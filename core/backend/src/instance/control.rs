use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use interprocess::local_socket::{
    prelude::*, ConnectOptions, GenericNamespaced, Listener, ListenerOptions, Stream,
};
use interprocess::TryClone;
use uuid::Uuid;

use super::context::{InstanceBuildIdentity, InstanceContext};
use super::leases::{
    create_private_directory, process_start_time, set_private_file, InstanceLeases,
};
use super::protocol::{
    ActiveWorkBlocker, CapabilityCommand, ControlCaller, ControlCompletion,
    ControlCompletionStatus, ControlError, ControlEvent, ControlEventPayload, ControlHello,
    ControlOperation, ControlRequest, ControlResponse, ControlResponseResult, ControlStream,
    DiscoveryProblem, DiscoveryProblemCategory, DiscoveryReport, InstanceDiagnosticReport,
    InstanceLifecycle, InstanceRecord, MessageCommand, ModuleCommand, ModuleControlStatus,
    OperationCommand, ScheduleCommand, StopOutcome, StoredDescriptor, TerminalAgentReportResult,
    TerminalAttachmentState, TerminalCloseControlResult, TerminalCommand, TerminalControlEvent,
    TerminalDriverResult, TerminalListResult, TerminalWriteResult, CONTROL_FRAME_SCHEMA_VERSION,
    TERMINAL_CONTROL_WRITE_MAX_BYTES,
};
use crate::message_bus::{MessageDiagnosticReport, MessageRuntimeInspection, RUNTIME_UNAVAILABLE};
use crate::module_control::codes::{
    CONTROL_CAPABILITY_UNAVAILABLE, OPERATION_CAPABILITY_UNAVAILABLE,
};
use crate::module_control::{
    agent::{ActiveCapabilityCatalog, ActiveCapabilityInspection, CapabilityInvocation},
    Diagnostic, DiagnosticSeverity, ModuleInspection, ModuleOperation, ModuleOperationKind,
    RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use crate::scheduler::{
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleRefreshReport, ScheduleTriggerReport,
    ScheduleVerification,
};
use crate::state::archive::StateArchiveInspection;
use crate::terminal_host::{
    TerminalAgentActivity, TerminalAgentReportRequest, TerminalAttachmentId, TerminalDescriptor,
    TerminalError, TerminalErrorCode, TerminalEvent, TerminalEventSink, TerminalId,
    TerminalRawAttachment,
};

const DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
const ENDPOINT_PROTOCOL: &str = "local_socket_json_line_v6";

pub trait ControlHandler: Send + Sync + 'static {
    fn active_work(&self) -> Vec<ActiveWorkBlocker>;
    fn state_fingerprint(&self) -> Result<Option<String>, ControlError> {
        Ok(None)
    }
    fn workspace_identities(&self) -> Vec<String> {
        Vec::new()
    }
    fn module_control_status(&self) -> ModuleControlStatus {
        ModuleControlStatus::default()
    }
    fn instance_diagnostics(&self) -> Vec<Diagnostic> {
        Vec::new()
    }
    fn save_state(&self, _destination: &Path) -> Result<StateArchiveInspection, ControlError> {
        Err(ControlError::new(
            "state.snapshot.provider_failed",
            "This instance does not provide state snapshots",
        ))
    }
    /// Module commands are deliberately data-only at this boundary. A live
    /// registry/supervisor can attach later without changing endpoint framing.
    fn module_control(&self, _command: ModuleCommand) -> Result<ControlStream, ControlError> {
        Err(ControlError::new(
            CONTROL_CAPABILITY_UNAVAILABLE,
            "This instance does not provide module-control fixtures",
        ))
    }
    fn message_control(&self, _command: MessageCommand) -> Result<ControlStream, ControlError> {
        Err(ControlError::new(
            RUNTIME_UNAVAILABLE,
            "This instance does not provide runtime message inspection",
        ))
    }
    fn capability_control(
        &self,
        _command: CapabilityCommand,
    ) -> Result<ControlStream, ControlError> {
        Err(ControlError::new(
            "capability.runtime.unavailable",
            "This instance does not provide agent capability control",
        ))
    }
    /// Scheduler commands remain data-only at this endpoint boundary. The
    /// scheduler service owns refresh, manual-delivery, and request-identity
    /// behavior; this adapter only carries an authenticated frame identity to
    /// the current instance.
    fn schedule_control(
        &self,
        _command: ScheduleCommand,
        _request_id: Uuid,
    ) -> Result<ControlStream, ControlError> {
        Err(ControlError::new(
            "scheduler.control.unavailable",
            "This instance does not provide scheduler control",
        ))
    }
    fn operation_control(&self, _command: OperationCommand) -> Result<ControlStream, ControlError> {
        Err(ControlError::new(
            OPERATION_CAPABILITY_UNAVAILABLE,
            "This instance does not provide module-operation fixtures",
        ))
    }
    fn terminal_list(&self) -> Result<Vec<TerminalDescriptor>, ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_get(&self, _id: TerminalId) -> Result<TerminalDescriptor, ControlError> {
        Err(terminal_control_unavailable())
    }
    /// Driver commands stay opaque to the generic instance protocol. The
    /// selected driver validates its own request and response contract.
    fn terminal_driver_request(
        &self,
        _id: TerminalId,
        _request: serde_json::Value,
    ) -> Result<serde_json::Value, ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_write(&self, _id: TerminalId, _data: Vec<u8>) -> Result<(), ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_report(
        &self,
        _report: TerminalAgentReportRequest,
    ) -> Result<TerminalAgentActivity, ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_close(
        &self,
        _id: TerminalId,
    ) -> Result<crate::terminal_host::TerminalCloseResult, ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_attach_raw(
        &self,
        _id: TerminalId,
        _sink: Arc<dyn TerminalEventSink>,
    ) -> Result<TerminalRawAttachment, ControlError> {
        Err(terminal_control_unavailable())
    }
    fn terminal_detach(&self, _attachment_id: TerminalAttachmentId) -> Result<(), ControlError> {
        Err(terminal_control_unavailable())
    }
    fn shutdown(&self, force: bool) -> Result<(), ControlError>;
}

fn terminal_control_unavailable() -> ControlError {
    ControlError::new(
        "terminal.control.unavailable",
        "This instance does not provide terminal control",
    )
}

pub struct ControlServer {
    signal: Arc<ServerSignal>,
    endpoint: String,
    descriptor_path: PathBuf,
    thread: Option<JoinHandle<()>>,
    _leases: Arc<InstanceLeases>,
}

impl ControlServer {
    pub fn start(
        context: InstanceContext,
        leases: Arc<InstanceLeases>,
        handler: Arc<dyn ControlHandler>,
    ) -> Result<Self, ControlError> {
        let descriptor_directory = context.runtime_root.join("instances");
        create_private_directory(&descriptor_directory).map_err(|error| {
            ControlError::new(
                "control.instance.endpoint_setup_failed",
                format!("Could not create private runtime directory: {error}"),
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;

        let endpoint = endpoint_name(context.instance_id);
        let listener = bind_listener(&endpoint).map_err(|error| {
            ControlError::new(
                "control.instance.endpoint_setup_failed",
                format!("Could not bind local control endpoint {endpoint}: {error}"),
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;

        let process_started_at = process_start_time(std::process::id()).ok_or_else(|| {
            ControlError::new(
                "control.instance.process_identity_failed",
                "Could not resolve the UI process start identity",
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;
        // The fingerprint is discovery metadata, not an application startup
        // prerequisite. Keep explicit state export fail-closed, but publish a
        // ready descriptor without a fingerprint when classification or a
        // provider is temporarily unavailable.
        let state_fingerprint = match handler.state_fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                if log::log_enabled!(log::Level::Warn) {
                    log::warn!(
                        target: "shipctl::instance",
                        "State fingerprint unavailable during startup: {}: {}",
                        error.code,
                        error.message
                    );
                } else {
                    eprintln!(
                        "State fingerprint warning: {}: {}",
                        error.code, error.message
                    );
                }
                None
            }
        };
        let record = InstanceRecord {
            instance_id: context.instance_id,
            name: context.name.clone(),
            build: context.build.clone(),
            process_id: std::process::id(),
            process_started_at,
            state_root: context.state_root.clone(),
            runtime_root: context.runtime_root.clone(),
            endpoint_protocol: ENDPOINT_PROTOCOL.to_string(),
            lifecycle: InstanceLifecycle::Ready,
            active_work: Vec::new(),
            state_fingerprint,
            workspace_identities: handler.workspace_identities(),
            module_control: handler.module_control_status(),
        };
        let descriptor = StoredDescriptor {
            descriptor_schema_version: DESCRIPTOR_SCHEMA_VERSION,
            instance: record.clone(),
            endpoint: endpoint.clone(),
            auth_token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        };
        let descriptor_path = descriptor_directory.join(format!("{}.json", context.instance_id));
        let signal = Arc::new(ServerSignal::default());
        let stopping = Arc::new(AtomicBool::new(false));
        let server_signal = Arc::clone(&signal);
        let server_stopping = stopping.clone();
        let server_descriptor = descriptor.clone();
        let server_descriptor_path = descriptor_path.clone();
        let thread = std::thread::Builder::new()
            .name(format!("shipctl-control-{}", context.instance_id))
            .spawn(move || {
                run_server(
                    listener,
                    &server_descriptor,
                    &server_descriptor_path,
                    handler,
                    server_signal,
                    server_stopping,
                );
            })
            .map_err(|error| {
                ControlError::new(
                    "control.instance.endpoint_setup_failed",
                    format!("Could not start local control service: {error}"),
                )
                .for_context(context.instance_id, context.state_root.clone())
            })?;

        if let Err(error) = write_descriptor_atomically(&descriptor_path, &descriptor) {
            signal.stop();
            wake_endpoint(&endpoint);
            let _ = thread.join();
            return Err(ControlError::new(
                "control.instance.descriptor_publish_failed",
                format!("Could not publish ready instance descriptor: {error}"),
            )
            .for_context(context.instance_id, context.state_root));
        }

        Ok(Self {
            signal,
            endpoint,
            descriptor_path,
            thread: Some(thread),
            _leases: leases,
        })
    }

    pub fn descriptor_path(&self) -> &Path {
        &self.descriptor_path
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.signal.stop();
        wake_endpoint(&self.endpoint);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        remove_if_present(&self.descriptor_path);
        remove_endpoint_artifact(&self.endpoint);
    }
}

#[derive(Default)]
struct ServerSignal {
    stopped: AtomicBool,
    changed: Mutex<()>,
    wake: Condvar,
}

impl ServerSignal {
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.notify();
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn notify(&self) {
        self.wake.notify_all();
    }

    fn wait_for_stream(&self, done: &AtomicBool) {
        let mut guard = self
            .changed
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !self.is_stopped() && !done.load(Ordering::SeqCst) {
            guard = self
                .wake
                .wait(guard)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

fn run_server(
    listener: Listener,
    descriptor: &StoredDescriptor,
    descriptor_path: &Path,
    handler: Arc<dyn ControlHandler>,
    signal: Arc<ServerSignal>,
    stopping: Arc<AtomicBool>,
) {
    let committed_shutdown = Arc::new(Mutex::new(None));
    let mut workers = Vec::new();
    while !signal.is_stopped() {
        let Ok(stream) = listener.accept() else {
            if signal.is_stopped() {
                break;
            }
            continue;
        };
        if signal.is_stopped() {
            drop(stream);
            break;
        }
        let worker_descriptor = descriptor.clone();
        let worker_descriptor_path = descriptor_path.to_path_buf();
        let worker_handler = Arc::clone(&handler);
        let worker_signal = Arc::clone(&signal);
        let worker_stopping = Arc::clone(&stopping);
        let worker_committed = Arc::clone(&committed_shutdown);
        let wake_endpoint_name = descriptor.endpoint.clone();
        let worker = std::thread::Builder::new()
            .name(format!(
                "shipctl-control-request-{}",
                descriptor.instance.instance_id
            ))
            .spawn(move || {
                if let Ok(Some(force)) = handle_connection(
                    stream,
                    &worker_descriptor,
                    &worker_descriptor_path,
                    worker_handler.as_ref(),
                    worker_stopping.as_ref(),
                    Arc::clone(&worker_signal),
                ) {
                    *worker_committed
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = Some(force);
                    worker_signal.stop();
                    wake_endpoint(&wake_endpoint_name);
                }
            });
        if let Ok(worker) = worker {
            workers.push(worker);
        }
    }

    drop(listener);
    signal.stop();
    for worker in workers {
        let _ = worker.join();
    }
    remove_endpoint_artifact(&descriptor.endpoint);
    let committed_shutdown = *committed_shutdown
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(force) = committed_shutdown {
        if let Err(error) = handler.shutdown(force) {
            eprintln!("Accepted instance shutdown could not complete: {error}");
        }
    }
}

fn handle_connection(
    stream: Stream,
    descriptor: &StoredDescriptor,
    descriptor_path: &Path,
    handler: &dyn ControlHandler,
    stopping: &AtomicBool,
    signal: Arc<ServerSignal>,
) -> std::io::Result<Option<bool>> {
    if !peer_is_current_user(&stream)? {
        return write_frames(
            stream,
            &ControlResponse::failure(
                Uuid::nil(),
                ControlError::new(
                    "control.instance.unauthorized",
                    "The local control peer is not the current user",
                ),
            ),
            &[],
        )
        .map(|()| None);
    }

    let mut reader = BufReader::new(stream);
    let mut frame = String::new();
    if reader.read_line(&mut frame)? == 0 {
        return Ok(None);
    }
    let request = match serde_json::from_str::<ControlRequest>(&frame) {
        Ok(request) => request,
        Err(error) => {
            return write_frames(
                reader.into_inner(),
                &ControlResponse::failure(
                    Uuid::nil(),
                    ControlError::new(
                        "control.instance.invalid_frame",
                        format!("The control request is not valid JSON: {error}"),
                    ),
                ),
                &[],
            )
            .map(|()| None);
        }
    };
    let requested_shutdown = match &request.operation {
        ControlOperation::Shutdown { force } => Some(*force),
        _ => None,
    };
    if let ControlOperation::Terminals {
        command: TerminalCommand::Attach { terminal_id },
    } = request.operation.clone()
    {
        if let Err(error) = validate_request(&request, descriptor) {
            return write_frames(
                reader.into_inner(),
                &ControlResponse::failure(request.request_id, error),
                &[],
            )
            .map(|()| None);
        }
        return handle_terminal_attachment(
            reader.into_inner(),
            request.request_id,
            terminal_id,
            handler,
            signal,
        )
        .map(|()| None);
    }
    let (mut response, events) = dispatch_request(request, descriptor, handler, stopping);
    let mut commit_shutdown = requested_shutdown.filter(|_| {
        matches!(
            response.result,
            Some(ControlResponseResult::Stop(StopOutcome {
                accepted: true,
                ..
            }))
        )
    });
    if commit_shutdown.is_some() {
        if let Err(error) = withdraw_descriptor(descriptor_path) {
            stopping.store(false, Ordering::SeqCst);
            response = ControlResponse::failure(
                response.request_id,
                ControlError::new(
                    "control.instance.descriptor_withdraw_failed",
                    format!("Could not withdraw the stopping instance descriptor: {error}"),
                )
                .for_context(
                    descriptor.instance.instance_id,
                    descriptor.instance.state_root.clone(),
                ),
            );
            commit_shutdown = None;
        }
    }
    let write_result = write_frames(reader.into_inner(), &response, &events);
    if let Some(force) = commit_shutdown {
        // The descriptor is already withdrawn, so commit shutdown even if the caller
        // disconnects before receiving its acknowledgement.
        let _ = write_result;
        return Ok(Some(force));
    }
    write_result.map(|()| None)
}

fn dispatch_request(
    request: ControlRequest,
    descriptor: &StoredDescriptor,
    handler: &dyn ControlHandler,
    stopping: &AtomicBool,
) -> (ControlResponse, Vec<ControlEventPayload>) {
    if let Err(error) = validate_request(&request, descriptor) {
        return (
            ControlResponse::failure(request.request_id, error),
            Vec::new(),
        );
    }

    match request.operation {
        ControlOperation::Hello => (
            ControlResponse::success(
                request.request_id,
                ControlResponseResult::Hello(ControlHello {
                    negotiated_control_protocol_version: descriptor
                        .instance
                        .build
                        .control_protocol_version,
                    frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
                    instance: current_record(descriptor, handler, stopping),
                }),
            ),
            Vec::new(),
        ),
        ControlOperation::Inspect => {
            let mut record = current_record(descriptor, handler, stopping);
            match handler.state_fingerprint() {
                Ok(fingerprint) => {
                    record.state_fingerprint = fingerprint;
                    (
                        ControlResponse::success(
                            request.request_id,
                            ControlResponseResult::Instance(record),
                        ),
                        Vec::new(),
                    )
                }
                Err(error) => (
                    ControlResponse::failure(request.request_id, error),
                    Vec::new(),
                ),
            }
        }
        ControlOperation::Diagnose => {
            let instance = current_record(descriptor, handler, stopping);
            let mut diagnostics = base_instance_diagnostics(&instance);
            diagnostics.extend(handler.instance_diagnostics());
            let healthy = diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error);
            (
                ControlResponse::success(
                    request.request_id,
                    ControlResponseResult::InstanceDiagnostics(InstanceDiagnosticReport {
                        instance,
                        healthy,
                        diagnostics,
                    }),
                ),
                Vec::new(),
            )
        }
        ControlOperation::SaveState { destination } => match handler.save_state(&destination) {
            Ok(archive) => (
                ControlResponse::success(
                    request.request_id,
                    ControlResponseResult::StateArchive(archive),
                ),
                Vec::new(),
            ),
            Err(error) => (
                ControlResponse::failure(request.request_id, error),
                Vec::new(),
            ),
        },
        ControlOperation::Shutdown { force } => {
            let blockers = handler.active_work();
            if !force && !blockers.is_empty() {
                return (ControlResponse::failure(
                    request.request_id,
                    ControlError::new(
                        "control.instance.shutdown_blocked",
                        "The instance has active work; use force to authorize application-owned cleanup",
                    )
                    .for_context(
                        descriptor.instance.instance_id,
                        descriptor.instance.state_root.clone(),
                    )
                    .with_blockers(blockers),
                ), Vec::new());
            }
            stopping.store(true, Ordering::SeqCst);
            (
                ControlResponse::success(
                    request.request_id,
                    ControlResponseResult::Stop(StopOutcome {
                        instance: current_record(descriptor, handler, stopping),
                        accepted: true,
                    }),
                ),
                Vec::new(),
            )
        }
        ControlOperation::Modules { command } => match handler.module_control(command) {
            Ok(stream) => (
                ControlResponse::success(request.request_id, stream.result),
                stream.events,
            ),
            Err(error) => (
                ControlResponse::failure(request.request_id, error),
                Vec::new(),
            ),
        },
        ControlOperation::Messages { command } => match handler.message_control(command) {
            Ok(stream) => (
                ControlResponse::success(request.request_id, stream.result),
                stream.events,
            ),
            Err(error) => (
                ControlResponse::failure(request.request_id, error),
                Vec::new(),
            ),
        },
        ControlOperation::Capabilities { command } => match handler.capability_control(command) {
            Ok(stream) => (
                ControlResponse::success(request.request_id, stream.result),
                stream.events,
            ),
            Err(error) => (
                ControlResponse::failure(request.request_id, error),
                Vec::new(),
            ),
        },
        ControlOperation::Terminals { command } => {
            dispatch_terminal_request(request.request_id, command, handler)
        }
        ControlOperation::Schedules { command } => {
            match handler.schedule_control(command, request.request_id) {
                Ok(stream) => (
                    ControlResponse::success(request.request_id, stream.result),
                    stream.events,
                ),
                Err(error) => (
                    ControlResponse::failure(request.request_id, error),
                    Vec::new(),
                ),
            }
        }
        ControlOperation::Operations { command } => match handler.operation_control(command) {
            Ok(stream) => (
                ControlResponse::success(request.request_id, stream.result),
                stream.events,
            ),
            Err(error) => (
                ControlResponse::failure(request.request_id, error),
                Vec::new(),
            ),
        },
    }
}

fn validate_request(
    request: &ControlRequest,
    descriptor: &StoredDescriptor,
) -> Result<(), ControlError> {
    if request.frame_type != "request" {
        return Err(ControlError::new(
            "control.instance.invalid_frame",
            "The local control frame must declare frameType request",
        ));
    }
    if request.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION {
        return Err(ControlError::new(
            "control.instance.protocol_incompatible",
            "The control frame schema is incompatible",
        )
        .with_expected_observed(
            CONTROL_FRAME_SCHEMA_VERSION.to_string(),
            request.frame_schema_version.to_string(),
        ));
    }
    if request.control_protocol_version != descriptor.instance.build.control_protocol_version {
        return Err(ControlError::new(
            "control.instance.protocol_incompatible",
            "The control protocol version is incompatible",
        )
        .with_expected_observed(
            descriptor
                .instance
                .build
                .control_protocol_version
                .to_string(),
            request.control_protocol_version.to_string(),
        ));
    }
    if request.auth_token != descriptor.auth_token {
        return Err(ControlError::new(
            "control.instance.unauthorized",
            "The local control authentication token is invalid",
        ));
    }
    Ok(())
}

fn dispatch_terminal_request(
    request_id: Uuid,
    command: TerminalCommand,
    handler: &dyn ControlHandler,
) -> (ControlResponse, Vec<ControlEventPayload>) {
    let result = match command {
        TerminalCommand::List {} => handler.terminal_list().map(|terminals| {
            ControlResponseResult::TerminalList(TerminalListResult {
                count: terminals.len(),
                terminals,
            })
        }),
        TerminalCommand::Get { terminal_id } => handler
            .terminal_get(terminal_id)
            .map(ControlResponseResult::TerminalDescriptor),
        TerminalCommand::DriverRequest {
            terminal_id,
            request,
        } => handler
            .terminal_driver_request(terminal_id, request)
            .map(|response| {
                ControlResponseResult::TerminalDriver(TerminalDriverResult {
                    terminal_id,
                    response,
                })
            }),
        TerminalCommand::Write {
            terminal_id,
            data_base64,
        } => decode_terminal_input(&data_base64).and_then(|data| {
            let accepted_bytes = data.len();
            handler.terminal_write(terminal_id, data).map(|()| {
                ControlResponseResult::TerminalWrite(TerminalWriteResult {
                    terminal_id,
                    accepted_bytes,
                })
            })
        }),
        TerminalCommand::Report {
            terminal_id,
            kind,
            source,
            message,
        } => handler
            .terminal_report(TerminalAgentReportRequest {
                terminal_id,
                kind,
                source,
                message,
            })
            .map(|activity| {
                ControlResponseResult::TerminalAgentReport(TerminalAgentReportResult {
                    terminal_id,
                    activity,
                })
            }),
        TerminalCommand::Close { terminal_id } => {
            handler.terminal_close(terminal_id).map(|closed| {
                ControlResponseResult::TerminalClose(TerminalCloseControlResult {
                    terminal_id,
                    existed: closed.existed,
                    exit: closed.exit,
                })
            })
        }
        TerminalCommand::Attach { .. } => Err(ControlError::new(
            "terminal.attach.invalid_transport",
            "Terminal attach requires the streaming control path",
        )),
    };
    match result {
        Ok(result) => (ControlResponse::success(request_id, result), Vec::new()),
        Err(error) => (ControlResponse::failure(request_id, error), Vec::new()),
    }
}

fn decode_terminal_input(data_base64: &str) -> Result<Vec<u8>, ControlError> {
    let maximum_encoded_bytes = TERMINAL_CONTROL_WRITE_MAX_BYTES.div_ceil(3) * 4;
    if data_base64.len() > maximum_encoded_bytes {
        return Err(ControlError::new(
            "terminal.input.too_large",
            format!(
                "Terminal input exceeds the established {TERMINAL_CONTROL_WRITE_MAX_BYTES}-byte flow-control budget"
            ),
        )
        .with_expected_observed(
            format!("at most {TERMINAL_CONTROL_WRITE_MAX_BYTES} decoded bytes"),
            format!("{} encoded bytes", data_base64.len()),
        ));
    }
    let data = BASE64_STANDARD.decode(data_base64).map_err(|error| {
        ControlError::new(
            "terminal.input.invalid_base64",
            format!("Terminal input is not valid base64: {error}"),
        )
    })?;
    if data.len() > TERMINAL_CONTROL_WRITE_MAX_BYTES {
        return Err(ControlError::new(
            "terminal.input.too_large",
            format!(
                "Terminal input exceeds the established {TERMINAL_CONTROL_WRITE_MAX_BYTES}-byte flow-control budget"
            ),
        )
        .with_expected_observed(
            format!("at most {TERMINAL_CONTROL_WRITE_MAX_BYTES} decoded bytes"),
            format!("{} decoded bytes", data.len()),
        ));
    }
    Ok(data)
}

pub fn terminal_control_error(error: TerminalError) -> ControlError {
    let code = match error.code {
        TerminalErrorCode::NotFound => "terminal.not_found",
        TerminalErrorCode::Exited => "terminal.exited",
        TerminalErrorCode::Closing => "terminal.closing",
        TerminalErrorCode::ShuttingDown => "terminal.host_shutting_down",
        TerminalErrorCode::InvalidRequest => "terminal.request.invalid",
        TerminalErrorCode::StartupFailed => "terminal.startup_failed",
        TerminalErrorCode::RuntimeStopped => "terminal.runtime_stopped",
        TerminalErrorCode::Io => "terminal.io",
    };
    ControlError::new(code, error.message)
}

fn current_record(
    descriptor: &StoredDescriptor,
    handler: &dyn ControlHandler,
    stopping: &AtomicBool,
) -> InstanceRecord {
    let mut record = descriptor.instance.clone();
    record.active_work = handler.active_work();
    record.workspace_identities = handler.workspace_identities();
    record.module_control = handler.module_control_status();
    record.lifecycle = if stopping.load(Ordering::SeqCst) {
        InstanceLifecycle::Stopping
    } else {
        InstanceLifecycle::Ready
    };
    record
}

fn base_instance_diagnostics(instance: &InstanceRecord) -> Vec<Diagnostic> {
    [
        (
            "control.instance.descriptor.valid",
            "descriptor",
            "The live descriptor identity matches the responding process",
        ),
        (
            "control.instance.endpoint.accessible",
            "endpoint_access",
            "The owner-only local endpoint accepted this caller",
        ),
        (
            "control.instance.handshake.valid",
            "handshake",
            "The hello exchange completed with matching instance identity",
        ),
        (
            "control.instance.protocol.compatible",
            "protocol",
            "The caller and instance negotiated the same control protocol",
        ),
        (
            "control.instance.build.compatible",
            "build_identity",
            "The caller accepted the running instance build identity",
        ),
    ]
    .into_iter()
    .map(|(code, check, summary)| Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.to_string(),
        severity: DiagnosticSeverity::Info,
        check: check.to_string(),
        summary: summary.to_string(),
        evidence: RedactedEvidence {
            fields: BTreeMap::from([
                ("instanceId".to_string(), instance.instance_id.to_string()),
                (
                    "controlProtocolVersion".to_string(),
                    instance.build.control_protocol_version.to_string(),
                ),
                (
                    "endpointProtocol".to_string(),
                    instance.endpoint_protocol.clone(),
                ),
            ]),
        },
        remedy: None,
    })
    .collect()
}

fn handle_terminal_attachment(
    stream: Stream,
    request_id: Uuid,
    terminal_id: TerminalId,
    handler: &dyn ControlHandler,
    signal: Arc<ServerSignal>,
) -> std::io::Result<()> {
    // The initial response and every live event share this lock. Holding it
    // across TerminalService::attach means an event racing with attach cannot
    // overtake the canonical replay state.
    let writer = Arc::new(Mutex::new(stream));
    let attachment_id = Arc::new(Mutex::new(None::<TerminalAttachmentId>));
    let control_sequence = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));

    // Attach is server-to-client after the request frame. A dedicated read
    // observer turns peer EOF (or any unexpected inbound byte) into detach
    // without polling and without coupling terminal output to socket reads.
    // It owns no handler/service state, so server shutdown never waits on a
    // client that keeps an idle connection open.
    let mut peer_observer = writer
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .try_clone()?;
    let peer_done = Arc::clone(&done);
    let peer_signal = Arc::clone(&signal);
    std::thread::Builder::new()
        .name(format!("terminal-control-peer-{attachment_id:?}"))
        .spawn(move || {
            let mut inbound = [0_u8; 1];
            let _ = peer_observer.read(&mut inbound);
            peer_done.store(true, Ordering::SeqCst);
            peer_signal.notify();
        })?;

    let sink_writer = Arc::clone(&writer);
    let sink_attachment_id = Arc::clone(&attachment_id);
    let sink_sequence = Arc::clone(&control_sequence);
    let sink_done = Arc::clone(&done);
    let sink_closed = Arc::clone(&closed);
    let sink_signal = Arc::clone(&signal);
    let sink: Arc<dyn TerminalEventSink> = Arc::new(
        move |event_terminal_id: TerminalId, event: TerminalEvent| -> Result<(), String> {
            if sink_closed.load(Ordering::SeqCst) {
                return Err("terminal control stream is closed".to_string());
            }
            let mut writer = sink_writer
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if sink_closed.load(Ordering::SeqCst) {
                return Err("terminal control stream is closed".to_string());
            }
            let attachment_id = sink_attachment_id
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .ok_or_else(|| "terminal attachment identity is not installed".to_string())?;
            let (event, completes_stream) =
                terminal_event_frame(event_terminal_id, attachment_id, event);
            let sequence = sink_sequence.fetch_add(1, Ordering::SeqCst) + 1;
            let result = write_event_frame(
                &mut writer,
                &ControlEvent {
                    frame_type: "event".to_string(),
                    frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
                    request_id,
                    sequence,
                    event: ControlEventPayload::Terminal(event),
                },
            )
            .map_err(|error| error.to_string());
            if completes_stream || result.is_err() {
                sink_done.store(true, Ordering::SeqCst);
                sink_signal.notify();
            }
            result
        },
    );

    let mut writer_guard = writer.lock().unwrap_or_else(|error| error.into_inner());
    let attachment = match handler.terminal_attach_raw(terminal_id, sink) {
        Ok(attachment) => attachment,
        Err(error) => {
            return write_frames_to(
                &mut writer_guard,
                &ControlResponse::failure(request_id, error),
                &[],
            );
        }
    };
    *attachment_id
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(attachment.attachment_id);
    let initial = terminal_attachment_state(terminal_id, &attachment);
    // Frames are written whole and blocking. A frame carrying meaning is larger
    // than a socket send buffer, so a nonblocking write would stop in the middle
    // of one and leave the reader a broken line it cannot recover from. Waiting
    // here costs nothing that matters: the terminal runtime holds the bounded
    // mailbox, so a client that stops reading fills that mailbox and is resynced
    // or detached, and PTY draining never waits on this thread.
    if let Err(error) = write_response_frame(
        &mut writer_guard,
        &ControlResponse::success(
            request_id,
            ControlResponseResult::TerminalAttachment(initial),
        ),
    ) {
        closed.store(true, Ordering::SeqCst);
        let _ = handler.terminal_detach(attachment.attachment_id);
        return Err(error);
    }
    if !attachment.live {
        write_completion_frame(
            &mut writer_guard,
            &ControlCompletion {
                frame_type: "completion".to_string(),
                frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
                request_id,
                status: ControlCompletionStatus::Succeeded,
                event_count: 0,
            },
        )?;
        return Ok(());
    }
    drop(writer_guard);

    signal.wait_for_stream(&done);
    closed.store(true, Ordering::SeqCst);
    let _ = handler.terminal_detach(attachment.attachment_id);

    // A disconnected peer may make this write fail; attachment cleanup has
    // already happened and never closes the terminal process. A shutdown
    // completion lets a well-behaved client close its read observer.
    let mut writer_guard = writer.lock().unwrap_or_else(|error| error.into_inner());
    write_completion_frame(
        &mut writer_guard,
        &ControlCompletion {
            frame_type: "completion".to_string(),
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id,
            status: ControlCompletionStatus::Succeeded,
            event_count: control_sequence.load(Ordering::SeqCst),
        },
    )
}

fn terminal_attachment_state(
    terminal_id: TerminalId,
    attachment: &TerminalRawAttachment,
) -> TerminalAttachmentState {
    TerminalAttachmentState {
        terminal_id,
        attachment_id: attachment.attachment_id,
        live: attachment.live,
        descriptor: attachment.descriptor.clone(),
        sequence_boundary: attachment.sequence_boundary,
    }
}

fn terminal_event_frame(
    terminal_id: TerminalId,
    attachment_id: TerminalAttachmentId,
    event: TerminalEvent,
) -> (TerminalControlEvent, bool) {
    match event {
        TerminalEvent::Output {
            sequence,
            revision,
            data,
        } => (
            TerminalControlEvent::Output {
                terminal_id,
                attachment_id,
                sequence,
                revision,
                data_base64: BASE64_STANDARD.encode(data.as_ref()),
            },
            false,
        ),
        TerminalEvent::MetadataChanged {
            sequence,
            descriptor,
        } => (
            TerminalControlEvent::MetadataChanged {
                terminal_id,
                attachment_id,
                sequence,
                descriptor,
            },
            false,
        ),
        TerminalEvent::AgentActivityChanged {
            sequence,
            descriptor,
        } => (
            TerminalControlEvent::AgentActivityChanged {
                terminal_id,
                attachment_id,
                sequence,
                descriptor,
            },
            false,
        ),
        TerminalEvent::Exited {
            sequence,
            descriptor,
        } => (
            TerminalControlEvent::Exited {
                terminal_id,
                attachment_id,
                sequence,
                descriptor,
            },
            true,
        ),
        TerminalEvent::ResyncRequired { sequence, reason } => (
            TerminalControlEvent::ResyncRequired {
                terminal_id,
                attachment_id,
                sequence,
                reason,
            },
            true,
        ),
        TerminalEvent::Detached { sequence, reason } => (
            TerminalControlEvent::Detached {
                terminal_id,
                attachment_id,
                sequence,
                reason,
            },
            true,
        ),
    }
}

fn write_frames(
    mut stream: Stream,
    response: &ControlResponse,
    events: &[ControlEventPayload],
) -> std::io::Result<()> {
    write_frames_to(&mut stream, response, events)
}

fn write_frames_to(
    stream: &mut Stream,
    response: &ControlResponse,
    events: &[ControlEventPayload],
) -> std::io::Result<()> {
    write_response_frame(stream, response)?;
    for (index, event) in events.iter().enumerate() {
        write_event_frame(
            stream,
            &ControlEvent {
                frame_type: "event".to_string(),
                frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
                request_id: response.request_id,
                sequence: index as u64 + 1,
                event: event.clone(),
            },
        )?;
    }
    write_completion_frame(
        stream,
        &ControlCompletion {
            frame_type: "completion".to_string(),
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id: response.request_id,
            status: if response.error.is_some() {
                ControlCompletionStatus::Failed
            } else {
                ControlCompletionStatus::Succeeded
            },
            event_count: events.len() as u64,
        },
    )
}

fn write_response_frame(stream: &mut Stream, response: &ControlResponse) -> std::io::Result<()> {
    serde_json::to_writer(&mut *stream, response).map_err(std::io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn write_event_frame(stream: &mut Stream, event: &ControlEvent) -> std::io::Result<()> {
    serde_json::to_writer(&mut *stream, event).map_err(std::io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn write_completion_frame(
    stream: &mut Stream,
    completion: &ControlCompletion,
) -> std::io::Result<()> {
    serde_json::to_writer(&mut *stream, completion).map_err(std::io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub struct InstanceDirectory {
    runtime_root: PathBuf,
    expected_build: InstanceBuildIdentity,
}

/// Streaming client for one control-socket terminal attachment. Dropping this
/// value closes only the socket subscription; it never closes the terminal.
pub struct TerminalAttachmentClient {
    state: TerminalAttachmentState,
    request_id: Uuid,
    reader: BufReader<Stream>,
    control_sequence: u64,
    terminal_sequence: u64,
    completed: bool,
}

impl TerminalAttachmentClient {
    pub fn state(&self) -> &TerminalAttachmentState {
        &self.state
    }

    pub fn next_event(&mut self) -> Result<Option<TerminalControlEvent>, ControlError> {
        if self.completed {
            return Ok(None);
        }
        let mut frame = String::new();
        let read = self.reader.read_line(&mut frame).map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("Could not read the terminal attachment stream: {error}"),
            )
        })?;
        if read == 0 {
            return Err(ControlError::new(
                "terminal.attach.disconnected",
                "The terminal attachment ended without a completion frame",
            ));
        }
        let value: serde_json::Value = serde_json::from_str(&frame).map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("The terminal attachment frame is invalid JSON: {error}"),
            )
        })?;
        match value.get("frameType").and_then(serde_json::Value::as_str) {
            Some("event") => {
                let event: ControlEvent = serde_json::from_value(value).map_err(|error| {
                    ControlError::new(
                        "control.instance.handshake_failed",
                        format!("The terminal attachment event is invalid: {error}"),
                    )
                })?;
                let expected_control_sequence = self.control_sequence + 1;
                if event.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
                    || event.request_id != self.request_id
                    || event.sequence != expected_control_sequence
                {
                    return Err(ControlError::new(
                        "terminal.attach.sequence_invalid",
                        "The terminal attachment control sequence is invalid",
                    ));
                }
                let ControlEventPayload::Terminal(event) = event.event else {
                    return Err(ControlError::new(
                        "terminal.attach.event_invalid",
                        "The terminal attachment received a non-terminal event",
                    ));
                };
                let (terminal_id, attachment_id, sequence, permits_gap) =
                    terminal_event_identity(&event);
                if terminal_id != self.state.terminal_id
                    || attachment_id != self.state.attachment_id
                    || (!permits_gap && sequence != self.terminal_sequence + 1)
                    || sequence <= self.terminal_sequence
                {
                    return Err(ControlError::new(
                        "terminal.attach.sequence_invalid",
                        "The terminal event identity or sequence is invalid",
                    ));
                }
                self.control_sequence = expected_control_sequence;
                self.terminal_sequence = sequence;
                Ok(Some(event))
            }
            Some("completion") => {
                let completion: ControlCompletion =
                    serde_json::from_value(value).map_err(|error| {
                        ControlError::new(
                            "control.instance.handshake_failed",
                            format!("The terminal completion frame is invalid: {error}"),
                        )
                    })?;
                if completion.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
                    || completion.request_id != self.request_id
                    || completion.status != ControlCompletionStatus::Succeeded
                    || completion.event_count != self.control_sequence
                {
                    return Err(ControlError::new(
                        "terminal.attach.sequence_invalid",
                        "The terminal attachment completion is invalid",
                    ));
                }
                self.completed = true;
                Ok(None)
            }
            _ => Err(ControlError::new(
                "control.instance.handshake_failed",
                "The terminal attachment contains an unknown frame type",
            )),
        }
    }
}

impl InstanceDirectory {
    pub fn new(runtime_root: PathBuf, expected_build: InstanceBuildIdentity) -> Self {
        Self {
            runtime_root,
            expected_build,
        }
    }

    pub fn discover(&self) -> DiscoveryReport {
        let (instances, problems) = self.scan();
        DiscoveryReport {
            instances: instances.into_iter().map(|(_, record)| record).collect(),
            problems,
        }
    }

    pub fn inspect(&self, selector: Option<&str>) -> Result<InstanceRecord, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(&descriptor, ControlOperation::Inspect).and_then(expect_instance_result)
    }

    pub fn diagnose(
        &self,
        selector: Option<&str>,
    ) -> Result<InstanceDiagnosticReport, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(&descriptor, ControlOperation::Diagnose).and_then(expect_instance_diagnostics)
    }

    pub fn stop(&self, selector: Option<&str>, force: bool) -> Result<StopOutcome, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(&descriptor, ControlOperation::Shutdown { force }).and_then(expect_stop_result)
    }

    pub fn save_state(
        &self,
        selector: Option<&str>,
        destination: PathBuf,
    ) -> Result<StateArchiveInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(&descriptor, ControlOperation::SaveState { destination })
            .and_then(expect_state_archive_result)
    }

    pub fn list_terminals(&self, selector: &str) -> Result<TerminalListResult, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::List {},
            },
        )
        .and_then(expect_terminal_list_result)
    }

    pub fn get_terminal(
        &self,
        selector: &str,
        terminal_id: TerminalId,
    ) -> Result<TerminalDescriptor, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::Get { terminal_id },
            },
        )
        .and_then(expect_terminal_descriptor_result)
    }

    pub fn request_terminal_driver(
        &self,
        selector: &str,
        terminal_id: TerminalId,
        request_value: serde_json::Value,
    ) -> Result<TerminalDriverResult, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::DriverRequest {
                    terminal_id,
                    request: request_value,
                },
            },
        )
        .and_then(expect_terminal_driver_result)
    }

    pub fn write_terminal(
        &self,
        selector: &str,
        terminal_id: TerminalId,
        data: &[u8],
    ) -> Result<TerminalWriteResult, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::Write {
                    terminal_id,
                    data_base64: BASE64_STANDARD.encode(data),
                },
            },
        )
        .and_then(expect_terminal_write_result)
    }

    pub fn report_terminal_agent(
        &self,
        selector: &str,
        report: TerminalAgentReportRequest,
    ) -> Result<TerminalAgentReportResult, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::Report {
                    terminal_id: report.terminal_id,
                    kind: report.kind,
                    source: report.source,
                    message: report.message,
                },
            },
        )
        .and_then(expect_terminal_agent_report_result)
    }

    pub fn close_terminal(
        &self,
        selector: &str,
        terminal_id: TerminalId,
    ) -> Result<TerminalCloseControlResult, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Terminals {
                command: TerminalCommand::Close { terminal_id },
            },
        )
        .and_then(expect_terminal_close_result)
    }

    pub fn attach_terminal(
        &self,
        selector: &str,
        terminal_id: TerminalId,
    ) -> Result<TerminalAttachmentClient, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request_terminal_attachment(&descriptor, terminal_id)
    }

    pub fn inspect_module(
        &self,
        selector: Option<&str>,
        module_id: String,
    ) -> Result<ModuleInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Modules {
                command: ModuleCommand::Inspect { module_id },
            },
        )
        .and_then(expect_module_inspection_result)
    }

    pub fn diagnose_module(
        &self,
        selector: Option<&str>,
        module_id: String,
    ) -> Result<Vec<Diagnostic>, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Modules {
                command: ModuleCommand::Diagnose { module_id },
            },
        )
        .and_then(expect_module_diagnostics_result)
    }

    pub fn inspect_messages(
        &self,
        selector: Option<&str>,
    ) -> Result<MessageRuntimeInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Messages {
                command: MessageCommand::Inspect {},
            },
        )
        .and_then(expect_message_inspection_result)
    }

    pub fn diagnose_messages(
        &self,
        selector: Option<&str>,
    ) -> Result<MessageDiagnosticReport, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Messages {
                command: MessageCommand::Diagnose {},
            },
        )
        .and_then(expect_message_diagnostics_result)
    }

    pub fn list_capabilities(
        &self,
        selector: &str,
    ) -> Result<ActiveCapabilityCatalog, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Capabilities {
                command: CapabilityCommand::List {},
            },
        )
        .and_then(expect_capability_catalog_result)
    }

    pub fn inspect_capability(
        &self,
        selector: &str,
        capability_id: String,
    ) -> Result<ActiveCapabilityInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Capabilities {
                command: CapabilityCommand::Inspect { capability_id },
            },
        )
        .and_then(expect_capability_inspection_result)
    }

    pub fn call_capability(
        &self,
        selector: &str,
        capability_id: String,
        port_id: String,
        payload: serde_json::Value,
    ) -> Result<CapabilityInvocation, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Capabilities {
                command: CapabilityCommand::Call {
                    capability_id,
                    port_id,
                    payload,
                },
            },
        )
        .and_then(expect_capability_invocation_result)
    }

    /// Lists the accepted schedule snapshot for one explicitly selected live
    /// instance.
    pub fn list_schedules(&self, selector: &str) -> Result<ScheduleInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::List {},
            },
        )
        .and_then(expect_schedule_inspection_result)
    }

    /// Inspects one accepted schedule in one explicitly selected live
    /// instance.
    pub fn inspect_schedule(
        &self,
        selector: &str,
        schedule_id: String,
    ) -> Result<ScheduleInspection, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Inspect { schedule_id },
            },
        )
        .and_then(expect_schedule_inspection_result)
    }

    /// Diagnoses the accepted schedule snapshot for one explicitly selected
    /// live instance.
    pub fn diagnose_schedules(
        &self,
        selector: &str,
    ) -> Result<ScheduleDiagnosticReport, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Diagnose {},
            },
        )
        .and_then(expect_schedule_diagnostics_result)
    }

    /// Verifies the schedule source against one explicitly selected live
    /// instance without changing its accepted snapshot.
    pub fn verify_schedules(&self, selector: &str) -> Result<ScheduleVerification, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Verify {},
            },
        )
        .and_then(expect_schedule_verification_result)
    }

    /// Refreshes schedules with the caller's stable retry identity.
    ///
    /// A retry must use the same `request_id`; the receiving scheduler service
    /// owns replay behavior for the current instance incarnation.
    pub fn refresh_schedules_with_request_id(
        &self,
        selector: &str,
        request_id: Uuid,
    ) -> Result<ScheduleRefreshReport, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request_with_id(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Refresh {},
            },
            request_id,
        )
        .and_then(expect_schedule_refresh_result)
    }

    /// Triggers one accepted schedule with the caller's stable retry identity.
    ///
    /// A retry must use the same `request_id`; the receiving scheduler service
    /// owns replay behavior for the current instance incarnation.
    pub fn trigger_schedule_with_request_id(
        &self,
        selector: &str,
        schedule_id: String,
        request_id: Uuid,
    ) -> Result<ScheduleTriggerReport, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, Some(selector))?;
        request_with_id(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Trigger { schedule_id },
            },
            request_id,
        )
        .and_then(expect_schedule_trigger_result)
    }

    pub fn transition_module(
        &self,
        selector: Option<&str>,
        module_id: String,
        kind: ModuleOperationKind,
        target_registry_revision: u64,
        artifact_content_digest: Option<String>,
    ) -> Result<ModuleOperation, ControlError> {
        self.transition_module_stream(
            selector,
            module_id,
            kind,
            target_registry_revision,
            artifact_content_digest,
        )
        .and_then(expect_module_operation_result)
    }

    pub fn transition_module_stream(
        &self,
        selector: Option<&str>,
        module_id: String,
        kind: ModuleOperationKind,
        target_registry_revision: u64,
        artifact_content_digest: Option<String>,
    ) -> Result<ControlStream, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Modules {
                command: ModuleCommand::Lifecycle {
                    module_id,
                    kind,
                    target_registry_revision,
                    artifact_content_digest,
                },
            },
        )
    }

    pub fn inspect_operation(
        &self,
        selector: Option<&str>,
        operation_id: Uuid,
    ) -> Result<ModuleOperation, ControlError> {
        let (instances, _) = self.scan();
        let descriptor = select_instance(instances, selector)?;
        request(
            &descriptor,
            ControlOperation::Operations {
                command: OperationCommand::Inspect { operation_id },
            },
        )
        .and_then(expect_module_operation_result)
    }

    fn scan(
        &self,
    ) -> (
        Vec<(StoredDescriptor, InstanceRecord)>,
        Vec<DiscoveryProblem>,
    ) {
        let descriptor_directory = self.runtime_root.join("instances");
        let mut live = Vec::new();
        let mut problems = Vec::new();
        let Ok(entries) = fs::read_dir(&descriptor_directory) else {
            return (live, problems);
        };
        let mut paths: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        paths.sort();

        for path in paths {
            let descriptor = match read_descriptor(&path) {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    problems.push(DiscoveryProblem {
                        descriptor_path: path,
                        category: DiscoveryProblemCategory::InvalidDescriptor,
                        error,
                        reclaimed: false,
                    });
                    continue;
                }
            };
            match self.probe(&descriptor) {
                Ok(record) => live.push((descriptor, record)),
                Err(error) => {
                    let category = category_for(&error);
                    let identity_is_dead = process_start_time(descriptor.instance.process_id)
                        != Some(descriptor.instance.process_started_at);
                    let endpoint_is_owned = descriptor.instance.runtime_root == self.runtime_root
                        && descriptor.endpoint == endpoint_name(descriptor.instance.instance_id);
                    let reclaimed = if identity_is_dead {
                        remove_if_present(&path);
                        if endpoint_is_owned {
                            remove_endpoint_artifact(&descriptor.endpoint);
                        }
                        true
                    } else {
                        false
                    };
                    problems.push(DiscoveryProblem {
                        descriptor_path: path,
                        category,
                        error,
                        reclaimed,
                    });
                }
            }
        }
        (live, problems)
    }

    fn probe(&self, descriptor: &StoredDescriptor) -> Result<InstanceRecord, ControlError> {
        if descriptor.descriptor_schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(ControlError::new(
                "control.instance.protocol_incompatible",
                "The instance descriptor schema is incompatible",
            )
            .with_expected_observed(
                DESCRIPTOR_SCHEMA_VERSION.to_string(),
                descriptor.descriptor_schema_version.to_string(),
            ));
        }
        if descriptor.instance.build.control_protocol_version
            != self.expected_build.control_protocol_version
        {
            return Err(ControlError::new(
                "control.instance.protocol_incompatible",
                "The instance control protocol is incompatible",
            )
            .with_expected_observed(
                self.expected_build.control_protocol_version.to_string(),
                descriptor
                    .instance
                    .build
                    .control_protocol_version
                    .to_string(),
            ));
        }
        let hello = request(descriptor, ControlOperation::Hello).and_then(expect_hello_result)?;
        let record = hello.instance;
        if record.instance_id != descriptor.instance.instance_id
            || record.name != descriptor.instance.name
            || record.state_root != descriptor.instance.state_root
            || record.process_id != descriptor.instance.process_id
            || record.process_started_at != descriptor.instance.process_started_at
            || record.build != descriptor.instance.build
        {
            return Err(ControlError::new(
                "control.instance.handshake_failed",
                "The live handshake does not match the published descriptor identity",
            ));
        }
        Ok(record)
    }
}

fn select_instance(
    instances: Vec<(StoredDescriptor, InstanceRecord)>,
    selector: Option<&str>,
) -> Result<StoredDescriptor, ControlError> {
    let requested = selector.map(str::to_string);
    let mut matches: Vec<_> = match selector {
        Some(selector) => instances
            .into_iter()
            .filter(|(_, record)| {
                record.name == selector || record.instance_id.to_string() == selector
            })
            .collect(),
        None => instances,
    };
    match matches.len() {
        0 => Err(ControlError::new(
            "control.instance.absent",
            "No live compatible instance matched the requested selector",
        )
        .with_selector(requested.unwrap_or_else(|| "<sole-live-instance>".to_string()))),
        1 => Ok(matches.remove(0).0),
        _ => Err(ControlError::new(
            "control.instance.ambiguous",
            "More than one live instance matched; provide an exact name or UUID",
        )
        .with_selector(requested.unwrap_or_else(|| "<sole-live-instance>".to_string()))),
    }
}

fn request(
    descriptor: &StoredDescriptor,
    operation: ControlOperation,
) -> Result<ControlStream, ControlError> {
    request_with_id(descriptor, operation, Uuid::new_v4())
}

fn request_terminal_attachment(
    descriptor: &StoredDescriptor,
    terminal_id: TerminalId,
) -> Result<TerminalAttachmentClient, ControlError> {
    let request_id = Uuid::new_v4();
    let frame = ControlRequest {
        frame_type: "request".to_string(),
        frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
        control_protocol_version: descriptor.instance.build.control_protocol_version,
        request_id,
        auth_token: descriptor.auth_token.clone(),
        caller: ControlCaller {
            process_id: std::process::id(),
            executable_role: "shipctl-cli".to_string(),
            injected_instance_id: std::env::var("SHIPCTL_INSTANCE_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        },
        operation: ControlOperation::Terminals {
            command: TerminalCommand::Attach { terminal_id },
        },
    };
    let mut stream = connect_endpoint(&descriptor.endpoint).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not connect to the published local endpoint: {error}"),
        )
        .for_context(
            descriptor.instance.instance_id,
            descriptor.instance.state_root.clone(),
        )
    })?;
    serde_json::to_writer(&mut stream, &frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not encode the terminal attachment request: {error}"),
        )
    })?;
    stream
        .write_all(b"\n")
        .and_then(|()| stream.flush())
        .map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("Could not send the terminal attachment request: {error}"),
            )
        })?;

    let mut reader = BufReader::new(stream);
    let mut response_frame = String::new();
    reader.read_line(&mut response_frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not read the terminal attachment response: {error}"),
        )
    })?;
    let response: ControlResponse = serde_json::from_str(&response_frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("The terminal attachment response is invalid: {error}"),
        )
    })?;
    if response.frame_type != "response"
        || response.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
        || response.request_id != request_id
    {
        return Err(ControlError::new(
            "control.instance.handshake_failed",
            "The terminal attachment response did not match the request identity or schema",
        ));
    }
    let state = match (response.result, response.error) {
        (Some(ControlResponseResult::TerminalAttachment(state)), None) => state,
        (None, Some(error)) => return Err(error),
        _ => {
            return Err(ControlError::new(
                "control.instance.handshake_failed",
                "The endpoint returned an invalid terminal attachment response",
            ));
        }
    };
    if state.terminal_id != terminal_id {
        return Err(ControlError::new(
            "control.instance.handshake_failed",
            "The terminal attachment response addressed another terminal",
        ));
    }
    let terminal_sequence = state.sequence_boundary;
    Ok(TerminalAttachmentClient {
        state,
        request_id,
        reader,
        control_sequence: 0,
        terminal_sequence,
        completed: false,
    })
}

/// Sends one authenticated request using the caller's stable mutation
/// identity. Read-only callers use [`request`], while retryable scheduler
/// refresh and trigger clients reuse this UUID after a lost response.
fn request_with_id(
    descriptor: &StoredDescriptor,
    operation: ControlOperation,
    request_id: Uuid,
) -> Result<ControlStream, ControlError> {
    let frame = ControlRequest {
        frame_type: "request".to_string(),
        frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
        control_protocol_version: descriptor.instance.build.control_protocol_version,
        request_id,
        auth_token: descriptor.auth_token.clone(),
        caller: ControlCaller {
            process_id: std::process::id(),
            executable_role: "shipctl-cli".to_string(),
            injected_instance_id: std::env::var("SHIPCTL_INSTANCE_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        },
        operation,
    };
    let mut stream = connect_endpoint(&descriptor.endpoint).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not connect to the published local endpoint: {error}"),
        )
        .for_context(
            descriptor.instance.instance_id,
            descriptor.instance.state_root.clone(),
        )
    })?;
    serde_json::to_writer(&mut stream, &frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not encode the local control request: {error}"),
        )
    })?;
    stream
        .write_all(b"\n")
        .and_then(|()| stream.flush())
        .map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("Could not send the local control request: {error}"),
            )
        })?;

    let mut reader = BufReader::new(stream);
    let mut response_frame = String::new();
    reader.read_line(&mut response_frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("Could not read the local control response: {error}"),
        )
    })?;
    let response: ControlResponse = serde_json::from_str(&response_frame).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("The local control response is invalid: {error}"),
        )
    })?;
    if response.frame_type != "response"
        || response.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
        || response.request_id != request_id
    {
        return Err(ControlError::new(
            "control.instance.handshake_failed",
            "The local control response did not match the request identity or schema",
        ));
    }
    let outcome = match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The local control response has an invalid result/error shape",
        )),
    };
    let mut events = Vec::new();
    loop {
        let mut frame = String::new();
        let read = reader.read_line(&mut frame).map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("Could not read the local control stream frame: {error}"),
            )
        })?;
        if read == 0 {
            return Err(ControlError::new(
                "control.instance.handshake_failed",
                "The local control stream ended before its completion frame",
            ));
        }
        let value: serde_json::Value = serde_json::from_str(&frame).map_err(|error| {
            ControlError::new(
                "control.instance.handshake_failed",
                format!("The local control stream frame is invalid JSON: {error}"),
            )
        })?;
        match value.get("frameType").and_then(serde_json::Value::as_str) {
            Some("event") => {
                let event: ControlEvent = serde_json::from_value(value).map_err(|error| {
                    ControlError::new(
                        "control.instance.handshake_failed",
                        format!("The local control event frame is invalid: {error}"),
                    )
                })?;
                if event.frame_type != "event"
                    || event.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
                    || event.request_id != request_id
                    || event.sequence != events.len() as u64 + 1
                {
                    return Err(ControlError::new(
                        "control.instance.handshake_failed",
                        "The local control event did not match the request, schema, or ordering",
                    ));
                }
                events.push(event.event);
            }
            Some("completion") => {
                let completion: ControlCompletion =
                    serde_json::from_value(value).map_err(|error| {
                        ControlError::new(
                            "control.instance.handshake_failed",
                            format!("The local control completion frame is invalid: {error}"),
                        )
                    })?;
                let expected_status = if outcome.is_ok() {
                    ControlCompletionStatus::Succeeded
                } else {
                    ControlCompletionStatus::Failed
                };
                if completion.frame_type != "completion"
                    || completion.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
                    || completion.request_id != request_id
                    || completion.event_count != events.len() as u64
                    || completion.status != expected_status
                {
                    return Err(ControlError::new(
                        "control.instance.handshake_failed",
                        "The local control completion did not match the response stream",
                    ));
                }
                return outcome.map(|result| ControlStream { result, events });
            }
            _ => {
                return Err(ControlError::new(
                    "control.instance.handshake_failed",
                    "The local control stream contains an unknown frame type",
                ));
            }
        }
    }
}

fn expect_instance_result(stream: ControlStream) -> Result<InstanceRecord, ControlError> {
    match stream.result {
        ControlResponseResult::Instance(instance) => Ok(instance),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-inspection result for an inspection request",
        )),
    }
}

fn expect_terminal_list_result(stream: ControlStream) -> Result<TerminalListResult, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalList(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-list result for a terminal list request",
        )),
    }
}

fn expect_terminal_descriptor_result(
    stream: ControlStream,
) -> Result<TerminalDescriptor, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalDescriptor(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-descriptor result for a terminal get request",
        )),
    }
}

fn expect_terminal_driver_result(
    stream: ControlStream,
) -> Result<TerminalDriverResult, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalDriver(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-driver result for a terminal driver request",
        )),
    }
}

fn expect_terminal_write_result(
    stream: ControlStream,
) -> Result<TerminalWriteResult, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalWrite(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-write result for a terminal write request",
        )),
    }
}

fn expect_terminal_agent_report_result(
    stream: ControlStream,
) -> Result<TerminalAgentReportResult, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalAgentReport(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-report result for a terminal agent report request",
        )),
    }
}

fn expect_terminal_close_result(
    stream: ControlStream,
) -> Result<TerminalCloseControlResult, ControlError> {
    match stream.result {
        ControlResponseResult::TerminalClose(result) => Ok(result),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-close result for a terminal close request",
        )),
    }
}

fn terminal_event_identity(
    event: &TerminalControlEvent,
) -> (TerminalId, TerminalAttachmentId, u64, bool) {
    match event {
        TerminalControlEvent::Output {
            terminal_id,
            attachment_id,
            sequence,
            ..
        }
        | TerminalControlEvent::MetadataChanged {
            terminal_id,
            attachment_id,
            sequence,
            ..
        }
        | TerminalControlEvent::AgentActivityChanged {
            terminal_id,
            attachment_id,
            sequence,
            ..
        }
        | TerminalControlEvent::Exited {
            terminal_id,
            attachment_id,
            sequence,
            ..
        }
        | TerminalControlEvent::Detached {
            terminal_id,
            attachment_id,
            sequence,
            ..
        } => (*terminal_id, *attachment_id, *sequence, false),
        TerminalControlEvent::ResyncRequired {
            terminal_id,
            attachment_id,
            sequence,
            ..
        } => (*terminal_id, *attachment_id, *sequence, true),
    }
}

fn expect_hello_result(stream: ControlStream) -> Result<ControlHello, ControlError> {
    match stream.result {
        ControlResponseResult::Hello(hello) => Ok(hello),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-hello result for a hello request",
        )),
    }
}

fn expect_instance_diagnostics(
    stream: ControlStream,
) -> Result<InstanceDiagnosticReport, ControlError> {
    match stream.result {
        ControlResponseResult::InstanceDiagnostics(report) => Ok(report),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-diagnostic result for an instance diagnosis request",
        )),
    }
}

fn expect_stop_result(stream: ControlStream) -> Result<StopOutcome, ControlError> {
    match stream.result {
        ControlResponseResult::Stop(outcome) => Ok(outcome),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned an inspection result for a stop request",
        )),
    }
}

fn expect_state_archive_result(
    stream: ControlStream,
) -> Result<StateArchiveInspection, ControlError> {
    match stream.result {
        ControlResponseResult::StateArchive(archive) => Ok(archive),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-archive result for a state save request",
        )),
    }
}

fn expect_module_inspection_result(
    stream: ControlStream,
) -> Result<ModuleInspection, ControlError> {
    match stream.result {
        ControlResponseResult::ModuleInspection(inspection) => Ok(inspection),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-inspection result for a module inspection request",
        )),
    }
}

fn expect_module_diagnostics_result(
    stream: ControlStream,
) -> Result<Vec<Diagnostic>, ControlError> {
    match stream.result {
        ControlResponseResult::ModuleDiagnostics(diagnostics) => Ok(diagnostics),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-diagnostic result for a module diagnostic request",
        )),
    }
}

fn expect_message_inspection_result(
    stream: ControlStream,
) -> Result<MessageRuntimeInspection, ControlError> {
    match stream.result {
        ControlResponseResult::MessageInspection(inspection) => Ok(inspection),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-inspection result for a message inspection request",
        )),
    }
}

fn expect_message_diagnostics_result(
    stream: ControlStream,
) -> Result<MessageDiagnosticReport, ControlError> {
    match stream.result {
        ControlResponseResult::MessageDiagnostics(diagnostics) => Ok(diagnostics),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-diagnostic result for a message diagnosis request",
        )),
    }
}

fn expect_capability_catalog_result(
    stream: ControlStream,
) -> Result<ActiveCapabilityCatalog, ControlError> {
    match stream.result {
        ControlResponseResult::CapabilityCatalog(catalog) => Ok(catalog),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-catalog result for a capability list request",
        )),
    }
}

fn expect_capability_inspection_result(
    stream: ControlStream,
) -> Result<ActiveCapabilityInspection, ControlError> {
    match stream.result {
        ControlResponseResult::CapabilityInspection(inspection) => Ok(inspection),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-inspection result for a capability inspection request",
        )),
    }
}

fn expect_capability_invocation_result(
    stream: ControlStream,
) -> Result<CapabilityInvocation, ControlError> {
    match stream.result {
        ControlResponseResult::CapabilityInvocation(invocation) => Ok(invocation),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-invocation result for a capability call request",
        )),
    }
}

fn expect_schedule_inspection_result(
    stream: ControlStream,
) -> Result<ScheduleInspection, ControlError> {
    match stream.result {
        ControlResponseResult::ScheduleInspection(inspection) => Ok(inspection),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-inspection result for a schedule inspection request",
        )),
    }
}

fn expect_schedule_diagnostics_result(
    stream: ControlStream,
) -> Result<ScheduleDiagnosticReport, ControlError> {
    match stream.result {
        ControlResponseResult::ScheduleDiagnostics(report) => Ok(report),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-diagnostic result for a schedule diagnosis request",
        )),
    }
}

fn expect_schedule_verification_result(
    stream: ControlStream,
) -> Result<ScheduleVerification, ControlError> {
    match stream.result {
        ControlResponseResult::ScheduleVerification(verification) => Ok(verification),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-verification result for a schedule verification request",
        )),
    }
}

fn expect_schedule_refresh_result(
    stream: ControlStream,
) -> Result<ScheduleRefreshReport, ControlError> {
    match stream.result {
        ControlResponseResult::ScheduleRefresh(report) => Ok(report),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-refresh result for a schedule refresh request",
        )),
    }
}

fn expect_schedule_trigger_result(
    stream: ControlStream,
) -> Result<ScheduleTriggerReport, ControlError> {
    match stream.result {
        ControlResponseResult::ScheduleTrigger(report) => Ok(report),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-trigger result for a schedule trigger request",
        )),
    }
}

fn expect_module_operation_result(stream: ControlStream) -> Result<ModuleOperation, ControlError> {
    match stream.result {
        ControlResponseResult::ModuleOperation(operation) => Ok(operation),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The endpoint returned a non-operation result for a module operation request",
        )),
    }
}

fn read_descriptor(path: &Path) -> Result<StoredDescriptor, ControlError> {
    let bytes = fs::read(path).map_err(|error| {
        ControlError::new(
            "control.instance.stale_descriptor",
            format!("Could not read instance descriptor: {error}"),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ControlError::new(
            "control.instance.stale_descriptor",
            format!("Could not decode instance descriptor: {error}"),
        )
    })
}

fn write_descriptor_atomically(
    descriptor_path: &Path,
    descriptor: &StoredDescriptor,
) -> std::io::Result<()> {
    let temporary = descriptor_path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    set_private_file(&temporary)?;
    serde_json::to_writer_pretty(&mut file, descriptor).map_err(std::io::Error::other)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, descriptor_path).inspect_err(|_| remove_if_present(&temporary))?;
    Ok(())
}

fn category_for(error: &ControlError) -> DiscoveryProblemCategory {
    match error.code.as_str() {
        "control.instance.unauthorized" => DiscoveryProblemCategory::Unauthorized,
        "control.instance.protocol_incompatible" => DiscoveryProblemCategory::Incompatible,
        "control.instance.stale_descriptor" => DiscoveryProblemCategory::Stale,
        _ => DiscoveryProblemCategory::HandshakeFailed,
    }
}

fn remove_if_present(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "Could not remove Shipctl runtime artifact {}: {error}",
                path.display()
            );
        }
    }
}

fn withdraw_descriptor(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn endpoint_name(instance_id: Uuid) -> String {
    format!("shipctl.{}", instance_id.simple())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
fn remove_endpoint_artifact(endpoint: &str) {
    remove_if_present(&Path::new("/tmp").join(endpoint));
}

#[cfg(any(windows, target_os = "linux", target_os = "android"))]
fn remove_endpoint_artifact(_endpoint: &str) {}

fn wake_endpoint(endpoint: &str) {
    let _ = connect_endpoint(endpoint);
}

fn connect_endpoint(endpoint: &str) -> std::io::Result<Stream> {
    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    ConnectOptions::new().name(name).connect_sync()
}

#[cfg(unix)]
fn bind_listener(endpoint: &str) -> std::io::Result<Listener> {
    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()?;
    protect_endpoint_artifact(endpoint)?;
    Ok(listener)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
fn protect_endpoint_artifact(endpoint: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(
        Path::new("/tmp").join(endpoint),
        fs::Permissions::from_mode(0o600),
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn protect_endpoint_artifact(_endpoint: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn bind_listener(endpoint: &str) -> std::io::Result<Listener> {
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use widestring::U16CString;

    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    let sddl = U16CString::from_str("D:P(A;;GA;;;OW)").map_err(std::io::Error::other)?;
    let security = SecurityDescriptor::deserialize(&sddl)?;
    ListenerOptions::new()
        .name(name)
        .security_descriptor(security)
        .create_sync()
}

#[cfg(unix)]
fn peer_is_current_user(stream: &Stream) -> std::io::Result<bool> {
    let peer = stream.peer_creds()?;
    let current = unsafe { libc::geteuid() };
    Ok(peer.euid() == Some(current))
}

#[cfg(windows)]
fn peer_is_current_user(_stream: &Stream) -> std::io::Result<bool> {
    // The listener's owner-only DACL is the platform authentication check.
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::context::{InstanceLaunchOptions, LaunchProvenance};
    use crate::scheduler::contracts::{ScheduleDeliveryOutcome, ScheduleDeliverySummary};
    use crate::scheduler::{SCHEDULE_CONTROL_SCHEMA_VERSION, SCHEDULE_INSPECTION_SCHEMA_VERSION};
    use crate::terminal_host::TerminalColorTheme;
    use crate::terminal_host::{
        TerminalLaunchRequest, TerminalLaunchTarget, TerminalMetadata, TerminalOwner,
        TerminalService,
    };
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct FakeHandler {
        active: AtomicUsize,
        shutdown: AtomicBool,
        schedule_requests: Mutex<Vec<(ScheduleCommand, Uuid)>>,
        terminal_writes: Mutex<Vec<Vec<u8>>>,
        terminals: TerminalService,
    }

    struct FingerprintFailureHandler;

    impl ControlHandler for FingerprintFailureHandler {
        fn active_work(&self) -> Vec<ActiveWorkBlocker> {
            Vec::new()
        }

        fn state_fingerprint(&self) -> Result<Option<String>, ControlError> {
            Err(ControlError::new(
                "state.snapshot.unclassified_source",
                "Durable source is not classified: legacy.json",
            ))
        }

        fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
            Ok(())
        }
    }

    impl ControlHandler for FakeHandler {
        fn active_work(&self) -> Vec<ActiveWorkBlocker> {
            let count = self.active.load(Ordering::SeqCst);
            if count == 0 {
                Vec::new()
            } else {
                vec![ActiveWorkBlocker {
                    kind: "terminal_sessions".to_string(),
                    count,
                    message: "Terminal sessions are still running".to_string(),
                }]
            }
        }

        fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
            self.shutdown.store(true, Ordering::SeqCst);
            self.terminals.begin_shutdown();
            self.terminals.shutdown_all();
            Ok(())
        }

        fn terminal_list(&self) -> Result<Vec<TerminalDescriptor>, ControlError> {
            Ok(self.terminals.list())
        }

        fn terminal_get(&self, id: TerminalId) -> Result<TerminalDescriptor, ControlError> {
            self.terminals.get(id).map_err(terminal_control_error)
        }

        fn terminal_driver_request(
            &self,
            id: TerminalId,
            request: serde_json::Value,
        ) -> Result<serde_json::Value, ControlError> {
            self.terminals
                .request_driver(id, request)
                .map_err(terminal_control_error)
        }

        fn terminal_write(&self, id: TerminalId, data: Vec<u8>) -> Result<(), ControlError> {
            self.terminal_writes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(data.clone());
            self.terminals
                .write(id, &data)
                .map_err(terminal_control_error)
        }

        fn terminal_report(
            &self,
            report: TerminalAgentReportRequest,
        ) -> Result<TerminalAgentActivity, ControlError> {
            self.terminals
                .report_agent(report)
                .map_err(terminal_control_error)
        }

        fn terminal_close(
            &self,
            id: TerminalId,
        ) -> Result<crate::terminal_host::TerminalCloseResult, ControlError> {
            self.terminals.close(id).map_err(terminal_control_error)
        }

        fn terminal_attach_raw(
            &self,
            id: TerminalId,
            sink: Arc<dyn TerminalEventSink>,
        ) -> Result<TerminalRawAttachment, ControlError> {
            self.terminals
                .attach_raw(id, sink, false)
                .map_err(terminal_control_error)
        }

        fn terminal_detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), ControlError> {
            self.terminals
                .detach(attachment_id)
                .map_err(terminal_control_error)
        }

        fn schedule_control(
            &self,
            command: ScheduleCommand,
            request_id: Uuid,
        ) -> Result<ControlStream, ControlError> {
            let result = match &command {
                ScheduleCommand::List {} | ScheduleCommand::Inspect { .. } => {
                    ControlResponseResult::ScheduleInspection(schedule_inspection())
                }
                ScheduleCommand::Diagnose {} => {
                    ControlResponseResult::ScheduleDiagnostics(ScheduleDiagnosticReport {
                        schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
                        code: "scheduler.control.diagnosed".to_string(),
                        healthy: true,
                        inspection: schedule_inspection(),
                        diagnostics: Vec::new(),
                    })
                }
                ScheduleCommand::Verify {} => {
                    ControlResponseResult::ScheduleVerification(ScheduleVerification {
                        schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
                        code: "scheduler.control.verified".to_string(),
                        matches_accepted: true,
                        accepted: schedule_inspection(),
                        candidate_digest_sha256: Some("candidate".to_string()),
                        diagnostics: Vec::new(),
                    })
                }
                ScheduleCommand::Refresh {} => {
                    ControlResponseResult::ScheduleRefresh(ScheduleRefreshReport {
                        schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
                        code: "scheduler.control.refreshed".to_string(),
                        applied: true,
                        inspection: schedule_inspection(),
                        diagnostics: Vec::new(),
                    })
                }
                ScheduleCommand::Trigger { schedule_id } => {
                    ControlResponseResult::ScheduleTrigger(ScheduleTriggerReport {
                        schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
                        code: "scheduler.control.triggered".to_string(),
                        inspection: schedule_inspection(),
                        schedule_id: schedule_id.clone(),
                        delivery: ScheduleDeliverySummary {
                            occurrence_utc: "2026-08-09T00:00:00Z".to_string(),
                            outcome: ScheduleDeliveryOutcome::Delivered,
                            route_generation: 2,
                            diagnostic: None,
                        },
                    })
                }
            };
            self.schedule_requests
                .lock()
                .unwrap()
                .push((command, request_id));
            Ok(ControlStream::result(result))
        }
    }

    fn schedule_inspection() -> ScheduleInspection {
        ScheduleInspection {
            schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
            instance_id: "test-instance".to_string(),
            incarnation: "test-incarnation".to_string(),
            schedule_generation: 1,
            snapshot_digest_sha256: "accepted".to_string(),
            bus_route_generation: 2,
            schedules: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn terminal_input_is_base64_strict_and_uses_the_established_flow_budget() {
        let accepted = vec![0x5a; TERMINAL_CONTROL_WRITE_MAX_BYTES];
        assert_eq!(
            decode_terminal_input(&BASE64_STANDARD.encode(&accepted)).unwrap(),
            accepted
        );
        assert_eq!(
            decode_terminal_input("not-base64!")
                .unwrap_err()
                .code
                .as_str(),
            "terminal.input.invalid_base64"
        );
        assert_eq!(
            decode_terminal_input(&BASE64_STANDARD.encode(vec![
                0_u8;
                TERMINAL_CONTROL_WRITE_MAX_BYTES
                    + 1
            ]))
            .unwrap_err()
            .code
            .as_str(),
            "terminal.input.too_large"
        );
    }

    fn fixture(label: &str) -> (InstanceContext, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "shipctl-control-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let context = InstanceContext::resolve(
            InstanceLaunchOptions {
                name: Some(label.to_string()),
                state_root: Some(root.join("state")),
                runtime_root: Some(root.join("runtime")),
                load_state: None,
                provenance: Some(LaunchProvenance::Cli),
            },
            "1.0.0",
        )
        .unwrap();
        (context, root)
    }

    fn fake_handler(instance_id: &str, active: usize) -> Arc<FakeHandler> {
        Arc::new(FakeHandler {
            active: AtomicUsize::new(active),
            shutdown: AtomicBool::new(false),
            schedule_requests: Mutex::new(Vec::new()),
            terminal_writes: Mutex::new(Vec::new()),
            terminals: TerminalService::new(
                instance_id,
                crate::terminal_host::retention::TerminalRetentionPolicy::default(),
            ),
        })
    }

    #[cfg(unix)]
    fn terminal_request(source: &str) -> TerminalLaunchRequest {
        let cwd = PathBuf::from("/tmp");
        TerminalLaunchRequest {
            driver_id: crate::terminal_host::types::default_terminal_driver_id(),
            target: TerminalLaunchTarget::Program {
                program: PathBuf::from("/bin/sh"),
                argv: vec!["-c".to_string(), source.to_string()],
            },
            cwd: cwd.clone(),
            environment: HashMap::new(),
            columns: 80,
            rows: 24,
            color_theme: TerminalColorTheme {
                foreground: "#ffffff".to_string(),
                background: "#000000".to_string(),
                palette: vec!["#000000".to_string(); 16],
            },
            metadata: TerminalMetadata {
                label: "control terminal".to_string(),
                cwd,
                project_path: None,
                display_command: "sh".to_string(),
                created_at_ms: 1,
                owner: TerminalOwner::Core,
                owner_metadata: None,
                presentation: None,
            },
        }
    }

    #[test]
    fn discovery_requires_handshake_and_shutdown_requires_force_for_active_work() {
        let (context, root) = fixture("live");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("live", 2);
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

        let report = directory.discover();
        assert_eq!(report.instances.len(), 1);
        assert!(report.problems.is_empty());
        assert_eq!(report.instances[0].active_work[0].count, 2);
        let blocked = directory.stop(Some("live"), false).unwrap_err();
        assert_eq!(blocked.code.as_str(), "control.instance.shutdown_blocked");
        assert!(!handler.shutdown.load(Ordering::SeqCst));

        let serialized = serde_json::to_string(&report).unwrap();
        let descriptor = fs::read_to_string(server.descriptor_path()).unwrap();
        let stored: StoredDescriptor = serde_json::from_str(&descriptor).unwrap();
        assert!(!serialized.contains(&stored.auth_token));

        let forced = directory.stop(Some("live"), true).unwrap();
        assert!(forced.accepted);
        assert_eq!(forced.instance.lifecycle, InstanceLifecycle::Stopping);
        assert!(!server.descriptor_path().exists());

        drop(server);
        assert!(handler.shutdown.load(Ordering::SeqCst));
        let repeated = directory.stop(Some("live"), true).unwrap_err();
        assert_eq!(repeated.code.as_str(), "control.instance.absent");
        assert!(directory.discover().instances.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn readiness_survives_an_unavailable_state_fingerprint() {
        let (context, root) = fixture("fingerprint-degraded");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let server =
            ControlServer::start(context.clone(), leases, Arc::new(FingerprintFailureHandler))
                .unwrap();

        let descriptor: StoredDescriptor =
            serde_json::from_slice(&fs::read(server.descriptor_path()).unwrap()).unwrap();
        assert_eq!(descriptor.instance.lifecycle, InstanceLifecycle::Ready);
        assert_eq!(descriptor.instance.state_fingerprint, None);

        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn authenticated_schedule_dispatch_preserves_the_caller_request_identity() {
        let (context, root) = fixture("schedule-dispatch");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("schedule-dispatch", 0);
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let descriptor: StoredDescriptor =
            serde_json::from_slice(&fs::read(server.descriptor_path()).unwrap()).unwrap();
        let request_id = Uuid::new_v4();

        let stream = request_with_id(
            &descriptor,
            ControlOperation::Schedules {
                command: ScheduleCommand::Trigger {
                    schedule_id: "agents.refresh".to_string(),
                },
            },
            request_id,
        )
        .unwrap();

        assert!(matches!(
            stream.result,
            ControlResponseResult::ScheduleTrigger(ref report)
                if report.schedule_id == "agents.refresh"
        ));
        assert_eq!(
            handler.schedule_requests.lock().unwrap().as_slice(),
            &[(
                ScheduleCommand::Trigger {
                    schedule_id: "agents.refresh".to_string(),
                },
                request_id,
            )]
        );

        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn schedule_directory_methods_return_typed_results_and_preserve_mutation_ids() {
        let (context, root) = fixture("schedule-directory");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("schedule-directory", 0);
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());
        let refresh_request_id = Uuid::new_v4();
        let trigger_request_id = Uuid::new_v4();

        assert_eq!(
            directory
                .list_schedules("schedule-directory")
                .unwrap()
                .schedule_generation,
            1
        );
        assert_eq!(
            directory
                .inspect_schedule("schedule-directory", "agents.refresh".to_string())
                .unwrap()
                .snapshot_digest_sha256,
            "accepted"
        );
        assert!(
            directory
                .diagnose_schedules("schedule-directory")
                .unwrap()
                .healthy
        );
        assert!(
            directory
                .verify_schedules("schedule-directory")
                .unwrap()
                .matches_accepted
        );
        assert!(
            directory
                .refresh_schedules_with_request_id("schedule-directory", refresh_request_id)
                .unwrap()
                .applied
        );
        assert_eq!(
            directory
                .trigger_schedule_with_request_id(
                    "schedule-directory",
                    "agents.refresh".to_string(),
                    trigger_request_id,
                )
                .unwrap()
                .schedule_id,
            "agents.refresh"
        );

        let schedule_requests = handler.schedule_requests.lock().unwrap();
        assert_eq!(schedule_requests.len(), 6);
        assert_eq!(
            schedule_requests[4],
            (ScheduleCommand::Refresh {}, refresh_request_id)
        );
        assert_eq!(
            schedule_requests[5],
            (
                ScheduleCommand::Trigger {
                    schedule_id: "agents.refresh".to_string(),
                },
                trigger_request_id,
            )
        );

        drop(schedule_requests);
        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn schedule_operations_require_current_schema_protocol_and_authentication() {
        let (context, root) = fixture("schedule-authentication");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("schedule-authentication", 0);
        let server = ControlServer::start(context, leases, handler.clone()).unwrap();
        let descriptor: StoredDescriptor =
            serde_json::from_slice(&fs::read(server.descriptor_path()).unwrap()).unwrap();
        let stopping = AtomicBool::new(false);

        let mut invalid_schema = schedule_request(&descriptor, Uuid::new_v4());
        invalid_schema.frame_schema_version -= 1;
        let (response, events) =
            dispatch_request(invalid_schema, &descriptor, &*handler, &stopping);
        assert!(events.is_empty());
        assert_eq!(
            response.error.unwrap().code.as_str(),
            "control.instance.protocol_incompatible"
        );

        let mut invalid_protocol = schedule_request(&descriptor, Uuid::new_v4());
        invalid_protocol.control_protocol_version -= 1;
        let (response, events) =
            dispatch_request(invalid_protocol, &descriptor, &*handler, &stopping);
        assert!(events.is_empty());
        assert_eq!(
            response.error.unwrap().code.as_str(),
            "control.instance.protocol_incompatible"
        );

        let mut invalid_authentication = schedule_request(&descriptor, Uuid::new_v4());
        invalid_authentication.auth_token = "wrong-token".to_string();
        let (response, events) =
            dispatch_request(invalid_authentication, &descriptor, &*handler, &stopping);
        assert!(events.is_empty());
        assert_eq!(
            response.error.unwrap().code.as_str(),
            "control.instance.unauthorized"
        );
        assert!(handler.schedule_requests.lock().unwrap().is_empty());

        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    fn schedule_request(descriptor: &StoredDescriptor, request_id: Uuid) -> ControlRequest {
        ControlRequest {
            frame_type: "request".to_string(),
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            control_protocol_version: descriptor.instance.build.control_protocol_version,
            request_id,
            auth_token: descriptor.auth_token.clone(),
            caller: ControlCaller {
                process_id: std::process::id(),
                executable_role: "shipctl-cli".to_string(),
                injected_instance_id: None,
            },
            operation: ControlOperation::Schedules {
                command: ScheduleCommand::List {},
            },
        }
    }

    #[cfg(unix)]
    #[test]
    fn raw_terminal_attachment_stays_concurrent_with_finite_control() {
        let (context, root) = fixture("terminal-control");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("terminal-control", 0);
        let terminal = handler
            .terminals
            .spawn(terminal_request(
                "stty -echo; printf 'socket-replay\\n'; while IFS= read -r line; do printf 'socket-live:%s\\n' \"$line\"; done",
            ))
            .unwrap();
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

        let listed = directory.list_terminals("terminal-control").unwrap();
        assert_eq!(listed.count, 1);
        assert_eq!(listed.terminals[0].id, terminal.id);
        assert_eq!(
            directory
                .get_terminal("terminal-control", terminal.id)
                .unwrap()
                .id,
            terminal.id
        );
        let foreign_id = TerminalId::new();
        let foreign_error = directory
            .report_terminal_agent(
                "terminal-control",
                TerminalAgentReportRequest {
                    terminal_id: foreign_id,
                    kind: crate::terminal_host::TerminalAgentReportKind::Working,
                    source: crate::terminal_host::TerminalAgentReportSource {
                        identifier: "control-test".to_string(),
                        version: "1".to_string(),
                    },
                    message: None,
                },
            )
            .unwrap_err();
        assert_eq!(foreign_error.code.as_str(), "terminal.not_found");

        let mut first = directory
            .attach_terminal("terminal-control", terminal.id)
            .unwrap();
        assert!(first.state().live);
        assert_eq!(first.state().terminal_id, terminal.id);

        let exact_input = b"first-line\n";
        let written = directory
            .write_terminal("terminal-control", terminal.id, exact_input)
            .unwrap();
        assert_eq!(written.accepted_bytes, exact_input.len());
        assert_eq!(
            handler.terminal_writes.lock().unwrap().last().unwrap(),
            exact_input
        );
        let mut first_output = Vec::new();
        while !String::from_utf8_lossy(&first_output).contains("socket-live:first-line") {
            if let Some(TerminalControlEvent::Output { data_base64, .. }) =
                first.next_event().unwrap()
            {
                first_output.extend(BASE64_STANDARD.decode(data_base64).unwrap());
            }
        }

        let reported = directory
            .report_terminal_agent(
                "terminal-control",
                TerminalAgentReportRequest {
                    terminal_id: terminal.id,
                    kind: crate::terminal_host::TerminalAgentReportKind::Blocked,
                    source: crate::terminal_host::TerminalAgentReportSource {
                        identifier: "control-test".to_string(),
                        version: "1".to_string(),
                    },
                    message: Some("awaiting input".to_string()),
                },
            )
            .unwrap();
        assert_eq!(reported.terminal_id, terminal.id);
        assert_eq!(reported.activity.revision, 1);
        assert_eq!(
            directory
                .get_terminal("terminal-control", terminal.id)
                .unwrap()
                .agent_activity,
            Some(reported.activity.clone())
        );
        assert!(matches!(
            first.next_event().unwrap(),
            Some(TerminalControlEvent::AgentActivityChanged {
                terminal_id,
                descriptor,
                ..
            }) if terminal_id == terminal.id
                && descriptor.agent_activity == Some(reported.activity.clone())
        ));

        // Dropping an observer leaves the process and registry record alive.
        drop(first);
        assert_eq!(
            directory
                .get_terminal("terminal-control", terminal.id)
                .unwrap()
                .lifecycle,
            crate::terminal_host::TerminalLifecycle::Running
        );

        let mut second = directory
            .attach_terminal("terminal-control", terminal.id)
            .unwrap();
        let exact_binary = [0_u8, 1, 2, 0xff, b'\n'];
        directory
            .write_terminal("terminal-control", terminal.id, &exact_binary)
            .unwrap();
        assert_eq!(
            handler.terminal_writes.lock().unwrap().last().unwrap(),
            &exact_binary
        );

        // A live attachment does not monopolize the endpoint. Closing from a
        // separate connection terminates only the addressed terminal.
        assert_eq!(
            directory.list_terminals("terminal-control").unwrap().count,
            1
        );
        let closed = directory
            .close_terminal("terminal-control", terminal.id)
            .unwrap();
        assert!(closed.existed);
        loop {
            match second.next_event().unwrap() {
                Some(TerminalControlEvent::Exited { terminal_id, .. }) => {
                    assert_eq!(terminal_id, terminal.id);
                }
                Some(_) => continue,
                None => break,
            }
        }
        assert!(
            !directory
                .close_terminal("terminal-control", terminal.id)
                .unwrap()
                .existed
        );
        assert_eq!(
            directory.list_terminals("terminal-control").unwrap().count,
            0
        );

        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    /// Semantic driver socket behavior is verified by the semantic-terminal module.

    #[cfg(unix)]
    #[test]
    fn live_terminal_attachment_does_not_block_server_shutdown() {
        let (context, root) = fixture("terminal-shutdown");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("terminal-shutdown", 0);
        let terminal = handler
            .terminals
            .spawn(terminal_request(
                "trap '' HUP TERM; while :; do sleep 60; done",
            ))
            .unwrap();
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());
        let attachment = directory
            .attach_terminal("terminal-shutdown", terminal.id)
            .unwrap();
        assert!(attachment.state().live);

        let stopped = directory.stop(Some("terminal-shutdown"), true).unwrap();
        assert!(stopped.accepted);
        drop(attachment);
        drop(server);
        assert!(handler.shutdown.load(Ordering::SeqCst));
        assert!(handler.terminals.list().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn stalled_terminal_socket_detaches_without_blocking_terminal_or_control() {
        let (context, root) = fixture("terminal-stalled-socket");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("terminal-stalled-socket", 0);
        let terminal = handler
            .terminals
            .spawn(terminal_request(
                "stty -echo; read go; while :; do printf 'socket-backpressure-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; done",
            ))
            .unwrap();
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());
        let attachment = directory
            .attach_terminal("terminal-stalled-socket", terminal.id)
            .unwrap();
        assert!(attachment.state().live);
        assert_eq!(handler.terminals.attachment_count(), 1);

        directory
            .write_terminal("terminal-stalled-socket", terminal.id, b"go\n")
            .unwrap();
        // The unread attachment is on its own nonblocking connection; finite
        // requests continue while that socket reaches backpressure.
        assert_eq!(
            directory
                .get_terminal("terminal-stalled-socket", terminal.id)
                .unwrap()
                .id,
            terminal.id
        );
        while handler.terminals.attachment_count() != 0 {
            std::thread::yield_now();
        }
        assert_eq!(handler.terminals.active_count(), 1);
        assert!(handler.terminals.get(terminal.id).is_ok());

        handler.terminals.close(terminal.id).unwrap();
        drop(attachment);
        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn idle_socket_disconnect_detaches_and_allows_later_reattach() {
        let (context, root) = fixture("terminal-disconnect");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = fake_handler("terminal-disconnect", 0);
        let terminal = handler
            .terminals
            .spawn(terminal_request(
                "stty -echo; while IFS= read -r line; do :; done",
            ))
            .unwrap();
        let server = ControlServer::start(context.clone(), leases, handler.clone()).unwrap();
        let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

        let first = directory
            .attach_terminal("terminal-disconnect", terminal.id)
            .unwrap();
        assert!(first.state().live);
        assert_eq!(handler.terminals.attachment_count(), 1);
        drop(first);
        while handler.terminals.attachment_count() != 0 {
            std::thread::yield_now();
        }
        assert_eq!(handler.terminals.active_count(), 1);

        let second = directory
            .attach_terminal("terminal-disconnect", terminal.id)
            .unwrap();
        assert!(second.state().live);
        drop(second);
        while handler.terminals.attachment_count() != 0 {
            std::thread::yield_now();
        }
        handler.terminals.close(terminal.id).unwrap();
        drop(server);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_handshake_reclaims_only_a_dead_process_identity() {
        let (context, root) = fixture("stale");
        let descriptors = context.runtime_root.join("instances");
        create_private_directory(&descriptors).unwrap();
        let path = descriptors.join(format!("{}.json", context.instance_id));
        let endpoint = endpoint_name(context.instance_id);
        let stale = StoredDescriptor {
            descriptor_schema_version: DESCRIPTOR_SCHEMA_VERSION,
            instance: InstanceRecord {
                instance_id: context.instance_id,
                name: context.name.clone(),
                build: context.build.clone(),
                process_id: u32::MAX,
                process_started_at: 1,
                state_root: context.state_root.clone(),
                runtime_root: context.runtime_root.clone(),
                endpoint_protocol: ENDPOINT_PROTOCOL.to_string(),
                lifecycle: InstanceLifecycle::Ready,
                active_work: Vec::new(),
                state_fingerprint: None,
                workspace_identities: Vec::new(),
                module_control: ModuleControlStatus::default(),
            },
            endpoint,
            auth_token: "not-a-live-token".to_string(),
        };
        write_descriptor_atomically(&path, &stale).unwrap();

        let report = InstanceDirectory::new(context.runtime_root, context.build).discover();

        assert!(report.instances.is_empty());
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].reclaimed);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
