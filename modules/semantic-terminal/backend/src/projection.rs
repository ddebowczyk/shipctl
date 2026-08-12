//! The host's terminal state as owned Shipctl values.
//!
//! `compat.rs` proves the pinned parser can produce every fact the product
//! needs. It proves it in tests and then throws the result away. This module
//! builds the same facts as a value the rest of Shipctl can hold, print, and
//! compare.
//!
//! Two rules, inherited from that corpus:
//!
//! - the read boundary is the semantic API, never the ANSI formatter; and
//! - every fact is copied out before it is returned, so nothing here borrows
//!   memory the parser still owns.
//!
//! This projection is read-only and additive. It replaces no transport, and no
//! client consumes it yet. It exists so that "what does the host believe" is a
//! question with a printable answer.

use libghostty_vt::{
    render::{CellIterator, CursorVisualStyle, Dirty, RowIterator},
    screen::{CellContentTag, CellWide, GridRef, RowSemanticPrompt, Screen},
    selection::Adjustment,
    style::{Palette, RgbColor, StyleColor},
    terminal::{Mode, Point, PointCoordinate, PointSpace},
    RenderState, Terminal,
};
use serde::{Deserialize, Serialize};

/// Longest hyperlink URI copied out of a cell.
///
/// Derived from the WHATWG URL standard, which requires a conforming
/// implementation to support URLs of at least 8,000 code points
/// (<https://url.spec.whatwg.org/#url-parsing>). A longer URI is reported as
/// truncated rather than silently cut.
const MAX_HYPERLINK_URI_BYTES: usize = 8_000;

/// Codepoints read from a cell before the reader asks the parser for the exact
/// size.
///
/// Derived from the Unicode stream-safe text format, which allows at most 30
/// non-starters after a starter (UAX #15, Stream-Safe Text Format). Text that
/// is not stream-safe is read again with the size the parser reports, so this
/// number limits nothing a caller can observe.
const STREAM_SAFE_CODEPOINTS: usize = 31;

/// Everything the host believes about one terminal, at one moment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProjection {
    pub columns: u16,
    pub rows: u16,
    pub screen: ProjectedScreen,
    /// Rows held in history behind the viewport.
    pub scrollback_rows: usize,
    pub cursor: ProjectedCursor,
    pub modes: ProjectedModes,
    pub colors: ProjectedColors,
    /// What changed since the previous read.
    pub damage: ProjectedDamage,
    /// The viewport, top row first.
    pub viewport: Vec<ProjectedRow>,
}

/// What changed since the previous projection read.
///
/// This is the host's answer, not an inference. When the host cannot prove
/// which rows changed it says the whole frame changed, because a partial update
/// that is wrong leaves stale cells on a screen and a full one only costs work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedDamage {
    pub scope: ProjectedDamageScope,
    /// Viewport rows that changed, top row first. Meaningful when the scope is
    /// partial; a full or clean frame says everything or nothing.
    pub rows: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectedDamageScope {
    /// Nothing changed. A client that painted the last read is current.
    Clean,
    /// The rows listed changed and no others.
    Partial,
    /// Everything changed, or the host cannot say which part did.
    Full,
}

/// Rows read out of retained history, and what history looked like when they
/// were read.
///
/// History coordinates are not identities. Row 0 is the oldest row the terminal
/// still keeps, so eviction renumbers every row behind it. A client that must
/// point at one line across time holds an anchor, not an index; this window
/// reports `history_rows` so a client can tell that its window moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryWindow {
    /// History row of the first row returned.
    pub start_row: u32,
    /// Rows retained behind the viewport when the window was read.
    pub history_rows: usize,
    /// The window, oldest row first. Shorter than the request when the request
    /// runs past what history holds.
    pub rows: Vec<ProjectedRow>,
}

/// A cell coordinate, owned rather than borrowed from the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedPoint {
    pub column: u16,
    pub row: u32,
}

/// The name a client holds for one anchored cell.
///
/// It is a number the host minted and nothing else. The parser's tracked
/// reference stays with the host, so no pointer, lifetime, or dependency type
/// crosses a client boundary; a stale handle is answered, not dereferenced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalAnchorId(pub u64);

/// Where an anchored cell is now.
///
/// A history row number is not an identity, because eviction renumbers history.
/// An anchor is: the host moves it with its cell through scrolling, eviction
/// and reflow, and reports where it went in every space that still names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAnchor {
    pub id: TerminalAnchorId,
    /// False once the anchored cell is gone. The handle stays answerable: a
    /// client learns that its anchor was evicted rather than reading a cell
    /// that now holds something else.
    ///
    /// Trustworthy only while `loss_reported` is true.
    pub retained: bool,
    /// Whether the host can report this anchor's loss.
    ///
    /// True means the terminal retains history, so a line that leaves the
    /// active area is held by a page and the anchor reports eviction when that
    /// page is freed. False means no page has ever held a line for this
    /// terminal, so a line that leaves the active area is destroyed with no
    /// eviction to report, and the anchor keeps naming the row that replaced
    /// it. Selection and marks over such an anchor are live-screen only.
    pub loss_reported: bool,
    /// The row a history read accepts, while the anchored line is behind the
    /// viewport. `None` once the line is on screen again or gone.
    pub history: Option<ProjectedPoint>,
    /// History and the active area counted together. Answered for as long as
    /// the line exists, which makes it the coordinate to compare across reads.
    pub screen: Option<ProjectedPoint>,
    /// Where the line is drawn, while it is visible.
    pub viewport: Option<ProjectedPoint>,
    /// Where the line is in the active area, while the child can still write
    /// to it.
    pub active: Option<ProjectedPoint>,
}

/// How a selection endpoint moves when the client does not name a new cell.
///
/// A drag that leaves the window, a keyboard extension, and an autoscroll are
/// all this: the client says which way, and the host decides which cell that
/// reaches. A client that computed the destination itself would need to know
/// where rows wrap and where history begins, which is the authority this plan
/// keeps in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedSelectionMove {
    /// The previous non-empty cell, wrapping up onto the row above.
    Left,
    /// The next non-empty cell, wrapping down onto the row below.
    Right,
    Up,
    Down,
    /// The top-left cell of the screen.
    Home,
    /// The right edge of the last non-blank row.
    End,
    PageUp,
    PageDown,
    BeginningOfLine,
    EndOfLine,
}

impl ProjectedSelectionMove {
    /// Temporary bridge for the core replay adapter. This becomes private
    /// again when selection moves with the semantic replay engine.
    pub fn adjustment(self) -> Adjustment {
        match self {
            Self::Left => Adjustment::Left,
            Self::Right => Adjustment::Right,
            Self::Up => Adjustment::Up,
            Self::Down => Adjustment::Down,
            Self::Home => Adjustment::Home,
            Self::End => Adjustment::End,
            Self::PageUp => Adjustment::PageUp,
            Self::PageDown => Adjustment::PageDown,
            Self::BeginningOfLine => Adjustment::BeginningOfLine,
            Self::EndOfLine => Adjustment::EndOfLine,
        }
    }
}

/// What a client asks the host to select.
///
/// The client names an intent — this point, this word, that command's output,
/// one step further in this direction — and never a set of cells. Which cells
/// the intent covers depends on where rows wrap, where a word ends, where the
/// OSC 133 marks are and where history begins, all of which the host holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TerminalSelectionRequest {
    /// A drag: the cell it started on and the cell it is on now.
    Range {
        space: ProjectedSpace,
        from: ProjectedPoint,
        to: ProjectedPoint,
        /// Column-bounded rather than line-following.
        rectangle: bool,
    },
    Word {
        space: ProjectedSpace,
        at: ProjectedPoint,
    },
    Line {
        space: ProjectedSpace,
        at: ProjectedPoint,
    },
    /// The output of the command the point falls in.
    Output {
        space: ProjectedSpace,
        at: ProjectedPoint,
    },
    All,
    /// Move the end of the current selection. This is the keyboard extension
    /// and the drag that left the window, which is why it names no cell.
    Extend {
        movement: ProjectedSelectionMove,
    },
    Clear,
}

/// What the host holds after a selection request.
///
/// The text comes back with the answer because the host is the only place that
/// can produce it: unwrapping a wrapped line and dropping the spacer half of a
/// wide grapheme are its facts, not the client's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSelectionState {
    /// Whether a selection exists. A request that matched nothing leaves this
    /// false rather than reporting an empty one.
    pub active: bool,
    /// The selected text, or `None` when nothing is selected.
    pub text: Option<String>,
}

/// The coordinate spaces a cell can be named in.
///
/// The same cell has a different number in each of them, and which one is
/// meant is never guessable from the number alone. Every coordinate that
/// crosses a boundary therefore says which space it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedSpace {
    /// The rows the child writes to. Row 0 is the top of the screen.
    Active,
    /// What is displayed. Equal to the active area until the user scrolls.
    Viewport,
    /// History and the active area together, oldest row first.
    Screen,
    /// History alone. Row 0 is the oldest row still retained, so eviction
    /// renumbers it.
    History,
}

impl ProjectedSpace {
    /// Temporary bridge for the core replay adapter.
    pub fn at(self, point: ProjectedPoint) -> Point {
        let at = PointCoordinate {
            x: point.column,
            y: point.row,
        };
        match self {
            Self::Active => Point::Active(at),
            Self::Viewport => Point::Viewport(at),
            Self::Screen => Point::Screen(at),
            Self::History => Point::History(at),
        }
    }

    /// Temporary bridge for the core replay adapter.
    pub fn space(self) -> PointSpace {
        match self {
            Self::Active => PointSpace::Active,
            Self::Viewport => PointSpace::Viewport,
            Self::Screen => PointSpace::Screen,
            Self::History => PointSpace::History,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedScreen {
    Primary,
    Alternate,
}

/// How the cursor is drawn.
///
/// The child asks for this with DECSCUSR, and the host resolves the ask against
/// the configured default. A client that chose the shape itself would be
/// deciding a terminal fact — which is why it is projected rather than read
/// from the application's settings on the way to the painter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedCursorShape {
    Block,
    BlockHollow,
    Bar,
    Underline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCursor {
    pub column: u16,
    pub row: u16,
    pub visible: bool,
    /// The cursor sits past the last column and the next character wraps. A
    /// client cannot infer this from the cells.
    pub pending_wrap: bool,
    pub shape: ProjectedCursorShape,
    /// Whether this cursor blinks. Not whether it is lit: the phase is the
    /// painter's, and no client would agree with another about it anyway.
    pub blinking: bool,
}

/// The modes that decide how input is encoded and what a client may do on its
/// own. Anything a client would otherwise guess belongs here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedModes {
    pub wraparound: bool,
    pub bracketed_paste: bool,
    pub application_cursor_keys: bool,
    pub application_keypad: bool,
    pub focus_events: bool,
    pub mouse_tracking: bool,
    pub insert: bool,
    pub reverse_video: bool,
    pub origin: bool,
}

/// The colours in force. The child can replace any of them at run time, so a
/// client holding its own theme as the truth would draw the wrong ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedColors {
    pub foreground: Option<ProjectedColor>,
    pub background: Option<ProjectedColor>,
    /// The first sixteen palette entries, which is what SGR 30-37 and 90-97
    /// select.
    pub palette: Vec<ProjectedColor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl From<RgbColor> for ProjectedColor {
    fn from(color: RgbColor) -> Self {
        Self {
            r: color.r,
            g: color.g,
            b: color.b,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRow {
    /// The row filled and the text continues on the next row. This is a row
    /// fact, not a newline.
    pub wrapped: bool,
    /// The row continues the one above it.
    pub continuation: bool,
    pub prompt: ProjectedPrompt,
    pub cells: Vec<ProjectedCell>,
}

impl ProjectedRow {
    /// The row's text, with the spacer cells of wide graphemes contributing
    /// nothing.
    pub fn text(&self) -> String {
        self.cells.iter().map(|cell| cell.text.as_str()).collect()
    }
}

/// OSC 133 marking. This is what makes "copy the output of that command"
/// answerable. The pinned parser marks rows with these three states, so this
/// enum is exhaustive over what it can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedPrompt {
    None,
    Prompt,
    PromptContinuation,
}

/// How many columns a grapheme occupies. The host owns this; frontend font
/// measurement may not change it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedWidth {
    /// One column.
    Narrow,
    /// Two columns; the text is on this cell.
    Wide,
    /// The second column of a wide grapheme. It carries no text and must not
    /// be drawn.
    SpacerTail,
    /// A blank cell inserted at the end of a row where a wide grapheme did not
    /// fit.
    SpacerHead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCell {
    /// One grapheme cluster, combining marks included. Empty for spacer cells.
    pub text: String,
    pub width: ProjectedWidth,
    pub bold: bool,
    pub foreground: Option<ProjectedColor>,
    pub background: Option<ProjectedColor>,
    pub selected: bool,
    /// The URI of an OSC 8 hyperlink on this cell, if it carries one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hyperlink: Option<String>,
}

/// Reads the host's current state and copies it out.
///
/// The parser is borrowed and not advanced. The render state is not: reading it
/// consumes the damage the parser recorded, so the damage this projection
/// reports is exactly what changed since the previous projection read through
/// the same render state. A caller that wants an answer without disturbing that
/// accounting uses its own render state and ignores the damage it reports.
pub fn project<'alloc>(
    terminal: &Terminal<'alloc, '_>,
    render: &mut RenderState<'alloc>,
) -> Result<TerminalProjection, String> {
    let columns = terminal.cols().map_err(read("terminal columns"))?;
    let rows = terminal.rows().map_err(read("terminal rows"))?;
    let (viewport, damage, cursor_visual) = project_viewport(terminal, render)?;
    Ok(TerminalProjection {
        columns,
        rows,
        screen: match terminal.active_screen().map_err(read("active screen"))? {
            Screen::Primary => ProjectedScreen::Primary,
            _ => ProjectedScreen::Alternate,
        },
        scrollback_rows: terminal
            .scrollback_rows()
            .map_err(read("scrollback rows"))?,
        cursor: project_cursor(terminal, cursor_visual)?,
        modes: project_modes(terminal)?,
        colors: project_colors(terminal)?,
        damage,
        viewport,
    })
}

/// How the cursor looks, which only the render snapshot answers.
///
/// The parser holds the DECSCUSR request; resolving it against the configured
/// default is the render state's, so both halves are read there and carried out
/// to the projection together.
#[derive(Debug, Clone, Copy)]
struct CursorVisual {
    shape: ProjectedCursorShape,
    blinking: bool,
}

fn project_cursor(
    terminal: &Terminal<'_, '_>,
    visual: CursorVisual,
) -> Result<ProjectedCursor, String> {
    Ok(ProjectedCursor {
        column: terminal.cursor_x().map_err(read("cursor column"))?,
        row: terminal.cursor_y().map_err(read("cursor row"))?,
        visible: terminal
            .is_cursor_visible()
            .map_err(read("cursor visibility"))?,
        pending_wrap: terminal
            .is_cursor_pending_wrap()
            .map_err(read("cursor pending wrap"))?,
        shape: visual.shape,
        blinking: visual.blinking,
    })
}

fn project_modes(terminal: &Terminal<'_, '_>) -> Result<ProjectedModes, String> {
    let mode = |mode: Mode, what: &'static str| terminal.mode(mode).map_err(read(what));
    Ok(ProjectedModes {
        wraparound: mode(Mode::WRAPAROUND, "wraparound mode")?,
        bracketed_paste: mode(Mode::BRACKETED_PASTE, "bracketed paste mode")?,
        application_cursor_keys: mode(Mode::DECCKM, "application cursor key mode")?,
        application_keypad: mode(Mode::KEYPAD_KEYS, "application keypad mode")?,
        focus_events: mode(Mode::FOCUS_EVENT, "focus event mode")?,
        mouse_tracking: terminal
            .is_mouse_tracking()
            .map_err(read("mouse tracking"))?,
        insert: mode(Mode::INSERT, "insert mode")?,
        reverse_video: mode(Mode::REVERSE_COLORS, "reverse video mode")?,
        origin: mode(Mode::ORIGIN, "origin mode")?,
    })
}

fn project_colors(terminal: &Terminal<'_, '_>) -> Result<ProjectedColors, String> {
    let palette = terminal.color_palette().map_err(read("color palette"))?;
    Ok(ProjectedColors {
        foreground: terminal
            .fg_color()
            .map_err(read("foreground color"))?
            .map(ProjectedColor::from),
        background: terminal
            .bg_color()
            .map_err(read("background color"))?
            .map(ProjectedColor::from),
        palette: (0..16)
            .map(|index| {
                ProjectedColor::from(palette.get(libghostty_vt::style::PaletteIndex(index)))
            })
            .collect(),
    })
}

/// Reads the viewport and the damage that came with it.
///
/// The two are one read because the parser reports damage through the same
/// snapshot that reports the rows, and because a caller that saw the rows has
/// been told what changed and must not be told again. Both layers of the
/// dependency's damage accounting are cleared here for that reason: the global
/// one and the per-row one, which it documents as independent.
fn project_viewport<'alloc>(
    terminal: &Terminal<'alloc, '_>,
    state: &mut RenderState<'alloc>,
) -> Result<(Vec<ProjectedRow>, ProjectedDamage, CursorVisual), String> {
    let snapshot = state.update(terminal).map_err(read("render snapshot"))?;
    let cursor_visual = CursorVisual {
        shape: match snapshot
            .cursor_visual_style()
            .map_err(read("cursor visual style"))?
        {
            CursorVisualStyle::Bar => ProjectedCursorShape::Bar,
            CursorVisualStyle::Underline => ProjectedCursorShape::Underline,
            CursorVisualStyle::BlockHollow => ProjectedCursorShape::BlockHollow,
            _ => ProjectedCursorShape::Block,
        },
        blinking: snapshot.cursor_blinking().map_err(read("cursor blink"))?,
    };
    let scope = match snapshot.dirty().map_err(read("render damage"))? {
        Dirty::Clean => ProjectedDamageScope::Clean,
        Dirty::Partial => ProjectedDamageScope::Partial,
        _ => ProjectedDamageScope::Full,
    };
    snapshot
        .set_dirty(Dirty::Clean)
        .map_err(read("render damage reset"))?;
    let mut damaged_rows = Vec::new();
    let mut row_iterator = RowIterator::new().map_err(read("row iterator"))?;
    let mut rows = row_iterator
        .update(&snapshot)
        .map_err(read("row iteration"))?;
    let mut cell_iterator = CellIterator::new().map_err(read("cell iterator"))?;

    let mut projected = Vec::new();
    let mut row_index = 0u16;
    while let Some(row) = rows.next() {
        if row.dirty().map_err(read("row damage"))? {
            damaged_rows.push(row_index);
            row.set_dirty(false).map_err(read("row damage reset"))?;
        }
        let raw = row.raw_row().map_err(read("raw row"))?;
        let wrapped = raw.is_wrapped().map_err(read("row wrap"))?;
        let continuation = raw
            .is_wrap_continuation()
            .map_err(read("row continuation"))?;
        let prompt = match raw.semantic_prompt().map_err(read("row semantic prompt"))? {
            RowSemanticPrompt::None => ProjectedPrompt::None,
            RowSemanticPrompt::Prompt => ProjectedPrompt::Prompt,
            RowSemanticPrompt::Continuation => ProjectedPrompt::PromptContinuation,
        };

        let mut cells = Vec::new();
        let mut cell_iteration = cell_iterator.update(row).map_err(read("cell iteration"))?;
        let mut column = 0u16;
        while let Some(cell) = cell_iteration.next() {
            let mut text = String::new();
            cell.graphemes_utf8(&mut text).map_err(read("cell text"))?;
            let width = match cell
                .raw_cell()
                .map_err(read("raw cell"))?
                .wide()
                .map_err(read("cell width"))?
            {
                CellWide::Narrow => ProjectedWidth::Narrow,
                CellWide::Wide => ProjectedWidth::Wide,
                CellWide::SpacerTail => ProjectedWidth::SpacerTail,
                _ => ProjectedWidth::SpacerHead,
            };
            cells.push(ProjectedCell {
                text,
                width,
                bold: cell.style().map_err(read("cell style"))?.bold,
                foreground: cell
                    .fg_color()
                    .map_err(read("cell foreground"))?
                    .map(ProjectedColor::from),
                background: cell
                    .bg_color()
                    .map_err(read("cell background"))?
                    .map(ProjectedColor::from),
                selected: cell.is_selected().map_err(read("cell selection"))?,
                hyperlink: hyperlink_at(terminal, column, row_index)?,
            });
            column += 1;
        }

        projected.push(ProjectedRow {
            wrapped,
            continuation,
            prompt,
            cells,
        });
        row_index += 1;
    }
    Ok((
        projected,
        ProjectedDamage {
            scope,
            rows: damaged_rows,
        },
        cursor_visual,
    ))
}

/// Reads a window of retained history.
///
/// The viewport is rendered; history is not. The render API reports the visible
/// rows only, so rows that scrolled behind the viewport are read through grid
/// references instead. `grid_rows` produces the same `ProjectedRow` values as
/// the render path, which `render_and_grid_reads_agree_on_the_same_rows` holds
/// to.
///
/// A request that runs past what history holds returns the rows that exist. It
/// is not an error: history shrinks whenever the terminal evicts, and a client
/// asking for what was there a moment ago must learn that, not fail.
pub fn project_history(
    terminal: &Terminal<'_, '_>,
    start_row: u32,
    rows: u32,
) -> Result<TerminalHistoryWindow, String> {
    let history_rows = terminal
        .scrollback_rows()
        .map_err(read("scrollback rows"))?;
    let retained = u32::try_from(history_rows).unwrap_or(u32::MAX);
    let count = rows.min(retained.saturating_sub(start_row));
    Ok(TerminalHistoryWindow {
        start_row,
        history_rows,
        rows: grid_rows(terminal, ProjectedSpace::History, start_row, count)?,
    })
}

/// Reads rows cell by cell through grid references.
///
/// Each reference resolves its row by walking the page list, so this reader
/// answers explicit reads and must not be put in a render loop. The render API
/// exists for that and is what the viewport uses.
fn grid_rows(
    terminal: &Terminal<'_, '_>,
    space: ProjectedSpace,
    first_row: u32,
    rows: u32,
) -> Result<Vec<ProjectedRow>, String> {
    let columns = terminal.cols().map_err(read("terminal columns"))?;
    let palette = terminal.color_palette().map_err(read("color palette"))?;
    let selection = terminal.selection().map_err(read("selection"))?;

    let mut projected = Vec::with_capacity(rows as usize);
    for offset in 0..rows {
        let row = first_row + offset;
        let mut wrapped = false;
        let mut continuation = false;
        let mut prompt = ProjectedPrompt::None;
        let mut cells = Vec::with_capacity(usize::from(columns));
        for column in 0..columns {
            let point = space.at(ProjectedPoint { column, row });
            let reference = terminal.grid_ref(point).map_err(read("grid reference"))?;
            if column == 0 {
                let raw = reference.row().map_err(read("row"))?;
                wrapped = raw.is_wrapped().map_err(read("row wrap"))?;
                continuation = raw
                    .is_wrap_continuation()
                    .map_err(read("row continuation"))?;
                prompt = match raw.semantic_prompt().map_err(read("row semantic prompt"))? {
                    RowSemanticPrompt::None => ProjectedPrompt::None,
                    RowSemanticPrompt::Prompt => ProjectedPrompt::Prompt,
                    RowSemanticPrompt::Continuation => ProjectedPrompt::PromptContinuation,
                };
            }
            let selected = match selection.as_ref() {
                Some(selection) => selection
                    .contains(terminal, point)
                    .map_err(read("cell selection"))?,
                None => false,
            };
            cells.push(grid_cell(&reference, &palette, selected)?);
        }
        projected.push(ProjectedRow {
            wrapped,
            continuation,
            prompt,
            cells,
        });
    }
    Ok(projected)
}

/// One cell, resolved the way the render path documents it.
///
/// The foreground comes from the style with palette indices looked up and no
/// bold handling applied. The background flattens the cell's own RGB or palette
/// background before falling back to the style. Both are `None` when nothing is
/// set, which means "the terminal default", not black.
fn grid_cell(
    reference: &GridRef<'_>,
    palette: &Palette,
    selected: bool,
) -> Result<ProjectedCell, String> {
    let cell = reference.cell().map_err(read("cell"))?;
    let style = reference.style().map_err(read("cell style"))?;
    let background = match cell.content_tag().map_err(read("cell content"))? {
        CellContentTag::BgColorRgb => Some(ProjectedColor::from(
            cell.bg_color_rgb().map_err(read("cell background"))?,
        )),
        CellContentTag::BgColorPalette => Some(ProjectedColor::from(
            palette.get(cell.bg_color_palette().map_err(read("cell background"))?),
        )),
        _ => palette_color(style.bg_color, palette),
    };
    Ok(ProjectedCell {
        text: grid_text(reference)?,
        width: match cell.wide().map_err(read("cell width"))? {
            CellWide::Narrow => ProjectedWidth::Narrow,
            CellWide::Wide => ProjectedWidth::Wide,
            CellWide::SpacerTail => ProjectedWidth::SpacerTail,
            _ => ProjectedWidth::SpacerHead,
        },
        bold: style.bold,
        foreground: palette_color(style.fg_color, palette),
        background,
        selected,
        hyperlink: hyperlink_of(reference)?,
    })
}

fn palette_color(color: StyleColor, palette: &Palette) -> Option<ProjectedColor> {
    match color {
        StyleColor::None => None,
        StyleColor::Palette(index) => Some(ProjectedColor::from(palette.get(index))),
        StyleColor::Rgb(color) => Some(ProjectedColor::from(color)),
    }
}

/// The grapheme cluster on one cell, combining marks included.
fn grid_text(reference: &GridRef<'_>) -> Result<String, String> {
    let mut buffer = ['\0'; STREAM_SAFE_CODEPOINTS];
    match reference.graphemes(&mut buffer) {
        Ok(length) => Ok(buffer[..length].iter().collect()),
        Err(libghostty_vt::Error::OutOfSpace { required }) => {
            let mut buffer = vec!['\0'; required];
            let length = reference
                .graphemes(&mut buffer)
                .map_err(read("cell text"))?;
            Ok(buffer[..length].iter().collect())
        }
        Err(error) => Err(read("cell text")(error)),
    }
}

/// The hyperlink on one cell, if it has one.
///
/// The URI is a grid fact rather than a render-cell fact, so it is read through
/// a grid reference at the same coordinate.
fn hyperlink_at(
    terminal: &Terminal<'_, '_>,
    column: u16,
    row: u16,
) -> Result<Option<String>, String> {
    let Ok(reference) = terminal.grid_ref(Point::Active(PointCoordinate {
        x: column,
        y: u32::from(row),
    })) else {
        return Ok(None);
    };
    hyperlink_of(&reference)
}

fn hyperlink_of(reference: &GridRef<'_>) -> Result<Option<String>, String> {
    let has_link = reference
        .cell()
        .and_then(|cell| cell.has_hyperlink())
        .unwrap_or(false);
    if !has_link {
        return Ok(None);
    }
    let mut uri = vec![0u8; MAX_HYPERLINK_URI_BYTES];
    let length = reference
        .hyperlink_uri(&mut uri)
        .map_err(read("hyperlink uri"))?;
    uri.truncate(length);
    Ok(Some(String::from_utf8_lossy(&uri).into_owned()))
}

fn read(what: &'static str) -> impl Fn(libghostty_vt::Error) -> String {
    move |error| format!("Failed to read {what}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retention::TerminalRetentionPolicy;
    use libghostty_vt::TerminalOptions;

    fn terminal(columns: u16, rows: u16) -> Terminal<'static, 'static> {
        Terminal::new(TerminalOptions {
            cols: columns,
            rows,
            max_scrollback: TerminalRetentionPolicy::default().bytes(),
        })
        .expect("the pinned parser constructs a terminal")
    }

    /// Reads through a render state of its own, so one test's damage
    /// accounting never becomes another's.
    fn project(terminal: &Terminal<'static, '_>) -> Result<TerminalProjection, String> {
        super::project(terminal, &mut RenderState::new().expect("render state"))
    }

    #[test]
    fn the_projection_carries_text_width_and_style() {
        let mut vt = terminal(24, 3);
        vt.vt_write("\x1b[1;38;2;10;20;30mbold\x1b[0m 中 e\u{301}".as_bytes());

        let projection = project(&vt).expect("the projection reads");
        assert_eq!((projection.columns, projection.rows), (24, 3));
        assert_eq!(
            projection.viewport.len(),
            3,
            "the whole viewport is present"
        );

        let row = &projection.viewport[0];
        assert!(row.text().starts_with("bold 中"));
        assert!(row.cells[0].bold);
        assert_eq!(
            row.cells[0].foreground,
            Some(ProjectedColor {
                r: 10,
                g: 20,
                b: 30
            })
        );
        assert!(!row.cells[5].bold, "SGR 0 ends the run");

        // A wide grapheme owns two cells, and the second one carries no text.
        let wide = row
            .cells
            .iter()
            .position(|cell| cell.text == "中")
            .expect("the wide grapheme is present");
        assert_eq!(row.cells[wide].width, ProjectedWidth::Wide);
        assert_eq!(row.cells[wide + 1].width, ProjectedWidth::SpacerTail);
        assert!(row.cells[wide + 1].text.is_empty());

        assert!(
            row.cells.iter().any(|cell| cell.text == "e\u{301}"),
            "a combining mark stays in one cell with its base: {:?}",
            row.text()
        );
    }

    #[test]
    fn soft_wrap_is_a_row_fact_and_not_a_newline() {
        let mut vt = terminal(10, 4);
        vt.vt_write(b"1234567890ABC");

        let projection = project(&vt).expect("the projection reads");
        assert!(projection.viewport[0].wrapped);
        assert!(projection.viewport[1].continuation);
        assert!(!projection.viewport[1].wrapped);
        assert_eq!(projection.viewport[0].text(), "1234567890");
        assert!(projection.viewport[1].text().starts_with("ABC"));
    }

    #[test]
    fn the_cursor_reports_what_the_cells_cannot_say() {
        let mut vt = terminal(10, 4);
        vt.vt_write(b"\x1b[2;4H");
        let projection = project(&vt).expect("the projection reads");
        assert_eq!((projection.cursor.column, projection.cursor.row), (3, 1));
        assert!(projection.cursor.visible);
        assert!(!projection.cursor.pending_wrap);

        vt.vt_write(b"\x1b[H1234567890\x1b[?25l");
        let projection = project(&vt).expect("the projection reads");
        assert!(
            projection.cursor.pending_wrap,
            "a full row leaves the cursor pending wrap, not on the next row"
        );
        assert_eq!(projection.cursor.row, 0);
        assert!(!projection.cursor.visible);
    }

    #[test]
    fn the_shape_the_child_asked_for_is_the_shape_the_client_is_told() {
        let mut vt = terminal(10, 4);
        let projection = project(&vt).expect("the projection reads");
        assert_eq!(projection.cursor.shape, ProjectedCursorShape::Block);
        assert!(!projection.cursor.blinking);

        // DECSCUSR. The odd parameter of each pair blinks, the even one does
        // not, which is the only place either fact exists.
        for (request, shape, blinking) in [
            (b"\x1b[5 q".as_slice(), ProjectedCursorShape::Bar, true),
            (b"\x1b[6 q".as_slice(), ProjectedCursorShape::Bar, false),
            (
                b"\x1b[3 q".as_slice(),
                ProjectedCursorShape::Underline,
                true,
            ),
            (b"\x1b[2 q".as_slice(), ProjectedCursorShape::Block, false),
            (b"\x1b[1 q".as_slice(), ProjectedCursorShape::Block, true),
        ] {
            vt.vt_write(request);
            let projection = project(&vt).expect("the projection reads");
            assert_eq!(
                (projection.cursor.shape, projection.cursor.blinking),
                (shape, blinking),
                "{} names one shape and one blink",
                String::from_utf8_lossy(request)
            );
        }
    }

    #[test]
    fn modes_the_client_would_otherwise_guess_are_reported() {
        let mut vt = terminal(20, 4);
        let before = project(&vt).expect("the projection reads").modes;
        assert!(before.wraparound);
        assert!(!before.bracketed_paste);
        assert!(!before.mouse_tracking);

        vt.vt_write(b"\x1b[?7l\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[4h");
        let after = project(&vt).expect("the projection reads").modes;
        assert!(!after.wraparound);
        assert!(after.bracketed_paste);
        assert!(after.application_cursor_keys);
        assert!(after.focus_events);
        assert!(after.mouse_tracking);
        assert!(after.insert);
    }

    #[test]
    fn the_child_owns_the_colors_the_projection_reports() {
        let mut vt = terminal(20, 4);
        vt.vt_write(b"\x1b]11;#204060\x1b\\\x1b]10;#a0b0c0\x1b\\\x1b]4;1;#010203\x1b\\");

        let colors = project(&vt).expect("the projection reads").colors;
        assert_eq!(
            colors.background,
            Some(ProjectedColor {
                r: 0x20,
                g: 0x40,
                b: 0x60
            })
        );
        assert_eq!(
            colors.foreground,
            Some(ProjectedColor {
                r: 0xa0,
                g: 0xb0,
                b: 0xc0
            })
        );
        assert_eq!(
            colors.palette[1],
            ProjectedColor {
                r: 0x01,
                g: 0x02,
                b: 0x03
            }
        );
    }

    #[test]
    fn the_alternate_screen_is_named_and_leaves_history_behind() {
        let mut vt = terminal(20, 4);
        vt.vt_write(b"primary\r\n");
        assert_eq!(
            project(&vt).expect("the projection reads").screen,
            ProjectedScreen::Primary
        );

        vt.vt_write(b"\x1b[?1049h");
        let projection = project(&vt).expect("the projection reads");
        assert_eq!(projection.screen, ProjectedScreen::Alternate);
        assert!(
            !projection.viewport[0].text().starts_with("primary"),
            "the alternate screen does not show the primary screen"
        );

        vt.vt_write(b"\x1b[?1049l");
        let projection = project(&vt).expect("the projection reads");
        assert_eq!(projection.screen, ProjectedScreen::Primary);
        assert!(projection.viewport[0].text().starts_with("primary"));
    }

    #[test]
    fn a_hyperlink_uri_is_a_cell_fact() {
        let mut vt = terminal(24, 3);
        vt.vt_write(b"\x1b]8;id=shipctl;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ plain");

        let row = project(&vt).expect("the projection reads").viewport[0].clone();
        assert_eq!(
            row.cells[0].hyperlink.as_deref(),
            Some("https://example.com/x")
        );
        assert_eq!(row.cells[5].hyperlink, None, "the plain text carries none");
    }

    #[test]
    fn projecting_twice_gives_the_same_answer() {
        let mut vt = terminal(20, 4);
        vt.vt_write(b"\x1b[1mstable\x1b[0m\r\nsecond");
        // Reading is not a mutation: nothing observed the first read.
        assert_eq!(
            project(&vt).expect("the projection reads"),
            project(&vt).expect("the projection reads")
        );
    }

    /// Damage is a difference, so it is the one fact that depends on who is
    /// asking and when. A render state kept across reads answers "since your
    /// last read"; the rows it names are the rows that changed.
    #[test]
    fn damage_reports_what_changed_since_the_reader_last_looked() {
        let mut vt = terminal(20, 4);
        let mut render = RenderState::new().expect("render state");

        vt.vt_write(b"first\r\nsecond");
        let first = super::project(&vt, &mut render).expect("the projection reads");
        assert_eq!(
            first.damage.scope,
            ProjectedDamageScope::Full,
            "a reader that has seen nothing is told everything changed"
        );

        let unchanged = super::project(&vt, &mut render).expect("the projection reads");
        assert_eq!(
            unchanged.damage,
            ProjectedDamage {
                scope: ProjectedDamageScope::Clean,
                rows: Vec::new()
            },
            "nothing happened between the two reads"
        );

        vt.vt_write(b"\x1b[3;1Hthird");
        let changed = super::project(&vt, &mut render).expect("the projection reads");
        assert_eq!(changed.damage.scope, ProjectedDamageScope::Partial);
        assert_eq!(
            changed.damage.rows,
            vec![1, 2],
            "the row written to, and the row the cursor left, both need repainting"
        );
        assert_eq!(changed.viewport[2].text().trim_end(), "third");

        // The cells are still whole in a partial frame: damage says what to
        // repaint, never what the projection left out.
        assert_eq!(changed.viewport[0].text().trim_end(), "first");
    }

    #[test]
    fn the_projection_survives_the_terminal_moving_on() {
        let mut vt = terminal(20, 4);
        vt.vt_write(b"first");
        let captured = project(&vt).expect("the projection reads");

        vt.vt_write(b"\x1b[2J\x1b[Hsecond");
        assert!(
            captured.viewport[0].text().starts_with("first"),
            "the copy is owned and does not follow the parser"
        );
        assert!(project(&vt).expect("the projection reads").viewport[0]
            .text()
            .starts_with("second"));
    }

    /// The gate the whole history story rests on.
    ///
    /// History cannot be rendered, so it is read through grid references. That
    /// is only trustworthy while both readers give the same answer for rows
    /// where both can read. If this fails, history rows are not the same kind
    /// of fact as viewport rows and nothing downstream may treat them as one.
    #[test]
    fn render_and_grid_reads_agree_on_the_same_rows() {
        let mut vt = terminal(24, 4);
        vt.vt_write("\x1b[1;31mbold\x1b[0m \x1b[48;5;4mbg\x1b[0m 中 e\u{301}\r\n".as_bytes());
        vt.vt_write(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\r\n");
        vt.vt_write(b"\x1b[38;2;10;20;30mtail");
        let selection = vt
            .select_all()
            .expect("the parser selects")
            .expect("the screen has content");
        vt.set_selection(Some(&selection))
            .expect("the parser holds the selection");

        let (rendered, _, _) =
            project_viewport(&vt, &mut RenderState::new().expect("render state"))
                .expect("the render path reads");
        let read = grid_rows(&vt, ProjectedSpace::Active, 0, rendered.len() as u32)
            .expect("the grid path reads");
        assert_eq!(read, rendered, "the two readers disagree");

        // The comparison is only worth something if the rows carry the facts
        // that could differ between the two readers.
        let cells: Vec<&ProjectedCell> = rendered.iter().flat_map(|row| &row.cells).collect();
        assert!(cells.iter().any(|cell| cell.bold));
        assert!(cells.iter().any(|cell| cell.selected));
        assert!(cells.iter().any(|cell| cell.hyperlink.is_some()));
        assert!(cells.iter().any(|cell| cell.width == ProjectedWidth::Wide));
        assert!(cells.iter().any(|cell| cell.background.is_some()));
        assert!(cells.iter().any(|cell| cell.foreground.is_some()));
    }

    #[test]
    fn rows_that_scroll_away_stay_readable_as_history() {
        let mut vt = terminal(10, 3);
        vt.vt_write(b"1234567890ABC\r\n");
        for line in 0..6 {
            vt.vt_write(format!("line{line}\r\n").as_bytes());
        }

        let window = project_history(&vt, 0, 3).expect("history reads");
        assert_eq!(window.start_row, 0);
        assert_eq!(window.rows.len(), 3);
        assert!(
            window.history_rows >= 3,
            "the rows written past the screen are retained"
        );
        assert_eq!(window.rows[0].text().trim_end(), "1234567890");
        assert!(
            window.rows[0].wrapped && window.rows[1].continuation,
            "a soft wrap stays a row fact after the rows leave the viewport"
        );
        assert_eq!(window.rows[1].text().trim_end(), "ABC");
        assert_eq!(window.rows[2].text().trim_end(), "line0");

        let later = project_history(&vt, 2, 2).expect("history reads");
        assert_eq!(later.start_row, 2);
        assert_eq!(
            later.rows[0], window.rows[2],
            "windows overlap consistently"
        );
    }

    #[test]
    fn a_history_window_reports_what_history_holds() {
        let mut vt = terminal(10, 2);
        for line in 0..5 {
            vt.vt_write(format!("line{line}\r\n").as_bytes());
        }

        let held = project_history(&vt, 0, u32::MAX).expect("history reads");
        assert_eq!(held.rows.len(), held.history_rows);

        // Asking past the end is how a client finds out that history moved,
        // so it answers with what exists instead of failing.
        let past = project_history(&vt, held.history_rows as u32, 4).expect("history reads");
        assert!(past.rows.is_empty());
        assert_eq!(past.history_rows, held.history_rows);

        // Why the clamp is not optional: the parser does not refuse a history
        // row past the end. It reads on into the active area, so an unclamped
        // window would hand a client live rows and call them history.
        let overrun = grid_rows(&vt, ProjectedSpace::History, held.history_rows as u32, 1)
            .expect("the parser reads past the end of history");
        let active = grid_rows(&vt, ProjectedSpace::Active, 0, 1).expect("the active area reads");
        assert_eq!(overrun, active);
    }

    #[test]
    fn the_projection_round_trips_as_json() {
        let mut vt = terminal(12, 2);
        vt.vt_write("\x1b[31m中\x1b[0m x".as_bytes());
        let projection = project(&vt).expect("the projection reads");

        let json = serde_json::to_string(&projection).expect("the projection serializes");
        let restored: TerminalProjection =
            serde_json::from_str(&json).expect("the projection deserializes");
        assert_eq!(projection, restored);
    }
}
