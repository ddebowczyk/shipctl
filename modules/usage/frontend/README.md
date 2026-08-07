# Usage frontend module

This package owns Shep's Usage frontend: provider DTOs and Tauri client,
global stores, quota helpers, Usage panel, sidebar utilization widget, settings
section, styles, logos, refresh scheduling, and ingestion-event lifecycle.

The host imports only the public `usageModule` contribution from
`@shep/module-usage`. The persisted global surface ID remains `core.usage` for
compatibility. Native commands and the typed `usage:` config field remain a
temporary compatibility boundary until the Usage backend extraction.
