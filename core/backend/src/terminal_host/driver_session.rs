use serde_json::Value as JsonValue;

use super::driver::{
    TerminalByteOccurrence, TerminalColorTheme, TerminalDriverDescriptor, TerminalDriverError,
    TerminalDriverRequestResult, TerminalDriverSessionRequest, TerminalDriverUpdate,
};

/// Native parser state stays on the host actor thread. In particular, a
/// Ghostty session is not `Send`; the factory is `Send + Sync` but a session
/// never crosses threads after creation.
pub trait TerminalDriverSession {
    fn on_output(
        &mut self,
        occurrence: TerminalByteOccurrence,
    ) -> Result<TerminalDriverUpdate, TerminalDriverError>;

    fn on_resize(&mut self, columns: u16, rows: u16) -> Result<(), TerminalDriverError>;

    /// Return a presentation snapshot owned by the selected driver. A baseline
    /// must not consume the damage pending for already attached readers.
    fn snapshot(&mut self, baseline: bool) -> Result<JsonValue, TerminalDriverError>;

    /// Encode one provider-owned presentation event. The host supplies only
    /// ordering facts; it never constructs or decodes the presentation.
    fn presentation(
        &mut self,
        _sequence: u64,
        _revision: u64,
        _baseline: bool,
    ) -> Result<JsonValue, TerminalDriverError> {
        Err(TerminalDriverError::new(
            "the selected terminal driver has no provider presentation stream",
        ))
    }

    /// Produce a byte replay only for the retiring compatibility transport.
    /// New terminal presentations must use their own driver payload instead.
    fn replay(&mut self) -> Result<Vec<u8>, TerminalDriverError>;

    /// Apply the host's current colour theme and return any ordered PTY reply.
    fn set_color_theme(
        &mut self,
        theme: &TerminalColorTheme,
    ) -> Result<TerminalDriverUpdate, TerminalDriverError>;

    /// Route a driver-owned operation without exposing its semantic schema to
    /// the core terminal host.
    fn request(
        &mut self,
        request: JsonValue,
    ) -> Result<TerminalDriverRequestResult, TerminalDriverError>;

    fn stop(&mut self);
}

pub trait TerminalDriverFactory: Send + Sync {
    fn descriptor(&self) -> TerminalDriverDescriptor;

    fn create(
        &self,
        request: TerminalDriverSessionRequest,
    ) -> Result<Box<dyn TerminalDriverSession>, TerminalDriverError>;
}
