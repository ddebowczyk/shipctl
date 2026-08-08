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
    ActiveWorkBlocker, ControlError, ControlOperation, ControlRequest, ControlResponse,
    ControlResponseResult, DiscoveryProblem, DiscoveryProblemCategory, DiscoveryReport,
    InstanceLifecycle, InstanceRecord, StopOutcome, StoredDescriptor, CONTROL_FRAME_SCHEMA_VERSION,
};
use crate::state::archive::StateArchiveInspection;

const DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
const ENDPOINT_PROTOCOL: &str = "local_socket_json_line_v1";

pub trait ControlHandler: Send + Sync + 'static {
    fn active_work(&self) -> Vec<ActiveWorkBlocker>;
    fn state_fingerprint(&self) -> Result<Option<String>, ControlError> {
        Ok(None)
    }
    fn save_state(&self, _destination: &Path) -> Result<StateArchiveInspection, ControlError> {
        Err(ControlError::new(
            "state.snapshot.provider_failed",
            "This instance does not provide state snapshots",
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
        return write_response(
            stream,
            &ControlResponse::failure(
                Uuid::nil(),
                ControlError::new(
                    "control.instance.unauthorized",
                    "The local control peer is not the current user",
                ),
            ),
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
            return write_response(
                reader.into_inner(),
                &ControlResponse::failure(
                    Uuid::nil(),
                    ControlError::new(
                        "control.instance.invalid_frame",
                        format!("The control request is not valid JSON: {error}"),
                    ),
                ),
            )
            .map(|()| None);
        }
    };
    let requested_shutdown = match &request.operation {
        ControlOperation::Shutdown { force } => Some(*force),
        _ => None,
    };
    let mut response = dispatch_request(request, descriptor, handler, stopping);
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
    let write_result = write_response(reader.into_inner(), &response);
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
) -> ControlResponse {
    if request.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION {
        return ControlResponse::failure(
            request.request_id,
            ControlError::new(
                "control.instance.protocol_incompatible",
                "The control frame schema is incompatible",
            )
            .with_expected_observed(
                CONTROL_FRAME_SCHEMA_VERSION.to_string(),
                request.frame_schema_version.to_string(),
            ),
        );
    }
    if request.control_protocol_version != descriptor.instance.build.control_protocol_version {
        return ControlResponse::failure(
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
        );
    }
    if request.auth_token != descriptor.auth_token {
        return ControlResponse::failure(
            request.request_id,
            ControlError::new(
                "control.instance.unauthorized",
                "The local control authentication token is invalid",
            ),
        );
    }

    match request.operation {
        ControlOperation::Ping => ControlResponse::success(
            request.request_id,
            ControlResponseResult::Instance(current_record(descriptor, handler, stopping)),
        ),
        ControlOperation::Inspect => {
            let mut record = current_record(descriptor, handler, stopping);
            match handler.state_fingerprint() {
                Ok(fingerprint) => {
                    record.state_fingerprint = fingerprint;
                    ControlResponse::success(
                        request.request_id,
                        ControlResponseResult::Instance(record),
                    )
                }
                Err(error) => ControlResponse::failure(request.request_id, error),
            }
        }
        ControlOperation::SaveState { destination } => match handler.save_state(&destination) {
            Ok(archive) => ControlResponse::success(
                request.request_id,
                ControlResponseResult::StateArchive(archive),
            ),
            Err(error) => ControlResponse::failure(request.request_id, error),
        },
        ControlOperation::Shutdown { force } => {
            let blockers = handler.active_work();
            if !force && !blockers.is_empty() {
                return ControlResponse::failure(
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
                );
            }
            stopping.store(true, Ordering::SeqCst);
            ControlResponse::success(
                request.request_id,
                ControlResponseResult::Stop(StopOutcome {
                    instance: current_record(descriptor, handler, stopping),
                    accepted: true,
                }),
            )
        }
    }
}

fn current_record(
    descriptor: &StoredDescriptor,
    handler: &dyn ControlHandler,
    stopping: &AtomicBool,
) -> InstanceRecord {
    let mut record = descriptor.instance.clone();
    record.active_work = handler.active_work();
    record.lifecycle = if stopping.load(Ordering::SeqCst) {
        InstanceLifecycle::Stopping
    } else {
        InstanceLifecycle::Ready
    };
    record
}

fn write_response(mut stream: Stream, response: &ControlResponse) -> std::io::Result<()> {
    serde_json::to_writer(&mut stream, response).map_err(std::io::Error::other)?;
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
        let record =
            request(descriptor, ControlOperation::Ping).and_then(expect_instance_result)?;
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
) -> Result<ControlResponseResult, ControlError> {
    let request_id = Uuid::new_v4();
    let frame = ControlRequest {
        frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
        control_protocol_version: descriptor.instance.build.control_protocol_version,
        request_id,
        auth_token: descriptor.auth_token.clone(),
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

    let mut response_frame = String::new();
    BufReader::new(stream)
        .read_line(&mut response_frame)
        .map_err(|error| {
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
    if response.frame_schema_version != CONTROL_FRAME_SCHEMA_VERSION
        || response.request_id != request_id
    {
        return Err(ControlError::new(
            "control.instance.handshake_failed",
            "The local control response did not match the request identity or schema",
        ));
    }
    match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => Err(ControlError::new(
            "control.instance.handshake_failed",
            "The local control response has an invalid result/error shape",
        )),
    }
}

fn expect_instance_result(result: ControlResponseResult) -> Result<InstanceRecord, ControlError> {
    match result {
        ControlResponseResult::Instance(record) => Ok(record),
        ControlResponseResult::StateArchive(_) | ControlResponseResult::Stop(_) => {
            Err(ControlError::new(
                "control.instance.handshake_failed",
                "The endpoint returned a stop result for an inspection request",
            ))
        }
    }
}

fn expect_stop_result(result: ControlResponseResult) -> Result<StopOutcome, ControlError> {
    match result {
        ControlResponseResult::Stop(outcome) => Ok(outcome),
        ControlResponseResult::Instance(_) | ControlResponseResult::StateArchive(_) => {
            Err(ControlError::new(
                "control.instance.handshake_failed",
                "The endpoint returned an inspection result for a stop request",
            ))
        }
    }
}

fn expect_state_archive_result(
    result: ControlResponseResult,
) -> Result<StateArchiveInspection, ControlError> {
    match result {
        ControlResponseResult::StateArchive(archive) => Ok(archive),
        ControlResponseResult::Instance(_) | ControlResponseResult::Stop(_) => {
            Err(ControlError::new(
                "control.instance.handshake_failed",
                "The endpoint returned a non-archive result for a state save request",
            ))
        }
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
    use std::sync::atomic::AtomicUsize;

    struct FakeHandler {
        active: AtomicUsize,
        shutdown: AtomicBool,
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
