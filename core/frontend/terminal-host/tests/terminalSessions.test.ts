import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
} from "@shipctl/module-api";
import {
  bindTerminalSessionDimensions,
  bindTerminalSessionsRuntime,
  MODULE_TERMINAL_SESSIONS,
  publishTerminalClosed,
  publishTerminalDescriptor,
  requestTerminalSessionOwnerAction,
  terminalSessionFromDescriptor,
  terminalSessionExitReason,
} from "../terminalSessions.ts";
import type { TerminalDescriptor, TerminalId } from "../types.ts";

const request: ModuleTerminalSessionLaunchRequest = {
  projectPath: "/repo",
  moduleSessionId: "commands:invocation-one",
  ownerKey: "commands:dev",
  command: "pnpm",
  arguments: ["run", "dev"],
  environment: { PORT: "4173" },
  cwd: "/repo/apps/web",
  label: "dev",
  ownerMetadata: { commandName: "dev" },
  presentation: {
    showInSessionList: true,
    icon: { src: "module://commands.svg", alt: "Command" },
  },
  columns: 132,
  rows: 42,
};

const session: ModuleTerminalSession = {
  id: request.moduleSessionId,
  terminalId: "00000000-0000-4000-8000-000000000001" as ModuleTerminalSession["terminalId"],
  moduleId: "commands",
  projectPath: request.projectPath,
  ownerKey: request.ownerKey,
  label: request.label,
  ownerMetadata: request.ownerMetadata,
  presentation: request.presentation,
};

function descriptor(
  lifecycle: TerminalDescriptor["lifecycle"] = "running",
  exitCode: number | null = null,
): TerminalDescriptor {
  return {
    id: session.terminalId as unknown as TerminalId,
    revision: lifecycle === "exited" ? 2 : 1,
    lifecycle,
    exit: lifecycle === "exited"
      ? { code: exitCode, reason: "process_exit", observedAtMs: 2 }
      : null,
    metadata: {
      label: session.label,
      cwd: "/repo/apps/web",
      projectPath: session.projectPath,
      displayCommand: "pnpm",
      createdAtMs: 1,
      owner: {
        type: "module",
        moduleId: session.moduleId,
        ownerKey: session.ownerKey,
        moduleSessionId: session.id,
      },
      ownerMetadata: request.ownerMetadata ?? null,
      presentation: request.presentation ?? null,
    },
    columns: 132,
    rows: 42,
    lastOutputAtMs: null,
    agentActivity: null,
  };
}

test("the stable port forwards complete launch, stop, and focus requests", async () => {
  const calls: unknown[] = [];
  const observation = { dispose: async () => undefined };
  const unbind = bindTerminalSessionsRuntime({
    launch: async (received) => {
      calls.push(["launch", received]);
      return session;
    },
    launchManaged: async () => session,
    update: async (sessionId, patch) => {
      calls.push(["update", sessionId, patch]);
      return { ...session, ...patch };
    },
    observe: async (sessionId, listener) => {
      calls.push(["observe", sessionId]);
      listener({ type: "data", data: [65] });
      return observation;
    },
    stop: async (sessionId) => {
      calls.push(["stop", sessionId]);
    },
    focus: async (sessionId) => {
      calls.push(["focus", sessionId]);
    },
    list: () => [],
  });

  assert.equal(await MODULE_TERMINAL_SESSIONS.launch(request), session);
  assert.deepEqual(MODULE_TERMINAL_SESSIONS.list(), []);
  const patch = { label: "web", ownerMetadata: { commandName: "web" } };
  assert.equal((await MODULE_TERMINAL_SESSIONS.update(session.id, patch)).label, "web");
  const observed: unknown[] = [];
  assert.equal(
    await MODULE_TERMINAL_SESSIONS.observe(session.id, (event) => observed.push(event)),
    observation,
  );
  await MODULE_TERMINAL_SESSIONS.focus(session.id);
  await MODULE_TERMINAL_SESSIONS.stop(session.id);

  assert.deepEqual(calls, [
    ["launch", request],
    ["update", session.id, patch],
    ["observe", session.id],
    ["focus", session.id],
    ["stop", session.id],
  ]);
  assert.deepEqual(observed, [{ type: "data", data: [65] }]);
  unbind();
});

test("host owner requests are awaited in order and preserve opaque state", async () => {
  const calls: string[] = [];
  const first = MODULE_TERMINAL_SESSIONS.subscribe(async (event) => {
    if (event.type !== "placement-requested") return;
    await Promise.resolve();
    calls.push(`first:${String((event.session.ownerMetadata as { commandName: string }).commandName)}`);
  });
  const second = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    if (event.type === "placement-requested") calls.push(`second:${event.projectPath}`);
  });

  await requestTerminalSessionOwnerAction({
    type: "placement-requested",
    session,
    projectPath: "/repo-two",
  });
  assert.deepEqual(calls, ["first:dev", "second:/repo-two"]);

  first();
  second();
});

test("a rejected owner request prevents later listeners from observing a mutation", async () => {
  const calls: string[] = [];
  const first = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    if (event.type === "rename-requested") throw new Error("persistence failed");
  });
  const second = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    if (event.type === "rename-requested") calls.push(event.label);
  });

  await assert.rejects(
    requestTerminalSessionOwnerAction({
      type: "rename-requested",
      session,
      label: "web",
    }),
    /persistence failed/,
  );
  assert.deepEqual(calls, []);

  first();
  second();
});

test("terminal dimensions are host-supplied and reset to safe defaults", () => {
  const unbind = bindTerminalSessionDimensions(() => ({ columns: 132, rows: 42 }));
  assert.deepEqual(MODULE_TERMINAL_SESSIONS.getDimensions(), {
    columns: 132,
    rows: 42,
  });
  unbind();
  assert.deepEqual(MODULE_TERMINAL_SESSIONS.getDimensions(), {
    columns: 80,
    rows: 24,
  });
});

test("host descriptors reconstruct module sessions without renderer-owned identity", () => {
  assert.deepEqual(terminalSessionFromDescriptor(descriptor()), session);

  const agentActivity = {
    revision: 3,
    state: "working" as const,
    message: "reviewing",
    updatedAtMs: 4,
    source: { identifier: "codex", version: "1" },
    attention: null,
  };
  assert.deepEqual(
    terminalSessionFromDescriptor({ ...descriptor(), agentActivity }),
    { ...session, agentActivity },
  );
});

test("lifecycle subscriptions adopt inventory and distinguish exit from close", () => {
  const received: ModuleTerminalSessionLifecycleEvent[] = [];
  const unbind = bindTerminalSessionsRuntime({
    launch: async () => session,
    launchManaged: async () => session,
    update: async () => session,
    observe: async () => ({ dispose: async () => undefined }),
    stop: async () => undefined,
    focus: async () => undefined,
    list: () => [session],
  });
  const unsubscribe = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    received.push(event);
  });
  publishTerminalDescriptor(descriptor(), "updated");
  publishTerminalDescriptor(descriptor("exited", 2), "updated");
  publishTerminalClosed(descriptor("exited", 2));
  unsubscribe();
  publishTerminalDescriptor(descriptor(), "updated");
  unbind();

  assert.deepEqual(received.map((event) => event.type), [
    "adopted",
    "updated",
    "exited",
    "closed",
  ]);
});

test("exit classification distinguishes manual, zero, and nonzero outcomes", () => {
  assert.equal(terminalSessionExitReason(true, 0), "manual-stop");
  assert.equal(terminalSessionExitReason(false, 0), "zero-exit");
  assert.equal(terminalSessionExitReason(false, 1), "nonzero-exit");
  assert.equal(terminalSessionExitReason(false, -1), "nonzero-exit");
});

test("a stale React cleanup cannot unbind a newer runtime", async () => {
  const firstCleanup = bindTerminalSessionsRuntime({
    launch: async () => ({ ...session, id: "first" }),
    launchManaged: async () => ({ ...session, id: "first" }),
    update: async () => ({ ...session, id: "first" }),
    observe: async () => ({ dispose: async () => undefined }),
    stop: async () => undefined,
    focus: async () => undefined,
    list: () => [],
  });
  const secondCleanup = bindTerminalSessionsRuntime({
    launch: async () => ({ ...session, id: "second" }),
    launchManaged: async () => ({ ...session, id: "second" }),
    update: async () => ({ ...session, id: "second" }),
    observe: async () => ({ dispose: async () => undefined }),
    stop: async () => undefined,
    focus: async () => undefined,
    list: () => [],
  });

  firstCleanup();
  assert.equal((await MODULE_TERMINAL_SESSIONS.launch(request)).id, "second");
  secondCleanup();
  assert.throws(
    () => MODULE_TERMINAL_SESSIONS.launch(request),
    /unavailable before the host runtime mounts/,
  );
});
