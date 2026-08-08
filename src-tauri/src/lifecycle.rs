//! Application lifecycle. `shutdown_and_quit` spans the terminal capability,
//! the projects watcher and the Tauri app handle at once, so it belongs to the
//! shell that composes them rather than to any one capability.

use shipctl_core::instance::{ActiveWorkBlocker, ControlError, ControlHandler};
use shipctl_core::projects::watcher::GitWatcher;
use shipctl_core::state::archive::{StateArchiveInspection, StateArchiveService};
use shipctl_core::terminal::manager::PtyManager;
use std::path::Path;
use tauri::Manager;

pub struct TauriControlHandler {
    app: tauri::AppHandle,
}

impl TauriControlHandler {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ControlHandler for TauriControlHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        let count = self.app.state::<PtyManager>().session_count();
        if count == 0 {
            Vec::new()
        } else {
            vec![ActiveWorkBlocker {
                kind: "pty_sessions".to_string(),
                count,
                message: "Running terminal sessions require an explicit forced stop".to_string(),
            }]
        }
    }

    fn state_fingerprint(&self) -> Result<Option<String>, ControlError> {
        self.app
            .state::<StateArchiveService>()
            .fingerprint_current()
            .map(Some)
    }

    fn save_state(&self, destination: &Path) -> Result<StateArchiveInspection, ControlError> {
        self.app.state::<StateArchiveService>().save(destination)
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        perform_shutdown(&self.app);
        Ok(())
    }
}

fn perform_shutdown(app: &tauri::AppHandle) {
    let pty_manager = app.state::<PtyManager>();
    if !pty_manager.begin_shutdown() {
        return;
    }
    app.state::<GitWatcher>().shutdown();
    pty_manager.kill_all();
    app.exit(0);
}

#[tauri::command]
pub fn shutdown_and_quit(app: tauri::AppHandle) -> Result<(), String> {
    perform_shutdown(&app);
    Ok(())
}
