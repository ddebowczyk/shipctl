//! Host-owned scrollback budget passed unchanged to the selected driver.
//!
//! A driver decides how it applies this value. The host keeps only the product
//! setting and its revision, so it does not depend on a parser implementation.

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TerminalRetentionPolicy {
    bytes: usize,
}

pub const RETENTION_DEFAULT_BYTES: usize = 16 * 1024 * 1024;

impl TerminalRetentionPolicy {
    pub const fn from_bytes(bytes: usize) -> Self {
        Self { bytes }
    }

    pub const fn bytes(self) -> usize {
        self.bytes
    }
}

impl Default for TerminalRetentionPolicy {
    fn default() -> Self {
        Self::from_bytes(RETENTION_DEFAULT_BYTES)
    }
}
