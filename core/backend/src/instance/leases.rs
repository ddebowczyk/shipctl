use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use fs4::{FileExt, TryLockError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::context::InstanceContext;
use super::protocol::ControlError;

pub struct InstanceLeases {
    _name: File,
    _state_root: File,
    pub name_path: PathBuf,
    pub state_root_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRecord<'a> {
    instance_id: uuid::Uuid,
    name: &'a str,
    state_root: &'a Path,
    process_id: u32,
    process_started_at: u64,
}

impl InstanceLeases {
    pub fn acquire(context: &InstanceContext) -> Result<Self, ControlError> {
        let lease_root = context.runtime_root.join("leases").join("names");
        create_private_directory(&lease_root).map_err(|error| {
            ControlError::new(
                "control.instance.lease_setup_failed",
                format!("Could not create the private lease directory: {error}"),
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;

        let name_path = lease_root.join(format!("{}.lock", digest(context.name.as_bytes())));
        let state_root_path = state_root_lease_path(&context.state_root);
        let record = LeaseRecord {
            instance_id: context.instance_id,
            name: &context.name,
            state_root: &context.state_root,
            process_id: std::process::id(),
            process_started_at: current_process_start_time().map_err(|error| {
                ControlError::new("control.instance.process_identity_failed", error)
                    .for_context(context.instance_id, context.state_root.clone())
            })?,
        };

        let name = acquire(
            &name_path,
            "control.instance.name_in_use",
            "The requested instance name is already owned by a live process",
            context,
            &record,
        )?;
        let state_root = match acquire(
            &state_root_path,
            "control.instance.state_root_in_use",
            "The requested writable state root is already owned by a live process",
            context,
            &record,
        ) {
            Ok(file) => file,
            Err(error) => {
                drop(name);
                return Err(error);
            }
        };

        Ok(Self {
            _name: name,
            _state_root: state_root,
            name_path,
            state_root_path,
        })
    }
}

fn acquire(
    path: &Path,
    code: &str,
    message: &str,
    context: &InstanceContext,
    record: &LeaseRecord<'_>,
) -> Result<File, ControlError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            ControlError::new(
                "control.instance.lease_setup_failed",
                format!("Could not open lease {}: {error}", path.display()),
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;
    set_private_file(path).map_err(|error| {
        ControlError::new(
            "control.instance.lease_setup_failed",
            format!("Could not protect lease {}: {error}", path.display()),
        )
        .for_context(context.instance_id, context.state_root.clone())
    })?;

    FileExt::try_lock(&file).map_err(|error| {
        let observed = if matches!(error, TryLockError::WouldBlock) {
            "held by another process".to_string()
        } else {
            error.to_string()
        };
        ControlError::new(code, message)
            .for_context(context.instance_id, context.state_root.clone())
            .with_expected_observed("available exclusive lease", observed)
    })?;

    file.set_len(0)
        .and_then(|()| file.seek(SeekFrom::Start(0)).map(|_| ()))
        .and_then(|()| serde_json::to_writer(&mut file, record).map_err(std::io::Error::other))
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            ControlError::new(
                "control.instance.lease_setup_failed",
                format!("Could not record lease {}: {error}", path.display()),
            )
            .for_context(context.instance_id, context.state_root.clone())
        })?;
    Ok(file)
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn state_root_lease_path(state_root: &Path) -> PathBuf {
    let parent = state_root.parent().unwrap_or(state_root);
    parent.join(format!(
        ".shipctl-state-{}.lock",
        digest(&path_identity(state_root))
    ))
}

#[cfg(unix)]
fn path_identity(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn path_identity(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

pub(crate) fn process_start_time(process_id: u32) -> Option<u64> {
    let pid = Pid::from_u32(process_id);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).map(sysinfo::Process::start_time)
}

fn current_process_start_time() -> Result<u64, String> {
    process_start_time(std::process::id())
        .ok_or_else(|| "Could not resolve the UI process start identity".to_string())
}

pub(crate) fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(crate) fn set_private_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::context::{InstanceLaunchOptions, LaunchProvenance};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn context(name: &str, state_root: PathBuf, runtime_root: PathBuf) -> InstanceContext {
        InstanceContext::resolve(
            InstanceLaunchOptions {
                name: Some(name.to_string()),
                state_root: Some(state_root),
                runtime_root: Some(runtime_root),
                load_state: None,
                provenance: Some(LaunchProvenance::Cli),
            },
            "1.0.0",
        )
        .unwrap()
    }

    fn test_root(label: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "shipctl-leases-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn exactly_one_owner_can_hold_a_name_or_state_root() {
        let root = test_root("contention");
        let runtime = root.join("runtime");
        let first_context = context("same-name", root.join("first"), runtime.clone());
        let same_name_context = context("same-name", root.join("second"), runtime.clone());
        let same_root_context = context("other-name", root.join("first"), runtime);

        let first = InstanceLeases::acquire(&first_context).unwrap();
        let name_error = InstanceLeases::acquire(&same_name_context).unwrap_err();
        let root_error = InstanceLeases::acquire(&same_root_context).unwrap_err();

        assert_eq!(name_error.code.as_str(), "control.instance.name_in_use");
        assert_eq!(
            root_error.code.as_str(),
            "control.instance.state_root_in_use"
        );
        drop(first);
        assert!(InstanceLeases::acquire(&same_name_context).is_ok());
    }

    impl std::fmt::Debug for InstanceLeases {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("InstanceLeases")
                .field("name_path", &self.name_path)
                .field("state_root_path", &self.state_root_path)
                .finish()
        }
    }
}
