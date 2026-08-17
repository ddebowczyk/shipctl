//! Durable assistant recovery manifest.

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::AssistantSessionRecord;

pub const MANIFEST_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssistantSessionManifest {
    pub version: u32,
    pub sessions: Vec<AssistantSessionRecord>,
}

impl Default for AssistantSessionManifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            sessions: Vec::new(),
        }
    }
}

pub fn read(path: &Path) -> Result<AssistantSessionManifest, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read restore manifest: {error}"))?;
    let manifest: AssistantSessionManifest = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse restore manifest: {error}"))?;
    if manifest.version > MANIFEST_VERSION {
        return Err(format!(
            "Restore manifest version {} is newer than supported version {MANIFEST_VERSION}",
            manifest.version
        ));
    }
    if manifest.version != MANIFEST_VERSION {
        return Err(format!(
            "Unsupported restore manifest version {}",
            manifest.version
        ));
    }
    Ok(manifest)
}

/// Write a complete manifest before mutating any associated process state.
///
/// The temporary file lives beside the destination so rename is atomic on the
/// same volume. Permissions are set explicitly because this data identifies
/// local coding sessions and directories.
pub fn write_atomically(path: &Path, manifest: &AssistantSessionManifest) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Restore manifest has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create restore manifest directory: {error}"))?;
    set_restrictive_permissions(parent)?;

    let serialized = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Failed to serialize restore manifest: {error}"))?;
    let temp_path = temporary_path(path);
    let mut file = create_private_file(&temp_path)?;

    let write_result = (|| {
        file.write_all(&serialized)
            .map_err(|error| format!("Failed to write restore manifest: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Failed to finalize restore manifest: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync restore manifest: {error}"))?;
        drop(file);
        fs::rename(&temp_path, path)
            .map_err(|error| format!("Failed to atomically replace restore manifest: {error}"))?;
        set_restrictive_permissions(path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

pub fn quarantine(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Restore manifest has no parent directory".to_string())?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("assistant-sessions");
    let quarantined = parent.join(format!("{stem}.{reason}-{}", timestamp_suffix()));
    fs::rename(path, &quarantined)
        .map_err(|error| format!("Failed to quarantine restore manifest: {error}"))?;
    Ok(quarantined)
}

fn temporary_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("assistant-sessions.json");
    parent.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        timestamp_suffix()
    ))
}

fn timestamp_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Failed to create temporary restore manifest: {error}"))
}

fn set_restrictive_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Failed to secure restore manifest permissions: {error}"))?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Failed to sync restore manifest directory: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{AssistantProvider, AssistantSessionRecord, CaptureState, SessionMode};
    use super::{read, write_atomically, AssistantSessionManifest, MANIFEST_VERSION};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let directory = std::env::temp_dir().join(format!(
            "shipctl-assistant-session-manifest-test-{}-{sequence}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn sample_record() -> AssistantSessionRecord {
        AssistantSessionRecord {
            record_id: "record-1".to_string(),
            provider: AssistantProvider::Claude,
            provider_session_id: Some("123e4567-e89b-12d3-a456-426614174000".to_string()),
            launch_repo_path: "/tmp/launch".to_string(),
            placement_project_path: "/tmp/placement".to_string(),
            label: "Claude Code".to_string(),
            session_mode: SessionMode::Standard,
            model: Some("sonnet".to_string()),
            capture_state: CaptureState::Ready,
            restore_on_next_launch: true,
            started_at: 1,
            updated_at: 2,
        }
    }

    #[test]
    fn atomically_replaces_a_manifest_without_leaving_a_temporary_file() {
        let directory = fixture_dir("atomic-replace");
        let path = directory.join("assistant-sessions.json");
        write_atomically(&path, &AssistantSessionManifest::default()).unwrap();

        let replacement = AssistantSessionManifest {
            version: MANIFEST_VERSION,
            sessions: vec![sample_record()],
        };
        write_atomically(&path, &replacement).unwrap();

        let loaded = read(&path).unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].record_id, "record-1");
        assert!(fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn serializes_only_the_explicit_restore_record_fields() {
        let manifest = AssistantSessionManifest {
            version: MANIFEST_VERSION,
            sessions: vec![sample_record()],
        };

        let json = serde_json::to_value(manifest).unwrap();
        let mut fields = json["sessions"][0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        fields.sort();

        assert_eq!(
            fields,
            vec![
                "captureState",
                "label",
                "launchRepoPath",
                "model",
                "placementProjectPath",
                "provider",
                "providerSessionId",
                "recordId",
                "restoreOnNextLaunch",
                "sessionMode",
                "startedAt",
                "updatedAt",
            ]
        );
    }
}
