//! The Tauri desktop shell.
//!
//! This crate holds no capability logic. It starts the app, wires the managers
//! from `shipctl-core` into Tauri state, registers the command handlers those
//! capabilities expose, and installs whichever module plugins this build
//! carries. Everything it registers lives in `core/backend` or `modules/`.

pub mod build_info;

mod lifecycle;
mod menu;
mod module_loader_probe;
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
use shipctl_core::state::archive::StateArchiveService;
use shipctl_core::state::providers::{UiSnapshotProvider, WorkspaceSnapshotProvider};
use shipctl_core::state::ui::UiStateStore;
use shipctl_core::terminal::manager::PtyManager;
use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_api::{DurableWriteBarrier, SnapshotProvider};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_options(InstanceLaunchOptions::default()).expect("error while running Shipctl UI");
}

pub fn run_with_options(options: InstanceLaunchOptions) -> Result<(), String> {
    run_with_options_and_loader_probe(options, None)
}

pub fn run_with_options_and_loader_probe(
    options: InstanceLaunchOptions,
    module_loader_probe_request: Option<std::path::PathBuf>,
) -> Result<(), String> {
    let _ = fix_path_env::fix();

    let load_state = options.load_state.clone();
    let reconcile_external_sources = load_state.is_none();
    let context = InstanceContext::resolve(options, build_info::APP_VERSION)?;
    let paths = context.paths();
    let module_artifact_root = paths.module_artifact_root.clone();
    let module_loader_probe = module_loader_probe::ModuleLoaderProbe::from_request(
        module_loader_probe_request.as_deref(),
        &paths,
    )?;
    let module_loader_probe_enabled = module_loader_probe.is_enabled();
    let leases = Arc::new(InstanceLeases::acquire(&context).map_err(|error| error.to_string())?);
    let durable_writes = DurableWriteBarrier::default();
    let snapshot_providers = snapshot_providers(&paths);
    let state_archive = StateArchiveService::new(
        paths.clone(),
        &context,
        durable_writes.clone(),
        snapshot_providers,
    );

    // Copy pre-rename state from `~/.shep` before anything opens a file under
    // `~/.shipctl`. Module plugins install below and may touch their own state
    // eagerly, so this cannot wait for `setup()`. The original is left in
    // place: an installed `shep` build keeps its own state and keeps working.
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
            eprintln!("Migrated {n} file(s) from ~/.shep into ~/.shipctl");
        }
        Ok(_) => {}
        Err(e) => eprintln!("State migration warning: {e}"),
    }

    if !module_loader_probe_enabled {
        modules::inventory::seed_current_build(&paths)?;
    }
    let module_control = if module_loader_probe_enabled {
        None
    } else {
        Some(
            ModuleControlService::initialize(paths.clone(), context.instance_id)
                .map_err(|error| error.to_string())?,
        )
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let pty_manager = PtyManager::new(context.instance_id.to_string());
    let workspace = WorkspaceManager::new_with_barrier(paths.clone(), durable_writes.clone());
    let ui_state = UiStateStore::new_with_barrier(paths.ui_state.clone(), durable_writes.clone());
    let message_bus = RuntimeMessageBus::new(context.clone());
    let message_bridges = MessageBusBridgeService::new(message_bus.clone());
    let control_context = context.clone();
    let control_leases = leases.clone();
    let app = modules::install(
        builder,
        pty_manager.clone(),
        workspace.clone(),
        paths.clone(),
        durable_writes,
        message_bridges.clone(),
    )
    .manage(pty_manager)
    .manage(workspace)
    .manage(ui_state)
    .manage(state_archive)
    .manage(module_loader_probe)
    .manage(module_control)
    .manage(message_bus)
    .manage(message_bridges)
    .manage(paths)
    .manage(context)
    .setup(move |app| {
        // The static config intentionally grants no filesystem location. This
        // per-instance scope is the sole directory the asset protocol may
        // serve, so runtime module artifacts can change without widening the
        // webview's access to the rest of the state profile.
        app.state::<tauri::scope::Scopes>()
            .allow_directory(&module_artifact_root, true)?;

        // A probe is a disposable host-only verification run. It deliberately
        // does not acquire a control socket, watcher, or background work that
        // could touch ordinary user/PTY state while the packaged webview loads
        // the immutable artifacts.
        if module_loader_probe_enabled {
            return Ok(());
        }

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

        menu::setup(app.handle())?;

        if cfg!(debug_assertions) {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
        }

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
            let pty = window.state::<PtyManager>();
            if pty.is_shutting_down() {
                return;
            }
            let count = pty.session_count();
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
        shipctl_core::terminal::commands::spawn_pty,
        shipctl_core::terminal::commands::write_pty,
        shipctl_core::terminal::commands::acknowledge_pty_output,
        shipctl_core::terminal::commands::update_pty_color_theme,
        shipctl_core::terminal::commands::resize_pty,
        shipctl_core::terminal::commands::kill_pty,
        shipctl_core::terminal::commands::get_pty_session_count,
        shipctl_core::terminal::commands::get_terminal_settings,
        shipctl_core::terminal::commands::save_terminal_settings,
        shipctl_core::terminal::commands::get_memory_stats,
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
        module_loader_probe::take_module_loader_probe,
        module_loader_probe::complete_module_loader_probe,
    ])
    .build(tauri::generate_context!())
    .map_err(|error| format!("error while building Tauri application: {error}"))?;

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = &event {
            if app_handle
                .state::<module_loader_probe::ModuleLoaderProbe>()
                .is_enabled()
            {
                return;
            }
            let pty = app_handle.state::<PtyManager>();
            if pty.is_shutting_down() {
                return;
            }
            let count = pty.session_count();
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
        Arc::new(UiSnapshotProvider::new(paths.ui_state.clone())),
        Arc::new(ModuleRegistrySnapshotProvider::new(
            paths.module_registry_database.clone(),
        )),
    ];
    modules::extend_snapshot_providers(paths, &mut providers);
    providers
}
