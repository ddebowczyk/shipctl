//! Canonical, storage-independent contracts for module control.
//!
//! The registry, local control endpoint, CLI, and frontend supervisor share
//! these values. They describe a desired configuration for one named running
//! instance; they never model Cargo feature selection or a source rebuild.

pub mod contracts;
pub mod registry;

pub use contracts::*;
pub use registry::*;
