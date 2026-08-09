use std::collections::BTreeMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shipctl_core::message_bus::{
    BroadcastTopicDeclaration, CapabilityPortDeclaration, DirectedChannelDeclaration,
    MessageDeclarations, MessageSchemaDescriptor, MessageTypeContract, MessageTypeId,
    RouteEndpointRef, MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::module_control::artifact::{
    canonical_content_digest, ArtifactIntegrityFile, ArtifactIntegrityIndex, CapabilityAgentAccess,
    CapabilityAgentWatchAccess, CapabilityConsumerBinding, CapabilityDefinition,
    CapabilityEventDefinition, CapabilityManifest, CapabilityPortDefinition, CapabilityPortKind,
    CapabilityProviderBinding, CapabilityProviderCardinality, CapabilityProviderSelection,
    CapabilityScope, CapabilityStreamDefinition, CapabilitySurfaceBinding,
    CapabilityTopicDefinition, RuntimeArtifactArchive, RuntimeArtifactManifest,
    RuntimeUiContribution, ARTIFACT_CONTRACT_SCHEMA_VERSION, ARTIFACT_INTEGRITY_PATH,
    ARTIFACT_MANIFEST_PATH, CAPABILITY_CONTRACT_SCHEMA_VERSION,
};
use uuid::Uuid;

const A_MODULE: &str = "fixture.runtime-a";
const A_CAPABILITY: &str = "fixture.runtime-a-capability";
const B_MODULE: &str = "fixture.runtime-b";
const B_CAPABILITY: &str = "fixture.runtime-b-capability";

/// This is the Phase 3 public boundary: it deliberately starts from a real
/// archive, uses only the compiled CLI, and never seeds a registry or asks for
/// runtime activation.
#[test]
fn compiled_cli_admits_disabled_runtime_artifacts_and_rejects_unsafe_candidates() {
    let root = unique_root("runtime-artifact-cli");
    let archive_root = root.join("archives");
    let state_root = root.join("state");
    let runtime_sentinel = root.join("runtime-must-not-exist");
    fs::create_dir_all(&archive_root).unwrap();
    let compatible_api_range = format!("^{}", shipctl_cli::APP_VERSION);

    let artifact_a = fixture_archive(
        A_MODULE,
        A_CAPABILITY,
        "source-one",
        "semantic-a",
        &compatible_api_range,
        &[],
        &[],
        &[],
    );
    let a_path = archive_root.join("a.shipctl-module");
    let a_repacked_path = archive_root.join("a-repacked.shipctl-module");
    write_archive(&a_path, &artifact_a);
    write_archive(&a_repacked_path, &artifact_a);
    assert_eq!(
        fs::read(&a_path).unwrap(),
        fs::read(&a_repacked_path).unwrap()
    );

    let host_binary = Path::new(env!("CARGO_BIN_EXE_shipctl"));
    let host_binary_before = sha256_hex(&fs::read(host_binary).unwrap());
    assert!(!state_root.exists());
    assert!(!runtime_sentinel.exists());

    let preflight_a = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "preflight", a_path.to_str().unwrap()],
            Some("json"),
        ),
        "modules.preflight",
        "module.artifact.preflighted",
    );
    let content_digest = assert_disabled_artifact(&preflight_a, A_MODULE);
    assert_no_provenance(&preflight_a, "source-one");
    assert!(
        !state_root.exists(),
        "preflight must not create the state root"
    );
    assert!(!runtime_sentinel.exists());

    let preflight_toon = run_offline(
        &state_root,
        &runtime_sentinel,
        &["modules", "preflight", a_path.to_str().unwrap()],
        None,
    );
    assert!(preflight_toon.status.success());
    assert!(preflight_toon.stderr.is_empty());
    let preflight_toon: Value =
        toon_format::decode_default(std::str::from_utf8(&preflight_toon.stdout).unwrap()).unwrap();
    assert_eq!(preflight_toon, preflight_a);
    assert!(!state_root.exists(), "TOON preflight must remain read-only");

    let add_a = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "add", a_path.to_str().unwrap()],
            Some("json"),
        ),
        "modules.add",
        "module.artifact.added",
    );
    assert_eq!(add_a["data"]["receipt"]["changed"], true);
    assert_eq!(add_a["data"]["receipt"]["desired"]["enabled"], false);
    assert_eq!(assert_disabled_artifact(&add_a, A_MODULE), content_digest);
    assert_no_runtime_side_effects(&state_root, &runtime_sentinel);

    let module_a = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "inspect", A_MODULE],
            Some("json"),
        ),
        "modules.inspect",
        "module.artifact.disabled_inspected",
    );
    assert_eq!(module_a["data"]["moduleId"], A_MODULE);
    assert_eq!(module_a["data"]["desired"]["enabled"], false);
    assert_eq!(module_a["data"]["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(
        module_a["data"]["artifacts"][0]["identity"]["contentDigest"],
        content_digest
    );
    assert_eq!(
        module_a["data"]["artifacts"][0]["canonical"]["manifest"]["messages"]["handles"][0]
            ["schedulerAllowed"],
        true
    );
    assert_eq!(
        module_a["data"]["artifacts"][0]["canonical"]["manifest"]["uiContributions"][0]["entry"],
        "chunks/fixture-panel.mjs"
    );
    assert_eq!(
        module_a["data"]["artifacts"][0]["canonical"]["manifest"]["styles"][0],
        "styles/fixture.css"
    );
    assert_disabled_report(&module_a["data"]);
    assert_no_provenance(&module_a, "source-one");

    let capability_a = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "inspect-capability", A_CAPABILITY],
            Some("json"),
        ),
        "modules.inspect_capability",
        "module.capability.inspected",
    );
    assert_eq!(capability_a["data"]["capabilityId"], A_CAPABILITY);
    assert_eq!(
        capability_a["data"]["definitions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        capability_a["data"]["bindings"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        capability_a["data"]["definitions"][0]["events"][0]["id"],
        format!("{A_CAPABILITY}.completed")
    );
    assert_eq!(
        capability_a["data"]["definitions"][0]["streams"][0]["ordered"],
        true
    );
    assert_disabled_report(&capability_a["data"]);
    assert_no_provenance(&capability_a, "source-one");

    let artifact_a_other_provenance = fixture_archive(
        A_MODULE,
        A_CAPABILITY,
        "source-two",
        "semantic-a",
        &compatible_api_range,
        &[],
        &[],
        &[],
    );
    let a_other_provenance_path = archive_root.join("a-other-provenance.shipctl-module");
    write_archive(&a_other_provenance_path, &artifact_a_other_provenance);
    assert_ne!(
        fs::read(&a_path).unwrap(),
        fs::read(&a_other_provenance_path).unwrap(),
        "provenance changes the raw archive but not its semantic identity"
    );
    let preflight_a_other_provenance = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &[
                "modules",
                "preflight",
                a_other_provenance_path.to_str().unwrap(),
            ],
            Some("json"),
        ),
        "modules.preflight",
        "module.artifact.preflighted",
    );
    assert_eq!(
        assert_disabled_artifact(&preflight_a_other_provenance, A_MODULE),
        content_digest
    );
    assert_no_provenance(&preflight_a_other_provenance, "source-two");

    let add_a_other_provenance = assert_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "add", a_other_provenance_path.to_str().unwrap()],
            Some("json"),
        ),
        "modules.add",
        "module.artifact.added",
        "no_op",
    );
    assert_eq!(add_a_other_provenance["data"]["receipt"]["changed"], false);
    assert_eq!(
        add_a_other_provenance["data"]["artifact"]["identity"]["contentDigest"],
        content_digest
    );
    let module_a_after_repack = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "inspect", A_MODULE],
            Some("json"),
        ),
        "modules.inspect",
        "module.artifact.disabled_inspected",
    );
    assert_eq!(
        module_a_after_repack["data"]["artifacts"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "same semantic content must not publish a duplicate identity"
    );

    let artifact_b = fixture_archive(
        B_MODULE,
        B_CAPABILITY,
        "source-b",
        "semantic-b",
        &compatible_api_range,
        &[],
        &[],
        &[],
    );
    let b_path = archive_root.join("b.shipctl-module");
    write_archive(&b_path, &artifact_b);
    let add_b = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "add", b_path.to_str().unwrap()],
            Some("json"),
        ),
        "modules.add",
        "module.artifact.added",
    );
    assert_eq!(add_b["data"]["receipt"]["desired"]["enabled"], false);
    let module_b = assert_success_json(
        &run_offline(
            &state_root,
            &runtime_sentinel,
            &["modules", "inspect", B_MODULE],
            Some("json"),
        ),
        "modules.inspect",
        "module.artifact.disabled_inspected",
    );
    assert_eq!(module_b["data"]["desired"]["enabled"], false);
    assert_disabled_report(&module_b["data"]);
    assert_eq!(published_digests(&state_root).len(), 2);

    let after_valid_artifacts = tree_fingerprint(&state_root);
    let tampered = tampered_archive(&artifact_a);
    let incompatible = fixture_archive(
        "fixture.incompatible",
        A_CAPABILITY,
        "source-incompatible",
        "semantic-incompatible",
        &compatible_api_range,
        &[],
        &[],
        &[],
    );
    let denied_grant = fixture_archive(
        "fixture.denied-grant",
        "fixture.denied-grant-capability",
        "source-grant",
        "semantic-grant",
        &compatible_api_range,
        &["host.fixture.grant"],
        &[],
        &[],
    );
    let unsupported_native = fixture_archive(
        "fixture.unsupported-native",
        "fixture.unsupported-native-capability",
        "source-native",
        "semantic-native",
        &compatible_api_range,
        &[],
        &["fixture.native.adapter"],
        &[],
    );
    let incompatible_api = fixture_archive(
        "fixture.incompatible-api",
        "fixture.incompatible-api-capability",
        "source-api",
        "semantic-api",
        "^9.0.0",
        &[],
        &[],
        &[],
    );
    let incompatible_peer = fixture_archive(
        "fixture.incompatible-peer",
        "fixture.incompatible-peer-capability",
        "source-peer",
        "semantic-peer",
        &compatible_api_range,
        &[],
        &[],
        &[("host.fixture.peer", "^1.0.0")],
    );

    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "tampered",
        &tampered,
        "module.artifact.integrity.invalid",
        &after_valid_artifacts,
    );
    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "incompatible",
        &incompatible,
        "module.artifact.capability.conflict",
        &after_valid_artifacts,
    );
    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "denied-grant",
        &denied_grant,
        "module.artifact.grant.denied",
        &after_valid_artifacts,
    );
    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "unsupported-native",
        &unsupported_native,
        "module.artifact.native_adapter.unavailable",
        &after_valid_artifacts,
    );
    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "incompatible-api",
        &incompatible_api,
        "module.artifact.api.incompatible",
        &after_valid_artifacts,
    );
    assert_rejected_without_publication(
        &archive_root,
        &state_root,
        &runtime_sentinel,
        "incompatible-peer",
        &incompatible_peer,
        "module.artifact.peer.incompatible",
        &after_valid_artifacts,
    );

    assert_eq!(tree_fingerprint(&state_root), after_valid_artifacts);
    assert_no_runtime_side_effects(&state_root, &runtime_sentinel);
    assert_eq!(
        sha256_hex(&fs::read(host_binary).unwrap()),
        host_binary_before
    );
    fs::remove_dir_all(root).unwrap();
}

fn fixture_archive(
    module_id: &str,
    capability_id: &str,
    provenance: &str,
    semantic_marker: &str,
    api_range: &str,
    requested_grants: &[&str],
    native_adapters: &[&str],
    peer_dependencies: &[(&str, &str)],
) -> RuntimeArtifactArchive {
    let request = message_contract(&format!("{capability_id}.request"), semantic_marker);
    let response = message_contract(&format!("{capability_id}.response"), semantic_marker);
    let completed = message_contract(&format!("{capability_id}.completed"), semantic_marker);
    let output = message_contract(&format!("{capability_id}.output"), semantic_marker);
    let port_id = format!("{capability_id}.review");
    let event_id = format!("{capability_id}.completed");
    let topic_id = format!("{capability_id}.completed-topic");
    let stream_id = format!("{capability_id}.output");
    let wakeup_id = format!("{module_id}.scheduler-wakeup");

    let mut definition = CapabilityDefinition {
        id: capability_id.to_string(),
        version: "1.2.3".to_string(),
        definition_digest_sha256: String::new(),
        schemas: vec![
            request.clone(),
            response.clone(),
            completed.clone(),
            output.clone(),
        ],
        ports: vec![CapabilityPortDefinition {
            id: port_id.clone(),
            kind: CapabilityPortKind::Command,
            request: request.message.clone(),
            response: response.message.clone(),
        }],
        events: vec![CapabilityEventDefinition {
            id: event_id.clone(),
            message: completed.message.clone(),
        }],
        topics: vec![CapabilityTopicDefinition {
            id: topic_id.clone(),
            event_id: event_id.clone(),
            message: completed.message.clone(),
        }],
        streams: vec![CapabilityStreamDefinition {
            id: stream_id.clone(),
            message: output.message.clone(),
            ordered: true,
        }],
        provider_cardinality: CapabilityProviderCardinality::Exclusive,
        selection: CapabilityProviderSelection::Priority,
        scopes: vec![CapabilityScope::Instance, CapabilityScope::Workspace],
        agent_access: CapabilityAgentAccess {
            inspect: true,
            invoke: vec![port_id.clone()],
            watch: CapabilityAgentWatchAccess {
                events: vec![event_id.clone()],
                topics: vec![topic_id.clone()],
            },
            attach: vec![stream_id.clone()],
        },
    };
    definition.definition_digest_sha256 = definition.calculated_digest_sha256().unwrap();
    let reference = definition.reference();
    let messages = MessageDeclarations {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        provides: vec![
            request.clone(),
            response.clone(),
            completed.clone(),
            output.clone(),
        ],
        handles: vec![DirectedChannelDeclaration {
            endpoint: RouteEndpointRef {
                id: wakeup_id.clone(),
                message: request.message.clone(),
            },
            capacity: 1,
            required_grant: format!("message.send.{wakeup_id}"),
            scheduler_allowed: true,
        }],
        publishes: vec![BroadcastTopicDeclaration {
            endpoint: RouteEndpointRef {
                id: topic_id.clone(),
                message: completed.message.clone(),
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
    let capabilities = CapabilityManifest {
        schema_version: CAPABILITY_CONTRACT_SCHEMA_VERSION,
        definitions: vec![definition.clone()],
        providers: vec![CapabilityProviderBinding {
            capability: reference.clone(),
            surfaces: CapabilitySurfaceBinding {
                ports: vec![port_id],
                events: vec![event_id],
                topics: vec![topic_id],
                streams: vec![stream_id],
            },
            scopes: vec![CapabilityScope::Instance],
            priority: Some(100),
        }],
        consumers: vec![CapabilityConsumerBinding {
            capability: reference,
            surfaces: CapabilitySurfaceBinding {
                ports: Vec::new(),
                events: vec![format!("{capability_id}.completed")],
                topics: vec![format!("{capability_id}.completed-topic")],
                streams: vec![format!("{capability_id}.output")],
            },
            scopes: vec![CapabilityScope::Workspace],
        }],
    };
    let ui_contribution = RuntimeUiContribution {
        id: format!("{module_id}.panel"),
        slot: "sidebar".to_string(),
        entry: "chunks/fixture-panel.mjs".to_string(),
    };
    let peer_dependencies = peer_dependencies
        .iter()
        .map(|(name, range)| ((*name).to_string(), (*range).to_string()))
        .collect::<BTreeMap<_, _>>();
    let manifest_value = json!({
        "schemaVersion": ARTIFACT_CONTRACT_SCHEMA_VERSION,
        "id": module_id,
        "name": "Compiled CLI fixture",
        "version": "1.0.0",
        "apiRange": api_range,
        "runtimeKind": "frontend_esm",
        "entry": "module.mjs",
        "styles": ["styles/fixture.css"],
        "assets": ["assets/fixture.svg"],
        "messages": messages,
        "capabilities": capabilities,
        "uiContributions": [ui_contribution],
        "requestedGrants": requested_grants,
        "nativeAdapters": native_adapters,
        "configurationSchema": {"type": "object"},
        "secretReferences": [],
        "peerDependencies": peer_dependencies,
        "supportedScopes": ["instance", "workspace"],
        "lifecycle": "live",
        "sourceProvenance": {"source": provenance}
    });
    let manifest: RuntimeArtifactManifest = serde_json::from_value(manifest_value.clone()).unwrap();

    let mut files = BTreeMap::from([
        (
            "module.mjs".to_string(),
            b"export const fixture = true;".to_vec(),
        ),
        (
            "chunks/fixture-panel.mjs".to_string(),
            b"export const fixturePanel = true;".to_vec(),
        ),
        (
            "styles/fixture.css".to_string(),
            b".fixture { color: green; }".to_vec(),
        ),
        ("assets/fixture.svg".to_string(), b"<svg/>".to_vec()),
        (
            ARTIFACT_MANIFEST_PATH.to_string(),
            serde_yaml::to_string(&manifest_value).unwrap().into_bytes(),
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
            format!("capabilities/{}.json", definition.id),
            serde_json::to_vec(definition).unwrap(),
        );
    }
    reindex(&mut files);
    RuntimeArtifactArchive::new(files).unwrap()
}

fn message_contract(id: &str, semantic_marker: &str) -> MessageTypeContract {
    let path = format!("messages/{}.schema.json", id.replace('.', "-"));
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
                    "title": semantic_marker,
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["value"],
                    "properties": {"value": {"type": "string"}}
                }),
            )]),
            max_encoded_bytes: 1024,
            redacted_fields: Vec::new(),
            compatible_versions: vec![1],
        },
    }
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
        files: entries.clone(),
        content_digest_sha256: canonical_content_digest(&manifest, &entries).unwrap(),
    };
    files.insert(
        ARTIFACT_INTEGRITY_PATH.to_string(),
        serde_json::to_vec(&index).unwrap(),
    );
}

fn tampered_archive(archive: &RuntimeArtifactArchive) -> RuntimeArtifactArchive {
    let mut files = archive.files().clone();
    files
        .get_mut("module.mjs")
        .unwrap()
        .extend_from_slice(b"// changed after integrity sealing");
    RuntimeArtifactArchive::new(files).unwrap()
}

fn write_archive(path: &Path, archive: &RuntimeArtifactArchive) {
    let mut builder = tar::Builder::new(Vec::new());
    for (entry_path, contents) in archive.files() {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(contents.len() as u64);
        builder
            .append_data(&mut header, entry_path, Cursor::new(contents))
            .unwrap();
    }
    builder.finish().unwrap();
    fs::write(path, builder.into_inner().unwrap()).unwrap();
}

fn assert_rejected_without_publication(
    archive_root: &Path,
    state_root: &Path,
    runtime_sentinel: &Path,
    name: &str,
    archive: &RuntimeArtifactArchive,
    expected_code: &str,
    expected_state: &BTreeMap<PathBuf, String>,
) {
    let archive_path = archive_root.join(format!("{name}.shipctl-module"));
    write_archive(&archive_path, archive);
    for command in ["preflight", "add"] {
        assert_error_json(
            &run_offline(
                state_root,
                runtime_sentinel,
                &["modules", command, archive_path.to_str().unwrap()],
                Some("json"),
            ),
            &format!("modules.{command}"),
            expected_code,
        );
        assert_eq!(
            &tree_fingerprint(state_root),
            expected_state,
            "{command} must not publish rejected {name} archive state"
        );
        assert_no_runtime_side_effects(state_root, runtime_sentinel);
    }
}

fn run_offline(
    state_root: &Path,
    runtime_sentinel: &Path,
    command: &[&str],
    output: Option<&str>,
) -> Output {
    let mut invocation = Command::new(env!("CARGO_BIN_EXE_shipctl"));
    invocation
        .args(command)
        .args(["--offline", "--state-root", state_root.to_str().unwrap()]);
    if let Some(output) = output {
        invocation.args(["--output", output]);
    }
    invocation
        .env("SHIPCTL_RUNTIME_DIR", runtime_sentinel)
        .output()
        .unwrap()
}

fn assert_success_json(output: &Output, operation: &str, code: &str) -> Value {
    assert_json(output, operation, code, "success")
}

fn assert_json(output: &Output, operation: &str, code: &str, status: &str) -> Value {
    assert!(
        output.status.success(),
        "shipctl exited {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "structured CLI output belongs on stdout"
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], operation);
    assert_eq!(value["status"], status);
    assert_eq!(value["code"], code);
    value
}

fn assert_error_json(output: &Output, operation: &str, code: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(
        output.stderr.is_empty(),
        "structured CLI errors belong on stdout"
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], operation);
    assert_eq!(value["status"], "error");
    assert_eq!(value["code"], code);
    assert_eq!(value["error"]["code"], code);
}

fn assert_disabled_artifact(value: &Value, module_id: &str) -> String {
    assert_disabled_report(&value["data"]);
    assert_eq!(value["data"]["artifact"]["identity"]["id"], module_id);
    value["data"]["artifact"]["identity"]["contentDigest"]
        .as_str()
        .unwrap()
        .to_string()
}

fn assert_disabled_report(report: &Value) {
    assert_eq!(report["runtimeAvailable"], false);
    assert_eq!(report["callable"], false);
}

fn assert_no_provenance(value: &Value, provenance: &str) {
    let serialized = serde_json::to_string(value).unwrap();
    assert!(!serialized.contains("sourceProvenance"));
    assert!(!serialized.contains(provenance));
}

fn assert_no_runtime_side_effects(state_root: &Path, runtime_sentinel: &Path) {
    assert!(
        !runtime_sentinel.exists(),
        "offline CLI must not start a runtime"
    );
    assert!(
        !state_root.join("module-control").exists(),
        "offline artifact admission must not emit runtime evidence"
    );
}

fn published_digests(state_root: &Path) -> Vec<String> {
    let artifact_root = state_root.join("modules");
    let mut digests = fs::read_dir(artifact_root)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter_map(|entry| {
            entry
                .file_type()
                .unwrap()
                .is_dir()
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .filter(|name| name != ".staging")
        .collect::<Vec<_>>();
    digests.sort();
    digests
}

fn tree_fingerprint(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut fingerprint = BTreeMap::new();
    collect_tree_fingerprint(root, root, &mut fingerprint);
    fingerprint
}

fn collect_tree_fingerprint(
    root: &Path,
    current: &Path,
    fingerprint: &mut BTreeMap<PathBuf, String>,
) {
    if !current.exists() {
        return;
    }
    for entry in fs::read_dir(current).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap().to_path_buf();
        let metadata = fs::symlink_metadata(&path).unwrap();
        if metadata.file_type().is_symlink() {
            panic!("unexpected link in test state: {}", path.display());
        }
        if metadata.is_dir() {
            fingerprint.insert(relative.clone(), "directory".to_string());
            collect_tree_fingerprint(root, &path, fingerprint);
        } else if metadata.is_file() {
            fingerprint.insert(relative, sha256_hex(&fs::read(path).unwrap()));
        } else {
            panic!("unexpected state entry: {}", path.display());
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unique_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "shipctl-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ))
}
