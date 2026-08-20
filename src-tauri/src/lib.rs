//! The Tauri desktop shell.
//!
//! This crate holds no capability logic. It starts the app, wires the managers
//! from `shipctl-core` into Tauri state, registers the command handlers those
//! capabilities expose, and installs whichever module plugins this build
//! carries. Everything it registers lives in `core/backend` or `modules/`.

pub mod build_info;

mod lifecycle;
mod menu;
mod modules;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use shipctl_core::assistant_launch::{AssistantLaunchService, AssistantSnapshotProvider};
use shipctl_core::credentials::CredentialStoreService;
use shipctl_core::git::GitService;
use shipctl_core::instance::{
    ControlServer, InstanceContext, InstanceLaunchOptions, InstanceLeases,
};
use shipctl_core::logs::{
    app_log_dir, cleanup_message, inspect_all, now_timestamp, LogRecord, LOG_FILE_STEM,
    NOTICE_LOG_FILE_STEM,
};
use shipctl_core::message_bus::RuntimeMessageBus;
use shipctl_core::module_control::live::ModuleControlService;
use shipctl_core::module_control::registry::ModuleRegistrySnapshotProvider;
use shipctl_core::plugin_data::{
    LegacyPluginDataRecordMapSource, PluginDataScope, PluginDataService,
};
use shipctl_core::processes::ProcessesService;
use shipctl_core::project_documents::ProjectDocumentsService;
use shipctl_core::scheduler::{
    purge_stale_lease_sources, SchedulerLeaseService, SchedulerService, SchedulerSnapshotProvider,
};
use shipctl_core::semantic_terminal::SemanticTerminalService;
use shipctl_core::skill_installation::SkillInstallationService;
use shipctl_core::state::archive::StateArchiveService;
use shipctl_core::state::providers::{
    LegacyStateSnapshotProvider, PluginDataSnapshotProvider, UiSnapshotProvider,
    WorkspaceSnapshotProvider,
};
use shipctl_core::state::ui::UiStateStore;
use shipctl_core::state::{DurableWriteBarrier, SnapshotProvider};
use shipctl_core::terminal_host::{
    TerminalDriverDescriptor, TerminalDriverId, TerminalDriverRegistry, TerminalService,
};
use shipctl_core::usage_sources::{UsageSnapshotProvider, UsageSourcesService};
use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_tauri_adapter::{GitWatcher, MessageBusBridgeService};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_options(InstanceLaunchOptions::default()).expect("error while running Shipctl UI");
}

pub fn run_with_options(options: InstanceLaunchOptions) -> Result<(), String> {
    let _ = fix_path_env::fix();

    let load_state = options.load_state.clone();
    let context = InstanceContext::resolve(options, build_info::APP_VERSION)?;
    // Every instance writes to one shared log, so each record has to name the
    // instance that produced it or a second UI is unreadable.
    let logging_instance = context.name.clone();
    let paths = context.paths();
    let module_artifact_root = paths.module_artifact_root.clone();
    let leases = Arc::new(InstanceLeases::acquire(&context).map_err(|error| error.to_string())?);
    let durable_writes = DurableWriteBarrier::default();
    let snapshot_providers = snapshot_providers(&paths);
    let state_archive = StateArchiveService::new(
        paths.clone(),
        &context,
        durable_writes.clone(),
        snapshot_providers,
    );

    // Copy legacy state before anything opens a file under `~/.shipctl`.
    // Module plugins install below and may touch their own state eagerly, so
    // this cannot wait for `setup()`. The original data remains untouched.
    let migration = if let Some(archive) = load_state.as_deref() {
        state_archive
            .restore(archive)
            .map_err(|error| error.to_string())?;
        Ok(shipctl_core::workspace::migration::Outcome::AlreadyPresent)
    } else if context.uses_default_profile() {
        shipctl_core::workspace::migration::migrate_home_state_to(&context.state_root)
    } else {
        Ok(shipctl_core::workspace::migration::Outcome::AlreadyPresent)
    };
    match migration {
        Ok(shipctl_core::workspace::migration::Outcome::Copied(n)) => {
            eprintln!("Migrated {n} file(s) from legacy application data");
        }
        Ok(_) => {}
        Err(e) => eprintln!("State migration warning: {e}"),
    }

    modules::inventory::seed_current_build(&paths)?;
    modules::seed_bundled_artifacts(&paths, context.instance_id, durable_writes.clone())?;
    let module_control = ModuleControlService::initialize(paths.clone(), context.instance_id)
        .map_err(|error| error.to_string())?;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    let workspace = WorkspaceManager::new_with_barrier(paths.clone(), durable_writes.clone());
    // TypeScript applies durable configuration after the shell is available.
    // The native resource starts with its stable generic default and accepts a
    // byte-budget commit through `set_terminal_retention`.
    let terminals = {
        let mut drivers = TerminalDriverRegistry::default();
        drivers
            .register(shipctl_core::semantic_terminal::native_factory())
            .expect("the semantic terminal driver registers once");
        drivers
            .register_browser_driver(TerminalDriverDescriptor {
                id: TerminalDriverId::new("thin-terminal")
                    .expect("thin-terminal has a valid static driver id"),
                native_interpretation: false,
            })
            .expect("the thin terminal driver registers once");
        TerminalService::with_driver_registry(
            context.instance_id.to_string(),
            shipctl_core::terminal_host::retention::TerminalRetentionPolicy::default(),
            drivers,
        )
    };
    let semantic_terminals = SemanticTerminalService::terminal_host(terminals.clone());
    let ui_state = UiStateStore::new_with_barrier(paths.ui_state.clone(), durable_writes.clone());
    // This is a read-only input only. The generic plugin-data service exposes
    // it as revision-zero migration data for the reserved workspace owner;
    // its first migration writes the canonical plugin-data record and every
    // later read is served exclusively from that record.
    let workspace_document_source = LegacyPluginDataRecordMapSource::new(
        paths.state_root.join("workspace-documents.json"),
        "shipctl.workspace".to_string(),
        PluginDataScope::Global,
        "workspace-document:".to_string(),
        1,
    )?;
    let plugin_data = PluginDataService::with_legacy_record_maps(
        paths.plugin_data.clone(),
        durable_writes.clone(),
        vec![workspace_document_source],
    );
    let processes = ProcessesService::system();
    let git = GitService::workspace(workspace.clone());
    let project_documents = ProjectDocumentsService::workspace(workspace.clone());
    let skill_installation = SkillInstallationService::workspace(workspace.clone());
    let usage_sources = UsageSourcesService::open_at(&paths.usage_database, durable_writes.clone())
        .unwrap_or_else(|error| {
            eprintln!("Usage source database failed to open ({error}), using in-memory fallback");
            UsageSourcesService::open_in_memory(durable_writes.clone())
        });
    let assistant_launch = AssistantLaunchService::new(
        terminals.clone(),
        paths.assistant_sessions.clone(),
        durable_writes.clone(),
    );
    let credentials = CredentialStoreService::new();
    let message_bus = RuntimeMessageBus::new(context.clone());
    let agent_capabilities = shipctl_core::module_control::agent::AgentCapabilityService::new(
        module_control.clone(),
        message_bus.clone(),
    );
    purge_stale_lease_sources(&paths.schedule_root, &durable_writes)
        .map_err(|error| error.to_string())?;
    let scheduler = SchedulerService::new(
        context.clone(),
        paths.schedule_root.clone(),
        message_bus.clone(),
    )
    .map_err(|error| error.to_string())?;
    let scheduler_leases = SchedulerLeaseService::new(scheduler.clone(), durable_writes.clone());
    let message_bridges = MessageBusBridgeService::with_scheduler_leases(
        message_bus.clone(),
        scheduler_leases.clone(),
    );
    let scheduler_startup = scheduler.clone();
    let control_context = context.clone();
    let control_leases = leases.clone();
    let app = modules::install(builder)
        .manage(terminals)
        .manage(semantic_terminals)
        .manage(workspace)
        .manage(plugin_data)
        .manage(processes)
        .manage(git)
        .manage(project_documents)
        .manage(skill_installation)
        .manage(usage_sources)
        .manage(assistant_launch)
        .manage(credentials)
        .manage(ui_state)
        .manage(state_archive)
        .manage(module_control)
        .manage(shipctl_tauri_adapter::module_control::ModuleRegistryRevisionObservers::default())
        .manage(agent_capabilities)
        .manage(message_bus)
        .manage(message_bridges)
        .manage(scheduler)
        .manage(scheduler_leases)
        .manage(paths)
        .manage(context)
        .setup(move |app| {
            // The static config intentionally grants no filesystem location. This
            // per-instance scope is the sole directory the asset protocol may
            // serve, so runtime module artifacts can change without widening the
            // webview's access to the rest of the state profile.
            app.state::<tauri::scope::Scopes>()
                .allow_directory(&module_artifact_root, true)?;

            // The frontend opens its bridge after setup. The scheduler retains its
            // initial candidate until that first route publication so it never
            // accepts schedules against generation zero.
            tauri::async_runtime::spawn(async move {
                scheduler_startup.start_initial_route_refresh();
            });

            // Run migration from old project-based config
            let workspace = app.state::<WorkspaceManager>();
            if let Err(e) = workspace.migrate() {
                eprintln!("Migration warning: {e}");
            }
            // Start file system watcher for git status updates
            app.manage(GitWatcher::new(app.handle().clone()));

            // Release builds need the same file-backed diagnostics as development
            // builds. Logging is best-effort so an unavailable log directory can
            // never become another startup failure.
            //
            // There is deliberately no stdout target. This is a desktop
            // application: its diagnostics belong in a file that `shipctl logs`
            // can query, not on the terminal of whatever happened to start it.
            //
            // Records are JSON Lines so the file is directly usable with `jq`,
            // with no parsing step and no CLI in the way.
            let log_directory = app_log_dir(&app.config().identifier);
            refuse_incompatible_logs(log_directory.as_deref())?;
            if let Err(error) = app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(configured_log_level())
                    .format(move |callback, message, record| {
                        let line = LogRecord::new(
                            now_timestamp(),
                            record.level().into(),
                            record.target(),
                            Some(logging_instance.as_str()),
                            &message.to_string(),
                        )
                        .to_line()
                        .unwrap_or_default();
                        callback.finish(format_args!("{line}"))
                    })
                    .targets([
                        log_target(log_directory.as_deref(), LOG_FILE_STEM)
                            .filter(|metadata| !is_notice_log_target(metadata.target())),
                        log_target(log_directory.as_deref(), NOTICE_LOG_FILE_STEM)
                            .filter(|metadata| is_notice_log_target(metadata.target())),
                    ])
                    .build(),
            ) {
                eprintln!("Logging warning: {error}");
            }
            log::info!(
                target: "shipctl::startup",
                "Shipctl UI starting: version={}, build_id={}",
                build_info::APP_VERSION,
                build_info::BUILD_ID,
            );

            menu::setup(app.handle())?;

            let control = ControlServer::start(
                control_context.clone(),
                control_leases.clone(),
                Arc::new(lifecycle::TauriControlHandler::new(app.handle().clone())),
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(control);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let terminals = window.state::<TerminalService>();
                if terminals.is_shutting_down() {
                    return;
                }
                let count = terminals.active_count();
                // Never let a window-close bypass the confirmation dialog.
                // With no PTYs it is still easy to lose the active workspace
                // by accidentally pressing Cmd+Q or the red window button.
                api.prevent_close();
                let _ = window.emit("quit-requested", count);
            }
        })
        .invoke_handler(tauri::generate_handler![
            shipctl_tauri_adapter::configuration::read_global_configuration_value,
            shipctl_tauri_adapter::configuration::read_project_configuration_value,
            shipctl_tauri_adapter::projects::list_repos,
            shipctl_tauri_adapter::projects::register_repo,
            shipctl_tauri_adapter::projects::unregister_repo,
            shipctl_tauri_adapter::projects::load_workspace,
            shipctl_tauri_adapter::projects::save_workspace,
            shipctl_tauri_adapter::projects::list_groups,
            shipctl_tauri_adapter::projects::create_group,
            shipctl_tauri_adapter::projects::rename_group,
            shipctl_tauri_adapter::projects::delete_group,
            shipctl_tauri_adapter::projects::move_repo_to_group,
            shipctl_tauri_adapter::projects::watch_repo,
            shipctl_tauri_adapter::projects::unwatch_repo,
            shipctl_tauri_adapter::terminal_host::set_terminal_retention,
            shipctl_tauri_adapter::terminal_host::get_memory_stats,
            shipctl_tauri_adapter::terminal_host::spawn_terminal,
            shipctl_tauri_adapter::terminal_host::list_terminals,
            shipctl_tauri_adapter::terminal_host::get_terminal,
            shipctl_tauri_adapter::terminal_host::get_terminal_publication_stats,
            shipctl_tauri_adapter::terminal_host::attach_raw_terminal,
            shipctl_tauri_adapter::terminal_host::detach_terminal,
            shipctl_tauri_adapter::terminal_host::subscribe_terminal_registry,
            shipctl_tauri_adapter::terminal_host::unsubscribe_terminal_registry,
            shipctl_tauri_adapter::terminal_host::write_terminal,
            shipctl_tauri_adapter::terminal_host::resize_terminal,
            shipctl_tauri_adapter::terminal_host::close_terminal,
            shipctl_tauri_adapter::terminal_host::update_terminal_color_theme,
            shipctl_tauri_adapter::terminal_host::update_terminal_metadata,
            shipctl_tauri_adapter::appearance::list_monospace_families,
            shipctl_tauri_adapter::appearance::load_font_family,
            shipctl_tauri_adapter::platform::get_username,
            shipctl_tauri_adapter::platform::get_home_directory,
            shipctl_tauri_adapter::platform::get_default_shell,
            shipctl_tauri_adapter::platform::get_computer_name,
            shipctl_tauri_adapter::platform::check_command_exists,
            shipctl_tauri_adapter::platform::reveal_in_finder,
            shipctl_tauri_adapter::platform::open_in_editor,
            shipctl_tauri_adapter::platform::open_url,
            shipctl_tauri_adapter::plugin_data::read_plugin_data_record,
            shipctl_tauri_adapter::plugin_data::write_plugin_data_record,
            shipctl_tauri_adapter::plugin_data::migrate_plugin_data_records,
            shipctl_tauri_adapter::processes::inspect_listening_processes,
            shipctl_tauri_adapter::processes::terminate_inspected_process,
            shipctl_tauri_adapter::processes::inspect_process_command,
            shipctl_tauri_adapter::processes::release_process_inspections,
            shipctl_tauri_adapter::git::git_is_repository,
            shipctl_tauri_adapter::git::git_initialize_repository,
            shipctl_tauri_adapter::git::git_current_branch,
            shipctl_tauri_adapter::git::git_list_branches,
            shipctl_tauri_adapter::git::git_push_branch,
            shipctl_tauri_adapter::git::git_list_worktrees,
            shipctl_tauri_adapter::git::git_create_worktree,
            shipctl_tauri_adapter::git::git_inspect_status,
            shipctl_tauri_adapter::git::git_list_changed_files,
            shipctl_tauri_adapter::git::git_read_file_diff,
            shipctl_tauri_adapter::git::git_read_file,
            shipctl_tauri_adapter::git::git_list_files,
            shipctl_tauri_adapter::git::git_stage_file,
            shipctl_tauri_adapter::git::git_stage_all,
            shipctl_tauri_adapter::git::git_commit,
            shipctl_tauri_adapter::git::git_unstage_file,
            shipctl_tauri_adapter::git::git_unstage_all,
            shipctl_tauri_adapter::git::git_switch_branch,
            shipctl_tauri_adapter::git::git_create_branch,
            shipctl_tauri_adapter::git::git_diff_stats,
            shipctl_tauri_adapter::git::release_git_activation,
            shipctl_tauri_adapter::project_documents::discover_project_documents,
            shipctl_tauri_adapter::project_documents::read_project_document,
            shipctl_tauri_adapter::project_documents::write_project_document,
            shipctl_tauri_adapter::project_documents::release_project_documents_activation,
            shipctl_tauri_adapter::skill_installation::inspect_skill_installations,
            shipctl_tauri_adapter::skill_installation::install_skill_source,
            shipctl_tauri_adapter::skill_installation::remove_skill_installation,
            shipctl_tauri_adapter::skill_installation::release_skill_installation_activation,
            shipctl_tauri_adapter::usage_sources::inspect_usage_sources,
            shipctl_tauri_adapter::usage_sources::refresh_usage_sources,
            shipctl_tauri_adapter::usage_sources::read_usage_source_resource,
            shipctl_tauri_adapter::usage_sources::release_usage_sources_activation,
            shipctl_tauri_adapter::assistant_launch::start_assistant_session,
            shipctl_tauri_adapter::assistant_launch::resume_assistant_session,
            shipctl_tauri_adapter::assistant_launch::record_assistant_session_identity,
            shipctl_tauri_adapter::assistant_launch::mark_assistant_session_identity_failed,
            shipctl_tauri_adapter::assistant_launch::record_assistant_session_placement,
            shipctl_tauri_adapter::assistant_launch::record_assistant_session_label,
            shipctl_tauri_adapter::assistant_launch::discard_assistant_session,
            shipctl_tauri_adapter::assistant_launch::rearm_assistant_session,
            shipctl_tauri_adapter::assistant_launch::inspect_restorable_assistant_sessions,
            shipctl_tauri_adapter::assistant_launch::take_assistant_session_startup_warning,
            shipctl_tauri_adapter::assistant_launch::prepare_assistant_sessions_for_shutdown,
            shipctl_tauri_adapter::assistant_launch::read_assistant_launch_resource,
            shipctl_tauri_adapter::assistant_launch::write_assistant_launch_resource,
            shipctl_tauri_adapter::assistant_launch::execute_assistant_launch_resource,
            shipctl_tauri_adapter::assistant_launch::release_assistant_launch_activation,
            shipctl_tauri_adapter::credentials::inspect_credential,
            shipctl_tauri_adapter::credentials::save_credential,
            shipctl_tauri_adapter::credentials::delete_credential,
            shipctl_tauri_adapter::credentials::release_credential_store_activation,
            shipctl_tauri_adapter::semantic_terminal::get_semantic_terminal_snapshot,
            shipctl_tauri_adapter::semantic_terminal::attach_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::credit_semantic_terminal_screen,
            shipctl_tauri_adapter::semantic_terminal::detach_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::resize_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::input_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::history_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::anchor_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::resolve_semantic_terminal_anchor,
            shipctl_tauri_adapter::semantic_terminal::release_semantic_terminal_anchor,
            shipctl_tauri_adapter::semantic_terminal::select_semantic_terminal,
            shipctl_tauri_adapter::semantic_terminal::is_semantic_terminal_paste_safe,
            shipctl_tauri_adapter::semantic_terminal::get_semantic_terminal_publication_stats,
            shipctl_tauri_adapter::semantic_terminal::get_semantic_terminal_app_memory,
            shipctl_tauri_adapter::semantic_terminal::release_semantic_terminal_activation,
            shipctl_tauri_adapter::instance::inspect_instance,
            shipctl_tauri_adapter::state::get_ui_state,
            shipctl_tauri_adapter::state::set_last_repo_path,
            shipctl_tauri_adapter::state::save_appearance_state,
            shipctl_tauri_adapter::module_control::publish_module_runtime_snapshot,
            shipctl_tauri_adapter::module_control::list_runtime_modules,
            shipctl_tauri_adapter::module_control::observe_module_registry_revisions,
            shipctl_tauri_adapter::module_control::stop_module_registry_revision_observer,
            shipctl_tauri_adapter::module_control::report_module_reconciliation_failure,
            shipctl_tauri_adapter::message_bus::open_runtime_message_bridge,
            shipctl_tauri_adapter::message_bus::reconcile_runtime_message_bridge,
            shipctl_tauri_adapter::message_bus::close_runtime_message_bridge,
            shipctl_tauri_adapter::message_bus::send_runtime_message,
            shipctl_tauri_adapter::message_bus::publish_runtime_message,
            shipctl_tauri_adapter::message_bus::request_runtime_message,
            shipctl_tauri_adapter::message_bus::reply_runtime_message,
            shipctl_tauri_adapter::message_bus::report_runtime_message_failure,
            shipctl_tauri_adapter::message_bus::inspect_runtime_messages,
            shipctl_tauri_adapter::scheduler::register_semantic_schedule,
            shipctl_tauri_adapter::scheduler::inspect_semantic_schedules,
            shipctl_tauri_adapter::scheduler::cancel_semantic_schedule,
            shipctl_tauri_adapter::scheduler::observe_semantic_schedule_deliveries,
            shipctl_tauri_adapter::scheduler::stop_semantic_schedule_observer,
            lifecycle::shutdown_and_quit,
        ])
        .build(tauri::generate_context!())
        .map_err(|error| format!("error while building Tauri application: {error}"))?;

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = &event {
            let terminals = app_handle.state::<TerminalService>();
            if terminals.is_shutting_down() {
                return;
            }
            let count = terminals.active_count();
            // Cmd+Q must use the same explicit confirmation as a window close,
            // regardless of whether a PTY happens to be active right now.
            api.prevent_exit();
            let _ = app_handle.emit("quit-requested", count);
        }
    });
    Ok(())
}

fn snapshot_providers(
    paths: &shipctl_core::state::paths::ShipctlPaths,
) -> Vec<Arc<dyn SnapshotProvider>> {
    let providers: Vec<Arc<dyn SnapshotProvider>> = vec![
        Arc::new(WorkspaceSnapshotProvider::new(paths.global_config.clone())),
        Arc::new(LegacyStateSnapshotProvider),
        Arc::new(UiSnapshotProvider::new(paths.ui_state.clone())),
        Arc::new(PluginDataSnapshotProvider::new(paths.plugin_data.clone())),
        Arc::new(ModuleRegistrySnapshotProvider::new(
            paths.module_registry_database.clone(),
        )),
        Arc::new(
            shipctl_core::module_control::artifact_snapshot::ModuleArtifactSnapshotProvider::new(
                paths.module_artifact_root.clone(),
                paths.module_registry_database.clone(),
            ),
        ),
        Arc::new(SchedulerSnapshotProvider::new(paths.schedule_root.clone())),
        Arc::new(UsageSnapshotProvider::new(paths.usage_database.clone())),
        Arc::new(AssistantSnapshotProvider::new(
            paths.assistant_sessions.clone(),
        )),
    ];
    providers
}

fn configured_log_level() -> log::LevelFilter {
    std::env::var("SHIPCTL_LOG")
        .ok()
        .as_deref()
        .and_then(parse_log_level)
        .unwrap_or(log::LevelFilter::Info)
}

/// One log file target.
///
/// The folder comes from `shipctl_core::logs::app_log_dir` rather than the log
/// plugin's own resolution, so the directory the UI writes to and the directory
/// `shipctl logs` reads from are decided by one function. The plugin's own
/// `LogDir` remains the fallback for a platform where that function cannot
/// resolve a home directory.
fn log_target(directory: Option<&std::path::Path>, file_name: &str) -> tauri_plugin_log::Target {
    let kind = match directory {
        Some(path) => tauri_plugin_log::TargetKind::Folder {
            path: path.to_path_buf(),
            file_name: Some(file_name.to_string()),
        },
        None => tauri_plugin_log::TargetKind::LogDir {
            file_name: Some(file_name.to_string()),
        },
    };
    tauri_plugin_log::Target::new(kind)
}

/// Refuse to start when a log file an older build left behind is in a format
/// this build can neither read nor extend.
///
/// Appending to such a file would produce a log that no reader can make sense
/// of, and this process must not decide on its own to delete a file it did not
/// write. So it stops and names what has to be removed. Clearing the file is
/// one command, and it belongs to whoever owns the machine.
fn refuse_incompatible_logs(directory: Option<&std::path::Path>) -> Result<(), String> {
    let Some(directory) = directory else {
        return Ok(());
    };
    let paths = [LOG_FILE_STEM, NOTICE_LOG_FILE_STEM]
        .map(|stem| directory.join(format!("{stem}.log")))
        .to_vec();
    let found = inspect_all(&paths)?;
    if found.is_empty() {
        return Ok(());
    }
    Err(cleanup_message(&found))
}

const NOTICE_LOG_TARGET: &str = "webview:shipctl.notice";

fn is_notice_log_target(target: &str) -> bool {
    target == NOTICE_LOG_TARGET
}

fn parse_log_level(value: &str) -> Option<log::LevelFilter> {
    match value.trim().to_ascii_lowercase().as_str() {
        "off" => Some(log::LevelFilter::Off),
        "error" => Some(log::LevelFilter::Error),
        "warn" => Some(log::LevelFilter::Warn),
        "info" => Some(log::LevelFilter::Info),
        "debug" => Some(log::LevelFilter::Debug),
        "trace" => Some(log::LevelFilter::Trace),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_log_levels_without_making_invalid_configuration_fatal() {
        assert_eq!(parse_log_level("trace"), Some(log::LevelFilter::Trace));
        assert_eq!(parse_log_level(" DEBUG "), Some(log::LevelFilter::Debug));
        assert_eq!(parse_log_level("verbose"), None);
    }

    #[test]
    fn routes_notice_diagnostics_to_their_own_log() {
        assert!(is_notice_log_target("webview:shipctl.notice"));
        assert!(!is_notice_log_target("webview:shipctl.terminal"));
        assert!(!is_notice_log_target("shipctl::terminal_host"));
    }
}
