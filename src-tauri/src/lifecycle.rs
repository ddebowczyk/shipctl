//! Application lifecycle. `shutdown_and_quit` spans the terminal capability,
//! the projects watcher and the Tauri app handle at once, so it belongs to the
//! shell that composes them rather than to any one capability.

use shep_core::projects::watcher::GitWatcher;
use shep_core::terminal::manager::PtyManager;
use tauri::State;

#[tauri::command]
pub fn shutdown_and_quit(
    app: tauri::AppHandle,
    pty_manager: State<'_, PtyManager>,
    watcher: State<'_, GitWatcher>,
) -> Result<(), String> {
    if !pty_manager.begin_shutdown() {
        return Ok(());
    }
    watcher.shutdown();
    pty_manager.kill_all();
    app.exit(0);
    Ok(())
}
