# Ports native module

This internal Tauri plugin owns listening-port discovery, process filtering,
project enrichment, framework detection, and process termination policy.

The host injects only two narrow capabilities: a catalog of registered project
paths and bounded process observation/control operations. The plugin does not
import the Shipctl host crate and cannot execute arbitrary shell commands.

Commands are namespaced under `plugin:shipctl-ports|...`. During the frontend
migration, the host's historical flat commands forward to the same module core.
The optional `ports-module` Cargo feature makes native removal verifiable.
