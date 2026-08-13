use tauri::State;

use shipctl_core::workspace::config::CanvasAdapter;
use shipctl_core::workspace::manager::WorkspaceManager;

/// Returns the adapter fixed for this browser bootstrap. The frontend reads it
/// before mounting the shell, so a config edit cannot replace a live terminal
/// canvas.
#[tauri::command]
pub fn get_canvas_adapter(workspace: State<'_, WorkspaceManager>) -> Result<CanvasAdapter, String> {
    let adapter = workspace.load_canvas_adapter()?;
    log::info!(
        target: "shipctl::canvas",
        "Canvas adapter selected for this application instance: {}; changes to ui.canvas take effect after restart.",
        adapter.as_str(),
    );
    Ok(adapter)
}
