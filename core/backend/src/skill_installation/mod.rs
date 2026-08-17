//! Project-authorized, atomic skill installation mechanics.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::{Deserialize, Serialize};

use crate::workspace::manager::WorkspaceManager;

pub const SKILL_INSTALLATION_TRANSPORT_FAILED: &str = "skill-installation.transport-failed";
pub const SKILL_INSTALLATION_DENIED: &str = "skill-installation.denied";
pub const SKILL_INSTALLATION_INVALID_PROJECT: &str = "skill-installation.invalid-project";
pub const SKILL_INSTALLATION_INVALID_REQUEST: &str = "skill-installation.invalid-request";
pub const SKILL_INSTALLATION_ACTIVATION_DISPOSED: &str = "skill-installation.activation-disposed";

/// Host-owned catalog for exact project-root authorization.
pub trait SkillProjectCatalog: Send + Sync {
    fn registered_project_paths(&self) -> Result<Vec<String>, String>;
}

impl SkillProjectCatalog for WorkspaceManager {
    fn registered_project_paths(&self) -> Result<Vec<String>, String> {
        self.list_repos()
            .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillInstallationActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallationError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallationState {
    pub skill_id: String,
    pub installed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SkillInstallationGrant {
    Inspect,
    Install,
    Remove,
}

#[derive(Clone, Debug)]
struct SkillInstallationPolicy {
    module_id: &'static str,
    grants: &'static [SkillInstallationGrant],
}

const ALL_GRANTS: &[SkillInstallationGrant] = &[
    SkillInstallationGrant::Inspect,
    SkillInstallationGrant::Install,
    SkillInstallationGrant::Remove,
];
const DEFAULT_POLICIES: &[SkillInstallationPolicy] = &[
    SkillInstallationPolicy {
        module_id: "core",
        grants: ALL_GRANTS,
    },
    SkillInstallationPolicy {
        module_id: "shipctl.skills",
        grants: ALL_GRANTS,
    },
];

#[derive(Default)]
struct SkillInstallationProviderState {
    released_activations: HashSet<String>,
}

struct SkillInstallationServiceInner {
    projects: Arc<dyn SkillProjectCatalog>,
    policies: Vec<SkillInstallationPolicy>,
    state: Mutex<SkillInstallationProviderState>,
}

/// Permanent native provider for scoped skill installation mechanics.
///
/// The caller owns skill discovery, catalog metadata, and source selection.
/// This provider owns project authorization and safe filesystem publication.
#[derive(Clone)]
pub struct SkillInstallationService {
    inner: Arc<SkillInstallationServiceInner>,
}

static TRANSACTION_ID: AtomicU64 = AtomicU64::new(0);

struct OriginalFile {
    contents: Vec<u8>,
    permissions: fs::Permissions,
}

fn transaction_path(parent: &Path, name: &str, role: &str) -> Result<PathBuf, String> {
    loop {
        let id = TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{name}.shipctl-{role}-{}-{id}",
            std::process::id()
        ));
        match candidate.symlink_metadata() {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect transaction path {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
}

fn original_regular_file(path: &Path) -> Result<Option<OriginalFile>, String> {
    match path.symlink_metadata() {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let contents = fs::read(path)
                .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
            Ok(Some(OriginalFile {
                contents,
                permissions: metadata.permissions(),
            }))
        }
        Ok(_) => Err(format!(
            "Refusing to replace non-regular skill file: {}",
            path.display()
        )),
    }
}

fn plain_directory(
    root: &Path,
    components: &[&str],
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let mut current = root.to_path_buf();
    for component in components {
        current.push(component);
        match current.symlink_metadata() {
            Err(error) if error.kind() == ErrorKind::NotFound && !create => return Ok(None),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!(
                        "Failed to create safe directory {}: {error}",
                        current.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!("Failed to inspect {}: {error}", current.display()));
            }
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(format!(
                    "Refusing unsafe skill directory: {}",
                    current.display()
                ));
            }
        }
    }
    Ok(Some(current))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Missing parent for {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let staged = transaction_path(parent, name, "write")?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|error| format!("Failed to stage {}: {error}", path.display()))?;
        file.write_all(contents)
            .map_err(|error| format!("Failed to stage {}: {error}", path.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync {}: {error}", path.display()))?;
        fs::rename(&staged, path)
            .map_err(|error| format!("Failed to publish {}: {error}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

fn rollback_skill_file(
    skill_file: &Path,
    original: Option<&OriginalFile>,
    remove_empty_skill_dir: bool,
) -> Result<(), String> {
    match original {
        Some(original) => {
            atomic_write(skill_file, &original.contents)?;
            fs::set_permissions(skill_file, original.permissions.clone()).map_err(|error| {
                format!(
                    "Failed to restore permissions on {}: {error}",
                    skill_file.display()
                )
            })?;
        }
        None => match fs::remove_file(skill_file) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to roll back {}: {error}",
                    skill_file.display()
                ));
            }
        },
    }
    if remove_empty_skill_dir {
        if let Some(skill_dir) = skill_file.parent() {
            let _ = fs::remove_dir(skill_dir);
        }
    }
    Ok(())
}

fn install_failure(
    error: String,
    skill_file: &Path,
    original: Option<&OriginalFile>,
    remove_empty_skill_dir: bool,
) -> String {
    match rollback_skill_file(skill_file, original, remove_empty_skill_dir) {
        Ok(()) => error,
        Err(rollback_error) => format!("{error}; rollback failed: {rollback_error}"),
    }
}

#[derive(Clone, Copy)]
enum OwnedPointerKind {
    Symlink,
    Directory,
}

fn owned_pointer_kind(pointer: &Path) -> Result<Option<OwnedPointerKind>, String> {
    let metadata = match pointer.symlink_metadata() {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("Failed to inspect {}: {error}", pointer.display()));
        }
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() {
        return Ok(Some(OwnedPointerKind::Symlink));
    }
    if !metadata.is_dir() {
        return Ok(None);
    }
    let only_skill_md = fs::read_dir(pointer)
        .map_err(|error| format!("Failed to inspect {}: {error}", pointer.display()))?
        .all(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy() == "SKILL.md")
                .unwrap_or(false)
        });
    Ok(only_skill_md.then_some(OwnedPointerKind::Directory))
}

fn validate_skill_id(skill_id: &str) -> Result<(), String> {
    let mut characters = skill_id.chars();
    let valid = characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid skill identity: {skill_id}"))
    }
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    name: String,
}

fn validate_skill_source(skill_id: &str, markdown: &str) -> Result<(), String> {
    validate_skill_id(skill_id)?;
    let mut lines = markdown.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("Skill source must start with YAML frontmatter".to_string());
    }
    let frontmatter = lines
        .by_ref()
        .take_while(|line| line.trim() != "---")
        .collect::<Vec<_>>()
        .join("\n");
    let metadata: SkillFrontmatter = serde_yaml::from_str(&frontmatter)
        .map_err(|error| format!("Invalid skill frontmatter: {error}"))?;
    if metadata.name != skill_id {
        return Err(format!(
            "Skill source name does not match identity: expected {skill_id}, got {}",
            metadata.name
        ));
    }
    Ok(())
}

/// Whether the repo has the named skill installed at the standard location.
pub fn has_skill(root: &Path, name: &str) -> bool {
    let Ok(Some(skill_dir)) = plain_directory(root, &[".agents", "skills", name], false) else {
        return false;
    };
    matches!(
        skill_dir.join("SKILL.md").symlink_metadata(),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink()
    )
}

/// Inspect install state for caller-selected skill identities.
pub fn inspect_skills(
    root: &Path,
    skill_ids: &[String],
) -> Result<Vec<SkillInstallationState>, String> {
    skill_ids
        .iter()
        .map(|skill_id| {
            validate_skill_id(skill_id)?;
            Ok(SkillInstallationState {
                skill_id: skill_id.clone(),
                installed: has_skill(root, skill_id),
            })
        })
        .collect()
}

/// Write the skill at the cross-agent standard location (`.agents/skills/`)
/// and point `.claude/skills/` at it so Claude Code, Codex, and OpenCode
/// all pick it up from a single source file.
pub fn install_skill(root: &Path, skill_id: &str, markdown: &str) -> Result<(), String> {
    validate_skill_source(skill_id, markdown)?;
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }

    let skill_dir_existed =
        plain_directory(root, &[".agents", "skills", skill_id], false)?.is_some();
    let skill_dir = plain_directory(root, &[".agents", "skills", skill_id], true)?
        .expect("created skill directory");
    let skill_file = skill_dir.join("SKILL.md");
    let original = original_regular_file(&skill_file)?;
    atomic_write(&skill_file, markdown.as_bytes())?;

    let claude_skills = match plain_directory(root, &[".claude", "skills"], true) {
        Ok(Some(directory)) => directory,
        Ok(None) => unreachable!("create=true always returns a directory"),
        Err(error) => {
            return Err(install_failure(
                error,
                &skill_file,
                original.as_ref(),
                !skill_dir_existed,
            ));
        }
    };
    let pointer = claude_skills.join(skill_id);
    match pointer.symlink_metadata() {
        Ok(_) => return Ok(()), // Something already there — leave the user's setup alone.
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(install_failure(
                format!("Failed to inspect {}: {error}", pointer.display()),
                &skill_file,
                original.as_ref(),
                !skill_dir_existed,
            ));
        }
    }
    #[cfg(unix)]
    if let Err(error) =
        std::os::unix::fs::symlink(Path::new("../../.agents/skills").join(skill_id), &pointer)
    {
        return Err(install_failure(
            format!("Failed to link Claude skill: {error}"),
            &skill_file,
            original.as_ref(),
            !skill_dir_existed,
        ));
    }
    #[cfg(not(unix))]
    {
        if let Err(error) = fs::create_dir_all(&pointer)
            .and_then(|()| fs::write(pointer.join("SKILL.md"), markdown))
        {
            let _ = fs::remove_dir_all(&pointer);
            return Err(install_failure(
                format!("Failed to create Claude skill: {error}"),
                &skill_file,
                original.as_ref(),
                !skill_dir_existed,
            ));
        }
    }
    Ok(())
}

/// Remove an installed skill: the `.agents/skills/<name>` directory, plus
/// the `.claude/skills/<name>` pointer — but only if the pointer is ours
/// (a symlink, or on non-unix a directory holding just SKILL.md).
pub fn uninstall_skill(root: &Path, name: &str) -> Result<(), String> {
    validate_skill_id(name)?;

    let skill_parent = plain_directory(root, &[".agents", "skills"], false)?;
    let pointer_parent = plain_directory(root, &[".claude", "skills"], false)?;
    let skill_dir = skill_parent
        .as_ref()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|| root.join(".agents/skills").join(name));
    let pointer = pointer_parent
        .as_ref()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|| root.join(".claude/skills").join(name));
    let pointer_kind = owned_pointer_kind(&pointer)?;

    let staged_skill = match skill_parent {
        None => None,
        Some(_) => match skill_dir.symlink_metadata() {
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect {}: {error}",
                    skill_dir.display()
                ));
            }
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                let parent = skill_dir.parent().expect("skill directory has a parent");
                let staged = transaction_path(parent, name, "remove")?;
                fs::rename(&skill_dir, &staged)
                    .map_err(|error| format!("Failed to stage {}: {error}", skill_dir.display()))?;
                Some(staged)
            }
            Ok(_) => None,
        },
    };

    let staged_pointer = if let Some(kind) = pointer_kind {
        let parent = pointer.parent().expect("skill pointer has a parent");
        let staged = transaction_path(parent, name, "remove")?;
        if let Err(error) = fs::rename(&pointer, &staged) {
            let rollback = staged_skill
                .as_ref()
                .map(|staged| fs::rename(staged, &skill_dir));
            let rollback_error = rollback.and_then(Result::err);
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Failed to stage {}: {error}; rollback failed: {rollback_error}",
                    pointer.display()
                ),
                None => format!("Failed to stage {}: {error}", pointer.display()),
            });
        }
        Some((staged, kind))
    } else {
        None
    };

    // Both public paths are now absent. Cleanup of transaction-private names
    // does not change the successful uninstall result.
    if let Some(staged) = staged_skill {
        let _ = fs::remove_dir_all(staged);
    }
    if let Some((staged, kind)) = staged_pointer {
        match kind {
            OwnedPointerKind::Symlink => {
                let _ = fs::remove_file(staged);
            }
            OwnedPointerKind::Directory => {
                let _ = fs::remove_dir_all(staged);
            }
        }
    }
    Ok(())
}

impl SkillInstallationService {
    pub fn workspace(workspace: WorkspaceManager) -> Self {
        Self::new(Arc::new(workspace))
    }

    pub fn new(projects: Arc<dyn SkillProjectCatalog>) -> Self {
        Self::with_policies(projects, DEFAULT_POLICIES.to_vec())
    }

    fn with_policies(
        projects: Arc<dyn SkillProjectCatalog>,
        policies: Vec<SkillInstallationPolicy>,
    ) -> Self {
        Self {
            inner: Arc::new(SkillInstallationServiceInner {
                projects,
                policies,
                state: Mutex::new(SkillInstallationProviderState::default()),
            }),
        }
    }

    pub fn inspect(
        &self,
        actor: &SkillInstallationActor,
        project_id: &str,
        skill_ids: &[String],
    ) -> Result<Vec<SkillInstallationState>, SkillInstallationError> {
        let root = self.project_root(actor, SkillInstallationGrant::Inspect, project_id)?;
        inspect_skills(&root, skill_ids).map_err(skill_operation_error)
    }

    pub fn install(
        &self,
        actor: &SkillInstallationActor,
        project_id: &str,
        skill_id: &str,
        markdown: &str,
    ) -> Result<(), SkillInstallationError> {
        let root = self.project_root(actor, SkillInstallationGrant::Install, project_id)?;
        install_skill(&root, skill_id, markdown).map_err(skill_operation_error)
    }

    pub fn remove(
        &self,
        actor: &SkillInstallationActor,
        project_id: &str,
        skill_id: &str,
    ) -> Result<(), SkillInstallationError> {
        let root = self.project_root(actor, SkillInstallationGrant::Remove, project_id)?;
        uninstall_skill(&root, skill_id).map_err(skill_operation_error)
    }

    pub fn release_activation(
        &self,
        actor: &SkillInstallationActor,
    ) -> Result<(), SkillInstallationError> {
        self.authorize(actor, None)?;
        self.inner
            .state
            .lock()
            .expect("skill installation provider state poisoned")
            .released_activations
            .insert(actor.activation_id.clone());
        Ok(())
    }

    fn project_root(
        &self,
        actor: &SkillInstallationActor,
        grant: SkillInstallationGrant,
        project_id: &str,
    ) -> Result<PathBuf, SkillInstallationError> {
        self.authorize(actor, Some(grant))?;
        let registered = self
            .inner
            .projects
            .registered_project_paths()
            .map_err(|message| skill_error(SKILL_INSTALLATION_TRANSPORT_FAILED, message))?;
        registered
            .iter()
            .find(|path| path.as_str() == project_id)
            .map(PathBuf::from)
            .ok_or_else(|| {
                skill_error(
                    SKILL_INSTALLATION_INVALID_PROJECT,
                    format!("Project is not registered: {project_id}"),
                )
            })
    }

    fn authorize(
        &self,
        actor: &SkillInstallationActor,
        grant: Option<SkillInstallationGrant>,
    ) -> Result<(), SkillInstallationError> {
        let policy = self
            .inner
            .policies
            .iter()
            .find(|policy| policy.module_id == actor.module_id)
            .ok_or_else(|| {
                skill_error(
                    SKILL_INSTALLATION_DENIED,
                    format!(
                        "Module is not allowed to install skills: {}",
                        actor.module_id
                    ),
                )
            })?;
        if self
            .inner
            .state
            .lock()
            .expect("skill installation provider state poisoned")
            .released_activations
            .contains(&actor.activation_id)
        {
            return Err(skill_error(
                SKILL_INSTALLATION_ACTIVATION_DISPOSED,
                "The module activation is no longer active",
            ));
        }
        if grant.is_some_and(|required| !policy.grants.contains(&required)) {
            return Err(skill_error(
                SKILL_INSTALLATION_DENIED,
                "The module activation lacks the required skill grant",
            ));
        }
        Ok(())
    }
}

fn skill_operation_error(message: String) -> SkillInstallationError {
    let normalized = message.to_ascii_lowercase();
    let code = if normalized.contains("invalid skill identity")
        || normalized.contains("skill source")
        || normalized.contains("skill frontmatter")
    {
        SKILL_INSTALLATION_INVALID_REQUEST
    } else if normalized.contains("not a directory") {
        SKILL_INSTALLATION_INVALID_PROJECT
    } else if normalized.contains("permission")
        || normalized.contains("denied")
        || normalized.contains("not permitted")
        || normalized.contains("not allowed")
    {
        SKILL_INSTALLATION_DENIED
    } else {
        SKILL_INSTALLATION_TRANSPORT_FAILED
    };
    skill_error(code, message)
}

fn skill_error(code: &str, message: impl Into<String>) -> SkillInstallationError {
    SkillInstallationError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::path::PathBuf;

    const ALPHA_SKILL: &str = "---\nname: fixture-alpha\n---\n\n# Fixture alpha\n";
    const BETA_SKILL: &str = "---\nname: fixture-beta\n---\n\n# Fixture beta\n";

    struct FixedProjectRoot {
        root: PathBuf,
    }

    impl SkillProjectCatalog for FixedProjectRoot {
        fn registered_project_paths(&self) -> Result<Vec<String>, String> {
            Ok(vec![self.root.to_string_lossy().into_owned()])
        }
    }

    fn service_for(root: PathBuf) -> SkillInstallationService {
        SkillInstallationService::new(Arc::new(FixedProjectRoot { root }))
    }

    fn actor() -> SkillInstallationActor {
        SkillInstallationActor {
            module_id: "shipctl.skills".to_string(),
            activation_id: "skills-test".to_string(),
        }
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shipctl-skills-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn source_frontmatter_must_match_the_installation_identity() {
        assert!(validate_skill_source("fixture-alpha", ALPHA_SKILL).is_ok());
        assert!(validate_skill_source("fixture-beta", ALPHA_SKILL).is_err());
    }

    #[test]
    fn setup_writes_standard_location_and_claude_pointer() {
        let dir = temp_repo("setup");

        assert!(!has_skill(&dir, "fixture-alpha"));
        install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap();
        assert!(has_skill(&dir, "fixture-alpha"));

        let real = dir.join(".agents/skills/fixture-alpha/SKILL.md");
        assert!(real.is_file());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("name: fixture-alpha"));

        // The Claude pointer resolves to the same skill.
        let pointer = dir.join(".claude/skills/fixture-alpha/SKILL.md");
        assert!(fs::read_to_string(&pointer)
            .unwrap()
            .contains("name: fixture-alpha"));

        // Idempotent — a second run doesn't fail on the existing pointer.
        install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_rolls_back_a_new_skill_when_pointer_publication_fails() {
        let dir = temp_repo("setup-rollback-new");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude/skills"), "blocks the skills directory").unwrap();

        let error = install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap_err();

        assert!(error.contains(".claude/skills"));
        assert!(!has_skill(&dir, "fixture-alpha"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_restores_an_existing_skill_when_pointer_publication_fails() {
        let dir = temp_repo("setup-rollback-existing");
        let skill_file = dir.join(".agents/skills/fixture-alpha/SKILL.md");
        fs::create_dir_all(skill_file.parent().unwrap()).unwrap();
        fs::write(&skill_file, "existing user content\n").unwrap();
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude/skills"), "blocks the skills directory").unwrap();

        install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap_err();

        assert_eq!(
            fs::read_to_string(skill_file).unwrap(),
            "existing user content\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn setup_rejects_an_agents_directory_that_escapes_the_project() {
        let dir = temp_repo("setup-agents-symlink");
        let outside = temp_repo("setup-agents-symlink-outside");
        std::os::unix::fs::symlink(&outside, dir.join(".agents")).unwrap();

        let error = install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert!(!outside.join("skills/fixture-alpha/SKILL.md").exists());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn setup_rolls_back_when_the_claude_directory_escapes_the_project() {
        let dir = temp_repo("setup-claude-symlink");
        let outside = temp_repo("setup-claude-symlink-outside");
        std::os::unix::fs::symlink(&outside, dir.join(".claude")).unwrap();

        let error = install_skill(&dir, "fixture-alpha", ALPHA_SKILL).unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert!(!has_skill(&dir, "fixture-alpha"));
        assert!(!outside.join("skills/fixture-alpha").exists());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn list_reflects_install_state() {
        let dir = temp_repo("list");

        let ids = vec!["fixture-alpha".to_string(), "fixture-beta".to_string()];
        let before = inspect_skills(&dir, &ids).unwrap();
        assert_eq!(before.len(), ids.len());
        assert!(before.iter().all(|s| !s.installed));

        install_skill(&dir, "fixture-beta", BETA_SKILL).unwrap();
        let after = inspect_skills(&dir, &ids).unwrap();
        assert!(
            after
                .iter()
                .find(|s| s.skill_id == "fixture-beta")
                .unwrap()
                .installed
        );
        assert!(
            !after
                .iter()
                .find(|s| s.skill_id == "fixture-alpha")
                .unwrap()
                .installed
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_deletes_skill_and_our_pointer() {
        let dir = temp_repo("remove");

        install_skill(&dir, "fixture-beta", BETA_SKILL).unwrap();
        uninstall_skill(&dir, "fixture-beta").unwrap();
        assert!(!has_skill(&dir, "fixture-beta"));
        assert!(dir
            .join(".claude/skills/fixture-beta")
            .symlink_metadata()
            .is_err());

        // Removing an absent skill is a no-op, not an error.
        uninstall_skill(&dir, "fixture-beta").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_leaves_foreign_claude_dir_alone() {
        let dir = temp_repo("foreign");

        // A user-authored real directory at the pointer path, with extra files.
        let foreign = dir.join(".claude/skills/fixture-beta");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "user's own\n").unwrap();
        fs::write(foreign.join("notes.md"), "keep me\n").unwrap();

        uninstall_skill(&dir, "fixture-beta").unwrap();
        assert!(foreign.join("notes.md").is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_an_agents_directory_that_escapes_the_project() {
        let dir = temp_repo("remove-agents-symlink");
        let outside = temp_repo("remove-agents-symlink-outside");
        let outside_skill = outside.join("skills/fixture-beta/SKILL.md");
        fs::create_dir_all(outside_skill.parent().unwrap()).unwrap();
        fs::write(&outside_skill, "outside project\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".agents")).unwrap();

        let error = uninstall_skill(&dir, "fixture-beta").unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert_eq!(
            fs::read_to_string(outside_skill).unwrap(),
            "outside project\n"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn invalid_skill_identity_is_an_error() {
        let dir = temp_repo("invalid-identity");
        assert!(install_skill(&dir, "../outside", ALPHA_SKILL).is_err());
        assert!(uninstall_skill(&dir, "../outside").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn registered_operations_reject_an_unregistered_root() {
        let registered = temp_repo("registered");
        let unregistered = temp_repo("unregistered");
        let service = service_for(registered.clone());

        let error = service
            .install(
                &actor(),
                &unregistered.to_string_lossy(),
                "fixture-alpha",
                ALPHA_SKILL,
            )
            .unwrap_err();

        assert!(error.message.contains("not registered"));
        assert!(!has_skill(&registered, "fixture-alpha"));
        assert!(!has_skill(&unregistered, "fixture-alpha"));
        let _ = fs::remove_dir_all(&registered);
        let _ = fs::remove_dir_all(&unregistered);
    }

    #[test]
    fn registered_missing_root_keeps_the_uninstalled_catalog_contract() {
        let root =
            std::env::temp_dir().join(format!("shipctl-skills-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let service = service_for(root.clone());

        let skills = service
            .inspect(
                &actor(),
                &root.to_string_lossy(),
                &["fixture-alpha".to_string(), "fixture-beta".to_string()],
            )
            .unwrap();

        assert_eq!(skills.len(), 2);
        assert!(skills.iter().all(|skill| !skill.installed));
    }

    fn provider_with_grants(
        root: &Path,
        grants: &'static [SkillInstallationGrant],
    ) -> SkillInstallationService {
        SkillInstallationService::with_policies(
            Arc::new(FixedProjectRoot {
                root: root.to_path_buf(),
            }),
            vec![SkillInstallationPolicy {
                module_id: "shipctl.skills",
                grants,
            }],
        )
    }

    proptest! {
        #[test]
        fn architecture_provider_skill_installation_parity_property(
            skill_id in "[a-z][a-z0-9-]{0,15}",
            body in any::<String>(),
            remove_after_install in any::<bool>(),
        ) {
            let raw_root = tempfile::tempdir().unwrap();
            let provider_root = tempfile::tempdir().unwrap();
            let markdown = format!("---\nname: {skill_id}\n---\n\n{body}");
            let provider = service_for(provider_root.path().to_path_buf());
            let actor = actor();
            let project_id = provider_root.path().to_string_lossy().to_string();

            install_skill(raw_root.path(), &skill_id, &markdown).unwrap();
            provider
                .install(&actor, &project_id, &skill_id, &markdown)
                .unwrap();

            let raw_skill = raw_root.path().join(".agents/skills").join(&skill_id).join("SKILL.md");
            let provided_skill = provider_root
                .path()
                .join(".agents/skills")
                .join(&skill_id)
                .join("SKILL.md");
            prop_assert_eq!(fs::read(&provided_skill).unwrap(), fs::read(&raw_skill).unwrap());
            prop_assert_eq!(
                fs::read(provider_root.path().join(".claude/skills").join(&skill_id).join("SKILL.md")).unwrap(),
                fs::read(raw_root.path().join(".claude/skills").join(&skill_id).join("SKILL.md")).unwrap(),
            );
            prop_assert_eq!(
                provider.inspect(&actor, &project_id, std::slice::from_ref(&skill_id)).unwrap(),
                inspect_skills(raw_root.path(), std::slice::from_ref(&skill_id)).unwrap(),
            );

            if remove_after_install {
                uninstall_skill(raw_root.path(), &skill_id).unwrap();
                provider.remove(&actor, &project_id, &skill_id).unwrap();
                prop_assert_eq!(provided_skill.exists(), raw_skill.exists());
            }
        }

        #[test]
        fn architecture_provider_skill_installation_authority_property(
            known_module in any::<bool>(),
            grant_allowed in any::<bool>(),
            disposed in any::<bool>(),
            registered_scope in any::<bool>(),
            operation in 0usize..3,
        ) {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let grants = if grant_allowed { ALL_GRANTS } else { &[] };
            let provider = provider_with_grants(root.path(), grants);
            let candidate = SkillInstallationActor {
                module_id: if known_module { "shipctl.skills" } else { "shipctl.unknown" }.to_string(),
                activation_id: "authority".to_string(),
            };
            if disposed && known_module {
                provider.release_activation(&candidate).unwrap();
            }
            let project_id = if registered_scope {
                root.path().to_string_lossy().to_string()
            } else {
                outside.path().to_string_lossy().to_string()
            };
            let result = match operation {
                0 => provider.inspect(&candidate, &project_id, &["fixture".to_string()]).map(|_| ()),
                1 => provider.install(
                    &candidate,
                    &project_id,
                    "fixture",
                    "---\nname: fixture\n---\n\n# Fixture\n",
                ),
                _ => provider.remove(&candidate, &project_id, "fixture"),
            };

            let expected_code = if !known_module {
                Some(SKILL_INSTALLATION_DENIED)
            } else if disposed {
                Some(SKILL_INSTALLATION_ACTIVATION_DISPOSED)
            } else if !grant_allowed {
                Some(SKILL_INSTALLATION_DENIED)
            } else if !registered_scope {
                Some(SKILL_INSTALLATION_INVALID_PROJECT)
            } else {
                None
            };
            match expected_code {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
            prop_assert!(!outside.path().join(".agents/skills/fixture/SKILL.md").exists());
        }

        #[test]
        fn architecture_provider_skill_installation_ownership_property(
            release_installer in any::<bool>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let project_id = root.path().to_string_lossy().to_string();
            let provider = service_for(root.path().to_path_buf());
            let installer = actor();
            let peer = SkillInstallationActor {
                module_id: "shipctl.skills".to_string(),
                activation_id: "skills-peer".to_string(),
            };
            provider
                .install(&installer, &project_id, "fixture", "---\nname: fixture\n---\n\n# Fixture\n")
                .unwrap();
            let installed_path = root.path().join(".agents/skills/fixture/SKILL.md");
            let original = fs::read(&installed_path).unwrap();
            let (released, live) = if release_installer {
                (&installer, &peer)
            } else {
                (&peer, &installer)
            };

            provider.release_activation(released).unwrap();
            let disposed = provider
                .inspect(released, &project_id, &["fixture".to_string()])
                .unwrap_err();
            prop_assert_eq!(disposed.code, SKILL_INSTALLATION_ACTIVATION_DISPOSED);
            prop_assert_eq!(fs::read(&installed_path).unwrap(), original);
            prop_assert!(provider
                .inspect(live, &project_id, &["fixture".to_string()])
                .unwrap()[0]
                .installed);
        }
    }
}
