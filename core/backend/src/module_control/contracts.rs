use std::collections::BTreeMap;

use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::codes::{
    INVALID_DESIRED_STATE, INVALID_DIAGNOSTIC, INVALID_IDENTITY, INVALID_JSON,
    SCHEMA_VERSION_UNSUPPORTED, SECRET_LEAKAGE, UNKNOWN_FIELD,
};

/// The first stable JSON schema for module control facts and requests.
pub const MODULE_CONTROL_SCHEMA_VERSION: u32 = 1;

/// A stable failure for contract parsing or semantic validation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleContractError {
    pub code: String,
    pub message: String,
}

impl ModuleContractError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ModuleContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ModuleContractError {}

/// A versioned JSON contract with semantic validation beyond serde's shape
/// checking. New fields require a schema-version decision because contracts
/// deny unknown fields.
pub trait ModuleContract: DeserializeOwned {
    fn schema_version(&self) -> u32;
    fn validate(&self) -> Result<(), ModuleContractError>;
}

/// Parse one canonical JSON contract with stable error codes.
pub fn parse_contract_json<T: ModuleContract>(source: &str) -> Result<T, ModuleContractError> {
    let value: Value = serde_json::from_str(source).map_err(|error| {
        ModuleContractError::new(INVALID_JSON, format!("Contract JSON is invalid: {error}"))
    })?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ModuleContractError::new(
                SCHEMA_VERSION_UNSUPPORTED,
                "Contract schemaVersion is required".to_string(),
            )
        })?;
    if schema_version != MODULE_CONTROL_SCHEMA_VERSION as u64 {
        return Err(ModuleContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Contract schemaVersion {schema_version} is unsupported; expected {MODULE_CONTROL_SCHEMA_VERSION}"
            ),
        ));
    }

    let contract: T = serde_json::from_value(value).map_err(|error| {
        let code = if error.to_string().contains("unknown field") {
            UNKNOWN_FIELD
        } else {
            INVALID_JSON
        };
        ModuleContractError::new(code, format!("Contract shape is invalid: {error}"))
    })?;
    if contract.schema_version() != MODULE_CONTROL_SCHEMA_VERSION {
        return Err(ModuleContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Contract schemaVersion {} is unsupported; expected {MODULE_CONTROL_SCHEMA_VERSION}",
                contract.schema_version()
            ),
        ));
    }
    contract.validate()?;
    Ok(contract)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleSource {
    Bundled,
    User,
    Development,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleRuntimeKind {
    /// Trusted frontend ESM mediated by the host; live-loadable once Phase 4 lands.
    FrontendEsm,
    /// Existing static composition inventory. It is restart-bound until migrated.
    StaticBuiltin,
    /// An adapter already compiled into this Shipctl host; activation is not a Rust build.
    PrecompiledHostAdapter,
    /// Reserved until Shipctl ships a supported isolated driver.
    Worker,
    /// Reserved until Shipctl ships a supported isolated driver.
    Wasm,
    /// New Rust/Tauri registration. Always restart-required.
    NativeRegistration,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleIdentity {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub content_digest: String,
    pub runtime_kind: ModuleRuntimeKind,
}

impl ModuleContract for ModuleIdentity {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_module_id(&self.id)
            || Version::parse(&self.version).is_err()
            || !valid_sha256(&self.content_digest)
        {
            return Err(ModuleContractError::new(
                INVALID_IDENTITY,
                "Module identity requires a dotted module id, semantic version, and SHA-256 content digest"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

/// Durable desired selection for one Shipctl state root.
///
/// It references an immutable precompiled artifact. Disabling retains a selected
/// artifact when one exists, so re-enabling is a data-only transition. `None`
/// means no artifact is selected; neither state means that Rust source or Cargo
/// features were removed. Process incarnation belongs to observations and
/// operations, not desired state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredModuleState {
    pub schema_version: u32,
    pub module_id: String,
    pub selected_artifact: Option<ModuleIdentity>,
    pub enabled: bool,
    pub configuration_revision: u64,
}

impl ModuleContract for DesiredModuleState {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_module_id(&self.module_id)
            || (self.enabled && self.selected_artifact.is_none())
            || self
                .selected_artifact
                .as_ref()
                .is_some_and(|artifact| artifact.id != self.module_id)
        {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Enabled desired state must select one matching immutable artifact".to_string(),
            ));
        }
        if let Some(artifact) = &self.selected_artifact {
            artifact.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleLifecycleState {
    Disabled,
    Preparing,
    Active,
    Draining,
    Failed,
    Unavailable,
    RestartRequired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedModuleState {
    pub schema_version: u32,
    pub module_id: String,
    pub instance_id: Uuid,
    pub artifact: Option<ModuleIdentity>,
    pub applied_registry_revision: u64,
    pub lifecycle: ModuleLifecycleState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_instance_id: Option<String>,
}

impl ModuleContract for ObservedModuleState {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_module_id(&self.module_id)
            || self
                .artifact
                .as_ref()
                .is_some_and(|artifact| artifact.id != self.module_id)
        {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Observed state must identify the selected module artifact".to_string(),
            ));
        }
        if let Some(artifact) = &self.artifact {
            artifact.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleOperationKind {
    Add,
    Enable,
    Update,
    Disable,
    Remove,
    Rollback,
    Reconfigure,
    Apply,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleOperationPhase {
    Received,
    Preflight,
    Committed,
    Reconciling,
    Published,
    Draining,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleOperationResult {
    Pending,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleTransition {
    pub phase: ModuleOperationPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleOperation {
    pub schema_version: u32,
    pub request_id: Uuid,
    pub module_id: String,
    pub instance_id: Uuid,
    pub kind: ModuleOperationKind,
    pub target_registry_revision: u64,
    pub transitions: Vec<ModuleTransition>,
    pub result: ModuleOperationResult,
}

impl ModuleContract for ModuleOperation {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_module_id(&self.module_id) || self.transitions.is_empty() {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Module operation requires a module id and at least one transition".to_string(),
            ));
        }
        for transition in &self.transitions {
            for diagnostic in &transition.diagnostics {
                diagnostic.validate()?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

/// Evidence safe to return to agents. Sensitive fields are either omitted or
/// represented as exactly `[redacted]`; raw credentials are rejected.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactedEvidence {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

impl RedactedEvidence {
    fn validate(&self) -> Result<(), ModuleContractError> {
        for (key, value) in &self.fields {
            let sensitive_key = [
                "secret",
                "token",
                "password",
                "credential",
                "authorization",
                "api_key",
            ]
            .iter()
            .any(|needle| key.to_ascii_lowercase().contains(needle));
            let secret_value = ["bearer ", "ghp_", "sk-", "xoxb-"]
                .iter()
                .any(|needle| value.to_ascii_lowercase().contains(needle));
            if (sensitive_key && value != "[redacted]") || secret_value {
                return Err(ModuleContractError::new(
                    SECRET_LEAKAGE,
                    format!(
                        "Diagnostic evidence field {key:?} contains unredacted secret material"
                    ),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostic {
    pub schema_version: u32,
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub check: String,
    pub summary: String,
    #[serde(default)]
    pub evidence: RedactedEvidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remedy: Option<String>,
}

impl ModuleContract for Diagnostic {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_diagnostic_code(&self.code)
            || self.check.trim().is_empty()
            || self.summary.trim().is_empty()
        {
            return Err(ModuleContractError::new(
                INVALID_DIAGNOSTIC,
                "Diagnostic code must have at least three lowercase dotted segments and check/summary must be present"
                    .to_string(),
            ));
        }
        self.evidence.validate()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceDrainState {
    Active,
    Draining,
    Released,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLease {
    pub schema_version: u32,
    pub owner_instance_id: String,
    pub owner_shipctl_instance_id: Uuid,
    pub resource_kind: String,
    pub resource_id: String,
    pub drain_state: ResourceDrainState,
}

impl ModuleContract for ResourceLease {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if self.owner_instance_id.trim().is_empty()
            || self.resource_kind.trim().is_empty()
            || self.resource_id.trim().is_empty()
        {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Resource leases require owner and resource identities".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleGrant {
    pub id: String,
    pub effective: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleContribution {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_instance_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleInspection {
    pub schema_version: u32,
    pub manifest: ModuleIdentity,
    pub desired: DesiredModuleState,
    #[serde(default)]
    pub observed: Vec<ObservedModuleState>,
    #[serde(default)]
    pub grants: Vec<ModuleGrant>,
    #[serde(default)]
    pub contributions: Vec<ModuleContribution>,
    #[serde(default)]
    pub leases: Vec<ResourceLease>,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
}

impl ModuleContract for ModuleInspection {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        self.manifest.validate()?;
        self.desired.validate()?;
        if self.manifest.id != self.desired.module_id {
            return Err(ModuleContractError::new(
                INVALID_IDENTITY,
                "Inspection manifest and desired state must name the same module".to_string(),
            ));
        }
        for state in &self.observed {
            state.validate()?;
            if state.module_id != self.manifest.id {
                return Err(ModuleContractError::new(
                    INVALID_IDENTITY,
                    "Inspection observed state must name the inspected module".to_string(),
                ));
            }
        }
        for lease in &self.leases {
            lease.validate()?;
        }
        for diagnostic in &self.diagnostics {
            diagnostic.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationExpectation {
    pub schema_version: u32,
    pub fixture_id: String,
    pub module_id: String,
    pub instance_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_artifact_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_configuration_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_applied_registry_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_lifecycle: Option<ModuleLifecycleState>,
    #[serde(default)]
    pub expected_diagnostic_codes: Vec<String>,
}

impl ModuleContract for VerificationExpectation {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        if self.fixture_id.trim().is_empty()
            || !valid_module_id(&self.module_id)
            || self
                .expected_artifact_digest
                .as_deref()
                .is_some_and(|digest| !valid_sha256(digest))
            || self
                .expected_diagnostic_codes
                .iter()
                .any(|code| !valid_diagnostic_code(code))
        {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Verification expectation contains invalid fixture, module, digest, or diagnostic code"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationObserved {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<ModuleInspection>,
    #[serde(default)]
    pub diagnostic_codes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationResult {
    pub schema_version: u32,
    pub fixture_id: String,
    pub expected: VerificationExpectation,
    pub observed: VerificationObserved,
    pub matched: bool,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
    /// Isolated test paths or safe logical locations only; never production secrets.
    #[serde(default)]
    pub resolved_paths: BTreeMap<String, String>,
    /// Exact evaluated artifact markers keyed by immutable content digest.
    #[serde(default)]
    pub artifact_markers: BTreeMap<String, String>,
}

impl ModuleContract for VerificationResult {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        self.expected.validate()?;
        if self.fixture_id != self.expected.fixture_id {
            return Err(ModuleContractError::new(
                INVALID_DESIRED_STATE,
                "Verification result and expectation must use the same fixture id".to_string(),
            ));
        }
        if let Some(inspection) = &self.observed.inspection {
            inspection.validate()?;
            if inspection.manifest.id != self.expected.module_id {
                return Err(ModuleContractError::new(
                    INVALID_DESIRED_STATE,
                    "Verification observation must match the requested module".to_string(),
                ));
            }
        }
        for code in &self.observed.diagnostic_codes {
            if !valid_diagnostic_code(code) {
                return Err(ModuleContractError::new(
                    INVALID_DIAGNOSTIC,
                    "Verification observation contains an invalid diagnostic code".to_string(),
                ));
            }
        }
        for diagnostic in &self.diagnostics {
            diagnostic.validate()?;
        }
        Ok(())
    }
}

fn validate_schema_version(schema_version: u32) -> Result<(), ModuleContractError> {
    if schema_version == MODULE_CONTROL_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(ModuleContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Contract schemaVersion {schema_version} is unsupported; expected {MODULE_CONTROL_SCHEMA_VERSION}"
            ),
        ))
    }
}

fn valid_module_id(value: &str) -> bool {
    let segments: Vec<_> = value.split('.').collect();
    segments.len() >= 2
        && segments.into_iter().all(|segment| {
            let mut characters = segment.chars();
            matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
                && characters.all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_diagnostic_code(value: &str) -> bool {
    let segments: Vec<_> = value.split('.').collect();
    segments.len() >= 3
        && segments.into_iter().all(|segment| {
            let mut characters = segment.chars();
            matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
                && characters.all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
                })
        })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../ops/module-control/fixtures/contracts")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn golden_inspection_round_trips_to_canonical_json() {
        let source = fixture("inspection.valid.json");
        let inspection: ModuleInspection = parse_contract_json(&source).unwrap();

        assert_eq!(
            serde_json::to_string_pretty(&inspection).unwrap() + "\n",
            source
        );
    }

    #[test]
    fn golden_verification_result_round_trips_to_canonical_json() {
        let source = fixture("verification-result.valid.json");
        let result: VerificationResult = parse_contract_json(&source).unwrap();

        assert_eq!(
            serde_json::to_string_pretty(&result).unwrap() + "\n",
            source
        );
    }

    #[test]
    fn golden_operation_round_trips_to_canonical_json() {
        let source = fixture("operation.valid.json");
        let operation: ModuleOperation = parse_contract_json(&source).unwrap();

        assert_eq!(
            serde_json::to_string_pretty(&operation).unwrap() + "\n",
            source
        );
    }

    #[test]
    fn disabled_state_retains_its_selected_artifact_without_a_build_field() {
        let source = fixture("desired.disabled-selected-artifact.valid.json");
        let desired: DesiredModuleState = parse_contract_json(&source).unwrap();

        assert!(!desired.enabled);
        assert!(desired.selected_artifact.is_some());
        assert!(!serde_json::to_string(&desired).unwrap().contains("build"));
        assert_eq!(
            serde_json::to_string_pretty(&desired).unwrap() + "\n",
            source
        );
    }

    #[test]
    fn failures_have_stable_codes() {
        assert_eq!(
            parse_contract_json::<ModuleInspection>(&fixture(
                "inspection.unsupported-version.json"
            ))
            .unwrap_err()
            .code,
            SCHEMA_VERSION_UNSUPPORTED
        );
        assert_eq!(
            parse_contract_json::<ModuleInspection>(&fixture("inspection.unknown-field.json"))
                .unwrap_err()
                .code,
            UNKNOWN_FIELD
        );
        assert_eq!(
            parse_contract_json::<Diagnostic>(&fixture("diagnostic.secret-leak.json"))
                .unwrap_err()
                .code,
            SECRET_LEAKAGE
        );
        assert_eq!(
            parse_contract_json::<Diagnostic>(&fixture("diagnostic.invalid-code.json"))
                .unwrap_err()
                .code,
            INVALID_DIAGNOSTIC
        );
    }

    #[test]
    fn desired_state_cannot_claim_enabled_without_an_artifact() {
        let desired = DesiredModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: "shipctl.fixture".to_string(),
            selected_artifact: None,
            enabled: true,
            configuration_revision: 4,
        };

        assert_eq!(desired.validate().unwrap_err().code, INVALID_DESIRED_STATE);
    }
}
