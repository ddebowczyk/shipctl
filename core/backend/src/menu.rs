//! Static native-menu compilation.
//!
//! The model in this module has no Tauri types. The bundle shell turns it into
//! platform menu objects after static module composition is complete.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;

/// A fixed host menu slot that a bundled module may target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NativeMenuSlot {
    /// The File menu's new-item group, before the first separator.
    FileNew,
}

/// A trusted, build-time native-menu declaration from a bundled module.
///
/// Runtime artifacts never reach this type. They remain headless until the
/// host has a separate dynamic UI lifecycle contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuContribution {
    pub module_id: String,
    pub command_id: String,
    pub label: String,
    pub accelerator: Option<String>,
    pub slot: NativeMenuSlot,
    pub order: i32,
}

impl NativeMenuContribution {
    pub fn new(
        module_id: impl Into<String>,
        command_id: impl Into<String>,
        label: impl Into<String>,
        accelerator: Option<&str>,
        slot: NativeMenuSlot,
        order: i32,
    ) -> Self {
        Self {
            module_id: module_id.into(),
            command_id: command_id.into(),
            label: label.into(),
            accelerator: accelerator.map(str::to_owned),
            slot,
            order,
        }
    }
}

/// Input facts for one startup menu profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuCompileInput {
    pub semantic_terminal_available: bool,
    pub contributions: Vec<NativeMenuContribution>,
}

/// A framework-independent menu model rendered by the Tauri bundle shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuModel {
    pub sections: Vec<NativeMenuSection>,
}

impl NativeMenuModel {
    pub fn command_ids(&self) -> impl Iterator<Item = &str> {
        self.sections
            .iter()
            .flat_map(|section| section.entries.iter())
            .filter_map(|entry| match entry {
                NativeMenuEntry::Command(command) => Some(command.id.as_str()),
                NativeMenuEntry::Role(_) | NativeMenuEntry::Separator => None,
            })
    }

    pub fn section(&self, id: NativeMenuSectionId) -> Option<&NativeMenuSection> {
        self.sections.iter().find(|section| section.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuSection {
    pub id: NativeMenuSectionId,
    pub label: &'static str,
    pub entries: Vec<NativeMenuEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeMenuSectionId {
    App,
    File,
    Edit,
    View,
    Window,
    Help,
}

impl NativeMenuSectionId {
    pub const fn identifier(self) -> &'static str {
        match self {
            Self::App => "shipctl.app",
            Self::File => "shipctl.file",
            Self::Edit => "shipctl.edit",
            Self::View => "shipctl.view",
            Self::Window => "shipctl.window",
            Self::Help => "shipctl.help",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeMenuEntry {
    Command(NativeMenuCommand),
    Separator,
    Role(NativeMenuRole),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuCommand {
    pub id: String,
    pub label: String,
    pub accelerator: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeMenuRole {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuCompileError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for NativeMenuCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for NativeMenuCompileError {}

/// Compile a deterministic, static startup menu profile.
pub fn compile_native_menu(
    input: NativeMenuCompileInput,
) -> Result<NativeMenuModel, NativeMenuCompileError> {
    let mut command_ids = core_command_ids(input.semantic_terminal_available);
    let mut file_entries = Vec::new();

    if input.semantic_terminal_available {
        file_entries.push(command(
            "terminal.new-semantic",
            "New Semantic Terminal",
            Some("CmdOrCtrl+T"),
        ));
    }
    file_entries.push(command(
        "terminal.new-thin",
        "New Thin Terminal",
        Some("CmdOrCtrl+Alt+T"),
    ));
    file_entries.push(command(
        "core.new-session",
        "New Session",
        Some("CmdOrCtrl+Shift+T"),
    ));

    let mut contributions = input.contributions;
    contributions.sort_by(|left, right| {
        (left.slot, left.order, &left.module_id, &left.command_id).cmp(&(
            right.slot,
            right.order,
            &right.module_id,
            &right.command_id,
        ))
    });
    for contribution in contributions {
        validate_contribution(&contribution)?;
        if !command_ids.insert(contribution.command_id.clone()) {
            return Err(NativeMenuCompileError {
                code: "menu.duplicate_command_id",
                message: format!(
                    "Command {} is declared more than once",
                    contribution.command_id
                ),
            });
        }
        match contribution.slot {
            NativeMenuSlot::FileNew => {
                file_entries.push(NativeMenuEntry::Command(NativeMenuCommand {
                    id: contribution.command_id,
                    label: contribution.label,
                    accelerator: contribution.accelerator,
                }))
            }
        }
    }
    file_entries.extend([
        NativeMenuEntry::Separator,
        command("core.open-in-editor", "Open in Editor", Some("CmdOrCtrl+E")),
        NativeMenuEntry::Separator,
        NativeMenuEntry::Role(NativeMenuRole::CloseWindow),
    ]);

    Ok(NativeMenuModel {
        sections: vec![
            NativeMenuSection {
                id: NativeMenuSectionId::App,
                label: "Shipctl",
                entries: vec![
                    NativeMenuEntry::Role(NativeMenuRole::About),
                    NativeMenuEntry::Separator,
                    command("core.settings", "Settings…", Some("CmdOrCtrl+,")),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::Services),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::Hide),
                    NativeMenuEntry::Role(NativeMenuRole::HideOthers),
                    NativeMenuEntry::Role(NativeMenuRole::ShowAll),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::Quit),
                ],
            },
            NativeMenuSection {
                id: NativeMenuSectionId::File,
                label: "File",
                entries: file_entries,
            },
            NativeMenuSection {
                id: NativeMenuSectionId::Edit,
                label: "Edit",
                entries: vec![
                    NativeMenuEntry::Role(NativeMenuRole::Undo),
                    NativeMenuEntry::Role(NativeMenuRole::Redo),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::Cut),
                    NativeMenuEntry::Role(NativeMenuRole::Copy),
                    NativeMenuEntry::Role(NativeMenuRole::Paste),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::SelectAll),
                ],
            },
            NativeMenuSection {
                id: NativeMenuSectionId::View,
                label: "View",
                entries: vec![
                    command("core.next-tab", "Next Tab", Some("CmdOrCtrl+Tab")),
                    command(
                        "core.previous-tab",
                        "Previous Tab",
                        Some("CmdOrCtrl+Shift+Tab"),
                    ),
                    NativeMenuEntry::Separator,
                    command("core.toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B")),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::Fullscreen),
                ],
            },
            NativeMenuSection {
                id: NativeMenuSectionId::Window,
                label: "Window",
                entries: vec![
                    NativeMenuEntry::Role(NativeMenuRole::Minimize),
                    NativeMenuEntry::Role(NativeMenuRole::Maximize),
                    NativeMenuEntry::Separator,
                    NativeMenuEntry::Role(NativeMenuRole::CloseWindow),
                ],
            },
            NativeMenuSection {
                id: NativeMenuSectionId::Help,
                label: "Help",
                entries: Vec::new(),
            },
        ],
    })
}

fn command(
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
) -> NativeMenuEntry {
    NativeMenuEntry::Command(NativeMenuCommand {
        id: id.to_string(),
        label: label.to_string(),
        accelerator: accelerator.map(ToString::to_string),
    })
}

fn core_command_ids(semantic_terminal_available: bool) -> BTreeSet<String> {
    [
        semantic_terminal_available.then_some("terminal.new-semantic"),
        Some("terminal.new-thin"),
        Some("core.new-session"),
        Some("core.open-in-editor"),
        Some("core.settings"),
        Some("core.next-tab"),
        Some("core.previous-tab"),
        Some("core.toggle-sidebar"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_owned)
    .collect()
}

fn validate_contribution(
    contribution: &NativeMenuContribution,
) -> Result<(), NativeMenuCompileError> {
    if !is_stable_dotted_id(&contribution.module_id) {
        return Err(NativeMenuCompileError {
            code: "menu.invalid_module_id",
            message: format!(
                "Module {} must use a stable dotted identifier",
                contribution.module_id
            ),
        });
    }
    if !is_stable_dotted_id(&contribution.command_id) {
        return Err(NativeMenuCompileError {
            code: "menu.invalid_command_id",
            message: format!(
                "Command {} must use a stable dotted identifier",
                contribution.command_id
            ),
        });
    }
    if contribution.label.trim().is_empty() {
        return Err(NativeMenuCompileError {
            code: "menu.invalid_label",
            message: format!("Command {} must have a label", contribution.command_id),
        });
    }
    if contribution
        .accelerator
        .as_deref()
        .is_some_and(|accelerator| accelerator.trim().is_empty())
    {
        return Err(NativeMenuCompileError {
            code: "menu.invalid_accelerator",
            message: format!(
                "Command {} has an empty accelerator",
                contribution.command_id
            ),
        });
    }
    Ok(())
}

fn is_stable_dotted_id(value: &str) -> bool {
    let mut segments = value.split('.');
    let mut count = 0;
    for segment in &mut segments {
        count += 1;
        if segment.split('-').any(|part| {
            part.is_empty()
                || part
                    .bytes()
                    .any(|byte| !(byte.is_ascii_lowercase() || byte.is_ascii_digit()))
        }) {
            return false;
        }
    }
    count >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contribution(command_id: &str, order: i32) -> NativeMenuContribution {
        NativeMenuContribution::new(
            "shipctl.commands",
            command_id,
            "New Commands Panel",
            Some("CmdOrCtrl+Shift+C"),
            NativeMenuSlot::FileNew,
            order,
        )
    }

    fn file_command_ids(menu: &NativeMenuModel) -> Vec<&str> {
        menu.section(NativeMenuSectionId::File)
            .unwrap()
            .entries
            .iter()
            .filter_map(|entry| match entry {
                NativeMenuEntry::Command(command) => Some(command.id.as_str()),
                NativeMenuEntry::Role(_) | NativeMenuEntry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn compiles_static_module_commands_into_the_file_new_group() {
        let menu = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: true,
            contributions: vec![contribution("commands.open-panel", 20)],
        })
        .unwrap();

        assert_eq!(
            file_command_ids(&menu),
            vec![
                "terminal.new-semantic",
                "terminal.new-thin",
                "core.new-session",
                "commands.open-panel",
                "core.open-in-editor",
            ]
        );
        assert_eq!(
            menu.command_ids().collect::<Vec<_>>(),
            vec![
                "core.settings",
                "terminal.new-semantic",
                "terminal.new-thin",
                "core.new-session",
                "commands.open-panel",
                "core.open-in-editor",
                "core.next-tab",
                "core.previous-tab",
                "core.toggle-sidebar",
            ]
        );
    }

    #[test]
    fn omits_semantic_terminal_when_the_static_profile_does_not_ship_it() {
        let menu = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: false,
            contributions: Vec::new(),
        })
        .unwrap();

        assert_eq!(
            file_command_ids(&menu),
            vec![
                "terminal.new-thin",
                "core.new-session",
                "core.open-in-editor"
            ]
        );
    }

    #[test]
    fn orders_module_items_deterministically() {
        let menu = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: true,
            contributions: vec![
                contribution("commands.second", 20),
                contribution("commands.first", 10),
            ],
        })
        .unwrap();

        assert_eq!(
            file_command_ids(&menu),
            vec![
                "terminal.new-semantic",
                "terminal.new-thin",
                "core.new-session",
                "commands.first",
                "commands.second",
                "core.open-in-editor",
            ]
        );
    }

    #[test]
    fn rejects_duplicate_or_invalid_module_menu_declarations() {
        let duplicate = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: true,
            contributions: vec![
                contribution("commands.open-panel", 10),
                contribution("commands.open-panel", 20),
            ],
        })
        .unwrap_err();
        assert_eq!(duplicate.code, "menu.duplicate_command_id");

        let invalid = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: true,
            contributions: vec![contribution("Commands.Open", 10)],
        })
        .unwrap_err();
        assert_eq!(invalid.code, "menu.invalid_command_id");

        let core_collision = compile_native_menu(NativeMenuCompileInput {
            semantic_terminal_available: true,
            contributions: vec![contribution("core.settings", 10)],
        })
        .unwrap_err();
        assert_eq!(core_collision.code, "menu.duplicate_command_id");
    }
}
