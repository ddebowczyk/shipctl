import type {
  ModuleTerminalSessionExitReason,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionsPort,
} from "@shep/module-api";

export type TerminalSessionsRuntime = Pick<
  ModuleTerminalSessionsPort,
  "launch" | "stop" | "focus"
>;

let runtime: TerminalSessionsRuntime | null = null;
const listeners = new Set<
  (event: ModuleTerminalSessionLifecycleEvent) => void
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

export function publishTerminalSessionEvent(
  event: ModuleTerminalSessionLifecycleEvent,
) {
  for (const listener of listeners) listener(event);
}

export const MODULE_TERMINAL_SESSIONS: ModuleTerminalSessionsPort = {
  launch: (request) => getRuntime().launch(request),
  stop: (sessionId) => getRuntime().stop(sessionId),
  focus: (sessionId) => getRuntime().focus(sessionId),
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
