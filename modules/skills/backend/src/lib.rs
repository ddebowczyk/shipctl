//! Fixed agent-skill catalog and project-scoped installation policy.

#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{plugin::TauriPlugin, Manager, Runtime, State};

pub const PLUGIN_NAME: &str = "shep-skills";
pub const LIST_SKILLS_COMMAND: &str = "plugin:shep-skills|list_skills";
pub const SETUP_SKILL_COMMAND: &str = "plugin:shep-skills|setup_skill";
pub const REMOVE_SKILL_COMMAND: &str = "plugin:shep-skills|remove_skill";

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

/// A prebuilt agent skill Shep can install into a repo. The markdown is
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
        name: "shep-todos",
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
    root.join(".agents/skills")
        .join(name)
        .join("SKILL.md")
        .is_file()
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

    let skill_dir = root.join(".agents/skills").join(skill.name);
    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create {}: {e}", skill_dir.display()))?;
    fs::write(skill_dir.join("SKILL.md"), skill.markdown)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    let claude_skills = root.join(".claude/skills");
    let pointer = claude_skills.join(skill.name);
    if pointer.symlink_metadata().is_ok() {
        return Ok(()); // Something already there — leave the user's setup alone.
    }
    fs::create_dir_all(&claude_skills)
        .map_err(|e| format!("Failed to create {}: {e}", claude_skills.display()))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(Path::new("../../.agents/skills").join(skill.name), &pointer)
        .map_err(|e| format!("Failed to link Claude skill: {e}"))?;
    #[cfg(not(unix))]
    {
        fs::create_dir_all(&pointer).map_err(|e| format!("Failed to create skill dir: {e}"))?;
        fs::write(pointer.join("SKILL.md"), skill.markdown)
            .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;
    }
    Ok(())
}

/// Remove an installed skill: the `.agents/skills/<name>` directory, plus
/// the `.claude/skills/<name>` pointer — but only if the pointer is ours
/// (a symlink, or on non-unix a directory holding just SKILL.md).
pub fn uninstall_skill(root: &Path, name: &str) -> Result<(), String> {
    find_skill(name)?;

    let skill_dir = root.join(".agents/skills").join(name);
    if skill_dir.is_dir() {
        fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Failed to remove {}: {e}", skill_dir.display()))?;
    }

    let pointer = root.join(".claude/skills").join(name);
    if let Ok(meta) = pointer.symlink_metadata() {
        if meta.file_type().is_symlink() {
            fs::remove_file(&pointer)
                .map_err(|e| format!("Failed to remove {}: {e}", pointer.display()))?;
        } else if meta.is_dir() {
            let only_skill_md = fs::read_dir(&pointer)
                .map(|entries| {
                    entries
                        .flatten()
                        .all(|e| e.file_name().to_string_lossy() == "SKILL.md")
                })
                .unwrap_or(false);
            if only_skill_md {
                fs::remove_dir_all(&pointer)
                    .map_err(|e| format!("Failed to remove {}: {e}", pointer.display()))?;
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
        let dir = std::env::temp_dir().join(format!("shep-skills-{tag}-{}", std::process::id()));
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

        assert!(!has_skill(&dir, "shep-todos"));
        install_skill(&dir, "shep-todos").unwrap();
        assert!(has_skill(&dir, "shep-todos"));

        let real = dir.join(".agents/skills/shep-todos/SKILL.md");
        assert!(real.is_file());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("name: shep-todos"));

        // The Claude pointer resolves to the same skill.
        let pointer = dir.join(".claude/skills/shep-todos/SKILL.md");
        assert!(fs::read_to_string(&pointer)
            .unwrap()
            .contains("name: shep-todos"));

        // Idempotent — a second run doesn't fail on the existing pointer.
        install_skill(&dir, "shep-todos").unwrap();
        let _ = fs::remove_dir_all(&dir);
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
                .find(|s| s.name == "shep-todos")
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

    #[test]
    fn unknown_skill_is_an_error() {
        let dir = temp_repo("unknown");
        assert!(install_skill(&dir, "nope").is_err());
        assert!(uninstall_skill(&dir, "nope").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exposes_namespaced_command_contract() {
        assert_eq!(PLUGIN_NAME, "shep-skills");
        assert_eq!(LIST_SKILLS_COMMAND, "plugin:shep-skills|list_skills");
        assert_eq!(SETUP_SKILL_COMMAND, "plugin:shep-skills|setup_skill");
        assert_eq!(REMOVE_SKILL_COMMAND, "plugin:shep-skills|remove_skill");
    }

    #[test]
    fn registered_operations_reject_an_unregistered_root() {
        let registered = temp_repo("registered");
        let unregistered = temp_repo("unregistered");
        let services = services_for(registered.clone());

        let error =
            setup_registered_skill(&services, &unregistered.to_string_lossy(), "shep-todos")
                .unwrap_err();

        assert!(error.contains("not registered"));
        assert!(!has_skill(&registered, "shep-todos"));
        assert!(!has_skill(&unregistered, "shep-todos"));
        let _ = fs::remove_dir_all(&registered);
        let _ = fs::remove_dir_all(&unregistered);
    }

    #[test]
    fn registered_missing_root_keeps_the_uninstalled_catalog_contract() {
        let root = std::env::temp_dir().join(format!("shep-skills-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let services = services_for(root.clone());

        let skills = list_registered_skills(&services, &root.to_string_lossy()).unwrap();

        assert_eq!(skills.len(), BUILTIN_SKILLS.len());
        assert!(skills.iter().all(|skill| !skill.installed));
    }
}
