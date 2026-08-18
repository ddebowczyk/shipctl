<!-- markdownlint-disable MD013 -->

# Step 07 — Make layout, frame, and navigation composable

## Outcome

Use the workspace semantic service to compose Shipctl's main canvas from
plugin-owned views inside a standard, renderer-owned frame. Layman becomes the
first controlled renderer for the semantic layout, rather than a static wrapper
around today’s hardwired screen. Menus, sidebar/navigation placement, panes,
tabs, popups, and notifications become contribution or workspace-profile
concerns, not AppShell constants.

## Renderer ownership model

    accepted plugin contributions
                 |
    workspace service: semantic document + profile + actions
                 |
    canvas adapter: projection + intent translation
                 |
    Layman renderer: controlled visual tree
                 |
    React view bodies supplied by plugins

The persistent source of truth is the workspace document. Layman rendering
output and transient drag state are not persisted. User gestures are translated
to semantic workspace intents, validated by the workspace service, then
projected back into the renderer.

This lets Shipctl switch canvas implementations or render the same semantic
workspace differently without a data migration.

## Standard frame versus plugin views

The trusted renderer provides a small standard WorkspaceFrame:

- accessible window chrome and safe focus routing;
- content regions for a primary canvas and optional navigation;
- routing for global keyboard shortcuts and notices;
- a stable place to attach native window behavior when explicitly requested;
- renderer diagnostics for projection failures.

The frame does not hardcode a project list, usage panel, terminal tabs,
assistant sessions, or a left navigation bar. Those are plugin contributions
and workspace profile selections.

| Contribution family | Plugin declares | Workspace/profile decides |
| --- | --- | --- |
| View | stable id, title/icon metadata, view body, singleton/multiplicity and availability | open instance, group, split/stack/floating position, focus |
| Navigation item | stable id, label/icon, target action/view, capability requirements | visibility, ordering, side, collapsed behavior |
| Menu item/menu group | placement target, command id, enablement predicate | which menus exist and user/profile ordering where allowed |
| Command palette action | semantic command and argument schema | discoverability and shortcut binding |
| Overlay/popover | trigger contract and content | whether an overlay is currently open; no durable renderer snapshot |
| Notification | structured event and severity | rendering and user acknowledgement policy |

## Minimum useful first increment

Do not wait for every IDE behavior. The first Layman-backed workspace should:

1. render a single compatibility view as one Layman window;
2. project semantic tabs/splits from the workspace document;
3. permit open, focus, close, and move/split only where the semantic service
   supports them;
4. persist and validate a workspace profile through TypeScript configuration;
5. expose inspect/validate/plan/apply to agents;
6. offer reset to a safe default profile.

The next increments add resize, user-driven docking, floating windows,
maximize/restore, configurable navigation side, and profile management. Each
visual affordance arrives only after its semantic operation and recovery rule
are defined in Step 06.

## Native windows and popups

Browser-like floating panes are a workspace semantic feature and can be
implemented by Layman. A true operating-system window is different: the
workspace plugin emits a typed window intent, the runtime checks a grant, and
the desktop port owns native window creation/lifetime. The workspace document
stores semantic placement/identity where useful, never a raw native handle.

Menus follow the same rule. Plugins contribute semantic menu items. A renderer
or desktop menu adapter projects accepted items into a visual/native menu. No
feature calls a native menu API directly.

## Refactoring actions

1. Define view, navigation, menu, overlay, and notification contribution
   contracts in the public plugin API.
2. Introduce WorkspaceFrame with slots and accessible focus rules, keeping it
   renderer-specific but feature-neutral.
3. Make LaymanCanvas a controlled adapter over WorkspaceCanvasBridge rather
   than a source of layout state.
4. Remove legacy sidebar/tab-bar placement decisions from AppShell as their
   equivalent contributions migrate.
5. Add semantic renderer fallbacks for unavailable view bodies and projection
   errors so a single bad plugin cannot blank the canvas.
6. Add profile configuration for navigation side/order and standard-frame
   appearance only after the schema is agent-operable.
7. Keep the old canvas adapter as an explicit compatibility renderer until
   parity tests and migration telemetry permit its removal.

## Validation and exit criteria

- A fixture profile can place two declared views in a stack and split them
  without any feature-specific code in AppShell.
- The same workspace document projects to a deterministic canvas model in
  renderer tests.
- A user resize or drag is either reflected as a valid semantic operation or
  visibly rejected; it never produces untracked transient state.
- An agent can inspect a profile, make a validated offline change, and reset it
  to a known default.
- Navigation and menu contents are derived from accepted contributions and
  profile policy, not a static feature list.
- Layman is replaceable: no Layman snapshot or type appears in the public
  workspace document or a plugin contract.
