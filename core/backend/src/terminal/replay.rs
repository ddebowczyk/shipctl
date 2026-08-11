//! Continuous host VT state and exact xterm.js reset-target replay.
//!
//! The adapter is the production form of the fixture proof in
//! `research/20260809-124553-fut-tty/vt-proof`. Keep the replay compatibility
//! helpers in step with that proof when the pinned parser is upgraded.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use libghostty_vt::{
    fmt::{Format, Formatter, FormatterOptions},
    key, mouse, paste,
    screen::{CellWide, Screen, TrackedGridRef},
    selection::{FormatOptions, SelectLineOptions, SelectWordOptions, Selection},
    style::{Palette, PaletteIndex, RgbColor, Style, StyleColor, Underline},
    terminal::{ColorScheme, Mode, Point, PointCoordinate},
    Error, RenderState, Terminal, TerminalOptions,
};
use shipctl_module_api::TerminalColorTheme;

use super::effects::{TerminalClipboardContent, TerminalClipboardLocation, TerminalEffect};
use super::input::{focus_event, TerminalInput};
use super::projection::{
    ProjectedPoint, ProjectedSelectionMove, ProjectedSpace, TerminalAnchor, TerminalAnchorId,
    TerminalHistoryWindow, TerminalSelectionRequest, TerminalSelectionState,
};
use super::retention::TerminalRetentionPolicy;

/// What one parse step produced besides new screen state.
///
/// The two are separate because they go to opposite places: responses are
/// written back to the child and never reach a client, and effects reach
/// clients and are never written to the child.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TerminalFeed {
    pub responses: Vec<u8>,
    pub effects: Vec<TerminalEffect>,
}

fn push_effect(effects: &Arc<Mutex<Vec<TerminalEffect>>>, effect: TerminalEffect) {
    effects
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(effect);
}

pub struct VtReplayEngine {
    terminal: Terminal<'static, 'static>,
    responses: Arc<Mutex<Vec<u8>>>,
    /// Occurrences the parser reported during the current parse, in the order
    /// it reported them. The callbacks that fill this run inside `vt_write`, so
    /// the order is the child's order and not a reconstruction.
    effects: Arc<Mutex<Vec<TerminalEffect>>>,
    /// The render state the projection reads through.
    ///
    /// It is kept, not rebuilt, because damage is a difference and a fresh
    /// render state has nothing to differ from. One engine, one damage account:
    /// every projection reports what changed since the previous one.
    render: RenderState<'static>,
    color_scheme: Arc<Mutex<ColorScheme>>,
    /// The cells clients asked the host to keep pointing at. The tracked
    /// references live here, beside the terminal that moves them, and never
    /// leave: a client holds the handle only.
    anchors: HashMap<TerminalAnchorId, TrackedGridRef>,
    /// Handles are never reused, so a client that releases an anchor and asks
    /// again cannot be answered with a different cell.
    minted_anchors: u64,
    /// Whether a page has ever held a line for this terminal.
    ///
    /// The retention budget alone does not answer this. Retention is
    /// page-granular, so a nonzero budget below the page floor at a given
    /// geometry retains no rows at all. Watching history become non-empty is
    /// the statement that holds for every budget and every geometry.
    ///
    /// It stays true once set: a small budget evicts history back to empty, and
    /// such a terminal still reports the eviction.
    history_ever_retained: bool,
}

impl VtReplayEngine {
    pub fn new(
        cols: u16,
        rows: u16,
        theme: &TerminalColorTheme,
        retention: TerminalRetentionPolicy,
    ) -> Result<Self, String> {
        validate_dimensions(cols, rows)?;
        let responses = Arc::new(Mutex::new(Vec::new()));
        let color_scheme = Arc::new(Mutex::new(theme_color_scheme(theme)));
        let mut terminal = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: retention.bytes(),
        })
        .map_err(|error| format!("Failed to initialize terminal VT state: {error}"))?;

        terminal
            .on_pty_write({
                let responses = Arc::clone(&responses);
                move |_terminal, data| {
                    responses
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .extend_from_slice(data);
                }
            })
            .map_err(|error| format!("Failed to install terminal PTY responder: {error}"))?;
        terminal
            .on_color_scheme({
                let color_scheme = Arc::clone(&color_scheme);
                move |_terminal| {
                    Some(
                        *color_scheme
                            .lock()
                            .unwrap_or_else(|error| error.into_inner()),
                    )
                }
            })
            .map_err(|error| format!("Failed to install terminal color responder: {error}"))?;

        let effects = Arc::new(Mutex::new(Vec::new()));
        terminal
            .on_title_changed({
                let effects = Arc::clone(&effects);
                move |terminal| {
                    let title = terminal.title().unwrap_or_default().to_string();
                    push_effect(&effects, TerminalEffect::Title { title });
                }
            })
            .map_err(|error| format!("Failed to install terminal title reporter: {error}"))?;
        terminal
            .on_pwd_changed({
                let effects = Arc::clone(&effects);
                move |terminal| {
                    let uri = terminal.pwd().unwrap_or_default().to_string();
                    push_effect(&effects, TerminalEffect::WorkingDirectory { uri });
                }
            })
            .map_err(|error| format!("Failed to install terminal directory reporter: {error}"))?;
        terminal
            .on_bell({
                let effects = Arc::clone(&effects);
                move |_terminal| push_effect(&effects, TerminalEffect::Bell)
            })
            .map_err(|error| format!("Failed to install terminal bell reporter: {error}"))?;
        terminal
            .on_clipboard_write({
                let effects = Arc::clone(&effects);
                move |_terminal, write| {
                    push_effect(
                        &effects,
                        TerminalEffect::Clipboard {
                            location: TerminalClipboardLocation::from(write.location()),
                            contents: write
                                .contents()
                                .map(|content| TerminalClipboardContent {
                                    mime: content.mime.to_string(),
                                    data: content.data.to_string(),
                                })
                                .collect(),
                        },
                    );
                    // The host records the request; whether a clipboard exists
                    // to write to is a client question, and the protocols this
                    // callback serves ignore the answer anyway.
                    Ok(())
                }
            })
            .map_err(|error| format!("Failed to install terminal clipboard reporter: {error}"))?;

        let mut engine = Self {
            terminal,
            responses,
            effects,
            render: RenderState::new()
                .map_err(|error| format!("Failed to initialize terminal render state: {error}"))?,
            color_scheme,
            anchors: HashMap::new(),
            minted_anchors: 0,
            history_ever_retained: false,
        };
        engine.apply_theme(theme)?;
        // Applying the theme is a host action, not the child's, so nothing it
        // reported belongs to the child's stream.
        engine.take_effects();
        Ok(engine)
    }

    /// Parse bytes before they are published, returning the responses generated
    /// by this parse step for ordered write-back to the PTY and the occurrences
    /// the parse reported.
    ///
    /// The occurrences arrive through the parser's own callbacks, inside the
    /// write, so their order is the child's order and not a reconstruction.
    pub fn feed(&mut self, bytes: &[u8]) -> TerminalFeed {
        self.discard_responses();
        self.take_effects();
        self.terminal.vt_write(bytes);
        self.note_retained_history();
        TerminalFeed {
            responses: self.take_responses(),
            effects: self.take_effects(),
        }
    }

    /// The occurrences reported since the last read, in order.
    fn take_effects(&mut self) -> Vec<TerminalEffect> {
        std::mem::take(
            &mut *self
                .effects
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    /// Encode one semantic input into the bytes this terminal's child expects.
    ///
    /// Every answer depends on modes the child selected and the host holds:
    /// application cursor keys, the Kitty keyboard protocol, bracketed paste,
    /// mouse tracking and format, focus reporting. An input the current modes
    /// do not report encodes to nothing, which is the correct answer and not a
    /// failure — a mouse move with tracking off is not a message.
    pub fn encode_input(&mut self, input: &TerminalInput) -> Result<Vec<u8>, String> {
        let mut encoded = Vec::new();
        match input {
            TerminalInput::Key(event) => {
                if event.composing {
                    // A composing key produces no bytes. The input method
                    // sends the result as text when the person commits it.
                    return Ok(encoded);
                }
                let built = event.build()?;
                let mut encoder = key::Encoder::new()
                    .map_err(|error| format!("Failed to build a key encoder: {error}"))?;
                encoder.set_options_from_terminal(&self.terminal);
                encoder
                    .encode_to_vec(&built, &mut encoded)
                    .map_err(vt_error("encode a key"))?;
            }
            TerminalInput::Text { text } => encoded.extend_from_slice(text.as_bytes()),
            TerminalInput::Paste { text } => {
                let bracketed = self
                    .terminal
                    .mode(Mode::BRACKETED_PASTE)
                    .map_err(vt_error("read bracketed paste mode"))?;
                let mut payload = text.clone().into_bytes();
                encoded = encode_into_grown_buffer(payload.len(), |buffer| {
                    paste::encode(&mut payload, bracketed, buffer)
                })
                .map_err(vt_error("encode a paste"))?;
            }
            TerminalInput::Mouse(event) => {
                let (built, size) = event.build()?;
                let mut encoder = mouse::Encoder::new()
                    .map_err(|error| format!("Failed to build a mouse encoder: {error}"))?;
                encoder.set_options_from_terminal(&self.terminal);
                encoder.set_size(size);
                encoder.set_any_button_pressed(event.any_button_pressed);
                encoder
                    .encode_to_vec(&built, &mut encoded)
                    .map_err(vt_error("encode a pointer event"))?;
            }
            TerminalInput::Focus { gained } => {
                if self
                    .terminal
                    .mode(Mode::FOCUS_EVENT)
                    .map_err(vt_error("read focus reporting mode"))?
                {
                    let event = focus_event(*gained);
                    encoded = encode_into_grown_buffer(0, |buffer| event.encode(buffer))
                        .map_err(vt_error("encode a focus change"))?;
                }
            }
        }
        Ok(encoded)
    }

    /// The host's current state as owned Shipctl values.
    ///
    /// This reads the semantic API rather than the ANSI formatter, so it is the
    /// only answer to "what does the host believe" that does not go through a
    /// second parser. Reading advances no parse, but it does consume the damage
    /// the parse recorded, so each answer reports what changed since the one
    /// before it.
    pub fn project(&mut self) -> Result<super::projection::TerminalProjection, String> {
        super::projection::project(&self.terminal, &mut self.render)
    }

    /// The same state, read for a client that has painted nothing yet.
    ///
    /// A new attachment needs the whole screen, and it must not take the damage
    /// away from the readers already following the stream. This read therefore
    /// uses a render state of its own, which has seen no earlier frame and so
    /// reports the whole screen as changed.
    pub fn project_baseline(&mut self) -> Result<super::projection::TerminalProjection, String> {
        let mut baseline = RenderState::new().map_err(|error| error.to_string())?;
        super::projection::project(&self.terminal, &mut baseline)
    }

    /// A window of retained history as the same rows the viewport reports.
    pub fn project_history(
        &self,
        start_row: u32,
        rows: u32,
    ) -> Result<TerminalHistoryWindow, String> {
        super::projection::project_history(&self.terminal, start_row, rows)
    }

    /// Pins one cell and returns the handle a client keeps instead of a row
    /// number.
    ///
    /// The host holds the pin for as long as the client asks it to. Each pin
    /// adds work to every terminal mutation, so they are created on request and
    /// released on request, never on the host's own initiative.
    ///
    /// A history row past the end of history is refused here. The parser counts
    /// history coordinates from the oldest retained row and reads on into the
    /// active area rather than stopping at the end of history, so a client
    /// asking for a history row would otherwise be given a live one.
    pub fn anchor(
        &mut self,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<TerminalAnchor, String> {
        if space == ProjectedSpace::History {
            let history_rows = self.scrollback_rows()?;
            if at.row as usize >= history_rows {
                return Err(format!(
                    "Cannot anchor history row {}: history holds {history_rows} rows",
                    at.row
                ));
            }
        }
        let tracked = self
            .terminal
            .track_grid_ref(space.at(at))
            .map_err(vt_error("anchor a terminal cell"))?;
        self.minted_anchors += 1;
        let id = TerminalAnchorId(self.minted_anchors);
        let anchor = read_anchor(&self.terminal, id, &tracked, self.loss_reported()?)?;
        self.anchors.insert(id, tracked);
        Ok(anchor)
    }

    /// Where an anchor is now, or `None` when the host holds no such handle.
    pub fn resolve_anchor(&self, id: TerminalAnchorId) -> Result<Option<TerminalAnchor>, String> {
        let loss_reported = self.loss_reported()?;
        self.anchors
            .get(&id)
            .map(|tracked| read_anchor(&self.terminal, id, tracked, loss_reported))
            .transpose()
    }

    /// Whether this terminal can report the loss of an anchored line.
    ///
    /// Read on every anchor answer rather than cached alone, so a terminal that
    /// has just retained its first row corrects itself without waiting for the
    /// next parse step.
    fn loss_reported(&self) -> Result<bool, String> {
        Ok(self.history_ever_retained || self.scrollback_rows()? > 0)
    }

    fn note_retained_history(&mut self) {
        if !self.history_ever_retained {
            self.history_ever_retained = self.loss_reported().unwrap_or(false);
        }
    }

    /// Drops an anchor. Answers whether the host was holding it, so a client
    /// releasing twice learns the difference.
    pub fn release_anchor(&mut self, id: TerminalAnchorId) -> bool {
        self.anchors.remove(&id).is_some()
    }

    /// Anchors the host is holding for clients.
    pub fn anchor_count(&self) -> usize {
        self.anchors.len()
    }

    /// Apply one client selection intent and answer with what the host now
    /// holds.
    ///
    /// This is the whole selection surface a client boundary needs: one intent
    /// in, one state out. The individual operations below stay public because
    /// the host uses them directly, but nothing outside has to know which of
    /// them a given gesture becomes.
    pub fn apply_selection(
        &mut self,
        request: TerminalSelectionRequest,
    ) -> Result<TerminalSelectionState, String> {
        match request {
            TerminalSelectionRequest::Range {
                space,
                from,
                to,
                rectangle,
            } => self.select(space, from, to, rectangle)?,
            TerminalSelectionRequest::Word { space, at } => {
                self.select_word_at(space, at)?;
            }
            TerminalSelectionRequest::Line { space, at } => {
                self.select_line_at(space, at)?;
            }
            TerminalSelectionRequest::Output { space, at } => {
                self.select_output_at(space, at)?;
            }
            TerminalSelectionRequest::All => {
                self.select_all()?;
            }
            TerminalSelectionRequest::Extend { movement } => {
                self.extend_selection(movement)?;
            }
            TerminalSelectionRequest::Clear => self.clear_selection()?,
        }
        Ok(TerminalSelectionState {
            active: self.has_selection()?,
            text: self.selection_text()?,
        })
    }

    /// Select the cells between two points, as a drag does.
    ///
    /// The selection is installed on the terminal, so it reaches clients as the
    /// per-cell `selected` fact that every read already carries. Nothing about
    /// what a selection means — where a line wraps, where history starts, which
    /// cells a rectangle covers — leaves the host.
    pub fn select(
        &mut self,
        space: ProjectedSpace,
        from: ProjectedPoint,
        to: ProjectedPoint,
        rectangle: bool,
    ) -> Result<(), String> {
        let start = self
            .terminal
            .grid_ref(space.at(from))
            .map_err(vt_error("read a selection start"))?;
        let end = self
            .terminal
            .grid_ref(space.at(to))
            .map_err(vt_error("read a selection end"))?;
        let selection = Selection::new(start, end, rectangle);
        self.terminal
            .set_selection(Some(&selection))
            .map_err(vt_error("install a selection"))?;
        Ok(())
    }

    /// Select the word under a point, as a double click does. Answers whether
    /// there was a word there.
    pub fn select_word_at(
        &mut self,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<bool, String> {
        let reference = self
            .terminal
            .grid_ref(space.at(at))
            .map_err(vt_error("read a selection point"))?;
        let word = self
            .terminal
            .select_word(SelectWordOptions::new(reference))
            .map_err(vt_error("select a word"))?;
        self.install(word.as_ref())
    }

    /// Select the logical line under a point, as a triple click does. A wrapped
    /// line is one line here, which is the reason this is not a row range.
    pub fn select_line_at(
        &mut self,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<bool, String> {
        let reference = self
            .terminal
            .grid_ref(space.at(at))
            .map_err(vt_error("read a selection point"))?;
        let line = self
            .terminal
            .select_line(SelectLineOptions::new(reference))
            .map_err(vt_error("select a line"))?;
        self.install(line.as_ref())
    }

    /// Select what the command under a point printed, without its prompt.
    pub fn select_output_at(
        &mut self,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<bool, String> {
        let reference = self
            .terminal
            .grid_ref(space.at(at))
            .map_err(vt_error("read a selection point"))?;
        let output = self
            .terminal
            .select_output(reference)
            .map_err(vt_error("select command output"))?;
        self.install(output.as_ref())
    }

    pub fn select_all(&mut self) -> Result<bool, String> {
        let all = self
            .terminal
            .select_all()
            .map_err(vt_error("select everything"))?;
        self.install(all.as_ref())
    }

    /// Move the selection's active end without naming a cell.
    ///
    /// This is the drag that left the window, the keyboard extension, and the
    /// autoscroll: the host decides which cell the move reaches, including when
    /// that cell is in retained history. Answers whether there was a selection
    /// to move.
    pub fn extend_selection(&mut self, movement: ProjectedSelectionMove) -> Result<bool, String> {
        let Some(mut selection) = self
            .terminal
            .selection()
            .map_err(vt_error("read the current selection"))?
        else {
            return Ok(false);
        };
        selection
            .adjust(&self.terminal, movement.adjustment())
            .map_err(vt_error("extend a selection"))?;
        self.terminal
            .set_selection(Some(&selection))
            .map_err(vt_error("install a selection"))?;
        Ok(true)
    }

    pub fn clear_selection(&mut self) -> Result<(), String> {
        self.terminal
            .set_selection(None)
            .map_err(vt_error("clear the selection"))?;
        Ok(())
    }

    /// The selected text, copied out of the parser as an owned string.
    ///
    /// A wrapped line is joined here rather than by the client, because where
    /// the line wrapped is a host fact.
    pub fn selection_text(&self) -> Result<Option<String>, String> {
        let Some(selection) = self
            .terminal
            .selection()
            .map_err(vt_error("read the current selection"))?
        else {
            return Ok(None);
        };
        let copied = self
            .terminal
            .format_selection_alloc(
                None,
                FormatOptions::new()
                    .with_selection(&selection)
                    .with_unwrap(true),
            )
            .map_err(vt_error("copy the selected text"))?;
        copied
            .map(|bytes| {
                String::from_utf8(bytes.as_ref().to_vec())
                    .map_err(|error| format!("Selected text is not UTF-8: {error}"))
            })
            .transpose()
    }

    pub fn has_selection(&self) -> Result<bool, String> {
        Ok(self
            .terminal
            .selection()
            .map_err(vt_error("read the current selection"))?
            .is_some())
    }

    fn install(&self, selection: Option<&Selection<'_>>) -> Result<bool, String> {
        match selection {
            Some(selection) => {
                self.terminal
                    .set_selection(Some(selection))
                    .map_err(vt_error("install a selection"))?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Rows currently held in history. The host is the retention authority, so
    /// this is the only truthful answer to "how much history is there".
    pub fn scrollback_rows(&self) -> Result<usize, String> {
        self.terminal
            .scrollback_rows()
            .map_err(vt_error("read terminal scrollback rows"))
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        validate_dimensions(cols, rows)?;
        self.terminal
            .resize(cols, rows, 0, 0)
            .map_err(|error| format!("Failed to resize terminal VT state: {error}"))
    }

    /// Apply query-visible defaults and return an unsolicited color-scheme
    /// report only when the process enabled DEC mode 2031.
    pub fn set_theme(&mut self, theme: &TerminalColorTheme) -> Result<Vec<u8>, String> {
        self.apply_theme(theme)?;
        if !self
            .terminal
            .mode(Mode::COLOR_SCHEME_REPORT)
            .map_err(|error| format!("Failed to inspect color-report mode: {error}"))?
        {
            return Ok(Vec::new());
        }

        let mut response = [0u8; 32];
        let length = theme_color_scheme(theme)
            .encode_report(&mut response)
            .map_err(|error| format!("Failed to encode color-scheme report: {error}"))?;
        Ok(response[..length].to_vec())
    }

    /// Produce a reset-target replay without losing the inactive primary
    /// buffer while the alternate screen is active.
    pub fn replay(&mut self) -> Result<Vec<u8>, String> {
        self.discard_responses();
        let replay = if self
            .terminal
            .active_screen()
            .map_err(vt_error("inspect active terminal screen"))?
            == Screen::Primary
        {
            format_active_screen(&self.terminal)?
        } else {
            let alternate = format_active_screen(&self.terminal)?;
            self.terminal.vt_write(b"\x1b[?1049l");
            let primary = format_active_screen(&self.terminal)?;
            self.terminal.reset();
            self.terminal.vt_write(&primary);
            self.terminal.vt_write(&alternate);

            let mut replay = primary;
            replay.extend_from_slice(&alternate);
            replay
        };
        // Formatting/rebuilding state must never leak synthetic query replies
        // into the child stream.
        self.discard_responses();
        Ok(replay)
    }

    fn apply_theme(&mut self, theme: &TerminalColorTheme) -> Result<(), String> {
        let foreground = parse_rgb(&theme.foreground, "foreground")?;
        let background = parse_rgb(&theme.background, "background")?;
        let mut palette = Palette::default();
        for (index, value) in theme.palette.iter().enumerate() {
            let index = u8::try_from(index)
                .map_err(|_| "Terminal color palette has more than 256 entries".to_string())?;
            palette.set(
                PaletteIndex(index),
                parse_rgb(value, &format!("palette index {index}"))?,
            );
        }
        self.terminal
            .set_default_fg_color(Some(foreground))
            .and_then(|terminal| terminal.set_default_bg_color(Some(background)))
            .and_then(|terminal| terminal.set_default_color_palette(Some(palette)))
            .map_err(|error| format!("Failed to apply terminal color theme: {error}"))?;
        *self
            .color_scheme
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = theme_color_scheme(theme);
        Ok(())
    }

    fn take_responses(&self) -> Vec<u8> {
        std::mem::take(
            &mut *self
                .responses
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn discard_responses(&self) {
        self.responses
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}

/// Copies an anchor's position out of the tracked reference.
///
/// A cell is named differently in each space and is not named at all in some of
/// them, so every space is asked and the ones with no answer stay `None`.
///
/// The parser answers a history coordinate for cells that are not in history,
/// counting them from the oldest retained row as the screen space does. That
/// number would send a client to the wrong row, so it is kept only while it
/// names retained history, which is what `project_history` reads.
fn read_anchor(
    terminal: &Terminal<'_, '_>,
    id: TerminalAnchorId,
    tracked: &TrackedGridRef,
    loss_reported: bool,
) -> Result<TerminalAnchor, String> {
    let at = |space: ProjectedSpace| -> Result<Option<ProjectedPoint>, String> {
        Ok(tracked
            .point(space.space())
            .map_err(vt_error("read an anchor position"))?
            .map(|point| ProjectedPoint {
                column: point.x,
                row: point.y,
            }))
    };
    let history_rows = terminal
        .scrollback_rows()
        .map_err(vt_error("read terminal scrollback rows"))?;
    Ok(TerminalAnchor {
        id,
        retained: tracked.has_value(),
        loss_reported,
        history: at(ProjectedSpace::History)?.filter(|point| (point.row as usize) < history_rows),
        screen: at(ProjectedSpace::Screen)?,
        viewport: at(ProjectedSpace::Viewport)?,
        active: at(ProjectedSpace::Active)?,
    })
}

pub fn validate_dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("Terminal dimensions must be non-zero".to_string());
    }
    usize::from(cols)
        .checked_mul(usize::from(rows))
        .ok_or_else(|| "Terminal dimensions overflow the host cell count".to_string())?;
    Ok(())
}

fn parse_rgb(value: &str, field: &str) -> Result<RgbColor, String> {
    let value = value.trim();
    if value.len() != 7 || !value.starts_with('#') {
        return Err(format!("Terminal {field} must use #RRGGBB"));
    }
    let parse = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&value[range], 16)
            .map_err(|_| format!("Terminal {field} must use #RRGGBB"))
    };
    Ok(RgbColor {
        r: parse(1..3)?,
        g: parse(3..5)?,
        b: parse(5..7)?,
    })
}

fn theme_color_scheme(theme: &TerminalColorTheme) -> ColorScheme {
    let Ok(background) = parse_rgb(&theme.background, "background") else {
        return ColorScheme::Dark;
    };
    let luminance = 0.299 * f64::from(background.r)
        + 0.587 * f64::from(background.g)
        + 0.114 * f64::from(background.b);
    if luminance / 255.0 > 0.5 {
        ColorScheme::Light
    } else {
        ColorScheme::Dark
    }
}

fn vt_error(context: &'static str) -> impl FnOnce(Error) -> String {
    move |error| format!("Failed to {context}: {error}")
}

/// Run an encoder that writes into a caller-supplied buffer, growing the buffer
/// to whatever size it asks for.
///
/// The fixed-buffer encoders answer `OutOfSpace { required }` rather than
/// truncating, so the exact size is a fact the dependency reports. Nothing here
/// guesses one, and no input is capped by a number this host chose.
fn encode_into_grown_buffer(
    hint: usize,
    mut encode: impl FnMut(&mut [u8]) -> Result<usize, Error>,
) -> Result<Vec<u8>, Error> {
    let mut buffer = vec![0u8; hint];
    loop {
        match encode(&mut buffer) {
            Ok(written) => {
                buffer.truncate(written);
                return Ok(buffer);
            }
            Err(Error::OutOfSpace { required }) => buffer.resize(required, 0),
            Err(error) => return Err(error),
        }
    }
}

fn format_active_screen(terminal: &Terminal<'_, '_>) -> Result<Vec<u8>, String> {
    let cursor_x = terminal
        .cursor_x()
        .map_err(vt_error("read cursor column"))?;
    let cursor_y = terminal.cursor_y().map_err(vt_error("read cursor row"))?;
    let cursor_pending_wrap = terminal
        .is_cursor_pending_wrap()
        .map_err(vt_error("read cursor wrap state"))?;
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
    let mut formatter = Formatter::new(terminal, options)
        .map_err(vt_error("initialize terminal replay formatter"))?;
    let mut replay = formatter
        .format_alloc(None)
        .map_err(vt_error("format terminal replay"))?
        .as_ref()
        .to_vec();
    let active_hyperlink = last_osc8(&replay);
    append_hyperlink_cells(terminal, &mut replay)?;
    append_blank_wrap_continuations(terminal, &mut replay)?;
    append_cursor_cell(terminal, cursor_x, cursor_y, &mut replay)?;
    if !cursor_pending_wrap {
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
) -> Result<(), String> {
    let cursor_ref = terminal
        .grid_ref(Point::Active(PointCoordinate {
            x: cursor_x,
            y: u32::from(cursor_y),
        }))
        .map_err(vt_error("read terminal cursor cell"))?;
    let start_x = if cursor_ref
        .cell()
        .and_then(|cell| cell.wide())
        .map_err(vt_error("read terminal cursor cell width"))?
        == CellWide::SpacerTail
    {
        cursor_x
            .checked_sub(1)
            .ok_or_else(|| "Wide cursor spacer has no lead cell".to_string())?
    } else {
        cursor_x
    };
    let start_ref = terminal
        .grid_ref(Point::Active(PointCoordinate {
            x: start_x,
            y: u32::from(cursor_y),
        }))
        .map_err(vt_error("read terminal cursor lead cell"))?;
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
    let mut formatter = Formatter::new(terminal, options)
        .map_err(vt_error("initialize terminal cell formatter"))?;
    replay.extend_from_slice(format!("\x1b[{};{}H", cursor_y + 1, start_x + 1).as_bytes());
    replay.extend_from_slice(
        formatter
            .format_alloc(None)
            .map_err(vt_error("format terminal cursor cell"))?
            .as_ref(),
    );
    Ok(())
}

fn append_blank_wrap_continuations(
    terminal: &Terminal<'_, '_>,
    replay: &mut Vec<u8>,
) -> Result<(), String> {
    let cols = terminal.cols().map_err(vt_error("read terminal columns"))?;
    let rows = terminal.rows().map_err(vt_error("read terminal rows"))?;
    for y in 1..rows {
        let first = terminal
            .grid_ref(Point::Active(PointCoordinate {
                x: 0,
                y: u32::from(y),
            }))
            .map_err(vt_error("read wrapped terminal row"))?;
        if !first
            .row()
            .and_then(|row| row.is_wrap_continuation())
            .map_err(vt_error("read terminal wrap continuation"))?
            || !row_is_plain_blank(terminal, y)?
        {
            continue;
        }
        append_cursor_cell(terminal, cols - 1, y - 1, replay)?;
        replay.extend_from_slice(b"\x1b[0m\x1b[0\x22q\x1b]8;;\x1b\\ \x08\x1b[X");
    }
    Ok(())
}

fn row_is_plain_blank(terminal: &Terminal<'_, '_>, y: u16) -> Result<bool, String> {
    for x in 0..terminal.cols().map_err(vt_error("read terminal columns"))? {
        let cell = terminal
            .grid_ref(Point::Active(PointCoordinate { x, y: u32::from(y) }))
            .and_then(|grid| grid.cell())
            .map_err(vt_error("read terminal blank-row cell"))?;
        if cell.has_text().map_err(vt_error("inspect cell text"))?
            || cell
                .has_styling()
                .map_err(vt_error("inspect cell styling"))?
            || cell
                .has_hyperlink()
                .map_err(vt_error("inspect cell hyperlink"))?
            || cell
                .is_protected()
                .map_err(vt_error("inspect cell protection"))?
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
    (uri_start < payload.len()).then(|| sequence.to_vec())
}

fn append_hyperlink_cells(terminal: &Terminal<'_, '_>, replay: &mut Vec<u8>) -> Result<(), String> {
    for y in 0..terminal.rows().map_err(vt_error("read terminal rows"))? {
        for x in 0..terminal.cols().map_err(vt_error("read terminal columns"))? {
            let grid = terminal
                .grid_ref(Point::Active(PointCoordinate { x, y: u32::from(y) }))
                .map_err(vt_error("read terminal hyperlink cell"))?;
            if !grid
                .cell()
                .and_then(|cell| cell.has_hyperlink())
                .map_err(vt_error("inspect terminal hyperlink cell"))?
            {
                continue;
            }
            let graphemes = read_graphemes(&grid)?;
            if graphemes.is_empty() {
                continue;
            }
            let uri = read_hyperlink(&grid)?;
            replay.extend_from_slice(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
            replay.extend_from_slice(
                style_sequence(grid.style().map_err(vt_error("read terminal cell style"))?)
                    .as_bytes(),
            );
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

fn read_graphemes(grid: &libghostty_vt::screen::GridRef<'_>) -> Result<Vec<char>, String> {
    let mut output = Vec::new();
    loop {
        match grid.graphemes(&mut output) {
            Ok(length) => {
                output.truncate(length);
                return Ok(output);
            }
            Err(Error::OutOfSpace { required }) => output.resize(required, '\0'),
            Err(error) => return Err(format!("Failed to read terminal graphemes: {error}")),
        }
    }
}

fn read_hyperlink(grid: &libghostty_vt::screen::GridRef<'_>) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    loop {
        match grid.hyperlink_uri(&mut output) {
            Ok(length) => {
                output.truncate(length);
                return Ok(output);
            }
            Err(Error::OutOfSpace { required }) => output.resize(required, 0),
            Err(error) => return Err(format!("Failed to read terminal hyperlink: {error}")),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> TerminalColorTheme {
        TerminalColorTheme {
            foreground: "#eeeeee".to_string(),
            background: "#111111".to_string(),
            palette: vec!["#000000".to_string(); 16],
        }
    }

    /// The engine is where the product policy becomes physical retention. If
    /// this passes, no runtime can silently keep a different amount of history
    /// than the service committed.
    #[test]
    fn the_engine_retains_history_according_to_the_policy_it_was_given() {
        let feed_lines = |engine: &mut VtReplayEngine| {
            for _ in 0..3_000 {
                engine.feed(b"x\r\n");
            }
        };

        let mut none =
            VtReplayEngine::new(80, 24, &theme(), TerminalRetentionPolicy::from_bytes(0))
                .expect("engine");
        feed_lines(&mut none);
        assert_eq!(none.scrollback_rows().expect("rows"), 0);

        let mut budgeted =
            VtReplayEngine::new(80, 24, &theme(), TerminalRetentionPolicy::default())
                .expect("engine");
        feed_lines(&mut budgeted);
        assert!(budgeted.scrollback_rows().expect("rows") > 0);
    }

    /// A child that owns its colors keeps them when the user changes the app
    /// theme. `compat.rs` proves the child's OSC 4/10/11 state is readable, so
    /// a theme apply that overwrites it is discarding known state, not missing
    /// it. This test states the contract the end-state plan depends on; it
    /// records where today's engine does not meet it.
    #[test]
    fn a_theme_change_does_not_discard_colors_the_child_set_for_itself() {
        let mut engine =
            VtReplayEngine::new(20, 5, &theme(), TerminalRetentionPolicy::default()).unwrap();

        // The child claims a background, a foreground, and one palette slot.
        engine.feed(b"\x1b]11;#204060\x1b\\\x1b]10;#a0b0c0\x1b\\\x1b]4;1;#010203\x1b\\");

        let child_bg = RgbColor {
            r: 0x20,
            g: 0x40,
            b: 0x60,
        };
        let child_fg = RgbColor {
            r: 0xa0,
            g: 0xb0,
            b: 0xc0,
        };
        let child_slot = RgbColor {
            r: 0x01,
            g: 0x02,
            b: 0x03,
        };
        assert_eq!(engine.terminal.bg_color().unwrap(), Some(child_bg));
        assert_eq!(engine.terminal.fg_color().unwrap(), Some(child_fg));
        assert_eq!(
            engine
                .terminal
                .color_palette()
                .unwrap()
                .get(PaletteIndex(1)),
            child_slot
        );

        // The user switches the app theme. Nothing about that is a statement
        // about the colors the child chose.
        let new_theme = TerminalColorTheme {
            foreground: "#ffffff".to_string(),
            background: "#000000".to_string(),
            palette: vec!["#fefefe".to_string(); 16],
        };
        engine.set_theme(&new_theme).expect("apply theme");

        assert_eq!(
            engine.terminal.bg_color().unwrap(),
            Some(child_bg),
            "the child's OSC 11 background survives an app theme change"
        );
        assert_eq!(
            engine.terminal.fg_color().unwrap(),
            Some(child_fg),
            "the child's OSC 10 foreground survives an app theme change"
        );
        assert_eq!(
            engine
                .terminal
                .color_palette()
                .unwrap()
                .get(PaletteIndex(1)),
            child_slot,
            "the child's OSC 4 palette slot survives an app theme change"
        );

        // Guard against a vacuous pass. The three assertions above are only
        // meaningful if the theme apply actually did something, so prove it
        // reached the layer underneath the child's overrides.
        assert_eq!(
            engine.terminal.default_bg_color().unwrap(),
            Some(RgbColor {
                r: 0x00,
                g: 0x00,
                b: 0x00
            }),
            "the theme reached the host default layer beneath the child override"
        );
        assert_eq!(
            engine
                .terminal
                .color_palette()
                .unwrap()
                .get(PaletteIndex(2)),
            RgbColor {
                r: 0xfe,
                g: 0xfe,
                b: 0xfe
            },
            "a palette slot the child never claimed does follow the new theme"
        );
    }

    /// `RuntimeActor::resize` and `set_theme` both publish a replay, and the
    /// client installs one by calling `term.reset()` first. This test was
    /// written to show that a replay drops history. It does not: the replay
    /// carries every retained row. What a resize actually costs is the
    /// re-encoding of the whole retained buffer into ANSI, on every resize
    /// step and every theme change. Recorded here so no plan re-asserts a
    /// content loss that the engine does not have.
    #[test]
    fn a_replay_re_encodes_every_retained_row_so_its_cost_scales_with_history() {
        let mut engine =
            VtReplayEngine::new(20, 5, &theme(), TerminalRetentionPolicy::default()).unwrap();
        for line in 0..60 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }

        let retained = engine.scrollback_rows().expect("rows");
        assert!(
            retained > 0,
            "the engine retained scrolled-off rows, so history exists to lose"
        );

        let replay = engine.replay().expect("replay");
        let contains = |needle: &str| {
            replay
                .windows(needle.len())
                .any(|window| window == needle.as_bytes())
        };

        let missing: Vec<usize> = (0..60).filter(|n| !contains(&format!("line{n}"))).collect();
        assert!(
            missing.is_empty(),
            "the replay carries every retained row, not only the active screen; \
             missing rows would be {missing:?}"
        );

        // The cost is size, not loss. A replay is the whole retained buffer
        // re-encoded as ANSI, and resize and theme change each produce one.
        let bytes_per_row = replay.len() / (retained + 5);
        assert!(
            bytes_per_row > 0,
            "a replay re-encodes every retained row, so its size scales with \
             retention rather than with the screen"
        );
    }

    #[test]
    fn rejects_zero_dimensions_before_parser_allocation() {
        assert!(validate_dimensions(0, 24).is_err());
        assert!(validate_dimensions(80, 0).is_err());
    }

    /// The text of the row an anchor names, read back through the same reads a
    /// client has.
    fn anchored_text(engine: &mut VtReplayEngine, anchor: &TerminalAnchor) -> String {
        if let Some(at) = anchor.history {
            let window = engine.project_history(at.row, 1).expect("history reads");
            return window.rows[0].text().trim_end().to_string();
        }
        let at = anchor.active.expect("a retained anchor is named somewhere");
        // The viewport is the active area while nothing scrolled it away.
        engine.project().expect("the projection reads").viewport[at.row as usize]
            .text()
            .trim_end()
            .to_string()
    }

    /// The claim area 03 rests on: a client can keep pointing at one line
    /// without holding a row number, because row numbers move and the anchor
    /// moves with the line instead.
    #[test]
    fn an_anchor_follows_its_line_through_scrolling_and_resize() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"anchored\r\n");

        let anchor = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host anchors a cell");
        assert!(anchor.retained);
        assert_eq!(anchored_text(&mut engine, &anchor), "anchored");

        for line in 0..8 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        let scrolled = engine
            .resolve_anchor(anchor.id)
            .expect("the anchor reads")
            .expect("the host still holds the handle");
        assert!(scrolled.retained);
        assert_ne!(
            scrolled.active, anchor.active,
            "the line is no longer where it was"
        );
        assert_eq!(anchored_text(&mut engine, &scrolled), "anchored");

        engine.resize(24, 3).expect("the engine resizes");
        let reflowed = engine
            .resolve_anchor(anchor.id)
            .expect("the anchor reads")
            .expect("the host still holds the handle");
        assert!(reflowed.retained);
        assert_eq!(
            anchored_text(&mut engine, &reflowed),
            "anchored",
            "reflow moved the line and the anchor went with it"
        );
    }

    /// A history budget small enough that eviction happens inside a test.
    ///
    /// Measured, not chosen: at the 80-column geometry below it retains 655
    /// rows, so the 3,000 lines the test writes evict the oldest several times
    /// over. It is a test input and says nothing about what the product offers.
    const EVICTING_BUDGET_BYTES: usize = 64 * 1024;

    #[test]
    fn an_evicted_anchor_says_so_instead_of_naming_another_line() {
        let mut engine = VtReplayEngine::new(
            80,
            3,
            &theme(),
            TerminalRetentionPolicy::from_bytes(EVICTING_BUDGET_BYTES),
        )
        .unwrap();
        engine.feed(b"oldest\r\n");
        for line in 0..20 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        let anchor = engine
            .anchor(
                ProjectedSpace::History,
                ProjectedPoint { column: 0, row: 0 },
            )
            .expect("the host anchors a cell");
        assert!(anchor.retained);
        assert!(
            anchor.loss_reported,
            "history holds lines here, so a lost line is evicted from a page and reported"
        );
        assert_eq!(anchored_text(&mut engine, &anchor), "oldest");

        for line in 0..3_000 {
            engine.feed(format!("x{line}\r\n").as_bytes());
        }
        assert_ne!(
            engine.project_history(0, 1).unwrap().rows[0]
                .text()
                .trim_end(),
            "oldest",
            "history row 0 is a different line now, which is why it is not an identity"
        );

        let evicted = engine
            .resolve_anchor(anchor.id)
            .expect("the anchor reads")
            .expect("the handle is still answerable");
        assert!(
            !evicted.retained,
            "the line left the terminal and the anchor reports it"
        );
        assert!(evicted.loss_reported);
        assert_eq!(evicted.history, None);
        assert_eq!(evicted.screen, None);
        assert_eq!(evicted.active, None);

        // A row number would name whatever moved in. A handle is never reused,
        // so it cannot.
        let fresh = engine
            .anchor(
                ProjectedSpace::History,
                ProjectedPoint { column: 0, row: 0 },
            )
            .expect("the host anchors a cell");
        assert_ne!(fresh.id, anchor.id);
    }

    /// Where the anchor cannot be trusted, and why the limit is recorded rather
    /// than worked around.
    ///
    /// With no history budget, a line that scrolls off is not evicted from
    /// history; there is no history to evict it from. The pinned parser keeps
    /// the tracked reference on the active row instead, so the anchor names the
    /// line that replaced the anchored one and reports itself retained. A
    /// client on a zero-retention terminal therefore cannot anchor a line it
    /// expects to scroll away. If a later revision of the parser reports this,
    /// this test fails and the limit is lifted.
    ///
    /// The host does not leave a client to discover this: the anchor says its
    /// loss is not reported, so `retained` is not to be believed on it.
    #[test]
    fn with_no_history_a_scrolled_off_anchor_names_the_line_that_replaced_it() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::from_bytes(0)).unwrap();
        engine.feed(b"gone\r\n");
        let anchor = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host anchors a cell");
        assert!(
            !anchor.loss_reported,
            "no page can hold a line here, so no loss can be reported"
        );
        assert_eq!(anchored_text(&mut engine, &anchor), "gone");

        for line in 0..6 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        assert_eq!(engine.scrollback_rows().unwrap(), 0, "nothing is retained");

        let stale = engine
            .resolve_anchor(anchor.id)
            .expect("the anchor reads")
            .expect("the handle is still answerable");
        assert!(stale.retained);
        assert_eq!(stale.active, Some(ProjectedPoint { column: 0, row: 0 }));
        assert_ne!(
            anchored_text(&mut engine, &stale),
            "gone",
            "the anchored line is gone and the parser did not say so"
        );
        assert!(
            !stale.loss_reported,
            "the same anchor that reports itself retained also reports that its \
             loss cannot be seen, which is the fact a client acts on"
        );
    }

    /// The host declares what it knows about loss instead of guessing at it, so
    /// the fact tracks the terminal rather than the moment the anchor was made.
    ///
    /// A terminal that has not yet scrolled a line into history has proved
    /// nothing about retention, so it says loss is not reported. It corrects
    /// itself as soon as a page holds a line, for anchors made before that too.
    #[test]
    fn a_terminal_reports_loss_once_a_page_holds_a_line() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"first\r\n");
        assert_eq!(engine.scrollback_rows().unwrap(), 0);

        let anchor = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host anchors a cell");
        assert!(
            !anchor.loss_reported,
            "nothing has been retained yet, so nothing proves a loss would be reported"
        );

        for line in 0..6 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        assert!(engine.scrollback_rows().unwrap() > 0);

        let resolved = engine
            .resolve_anchor(anchor.id)
            .expect("the anchor reads")
            .expect("the host still holds the handle");
        assert!(
            resolved.loss_reported,
            "the same anchor corrects itself once history holds a line"
        );
        assert_eq!(anchored_text(&mut engine, &resolved), "first");
    }

    /// The parser reads a history coordinate on into the active area instead of
    /// stopping at the end of history, so asking for history row 0 on a
    /// terminal with no history would pin a live row and call it history.
    #[test]
    fn a_history_anchor_past_the_end_of_history_is_refused() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"live\r\n");
        assert_eq!(engine.scrollback_rows().unwrap(), 0);
        engine
            .anchor(
                ProjectedSpace::History,
                ProjectedPoint { column: 0, row: 0 },
            )
            .expect_err("there is no history row to anchor");
        assert_eq!(engine.anchor_count(), 0);

        // The same row is anchorable in the space that actually names it.
        engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the live row is anchorable as a live row");

        for line in 0..6 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        let history_rows = engine.scrollback_rows().unwrap();
        assert!(history_rows > 0);
        engine
            .anchor(
                ProjectedSpace::History,
                ProjectedPoint {
                    column: 0,
                    row: history_rows as u32 - 1,
                },
            )
            .expect("the last retained row is anchorable");
        engine
            .anchor(
                ProjectedSpace::History,
                ProjectedPoint {
                    column: 0,
                    row: history_rows as u32,
                },
            )
            .expect_err("one row past the end is the active area, not history");
    }

    #[test]
    fn the_host_holds_anchors_only_while_a_client_asks_it_to() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"pinned\r\n");
        assert_eq!(engine.anchor_count(), 0);

        let first = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .unwrap();
        let second = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 2, row: 0 })
            .unwrap();
        assert_eq!(engine.anchor_count(), 2);

        assert!(engine.release_anchor(first.id));
        assert!(
            !engine.release_anchor(first.id),
            "releasing twice is answered rather than repeated"
        );
        assert!(engine.resolve_anchor(first.id).unwrap().is_none());
        assert!(engine.resolve_anchor(second.id).unwrap().is_some());
        assert_eq!(engine.anchor_count(), 1);
    }

    /// The other half of the claim: what crosses a boundary is a number and
    /// coordinates, with nothing of the parser in it.
    #[test]
    fn an_anchor_round_trips_as_json() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"anchored\r\n");
        let anchor = engine
            .anchor(ProjectedSpace::Active, ProjectedPoint { column: 3, row: 0 })
            .unwrap();

        let json = serde_json::to_string(&anchor).expect("the anchor serializes");
        assert!(
            json.contains("\"lossReported\""),
            "a client reads whether loss is reported off the wire: {json}"
        );
        let restored: TerminalAnchor =
            serde_json::from_str(&json).expect("the anchor deserializes");
        assert_eq!(restored, anchor);
    }

    /// Area 01 criterion 7. A selection is a host fact: the client names cells
    /// or directions, and the host decides which cells that covers. These are
    /// the cases beyond word, line and range helpers — a drag, an extension the
    /// client did not spell out, a wrapped line, the alternate screen, and
    /// retained history.
    #[test]
    fn a_drag_selects_the_cells_between_two_points() {
        let mut engine =
            VtReplayEngine::new(24, 4, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"alpha beta gamma\r\n");

        engine
            .select(
                ProjectedSpace::Active,
                ProjectedPoint { column: 0, row: 0 },
                ProjectedPoint { column: 4, row: 0 },
                false,
            )
            .expect("the host selects a range");
        assert_eq!(engine.selection_text().unwrap().as_deref(), Some("alpha"));

        // The per-cell fact every read already carries follows the selection.
        let selected: String = engine.project().unwrap().viewport[0]
            .cells
            .iter()
            .filter(|cell| cell.selected)
            .map(|cell| cell.text.as_str())
            .collect();
        assert_eq!(selected, "alpha");

        engine.clear_selection().expect("the host clears it");
        assert!(!engine.has_selection().unwrap());
        assert_eq!(engine.selection_text().unwrap(), None);
        assert!(engine.project().unwrap().viewport[0]
            .cells
            .iter()
            .all(|cell| !cell.selected));
    }

    /// A wrapped line is one line. A client that selected it as two row ranges
    /// would be deciding where the line broke, which is the host's fact.
    #[test]
    fn a_wrapped_line_selects_and_copies_as_one_line() {
        let mut engine =
            VtReplayEngine::new(20, 5, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"abcdefghijklmnopqrstuvwxyz0123\r\n");
        let state = engine.project().unwrap();
        assert!(
            state.viewport[0].wrapped && state.viewport[1].continuation,
            "the subject must actually be a wrapped line"
        );

        assert!(engine
            .select_line_at(ProjectedSpace::Active, ProjectedPoint { column: 2, row: 0 })
            .expect("the host selects a line"));
        assert_eq!(
            engine.selection_text().unwrap().as_deref(),
            Some("abcdefghijklmnopqrstuvwxyz0123"),
            "the selection crossed the wrap without the client knowing where it was"
        );
    }

    /// The drag that left the window, and the keyboard extension. The client
    /// says which way; the host says which cell.
    #[test]
    fn extending_a_selection_reaches_cells_the_client_never_named() {
        let mut engine =
            VtReplayEngine::new(24, 4, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"alpha beta gamma\r\n");

        assert!(
            !engine
                .extend_selection(ProjectedSelectionMove::Right)
                .unwrap(),
            "with nothing selected there is nothing to extend"
        );

        assert!(engine
            .select_word_at(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host selects a word"));
        assert_eq!(engine.selection_text().unwrap().as_deref(), Some("alpha"));

        assert!(engine
            .extend_selection(ProjectedSelectionMove::EndOfLine)
            .unwrap());
        assert_eq!(
            engine.selection_text().unwrap().as_deref(),
            Some("alpha beta gamma"),
            "the host resolved the edge of the line, not the client"
        );
    }

    /// Autoscroll: an extension that runs off the top of the screen reaches
    /// rows that are no longer on it. History is where selection meets
    /// retention, and neither is the client's to decide.
    #[test]
    fn a_selection_extended_upward_reaches_retained_history() {
        let mut engine =
            VtReplayEngine::new(12, 3, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"oldest\r\n");
        for line in 0..8 {
            engine.feed(format!("line{line}\r\n").as_bytes());
        }
        assert!(engine.scrollback_rows().unwrap() > 0);

        assert!(engine
            .select_word_at(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host selects a word on screen"));

        for _ in 0..12 {
            engine
                .extend_selection(ProjectedSelectionMove::Up)
                .expect("the host extends the selection");
        }

        let history = engine
            .project_history(0, u32::MAX)
            .expect("the host reads history");
        assert!(
            history
                .rows
                .iter()
                .any(|row| row.cells.iter().any(|cell| cell.selected)),
            "the extension never reached history, so this proves nothing about autoscroll"
        );
        let copied = engine.selection_text().unwrap().unwrap_or_default();
        assert!(
            copied.contains("oldest"),
            "the copied text stops at the screen edge: {copied:?}"
        );
    }

    /// The alternate screen has its own cells and its own selection. A client
    /// that kept selection state across the switch would be holding a second
    /// answer.
    #[test]
    fn selection_applies_to_the_alternate_screen_it_was_made_on() {
        let mut engine =
            VtReplayEngine::new(24, 4, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(b"primary text\r\n\x1b[?1049h\x1b[Halternate text\r\n");

        assert!(engine
            .select_word_at(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 0 })
            .expect("the host selects a word on the alternate screen"));
        assert_eq!(
            engine.selection_text().unwrap().as_deref(),
            Some("alternate")
        );

        engine.feed(b"\x1b[?1049l");
        let restored = engine.project().unwrap();
        assert!(restored.viewport[0].text().starts_with("primary"));
        assert!(
            restored
                .viewport
                .iter()
                .all(|row| row.cells.iter().all(|cell| !cell.selected)),
            "a selection made on the alternate screen does not mark the primary one"
        );
    }

    /// "Copy the output of that command" is a host answer, because only the
    /// host holds the OSC 133 marks that say where the output starts and ends.
    #[test]
    fn the_host_selects_the_output_of_one_command() {
        let mut engine =
            VtReplayEngine::new(24, 6, &theme(), TerminalRetentionPolicy::default()).unwrap();
        engine.feed(
            b"\x1b]133;A\x1b\\$ ls\r\n\x1b]133;C\x1b\\file-one\r\nfile-two\r\n\x1b]133;D\x1b\\",
        );

        assert!(engine
            .select_output_at(ProjectedSpace::Active, ProjectedPoint { column: 0, row: 1 })
            .expect("the host selects command output"));
        let output = engine.selection_text().unwrap().unwrap_or_default();
        assert!(
            output.contains("file-one") && output.contains("file-two"),
            "the output block did not come back whole: {output:?}"
        );
        assert!(
            !output.contains("$ ls"),
            "the command line is not its output: {output:?}"
        );
    }

    #[test]
    fn parses_output_before_replay_and_answers_queries_once() {
        let mut engine =
            VtReplayEngine::new(20, 5, &theme(), TerminalRetentionPolicy::default()).unwrap();
        let feed = engine.feed(b"early\x1b[2;4H\x1b[6n");

        assert_eq!(feed.responses, b"\x1b[2;4R");
        assert!(
            feed.effects.is_empty(),
            "a cursor report is an answer to the child, not an occurrence a client hears"
        );
        assert!(engine
            .replay()
            .unwrap()
            .windows(b"early".len())
            .any(|window| window == b"early"));
    }
}
