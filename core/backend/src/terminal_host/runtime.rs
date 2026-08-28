//! One ordered owner for a terminal's PTY, VT state, query responses, and
//! lifecycle. The service sends commands; transports observe events.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use super::{
    TerminalByteOccurrence, TerminalColorTheme, TerminalDriverError, TerminalDriverFactory,
    TerminalDriverSession, TerminalDriverSessionRequest, TerminalDriverUpdate,
};
use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender, TryRecvError, TrySendError};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::process::{ProcessTerminator, TERMINATION_GRACE_PERIOD};
use super::publication::{
    event_audience, plan_child_output, resize_admission, subscriber_disposition, DeliveryOutcome,
    RuntimeEffect, RuntimeLiveness, SubscriberDisposition,
};
use super::record::TerminalRecord;
use super::retention::TerminalRetentionPolicy;
use super::types::{
    TerminalAgentReportRequest, TerminalAttachmentId, TerminalDriverAttachment, TerminalError,
    TerminalErrorCode, TerminalEvent, TerminalExit, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalLaunchTarget, TerminalMetadata, TerminalRawAttachment,
    TerminalRevision,
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
const MAX_EXACT_JSON_INTEGER: u64 = (1_u64 << 53) - 1;

pub trait TerminalEventSink: Send + Sync + 'static {
    fn publish(&self, terminal_id: TerminalId, event: TerminalEvent) -> Result<(), String>;

    /// Publish an event whose JSON was encoded once before attachment fan-out.
    /// Typed sinks keep their existing contract. Tauri sends the cached JSON
    /// directly, so a second webview does not serialize the screen again.
    fn publish_preencoded(
        &self,
        terminal_id: TerminalId,
        event: PublishedTerminalEvent,
    ) -> Result<(), String> {
        self.publish(terminal_id, event.event().clone())
    }

    /// A successful synchronous publish is a client commit. The Tauri webview
    /// overrides this because channel admission is earlier than model commit.
    fn commits_screen_on_publish(&self) -> bool {
        true
    }
}

/// Delivers one selected driver's opaque presentation event. The driver owns
/// the event schema; the host owns only the attachment and its ordering.
pub trait TerminalDriverEventSink: Send + Sync + 'static {
    fn publish(&self, terminal_id: TerminalId, event: serde_json::Value) -> Result<(), String>;
}

impl<F> TerminalDriverEventSink for F
where
    F: Fn(TerminalId, serde_json::Value) -> Result<(), String> + Send + Sync + 'static,
{
    fn publish(&self, terminal_id: TerminalId, event: serde_json::Value) -> Result<(), String> {
        self(terminal_id, event)
    }
}

/// One typed event and its canonical JSON encoding, shared by all attachments.
#[derive(Clone)]
pub struct PublishedTerminalEvent {
    event: TerminalEvent,
    json: Arc<str>,
}

/// Cumulative publication evidence from one terminal runtime.
///
/// These are observations, not limits or gates. A scenario reads two samples
/// and reports their difference for the workload between them.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPublicationStats {
    pub pty_reads: u64,
    pub screen_changes: u64,
    pub screen_projections: u64,
    pub screen_encodes: u64,
    pub screen_encoded_bytes: u64,
    pub screen_recipient_deliveries: u64,
    pub effect_events: u64,
    pub effect_encoded_bytes: u64,
    pub current_screen_transactions: u64,
    pub current_screen_bytes_queued: u64,
    pub peak_screen_bytes_queued: u64,
    pub current_effect_events_queued: u64,
    pub current_effect_bytes_queued: u64,
    pub peak_effect_events_queued: u64,
    pub peak_effect_bytes_queued: u64,
}

impl PublishedTerminalEvent {
    fn encode(event: TerminalEvent) -> Result<Self, serde_json::Error> {
        let json = serde_json::to_string(&event)?;
        Ok(Self {
            event,
            json: Arc::from(json),
        })
    }

    pub fn event(&self) -> &TerminalEvent {
        &self.event
    }

    pub fn json(&self) -> &str {
        &self.json
    }
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
        driver_factory: Option<Arc<dyn TerminalDriverFactory>>,
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
                        driver_factory,
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

    /// Send an opaque request to the selected terminal driver. The actor keeps
    /// driver mutations and any resulting child input in terminal order.
    pub fn request_driver(
        &self,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, TerminalError> {
        self.request(|reply| RuntimeCommand::DriverRequest { request, reply })
    }

    pub fn publication_stats(&self) -> Result<TerminalPublicationStats, TerminalError> {
        self.request(|reply| RuntimeCommand::PublicationStats { reply })
    }

    /// Attach exact child bytes without constructing a client replay snapshot.
    pub fn attach_raw(
        &self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalRawAttachment, TerminalError> {
        self.request(|reply| RuntimeCommand::AttachRaw {
            attachment_id,
            sink,
            claims_resize,
            on_detached,
            reply,
        })
    }

    /// Attach the selected native driver's own presentation stream.
    pub fn attach_driver(
        &self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalDriverEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalDriverAttachment, TerminalError> {
        self.request(|reply| RuntimeCommand::AttachDriver {
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

    /// Commit one selected-driver presentation event and permit the next one.
    pub fn credit_driver_presentation(
        &self,
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
    ) -> Result<(), TerminalError> {
        self.request(|reply| RuntimeCommand::CreditDriverPresentation {
            attachment_id,
            committed_sequence,
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
    DriverRequest {
        request: serde_json::Value,
        reply: Sender<Result<serde_json::Value, TerminalError>>,
    },
    PublicationStats {
        reply: Sender<Result<TerminalPublicationStats, TerminalError>>,
    },
    AttachRaw {
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
        reply: Sender<Result<TerminalRawAttachment, TerminalError>>,
    },
    AttachDriver {
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalDriverEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
        reply: Sender<Result<TerminalDriverAttachment, TerminalError>>,
    },
    Detach {
        attachment_id: TerminalAttachmentId,
        reply: Sender<Result<(), TerminalError>>,
    },
    CreditDriverPresentation {
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
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
    events: Sender<PublishedTerminalEvent>,
    control: Sender<PublishedTerminalEvent>,
    /// Which encoding this attachment asked for. The actor produces the other
    /// encoding only while somebody is listening for it.
    on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
}

struct DriverSubscriber {
    events: Sender<serde_json::Value>,
    screen_in_flight: Option<u64>,
    screen_credit: bool,
    last_screen_sequence: u64,
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
    /// The build-selected native interpreter. It is created and used only on
    /// this actor thread; raw-only drivers leave it absent.
    driver: Option<Box<dyn TerminalDriverSession>>,
    subscribers: HashMap<TerminalAttachmentId, Subscriber>,
    driver_subscribers: HashMap<TerminalAttachmentId, DriverSubscriber>,
    subscriber_status_sender: Sender<SubscriberStatus>,
    subscriber_status_receiver: Receiver<SubscriberStatus>,
    resize_authority: Option<TerminalAttachmentId>,
    child_pid: Option<u32>,
    sequence: u64,
    /// The latest sequence that changed the selected driver's presentation.
    screen_sequence: u64,
    screen_revision: TerminalRevision,
    publication_stats: TerminalPublicationStats,
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
        driver_factory: Option<Arc<dyn TerminalDriverFactory>>,
    ) -> Result<Self, TerminalError> {
        if request.columns == 0 || request.rows == 0 {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Terminal dimensions must be greater than zero",
            ));
        }
        let driver = driver_factory
            .map(|factory| {
                factory.create(TerminalDriverSessionRequest {
                    columns: request.columns,
                    rows: request.rows,
                    color_theme: request.color_theme.clone(),
                    scrollback_bytes: retention.bytes(),
                })
            })
            .transpose()
            .map_err(|error| {
                TerminalError::new(TerminalErrorCode::StartupFailed, error.to_string())
            })?;
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
            driver,
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
        driver: Option<Box<dyn TerminalDriverSession>>,
        child: ChildAttachment,
    ) -> Self {
        let (subscriber_status_sender, subscriber_status_receiver) = unbounded();
        let screen_revision = record.descriptor().revision;
        Self {
            record,
            command_receiver,
            output_receiver,
            geometry: child.geometry,
            writer: child.writer,
            terminator: child.terminator,
            driver,
            subscribers: HashMap::new(),
            driver_subscribers: HashMap::new(),
            subscriber_status_sender,
            subscriber_status_receiver,
            resize_authority: None,
            child_pid: child.child_pid,
            sequence: 0,
            screen_sequence: 0,
            screen_revision,
            publication_stats: TerminalPublicationStats::default(),
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
            RuntimeCommand::DriverRequest { request, reply } => {
                let result = self.request_driver(request);
                let _ = reply.send(result);
            }
            RuntimeCommand::PublicationStats { reply } => {
                let _ = reply.send(Ok(self.publication_stats()));
            }
            RuntimeCommand::AttachRaw {
                attachment_id,
                sink,
                claims_resize,
                on_detached,
                reply,
            } => {
                let result = self.attach_raw(attachment_id, sink, claims_resize, on_detached);
                let _ = reply.send(result);
            }
            RuntimeCommand::AttachDriver {
                attachment_id,
                sink,
                claims_resize,
                on_detached,
                reply,
            } => {
                let result = self.attach_driver(attachment_id, sink, claims_resize, on_detached);
                let _ = reply.send(result);
            }
            RuntimeCommand::Detach {
                attachment_id,
                reply,
            } => {
                self.detach_subscriber(attachment_id, "detached by client");
                let _ = reply.send(Ok(()));
            }
            RuntimeCommand::CreditDriverPresentation {
                attachment_id,
                committed_sequence,
                reply,
            } => {
                let result = self.credit_driver_presentation(attachment_id, committed_sequence);
                let _ = reply.send(result);
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
        if columns == 0 || rows == 0 {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Terminal dimensions must be greater than zero",
            ));
        }
        self.geometry
            .as_ref()
            .ok_or_else(runtime_stopped)?
            .resize(columns, rows)
            .map_err(io_error)?;
        if let Some(driver) = self.driver.as_mut() {
            driver.on_resize(columns, rows).map_err(driver_error)?;
        }
        let descriptor = self.record.record_resize(columns, rows);
        self.publish_descriptor(descriptor.clone());
        let sequence = self.next_sequence();
        if self.driver.is_some() {
            self.note_screen_change(sequence, descriptor.revision);
        }
        Ok(())
    }

    fn set_theme(&mut self, theme: &TerminalColorTheme) -> Result<(), String> {
        let update = self
            .driver
            .as_mut()
            .map(|driver| {
                driver
                    .set_color_theme(theme)
                    .map_err(|error| error.to_string())
            })
            .transpose()?;
        let descriptor = self.record.note_replay_change();
        self.publish_descriptor(descriptor.clone());
        if update
            .as_ref()
            .is_some_and(|update| update.presentation_changed)
        {
            let sequence = self.next_sequence();
            self.note_screen_change(sequence, descriptor.revision);
        }
        if let Some(update) = update {
            self.write_response(&update.reply_bytes)?;
            self.publish_driver_events(update.events);
        }
        Ok(())
    }

    fn attach_raw(
        &mut self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalRawAttachment, TerminalError> {
        let descriptor = self.record.descriptor();
        let sequence_boundary = self.sequence;
        if self.exited {
            return Ok(TerminalRawAttachment {
                attachment_id,
                live: false,
                descriptor,
                sequence_boundary,
            });
        }
        let subscriber = spawn_subscriber(
            self.record.id(),
            attachment_id,
            sink,
            self.subscriber_status_sender.clone(),
            on_detached,
            sequence_boundary,
        )?;
        self.subscribers.insert(attachment_id, subscriber);
        if claims_resize {
            self.resize_authority = Some(attachment_id);
        }
        Ok(TerminalRawAttachment {
            attachment_id,
            live: true,
            descriptor,
            sequence_boundary,
        })
    }

    fn attach_driver(
        &mut self,
        attachment_id: TerminalAttachmentId,
        sink: Arc<dyn TerminalDriverEventSink>,
        claims_resize: bool,
        on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    ) -> Result<TerminalDriverAttachment, TerminalError> {
        let descriptor = self.record.descriptor();
        let sequence_boundary = self.sequence;
        let snapshot = self
            .driver
            .as_mut()
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::InvalidRequest,
                    "The selected terminal driver has no native presentation stream",
                )
            })?
            .snapshot(true)
            .map_err(driver_error)?;
        if self.exited {
            return Ok(TerminalDriverAttachment {
                attachment_id,
                live: false,
                descriptor,
                sequence_boundary,
                snapshot,
            });
        }
        let subscriber = spawn_driver_subscriber(
            self.record.id(),
            attachment_id,
            sink,
            self.subscriber_status_sender.clone(),
            on_detached,
            sequence_boundary,
        )?;
        self.driver_subscribers.insert(attachment_id, subscriber);
        if claims_resize {
            self.resize_authority = Some(attachment_id);
        }
        Ok(TerminalDriverAttachment {
            attachment_id,
            live: true,
            descriptor,
            sequence_boundary,
            snapshot,
        })
    }

    fn credit_driver_presentation(
        &mut self,
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
    ) -> Result<(), TerminalError> {
        let subscriber = self
            .driver_subscribers
            .get_mut(&attachment_id)
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::NotFound,
                    "Terminal driver attachment is not live",
                )
            })?;
        if subscriber.screen_in_flight != Some(committed_sequence) {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Presentation credit did not commit the attachment's in-flight screen",
            ));
        }
        subscriber.screen_in_flight = None;
        subscriber.screen_credit = true;
        self.publish_available_driver_presentations();
        Ok(())
    }

    /// Record a new replaceable state and satisfy every waiting reader once.
    fn note_screen_change(&mut self, sequence: u64, revision: TerminalRevision) {
        self.publication_stats.screen_changes += 1;
        self.screen_sequence = sequence;
        self.screen_revision = revision;
        self.publish_available_driver_presentations();
    }

    fn publish_driver_events(&mut self, events: Vec<serde_json::Value>) {
        if events.is_empty() {
            return;
        }
        for event in &events {
            if event.get("event").and_then(serde_json::Value::as_str) == Some("effects") {
                self.publication_stats.effect_events += 1;
                self.publication_stats.effect_encoded_bytes += serde_json::to_vec(event)
                    .map(|encoded| encoded.len() as u64)
                    .unwrap_or(0);
            }
        }
        let mut disconnected = Vec::new();
        for (attachment_id, subscriber) in &self.driver_subscribers {
            for event in &events {
                if subscriber.events.send(event.clone()).is_err() {
                    disconnected.push(*attachment_id);
                    break;
                }
            }
        }
        for attachment_id in disconnected {
            self.remove_driver_subscriber(attachment_id);
        }
    }

    fn publish_available_driver_presentations(&mut self) {
        let recipients = self
            .driver_subscribers
            .iter()
            .filter_map(|(id, subscriber)| {
                (subscriber.screen_credit && subscriber.last_screen_sequence < self.screen_sequence)
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        if recipients.is_empty() {
            return;
        }
        let event = match self
            .driver
            .as_mut()
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::InvalidRequest,
                    "The selected terminal driver has no native presentation stream",
                )
            })
            .and_then(|driver| {
                driver
                    .presentation(self.screen_sequence, self.screen_revision.0, false)
                    .map_err(driver_error)
            }) {
            Ok(event) => event,
            Err(error) => {
                log::warn!(
                    target: LOG_TARGET,
                    "terminal {} could not encode selected-driver presentation at sequence {}: {error}",
                    self.record.id(),
                    self.screen_sequence,
                );
                return;
            }
        };
        self.publication_stats.screen_projections += 1;
        self.publication_stats.screen_encodes += 1;
        self.publication_stats.screen_encoded_bytes += serde_json::to_vec(&event)
            .map(|encoded| encoded.len() as u64)
            .unwrap_or(0);
        let mut disconnected = Vec::new();
        for attachment_id in recipients {
            let Some(subscriber) = self.driver_subscribers.get_mut(&attachment_id) else {
                continue;
            };
            if subscriber.events.send(event.clone()).is_ok() {
                self.publication_stats.screen_recipient_deliveries += 1;
                subscriber.screen_credit = false;
                subscriber.screen_in_flight = Some(self.screen_sequence);
                subscriber.last_screen_sequence = self.screen_sequence;
            } else {
                disconnected.push(attachment_id);
            }
        }
        for attachment_id in disconnected {
            self.remove_driver_subscriber(attachment_id);
        }
    }

    fn handle_output(&mut self, output: ReaderEvent) {
        match output {
            ReaderEvent::Data(data) => {
                self.publication_stats.pty_reads += 1;
                let sequence = self.next_sequence();
                let update = self.driver.as_mut().map_or_else(
                    TerminalDriverUpdate::empty,
                    |driver| {
                        driver
                            .on_output(TerminalByteOccurrence {
                                sequence,
                                bytes: data.clone(),
                            })
                            .unwrap_or_else(|error| {
                                log::warn!(
                                    target: LOG_TARGET,
                                    "terminal {} driver rejected output at sequence {sequence}: {error}",
                                    self.record.id(),
                                );
                                TerminalDriverUpdate::empty()
                            })
                    },
                );
                let revision = self.record.note_output();
                // Output is published whether or not the child could be
                // answered: the bytes arrived either way.
                let _ = self.apply(plan_child_output(
                    &data,
                    update.reply_bytes,
                    sequence,
                    revision,
                ));
                self.publish_driver_events(update.events.clone());
                if update.presentation_changed {
                    self.note_screen_change(sequence, revision);
                }
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

    fn selected_driver(&mut self) -> Result<&mut Box<dyn TerminalDriverSession>, TerminalError> {
        self.driver.as_mut().ok_or_else(|| {
            TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "The selected terminal driver has no native request handler",
            )
        })
    }

    /// Execute a driver request without decoding the driver's schema. A driver
    /// reports only ordered child bytes and whether its presentation changed.
    fn request_driver(
        &mut self,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, TerminalError> {
        let response = self
            .selected_driver()?
            .request(request)
            .map_err(driver_error)?;
        if response.presentation_changed {
            let sequence = self.next_sequence();
            let revision = self.record.note_replay_change().revision;
            self.note_screen_change(sequence, revision);
        }
        if !response.reply_bytes.is_empty() {
            self.require_writable().and_then(|writer| {
                writer.write_all(&response.reply_bytes).map_err(|error| {
                    io_error(format!(
                        "Failed to write terminal driver bytes to child: {error}"
                    ))
                })
            })?;
        }
        Ok(response.payload)
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
        let event = match PublishedTerminalEvent::encode(event) {
            Ok(event) => event,
            Err(error) => {
                log::error!(
                    target: LOG_TARGET,
                    "terminal {} could not encode event at sequence {sequence}: {error}",
                    self.record.id()
                );
                return;
            }
        };
        let mut lost = Vec::new();
        for (attachment_id, subscriber) in &mut self.subscribers {
            if !audience.includes() {
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
                    let control = PublishedTerminalEvent::encode(TerminalEvent::ResyncRequired {
                        sequence,
                        reason: "attachment mailbox exceeded the established 100000-byte flow-control budget"
                            .to_string(),
                    })
                    .expect("terminal control events are JSON values");
                    let _ = subscriber.control.try_send(control);
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
        self.observe_queue_peaks();
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
            let event = PublishedTerminalEvent::encode(TerminalEvent::Detached {
                sequence,
                reason: reason.to_string(),
            })
            .expect("terminal control events are JSON values");
            let _ = subscriber.control.try_send(event);
            (subscriber.on_detached)(attachment_id);
        } else if self.driver_subscribers.contains_key(&attachment_id) {
            log::debug!(
                target: LOG_TARGET,
                "terminal {} detached selected-driver attachment {attachment_id:?}: {reason}",
                self.record.id(),
            );
            self.remove_driver_subscriber(attachment_id);
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

    fn remove_driver_subscriber(&mut self, attachment_id: TerminalAttachmentId) {
        if let Some(subscriber) = self.driver_subscribers.remove(&attachment_id) {
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
        for (attachment_id, subscriber) in self.driver_subscribers.drain() {
            (subscriber.on_detached)(attachment_id);
        }
    }

    fn handle_subscriber_status(&mut self, status: SubscriberStatus) {
        match status {
            SubscriberStatus::Disconnected(attachment_id) => {
                self.remove_subscriber(attachment_id);
                self.remove_driver_subscriber(attachment_id);
            }
        }
    }

    fn publication_stats(&self) -> TerminalPublicationStats {
        let mut stats = self.publication_stats.clone();
        stats.current_screen_transactions = self
            .driver_subscribers
            .values()
            .filter(|subscriber| subscriber.screen_in_flight.is_some())
            .count() as u64;
        stats.current_screen_bytes_queued = 0;
        stats
    }

    fn observe_queue_peaks(&mut self) {
        let current = self.publication_stats();
        self.publication_stats.peak_screen_bytes_queued = self
            .publication_stats
            .peak_screen_bytes_queued
            .max(current.current_screen_bytes_queued);
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
    apply_terminal_environment(&mut command, &mut request.environment);

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

fn apply_terminal_environment(
    command: &mut CommandBuilder,
    environment: &mut HashMap<String, String>,
) {
    let explicit_no_color = environment.contains_key("NO_COLOR");
    for (key, value) in environment.drain() {
        command.env(key, value);
    }
    if !explicit_no_color {
        command.env_remove("NO_COLOR");
    }
    command.env("TERM", "xterm-256color");
    command.env("TERM_PROGRAM", "iTerm.app");
    command.env("COLORTERM", "truecolor");
}

fn spawn_subscriber(
    terminal_id: TerminalId,
    attachment_id: TerminalAttachmentId,
    sink: Arc<dyn TerminalEventSink>,
    status: Sender<SubscriberStatus>,
    on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    _baseline_sequence: u64,
) -> Result<Subscriber, TerminalError> {
    let (event_sender, event_receiver) = bounded(ATTACHMENT_MAILBOX_EVENTS);
    let (control_sender, control_receiver) = bounded(1);
    thread::Builder::new()
        .name(format!("terminal-attachment-{attachment_id:?}"))
        .spawn(move || {
            'worker: loop {
                match control_receiver.try_recv() {
                    Ok(event) => {
                        let _ = sink.publish_preencoded(terminal_id, event);
                        break;
                    }
                    Err(TryRecvError::Disconnected) => {
                        for event in event_receiver.iter() {
                            if sink.publish_preencoded(terminal_id, event).is_err() {
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
                            let _ = sink.publish_preencoded(terminal_id, event);
                            break 'worker;
                        }
                        Err(_) => continue 'worker,
                    },
                    recv(event_receiver) -> event => match event {
                        Ok(event) => {
                            if sink.publish_preencoded(terminal_id, event).is_err() {
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

fn spawn_driver_subscriber(
    terminal_id: TerminalId,
    attachment_id: TerminalAttachmentId,
    sink: Arc<dyn TerminalDriverEventSink>,
    status: Sender<SubscriberStatus>,
    on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync>,
    baseline_sequence: u64,
) -> Result<DriverSubscriber, TerminalError> {
    let (events, receiver) = unbounded();
    thread::Builder::new()
        .name(format!("terminal-driver-attachment-{attachment_id:?}"))
        .spawn(move || {
            for event in receiver {
                if sink.publish(terminal_id, event).is_err() {
                    break;
                }
            }
            let _ = status.send(SubscriberStatus::Disconnected(attachment_id));
        })
        .map_err(|error| {
            TerminalError::new(
                TerminalErrorCode::RuntimeStopped,
                format!("Failed to start terminal driver attachment worker: {error}"),
            )
        })?;
    Ok(DriverSubscriber {
        events,
        screen_in_flight: Some(baseline_sequence),
        screen_credit: false,
        last_screen_sequence: baseline_sequence,
        on_detached,
    })
}

fn event_sequence(event: &TerminalEvent) -> u64 {
    match event {
        TerminalEvent::Output { sequence, .. }
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

fn driver_error(error: TerminalDriverError) -> TerminalError {
    io_error(format!("Selected terminal driver failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use portable_pty::CommandBuilder;

    use super::apply_terminal_environment;

    #[test]
    fn interactive_terminals_remove_only_inherited_no_color() {
        let mut inherited = CommandBuilder::new("/usr/bin/env");
        inherited.env("NO_COLOR", "1");
        apply_terminal_environment(&mut inherited, &mut HashMap::new());
        assert_eq!(inherited.get_env("NO_COLOR"), None);
        assert_eq!(
            inherited.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            inherited.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );

        let mut requested = CommandBuilder::new("/usr/bin/env");
        apply_terminal_environment(
            &mut requested,
            &mut HashMap::from([("NO_COLOR".to_string(), "1".to_string())]),
        );
        assert_eq!(
            requested.get_env("NO_COLOR"),
            Some(std::ffi::OsStr::new("1"))
        );
    }
}

fn runtime_stopped() -> TerminalError {
    TerminalError::new(
        TerminalErrorCode::RuntimeStopped,
        "Terminal runtime is no longer available",
    )
}
