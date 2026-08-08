use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use shipctl_core::module_control::{
    BuildModuleMembership, DesiredModuleState, ModuleIdentity, ModuleLifecycleState,
    ModuleOperationKind, ModuleRegistry, ModuleRuntimeKind, ModuleSource, ObservedModuleState,
    RegistryMutation, StaticBuildInventory, VerificationExpectation, MODULE_CONTROL_SCHEMA_VERSION,
};
use shipctl_core::state::paths::ShipctlPaths;
use uuid::Uuid;

const MODULE_ID: &str = "example.module";
const INSTANCE_ID: &str = "00000000-0000-0000-0000-000000000101";
const REQUEST_ID: &str = "00000000-0000-0000-0000-000000000102";

#[test]
fn compiled_cli_inspects_and_verifies_registry_without_writes_or_runtime_discovery() {
    let root = unique_root("offline-modules");
    let state_root = root.join("state");
    let runtime_sentinel = root.join("runtime-must-not-exist");
    let paths = ShipctlPaths::new(state_root.clone(), runtime_sentinel.clone());
    let instance_id = Uuid::parse_str(INSTANCE_ID).unwrap();
    let artifact = artifact();
    seed_registry(&paths, instance_id, &artifact);
    let matching = root.join("matching.json");
    let mismatching = root.join("mismatching.json");
    write_expectation(&matching, instance_id, true, &artifact);
    write_expectation(&mismatching, instance_id, false, &artifact);

    let before_database = fs::read(&paths.module_registry_database).unwrap();
    let before_entries = directory_entries(&state_root);

    let list_json = run(
        &state_root,
        &runtime_sentinel,
        &["modules", "list", "--offline", "--output", "json"],
    );
    assert_success(&list_json);
    let list_value: Value = serde_json::from_slice(&list_json.stdout).unwrap();
    assert_eq!(list_value["operation"], "modules.list");
    assert_eq!(list_value["data"]["runtimeAvailable"], false);
    assert_eq!(list_value["data"]["count"], 2);

    let list_toon = run(
        &state_root,
        &runtime_sentinel,
        &["modules", "list", "--offline", "--output", "toon"],
    );
    assert_success(&list_toon);
    let toon_value: Value =
        toon_format::decode_default(std::str::from_utf8(&list_toon.stdout).unwrap()).unwrap();
    assert_eq!(toon_value, list_value);

    let inspection = run(
        &state_root,
        &runtime_sentinel,
        &[
            "modules",
            "inspect",
            MODULE_ID,
            "--offline",
            "--output",
            "json",
        ],
    );
    assert_success(&inspection);
    let inspection: Value = serde_json::from_slice(&inspection.stdout).unwrap();
    assert_eq!(inspection["data"]["desired"][0]["enabled"], true);
    assert_eq!(
        inspection["data"]["lastReportedObservations"][0]["lifecycle"],
        "active"
    );

    let diagnosis = run(
        &state_root,
        &runtime_sentinel,
        &["modules", "diagnose", "--offline", "--output", "json"],
    );
    assert_success(&diagnosis);
    let diagnosis: Value = serde_json::from_slice(&diagnosis.stdout).unwrap();
    assert_eq!(diagnosis["data"]["healthy"], true);
    assert_eq!(
        diagnosis["data"]["diagnostics"][0]["evidence"]["fields"]["integrity"],
        "passed"
    );
    assert_eq!(
        diagnosis["data"]["diagnostics"][0]["evidence"]["fields"]["operationJournal"],
        "passed"
    );

    let matched = run_with_expectation(&state_root, &runtime_sentinel, &matching, "json");
    assert_success(&matched);
    let matched: Value = serde_json::from_slice(&matched.stdout).unwrap();
    assert_eq!(matched["data"]["matched"], true);

    let mismatched = run_with_expectation(&state_root, &runtime_sentinel, &mismatching, "json");
    assert!(!mismatched.status.success());
    assert!(mismatched.stderr.is_empty());
    let mismatched: Value = serde_json::from_slice(&mismatched.stdout).unwrap();
    assert_eq!(mismatched["status"], "error");
    assert_eq!(
        mismatched["code"],
        "module.verification.expectation_mismatch"
    );
    assert_eq!(mismatched["data"]["matched"], false);

    assert_eq!(
        fs::read(&paths.module_registry_database).unwrap(),
        before_database
    );
    assert_eq!(directory_entries(&state_root), before_entries);
    assert!(!runtime_sentinel.exists());

    prove_corruption_is_structured(&root, &runtime_sentinel);
    fs::remove_dir_all(root).unwrap();
}

fn seed_registry(paths: &ShipctlPaths, instance_id: Uuid, artifact: &ModuleIdentity) {
    let mut registry = ModuleRegistry::open_writable(paths).unwrap();
    registry
        .commit(&RegistryMutation {
            request_id: Uuid::parse_str(REQUEST_ID).unwrap(),
            module_id: MODULE_ID.to_string(),
            instance_id,
            kind: ModuleOperationKind::Enable,
            artifacts: vec![artifact.clone()],
            desired: Some(DesiredModuleState {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                module_id: MODULE_ID.to_string(),
                instance_id,
                selected_artifact: Some(artifact.clone()),
                enabled: true,
                configuration_revision: 1,
            }),
            observations: vec![ObservedModuleState {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                module_id: MODULE_ID.to_string(),
                instance_id,
                artifact: Some(artifact.clone()),
                applied_registry_revision: 0,
                lifecycle: ModuleLifecycleState::Active,
                module_instance_id: Some("frontend-fixture".to_string()),
            }],
        })
        .unwrap();
    let inventory = StaticBuildInventory::from_build_composition(
        "shipctl-ui:fixture",
        "1.0.0",
        vec![BuildModuleMembership {
            module_id: "shipctl.static".to_string(),
            native_compiled: true,
            frontend_shipped: true,
        }],
    )
    .unwrap();
    registry.seed_static_inventory(&inventory).unwrap();
}

fn artifact() -> ModuleIdentity {
    ModuleIdentity {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        id: MODULE_ID.to_string(),
        version: "1.0.0".to_string(),
        content_digest: "a".repeat(64),
        source: ModuleSource::User,
        runtime_kind: ModuleRuntimeKind::FrontendEsm,
    }
}

fn write_expectation(
    path: &Path,
    instance_id: Uuid,
    expected_enabled: bool,
    artifact: &ModuleIdentity,
) {
    let expectation = VerificationExpectation {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        fixture_id: "offline-cli-fixture".to_string(),
        module_id: MODULE_ID.to_string(),
        instance_id,
        expected_enabled: Some(expected_enabled),
        expected_artifact_digest: Some(artifact.content_digest.clone()),
        expected_configuration_revision: Some(1),
        expected_applied_registry_revision: Some(0),
        expected_lifecycle: Some(ModuleLifecycleState::Active),
        expected_diagnostic_codes: Vec::new(),
    };
    fs::write(path, serde_json::to_vec_pretty(&expectation).unwrap()).unwrap();
}

fn run_with_expectation(
    state_root: &Path,
    runtime_sentinel: &Path,
    expectation: &Path,
    output: &str,
) -> Output {
    let expectation = expectation.to_str().unwrap();
    run(
        state_root,
        runtime_sentinel,
        &[
            "modules",
            "verify",
            MODULE_ID,
            "--offline",
            "--expect",
            expectation,
            "--output",
            output,
        ],
    )
}

fn run(state_root: &Path, runtime_sentinel: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args(args)
        .args(["--state-root", state_root.to_str().unwrap()])
        .env("SHIPCTL_RUNTIME_DIR", runtime_sentinel)
        .output()
        .unwrap()
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "shipctl failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
}

fn prove_corruption_is_structured(root: &Path, runtime_sentinel: &Path) {
    let corrupt_state = root.join("corrupt-state");
    fs::create_dir_all(&corrupt_state).unwrap();
    fs::write(corrupt_state.join("module-registry.sqlite3"), b"not sqlite").unwrap();
    let output = run(
        &corrupt_state,
        runtime_sentinel,
        &["modules", "diagnose", "--offline", "--output", "json"],
    );
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "error");
    assert_eq!(value["data"]["healthy"], false);
    assert!(value["data"]["diagnostics"][0]["code"]
        .as_str()
        .unwrap()
        .starts_with("module.registry."));
}

fn directory_entries(path: &Path) -> Vec<PathBuf> {
    let mut entries = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn unique_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "shipctl-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ))
}
