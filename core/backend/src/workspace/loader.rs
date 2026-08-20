use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::{
    GlobalConfig, GroupEntry, RegisteredRepo, RepoEntry, RepoInfo, WorkspaceConfig,
};
use crate::state::paths::ShipctlPaths;
use crate::state::DurableWriteBarrier;

type ConfigCache = Option<(GlobalConfig, SystemTime)>;

pub struct GlobalStore {
    paths: ShipctlPaths,
    cache: Mutex<ConfigCache>,
    durable_writes: DurableWriteBarrier,
}

impl GlobalStore {
    pub fn new(paths: ShipctlPaths) -> Self {
        Self::new_with_barrier(paths, DurableWriteBarrier::default())
    }

    pub fn new_with_barrier(paths: ShipctlPaths, durable_writes: DurableWriteBarrier) -> Self {
        Self {
            paths,
            cache: Mutex::new(None),
            durable_writes,
        }
    }
}

// ── Paths ───────────────────────────────────────────────────────────
//
// State lives in `~/.shipctl` and `<repo>/.shipctl`. Matching predecessor
// profiles are copied once on startup by `workspace::migration`, never moved.
// Reads fall back to the legacy path so a repository not yet migrated still
// opens.

fn repo_shipctl_dir(repo_path: &str) -> std::path::PathBuf {
    Path::new(repo_path).join(super::migration::HOME_DIR_NAME)
}

fn repo_workspace_file(repo_path: &str) -> std::path::PathBuf {
    repo_shipctl_dir(repo_path).join("workspace.yml")
}

/// Where to *read* a repo's workspace from: the current path if it exists,
/// otherwise the legacy one. Writes always go to the current path and leave
/// the predecessor file intact.
fn repo_workspace_read_path(repo_path: &str) -> std::path::PathBuf {
    let current = repo_workspace_file(repo_path);
    if current.exists() {
        return current;
    }
    let legacy = Path::new(repo_path)
        .join(super::migration::LEGACY_DIR_NAME)
        .join("workspace.yml");
    if legacy.exists() {
        return legacy;
    }
    current
}

// ── Global config ───────────────────────────────────────────────────

pub fn load_global_config(store: &GlobalStore) -> Result<GlobalConfig, String> {
    let mut cache = store
        .cache
        .lock()
        .map_err(|_| "Global config lock is poisoned".to_string())?;
    load_global_config_at(&store.paths.global_config, &mut cache)
}

fn load_global_config_at(path: &Path, cache: &mut ConfigCache) -> Result<GlobalConfig, String> {
    if !path.exists() {
        return Ok(GlobalConfig::default());
    }

    let mtime = fs::metadata(&path)
        .and_then(|m| m.modified())
        .unwrap_or(UNIX_EPOCH);

    if let Some((cached, cached_mtime)) = cache.as_ref() {
        if *cached_mtime == mtime {
            return Ok(cached.clone());
        }
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read global config: {e}"))?;
    let config: GlobalConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse global config: {e}"))?;

    *cache = Some((config.clone(), mtime));

    Ok(config)
}

pub fn save_global_config(store: &GlobalStore, config: &GlobalConfig) -> Result<(), String> {
    let _durable_update = store.durable_writes.enter_update()?;
    let mut cache = store
        .cache
        .lock()
        .map_err(|_| "Global config lock is poisoned".to_string())?;
    save_global_config_at(&store.paths.global_config, config, &mut cache)
}

fn save_global_config_at(
    path: &Path,
    config: &GlobalConfig,
    cache: &mut ConfigCache,
) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Global config path has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create .shipctl dir: {e}"))?;

    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, &yaml).map_err(|e| format!("Failed to write global config: {e}"))?;

    // Update cache with the config we just wrote
    if let Ok(mtime) = fs::metadata(&path).and_then(|m| m.modified()) {
        *cache = Some((config.clone(), mtime));
    }

    Ok(())
}

fn mutate_global_config<T>(
    store: &GlobalStore,
    mutation: impl FnOnce(&mut GlobalConfig) -> Result<T, String>,
) -> Result<T, String> {
    let _durable_update = store.durable_writes.enter_update()?;
    mutate_global_config_at(&store.paths.global_config, &store.cache, mutation)
}

fn mutate_global_config_at<T>(
    path: &Path,
    cache: &Mutex<ConfigCache>,
    mutation: impl FnOnce(&mut GlobalConfig) -> Result<T, String>,
) -> Result<T, String> {
    let mut cache = cache
        .lock()
        .map_err(|_| "Global config lock is poisoned".to_string())?;
    let mut config = load_global_config_at(path, &mut cache)?;
    let result = mutation(&mut config)?;
    save_global_config_at(path, &config, &mut cache)?;
    Ok(result)
}

pub fn load_global_capability_data(
    store: &GlobalStore,
    capability_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    load_global_config(store)?.capability_value(capability_id)
}

/// Read an opaque legacy global configuration value for the one-way
/// TypeScript migration. This intentionally bypasses the generic
/// capability-data reservation: it is a compatibility source, not a new
/// authority or a typed native settings API.
pub fn read_global_configuration_value(
    store: &GlobalStore,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    Ok(load_global_config(store)?.capability_data.get(key).cloned())
}

pub fn replace_global_capability_data(
    store: &GlobalStore,
    capability_id: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    mutate_global_config(store, |config| {
        config.replace_capability_value(capability_id, value)
    })
}

// ── Repo operations ─────────────────────────────────────────────────

pub fn list_repos(store: &GlobalStore) -> Result<Vec<RepoInfo>, String> {
    let config = load_global_config(store)?;

    let repos = config
        .repos
        .iter()
        .map(|entry| {
            let path = Path::new(&entry.path);
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            RepoInfo {
                path: entry.path.clone(),
                name,
                group: entry.group.clone(),
            }
        })
        .collect();
    Ok(repos)
}

pub fn register_repo(store: &GlobalStore, repo_path: &str) -> Result<RegisteredRepo, String> {
    let path = Path::new(repo_path);
    if !path.is_dir() {
        return Err(format!("Directory does not exist: {repo_path}"));
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Add to global config if not already there.
    mutate_global_config(store, |config| {
        if !config.repos.iter().any(|r| r.path == canonical_str) {
            config.repos.push(RepoEntry {
                path: canonical_str.clone(),
                group: None,
            });
        }
        Ok(())
    })?;

    // Load existing workspace config or return an in-memory default. We create
    // `.shipctl` lazily only when the user actually saves project config.
    let workspace = load_or_default_workspace(&canonical_str)?;
    Ok(RegisteredRepo {
        path: canonical_str,
        workspace,
    })
}

pub fn unregister_repo(store: &GlobalStore, repo_path: &str) -> Result<(), String> {
    mutate_global_config(store, |config| {
        config.repos.retain(|r| r.path != repo_path);
        Ok(())
    })
}

// ── Per-repo workspace ──────────────────────────────────────────────

pub fn load_repo_workspace(repo_path: &str) -> Result<WorkspaceConfig, String> {
    load_or_default_workspace(repo_path)
}

/// Read an opaque legacy project configuration value for the documented
/// temporary bootstrap exception. The workspace plugin will import these
/// values into its plugin-data namespace before this compatibility reader is
/// deleted.
pub fn read_project_configuration_value(
    repo_path: &str,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    let workspace = load_or_default_workspace(repo_path)?;
    let Some(value) = workspace.capability_data.get(key) else {
        return Ok(None);
    };

    serde_json::to_value(value)
        .map(Some)
        .map_err(|error| format!("Failed to encode legacy project configuration {key}: {error}"))
}

pub fn save_repo_workspace(repo_path: &str, config: &WorkspaceConfig) -> Result<(), String> {
    ensure_repo_shipctl_dir(repo_path)?;

    let path = repo_workspace_file(repo_path);
    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, yaml).map_err(|e| format!("Failed to write workspace file: {e}"))
}

// ── Migration ───────────────────────────────────────────────────────

pub fn migrate_old_projects(store: &GlobalStore) -> Result<(), String> {
    let old_dir = &store.paths.old_projects;
    if !old_dir.exists() {
        return Ok(());
    }

    // Check if we already have a global config (migration already done)
    let global_path = &store.paths.global_config;
    if global_path.exists() {
        return Ok(());
    }

    let mut global_config = GlobalConfig::default();

    let entries =
        fs::read_dir(&old_dir).map_err(|e| format!("Failed to read old projects: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let old_workspace_file = path.join("workspace.yml");
        if !old_workspace_file.exists() {
            continue;
        }

        let content = match fs::read_to_string(&old_workspace_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Parse the predecessor document. Only `cwd` and `name` belonged to
        // the migration envelope; every other top-level value stays opaque so
        // its owning TypeScript capability can migrate it without a native
        // product grammar.
        let old_config: serde_yaml::Value = match serde_yaml::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let cwd = old_config
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if cwd.is_empty() || !Path::new(&cwd).is_dir() {
            continue;
        }

        let name = old_config
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let capability_data = old_config
            .as_mapping()
            .map(|mapping| {
                mapping
                    .iter()
                    .filter_map(|(key, value)| {
                        let key = key.as_str()?;
                        (!matches!(key, "cwd" | "name")).then(|| (key.to_string(), value.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let workspace = WorkspaceConfig {
            name: if name.is_empty() {
                Path::new(&cwd)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            } else {
                name
            },
            capability_data,
        };

        // Write to repo's .shipctl/workspace.yml
        if ensure_repo_shipctl_dir(&cwd).is_ok() {
            let _ = save_repo_workspace(&cwd, &workspace);
        }

        // Add to global registry
        global_config.repos.push(RepoEntry {
            path: cwd,
            group: None,
        });
    }

    if !global_config.repos.is_empty() {
        save_global_config(store, &global_config)?;
    }

    Ok(())
}

// ── Group operations ───────────────────────────────────────────────

pub fn list_groups(store: &GlobalStore) -> Result<Vec<GroupEntry>, String> {
    let config = load_global_config(store)?;
    let mut groups = config.groups;
    groups.sort_by_key(|g| g.order);
    Ok(groups)
}

pub fn create_group(store: &GlobalStore, name: &str) -> Result<GroupEntry, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Group name cannot be empty".to_string());
    }

    let id = format!(
        "{}-{}",
        slug_from_name(trimmed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    mutate_global_config(store, |config| {
        let next_order = config.groups.iter().map(|g| g.order).max().unwrap_or(0) + 1;
        let entry = GroupEntry {
            id,
            name: trimmed.to_string(),
            order: next_order,
        };
        config.groups.push(entry.clone());
        Ok(entry)
    })
}

pub fn rename_group(store: &GlobalStore, group_id: &str, new_name: &str) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Group name cannot be empty".to_string());
    }

    mutate_global_config(store, |config| {
        let group = config
            .groups
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| format!("Group not found: {group_id}"))?;
        group.name = trimmed.to_string();
        Ok(())
    })
}

pub fn delete_group(store: &GlobalStore, group_id: &str) -> Result<(), String> {
    mutate_global_config(store, |config| {
        config.groups.retain(|g| g.id != group_id);
        // Ungroup any repos that belonged to this group
        for repo in &mut config.repos {
            if repo.group.as_deref() == Some(group_id) {
                repo.group = None;
            }
        }
        Ok(())
    })
}

pub fn move_repo_to_group(
    store: &GlobalStore,
    repo_path: &str,
    group_id: Option<&str>,
) -> Result<(), String> {
    mutate_global_config(store, |config| {
        // Validate group exists (if setting, not clearing)
        if let Some(gid) = group_id {
            if !config.groups.iter().any(|g| g.id == gid) {
                return Err(format!("Group not found: {gid}"));
            }
        }

        let repo = config
            .repos
            .iter_mut()
            .find(|r| r.path == repo_path)
            .ok_or_else(|| format!("Repo not found: {repo_path}"))?;
        repo.group = group_id.map(|s| s.to_string());
        Ok(())
    })
}

fn slug_from_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

// ── Helpers ─────────────────────────────────────────────────────────

fn ensure_repo_shipctl_dir(repo_path: &str) -> Result<(), String> {
    // Copy predecessor state first, so the new directory starts from the
    // project's existing state rather than a blank default. The legacy
    // directory remains untouched.
    let _ = super::migration::migrate_repo_state(repo_path);

    let shipctl_dir = repo_shipctl_dir(repo_path);
    fs::create_dir_all(&shipctl_dir).map_err(|e| format!("Failed to create .shipctl dir: {e}"))?;

    // Create .gitignore in .shipctl/ to ignore everything
    let gitignore = shipctl_dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, "*\n").map_err(|e| format!("Failed to write .gitignore: {e}"))?;
    }

    Ok(())
}

fn load_or_default_workspace(repo_path: &str) -> Result<WorkspaceConfig, String> {
    let path = repo_workspace_read_path(repo_path);
    if path.exists() {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read workspace file: {e}"))?;
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse workspace YAML: {e}"))
    } else {
        let name = Path::new(repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let config = WorkspaceConfig {
            name,
            capability_data: Default::default(),
        };

        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        load_global_config_at, mutate_global_config_at, save_global_config_at, ConfigCache,
    };
    use crate::workspace::config::GlobalConfig;

    #[test]
    fn concurrent_global_mutations_cannot_lose_host_or_capability_updates() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "shipctl-global-config-atomic-{}-{unique}.yml",
            std::process::id()
        ));
        let cache: Arc<Mutex<ConfigCache>> = Arc::new(Mutex::new(None));

        let mut initial = GlobalConfig::default();
        initial.capability_data.insert(
            "futureCapability".to_string(),
            serde_json::json!({ "density": "compact" }),
        );
        save_global_config_at(&path, &initial, &mut cache.lock().unwrap()).unwrap();

        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first_path = path.clone();
        let first_cache = Arc::clone(&cache);
        let first = thread::spawn(move || {
            mutate_global_config_at(&first_path, &first_cache, |config| {
                config.repos.push(crate::workspace::config::RepoEntry {
                    path: "/tmp/first-repo".to_string(),
                    group: None,
                });
                first_entered_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
                Ok(())
            })
        });

        first_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first mutation should hold the transaction lock");

        let (second_started_tx, second_started_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second_path = path.clone();
        let second_cache = Arc::clone(&cache);
        let second = thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            mutate_global_config_at(&second_path, &second_cache, |config| {
                second_entered_tx.send(()).unwrap();
                config.replace_capability_value(
                    "exampleCapability",
                    serde_json::json!({ "enabled": true }),
                )
            })
        });

        second_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second mutation should attempt the transaction");
        assert!(
            second_entered_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "second mutation entered while the first transaction was paused"
        );

        release_first_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second mutation should enter after the first commits");
        second.join().unwrap().unwrap();

        let final_config = load_global_config_at(&path, &mut cache.lock().unwrap()).unwrap();
        assert!(final_config
            .repos
            .iter()
            .any(|repo| repo.path == "/tmp/first-repo"));
        assert_eq!(
            final_config.capability_value("exampleCapability").unwrap(),
            Some(serde_json::json!({ "enabled": true }))
        );
        assert_eq!(
            final_config.capability_value("futureCapability").unwrap(),
            Some(serde_json::json!({ "density": "compact" }))
        );

        fs::remove_file(path).unwrap();
    }
}
