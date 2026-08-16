//! Fixed agent-skill catalog and project-scoped installation policy.

#![forbid(unsafe_code)]

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use tauri::{plugin::TauriPlugin, Manager, Runtime, State};

pub const PLUGIN_NAME: &str = "shipctl-skills";
pub const LIST_SKILLS_COMMAND: &str = "plugin:shipctl-skills|list_skills";
pub const SETUP_SKILL_COMMAND: &str = "plugin:shipctl-skills|setup_skill";
pub const REMOVE_SKILL_COMMAND: &str = "plugin:shipctl-skills|remove_skill";

/// Host-owned authority for resolving an exact registered project root.
pub trait ProjectRootAuthority: Send + Sync {
    fn authorize_project_root(&self, requested_path: &str) -> Result<PathBuf, String>;
}

#[derive(Clone)]
pub struct HostServices {
    projects: Arc<dyn ProjectRootAuthority>,
}

impl HostServices {
    pub fn new(projects: Arc<dyn ProjectRootAuthority>) -> Self {
        Self { projects }
    }

    fn project_root(&self, requested_path: &str) -> Result<PathBuf, String> {
        self.projects.authorize_project_root(requested_path)
    }
}

/// A prebuilt agent skill Shipctl can install into a repo. The markdown is
/// embedded at compile time; `name` doubles as the directory name under
/// `.agents/skills/` and must match the frontmatter `name:` in the file.
struct BuiltinSkill {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    markdown: &'static str,
}

const BUILTIN_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "shipctl-todos",
        title: "Project to-dos",
        description: "Teaches agents to keep TODO.md as a kanban board: move cards when starting or finishing work, add discovered work to the backlog, and reconcile the board before ending a session.",
        markdown: include_str!("../resources/todo_skill.md"),
    },
    BuiltinSkill {
        name: "orchestrate",
        title: "Orchestrate",
        description: "Turns any agent into a planner/orchestrator that delegates implementation to a different agent CLI running headless (codex, claude, opencode), reviews each task, and finishes with a fresh-context audit.",
        markdown: include_str!("../resources/orchestrate_skill.md"),
    },
];

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

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    pub installed: bool,
}

fn find_skill(name: &str) -> Result<&'static BuiltinSkill, String> {
    BUILTIN_SKILLS
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("Unknown skill: {name}"))
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

/// All built-in skills with their install state for this repo.
pub fn inspect_skills(root: &Path) -> Vec<SkillInfo> {
    BUILTIN_SKILLS
        .iter()
        .map(|s| SkillInfo {
            name: s.name.to_string(),
            title: s.title.to_string(),
            description: s.description.to_string(),
            installed: has_skill(root, s.name),
        })
        .collect()
}

/// Write the skill at the cross-agent standard location (`.agents/skills/`)
/// and point `.claude/skills/` at it so Claude Code, Codex, and OpenCode
/// all pick it up from a single source file.
pub fn install_skill(root: &Path, name: &str) -> Result<(), String> {
    let skill = find_skill(name)?;
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }

    let skill_dir_existed =
        plain_directory(root, &[".agents", "skills", skill.name], false)?.is_some();
    let skill_dir = plain_directory(root, &[".agents", "skills", skill.name], true)?
        .expect("created skill directory");
    let skill_file = skill_dir.join("SKILL.md");
    let original = original_regular_file(&skill_file)?;
    atomic_write(&skill_file, skill.markdown.as_bytes())?;

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
    let pointer = claude_skills.join(skill.name);
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
        std::os::unix::fs::symlink(Path::new("../../.agents/skills").join(skill.name), &pointer)
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
            .and_then(|()| fs::write(pointer.join("SKILL.md"), skill.markdown))
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
    find_skill(name)?;

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

pub fn list_registered_skills(
    services: &HostServices,
    repo_path: &str,
) -> Result<Vec<SkillInfo>, String> {
    let root = services.project_root(repo_path)?;
    Ok(inspect_skills(&root))
}

pub fn setup_registered_skill(
    services: &HostServices,
    repo_path: &str,
    name: &str,
) -> Result<(), String> {
    let root = services.project_root(repo_path)?;
    install_skill(&root, name)
}

pub fn remove_registered_skill(
    services: &HostServices,
    repo_path: &str,
    name: &str,
) -> Result<(), String> {
    let root = services.project_root(repo_path)?;
    uninstall_skill(&root, name)
}

#[tauri::command]
fn list_skills(
    services: State<'_, HostServices>,
    repo_path: &str,
) -> Result<Vec<SkillInfo>, String> {
    list_registered_skills(&services, repo_path)
}

#[tauri::command]
fn setup_skill(
    services: State<'_, HostServices>,
    repo_path: &str,
    name: &str,
) -> Result<(), String> {
    setup_registered_skill(&services, repo_path, name)
}

#[tauri::command]
fn remove_skill(
    services: State<'_, HostServices>,
    repo_path: &str,
    name: &str,
) -> Result<(), String> {
    remove_registered_skill(&services, repo_path, name)
}

pub fn init<R: Runtime>(services: HostServices) -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(move |app, _api| {
            app.manage(services.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_skills,
            setup_skill,
            remove_skill
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct FixedProjectRoot {
        root: PathBuf,
    }

    impl ProjectRootAuthority for FixedProjectRoot {
        fn authorize_project_root(&self, requested_path: &str) -> Result<PathBuf, String> {
            if requested_path == self.root.to_string_lossy() {
                Ok(self.root.clone())
            } else {
                Err(format!("Project is not registered: {requested_path}"))
            }
        }
    }

    fn services_for(root: PathBuf) -> HostServices {
        HostServices::new(Arc::new(FixedProjectRoot { root }))
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shipctl-skills-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn registry_markdown_names_match_directories() {
        for skill in BUILTIN_SKILLS {
            assert!(
                skill.markdown.contains(&format!("name: {}", skill.name)),
                "frontmatter name mismatch for {}",
                skill.name
            );
        }
    }

    #[test]
    fn setup_writes_standard_location_and_claude_pointer() {
        let dir = temp_repo("setup");

        assert!(!has_skill(&dir, "shipctl-todos"));
        install_skill(&dir, "shipctl-todos").unwrap();
        assert!(has_skill(&dir, "shipctl-todos"));

        let real = dir.join(".agents/skills/shipctl-todos/SKILL.md");
        assert!(real.is_file());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("name: shipctl-todos"));

        // The Claude pointer resolves to the same skill.
        let pointer = dir.join(".claude/skills/shipctl-todos/SKILL.md");
        assert!(fs::read_to_string(&pointer)
            .unwrap()
            .contains("name: shipctl-todos"));

        // Idempotent — a second run doesn't fail on the existing pointer.
        install_skill(&dir, "shipctl-todos").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_rolls_back_a_new_skill_when_pointer_publication_fails() {
        let dir = temp_repo("setup-rollback-new");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude/skills"), "blocks the skills directory").unwrap();

        let error = install_skill(&dir, "shipctl-todos").unwrap_err();

        assert!(error.contains(".claude/skills"));
        assert!(!has_skill(&dir, "shipctl-todos"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_restores_an_existing_skill_when_pointer_publication_fails() {
        let dir = temp_repo("setup-rollback-existing");
        let skill_file = dir.join(".agents/skills/shipctl-todos/SKILL.md");
        fs::create_dir_all(skill_file.parent().unwrap()).unwrap();
        fs::write(&skill_file, "existing user content\n").unwrap();
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude/skills"), "blocks the skills directory").unwrap();

        install_skill(&dir, "shipctl-todos").unwrap_err();

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

        let error = install_skill(&dir, "shipctl-todos").unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert!(!outside.join("skills/shipctl-todos/SKILL.md").exists());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn setup_rolls_back_when_the_claude_directory_escapes_the_project() {
        let dir = temp_repo("setup-claude-symlink");
        let outside = temp_repo("setup-claude-symlink-outside");
        std::os::unix::fs::symlink(&outside, dir.join(".claude")).unwrap();

        let error = install_skill(&dir, "shipctl-todos").unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert!(!has_skill(&dir, "shipctl-todos"));
        assert!(!outside.join("skills/shipctl-todos").exists());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn list_reflects_install_state() {
        let dir = temp_repo("list");

        let before = inspect_skills(&dir);
        assert_eq!(before.len(), BUILTIN_SKILLS.len());
        assert!(before.iter().all(|s| !s.installed));

        install_skill(&dir, "orchestrate").unwrap();
        let after = inspect_skills(&dir);
        assert!(
            after
                .iter()
                .find(|s| s.name == "orchestrate")
                .unwrap()
                .installed
        );
        assert!(
            !after
                .iter()
                .find(|s| s.name == "shipctl-todos")
                .unwrap()
                .installed
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_deletes_skill_and_our_pointer() {
        let dir = temp_repo("remove");

        install_skill(&dir, "orchestrate").unwrap();
        uninstall_skill(&dir, "orchestrate").unwrap();
        assert!(!has_skill(&dir, "orchestrate"));
        assert!(dir
            .join(".claude/skills/orchestrate")
            .symlink_metadata()
            .is_err());

        // Removing an absent skill is a no-op, not an error.
        uninstall_skill(&dir, "orchestrate").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_leaves_foreign_claude_dir_alone() {
        let dir = temp_repo("foreign");

        // A user-authored real directory at the pointer path, with extra files.
        let foreign = dir.join(".claude/skills/orchestrate");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "user's own\n").unwrap();
        fs::write(foreign.join("notes.md"), "keep me\n").unwrap();

        uninstall_skill(&dir, "orchestrate").unwrap();
        assert!(foreign.join("notes.md").is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_an_agents_directory_that_escapes_the_project() {
        let dir = temp_repo("remove-agents-symlink");
        let outside = temp_repo("remove-agents-symlink-outside");
        let outside_skill = outside.join("skills/orchestrate/SKILL.md");
        fs::create_dir_all(outside_skill.parent().unwrap()).unwrap();
        fs::write(&outside_skill, "outside project\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".agents")).unwrap();

        let error = uninstall_skill(&dir, "orchestrate").unwrap_err();

        assert!(error.contains("unsafe skill directory"));
        assert_eq!(
            fs::read_to_string(outside_skill).unwrap(),
            "outside project\n"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn unknown_skill_is_an_error() {
        let dir = temp_repo("unknown");
        assert!(install_skill(&dir, "nope").is_err());
        assert!(uninstall_skill(&dir, "nope").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exposes_namespaced_command_contract() {
        assert_eq!(PLUGIN_NAME, "shipctl-skills");
        assert_eq!(LIST_SKILLS_COMMAND, "plugin:shipctl-skills|list_skills");
        assert_eq!(SETUP_SKILL_COMMAND, "plugin:shipctl-skills|setup_skill");
        assert_eq!(REMOVE_SKILL_COMMAND, "plugin:shipctl-skills|remove_skill");
    }

    #[test]
    fn registered_operations_reject_an_unregistered_root() {
        let registered = temp_repo("registered");
        let unregistered = temp_repo("unregistered");
        let services = services_for(registered.clone());

        let error =
            setup_registered_skill(&services, &unregistered.to_string_lossy(), "shipctl-todos")
                .unwrap_err();

        assert!(error.contains("not registered"));
        assert!(!has_skill(&registered, "shipctl-todos"));
        assert!(!has_skill(&unregistered, "shipctl-todos"));
        let _ = fs::remove_dir_all(&registered);
        let _ = fs::remove_dir_all(&unregistered);
    }

    #[test]
    fn registered_missing_root_keeps_the_uninstalled_catalog_contract() {
        let root =
            std::env::temp_dir().join(format!("shipctl-skills-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let services = services_for(root.clone());

        let skills = list_registered_skills(&services, &root.to_string_lossy()).unwrap();

        assert_eq!(skills.len(), BUILTIN_SKILLS.len());
        assert!(skills.iter().all(|skill| !skill.installed));
    }
}
