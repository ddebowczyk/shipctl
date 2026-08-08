//! A deliberately narrow, one-shot packaged-webview probe for the generic
//! artifact loader. It is only armed by `shipctl-ui --module-loader-probe` and
//! accepts both its request and result below the selected instance state root.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use shipctl_core::state::paths::ShipctlPaths;

pub const MODULE_LOADER_PROBE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ProbeRequest {
    schema_version: u32,
    artifacts: Vec<ProbeRequestArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ProbeRequestArtifact {
    label: String,
    digest_sha256: String,
    entry_relative_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleLoaderProbePlan {
    pub schema_version: u32,
    pub artifacts: Vec<ModuleLoaderProbeArtifact>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleLoaderProbeArtifact {
    pub label: String,
    pub digest_sha256: String,
    pub entry_path: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ModuleLoaderProbeResult {
    pub schema_version: u32,
    pub success: bool,
    pub observed: serde_json::Value,
    pub diagnostics: Vec<serde_json::Value>,
}

/// This state is inert on every ordinary launch. `take_plan` consumes the one
/// explicit request so a second webview cannot repeat a diagnostic run.
pub struct ModuleLoaderProbe {
    plan: Mutex<Option<ModuleLoaderProbePlan>>,
    result_path: Option<PathBuf>,
}

impl ModuleLoaderProbe {
    pub fn disabled() -> Self {
        Self {
            plan: Mutex::new(None),
            result_path: None,
        }
    }

    pub fn from_request(request_path: Option<&Path>, paths: &ShipctlPaths) -> Result<Self, String> {
        let Some(request_path) = request_path else {
            return Ok(Self::disabled());
        };

        let control_root = paths
            .module_control_evidence_root
            .parent()
            .ok_or_else(|| "module-control evidence root has no parent".to_owned())?;
        let canonical_control_root = fs::canonicalize(control_root).map_err(|error| {
            format!(
                "module loader probe requires an existing instance module-control root {}: {error}",
                control_root.display()
            )
        })?;
        let canonical_request = fs::canonicalize(request_path).map_err(|error| {
            format!(
                "module loader probe request {} cannot be resolved: {error}",
                request_path.display()
            )
        })?;
        if !canonical_request.starts_with(&canonical_control_root) {
            return Err(format!(
                "module loader probe request must be below the selected instance module-control root {}",
                canonical_control_root.display()
            ));
        }

        let request: ProbeRequest =
            serde_json::from_slice(&fs::read(&canonical_request).map_err(|error| {
                format!(
                    "module loader probe request {} cannot be read: {error}",
                    canonical_request.display()
                )
            })?)
            .map_err(|error| format!("module loader probe request is invalid JSON: {error}"))?;
        if request.schema_version != MODULE_LOADER_PROBE_SCHEMA_VERSION {
            return Err(format!(
                "module loader probe schema {} is unsupported",
                request.schema_version
            ));
        }
        if request.artifacts.len() != 3
            || request
                .artifacts
                .iter()
                .map(|artifact| artifact.label.as_str())
                .collect::<Vec<_>>()
                != ["A", "B", "C"]
        {
            return Err(
                "module loader probe must contain the ordered A, B, C artifacts".to_owned(),
            );
        }

        let canonical_artifact_root = fs::canonicalize(&paths.module_artifact_root).map_err(|error| {
            format!(
                "module loader probe requires an existing instance module artifact root {}: {error}",
                paths.module_artifact_root.display()
            )
        })?;
        let artifacts = request
            .artifacts
            .into_iter()
            .map(|artifact| {
                if !is_sha256(&artifact.digest_sha256) {
                    return Err(format!(
                        "module loader probe {} digest is not a SHA-256 hex value",
                        artifact.label
                    ));
                }
                if artifact.entry_relative_path.is_absolute() {
                    return Err(format!(
                        "module loader probe {} entry path must be relative",
                        artifact.label
                    ));
                }
                let entry_path = fs::canonicalize(
                    paths
                        .module_artifact_root
                        .join(&artifact.entry_relative_path),
                )
                .map_err(|error| {
                    format!(
                        "module loader probe {} entry cannot be resolved: {error}",
                        artifact.label
                    )
                })?;
                if !entry_path.starts_with(&canonical_artifact_root) || !entry_path.is_file() {
                    return Err(format!(
                        "module loader probe {} entry escapes the selected artifact root",
                        artifact.label
                    ));
                }
                if !entry_path.components().any(|component| {
                    component.as_os_str() == std::ffi::OsStr::new(&artifact.digest_sha256)
                }) {
                    return Err(format!(
                        "module loader probe {} entry is not digest-qualified",
                        artifact.label
                    ));
                }
                Ok(ModuleLoaderProbeArtifact {
                    label: artifact.label,
                    digest_sha256: artifact.digest_sha256,
                    entry_path,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            plan: Mutex::new(Some(ModuleLoaderProbePlan {
                schema_version: MODULE_LOADER_PROBE_SCHEMA_VERSION,
                artifacts,
            })),
            result_path: Some(
                paths
                    .module_control_evidence_root
                    .join("loader-probe-result.json"),
            ),
        })
    }

    fn take_plan(&self) -> Result<Option<ModuleLoaderProbePlan>, String> {
        self.plan
            .lock()
            .map(|mut plan| plan.take())
            .map_err(|_| "module loader probe state lock was poisoned".to_owned())
    }

    pub fn is_enabled(&self) -> bool {
        self.result_path.is_some()
    }

    fn write_result(&self, result: &ModuleLoaderProbeResult) -> Result<(), String> {
        let Some(result_path) = &self.result_path else {
            return Err("module loader probe is not enabled for this launch".to_owned());
        };
        if result.schema_version != MODULE_LOADER_PROBE_SCHEMA_VERSION {
            return Err(format!(
                "module loader probe result schema {} is unsupported",
                result.schema_version
            ));
        }
        let parent = result_path
            .parent()
            .ok_or_else(|| "module loader probe result path has no parent".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "module loader probe evidence root {} cannot be created: {error}",
                parent.display()
            )
        })?;
        let temporary_path = result_path.with_extension("json.tmp");
        fs::write(
            &temporary_path,
            serde_json::to_vec_pretty(result).map_err(|error| {
                format!("module loader probe result cannot be encoded: {error}")
            })?,
        )
        .map_err(|error| format!("module loader probe result cannot be written: {error}"))?;
        fs::rename(&temporary_path, result_path)
            .map_err(|error| format!("module loader probe result cannot be finalized: {error}"))
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[tauri::command]
pub fn take_module_loader_probe(
    probe: State<'_, ModuleLoaderProbe>,
) -> Result<Option<ModuleLoaderProbePlan>, String> {
    probe.take_plan()
}

#[tauri::command]
pub fn complete_module_loader_probe(
    app: AppHandle,
    probe: State<'_, ModuleLoaderProbe>,
    result: ModuleLoaderProbeResult,
) -> Result<(), String> {
    let exit_code = if result.success { 0 } else { 1 };
    probe.write_result(&result)?;
    app.exit(exit_code);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_probe_has_no_plan() {
        assert!(ModuleLoaderProbe::disabled().take_plan().unwrap().is_none());
    }

    #[test]
    fn sha256_validation_requires_exact_hex_digest() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256("not-a-digest"));
        assert!(!is_sha256(&"g".repeat(64)));
    }
}
