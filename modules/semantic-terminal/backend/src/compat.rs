//! Ghostty semantic compatibility corpus.
//!
//! This is the executable half of the go/no-go gate for making Ghostty the
//! sole VT authority. Every test here asks one question of the *pinned* parser
//! revision: can the safe API produce a terminal fact, effect, encoding, or
//! selection that the product needs, as an **owned** value that outlives the
//! call?
//!
//! Two rules keep this corpus honest:
//!
//! - The read boundary is the semantic API ([`RenderState`], `grid_ref`,
//!   accessors, encoders), never the ANSI formatter. The formatter is the
//!   current replay transport, not a semantic contract, so a fact that is only
//!   observable in formatter bytes is recorded as a gap rather than a pass.
//! - Every fact is copied into a Rust-owned value before it is asserted. No
//!   assertion may read a borrow that Ghostty still owns.
//!
//! Retention is deliberately absent: [`crate::retention`] is the single
//! measured authority for `max_scrollback`, and a second interpretation here
//! would be a second answer. This corpus only proves that retained history is
//! *addressable*.
//!
//! The verdict, the gap ledger, and the dependency ownership record derived
//! from these tests live in `docs/ops/terminal-vt-dependency.md`. That document
//! and this corpus are one deliverable: an upgrade that changes a relied-on
//! behavior must fail here first.

use std::cell::RefCell;

use crate::libghostty_vt::{
    focus,
    key::{self, KittyKeyFlags},
    mouse, osc, paste,
    render::{CellIterator, RowIterator},
    screen::{CellWide, RowSemanticPrompt, Screen},
    selection::{FormatOptions, SelectLineOptions, SelectWordOptions, Selection},
    style::RgbColor,
    terminal::{CursorStyle, Mode, Point, PointCoordinate},
    unicode, RenderState, Terminal, TerminalOptions,
};

use crate::retention::TerminalRetentionPolicy;

fn new_terminal<'cb>(cols: u16, rows: u16) -> Terminal<'static, 'cb> {
    Terminal::new(TerminalOptions {
        cols,
        rows,
        max_scrollback: TerminalRetentionPolicy::default().bytes(),
    })
    .expect("pinned parser must construct a terminal")
}

/// One cell, copied out of Ghostty. Every field is owned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedCell {
    text: String,
    wide: CellWide,
    bold: bool,
    fg: Option<RgbColor>,
    bg: Option<RgbColor>,
    selected: bool,
}

/// One row, copied out of Ghostty. Every field is owned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedRow {
    wrapped: bool,
    continuation: bool,
    prompt: RowSemanticPrompt,
    cells: Vec<RenderedCell>,
}

impl RenderedRow {
    fn text(&self) -> String {
        self.cells.iter().map(|cell| cell.text.as_str()).collect()
    }
}

/// Read the viewport through the semantic render API and return owned rows.
///
/// This is the shape the future renderer needs: rows and cells with text,
/// width class, style, resolved colors, selection membership, and wrap state —
/// with no escape sequence anywhere in the path.
fn render<'alloc>(terminal: &Terminal<'alloc, '_>) -> Vec<RenderedRow> {
    let mut state = RenderState::new().expect("render state");
    let snapshot = state.update(terminal).expect("render snapshot");
    let mut row_iterator = RowIterator::new().expect("row iterator");
    let mut rows = row_iterator.update(&snapshot).expect("row iteration");
    let mut cell_iterator = CellIterator::new().expect("cell iterator");

    let mut rendered = Vec::new();
    while let Some(row) = rows.next() {
        let raw = row.raw_row().expect("raw row");
        let mut cells = Vec::new();
        let mut cell_iteration = cell_iterator.update(row).expect("cell iteration");
        while let Some(cell) = cell_iteration.next() {
            let mut text = String::new();
            cell.graphemes_utf8(&mut text).expect("cell graphemes");
            cells.push(RenderedCell {
                text,
                wide: cell
                    .raw_cell()
                    .expect("raw cell")
                    .wide()
                    .expect("cell width"),
                bold: cell.style().expect("cell style").bold,
                fg: cell.fg_color().expect("cell foreground"),
                bg: cell.bg_color().expect("cell background"),
                selected: cell.is_selected().expect("cell selection"),
            });
        }
        rendered.push(RenderedRow {
            wrapped: raw.is_wrapped().expect("row wrap"),
            continuation: raw.is_wrap_continuation().expect("row continuation"),
            prompt: raw.semantic_prompt().expect("row semantic prompt"),
            cells,
        });
    }
    rendered
}

/// Copy the text of a selection out of Ghostty as an owned string.
fn selected_text(terminal: &Terminal<'_, '_>, selection: &Selection<'_>) -> String {
    let bytes = terminal
        .format_selection_alloc(None, FormatOptions::new().with_selection(selection))
        .expect("format selection")
        .expect("selection has content");
    String::from_utf8(bytes.as_ref().to_vec()).expect("selection text is utf-8")
}

/// Where the parse currently stands, used to position an effect inside a write.
fn at(terminal: &Terminal<'_, '_>) -> u16 {
    terminal.cursor_x().unwrap_or_default()
}

fn grid_point<'t>(
    terminal: &'t Terminal<'_, '_>,
    x: u16,
    y: u16,
) -> crate::libghostty_vt::screen::GridRef<'t> {
    terminal
        .grid_ref(Point::Active(PointCoordinate { x, y: u32::from(y) }))
        .expect("grid reference")
}

// -- geometry, screens, history ------------------------------------------

/// Geometry and the active screen are readable, and resize is a host
/// operation rather than a replayed side effect.
#[test]
fn geometry_and_active_screen_are_readable_and_mutable() {
    let mut terminal = new_terminal(20, 6);
    assert_eq!(terminal.cols().expect("cols"), 20);
    assert_eq!(terminal.rows().expect("rows"), 6);
    assert_eq!(terminal.active_screen().expect("screen"), Screen::Primary);

    terminal.resize(30, 8, 0, 0).expect("resize");
    assert_eq!(terminal.cols().expect("cols"), 30);
    assert_eq!(terminal.rows().expect("rows"), 8);

    terminal.vt_write(b"\x1b[?1049h");
    assert_eq!(terminal.active_screen().expect("screen"), Screen::Alternate);
    terminal.vt_write(b"\x1b[?1049l");
    assert_eq!(terminal.active_screen().expect("screen"), Screen::Primary);
}

/// The alternate screen must not destroy the primary screen, because the
/// client shows primary content again the moment a full-screen program exits.
#[test]
fn the_alternate_screen_leaves_the_primary_screen_intact() {
    let mut terminal = new_terminal(20, 4);
    terminal.vt_write(b"primary-kept");
    terminal.vt_write(b"\x1b[?1049h\x1b[2J\x1b[Halternate-only");
    assert!(!render(&terminal)[0].text().contains("primary-kept"));

    terminal.vt_write(b"\x1b[?1049l");
    assert!(render(&terminal)[0].text().contains("primary-kept"));
}

/// History is addressable as semantic cells, not only as replay bytes. The
/// *amount* of history is measured in [`crate::retention`]; this proves the
/// rows can be read at all, which is what scrollback rendering and selection
/// over history require.
#[test]
fn retained_history_is_addressable_as_cells() {
    let mut terminal = new_terminal(20, 3);
    for line in 0..10 {
        terminal.vt_write(format!("line-{line}\r\n").as_bytes());
    }

    let scrollback = terminal.scrollback_rows().expect("scrollback rows");
    assert!(scrollback > 0, "history must exist to be addressable");
    assert_eq!(
        terminal.total_rows().expect("total rows"),
        scrollback + usize::from(terminal.rows().expect("rows"))
    );

    let first = terminal
        .grid_ref(Point::History(PointCoordinate { x: 0, y: 0 }))
        .expect("history grid reference");
    let mut graphemes = ['\0'; 4];
    let length = first.graphemes(&mut graphemes).expect("history graphemes");
    assert_eq!(graphemes[..length], ['l']);
}

// -- rows, cells, graphemes, widths, styles, colors ----------------------

/// The renderer's whole read surface in one pass: text, width class, style,
/// resolved colors, and wrap state, taken from the semantic API.
#[test]
fn the_render_snapshot_carries_text_widths_styles_and_colors() {
    let mut terminal = new_terminal(24, 4);
    terminal.vt_write("\x1b[1;38;2;10;20;30;48;5;17mbold\x1b[0m 中 e\u{301}".as_bytes());

    let rows = render(&terminal);
    assert_eq!(rows.len(), 4, "the snapshot covers the whole viewport");
    let row = &rows[0];
    assert!(row.text().starts_with("bold 中"));

    let styled = &row.cells[0];
    assert_eq!(styled.text, "b");
    assert!(styled.bold);
    assert_eq!(
        styled.fg,
        Some(RgbColor {
            r: 10,
            g: 20,
            b: 30
        })
    );
    assert!(styled.bg.is_some(), "palette background resolves to rgb");

    let plain = &row.cells[5];
    assert!(!plain.bold, "SGR 0 ends the run");

    // A wide grapheme owns two cells: the lead carries the text, the tail is a
    // spacer the renderer must not draw.
    let wide = row
        .cells
        .iter()
        .position(|cell| cell.text == "中")
        .expect("wide grapheme is present");
    assert_eq!(row.cells[wide].wide, CellWide::Wide);
    assert_eq!(row.cells[wide + 1].wide, CellWide::SpacerTail);
    assert_eq!(row.cells[wide + 1].text, "");

    // A combining mark stays in one cell with its base.
    assert!(
        row.cells.iter().any(|cell| cell.text == "e\u{301}"),
        "combining grapheme keeps one cell: {:?}",
        row.text()
    );

    // Width classification is available without a terminal, for measurement.
    assert_eq!(unicode::codepoint_width('中'), 2);
    // (codepoints in the cluster, columns it occupies).
    assert_eq!(unicode::grapheme_width(&['e', '\u{301}']), (2, 1));
}

/// Soft wrap is a row fact, not a newline. The renderer needs it to reflow
/// selection and to copy a wrapped line as one line.
#[test]
fn soft_wrap_and_continuation_rows_are_distinguishable() {
    let mut terminal = new_terminal(10, 4);
    terminal.vt_write(b"1234567890ABC");

    let rows = render(&terminal);
    assert!(rows[0].wrapped, "the full row soft-wrapped");
    assert!(rows[1].continuation, "the next row continues it");
    assert!(!rows[1].wrapped);
    assert_eq!(rows[0].text(), "1234567890");
    assert!(rows[1].text().starts_with("ABC"));
}

/// Reflow is the host's, and it survives a geometry change in both
/// directions. A client that re-lays-out text itself would drift here.
#[test]
fn reflow_preserves_content_across_a_resize() {
    let mut terminal = new_terminal(14, 4);
    terminal.vt_write(b"one two three four five six");

    terminal.resize(9, 6, 0, 0).expect("narrow resize");
    let narrow: String = render(&terminal)
        .iter()
        .map(|row| row.text().trim_end().to_string())
        .collect();
    assert!(narrow.contains("one two three four five six"));

    terminal.resize(30, 4, 0, 0).expect("wide resize");
    assert!(render(&terminal)[0]
        .text()
        .starts_with("one two three four five six"));
}

/// Cursor state is a first-class fact, including pending wrap — the state a
/// client cannot infer from the cell contents alone.
#[test]
fn cursor_position_visibility_style_and_pending_wrap_are_readable() {
    let mut terminal = new_terminal(10, 4);
    terminal.vt_write(b"\x1b[2;4H");
    assert_eq!(terminal.cursor_x().expect("cursor x"), 3);
    assert_eq!(terminal.cursor_y().expect("cursor y"), 1);
    assert!(!terminal.is_cursor_pending_wrap().expect("pending wrap"));
    assert!(terminal.is_cursor_visible().expect("cursor visible"));

    terminal.vt_write(b"\x1b[H1234567890");
    assert!(
        terminal.is_cursor_pending_wrap().expect("pending wrap"),
        "a full row leaves the cursor pending wrap rather than on the next row"
    );
    assert_eq!(terminal.cursor_y().expect("cursor y"), 0);

    terminal.vt_write(b"\x1b[?25l");
    assert!(!terminal.is_cursor_visible().expect("cursor visible"));

    terminal
        .set_default_cursor_style(Some(CursorStyle::Bar))
        .expect("default cursor style");
    terminal.vt_write(b"\x1b[3 q");
    assert!(terminal.cursor_style().is_ok(), "cursor style is readable");
}

/// Semantic prompt marking (OSC 133) reaches rows and cells. This is what
/// makes "copy the output of this command" possible at all.
#[test]
fn semantic_prompt_marking_reaches_rows() {
    let mut terminal = new_terminal(20, 4);
    terminal.vt_write(b"\x1b]133;A\x1b\\$ \x1b]133;B\x1b\\ls\x1b]133;C\x1b\\\r\nout\r\n");

    let rows = render(&terminal);
    assert_eq!(rows[0].prompt, RowSemanticPrompt::Prompt);
    assert_eq!(rows[1].prompt, RowSemanticPrompt::None);
}

/// The child can own the palette and the default colors. A client that keeps
/// its own theme as the truth would show the wrong colors after OSC 4/10/11.
#[test]
fn the_child_owns_the_palette_and_the_default_colors() {
    let mut terminal = new_terminal(20, 4);
    let host_default = RgbColor {
        r: 0x11,
        g: 0x11,
        b: 0x11,
    };
    terminal
        .set_default_bg_color(Some(host_default))
        .expect("default background");
    assert_eq!(
        terminal.default_bg_color().expect("default background"),
        Some(host_default)
    );

    terminal.vt_write(b"\x1b]11;#204060\x1b\\\x1b]10;#a0b0c0\x1b\\\x1b]4;1;#010203\x1b\\");
    assert_eq!(
        terminal.bg_color().expect("background"),
        Some(RgbColor {
            r: 0x20,
            g: 0x40,
            b: 0x60
        }),
        "OSC 11 overrides the host default while the child holds it"
    );
    assert_eq!(
        terminal.fg_color().expect("foreground"),
        Some(RgbColor {
            r: 0xa0,
            g: 0xb0,
            b: 0xc0
        })
    );
    let palette = terminal.color_palette().expect("palette");
    assert_eq!(
        palette.get(crate::libghostty_vt::style::PaletteIndex(1)),
        RgbColor {
            r: 0x01,
            g: 0x02,
            b: 0x03
        }
    );
    assert_eq!(
        terminal.default_bg_color().expect("default background"),
        Some(host_default),
        "the host default survives underneath the child's override"
    );
}

/// Hyperlink URIs are per-cell facts and are readable as owned bytes.
#[test]
fn hyperlink_uris_are_readable_per_cell() {
    let mut terminal = new_terminal(24, 3);
    terminal.vt_write(b"\x1b]8;id=shipctl;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ plain");

    let linked = grid_point(&terminal, 0, 0);
    assert!(linked
        .cell()
        .and_then(|cell| cell.has_hyperlink())
        .expect("hyperlink flag"));
    let mut uri = vec![0u8; 64];
    let length = linked.hyperlink_uri(&mut uri).expect("hyperlink uri");
    assert_eq!(&uri[..length], b"https://example.com/x");

    let plain = grid_point(&terminal, 5, 0);
    assert!(!plain
        .cell()
        .and_then(|cell| cell.has_hyperlink())
        .expect("hyperlink flag"));
}

/// Modes are queryable by number and kind, which is the only sound basis for
/// mode-aware input encoding and for deciding what the client may do locally.
#[test]
fn terminal_modes_are_queryable() {
    let mut terminal = new_terminal(20, 4);
    assert!(terminal.mode(Mode::WRAPAROUND).expect("wraparound"));
    assert!(!terminal.mode(Mode::BRACKETED_PASTE).expect("paste mode"));

    terminal.vt_write(b"\x1b[?7l\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?1004h");
    assert!(!terminal.mode(Mode::WRAPAROUND).expect("wraparound"));
    assert!(terminal.mode(Mode::BRACKETED_PASTE).expect("paste mode"));
    assert!(terminal.mode(Mode::DECCKM).expect("cursor key mode"));
    assert!(terminal.mode(Mode::FOCUS_EVENT).expect("focus events"));
    assert!(terminal.is_mouse_tracking().expect("mouse tracking"));
}

// -- ordered non-cell effects --------------------------------------------

/// Non-cell effects are delivered as ordered callbacks *inside* the parse, so
/// each one can be published at the exact point in the output it belongs to.
/// Order is the product fact: a bell attributed to a later screen state is a
/// wrong notification.
///
/// One PTY chunk carries text and effects together, so the position within the
/// chunk is what has to be observable — the callback's own view of the cursor
/// proves it. Payloads are copied out; the callback owns none of them.
///
/// OSC 9 is the exception and is proved separately below.
#[test]
fn non_cell_effects_are_positioned_inside_one_write_with_owned_payloads() {
    let effects: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let mut terminal = new_terminal(20, 4);

    terminal
        .on_title_changed(|term| {
            let title = term.title().unwrap_or_default().to_string();
            effects
                .borrow_mut()
                .push(format!("title:{title}@{}", at(term)));
        })
        .expect("title callback");
    terminal
        .on_pwd_changed(|term| {
            let pwd = term.pwd().unwrap_or_default().to_string();
            effects.borrow_mut().push(format!("pwd:{pwd}@{}", at(term)));
        })
        .expect("pwd callback");
    terminal
        .on_bell(|term| effects.borrow_mut().push(format!("bell@{}", at(term))))
        .expect("bell callback");
    terminal
        .on_clipboard_write(|term, write| {
            let payload: Vec<String> = write
                .contents()
                .map(|content| content.data.to_string())
                .collect();
            effects
                .borrow_mut()
                .push(format!("clipboard:{}@{}", payload.join(","), at(term)));
            Ok(())
        })
        .expect("clipboard callback");
    terminal
        .on_pty_write(|term, data| {
            effects.borrow_mut().push(format!(
                "pty:{}@{}",
                String::from_utf8_lossy(data),
                at(term)
            ));
        })
        .expect("pty callback");

    terminal.vt_write(
        b"one\x1b]0;shipctl\x1b\\two\x07three\
          \x1b]7;file:///workspace\x1b\\\x1b]52;c;aGVsbG8=\x1b\\\x1b[6n",
    );

    let effects = effects.borrow();
    assert_eq!(
        effects.as_slice(),
        [
            "title:shipctl@3".to_string(),
            "bell@6".to_string(),
            // OSC 7 is reported verbatim as a URI. Turning it into a path is
            // the host's job, not the parser's.
            "pwd:file:///workspace@11".to_string(),
            "clipboard:hello@11".to_string(),
            "pty:\x1b[1;12R@11".to_string(),
        ]
    );
}

/// **Gap, proven.** The product turns OSC 9 into a desktop notification today.
/// The pinned parser recognizes the command but exposes no callback and no
/// payload accessor, so the notification body cannot be read through the safe
/// API. This test is the falsification attempt; it passes by *demonstrating*
/// the limit, and it will fail the moment an upgrade closes it — which is when
/// the ledger entry must be retired.
#[test]
fn the_desktop_notification_payload_is_not_exposed() {
    let effects: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let mut terminal = new_terminal(20, 4);
    // Every callback that could plausibly carry the payload.
    terminal
        .on_title_changed(|term| {
            effects
                .borrow_mut()
                .push(format!("title:{}", term.title().unwrap_or_default()));
        })
        .expect("title callback");
    terminal
        .on_pwd_changed(|term| {
            effects
                .borrow_mut()
                .push(format!("pwd:{}", term.pwd().unwrap_or_default()));
        })
        .expect("pwd callback");
    terminal
        .on_bell(|_term| effects.borrow_mut().push("bell".to_string()))
        .expect("bell callback");

    terminal.vt_write(b"\x1b]9;build finished\x1b\\");
    assert!(
        effects.borrow().is_empty(),
        "no terminal callback carries the OSC 9 payload: {:?}",
        effects.borrow()
    );

    // The standalone OSC parser classifies the command, and that is all: the
    // variant has no payload field to read.
    let mut parser = osc::Parser::new().expect("osc parser");
    for byte in b"9;build finished" {
        parser.next_byte(*byte);
    }
    assert!(matches!(
        parser.end(0x1b).command_type(),
        osc::CommandType::ShowDesktopNotification
    ));
}

// -- mode-aware input encoding -------------------------------------------

/// Key encoding is the host's, and it follows the modes the child set. This
/// is why the client may not keep its own keymap.
#[test]
fn key_encoding_follows_terminal_modes() {
    let mut terminal = new_terminal(20, 4);
    let mut encoder = key::Encoder::new().expect("key encoder");
    let mut event = key::Event::new().expect("key event");
    event
        .set_action(key::Action::Press)
        .set_key(key::Key::ArrowUp);

    let mut normal = Vec::new();
    encoder.set_options_from_terminal(&terminal);
    encoder.encode_to_vec(&event, &mut normal).expect("encode");
    assert_eq!(normal, b"\x1b[A");

    terminal.vt_write(b"\x1b[?1h");
    let mut application = Vec::new();
    encoder.set_options_from_terminal(&terminal);
    encoder
        .encode_to_vec(&event, &mut application)
        .expect("encode");
    assert_eq!(application, b"\x1bOA", "DECCKM changes the encoding");

    // Text keys carry their utf-8 payload, and modifiers are the encoder's.
    let mut typed = key::Event::new().expect("key event");
    typed
        .set_action(key::Action::Press)
        .set_key(key::Key::C)
        .set_utf8(Some("c"));
    let mut plain = Vec::new();
    encoder.encode_to_vec(&typed, &mut plain).expect("encode");
    assert_eq!(plain, b"c");

    typed.set_mods(key::Mods::CTRL);
    let mut control = Vec::new();
    encoder.encode_to_vec(&typed, &mut control).expect("encode");
    assert_eq!(control, b"\x03");

    // The Kitty keyboard protocol is state the child owns and the encoder reads.
    assert_eq!(
        terminal.kitty_keyboard_flags().expect("kitty flags"),
        KittyKeyFlags::empty()
    );
    terminal.vt_write(b"\x1b[>1u");
    assert_ne!(
        terminal.kitty_keyboard_flags().expect("kitty flags"),
        KittyKeyFlags::empty()
    );
    encoder.set_options_from_terminal(&terminal);
    let mut kitty = Vec::new();
    encoder.encode_to_vec(&event, &mut kitty).expect("encode");
    assert!(!kitty.is_empty());
}

/// Paste encoding follows bracketed-paste mode, and the parser answers
/// whether a payload is safe to paste unguarded.
#[test]
fn paste_encoding_follows_bracketed_paste_mode() {
    let mut terminal = new_terminal(20, 4);
    let mut payload = *b"hello";
    let mut buffer = [0u8; 32];

    let bracketed = terminal.mode(Mode::BRACKETED_PASTE).expect("paste mode");
    let length = paste::encode(&mut payload, bracketed, &mut buffer).expect("encode paste");
    assert_eq!(&buffer[..length], b"hello");

    terminal.vt_write(b"\x1b[?2004h");
    let bracketed = terminal.mode(Mode::BRACKETED_PASTE).expect("paste mode");
    let mut payload = *b"hello";
    let length = paste::encode(&mut payload, bracketed, &mut buffer).expect("encode paste");
    assert_eq!(&buffer[..length], b"\x1b[200~hello\x1b[201~");

    assert!(paste::is_safe("plain text"));
    assert!(!paste::is_safe("rm -rf /\n"), "a newline would execute");
}

/// Mouse encoding follows the tracking mode and format the child selected,
/// and it converts surface pixels into cells using the geometry the client
/// gives it.
#[test]
fn mouse_encoding_follows_the_tracking_mode_and_format() {
    let mut terminal = new_terminal(20, 4);
    terminal.vt_write(b"\x1b[?1000h\x1b[?1006h");

    let mut encoder = mouse::Encoder::new().expect("mouse encoder");
    encoder.set_options_from_terminal(&terminal);
    encoder.set_size(mouse::EncoderSize {
        screen_width: 200,
        screen_height: 80,
        cell_width: 10,
        cell_height: 20,
        padding_top: 0,
        padding_bottom: 0,
        padding_right: 0,
        padding_left: 0,
    });

    let mut event = mouse::Event::new().expect("mouse event");
    event
        .set_action(mouse::Action::Press)
        .set_button(Some(mouse::Button::Left))
        .set_position(mouse::Position { x: 25.0, y: 21.0 });

    let mut press = Vec::new();
    encoder.encode_to_vec(&event, &mut press).expect("encode");
    assert_eq!(press, b"\x1b[<0;3;2M", "SGR press at cell (3,2)");

    event.set_action(mouse::Action::Release);
    let mut release = Vec::new();
    encoder.encode_to_vec(&event, &mut release).expect("encode");
    assert_eq!(release, b"\x1b[<0;3;2m");

    // Without the child's request there is nothing to send.
    let mut quiet = new_terminal(20, 4);
    quiet.vt_write(b"\x1b[?1006l\x1b[?1000l");
    let mut off = mouse::Encoder::new().expect("mouse encoder");
    off.set_options_from_terminal(&quiet);
    off.set_size(mouse::EncoderSize {
        screen_width: 200,
        screen_height: 80,
        cell_width: 10,
        cell_height: 20,
        padding_top: 0,
        padding_bottom: 0,
        padding_right: 0,
        padding_left: 0,
    });
    let mut silent = Vec::new();
    off.encode_to_vec(&event, &mut silent).expect("encode");
    assert!(silent.is_empty(), "no tracking mode, no report");
}

/// The wheel is a button, and the encoder is what says which one.
///
/// A terminal has never had a scroll report of its own: X11 numbered the wheel
/// as buttons four to seven, and every mouse format since has carried it that
/// way. So a client that wants the wheel to reach the child does not need a new
/// kind of event — it needs to know which button the wheel is, and to send a
/// press. This asserts the numbers the pinned parser produces for those four
/// buttons, so the client's mapping is checked against the encoder rather than
/// against a reading of a specification.
#[test]
fn the_wheel_encodes_as_the_buttons_the_scroll_flag_names() {
    let mut terminal = new_terminal(20, 4);
    terminal.vt_write(b"\x1b[?1000h\x1b[?1006h");

    let mut encoder = mouse::Encoder::new().expect("mouse encoder");
    encoder.set_options_from_terminal(&terminal);
    encoder.set_size(mouse::EncoderSize {
        screen_width: 200,
        screen_height: 80,
        cell_width: 10,
        cell_height: 20,
        padding_top: 0,
        padding_bottom: 0,
        padding_right: 0,
        padding_left: 0,
    });

    let mut event = mouse::Event::new().expect("mouse event");
    event
        .set_action(mouse::Action::Press)
        .set_position(mouse::Position { x: 25.0, y: 21.0 });

    // 64 is the scroll flag; the four wheel directions follow it in order.
    for (button, code) in [
        (mouse::Button::Four, 64),
        (mouse::Button::Five, 65),
        (mouse::Button::Six, 66),
        (mouse::Button::Seven, 67),
    ] {
        event.set_button(Some(button));
        let mut report = Vec::new();
        encoder.encode_to_vec(&event, &mut report).expect("encode");
        assert_eq!(
            report,
            format!("\x1b[<{code};3;2M").into_bytes(),
            "the wheel reports as button {button:?} at the cell under the pointer"
        );
    }

    // A wheel has no release, and the encoder does not invent one for it: a
    // client that sent one would tell the child the wheel was let go.
    event
        .set_action(mouse::Action::Release)
        .set_button(Some(mouse::Button::Four));
    let mut release = Vec::new();
    encoder.encode_to_vec(&event, &mut release).expect("encode");
    assert_eq!(
        release, b"\x1b[<64;3;2m",
        "which is why the client sends presses only"
    );
}

/// Focus reporting is mode-gated in the same way, and the encoding is the
/// host's.
#[test]
fn focus_events_encode_only_when_the_child_asked_for_them() {
    let mut terminal = new_terminal(20, 4);
    assert!(!terminal.mode(Mode::FOCUS_EVENT).expect("focus mode"));

    terminal.vt_write(b"\x1b[?1004h");
    assert!(terminal.mode(Mode::FOCUS_EVENT).expect("focus mode"));

    let mut buffer = [0u8; 8];
    let length = focus::Event::Gained.encode(&mut buffer).expect("encode");
    assert_eq!(&buffer[..length], b"\x1b[I");
    let length = focus::Event::Lost.encode(&mut buffer).expect("encode");
    assert_eq!(&buffer[..length], b"\x1b[O");
}

// -- selection ------------------------------------------------------------

/// Word, line, range, and command-output selections all come from the host,
/// and their copied text is owned bytes.
#[test]
fn word_line_range_and_output_selections_produce_owned_text() {
    let mut terminal = new_terminal(24, 5);
    terminal.vt_write(b"\x1b]133;A\x1b\\$ \x1b]133;B\x1b\\build\x1b]133;C\x1b\\\r\n");
    terminal.vt_write(b"alpha beta gamma\r\n");
    terminal.vt_write(b"second line\r\n");

    // Word: a double-click at a letter selects the whole word.
    let word = terminal
        .select_word(SelectWordOptions::new(grid_point(&terminal, 7, 1)))
        .expect("select word")
        .expect("word at that cell");
    assert_eq!(selected_text(&terminal, &word), "beta");

    // Line: the whole logical line, trimmed.
    let line = terminal
        .select_line(SelectLineOptions::new(grid_point(&terminal, 2, 1)))
        .expect("select line")
        .expect("line at that cell");
    assert_eq!(selected_text(&terminal, &line), "alpha beta gamma");

    // Range: an explicit drag between two cells.
    let range = Selection::new(
        grid_point(&terminal, 0, 1),
        grid_point(&terminal, 4, 1),
        false,
    );
    assert_eq!(selected_text(&terminal, &range), "alpha");

    // Output: everything the last command printed, without the prompt.
    let output = terminal
        .select_output(grid_point(&terminal, 0, 1))
        .expect("select output")
        .expect("output at that cell");
    let copied = selected_text(&terminal, &output);
    assert!(copied.contains("alpha beta gamma"), "copied: {copied:?}");
    assert!(!copied.contains("$ build"), "the prompt is not output");

    // An installed selection is visible to the renderer as a per-cell fact.
    terminal.set_selection(Some(&word)).expect("set selection");
    let rows = render(&terminal);
    let selected: String = rows[1]
        .cells
        .iter()
        .filter(|cell| cell.selected)
        .map(|cell| cell.text.as_str())
        .collect();
    assert_eq!(selected, "beta");
}

// -- ownership across the FFI boundary -----------------------------------

/// Nothing the client keeps may be a borrow into Ghostty. Every fact this
/// corpus reads is copied first, and the copies survive later writes, a
/// resize, and a full reset — the three operations that invalidate borrowed
/// grid references.
#[test]
fn facts_copied_out_stay_valid_after_the_terminal_moves_on() {
    let mut terminal = new_terminal(24, 4);
    terminal.vt_write(b"\x1b]0;before\x1b\\\x1b]7;file:///before\x1b\\");
    terminal.vt_write(b"alpha beta\r\n");

    let title = terminal.title().expect("title").to_string();
    let pwd = terminal.pwd().expect("pwd").to_string();
    let rows = render(&terminal);
    let word = terminal
        .select_word(SelectWordOptions::new(grid_point(&terminal, 0, 0)))
        .expect("select word")
        .expect("word");
    let copied = selected_text(&terminal, &word);
    let mut uri = vec![0u8; 32];
    let palette = terminal.color_palette().expect("palette");

    terminal.vt_write(b"\x1b]0;after\x1b\\overwritten");
    terminal.resize(8, 12, 0, 0).expect("resize");
    terminal.reset();
    terminal.vt_write(b"\x1b]8;;https://example.com/after\x1b\\z");

    assert_eq!(title, "before");
    assert_eq!(pwd, "file:///before");
    assert_eq!(copied, "alpha");
    assert_eq!(rows[0].text().trim_end(), "alpha beta");
    assert_eq!(rows[0].cells[0].text, "a");
    assert_eq!(
        palette.get(crate::libghostty_vt::style::PaletteIndex(1)),
        terminal
            .color_palette()
            .expect("palette")
            .get(crate::libghostty_vt::style::PaletteIndex(1))
    );

    // And a fresh read after all of that still works, so the copies did not
    // leave the parser in a borrowed state.
    let after = grid_point(&terminal, 0, 0);
    let length = after.hyperlink_uri(&mut uri).expect("hyperlink uri");
    assert_eq!(&uri[..length], b"https://example.com/after");
}
