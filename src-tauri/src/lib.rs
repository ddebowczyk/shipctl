//! The Tauri desktop shell.
//!
//! This crate holds no capability logic. It starts the app, wires the managers
//! from `shipctl-core` into Tauri state, registers the command handlers those
//! capabilities expose, and installs whichever module plugins this build
//! carries. Everything it registers lives in `core/backend` or `modules/`.

mod lifecycle;
mod menu;
mod modules;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use shipctl_core::projects::watcher::GitWatcher;
use shipctl_core::terminal::manager::PtyManager;
use shipctl_core::workspace::manager::WorkspaceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fix_path_env::fix();

    // Copy pre-rename state from `~/.shep` before anything opens a file under
    // `~/.shipctl`. Module plugins install below and may touch their own state
    // eagerly, so this cannot wait for `setup()`. The original is left in
    // place: an installed `shep` build keeps its own state and keeps working.
    match shipctl_core::workspace::migration::migrate_home_state() {
        Ok(shipctl_core::workspace::migration::Outcome::Copied(n)) => {
            eprintln!("Migrated {n} file(s) from ~/.shep into ~/.shipctl");
        }
        Ok(_) => {}
        Err(e) => eprintln!("State migration warning: {e}"),
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let pty_manager = PtyManager::new();
    let app = modules::install(builder, pty_manager.clone())
        .manage(pty_manager)
        .manage(WorkspaceManager::new())
        .setup(|app| {
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
            modules::capability_data::get_global_capability_data,
            modules::capability_data::replace_global_capability_data,
            lifecycle::shutdown_and_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = &event {
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
}
