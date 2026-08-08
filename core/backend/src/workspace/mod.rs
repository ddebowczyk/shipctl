//! The persistence layer underneath every other capability: the on-disk
//! configuration schema, its loader, and the manager that projects, settings
//! and terminal all read and write through.

pub mod config;
pub mod loader;
pub mod manager;
pub mod migration;
