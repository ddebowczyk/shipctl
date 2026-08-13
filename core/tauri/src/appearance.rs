use shipctl_core::appearance::fonts::{self, FontFaceData, FontFamily};

#[tauri::command]
pub fn list_monospace_families() -> Vec<FontFamily> {
    fonts::list_monospace_families()
}

#[tauri::command]
pub async fn load_font_family(family: String) -> Vec<FontFaceData> {
    // Font file reads can total 10+ MB for a large family. Run on the blocking
    // thread pool so the Tauri runtime isn't stalled.
    tauri::async_runtime::spawn_blocking(move || fonts::load_font_family(&family))
        .await
        .unwrap_or_default()
}
