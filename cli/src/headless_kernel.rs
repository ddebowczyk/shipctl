//! Generic native resources exposed to the packaged headless TypeScript host.
//!
//! The kernel deliberately owns no module selection, enablement, verification,
//! or diagnostic policy. It is a private, versioned process boundary for the
//! resource implementations that cannot run in TypeScript.

use std::io::{self, Read};
use std::path::PathBuf;
use std::process::ExitCode;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use shipctl_core::instance::{
    resolve_state_root, resolve_state_root_read_only, ControlError, RootSource,
};
use shipctl_core::module_control::artifact::PLUGIN_API_VERSION;
use shipctl_core::module_control::codes::{MODULE_ABSENT, REGISTRY_REVISION_DISCONTINUOUS};
use shipctl_core::module_control::registry::{
    diagnose_registry, CapabilityCatalogSnapshot, ModuleRegistry, ReconciliationFailureRecord,
    RegisteredArtifact, RegistryMutation, RegistrySnapshot, RuntimeAcceptanceRecord,
    RuntimeArtifactCatalogEntry,
};
use shipctl_core::module_control::repository::{
    pack_artifact_directory, ArtifactRepository, OfflineArtifactAddReport,
    OfflineArtifactPackReport, OfflineArtifactPreflightReport, OfflineCapabilityInspection,
    OfflineDisabledModuleInspection,
};
use shipctl_core::module_control::{DesiredModuleState, ModuleOperation, ModuleOperationKind};
use shipctl_core::plugin_data::{
    PluginDataActor, PluginDataMigrationReceipt, PluginDataMigrationTransaction, PluginDataRecord,
    PluginDataScope, PluginDataService, PluginDataWrite,
};
use shipctl_core::state::{paths::ShipctlPaths, DurableWriteBarrier};
use uuid::Uuid;

pub const KERNEL_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KernelRequest {
    schema_version: u32,
    operation: String,
    input: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KernelResponse {
    schema_version: u32,
    operation: String,
    status: KernelStatus,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ControlError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum KernelStatus {
    Success,
    Failure,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateRootInput {
    #[serde(default)]
    state_root: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactInput {
    #[serde(default)]
    state_root: Option<PathBuf>,
    archive: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPackInput {
    source: PathBuf,
    destination: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleInput {
    #[serde(default)]
    state_root: Option<PathBuf>,
    module_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityInput {
    #[serde(default)]
    state_root: Option<PathBuf>,
    capability_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryTransitionInput {
    #[serde(default)]
    state_root: Option<PathBuf>,
    module_id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivatePluginDataRequest<Input> {
    activation: PluginDataActor,
    correlation_id: String,
    input: Input,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadPluginDataInput {
    scope: PluginDataScope,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginDataInput<Input> {
    #[serde(default)]
    state_root: Option<PathBuf>,
    request: PrivatePluginDataRequest<Input>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResult {
    state_root: PathBuf,
    state_root_source: RootSource,
    snapshot: DynamicRegistrySnapshot,
}

/// The public headless view deliberately excludes legacy build composition.
/// Every member here is durable dynamic-registry state or its accepted catalog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DynamicRegistrySnapshot {
    registry_path: PathBuf,
    registry_revision: u64,
    artifacts: Vec<RegisteredArtifact>,
    desired: Vec<DesiredModuleState>,
    operations: Vec<ModuleOperation>,
    observations: Vec<shipctl_core::module_control::ObservedModuleState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_acceptance: Option<RuntimeAcceptanceRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    reconciliation_failures: Vec<ReconciliationFailureRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_artifacts: Vec<RuntimeArtifactCatalogEntry>,
    #[serde(default, skip_serializing_if = "CapabilityCatalogSnapshot::is_empty")]
    capability_catalog: CapabilityCatalogSnapshot,
}

impl From<RegistrySnapshot> for DynamicRegistrySnapshot {
    fn from(snapshot: RegistrySnapshot) -> Self {
        Self {
            registry_path: snapshot.registry_path,
            registry_revision: snapshot.registry_revision,
            artifacts: snapshot.artifacts,
            desired: snapshot.desired,
            operations: snapshot.operations,
            observations: snapshot.observations,
            runtime_acceptance: snapshot.runtime_acceptance,
            reconciliation_failures: snapshot.reconciliation_failures,
            runtime_artifacts: snapshot.runtime_artifacts,
            capability_catalog: snapshot.capability_catalog,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticResult {
    state_root: PathBuf,
    state_root_source: RootSource,
    registry_path: PathBuf,
    diagnostics: Vec<shipctl_core::module_control::Diagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistryTransitionResult {
    state_root: PathBuf,
    state_root_source: RootSource,
    registry_revision: u64,
    changed: bool,
    desired: DesiredModuleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<ModuleOperation>,
}

pub fn run_stdio() -> ExitCode {
    let mut source = String::new();
    let response = match io::stdin().read_to_string(&mut source) {
        Ok(_) => match serde_json::from_str::<KernelRequest>(&source) {
            Ok(request) => dispatch(request),
            Err(error) => failure(
                "kernel.request",
                ControlError::new(
                    "headless.kernel.invalid_request",
                    format!("Headless kernel request is not valid JSON: {error}"),
                ),
            ),
        },
        Err(error) => failure(
            "kernel.request",
            ControlError::new(
                "headless.kernel.read_failed",
                format!("Could not read headless kernel request: {error}"),
            ),
        ),
    };
    match serde_json::to_string(&response) {
        Ok(output) => println!("{output}"),
        Err(error) => println!(
            "{{\"schemaVersion\":{KERNEL_PROTOCOL_VERSION},\"operation\":\"kernel.response\",\"status\":\"failure\",\"code\":\"headless.kernel.response_encode_failed\",\"error\":{{\"code\":\"headless.kernel.response_encode_failed\",\"message\":{}}}}}",
            serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"encoding failure\"".to_string()),
        ),
    }
    ExitCode::SUCCESS
}

/// Call one generic native resource in-process. This is used only for resource
/// operations that have no product semantics; capability execution crosses the
/// installed TypeScript runner instead.
pub fn invoke(operation: impl Into<String>, input: Value) -> Result<Value, ControlError> {
    let response = dispatch(KernelRequest {
        schema_version: KERNEL_PROTOCOL_VERSION,
        operation: operation.into(),
        input,
    });
    match response {
        KernelResponse {
            status: KernelStatus::Success,
            data: Some(data),
            ..
        } => Ok(data),
        KernelResponse {
            error: Some(error), ..
        } => Err(error),
        KernelResponse { code, .. } => Err(ControlError::new(
            "headless.kernel.invalid_response",
            format!("Headless kernel returned {code} without result data or an error"),
        )),
    }
}

fn dispatch(request: KernelRequest) -> KernelResponse {
    if request.schema_version != KERNEL_PROTOCOL_VERSION {
        return failure(
            request.operation,
            ControlError::new(
                "headless.kernel.protocol_mismatch",
                format!(
                    "Headless kernel protocol {} is unsupported; expected {}",
                    request.schema_version, KERNEL_PROTOCOL_VERSION,
                ),
            ),
        );
    }
    let operation = request.operation.clone();
    let result = match operation.as_str() {
        "registry.snapshot" => parse_then(request.input, snapshot),
        "registry.diagnose" => parse_then(request.input, diagnose),
        "registry.set-enabled" => parse_then(request.input, set_enabled),
        "artifact.pack" => parse_then(request.input, pack),
        "artifact.preflight" => parse_then(request.input, preflight),
        "artifact.add" => parse_then(request.input, add),
        "artifact.inspect" => parse_then(request.input, inspect),
        "artifact.inspect-capability" => parse_then(request.input, inspect_capability),
        "plugin-data.read" => parse_then(request.input, plugin_data_read),
        "plugin-data.write" => parse_then(request.input, plugin_data_write),
        "plugin-data.migrate" => parse_then(request.input, plugin_data_migrate),
        _ => Err(ControlError::new(
            "headless.kernel.operation_unavailable",
            format!("Headless kernel operation {operation} is unavailable"),
        )),
    };
    match result {
        Ok(data) => success(operation, data),
        Err(error) => failure(operation, error),
    }
}

fn parse_then<Input, Output>(
    value: Value,
    handle: impl FnOnce(Input) -> Result<Output, ControlError>,
) -> Result<Value, ControlError>
where
    Input: DeserializeOwned,
    Output: Serialize,
{
    let input = serde_json::from_value(value).map_err(|error| {
        ControlError::new(
            "headless.kernel.invalid_request",
            format!("Headless kernel request shape is invalid: {error}"),
        )
    })?;
    let output = handle(input)?;
    serde_json::to_value(output).map_err(|error| {
        ControlError::new(
            "headless.kernel.response_encode_failed",
            format!("Could not encode headless kernel response: {error}"),
        )
    })
}

fn snapshot(input: StateRootInput) -> Result<SnapshotResult, ControlError> {
    let (state_root, state_root_source) = read_only_root(input.state_root.as_deref())?;
    let paths = ShipctlPaths::new(state_root.clone(), PathBuf::new());
    let registry = ModuleRegistry::open_read_only(&paths).map_err(registry_error)?;
    let snapshot = registry.snapshot().map_err(registry_error)?;
    Ok(SnapshotResult {
        state_root,
        state_root_source,
        snapshot: snapshot.into(),
    })
}

fn diagnose(input: StateRootInput) -> Result<DiagnosticResult, ControlError> {
    let (state_root, state_root_source) = read_only_root(input.state_root.as_deref())?;
    let paths = ShipctlPaths::new(state_root.clone(), PathBuf::new());
    Ok(DiagnosticResult {
        state_root,
        state_root_source,
        registry_path: paths.module_registry_database.clone(),
        diagnostics: diagnose_registry(&paths.module_registry_database),
    })
}

fn set_enabled(input: RegistryTransitionInput) -> Result<RegistryTransitionResult, ControlError> {
    let (state_root, state_root_source) = writable_root(input.state_root.as_deref())?;
    let paths = ShipctlPaths::new(state_root.clone(), PathBuf::new());
    let mut registry = ModuleRegistry::open_writable(&paths).map_err(registry_error)?;
    let snapshot = registry.snapshot().map_err(registry_error)?;
    let current = snapshot
        .desired
        .iter()
        .find(|desired| desired.module_id == input.module_id)
        .cloned()
        .ok_or_else(|| {
            ControlError::new(
                MODULE_ABSENT,
                format!("Module {} has no dynamic desired state", input.module_id),
            )
            .with_selector(&input.module_id)
        })?;
    if current.selected_artifact.is_none() {
        return Err(ControlError::new(
            MODULE_ABSENT,
            format!(
                "Module {} has no selected dynamic artifact",
                input.module_id
            ),
        )
        .with_selector(&input.module_id));
    }
    if current.enabled == input.enabled {
        return Ok(RegistryTransitionResult {
            state_root,
            state_root_source,
            registry_revision: snapshot.registry_revision,
            changed: false,
            desired: current,
            operation: None,
        });
    }
    let configuration_revision =
        current
            .configuration_revision
            .checked_add(1)
            .ok_or_else(|| {
                ControlError::new(
                    REGISTRY_REVISION_DISCONTINUOUS,
                    "Desired configuration revision cannot advance beyond u64::MAX",
                )
            })?;
    let desired = DesiredModuleState {
        enabled: input.enabled,
        configuration_revision,
        ..current
    };
    let operation = registry
        .commit(&RegistryMutation {
            request_id: Uuid::new_v4(),
            module_id: input.module_id,
            instance_id: Uuid::nil(),
            kind: if desired.enabled {
                ModuleOperationKind::Enable
            } else {
                ModuleOperationKind::Disable
            },
            artifacts: Vec::new(),
            desired: Some(desired.clone()),
            observations: Vec::new(),
        })
        .map_err(registry_error)?;
    Ok(RegistryTransitionResult {
        state_root,
        state_root_source,
        registry_revision: operation.target_registry_revision,
        changed: true,
        desired,
        operation: Some(operation),
    })
}

fn pack(input: ArtifactPackInput) -> Result<OfflineArtifactPackReport, ControlError> {
    pack_artifact_directory(&input.source, &input.destination)
        .map_err(|error| error.into_control_error())
}

fn preflight(input: ArtifactInput) -> Result<OfflineArtifactPreflightReport, ControlError> {
    let state_root = read_only_root(input.state_root.as_deref())?.0;
    artifact_repository(state_root)
        .preflight_report(&input.archive)
        .map_err(|error| error.into_control_error())
}

fn add(input: ArtifactInput) -> Result<OfflineArtifactAddReport, ControlError> {
    let state_root = writable_root(input.state_root.as_deref())?.0;
    artifact_repository(state_root)
        .add_archive(&input.archive)
        .map_err(|error| error.into_control_error())
}

fn inspect(input: ModuleInput) -> Result<OfflineDisabledModuleInspection, ControlError> {
    let state_root = read_only_root(input.state_root.as_deref())?.0;
    artifact_repository(state_root)
        .inspect_disabled_module(&input.module_id)
        .map_err(|error| error.into_control_error())
}

fn inspect_capability(input: CapabilityInput) -> Result<OfflineCapabilityInspection, ControlError> {
    let state_root = read_only_root(input.state_root.as_deref())?.0;
    artifact_repository(state_root)
        .inspect_capability(&input.capability_id)
        .map_err(|error| error.into_control_error())
}

fn plugin_data_read(
    input: PluginDataInput<ReadPluginDataInput>,
) -> Result<Option<PluginDataRecord>, ControlError> {
    validate_correlation_id(&input.request.correlation_id)?;
    let state_root = read_only_root(input.state_root.as_deref())?.0;
    plugin_data_service(state_root)
        .read_record(
            &input.request.activation,
            &input.request.input.scope,
            &input.request.input.key,
        )
        .map_err(plugin_data_error)
}

fn plugin_data_write(
    input: PluginDataInput<PluginDataWrite>,
) -> Result<PluginDataRecord, ControlError> {
    validate_correlation_id(&input.request.correlation_id)?;
    let state_root = writable_root(input.state_root.as_deref())?.0;
    plugin_data_service(state_root)
        .write_record(&input.request.activation, input.request.input)
        .map_err(plugin_data_error)
}

fn plugin_data_migrate(
    input: PluginDataInput<PluginDataMigrationTransaction>,
) -> Result<PluginDataMigrationReceipt, ControlError> {
    validate_correlation_id(&input.request.correlation_id)?;
    let state_root = writable_root(input.state_root.as_deref())?.0;
    plugin_data_service(state_root)
        .migrate_records(&input.request.activation, input.request.input)
        .map_err(plugin_data_error)
}

fn artifact_repository(state_root: PathBuf) -> ArtifactRepository {
    ArtifactRepository::for_offline(
        ShipctlPaths::new(state_root, PathBuf::new()),
        PLUGIN_API_VERSION,
    )
}

fn plugin_data_service(state_root: PathBuf) -> PluginDataService {
    let paths = ShipctlPaths::new(state_root, PathBuf::new());
    PluginDataService::new_with_barrier(paths.plugin_data, DurableWriteBarrier::default())
}

fn read_only_root(
    explicit: Option<&std::path::Path>,
) -> Result<(PathBuf, RootSource), ControlError> {
    resolve_state_root_read_only(explicit)
        .map_err(|error| ControlError::new("module.registry.state_root_invalid", error))
}

fn writable_root(
    explicit: Option<&std::path::Path>,
) -> Result<(PathBuf, RootSource), ControlError> {
    resolve_state_root(explicit)
        .map_err(|error| ControlError::new("module.registry.state_root_invalid", error))
}

fn registry_error(error: shipctl_core::module_control::registry::RegistryError) -> ControlError {
    ControlError::new(error.code, error.message)
}

fn plugin_data_error(error: String) -> ControlError {
    let (code, message) = error
        .split_once(": ")
        .unwrap_or(("plugin-data.storage-failed", error.as_str()));
    ControlError::new(code, message)
}

fn validate_correlation_id(value: &str) -> Result<(), ControlError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err(ControlError::new(
            "plugin-data.invalid-request",
            "Correlation ID is invalid",
        ))
    } else {
        Ok(())
    }
}

fn success(operation: String, data: Value) -> KernelResponse {
    KernelResponse {
        schema_version: KERNEL_PROTOCOL_VERSION,
        operation,
        status: KernelStatus::Success,
        code: "headless.kernel.completed".to_string(),
        data: Some(data),
        error: None,
    }
}

fn failure(operation: impl Into<String>, error: ControlError) -> KernelResponse {
    KernelResponse {
        schema_version: KERNEL_PROTOCOL_VERSION,
        operation: operation.into(),
        status: KernelStatus::Failure,
        code: error.code.to_string(),
        data: None,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_operation_is_a_structured_failure() {
        let response = dispatch(KernelRequest {
            schema_version: KERNEL_PROTOCOL_VERSION,
            operation: "unknown.operation".to_string(),
            input: Value::Null,
        });
        assert!(matches!(response.status, KernelStatus::Failure));
        assert_eq!(response.code, "headless.kernel.operation_unavailable");
    }
}
