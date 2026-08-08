# Shipctl Usage backend module

This internal Tauri plugin owns Usage persistence, transcript ingestion,
provider quota adapters, normalization, queries, and interpretation of the
module-owned `usage` settings document. The host supplies only generic,
read-only access to opaque global capability data.

Commands are exposed under `plugin:shipctl-usage|...`; the plugin owns its
`UsageDb` state and startup ingestion lifecycle. It has no flat host-command,
typed host-settings, or provider-model-catalog dependency.
