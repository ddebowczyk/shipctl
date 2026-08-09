//! One ordered owner for a terminal's PTY, VT state, query responses, and
//! lifecycle. The service sends commands; transports observe events.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender, TryRecvError, TrySendError};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use shipctl_module_api::TerminalColorTheme;

use super::process::{ProcessTerminator, TERMINATION_GRACE_PERIOD};
use super::record::TerminalRecord;
use super::replay::{validate_dimensions, VtReplayEngine};
use super::types::{
    TerminalAgentReportRequest, TerminalAttachment, TerminalAttachmentId, TerminalError,
    TerminalErrorCode, TerminalEvent, TerminalExit, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalLaunchTarget, TerminalMetadata, TerminalReplay,
    TerminalRuntimeSnapshot,
};

type TerminalDescriptorSink = Arc<dyn Fn(super::types::TerminalDescriptor) + Send + Sync>;

const PTY_READ_CHUNK_BYTES: usize = 4_096;
// The replaced renderer ACK path paused at 100,000 unacknowledged bytes. PTY
// reads are at most 4,096 bytes, so 25 slots preserve that established memory
// pressure point independently for each attachment (ceil(100000 / 4096)).
const ATTACHMENT_MAILBOX_EVENTS: usize = 25;
// The reader-to-actor handoff stays one event deep. The actor continuously
// parses even with no attachments, while this prevents userspace read-ahead.
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 1;

pub trait TerminalEventSink: Send + Sync + 'static {
    fn publish(&self, terminal_id: TerminalId, event: TerminalEvent) -> Result<(), String>;
}

impl<F> TerminalEventSink for F
where
    F: Fn(TerminalId, TerminalEvent) -> Result<(), String> + Send + Sync + 'static,
{
    fn publish(&self, terminal_id: TerminalId, event: TerminalEvent) -> Result<(), String> {
        self(terminal_id, event)
    }
}

#[derive(Clone)]
pub struct TerminalRuntimeHandle {
    commands: Sender<RuntimeCommand>,
}

impl TerminalRuntimeHandle {
    pub fn start(
        record: Arc<TerminalRecord>,
        request: TerminalLaunchRequest,
        descriptor_sink: TerminalDescriptorSink,
    ) -> Result<Self, TerminalError> {
        let (command_sender, command_receiver) = bounded(0);
        let (output_sender, output_receiver) = bounded(PTY_OUTPUT_QUEUE_CAPACITY);
        let (startup_sender, startup_receiver) = bounded(0);
        let handle = Self {
            commands: command_sender,
        };
        let runtime_handle = handle.clone();
        let failure_record = Arc::clone(&record);
        let thread_name = format!("terminal-runtime-{}", record.id());
        let spawn_result =
            thread::Builder::new()
                .name(thread_name)
                .spawn(move || {
                    match RuntimeActor::initialize(
                        Arc::clone(&record),
                        request,
                        command_receiver,
                        output_receiver,
                        output_sender,
                        descriptor_sink,
                    ) {
                        Ok(mut actor) => {
                            record.install_running(runtime_handle, actor.child_pid);
                            let _ = startup_sender.send(Ok(()));
                            actor.run();
                        }
                        Err(error) => {
                            record.mark_startup_failed();
                            let _ = startup_sender.send(Err(error));
                        }
                    }
                });
        if let Err(error) = spawn_result {
            failure_record.mark_startup_failed();
            return Err(TerminalError::new(
                TerminalErrorCode::StartupFailed,
                format!("Failed to start terminal runtime thread: {error}"),
            ));
        }

        startup_receiver.recv().map_err(|_| {
            TerminalError::new(
                TerminalErrorCode::StartupFailed,
                "Terminal runtime stopped during startup",
            )
        })??;
        Ok(handle)
    }

    pub fn write(&self, data: Vec<u8>) -> Result<(), TerminalError> {
        self.request(|reply| RuntimeCommand::Write { data, reply })
    }

    pub fn resize(
        &self,
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        self.request(|reply| RuntimeCommand::Resize {
            attachment_id,
            columns,
            rows,
            reply,
        })
    }

    pub fn set_theme(&self, theme: TerminalColorTheme) -> Result<(), TerminalError> {
        self.request(|reply| RuntimeCommand::SetTheme { theme, reply })
    }

    pub fn snapshot(&self) -> Result<TerminalRuntimeSnapshot, TerminalError> {
        self.request(|reply| RuntimeCommand::Snapshot { reply })
    }

    pub fn attach(
        &self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalAttachment, TerminalError> {
        self.request(|reply| RuntimeCommand::Attach {
            attachment_id,
            sink,
            claims_resize,
            on_detached,
            reply,
        })
    }

    pub fn detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), TerminalError> {
        self.request(|reply| RuntimeCommand::Detach {
            attachment_id,
            reply,
        })
    }

    pub fn wait_for_exit(&self) -> Result<TerminalExit, TerminalError> {
        self.request(|reply| RuntimeCommand::WaitForExit { reply })
    }

    pub fn update_metadata(
        &self,
        metadata: TerminalMetadata,
    ) -> Result<super::types::TerminalDescriptor, TerminalError> {
        self.request(|reply| RuntimeCommand::UpdateMetadata { metadata, reply })
    }

    pub fn report_agent(
        &self,
        report: TerminalAgentReportRequest,
    ) -> Result<super::types::TerminalAgentActivity, TerminalError> {
        self.request(|reply| RuntimeCommand::ReportAgent { report, reply })
    }

    /// Request close without waiting. Host shutdown can signal all runtimes
    /// first and only then await these tickets, preserving a shared grace
    /// window across terminals.
    pub fn request_close(
        &self,
        reason: TerminalExitReason,
    ) -> Result<TerminalCloseTicket, TerminalError> {
        let (reply, completion) = bounded(1);
        self.commands
            .send(RuntimeCommand::Close { reason, reply })
            .map_err(|_| runtime_stopped())?;
        Ok(TerminalCloseTicket { completion })
    }

    fn request<T>(
        &self,
        command: impl FnOnce(Sender<Result<T, TerminalError>>) -> RuntimeCommand,
    ) -> Result<T, TerminalError> {
        let (reply, response) = bounded(1);
        self.commands
            .send(command(reply))
            .map_err(|_| runtime_stopped())?;
        response.recv().map_err(|_| runtime_stopped())?
    }
}

pub struct TerminalCloseTicket {
    completion: Receiver<Result<TerminalExit, TerminalError>>,
}

impl TerminalCloseTicket {
    pub fn wait(self) -> Result<TerminalExit, TerminalError> {
        self.completion.recv().map_err(|_| runtime_stopped())?
    }
}

enum RuntimeCommand {
    Write {
        data: Vec<u8>,
        reply: Sender<Result<(), TerminalError>>,
    },
    Resize {
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
        reply: Sender<Result<(), TerminalError>>,
    },
    SetTheme {
        theme: TerminalColorTheme,
        reply: Sender<Result<(), TerminalError>>,
    },
    Snapshot {
        reply: Sender<Result<TerminalRuntimeSnapshot, TerminalError>>,
    },
    Attach {
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
        reply: Sender<Result<TerminalAttachment, TerminalError>>,
    },
    Detach {
        attachment_id: TerminalAttachmentId,
        reply: Sender<Result<(), TerminalError>>,
    },
    WaitForExit {
        reply: Sender<Result<TerminalExit, TerminalError>>,
    },
    UpdateMetadata {
        metadata: TerminalMetadata,
        reply: Sender<Result<super::types::TerminalDescriptor, TerminalError>>,
    },
    ReportAgent {
        report: TerminalAgentReportRequest,
        reply: Sender<Result<super::types::TerminalAgentActivity, TerminalError>>,
    },
    Close {
        reason: TerminalExitReason,
        reply: Sender<Result<TerminalExit, TerminalError>>,
    },
}

enum ReaderEvent {
    Data(Vec<u8>),
    Exited {
        code: Option<i32>,
        read_error: Option<String>,
        wait_error: Option<String>,
    },
}

struct ClosingState {
    reason: TerminalExitReason,
    deadline: Instant,
    force_kill_sent: bool,
    replies: Vec<Sender<Result<TerminalExit, TerminalError>>>,
}

struct Subscriber {
    events: Sender<TerminalEvent>,
    control: Sender<TerminalEvent>,
    on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
}

enum SubscriberStatus {
    Disconnected(TerminalAttachmentId),
}

struct RuntimeActor {
    record: Arc<TerminalRecord>,
    command_receiver: Receiver<RuntimeCommand>,
    output_receiver: Receiver<ReaderEvent>,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    terminator: Option<ProcessTerminator>,
    vt: VtReplayEngine,
    subscribers: HashMap<TerminalAttachmentId, Subscriber>,
    subscriber_status_sender: Sender<SubscriberStatus>,
    subscriber_status_receiver: Receiver<SubscriberStatus>,
    resize_authority: Option<TerminalAttachmentId>,
    child_pid: Option<u32>,
    sequence: u64,
    closing: Option<ClosingState>,
    exit_waiters: Vec<Sender<Result<TerminalExit, TerminalError>>>,
    exited: bool,
    descriptor_sink: TerminalDescriptorSink,
}

impl RuntimeActor {
    fn initialize(
        record: Arc<TerminalRecord>,
        mut request: TerminalLaunchRequest,
        command_receiver: Receiver<RuntimeCommand>,
        output_receiver: Receiver<ReaderEvent>,
        output_sender: Sender<ReaderEvent>,
        descriptor_sink: TerminalDescriptorSink,
    ) -> Result<Self, TerminalError> {
        validate_dimensions(request.columns, request.rows)
            .map_err(|message| TerminalError::new(TerminalErrorCode::InvalidRequest, message))?;
        // The parser exists before PTY allocation or child spawn, so no child
        // path can produce bytes before continuous host state is available.
        let vt = VtReplayEngine::new(request.columns, request.rows, &request.color_theme)
            .map_err(|message| TerminalError::new(TerminalErrorCode::StartupFailed, message))?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.rows,
                cols: request.columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| startup_error(format!("Failed to open PTY: {error}")))?;
        // Acquire all fallible master resources before a child exists.
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| startup_error(format!("Failed to get PTY writer: {error}")))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| startup_error(format!("Failed to get PTY reader: {error}")))?;

        let launch = resolve_launch_command(&request.target);
        let mut command = CommandBuilder::new(&launch.program);
        for argument in launch.argv {
            command.arg(argument);
        }
        command.cwd(&request.cwd);
        for (key, value) in request.environment.drain() {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        command.env("TERM_PROGRAM", "iTerm.app");
        command.env("COLORTERM", "truecolor");

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| startup_error(format!("Failed to spawn terminal command: {error}")))?;
        let child_pid = child.process_id();
        let terminator = ProcessTerminator::new(child_pid, child.clone_killer());
        drop(pair.slave);

        // This thread is part of the runtime and is the sole wait owner. Every
        // EOF/read-error/close path reaches the same child.wait() epilogue.
        thread::spawn(move || {
            let mut buffer = [0u8; PTY_READ_CHUNK_BYTES];
            let mut read_error = None;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        if output_sender
                            .send(ReaderEvent::Data(buffer[..length].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        read_error = Some(error.to_string());
                        break;
                    }
                }
            }
            let (code, wait_error) = match child.wait() {
                Ok(status) => (i32::try_from(status.exit_code()).ok(), None),
                Err(error) => (None, Some(error.to_string())),
            };
            let _ = output_sender.send(ReaderEvent::Exited {
                code,
                read_error,
                wait_error,
            });
        });

        let (subscriber_status_sender, subscriber_status_receiver) = unbounded();
        Ok(Self {
            record,
            command_receiver,
            output_receiver,
            master: Some(pair.master),
            writer: Some(writer),
            terminator: Some(terminator),
            vt,
            subscribers: HashMap::new(),
            subscriber_status_sender,
            subscriber_status_receiver,
            resize_authority: None,
            child_pid,
            sequence: 0,
            closing: None,
            exit_waiters: Vec::new(),
            exited: false,
            descriptor_sink,
        })
    }

    fn run(&mut self) {
        loop {
            if self.exited {
                match self.command_receiver.recv() {
                    Ok(command) => {
                        if self.handle_command(command) {
                            break;
                        }
                    }
                    Err(_) => break,
                }
                continue;
            }

            // At most one command and one output event are handled per turn.
            // With a rendezvous command channel and one-event output queue,
            // neither a writer flood nor a PTY flood can permanently starve
            // the other ingress.
            let mut progressed = false;
            match self.command_receiver.try_recv() {
                Ok(command) => {
                    progressed = true;
                    if self.handle_command(command) {
                        break;
                    }
                }
                Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) => {}
            }
            match self.output_receiver.try_recv() {
                Ok(output) => {
                    progressed = true;
                    self.handle_output(output);
                }
                Err(TryRecvError::Disconnected) | Err(TryRecvError::Empty) => {}
            }
            match self.subscriber_status_receiver.try_recv() {
                Ok(status) => {
                    progressed = true;
                    self.handle_subscriber_status(status);
                }
                Err(TryRecvError::Disconnected) | Err(TryRecvError::Empty) => {}
            }
            self.escalate_if_due();
            if progressed {
                continue;
            }

            if let Some(deadline) = self.closing.as_ref().map(|closing| closing.deadline) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                select! {
                    recv(self.command_receiver) -> command => match command {
                        Ok(command) => if self.handle_command(command) { break; },
                        Err(_) => break,
                    },
                    recv(self.output_receiver) -> output => if let Ok(output) = output {
                        self.handle_output(output);
                    },
                    recv(self.subscriber_status_receiver) -> status => if let Ok(status) = status {
                        self.handle_subscriber_status(status);
                    },
                    recv(crossbeam_channel::after(remaining)) -> _ => self.escalate_if_due(),
                }
            } else {
                select! {
                    recv(self.command_receiver) -> command => match command {
                        Ok(command) => if self.handle_command(command) { break; },
                        Err(_) => break,
                    },
                    recv(self.output_receiver) -> output => if let Ok(output) = output {
                        self.handle_output(output);
                    },
                    recv(self.subscriber_status_receiver) -> status => if let Ok(status) = status {
                        self.handle_subscriber_status(status);
                    },
                }
            }
        }

        // Dropping the last command handle without explicit close occurs only
        // during app teardown. Still request termination so the wait-owner
        // thread is never orphaned.
        if !self.exited {
            if let Some(terminator) = self.terminator.as_mut() {
                terminator.request_graceful();
                terminator.force_kill();
            }
        }
    }

    /// Returns true when the actor should stop.
    fn handle_command(&mut self, command: RuntimeCommand) -> bool {
        match command {
            RuntimeCommand::Write { data, reply } => {
                let result = self.require_writable().and_then(|writer| {
                    writer
                        .write_all(&data)
                        .map_err(|error| io_error(format!("Failed to write to terminal: {error}")))
                });
                let _ = reply.send(result);
            }
            RuntimeCommand::Resize {
                attachment_id,
                columns,
                rows,
                reply,
            } => {
                let result = self.resize(attachment_id, columns, rows);
                let _ = reply.send(result);
            }
            RuntimeCommand::SetTheme { theme, reply } => {
                let result = self.set_theme(&theme).map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::Snapshot { reply } => {
                let result = self.snapshot();
                let _ = reply.send(result);
            }
            RuntimeCommand::Attach {
                attachment_id,
                sink,
                claims_resize,
                on_detached,
                reply,
            } => {
                let result = self.attach(attachment_id, sink, claims_resize, on_detached);
                let _ = reply.send(result);
            }
            RuntimeCommand::Detach {
                attachment_id,
                reply,
            } => {
                self.detach_subscriber(attachment_id, "detached by client");
                let _ = reply.send(Ok(()));
            }
            RuntimeCommand::WaitForExit { reply } => {
                if let Some(exit) = self.record.exit() {
                    let _ = reply.send(Ok(exit));
                } else {
                    self.exit_waiters.push(reply);
                }
            }
            RuntimeCommand::UpdateMetadata { metadata, reply } => {
                let descriptor = self.record.update_metadata(metadata);
                self.publish_descriptor(descriptor.clone());
                let sequence = self.next_sequence();
                self.publish(TerminalEvent::MetadataChanged {
                    sequence,
                    descriptor: descriptor.clone(),
                });
                let _ = reply.send(Ok(descriptor));
            }
            RuntimeCommand::ReportAgent { report, reply } => {
                let result = if self.exited {
                    Err(TerminalError::new(
                        TerminalErrorCode::Exited,
                        format!("Terminal {} has exited", self.record.id()),
                    ))
                } else if self.closing.is_some() {
                    Err(TerminalError::new(
                        TerminalErrorCode::Closing,
                        format!("Terminal {} is closing", self.record.id()),
                    ))
                } else {
                    self.record.report_agent(report).map(|descriptor| {
                        let activity = descriptor
                            .agent_activity
                            .clone()
                            .expect("accepted agent report must create agent activity");
                        self.publish_descriptor(descriptor.clone());
                        let sequence = self.next_sequence();
                        self.publish(TerminalEvent::AgentActivityChanged {
                            sequence,
                            descriptor,
                        });
                        activity
                    })
                };
                let _ = reply.send(result);
            }
            RuntimeCommand::Close { reason, reply } => {
                if self.exited {
                    let exit = self.record.exit().ok_or_else(runtime_stopped);
                    let _ = reply.send(exit);
                    return true;
                }
                if let Some(closing) = self.closing.as_mut() {
                    closing.replies.push(reply);
                } else {
                    let descriptor = self.record.mark_closing();
                    self.publish_descriptor(descriptor);
                    if let Some(terminator) = self.terminator.as_mut() {
                        terminator.request_graceful();
                    }
                    self.closing = Some(ClosingState {
                        reason,
                        deadline: Instant::now() + TERMINATION_GRACE_PERIOD,
                        force_kill_sent: false,
                        replies: vec![reply],
                    });
                }
            }
        }
        false
    }

    fn require_writable(&mut self) -> Result<&mut Box<dyn Write + Send>, TerminalError> {
        if self.exited {
            return Err(TerminalError::new(
                TerminalErrorCode::Exited,
                format!("Terminal {} has exited", self.record.id()),
            ));
        }
        if self.closing.is_some() {
            return Err(TerminalError::new(
                TerminalErrorCode::Closing,
                format!("Terminal {} is closing", self.record.id()),
            ));
        }
        self.writer.as_mut().ok_or_else(runtime_stopped)
    }

    fn resize(
        &mut self,
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        if self.exited {
            return Err(TerminalError::new(
                TerminalErrorCode::Exited,
                format!("Terminal {} has exited", self.record.id()),
            ));
        }
        if self.closing.is_some() {
            return Err(TerminalError::new(
                TerminalErrorCode::Closing,
                format!("Terminal {} is closing", self.record.id()),
            ));
        }
        if self.resize_authority != Some(attachment_id) {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Resize rejected because this attachment is not the current renderer authority",
            ));
        }
        validate_dimensions(columns, rows)
            .map_err(|message| TerminalError::new(TerminalErrorCode::InvalidRequest, message))?;
        self.master
            .as_ref()
            .ok_or_else(runtime_stopped)?
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| io_error(format!("Failed to resize PTY: {error}")))?;
        self.vt
            .resize(columns, rows)
            .map_err(|message| io_error(message))?;
        let descriptor = self.record.record_resize(columns, rows);
        self.publish_descriptor(descriptor);
        let replay = self.replay()?;
        let sequence = self.next_sequence();
        self.publish(TerminalEvent::Replay { sequence, replay });
        Ok(())
    }

    fn snapshot(&mut self) -> Result<TerminalRuntimeSnapshot, TerminalError> {
        let replay = self.replay()?;
        Ok(TerminalRuntimeSnapshot {
            descriptor: self.record.descriptor(),
            sequence_boundary: self.sequence,
            replay,
        })
    }

    fn replay(&mut self) -> Result<TerminalReplay, TerminalError> {
        let descriptor = self.record.descriptor();
        let bytes = self
            .vt
            .replay()
            .map_err(|message| io_error(format!("Failed to build terminal replay: {message}")))?;
        Ok(TerminalReplay {
            revision: descriptor.revision,
            columns: descriptor.columns,
            rows: descriptor.rows,
            bytes: Arc::from(bytes),
        })
    }

    fn set_theme(&mut self, theme: &TerminalColorTheme) -> Result<(), String> {
        let response = self.vt.set_theme(theme)?;
        if !response.is_empty() {
            self.write_response(&response)?;
        }
        let descriptor = self.record.note_replay_change();
        self.publish_descriptor(descriptor);
        let replay = self.replay().map_err(|error| error.to_string())?;
        let sequence = self.next_sequence();
        self.publish(TerminalEvent::Replay { sequence, replay });
        Ok(())
    }

    fn attach(
        &mut self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalAttachment, TerminalError> {
        let snapshot = self.snapshot()?;
        if self.exited {
            return Ok(TerminalAttachment {
                attachment_id,
                live: false,
                snapshot,
            });
        }
        let subscriber = spawn_subscriber(
            self.record.id(),
            attachment_id,
            sink,
            self.subscriber_status_sender.clone(),
            on_detached,
        )?;
        self.subscribers.insert(attachment_id, subscriber);
        if claims_resize {
            self.resize_authority = Some(attachment_id);
        }
        Ok(TerminalAttachment {
            attachment_id,
            live: true,
            snapshot,
        })
    }

    fn handle_output(&mut self, output: ReaderEvent) {
        match output {
            ReaderEvent::Data(data) => {
                let responses = self.vt.feed(&data);
                if !responses.is_empty() {
                    let _ = self.write_response(&responses);
                }
                let sequence = self.next_sequence();
                let revision = self.record.note_output();
                self.publish(TerminalEvent::Output {
                    sequence,
                    revision,
                    data: Arc::from(data),
                });
            }
            ReaderEvent::Exited {
                code,
                read_error,
                wait_error,
            } => {
                let reason = self
                    .closing
                    .as_ref()
                    .map(|closing| closing.reason)
                    .unwrap_or(TerminalExitReason::ProcessExit);
                if let Some(error) = read_error {
                    eprintln!("terminal {} PTY reader ended: {error}", self.record.id());
                }
                if let Some(error) = wait_error {
                    eprintln!("terminal {} child wait failed: {error}", self.record.id());
                }
                self.writer.take();
                self.master.take();
                self.terminator.take();
                let descriptor = self.record.finish_exit(code, reason);
                self.publish_descriptor(descriptor.clone());
                self.exited = true;
                let sequence = self.next_sequence();
                self.publish(TerminalEvent::Exited {
                    sequence,
                    descriptor: descriptor.clone(),
                });
                self.finish_subscribers();
                if let Some(closing) = self.closing.take() {
                    let exit = descriptor
                        .exit
                        .clone()
                        .expect("exited descriptor must contain exit state");
                    for reply in closing.replies {
                        let _ = reply.send(Ok(exit.clone()));
                    }
                }
                let exit = descriptor
                    .exit
                    .expect("exited descriptor must contain exit state");
                for reply in self.exit_waiters.drain(..) {
                    let _ = reply.send(Ok(exit.clone()));
                }
            }
        }
    }

    fn publish_descriptor(&self, descriptor: super::types::TerminalDescriptor) {
        (self.descriptor_sink)(descriptor);
    }

    fn write_response(&mut self, bytes: &[u8]) -> Result<(), String> {
        let Some(writer) = self.writer.as_mut() else {
            return Ok(());
        };
        writer
            .write_all(bytes)
            .map_err(|error| format!("Failed to write terminal query response: {error}"))
    }

    fn publish(&mut self, event: TerminalEvent) {
        let sequence = event_sequence(&event);
        let mut overflowed = Vec::new();
        let mut disconnected = Vec::new();
        for (attachment_id, subscriber) in &self.subscribers {
            match subscriber.events.try_send(event.clone()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    let _ = subscriber.control.try_send(TerminalEvent::ResyncRequired {
                        sequence,
                        reason: "attachment mailbox exceeded the established 100000-byte flow-control budget"
                            .to_string(),
                    });
                    overflowed.push(*attachment_id);
                }
                Err(TrySendError::Disconnected(_)) => disconnected.push(*attachment_id),
            }
        }
        for attachment_id in overflowed.into_iter().chain(disconnected) {
            self.remove_subscriber(attachment_id);
        }
    }

    fn detach_subscriber(&mut self, attachment_id: TerminalAttachmentId, reason: &str) {
        if let Some(subscriber) = self.subscribers.remove(&attachment_id) {
            if self.resize_authority == Some(attachment_id) {
                self.resize_authority = None;
            }
            let sequence = self.next_sequence();
            let _ = subscriber.control.try_send(TerminalEvent::Detached {
                sequence,
                reason: reason.to_string(),
            });
            (subscriber.on_detached)(attachment_id);
        }
    }

    fn remove_subscriber(&mut self, attachment_id: TerminalAttachmentId) {
        if let Some(subscriber) = self.subscribers.remove(&attachment_id) {
            if self.resize_authority == Some(attachment_id) {
                self.resize_authority = None;
            }
            (subscriber.on_detached)(attachment_id);
        }
    }

    fn finish_subscribers(&mut self) {
        self.resize_authority = None;
        for (attachment_id, subscriber) in self.subscribers.drain() {
            (subscriber.on_detached)(attachment_id);
        }
    }

    fn handle_subscriber_status(&mut self, status: SubscriberStatus) {
        match status {
            SubscriberStatus::Disconnected(attachment_id) => {
                self.remove_subscriber(attachment_id);
            }
        }
    }

    fn next_sequence(&mut self) -> u64 {
        self.sequence = self
            .sequence
            .checked_add(1)
            .expect("terminal event sequence overflow is a fatal invariant violation");
        self.sequence
    }

    fn escalate_if_due(&mut self) {
        let Some(closing) = self.closing.as_mut() else {
            return;
        };
        if closing.force_kill_sent || Instant::now() < closing.deadline {
            return;
        }
        closing.force_kill_sent = true;
        if let Some(terminator) = self.terminator.as_mut() {
            terminator.force_kill();
        }
    }
}

fn spawn_subscriber(
    terminal_id: TerminalId,
    attachment_id: TerminalAttachmentId,
    sink: Arc<dyn TerminalEventSink>,
    status: Sender<SubscriberStatus>,
    on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
) -> Result<Subscriber, TerminalError> {
    let (event_sender, event_receiver) = bounded(ATTACHMENT_MAILBOX_EVENTS);
    let (control_sender, control_receiver) = bounded(1);
    thread::Builder::new()
        .name(format!("terminal-attachment-{attachment_id:?}"))
        .spawn(move || {
            'worker: loop {
                match control_receiver.try_recv() {
                    Ok(event) => {
                        let _ = sink.publish(terminal_id, event);
                        break;
                    }
                    Err(TryRecvError::Disconnected) => {
                        for event in event_receiver.iter() {
                            if sink.publish(terminal_id, event).is_err() {
                                break;
                            }
                        }
                        break;
                    }
                    Err(TryRecvError::Empty) => {}
                }

                crossbeam_channel::select_biased! {
                    recv(control_receiver) -> control => match control {
                        Ok(event) => {
                            let _ = sink.publish(terminal_id, event);
                            break 'worker;
                        }
                        Err(_) => continue 'worker,
                    },
                    recv(event_receiver) -> event => match event {
                        Ok(event) => {
                            if sink.publish(terminal_id, event).is_err() {
                                break 'worker;
                            }
                        }
                        Err(_) => continue 'worker,
                    },
                }
            }
            let _ = status.send(SubscriberStatus::Disconnected(attachment_id));
        })
        .map_err(|error| {
            TerminalError::new(
                TerminalErrorCode::RuntimeStopped,
                format!("Failed to start terminal attachment worker: {error}"),
            )
        })?;
    Ok(Subscriber {
        events: event_sender,
        control: control_sender,
        on_detached,
    })
}

fn event_sequence(event: &TerminalEvent) -> u64 {
    match event {
        TerminalEvent::Output { sequence, .. }
        | TerminalEvent::Replay { sequence, .. }
        | TerminalEvent::MetadataChanged { sequence, .. }
        | TerminalEvent::AgentActivityChanged { sequence, .. }
        | TerminalEvent::Exited { sequence, .. }
        | TerminalEvent::ResyncRequired { sequence, .. }
        | TerminalEvent::Detached { sequence, .. } => *sequence,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchCommand {
    program: std::path::PathBuf,
    argv: Vec<String>,
}

fn resolve_launch_command(target: &TerminalLaunchTarget) -> LaunchCommand {
    match target {
        TerminalLaunchTarget::Shell { executable } => LaunchCommand {
            program: resolve_shell(executable),
            argv: vec!["-l".to_string()],
        },
        TerminalLaunchTarget::ShellCommand { executable, source } => LaunchCommand {
            program: resolve_shell(executable),
            argv: vec![
                "-l".to_string(),
                "-i".to_string(),
                "-c".to_string(),
                source.clone(),
            ],
        },
        TerminalLaunchTarget::Program { program, argv } => LaunchCommand {
            program: program.clone(),
            argv: argv.clone(),
        },
    }
}

fn resolve_shell(executable: &Option<std::path::PathBuf>) -> std::path::PathBuf {
    executable.clone().unwrap_or_else(|| {
        std::env::var_os("SHELL")
            .map(Into::into)
            .unwrap_or_else(|| "/bin/zsh".into())
    })
}

fn startup_error(message: impl Into<String>) -> TerminalError {
    TerminalError::new(TerminalErrorCode::StartupFailed, message)
}

fn io_error(message: impl Into<String>) -> TerminalError {
    TerminalError::new(TerminalErrorCode::Io, message)
}

fn runtime_stopped() -> TerminalError {
    TerminalError::new(
        TerminalErrorCode::RuntimeStopped,
        "Terminal runtime is no longer available",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_shell_has_exactly_one_login_shell_boundary() {
        let launch = resolve_launch_command(&TerminalLaunchTarget::Shell {
            executable: Some("/bin/zsh".into()),
        });
        assert_eq!(launch.program, std::path::PathBuf::from("/bin/zsh"));
        assert_eq!(launch.argv, vec!["-l"]);
    }

    #[test]
    fn direct_program_preserves_exact_argv() {
        let argv = vec![
            String::new(),
            "argument with spaces".to_string(),
            "quote'\"$literal".to_string(),
            "Zażółć".to_string(),
        ];
        let launch = resolve_launch_command(&TerminalLaunchTarget::Program {
            program: "/usr/bin/example".into(),
            argv: argv.clone(),
        });
        assert_eq!(launch.program, std::path::PathBuf::from("/usr/bin/example"));
        assert_eq!(launch.argv, argv);
    }
}
