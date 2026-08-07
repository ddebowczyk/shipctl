use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::git;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "shep-git-characterization-{tag}-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn directory(&self, name: &str) -> PathBuf {
        let path = self.path().join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_git(path: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap()
}

fn git_ok(path: &Path, args: &[&str]) {
    let output = run_git(path, args);
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn initialize(path: &Path) {
    git::init_repo(path.to_str().unwrap()).unwrap();
    git_ok(path, &["config", "user.name", "Shep Characterization"]);
    git_ok(
        path,
        &[
            "config",
            "user.email",
            "shep-characterization@example.invalid",
        ],
    );
}

fn commit_all(path: &Path, message: &str) {
    git::stage_all(path.to_str().unwrap()).unwrap();
    git::commit(path.to_str().unwrap(), message).unwrap();
}

fn write(path: &Path, contents: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

#[test]
fn non_repository_is_an_unavailable_status_and_other_operations_return_errors() {
    let fixture = TempRoot::new("non-repository");
    let path = fixture.path().to_str().unwrap();

    let status = git::status(path);
    assert!(!status.is_git_repo);
    assert_eq!(status.branch, "");
    assert!(!status.dirty);
    assert_eq!(status.staged, 0);
    assert_eq!(status.unstaged, 0);
    assert_eq!(status.untracked, 0);
    assert!(!git::is_git_repo(path));
    assert!(git::changed_files(path).is_err());
    assert!(git::list_files(path).is_err());
    match git::create_worktree(path, "") {
        Err(error) => assert_eq!(error, "Branch name is required"),
        Ok(_) => panic!("empty branch name unexpectedly created a worktree"),
    }
}

#[test]
fn status_changes_and_diffs_preserve_staged_unstaged_untracked_and_detached_states() {
    let fixture = TempRoot::new("status");
    let repo = fixture.directory("repo");
    let path = repo.to_str().unwrap();
    initialize(&repo);
    write(&repo.join("tracked.txt"), "one\n");
    commit_all(&repo, "initial");

    let clean = git::status(path);
    assert!(clean.is_git_repo);
    assert_eq!(clean.branch, "main");
    assert!(!clean.dirty);

    write(&repo.join("tracked.txt"), "two\n");
    git::stage_file(path, "tracked.txt").unwrap();
    write(&repo.join("tracked.txt"), "three\n");
    write(&repo.join("new.txt"), "new\n");

    let dirty = git::status(path);
    assert!(dirty.dirty);
    assert_eq!(dirty.staged, 1);
    assert_eq!(dirty.unstaged, 1);
    assert_eq!(dirty.untracked, 1);

    let changed = git::changed_files(path).unwrap();
    assert!(changed
        .iter()
        .any(|file| file.path == "tracked.txt" && file.area == "staged" && file.status == "M"));
    assert!(changed.iter().any(|file| {
        file.path == "tracked.txt" && file.area == "unstaged" && file.status == "M"
    }));
    assert!(changed
        .iter()
        .any(|file| file.path == "new.txt" && file.area == "untracked" && file.status == "?"));

    let staged_diff = git::file_diff(path, "tracked.txt", true).unwrap();
    assert!(staged_diff.contains("-one"));
    assert!(staged_diff.contains("+two"));
    let working_diff = git::file_diff(path, "tracked.txt", false).unwrap();
    assert!(working_diff.contains("-two"));
    assert!(working_diff.contains("+three"));
    assert!(git::file_diff(path, "new.txt", false)
        .unwrap()
        .contains("+new"));

    let stats = git::diff_stats(path).unwrap();
    assert!(stats
        .iter()
        .any(|stat| stat.path == "tracked.txt" && stat.additions == 1 && stat.deletions == 1));
    assert!(stats
        .iter()
        .any(|stat| stat.path == "new.txt" && stat.additions == 1 && stat.deletions == 0));

    git_ok(&repo, &["checkout", "--detach", "HEAD"]);
    let detached = git::status(path);
    assert_eq!(detached.branch, "(detached)");
    assert_eq!(git::current_branch(path).unwrap(), "");
}

#[test]
fn file_listing_and_preview_sources_follow_git_visibility_and_preview_limits() {
    let fixture = TempRoot::new("files");
    let repo = fixture.directory("repo");
    let path = repo.to_str().unwrap();
    initialize(&repo);
    write(&repo.join(".gitignore"), "ignored.txt\n.env*\n");
    write(&repo.join("tracked.txt"), "head\n");
    commit_all(&repo, "initial");

    write(&repo.join("tracked.txt"), "staged\n");
    git::stage_file(path, "tracked.txt").unwrap();
    write(&repo.join("tracked.txt"), "working\n");
    write(&repo.join("visible.txt"), "visible\n");
    write(&repo.join("ignored.txt"), "ignored\n");
    write(&repo.join(".env"), "root env\n");
    write(&repo.join(".env.local"), "local env\n");
    write(&repo.join(".envrc"), "direnv\n");

    assert_eq!(
        git::list_files(path).unwrap(),
        [
            ".env",
            ".env.local",
            ".envrc",
            ".gitignore",
            "tracked.txt",
            "visible.txt",
        ]
    );
    assert_eq!(
        git::file_contents(path, "tracked.txt", "working").unwrap(),
        "working\n"
    );
    assert_eq!(
        git::file_contents(path, "tracked.txt", "staged").unwrap(),
        "staged\n"
    );
    assert_eq!(
        git::file_contents(path, "tracked.txt", "head").unwrap(),
        "head\n"
    );
    assert!(git::file_contents(path, "tracked.txt", "unknown")
        .unwrap_err()
        .contains("Unknown source"));

    write(&repo.join("binary.bin"), [0xff, 0xfe, 0xfd]);
    assert!(git::file_contents(path, "binary.bin", "working")
        .unwrap_err()
        .contains("Binary or non-UTF-8"));
    write(&repo.join("large.txt"), vec![b'x'; 200 * 1024 + 1]);
    assert!(git::file_contents(path, "large.txt", "working")
        .unwrap_err()
        .contains("File too large to preview"));
}

#[test]
fn worktree_creation_uses_the_shep_sibling_directory_and_reports_parent_metadata() {
    let fixture = TempRoot::new("worktree");
    let repo = fixture.directory("repo");
    let path = repo.to_str().unwrap();
    initialize(&repo);
    write(&repo.join("README.md"), "main\n");
    commit_all(&repo, "initial");

    let created = git::create_worktree(path, "feature/characterized").unwrap();
    assert_eq!(created.branch, "feature/characterized");
    assert_eq!(
        Path::new(&created.path),
        fixture
            .path()
            .canonicalize()
            .unwrap()
            .join(".shep-worktrees/repo/feature-characterized")
    );

    let entries = git::list_worktrees(path).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries[0].is_main);
    assert_eq!(entries[0].branch.as_deref(), Some("main"));
    assert!(!entries[1].is_main);
    assert_eq!(entries[1].branch.as_deref(), Some("feature/characterized"));

    let worktree_status = git::status(&created.path);
    assert_eq!(worktree_status.worktree_parent.as_deref(), Some("repo"));
}

#[test]
fn submodules_are_single_gitlink_files_and_surface_nested_dirtiness() {
    let fixture = TempRoot::new("submodule");
    let child = fixture.directory("child");
    initialize(&child);
    write(&child.join("child.txt"), "child\n");
    commit_all(&child, "child initial");

    let parent = fixture.directory("parent");
    initialize(&parent);
    write(&parent.join("README.md"), "parent\n");
    commit_all(&parent, "parent initial");

    let child_path = child.to_str().unwrap();
    let output = Command::new("git")
        .args(["-c", "protocol.file.allow=always", "-C"])
        .arg(&parent)
        .args(["submodule", "add", child_path, "deps/child"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "submodule add failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    commit_all(&parent, "add submodule");

    let parent_path = parent.to_str().unwrap();
    assert!(git::list_files(parent_path)
        .unwrap()
        .contains(&"deps/child".to_string()));
    assert!(git::file_contents(parent_path, "deps/child", "working").is_err());

    write(&parent.join("deps/child/child.txt"), "changed\n");
    let status = git::status(parent_path);
    assert_eq!(status.unstaged, 1);
    assert!(git::changed_files(parent_path)
        .unwrap()
        .iter()
        .any(|file| file.path == "deps/child" && file.area == "unstaged"));
}

#[test]
fn large_untracked_directories_are_expanded_for_files_but_collapsed_for_status_badges() {
    let fixture = TempRoot::new("large-tree");
    let repo = fixture.directory("repo");
    let path = repo.to_str().unwrap();
    initialize(&repo);

    for index in 0..256 {
        write(
            &repo.join(format!("bulk/section-{}/file-{index:03}.txt", index % 8)),
            format!("fixture {index}\n"),
        );
    }

    let files = git::list_files(path).unwrap();
    assert_eq!(files.len(), 256);
    assert!(files.windows(2).all(|pair| pair[0] <= pair[1]));
    let changed = git::changed_files(path).unwrap();
    assert_eq!(
        changed
            .iter()
            .filter(|file| file.area == "untracked")
            .count(),
        256
    );
    assert_eq!(git::status(path).untracked, 1);
}
