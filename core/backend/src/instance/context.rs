use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::build_info::CONTROL_PROTOCOL_VERSION;
use crate::state::paths::DurableSource;
use crate::state::paths::ShipctlPaths;

pub const DEFAULT_INSTANCE_NAME: &str = "main";
pub const STATE_DIR_ENV: &str = "SHIPCTL_STATE_DIR";
pub const RUNTIME_DIR_ENV: &str = "SHIPCTL_RUNTIME_DIR";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootSource {
    Explicit,
    Environment,
    PlatformDefault,
    CacheFallback,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchProvenance {
    DirectUi,
    Cli,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceBuildIdentity {
    pub app_version: String,
    pub control_protocol_version: u32,
}

#[derive(Clone, Debug, Default)]
pub struct InstanceLaunchOptions {
    pub name: Option<String>,
    pub state_root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    pub load_state: Option<PathBuf>,
    pub provenance: Option<LaunchProvenance>,
}

impl InstanceLaunchOptions {
    pub fn from_args(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut values = args.into_iter();
        let _program = values.next();
        let mut options = Self::default();
        while let Some(argument) = values.next() {
            let argument = argument
                .into_string()
                .map_err(|_| "Shipctl UI arguments must be valid Unicode".to_string())?;
            let (flag, inline_value) = argument
                .split_once('=')
                .map_or((argument.as_str(), None), |(flag, value)| {
                    (flag, Some(value))
                });
            match flag {
                "--name" => options.name = Some(next_argument(flag, inline_value, &mut values)?),
                "--state-root" => {
                    options.state_root = Some(PathBuf::from(next_argument(
                        flag,
                        inline_value,
                        &mut values,
                    )?))
                }
                "--runtime-root" => {
                    options.runtime_root = Some(PathBuf::from(next_argument(
                        flag,
                        inline_value,
                        &mut values,
                    )?))
                }
                "--load-state" => {
                    options.load_state = Some(PathBuf::from(next_argument(
                        flag,
                        inline_value,
                        &mut values,
                    )?))
                }
                "--launched-by-cli" if inline_value.is_none() => {
                    options.provenance = Some(LaunchProvenance::Cli)
                }
                _ => return Err(format!("Unknown shipctl-ui argument: {argument}")),
            }
        }
        Ok(options)
    }
}

fn next_argument(
    flag: &str,
    inline_value: Option<&str>,
    values: &mut impl Iterator<Item = OsString>,
) -> Result<String, String> {
    match inline_value {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        Some(_) => Err(format!("{flag} requires a value")),
        None => values
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?
            .into_string()
            .map_err(|_| format!("{flag} value must be valid Unicode")),
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstanceContext {
    pub instance_id: Uuid,
    pub name: String,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub state_root_source: RootSource,
    pub runtime_root_source: RootSource,
    pub build: InstanceBuildIdentity,
    pub launch_provenance: LaunchProvenance,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstanceInspection {
    pub context: InstanceContext,
    pub durable_sources: Vec<DurableSource>,
}

impl InstanceContext {
    pub fn resolve(options: InstanceLaunchOptions, app_version: &str) -> Result<Self, String> {
        let name =
            validate_instance_name(options.name.as_deref().unwrap_or(DEFAULT_INSTANCE_NAME))?;
        let (state_root, state_root_source) =
            resolve_state_root_for(options.state_root.as_deref(), &name)?;
        let (runtime_root, runtime_root_source) =
            resolve_runtime_root(options.runtime_root.as_deref())?;

        Ok(Self {
            instance_id: Uuid::new_v4(),
            name,
            state_root,
            runtime_root,
            state_root_source,
            runtime_root_source,
            build: InstanceBuildIdentity {
                app_version: app_version.to_string(),
                control_protocol_version: CONTROL_PROTOCOL_VERSION,
            },
            launch_provenance: options.provenance.unwrap_or(LaunchProvenance::DirectUi),
        })
    }

    pub fn paths(&self) -> ShipctlPaths {
        ShipctlPaths::new(self.state_root.clone(), self.runtime_root.clone())
    }

    /// True only for the canonical instance sitting on its platform default
    /// root. This gates the one-way legacy state import, and a secondary named
    /// instance must start clean rather than inherit a copy of that data.
    pub fn uses_default_profile(&self) -> bool {
        self.state_root_source == RootSource::PlatformDefault && self.name == DEFAULT_INSTANCE_NAME
    }
}

pub fn validate_instance_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Instance name cannot be empty".to_string());
    }
    if value
        .chars()
        .any(|character| character.is_control() || character == '/' || character == '\\')
    {
        return Err(
            "Instance name cannot contain path separators or control characters".to_string(),
        );
    }
    Ok(value.to_string())
}

/// Home-relative directory name of the platform default state root for one
/// instance name.
///
/// A writable state root is owned exclusively by one live instance. The
/// canonical instance keeps the established `~/.shipctl` location, and every
/// other name resolves to a sibling directory, so a second named instance can
/// start beside the first instead of contending for its root.
pub fn default_state_root_name(instance_name: &str) -> String {
    let base = crate::workspace::migration::HOME_DIR_NAME;
    if instance_name == DEFAULT_INSTANCE_NAME {
        base.to_string()
    } else {
        format!("{base}-{instance_name}")
    }
}

pub fn resolve_state_root(explicit: Option<&Path>) -> Result<(PathBuf, RootSource), String> {
    resolve_state_root_for(explicit, DEFAULT_INSTANCE_NAME)
}

/// Resolve the state root for one named instance. Explicit paths and
/// `SHIPCTL_STATE_DIR` still win, in that order; only the platform default
/// varies by name.
pub fn resolve_state_root_for(
    explicit: Option<&Path>,
    instance_name: &str,
) -> Result<(PathBuf, RootSource), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;
    let environment = nonempty_path_env(STATE_DIR_ENV)?;
    let platform_default = home.join(default_state_root_name(instance_name));
    let (path, source) = select_state_root(explicit, environment.as_deref(), &platform_default);
    canonical_directory(path, source, "state root")
}

/// Resolve the established explicit/environment/default state-root precedence
/// without creating or otherwise mutating the selected directory.
pub fn resolve_state_root_read_only(
    explicit: Option<&Path>,
) -> Result<(PathBuf, RootSource), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;
    let environment = nonempty_path_env(STATE_DIR_ENV)?;
    let platform_default = home.join(crate::workspace::migration::HOME_DIR_NAME);
    let (path, source) = select_state_root(explicit, environment.as_deref(), &platform_default);
    read_only_directory(path, source, "state root")
}

/// Resolve the established explicit/environment/default runtime-root precedence
/// without creating or otherwise mutating the selected directory.
pub fn resolve_runtime_root_read_only(
    explicit: Option<&Path>,
) -> Result<(PathBuf, RootSource), String> {
    let environment = nonempty_path_env(RUNTIME_DIR_ENV)?;
    let (platform_default, source) = match dirs::runtime_dir() {
        Some(path) => (path.join("shipctl"), RootSource::PlatformDefault),
        None => (
            dirs::cache_dir()
                .ok_or_else(|| {
                    "Could not find a platform runtime or cache directory for Shipctl".to_string()
                })?
                .join("shipctl/runtime"),
            RootSource::CacheFallback,
        ),
    };
    let (path, source) = explicit
        .map(|path| (path, RootSource::Explicit))
        .or_else(|| {
            environment
                .as_deref()
                .map(|path| (path, RootSource::Environment))
        })
        .unwrap_or((&platform_default, source));
    read_only_directory(path, source, "runtime root")
}

fn read_only_directory(
    path: &Path,
    source: RootSource,
    label: &str,
) -> Result<(PathBuf, RootSource), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| format!("Could not resolve current directory: {error}"))?
            .join(path)
    };
    let resolved = if absolute.exists() {
        absolute.canonicalize().map_err(|error| {
            format!(
                "Failed to canonicalize {label} {}: {error}",
                absolute.display()
            )
        })?
    } else {
        absolute
    };
    Ok((resolved, source))
}

fn select_state_root<'a>(
    explicit: Option<&'a Path>,
    environment: Option<&'a Path>,
    platform_default: &'a Path,
) -> (&'a Path, RootSource) {
    explicit
        .map(|path| (path, RootSource::Explicit))
        .or_else(|| environment.map(|path| (path, RootSource::Environment)))
        .unwrap_or((platform_default, RootSource::PlatformDefault))
}

pub fn resolve_runtime_root(explicit: Option<&Path>) -> Result<(PathBuf, RootSource), String> {
    if let Some(path) = explicit {
        return canonical_directory(path, RootSource::Explicit, "runtime root");
    }
    if let Some(path) = nonempty_path_env(RUNTIME_DIR_ENV)? {
        return canonical_directory(&path, RootSource::Environment, "runtime root");
    }
    if let Some(path) = dirs::runtime_dir() {
        return canonical_directory(
            &path.join("shipctl"),
            RootSource::PlatformDefault,
            "runtime root",
        );
    }
    let cache = dirs::cache_dir().ok_or_else(|| {
        "Could not find a platform runtime or cache directory for Shipctl".to_string()
    })?;
    canonical_directory(
        &cache.join("shipctl/runtime"),
        RootSource::CacheFallback,
        "runtime root",
    )
}

fn nonempty_path_env(name: &str) -> Result<Option<PathBuf>, String> {
    match env::var_os(name) {
        None => Ok(None),
        Some(value) if value.is_empty() => Err(format!("{name} cannot be empty")),
        Some(value) => Ok(Some(PathBuf::from(value))),
    }
}

fn canonical_directory(
    path: &Path,
    source: RootSource,
    label: &str,
) -> Result<(PathBuf, RootSource), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {label} {}: {error}", path.display()))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize {label} {}: {error}", path.display()))?;
    Ok((canonical, source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn roots(label: &str) -> (PathBuf, PathBuf) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = env::temp_dir().join(format!(
            "shipctl-instance-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        (root.join("state"), root.join("runtime"))
    }

    #[test]
    fn explicit_roots_are_created_canonicalized_and_isolated() {
        let (first_state, first_runtime) = roots("first");
        let (second_state, second_runtime) = roots("second");
        let first = InstanceContext::resolve(
            InstanceLaunchOptions {
                name: Some("driver".into()),
                state_root: Some(first_state),
                runtime_root: Some(first_runtime),
                load_state: None,
                provenance: Some(LaunchProvenance::Cli),
            },
            "1.2.3",
        )
        .unwrap();
        let second = InstanceContext::resolve(
            InstanceLaunchOptions {
                name: Some("test".into()),
                state_root: Some(second_state),
                runtime_root: Some(second_runtime),
                load_state: None,
                provenance: None,
            },
            "1.2.3",
        )
        .unwrap();

        assert!(first.state_root.is_absolute());
        assert!(first.runtime_root.is_absolute());
        assert_ne!(first.instance_id, second.instance_id);
        assert_ne!(first.state_root, second.state_root);
        assert_ne!(first.runtime_root, second.runtime_root);
        assert_eq!(first.state_root_source, RootSource::Explicit);
        assert_eq!(first.launch_provenance, LaunchProvenance::Cli);
    }

    #[test]
    fn rejects_names_that_can_escape_or_corrupt_a_namespace() {
        for name in ["", "  ", "a/b", "a\\b", "a\nb"] {
            assert!(validate_instance_name(name).is_err(), "accepted {name:?}");
        }
        assert_eq!(
            validate_instance_name(" test-driver ").unwrap(),
            "test-driver"
        );
    }

    #[test]
    fn state_root_selection_has_explicit_environment_default_precedence() {
        let explicit = Path::new("/explicit");
        let environment = Path::new("/environment");
        let default = Path::new("/default");

        assert_eq!(
            select_state_root(Some(explicit), Some(environment), default),
            (explicit, RootSource::Explicit)
        );
        assert_eq!(
            select_state_root(None, Some(environment), default),
            (environment, RootSource::Environment)
        );
        assert_eq!(
            select_state_root(None, None, default),
            (default, RootSource::PlatformDefault)
        );
    }

    /// Two instances cannot share one writable state root, so the platform
    /// default has to differ by name for a second instance to start at all.
    #[test]
    fn the_default_state_root_is_a_sibling_for_every_name_but_the_canonical_one() {
        assert_eq!(default_state_root_name(DEFAULT_INSTANCE_NAME), ".shipctl");
        assert_eq!(default_state_root_name("test"), ".shipctl-test");
        assert_eq!(default_state_root_name("v0.7.4"), ".shipctl-v0.7.4");
        assert_ne!(
            default_state_root_name("test"),
            default_state_root_name("other")
        );
    }

    /// The legacy import seeds the canonical profile only. A secondary named
    /// instance on its own default root must start empty.
    #[test]
    fn only_the_canonical_instance_reports_the_default_profile() {
        let canonical = InstanceContext {
            instance_id: Uuid::new_v4(),
            name: DEFAULT_INSTANCE_NAME.to_string(),
            state_root: PathBuf::from("/home/.shipctl"),
            runtime_root: PathBuf::from("/runtime"),
            state_root_source: RootSource::PlatformDefault,
            runtime_root_source: RootSource::PlatformDefault,
            build: InstanceBuildIdentity {
                app_version: "0.0.0".to_string(),
                control_protocol_version: CONTROL_PROTOCOL_VERSION,
            },
            launch_provenance: LaunchProvenance::DirectUi,
        };
        assert!(canonical.uses_default_profile());

        let secondary = InstanceContext {
            name: "test".to_string(),
            state_root: PathBuf::from("/home/.shipctl-test"),
            ..canonical.clone()
        };
        assert!(!secondary.uses_default_profile());
    }

    #[test]
    fn read_only_state_root_resolution_does_not_create_the_selected_path() {
        let (state_root, _) = roots("offline-read");

        let (resolved, source) = resolve_state_root_read_only(Some(&state_root)).unwrap();

        assert_eq!(resolved, state_root);
        assert_eq!(source, RootSource::Explicit);
        assert!(!resolved.exists());
    }

    #[test]
    fn read_only_runtime_root_resolution_does_not_create_the_selected_path() {
        let (_, runtime_root) = roots("offline-runtime-read");

        let (resolved, source) = resolve_runtime_root_read_only(Some(&runtime_root)).unwrap();

        assert_eq!(resolved, runtime_root);
        assert_eq!(source, RootSource::Explicit);
        assert!(!resolved.exists());
    }

    #[test]
    fn parses_direct_ui_instance_inputs() {
        let options = InstanceLaunchOptions::from_args([
            OsString::from("shipctl-ui"),
            OsString::from("--name=test-a"),
            OsString::from("--state-root"),
            OsString::from("/tmp/state-a"),
            OsString::from("--runtime-root=/tmp/runtime-a"),
        ])
        .unwrap();

        assert_eq!(options.name.as_deref(), Some("test-a"));
        assert_eq!(
            options.state_root.as_deref(),
            Some(Path::new("/tmp/state-a"))
        );
        assert_eq!(
            options.runtime_root.as_deref(),
            Some(Path::new("/tmp/runtime-a"))
        );
    }
}
