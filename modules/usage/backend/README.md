# Shep Usage backend module

This internal Tauri plugin owns Usage persistence, transcript ingestion,
provider quota adapters, normalization, and queries. The host supplies only the
persisted provider-visibility settings needed to decide which remote quota
adapters may refresh.

Commands are exposed under `plugin:shep-usage|...`; the plugin owns its
`UsageDb` state and startup ingestion lifecycle.
