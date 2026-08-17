use std::collections::HashMap;
use std::sync::Arc;

use super::driver::{TerminalDriverDescriptor, TerminalDriverError, TerminalDriverId};
use super::driver_session::TerminalDriverFactory;

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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::driver::{
        TerminalDriverDescriptor, TerminalDriverError, TerminalDriverId,
        TerminalDriverSessionRequest,
    };
    use super::super::driver_session::{TerminalDriverFactory, TerminalDriverSession};

    use super::TerminalDriverRegistry;

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
        ) -> Result<Box<dyn TerminalDriverSession>, TerminalDriverError> {
            unreachable!("registry tests do not create a session")
        }
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
