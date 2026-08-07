import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
} from "@shep/module-api";
import {
  bindTerminalSessionDimensions,
  bindTerminalSessionsRuntime,
  MODULE_TERMINAL_SESSIONS,
  publishTerminalSessionEvent,
  requestTerminalSessionOwnerAction,
  terminalSessionExitReason,
} from "../../src/core/modules/terminalSessions.ts";

const request: ModuleTerminalSessionLaunchRequest = {
  projectPath: "/repo",
  ownerKey: "commands:dev",
  command: "pnpm",
  arguments: ["run", "dev"],
  environment: { PORT: "4173" },
  cwd: "/repo/apps/web",
  label: "dev",
  ownerMetadata: { commandName: "dev" },
  presentation: {
    role: "terminal",
    icon: { src: "module://commands.svg", alt: "Command" },
  },
  columns: 132,
  rows: 42,
};

const session: ModuleTerminalSession = {
  id: "opaque-session",
  projectPath: request.projectPath,
  ownerKey: request.ownerKey,
  label: request.label,
  ownerMetadata: request.ownerMetadata,
  presentation: request.presentation,
};

test("the stable port forwards complete launch, stop, and focus requests", async () => {
  const calls: unknown[] = [];
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
    stop: async (sessionId) => {
      calls.push(["stop", sessionId]);
    },
    focus: async (sessionId) => {
      calls.push(["focus", sessionId]);
    },
  });

  assert.equal(await MODULE_TERMINAL_SESSIONS.launch(request), session);
  const patch = { label: "web", ownerMetadata: { commandName: "web" } };
  assert.equal((await MODULE_TERMINAL_SESSIONS.update(session.id, patch)).label, "web");
  await MODULE_TERMINAL_SESSIONS.focus(session.id);
  await MODULE_TERMINAL_SESSIONS.stop(session.id);

  assert.deepEqual(calls, [
    ["launch", request],
    ["update", session.id, patch],
    ["focus", session.id],
    ["stop", session.id],
  ]);
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

test("lifecycle subscriptions preserve opaque session ownership and unsubscribe", () => {
  const received: ModuleTerminalSessionLifecycleEvent[] = [];
  const unsubscribe = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    received.push(event);
  });
  const started: ModuleTerminalSessionLifecycleEvent = {
    type: "started",
    session,
  };
  const exited: ModuleTerminalSessionLifecycleEvent = {
    type: "exited",
    session,
    reason: "nonzero-exit",
    exitCode: 2,
  };

  publishTerminalSessionEvent(started);
  publishTerminalSessionEvent(exited);
  unsubscribe();
  publishTerminalSessionEvent(started);

  assert.deepEqual(received, [started, exited]);
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
    stop: async () => undefined,
    focus: async () => undefined,
  });
  const secondCleanup = bindTerminalSessionsRuntime({
    launch: async () => ({ ...session, id: "second" }),
    launchManaged: async () => ({ ...session, id: "second" }),
    update: async () => ({ ...session, id: "second" }),
    stop: async () => undefined,
    focus: async () => undefined,
  });

  firstCleanup();
  assert.equal((await MODULE_TERMINAL_SESSIONS.launch(request)).id, "second");
  secondCleanup();
  assert.throws(
    () => MODULE_TERMINAL_SESSIONS.launch(request),
    /unavailable before the host runtime mounts/,
  );
});
