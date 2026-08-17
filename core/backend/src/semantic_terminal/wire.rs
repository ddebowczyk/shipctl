//! Compact, lossless semantic screen snapshots for transport.
//!
//! `projection` is the host model read from Ghostty. This module is only the
//! wire shape. It groups adjacent cells with the same paint facts, but keeps
//! one glyph string per host cell. The receiver therefore does not have to
//! recover grapheme or wide-cell boundaries from joined text.

use serde::{Deserialize, Serialize};

use super::projection::{
    ProjectedCell, ProjectedColor, ProjectedColors, ProjectedCursor, ProjectedDamage,
    ProjectedDamageScope, ProjectedModes, ProjectedPrompt, ProjectedRow, ProjectedScreen,
    ProjectedWidth, TerminalProjection,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreenSnapshot {
    pub columns: u16,
    pub rows: u16,
    pub screen: ProjectedScreen,
    pub scrollback_rows: usize,
    pub cursor: ProjectedCursor,
    pub modes: ProjectedModes,
    pub colors: ProjectedColors,
    pub damage: ProjectedDamage,
    pub viewport: Vec<ProjectedRunRow>,
    /// Attachment presentation state, separate from the canonical row runs.
    pub selection: Vec<ProjectedSelectionRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRunRow {
    pub wrapped: bool,
    pub continuation: bool,
    pub prompt: ProjectedPrompt,
    pub runs: Vec<ProjectedRun>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRun {
    /// Exactly one entry per host cell. Joining these strings is not lossless.
    pub glyphs: Vec<String>,
    pub width: ProjectedWidth,
    pub bold: bool,
    pub foreground: Option<ProjectedColor>,
    pub background: Option<ProjectedColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hyperlink: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedSelectionRow {
    pub row: u16,
    pub spans: Vec<ProjectedSelectionSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedSelectionSpan {
    pub start: u16,
    pub end: u16,
}

impl TerminalScreenSnapshot {
    pub fn from_projection(projection: TerminalProjection) -> Self {
        let mut selection = Vec::new();
        let viewport = projection
            .viewport
            .into_iter()
            .enumerate()
            .map(|(row, projected)| {
                let spans = selection_spans(&projected.cells);
                if !spans.is_empty() {
                    selection.push(ProjectedSelectionRow {
                        row: u16::try_from(row).expect("a terminal row fits in u16"),
                        spans,
                    });
                }
                ProjectedRunRow::from_row(projected)
            })
            .collect();

        Self {
            columns: projection.columns,
            rows: projection.rows,
            screen: projection.screen,
            scrollback_rows: projection.scrollback_rows,
            cursor: projection.cursor,
            modes: projection.modes,
            colors: projection.colors,
            damage: projection.damage,
            viewport,
            selection,
        }
    }

    /// The same screen, with every viewport row named as changed.
    ///
    /// Damage is a difference, and the host can report it once. An attachment
    /// that never received the state the difference was measured from cannot
    /// use it: rows changed in the states it missed are not named there.
    pub fn repainted(&self) -> Self {
        Self {
            damage: ProjectedDamage {
                scope: ProjectedDamageScope::Full,
                rows: Vec::new(),
            },
            ..self.clone()
        }
    }
}

impl ProjectedRunRow {
    fn from_row(row: ProjectedRow) -> Self {
        let mut runs: Vec<ProjectedRun> = Vec::new();
        for cell in row.cells {
            match runs.last_mut() {
                Some(run) if run.accepts(&cell) => run.glyphs.push(cell.text),
                _ => runs.push(ProjectedRun::from_cell(cell)),
            }
        }
        Self {
            wrapped: row.wrapped,
            continuation: row.continuation,
            prompt: row.prompt,
            runs,
        }
    }

    /// Presented row text, for CLI readers and diagnostics. Cell boundaries
    /// remain available through `glyphs`.
    pub fn text(&self) -> String {
        self.runs
            .iter()
            .flat_map(|run| run.glyphs.iter())
            .cloned()
            .collect()
    }
}

impl ProjectedRun {
    fn from_cell(cell: ProjectedCell) -> Self {
        Self {
            glyphs: vec![cell.text],
            width: cell.width,
            bold: cell.bold,
            foreground: cell.foreground,
            background: cell.background,
            hyperlink: cell.hyperlink,
        }
    }

    fn accepts(&self, cell: &ProjectedCell) -> bool {
        self.width == cell.width
            && self.bold == cell.bold
            && self.foreground == cell.foreground
            && self.background == cell.background
            && self.hyperlink == cell.hyperlink
    }
}

fn selection_spans(cells: &[ProjectedCell]) -> Vec<ProjectedSelectionSpan> {
    let mut spans = Vec::new();
    let mut start = None;
    for (column, cell) in cells.iter().enumerate() {
        match (start, cell.selected) {
            (None, true) => start = Some(column),
            (Some(from), false) => {
                spans.push(ProjectedSelectionSpan {
                    start: u16::try_from(from).expect("a terminal column fits in u16"),
                    end: u16::try_from(column).expect("a terminal column fits in u16"),
                });
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        spans.push(ProjectedSelectionSpan {
            start: u16::try_from(from).expect("a terminal column fits in u16"),
            end: u16::try_from(cells.len()).expect("a terminal column fits in u16"),
        });
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic_terminal::projection::{
        ProjectedColors, ProjectedCursorShape, ProjectedDamageScope,
    };

    fn cell(text: &str, width: ProjectedWidth, selected: bool) -> ProjectedCell {
        ProjectedCell {
            text: text.to_string(),
            width,
            bold: false,
            foreground: None,
            background: None,
            selected,
            hyperlink: None,
        }
    }

    #[test]
    fn runs_keep_one_glyph_per_host_cell_and_selection_is_an_overlay() {
        let projection = TerminalProjection {
            columns: 4,
            rows: 1,
            screen: ProjectedScreen::Primary,
            scrollback_rows: 0,
            cursor: ProjectedCursor {
                column: 0,
                row: 0,
                visible: true,
                pending_wrap: false,
                shape: ProjectedCursorShape::Block,
                blinking: false,
            },
            modes: ProjectedModes {
                wraparound: true,
                bracketed_paste: false,
                application_cursor_keys: false,
                application_keypad: false,
                focus_events: false,
                mouse_tracking: false,
                insert: false,
                reverse_video: false,
                origin: false,
            },
            colors: ProjectedColors {
                foreground: None,
                background: None,
                palette: Vec::new(),
            },
            damage: ProjectedDamage {
                scope: ProjectedDamageScope::Full,
                rows: vec![0],
            },
            viewport: vec![ProjectedRow {
                wrapped: false,
                continuation: false,
                prompt: ProjectedPrompt::None,
                cells: vec![
                    cell("a", ProjectedWidth::Narrow, false),
                    cell("e\u{301}", ProjectedWidth::Narrow, true),
                    cell("漢", ProjectedWidth::Wide, true),
                    cell("", ProjectedWidth::SpacerTail, false),
                ],
            }],
        };

        let snapshot = TerminalScreenSnapshot::from_projection(projection);
        assert_eq!(snapshot.viewport[0].runs[0].glyphs, ["a", "e\u{301}"]);
        assert_eq!(snapshot.viewport[0].runs[1].glyphs, ["漢"]);
        assert_eq!(snapshot.viewport[0].runs[2].glyphs, [""]);
        assert_eq!(
            snapshot.selection,
            [ProjectedSelectionRow {
                row: 0,
                spans: vec![ProjectedSelectionSpan { start: 1, end: 3 }],
            }]
        );
    }
}
