use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::state::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};
use serde::{Deserialize, Serialize};

use super::contracts::normalized_schedule_path;

const SCHEDULE_ARCHIVE_SCHEMA_VERSION: u32 = 1;
const SCHEDULE_SOURCE_ROOT: &str = "schedules";
const SCHEDULE_ARCHIVE_ENTRY: &str = "definitions";

/// Preserves one instance's file-defined scheduler configuration as a single
/// portable archive payload. It owns the dynamic directory classification while
/// the archive coordinator continues to reject every unclaimed durable file.
pub struct SchedulerSnapshotProvider {
    schedule_root: PathBuf,
}

impl SchedulerSnapshotProvider {
    pub fn new(schedule_root: PathBuf) -> Self {
        Self { schedule_root }
    }
}

impl SnapshotProvider for SchedulerSnapshotProvider {
    fn id(&self) -> &'static str {
        "scheduler.configuration"
    }

    fn schema_version(&self) -> u32 {
        SCHEDULE_ARCHIVE_SCHEMA_VERSION
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![SnapshotEntryDeclaration {
            id: SCHEDULE_ARCHIVE_ENTRY,
            classification: SnapshotClassification::Portable,
            source_paths: vec![PathBuf::from(SCHEDULE_SOURCE_ROOT)],
            target_path: Some(PathBuf::from(SCHEDULE_SOURCE_ROOT)),
            redaction: "schedule definitions only; secret-bearing payloads are rejected by scheduler validation",
        }]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        let payload = match fs::symlink_metadata(&self.schedule_root) {
            Ok(_) => Some(encode_bundle(&read_schedule_files(&self.schedule_root)?)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not inspect schedule root: {error}")),
        };
        Ok(vec![CapturedSnapshotEntry {
            id: SCHEDULE_ARCHIVE_ENTRY,
            decision: if payload.is_some() {
                "included".to_string()
            } else {
                "source_absent".to_string()
            },
            payload,
        }])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != SCHEDULE_ARCHIVE_ENTRY {
            return Err(format!("Unknown scheduler snapshot entry {entry_id}"));
        }
        let bundle: ScheduleArchiveBundle = serde_json::from_slice(payload)
            .map_err(|error| format!("Scheduler archive payload is invalid: {error}"))?;
        if bundle.schema_version != SCHEDULE_ARCHIVE_SCHEMA_VERSION {
            return Err("Scheduler archive payload schema version is unsupported".to_string());
        }
        for filename in bundle.files.keys() {
            normalized_schedule_path(Path::new(filename)).map_err(|error| {
                format!("Scheduler archive payload path is unsafe: {}", error.code)
            })?;
        }
        Ok(())
    }

    fn restore_payload(
        &self,
        entry_id: &str,
        payload: &[u8],
        staging_state_root: &Path,
    ) -> Result<(), String> {
        self.validate_payload(entry_id, payload)?;
        let bundle: ScheduleArchiveBundle = serde_json::from_slice(payload)
            .map_err(|error| format!("Scheduler archive payload is invalid: {error}"))?;
        let target_root = staging_state_root.join(SCHEDULE_SOURCE_ROOT);
        fs::create_dir_all(&target_root)
            .map_err(|error| format!("Could not create scheduler restore directory: {error}"))?;
        for (filename, contents) in bundle.files {
            let filename = normalized_schedule_path(Path::new(&filename)).map_err(|error| {
                format!("Scheduler archive payload path is unsafe: {}", error.code)
            })?;
            let target = target_root.join(filename);
            fs::write(&target, contents).map_err(|error| {
                format!(
                    "Could not restore scheduler source {}: {error}",
                    target.display()
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).map_err(
                    |error| {
                        format!(
                            "Could not secure scheduler source {}: {error}",
                            target.display()
                        )
                    },
                )?;
            }
        }
        Ok(())
    }

    fn owns_source_path(&self, source_path: &Path) -> bool {
        let Ok(relative) = source_path.strip_prefix(SCHEDULE_SOURCE_ROOT) else {
            return false;
        };
        normalized_schedule_path(relative).is_ok()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleArchiveBundle {
    schema_version: u32,
    files: BTreeMap<String, Vec<u8>>,
}

fn read_schedule_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect schedule root: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Schedule root must be a real directory".to_string());
    }
    let mut files = BTreeMap::new();
    for entry in
        fs::read_dir(root).map_err(|error| format!("Could not inspect schedule root: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect schedule entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not classify schedule entry: {error}"))?;
        if file_type.is_symlink() {
            return Err("Schedule source must not be a symbolic link".to_string());
        }
        if !file_type.is_file() {
            return Err("Schedule sources must be direct regular files".to_string());
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "Schedule source escaped its root".to_string())?
            .to_path_buf();
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Schedule source path is unsafe".to_string());
        }
        let filename = normalized_schedule_path(&relative)
            .map_err(|error| format!("Schedule source path is unsafe: {}", error.code))?;
        let contents = fs::read(entry.path())
            .map_err(|error| format!("Could not read scheduler source {filename}: {error}"))?;
        files.insert(filename, contents);
    }
    Ok(files)
}

fn encode_bundle(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&ScheduleArchiveBundle {
        schema_version: SCHEDULE_ARCHIVE_SCHEMA_VERSION,
        files: files.clone(),
    })
    .map_err(|error| format!("Could not encode scheduler archive payload: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn snapshot_provider_owns_only_direct_yaml_files_and_restores_them() {
        let source_root = tempdir().unwrap();
        let schedules = source_root.path().join(SCHEDULE_SOURCE_ROOT);
        fs::create_dir(&schedules).unwrap();
        fs::write(schedules.join("wake.yaml"), b"id: wake").unwrap();
        let provider = SchedulerSnapshotProvider::new(schedules);

        assert!(provider.owns_source_path(Path::new("schedules/wake.yaml")));
        assert!(!provider.owns_source_path(Path::new("schedules/nested/wake.yaml")));
        assert!(!provider.owns_source_path(Path::new("schedules/nested\\wake.yaml")));
        assert!(!provider.owns_source_path(Path::new("schedules/wake.txt")));

        let captured = provider.capture().unwrap();
        let payload = captured[0].payload.as_deref().unwrap();
        provider
            .validate_payload(SCHEDULE_ARCHIVE_ENTRY, payload)
            .unwrap();
        let staging = tempdir().unwrap();
        provider
            .restore_payload(SCHEDULE_ARCHIVE_ENTRY, payload, staging.path())
            .unwrap();
        assert_eq!(
            fs::read(staging.path().join("schedules/wake.yaml")).unwrap(),
            b"id: wake"
        );
    }

    #[test]
    fn snapshot_provider_rejects_nested_and_non_yaml_sources() {
        let root = tempdir().unwrap();
        let schedules = root.path().join(SCHEDULE_SOURCE_ROOT);
        fs::create_dir(&schedules).unwrap();
        fs::create_dir(schedules.join("nested")).unwrap();
        let provider = SchedulerSnapshotProvider::new(schedules);
        assert!(provider.capture().unwrap_err().contains("direct regular"));

        let root = tempdir().unwrap();
        let schedules = root.path().join(SCHEDULE_SOURCE_ROOT);
        fs::create_dir(&schedules).unwrap();
        fs::write(schedules.join("wake.txt"), b"not a schedule").unwrap();
        let provider = SchedulerSnapshotProvider::new(schedules);
        assert!(provider.capture().unwrap_err().contains("path is unsafe"));
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_provider_fails_closed_for_schedule_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let schedules = root.path().join(SCHEDULE_SOURCE_ROOT);
        fs::create_dir(&schedules).unwrap();
        let external = root.path().join("external.yaml");
        fs::write(&external, b"not from this instance").unwrap();
        symlink(&external, schedules.join("linked.yaml")).unwrap();
        let provider = SchedulerSnapshotProvider::new(schedules);
        assert!(provider.capture().unwrap_err().contains("symbolic link"));

        let root = tempdir().unwrap();
        let schedules = root.path().join(SCHEDULE_SOURCE_ROOT);
        symlink(root.path().join("missing"), &schedules).unwrap();
        let provider = SchedulerSnapshotProvider::new(schedules);
        assert!(provider.capture().unwrap_err().contains("real directory"));
    }
}
