# UI extension models

## Default: declarative contributions

Extensions should first contribute descriptions that the host renders with
Shep-owned React components:

```json
{
  "panels": [
    {
      "id": "terminal-history",
      "title": "History",
      "icon": "history",
      "view": {
        "type": "search-results",
        "dataSource": "terminal.history.search"
      }
    }
  ],
  "commands": [
    {
      "id": "terminal.history.clear",
      "title": "Clear Terminal History"
    }
  ]
}
```

Host-rendered contributions provide:

- consistent accessibility, theme, layout, and keyboard handling;
- schema validation before activation;
- no arbitrary frontend code execution;
- reliable unregistration and immediate visual removal;
- compatibility managed at the contribution-schema level.

Initial contribution points can include commands, menus, settings, status
items, forms, data tables, tree views, notifications, and standard panels.

## Isolated rich UI

When declarative UI is insufficient, an extension may provide HTML, CSS, and
JavaScript loaded into a dedicated isolated webview, child webview, or frame,
subject to platform support.

The isolated view must have:

- a separate origin or custom content protocol;
- no direct global Tauri API exposure;
- a restrictive Content Security Policy;
- no arbitrary network access unless granted;
- communication only through a validated host message broker;
- payload size, rate, and operation limits;
- lifecycle ownership tied to the extension instance.

The view sends intents to the broker and receives view data. It must not invoke
internal Tauri command names directly.

## Main-webview JavaScript

Dynamic imports, module federation, or direct React component registration can
give first-party extensions seamless access to the main view. They also share
the main view's authority and dependency graph.

Risks include:

- extension code can interfere with the complete UI;
- React and shared dependency versions become an implicit ABI;
- loaded JavaScript cannot be reliably unloaded;
- Content Security Policy becomes broader;
- extension crashes are frontend-host crashes;
- disabling may require a complete webview reload.

This model should be restricted to signed first-party modules that release in
coordination with Shep. It should not be presented as the general extension API.

## Contribution registration

Every activation should produce instance-owned registration handles:

```text
ExtensionInstance
├── panel registrations
├── command registrations
├── settings registrations
├── event subscriptions
├── resource protocol mounts
└── isolated view instances
```

Deactivation disposes the root instance. The host must guarantee that all child
registrations are removed even when graceful extension shutdown fails.

## State ownership

Extension UI should consume projection data supplied through its protocol. It
must not import Shep's Zustand stores. The host may project extension state into
its own read models, but those stores remain private implementation details.
