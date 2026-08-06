//! Narrow native contracts shared by the Shep host and internal modules.
//!
//! This crate intentionally has no exported contracts yet. The fixture module
//! does not require a host service, and package structure alone is not a reason
//! to invent a generic context, error type, or service locator.

#![forbid(unsafe_code)]
