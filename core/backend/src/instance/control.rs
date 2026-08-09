use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use interprocess::local_socket::{
    prelude::*, ConnectOptions, GenericNamespaced, Listener, ListenerOptions, Stream,
};
use uuid::Uuid;

use super::context::{InstanceBuildIdentity, InstanceContext};
use super::leases::{
    create_private_directory, process_start_time, set_private_file, InstanceLeases,
};
use super::protocol::{
    ActiveWorkBlocker, ControlCaller, ControlCompletion, ControlCompletionStatus, ControlError,
    ControlEvent, ControlEventPayload, ControlHello, ControlOperation, ControlRequest,
    ControlResponse, ControlResponseResult, ControlStream, DiscoveryProblem,
    DiscoveryProblemCategory, DiscoveryReport, InstanceDiagnosticReport, InstanceLifecycle,
    InstanceRecord, MessageCommand, ModuleCommand, ModuleControlStatus, OperationCommand,
    ScheduleCommand, StopOutcome, StoredDescriptor, CONTROL_FRAME_SCHEMA_VERSION,
};
use crate::message_bus::{MessageDiagnosticReport, MessageRuntimeInspection, RUNTIME_UNAVAILABLE};
use crate::module_control::codes::{
    CONTROL_CAPABILITY_UNAVAILABLE, OPERATION_CAPABILITY_UNAVAILABLE,
};
use crate::module_control::{
    Diagnostic, DiagnosticSeverity, ModuleInspection, ModuleOperation, ModuleOperationKind,
    RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use crate::scheduler::{
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleRefreshReport, ScheduleTriggerReport,
    ScheduleVerification,
};
use crate::state::archive::StateArchiveInspection;

const DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
const ENDPOINT_PROTOCOL: &str = "local_socket_json_line_v4";

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
    fn shutdown(&self, force: bool) -> Result<(), ControlError>;
}

pub struct ControlServer {
    stop: Arc<AtomicBool>,
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
        let state_fingerprint = handler.state_fingerprint()?;
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
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
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
                    &server_stop,
                    &server_stopping,
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
            stop.store(true, Ordering::SeqCst);
            wake_endpoint(&endpoint);
            let _ = thread.join();
            return Err(ControlError::new(
                "control.instance.descriptor_publish_failed",
                format!("Could not publish ready instance descriptor: {error}"),
            )
            .for_context(context.instance_id, context.state_root));
        }

        Ok(Self {
            stop,
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
        self.stop.store(true, Ordering::SeqCst);
        wake_endpoint(&self.endpoint);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        remove_if_present(&self.descriptor_path);
        remove_endpoint_artifact(&self.endpoint);
    }
}

fn run_server(
    listener: Listener,
    descriptor: &StoredDescriptor,
    descriptor_path: &Path,
    handler: Arc<dyn ControlHandler>,
    stop: &AtomicBool,
    stopping: &AtomicBool,
) {
    let mut committed_shutdown = None;
    while !stop.load(Ordering::SeqCst) {
        let Ok(stream) = listener.accept() else {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            continue;
        };
        match handle_connection(
            stream,
            descriptor,
            descriptor_path,
            handler.as_ref(),
            stopping,
        ) {
            Ok(Some(force)) => {
                committed_shutdown = Some(force);
                break;
            }
            Ok(None) | Err(_) => {}
        }
    }

    drop(listener);
    remove_endpoint_artifact(&descriptor.endpoint);
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
    if request.frame_type != "request" {
        return (
            ControlResponse::failure(
                request.request_id,
                ControlError::new(
                    "control.instance.invalid_frame",
                    "The local control frame must declare frameType request",
                ),
            ),
            Vec::new(),
        );
    }
    if request.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION {
        return (
            ControlResponse::failure(
                request.request_id,
                ControlError::new(
                    "control.instance.protocol_incompatible",
                    "The control frame schema is incompatible",
                )
                .with_expected_observed(
                    CONTROL_FRAME_SCHEMA_VERSION.to_string(),
                    request.frame_schema_version.to_string(),
                ),
            ),
            Vec::new(),
        );
    }
    if request.control_protocol_version != descriptor.instance.build.control_protocol_version {
        return (
            ControlResponse::failure(
                request.request_id,
                ControlError::new(
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
                ),
            ),
            Vec::new(),
        );
    }
    if request.auth_token != descriptor.auth_token {
        return (
            ControlResponse::failure(
                request.request_id,
                ControlError::new(
                    "control.instance.unauthorized",
                    "The local control authentication token is invalid",
                ),
            ),
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

fn write_frames(
    mut stream: Stream,
    response: &ControlResponse,
    events: &[ControlEventPayload],
) -> std::io::Result<()> {
    serde_json::to_writer(&mut stream, response).map_err(std::io::Error::other)?;
    stream.write_all(b"\n")?;
    for (index, event) in events.iter().enumerate() {
        serde_json::to_writer(
            &mut stream,
            &ControlEvent {
                frame_type: "event".to_string(),
                frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
                request_id: response.request_id,
                sequence: index as u64 + 1,
                event: event.clone(),
            },
        )
        .map_err(std::io::Error::other)?;
        stream.write_all(b"\n")?;
    }
    serde_json::to_writer(
        &mut stream,
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
    .map_err(std::io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub struct InstanceDirectory {
    runtime_root: PathBuf,
    expected_build: InstanceBuildIdentity,
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
    ) -> Result<ModuleOperation, ControlError> {
        self.transition_module_stream(selector, module_id, kind, target_registry_revision)
            .and_then(expect_module_operation_result)
    }

    pub fn transition_module_stream(
        &self,
        selector: Option<&str>,
        module_id: String,
        kind: ModuleOperationKind,
        target_registry_revision: u64,
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
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct FakeHandler {
        active: AtomicUsize,
        shutdown: AtomicBool,
        schedule_requests: Mutex<Vec<(ScheduleCommand, Uuid)>>,
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
            Ok(())
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

    #[test]
    fn discovery_requires_handshake_and_shutdown_requires_force_for_active_work() {
        let (context, root) = fixture("live");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = Arc::new(FakeHandler {
            active: AtomicUsize::new(2),
            shutdown: AtomicBool::new(false),
            schedule_requests: Mutex::new(Vec::new()),
        });
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
    fn authenticated_schedule_dispatch_preserves_the_caller_request_identity() {
        let (context, root) = fixture("schedule-dispatch");
        let leases = Arc::new(InstanceLeases::acquire(&context).unwrap());
        let handler = Arc::new(FakeHandler {
            active: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            schedule_requests: Mutex::new(Vec::new()),
        });
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
        let handler = Arc::new(FakeHandler {
            active: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            schedule_requests: Mutex::new(Vec::new()),
        });
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
        let handler = Arc::new(FakeHandler {
            active: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            schedule_requests: Mutex::new(Vec::new()),
        });
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
