const COMMANDS: &[&str] = &[
    "is_git_repo",
    "git_init",
    "git_current_branch",
    "git_list_branches",
    "git_push_branch",
    "git_list_worktrees",
    "git_create_worktree",
    "git_status",
    "git_changed_files",
    "git_file_diff",
    "git_file_contents",
    "git_list_files",
    "git_stage_file",
    "git_stage_all",
    "git_commit",
    "git_unstage_file",
    "git_unstage_all",
    "git_switch_branch",
    "git_create_branch",
    "git_diff_stats",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
