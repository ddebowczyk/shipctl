//! A recorded corpus of child output and the state it produces.
//!
//! Each trace is the exact byte stream one real program wrote to one real PTY,
//! kept beside the program that produced it and beside the semantic state the
//! host derives from those bytes. Replaying a trace needs no process, so the
//! claim "the same bytes give the same state" is proven offline and in
//! milliseconds.
//!
//! The corpus is what makes a host/view disagreement addressable: a trace is a
//! shared, replayable subject that both the host projection and any second
//! parser can be pointed at.
//!
//! Record or re-record every trace with a real PTY:
//!
//! ```sh
//! cargo test -p shipctl-core --lib terminal::traces::tests::record -- --ignored
//! ```
//!
//! Then read the `.state` diff before committing it: that diff is the change in
//! what the host believes.

use std::fmt::Write as _;
use std::path::PathBuf;

use super::projection::{
    ProjectedCell, ProjectedColor, ProjectedModes, ProjectedPrompt, ProjectedWidth,
    TerminalProjection,
};
use super::replay::VtReplayEngine;
use super::retention::TerminalRetentionPolicy;
use shipctl_module_api::TerminalColorTheme;

/// One recording: the program, the geometry it ran under, and the name the
/// recorded bytes and recorded state are filed under.
pub(super) struct Trace {
    pub(super) name: &'static str,
    pub(super) columns: u16,
    pub(super) rows: u16,
    /// The exact `sh -c` program that produced the bytes. Keeping it here is
    /// what makes a recording reproducible instead of a mystery blob.
    pub(super) source: &'static str,
}

/// Each trace exists for one fact a client cannot infer from the text alone.
pub(super) const TRACES: &[Trace] = &[
    Trace {
        name: "soft-wrap",
        columns: 20,
        rows: 6,
        source: r"printf 'abcdefghijklmnopqrstuvwxyz0123\n'",
    },
    Trace {
        name: "sgr-styles",
        columns: 40,
        rows: 4,
        source: r"printf '\033[1mbold\033[0m \033[31mred\033[0m \033[48;2;0;0;255mbluebg\033[0m\n'",
    },
    Trace {
        name: "alt-screen",
        columns: 40,
        rows: 5,
        source: r"printf 'before\n\033[?1049hinside\033[?1049lafter\n'",
    },
    Trace {
        name: "prompt-marks",
        columns: 40,
        rows: 5,
        source: r"printf '\033]133;A\033\\$ \033]133;B\033\\echo hi\n\033]133;C\033\\hi\n\033]133;D;0\033\\'",
    },
    Trace {
        name: "wide-graphemes",
        columns: 10,
        rows: 3,
        source: r"printf '\346\227\245\346\234\254ab\n'",
    },
    Trace {
        name: "cursor-motion",
        columns: 20,
        rows: 4,
        source: r"printf 'one\ntwo\nthree\n\033[2;1Hxx\033[K'",
    },
    Trace {
        name: "mode-switches",
        columns: 20,
        rows: 3,
        source: r"printf '\033[?2004h\033[?1h\033[?25lmodes\n'",
    },
    Trace {
        name: "hyperlink",
        columns: 30,
        rows: 3,
        source: r"printf '\033]8;;https://example.com\033\\link\033]8;;\033\\\n'",
    },
];

/// The theme every recording replays under. Recording and replay must agree on
/// it, because the child's own colour changes are reported against it.
pub(super) fn corpus_theme() -> TerminalColorTheme {
    TerminalColorTheme {
        foreground: "#e6e6e6".to_string(),
        background: "#101010".to_string(),
        palette: vec![
            "#000000".to_string(),
            "#cc0000".to_string(),
            "#00cc00".to_string(),
            "#cccc00".to_string(),
            "#0000cc".to_string(),
            "#cc00cc".to_string(),
            "#00cccc".to_string(),
            "#cccccc".to_string(),
            "#666666".to_string(),
            "#ff0000".to_string(),
            "#00ff00".to_string(),
            "#ffff00".to_string(),
            "#0000ff".to_string(),
            "#ff00ff".to_string(),
            "#00ffff".to_string(),
            "#ffffff".to_string(),
        ],
    }
}

fn corpus_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/terminal-traces")
}

pub(super) fn bytes_path(trace: &Trace) -> PathBuf {
    corpus_directory().join(format!("{}.vt", trace.name))
}

fn state_path(trace: &Trace) -> PathBuf {
    corpus_directory().join(format!("{}.state", trace.name))
}

/// Replays recorded bytes into a fresh host parser. No process is involved.
pub(super) fn replay(trace: &Trace, bytes: &[u8]) -> TerminalProjection {
    let mut engine = VtReplayEngine::new(
        trace.columns,
        trace.rows,
        &corpus_theme(),
        TerminalRetentionPolicy::default(),
    )
    .expect("the corpus geometry is valid");
    engine.feed(bytes);
    engine.project().expect("the host can read its own state")
}

/// Renders a projection as the reviewable text that is checked in beside the
/// bytes. Everything the projection reports has a place here, so a change in
/// belief cannot pass review as an unchanged file.
fn render(trace: &Trace, projection: &TerminalProjection) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# recorded from: sh -c '{}'", trace.source);
    let _ = writeln!(
        out,
        "columns={} rows={} screen={} scrollback={}",
        projection.columns,
        projection.rows,
        match projection.screen {
            super::projection::ProjectedScreen::Primary => "primary",
            super::projection::ProjectedScreen::Alternate => "alternate",
        },
        projection.scrollback_rows
    );
    let _ = writeln!(
        out,
        "cursor={},{} visible={} pending_wrap={}",
        projection.cursor.column,
        projection.cursor.row,
        projection.cursor.visible,
        projection.cursor.pending_wrap
    );
    let _ = writeln!(out, "modes={}", render_modes(&projection.modes));
    let _ = writeln!(
        out,
        "colors fg={} bg={}",
        render_color(projection.colors.foreground.as_ref()),
        render_color(projection.colors.background.as_ref())
    );
    let _ = writeln!(
        out,
        "palette={}",
        projection
            .colors
            .palette
            .iter()
            .map(|color| render_color(Some(color)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    for (index, row) in projection
        .viewport
        .iter()
        .enumerate()
        .take(significant(&projection.viewport))
    {
        let mut flags = String::new();
        if row.wrapped {
            flags.push_str(" wrapped");
        }
        if row.continuation {
            flags.push_str(" continuation");
        }
        match row.prompt {
            ProjectedPrompt::None => {}
            ProjectedPrompt::Prompt => flags.push_str(" prompt"),
            ProjectedPrompt::PromptContinuation => flags.push_str(" prompt_continuation"),
        }
        let _ = writeln!(out, "row {index:02}{flags} |{}|", row.text().trim_end());
        for (start, end, attributes) in cell_runs(&row.cells) {
            let _ = writeln!(out, "cells {index:02} {start}-{end} {attributes}");
        }
    }
    out
}

/// Rows are written up to the last one that carries anything. Trailing blank
/// rows say nothing and would make every geometry change a corpus-wide diff.
fn significant(viewport: &[super::projection::ProjectedRow]) -> usize {
    viewport
        .iter()
        .rposition(|row| {
            row.wrapped
                || row.continuation
                || row.prompt != ProjectedPrompt::None
                || !row.text().trim_end().is_empty()
                || !cell_runs(&row.cells).is_empty()
        })
        .map_or(0, |last| last + 1)
}

fn render_modes(modes: &ProjectedModes) -> String {
    let enabled: Vec<&str> = [
        ("wraparound", modes.wraparound),
        ("bracketed_paste", modes.bracketed_paste),
        ("application_cursor_keys", modes.application_cursor_keys),
        ("application_keypad", modes.application_keypad),
        ("focus_events", modes.focus_events),
        ("mouse_tracking", modes.mouse_tracking),
        ("insert", modes.insert),
        ("reverse_video", modes.reverse_video),
        ("origin", modes.origin),
    ]
    .into_iter()
    .filter_map(|(name, on)| on.then_some(name))
    .collect();
    if enabled.is_empty() {
        "none".to_string()
    } else {
        enabled.join(",")
    }
}

fn render_color(color: Option<&ProjectedColor>) -> String {
    color.map_or_else(
        || "none".to_string(),
        |color| format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b),
    )
}

/// The per-cell facts that the row text cannot carry: width, weight, colour and
/// hyperlink. Adjacent equal cells collapse into one run; cells carrying
/// nothing beyond their text produce no run at all.
fn cell_runs(cells: &[ProjectedCell]) -> Vec<(usize, usize, String)> {
    let mut runs: Vec<(usize, usize, String)> = Vec::new();
    for (index, cell) in cells.iter().enumerate() {
        let attributes = cell_attributes(cell);
        if attributes.is_empty() {
            continue;
        }
        match runs.last_mut() {
            Some(last) if last.1 == index && last.2 == attributes => last.1 = index + 1,
            _ => runs.push((index, index + 1, attributes)),
        }
    }
    runs
}

fn cell_attributes(cell: &ProjectedCell) -> String {
    let mut attributes = Vec::new();
    match cell.width {
        ProjectedWidth::Narrow => {}
        ProjectedWidth::Wide => attributes.push("wide".to_string()),
        ProjectedWidth::SpacerTail => attributes.push("spacer_tail".to_string()),
        ProjectedWidth::SpacerHead => attributes.push("spacer_head".to_string()),
    }
    if cell.bold {
        attributes.push("bold".to_string());
    }
    if let Some(color) = cell.foreground.as_ref() {
        attributes.push(format!("fg={}", render_color(Some(color))));
    }
    if let Some(color) = cell.background.as_ref() {
        attributes.push(format!("bg={}", render_color(Some(color))));
    }
    if let Some(uri) = cell.hyperlink.as_ref() {
        attributes.push(format!("link={uri}"));
    }
    attributes.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn recorded_bytes(trace: &Trace) -> Vec<u8> {
        fs::read(bytes_path(trace)).unwrap_or_else(|error| {
            panic!(
                "trace {} is missing its recording ({error}); record it with `cargo test -p shipctl-core --lib terminal::traces::tests::record -- --ignored`",
                trace.name
            )
        })
    }

    #[test]
    fn every_recorded_trace_replays_to_the_state_recorded_beside_it() {
        for trace in TRACES {
            let bytes = recorded_bytes(trace);
            let expected = fs::read_to_string(state_path(trace)).unwrap_or_else(|error| {
                panic!("trace {} is missing its state: {error}", trace.name)
            });
            assert_eq!(
                render(trace, &replay(trace, &bytes)),
                expected,
                "trace {} no longer produces the state recorded beside it",
                trace.name
            );
        }
    }

    #[test]
    fn replaying_the_same_bytes_twice_gives_the_same_state() {
        for trace in TRACES {
            let bytes = recorded_bytes(trace);
            assert_eq!(
                replay(trace, &bytes),
                replay(trace, &bytes),
                "trace {} replays differently on a second parser",
                trace.name
            );
        }
    }

    /// The goldens catch drift; these assertions say what each trace is for, so
    /// a golden that drifts to something meaningless still fails.
    #[test]
    fn the_corpus_covers_the_facts_a_client_cannot_infer_from_text() {
        let trace = |name: &str| TRACES.iter().find(|trace| trace.name == name).unwrap();

        let wrap = trace("soft-wrap");
        let wrapped = replay(wrap, &recorded_bytes(wrap));
        assert!(
            wrapped.viewport[0].wrapped && wrapped.viewport[1].continuation,
            "a filled row that continues is a row fact, not a newline"
        );

        let styles = trace("sgr-styles");
        let styled = replay(styles, &recorded_bytes(styles));
        assert!(styled.viewport[0].cells.iter().any(|cell| cell.bold));
        assert!(styled.viewport[0]
            .cells
            .iter()
            .any(|cell| cell.foreground.is_some()));
        assert!(styled.viewport[0]
            .cells
            .iter()
            .any(|cell| cell.background == Some(ProjectedColor { r: 0, g: 0, b: 255 })));

        let alternate = trace("alt-screen");
        let left = replay(alternate, &recorded_bytes(alternate));
        assert_eq!(
            left.screen,
            super::super::projection::ProjectedScreen::Primary
        );
        assert!(
            left.viewport.iter().any(|row| row.text().contains("after")),
            "leaving the alternate screen restores what was underneath"
        );

        let marks = trace("prompt-marks");
        let marked = replay(marks, &recorded_bytes(marks));
        assert!(
            marked
                .viewport
                .iter()
                .any(|row| row.prompt == ProjectedPrompt::Prompt),
            "OSC 133 marking is what makes 'copy that command's output' answerable"
        );

        let wide = trace("wide-graphemes");
        let graphemes = replay(wide, &recorded_bytes(wide));
        assert!(graphemes.viewport[0]
            .cells
            .iter()
            .any(|cell| cell.width == ProjectedWidth::Wide));
        assert!(graphemes.viewport[0]
            .cells
            .iter()
            .any(|cell| cell.width == ProjectedWidth::SpacerTail));

        let motion = trace("cursor-motion");
        let moved = replay(motion, &recorded_bytes(motion));
        assert_eq!(moved.viewport[1].text().trim_end(), "xx");

        let switches = trace("mode-switches");
        let switched = replay(switches, &recorded_bytes(switches));
        assert!(switched.modes.bracketed_paste);
        assert!(switched.modes.application_cursor_keys);
        assert!(!switched.cursor.visible);

        let links = trace("hyperlink");
        let linked = replay(links, &recorded_bytes(links));
        assert_eq!(
            linked.viewport[0].cells[0].hyperlink.as_deref(),
            Some("https://example.com")
        );
    }

    /// Recording needs a real PTY and rewrites checked-in files, so it is not
    /// part of the ordinary run. Everything above replays offline.
    #[cfg(unix)]
    #[test]
    #[ignore = "records the corpus from real PTY sessions and rewrites the checked-in fixtures"]
    fn record() {
        fs::create_dir_all(corpus_directory()).expect("the corpus directory can be created");
        for trace in TRACES {
            let bytes = record_trace(trace);
            fs::write(bytes_path(trace), &bytes).expect("the recording can be written");
            fs::write(state_path(trace), render(trace, &replay(trace, &bytes)))
                .expect("the state can be written");
        }
    }

    /// Runs one program under a real PTY and returns every byte it wrote.
    ///
    /// The PTY is what makes this a recording rather than a construction: line
    /// endings, echo and flushing are the terminal's, not ours.
    #[cfg(unix)]
    fn record_trace(trace: &Trace) -> Vec<u8> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: trace.rows,
                cols: trace.columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("a PTY can be opened");
        let mut reader = pair.master.try_clone_reader().expect("the master reads");

        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg(trace.source);
        command.cwd("/");
        // The same environment the host gives its own children, so a recording
        // is what a Shipctl-hosted program would emit.
        command.env("TERM", "xterm-256color");
        command.env("TERM_PROGRAM", "iTerm.app");
        command.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(command).expect("the child starts");
        drop(pair.slave);

        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        // A closed PTY reports EOF on one platform and an error on another;
        // both mean the child is done writing.
        while let Ok(length) = reader.read(&mut buffer) {
            if length == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..length]);
        }
        let status = child.wait().expect("the child is waited for");
        assert!(
            status.success(),
            "trace {} did not exit cleanly; its recording would be misleading",
            trace.name
        );
        bytes
    }
}
