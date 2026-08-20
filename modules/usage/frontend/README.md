# Usage frontend module

This package owns Shipctl's Usage policy and frontend: pricing, aggregation,
alias review, the semantic Usage Sources client, global stores, quota helpers,
the Usage panel, the sidebar utilization widget, settings, styles, refresh
scheduling, and the ingestion-event lifecycle.

The runtime artifact imports the direct plugin declarations from this package;
its activation owns every registered contribution and the Usage Sources
observer. The persisted global surface ID is `core.usage`.

Usage settings are read and replaced through the host's generic global-data
port under the `usage` key. This package owns their schema, defaults,
normalization, and merge behavior; the host stores the document opaquely and
preserves unknown values.

The module consumes normalized facts through the public `usageSourcesService`.
It does not import Tauri APIs. The permanent Rust provider owns reviewed source,
credential, process, network, and SQLite authority. Model discovery is
Assistant behavior and is not part of this package.
