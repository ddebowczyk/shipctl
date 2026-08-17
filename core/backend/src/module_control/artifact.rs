//! Immutable, disabled runtime-artifact contracts.
//!
//! This module deliberately stops at admission: it reads a portable archive
//! payload, validates its declared contracts, and produces a deterministic
//! identity.  It never imports JavaScript, starts a provider, opens a route,
//! or makes a capability callable.  Phase 4 owns those live concerns.

use std::collections::{BTreeMap, BTreeSet};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::message_bus::{MessageDeclarations, MessageTypeContract, MessageTypeId};

use super::{ModuleIdentity, ModuleRuntimeKind, MODULE_CONTROL_SCHEMA_VERSION};

/// The manifest and index names in a portable runtime-artifact archive.
pub const ARTIFACT_MANIFEST_PATH: &str = "module.yaml";
pub const ARTIFACT_INTEGRITY_PATH: &str = "integrity.json";
pub const ARTIFACT_CONTRACT_SCHEMA_VERSION: u32 = 2;
pub const ARTIFACT_MINIMUM_SCHEMA_VERSION: u32 = 1;
pub const APPLICATION_DECLARATION_SCHEMA_VERSION: u32 = 1;
pub const PLUGIN_API_VERSION: &str = "1.0.0";
pub const CAPABILITY_CONTRACT_SCHEMA_VERSION: u32 = 1;

pub const ARTIFACT_ARCHIVE_INVALID: &str = "module.artifact.archive.invalid";
pub const ARTIFACT_ARCHIVE_PATH_INVALID: &str = "module.artifact.path.invalid";
pub const ARTIFACT_MANIFEST_INVALID: &str = "module.artifact.manifest.invalid";
pub const ARTIFACT_INTEGRITY_INVALID: &str = "module.artifact.integrity.invalid";
pub const ARTIFACT_CONTENT_DIGEST_INVALID: &str = "module.artifact.content_digest.invalid";
pub const CAPABILITY_CONTRACT_INVALID: &str = "module.artifact.capability.invalid";
pub const CAPABILITY_CONTRACT_CONFLICT: &str = "module.artifact.capability.conflict";
pub const ARTIFACT_API_INCOMPATIBLE: &str = "module.artifact.api.incompatible";
pub const ARTIFACT_PEER_INCOMPATIBLE: &str = "module.artifact.peer.incompatible";
pub const ARTIFACT_SERVICE_INCOMPATIBLE: &str = "module.artifact.service.incompatible";
pub const ARTIFACT_CONTRIBUTION_INCOMPATIBLE: &str = "module.artifact.contribution.incompatible";
pub const ARTIFACT_GRANT_DENIED: &str = "module.artifact.grant.denied";
pub const ARTIFACT_NATIVE_ADAPTER_UNAVAILABLE: &str = "module.artifact.native_adapter.unavailable";

/// A stable, payload-free failure from archive admission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactContractError {
    pub code: String,
    pub message: String,
}

impl ArtifactContractError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ArtifactContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ArtifactContractError {}

/// A content-pinned reference to one semantic capability definition.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityReference {
    pub id: String,
    pub version: String,
    pub definition_digest_sha256: String,
}

impl CapabilityReference {
    pub fn validate(&self) -> Result<(), ArtifactContractError> {
        if !valid_scoped_id(&self.id)
            || Version::parse(&self.version).is_err()
            || !valid_sha256(&self.definition_digest_sha256)
        {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability references require a dotted id, semantic version, and SHA-256 definition digest",
            ));
        }
        Ok(())
    }
}

/// Where a capability is meaningful.  This is descriptive metadata until a
/// later phase authorizes live selection.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityScope {
    Instance,
    Workspace,
    Global,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityProviderCardinality {
    Exclusive,
    Multiple,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityProviderSelection {
    Priority,
    All,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityPortKind {
    Command,
    Query,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityPortDefinition {
    pub id: String,
    pub kind: CapabilityPortKind,
    pub request: MessageTypeId,
    pub response: MessageTypeId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityEventDefinition {
    pub id: String,
    pub message: MessageTypeId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityTopicDefinition {
    pub id: String,
    pub event_id: String,
    pub message: MessageTypeId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityStreamDefinition {
    pub id: String,
    pub message: MessageTypeId,
    pub ordered: bool,
}

/// The only surfaces an external agent may later be granted.  This remains
/// declarative in Phase 3; it is not an authorization decision.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityAgentWatchAccess {
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityAgentAccess {
    pub inspect: bool,
    #[serde(default)]
    pub invoke: Vec<String>,
    pub watch: CapabilityAgentWatchAccess,
    #[serde(default)]
    pub attach: Vec<String>,
}

/// A semantic API which may be defined by an artifact itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDefinition {
    pub id: String,
    pub version: String,
    pub definition_digest_sha256: String,
    #[serde(default)]
    pub schemas: Vec<MessageTypeContract>,
    #[serde(default)]
    pub ports: Vec<CapabilityPortDefinition>,
    #[serde(default)]
    pub events: Vec<CapabilityEventDefinition>,
    #[serde(default)]
    pub topics: Vec<CapabilityTopicDefinition>,
    #[serde(default)]
    pub streams: Vec<CapabilityStreamDefinition>,
    pub provider_cardinality: CapabilityProviderCardinality,
    pub selection: CapabilityProviderSelection,
    #[serde(default)]
    pub scopes: Vec<CapabilityScope>,
    pub agent_access: CapabilityAgentAccess,
}

impl CapabilityDefinition {
    pub fn reference(&self) -> CapabilityReference {
        CapabilityReference {
            id: self.id.clone(),
            version: self.version.clone(),
            definition_digest_sha256: self.definition_digest_sha256.clone(),
        }
    }

    /// Calculate the digest over the semantic definition, excluding its
    /// self-referential digest field.  It is public so artifact builders can
    /// produce a deterministic archive without duplicating host logic.
    pub fn calculated_digest_sha256(&self) -> Result<String, ArtifactContractError> {
        let mut canonical = self.clone();
        canonical.definition_digest_sha256.clear();
        canonical_json_digest(&canonical)
    }

    pub fn validate(&self) -> Result<(), ArtifactContractError> {
        CapabilityReference {
            id: self.id.clone(),
            version: self.version.clone(),
            definition_digest_sha256: self.definition_digest_sha256.clone(),
        }
        .validate()?;

        if self.calculated_digest_sha256()? != self.definition_digest_sha256 {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                format!(
                    "Capability {}@{} does not match its declared definition digest",
                    self.id, self.version
                ),
            ));
        }

        let mut schema_ids = BTreeSet::new();
        for schema in &self.schemas {
            schema.compile().map_err(|error| {
                ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    format!("Capability schema is invalid: {}", error.code),
                )
            })?;
            if !schema_ids.insert(schema.message.clone()) {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability schema message identifiers must be unique",
                ));
            }
        }

        let port_ids = validate_named_ids(self.ports.iter().map(|surface| surface.id.as_str()))?;
        let event_ids = validate_named_ids(self.events.iter().map(|surface| surface.id.as_str()))?;
        let topic_ids = validate_named_ids(self.topics.iter().map(|surface| surface.id.as_str()))?;
        let stream_ids =
            validate_named_ids(self.streams.iter().map(|surface| surface.id.as_str()))?;
        if port_ids.is_empty()
            && event_ids.is_empty()
            && topic_ids.is_empty()
            && stream_ids.is_empty()
        {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability definitions must declare at least one surface",
            ));
        }

        for port in &self.ports {
            validate_message_reference(&port.request, &schema_ids)?;
            validate_message_reference(&port.response, &schema_ids)?;
        }
        for event in &self.events {
            validate_message_reference(&event.message, &schema_ids)?;
        }
        for topic in &self.topics {
            validate_message_reference(&topic.message, &schema_ids)?;
            let event = self
                .events
                .iter()
                .find(|event| event.id == topic.event_id)
                .ok_or_else(|| {
                    ArtifactContractError::new(
                        CAPABILITY_CONTRACT_INVALID,
                        "Capability topics must reference a declared event",
                    )
                })?;
            if event.message != topic.message {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability topic and referenced event must share a message contract",
                ));
            }
        }
        for stream in &self.streams {
            validate_message_reference(&stream.message, &schema_ids)?;
        }

        let scopes = unique_scopes(&self.scopes)?;
        if scopes.is_empty() {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability definitions must declare at least one scope",
            ));
        }
        if self.provider_cardinality == CapabilityProviderCardinality::Exclusive
            && self.selection != CapabilityProviderSelection::Priority
        {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Exclusive capabilities require priority provider selection",
            ));
        }
        validate_agent_access(
            &self.agent_access,
            &port_ids,
            &event_ids,
            &topic_ids,
            &stream_ids,
        )?;
        Ok(())
    }
}

/// Named capability surfaces implemented or required by a module binding.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitySurfaceBinding {
    #[serde(default)]
    pub ports: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub streams: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityProviderBinding {
    pub capability: CapabilityReference,
    pub surfaces: CapabilitySurfaceBinding,
    #[serde(default)]
    pub scopes: Vec<CapabilityScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityConsumerBinding {
    pub capability: CapabilityReference,
    pub surfaces: CapabilitySurfaceBinding,
    #[serde(default)]
    pub scopes: Vec<CapabilityScope>,
}

/// The artifact-local capability catalog.  The three collections map directly
/// to defines, implements, and requires in the Phase 3 plan.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub definitions: Vec<CapabilityDefinition>,
    #[serde(default)]
    pub providers: Vec<CapabilityProviderBinding>,
    #[serde(default)]
    pub consumers: Vec<CapabilityConsumerBinding>,
}

impl CapabilityManifest {
    pub fn validate(&self, known: &CapabilityDefinitionIndex) -> Result<(), ArtifactContractError> {
        let local = self.validate_local()?;
        let combined = known.with_definitions(&local.definitions)?;
        validate_provider_bindings(&self.providers, &combined)?;
        validate_consumer_bindings(&self.consumers, &combined)?;
        Ok(())
    }

    /// Validate archive-local facts only. A stored artifact may bind to a
    /// definition supplied by another artifact, so those links are resolved
    /// only by preflight against the immutable definition catalog.
    fn validate_local(&self) -> Result<CapabilityDefinitionIndex, ArtifactContractError> {
        if self.schema_version != CAPABILITY_CONTRACT_SCHEMA_VERSION {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                format!(
                    "Capability schema version {} is unsupported",
                    self.schema_version
                ),
            ));
        }
        let local = CapabilityDefinitionIndex::from_definitions(&self.definitions)?;
        for binding in &self.providers {
            binding.capability.validate()?;
            validate_binding_surface_names(&binding.surfaces)?;
            if unique_scopes(&binding.scopes)?.is_empty() {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability provider bindings must declare at least one scope",
                ));
            }
        }
        for binding in &self.consumers {
            binding.capability.validate()?;
            validate_binding_surface_names(&binding.surfaces)?;
            if unique_scopes(&binding.scopes)?.is_empty() {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability consumer bindings must declare at least one scope",
                ));
            }
        }
        Ok(local)
    }
}

/// A strict, deterministic lookup of definitions supplied by the host or
/// installed artifacts.  It contains metadata only, never active providers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CapabilityDefinitionIndex {
    definitions: BTreeMap<(String, String), CapabilityDefinition>,
}

impl CapabilityDefinitionIndex {
    pub fn from_definitions(
        definitions: &[CapabilityDefinition],
    ) -> Result<Self, ArtifactContractError> {
        let mut index = Self::default();
        for definition in definitions {
            definition.validate()?;
            let key = (definition.id.clone(), definition.version.clone());
            if index.definitions.contains_key(&key) {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    format!(
                        "Capability {}@{} is declared more than once",
                        definition.id, definition.version
                    ),
                ));
            }
            index.definitions.insert(key, definition.clone());
        }
        Ok(index)
    }

    pub fn get(&self, reference: &CapabilityReference) -> Option<&CapabilityDefinition> {
        self.definitions
            .get(&(reference.id.clone(), reference.version.clone()))
    }

    pub fn definitions(&self) -> impl Iterator<Item = &CapabilityDefinition> {
        self.definitions.values()
    }

    fn with_definitions(
        &self,
        definitions: &BTreeMap<(String, String), CapabilityDefinition>,
    ) -> Result<Self, ArtifactContractError> {
        let mut merged = self.clone();
        for (key, definition) in definitions {
            if let Some(existing) = merged.definitions.get(key) {
                if existing != definition {
                    return Err(ArtifactContractError::new(
                        CAPABILITY_CONTRACT_CONFLICT,
                        format!(
                            "Capability {}@{} conflicts with an existing definition",
                            definition.id, definition.version
                        ),
                    ));
                }
                continue;
            }
            merged.definitions.insert(key.clone(), definition.clone());
        }
        Ok(merged)
    }
}

/// A stable UI contribution declaration.  It is metadata only until the
/// active catalog/supervisor phase decides whether to mount it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeUiContribution {
    pub id: String,
    pub slot: String,
    pub entry: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePluginRole {
    #[default]
    Headless,
    Presentation,
    Compound,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeServiceDeclaration {
    pub id: String,
    pub version: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeContributionFamily {
    Command,
    GlobalNavigation,
    GlobalSurface,
    MessageGraph,
    Panel,
    ProjectAction,
    ProjectFacts,
    ProjectImport,
    ProjectLayout,
    ProjectNavigation,
    ScheduledTask,
    Settings,
    Sidebar,
    SkillsProvider,
    TerminalPresentation,
}

impl RuntimeContributionFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::GlobalNavigation => "global-navigation",
            Self::GlobalSurface => "global-surface",
            Self::MessageGraph => "message-graph",
            Self::Panel => "panel",
            Self::ProjectAction => "project-action",
            Self::ProjectFacts => "project-facts",
            Self::ProjectImport => "project-import",
            Self::ProjectLayout => "project-layout",
            Self::ProjectNavigation => "project-navigation",
            Self::ScheduledTask => "scheduled-task",
            Self::Settings => "settings",
            Self::Sidebar => "sidebar",
            Self::SkillsProvider => "skills-provider",
            Self::TerminalPresentation => "terminal-presentation",
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeContributionDeclaration {
    pub family: RuntimeContributionFamily,
    pub id: String,
    pub schema_version: u32,
}

/// Static application declarations which can be compared with a provisionally
/// loaded TypeScript plugin before any service or contribution is published.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeApplicationManifest {
    pub schema_version: u32,
    pub role: RuntimePluginRole,
    #[serde(default)]
    pub required_services: Vec<RuntimeServiceDeclaration>,
    #[serde(default)]
    pub provided_services: Vec<RuntimeServiceDeclaration>,
    #[serde(default)]
    pub background_effects: Vec<String>,
    #[serde(default)]
    pub contributions: Vec<RuntimeContributionDeclaration>,
}

impl RuntimeApplicationManifest {
    fn is_legacy_empty(&self) -> bool {
        self == &Self::default()
    }

    fn validate(&self) -> Result<(), ArtifactContractError> {
        if self.schema_version != APPLICATION_DECLARATION_SCHEMA_VERSION {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Application declarations use an unsupported schema version",
            ));
        }
        validate_service_declarations(&self.required_services, "Required services")?;
        validate_service_declarations(&self.provided_services, "Provided services")?;
        validate_unique_scoped_strings(&self.background_effects, "Background effects")?;

        let mut contributions = BTreeSet::new();
        for contribution in &self.contributions {
            if contribution.schema_version == 0
                || !valid_contribution_id(contribution.family, &contribution.id)
                || !contributions.insert((contribution.family, contribution.id.as_str()))
            {
                return Err(ArtifactContractError::new(
                    ARTIFACT_MANIFEST_INVALID,
                    "Application contributions require unique family-appropriate IDs and nonzero schema versions",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactLifecycleRequirement {
    Live,
    DrainRequired,
    RestartRequired,
    Unsupported,
}

/// Runtime artifact manifest.  `sourceProvenance` is accepted only so source
/// builders can describe origin, but it is never serialized through a public
/// projection and is excluded from canonical identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArtifactManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_range: String,
    pub runtime_kind: ModuleRuntimeKind,
    pub entry: String,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub assets: Vec<String>,
    pub messages: MessageDeclarations,
    pub capabilities: CapabilityManifest,
    #[serde(
        default,
        skip_serializing_if = "RuntimeApplicationManifest::is_legacy_empty"
    )]
    pub application: RuntimeApplicationManifest,
    #[serde(default)]
    pub ui_contributions: Vec<RuntimeUiContribution>,
    #[serde(default)]
    pub requested_grants: Vec<String>,
    #[serde(default)]
    pub native_adapters: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_schema: Option<Value>,
    #[serde(default)]
    pub secret_references: Vec<String>,
    #[serde(default)]
    pub peer_dependencies: BTreeMap<String, String>,
    #[serde(default)]
    pub supported_scopes: Vec<CapabilityScope>,
    pub lifecycle: ArtifactLifecycleRequirement,
    #[serde(
        default,
        rename = "sourceProvenance",
        skip_serializing_if = "Option::is_none"
    )]
    source_provenance: Option<Value>,
}

impl RuntimeArtifactManifest {
    pub fn validate(&self) -> Result<(), ArtifactContractError> {
        self.validate_shape()?;
        self.messages.clone().prepare().map_err(|error| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("Artifact message declarations are invalid: {}", error.code),
            )
        })?;
        let local_definitions = self.capabilities.validate_local()?;
        validate_capability_message_bindings(
            &self.messages,
            &self.capabilities.providers,
            &local_definitions,
        )?;
        Ok(())
    }

    fn validate_shape(&self) -> Result<(), ArtifactContractError> {
        if !(ARTIFACT_MINIMUM_SCHEMA_VERSION..=ARTIFACT_CONTRACT_SCHEMA_VERSION)
            .contains(&self.schema_version)
            || !valid_scoped_id(&self.id)
            || self.name.trim().is_empty()
            || Version::parse(&self.version).is_err()
            || VersionReq::parse(&self.api_range).is_err()
            || self.runtime_kind != ModuleRuntimeKind::FrontendEsm
            || !valid_archive_path(&self.entry)
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Runtime manifest requires schema version, id, name, semantic version, API range, frontend ESM runtime kind, and a normalized entry path",
            ));
        }
        if self.schema_version >= 2 {
            self.application.validate()?;
            if !self.ui_contributions.is_empty() {
                return Err(ArtifactContractError::new(
                    ARTIFACT_MANIFEST_INVALID,
                    "Schema version 2 declares contributions only through application.contributions",
                ));
            }
        } else if !self.application.is_legacy_empty() {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Schema version 1 cannot declare version 2 application metadata",
            ));
        }
        validate_unique_paths(&self.styles)?;
        validate_unique_paths(&self.assets)?;
        validate_unique_strings(&self.requested_grants, "Requested grants")?;
        validate_unique_strings(&self.native_adapters, "Native adapters")?;
        validate_unique_strings(&self.secret_references, "Secret references")?;
        validate_unique_scopes(&self.supported_scopes, "Supported scopes")?;
        if self
            .configuration_schema
            .as_ref()
            .is_some_and(|schema| !schema.is_object())
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Configuration schema must be a JSON object when declared",
            ));
        }

        let mut contribution_ids = BTreeSet::new();
        for contribution in &self.ui_contributions {
            if !valid_scoped_id(&contribution.id)
                || contribution.slot.trim().is_empty()
                || !valid_archive_path(&contribution.entry)
                || !contribution_ids.insert(contribution.id.as_str())
            {
                return Err(ArtifactContractError::new(
                    ARTIFACT_MANIFEST_INVALID,
                    "UI contributions require unique stable ids, a slot, and a normalized entry path",
                ));
            }
        }
        for (peer, range) in &self.peer_dependencies {
            if peer.trim().is_empty() || VersionReq::parse(range).is_err() {
                return Err(ArtifactContractError::new(
                    ARTIFACT_MANIFEST_INVALID,
                    "Peer dependencies require nonempty names and semantic version ranges",
                ));
            }
        }
        Ok(())
    }

    fn canonicalized(&self) -> Self {
        let mut canonical = self.clone();
        canonical.source_provenance = None;
        canonical
    }
}

/// One raw file digest in `integrity.json`.  It covers archive bytes for
/// tamper detection; semantic content identity is calculated separately so
/// source provenance cannot affect module identity.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactIntegrityFile {
    pub path: String,
    pub digest_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactIntegrityIndex {
    pub schema_version: u32,
    pub files: Vec<ArtifactIntegrityFile>,
    pub content_digest_sha256: String,
}

/// The provenance-free metadata persisted in the catalog and returned by the
/// offline CLI.  It is exactly what participates in immutable identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalArtifactMetadata {
    pub manifest: RuntimeArtifactManifest,
    pub content_digest_sha256: String,
}

/// A fully validated archive, still disabled and non-callable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidatedRuntimeArtifact {
    pub manifest: RuntimeArtifactManifest,
    pub integrity: ArtifactIntegrityIndex,
    pub content_digest: String,
}

impl ValidatedRuntimeArtifact {
    pub fn identity(&self) -> ModuleIdentity {
        ModuleIdentity {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            id: self.manifest.id.clone(),
            version: self.manifest.version.clone(),
            content_digest: self.content_digest.clone(),
            runtime_kind: self.manifest.runtime_kind,
        }
    }

    pub fn canonical_metadata(&self) -> CanonicalArtifactMetadata {
        CanonicalArtifactMetadata {
            manifest: self.manifest.canonicalized(),
            content_digest_sha256: self.content_digest.clone(),
        }
    }
}

/// A portable archive represented as normalized relative paths and bytes.
/// Tar decoding lives in the repository; this type is deliberately agnostic
/// to the container format so tests and future builders use the same contract.
#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeArtifactArchive {
    files: BTreeMap<String, Vec<u8>>,
}

impl RuntimeArtifactArchive {
    pub fn new(files: BTreeMap<String, Vec<u8>>) -> Result<Self, ArtifactContractError> {
        if files.is_empty()
            || !files.contains_key(ARTIFACT_MANIFEST_PATH)
            || !files.contains_key(ARTIFACT_INTEGRITY_PATH)
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_ARCHIVE_INVALID,
                "Runtime artifact archives require module.yaml and integrity.json",
            ));
        }
        if files.keys().any(|path| !valid_archive_path(path)) {
            return Err(ArtifactContractError::new(
                ARTIFACT_ARCHIVE_PATH_INVALID,
                "Runtime artifact archive paths must be normalized relative files",
            ));
        }
        Ok(Self { files })
    }

    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }

    /// Validate raw integrity, manifest shape, message contracts, and local
    /// capabilities. It does not consult an installed catalog.
    pub fn inspect(&self) -> Result<ValidatedRuntimeArtifact, ArtifactContractError> {
        let manifest = self.parse_manifest()?;
        let integrity = self.parse_integrity()?;
        validate_integrity_index(&integrity, &self.files)?;
        validate_manifest_files(&manifest, &self.files)?;
        manifest.validate()?;

        let content_digest = canonical_content_digest(&manifest, &integrity.files)?;
        if integrity.content_digest_sha256 != content_digest {
            return Err(ArtifactContractError::new(
                ARTIFACT_CONTENT_DIGEST_INVALID,
                "Integrity index content digest does not match canonical runtime artifact content",
            ));
        }
        Ok(ValidatedRuntimeArtifact {
            manifest,
            integrity,
            content_digest,
        })
    }

    /// Validate an archive against the immutable definition catalog currently
    /// visible to admission.  This is still a read-only operation.
    pub fn preflight(
        &self,
        known_definitions: &CapabilityDefinitionIndex,
    ) -> Result<ValidatedRuntimeArtifact, ArtifactContractError> {
        let artifact = self.inspect()?;
        artifact.manifest.capabilities.validate(known_definitions)?;
        let local = CapabilityDefinitionIndex::from_definitions(
            &artifact.manifest.capabilities.definitions,
        )?;
        let definitions = known_definitions.with_definitions(&local.definitions)?;
        validate_capability_message_bindings(
            &artifact.manifest.messages,
            &artifact.manifest.capabilities.providers,
            &definitions,
        )?;
        Ok(artifact)
    }

    fn parse_manifest(&self) -> Result<RuntimeArtifactManifest, ArtifactContractError> {
        let bytes = self
            .files
            .get(ARTIFACT_MANIFEST_PATH)
            .expect("archive constructor requires module.yaml");
        serde_yaml::from_slice(bytes).map_err(|error| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("Runtime manifest YAML is invalid: {error}"),
            )
        })
    }

    fn parse_integrity(&self) -> Result<ArtifactIntegrityIndex, ArtifactContractError> {
        let bytes = self
            .files
            .get(ARTIFACT_INTEGRITY_PATH)
            .expect("archive constructor requires integrity.json");
        serde_json::from_slice(bytes).map_err(|error| {
            ArtifactContractError::new(
                ARTIFACT_INTEGRITY_INVALID,
                format!("Artifact integrity index JSON is invalid: {error}"),
            )
        })
    }
}

/// Trusted facts supplied by the host to offline preflight. Candidate metadata
/// cannot grant itself access to the host or native adapters.
#[derive(Clone, Debug, Default)]
pub struct ArtifactPreflightContext {
    pub host_api_version: Option<String>,
    pub peer_versions: BTreeMap<String, String>,
    pub service_versions: BTreeMap<String, u32>,
    pub contribution_schema_versions: BTreeMap<String, u32>,
    pub allowed_grants: BTreeSet<String>,
    pub supported_native_adapters: BTreeSet<String>,
}

impl ArtifactPreflightContext {
    pub fn validate_requirements(
        &self,
        artifact: &ValidatedRuntimeArtifact,
    ) -> Result<(), ArtifactContractError> {
        let api_version = self.host_api_version.as_deref().ok_or_else(|| {
            ArtifactContractError::new(
                ARTIFACT_API_INCOMPATIBLE,
                "No trusted host module API version is available for artifact preflight",
            )
        })?;
        let api_version = Version::parse(api_version).map_err(|_| {
            ArtifactContractError::new(
                ARTIFACT_API_INCOMPATIBLE,
                "Trusted host module API version is not semantic-version formatted",
            )
        })?;
        let api_range = VersionReq::parse(&artifact.manifest.api_range).map_err(|_| {
            ArtifactContractError::new(
                ARTIFACT_API_INCOMPATIBLE,
                "Artifact API range is not semantic-version formatted",
            )
        })?;
        if !api_range.matches(&api_version) {
            return Err(ArtifactContractError::new(
                ARTIFACT_API_INCOMPATIBLE,
                "Artifact requires an incompatible host module API version",
            ));
        }
        for (peer, range) in &artifact.manifest.peer_dependencies {
            let supplied = self.peer_versions.get(peer).ok_or_else(|| {
                ArtifactContractError::new(
                    ARTIFACT_PEER_INCOMPATIBLE,
                    format!("Required host peer {peer:?} is unavailable"),
                )
            })?;
            let supplied = Version::parse(supplied).map_err(|_| {
                ArtifactContractError::new(
                    ARTIFACT_PEER_INCOMPATIBLE,
                    format!("Trusted host peer {peer:?} has an invalid version"),
                )
            })?;
            let requirement = VersionReq::parse(range).map_err(|_| {
                ArtifactContractError::new(
                    ARTIFACT_PEER_INCOMPATIBLE,
                    "Artifact peer range is not semantic-version formatted",
                )
            })?;
            if !requirement.matches(&supplied) {
                return Err(ArtifactContractError::new(
                    ARTIFACT_PEER_INCOMPATIBLE,
                    format!("Required host peer {peer:?} is incompatible"),
                ));
            }
        }
        for required in &artifact.manifest.application.required_services {
            if self.service_versions.get(&required.id) != Some(&required.version) {
                return Err(ArtifactContractError::new(
                    ARTIFACT_SERVICE_INCOMPATIBLE,
                    format!(
                        "Required service {}@{} is unavailable or incompatible",
                        required.id, required.version
                    ),
                ));
            }
        }
        for contribution in &artifact.manifest.application.contributions {
            let family = contribution.family.as_str();
            if self.contribution_schema_versions.get(family) != Some(&contribution.schema_version) {
                return Err(ArtifactContractError::new(
                    ARTIFACT_CONTRIBUTION_INCOMPATIBLE,
                    format!(
                        "Contribution family {family} schema version {} is unsupported",
                        contribution.schema_version
                    ),
                ));
            }
        }
        if artifact
            .manifest
            .requested_grants
            .iter()
            .any(|grant| !self.allowed_grants.contains(grant))
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_GRANT_DENIED,
                "Artifact requests a host grant that is not approved by this host",
            ));
        }
        if artifact
            .manifest
            .native_adapters
            .iter()
            .any(|adapter| !self.supported_native_adapters.contains(adapter))
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_NATIVE_ADAPTER_UNAVAILABLE,
                "Artifact requires an unsupported native adapter",
            ));
        }
        Ok(())
    }
}

fn validate_provider_bindings(
    bindings: &[CapabilityProviderBinding],
    definitions: &CapabilityDefinitionIndex,
) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    for binding in bindings {
        let definition = resolve_binding_definition(&binding.capability, definitions)?;
        if !seen.insert((
            binding.capability.id.clone(),
            binding.capability.version.clone(),
        )) {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability provider bindings must be unique per capability id and version",
            ));
        }
        validate_binding_surfaces(&binding.surfaces, definition)?;
        validate_binding_scopes(&binding.scopes, definition)?;
        match definition.selection {
            CapabilityProviderSelection::Priority if binding.priority.is_none() => {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Priority-selected capability providers require a priority",
                ));
            }
            CapabilityProviderSelection::All if binding.priority.is_some() => {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "All-selected capability providers must not declare a priority",
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_consumer_bindings(
    bindings: &[CapabilityConsumerBinding],
    definitions: &CapabilityDefinitionIndex,
) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    for binding in bindings {
        let definition = resolve_binding_definition(&binding.capability, definitions)?;
        if !seen.insert((
            binding.capability.id.clone(),
            binding.capability.version.clone(),
        )) {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability consumer bindings must be unique per capability id and version",
            ));
        }
        validate_binding_surfaces(&binding.surfaces, definition)?;
        validate_binding_scopes(&binding.scopes, definition)?;
    }
    Ok(())
}

/// A capability provider is not merely a label: its declared command/query
/// ports and emitted topics must be backed by the artifact's typed message
/// declarations. Streams remain deliberately separate from the message bus.
fn validate_capability_message_bindings(
    messages: &MessageDeclarations,
    providers: &[CapabilityProviderBinding],
    definitions: &CapabilityDefinitionIndex,
) -> Result<(), ArtifactContractError> {
    for binding in providers {
        let Some(definition) = definitions.get(&binding.capability) else {
            // `RuntimeArtifactManifest::validate` performs a local-only pass.
            // Full archive preflight resolves external definitions first.
            continue;
        };
        if definition.definition_digest_sha256 != binding.capability.definition_digest_sha256 {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_CONFLICT,
                "Capability provider binding digest does not match its definition",
            ));
        }
        for id in &binding.surfaces.ports {
            let port = definition
                .ports
                .iter()
                .find(|port| port.id == *id)
                .ok_or_else(|| {
                    ArtifactContractError::new(
                        CAPABILITY_CONTRACT_INVALID,
                        "Capability provider references an undeclared port",
                    )
                })?;
            let declared = messages.ports.iter().find(|candidate| candidate.id == *id);
            if !declared.is_some_and(|candidate| {
                candidate.request == port.request && candidate.response == port.response
            }) {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability provider ports must match declared typed message ports",
                ));
            }
        }
        for id in &binding.surfaces.topics {
            let topic = definition
                .topics
                .iter()
                .find(|topic| topic.id == *id)
                .ok_or_else(|| {
                    ArtifactContractError::new(
                        CAPABILITY_CONTRACT_INVALID,
                        "Capability provider references an undeclared topic",
                    )
                })?;
            let declared = messages
                .publishes
                .iter()
                .find(|candidate| candidate.endpoint.id == *id);
            if !declared.is_some_and(|candidate| candidate.endpoint.message == topic.message) {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability provider topics must match declared typed message topics",
                ));
            }
        }
        for id in &binding.surfaces.events {
            let event = definition
                .events
                .iter()
                .find(|event| event.id == *id)
                .ok_or_else(|| {
                    ArtifactContractError::new(
                        CAPABILITY_CONTRACT_INVALID,
                        "Capability provider references an undeclared event",
                    )
                })?;
            let delivered = definition.topics.iter().any(|topic| {
                topic.event_id == *id
                    && messages.publishes.iter().any(|candidate| {
                        candidate.endpoint.id == topic.id
                            && candidate.endpoint.message == event.message
                    })
            });
            if !delivered {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability provider events require a matching declared message topic",
                ));
            }
        }
        for message in capability_messages_for_binding(definition, &binding.surfaces) {
            let capability_contract = definition
                .schemas
                .iter()
                .find(|contract| contract.message == message)
                .ok_or_else(|| {
                    ArtifactContractError::new(
                        CAPABILITY_CONTRACT_INVALID,
                        "Capability provider surface has no declared schema",
                    )
                })?;
            let message_contract = messages
                .provides
                .iter()
                .find(|contract| contract.message == message);
            if message_contract != Some(capability_contract) {
                return Err(ArtifactContractError::new(
                    CAPABILITY_CONTRACT_INVALID,
                    "Capability provider surface schemas must exactly match message declarations",
                ));
            }
        }
    }
    Ok(())
}

fn capability_messages_for_binding(
    definition: &CapabilityDefinition,
    surfaces: &CapabilitySurfaceBinding,
) -> BTreeSet<MessageTypeId> {
    let mut messages = BTreeSet::new();
    for id in &surfaces.ports {
        if let Some(port) = definition.ports.iter().find(|port| port.id == *id) {
            messages.insert(port.request.clone());
            messages.insert(port.response.clone());
        }
    }
    for id in &surfaces.events {
        if let Some(event) = definition.events.iter().find(|event| event.id == *id) {
            messages.insert(event.message.clone());
        }
    }
    for id in &surfaces.topics {
        if let Some(topic) = definition.topics.iter().find(|topic| topic.id == *id) {
            messages.insert(topic.message.clone());
        }
    }
    for id in &surfaces.streams {
        if let Some(stream) = definition.streams.iter().find(|stream| stream.id == *id) {
            messages.insert(stream.message.clone());
        }
    }
    messages
}

fn resolve_binding_definition<'a>(
    reference: &CapabilityReference,
    definitions: &'a CapabilityDefinitionIndex,
) -> Result<&'a CapabilityDefinition, ArtifactContractError> {
    reference.validate()?;
    let definition = definitions.get(reference).ok_or_else(|| {
        ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            format!(
                "Capability binding references unknown definition {}@{}",
                reference.id, reference.version
            ),
        )
    })?;
    if definition.definition_digest_sha256 != reference.definition_digest_sha256 {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_CONFLICT,
            "Capability binding digest does not match the immutable definition",
        ));
    }
    Ok(definition)
}

fn validate_binding_surfaces(
    binding: &CapabilitySurfaceBinding,
    definition: &CapabilityDefinition,
) -> Result<(), ArtifactContractError> {
    let ports = definition
        .ports
        .iter()
        .map(|value| value.id.as_str())
        .collect::<BTreeSet<_>>();
    let events = definition
        .events
        .iter()
        .map(|value| value.id.as_str())
        .collect::<BTreeSet<_>>();
    let topics = definition
        .topics
        .iter()
        .map(|value| value.id.as_str())
        .collect::<BTreeSet<_>>();
    let streams = definition
        .streams
        .iter()
        .map(|value| value.id.as_str())
        .collect::<BTreeSet<_>>();
    validate_surface_subset(&binding.ports, &ports)?;
    validate_surface_subset(&binding.events, &events)?;
    validate_surface_subset(&binding.topics, &topics)?;
    validate_surface_subset(&binding.streams, &streams)?;
    if binding.ports.is_empty()
        && binding.events.is_empty()
        && binding.topics.is_empty()
        && binding.streams.is_empty()
    {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability bindings must name at least one declared surface",
        ));
    }
    Ok(())
}

/// The local pass cannot resolve an external definition, but it can still
/// reject malformed, duplicate, or empty binding declarations before anything
/// is persisted. Full subset validation happens during catalog preflight.
fn validate_binding_surface_names(
    binding: &CapabilitySurfaceBinding,
) -> Result<(), ArtifactContractError> {
    let named = [
        &binding.ports,
        &binding.events,
        &binding.topics,
        &binding.streams,
    ];
    if named.iter().all(|values| values.is_empty()) {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability bindings must name at least one declared surface",
        ));
    }
    for values in named {
        let mut seen = BTreeSet::new();
        if values
            .iter()
            .any(|value| !valid_scoped_id(value) || !seen.insert(value.as_str()))
        {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability binding surface ids must be unique dotted lowercase identifiers",
            ));
        }
    }
    Ok(())
}

fn validate_binding_scopes(
    scopes: &[CapabilityScope],
    definition: &CapabilityDefinition,
) -> Result<(), ArtifactContractError> {
    let declared = unique_scopes(&definition.scopes)?;
    let bound = unique_scopes(scopes)?;
    if bound.is_empty() || !bound.is_subset(&declared) {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability binding scopes must be a nonempty subset of definition scopes",
        ));
    }
    Ok(())
}

fn validate_surface_subset(
    values: &[String],
    declared: &BTreeSet<&str>,
) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    if values
        .iter()
        .any(|value| !seen.insert(value.as_str()) || !declared.contains(value.as_str()))
    {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability binding surfaces must be unique declared surface ids",
        ));
    }
    Ok(())
}

fn validate_agent_access(
    access: &CapabilityAgentAccess,
    ports: &BTreeSet<&str>,
    events: &BTreeSet<&str>,
    topics: &BTreeSet<&str>,
    streams: &BTreeSet<&str>,
) -> Result<(), ArtifactContractError> {
    validate_surface_subset(&access.invoke, ports)?;
    validate_surface_subset(&access.watch.events, events)?;
    validate_surface_subset(&access.watch.topics, topics)?;
    validate_surface_subset(&access.attach, streams)?;
    Ok(())
}

fn validate_message_reference(
    message: &MessageTypeId,
    schemas: &BTreeSet<MessageTypeId>,
) -> Result<(), ArtifactContractError> {
    message.validate().map_err(|error| {
        ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            format!("Capability message reference is invalid: {}", error.code),
        )
    })?;
    if !schemas.contains(message) {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability surfaces must reference declared capability schemas",
        ));
    }
    Ok(())
}

fn validate_named_ids<'a>(
    identifiers: impl Iterator<Item = &'a str>,
) -> Result<BTreeSet<&'a str>, ArtifactContractError> {
    let mut values = BTreeSet::new();
    for identifier in identifiers {
        if !valid_scoped_id(identifier) || !values.insert(identifier) {
            return Err(ArtifactContractError::new(
                CAPABILITY_CONTRACT_INVALID,
                "Capability surface ids must be unique dotted lowercase identifiers",
            ));
        }
    }
    Ok(values)
}

fn unique_scopes(
    scopes: &[CapabilityScope],
) -> Result<BTreeSet<CapabilityScope>, ArtifactContractError> {
    let values = scopes.iter().copied().collect::<BTreeSet<_>>();
    if values.len() != scopes.len() {
        return Err(ArtifactContractError::new(
            CAPABILITY_CONTRACT_INVALID,
            "Capability scopes must be unique",
        ));
    }
    Ok(values)
}

fn validate_unique_scopes(
    scopes: &[CapabilityScope],
    subject: &str,
) -> Result<(), ArtifactContractError> {
    if unique_scopes(scopes)?.len() != scopes.len() {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            format!("{subject} must be unique"),
        ));
    }
    Ok(())
}

fn validate_unique_strings(values: &[String], subject: &str) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    if values
        .iter()
        .any(|value| value.trim().is_empty() || !seen.insert(value.as_str()))
    {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            format!("{subject} must be nonempty and unique"),
        ));
    }
    Ok(())
}

fn validate_unique_scoped_strings(
    values: &[String],
    subject: &str,
) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    if values
        .iter()
        .any(|value| !valid_scoped_id(value) || !seen.insert(value.as_str()))
    {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            format!("{subject} must be unique stable scoped identifiers"),
        ));
    }
    Ok(())
}

fn validate_service_declarations(
    services: &[RuntimeServiceDeclaration],
    subject: &str,
) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    if services.iter().any(|service| {
        !valid_scoped_id(&service.id) || service.version == 0 || !seen.insert(service.id.as_str())
    }) {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            format!("{subject} require unique stable ids and nonzero versions"),
        ));
    }
    Ok(())
}

fn validate_unique_paths(paths: &[String]) -> Result<(), ArtifactContractError> {
    let mut seen = BTreeSet::new();
    if paths
        .iter()
        .any(|path| !valid_archive_path(path) || !seen.insert(path.as_str()))
    {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            "Artifact resource paths must be normalized and unique",
        ));
    }
    Ok(())
}

fn validate_manifest_files(
    manifest: &RuntimeArtifactManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ArtifactContractError> {
    let mut required = BTreeSet::new();
    required.insert(manifest.entry.clone());
    required.extend(manifest.styles.iter().cloned());
    required.extend(manifest.assets.iter().cloned());
    required.extend(
        manifest
            .ui_contributions
            .iter()
            .map(|item| item.entry.clone()),
    );
    if required.iter().any(|path| !files.contains_key(path)) {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            "Runtime manifest references a file absent from the archive",
        ));
    }
    validate_contract_resource_files(
        &manifest.messages.provides,
        "messages/",
        files,
        "Message contract schemas",
    )?;
    for definition in &manifest.capabilities.definitions {
        validate_contract_resource_files(
            &definition.schemas,
            "messages/",
            files,
            "Capability contract schemas",
        )?;
        let path = capability_definition_document_path(definition);
        let bytes = files.get(&path).ok_or_else(|| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Capability definitions require one canonical capabilities/*.json document",
            )
        })?;
        let actual: Value = serde_json::from_slice(bytes).map_err(|_| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Capability definition document is not JSON",
            )
        })?;
        let expected = serde_json::to_value(definition).map_err(|error| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("Capability definition cannot be canonicalized: {error}"),
            )
        })?;
        if canonicalize_json(actual) != canonicalize_json(expected) {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                "Capability definition document does not match the declared definition",
            ));
        }
        required.insert(path);
    }
    required.insert(ARTIFACT_MANIFEST_PATH.to_string());
    for contract in manifest.messages.provides.iter().chain(
        manifest
            .capabilities
            .definitions
            .iter()
            .flat_map(|definition| definition.schemas.iter()),
    ) {
        required.extend(contract.schema.resources.keys().cloned());
    }
    let actual = files
        .keys()
        .filter(|path| path.as_str() != ARTIFACT_INTEGRITY_PATH)
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual != required {
        return Err(ArtifactContractError::new(
            ARTIFACT_MANIFEST_INVALID,
            "Artifact contains missing or undeclared files",
        ));
    }
    Ok(())
}

fn capability_definition_document_path(definition: &CapabilityDefinition) -> String {
    format!("capabilities/{}.json", definition.id)
}

/// Message and capability schemas are represented in the strict contract as
/// JSON values, but a runtime artifact must also carry the same resources as
/// immutable files. This binds the metadata to the archive layout without
/// teaching the host a second schema language.
fn validate_contract_resource_files(
    contracts: &[MessageTypeContract],
    required_prefix: &str,
    files: &BTreeMap<String, Vec<u8>>,
    subject: &str,
) -> Result<(), ArtifactContractError> {
    let mut declared = BTreeMap::<String, Value>::new();
    for contract in contracts {
        for (path, schema) in &contract.schema.resources {
            if !path.starts_with(required_prefix) {
                return Err(ArtifactContractError::new(
                    ARTIFACT_MANIFEST_INVALID,
                    format!("{subject} must live under {required_prefix}"),
                ));
            }
            match declared.get(path) {
                Some(previous)
                    if canonicalize_json(previous.clone()) != canonicalize_json(schema.clone()) =>
                {
                    return Err(ArtifactContractError::new(
                        ARTIFACT_MANIFEST_INVALID,
                        "One schema resource path cannot declare different JSON content",
                    ));
                }
                Some(_) => {}
                None => {
                    declared.insert(path.clone(), schema.clone());
                }
            }
        }
    }
    for (path, expected) in declared {
        let bytes = files.get(&path).ok_or_else(|| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("{subject} reference a file absent from the archive"),
            )
        })?;
        let actual: Value = serde_json::from_slice(bytes).map_err(|_| {
            ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("{subject} file is not JSON"),
            )
        })?;
        if canonicalize_json(actual) != canonicalize_json(expected) {
            return Err(ArtifactContractError::new(
                ARTIFACT_MANIFEST_INVALID,
                format!("{subject} file does not match its declared contract"),
            ));
        }
    }
    Ok(())
}

fn validate_integrity_index(
    index: &ArtifactIntegrityIndex,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ArtifactContractError> {
    if !(ARTIFACT_MINIMUM_SCHEMA_VERSION..=ARTIFACT_CONTRACT_SCHEMA_VERSION)
        .contains(&index.schema_version)
        || !valid_sha256(&index.content_digest_sha256)
    {
        return Err(ArtifactContractError::new(
            ARTIFACT_INTEGRITY_INVALID,
            "Artifact integrity index has an unsupported schema version or invalid content digest",
        ));
    }
    let mut expected_paths = files
        .keys()
        .filter(|path| path.as_str() != ARTIFACT_INTEGRITY_PATH)
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut previous = None;
    for entry in &index.files {
        if !valid_archive_path(&entry.path)
            || entry.path == ARTIFACT_INTEGRITY_PATH
            || !valid_sha256(&entry.digest_sha256)
            || previous
                .as_deref()
                .is_some_and(|path: &str| path >= entry.path.as_str())
        {
            return Err(ArtifactContractError::new(
                ARTIFACT_INTEGRITY_INVALID,
                "Artifact integrity entries must be sorted normalized paths with SHA-256 digests",
            ));
        }
        previous = Some(entry.path.clone());
        let bytes = files.get(&entry.path).ok_or_else(|| {
            ArtifactContractError::new(
                ARTIFACT_INTEGRITY_INVALID,
                "Artifact integrity index declares a file absent from the archive",
            )
        })?;
        if sha256_hex(bytes) != entry.digest_sha256 {
            return Err(ArtifactContractError::new(
                ARTIFACT_INTEGRITY_INVALID,
                "Artifact file bytes do not match their integrity digest",
            ));
        }
        if !expected_paths.remove(&entry.path) {
            return Err(ArtifactContractError::new(
                ARTIFACT_INTEGRITY_INVALID,
                "Artifact integrity index declares a duplicate file path",
            ));
        }
    }
    if !expected_paths.is_empty() {
        return Err(ArtifactContractError::new(
            ARTIFACT_INTEGRITY_INVALID,
            "Artifact archive contains a file missing from the integrity index",
        ));
    }
    Ok(())
}

/// Calculate the immutable semantic identity for a parsed manifest and its
/// sorted raw integrity entries. Archive builders and tests use this instead
/// of copying host canonicalization rules. `sourceProvenance` and the raw
/// `module.yaml` digest are intentionally excluded.
pub fn canonical_content_digest(
    manifest: &RuntimeArtifactManifest,
    files: &[ArtifactIntegrityFile],
) -> Result<String, ArtifactContractError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestInput<'a> {
        manifest: &'a RuntimeArtifactManifest,
        files: Vec<&'a ArtifactIntegrityFile>,
    }

    // module.yaml can contain sourceProvenance. Its raw digest remains in the
    // integrity index for tamper detection, but it must not become identity.
    let metadata = manifest.canonicalized();
    let files = files
        .iter()
        .filter(|entry| entry.path != ARTIFACT_MANIFEST_PATH)
        .collect::<Vec<_>>();
    canonical_json_digest(&DigestInput {
        manifest: &metadata,
        files,
    })
}

fn canonical_json_digest<T: Serialize>(value: &T) -> Result<String, ArtifactContractError> {
    let value = serde_json::to_value(value).map_err(|error| {
        ArtifactContractError::new(
            ARTIFACT_CONTENT_DIGEST_INVALID,
            format!("Artifact metadata cannot be canonicalized: {error}"),
        )
    })?;
    let canonical = canonicalize_json(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|error| {
        ArtifactContractError::new(
            ARTIFACT_CONTENT_DIGEST_INVALID,
            format!("Artifact metadata cannot be canonicalized: {error}"),
        )
    })?;
    Ok(sha256_hex(&bytes))
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let values = values.into_iter().collect::<BTreeMap<_, _>>();
            Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize_json(value)))
                    .collect(),
            )
        }
        other => other,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_archive_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn valid_scoped_id(value: &str) -> bool {
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() >= 2
        && segments.into_iter().all(|segment| {
            let mut characters = segment.chars();
            matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
                && characters.all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
        })
}

fn valid_contribution_id(family: RuntimeContributionFamily, value: &str) -> bool {
    match family {
        RuntimeContributionFamily::TerminalPresentation => {
            crate::terminal_host::TerminalDriverId::new(value).is_ok()
        }
        _ => valid_scoped_id(value),
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::json;

    use crate::message_bus::{
        BroadcastTopicDeclaration, CapabilityPortDeclaration, DirectedChannelDeclaration,
        MessageSchemaDescriptor, RouteEndpointRef, MESSAGE_CONTRACT_SCHEMA_VERSION,
    };

    use super::*;

    fn message(id: &str) -> MessageTypeId {
        MessageTypeId {
            id: id.to_string(),
            version: 1,
        }
    }

    fn schema_contract(id: &str, path: &str) -> MessageTypeContract {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": format!("shipctl-artifact:///{path}"),
            "type": "object",
            "additionalProperties": false,
        });
        MessageTypeContract {
            message: message(id),
            schema: MessageSchemaDescriptor {
                draft: "https://json-schema.org/draft/2020-12/schema".to_string(),
                root: path.to_string(),
                resources: BTreeMap::from([(path.to_string(), schema)]),
                max_encoded_bytes: 1024,
                redacted_fields: Vec::new(),
                compatible_versions: vec![1],
            },
        }
    }

    fn fixture_manifest(provenance: &str) -> RuntimeArtifactManifest {
        let request = schema_contract(
            "fixture.work-review.request",
            "messages/work-review-request.schema.json",
        );
        let response = schema_contract(
            "fixture.work-review.response",
            "messages/work-review-response.schema.json",
        );
        let completed = schema_contract(
            "fixture.work-review.completed",
            "messages/work-review-completed.schema.json",
        );
        let output = schema_contract(
            "fixture.work-review.output",
            "messages/work-review-output.schema.json",
        );
        let mut definition = CapabilityDefinition {
            id: "fixture.work-review".to_string(),
            version: "1.2.3".to_string(),
            definition_digest_sha256: String::new(),
            schemas: vec![
                request.clone(),
                response.clone(),
                completed.clone(),
                output.clone(),
            ],
            ports: vec![CapabilityPortDefinition {
                id: "fixture.work-review.review".to_string(),
                kind: CapabilityPortKind::Command,
                request: request.message.clone(),
                response: response.message.clone(),
            }],
            events: vec![CapabilityEventDefinition {
                id: "fixture.work-review.completed".to_string(),
                message: completed.message.clone(),
            }],
            topics: vec![CapabilityTopicDefinition {
                id: "fixture.work-review.completed-topic".to_string(),
                event_id: "fixture.work-review.completed".to_string(),
                message: completed.message.clone(),
            }],
            streams: vec![CapabilityStreamDefinition {
                id: "fixture.work-review.output".to_string(),
                message: output.message.clone(),
                ordered: true,
            }],
            provider_cardinality: CapabilityProviderCardinality::Exclusive,
            selection: CapabilityProviderSelection::Priority,
            scopes: vec![CapabilityScope::Instance, CapabilityScope::Workspace],
            agent_access: CapabilityAgentAccess {
                inspect: true,
                invoke: vec!["fixture.work-review.review".to_string()],
                watch: CapabilityAgentWatchAccess {
                    events: vec!["fixture.work-review.completed".to_string()],
                    topics: vec!["fixture.work-review.completed-topic".to_string()],
                },
                attach: vec!["fixture.work-review.output".to_string()],
            },
        };
        definition.definition_digest_sha256 = definition.calculated_digest_sha256().unwrap();
        let reference = definition.reference();
        RuntimeArtifactManifest {
            schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
            id: "fixture.work-review".to_string(),
            name: "Fixture Work Review".to_string(),
            version: "1.2.3".to_string(),
            api_range: "^1.0.0".to_string(),
            runtime_kind: ModuleRuntimeKind::FrontendEsm,
            entry: "module.mjs".to_string(),
            styles: vec!["styles/work-review.css".to_string()],
            assets: vec![
                "assets/work-review.svg".to_string(),
                "chunks/work-review-panel.mjs".to_string(),
            ],
            messages: MessageDeclarations {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                provides: vec![
                    request.clone(),
                    response.clone(),
                    completed.clone(),
                    output.clone(),
                ],
                handles: vec![DirectedChannelDeclaration {
                    endpoint: RouteEndpointRef {
                        id: "fixture.work-review.wakeup".to_string(),
                        message: request.message.clone(),
                    },
                    capacity: 1,
                    required_grant: "message.send.fixture.work-review.wakeup".to_string(),
                    scheduler_allowed: true,
                }],
                publishes: vec![BroadcastTopicDeclaration {
                    endpoint: RouteEndpointRef {
                        id: "fixture.work-review.completed-topic".to_string(),
                        message: completed.message.clone(),
                    },
                    capacity: 1,
                    required_grant: "message.publish.fixture.work-review.completed-topic"
                        .to_string(),
                    scheduler_allowed: false,
                }],
                subscribes: Vec::new(),
                ports: vec![CapabilityPortDeclaration {
                    id: "fixture.work-review.review".to_string(),
                    request: request.message,
                    response: response.message,
                    capacity: 1,
                    required_grant: "message.request.fixture.work-review.review".to_string(),
                    scheduler_allowed: false,
                }],
            },
            capabilities: CapabilityManifest {
                schema_version: CAPABILITY_CONTRACT_SCHEMA_VERSION,
                definitions: vec![definition],
                providers: vec![CapabilityProviderBinding {
                    capability: reference.clone(),
                    surfaces: CapabilitySurfaceBinding {
                        ports: vec!["fixture.work-review.review".to_string()],
                        events: vec!["fixture.work-review.completed".to_string()],
                        topics: vec!["fixture.work-review.completed-topic".to_string()],
                        streams: vec!["fixture.work-review.output".to_string()],
                    },
                    scopes: vec![CapabilityScope::Instance],
                    priority: Some(100),
                }],
                consumers: vec![CapabilityConsumerBinding {
                    capability: reference,
                    surfaces: CapabilitySurfaceBinding {
                        ports: Vec::new(),
                        events: vec!["fixture.work-review.completed".to_string()],
                        topics: vec!["fixture.work-review.completed-topic".to_string()],
                        streams: vec!["fixture.work-review.output".to_string()],
                    },
                    scopes: vec![CapabilityScope::Workspace],
                }],
            },
            application: RuntimeApplicationManifest {
                schema_version: APPLICATION_DECLARATION_SCHEMA_VERSION,
                role: RuntimePluginRole::Compound,
                required_services: Vec::new(),
                provided_services: Vec::new(),
                background_effects: vec!["fixture.work-review.refresh".to_string()],
                contributions: vec![RuntimeContributionDeclaration {
                    family: RuntimeContributionFamily::Panel,
                    id: "fixture.work-review.panel".to_string(),
                    schema_version: 1,
                }],
            },
            ui_contributions: Vec::new(),
            requested_grants: Vec::new(),
            native_adapters: Vec::new(),
            configuration_schema: Some(json!({"type": "object"})),
            secret_references: vec!["fixture.work-review.token".to_string()],
            peer_dependencies: BTreeMap::new(),
            supported_scopes: vec![CapabilityScope::Instance, CapabilityScope::Workspace],
            lifecycle: ArtifactLifecycleRequirement::Live,
            source_provenance: Some(json!({"source": provenance})),
        }
    }

    fn archive_files(manifest: &RuntimeArtifactManifest) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::from([
            (
                "module.mjs".to_string(),
                b"export const fixture = true;".to_vec(),
            ),
            (
                "chunks/work-review-panel.mjs".to_string(),
                b"export const panel = true;".to_vec(),
            ),
            (
                "styles/work-review.css".to_string(),
                b".fixture { color: green; }".to_vec(),
            ),
            ("assets/work-review.svg".to_string(), b"<svg/>".to_vec()),
            (
                ARTIFACT_MANIFEST_PATH.to_string(),
                serde_yaml::to_string(manifest).unwrap().into_bytes(),
            ),
        ]);
        for contract in manifest.messages.provides.iter().chain(
            manifest
                .capabilities
                .definitions
                .iter()
                .flat_map(|definition| definition.schemas.iter()),
        ) {
            for (path, schema) in &contract.schema.resources {
                files
                    .entry(path.clone())
                    .or_insert_with(|| serde_json::to_vec(schema).unwrap());
            }
        }
        for definition in &manifest.capabilities.definitions {
            files.insert(
                capability_definition_document_path(definition),
                serde_json::to_vec(definition).unwrap(),
            );
        }
        reindex(&mut files);
        files
    }

    fn reindex(files: &mut BTreeMap<String, Vec<u8>>) {
        files.remove(ARTIFACT_INTEGRITY_PATH);
        let manifest: RuntimeArtifactManifest =
            serde_yaml::from_slice(files.get(ARTIFACT_MANIFEST_PATH).unwrap()).unwrap();
        let entries = files
            .iter()
            .map(|(path, bytes)| ArtifactIntegrityFile {
                path: path.clone(),
                digest_sha256: sha256_hex(bytes),
            })
            .collect::<Vec<_>>();
        let index = ArtifactIntegrityIndex {
            schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
            content_digest_sha256: canonical_content_digest(&manifest, &entries).unwrap(),
            files: entries,
        };
        files.insert(
            ARTIFACT_INTEGRITY_PATH.to_string(),
            serde_json::to_vec(&index).unwrap(),
        );
    }

    fn fixture_archive(provenance: &str) -> RuntimeArtifactArchive {
        RuntimeArtifactArchive::new(archive_files(&fixture_manifest(provenance))).unwrap()
    }

    #[test]
    fn contribution_ids_follow_their_public_domain_contracts() {
        let mut application = fixture_manifest("/fixture/source").application;
        application.contributions = vec![RuntimeContributionDeclaration {
            family: RuntimeContributionFamily::TerminalPresentation,
            id: "thin-terminal".to_string(),
            schema_version: 1,
        }];
        assert!(application.validate().is_ok());

        application.contributions[0].id = "Thin Terminal".to_string();
        assert_eq!(
            application.validate().unwrap_err().code,
            ARTIFACT_MANIFEST_INVALID
        );

        application.contributions[0].family = RuntimeContributionFamily::Panel;
        application.contributions[0].id = "thin-terminal".to_string();
        assert_eq!(
            application.validate().unwrap_err().code,
            ARTIFACT_MANIFEST_INVALID
        );
    }

    #[test]
    fn fixture_archive_is_disabled_metadata_and_preflights() {
        let artifact = fixture_archive("/source/one")
            .preflight(&CapabilityDefinitionIndex::default())
            .unwrap();
        assert_eq!(artifact.identity().id, "fixture.work-review");
        assert_eq!(artifact.manifest.capabilities.definitions.len(), 1);
        assert_eq!(artifact.manifest.capabilities.providers.len(), 1);
        assert_eq!(artifact.manifest.capabilities.consumers.len(), 1);
        assert_eq!(artifact.manifest.messages.ports.len(), 1);
        assert!(artifact.manifest.messages.handles[0].scheduler_allowed);
        assert_eq!(artifact.manifest.messages.publishes.len(), 1);
        assert_eq!(
            artifact.manifest.lifecycle,
            ArtifactLifecycleRequirement::Live
        );
    }

    #[test]
    fn archive_paths_are_fail_closed() {
        let mut files = BTreeMap::new();
        files.insert(ARTIFACT_MANIFEST_PATH.to_string(), Vec::new());
        files.insert(ARTIFACT_INTEGRITY_PATH.to_string(), Vec::new());
        files.insert("../escape.js".to_string(), Vec::new());
        assert_eq!(
            RuntimeArtifactArchive::new(files).unwrap_err().code,
            ARTIFACT_ARCHIVE_PATH_INVALID
        );
    }

    #[test]
    fn provenance_is_not_identity_but_raw_integrity_is_total() {
        let first = fixture_archive("/source/one").inspect().unwrap();
        let second = fixture_archive("/source/two").inspect().unwrap();
        assert_eq!(first.identity(), second.identity());
        assert_eq!(first.canonical_metadata(), second.canonical_metadata());
        assert_ne!(
            first
                .integrity
                .files
                .iter()
                .find(|entry| entry.path == ARTIFACT_MANIFEST_PATH),
            second
                .integrity
                .files
                .iter()
                .find(|entry| entry.path == ARTIFACT_MANIFEST_PATH),
        );
        let canonical = serde_json::to_string(&first.canonical_metadata()).unwrap();
        assert!(!canonical.contains("sourceProvenance"));
        assert!(!canonical.contains("/source/one"));

        let mut tampered = archive_files(&fixture_manifest("/source/one"));
        tampered
            .get_mut("module.mjs")
            .unwrap()
            .extend_from_slice(b"// changed");
        assert_eq!(
            RuntimeArtifactArchive::new(tampered)
                .unwrap()
                .inspect()
                .unwrap_err()
                .code,
            ARTIFACT_INTEGRITY_INVALID
        );
    }

    #[test]
    fn linked_schema_documents_and_provider_ports_fail_closed() {
        let mut missing_document = archive_files(&fixture_manifest("/source/one"));
        missing_document.remove("capabilities/fixture.work-review.json");
        reindex(&mut missing_document);
        assert_eq!(
            RuntimeArtifactArchive::new(missing_document)
                .unwrap()
                .inspect()
                .unwrap_err()
                .code,
            ARTIFACT_MANIFEST_INVALID
        );

        let mut mismatch = fixture_manifest("/source/one");
        mismatch.messages.ports[0].response = mismatch.messages.ports[0].request.clone();
        let archive = RuntimeArtifactArchive::new(archive_files(&mismatch)).unwrap();
        assert_eq!(
            archive.inspect().unwrap_err().code,
            CAPABILITY_CONTRACT_INVALID
        );
    }

    proptest! {
        #[test]
        fn architecture_artifact_roundtrip_property(
            entry_bytes in any::<Vec<u8>>(),
            style_bytes in any::<Vec<u8>>(),
            asset_bytes in any::<Vec<u8>>(),
        ) {
            let manifest = fixture_manifest("/generated/source");
            let mut files = archive_files(&manifest);
            files.insert("module.mjs".to_string(), entry_bytes.clone());
            files.insert("styles/work-review.css".to_string(), style_bytes.clone());
            files.insert("assets/work-review.svg".to_string(), asset_bytes.clone());
            reindex(&mut files);
            let retained = files.clone();

            let archive = RuntimeArtifactArchive::new(files).unwrap();
            let inspected = archive.inspect().unwrap();

            prop_assert_eq!(&archive.files, &retained);
            prop_assert_eq!(archive.files.get("module.mjs"), Some(&entry_bytes));
            prop_assert_eq!(archive.files.get("styles/work-review.css"), Some(&style_bytes));
            prop_assert_eq!(archive.files.get("assets/work-review.svg"), Some(&asset_bytes));
            prop_assert_eq!(
                inspected.identity().content_digest,
                inspected.integrity.content_digest_sha256,
            );
        }

        #[test]
        fn architecture_artifact_tamper_property(
            entry_bytes in any::<Vec<u8>>(),
            mutation in any::<u8>(),
        ) {
            let manifest = fixture_manifest("/generated/source");
            let mut valid = archive_files(&manifest);
            valid.insert("module.mjs".to_string(), entry_bytes);
            reindex(&mut valid);
            prop_assert!(RuntimeArtifactArchive::new(valid.clone()).unwrap().inspect().is_ok());

            match mutation % 7 {
                0 => {
                    let bytes = valid.get_mut("module.mjs").unwrap();
                    if bytes.is_empty() { bytes.push(0xff); } else { bytes[0] ^= 0xff; }
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                1 => {
                    valid.remove("module.mjs");
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                2 => {
                    valid.insert("assets/undeclared.bin".to_string(), vec![mutation]);
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                3 => {
                    let mut index: ArtifactIntegrityIndex = serde_json::from_slice(
                        valid.get(ARTIFACT_INTEGRITY_PATH).unwrap(),
                    ).unwrap();
                    index.files[0].digest_sha256 = "0".repeat(64);
                    valid.insert(
                        ARTIFACT_INTEGRITY_PATH.to_string(),
                        serde_json::to_vec(&index).unwrap(),
                    );
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                4 => {
                    let mut index: ArtifactIntegrityIndex = serde_json::from_slice(
                        valid.get(ARTIFACT_INTEGRITY_PATH).unwrap(),
                    ).unwrap();
                    index.content_digest_sha256 = "0".repeat(64);
                    valid.insert(
                        ARTIFACT_INTEGRITY_PATH.to_string(),
                        serde_json::to_vec(&index).unwrap(),
                    );
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                5 => {
                    let bytes = valid.get_mut(ARTIFACT_MANIFEST_PATH).unwrap();
                    bytes.push(b' ');
                    prop_assert!(RuntimeArtifactArchive::new(valid).unwrap().inspect().is_err());
                }
                _ => {
                    valid.insert("../escape.mjs".to_string(), vec![mutation]);
                    prop_assert!(RuntimeArtifactArchive::new(valid).is_err());
                }
            }
        }

        #[test]
        fn architecture_artifact_compatibility_property(
            manifest_schema in any::<u8>(),
            host_api_major in any::<u8>(),
            required_api_major in any::<u8>(),
            service_version in any::<u8>(),
            host_service_version in any::<u8>(),
            contribution_version in any::<u8>(),
            host_contribution_version in any::<u8>(),
            host_api_available in any::<bool>(),
            malformed_api_range in any::<bool>(),
        ) {
            let mut manifest = fixture_manifest("/generated/source");
            manifest.schema_version = u32::from(manifest_schema);
            manifest.api_range = if malformed_api_range {
                "not-a-version-range".to_string()
            } else {
                format!("={required_api_major}.0.0")
            };
            if manifest.schema_version == 1 {
                manifest.application = RuntimeApplicationManifest::default();
            } else {
                manifest.application.required_services = vec![RuntimeServiceDeclaration {
                    id: "fixture.required-service".to_string(),
                    version: u32::from(service_version) + 1,
                }];
                manifest.application.contributions[0].schema_version =
                    u32::from(contribution_version) + 1;
            }
            let inspected = RuntimeArtifactArchive::new(archive_files(&manifest))
                .unwrap()
                .inspect();
            let manifest_is_valid = matches!(manifest.schema_version, 1 | 2)
                && !malformed_api_range;
            prop_assert_eq!(inspected.is_ok(), manifest_is_valid);
            if !manifest_is_valid {
                return Ok(());
            }

            let artifact = inspected.unwrap();
            let context = ArtifactPreflightContext {
                host_api_version: host_api_available.then(|| format!("{host_api_major}.0.0")),
                service_versions: BTreeMap::from([(
                    "fixture.required-service".to_string(),
                    u32::from(host_service_version) + 1,
                )]),
                contribution_schema_versions: BTreeMap::from([(
                    "panel".to_string(),
                    u32::from(host_contribution_version) + 1,
                )]),
                ..ArtifactPreflightContext::default()
            };
            let expected = host_api_available
                && host_api_major == required_api_major
                && (manifest.schema_version == 1
                    || (service_version == host_service_version
                        && contribution_version == host_contribution_version));
            prop_assert_eq!(context.validate_requirements(&artifact).is_ok(), expected);
        }
    }
}
