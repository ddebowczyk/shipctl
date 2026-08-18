<!-- markdownlint-disable MD013 -->

# Step 07 — Dissolve the compatibility canvas into contributed views

## Outcome

Today Layman renders **one compatibility tab containing the entire legacy
canvas**, plus real workspace-view tabs beside it. This step empties that
compatibility tab by converting its contents into contributed workspace views,
then deletes it and the imperative canvas contract it exists to serve.

The renderer-neutral projection, the gesture gate, and the semantic document are
already built. What remains is a feature-specific model that outlives them.

## What already exists

| Already built | Evidence |
| --- | --- |
| Layman renders the semantic document as windows/tabs | `core/frontend/canvas/layman/workspaceProjection.ts` (`createLaymanWorkspaceState`, `workspaceStackIdFromLaymanWindowId`) |
| User gestures are gated before becoming semantic intents | `LaymanCanvas.tsx:62-80` — `LaymanInteractionPolicy.canExecute` allows `tab.select`, conditionally `tab.remove` and `tab.move`, and rejects the rest when `origin === "user"` |
| Gestures translate to workspace commands | `core/frontend/canvas/layman/workspaceActions.ts` (`laymanWorkspaceAction`) |
| Two renderers project the same document | `canvas/layman/workspaceProjection.ts` and `canvas/legacy/workspaceProjection.ts` |
| Renderer selection is resolvable in TypeScript | `canvas/canvasAdapterResolver.tsx`, `canvas/views.ts` |
| No renderer type leaks into the contract | `WorkspaceViewPresentationRef { loaderId, exportName }` |

The draft's "minimum useful first increment" — render one compatibility view as a
Layman window, project semantic tabs, permit only supported operations — is
**already delivered**. Do not re-plan it.

## The actual blocker: a second, feature-shaped workspace model

`core/frontend/canvas/types.ts` defines a parallel model that the semantic
document was supposed to replace:

- `CanvasModelInput` / `CanvasModel` (lines 61-100): a `sidebar` holding
  `repos`, `groups`, `activeProjectPath`, `tabDropProjectPath`; a `tabBar`
  holding `panels`; `terminalSlots`; a `trailingLayout` with a `project`. Every
  one of these is a specific feature named in the host frame.
- `CanvasActions` (lines 103-125): **22 imperative operations** —
  `selectRepo`, `addProject`, `removeProject`, `newModuleSession`,
  `openInEditor`, `newDefaultTerminal`, `newTerminal`, `openPanel`,
  `renameGroup`, `deleteGroup`, `moveToGroup`, `toggleGlobalSurface`, and
  tab-level `selectTab`/`closeTab`/`moveTab`/`reorderTab`/`renameTab`/
  `setTabTitle`. These bypass `WorkspaceCommand` entirely: they are not
  revision-checked, not validated by the workspace authority, and not
  persisted as semantic operations.
- `CanvasPorts` (lines 128-142): hands the renderer `moduleHostServices` (the
  bag Step 02 deletes) and `moduleActivations` — a map of **every activation
  context** to the renderer.

`LaymanCanvas.tsx:23-28` imports `LegacyCanvas` and
`CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID`, so the whole of the above renders
inside one tab of the semantic workspace. That tab is the half-transition: it
looks like progress and can persist indefinitely.

Three consequences to state plainly:

1. Tab operations exist in two places with different guarantees — `CanvasActions.closeTab`
   and `CloseWorkspaceViewCommand`. Which one a gesture reaches depends on which
   tab it lands on.
2. `CanvasPorts.moduleActivations` gives the renderer authority the plugin
   contract deliberately withholds. This must be removed regardless of the rest
   of the step.
3. Terminal presentation is mounted by the frame (`terminalSlots`,
   "Visibility never changes its mount"), so terminals cannot become ordinary
   contributed views until mount-stability is preserved by the view host.

## The work

Convert each `CanvasModel` region into contributed workspace views, one at a
time, deleting its `CanvasModel` field and its `CanvasActions` members in the
same commit:

| Region | Becomes | Notes |
| --- | --- | --- |
| `sidebar` (repos, groups, navigation) | a navigation contribution rendered by the frame, plus a projects view | `renameGroup`/`deleteGroup`/`moveToGroup` become project-service operations, not canvas actions |
| `tabBar.panels` | workspace view definitions in the catalogue | `openPanel`/`toggleGlobalSurface` become `open`/`focus` commands |
| `terminalSlots` | terminal views with a mount-stable view host | the last to move; requires the host to guarantee mount stability across hide/show |
| `trailingLayout` | a contributed view or a profile preference | decide which; it is currently a boolean plus a project |
| `content: CanvasContentTarget` | the semantic document's focused instance | delete the union |

`CanvasActions` members with no semantic equivalent (`newModuleSession`,
`openInEditor`, `addProject`) are not layout operations at all — they route to
the projects and desktop services (Step 04).

## Standard frame

What the trusted renderer keeps after the conversion:

- window chrome, focus routing, and accessibility;
- content regions for a primary canvas and optional navigation;
- global shortcut and notice routing;
- an attachment point for native window behavior requested through a grant;
- renderer diagnostics for projection failures.

It keeps no feature name. A projection failure for one view renders a
diagnosable placeholder in that view's region; it never blanks the canvas.

## Contribution split

| Contribution family | Plugin declares | Workspace/profile decides |
| --- | --- | --- |
| View | stable id, label/icon, body ref, cardinality, availability | open instance, stack/split/floating placement, focus |
| Navigation item | stable id, label/icon, target command or view, capability requirements | visibility, ordering, side, collapse |
| Menu item / group | placement target, command id, enablement predicate | which menus exist and their ordering |
| Command palette action | semantic command and argument schema | discoverability, shortcut binding |
| Overlay / popover | trigger contract and content | whether one is open; never persisted |
| Notification | structured event and severity | rendering and acknowledgement policy |

Adding any of these families requires the taxonomy decision from Step 02 —
`RuntimeContributionFamily` in Rust is the gate. Do not introduce a new family
here without resolving that first.

## Native windows and menus

A browser-like floating pane is a workspace semantic feature, rendered by
Layman, described by `WorkspaceFloatingStack` — which needs the float/dock
operations from Step 06 before any control emits it.

A real operating-system window is different: the workspace plugin emits a typed
window intent, the runtime checks a grant, and the desktop port owns creation
and lifetime. The document stores semantic placement and identity, never a
native handle. Menus follow the same rule — plugins contribute semantic items; a
renderer or desktop menu adapter projects accepted items.

## Legacy canvas retirement

`docs/4-layer-architecture/spec/phases/phase-h.yaml:21` states the legacy canvas
is removed "only after a separate product decision authorizes it". That decision
does not exist yet (Step 00, owner decision 3).

Therefore this step's deletion gate is conditional, and must be written as a
`deletion_gates` entry naming:

- the artifacts deleted together — `canvas/legacy/*` (~1 100 lines across
  `LegacyCanvas.tsx`, `LegacyTabBar.tsx`, `LegacySidebar.tsx`,
  `LegacySidebarFooter.tsx`, `useSidebarSettingsStore.ts`,
  `workspaceProjection.ts`), `CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID`, the
  `CanvasModel`/`CanvasActions`/`CanvasPorts` types, and
  `canvas/tests/legacyCanvas.test.ts` + `legacyWorkspaceProjection.test.ts`;
- the parity evidence required before deletion;
- the owner and the date the product decision was recorded.

Until that decision exists, the legacy canvas stays — but `CanvasActions` must
still shrink with every converted region. Retirement of the *renderer* and
dissolution of the *model* are separate gates; conflating them is what would
make this permanent.

## Refactoring actions

1. Remove `moduleActivations` and `moduleHostServices` from `CanvasPorts` first;
   it is independent of the rest and closes an authority leak.
2. Convert regions in the order: `tabBar.panels` → `sidebar` → `trailingLayout`
   → `terminalSlots`. Delete the matching `CanvasActions` members in the same
   commit as each conversion.
3. Route the non-layout `CanvasActions` members to their owning services.
4. Add the mount-stability guarantee to the view host before converting
   terminals.
5. Add renderer fallbacks for unavailable view bodies and projection errors.
6. Add navigation/frame profile preferences only after the schema is
   agent-operable (Step 06).
7. Write the conditional `deletion_gates` entry for the legacy canvas.

## Validation and exit criteria

- A fixture profile places two declared views in a stack and splits them with no
  feature-specific code in `AppShell` or the frame.
- `CanvasActions` has zero members that mutate layout; every layout change goes
  through `WorkspaceCommand` and is revision-checked.
- `CanvasPorts` exposes no activation context and no host-services bag.
- The same document projects deterministically in both renderer test suites
  (`canvas/tests/workspaceProjection.test.ts`,
  `canvas/tests/laymanCanvas.test.ts`).
- A user gesture is either a valid semantic operation or is visibly rejected by
  `canExecute`; it never produces untracked transient state.
- No `react-layman` type appears in the workspace document or any plugin
  contract; `canvas-tauri-import`, `canvas-feature-module-import`, and the new
  `canvas-persistence-import` rules all pass.
- Navigation and menu contents derive from accepted contributions and profile
  policy, not a static list.
- The legacy canvas either is deleted with its recorded product decision, or its
  `deletion_gates` entry states what is still missing.
