import type {
  ModuleTerminalDimensions,
  ModuleTerminalSessionExitReason,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionsPort,
} from "@shep/module-api";

export type TerminalSessionsRuntime = Pick<
  ModuleTerminalSessionsPort,
  "launch" | "update" | "stop" | "focus"
>;

type TerminalSessionNotification = Extract<
  ModuleTerminalSessionLifecycleEvent,
  { readonly type: "started" | "exited" }
>;

export type TerminalSessionOwnerRequest = Extract<
  ModuleTerminalSessionLifecycleEvent,
  { readonly type: "rename-requested" | "placement-requested" | "stop-requested" }
>;

let runtime: TerminalSessionsRuntime | null = null;
let dimensionsProvider: () => ModuleTerminalDimensions = () => ({
  columns: 80,
  rows: 24,
});
const listeners = new Set<
  (event: ModuleTerminalSessionLifecycleEvent) => void | Promise<void>
>();

function getRuntime() {
  if (!runtime) {
    throw new Error("Terminal session service is unavailable before the host runtime mounts");
  }
  return runtime;
}

export function terminalSessionExitReason(
  requestedStop: boolean,
  exitCode: number,
): ModuleTerminalSessionExitReason {
  if (requestedStop) return "manual-stop";
  return exitCode === 0 ? "zero-exit" : "nonzero-exit";
}

export function bindTerminalSessionsRuntime(next: TerminalSessionsRuntime) {
  runtime = next;
  return () => {
    if (runtime === next) runtime = null;
  };
}

export function bindTerminalSessionDimensions(
  next: () => ModuleTerminalDimensions,
) {
  dimensionsProvider = next;
  return () => {
    if (dimensionsProvider === next) {
      dimensionsProvider = () => ({ columns: 80, rows: 24 });
    }
  };
}

export function publishTerminalSessionEvent(
  event: TerminalSessionNotification,
) {
  for (const listener of listeners) {
    try {
      void Promise.resolve(listener(event)).catch(() => undefined);
    } catch {
      // Lifecycle notifications cannot roll back a process event.
    }
  }
}

/**
 * Give the owning module a transactional boundary before a host mutation.
 * Listeners run in subscription order and a rejection prevents the mutation.
 */
export async function requestTerminalSessionOwnerAction(
  event: TerminalSessionOwnerRequest,
) {
  for (const listener of listeners) await listener(event);
}

export const MODULE_TERMINAL_SESSIONS: ModuleTerminalSessionsPort = {
  getDimensions: () => dimensionsProvider(),
  launch: (request) => getRuntime().launch(request),
  update: (sessionId, patch) => getRuntime().update(sessionId, patch),
  stop: (sessionId) => getRuntime().stop(sessionId),
  focus: (sessionId) => getRuntime().focus(sessionId),
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
