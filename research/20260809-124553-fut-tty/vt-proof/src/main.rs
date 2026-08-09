use std::cell::RefCell;

use libghostty_vt::{
    Error, Terminal, TerminalOptions,
    fmt::{Format, Formatter, FormatterOptions},
    screen::{CellWide, Screen},
    selection::Selection,
    style::{Style, StyleColor, Underline},
    terminal::{Point, PointCoordinate},
};

struct Fixture {
    name: &'static str,
    cols: u16,
    rows: u16,
    prefix: &'static [u8],
    suffix: &'static [u8],
    resize_at_split: Option<(u16, u16)>,
    expect_hyperlink_in_replay: bool,
    expect_query_response: bool,
}

struct VtAdapter<'a> {
    terminal: Terminal<'a, 'a>,
}

impl<'a> VtAdapter<'a> {
    fn new(
        cols: u16,
        rows: u16,
        cell_budget: usize,
        responses: &'a RefCell<Vec<u8>>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        validate_dimensions(cols, rows, cell_budget)?;
        let mut terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: 1_000,
        })?;
        terminal.on_pty_write({
            let responses = responses;
            move |_terminal, data| responses.borrow_mut().extend_from_slice(data)
        })?;
        Ok(Self { terminal })
    }

    fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
    }

    fn resize(
        &mut self,
        cols: u16,
        rows: u16,
        cell_budget: usize,
    ) -> Result<(), Box<dyn std::error::Error>> {
        validate_dimensions(cols, rows, cell_budget)?;
        self.terminal.resize(cols, rows, 0, 0)?;
        Ok(())
    }

    /// Produce a reset-target replay for xterm.js without losing the inactive
    /// primary buffer while the alternate screen is active.
    fn replay(&mut self) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        if self.terminal.active_screen()? == Screen::Primary {
            return format_active_screen(&self.terminal);
        }

        // libghostty-vt's formatter serializes the active screen. Preserve the
        // alternate replay, expose and serialize the primary screen, then
        // rebuild the parser to its original alternate-screen state. The
        // returned stream reconstructs primary first and alternate second, so
        // a later DECRST 1049 restores the real primary contents.
        let alternate = format_active_screen(&self.terminal)?;
        self.terminal.vt_write(b"\x1b[?1049l");
        let primary = format_active_screen(&self.terminal)?;
        self.terminal.reset();
        self.terminal.vt_write(&primary);
        self.terminal.vt_write(&alternate);

        let mut replay = primary;
        replay.extend_from_slice(&alternate);
        Ok(replay)
    }
}

fn validate_dimensions(
    cols: u16,
    rows: u16,
    cell_budget: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    if cols == 0 || rows == 0 {
        return Err("terminal dimensions must be non-zero".into());
    }
    let cells = usize::from(cols)
        .checked_mul(usize::from(rows))
        .ok_or("terminal dimensions overflow the host cell count")?;
    if cells > cell_budget {
        return Err(format!(
            "terminal dimensions require {cells} cells, above the caller's {cell_budget}-cell allocation budget"
        )
        .into());
    }
    Ok(())
}

fn format_active_screen(
    terminal: &Terminal<'_, '_>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let cursor_x = terminal.cursor_x()?;
    let cursor_y = terminal.cursor_y()?;
    let cursor_pending_wrap = terminal.is_cursor_pending_wrap()?;
    let options = FormatterOptions::new()
        .with_format(Format::Vt)
        .with_unwrap(true)
        .with_palette(true)
        .with_modes(true)
        .with_scrolling_region(true)
        .with_tabstops(true)
        .with_pwd(true)
        .with_keyboard(true)
        .with_cursor(true)
        .with_style(true)
        .with_hyperlink(true)
        .with_protection(true)
        .with_kitty_keyboard(true)
        .with_charsets(true);
    let mut formatter = Formatter::new(terminal, options)?;
    let mut replay = formatter.format_alloc(None)?.as_ref().to_vec();
    let active_hyperlink = last_osc8(&replay);
    append_hyperlink_cells(terminal, &mut replay)?;
    append_blank_wrap_continuations(terminal, &mut replay)?;
    append_cursor_cell(terminal, cursor_x, cursor_y, &mut replay)?;
    if !cursor_pending_wrap {
        // The current formatter emits cursor state before tab-stop state; the
        // latter moves the cursor while rebuilding stops. The cursor-cell
        // formatter above also advances after reprinting the cell. Restore the
        // observed position as the final cursor operation.
        replay.extend_from_slice(format!("\x1b[{};{}H", cursor_y + 1, cursor_x + 1).as_bytes());
    }
    if let Some(active_hyperlink) = active_hyperlink {
        replay.extend_from_slice(&active_hyperlink);
    }
    Ok(replay)
}

fn append_cursor_cell(
    terminal: &Terminal<'_, '_>,
    cursor_x: u16,
    cursor_y: u16,
    replay: &mut Vec<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Reprint an authoritative cell using a one-cell Ghostty formatter. When
    // used at the real cursor, this restores its active style, hyperlink,
    // protection, keyboard, and charset state. Leaving it as the last
    // cursor-moving operation also restores pending wrap, which CUP clears.
    let cursor_ref = terminal.grid_ref(Point::Active(PointCoordinate {
        x: cursor_x,
        y: u32::from(cursor_y),
    }))?;
    let start_x = if cursor_ref.cell()?.wide()? == CellWide::SpacerTail {
        cursor_x
            .checked_sub(1)
            .ok_or("wide cursor spacer has no lead cell")?
    } else {
        cursor_x
    };
    let start_ref = terminal.grid_ref(Point::Active(PointCoordinate {
        x: start_x,
        y: u32::from(cursor_y),
    }))?;
    let selection = Selection::new(start_ref, cursor_ref, false);
    let options = FormatterOptions::new()
        .with_format(Format::Vt)
        .with_unwrap(false)
        .with_trim(false)
        .with_selection(&selection)
        .with_cursor(false)
        .with_style(true)
        .with_hyperlink(true)
        .with_protection(true)
        .with_kitty_keyboard(true)
        .with_charsets(true);
    let mut formatter = Formatter::new(terminal, options)?;
    replay.extend_from_slice(
        format!("\x1b[{};{}H", cursor_y + 1, start_x + 1).as_bytes(),
    );
    replay.extend_from_slice(formatter.format_alloc(None)?.as_ref());
    Ok(())
}

fn append_blank_wrap_continuations(
    terminal: &Terminal<'_, '_>,
    replay: &mut Vec<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    let cols = terminal.cols()?;
    let rows = terminal.rows()?;
    if cols == 0 {
        return Ok(());
    }
    for y in 1..rows {
        let first = terminal.grid_ref(Point::Active(PointCoordinate {
            x: 0,
            y: u32::from(y),
        }))?;
        if !first.row()?.is_wrap_continuation()? || !row_is_plain_blank(terminal, y)? {
            continue;
        }

        // The formatter cannot express an empty row that is nevertheless a
        // soft-wrap continuation. Reprint the preceding edge cell to enter
        // pending-wrap, print one default space into the continuation row,
        // then erase it. xterm retains the row's wrap bit while the visible
        // cells remain unchanged.
        append_cursor_cell(terminal, cols - 1, y - 1, replay)?;
        replay.extend_from_slice(b"\x1b[0m\x1b[0\x22q\x1b]8;;\x1b\\ \x08\x1b[X");
    }
    Ok(())
}

fn row_is_plain_blank(
    terminal: &Terminal<'_, '_>,
    y: u16,
) -> Result<bool, Box<dyn std::error::Error>> {
    for x in 0..terminal.cols()? {
        let cell = terminal
            .grid_ref(Point::Active(PointCoordinate {
                x,
                y: u32::from(y),
            }))?
            .cell()?;
        if cell.has_text()?
            || cell.has_styling()?
            || cell.has_hyperlink()?
            || cell.is_protected()?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn last_osc8(bytes: &[u8]) -> Option<Vec<u8>> {
    let start = bytes.windows(4).rposition(|window| window == b"\x1b]8;")?;
    let terminator = bytes[start + 4..]
        .windows(2)
        .position(|window| window == b"\x1b\\")?;
    let end = start + 4 + terminator + 2;
    let sequence = &bytes[start..end];
    let payload = &sequence[4..sequence.len() - 2];
    let uri_start = payload.iter().position(|byte| *byte == b';')? + 1;
    // A close sequence has no URI and must not become the post-replay state.
    (uri_start < payload.len()).then(|| sequence.to_vec())
}

fn append_hyperlink_cells(
    terminal: &Terminal<'_, '_>,
    replay: &mut Vec<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    for y in 0..terminal.rows()? {
        for x in 0..terminal.cols()? {
            let grid = terminal.grid_ref(Point::Active(PointCoordinate { x, y: u32::from(y) }))?;
            if !grid.cell()?.has_hyperlink()? {
                continue;
            }
            let graphemes = read_graphemes(&grid)?;
            if graphemes.is_empty() {
                continue;
            }
            let uri = read_hyperlink(&grid)?;
            replay.extend_from_slice(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
            replay.extend_from_slice(style_sequence(grid.style()?).as_bytes());
            replay.extend_from_slice(b"\x1b]8;;");
            replay.extend_from_slice(&uri);
            replay.extend_from_slice(b"\x1b\\");
            for grapheme in graphemes {
                let mut encoded = [0; 4];
                replay.extend_from_slice(grapheme.encode_utf8(&mut encoded).as_bytes());
            }
            replay.extend_from_slice(b"\x1b]8;;\x1b\\");
        }
    }
    Ok(())
}

fn read_graphemes(
    grid: &libghostty_vt::screen::GridRef<'_>,
) -> Result<Vec<char>, Box<dyn std::error::Error>> {
    let mut output = Vec::new();
    loop {
        match grid.graphemes(&mut output) {
            Ok(length) => {
                output.truncate(length);
                return Ok(output);
            }
            Err(Error::OutOfSpace { required }) => output.resize(required, '\0'),
            Err(error) => return Err(error.into()),
        }
    }
}

fn read_hyperlink(
    grid: &libghostty_vt::screen::GridRef<'_>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut output = Vec::new();
    loop {
        match grid.hyperlink_uri(&mut output) {
            Ok(length) => {
                output.truncate(length);
                return Ok(output);
            }
            Err(Error::OutOfSpace { required }) => output.resize(required, 0),
            Err(error) => return Err(error.into()),
        }
    }
}

fn style_sequence(style: Style) -> String {
    let mut codes = vec!["0".to_string()];
    if style.bold {
        codes.push("1".to_string());
    }
    if style.faint {
        codes.push("2".to_string());
    }
    if style.italic {
        codes.push("3".to_string());
    }
    match style.underline {
        Underline::None => {}
        Underline::Single => codes.push("4".to_string()),
        Underline::Double => codes.push("4:2".to_string()),
        Underline::Curly => codes.push("4:3".to_string()),
        Underline::Dotted => codes.push("4:4".to_string()),
        Underline::Dashed => codes.push("4:5".to_string()),
        _ => {}
    }
    if style.blink {
        codes.push("5".to_string());
    }
    if style.inverse {
        codes.push("7".to_string());
    }
    if style.invisible {
        codes.push("8".to_string());
    }
    if style.strikethrough {
        codes.push("9".to_string());
    }
    if style.overline {
        codes.push("53".to_string());
    }
    push_color(&mut codes, style.fg_color, "38", 30, 90);
    push_color(&mut codes, style.bg_color, "48", 40, 100);
    push_color(&mut codes, style.underline_color, "58", 0, 0);
    format!("\x1b[{}m", codes.join(";"))
}

fn push_color(
    codes: &mut Vec<String>,
    color: StyleColor,
    extended_prefix: &str,
    normal_base: u8,
    bright_base: u8,
) {
    match color {
        StyleColor::None => {}
        StyleColor::Palette(index) => {
            let index = index.0;
            if normal_base != 0 && index < 8 {
                codes.push((normal_base + index).to_string());
            } else if bright_base != 0 && index < 16 {
                codes.push((bright_base + index - 8).to_string());
            } else {
                codes.push(format!("{extended_prefix};5;{index}"));
            }
        }
        StyleColor::Rgb(color) => codes.push(format!(
            "{extended_prefix};2;{};{};{}",
            color.r, color.g, color.b
        )),
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn fixtures() -> Vec<Fixture> {
    vec![
        Fixture {
            name: "ordinary-text",
            cols: 16,
            rows: 5,
            prefix: b"alpha\r\nbeta",
            suffix: b"!\r\ngamma",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "soft-wrapping",
            cols: 10,
            rows: 4,
            prefix: b"1234567890ABC",
            suffix: b"DEFGHIJ",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "cursor-and-erase",
            cols: 18,
            rows: 5,
            prefix: b"first\r\nsecond\x1b[1A\x1b[2K\x1b[1;3HXY",
            suffix: b"\x1b[2B\x1b[1Gtail\x1b[K",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "colors-and-styles",
            cols: 24,
            rows: 5,
            prefix: b"\x1b[1;2;3;4;5;7;9;53;38;2;12;34;56;48;5;17mstyled",
            suffix: b"-suffix\x1b[0m\r\nplain",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "osc8-hyperlink",
            cols: 24,
            rows: 4,
            prefix: b"\x1b]8;id=shipctl;https://example.com/terminal\x1b\\link",
            suffix: b"-suffix\x1b]8;;\x1b\\",
            resize_at_split: None,
            expect_hyperlink_in_replay: true,
            expect_query_response: false,
        },
        Fixture {
            name: "alternate-screen-roundtrip",
            cols: 20,
            rows: 5,
            prefix: b"normal-before\r\nkept\x1b[?1049h\x1b[2J\x1b[Halternate",
            suffix: b"-suffix\x1b[?1049l\r\nnormal-after",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "synchronized-output",
            cols: 22,
            rows: 4,
            prefix: b"before\x1b[?2026h\x1b[2J\x1b[Hatomic",
            suffix: b"-suffix\x1b[?2026l",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "unicode-graphemes",
            cols: 24,
            rows: 5,
            prefix: "e\u{301} | 中 | 👩\u{200d}💻 | ✨".as_bytes(),
            suffix: "\r\nZażółć gęślą".as_bytes(),
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "resize-and-reflow",
            cols: 14,
            rows: 4,
            prefix: b"one two three four five six",
            suffix: b" seven eight",
            resize_at_split: Some((9, 6)),
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "terminal-modes",
            cols: 20,
            rows: 4,
            prefix: b"\x1b[?1h\x1b[?7l\x1b[?45h\x1b[?1004h\x1b[?2004hmode",
            suffix: b"-suffix",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: false,
        },
        Fixture {
            name: "query-response",
            cols: 20,
            rows: 5,
            prefix: b"\x1b[2;4H\x1b[6n\x1b[?7$p",
            suffix: b"answer",
            resize_at_split: None,
            expect_hyperlink_in_replay: false,
            expect_query_response: true,
        },
    ]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for fixture in fixtures() {
        let responses = RefCell::new(Vec::new());
        let initial_budget = usize::from(fixture.cols) * usize::from(fixture.rows);
        let mut adapter = VtAdapter::new(fixture.cols, fixture.rows, initial_budget, &responses)?;
        adapter.write(fixture.prefix);

        let (capture_cols, capture_rows) = if let Some((cols, rows)) = fixture.resize_at_split {
            let resize_budget = usize::from(cols) * usize::from(rows);
            adapter.resize(cols, rows, resize_budget)?;
            (cols, rows)
        } else {
            (fixture.cols, fixture.rows)
        };

        let replay = adapter.replay()?;
        if fixture.expect_hyperlink_in_replay
            && !replay
                .windows(b"https://example.com/terminal".len())
                .any(|window| window == b"https://example.com/terminal")
        {
            return Err(format!("{} replay lost its OSC 8 URI", fixture.name).into());
        }
        if fixture.expect_query_response && responses.borrow().is_empty() {
            return Err(format!("{} produced no PTY query response", fixture.name).into());
        }

        // Prove that a client restored from the split replay and then fed the
        // suffix remains equivalent to a fresh client restored from the
        // host's final canonical state.
        adapter.write(fixture.suffix);
        let final_replay = adapter.replay()?;
        let responses = responses.borrow();

        println!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            fixture.name,
            fixture.cols,
            fixture.rows,
            capture_cols,
            capture_rows,
            hex(fixture.prefix),
            hex(fixture.suffix),
            hex(&replay),
            hex(&final_replay),
            hex(&responses),
            fixture.expect_hyperlink_in_replay,
            fixture.expect_query_response,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_dimensions;

    #[test]
    fn rejects_zero_or_over_budget_dimensions_before_allocation() {
        assert!(validate_dimensions(0, 24, 80 * 24).is_err());
        assert!(validate_dimensions(80, 0, 80 * 24).is_err());
        assert!(validate_dimensions(81, 24, 80 * 24).is_err());
        assert!(validate_dimensions(80, 24, 80 * 24).is_ok());
    }
}
