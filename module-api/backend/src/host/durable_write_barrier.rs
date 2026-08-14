use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Coordinates durable mutations across the host and all installed modules.
///
/// Normal writers take a shared guard. A state snapshot takes the exclusive
/// guard, which gives every provider one coherent cross-capability boundary
/// without teaching the host how the provider stores its data.
#[derive(Clone, Default)]
pub struct DurableWriteBarrier {
    lock: Arc<RwLock<()>>,
}

impl DurableWriteBarrier {
    pub fn enter_update(&self) -> Result<RwLockReadGuard<'_, ()>, String> {
        self.lock
            .read()
            .map_err(|_| "Durable write barrier is poisoned".to_string())
    }

    pub fn freeze(&self) -> Result<RwLockWriteGuard<'_, ()>, String> {
        self.lock
            .write()
            .map_err(|_| "Durable write barrier is poisoned".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::DurableWriteBarrier;

    #[test]
    fn updates_and_snapshot_freezes_are_mutually_exclusive() {
        let barrier = DurableWriteBarrier::default();
        let update = barrier.enter_update().unwrap();
        assert!(barrier.lock.try_write().is_err());
        drop(update);

        let freeze = barrier.freeze().unwrap();
        assert!(barrier.lock.try_read().is_err());
        drop(freeze);

        assert!(barrier.lock.try_read().is_ok());
        assert!(barrier.lock.try_write().is_ok());
    }
}
