use std::collections::BTreeMap;
use std::fs;

use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use super::*;
use crate::message_bus::{
    BroadcastTopicDeclaration, CapabilityPortDeclaration, MessageDeclarations,
    MessageSchemaDescriptor, MessageTypeContract, MessageTypeId, RouteEndpointRef,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use crate::module_control::artifact::{
    canonical_content_digest, ArtifactIntegrityFile, ArtifactIntegrityIndex, CapabilityAgentAccess,
    CapabilityAgentWatchAccess, CapabilityConsumerBinding, CapabilityDefinition,
    CapabilityManifest, CapabilityPortDefinition, CapabilityPortKind, CapabilityProviderBinding,
    CapabilityProviderCardinality, CapabilityProviderSelection, CapabilityScope,
    CapabilitySurfaceBinding, CapabilityTopicDefinition, RuntimeArtifactArchive,
    RuntimeArtifactManifest, ValidatedRuntimeArtifact, ARTIFACT_CONTRACT_SCHEMA_VERSION,
    CAPABILITY_CONTRACT_SCHEMA_VERSION,
};
use crate::module_control::codes::REGISTRY_HEALTHY;
use crate::module_control::{ModuleLifecycleState, ModuleRuntimeKind, ModuleSource};

fn test_paths(temporary: &TempDir) -> ShipctlPaths {
    ShipctlPaths::new(
        temporary.path().join("state"),
        temporary.path().join("runtime"),
    )
}

fn artifact(module_id: &str, marker: char) -> ModuleIdentity {
    ModuleIdentity {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        id: module_id.to_string(),
        version: "1.0.0".to_string(),
        content_digest: marker.to_string().repeat(64),
        runtime_kind: ModuleRuntimeKind::FrontendEsm,
    }
}

fn mutation(
    instance_id: Uuid,
    request_id: Uuid,
    artifact: &ModuleIdentity,
    enabled: bool,
    configuration_revision: u64,
) -> RegistryMutation {
    RegistryMutation {
        request_id,
        module_id: artifact.id.clone(),
        instance_id,
        kind: if enabled {
            ModuleOperationKind::Enable
        } else {
            ModuleOperationKind::Disable
        },
        artifacts: vec![ArtifactAcquisition {
            identity: artifact.clone(),
            source: ModuleSource::User,
        }],
        desired: Some(DesiredModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: artifact.id.clone(),
            selected_artifact: Some(artifact.clone()),
            enabled,
            configuration_revision,
        }),
        observations: vec![ObservedModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: artifact.id.clone(),
            instance_id,
            artifact: Some(artifact.clone()),
            applied_registry_revision: configuration_revision.saturating_sub(1),
            lifecycle: if enabled {
                ModuleLifecycleState::Active
            } else {
                ModuleLifecycleState::Disabled
            },
            module_instance_id: Some("frontend".to_string()),
        }],
    }
}

fn static_inventory(provenance: &str, marker: char) -> StaticBuildInventory {
    StaticBuildInventory {
        build_provenance: provenance.to_string(),
        modules: vec![StaticModuleRecord {
            identity: ModuleIdentity {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                id: "shipctl.static".to_string(),
                version: "1.0.0".to_string(),
                content_digest: marker.to_string().repeat(64),
                runtime_kind: ModuleRuntimeKind::StaticBuiltin,
            },
            source: ModuleSource::Bundled,
            build_provenance: provenance.to_string(),
            native_compiled: true,
            frontend_shipped: true,
            lifecycle: ModuleLifecycleState::RestartRequired,
            live_loadable: false,
        }],
    }
}

fn message_contract(id: &str) -> MessageTypeContract {
    let path = format!("messages/schemas/{}.json", id.replace('.', "-"));
    MessageTypeContract {
        message: MessageTypeId {
            id: id.to_string(),
            version: 1,
        },
        schema: MessageSchemaDescriptor {
            draft: "https://json-schema.org/draft/2020-12/schema".to_string(),
            root: path.clone(),
            resources: BTreeMap::from([(
                path.clone(),
                json!({
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$id": format!("shipctl-artifact:///{path}"),
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["value"],
                    "properties": {"value": {"type": "string"}}
                }),
            )]),
            max_encoded_bytes: 128,
            redacted_fields: Vec::new(),
            compatible_versions: vec![1],
        },
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Build one fully inspected archive rather than synthesizing an unchecked
/// `ValidatedRuntimeArtifact`. This keeps registry tests at the admission
/// boundary while still exercising only the registry's persistence behavior.
fn runtime_artifact(
    module_id: &str,
    capability_id: &str,
    variant: &str,
    provenance: Option<&str>,
) -> ValidatedRuntimeArtifact {
    let request = message_contract(&format!("{module_id}.request"));
    let response = message_contract(&format!("{module_id}.response"));
    let event = message_contract(&format!("{module_id}.event"));
    let port_id = format!("{capability_id}.port-{variant}");
    let event_id = format!("{capability_id}.event-{variant}");
    let topic_id = format!("{capability_id}.topic-{variant}");
    let mut definition = CapabilityDefinition {
        id: capability_id.to_string(),
        version: "1.0.0".to_string(),
        definition_digest_sha256: String::new(),
        schemas: vec![request.clone(), response.clone(), event.clone()],
        ports: vec![CapabilityPortDefinition {
            id: port_id.clone(),
            kind: CapabilityPortKind::Query,
            request: request.message.clone(),
            response: response.message.clone(),
        }],
        events: vec![crate::module_control::artifact::CapabilityEventDefinition {
            id: event_id.clone(),
            message: event.message.clone(),
        }],
        topics: vec![CapabilityTopicDefinition {
            id: topic_id.clone(),
            event_id: event_id.clone(),
            message: event.message.clone(),
        }],
        streams: Vec::new(),
        provider_cardinality: CapabilityProviderCardinality::Multiple,
        selection: CapabilityProviderSelection::All,
        scopes: vec![CapabilityScope::Instance],
        agent_access: CapabilityAgentAccess {
            inspect: true,
            invoke: vec![port_id.clone()],
            watch: CapabilityAgentWatchAccess {
                events: vec![event_id.clone()],
                topics: vec![topic_id.clone()],
            },
            attach: Vec::new(),
        },
    };
    definition.definition_digest_sha256 = definition.calculated_digest_sha256().unwrap();
    let binding_surfaces = CapabilitySurfaceBinding {
        ports: vec![port_id.clone()],
        events: vec![event_id],
        topics: vec![topic_id.clone()],
        streams: Vec::new(),
    };
    let capabilities = CapabilityManifest {
        schema_version: CAPABILITY_CONTRACT_SCHEMA_VERSION,
        definitions: vec![definition.clone()],
        providers: vec![CapabilityProviderBinding {
            capability: definition.reference(),
            surfaces: binding_surfaces.clone(),
            scopes: vec![CapabilityScope::Instance],
            priority: None,
        }],
        consumers: vec![CapabilityConsumerBinding {
            capability: definition.reference(),
            surfaces: binding_surfaces,
            scopes: vec![CapabilityScope::Instance],
        }],
    };
    let messages = MessageDeclarations {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        provides: definition.schemas.clone(),
        handles: Vec::new(),
        publishes: vec![BroadcastTopicDeclaration {
            endpoint: RouteEndpointRef {
                id: topic_id.clone(),
                message: event.message.clone(),
            },
            capacity: 1,
            required_grant: format!("message.publish.{topic_id}"),
            scheduler_allowed: false,
        }],
        subscribes: Vec::new(),
        ports: vec![CapabilityPortDeclaration {
            id: port_id.clone(),
            request: request.message.clone(),
            response: response.message.clone(),
            capacity: 1,
            required_grant: format!("message.request.{port_id}"),
            scheduler_allowed: false,
        }],
    };
    let manifest_value = json!({
        "schemaVersion": ARTIFACT_CONTRACT_SCHEMA_VERSION,
        "id": module_id,
        "name": format!("{module_id} fixture"),
        "version": "1.0.0",
        "apiRange": "^1.0.0",
        "runtimeKind": "frontend_esm",
        "entry": "dist/index.js",
        "styles": ["styles/fixture.css"],
        "assets": ["assets/fixture.txt"],
        "messages": messages,
        "capabilities": capabilities,
        "uiContributions": [],
        "requestedGrants": [],
        "nativeAdapters": [],
        "peerDependencies": {},
        "supportedScopes": ["instance"],
        "lifecycle": "live",
        "sourceProvenance": provenance,
    });
    // Keep the raw source provenance in module.yaml. The typed public
    // serializer intentionally removes it, so a source-only difference can
    // prove the registry's canonical identity rule below.
    let manifest: RuntimeArtifactManifest = serde_json::from_value(manifest_value.clone()).unwrap();
    let manifest_yaml = serde_yaml::to_string(&manifest_value).unwrap().into_bytes();

    let mut files = BTreeMap::from([
        ("assets/fixture.txt".to_string(), b"fixture asset".to_vec()),
        (
            "dist/index.js".to_string(),
            format!("export const fixture = {variant:?};").into_bytes(),
        ),
        (
            "styles/fixture.css".to_string(),
            b".fixture { display: block; }".to_vec(),
        ),
    ]);
    for contract in &definition.schemas {
        for (path, schema) in &contract.schema.resources {
            files.insert(path.clone(), serde_json::to_vec(schema).unwrap());
        }
    }
    files.insert(
        format!("capabilities/{}.json", definition.id),
        serde_json::to_vec(&definition).unwrap(),
    );
    files.insert("module.yaml".to_string(), manifest_yaml);
    let integrity_files = files
        .iter()
        .map(|(path, contents)| ArtifactIntegrityFile {
            path: path.clone(),
            digest_sha256: sha256_hex(contents),
        })
        .collect::<Vec<_>>();
    let content_digest = canonical_content_digest(&manifest, &integrity_files).unwrap();
    let integrity = ArtifactIntegrityIndex {
        schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
        files: integrity_files,
        content_digest_sha256: content_digest,
    };
    files.insert(
        "integrity.json".to_string(),
        serde_json::to_vec(&integrity).unwrap(),
    );
    RuntimeArtifactArchive::new(files)
        .unwrap()
        .preflight(&Default::default())
        .unwrap()
}

fn create_v1_registry(path: &std::path::Path, artifact: &ModuleIdentity) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE registry_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO registry_metadata(key, value) VALUES ('current_revision', '0');
            CREATE TABLE registry_revisions(
                revision INTEGER PRIMARY KEY CHECK(revision > 0),
                change_kind TEXT NOT NULL,
                request_id TEXT UNIQUE
            );
            CREATE TABLE artifacts(
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                identity_json TEXT NOT NULL,
                PRIMARY KEY(module_id, content_digest)
            );
            CREATE TABLE artifact_sources(
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                source TEXT NOT NULL,
                PRIMARY KEY(module_id, content_digest, source),
                FOREIGN KEY(module_id, content_digest)
                    REFERENCES artifacts(module_id, content_digest)
            );
            CREATE TABLE desired_state(
                module_id TEXT PRIMARY KEY,
                selected_artifact_digest TEXT,
                configuration_revision INTEGER NOT NULL CHECK(configuration_revision >= 0),
                state_json TEXT NOT NULL,
                FOREIGN KEY(module_id, selected_artifact_digest)
                    REFERENCES artifacts(module_id, content_digest)
            );
            CREATE TABLE operations(
                request_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL UNIQUE,
                instance_id TEXT NOT NULL,
                module_id TEXT NOT NULL,
                operation_json TEXT NOT NULL,
                FOREIGN KEY(revision) REFERENCES registry_revisions(revision)
            );
            CREATE TABLE observations(
                instance_id TEXT NOT NULL,
                module_id TEXT NOT NULL,
                observation_key TEXT NOT NULL,
                artifact_digest TEXT,
                applied_registry_revision INTEGER NOT NULL CHECK(applied_registry_revision >= 0),
                state_json TEXT NOT NULL,
                PRIMARY KEY(instance_id, module_id, observation_key),
                FOREIGN KEY(module_id, artifact_digest)
                    REFERENCES artifacts(module_id, content_digest)
            );
            CREATE TABLE static_inventory(
                module_id TEXT PRIMARY KEY,
                identity_digest TEXT NOT NULL,
                build_provenance TEXT NOT NULL,
                native_compiled INTEGER NOT NULL CHECK(native_compiled IN (0, 1)),
                frontend_shipped INTEGER NOT NULL CHECK(frontend_shipped IN (0, 1)),
                record_json TEXT NOT NULL,
                FOREIGN KEY(module_id, identity_digest)
                    REFERENCES artifacts(module_id, content_digest)
            );
            PRAGMA user_version = 1;
            ",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO artifacts(module_id, content_digest, identity_json)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                artifact.id,
                artifact.content_digest,
                serde_json::to_string(artifact).unwrap(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO artifact_sources(module_id, content_digest, source)
             VALUES (?1, ?2, 'user')",
            rusqlite::params![artifact.id, artifact.content_digest],
        )
        .unwrap();
}

#[test]
fn v1_registry_migrates_additively_to_runtime_catalog_v2() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    std::fs::create_dir_all(&paths.state_root).unwrap();
    let legacy_artifact = artifact("example.legacy", 'a');
    create_v1_registry(&paths.module_registry_database, &legacy_artifact);

    let registry = ModuleRegistry::open_writable(&paths).unwrap();
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.registry_revision, 0);
    assert_eq!(snapshot.artifacts.len(), 1);
    assert_eq!(snapshot.artifacts[0].identity, legacy_artifact);
    assert!(snapshot.runtime_artifacts.is_empty());
    assert_eq!(
        snapshot.capability_catalog,
        CapabilityCatalogSnapshot::default()
    );
    drop(registry);

    let connection = Connection::open(&paths.module_registry_database).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, REGISTRY_SCHEMA_VERSION);
    let catalog_tables: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE type = 'table' AND name IN (
                'runtime_artifact_catalog', 'capability_definitions',
                'artifact_capability_bindings', 'artifact_install_requests',
                'pending_artifact_installs'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(catalog_tables, 5);
}

#[test]
fn disabled_runtime_artifact_registration_is_typed_atomic_and_idempotent() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let candidate = runtime_artifact(
        "fixture.registry",
        "fixture.registry-capability",
        "first",
        None,
    );
    let capability = candidate.manifest.capabilities.definitions[0].reference();
    let registration = RuntimeArtifactRegistration {
        request_id: Uuid::new_v4(),
        artifact: candidate.clone(),
        source: ModuleSource::User,
    };

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    let receipt = registry.register_disabled_artifact(&registration).unwrap();
    assert!(receipt.changed);
    assert_eq!(receipt.registry_revision, 1);
    assert!(receipt.selected_by_install);
    let desired = receipt.desired.as_ref().unwrap();
    assert!(!desired.enabled);
    assert_eq!(
        desired.selected_artifact.as_ref(),
        Some(&candidate.identity())
    );

    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.registry_revision, 1);
    assert_eq!(snapshot.operations, Vec::new());
    assert_eq!(snapshot.observations, Vec::new());
    assert_eq!(snapshot.runtime_artifacts.len(), 1);
    assert_eq!(snapshot.runtime_artifacts[0].artifact, candidate);
    assert_eq!(
        snapshot.runtime_artifacts[0].sources,
        vec![ModuleSource::User]
    );
    assert_eq!(snapshot.capability_catalog.definitions.len(), 1);
    assert_eq!(snapshot.capability_catalog.bindings.len(), 2);
    assert_eq!(
        registry.capability_definition(&capability).unwrap(),
        Some(snapshot.capability_catalog.definitions[0].clone())
    );
    assert_eq!(registry.capability_bindings(&capability).unwrap().len(), 2);
    assert!(registry
        .capability_definition_index()
        .unwrap()
        .get(&capability)
        .is_some());

    let replay = registry.register_disabled_artifact(&registration).unwrap();
    assert_eq!(replay, receipt);
    assert_eq!(registry.revision().unwrap(), 1);
    assert_eq!(registry.snapshot().unwrap(), snapshot);
}

#[test]
fn failed_disabled_artifact_registration_rolls_back_the_entire_catalog_write() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let candidate = runtime_artifact("fixture.atomic", "fixture.atomic-capability", "first", None);
    let registration = RuntimeArtifactRegistration {
        request_id: Uuid::new_v4(),
        artifact: candidate,
        source: ModuleSource::User,
    };

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    let connection = Connection::open(registry.path()).unwrap();
    connection
        .execute_batch(
            "
            CREATE TRIGGER reject_artifact_install_receipt
            BEFORE INSERT ON artifact_install_requests
            BEGIN
                SELECT RAISE(ABORT, 'injected artifact receipt failure');
            END;
            ",
        )
        .unwrap();
    drop(connection);

    let error = registry
        .register_disabled_artifact(&registration)
        .unwrap_err();
    assert_eq!(error.code, REGISTRY_TRANSACTION_FAILED);
    assert_eq!(registry.revision().unwrap(), 0);

    let snapshot = registry.snapshot().unwrap();
    assert!(snapshot.artifacts.is_empty());
    assert!(snapshot.desired.is_empty());
    assert!(snapshot.runtime_artifacts.is_empty());
    assert!(snapshot.capability_catalog.is_empty());
    assert_eq!(
        registry
            .pending_artifact_install(registration.request_id)
            .unwrap(),
        PendingArtifactInstallResolution::Absent
    );
}

#[test]
fn pending_registration_accepts_provenance_only_archive_difference() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let staged = runtime_artifact(
        "fixture.provenance",
        "fixture.provenance-capability",
        "same",
        Some("builder-a"),
    );
    let published = runtime_artifact(
        "fixture.provenance",
        "fixture.provenance-capability",
        "same",
        Some("builder-b"),
    );
    assert_ne!(staged, published);
    assert_eq!(staged.identity(), published.identity());
    assert_eq!(staged.canonical_metadata(), published.canonical_metadata());

    let request_id = Uuid::new_v4();
    let intent = PendingArtifactInstall {
        schema_version: RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION,
        request_id,
        artifact: staged,
        source: ModuleSource::User,
        stage_id: Uuid::new_v4().to_string(),
    };
    let registration = RuntimeArtifactRegistration {
        request_id,
        artifact: published,
        source: ModuleSource::User,
    };

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    assert_eq!(
        registry.begin_pending_artifact_install(&intent).unwrap(),
        PendingArtifactInstallResolution::Pending(intent.clone())
    );
    let receipt = registry
        .finalize_pending_disabled_artifact(&registration)
        .unwrap();
    assert!(receipt.changed);
    assert_eq!(receipt.registry_revision, 1);
    assert_eq!(
        registry.pending_artifact_install(request_id).unwrap(),
        PendingArtifactInstallResolution::Installed(receipt)
    );
    assert!(registry.pending_artifact_installs().unwrap().is_empty());
}

#[test]
fn runtime_identity_and_capability_definition_conflicts_leave_catalog_unchanged() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let runtime_first = runtime_artifact(
        "fixture.runtime",
        "fixture.runtime-capability",
        "first",
        None,
    );
    let runtime_conflict = runtime_artifact(
        "fixture.runtime",
        "fixture.runtime-capability",
        "second",
        None,
    );
    let capability_first = runtime_artifact(
        "fixture.capability-one",
        "fixture.shared-capability",
        "first",
        None,
    );
    let capability_conflict = runtime_artifact(
        "fixture.capability-two",
        "fixture.shared-capability",
        "second",
        None,
    );

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: runtime_first,
            source: ModuleSource::User,
        })
        .unwrap();
    let runtime_error = registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: runtime_conflict,
            source: ModuleSource::User,
        })
        .unwrap_err();
    assert_eq!(runtime_error.code, REGISTRY_ARTIFACT_IMMUTABLE);
    assert_eq!(registry.revision().unwrap(), 1);

    registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: capability_first,
            source: ModuleSource::User,
        })
        .unwrap();
    let capability_error = registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: capability_conflict,
            source: ModuleSource::User,
        })
        .unwrap_err();
    assert_eq!(capability_error.code, REGISTRY_ARTIFACT_IMMUTABLE);
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.registry_revision, 2);
    assert_eq!(snapshot.runtime_artifacts.len(), 2);
    assert_eq!(snapshot.capability_catalog.definitions.len(), 2);
}

#[test]
fn commit_reopen_and_duplicate_request_preserve_one_complete_revision() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    let artifact = artifact("example.module", 'a');
    let mutation = mutation(instance_id, request_id, &artifact, true, 1);

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    let operation = registry.commit(&mutation).unwrap();
    let replay = registry.commit(&mutation).unwrap();
    assert_eq!(operation, replay);
    assert_eq!(registry.revision().unwrap(), 1);
    drop(registry);

    let registry = ModuleRegistry::open_read_only(&paths).unwrap();
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.registry_path, paths.module_registry_database);
    assert_eq!(snapshot.registry_revision, 1);
    assert_eq!(
        snapshot.artifacts,
        vec![RegisteredArtifact {
            identity: artifact,
            sources: vec![ModuleSource::User],
        }]
    );
    assert_eq!(snapshot.desired, vec![mutation.desired.unwrap()]);
    assert_eq!(snapshot.operations, vec![operation]);
    assert_eq!(snapshot.observations, mutation.observations);
}

#[test]
fn failed_write_rolls_back_every_record_and_revision() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let first_artifact = artifact("example.module", 'a');
    let mut second_artifact = artifact("example.module", 'b');
    second_artifact.version = "2.0.0".to_string();

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .commit(&mutation(
            instance_id,
            Uuid::new_v4(),
            &first_artifact,
            true,
            1,
        ))
        .unwrap();
    let before = registry.snapshot().unwrap();
    let error = registry
        .commit_with_failure(&mutation(
            instance_id,
            Uuid::new_v4(),
            &second_artifact,
            false,
            2,
        ))
        .unwrap_err();
    assert_eq!(error.code, REGISTRY_TRANSACTION_FAILED);
    drop(registry);

    let after = ModuleRegistry::open_read_only(&paths)
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn failed_migration_transaction_preserves_the_readable_prior_registry() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let artifact = artifact("example.module", 'a');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, true, 1))
        .unwrap();
    let before = registry.snapshot().unwrap();

    let error = registry.migration_failure_probe().unwrap_err();
    assert_eq!(error.code, REGISTRY_MIGRATION_FAILED);
    drop(registry);

    let connection = Connection::open(&paths.module_registry_database).unwrap();
    let staged: i64 = connection
        .query_row(
            "SELECT count(*) FROM registry_metadata WHERE key = 'migration_probe'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(staged, 0);
    drop(connection);
    let after = ModuleRegistry::open_read_only(&paths)
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn read_only_open_does_not_create_or_modify_registry_files() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let absent = diagnose_registry(&paths.module_registry_database);
    assert_eq!(absent[0].code, REGISTRY_ABSENT);
    assert!(!paths.module_registry_database.exists());

    let registry = ModuleRegistry::open_writable(&paths).unwrap();
    drop(registry);
    let bytes = fs::read(&paths.module_registry_database).unwrap();
    let entries = fs::read_dir(paths.state_root.clone())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();

    let registry = ModuleRegistry::open_read_only(&paths).unwrap();
    assert_eq!(registry.snapshot().unwrap().registry_revision, 0);
    drop(registry);
    assert_eq!(fs::read(&paths.module_registry_database).unwrap(), bytes);
    assert_eq!(
        fs::read_dir(paths.state_root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>(),
        entries
    );
}

#[test]
fn diagnostics_identify_schema_revision_artifact_and_journal_failures() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let artifact = artifact("example.module", 'a');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, true, 1))
        .unwrap();
    drop(registry);
    assert_eq!(
        diagnose_registry(&paths.module_registry_database)[0].code,
        REGISTRY_HEALTHY
    );

    let connection = Connection::open(&paths.module_registry_database).unwrap();
    connection
        .execute(
            "UPDATE registry_metadata SET value = '2' WHERE key = 'current_revision'",
            [],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        diagnose_registry(&paths.module_registry_database)[0].code,
        REGISTRY_REVISION_DISCONTINUOUS
    );

    let connection = Connection::open(&paths.module_registry_database).unwrap();
    connection
        .execute(
            "UPDATE registry_metadata SET value = '1' WHERE key = 'current_revision'",
            [],
        )
        .unwrap();
    connection.execute("PRAGMA foreign_keys = OFF", []).unwrap();
    connection.execute("DELETE FROM artifacts", []).unwrap();
    drop(connection);
    assert_eq!(
        diagnose_registry(&paths.module_registry_database)[0].code,
        REGISTRY_ARTIFACT_REFERENCE_MISSING
    );

    let journal_temporary = TempDir::new().unwrap();
    let journal_paths = test_paths(&journal_temporary);
    let mut registry = ModuleRegistry::open_writable(&journal_paths).unwrap();
    registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, true, 1))
        .unwrap();
    drop(registry);
    let connection = Connection::open(&journal_paths.module_registry_database).unwrap();
    connection
        .execute("UPDATE operations SET module_id = 'different.module'", [])
        .unwrap();
    drop(connection);
    assert_eq!(
        diagnose_registry(&journal_paths.module_registry_database)[0].code,
        REGISTRY_JOURNAL_INCONSISTENT
    );

    let schema_temporary = TempDir::new().unwrap();
    let schema_paths = test_paths(&schema_temporary);
    drop(ModuleRegistry::open_writable(&schema_paths).unwrap());
    let connection = Connection::open(&schema_paths.module_registry_database).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert_eq!(
        diagnose_registry(&schema_paths.module_registry_database)[0].code,
        REGISTRY_SCHEMA_UNSUPPORTED
    );
}

#[test]
fn artifact_identity_provenance_and_configuration_revisions_are_enforced() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let artifact = artifact("example.module", 'a');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, true, 1))
        .unwrap();

    let mut second_source = mutation(instance_id, Uuid::new_v4(), &artifact, false, 2);
    second_source.artifacts[0].source = ModuleSource::Development;
    registry.commit(&second_source).unwrap();
    assert_eq!(registry.revision().unwrap(), 2);
    assert_eq!(
        registry.snapshot().unwrap().artifacts[0].sources,
        vec![ModuleSource::Development, ModuleSource::User]
    );

    let mut changed_identity = artifact.clone();
    changed_identity.version = "2.0.0".to_string();
    let immutable_error = registry
        .commit(&mutation(
            instance_id,
            Uuid::new_v4(),
            &changed_identity,
            true,
            3,
        ))
        .unwrap_err();
    assert_eq!(immutable_error.code, REGISTRY_ARTIFACT_IMMUTABLE);
    assert_eq!(registry.revision().unwrap(), 2);

    let revision_error = registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, false, 4))
        .unwrap_err();
    assert_eq!(revision_error.code, REGISTRY_REVISION_DISCONTINUOUS);
    assert_eq!(registry.revision().unwrap(), 2);
}

#[test]
fn static_inventory_seed_is_idempotent_and_preserves_user_state_and_journal() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let user_artifact = artifact("example.module", 'a');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    let operation = registry
        .commit(&mutation(
            instance_id,
            Uuid::new_v4(),
            &user_artifact,
            true,
            1,
        ))
        .unwrap();
    let desired = registry.snapshot().unwrap().desired;

    let inventory = static_inventory("shipctl-ui:1.0.0:native+frontend", 'b');
    let first = registry.seed_static_inventory(&inventory).unwrap();
    let second = registry.seed_static_inventory(&inventory).unwrap();
    assert!(first.changed);
    assert_eq!(first.registry_revision, 2);
    assert_eq!(
        second,
        InventorySeedResult {
            registry_revision: 2,
            changed: false,
        }
    );
    drop(registry);

    let registry = ModuleRegistry::open_read_only(&paths).unwrap();
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(snapshot.registry_revision, 2);
    assert_eq!(
        snapshot.static_build_provenance.as_deref(),
        Some("shipctl-ui:1.0.0:native+frontend")
    );
    assert_eq!(snapshot.static_inventory, inventory.modules);
    assert_eq!(snapshot.desired, desired);
    assert_eq!(snapshot.operations, vec![operation]);
    assert!(registry.static_inventory_diagnostics(&inventory).is_empty());
}

#[test]
fn static_inventory_diagnostics_distinguish_absent_stale_and_mismatched_data() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let expected = static_inventory("shipctl-ui:1.0.0", 'c');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    assert_eq!(
        registry.static_inventory_diagnostics(&expected)[0].code,
        REGISTRY_INVENTORY_ABSENT
    );

    registry
        .seed_static_inventory(&static_inventory("shipctl-ui:0.9.0", 'b'))
        .unwrap();
    assert_eq!(
        registry.static_inventory_diagnostics(&expected)[0].code,
        REGISTRY_INVENTORY_STALE
    );

    let connection = Connection::open(&paths.module_registry_database).unwrap();
    connection
        .execute(
            "UPDATE registry_metadata SET value = ?1 WHERE key = 'static_build_provenance'",
            [expected.build_provenance.as_str()],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        registry.static_inventory_diagnostics(&expected)[0].code,
        REGISTRY_INVENTORY_MISMATCH
    );
}
