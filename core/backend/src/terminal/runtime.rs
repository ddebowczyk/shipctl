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

use super::contract::MAX_EXACT_JSON_INTEGER;
use super::process::{ProcessTerminator, TERMINATION_GRACE_PERIOD};
use super::projection::{
    ProjectedPoint, ProjectedSpace, TerminalAnchor, TerminalAnchorId, TerminalHistoryWindow,
    TerminalProjection,
};
use super::publication::{
    plan_child_output, plan_child_reply, plan_replay_transition, resize_admission,
    subscriber_disposition, DeliveryOutcome, RuntimeEffect, RuntimeLiveness, SubscriberDisposition,
};
use super::record::TerminalRecord;
use super::replay::{validate_dimensions, VtReplayEngine};
use super::retention::TerminalRetentionPolicy;
use super::types::{
    TerminalAgentReportRequest, TerminalAttachment, TerminalAttachmentId, TerminalError,
    TerminalErrorCode, TerminalEvent, TerminalExit, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalLaunchTarget, TerminalMetadata, TerminalReplay,
    TerminalRuntimeSnapshot,
};

type TerminalDescriptorSink = Arc<dyn Fn(super::types::TerminalDescriptor) + Send + Sync>;

/// The log target for the terminal capability, so its records can be filtered
/// apart from the rest of the host. The runtime logs what no caller is told by
/// a return value: what the child did, and what the host did about it.
const LOG_TARGET: &str = "shipctl::terminal";

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
        retention: TerminalRetentionPolicy,
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
                        retention,
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

    /// The host's semantic state, read through the actor so it is consistent
    /// with every other ordered operation.
    pub fn project(&self) -> Result<TerminalProjection, TerminalError> {
        self.request(|reply| RuntimeCommand::Project { reply })
    }

    /// A window of retained history, read through the actor for the same reason
    /// the projection is: the host's state has one reader.
    pub fn project_history(
        &self,
        start_row: u32,
        rows: u32,
    ) -> Result<TerminalHistoryWindow, TerminalError> {
        self.request(|reply| RuntimeCommand::History {
            start_row,
            rows,
            reply,
        })
    }

    /// Pins a cell and returns the handle that outlives its row number.
    pub fn anchor(
        &self,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<TerminalAnchor, TerminalError> {
        self.request(|reply| RuntimeCommand::Anchor { space, at, reply })
    }

    /// Where an anchor is now, or `None` when the host holds no such handle.
    pub fn resolve_anchor(
        &self,
        id: TerminalAnchorId,
    ) -> Result<Option<TerminalAnchor>, TerminalError> {
        self.request(|reply| RuntimeCommand::ResolveAnchor { id, reply })
    }

    /// Drops an anchor, answering whether the host was holding it.
    pub fn release_anchor(&self, id: TerminalAnchorId) -> Result<bool, TerminalError> {
        self.request(|reply| RuntimeCommand::ReleaseAnchor { id, reply })
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
    Project {
        reply: Sender<Result<TerminalProjection, TerminalError>>,
    },
    History {
        start_row: u32,
        rows: u32,
        reply: Sender<Result<TerminalHistoryWindow, TerminalError>>,
    },
    Anchor {
        space: ProjectedSpace,
        at: ProjectedPoint,
        reply: Sender<Result<TerminalAnchor, TerminalError>>,
    },
    ResolveAnchor {
        id: TerminalAnchorId,
        reply: Sender<Result<Option<TerminalAnchor>, TerminalError>>,
    },
    ReleaseAnchor {
        id: TerminalAnchorId,
        reply: Sender<Result<bool, TerminalError>>,
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

/// The only thing the actor asks of the PTY master: change the kernel's idea of
/// the window size.
///
/// The actor held `Box<dyn MasterPty + Send>` for this one call. Naming the one
/// call is what lets an actor exist without a PTY.
pub(crate) trait TerminalGeometry: Send {
    fn resize(&self, columns: u16, rows: u16) -> Result<(), String>;
}

impl TerminalGeometry for Box<dyn MasterPty + Send> {
    fn resize(&self, columns: u16, rows: u16) -> Result<(), String> {
        MasterPty::resize(
            self.as_ref(),
            PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            },
        )
        .map_err(|error| format!("Failed to resize PTY: {error}"))
    }
}

/// Everything the actor owns that a child process supplies.
///
/// Production builds one by opening a PTY and spawning a program. A test builds
/// one from an in-memory writer and a fake geometry, which is the whole point:
/// the actor's ordering does not depend on a child existing.
pub(crate) struct ChildAttachment {
    pub(crate) geometry: Option<Box<dyn TerminalGeometry>>,
    pub(crate) writer: Option<Box<dyn Write + Send>>,
    pub(crate) terminator: Option<ProcessTerminator>,
    pub(crate) child_pid: Option<u32>,
}

struct RuntimeActor {
    record: Arc<TerminalRecord>,
    command_receiver: Receiver<RuntimeCommand>,
    output_receiver: Receiver<ReaderEvent>,
    geometry: Option<Box<dyn TerminalGeometry>>,
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
        retention: TerminalRetentionPolicy,
    ) -> Result<Self, TerminalError> {
        validate_dimensions(request.columns, request.rows)
            .map_err(|message| TerminalError::new(TerminalErrorCode::InvalidRequest, message))?;
        // The parser exists before PTY allocation or child spawn, so no child
        // path can produce bytes before continuous host state is available.
        let vt = VtReplayEngine::new(
            request.columns,
            request.rows,
            &request.color_theme,
            retention,
        )
        .map_err(|message| TerminalError::new(TerminalErrorCode::StartupFailed, message))?;
        let child = spawn_child(&mut request, output_sender)?;
        log::debug!(
            target: LOG_TARGET,
            "terminal {} started {}x{} pid={:?}",
            record.id(),
            request.columns,
            request.rows,
            child.child_pid
        );
        Ok(Self::new(
            record,
            command_receiver,
            output_receiver,
            descriptor_sink,
            vt,
            child,
        ))
    }

    /// Assembles an actor from parts. This is the sole constructor and it starts
    /// nothing: whether the parts came from a child process is not its concern.
    fn new(
        record: Arc<TerminalRecord>,
        command_receiver: Receiver<RuntimeCommand>,
        output_receiver: Receiver<ReaderEvent>,
        descriptor_sink: TerminalDescriptorSink,
        vt: VtReplayEngine,
        child: ChildAttachment,
    ) -> Self {
        let (subscriber_status_sender, subscriber_status_receiver) = unbounded();
        Self {
            record,
            command_receiver,
            output_receiver,
            geometry: child.geometry,
            writer: child.writer,
            terminator: child.terminator,
            vt,
            subscribers: HashMap::new(),
            subscriber_status_sender,
            subscriber_status_receiver,
            resize_authority: None,
            child_pid: child.child_pid,
            sequence: 0,
            closing: None,
            exit_waiters: Vec::new(),
            exited: false,
            descriptor_sink,
        }
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
                log::debug!(
                    target: LOG_TARGET,
                    "terminal {} runtime stopped without an explicit close; terminating the child",
                    self.record.id()
                );
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
            RuntimeCommand::Project { reply } => {
                // Reading the host's state publishes nothing and advances no
                // sequence. An exited terminal still answers: its final state is
                // exactly what a caller asks about.
                let result = self.vt.project().map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::History {
                start_row,
                rows,
                reply,
            } => {
                let result = self.vt.project_history(start_row, rows).map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::Anchor { space, at, reply } => {
                // Anchors are held by the actor because the parser they pin is.
                // A caller gets a number back and nothing that borrows.
                let result = self.vt.anchor(space, at).map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::ResolveAnchor { id, reply } => {
                let result = self.vt.resolve_anchor(id).map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::ReleaseAnchor { id, reply } => {
                let _ = reply.send(Ok(self.vt.release_anchor(id)));
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
        resize_admission(
            self.liveness(),
            self.resize_authority,
            attachment_id,
            &self.record.id().to_string(),
        )?;
        validate_dimensions(columns, rows)
            .map_err(|message| TerminalError::new(TerminalErrorCode::InvalidRequest, message))?;
        self.geometry
            .as_ref()
            .ok_or_else(runtime_stopped)?
            .resize(columns, rows)
            .map_err(io_error)?;
        self.vt.resize(columns, rows).map_err(io_error)?;
        let descriptor = self.record.record_resize(columns, rows);
        let replay = match self.replay() {
            Ok(replay) => replay,
            Err(error) => {
                // The grid has already moved. The registry is told even when the
                // replay cannot be built, so it never reports the old size for a
                // terminal that no longer has it.
                self.publish_descriptor(descriptor);
                return Err(error);
            }
        };
        let sequence = self.next_sequence();
        self.apply(plan_replay_transition(descriptor, replay, sequence))
            .map_err(io_error)?;
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
        // The child is answered before the change is recorded. An answer that
        // cannot be written leaves the revision and the sequence where they were.
        self.apply(plan_child_reply(response))?;
        let descriptor = self.record.note_replay_change();
        let replay = match self.replay() {
            Ok(replay) => replay,
            Err(error) => {
                self.publish_descriptor(descriptor);
                return Err(error.to_string());
            }
        };
        let sequence = self.next_sequence();
        self.apply(plan_replay_transition(descriptor, replay, sequence))
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
                let sequence = self.next_sequence();
                let revision = self.record.note_output();
                // Output is published whether or not the child could be
                // answered: the bytes arrived either way.
                let _ = self.apply(plan_child_output(&data, responses, sequence, revision));
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
                    log::warn!(
                        target: LOG_TARGET,
                        "terminal {} PTY reader ended: {error}",
                        self.record.id()
                    );
                }
                if let Some(error) = wait_error {
                    log::warn!(
                        target: LOG_TARGET,
                        "terminal {} child wait failed: {error}",
                        self.record.id()
                    );
                }
                self.writer.take();
                self.geometry.take();
                self.terminator.take();
                let descriptor = self.record.finish_exit(code, reason);
                log::info!(
                    target: LOG_TARGET,
                    "terminal {} exited code={code:?} reason={reason:?}",
                    self.record.id()
                );
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

    fn liveness(&self) -> RuntimeLiveness {
        RuntimeLiveness::of(self.exited, self.closing.is_some())
    }

    /// Carries out a plan in order.
    ///
    /// A reply the child could not be given does not cancel the effects after
    /// it: the mutation that produced the reply already happened, so clients are
    /// still told about it. The failure is returned once every effect has run,
    /// for the callers that report it.
    fn apply(&mut self, effects: Vec<RuntimeEffect>) -> Result<(), String> {
        let mut failure = None;
        for effect in effects {
            match effect {
                RuntimeEffect::ReplyToChild(bytes) => {
                    if let Err(error) = self.write_response(&bytes) {
                        failure.get_or_insert(error);
                    }
                }
                RuntimeEffect::Descriptor(descriptor) => self.publish_descriptor(descriptor),
                RuntimeEffect::Publish(event) => self.publish(event),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
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
        let mut lost = Vec::new();
        for (attachment_id, subscriber) in &self.subscribers {
            let outcome = match subscriber.events.try_send(event.clone()) {
                Ok(()) => DeliveryOutcome::Delivered,
                Err(TrySendError::Full(_)) => DeliveryOutcome::Full,
                Err(TrySendError::Disconnected(_)) => DeliveryOutcome::Disconnected,
            };
            match subscriber_disposition(outcome) {
                SubscriberDisposition::Keep => {}
                SubscriberDisposition::ResyncThenRemove => {
                    // Nobody returns an error to the host here, so the log is
                    // the only record of why a viewer had to resynchronize.
                    log::warn!(
                        target: LOG_TARGET,
                        "terminal {} attachment {attachment_id:?} fell behind at sequence {sequence} and must resync",
                        self.record.id()
                    );
                    let _ = subscriber.control.try_send(TerminalEvent::ResyncRequired {
                        sequence,
                        reason: "attachment mailbox exceeded the established 100000-byte flow-control budget"
                            .to_string(),
                    });
                    lost.push(*attachment_id);
                }
                SubscriberDisposition::Remove => {
                    log::debug!(
                        target: LOG_TARGET,
                        "terminal {} attachment {attachment_id:?} disconnected at sequence {sequence}",
                        self.record.id()
                    );
                    lost.push(*attachment_id);
                }
            }
        }
        for attachment_id in lost {
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
        // Clients hold the sequence in a JavaScript number. Past the exact
        // integer boundary the two sides would disagree about ordering while
        // both believing they were consecutive.
        assert!(
            self.sequence <= MAX_EXACT_JSON_INTEGER,
            "terminal event sequence left the exact integer range shared with clients"
        );
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
        log::warn!(
            target: LOG_TARGET,
            "terminal {} did not stop within the grace period and is being killed",
            self.record.id()
        );
        if let Some(terminator) = self.terminator.as_mut() {
            terminator.force_kill();
        }
    }
}

/// Opens a PTY, starts the program, and starts the thread that reads it.
///
/// This is the only function in the capability that creates a child process. It
/// produces parts; it decides nothing. Everything the actor does with those
/// parts is reachable without calling this.
fn spawn_child(
    request: &mut TerminalLaunchRequest,
    output_sender: Sender<ReaderEvent>,
) -> Result<ChildAttachment, TerminalError> {
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

    Ok(ChildAttachment {
        geometry: Some(Box::new(pair.master)),
        writer: Some(writer),
        terminator: Some(terminator),
        child_pid,
    })
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
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use crate::terminal::types::{
        TerminalDescriptor, TerminalLifecycle, TerminalMetadata, TerminalOwner,
    };

    /// The bytes the actor sent toward the child.
    #[derive(Clone, Default)]
    struct ChildInbox(Arc<Mutex<Vec<u8>>>);

    impl ChildInbox {
        fn taken(&self) -> Vec<u8> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    impl Write for ChildInbox {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The window sizes the actor asked the kernel for.
    #[derive(Clone, Default)]
    struct GeometryLog(Arc<Mutex<Vec<(u16, u16)>>>);

    impl TerminalGeometry for GeometryLog {
        fn resize(&self, columns: u16, rows: u16) -> Result<(), String> {
            self.0.lock().unwrap().push((columns, rows));
            Ok(())
        }
    }

    /// One attachment's view of the stream, as a plain list.
    #[derive(Clone, Default)]
    struct EventLog(Arc<Mutex<Vec<TerminalEvent>>>);

    impl EventLog {
        fn kinds(&self) -> Vec<&'static str> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|event| match event {
                    TerminalEvent::Output { .. } => "output",
                    TerminalEvent::Replay { .. } => "replay",
                    TerminalEvent::MetadataChanged { .. } => "metadata",
                    TerminalEvent::AgentActivityChanged { .. } => "agent",
                    TerminalEvent::Exited { .. } => "exited",
                    TerminalEvent::ResyncRequired { .. } => "resync",
                    TerminalEvent::Detached { .. } => "detached",
                })
                .collect()
        }

        fn sequences(&self) -> Vec<u64> {
            self.0.lock().unwrap().iter().map(event_sequence).collect()
        }

        fn taken(&self) -> Vec<TerminalEvent> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    impl TerminalEventSink for EventLog {
        fn publish(&self, _terminal_id: TerminalId, event: TerminalEvent) -> Result<(), String> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }

    fn test_request() -> TerminalLaunchRequest {
        TerminalLaunchRequest {
            target: TerminalLaunchTarget::Shell { executable: None },
            cwd: PathBuf::from("/tmp"),
            environment: HashMap::new(),
            columns: 80,
            rows: 24,
            color_theme: TerminalColorTheme {
                foreground: "#ffffff".to_string(),
                background: "#000000".to_string(),
                palette: vec!["#000000".to_string(); 16],
            },
            metadata: TerminalMetadata {
                label: "harness".to_string(),
                cwd: PathBuf::from("/tmp"),
                project_path: None,
                display_command: "none".to_string(),
                created_at_ms: 1,
                owner: TerminalOwner::Core,
                owner_metadata: None,
                presentation: None,
            },
        }
    }

    /// A running actor with no child process behind it.
    ///
    /// `VtReplayEngine` is not `Send`, so the actor is built on the thread that
    /// runs it — the same reason production builds it inside the runtime thread.
    /// The harness therefore drives the actor the way every caller does: through
    /// the command channel. The reader channel replaces the PTY reader thread,
    /// so a test decides exactly when output arrives and when the child exits.
    struct ActorHarness {
        handle: TerminalRuntimeHandle,
        commands: Option<Sender<RuntimeCommand>>,
        output: Sender<ReaderEvent>,
        child_inbox: ChildInbox,
        geometry: GeometryLog,
        descriptors: Arc<Mutex<Vec<TerminalDescriptor>>>,
        detached: Arc<Mutex<Vec<TerminalAttachmentId>>>,
        record: Arc<TerminalRecord>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl ActorHarness {
        fn start() -> Self {
            let request = test_request();
            let record = TerminalRecord::new(TerminalId::new(), &request);
            // The channel shapes production uses: a rendezvous for commands and
            // a one-event queue for reader output.
            let (commands, command_receiver) = bounded(0);
            let (output, output_receiver) = bounded(PTY_OUTPUT_QUEUE_CAPACITY);
            let child_inbox = ChildInbox::default();
            let geometry = GeometryLog::default();
            let descriptors: Arc<Mutex<Vec<TerminalDescriptor>>> = Arc::default();

            let actor_record = Arc::clone(&record);
            let actor_inbox = child_inbox.clone();
            let actor_geometry = geometry.clone();
            let sink_descriptors = Arc::clone(&descriptors);
            let (ready, started) = bounded(0);
            let thread = thread::spawn(move || {
                let vt = VtReplayEngine::new(
                    request.columns,
                    request.rows,
                    &request.color_theme,
                    TerminalRetentionPolicy::default(),
                )
                .expect("the parser starts without a child");
                let mut actor = RuntimeActor::new(
                    actor_record,
                    command_receiver,
                    output_receiver,
                    Arc::new(move |descriptor| {
                        sink_descriptors.lock().unwrap().push(descriptor);
                    }),
                    vt,
                    ChildAttachment {
                        geometry: Some(Box::new(actor_geometry)),
                        writer: Some(Box::new(actor_inbox)),
                        terminator: None,
                        child_pid: None,
                    },
                );
                let _ = ready.send(());
                actor.run();
            });
            started.recv().expect("the actor started");

            Self {
                handle: TerminalRuntimeHandle {
                    commands: commands.clone(),
                },
                commands: Some(commands),
                output,
                child_inbox,
                geometry,
                descriptors,
                detached: Arc::default(),
                record,
                thread: Some(thread),
            }
        }

        fn send(&self, output: ReaderEvent) {
            self.output.send(output).expect("the actor is reading");
        }

        /// Attaches one subscriber and returns its stream.
        fn attach(&self, claims_resize: bool) -> (TerminalAttachmentId, EventLog) {
            let attachment_id = TerminalAttachmentId::new();
            let events = EventLog::default();
            let detached = Arc::clone(&self.detached);
            self.handle
                .attach(
                    attachment_id,
                    Arc::new(events.clone()),
                    claims_resize,
                    Arc::new(move |id| detached.lock().unwrap().push(id)),
                )
                .expect("attach needs no child");
            (attachment_id, events)
        }

        /// Closes the command channel, which is the actor's stop condition.
        fn stop(&mut self) {
            self.handle.commands = bounded(0).0;
            self.commands.take();
            if let Some(thread) = self.thread.take() {
                thread.join().expect("the actor thread ended cleanly");
            }
        }
    }

    impl Drop for ActorHarness {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// The subscriber thread delivers asynchronously, so a test waits for the
    /// count it expects rather than assuming the thread has been scheduled.
    fn wait_for_events(events: &EventLog, count: usize) {
        for _ in 0..2_000 {
            if events.0.lock().unwrap().len() >= count {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("expected {count} events, saw {:?}", events.kinds());
    }

    #[test]
    fn an_actor_runs_without_a_child_process() {
        let harness = ActorHarness::start();
        assert_eq!(
            harness.record.child_pid(),
            None,
            "the harness names no process"
        );
        let snapshot = harness.handle.snapshot().expect("the actor answers");
        assert_eq!(
            (snapshot.descriptor.columns, snapshot.descriptor.rows),
            (80, 24)
        );
        assert_eq!(snapshot.sequence_boundary, 0, "nothing has happened yet");
    }

    #[test]
    fn child_output_reaches_every_attachment_in_sequence_order() {
        let harness = ActorHarness::start();
        let (_, first) = harness.attach(false);
        let (_, second) = harness.attach(false);

        harness.send(ReaderEvent::Data(b"hello".to_vec()));
        harness.send(ReaderEvent::Data(b"world".to_vec()));

        wait_for_events(&first, 2);
        wait_for_events(&second, 2);
        assert_eq!(first.kinds(), vec!["output", "output"]);
        assert_eq!(
            first.sequences(),
            second.sequences(),
            "one sequence, not one per attachment"
        );
        assert_eq!(first.sequences(), vec![1, 2]);
    }

    #[test]
    fn a_query_from_the_child_is_answered_without_a_child() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        // Device attributes: the parser must answer this one.
        harness.send(ReaderEvent::Data(b"\x1b[c".to_vec()));

        wait_for_events(&events, 1);
        assert!(
            !harness.child_inbox.taken().is_empty(),
            "the parser answered nothing to a device-attributes query"
        );
        assert_eq!(
            events.kinds(),
            vec!["output"],
            "the answer to the child is not a client event"
        );
        match &events.taken()[0] {
            TerminalEvent::Output { data, .. } => assert_eq!(&data[..], b"\x1b[c"),
            other => panic!("expected Output, got {other:?}"),
        }
    }

    /// History and anchors are host facts, so they are answered by the actor
    /// that owns the parser, in order with everything else it does.
    #[test]
    fn history_and_anchors_are_answered_through_the_actor() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        harness.send(ReaderEvent::Data(b"anchored\r\n".to_vec()));
        wait_for_events(&events, 1);
        let anchor = harness
            .handle
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the actor anchors a cell");

        // Enough lines to push the anchored one off a 24-row screen.
        for line in 0..40 {
            harness.send(ReaderEvent::Data(format!("line{line}\r\n").into_bytes()));
        }
        wait_for_events(&events, 41);

        let window = harness
            .handle
            .project_history(0, 1)
            .expect("the actor reads history");
        assert!(window.history_rows > 0);
        assert_eq!(window.rows[0].text().trim_end(), "anchored");

        let resolved = harness
            .handle
            .resolve_anchor(anchor.id)
            .expect("the actor reads the anchor")
            .expect("the actor still holds it");
        assert!(
            resolved.loss_reported,
            "the actor carries the loss fact with the anchor, so a client outside \
             the engine knows whether `retained` can be believed"
        );
        let at = resolved.history.expect("the anchored line is in history");
        assert_eq!(
            harness
                .handle
                .project_history(at.row, 1)
                .expect("the actor reads history")
                .rows[0]
                .text()
                .trim_end(),
            "anchored",
            "the anchor names the line it was put on"
        );

        assert!(harness.handle.release_anchor(anchor.id).unwrap());
        assert!(harness.handle.resolve_anchor(anchor.id).unwrap().is_none());
    }

    #[test]
    fn only_the_renderer_authority_moves_the_grid() {
        let harness = ActorHarness::start();
        let (authority, _) = harness.attach(true);
        let (other, _) = harness.attach(false);

        harness
            .handle
            .resize(other, 100, 40)
            .expect_err("a second attachment must not resize");
        assert!(
            harness.geometry.0.lock().unwrap().is_empty(),
            "a refused resize never reaches the kernel"
        );

        harness
            .handle
            .resize(authority, 100, 40)
            .expect("the authority may resize");
        assert_eq!(harness.geometry.0.lock().unwrap().as_slice(), &[(100, 40)]);
    }

    #[test]
    fn a_resize_publishes_a_descriptor_and_one_replay() {
        let harness = ActorHarness::start();
        let (authority, events) = harness.attach(true);

        harness.handle.resize(authority, 100, 40).unwrap();

        wait_for_events(&events, 1);
        assert_eq!(events.kinds(), vec!["replay"]);
        let descriptors = harness.descriptors.lock().unwrap();
        assert_eq!(descriptors.len(), 1, "one resize, one descriptor");
        assert_eq!((descriptors[0].columns, descriptors[0].rows), (100, 40));
    }

    #[test]
    fn a_detached_attachment_loses_the_resize_authority() {
        let harness = ActorHarness::start();
        let (authority, _) = harness.attach(true);

        harness.handle.detach(authority).expect("detach succeeds");
        harness
            .handle
            .resize(authority, 100, 40)
            .expect_err("a detached attachment holds no authority");
    }

    #[test]
    fn the_exit_is_the_last_event_and_reaches_every_waiter() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);
        let waiter = harness.handle.clone();
        let waiting = thread::spawn(move || waiter.wait_for_exit());

        harness.send(ReaderEvent::Data(b"before".to_vec()));
        harness.send(ReaderEvent::Exited {
            code: Some(3),
            read_error: None,
            wait_error: None,
        });

        wait_for_events(&events, 2);
        assert_eq!(events.kinds(), vec!["output", "exited"]);
        let exit = waiting
            .join()
            .expect("the waiter thread ended")
            .expect("the waiter is answered");
        assert_eq!(exit.code, Some(3));
        assert_eq!(harness.record.lifecycle(), TerminalLifecycle::Exited);
    }

    #[test]
    fn an_exited_terminal_refuses_work_and_releases_every_subscription() {
        let harness = ActorHarness::start();
        let (authority, events) = harness.attach(true);

        harness.send(ReaderEvent::Exited {
            code: Some(0),
            read_error: None,
            wait_error: None,
        });
        wait_for_events(&events, 1);

        let refused = harness
            .handle
            .resize(authority, 100, 40)
            .expect_err("an exited terminal has no grid to move");
        assert_eq!(refused.code, TerminalErrorCode::Exited);
        assert_eq!(
            harness.detached.lock().unwrap().as_slice(),
            &[authority],
            "the exit released the subscription exactly once"
        );
    }

    #[test]
    fn a_theme_change_answers_only_a_child_that_asked_and_never_a_client() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);
        let theme = TerminalColorTheme {
            foreground: "#102030".to_string(),
            background: "#405060".to_string(),
            palette: vec!["#708090".to_string(); 16],
        };

        harness
            .handle
            .set_theme(theme.clone())
            .expect("a theme change needs no child");
        wait_for_events(&events, 1);
        assert!(
            harness.child_inbox.taken().is_empty(),
            "a child that did not ask for colour reports is not told"
        );

        // DEC mode 2031: the child asks to be told when colours change.
        harness.send(ReaderEvent::Data(b"\x1b[?2031h".to_vec()));
        wait_for_events(&events, 2);
        harness.child_inbox.taken();

        harness.handle.set_theme(theme).expect("the theme changes");
        wait_for_events(&events, 3);
        assert!(
            !harness.child_inbox.taken().is_empty(),
            "a child that asked is told the new colours"
        );
        assert_eq!(
            events.kinds(),
            vec!["replay", "output", "replay"],
            "the answer to the child never becomes a client event"
        );
    }

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
