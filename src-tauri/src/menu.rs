use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItem, SubmenuBuilder, HELP_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Wry};

pub fn setup(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let version = app.config().version.clone();

    // -- App (Shipctl) submenu --
    let about_meta = AboutMetadataBuilder::new().version(version).build();
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let app_menu = SubmenuBuilder::new(app, "Shipctl")
        .about(Some(about_meta))
        .separator()
        .item(&check_updates)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // -- File --
    let new_terminal = MenuItem::with_id(
        app,
        "new_terminal",
        "New Terminal",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let new_session = MenuItem::with_id(
        app,
        "new_session",
        "New Session",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let new_commands = MenuItem::with_id(
        app,
        "new_commands",
        "New Commands Panel",
        true,
        Some("CmdOrCtrl+Shift+C"),
    )?;
    let open_in_editor = MenuItem::with_id(
        app,
        "open_in_editor",
        "Open in Editor",
        true,
        Some("CmdOrCtrl+E"),
    )?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_terminal)
        .item(&new_session)
        .item(&new_commands)
        .separator()
        .item(&open_in_editor)
        .separator()
        .close_window()
        .build()?;

    // -- Edit --
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;

    // -- View --
    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle_sidebar",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let next_tab = MenuItem::with_id(app, "next_tab", "Next Tab", true, Some("CmdOrCtrl+Tab"))?;
    let previous_tab = MenuItem::with_id(
        app,
        "previous_tab",
        "Previous Tab",
        true,
        Some("CmdOrCtrl+Shift+Tab"),
    )?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&next_tab)
        .item(&previous_tab)
        .separator()
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()?;

    // -- Window --
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // -- Help --
    let help_menu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help").build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(|handle, event| {
        let id = event.id().as_ref();
        let _ = handle.emit("menu-event", id);
    });

    Ok(())
}
