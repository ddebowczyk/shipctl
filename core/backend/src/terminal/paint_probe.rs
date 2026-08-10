//! Falsification probe: can semantic state alone be presented?
//!
//! Area 04 of `docs/plans/top-5-end-state/` is the only area whose failure
//! invalidates the other four. If a presentation-only adapter cannot paint what
//! the host believes — without the child's bytes and without deciding column
//! occupancy for itself — then the host authority, the protocol and the client
//! model are being built for a surface that cannot ship.
//!
//! This module asks that question of the CLI half, which is the half the
//! existing test lanes can answer today. It paints a [`TerminalProjection`] as
//! local control sequences for a caller's terminal and checks the result
//! against a fresh host parser standing in for that terminal.
//!
//! Three rules keep the probe honest:
//!
//! - The painter's only input is the projection. It never sees the recorded
//!   bytes, so nothing it emits can be a replay of them.
//! - Column occupancy comes from [`ProjectedWidth`] and nothing else. The
//!   painter never measures text, and `paints_by_deciding_width_itself_fails_parity`
//!   proves the parity check notices when it tries.
//! - The stand-in parser is the *reader* of the painted stream, never the
//!   source of a fact. It plays the caller's terminal, which necessarily
//!   interprets a presentation stream; it receives no child output.
//!
//! Tests only. This is evidence about whether area 04 can be built, not the
//! painter that area 04 ships.

use super::projection::{
    ProjectedCell, ProjectedColor, ProjectedRow, ProjectedWidth, TerminalProjection,
};
use super::replay::VtReplayEngine;
use super::retention::TerminalRetentionPolicy;
use super::traces::{self, Trace};

/// Where the painter gets column occupancy from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Occupancy {
    /// From the host cell that claims the column. The rule area 04 requires.
    HostSupplied,
    /// From the painter's own idea of how wide a grapheme is. The mutation the
    /// parity check must reject: it treats every grapheme as one column and
    /// pads the second column of a wide one, which is what a frontend
    /// `wcwidth` would do.
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

fn paint(projection: &TerminalProjection) -> Vec<u8> {
    paint_with(projection, Occupancy::HostSupplied)
}

/// Turns what the host believes into what a terminal must be told to show it.
///
/// Rows that the host reports as wrapped are painted as one run, so the
/// caller's terminal reaches the same wrap state by wrapping rather than by
/// being told where each row starts.
fn paint_with(projection: &TerminalProjection, occupancy: Occupancy) -> Vec<u8> {
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

    set_style(&mut out, &mut style, &PaintedStyle::default());
    out.extend_from_slice(
        format!(
            "\x1b[{};{}H",
            projection.cursor.row + 1,
            projection.cursor.column + 1
        )
        .as_bytes(),
    );
    out.extend_from_slice(if projection.cursor.visible {
        b"\x1b[?25h"
    } else {
        b"\x1b[?25l"
    });
    out
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
fn glyph(cell: &ProjectedCell) -> &str {
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
    use std::fs;

    /// The caller's terminal, played by a parser that never sees child output.
    fn present(trace: &Trace, painted: &[u8]) -> TerminalProjection {
        let mut terminal = VtReplayEngine::new(
            trace.columns,
            trace.rows,
            &traces::corpus_theme(),
            TerminalRetentionPolicy::default(),
        )
        .expect("the corpus geometry is valid");
        terminal.feed(painted);
        terminal
            .project()
            .expect("the stand-in terminal reads its own state")
    }

    fn recorded(trace: &Trace) -> TerminalProjection {
        let bytes = fs::read(traces::bytes_path(trace)).unwrap_or_else(|error| {
            panic!(
                "trace {} is missing its recording ({error}); record it with `cargo test -p shipctl-core --lib terminal::traces::tests::record -- --ignored`",
                trace.name
            )
        });
        traces::replay(trace, &bytes)
    }

    /// The picture a row presents: everything a viewer can see in it, and
    /// nothing that only the host knows.
    ///
    /// Selection is left out because it belongs to the reader, not the picture:
    /// the stand-in terminal has no selection of its own and reports none.
    fn picture(projection: &TerminalProjection) -> Vec<String> {
        projection
            .viewport
            .iter()
            .map(|row| {
                let cells: Vec<String> = row
                    .cells
                    .iter()
                    .map(|cell| {
                        format!(
                            "{}/{:?}/{}/{:?}/{:?}/{:?}",
                            glyph(cell),
                            cell.width,
                            cell.bold,
                            cell.foreground,
                            cell.background,
                            cell.hyperlink
                        )
                    })
                    .collect();
                format!(
                    "wrapped={} continuation={} {}",
                    row.wrapped,
                    row.continuation,
                    cells.join("|")
                )
            })
            .collect()
    }

    /// The claim area 04 rests on, over every recording the host has: a
    /// presentation-only painter reproduces the host's picture from the host's
    /// state, with no access to the bytes that produced it.
    #[test]
    fn every_recorded_state_paints_back_to_the_same_picture() {
        for trace in traces::TRACES {
            let recorded = recorded(trace);
            let presented = present(trace, &paint(&recorded));
            assert_eq!(
                picture(&presented),
                picture(&recorded),
                "trace {} does not present the state the host holds",
                trace.name
            );
            assert_eq!(
                (presented.cursor.column, presented.cursor.row),
                (recorded.cursor.column, recorded.cursor.row),
                "trace {} puts the cursor somewhere else",
                trace.name
            );
            assert_eq!(
                presented.cursor.visible, recorded.cursor.visible,
                "trace {} disagrees about cursor visibility",
                trace.name
            );
        }
    }

    /// The probe's teeth. A painter that decides occupancy for itself — the
    /// shape of every frontend `wcwidth` — moves the columns after a wide
    /// grapheme, and the parity check must refuse it. Without this, the check
    /// above could be passing for reasons other than host-supplied occupancy.
    #[test]
    fn a_painter_that_decides_width_itself_fails_parity() {
        let trace = traces::TRACES
            .iter()
            .find(|trace| trace.name == "wide-graphemes")
            .expect("the corpus covers wide graphemes");
        let recorded = recorded(trace);
        assert!(
            recorded
                .viewport
                .iter()
                .any(|row| row.cells.iter().any(|c| c.width == ProjectedWidth::Wide)),
            "the subject must actually contain a wide grapheme"
        );

        let honest = present(trace, &paint_with(&recorded, Occupancy::HostSupplied));
        let guessing = present(trace, &paint_with(&recorded, Occupancy::PainterDecides));
        assert_eq!(picture(&honest), picture(&recorded));
        assert_ne!(
            picture(&guessing),
            picture(&recorded),
            "a second width authority went unnoticed, so the parity check proves nothing"
        );
    }

    /// Presentation is derived from state, not forwarded from the child. Two
    /// unrelated byte streams that leave the host in the same state must paint
    /// the same, and neither stream's own control bytes may appear in the
    /// paint.
    #[test]
    fn presentation_follows_state_rather_than_the_bytes_that_produced_it() {
        let trace = Trace {
            name: "derivation",
            columns: 20,
            rows: 3,
            source: "written by this test",
        };
        // The same five characters, reached by writing them and by erasing a
        // wrong line and filling it in out of order.
        let direct = traces::replay(&trace, b"hello");
        let roundabout = traces::replay(
            &trace,
            b"XXXXX\r\x1b[2Kxxxxx\r\x1b[3Gl\x1b[1Ghe\x1b[4Glo\x1b[6G",
        );

        assert_eq!(
            picture(&direct),
            picture(&roundabout),
            "the two streams must reach the same state for this test to mean anything"
        );
        assert_eq!(
            (direct.cursor.column, direct.cursor.row),
            (roundabout.cursor.column, roundabout.cursor.row)
        );
        assert_eq!(paint(&direct), paint(&roundabout));

        let painted = paint(&direct);
        assert!(
            !contains(&painted, b"\x1b[2K"),
            "an erase the child performed is not a thing the picture contains"
        );
        assert!(
            !contains(&painted, b"\x1b[3G"),
            "a cursor move the child performed is not a thing the picture contains"
        );
    }

    /// Model facts stay in the model. What the child asked the *host* for —
    /// prompt marks, bracketed paste, application cursor keys, the alternate
    /// screen — is carried by the semantic protocol, and painting it into the
    /// caller's terminal would make that terminal a second authority.
    #[test]
    fn the_paint_carries_no_fact_that_belongs_to_the_model() {
        for trace in traces::TRACES {
            let painted = paint(&recorded(trace));
            for (sequence, meaning) in [
                (b"\x1b]133".as_slice(), "a prompt mark"),
                (b"\x1b[?1049".as_slice(), "an alternate screen switch"),
                (b"\x1b[?2004".as_slice(), "bracketed paste"),
                (b"\x1b[?1h".as_slice(), "application cursor keys"),
            ] {
                assert!(
                    !contains(&painted, sequence),
                    "trace {} painted {meaning} into the caller's terminal",
                    trace.name
                );
            }
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
