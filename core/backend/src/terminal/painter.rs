//! The CLI half of area 04: semantic state painted as local terminal output.
//!
//! A painter is presentation only. Its whole input is what the host believes —
//! a [`TerminalProjection`] and the ordered [`TerminalEffect`]s that came with
//! it — and its whole output is what a caller's terminal must be told to show
//! that. It never sees the child's bytes, so nothing it emits can be a replay
//! of them, and it never measures text, so it is not a second authority on how
//! many columns a grapheme takes.
//!
//! Two rules keep it presentation:
//!
//! - Column occupancy comes from [`ProjectedWidth`] and nothing else.
//! - Facts the child asked the *host* for — prompt marks, bracketed paste,
//!   application cursor keys, the alternate screen — stay in the model. The
//!   caller's terminal is shown a picture, never given a mode to interpret.
//!
//! Each frame paints the whole viewport. Damage tells a renderer that keeps a
//! surface what changed; a stream of control sequences keeps nothing, and a
//! painter that trusted damage would depend on the caller's terminal holding
//! the previous frame exactly as the host projected it.
//!
//! `paint_probe` is this module's falsification probe: it replays the recorded
//! corpus through this painter and reads the result back with a fresh host
//! parser standing in for the caller's terminal.

use super::effects::TerminalEffect;
use super::projection::TerminalProjection;
use super::projection::{ProjectedCell, ProjectedColor, ProjectedRow, ProjectedWidth};
use super::wire::{ProjectedRun, ProjectedRunRow, TerminalScreenSnapshot};

/// Where the painter gets column occupancy from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Occupancy {
    /// From the host cell that claims the column. The only rule this ships.
    HostSupplied,
    /// From the painter's own idea of how wide a grapheme is: the mutation the
    /// parity probe must reject, and the shape of every frontend `wcwidth`.
    #[cfg(test)]
    PainterDecides,
}

/// The style currently installed on the caller's terminal, so the painter emits
/// a change rather than a full description per cell.
#[derive(Debug, Default, PartialEq, Eq)]
struct PaintedStyle {
    bold: bool,
    foreground: Option<ProjectedColor>,
    background: Option<ProjectedColor>,
    hyperlink: Option<String>,
}

/// Paint one frame of host state for the caller's terminal.
pub fn paint(projection: &TerminalProjection) -> Vec<u8> {
    paint_with(projection, Occupancy::HostSupplied)
}

/// Paint the compact wire shape without reconstructing a second terminal
/// model. Cell occupancy stays explicit in each run.
pub fn paint_snapshot(snapshot: &TerminalScreenSnapshot) -> Vec<u8> {
    let mut out = Vec::new();
    let mut style = PaintedStyle::default();
    out.extend_from_slice(b"\x1b[0m\x1b[2J");

    let mut row = 0;
    while row < snapshot.viewport.len() {
        out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        loop {
            paint_run_row(&mut out, &mut style, &snapshot.viewport[row]);
            let flows = snapshot.viewport[row].wrapped
                && snapshot
                    .viewport
                    .get(row + 1)
                    .is_some_and(|next| next.continuation);
            if !flows {
                break;
            }
            row += 1;
        }
        row += 1;
    }

    finish_frame(&mut out, &mut style, snapshot.cursor);
    out
}

/// Paint the occurrences that came with a frame, in the order the host sent
/// them.
///
/// A bell and a title are things a viewer shows. A clipboard write and a
/// working-directory report are not: they act on the caller's machine and on
/// the caller's own shell rather than showing what the host holds, so a viewer
/// of someone else's terminal does not perform them.
pub fn paint_effects(effects: &[TerminalEffect]) -> Vec<u8> {
    let mut out = Vec::new();
    for effect in effects {
        match effect {
            TerminalEffect::Bell => out.push(0x07),
            TerminalEffect::Title { title } => {
                out.extend_from_slice(format!("\x1b]0;{title}\x1b\\").as_bytes());
            }
            TerminalEffect::WorkingDirectory { .. } | TerminalEffect::Clipboard { .. } => {}
        }
    }
    out
}

/// Turns what the host believes into what a terminal must be told to show it.
///
/// Rows that the host reports as wrapped are painted as one run, so the
/// caller's terminal reaches the same wrap state by wrapping rather than by
/// being told where each row starts.
pub(super) fn paint_with(projection: &TerminalProjection, occupancy: Occupancy) -> Vec<u8> {
    let mut out = Vec::new();
    let mut style = PaintedStyle::default();
    out.extend_from_slice(b"\x1b[0m\x1b[2J");

    let viewport = &projection.viewport;
    let mut row = 0;
    while row < viewport.len() {
        out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        loop {
            paint_row(&mut out, &mut style, &viewport[row], occupancy);
            let flows = viewport[row].wrapped
                && viewport.get(row + 1).is_some_and(|next| next.continuation);
            if !flows {
                break;
            }
            row += 1;
        }
        row += 1;
    }

    finish_frame(&mut out, &mut style, projection.cursor);
    out
}

fn finish_frame(
    out: &mut Vec<u8>,
    style: &mut PaintedStyle,
    cursor: super::projection::ProjectedCursor,
) {
    set_style(out, style, &PaintedStyle::default());
    out.extend_from_slice(format!("\x1b[{};{}H", cursor.row + 1, cursor.column + 1).as_bytes());
    out.extend_from_slice(if cursor.visible {
        b"\x1b[?25h"
    } else {
        b"\x1b[?25l"
    });
}

fn paint_row(
    out: &mut Vec<u8>,
    style: &mut PaintedStyle,
    row: &ProjectedRow,
    occupancy: Occupancy,
) {
    for cell in &row.cells {
        if cell.width == ProjectedWidth::SpacerTail {
            // The wide grapheme beside it already claimed this column.
            if occupancy == Occupancy::HostSupplied {
                continue;
            }
        }
        set_style(out, style, &cell_style(cell));
        out.extend_from_slice(glyph(cell).as_bytes());
    }
}

fn paint_run_row(out: &mut Vec<u8>, style: &mut PaintedStyle, row: &ProjectedRunRow) {
    for run in &row.runs {
        paint_run(out, style, run);
    }
}

fn paint_run(out: &mut Vec<u8>, style: &mut PaintedStyle, run: &ProjectedRun) {
    if run.width == ProjectedWidth::SpacerTail {
        return;
    }
    set_style(
        out,
        style,
        &PaintedStyle {
            bold: run.bold,
            foreground: run.foreground,
            background: run.background,
            hyperlink: run.hyperlink.clone(),
        },
    );
    for glyph in &run.glyphs {
        out.extend_from_slice(if glyph.is_empty() {
            b" "
        } else {
            glyph.as_bytes()
        });
    }
}

fn cell_style(cell: &ProjectedCell) -> PaintedStyle {
    PaintedStyle {
        bold: cell.bold,
        foreground: cell.foreground,
        background: cell.background,
        hyperlink: cell.hyperlink.clone(),
    }
}

/// What a cell puts on the screen. An erased cell and a written space present
/// the same picture, so the painter writes a space for both.
pub(super) fn glyph(cell: &ProjectedCell) -> &str {
    if cell.text.is_empty() {
        " "
    } else {
        cell.text.as_str()
    }
}

fn set_style(out: &mut Vec<u8>, current: &mut PaintedStyle, wanted: &PaintedStyle) {
    let mut params: Vec<String> = Vec::new();
    if current.bold != wanted.bold {
        params.push(if wanted.bold { "1" } else { "22" }.to_string());
    }
    if current.foreground != wanted.foreground {
        params.push(match wanted.foreground {
            Some(color) => format!("38;2;{};{};{}", color.r, color.g, color.b),
            None => "39".to_string(),
        });
    }
    if current.background != wanted.background {
        params.push(match wanted.background {
            Some(color) => format!("48;2;{};{};{}", color.r, color.g, color.b),
            None => "49".to_string(),
        });
    }
    if !params.is_empty() {
        out.extend_from_slice(format!("\x1b[{}m", params.join(";")).as_bytes());
    }
    if current.hyperlink != wanted.hyperlink {
        let uri = wanted.hyperlink.clone().unwrap_or_default();
        out.extend_from_slice(format!("\x1b]8;;{uri}\x1b\\").as_bytes());
    }
    current.bold = wanted.bold;
    current.foreground = wanted.foreground;
    current.background = wanted.background;
    current.hyperlink = wanted.hyperlink.clone();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::effects::{TerminalClipboardContent, TerminalClipboardLocation};

    #[test]
    fn occurrences_that_show_something_are_painted_and_the_rest_are_not() {
        let painted = paint_effects(&[
            TerminalEffect::Bell,
            TerminalEffect::Title {
                title: "shipctl".to_string(),
            },
        ]);
        assert_eq!(painted, b"\x07\x1b]0;shipctl\x1b\\".to_vec());

        let silent = paint_effects(&[
            TerminalEffect::WorkingDirectory {
                uri: "file:///tmp".to_string(),
            },
            TerminalEffect::Clipboard {
                location: TerminalClipboardLocation::Standard,
                contents: vec![TerminalClipboardContent {
                    mime: "text/plain".to_string(),
                    data: "aGk=".to_string(),
                }],
            },
        ]);
        assert!(
            silent.is_empty(),
            "a viewer does not act on the caller's machine on the child's behalf"
        );
    }
}
