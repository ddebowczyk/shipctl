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
use super::effects::TerminalEffect;
use super::input::TerminalInput;
use super::process::{ProcessTerminator, TERMINATION_GRACE_PERIOD};
use super::projection::{
    ProjectedPoint, ProjectedSpace, TerminalAnchor, TerminalAnchorId, TerminalHistoryWindow,
    TerminalProjection, TerminalSelectionRequest, TerminalSelectionState,
};
use super::publication::{
    event_audience, plan_child_output, plan_child_reply, plan_replay_transition,
    plan_semantic_state, resize_admission, subscriber_disposition, DeliveryOutcome, RuntimeEffect,
    RuntimeLiveness, SubscriberDisposition,
};
use super::record::TerminalRecord;
use super::replay::{validate_dimensions, VtReplayEngine};
use super::retention::TerminalRetentionPolicy;
use super::types::{
    TerminalAgentReportRequest, TerminalAttachment, TerminalAttachmentId, TerminalError,
    TerminalErrorCode, TerminalEvent, TerminalExit, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalLaunchTarget, TerminalMetadata, TerminalReplay,
    TerminalRevision, TerminalRuntimeSnapshot, TerminalTransport,
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

    /// Encodes one semantic input from the host's current modes and writes it
    /// to the child. Answers how many bytes that was, which is zero when the
    /// modes do not report the input.
    pub fn input(&self, input: TerminalInput) -> Result<usize, TerminalError> {
        self.request(|reply| RuntimeCommand::Input { input, reply })
    }

    /// Applies a selection intent and answers with what the host then holds.
    ///
    /// Ordered with output and input rather than beside them: a drag that
    /// arrives while the child is writing selects against the state the host
    /// has at that point, and every later read agrees with the answer.
    pub fn select(
        &self,
        request: TerminalSelectionRequest,
    ) -> Result<TerminalSelectionState, TerminalError> {
        self.request(|reply| RuntimeCommand::Select { request, reply })
    }

    pub fn attach(
        &self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        transport: TerminalTransport,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalAttachment, TerminalError> {
        self.request(|reply| RuntimeCommand::Attach {
            attachment_id,
            sink,
            claims_resize,
            transport,
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
    Select {
        request: TerminalSelectionRequest,
        reply: Sender<Result<TerminalSelectionState, TerminalError>>,
    },
    Input {
        input: TerminalInput,
        reply: Sender<Result<usize, TerminalError>>,
    },
    Attach {
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        transport: TerminalTransport,
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
    /// Which encoding this attachment asked for. The actor produces the other
    /// encoding only while somebody is listening for it.
    transport: TerminalTransport,
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
            RuntimeCommand::Select { request, reply } => {
                let result = self.vt.apply_selection(request).map_err(io_error);
                let _ = reply.send(result);
            }
            RuntimeCommand::Input { input, reply } => {
                // Encoded here, from the modes this actor's parser holds, and
                // written from here, in order with everything else the actor
                // does. A caller cannot encode it earlier: the modes it would
                // have to read are only correct at this point in the sequence.
                let result = self
                    .vt
                    .encode_input(&input)
                    .map_err(io_error)
                    .and_then(|bytes| {
                        if bytes.is_empty() {
                            // The current modes do not report this input. There
                            // is nothing to write and nothing wrong.
                            return Ok(0);
                        }
                        self.require_writable().and_then(|writer| {
                            writer
                                .write_all(&bytes)
                                .map(|()| bytes.len())
                                .map_err(|error| {
                                    io_error(format!("Failed to write to terminal: {error}"))
                                })
                        })
                    });
                let _ = reply.send(result);
            }
            RuntimeCommand::Attach {
                attachment_id,
                sink,
                claims_resize,
                transport,
                on_detached,
                reply,
            } => {
                let result =
                    self.attach(attachment_id, sink, claims_resize, transport, on_detached);
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
        let revision = descriptor.revision;
        self.apply(plan_replay_transition(descriptor, replay, sequence))
            .map_err(io_error)?;
        // A resize on the semantic path is state, not a replay to re-parse.
        self.publish_semantic_state(sequence, revision, Vec::new());
        Ok(())
    }

    fn snapshot(&mut self) -> Result<TerminalRuntimeSnapshot, TerminalError> {
        let replay = self.replay()?;
        Ok(TerminalRuntimeSnapshot {
            descriptor: self.record.descriptor(),
            sequence_boundary: self.sequence,
            replay,
            state: None,
        })
    }

    /// The baseline a semantic attachment starts from.
    ///
    /// The state is projected through a render state of its own, so consuming
    /// the damage of this read does not take the change away from the frames
    /// the stream is already publishing.
    ///
    /// The replay is reduced to the geometry it names. A client that reads
    /// meaning must not also be handed a second, parseable copy of the screen:
    /// area 05 deletes the field, and until then nothing on this path fills it.
    fn semantic_snapshot(&mut self) -> Result<TerminalRuntimeSnapshot, TerminalError> {
        let state = self
            .vt
            .project_baseline()
            .map_err(|message| io_error(format!("Failed to project state: {message}")))?;
        let descriptor = self.record.descriptor();
        Ok(TerminalRuntimeSnapshot {
            sequence_boundary: self.sequence,
            replay: TerminalReplay {
                revision: descriptor.revision,
                columns: descriptor.columns,
                rows: descriptor.rows,
                bytes: Arc::from(&[][..]),
            },
            descriptor,
            state: Some(Box::new(state)),
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
        let revision = descriptor.revision;
        let applied = self.apply(plan_replay_transition(descriptor, replay, sequence));
        // A theme change on the semantic path is state too: the colours the
        // client paints with are a fact it reads, not ANSI it replays.
        self.publish_semantic_state(sequence, revision, Vec::new());
        applied
    }

    fn attach(
        &mut self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        transport: TerminalTransport,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalAttachment, TerminalError> {
        let snapshot = match transport {
            TerminalTransport::Legacy => self.snapshot()?,
            TerminalTransport::Semantic => self.semantic_snapshot()?,
        };
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
            transport,
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

    /// Whether anybody is listening on the semantic path.
    ///
    /// Projecting the host's state costs real work, so it is done when it has a
    /// reader and not otherwise.
    fn has_semantic_attachment(&self) -> bool {
        self.subscribers
            .values()
            .any(|subscriber| subscriber.transport == TerminalTransport::Semantic)
    }

    /// Publish the semantic encoding of the occurrence that just happened.
    ///
    /// A projection failure is logged and dropped rather than raised: the
    /// occurrence has already happened, and the legacy audience has already
    /// been told. The semantic audience learns the state at the next
    /// occurrence, or by asking.
    fn publish_semantic_state(
        &mut self,
        sequence: u64,
        revision: TerminalRevision,
        effects: Vec<TerminalEffect>,
    ) {
        if !self.has_semantic_attachment() {
            return;
        }
        match self.vt.project() {
            Ok(state) => {
                let _ = self.apply(plan_semantic_state(state, effects, sequence, revision));
            }
            Err(error) => log::warn!(
                target: LOG_TARGET,
                "terminal {} could not project its state at sequence {sequence}: {error}",
                self.record.id()
            ),
        }
    }

    fn handle_output(&mut self, output: ReaderEvent) {
        match output {
            ReaderEvent::Data(data) => {
                let feed = self.vt.feed(&data);
                let sequence = self.next_sequence();
                let revision = self.record.note_output();
                // Output is published whether or not the child could be
                // answered: the bytes arrived either way.
                let _ = self.apply(plan_child_output(&data, feed.responses, sequence, revision));
                // The same occurrence, told as meaning. It carries the same
                // sequence because it is the same occurrence, and it reaches a
                // different set of attachments. The effects the parse reported
                // travel with it, in the order the parse reported them.
                self.publish_semantic_state(sequence, revision, feed.effects);
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
        let audience = event_audience(&event);
        let mut lost = Vec::new();
        for (attachment_id, subscriber) in &self.subscribers {
            if !audience.includes(subscriber.transport) {
                continue;
            }
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
    transport: TerminalTransport,
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
        transport,
        on_detached,
    })
}

fn event_sequence(event: &TerminalEvent) -> u64 {
    match event {
        TerminalEvent::Output { sequence, .. }
        | TerminalEvent::Replay { sequence, .. }
        | TerminalEvent::Screen { sequence, .. }
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

    use crate::terminal::effects::{TerminalClipboardContent, TerminalClipboardLocation};
    use crate::terminal::input::{
        TerminalKeyAction, TerminalKeyEvent, TerminalModifiers, TerminalMouseAction,
        TerminalMouseButton, TerminalMouseEvent, TerminalSurfaceGeometry,
    };
    use crate::terminal::projection::{
        ProjectedColor, ProjectedDamage, ProjectedDamageScope, ProjectedModes, ProjectedPrompt,
        ProjectedScreen, ProjectedSelectionMove, ProjectedWidth,
    };
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
                    TerminalEvent::Screen { .. } => "screen",
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

        /// Attaches one byte-path subscriber and returns its stream.
        fn attach(&self, claims_resize: bool) -> (TerminalAttachmentId, EventLog) {
            self.attach_with(claims_resize, TerminalTransport::Legacy)
        }

        /// Attaches one subscriber on the transport it asks for.
        fn attach_with(
            &self,
            claims_resize: bool,
            transport: TerminalTransport,
        ) -> (TerminalAttachmentId, EventLog) {
            let (attachment, events) = self.attach_returning(claims_resize, transport);
            (attachment.attachment_id, events)
        }

        /// The same attach, with the snapshot the host answered it with.
        fn attach_returning(
            &self,
            claims_resize: bool,
            transport: TerminalTransport,
        ) -> (TerminalAttachment, EventLog) {
            let attachment_id = TerminalAttachmentId::new();
            let events = EventLog::default();
            let detached = Arc::clone(&self.detached);
            let attachment = self
                .handle
                .attach(
                    attachment_id,
                    Arc::new(events.clone()),
                    claims_resize,
                    transport,
                    Arc::new(move |id| detached.lock().unwrap().push(id)),
                )
                .expect("attach needs no child");
            (attachment, events)
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

    /// Waits for a fact the actor holds, rather than for events about it.
    ///
    /// An attachment mailbox holds [`ATTACHMENT_MAILBOX_EVENTS`] events, and a
    /// subscriber that falls behind that far is resynchronized and dropped by
    /// design. A test that writes more than a mailbox-full therefore cannot
    /// count events to learn that the writes were applied — it asks the engine.
    fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
        for _ in 0..2_000 {
            if ready() {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("the actor never reached: {what}");
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
        // More writes than a mailbox holds, so the wait is on the engine's own
        // history rather than on a subscriber that the host may have dropped.
        wait_until("the anchored line scrolled into history", || {
            harness.handle.project_history(0, 1).is_ok_and(|window| {
                window
                    .rows
                    .first()
                    .is_some_and(|row| row.text().trim_end() == "anchored")
            })
        });

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

    fn key(code: &str, mods: TerminalModifiers, text: Option<&str>) -> TerminalInput {
        TerminalInput::Key(TerminalKeyEvent {
            action: TerminalKeyAction::Press,
            code: code.to_string(),
            text: text.map(str::to_string),
            mods,
            composing: false,
        })
    }

    /// Area 01 criterion 3. The semantic path out of `handle_output` publishes
    /// no child bytes and no ANSI replay, and the byte path is what the
    /// migration switch selects — not a default the actor falls back to.
    #[test]
    fn the_semantic_path_publishes_state_and_the_byte_path_publishes_bytes() {
        let harness = ActorHarness::start();
        let (_, legacy) = harness.attach_with(false, TerminalTransport::Legacy);
        let (_, semantic) = harness.attach_with(false, TerminalTransport::Semantic);

        harness.send(ReaderEvent::Data(b"hello".to_vec()));
        wait_for_events(&legacy, 1);
        wait_for_events(&semantic, 1);

        assert_eq!(legacy.kinds(), vec!["output"]);
        assert_eq!(semantic.kinds(), vec!["screen"]);

        let bytes = legacy.taken();
        let state = semantic.taken();
        let (legacy_sequence, revision) = match &bytes[0] {
            TerminalEvent::Output {
                sequence, revision, ..
            } => (*sequence, *revision),
            other => panic!("expected Output, got {other:?}"),
        };
        match &state[0] {
            TerminalEvent::Screen {
                sequence,
                revision: semantic_revision,
                state,
                ..
            } => {
                assert_eq!(
                    *sequence, legacy_sequence,
                    "one occurrence, one sequence, two encodings"
                );
                assert_eq!(*semantic_revision, revision);
                assert_eq!(state.viewport[0].text().trim_end(), "hello");
            }
            other => panic!("expected Screen, got {other:?}"),
        }

        // A resize is state on the semantic path, not ANSI to re-parse.
        let (authority, _) = harness.attach_with(true, TerminalTransport::Legacy);
        harness.handle.resize(authority, 40, 12).expect("resize");
        wait_for_events(&legacy, 1);
        wait_for_events(&semantic, 1);
        assert_eq!(legacy.kinds(), vec!["replay"]);
        assert_eq!(semantic.kinds(), vec!["screen"]);
        match &semantic.taken()[0] {
            TerminalEvent::Screen { state, .. } => assert_eq!(state.columns, 40),
            other => panic!("expected Screen, got {other:?}"),
        }
        legacy.taken();

        // Lifecycle is neither encoding, so both hear it.
        harness.send(ReaderEvent::Exited {
            code: Some(0),
            read_error: None,
            wait_error: None,
        });
        wait_for_events(&legacy, 1);
        wait_for_events(&semantic, 1);
        assert_eq!(legacy.kinds(), vec!["exited"]);
        assert_eq!(semantic.kinds(), vec!["exited"]);
    }

    /// Area 01 criterion 6, on the production path: a client reports what the
    /// person did, and the actor decides what bytes that is from the modes the
    /// child selected. Nothing here is a keymap the client could hold, because
    /// the same event encodes differently a moment later.
    #[test]
    fn input_is_encoded_from_the_modes_the_child_selected() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        // Arrows, before and after the child asks for application cursor keys.
        assert!(
            harness
                .handle
                .input(key("ArrowUp", TerminalModifiers::default(), None))
                .expect("the actor encodes a key")
                > 0
        );
        assert_eq!(harness.child_inbox.taken(), b"\x1b[A");

        harness.send(ReaderEvent::Data(b"\x1b[?1h".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(key("ArrowUp", TerminalModifiers::default(), None))
            .expect("the actor encodes a key");
        assert_eq!(
            harness.child_inbox.taken(),
            b"\x1bOA",
            "the same key, a different mode, different bytes"
        );

        // A control character is derived from the key and the modifiers, not
        // sent as text by the client.
        harness
            .handle
            .input(key(
                "KeyC",
                TerminalModifiers {
                    ctrl: true,
                    ..TerminalModifiers::default()
                },
                Some("c"),
            ))
            .expect("the actor encodes a key");
        assert_eq!(harness.child_inbox.taken(), b"\x03");

        // Application keypad mode, which is a command the child sends and a
        // fact no client can see any other way.
        harness
            .handle
            .input(key("NumpadAdd", TerminalModifiers::default(), Some("+")))
            .expect("the actor encodes a key");
        assert_eq!(harness.child_inbox.taken(), b"+");
        harness.send(ReaderEvent::Data(b"\x1b[?66h\x1b[?1035l".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(key("NumpadAdd", TerminalModifiers::default(), Some("+")))
            .expect("the actor encodes a key");
        assert_eq!(
            harness.child_inbox.taken(),
            b"\x1bOk",
            "two modes decide this together, and the layout text loses to them"
        );

        // The Kitty keyboard protocol is another such command, and it changes
        // the encoding of keys the legacy mode has no way to report.
        harness.send(ReaderEvent::Data(b"\x1b[>1u".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(key("Escape", TerminalModifiers::default(), None))
            .expect("the actor encodes a key");
        assert_eq!(harness.child_inbox.taken(), b"\x1b[27u");

        // A key the host cannot name is refused rather than guessed at.
        assert!(harness
            .handle
            .input(key("NoSuchKey", TerminalModifiers::default(), None))
            .is_err());
    }

    /// Composition, paste, pointer and focus, each gated by the mode that
    /// governs it. An input the modes do not report writes nothing.
    #[test]
    fn composed_text_paste_pointer_and_focus_follow_their_modes() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        // A composing key produces no bytes; the commit produces the text.
        harness
            .handle
            .input(TerminalInput::Key(TerminalKeyEvent {
                action: TerminalKeyAction::Press,
                code: "KeyA".to_string(),
                text: Some("a".to_string()),
                mods: TerminalModifiers::default(),
                composing: true,
            }))
            .expect("the actor accepts a composing key");
        assert!(
            harness.child_inbox.taken().is_empty(),
            "a composition in progress is not input yet"
        );
        harness
            .handle
            .input(TerminalInput::Text {
                text: "日本".to_string(),
            })
            .expect("the actor writes committed text");
        assert_eq!(harness.child_inbox.taken(), "日本".as_bytes());

        // Paste follows bracketed-paste mode.
        harness
            .handle
            .input(TerminalInput::Paste {
                text: "ls".to_string(),
            })
            .expect("the actor encodes a paste");
        assert_eq!(harness.child_inbox.taken(), b"ls");

        harness.send(ReaderEvent::Data(b"\x1b[?2004h".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(TerminalInput::Paste {
                text: "ls".to_string(),
            })
            .expect("the actor encodes a paste");
        assert_eq!(harness.child_inbox.taken(), b"\x1b[200~ls\x1b[201~");

        // The pointer says nothing until the child asks to hear about it.
        let surface = TerminalSurfaceGeometry {
            screen_width: 800,
            screen_height: 480,
            cell_width: 10,
            cell_height: 20,
            padding_top: 0,
            padding_bottom: 0,
            padding_left: 0,
            padding_right: 0,
        };
        let press = TerminalInput::Mouse(TerminalMouseEvent {
            action: TerminalMouseAction::Press,
            button: Some(TerminalMouseButton::Left),
            mods: TerminalModifiers::default(),
            x: 25.0,
            y: 21.0,
            surface,
            any_button_pressed: true,
        });
        assert_eq!(
            harness
                .handle
                .input(press.clone())
                .expect("the actor answers a pointer event"),
            0,
            "no tracking mode, no report"
        );
        assert!(harness.child_inbox.taken().is_empty());

        harness.send(ReaderEvent::Data(b"\x1b[?1000h\x1b[?1006h".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(press)
            .expect("the actor encodes a pointer event");
        assert_eq!(
            harness.child_inbox.taken(),
            b"\x1b[<0;3;2M",
            "the host turned pixels into a cell using the geometry the client sent"
        );

        // The wheel is one of those buttons. A client reports the direction as
        // the button it is, and the host encodes the scroll report.
        harness
            .handle
            .input(TerminalInput::Mouse(TerminalMouseEvent {
                action: TerminalMouseAction::Press,
                button: Some(TerminalMouseButton::Five),
                mods: TerminalModifiers::default(),
                x: 25.0,
                y: 21.0,
                surface,
                any_button_pressed: false,
            }))
            .expect("the actor encodes a wheel report");
        assert_eq!(
            harness.child_inbox.taken(),
            b"\x1b[<65;3;2M",
            "a wheel the child asked for reaches it as a scroll, not as a scrollback move"
        );

        // Focus is reported only under mode 1004.
        assert_eq!(
            harness
                .handle
                .input(TerminalInput::Focus { gained: true })
                .expect("the actor answers a focus change"),
            0
        );
        harness.send(ReaderEvent::Data(b"\x1b[?1004h".to_vec()));
        wait_for_events(&events, 1);
        harness
            .handle
            .input(TerminalInput::Focus { gained: true })
            .expect("the actor encodes a focus change");
        assert_eq!(harness.child_inbox.taken(), b"\x1b[I");
        harness
            .handle
            .input(TerminalInput::Focus { gained: false })
            .expect("the actor encodes a focus change");
        assert_eq!(harness.child_inbox.taken(), b"\x1b[O");
    }

    /// The webview's keybinding presets, as the meaning they always were.
    ///
    /// Each preset ships a byte sequence a client writes: `\n` for the newline
    /// on shift-return, `\x17` for delete-word, `\x0c` for clear. Those bytes
    /// are what this host already makes of what the person asked for, so the
    /// client can report the meaning and stop holding the sequence.
    ///
    /// The values are taken from the input fixture by name rather than restated
    /// here, so what the client receives is what this test proved.
    #[test]
    fn the_keybinding_presets_are_bytes_this_host_already_makes() {
        let harness = ActorHarness::start();
        let _ = harness.attach(false);

        let samples = super::super::contract::sample_inputs();
        let sample = |name: &str| {
            samples
                .iter()
                .find(|sample| sample.name == name)
                .map(|sample| sample.input.clone())
                .unwrap_or_else(|| panic!("the input fixture has no {name} sample"))
        };

        for (name, bytes) in [
            ("preset-delete-word", b"\x17".as_slice()),
            ("preset-clear-screen", b"\x0c".as_slice()),
            ("preset-newline", b"\n".as_slice()),
        ] {
            harness
                .handle
                .input(sample(name))
                .expect("the actor encodes the preset");
            assert_eq!(
                harness.child_inbox.taken(),
                bytes,
                "{name} reaches the child as the sequence the preset ships"
            );
        }
    }

    /// Selection on the production path. The client sends an intent, the actor
    /// answers with the state and the text, and the projection every client
    /// reads carries the same answer. No client computes which cells a gesture
    /// covers, and none re-reads bytes to find out.
    #[test]
    fn selection_is_an_intent_the_actor_answers() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        harness.send(ReaderEvent::Data(b"alpha beta gamma\r\n".to_vec()));
        wait_for_events(&events, 1);

        let selected = harness
            .handle
            .select(TerminalSelectionRequest::Word {
                space: ProjectedSpace::Active,
                at: ProjectedPoint { column: 0, row: 0 },
            })
            .expect("the actor selects a word");
        assert!(selected.active);
        assert_eq!(selected.text.as_deref(), Some("alpha"));

        let extended = harness
            .handle
            .select(TerminalSelectionRequest::Extend {
                movement: ProjectedSelectionMove::EndOfLine,
            })
            .expect("the actor extends the selection");
        assert_eq!(
            extended.text.as_deref(),
            Some("alpha beta gamma"),
            "the host resolved the end of the line, not the client"
        );

        let marked: String = harness
            .handle
            .project()
            .expect("the actor projects")
            .viewport[0]
            .cells
            .iter()
            .filter(|cell| cell.selected)
            .map(|cell| cell.text.as_str())
            .collect();
        assert_eq!(
            marked, "alpha beta gamma",
            "the selection reaches clients as the per-cell fact every read carries"
        );

        let cleared = harness
            .handle
            .select(TerminalSelectionRequest::Clear)
            .expect("the actor clears the selection");
        assert!(!cleared.active && cleared.text.is_none());
        assert!(harness
            .handle
            .project()
            .expect("the actor projects")
            .viewport
            .iter()
            .all(|row| row.cells.iter().all(|cell| !cell.selected)));
    }

    /// Area 01 criterion 5: what happened travels beside what the screen now
    /// is, in the order the parse reported it, and the answer the parser owed
    /// the child goes to the child alone.
    ///
    /// OSC 9 is absent from this list on purpose. The pinned parser reports no
    /// payload for it, and the approved disposition is to expose it in the
    /// dependency rather than to scan the child's bytes beside the parser —
    /// see gap 1 in `docs/ops/terminal-vt-dependency.md`.
    #[test]
    fn occurrences_reach_clients_in_order_and_replies_reach_only_the_child() {
        let harness = ActorHarness::start();
        let (_, legacy) = harness.attach_with(false, TerminalTransport::Legacy);
        let (_, semantic) = harness.attach_with(false, TerminalTransport::Semantic);

        // One chunk: text, a title, a bell, a directory, a clipboard write, and
        // a cursor report the child asked for.
        harness.send(ReaderEvent::Data(
            b"one\x1b]0;shipctl\x1b\\two\x07\x1b]7;file:///workspace\x1b\\\
              \x1b]52;c;aGVsbG8=\x1b\\\x1b[6n"
                .to_vec(),
        ));
        wait_for_events(&semantic, 1);
        wait_for_events(&legacy, 1);

        let effects = match &semantic.taken()[0] {
            TerminalEvent::Screen { effects, .. } => effects.clone(),
            other => panic!("expected Screen, got {other:?}"),
        };
        assert_eq!(
            effects,
            vec![
                TerminalEffect::Title {
                    title: "shipctl".to_string()
                },
                TerminalEffect::Bell,
                TerminalEffect::WorkingDirectory {
                    uri: "file:///workspace".to_string()
                },
                TerminalEffect::Clipboard {
                    location: TerminalClipboardLocation::Standard,
                    contents: vec![TerminalClipboardContent {
                        mime: "text/plain".to_string(),
                        data: "hello".to_string(),
                    }],
                },
            ],
            "the order is the child's order, not the order of the reads"
        );

        // The cursor report is the parser's answer to the child. It went to the
        // child and to no client, on either encoding.
        let replies = harness.child_inbox.taken();
        assert_eq!(replies, b"\x1b[1;7R".to_vec());
        assert_eq!(legacy.kinds(), vec!["output"]);
        let published = legacy.taken();
        match &published[0] {
            TerminalEvent::Output { data, .. } => assert!(
                !data.windows(3).any(|window| window == b"[1;"),
                "the answer to the child is not in the client's bytes"
            ),
            other => panic!("expected Output, got {other:?}"),
        }

        // Screen state is not where an occurrence goes: nothing above turned
        // into a cell, and the next chunk carries its own occurrences only.
        harness.send(ReaderEvent::Data(b"plain".to_vec()));
        wait_for_events(&semantic, 1);
        match &semantic.taken()[0] {
            TerminalEvent::Screen { effects, .. } => assert!(
                effects.is_empty(),
                "occurrences belong to the parse that reported them"
            ),
            other => panic!("expected Screen, got {other:?}"),
        }
    }

    /// Area 01 criterion 4: a resize and a theme change are state transitions
    /// the host decides. The resize proves the host reflowed the text, so no
    /// client has to re-wrap it. The theme proves the published colours are the
    /// resolved ones — the child's choices survive, and only what the child did
    /// not choose follows the application theme.
    #[test]
    fn a_resize_reflows_and_a_theme_publishes_the_resolved_colours() {
        let harness = ActorHarness::start();
        let (authority, legacy) = harness.attach_with(true, TerminalTransport::Legacy);
        let (_, semantic) = harness.attach_with(false, TerminalTransport::Semantic);

        let line = "x".repeat(60);
        harness.send(ReaderEvent::Data(line.clone().into_bytes()));
        wait_for_events(&semantic, 1);
        let before = harness.handle.project().expect("the actor projects");
        assert!(
            !before.viewport[0].wrapped,
            "sixty columns of eighty do not wrap"
        );

        harness.handle.resize(authority, 40, 12).expect("resize");
        wait_for_events(&semantic, 2);
        let after = harness.handle.project().expect("the actor projects");
        assert_eq!((after.columns, after.rows), (40, 12));
        assert!(
            after.viewport[0].wrapped && after.viewport[1].continuation,
            "the host reflowed the row; the client is told, not asked"
        );
        assert_eq!(
            format!(
                "{}{}",
                after.viewport[0].text(),
                after.viewport[1].text().trim_end()
            ),
            line,
            "reflow moved the text, it did not lose it"
        );

        // The child chooses its own background and one palette entry.
        harness.send(ReaderEvent::Data(
            b"\x1b]11;#204060\x1b\\\x1b]4;1;#010203\x1b\\".to_vec(),
        ));
        wait_for_events(&semantic, 3);

        let theme = TerminalColorTheme {
            foreground: "#101112".to_string(),
            background: "#131415".to_string(),
            palette: vec!["#161718".to_string(); 16],
        };
        harness.handle.set_theme(theme).expect("the theme changes");
        wait_for_events(&semantic, 4);

        assert_eq!(
            semantic.kinds(),
            vec!["screen"; 4],
            "no ANSI reconstruction reached the semantic subscriber"
        );
        let colours = match semantic.taken().pop() {
            Some(TerminalEvent::Screen { state, .. }) => state.colors,
            other => panic!("expected Screen, got {other:?}"),
        };
        assert_eq!(
            colours.background,
            Some(ProjectedColor {
                r: 0x20,
                g: 0x40,
                b: 0x60
            }),
            "the application theme did not overwrite the colour the child chose"
        );
        assert_eq!(
            colours.palette[1],
            ProjectedColor {
                r: 0x01,
                g: 0x02,
                b: 0x03
            },
            "a child-authored palette entry survives the theme too"
        );
        assert_eq!(
            colours.foreground,
            Some(ProjectedColor {
                r: 0x10,
                g: 0x11,
                b: 0x12
            }),
            "what the child did not choose resolves to the new theme"
        );
        assert_eq!(
            colours.palette[2],
            ProjectedColor {
                r: 0x16,
                g: 0x17,
                b: 0x18
            }
        );
        legacy.taken();
    }

    /// A client that attaches mid-stream needs a baseline it can read. On the
    /// semantic path that baseline is state, and it must not consume the damage
    /// the attachments already following the stream have not read yet.
    #[test]
    fn a_semantic_attachment_starts_from_state_and_a_byte_one_does_not() {
        let harness = ActorHarness::start();
        let (_, following) = harness.attach_with(false, TerminalTransport::Semantic);
        harness.send(ReaderEvent::Data(b"already here".to_vec()));
        wait_for_events(&following, 1);
        following.taken();

        let (legacy, _) = harness.attach_returning(false, TerminalTransport::Legacy);
        assert!(
            legacy.snapshot.state.is_none(),
            "a byte-path attachment is given no state to read"
        );
        assert!(
            !legacy.snapshot.replay.bytes.is_empty(),
            "and is given the bytes it does read"
        );

        let (semantic, _) = harness.attach_returning(false, TerminalTransport::Semantic);
        let state = semantic
            .snapshot
            .state
            .expect("a semantic attachment is given the state it reads");
        assert_eq!(state.viewport[0].text().trim_end(), "already here");
        assert_eq!(
            state.damage.scope,
            ProjectedDamageScope::Full,
            "a client that has painted nothing is told to paint everything"
        );
        assert_eq!(
            semantic.snapshot.sequence_boundary, 1,
            "the baseline names the occurrence it is current as of"
        );
        assert!(
            semantic.snapshot.replay.bytes.is_empty(),
            "and is given no second, parseable copy of the screen"
        );
        assert_eq!(
            semantic.snapshot.replay.columns, legacy.snapshot.replay.columns,
            "the geometry the baseline names is the host's"
        );

        // The stream the first attachment follows still owes it that change.
        harness.send(ReaderEvent::Data(b"!".to_vec()));
        wait_for_events(&following, 1);
        match following.taken().pop() {
            Some(TerminalEvent::Screen { state, .. }) => assert_eq!(
                state.damage.scope,
                ProjectedDamageScope::Partial,
                "the baseline read did not take the stream's damage away from it"
            ),
            other => panic!("expected Screen, got {other:?}"),
        }
    }

    /// Area 01 criterion 1. One representative trace through the running actor,
    /// and every terminal fact read back out of the live projection.
    ///
    /// The facts this test is the only proof of are the per-cell and per-row
    /// ones — grapheme, occupancy, style, link, prompt — plus the screen,
    /// cursor, mode, palette and damage facts. History, selection and effects
    /// are proved through the same handle by the tests named for them.
    ///
    /// The attachment is a byte-path one on purpose: a semantic attachment
    /// would project on every chunk, and damage is a difference, so the actor
    /// would consume the change this test asks about before the test could read
    /// it.
    #[test]
    fn one_trace_through_the_actor_carries_every_terminal_fact() {
        let harness = ActorHarness::start();
        let (_, events) = harness.attach(false);

        let mut trace: Vec<u8> = Vec::new();
        // More lines than the screen holds, so rows leave for history.
        for line in 0..30 {
            trace.extend_from_slice(format!("fill{line}\r\n").as_bytes());
        }
        // Home, then erase what the fills left, so every row this test reads is
        // one this test wrote.
        trace.extend_from_slice(b"\x1b[H\x1b[J");
        // A shell prompt, styled text, a wide grapheme with a combining mark
        // after it, a hyperlink, and a palette entry the child chose.
        trace.extend_from_slice(b"\x1b]133;A\x1b\\");
        trace.extend_from_slice(b"$ \x1b[1;38;2;10;20;30mbold\x1b[0m done\r\n");
        trace.extend_from_slice("\u{6f22}e\u{301}\r\n".as_bytes());
        trace.extend_from_slice(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\r\n");
        trace.extend_from_slice(b"\x1b]4;3;rgb:0a/0b/0c\x1b\\");
        // Exactly one row of text: the row is full and the next character
        // decides whether it wraps.
        trace.extend(std::iter::repeat_n(b'w', 80));
        harness.send(ReaderEvent::Data(trace));
        wait_for_events(&events, 1);

        let state = harness.handle.project().expect("the actor projects");
        assert_eq!((state.columns, state.rows), (80, 24));
        assert_eq!(state.screen, ProjectedScreen::Primary);
        assert!(
            state.scrollback_rows > 0,
            "the rows that left the screen are retained, and the count says so"
        );

        let prompt_row = &state.viewport[0];
        assert_eq!(
            prompt_row.prompt,
            ProjectedPrompt::Prompt,
            "the host reports the OSC 133 marking; a client does not guess it"
        );
        assert_eq!(prompt_row.text().trim_end(), "$ bold done");
        let styled = &prompt_row.cells[2];
        assert_eq!(styled.text, "b");
        assert!(styled.bold);
        assert_eq!(
            styled.foreground,
            Some(ProjectedColor {
                r: 10,
                g: 20,
                b: 30
            })
        );
        assert!(
            !prompt_row.cells[0].bold && prompt_row.cells[0].foreground.is_none(),
            "the style belongs to the cells the child styled and no others"
        );

        let grapheme_row = &state.viewport[1];
        assert_eq!(grapheme_row.cells[0].text, "\u{6f22}");
        assert_eq!(
            grapheme_row.cells[0].width,
            ProjectedWidth::Wide,
            "the host owns how many columns a grapheme takes"
        );
        assert_eq!(grapheme_row.cells[1].width, ProjectedWidth::SpacerTail);
        assert!(
            grapheme_row.cells[1].text.is_empty(),
            "the second column of a wide grapheme carries no text to draw"
        );
        assert_eq!(
            grapheme_row.cells[2].text, "e\u{301}",
            "the combining mark stays on the cell it belongs to"
        );

        let link_row = &state.viewport[2];
        assert_eq!(link_row.text().trim_end(), "link");
        assert_eq!(
            link_row.cells[0].hyperlink.as_deref(),
            Some("https://example.com")
        );
        assert!(
            link_row.cells[6].hyperlink.is_none(),
            "the link ends where the child ended it"
        );

        assert_eq!(
            state.colors.foreground,
            Some(ProjectedColor {
                r: 0xff,
                g: 0xff,
                b: 0xff
            })
        );
        assert_eq!(
            state.colors.palette[3],
            ProjectedColor {
                r: 0x0a,
                g: 0x0b,
                b: 0x0c
            },
            "the palette entry the child set, not the one the theme carried"
        );

        assert!(
            state.cursor.visible && state.cursor.pending_wrap,
            "the row is full and the cursor waits; a client cannot infer this \
             from the cells"
        );
        assert_eq!((state.cursor.column, state.cursor.row), (79, 3));
        assert_eq!(
            state.damage.scope,
            ProjectedDamageScope::Full,
            "the first read of a screen has no earlier read to differ from"
        );

        assert_eq!(
            harness
                .handle
                .project()
                .expect("the actor projects")
                .damage
                .scope,
            ProjectedDamageScope::Clean,
            "nothing happened between the two reads"
        );

        // One more character: the full row wraps onto the next one.
        harness.send(ReaderEvent::Data(b"wwwwwwwwwwwwwwwwwwww".to_vec()));
        wait_for_events(&events, 2);
        let wrapped = harness.handle.project().expect("the actor projects");
        assert!(wrapped.viewport[3].wrapped && wrapped.viewport[4].continuation);
        assert!(!wrapped.cursor.pending_wrap);
        assert_eq!(
            wrapped.damage,
            ProjectedDamage {
                scope: ProjectedDamageScope::Partial,
                rows: vec![3, 4]
            },
            "the host names the rows that changed since the previous read"
        );

        // Every mode a client would otherwise guess.
        harness.send(ReaderEvent::Data(
            b"\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[4h\x1b[?5h\x1b[?6h\x1b[?25l".to_vec(),
        ));
        wait_for_events(&events, 3);
        let modes = harness.handle.project().expect("the actor projects");
        assert_eq!(
            modes.modes,
            ProjectedModes {
                wraparound: true,
                bracketed_paste: true,
                application_cursor_keys: true,
                application_keypad: false,
                focus_events: true,
                mouse_tracking: true,
                insert: true,
                reverse_video: true,
                origin: true,
            }
        );
        assert!(
            !modes.cursor.visible,
            "the child hid the cursor and the host says so"
        );

        // The alternate screen is its own surface, and leaving it restores the
        // one underneath unchanged.
        harness.send(ReaderEvent::Data(b"\x1b[?1049h".to_vec()));
        wait_for_events(&events, 4);
        let alternate = harness.handle.project().expect("the actor projects");
        assert_eq!(alternate.screen, ProjectedScreen::Alternate);
        assert!(
            alternate
                .viewport
                .iter()
                .all(|row| row.text().trim().is_empty()),
            "the alternate screen starts empty"
        );

        harness.send(ReaderEvent::Data(b"\x1b[?1049l".to_vec()));
        wait_for_events(&events, 5);
        let restored = harness.handle.project().expect("the actor projects");
        assert_eq!(restored.screen, ProjectedScreen::Primary);
        assert_eq!(restored.viewport[2].text().trim_end(), "link");
        assert_eq!(
            restored.viewport[2].cells[0].hyperlink.as_deref(),
            Some("https://example.com"),
            "the primary screen came back whole, links included"
        );
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
