# TODO frontend extraction

## Outcome

The existing TODO capability is now the first production frontend module. Its
panel, project-navigation row, settings UI, render cache, native client, data
types, inline Markdown renderer, and CSS live under
`modules/todos/frontend/`.

The host no longer imports TODO implementation code. It supplies generic
composition surfaces and narrow services for settings, skills, notices, and
project lifecycle events.

## Module-owned resources

- `src/index.ts`: public module registration and project lifecycle policy.
- `src/TodosPanel.tsx`: list and board UI.
- `src/TodoProjectRow.tsx`: project-navigation contribution.
- `src/TodoSettingsSection.tsx`: settings contribution.
- `src/store.ts`: project-scoped render cache and mutations.
- `src/client.ts`: compatibility client for the current flat Tauri command
  names. Native namespacing follows in `shep-3w1.7.3`.
- `src/types.ts`, `src/inlineMarkdown.tsx`, and `src/todos.css`: module-local
  data model and presentation resources.

## Host contracts added

The public frontend module API now supports:

- project-navigation contributions;
- settings contributions;
- project-added/changed/removed lifecycle callbacks;
- stable settings and skills snapshots with subscriptions;
- notice delivery through a host port;
- host services passed to contributed panels.

The host renders those contributions generically and contains failures at the
surface boundary. Filesystem and project lifecycle dispatch uses
`Promise.allSettled`, so one failing module cannot stop another.

## Compatibility

The existing persisted tab kind remains `todos`, while its stable contribution
identity is now `todos.board`. The compatibility mapping is bidirectional:

- legacy `todos` tabs hydrate as `todos.board`;
- the module's project row opens the existing `todos` tab shape;
- when the module is disabled, the same saved reference is retained and shown
  through generic unavailable-panel recovery.

This adapter remains intentionally until the generic tab model replaces
`PanelTabKind` in the final host audit. It contains compatibility vocabulary
without giving the module a dependency on host tab or terminal stores.

## Remaining native seam

The Rust TODO commands still live in `src-tauri/src/todos.rs` and retain their
flat invoke names for this compile-green stage. The next task moves those
commands into `modules/todos/backend`, registers the plugin through the native
module profile, and adds explicit capabilities without changing frontend
behavior.

## Verification contract

- TODO model/store characterization tests target module-owned sources.
- Module composition tests cover panels, project rows, settings, lifecycle
  failure isolation, and disabled recovery.
- The boundary checker rejects host deep imports and module imports outside the
  public API.
- Main and panel-host builds compile against the extracted module.
- A disposable disabled profile build verifies that omitting the module from
  composition still produces a working frontend.
