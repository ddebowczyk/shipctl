use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use shipctl_core::assistant_launch::{
    AssistantProvider, AssistantSessionRegistry, PrepareAssistantSession, SessionMode,
};
use shipctl_core::instance::{InstanceContext, InstanceLaunchOptions};
use shipctl_core::state::ui::UiStateStore;
use shipctl_core::terminal_host::retention::TerminalRetentionPolicy;
use shipctl_core::terminal_host::{TerminalId, TerminalService};
use shipctl_core::usage_sources::UsageDb;
use shipctl_core::workspace::config::EditorSettings;
use shipctl_core::workspace::manager::WorkspaceManager;
fn test_root() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "shipctl-instance-composition-{}-{unique}",
        std::process::id()
    ))
}

fn context(root: &std::path::Path, name: &str) -> InstanceContext {
    InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some(name.to_string()),
            state_root: Some(root.join(name).join("state")),
            runtime_root: Some(root.join(name).join("runtime")),
            load_state: None,
            provenance: None,
        },
        "test",
    )
    .unwrap()
}

#[test]
fn two_backend_compositions_isolate_every_registered_durable_source_and_terminal_identity() {
    let root = test_root();
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    let first = context(&root, "first");
    let second = context(&root, "second");
    let first_paths = first.paths();
    let second_paths = second.paths();

    let first_workspace = WorkspaceManager::new(first_paths.clone());
    let second_workspace = WorkspaceManager::new(second_paths.clone());
    first_workspace
        .save_editor_settings(&EditorSettings {
            preferred_editor: Some("zed".into()),
        })
        .unwrap();
    assert_eq!(
        first_workspace
            .load_editor_settings()
            .unwrap()
            .preferred_editor
            .as_deref(),
        Some("zed")
    );
    assert_eq!(
        second_workspace
            .load_editor_settings()
            .unwrap()
            .preferred_editor,
        None
    );

    let first_ui = UiStateStore::new(first_paths.ui_state.clone());
    let second_ui = UiStateStore::new(second_paths.ui_state.clone());
    first_ui
        .set_last_repo_path(Some(repo.to_string_lossy().into_owned()))
        .unwrap();
    assert!(first_ui.load().unwrap().last_repo_path.is_some());
    assert_eq!(second_ui.load().unwrap().last_repo_path, None);

    let first_assistants = AssistantSessionRegistry::new(first_paths.assistant_sessions.clone());
    first_assistants
        .prepare(PrepareAssistantSession {
            provider: AssistantProvider::Claude,
            launch_repo_path: repo.to_string_lossy().into_owned(),
            placement_project_path: repo.to_string_lossy().into_owned(),
            label: "isolated".into(),
            session_mode: SessionMode::Standard,
            model: None,
        })
        .unwrap();
    assert!(fs::read_to_string(&first_paths.assistant_sessions)
        .unwrap()
        .contains("isolated"));
    assert!(!second_paths.assistant_sessions.exists());

    let first_usage = UsageDb::open_at(&first_paths.usage_database).unwrap();
    let second_usage = UsageDb::open_at(&second_paths.usage_database).unwrap();
    first_usage
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TABLE isolation_marker (value TEXT); \
             INSERT INTO isolation_marker VALUES ('first');",
        )
        .unwrap();
    let first_marker: String = first_usage
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT value FROM isolation_marker", [], |row| row.get(0))
        .unwrap();
    assert_eq!(first_marker, "first");
    assert!(second_usage
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT value FROM isolation_marker", [], |row| {
            row.get::<_, String>(0)
        })
        .is_err());

    let first_terminals = TerminalService::new(
        first.instance_id.to_string(),
        TerminalRetentionPolicy::default(),
    );
    let second_terminals = TerminalService::new(
        second.instance_id.to_string(),
        TerminalRetentionPolicy::default(),
    );
    let mut first_environment = HashMap::new();
    let mut second_environment = HashMap::new();
    first_terminals.inject_host_environment(TerminalId::new(), &mut first_environment);
    second_terminals.inject_host_environment(TerminalId::new(), &mut second_environment);
    assert_eq!(
        first_environment.get("SHIPCTL_INSTANCE_ID"),
        Some(&first.instance_id.to_string())
    );
    assert_eq!(
        second_environment.get("SHIPCTL_INSTANCE_ID"),
        Some(&second.instance_id.to_string())
    );
    assert_ne!(first_environment, second_environment);

    assert!(first_paths
        .durable_sources()
        .iter()
        .all(|source| source.path.starts_with(&first.state_root)));
    assert!(second_paths
        .durable_sources()
        .iter()
        .all(|source| source.path.starts_with(&second.state_root)));

    let _ = fs::remove_dir_all(root);
}
