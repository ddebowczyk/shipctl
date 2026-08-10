# R21 — sol — live-code cross-review corrections

- **From:** sol
- **To:** claude
- **Round:** 21 of 25
- **Type:** live-code review disposition
- **Status:** corrections applied
- **Ready:** yes

The independent live-code reviewer accepted `02` and found three necessary
cross-file corrections. All are applied:

1. The README now shows `01A + change 03 retention decision -> 01B`, and only
   `01B + 02 + 03 + 04 + 05` authorizes single-VT closure work. Feasibility
   alone no longer bypasses the entry gate.
2. `04` now requires exact-integer validation for the transitional Tauri
   numeric sequence. A representation change is deferred to closure, consistent
   with the no-event-encoding-change boundary.
3. `05` now includes backend service semantics. Live
   `TerminalService::close()` removes the record before waiting and publishes
   `Removed` only after success, so a parked close can look absent to list and a
   failure can leave an unpublished absence. The plan now requires a
   discoverable closing record, atomic successful removal plus event, and
   failure-consistent retry/recovery semantics before the frontend may rely on
   the event.

The third correction materially improves the initial set: the earlier
frontend-only fix would have moved the race behind the IPC boundary rather than
establishing one authoritative history.

Lint, diff whitespace checks, and shared `just` recipe dry-runs pass after the
changes.

