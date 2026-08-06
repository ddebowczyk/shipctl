# Ports characterization and module seam

Date: 2026-08-06

## Outcome

Ports is a global, process-local overlay over a best-effort snapshot of
listening development processes. It is not a project panel, does not persist
state, does not poll, and does not represent free ports. Switching projects
while it is open leaves it open and changes neither the scan nor existing
terminal sessions.

The current behavior is protected by `pnpm test:ports-characterization` before
any implementation moves. The gate uses synthetic process, path, and port data;
it contains no user workspace values.

## Observable behavior

<!-- markdownlint-disable MD013 -->

| Behavior | Current contract | Evidence |
| --- | --- | --- |
| Placement | The footer opens Ports as a global overlay, mutually exclusive with Settings and Usage. The active tab remains underneath and is revealed when the overlay closes. | `src/components/sidebar/SidebarFooter.tsx`; `src/stores/useUIStore.ts`; `src/components/layout/AppShell.tsx`; `src/components/layout/TabBar.tsx` |
| Lifetime | Opening mounts the panel and starts one scan. Refresh starts another scan. There is no polling or persisted overlay/data state. | `src/components/ports/PortsPanel.tsx` |
| Scope | Every scan considers all listening development processes and labels them against all registered repo paths. The active project is not an input. | `src-tauri/src/commands.rs::list_listening_ports` |
| Empty state | An empty successful snapshot renders `No dev ports detected`. Missing or timed-out observation tools also collapse to an empty snapshot. | `run_with_timeout`; `PortsPanel`; native and frontend characterization tests |
| Error state | IPC-level scan rejection renders `Scan error`. Ordinary `lsof` or `ps` spawn failures do not reject; they degrade to empty or partial data. | `scanPorts`; `run_with_timeout` |
| Grouping | A matched repo basename is the group label. Unmatched listeners appear under `Other`, after alphabetically sorted project groups. | `groupPortsByProject`; `sortPortGroupKeys` |
| Browser action | The module requests `http://localhost:<port>` through the host URL-opening command. The host retains URL-scheme allowlist enforcement. | `PortsPanel::handleOpenBrowser`; `commands::open_url` |
| Stop action | The UI reports success when the native kill command returns `Ok`, then schedules a refresh after 500 ms. It does not independently verify process exit. | `stopPort`; `commands::kill_port` |

<!-- markdownlint-enable MD013 -->

## Native discovery fidelity

The implementation invokes three external macOS/Unix tools with a five-second
timeout per call:

1. `lsof -iTCP -sTCP:LISTEN -P -n` discovers listeners.
2. `ps -p <pids> -o pid=,rss=,etime=,command=` adds memory, uptime, and command
   text.
3. `lsof -a -d cwd -p <pids>` adds working directories.

Listener parsing assumes the whitespace-split `lsof` name field is at index
eight. Entries are deduplicated by port before process filtering, so the first
listener reported for a port wins. A fixed process-name denylist removes known
desktop/system applications; everything else is considered development work.

Project roots are found by walking up at most 15 ancestors for one of seven
marker files. Project attribution selects the longest registered path that is
a string prefix of the detected root and displays only that path's basename.
Paths are not canonicalized and the match does not enforce a path-component
boundary.

Framework detection is ordered: command-line signatures, then process-name
fallbacks, then marker files. Missing `ps` or cwd data leaves memory at zero,
uptime empty, and project/framework values partially inferred.

Termination sends ordinary `kill` first and runs `kill -9` if that command
returns a non-success status. The force-kill process can spawn successfully but
return a failure status without causing a Rust error. Consequently the current
`Process killed` notice is approximate. The migration must preserve this
observable behavior initially; improving verification is a separate product
change.

## Current ownership

<!-- markdownlint-disable MD013 -->

| Concern | Current owner |
| --- | --- |
| Overlay activation and exclusivity | `src/stores/useUIStore.ts` |
| Footer entry and active appearance | `src/components/sidebar/SidebarFooter.tsx` |
| Overlay placement | `src/components/layout/AppShell.tsx` and `TabBar.tsx` |
| UI, scan/stop transitions, grouping, formatting | `src/components/ports/PortsPanel.tsx` |
| Flat IPC client and shared data type | `src/lib/tauri.ts`; `src/lib/types.ts` |
| Discovery, process policy, project matching, termination | Port section of `src-tauri/src/commands.rs` |
| Project authorization/context | `WorkspaceManager::list_repos` |
| URL opening and scheme policy | Host `commands::open_url` |

<!-- markdownlint-enable MD013 -->

The flat commands are registered in `src-tauri/src/lib.rs`. Unlike internal
plugins, they have no capability-specific permission resource.

## Target ownership and authority

Ports should own its UI, view transitions, types, listener parsing, development
process policy, framework detection, project-label policy, native commands,
tests, and permission resources under `modules/ports/`.

The host should retain:

- generic global-surface placement, activation, and failure containment;
- authorized registered-project context exposed through a narrow read port;
- constrained process observation and termination authority rather than an
  unrestricted shell executor;
- URL opening and terminal URL-allowlist enforcement;
- notices as a narrow frontend host service.

The module must not receive `WorkspaceManager`, a Zustand store, arbitrary
Tauri `invoke`, or a general command runner.

## Safe migration slices

The original combined migration task is now an epic with three ordered slices:

1. `shep-3w1.8.1.2.1` adds a generic global-surface/navigation contribution
   rail while the existing Ports overlay remains behind an adapter.
2. `shep-3w1.8.1.2.2` extracts native policy into an optional internal plugin
   with explicit permissions and temporary flat adapters.
3. `shep-3w1.8.1.2.3` moves the frontend and tests, switches to namespaced
   commands, and removes feature-specific host paths after proof.

The final gate remains `shep-3w1.8.1.3`: enabled, disabled, and source-absent
builds must pass using the reusable plug-out harness.

## Characterization coverage

Frontend checks protect:

- flat command names before cutover;
- occupied, empty, and rejected scans;
- stop success and failure notices;
- project grouping, `Other` ordering, memory, and uptime formatting;
- global overlay behavior across project switches.

Native checks protect:

- IPv4, IPv6, wildcard, and invalid listener names;
- development-process filtering;
- bounded missing-tool behavior;
- marker-based project-root discovery;
- framework precedence;
- longest registered-project matching.

The gate deliberately does not kill a real process or inspect private user
workspaces. Full refresh, browser, and termination interaction remains in the
Phase 0 manual smoke contract.
