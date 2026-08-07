# Usage frontend module

This package owns Shep's Usage frontend: provider DTOs and Tauri client,
global stores, quota helpers, Usage panel, sidebar utilization widget, settings
section, styles, logos, refresh scheduling, and ingestion-event lifecycle.

The host imports only the public `usageModule` contribution from
`@shep/module-usage`. The persisted global surface ID is `core.usage`.

Usage settings are read and replaced through the host's generic global-data
port under the `usage` key. This package owns their schema, defaults,
normalization, and merge behavior; the host stores the document opaquely and
preserves unknown values.

All native calls use the `plugin:shep-usage|...` namespace. Model discovery is
Assistant behavior and is not part of this package.
