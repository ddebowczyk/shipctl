use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use shipctl_core::skill_installation::{has_skill, inspect_skills, install_skill, uninstall_skill};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
const FIXTURE_SKILL: &str = "---\nname: fixture-skill\n---\n\n# Fixture skill\n";

fn catalog_ids() -> Vec<String> {
    vec!["fixture-skill".to_string(), "fixture-other".to_string()]
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "shipctl-skills-characterization-{tag}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
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
    let catalog = inspect_skills(&missing, &catalog_ids()).unwrap();

    assert_eq!(
        catalog
            .iter()
            .map(|skill| skill.skill_id.as_str())
            .collect::<Vec<_>>(),
        ["fixture-skill", "fixture-other"]
    );
    assert!(catalog.iter().all(|skill| !skill.installed));
}

#[test]
fn installed_state_is_file_existence_not_metadata_validity() {
    let fixture = TempRoot::new("malformed");
    let skill_dir = fixture.path().join(".agents/skills/fixture-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "this is not skill frontmatter\n",
    )
    .unwrap();

    let catalog = inspect_skills(fixture.path(), &catalog_ids()).unwrap();
    let skill = catalog
        .iter()
        .find(|skill| skill.skill_id == "fixture-skill")
        .unwrap();

    assert!(skill.installed);
    assert!(!has_skill(fixture.path(), "fixture-other"));
}

#[test]
fn setup_and_remove_are_scoped_to_the_requested_project_root() {
    let alpha = TempRoot::new("alpha");
    let beta = TempRoot::new("beta");

    install_skill(alpha.path(), "fixture-skill", FIXTURE_SKILL).unwrap();

    assert!(has_skill(alpha.path(), "fixture-skill"));
    assert!(!has_skill(beta.path(), "fixture-skill"));
    assert!(alpha
        .path()
        .join(".claude/skills/fixture-skill/SKILL.md")
        .is_file());

    uninstall_skill(alpha.path(), "fixture-skill").unwrap();
    assert!(!has_skill(alpha.path(), "fixture-skill"));
    assert!(!alpha.path().join(".claude/skills/fixture-skill").exists());
}

#[test]
fn mutations_reject_unavailable_or_non_directory_roots() {
    let fixture = TempRoot::new("invalid-root");
    let missing = fixture.path().join("missing");
    let file = fixture.path().join("file");
    fs::write(&file, "not a project directory\n").unwrap();

    assert!(install_skill(&missing, "fixture-skill", FIXTURE_SKILL).is_err());
    assert!(install_skill(&file, "fixture-skill", FIXTURE_SKILL).is_err());
}
