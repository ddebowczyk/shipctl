mod assistant_sessions;
mod commands;
mod enabled_modules;
mod fonts;
#[cfg(feature = "git-module")]
mod git_module;
mod menu;
mod pi_config;
#[cfg(feature = "ports-module")]
mod ports_module;
mod pty;
#[cfg(feature = "skills-module")]
mod skills_module;
mod usage;
mod watcher;
mod workspace;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use assistant_sessions::AssistantSessionRegistry;
use pty::manager::PtyManager;
use usage::UsageDb;
use watcher::GitWatcher;
use workspace::manager::WorkspaceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fix_path_env::fix();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let app = enabled_modules::install(builder)
        .manage(PtyManager::new())
        .manage(AssistantSessionRegistry::new())
        .manage(WorkspaceManager::new())
        .manage(UsageDb::open().unwrap_or_else(|e| {
            eprintln!("Usage database failed to open ({e}), using in-memory fallback");
            UsageDb::open_in_memory()
        }))
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

            // Kick off background usage ingestion so it doesn't block startup
            let db = app.state::<UsageDb>().inner().clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                usage::run_background_ingest(&db);
                let _ = handle.emit("usage-ingest-complete", ());
            });

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
            commands::list_repos,
            commands::register_repo,
            commands::unregister_repo,
            commands::load_workspace,
            commands::save_workspace,
            commands::list_groups,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::move_repo_to_group,
            commands::get_editor_settings,
            commands::get_project_settings,
            commands::save_editor_settings,
            commands::save_project_settings,
            commands::get_keybinding_settings,
            commands::save_keybinding_settings,
            commands::get_terminal_settings,
            commands::save_terminal_settings,
            commands::get_sidebar_settings,
            commands::list_monospace_families,
            commands::load_font_family,
            commands::open_in_editor,
            commands::reveal_in_finder,
            commands::spawn_pty,
            commands::write_pty,
            commands::update_pty_color_theme,
            commands::resize_pty,
            commands::kill_pty,
            commands::spawn_assistant_session,
            commands::resume_assistant_session,
            commands::prepare_assistant_session,
            commands::confirm_assistant_session_capture,
            commands::try_capture_codex_assistant_session,
            commands::fail_assistant_session_capture,
            commands::update_assistant_session_placement,
            commands::update_assistant_session_label,
            commands::discard_assistant_session,
            commands::rearm_assistant_session,
            commands::list_restorable_assistant_sessions,
            commands::take_assistant_session_startup_warning,
            commands::begin_assistant_session_preserving_shutdown,
            commands::get_pty_session_count,
            commands::shutdown_and_quit,
            commands::get_username,
            commands::get_home_directory,
            commands::get_default_shell,
            commands::get_computer_name,
            commands::check_command_exists,
            commands::get_usage_settings,
            commands::save_usage_settings,
            commands::get_all_usage_snapshots,
            commands::get_usage_snapshot,
            commands::get_usage_details,
            commands::get_usage_overview,
            commands::get_project_alias_review_queue,
            commands::get_models_for_provider,
            commands::refresh_usage_data,
            commands::get_memory_stats,
            commands::watch_repo,
            commands::unwatch_repo,
            commands::open_url,
            commands::get_pi_config,
            commands::save_pi_settings,
            commands::save_pi_api_key,
            commands::delete_pi_api_key,
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
