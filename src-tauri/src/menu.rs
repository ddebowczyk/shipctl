//! Tauri rendering for the host-owned static native-menu model.

use std::collections::HashSet;

use shipctl_core::menu::{
    compile_native_menu, NativeMenuCompileInput, NativeMenuEntry, NativeMenuModel, NativeMenuRole,
    NativeMenuSection, NativeMenuSectionId, NativeMenuSubmenu,
};
use tauri::menu::{
    AboutMetadata, AboutMetadataBuilder, MenuBuilder, MenuItem, Submenu, SubmenuBuilder,
    HELP_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Wry};

use crate::build_info::BUILD_ID;

pub fn setup(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let model = compile_native_menu(NativeMenuCompileInput {
        semantic_terminal_available: crate::modules::semantic_terminal_available(),
        contributions: crate::modules::native_menu_contributions(),
    })
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    let menu = build_menu(app, &model, app.config().version.clone())?;
    let command_ids = model
        .command_ids()
        .map(str::to_owned)
        .collect::<HashSet<_>>();

    app.set_menu(menu)?;
    app.on_menu_event(move |handle, event| {
        let id = event.id().as_ref();
        if command_ids.contains(id) {
            let _ = handle.emit("menu-event", id);
        }
    });

    Ok(())
}

fn build_menu(
    app: &AppHandle<Wry>,
    model: &NativeMenuModel,
    version: Option<String>,
) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let mut builder = MenuBuilder::new(app);
    for section in &model.sections {
        let submenu = build_submenu(app, section, &version)?;
        builder = builder.item(&submenu);
    }
    builder.build()
}

fn build_submenu(
    app: &AppHandle<Wry>,
    section: &NativeMenuSection,
    version: &Option<String>,
) -> tauri::Result<Submenu<Wry>> {
    let mut builder = SubmenuBuilder::with_id(app, section_identifier(section.id), section.label);
    for entry in &section.entries {
        builder = append_entry(builder, app, entry, version)?;
    }
    builder.build()
}

fn section_identifier(id: NativeMenuSectionId) -> &'static str {
    match id {
        NativeMenuSectionId::Help => HELP_SUBMENU_ID,
        _ => id.identifier(),
    }
}

fn append_entry<'a>(
    builder: SubmenuBuilder<'a, Wry, AppHandle<Wry>>,
    app: &'a AppHandle<Wry>,
    entry: &NativeMenuEntry,
    version: &Option<String>,
) -> tauri::Result<SubmenuBuilder<'a, Wry, AppHandle<Wry>>> {
    match entry {
        NativeMenuEntry::Separator => Ok(builder.separator()),
        NativeMenuEntry::Command(command) => {
            let item = MenuItem::with_id(
                app,
                command.id.as_str(),
                command.label.as_str(),
                true,
                command.accelerator.as_deref(),
            )?;
            Ok(builder.item(&item))
        }
        NativeMenuEntry::Submenu(submenu) => {
            let submenu = build_nested_submenu(app, submenu, version)?;
            Ok(builder.item(&submenu))
        }
        NativeMenuEntry::Role(role) => append_role(builder, *role, version),
    }
}

fn build_nested_submenu(
    app: &AppHandle<Wry>,
    submenu: &NativeMenuSubmenu,
    version: &Option<String>,
) -> tauri::Result<Submenu<Wry>> {
    let mut builder = SubmenuBuilder::with_id(app, submenu.id.as_str(), submenu.label.as_str());
    for entry in &submenu.entries {
        builder = append_entry(builder, app, entry, version)?;
    }
    builder.build()
}

fn append_role<'a>(
    builder: SubmenuBuilder<'a, Wry, AppHandle<Wry>>,
    role: NativeMenuRole,
    version: &Option<String>,
) -> tauri::Result<SubmenuBuilder<'a, Wry, AppHandle<Wry>>> {
    Ok(match role {
        NativeMenuRole::About => builder.about(Some(about_metadata(version.clone()))),
        NativeMenuRole::Services => builder.services(),
        NativeMenuRole::Hide => builder.hide(),
        NativeMenuRole::HideOthers => builder.hide_others(),
        NativeMenuRole::ShowAll => builder.show_all(),
        NativeMenuRole::Quit => builder.quit(),
        NativeMenuRole::CloseWindow => builder.close_window(),
        NativeMenuRole::Undo => builder.undo(),
        NativeMenuRole::Redo => builder.redo(),
        NativeMenuRole::Cut => builder.cut(),
        NativeMenuRole::Copy => builder.copy(),
        NativeMenuRole::Paste => builder.paste(),
        NativeMenuRole::SelectAll => builder.select_all(),
        NativeMenuRole::Fullscreen => builder.fullscreen(),
        NativeMenuRole::Minimize => builder.minimize(),
        NativeMenuRole::Maximize => builder.maximize(),
    })
}

fn about_metadata(version: Option<String>) -> AboutMetadata<'static> {
    AboutMetadataBuilder::new()
        .version(version)
        .short_version(Some(format!("Build ID: {BUILD_ID}")))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_metadata_shows_product_version_and_build_id() {
        let metadata = about_metadata(Some("0.1.0".into()));

        assert_eq!(metadata.version.as_deref(), Some("0.1.0"));
        assert_eq!(
            metadata.short_version,
            Some(format!("Build ID: {BUILD_ID}"))
        );
    }

    #[test]
    fn help_keeps_tauris_reserved_menu_identifier() {
        assert_eq!(
            section_identifier(NativeMenuSectionId::Help),
            HELP_SUBMENU_ID
        );
    }
}
