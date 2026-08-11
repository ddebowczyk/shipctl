//! Semantic terminal input, owned by Shipctl and encoded by the host.
//!
//! A client reports what the person did — this physical key with these
//! modifiers, this composed text, this paste, this pointer position, the
//! window gained focus — and never what bytes that should become. Which bytes
//! it becomes depends on the modes the child selected: application cursor
//! keys, the Kitty keyboard protocol, bracketed paste, mouse tracking and
//! format, focus reporting. All of those live in the host's parser, so the
//! encoding lives there too.
//!
//! This is the input half of the same rule the projection states for output:
//! the host holds the meaning, and no client keeps a second copy of the rules.

use libghostty_vt::{
    focus,
    key::{self, Key, Mods},
    mouse, paste,
};
use serde::{Deserialize, Serialize};

/// One thing a person did, as the client observed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TerminalInput {
    Key(TerminalKeyEvent),
    /// Text an input method committed. It carries no key, because a
    /// composition has none: the client reports the result of composing.
    Text {
        text: String,
    },
    /// A paste. Bracketed or not is the child's mode, not the client's choice.
    Paste {
        text: String,
    },
    Mouse(TerminalMouseEvent),
    Focus {
        gained: bool,
    },
}

/// Modifier keys held when something happened.
///
/// Named rather than a bitmask, so a client cannot send a bit this host does
/// not understand and a reader of the wire can see what was held.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalModifiers {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    /// The command key on macOS, the Windows key elsewhere.
    pub meta: bool,
    pub caps_lock: bool,
    pub num_lock: bool,
}

impl TerminalModifiers {
    fn mods(self) -> Mods {
        let mut mods = Mods::empty();
        mods.set(Mods::SHIFT, self.shift);
        mods.set(Mods::ALT, self.alt);
        mods.set(Mods::CTRL, self.ctrl);
        mods.set(Mods::SUPER, self.meta);
        mods.set(Mods::CAPS_LOCK, self.caps_lock);
        mods.set(Mods::NUM_LOCK, self.num_lock);
        mods
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKeyAction {
    Press,
    Release,
    Repeat,
}

impl TerminalKeyAction {
    fn action(self) -> key::Action {
        match self {
            Self::Press => key::Action::Press,
            Self::Release => key::Action::Release,
            Self::Repeat => key::Action::Repeat,
        }
    }
}

/// A key, named by where it is on the keyboard.
///
/// `code` is the W3C `KeyboardEvent.code` name, which names the physical key
/// and not what it produces. That is the right identity: what the key produces
/// depends on the layout, which the client already applied to produce `text`,
/// while the escape sequence for a function or arrow key depends on the key
/// itself and on modes only the host knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKeyEvent {
    pub action: TerminalKeyAction,
    /// A W3C key code name, such as `KeyC`, `ArrowUp` or `F5`.
    pub code: String,
    /// What the key produces under the current layout, unmodified by Ctrl or
    /// Meta. `None` for keys that produce no text.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub mods: TerminalModifiers,
    /// Whether the key is part of an in-progress composition. A composing key
    /// produces no bytes; the commit arrives as `Text`.
    #[serde(default)]
    pub composing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMouseAction {
    Press,
    Release,
    Motion,
}

impl TerminalMouseAction {
    fn action(self) -> mouse::Action {
        match self {
            Self::Press => mouse::Action::Press,
            Self::Release => mouse::Action::Release,
            Self::Motion => mouse::Action::Motion,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMouseButton {
    Left,
    Middle,
    Right,
    Four,
    Five,
    Six,
    Seven,
    Eight,
    Nine,
    Ten,
    Eleven,
}

impl TerminalMouseButton {
    fn button(self) -> mouse::Button {
        match self {
            Self::Left => mouse::Button::Left,
            Self::Middle => mouse::Button::Middle,
            Self::Right => mouse::Button::Right,
            Self::Four => mouse::Button::Four,
            Self::Five => mouse::Button::Five,
            Self::Six => mouse::Button::Six,
            Self::Seven => mouse::Button::Seven,
            Self::Eight => mouse::Button::Eight,
            Self::Nine => mouse::Button::Nine,
            Self::Ten => mouse::Button::Ten,
            Self::Eleven => mouse::Button::Eleven,
        }
    }
}

/// How the client drew the terminal, in pixels.
///
/// The host knows how many cells there are; only the client knows how large it
/// drew them. A pointer position is a pixel until this says otherwise, and the
/// pixel formats report pixels, so the geometry travels with the event that
/// needs it rather than being remembered as a second copy of the layout.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSurfaceGeometry {
    pub screen_width: f64,
    pub screen_height: f64,
    pub cell_width: f64,
    pub cell_height: f64,
    #[serde(default)]
    pub padding_top: f64,
    #[serde(default)]
    pub padding_bottom: f64,
    #[serde(default)]
    pub padding_left: f64,
    #[serde(default)]
    pub padding_right: f64,
}

impl TerminalSurfaceGeometry {
    fn normalize(self, x: f64, y: f64) -> Result<(mouse::Position, mouse::EncoderSize), String> {
        let horizontal = normalize_axis(
            "horizontal",
            x,
            self.screen_width,
            self.cell_width,
            self.padding_left,
            self.padding_right,
        )?;
        let vertical = normalize_axis(
            "vertical",
            y,
            self.screen_height,
            self.cell_height,
            self.padding_top,
            self.padding_bottom,
        )?;
        Ok((
            mouse::Position {
                x: horizontal.position,
                y: vertical.position,
            },
            mouse::EncoderSize {
                screen_width: horizontal.screen,
                screen_height: vertical.screen,
                cell_width: horizontal.cell,
                cell_height: vertical.cell,
                padding_top: vertical.leading_padding,
                padding_bottom: vertical.trailing_padding,
                padding_left: horizontal.leading_padding,
                padding_right: horizontal.trailing_padding,
            },
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct NormalizedAxis {
    position: f32,
    screen: u32,
    cell: u32,
    leading_padding: u32,
    trailing_padding: u32,
}

/// Adapt browser CSS pixels to the integer geometry required by Ghostty.
///
/// The scale is derived from the measured cell. Applying it to both the
/// position and the remaining geometry keeps every cell boundary in the same
/// place. This matters more than preserving the original CSS-pixel unit: the
/// terminal protocols ultimately address either the normalized pixel or the
/// cell that contains it.
fn normalize_axis(
    name: &str,
    position: f64,
    screen: f64,
    cell: f64,
    leading_padding: f64,
    trailing_padding: f64,
) -> Result<NormalizedAxis, String> {
    for (field, value) in [
        ("position", position),
        ("screen", screen),
        ("cell", cell),
        ("leading padding", leading_padding),
        ("trailing padding", trailing_padding),
    ] {
        if !value.is_finite() {
            return Err(format!(
                "Cannot encode a pointer position: the {name} {field} is not finite"
            ));
        }
    }
    if cell <= 0.0 || screen < 0.0 || leading_padding < 0.0 || trailing_padding < 0.0 {
        return Err(format!(
            "Cannot encode a pointer position: the {name} geometry has a negative or zero size"
        ));
    }

    // Ghostty requires a non-zero u32 cell. One normalized pixel is the exact
    // representation of any positive browser cell that rounds below one.
    let normalized_cell = cell.round().max(1.0);
    let scale = normalized_cell / cell;
    let normalized_position = position * scale;
    if normalized_position < f32::MIN as f64 || normalized_position > f32::MAX as f64 {
        return Err(format!(
            "Cannot encode a pointer position: the normalized {name} position is out of range"
        ));
    }

    fn length(name: &str, field: &str, value: f64) -> Result<u32, String> {
        let rounded = value.round();
        if !(0.0..=u32::MAX as f64).contains(&rounded) {
            return Err(format!(
                "Cannot encode a pointer position: the normalized {name} {field} is out of range"
            ));
        }
        Ok(rounded as u32)
    }

    Ok(NormalizedAxis {
        position: normalized_position as f32,
        screen: length(name, "screen", screen * scale)?,
        cell: length(name, "cell", normalized_cell)?,
        leading_padding: length(name, "leading padding", leading_padding * scale)?,
        trailing_padding: length(name, "trailing padding", trailing_padding * scale)?,
    })
}

/// A pointer event in surface pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMouseEvent {
    pub action: TerminalMouseAction,
    /// `None` for a motion with no button held.
    #[serde(default)]
    pub button: Option<TerminalMouseButton>,
    #[serde(default)]
    pub mods: TerminalModifiers,
    pub x: f64,
    pub y: f64,
    pub surface: TerminalSurfaceGeometry,
    /// Whether any button is held. The formats that report drags need this and
    /// cannot derive it from one event.
    #[serde(default)]
    pub any_button_pressed: bool,
}

/// Whether a paste can be sent without a guard.
///
/// A payload with a newline runs when it lands. The host answers because the
/// answer is the terminal's, not the client's; what to do about a false answer
/// is the client's.
pub fn paste_is_safe(text: &str) -> bool {
    paste::is_safe(text)
}

pub(crate) fn focus_event(gained: bool) -> focus::Event {
    if gained {
        focus::Event::Gained
    } else {
        focus::Event::Lost
    }
}

impl TerminalKeyEvent {
    pub(crate) fn build(&self) -> Result<key::Event<'static>, String> {
        let Some(key) = key_from_code(&self.code) else {
            return Err(format!("Unknown key code {:?}", self.code));
        };
        let mut event =
            key::Event::new().map_err(|error| format!("Failed to build a key event: {error}"))?;
        event
            .set_action(self.action.action())
            .set_key(key)
            .set_mods(self.mods.mods())
            .set_composing(self.composing);
        // The encoder derives modified sequences from the key and the mods. It
        // documents that control characters and platform function-key
        // codepoints must not arrive as text, so text that is not printable is
        // dropped here rather than passed on and mis-encoded.
        let text = self
            .text
            .as_deref()
            .filter(|text| !text.is_empty() && text.chars().all(|c| !c.is_control()));
        event.set_utf8(text);
        if let Some(first) = text.and_then(|text| text.chars().next()) {
            event.set_unshifted_codepoint(first);
        }
        Ok(event)
    }
}

impl TerminalMouseEvent {
    pub(crate) fn build(&self) -> Result<(mouse::Event<'static>, mouse::EncoderSize), String> {
        let (position, size) = self.surface.normalize(self.x, self.y)?;
        let mut event = mouse::Event::new()
            .map_err(|error| format!("Failed to build a mouse event: {error}"))?;
        event
            .set_action(self.action.action())
            .set_button(self.button.map(TerminalMouseButton::button))
            .set_mods(self.mods.mods())
            .set_position(position);
        Ok((event, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_browser_geometry_preserves_cell_boundaries() {
        let cell_width = 10.836_914_062_5;
        let surface = TerminalSurfaceGeometry {
            screen_width: 80.0 * cell_width,
            screen_height: 24.0 * 20.25,
            cell_width,
            cell_height: 20.25,
            padding_top: 0.0,
            padding_bottom: 0.0,
            padding_left: 0.0,
            padding_right: 0.0,
        };
        let boundary_column = 17.0;
        let boundary_row = 9.0;

        let (position, size) = surface
            .normalize(boundary_column * cell_width, boundary_row * 20.25)
            .expect("fractional CSS pixels are valid terminal geometry");

        assert_eq!(size.cell_width, 11);
        assert_eq!(size.screen_width, 80 * size.cell_width);
        assert_eq!(position.x, boundary_column as f32 * size.cell_width as f32);
        assert_eq!(size.cell_height, 20);
        assert_eq!(size.screen_height, 24 * size.cell_height);
        assert_eq!(position.y, boundary_row as f32 * size.cell_height as f32);
    }

    #[test]
    fn unusable_browser_geometry_is_rejected_before_ghostty() {
        let surface = TerminalSurfaceGeometry {
            screen_width: 800.0,
            screen_height: 480.0,
            cell_width: 0.0,
            cell_height: 20.0,
            padding_top: 0.0,
            padding_bottom: 0.0,
            padding_left: 0.0,
            padding_right: 0.0,
        };

        assert!(surface.normalize(25.0, 21.0).is_err());
    }
}

/// The physical key a W3C code name refers to.
///
/// The table is the whole mapping the pinned parser exposes, so a client can
/// name any key the platform reports. An unknown name is refused rather than
/// encoded as something else: a key this host cannot name is a key whose
/// escape sequence it cannot know.
fn key_from_code(code: &str) -> Option<Key> {
    Some(match code {
        "Backquote" => Key::Backquote,
        "Backslash" => Key::Backslash,
        "BracketLeft" => Key::BracketLeft,
        "BracketRight" => Key::BracketRight,
        "Comma" => Key::Comma,
        "Digit0" => Key::Digit0,
        "Digit1" => Key::Digit1,
        "Digit2" => Key::Digit2,
        "Digit3" => Key::Digit3,
        "Digit4" => Key::Digit4,
        "Digit5" => Key::Digit5,
        "Digit6" => Key::Digit6,
        "Digit7" => Key::Digit7,
        "Digit8" => Key::Digit8,
        "Digit9" => Key::Digit9,
        "Equal" => Key::Equal,
        "IntlBackslash" => Key::IntlBackslash,
        "IntlRo" => Key::IntlRo,
        "IntlYen" => Key::IntlYen,
        "KeyA" => Key::A,
        "KeyB" => Key::B,
        "KeyC" => Key::C,
        "KeyD" => Key::D,
        "KeyE" => Key::E,
        "KeyF" => Key::F,
        "KeyG" => Key::G,
        "KeyH" => Key::H,
        "KeyI" => Key::I,
        "KeyJ" => Key::J,
        "KeyK" => Key::K,
        "KeyL" => Key::L,
        "KeyM" => Key::M,
        "KeyN" => Key::N,
        "KeyO" => Key::O,
        "KeyP" => Key::P,
        "KeyQ" => Key::Q,
        "KeyR" => Key::R,
        "KeyS" => Key::S,
        "KeyT" => Key::T,
        "KeyU" => Key::U,
        "KeyV" => Key::V,
        "KeyW" => Key::W,
        "KeyX" => Key::X,
        "KeyY" => Key::Y,
        "KeyZ" => Key::Z,
        "Minus" => Key::Minus,
        "Period" => Key::Period,
        "Quote" => Key::Quote,
        "Semicolon" => Key::Semicolon,
        "Slash" => Key::Slash,
        "AltLeft" => Key::AltLeft,
        "AltRight" => Key::AltRight,
        "Backspace" => Key::Backspace,
        "CapsLock" => Key::CapsLock,
        "ContextMenu" => Key::ContextMenu,
        "ControlLeft" => Key::ControlLeft,
        "ControlRight" => Key::ControlRight,
        "Enter" => Key::Enter,
        "MetaLeft" => Key::MetaLeft,
        "MetaRight" => Key::MetaRight,
        "ShiftLeft" => Key::ShiftLeft,
        "ShiftRight" => Key::ShiftRight,
        "Space" => Key::Space,
        "Tab" => Key::Tab,
        "Convert" => Key::Convert,
        "KanaMode" => Key::KanaMode,
        "NonConvert" => Key::NonConvert,
        "Delete" => Key::Delete,
        "End" => Key::End,
        "Help" => Key::Help,
        "Home" => Key::Home,
        "Insert" => Key::Insert,
        "PageDown" => Key::PageDown,
        "PageUp" => Key::PageUp,
        "ArrowDown" => Key::ArrowDown,
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "ArrowUp" => Key::ArrowUp,
        "NumLock" => Key::NumLock,
        "Numpad0" => Key::Numpad0,
        "Numpad1" => Key::Numpad1,
        "Numpad2" => Key::Numpad2,
        "Numpad3" => Key::Numpad3,
        "Numpad4" => Key::Numpad4,
        "Numpad5" => Key::Numpad5,
        "Numpad6" => Key::Numpad6,
        "Numpad7" => Key::Numpad7,
        "Numpad8" => Key::Numpad8,
        "Numpad9" => Key::Numpad9,
        "NumpadAdd" => Key::NumpadAdd,
        "NumpadBackspace" => Key::NumpadBackspace,
        "NumpadClear" => Key::NumpadClear,
        "NumpadClearEntry" => Key::NumpadClearEntry,
        "NumpadComma" => Key::NumpadComma,
        "NumpadDecimal" => Key::NumpadDecimal,
        "NumpadDivide" => Key::NumpadDivide,
        "NumpadEnter" => Key::NumpadEnter,
        "NumpadEqual" => Key::NumpadEqual,
        "NumpadMemoryAdd" => Key::NumpadMemoryAdd,
        "NumpadMemoryClear" => Key::NumpadMemoryClear,
        "NumpadMemoryRecall" => Key::NumpadMemoryRecall,
        "NumpadMemoryStore" => Key::NumpadMemoryStore,
        "NumpadMemorySubtract" => Key::NumpadMemorySubtract,
        "NumpadMultiply" => Key::NumpadMultiply,
        "NumpadParenLeft" => Key::NumpadParenLeft,
        "NumpadParenRight" => Key::NumpadParenRight,
        "NumpadSubtract" => Key::NumpadSubtract,
        "NumpadSeparator" => Key::NumpadSeparator,
        "NumpadUp" => Key::NumpadUp,
        "NumpadDown" => Key::NumpadDown,
        "NumpadRight" => Key::NumpadRight,
        "NumpadLeft" => Key::NumpadLeft,
        "NumpadBegin" => Key::NumpadBegin,
        "NumpadHome" => Key::NumpadHome,
        "NumpadEnd" => Key::NumpadEnd,
        "NumpadInsert" => Key::NumpadInsert,
        "NumpadDelete" => Key::NumpadDelete,
        "NumpadPageUp" => Key::NumpadPageUp,
        "NumpadPageDown" => Key::NumpadPageDown,
        "Escape" => Key::Escape,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        "F13" => Key::F13,
        "F14" => Key::F14,
        "F15" => Key::F15,
        "F16" => Key::F16,
        "F17" => Key::F17,
        "F18" => Key::F18,
        "F19" => Key::F19,
        "F20" => Key::F20,
        "F21" => Key::F21,
        "F22" => Key::F22,
        "F23" => Key::F23,
        "F24" => Key::F24,
        "F25" => Key::F25,
        "Fn" => Key::Fn,
        "FnLock" => Key::FnLock,
        "PrintScreen" => Key::PrintScreen,
        "ScrollLock" => Key::ScrollLock,
        "Pause" => Key::Pause,
        "BrowserBack" => Key::BrowserBack,
        "BrowserFavorites" => Key::BrowserFavorites,
        "BrowserForward" => Key::BrowserForward,
        "BrowserHome" => Key::BrowserHome,
        "BrowserRefresh" => Key::BrowserRefresh,
        "BrowserSearch" => Key::BrowserSearch,
        "BrowserStop" => Key::BrowserStop,
        "Eject" => Key::Eject,
        "LaunchApp1" => Key::LaunchApp1,
        "LaunchApp2" => Key::LaunchApp2,
        "LaunchMail" => Key::LaunchMail,
        "MediaPlayPause" => Key::MediaPlayPause,
        "MediaSelect" => Key::MediaSelect,
        "MediaStop" => Key::MediaStop,
        "MediaTrackNext" => Key::MediaTrackNext,
        "MediaTrackPrevious" => Key::MediaTrackPrevious,
        "Power" => Key::Power,
        "Sleep" => Key::Sleep,
        "AudioVolumeDown" => Key::AudioVolumeDown,
        "AudioVolumeMute" => Key::AudioVolumeMute,
        "AudioVolumeUp" => Key::AudioVolumeUp,
        "WakeUp" => Key::WakeUp,
        "Copy" => Key::Copy,
        "Cut" => Key::Cut,
        "Paste" => Key::Paste,
        _ => return None,
    })
}
