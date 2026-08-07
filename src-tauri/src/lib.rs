//! The Tauri desktop shell.
//!
//! This crate holds no capability logic. It starts the app, wires the managers
//! from `shep-core` into Tauri state, registers the command handlers those
//! capabilities expose, and installs whichever module plugins this build
//! carries. Everything it registers lives in `core/backend` or `modules/`.

mod lifecycle;
mod menu;
mod modules;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use shep_core::projects::watcher::GitWatcher;
use shep_core::terminal::manager::PtyManager;
use shep_core::workspace::manager::WorkspaceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fix_path_env::fix();
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
            shep_core::projects::commands::list_repos,
            shep_core::projects::commands::register_repo,
            shep_core::projects::commands::unregister_repo,
            shep_core::projects::commands::load_workspace,
            shep_core::projects::commands::save_workspace,
            shep_core::projects::commands::list_groups,
            shep_core::projects::commands::create_group,
            shep_core::projects::commands::rename_group,
            shep_core::projects::commands::delete_group,
            shep_core::projects::commands::move_repo_to_group,
            shep_core::projects::commands::watch_repo,
            shep_core::projects::commands::unwatch_repo,
            shep_core::settings::commands::get_editor_settings,
            shep_core::settings::commands::save_editor_settings,
            shep_core::settings::commands::get_project_settings,
            shep_core::settings::commands::save_project_settings,
            shep_core::settings::commands::get_keybinding_settings,
            shep_core::settings::commands::save_keybinding_settings,
            shep_core::settings::commands::get_sidebar_settings,
            shep_core::settings::commands::open_in_editor,
            shep_core::terminal::commands::spawn_pty,
            shep_core::terminal::commands::write_pty,
            shep_core::terminal::commands::acknowledge_pty_output,
            shep_core::terminal::commands::update_pty_color_theme,
            shep_core::terminal::commands::resize_pty,
            shep_core::terminal::commands::kill_pty,
            shep_core::terminal::commands::get_pty_session_count,
            shep_core::terminal::commands::get_terminal_settings,
            shep_core::terminal::commands::save_terminal_settings,
            shep_core::terminal::commands::get_memory_stats,
            shep_core::appearance::commands::list_monospace_families,
            shep_core::appearance::commands::load_font_family,
            shep_core::platform::commands::get_username,
            shep_core::platform::commands::get_home_directory,
            shep_core::platform::commands::get_default_shell,
            shep_core::platform::commands::get_computer_name,
            shep_core::platform::commands::check_command_exists,
            shep_core::platform::commands::reveal_in_finder,
            shep_core::platform::commands::open_url,
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
