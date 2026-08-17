use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shipctl_core::message_bus::{
    BroadcastTopicDeclaration, CapabilityPortDeclaration, DirectedChannelDeclaration,
    MessageDeclarations, MessageSchemaDescriptor, MessageTypeContract, MessageTypeId,
    RouteEndpointRef, MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::module_control::artifact::{
    canonical_content_digest, ArtifactIntegrityFile, ArtifactIntegrityIndex, CapabilityAgentAccess,
    CapabilityAgentWatchAccess, CapabilityDefinition, CapabilityEventDefinition,
    CapabilityManifest, CapabilityPortDefinition, CapabilityPortKind, CapabilityProviderBinding,
    CapabilityProviderCardinality, CapabilityProviderSelection, CapabilityScope,
    CapabilityStreamDefinition, CapabilitySurfaceBinding, CapabilityTopicDefinition,
    RuntimeArtifactArchive, RuntimeArtifactManifest, ARTIFACT_CONTRACT_SCHEMA_VERSION,
    ARTIFACT_INTEGRITY_PATH, ARTIFACT_MANIFEST_PATH, CAPABILITY_CONTRACT_SCHEMA_VERSION,
};

const MODULE_ID: &str = "shipctl.rapid-demo";
const CAPABILITY_ID: &str = "shipctl.terminal-probe";
const PORT_ID: &str = "shipctl.terminal-probe.probe";
const EVENT_ID: &str = "shipctl.terminal-probe.completed";
const TOPIC_ID: &str = "shipctl.terminal-probe.completed-topic";
const STREAM_ID: &str = "shipctl.terminal-probe.output";
const PING_CHANNEL_ID: &str = "shipctl.rapid-demo.ping";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from("target/rapid-time-to-value/shipctl-rapid-demo.shipctl-module")
    });
    let archive = rapid_demo_archive()?;
    archive.inspect()?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    write_archive(&output, &archive)?;
    println!("{}", output.display());
    Ok(())
}

fn rapid_demo_archive() -> Result<RuntimeArtifactArchive, Box<dyn std::error::Error>> {
    let request = message_contract(
        "shipctl.terminal-probe.request",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["projectPath", "mode"],
            "properties": {
                "projectPath": {"type": "string", "minLength": 1},
                "mode": {"enum": ["run", "status"]}
            }
        }),
    );
    let response = message_contract(
        "shipctl.terminal-probe.response",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": [
                "status", "output", "exitCode", "directedCount",
                "observedTopicCount", "topicSubscriberCount"
            ],
            "properties": {
                "status": {"enum": ["ran", "observed"]},
                "output": {"type": "string"},
                "exitCode": {"type": ["integer", "null"]},
                "directedCount": {"type": "integer", "minimum": 0},
                "observedTopicCount": {"type": "integer", "minimum": 0},
                "topicSubscriberCount": {"type": "integer", "minimum": 0}
            }
        }),
    );
    let completed = message_contract(
        "shipctl.terminal-probe.completed",
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["runId", "output", "exitCode"],
            "properties": {
                "runId": {"type": "string", "minLength": 1},
                "output": {"type": "string"},
                "exitCode": {"type": ["integer", "null"]}
            }
        }),
    );
    let output = message_contract(
        "shipctl.terminal-probe.output",
        json!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "data"],
                    "properties": {
                        "type": {"const": "data"},
                        "data": {"type": "string"}
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "exitCode"],
                    "properties": {
                        "type": {"const": "exit"},
                        "exitCode": {"type": ["integer", "null"]}
                    }
                }
            ]
        }),
    );

    let mut definition = CapabilityDefinition {
        id: CAPABILITY_ID.to_string(),
        version: "1.0.0".to_string(),
        definition_digest_sha256: String::new(),
        schemas: vec![
            request.clone(),
            response.clone(),
            completed.clone(),
            output.clone(),
        ],
        ports: vec![CapabilityPortDefinition {
            id: PORT_ID.to_string(),
            kind: CapabilityPortKind::Command,
            request: request.message.clone(),
            response: response.message.clone(),
        }],
        events: vec![CapabilityEventDefinition {
            id: EVENT_ID.to_string(),
            message: completed.message.clone(),
        }],
        topics: vec![CapabilityTopicDefinition {
            id: TOPIC_ID.to_string(),
            event_id: EVENT_ID.to_string(),
            message: completed.message.clone(),
        }],
        streams: vec![CapabilityStreamDefinition {
            id: STREAM_ID.to_string(),
            message: output.message.clone(),
            ordered: true,
        }],
        provider_cardinality: CapabilityProviderCardinality::Exclusive,
        selection: CapabilityProviderSelection::Priority,
        scopes: vec![CapabilityScope::Instance],
        agent_access: CapabilityAgentAccess {
            inspect: true,
            invoke: vec![PORT_ID.to_string()],
            watch: CapabilityAgentWatchAccess {
                events: vec![EVENT_ID.to_string()],
                topics: vec![TOPIC_ID.to_string()],
            },
            attach: Vec::new(),
        },
    };
    definition.definition_digest_sha256 = definition.calculated_digest_sha256()?;

    let messages = MessageDeclarations {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        provides: vec![request.clone(), response, completed.clone(), output],
        handles: vec![DirectedChannelDeclaration {
            endpoint: RouteEndpointRef {
                id: PING_CHANNEL_ID.to_string(),
                message: request.message.clone(),
            },
            capacity: 1,
            required_grant: format!("message.send.{PING_CHANNEL_ID}"),
            scheduler_allowed: false,
        }],
        publishes: vec![BroadcastTopicDeclaration {
            endpoint: RouteEndpointRef {
                id: TOPIC_ID.to_string(),
                message: completed.message.clone(),
            },
            capacity: 1,
            required_grant: format!("message.publish.{TOPIC_ID}"),
            scheduler_allowed: false,
        }],
        subscribes: vec![RouteEndpointRef {
            id: TOPIC_ID.to_string(),
            message: completed.message,
        }],
        ports: vec![CapabilityPortDeclaration {
            id: PORT_ID.to_string(),
            request: request.message,
            response: MessageTypeId {
                id: "shipctl.terminal-probe.response".to_string(),
                version: 1,
            },
            capacity: 1,
            required_grant: format!("message.request.{PORT_ID}"),
            scheduler_allowed: false,
        }],
    };

    let capabilities = CapabilityManifest {
        schema_version: CAPABILITY_CONTRACT_SCHEMA_VERSION,
        definitions: vec![definition.clone()],
        providers: vec![CapabilityProviderBinding {
            capability: definition.reference(),
            surfaces: CapabilitySurfaceBinding {
                ports: vec![PORT_ID.to_string()],
                events: vec![EVENT_ID.to_string()],
                topics: vec![TOPIC_ID.to_string()],
                streams: vec![STREAM_ID.to_string()],
            },
            scopes: vec![CapabilityScope::Instance],
            priority: Some(100),
        }],
        consumers: Vec::new(),
    };
    let manifest_value = json!({
        "schemaVersion": ARTIFACT_CONTRACT_SCHEMA_VERSION,
        "id": MODULE_ID,
        "name": "Shipctl rapid terminal probe",
        "version": "1.0.0",
        "apiRange": "^1.0.0",
        "runtimeKind": "frontend_esm",
        "entry": "module.mjs",
        "styles": [],
        "assets": [],
        "messages": messages,
        "capabilities": capabilities,
        "application": {
            "schemaVersion": 1,
            "role": "headless",
            "requiredServices": [],
            "providedServices": [],
            "backgroundEffects": [],
            "contributions": [
                {"family": "message-graph", "id": "shipctl.rapid-demo.messages", "schemaVersion": 1}
            ]
        },
        "uiContributions": [],
        "requestedGrants": [],
        "nativeAdapters": [],
        "secretReferences": [],
        "peerDependencies": {},
        "supportedScopes": ["instance"],
        "lifecycle": "live"
    });
    let manifest: RuntimeArtifactManifest = serde_json::from_value(manifest_value.clone())?;
    let module_source = module_source(&manifest.messages)?;
    let mut files = BTreeMap::from([
        ("module.mjs".to_string(), module_source.into_bytes()),
        (
            ARTIFACT_MANIFEST_PATH.to_string(),
            serde_yaml::to_string(&manifest_value)?.into_bytes(),
        ),
    ]);
    for contract in manifest.messages.provides.iter().chain(
        manifest
            .capabilities
            .definitions
            .iter()
            .flat_map(|candidate| candidate.schemas.iter()),
    ) {
        for (path, schema) in &contract.schema.resources {
            files
                .entry(path.clone())
                .or_insert_with(|| serde_json::to_vec(schema).expect("schema is serializable"));
        }
    }
    for candidate in &manifest.capabilities.definitions {
        files.insert(
            format!("capabilities/{}.json", candidate.id),
            serde_json::to_vec(candidate)?,
        );
    }
    reindex(&mut files)?;
    Ok(RuntimeArtifactArchive::new(files)?)
}

fn message_contract(id: &str, schema: Value) -> MessageTypeContract {
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
                })
                .as_object()
                .expect("base schema is an object")
                .iter()
                .chain(schema.as_object().expect("schema is an object"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            )]),
            max_encoded_bytes: 4096,
            redacted_fields: Vec::new(),
            compatible_versions: vec![1],
        },
    }
}

fn module_source(messages: &MessageDeclarations) -> Result<String, serde_json::Error> {
    let provides = serde_json::to_string(&messages.provides)?;
    Ok(format!(
        r#"const PROVIDES = {provides};
const REQUEST = {{ id: "shipctl.terminal-probe.request", version: 1 }};
const RESPONSE = {{ id: "shipctl.terminal-probe.response", version: 1 }};
const COMPLETED = {{ id: "shipctl.terminal-probe.completed", version: 1 }};
const PING = {{ id: "shipctl.rapid-demo.ping", message: REQUEST }};
const TOPIC = {{ id: "shipctl.terminal-probe.completed-topic", message: COMPLETED }};
const PORT = {{ id: "shipctl.terminal-probe.probe", request: REQUEST, response: RESPONSE }};

export function createShipctlPlugin() {{
  let services = null;
  let runtimeMessages = null;
  let directedCount = 0;
  let observedTopicCount = 0;
  let topicSubscriberCount = 0;
  let output = "";
  let exitCode = null;
  const sessions = new Set();
  const observations = new Set();

  function snapshot(status) {{
    return {{
      status,
      output,
      exitCode,
      directedCount,
      observedTopicCount,
      topicSubscriberCount,
    }};
  }}

  const module = {{
    id: "shipctl.rapid-demo",
    version: "1.0.0",
    messages: {{
      provides: PROVIDES,
      handles: [{{
        channel: PING,
        capacity: 1,
        requiredGrant: "message.send.shipctl.rapid-demo.ping",
        schedulerAllowed: false,
        handle() {{ directedCount += 1; }},
      }}],
      publishes: [{{
        topic: TOPIC,
        capacity: 1,
        requiredGrant: "message.publish.shipctl.terminal-probe.completed-topic",
        schedulerAllowed: false,
      }}],
      subscribes: [{{
        topic: TOPIC,
        handle() {{ observedTopicCount += 1; }},
      }}],
      ports: [{{
        port: PORT,
        capacity: 1,
        requiredGrant: "message.request.shipctl.terminal-probe.probe",
        schedulerAllowed: false,
        async handle(request) {{
          if (!services || !runtimeMessages) throw new Error("rapid demo is not active");
          if (request.mode === "status") return snapshot("observed");
          output = "";
          exitCode = null;
          const runId = crypto.randomUUID();
          let resolveExit;
          const exited = new Promise((resolve) => {{ resolveExit = resolve; }});
          const session = await services.terminalSessions.launch({{
            projectPath: request.projectPath,
            ownerKey: "shipctl.rapid-demo",
            command: "/usr/bin/printf",
            arguments: ["shipctl-rapid-demo\\n"],
            cwd: request.projectPath,
            label: "Rapid module probe",
            columns: 80,
            rows: 24,
          }});
          sessions.add(session.id);
          const decoder = new TextDecoder();
          const observation = await services.terminalSessions.observe(session.id, (event) => {{
            if (event.type === "replay") output = decoder.decode(Uint8Array.from(event.data));
            else if (event.type === "data") output += decoder.decode(
              Uint8Array.from(event.data),
              {{ stream: true }},
            );
            else if (event.type === "exit") {{
              output += decoder.decode();
              exitCode = event.exitCode;
              resolveExit();
            }}
          }});
          observations.add(observation);
          try {{
            await exited;
          }} finally {{
            await observation.dispose();
            observations.delete(observation);
            await services.terminalSessions.stop(session.id);
            sessions.delete(session.id);
          }}
          await runtimeMessages.send(PING, {{
            projectPath: request.projectPath,
            mode: "status",
          }});
          const published = await runtimeMessages.publish(TOPIC, {{
            runId,
            output,
            exitCode,
          }});
          topicSubscriberCount = published.subscriberCount;
          return snapshot("ran");
        }},
      }}],
    }},
    activate(host) {{
      services = host.services;
      runtimeMessages = host.messages;
      return {{
        async deactivate() {{
          for (const observation of observations) await observation.dispose();
          observations.clear();
          for (const sessionId of sessions) await services.terminalSessions.stop(sessionId);
          sessions.clear();
          services = null;
          runtimeMessages = null;
        }},
      }};
    }},
  }};
  return {{ role: "headless", backgroundEffects: [], module }};
}}
"#
    ))
}

fn reindex(files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), Box<dyn std::error::Error>> {
    files.remove(ARTIFACT_INTEGRITY_PATH);
    let manifest: RuntimeArtifactManifest =
        serde_yaml::from_slice(files.get(ARTIFACT_MANIFEST_PATH).expect("manifest exists"))?;
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
        content_digest_sha256: canonical_content_digest(&manifest, &entries)?,
    };
    files.insert(
        ARTIFACT_INTEGRITY_PATH.to_string(),
        serde_json::to_vec(&index)?,
    );
    Ok(())
}

fn write_archive(
    path: &PathBuf,
    archive: &RuntimeArtifactArchive,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = tar::Builder::new(Vec::new());
    for (entry_path, contents) in archive.files() {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(contents.len() as u64);
        builder.append_data(&mut header, entry_path, Cursor::new(contents))?;
    }
    builder.finish()?;
    fs::write(path, builder.into_inner()?)?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use shipctl_core::module_control::artifact::CapabilityDefinitionIndex;

    #[test]
    fn package_is_a_self_validating_restart_bound_artifact() {
        let archive = rapid_demo_archive().expect("example package must build");
        let artifact = archive
            .preflight(&CapabilityDefinitionIndex::default())
            .expect("example package must pass the public artifact contract");

        assert_eq!(artifact.identity().id, MODULE_ID);
        assert_eq!(artifact.identity().version, "1.0.0");
    }
}
