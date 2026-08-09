import type {
  ModuleTerminalDimensions,
  ModuleTerminalId,
  ModuleTerminalSession,
  ModuleTerminalSessionExitReason,
  ModuleTerminalSessionLifecycleEvent,
  ModuleTerminalSessionPresentation,
  ModuleTerminalSessionsPort,
} from "@shipctl/module-api";

import type { JsonValue, TerminalDescriptor } from "./types.ts";

export type TerminalSessionsRuntime = Pick<
  ModuleTerminalSessionsPort,
  "launch" | "launchManaged" | "update" | "observe" | "stop" | "focus"
> & {
  list(): readonly ModuleTerminalSession[];
};

export type TerminalSessionOwnerRequest = Extract<
  ModuleTerminalSessionLifecycleEvent,
  { readonly type: "rename-requested" | "placement-requested" | "stop-requested" }
>;

type TerminalProjectionEvent = "launched" | "adopted" | "updated";

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

function isObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function presentationFromJson(
  value: JsonValue | null,
): ModuleTerminalSessionPresentation | undefined {
  if (!isObject(value)) return undefined;
  const show = value.showInSessionList;
  if (show !== undefined && typeof show !== "boolean") return undefined;

  const icon = value.icon;
  if (icon !== undefined && (!isObject(icon) || typeof icon.src !== "string")) return undefined;
  const badge = value.badge;
  if (
    badge !== undefined
    && (
      !isObject(badge)
      || typeof badge.label !== "string"
      || typeof badge.title !== "string"
      || !["muted", "attention", "success"].includes(String(badge.tone))
    )
  ) return undefined;

  return value as ModuleTerminalSessionPresentation;
}

/** Derive a module session solely from host-discoverable public metadata. */
export function terminalSessionFromDescriptor(
  descriptor: TerminalDescriptor,
): ModuleTerminalSession | null {
  const owner = descriptor.metadata.owner;
  if (owner.type !== "module") return null;
  return {
    id: owner.moduleSessionId,
    terminalId: descriptor.id as unknown as ModuleTerminalId,
    moduleId: owner.moduleId,
    projectPath: descriptor.metadata.projectPath ?? descriptor.metadata.cwd,
    ownerKey: owner.ownerKey,
    label: descriptor.metadata.label,
    ...(descriptor.metadata.ownerMetadata === null
      ? {}
      : { ownerMetadata: descriptor.metadata.ownerMetadata }),
    ...(presentationFromJson(descriptor.metadata.presentation) === undefined
      ? {}
      : { presentation: presentationFromJson(descriptor.metadata.presentation) }),
    ...(descriptor.agentActivity === null
      ? {}
      : { agentActivity: descriptor.agentActivity }),
  };
}

export function terminalSessionExitReason(
  requestedStop: boolean,
  exitCode: number,
): ModuleTerminalSessionExitReason {
  if (requestedStop) return "manual-stop";
  return exitCode === 0 ? "zero-exit" : "nonzero-exit";
}

function notify(event: ModuleTerminalSessionLifecycleEvent) {
  for (const listener of listeners) {
    try {
      void Promise.resolve(listener(event)).catch(() => undefined);
    } catch {
      // Projection notifications cannot roll back authoritative host state.
    }
  }
}

function replayAdoptions(
  listener: (event: ModuleTerminalSessionLifecycleEvent) => void | Promise<void>,
) {
  if (!runtime) return;
  for (const session of runtime.list()) {
    try {
      void Promise.resolve(listener({ type: "adopted", session })).catch(() => undefined);
    } catch {
      // One module cannot prevent other modules from activating.
    }
  }
}

export function bindTerminalSessionsRuntime(next: TerminalSessionsRuntime) {
  runtime = next;
  for (const listener of listeners) replayAdoptions(listener);
  return () => {
    if (runtime === next) runtime = null;
  };
}

export function bindTerminalSessionDimensions(next: () => ModuleTerminalDimensions) {
  dimensionsProvider = next;
  return () => {
    if (dimensionsProvider === next) {
      dimensionsProvider = () => ({ columns: 80, rows: 24 });
    }
  };
}

export function publishTerminalDescriptor(
  descriptor: TerminalDescriptor,
  event: TerminalProjectionEvent,
) {
  const session = terminalSessionFromDescriptor(descriptor);
  if (!session) return;
  if (descriptor.lifecycle === "exited") {
    const exitCode = descriptor.exit?.code ?? null;
    notify({
      type: "exited",
      session,
      reason: terminalSessionExitReason(false, exitCode ?? 1),
      exitCode,
    });
    return;
  }
  notify({ type: event, session });
}

export function publishTerminalClosed(descriptor: TerminalDescriptor) {
  const session = terminalSessionFromDescriptor(descriptor);
  if (session) notify({ type: "closed", session });
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
  list: () => getRuntime().list(),
  launch: (request) => getRuntime().launch(request),
  launchManaged: (request) => getRuntime().launchManaged(request),
  update: (sessionId, patch) => getRuntime().update(sessionId, patch),
  observe: (sessionId, listener) => getRuntime().observe(sessionId, listener),
  stop: (sessionId) => getRuntime().stop(sessionId),
  focus: (sessionId) => getRuntime().focus(sessionId),
  subscribe(listener) {
    listeners.add(listener);
    replayAdoptions(listener);
    return () => listeners.delete(listener);
  },
};
