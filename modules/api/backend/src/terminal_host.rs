//! Data-only native terminal-host contracts.
//!
//! These traits let the host select one implementation without giving that
//! implementation a PTY handle, a reader, or a writer.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TerminalDriverId(String);

impl TerminalDriverId {
    pub fn new(value: impl Into<String>) -> Result<Self, TerminalDriverError> {
        let value = value.into();
        if value.is_empty()
            || !value.bytes().enumerate().all(|(index, byte)| match byte {
                b'a'..=b'z' => true,
                b'0'..=b'9' | b'-' => index > 0,
                _ => false,
            })
        {
            return Err(TerminalDriverError::new("invalid terminal driver id"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TerminalDriverId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl<'de> Deserialize<'de> for TerminalDriverId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDriverDescriptor {
    pub id: TerminalDriverId,
    pub native_interpretation: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalByteOccurrence {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

/// Immutable host facts supplied when a selected native driver is created.
/// The driver receives no PTY reader, writer, or geometry handle.
#[derive(Clone)]
pub struct TerminalDriverSessionRequest {
    pub columns: u16,
    pub rows: u16,
    pub color_theme: crate::TerminalColorTheme,
    pub scrollback_bytes: usize,
}

/// A driver update can contain only module-owned events and bytes that the
/// host writes through its one ordered PTY writer.
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDriverUpdate {
    /// Module-owned provider events, already framed for that driver's client.
    pub events: Vec<JsonValue>,
    pub reply_bytes: Vec<u8>,
    /// Whether this output changed the driver's presentation.
    pub presentation_changed: bool,
}

impl TerminalDriverUpdate {
    pub fn empty() -> Self {
        Self {
            events: Vec::new(),
            reply_bytes: Vec::new(),
            presentation_changed: false,
        }
    }
}

/// One opaque answer from a selected driver. The host serialises the call with
/// PTY output, but never decodes the driver's presentation or input payload.
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDriverRequestResult {
    /// Opaque response payload that belongs to the selected driver's request
    /// schema.
    pub payload: JsonValue,
    /// Bytes the host must write to the child in the same actor turn as this
    /// request. This keeps driver-encoded input ordered with PTY output.
    pub reply_bytes: Vec<u8>,
    /// Whether the request changed the driver's presentation. The host uses
    /// this only to schedule delivery; it never decodes the presentation.
    pub presentation_changed: bool,
}

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
        theme: &crate::TerminalColorTheme,
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

/// Build-profile registry of the native drivers available to the host. It is
/// deliberately separate from a terminal session: a host resolves a factory
/// before it creates a PTY and never changes that selection afterwards.
#[derive(Default)]
pub struct TerminalDriverRegistry {
    drivers: HashMap<TerminalDriverId, RegisteredTerminalDriver>,
}

struct RegisteredTerminalDriver {
    descriptor: TerminalDriverDescriptor,
    factory: Option<Arc<dyn TerminalDriverFactory>>,
}

impl TerminalDriverRegistry {
    pub fn register(
        &mut self,
        factory: Arc<dyn TerminalDriverFactory>,
    ) -> Result<(), TerminalDriverError> {
        let id = factory.descriptor().id;
        if self.drivers.contains_key(&id) {
            return Err(TerminalDriverError::new(format!(
                "terminal driver is already registered: {id}"
            )));
        }
        let descriptor = factory.descriptor();
        self.drivers.insert(
            id,
            RegisteredTerminalDriver {
                descriptor,
                factory: Some(factory),
            },
        );
        Ok(())
    }

    /// Register a driver whose interpretation stays in the browser.
    /// A native interpreter must always register a factory instead.
    pub fn register_browser_driver(
        &mut self,
        descriptor: TerminalDriverDescriptor,
    ) -> Result<(), TerminalDriverError> {
        if descriptor.native_interpretation {
            return Err(TerminalDriverError::new(
                "a native terminal driver must register a factory",
            ));
        }
        if self.drivers.contains_key(&descriptor.id) {
            return Err(TerminalDriverError::new(format!(
                "terminal driver is already registered: {}",
                descriptor.id
            )));
        }
        self.drivers.insert(
            descriptor.id.clone(),
            RegisteredTerminalDriver {
                descriptor,
                factory: None,
            },
        );
        Ok(())
    }

    pub fn resolve(&self, id: &TerminalDriverId) -> Option<Arc<dyn TerminalDriverFactory>> {
        self.drivers
            .get(id)
            .and_then(|driver| driver.factory.clone())
    }

    pub fn descriptor(&self, id: &TerminalDriverId) -> Option<&TerminalDriverDescriptor> {
        self.drivers.get(id).map(|driver| &driver.descriptor)
    }

    pub fn descriptors(&self) -> Vec<TerminalDriverDescriptor> {
        self.drivers
            .values()
            .map(|driver| driver.descriptor.clone())
            .collect()
    }
}

/// Thin-mode observers are deliberately unable to create parser replies.
pub trait TerminalObserver: Send {
    fn on_output(
        &mut self,
        occurrence: &TerminalByteOccurrence,
    ) -> Result<Vec<TerminalObservation>, TerminalDriverError>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalObservation {
    Bell,
    Title { value: String },
    Activity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalDriverError {
    message: String,
}

impl TerminalDriverError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for TerminalDriverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for TerminalDriverError {}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        TerminalDriverDescriptor, TerminalDriverFactory, TerminalDriverId, TerminalDriverRegistry,
        TerminalDriverSession, TerminalDriverSessionRequest,
    };

    struct TestFactory;

    impl TerminalDriverFactory for TestFactory {
        fn descriptor(&self) -> TerminalDriverDescriptor {
            TerminalDriverDescriptor {
                id: TerminalDriverId::new("semantic-terminal").unwrap(),
                native_interpretation: true,
            }
        }

        fn create(
            &self,
            _request: TerminalDriverSessionRequest,
        ) -> Result<Box<dyn TerminalDriverSession>, super::TerminalDriverError> {
            unreachable!("registry tests do not create a session")
        }
    }

    #[test]
    fn driver_ids_are_stable_lowercase_names() {
        assert_eq!(
            TerminalDriverId::new("semantic-terminal").unwrap().as_str(),
            "semantic-terminal"
        );
        assert!(TerminalDriverId::new("Semantic").is_err());
        assert!(TerminalDriverId::new("thin_terminal").is_err());
    }

    #[test]
    fn registry_rejects_duplicate_and_reports_missing_native_drivers() {
        let id = TerminalDriverId::new("semantic-terminal").unwrap();
        let mut registry = TerminalDriverRegistry::default();
        registry.register(Arc::new(TestFactory)).unwrap();

        assert!(registry.resolve(&id).is_some());
        assert!(registry
            .resolve(&TerminalDriverId::new("thin-terminal").unwrap())
            .is_none());
        assert!(registry.register(Arc::new(TestFactory)).is_err());
    }

    #[test]
    fn browser_driver_cannot_claim_native_interpretation() {
        let mut registry = TerminalDriverRegistry::default();
        let thin = TerminalDriverDescriptor {
            id: TerminalDriverId::new("thin-terminal").unwrap(),
            native_interpretation: false,
        };
        registry.register_browser_driver(thin.clone()).unwrap();
        assert_eq!(registry.descriptor(&thin.id), Some(&thin));
        assert!(registry.resolve(&thin.id).is_none());

        assert!(registry
            .register_browser_driver(TerminalDriverDescriptor {
                id: TerminalDriverId::new("invalid-native").unwrap(),
                native_interpretation: true,
            })
            .is_err());
    }
}
