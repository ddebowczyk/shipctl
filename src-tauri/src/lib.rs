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

use shipctl_core::instance::{
    ControlServer, InstanceContext, InstanceLaunchOptions, InstanceLeases,
};
use shipctl_core::message_bus::{MessageBusBridgeService, RuntimeMessageBus};
use shipctl_core::module_control::live::ModuleControlService;
use shipctl_core::module_control::registry::ModuleRegistrySnapshotProvider;
use shipctl_core::projects::watcher::GitWatcher;
use shipctl_core::scheduler::{SchedulerService, SchedulerSnapshotProvider};
use shipctl_core::state::archive::StateArchiveService;
use shipctl_core::state::providers::{
    LegacyStateSnapshotProvider, UiSnapshotProvider, WorkspaceSnapshotProvider,
};
use shipctl_core::state::ui::UiStateStore;
use shipctl_core::terminal::TerminalService;
use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_api::{DurableWriteBarrier, SnapshotProvider};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_options(InstanceLaunchOptions::default()).expect("error while running Shipctl UI");
}

pub fn run_with_options(options: InstanceLaunchOptions) -> Result<(), String> {
    let _ = fix_path_env::fix();

    let load_state = options.load_state.clone();
    let reconcile_external_sources = load_state.is_none();
    let context = InstanceContext::resolve(options, build_info::APP_VERSION)?;
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
    let module_control = ModuleControlService::initialize(paths.clone(), context.instance_id)
        .map_err(|error| error.to_string())?;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let workspace = WorkspaceManager::new_with_barrier(paths.clone(), durable_writes.clone());
    // Seed retention from normalized settings before any terminal can spawn, so
    // no runtime is ever constructed with a policy the user did not choose.
    let terminals = {
        let mut settings = workspace.load_terminal_settings().unwrap_or_default();
        shipctl_core::workspace::config::normalize_terminal_settings(&mut settings);
        TerminalService::new(
            context.instance_id.to_string(),
            shipctl_core::terminal::retention::TerminalRetentionPolicy::from_bytes(
                settings.scrollback_bytes,
            ),
        )
    };
    let ui_state = UiStateStore::new_with_barrier(paths.ui_state.clone(), durable_writes.clone());
    let message_bus = RuntimeMessageBus::new(context.clone());
    let message_bridges = MessageBusBridgeService::new(message_bus.clone());
    let agent_capabilities = shipctl_core::module_control::agent::AgentCapabilityService::new(
        module_control.clone(),
        message_bus.clone(),
    );
    let scheduler = SchedulerService::new(
        context.clone(),
        paths.schedule_root.clone(),
        message_bus.clone(),
    )
    .map_err(|error| error.to_string())?;
    let scheduler_startup = scheduler.clone();
    let control_context = context.clone();
    let control_leases = leases.clone();
    let app = modules::install(
        builder,
        terminals.clone(),
        workspace.clone(),
        paths.clone(),
        durable_writes,
        message_bridges.clone(),
    )
    .manage(terminals)
    .manage(workspace)
    .manage(ui_state)
    .manage(state_archive)
    .manage(module_control)
    .manage(agent_capabilities)
    .manage(message_bus)
    .manage(message_bridges)
    .manage(scheduler)
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
        if let Err(e) = workspace.backfill_global_config_defaults() {
            eprintln!("Config backfill warning: {e}");
        }

        // Start file system watcher for git status updates
        app.manage(GitWatcher::new(app.handle().clone()));

        // Release builds need the same file-backed diagnostics as development
        // builds. Logging is best-effort so an unavailable log directory can
        // never become another startup failure.
        if let Err(error) = app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(configured_log_level())
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
        modules::start_background_tasks(app.handle(), reconcile_external_sources);
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
        shipctl_core::projects::commands::list_repos,
        shipctl_core::projects::commands::register_repo,
        shipctl_core::projects::commands::unregister_repo,
        shipctl_core::projects::commands::load_workspace,
        shipctl_core::projects::commands::save_workspace,
        shipctl_core::projects::commands::list_groups,
        shipctl_core::projects::commands::create_group,
        shipctl_core::projects::commands::rename_group,
        shipctl_core::projects::commands::delete_group,
        shipctl_core::projects::commands::move_repo_to_group,
        shipctl_core::projects::commands::watch_repo,
        shipctl_core::projects::commands::unwatch_repo,
        shipctl_core::settings::commands::get_editor_settings,
        shipctl_core::settings::commands::save_editor_settings,
        shipctl_core::settings::commands::get_project_settings,
        shipctl_core::settings::commands::save_project_settings,
        shipctl_core::settings::commands::get_keybinding_settings,
        shipctl_core::settings::commands::save_keybinding_settings,
        shipctl_core::settings::commands::get_sidebar_settings,
        shipctl_core::settings::commands::open_in_editor,
        shipctl_core::terminal::commands::get_terminal_settings,
        shipctl_core::terminal::commands::save_terminal_settings,
        shipctl_core::terminal::commands::get_memory_stats,
        shipctl_core::terminal::commands::spawn_terminal,
        shipctl_core::terminal::commands::list_terminals,
        shipctl_core::terminal::commands::get_terminal,
        shipctl_core::terminal::commands::get_terminal_snapshot,
        shipctl_core::terminal::commands::attach_terminal,
        shipctl_core::terminal::commands::detach_terminal,
        shipctl_core::terminal::commands::subscribe_terminal_registry,
        shipctl_core::terminal::commands::unsubscribe_terminal_registry,
        shipctl_core::terminal::commands::write_terminal,
        shipctl_core::terminal::commands::input_terminal,
        shipctl_core::terminal::commands::history_terminal,
        shipctl_core::terminal::commands::anchor_terminal,
        shipctl_core::terminal::commands::resolve_terminal_anchor,
        shipctl_core::terminal::commands::release_terminal_anchor,
        shipctl_core::terminal::commands::select_terminal,
        shipctl_core::terminal::commands::resize_terminal,
        shipctl_core::terminal::commands::close_terminal,
        shipctl_core::terminal::commands::update_terminal_color_theme,
        shipctl_core::terminal::commands::update_terminal_metadata,
        shipctl_core::appearance::commands::list_monospace_families,
        shipctl_core::appearance::commands::load_font_family,
        shipctl_core::platform::commands::get_username,
        shipctl_core::platform::commands::get_home_directory,
        shipctl_core::platform::commands::get_default_shell,
        shipctl_core::platform::commands::get_computer_name,
        shipctl_core::platform::commands::check_command_exists,
        shipctl_core::platform::commands::reveal_in_finder,
        shipctl_core::platform::commands::open_url,
        shipctl_core::instance::context::inspect_instance,
        shipctl_core::state::ui::get_ui_state,
        shipctl_core::state::ui::set_last_repo_path,
        shipctl_core::state::ui::save_appearance_state,
        shipctl_core::module_control::live::publish_module_runtime_snapshot,
        shipctl_core::module_control::live::list_startup_modules,
        shipctl_core::message_bus::commands::open_runtime_message_bridge,
        shipctl_core::message_bus::commands::reconcile_runtime_message_bridge,
        shipctl_core::message_bus::commands::close_runtime_message_bridge,
        shipctl_core::message_bus::commands::send_runtime_message,
        shipctl_core::message_bus::commands::publish_runtime_message,
        shipctl_core::message_bus::commands::request_runtime_message,
        shipctl_core::message_bus::commands::reply_runtime_message,
        shipctl_core::message_bus::commands::report_runtime_message_failure,
        shipctl_core::message_bus::commands::inspect_runtime_messages,
        modules::capability_data::get_global_capability_data,
        modules::capability_data::replace_global_capability_data,
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
    let mut providers: Vec<Arc<dyn SnapshotProvider>> = vec![
        Arc::new(WorkspaceSnapshotProvider::new(paths.global_config.clone())),
        Arc::new(LegacyStateSnapshotProvider),
        Arc::new(UiSnapshotProvider::new(paths.ui_state.clone())),
        Arc::new(ModuleRegistrySnapshotProvider::new(
            paths.module_registry_database.clone(),
        )),
        Arc::new(
            shipctl_core::module_control::artifact_snapshot::ModuleArtifactSnapshotProvider::new(
                paths.module_artifact_root.clone(),
            ),
        ),
        Arc::new(SchedulerSnapshotProvider::new(paths.schedule_root.clone())),
    ];
    modules::extend_snapshot_providers(paths, &mut providers);
    providers
}

fn configured_log_level() -> log::LevelFilter {
    std::env::var("SHIPCTL_LOG")
        .ok()
        .as_deref()
        .and_then(parse_log_level)
        .unwrap_or(log::LevelFilter::Info)
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
}
