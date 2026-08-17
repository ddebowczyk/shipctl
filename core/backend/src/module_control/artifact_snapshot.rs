use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::state::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};
use serde::{Deserialize, Serialize};

use super::artifact::RuntimeArtifactArchive;
use super::repository::read_artifact_directory;

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const ARTIFACTS_ENTRY: &str = "artifacts";
const LOCK_ENTRY: &str = "repository_lock";
const ARTIFACT_ROOT: &str = "modules";
const LOCK_FILE: &str = ".module-artifact.lock";
const STAGING_DIRECTORY: &str = ".staging";

/// Saves only validated, content-addressed runtime artifacts. Repository lock
/// state and incomplete staging work are never portable workspace state.
pub struct ModuleArtifactSnapshotProvider {
    artifact_root: PathBuf,
}

impl ModuleArtifactSnapshotProvider {
    pub fn new(artifact_root: PathBuf) -> Self {
        Self { artifact_root }
    }

    fn decode_and_validate(payload: &[u8]) -> Result<ArtifactSnapshotBundle, String> {
        let bundle: ArtifactSnapshotBundle = serde_json::from_slice(payload)
            .map_err(|error| format!("Module artifact snapshot is invalid: {error}"))?;
        if bundle.schema_version != SNAPSHOT_SCHEMA_VERSION {
            return Err("Module artifact snapshot schema version is unsupported".to_string());
        }
        for (digest, files) in &bundle.artifacts {
            if !is_sha256_digest(digest) {
                return Err("Module artifact snapshot contains an invalid digest path".to_string());
            }
            let archive =
                RuntimeArtifactArchive::new(files.clone()).map_err(|error| error.to_string())?;
            let artifact = archive.inspect().map_err(|error| error.to_string())?;
            if artifact.content_digest != *digest {
                return Err(
                    "Module artifact snapshot directory does not match its content digest"
                        .to_string(),
                );
            }
        }
        Ok(bundle)
    }
}

impl SnapshotProvider for ModuleArtifactSnapshotProvider {
    fn id(&self) -> &'static str {
        "modules.artifacts"
    }

    fn schema_version(&self) -> u32 {
        SNAPSHOT_SCHEMA_VERSION
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![
            SnapshotEntryDeclaration {
                id: ARTIFACTS_ENTRY,
                classification: SnapshotClassification::Portable,
                source_paths: vec![PathBuf::from(ARTIFACT_ROOT)],
                target_path: Some(PathBuf::from(ARTIFACT_ROOT)),
                redaction: "validated immutable module artifacts only",
            },
            SnapshotEntryDeclaration {
                id: LOCK_ENTRY,
                classification: SnapshotClassification::LiveOnly,
                source_paths: vec![PathBuf::from(LOCK_FILE)],
                target_path: None,
                redaction: "process-local repository lease is excluded",
            },
        ]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        let artifacts = match fs::symlink_metadata(&self.artifact_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not inspect module artifact root: {error}")),
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Module artifact root must be a real directory".to_string());
                }
                let mut artifacts = BTreeMap::new();
                for entry in fs::read_dir(&self.artifact_root)
                    .map_err(|error| format!("Could not read module artifact root: {error}"))?
                {
                    let entry = entry.map_err(|error| {
                        format!("Could not read module artifact entry: {error}")
                    })?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "Module artifact directory name is not UTF-8".to_string())?;
                    if name == STAGING_DIRECTORY {
                        if directory_contains_files(&entry.path())? {
                            return Err(
                                "Module artifact staging directory is not empty during snapshot"
                                    .to_string(),
                            );
                        }
                        continue;
                    }
                    if !is_sha256_digest(&name) {
                        return Err(format!(
                            "Module artifact root contains an unrecognized entry: {name}"
                        ));
                    }
                    let archive = read_artifact_directory(&entry.path())
                        .map_err(|error| error.to_string())?;
                    let artifact = archive.inspect().map_err(|error| error.to_string())?;
                    if artifact.content_digest != name {
                        return Err(format!(
                            "Module artifact directory {name} does not match its content digest"
                        ));
                    }
                    artifacts.insert(name, archive.files().clone());
                }
                Some(
                    serde_json::to_vec(&ArtifactSnapshotBundle {
                        schema_version: SNAPSHOT_SCHEMA_VERSION,
                        artifacts,
                    })
                    .map_err(|error| {
                        format!("Could not encode module artifact snapshot: {error}")
                    })?,
                )
            }
        };

        Ok(vec![
            CapturedSnapshotEntry {
                id: ARTIFACTS_ENTRY,
                decision: if artifacts.is_some() {
                    "included".to_string()
                } else {
                    "source_absent".to_string()
                },
                payload: artifacts,
            },
            CapturedSnapshotEntry {
                id: LOCK_ENTRY,
                payload: None,
                decision: "excluded_process_local_lease".to_string(),
            },
        ])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != ARTIFACTS_ENTRY {
            return Err(format!("Unknown modules.artifacts payload {entry_id}"));
        }
        Self::decode_and_validate(payload).map(|_| ())
    }

    fn restore_payload(
        &self,
        entry_id: &str,
        payload: &[u8],
        staging_state_root: &Path,
    ) -> Result<(), String> {
        if entry_id != ARTIFACTS_ENTRY {
            return Err(format!("Unknown modules.artifacts payload {entry_id}"));
        }
        let bundle = Self::decode_and_validate(payload)?;
        let target_root = staging_state_root.join(ARTIFACT_ROOT);
        fs::create_dir_all(&target_root)
            .map_err(|error| format!("Could not create module artifact restore root: {error}"))?;
        for (digest, files) in bundle.artifacts {
            let artifact_root = target_root.join(digest);
            fs::create_dir(&artifact_root)
                .map_err(|error| format!("Could not create restored module artifact: {error}"))?;
            for (relative, contents) in files {
                let relative = safe_relative_path(&relative)?;
                let target = artifact_root.join(relative);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("Could not create restored module artifact directory: {error}")
                    })?;
                }
                fs::write(&target, contents)
                    .map_err(|error| format!("Could not restore module artifact file: {error}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).map_err(
                        |error| format!("Could not secure restored module artifact: {error}"),
                    )?;
                }
            }
        }
        Ok(())
    }

    fn owns_source_path(&self, source_path: &Path) -> bool {
        source_path == Path::new(LOCK_FILE) || source_path.starts_with(ARTIFACT_ROOT)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactSnapshotBundle {
    schema_version: u32,
    artifacts: BTreeMap<String, BTreeMap<String, Vec<u8>>>,
}

fn directory_contains_files(root: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect module artifact staging root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Module artifact staging root must be a real directory".to_string());
    }
    for entry in fs::read_dir(root)
        .map_err(|error| format!("Could not read module artifact staging root: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not read module artifact staging entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| {
            format!("Could not classify module artifact staging entry: {error}")
        })?;
        if file_type.is_symlink() || file_type.is_file() {
            return Ok(true);
        }
        if file_type.is_dir() && directory_contains_files(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Module artifact snapshot path is unsafe".to_string());
    }
    Ok(path.to_path_buf())
}
