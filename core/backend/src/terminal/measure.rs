//! What one frame of semantic state costs the host.
//!
//! The semantic path replaced a byte stream with state: every occurrence the
//! child causes makes the host project its screen and encode that projection
//! for a client. The byte path did neither. Whether that trade is affordable is
//! a question about this machine and this workload, so it is measured here
//! rather than argued.
//!
//! What is measured is what `RuntimeActor` actually does per read: feed one PTY
//! chunk into the parser (`PTY_READ_CHUNK_BYTES`, 4 KiB), project the state,
//! and encode the projection the way the event carrying it is encoded. No
//! process and no window is involved, so the numbers are the host's own cost
//! and nothing else's.
//!
//! Run it, and nothing gates on it:
//!
//! ```text
//! cargo test -p shipctl-core --lib --release terminal::measure -- --ignored --nocapture
//! ```
//!
//! `--release` because a debug build measures the compiler, not the design.
//!
//! No threshold appears below. No product requirement or technical contract in
//! this repository sets a frame or throughput budget for a terminal, so a
//! number here is evidence for an owner to read, never a gate this module
//! invented.

use std::time::{Duration, Instant};

use super::projection::{
    ProjectedCell, ProjectedColor, ProjectedDamageScope, ProjectedRow, ProjectedWidth,
};
use super::replay::VtReplayEngine;
use super::retention::TerminalRetentionPolicy;
use super::traces;

/// The chunk the reader hands the parser. Mirrors
/// `runtime::PTY_READ_CHUNK_BYTES`, which is what makes this a measurement of
/// the product rather than of a chosen batch size.
const CHUNK: usize = 4_096;

/// The workload the client scenario `measure.sustained-output` writes, so the
/// two halves of the profile describe the same event.
const SUSTAINED_LINES: usize = 2_000;

/// Geometries the profile is sampled at.
///
/// 80x24 is the PTY's own default. The rest are sampled to show how the cost
/// scales with the cell count, because the product's geometry is whatever the
/// person's window is. None of them is a target.
const GEOMETRIES: &[(u16, u16)] = &[(80, 24), (120, 40), (200, 50)];

struct Frame {
    feed: Duration,
    project: Duration,
    encode: Duration,
    bytes: usize,
    /// Rows the host said changed in this frame, and what only those rows cost
    /// to encode. The frame carries the whole viewport either way; this is the
    /// size the same frame would have if it carried what it says changed.
    damaged_rows: usize,
    damaged_bytes: usize,
    /// The same frame with adjacent cells of one style carried once, which is
    /// what the client rebuilds anyway before it paints. Measured, not
    /// proposed: it says what the cell-per-cell wire form costs.
    run_bytes: usize,
}

/// A run of adjacent cells that share everything but their text. The fields are
/// the ones `terminalCellPaint.ts` breaks a run on, so this is that decision
/// moved to the wire rather than a new one.
#[derive(serde::Serialize)]
struct MeasuredRun<'cell> {
    text: String,
    columns: usize,
    width: ProjectedWidth,
    bold: bool,
    foreground: &'cell Option<ProjectedColor>,
    background: &'cell Option<ProjectedColor>,
    selected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    hyperlink: &'cell Option<String>,
}

fn joins(run: &MeasuredRun<'_>, cell: &ProjectedCell) -> bool {
    run.width == cell.width
        && run.bold == cell.bold
        && *run.foreground == cell.foreground
        && *run.background == cell.background
        && run.selected == cell.selected
        && *run.hyperlink == cell.hyperlink
}

/// One row's cells as runs.
fn runs(row: &ProjectedRow) -> Vec<MeasuredRun<'_>> {
    let mut built: Vec<MeasuredRun<'_>> = Vec::new();
    for cell in &row.cells {
        match built.last_mut() {
            Some(open) if joins(open, cell) => {
                open.text.push_str(&cell.text);
                open.columns += 1;
            }
            _ => built.push(MeasuredRun {
                text: cell.text.clone(),
                columns: 1,
                width: cell.width,
                bold: cell.bold,
                foreground: &cell.foreground,
                background: &cell.background,
                selected: cell.selected,
                hyperlink: &cell.hyperlink,
            }),
        }
    }
    built
}

fn mean(values: &[Duration]) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    values.iter().sum::<Duration>() / values.len() as u32
}

fn slowest(values: &[Duration]) -> Duration {
    values.iter().copied().max().unwrap_or(Duration::ZERO)
}

/// Feed one workload through one geometry, one PTY chunk at a time.
fn frames(columns: u16, rows: u16, output: &[u8]) -> Vec<Frame> {
    let mut engine = VtReplayEngine::new(
        columns,
        rows,
        &traces::corpus_theme(),
        TerminalRetentionPolicy::default(),
    )
    .expect("the sampled geometry is valid");

    let mut measured = Vec::new();
    for chunk in output.chunks(CHUNK) {
        let started = Instant::now();
        let _ = engine.feed(chunk);
        let feed = started.elapsed();

        let started = Instant::now();
        let state = engine.project().expect("the host projects its own state");
        let project = started.elapsed();

        let started = Instant::now();
        let encoded = serde_json::to_vec(&state).expect("a projection encodes");
        let encode = started.elapsed();

        let changed: Vec<&ProjectedRow> = match state.damage.scope {
            ProjectedDamageScope::Clean => Vec::new(),
            ProjectedDamageScope::Full => state.viewport.iter().collect(),
            ProjectedDamageScope::Partial => state
                .damage
                .rows
                .iter()
                .filter_map(|row| state.viewport.get(usize::from(*row)))
                .collect(),
        };
        let damaged_bytes = serde_json::to_vec(&changed)
            .expect("the changed rows encode")
            .len();
        let as_runs: Vec<Vec<MeasuredRun<'_>>> = state.viewport.iter().map(runs).collect();
        let run_bytes = serde_json::to_vec(&as_runs).expect("the runs encode").len();

        measured.push(Frame {
            feed,
            project,
            encode,
            bytes: encoded.len(),
            damaged_rows: changed.len(),
            damaged_bytes,
            run_bytes,
        });
    }
    measured
}

fn report(label: &str, columns: u16, rows: u16, output: &[u8]) {
    let measured = frames(columns, rows, output);
    let feeds: Vec<Duration> = measured.iter().map(|frame| frame.feed).collect();
    let projects: Vec<Duration> = measured.iter().map(|frame| frame.project).collect();
    let encodes: Vec<Duration> = measured.iter().map(|frame| frame.encode).collect();
    let bytes: usize = measured.iter().map(|frame| frame.bytes).sum();
    let changed_bytes: usize = measured.iter().map(|frame| frame.damaged_bytes).sum();
    let changed_rows: usize = measured.iter().map(|frame| frame.damaged_rows).sum();
    let run_bytes: usize = measured.iter().map(|frame| frame.run_bytes).sum();
    let per_frame = mean(&projects) + mean(&encodes);
    let count = measured.len().max(1);

    println!(
        "{label:<20} {columns:>3}x{rows:<3} frames {frames:>4}  \
         feed {feed:>9.3?}  project {project:>9.3?}  encode {encode:>9.3?}  \
         slowest project {worst:>9.3?}  cost/frame {cost:>9.3?}  \
         json/frame {json:>7} B ({per_cell:>3} B/cell)  \
         changed rows/frame {rows_changed:>5.1}  those rows {changed:>7} B  \
         as runs {as_runs:>7} B  total {total:>9} B",
        frames = measured.len(),
        feed = mean(&feeds),
        project = mean(&projects),
        encode = mean(&encodes),
        worst = slowest(&projects),
        json = bytes / count,
        per_cell = bytes / count / usize::from(columns) / usize::from(rows),
        rows_changed = changed_rows as f64 / count as f64,
        changed = changed_bytes / count,
        as_runs = run_bytes / count,
        total = bytes,
        cost = per_frame,
    );
}

/// Sustained output: the workload a person sees when a build log scrolls past.
#[test]
#[ignore = "a measurement, not an assertion: run it with --release --nocapture"]
fn sustained_output_costs_this_much_per_frame() {
    let mut output = Vec::new();
    for line in 0..SUSTAINED_LINES {
        output.extend_from_slice(format!("sustained output line {line}\r\n").as_bytes());
    }
    println!(
        "\nsustained output: {} lines, {} bytes, {} B chunks\n",
        SUSTAINED_LINES,
        output.len(),
        CHUNK,
    );
    for &(columns, rows) in GEOMETRIES {
        report("sustained-output", columns, rows, &output);
    }
}

/// The same bytes with colour on every line, because SGR runs are what a cell
/// projection has to carry and plain text is the cheap case.
#[test]
#[ignore = "a measurement, not an assertion: run it with --release --nocapture"]
fn styled_output_costs_this_much_per_frame() {
    let mut output = Vec::new();
    for line in 0..SUSTAINED_LINES {
        output.extend_from_slice(
            format!("\x1b[1;32mok\x1b[0m \x1b[38;2;120;180;255mstyled line {line}\x1b[0m\r\n")
                .as_bytes(),
        );
    }
    println!(
        "\nstyled output: {} lines, {} bytes, {} B chunks\n",
        SUSTAINED_LINES,
        output.len(),
        CHUNK,
    );
    for &(columns, rows) in GEOMETRIES {
        report("styled-output", columns, rows, &output);
    }
}

/// A full-screen program: the cursor moves and cells are rewritten in place,
/// which is the case where a whole-viewport projection has the least to gain
/// from the rows that did not change.
#[test]
#[ignore = "a measurement, not an assertion: run it with --release --nocapture"]
fn full_screen_redraw_costs_this_much_per_frame() {
    let mut output = Vec::new();
    for step in 0..SUSTAINED_LINES {
        output.extend_from_slice(format!("\x1b[H\x1b[2Jframe {step}\r\n").as_bytes());
        for row in 0..20u16 {
            output.extend_from_slice(
                format!("\x1b[{};1Hrow {row} of frame {step}", row + 2).as_bytes(),
            );
        }
    }
    println!(
        "\nfull-screen redraw: {} repaints, {} bytes, {} B chunks\n",
        SUSTAINED_LINES,
        output.len(),
        CHUNK,
    );
    for &(columns, rows) in GEOMETRIES {
        report("full-screen-redraw", columns, rows, &output);
    }
}
