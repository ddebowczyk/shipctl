#[path = "../src/skills.rs"]
mod skills;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "shep-skills-characterization-{tag}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn as_string(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn unavailable_project_still_returns_the_fixed_uninstalled_catalog() {
    let fixture = TempRoot::new("missing");
    let missing = fixture.path().join("not-present");
    let catalog = skills::list_skills(&missing.to_string_lossy());

    assert_eq!(
        catalog
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>(),
        ["shep-todos", "orchestrate"]
    );
    assert!(catalog.iter().all(|skill| !skill.installed));
}

#[test]
fn installed_state_is_file_existence_not_metadata_validity() {
    let fixture = TempRoot::new("malformed");
    let skill_dir = fixture.path().join(".agents/skills/shep-todos");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "this is not skill frontmatter\n",
    )
    .unwrap();

    let catalog = skills::list_skills(&fixture.as_string());
    let todos = catalog
        .iter()
        .find(|skill| skill.name == "shep-todos")
        .unwrap();

    assert!(todos.installed);
    assert!(!skills::has_skill(&fixture.as_string(), "orchestrate"));
}

#[test]
fn setup_and_remove_are_scoped_to_the_requested_project_root() {
    let alpha = TempRoot::new("alpha");
    let beta = TempRoot::new("beta");

    skills::setup_skill(&alpha.as_string(), "shep-todos").unwrap();

    assert!(skills::has_skill(&alpha.as_string(), "shep-todos"));
    assert!(!skills::has_skill(&beta.as_string(), "shep-todos"));
    assert!(alpha
        .path()
        .join(".claude/skills/shep-todos/SKILL.md")
        .is_file());

    skills::remove_skill(&alpha.as_string(), "shep-todos").unwrap();
    assert!(!skills::has_skill(&alpha.as_string(), "shep-todos"));
    assert!(!alpha.path().join(".claude/skills/shep-todos").exists());
}

#[test]
fn mutations_reject_unavailable_or_non_directory_roots() {
    let fixture = TempRoot::new("invalid-root");
    let missing = fixture.path().join("missing");
    let file = fixture.path().join("file");
    fs::write(&file, "not a project directory\n").unwrap();

    assert!(skills::setup_skill(&missing.to_string_lossy(), "shep-todos").is_err());
    assert!(skills::setup_skill(&file.to_string_lossy(), "shep-todos").is_err());
}
