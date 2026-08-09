//! One-time copy of legacy state into the current application profile.
//!
//! This is a **copy**, not a move. The legacy profile remains intact, so an
//! earlier installation can keep using it independently after migration.
//!
//! The copy runs once. `~/.shipctl` existing is itself the "already migrated"
//! marker, so there is no separate state file to keep honest.

use std::fs;
use std::path::{Path, PathBuf};

/// Directory name used by the predecessor application. Keep this value only
/// for one-way state import; no current Shipctl state is written beneath it.
pub const LEGACY_DIR_NAME: &str = ".shep";
/// Directory this build stores state in.
pub const HOME_DIR_NAME: &str = ".shipctl";

/// SQLite's shared-memory file is a pure cache keyed to a live connection.
/// Copying a stale one next to a copied WAL can confuse recovery, so it is
/// skipped — SQLite rebuilds it, and replays the copied `-wal`, on next open.
const SKIP_SUFFIXES: &[&str] = &["-shm"];

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// `~/.shipctl` already present; nothing to do.
    AlreadyPresent,
    /// No legacy profile to copy from — a clean install.
    NoLegacyState,
    /// Copied this many files out of the legacy directory.
    Copied(usize),
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())
}

/// Copy the legacy home profile if and only if the current profile is absent.
pub fn migrate_home_state() -> Result<Outcome, String> {
    let home = home()?;
    copy_tree_once(&home.join(LEGACY_DIR_NAME), &home.join(HOME_DIR_NAME))
}

/// Copy the legacy profile into an already-resolved default state root.
///
/// Instance resolution creates and canonicalizes its root before any migration.
/// An empty directory is therefore still a clean migration target; a populated
/// directory remains the once-only marker and is never overwritten.
pub fn migrate_home_state_to(target: &Path) -> Result<Outcome, String> {
    let home = home()?;
    copy_tree_into_empty(&home.join(LEGACY_DIR_NAME), target)
}

/// Copy a legacy project profile under the same once-only rule.
///
/// Per-repo state is local — the app writes a `.gitignore` of `*` into the
/// directory — so this only ever touches files the user does not track.
pub fn migrate_repo_state(repo_path: &str) -> Result<Outcome, String> {
    let repo = Path::new(repo_path);
    copy_tree_once(&repo.join(LEGACY_DIR_NAME), &repo.join(HOME_DIR_NAME))
}

fn copy_tree_once(from: &Path, to: &Path) -> Result<Outcome, String> {
    if to.exists() {
        return Ok(Outcome::AlreadyPresent);
    }
    if !from.is_dir() {
        return Ok(Outcome::NoLegacyState);
    }

    // Stage into a sibling temp directory and rename into place, so an
    // interrupted copy cannot leave a half-populated `~/.shipctl` that the
    // next launch would mistake for a completed migration.
    let staging = staging_path(to);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }

    let copied = match copy_dir(from, &staging) {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    fs::rename(&staging, to).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("Failed to move migrated state into {}: {e}", to.display())
    })?;

    Ok(Outcome::Copied(copied))
}

fn copy_tree_into_empty(from: &Path, to: &Path) -> Result<Outcome, String> {
    if !to.is_dir() {
        return copy_tree_once(from, to);
    }
    if fs::read_dir(to)
        .map_err(|error| format!("Failed to inspect {}: {error}", to.display()))?
        .next()
        .is_some()
    {
        return Ok(Outcome::AlreadyPresent);
    }
    if !from.is_dir() {
        return Ok(Outcome::NoLegacyState);
    }

    let staging = staging_path(to);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let copied = match copy_dir(from, &staging) {
        Ok(copied) => copied,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    fs::remove_dir(to)
        .map_err(|error| format!("Failed to replace empty {}: {error}", to.display()))?;
    fs::rename(&staging, to).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        format!(
            "Failed to move migrated state into {}: {error}",
            to.display()
        )
    })?;
    Ok(Outcome::Copied(copied))
}

fn staging_path(to: &Path) -> PathBuf {
    let name = to
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(HOME_DIR_NAME);
    to.with_file_name(format!("{name}.migrating"))
}

fn copy_dir(from: &Path, to: &Path) -> Result<usize, String> {
    fs::create_dir_all(to).map_err(|e| format!("Failed to create {}: {e}", to.display()))?;

    let mut copied = 0;
    let entries =
        fs::read_dir(from).map_err(|e| format!("Failed to read {}: {e}", from.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read {}: {e}", from.display()))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if SKIP_SUFFIXES.iter().any(|s| name_str.ends_with(s)) {
            continue;
        }

        let src = entry.path();
        let dst = to.join(&name);
        let kind = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {e}", src.display()))?;

        if kind.is_dir() {
            copied += copy_dir(&src, &dst)?;
        } else if kind.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("Failed to copy {}: {e}", src.display()))?;
            copied += 1;
        }
        // Symlinks are deliberately skipped: nothing this app writes creates
        // them, and following one would copy state from outside the directory.
    }

    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(label: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "shipctl-migration-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_legacy_state_and_leaves_the_original_in_place() {
        let root = temp_dir("copy");
        let legacy = root.join(LEGACY_DIR_NAME);
        fs::create_dir_all(legacy.join("session-recovery")).unwrap();
        fs::write(legacy.join("config.yml"), "theme: dark").unwrap();
        fs::write(legacy.join("session-recovery/a.json"), "{}").unwrap();

        let target = root.join(".shipctl");
        assert_eq!(
            copy_tree_once(&legacy, &target).unwrap(),
            Outcome::Copied(2)
        );

        assert_eq!(
            fs::read_to_string(target.join("config.yml")).unwrap(),
            "theme: dark"
        );
        assert!(target.join("session-recovery/a.json").exists());
        // The old build keeps working: its directory is untouched.
        assert!(legacy.join("config.yml").exists());
    }

    #[test]
    fn skips_sqlite_shm_but_copies_the_wal() {
        let root = temp_dir("sqlite");
        let legacy = root.join(LEGACY_DIR_NAME);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("usage.sqlite3"), "db").unwrap();
        fs::write(legacy.join("usage.sqlite3-wal"), "wal").unwrap();
        fs::write(legacy.join("usage.sqlite3-shm"), "shm").unwrap();

        let target = root.join(".shipctl");
        assert_eq!(
            copy_tree_once(&legacy, &target).unwrap(),
            Outcome::Copied(2)
        );

        assert!(target.join("usage.sqlite3").exists());
        assert!(target.join("usage.sqlite3-wal").exists());
        assert!(!target.join("usage.sqlite3-shm").exists());
    }

    #[test]
    fn runs_once_and_never_overwrites_existing_state() {
        let root = temp_dir("once");
        let legacy = root.join(LEGACY_DIR_NAME);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("config.yml"), "old").unwrap();

        let target = root.join(".shipctl");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("config.yml"), "new").unwrap();

        assert_eq!(
            copy_tree_once(&legacy, &target).unwrap(),
            Outcome::AlreadyPresent
        );
        assert_eq!(
            fs::read_to_string(target.join("config.yml")).unwrap(),
            "new"
        );
    }

    #[test]
    fn a_clean_install_is_not_an_error() {
        let root = temp_dir("clean");
        assert_eq!(
            copy_tree_once(&root.join(LEGACY_DIR_NAME), &root.join(HOME_DIR_NAME)).unwrap(),
            Outcome::NoLegacyState
        );
        assert!(!root.join(".shipctl").exists());
    }

    #[test]
    fn leaves_no_staging_directory_behind() {
        let root = temp_dir("staging");
        let legacy = root.join(LEGACY_DIR_NAME);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("config.yml"), "x").unwrap();

        let target = root.join(".shipctl");
        copy_tree_once(&legacy, &target).unwrap();
        assert!(!staging_path(&target).exists());
    }

    #[test]
    fn resolved_empty_target_can_receive_legacy_state() {
        let root = temp_dir("resolved");
        let legacy = root.join(LEGACY_DIR_NAME);
        let target = root.join(".shipctl");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("config.yml"), "old").unwrap();

        assert_eq!(
            copy_tree_into_empty(&legacy, &target).unwrap(),
            Outcome::Copied(1)
        );
        assert_eq!(
            fs::read_to_string(target.join("config.yml")).unwrap(),
            "old"
        );
    }
}
