use std::fs;

use rusqlite::Connection;
use tempfile::TempDir;

use super::*;
use crate::module_control::{
    ModuleLifecycleState, ModuleRuntimeKind, ModuleSource, REGISTRY_HEALTHY,
};

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
        source: ModuleSource::User,
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
        artifacts: vec![artifact.clone()],
        desired: Some(DesiredModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: artifact.id.clone(),
            instance_id,
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
                source: ModuleSource::Bundled,
                runtime_kind: ModuleRuntimeKind::StaticBuiltin,
            },
            build_provenance: provenance.to_string(),
            native_compiled: true,
            frontend_shipped: true,
            lifecycle: ModuleLifecycleState::RestartRequired,
            live_loadable: false,
        }],
    }
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
    assert_eq!(snapshot.artifacts, vec![artifact]);
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
    let second_artifact = artifact("example.module", 'b');

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
fn immutable_artifacts_and_configuration_revisions_are_enforced() {
    let temporary = TempDir::new().unwrap();
    let paths = test_paths(&temporary);
    let instance_id = Uuid::new_v4();
    let artifact = artifact("example.module", 'a');
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, true, 1))
        .unwrap();

    let mut changed_provenance = artifact.clone();
    changed_provenance.source = ModuleSource::Development;
    let immutable_error = registry
        .commit(&mutation(
            instance_id,
            Uuid::new_v4(),
            &changed_provenance,
            false,
            2,
        ))
        .unwrap_err();
    assert_eq!(immutable_error.code, REGISTRY_ARTIFACT_IMMUTABLE);
    assert_eq!(registry.revision().unwrap(), 1);

    let revision_error = registry
        .commit(&mutation(instance_id, Uuid::new_v4(), &artifact, false, 3))
        .unwrap_err();
    assert_eq!(revision_error.code, REGISTRY_REVISION_DISCONTINUOUS);
    assert_eq!(registry.revision().unwrap(), 1);
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
