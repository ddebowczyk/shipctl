import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionLifecycleEvent,
} from "@shep/module-api";
import {
  bindTerminalSessionsRuntime,
  MODULE_TERMINAL_SESSIONS,
  publishTerminalSessionEvent,
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
  columns: 132,
  rows: 42,
};

const session: ModuleTerminalSession = {
  id: "opaque-session",
  projectPath: request.projectPath,
  ownerKey: request.ownerKey,
  label: request.label,
};

test("the stable port forwards complete launch, stop, and focus requests", async () => {
  const calls: unknown[] = [];
  const unbind = bindTerminalSessionsRuntime({
    launch: async (received) => {
      calls.push(["launch", received]);
      return session;
    },
    stop: async (sessionId) => {
      calls.push(["stop", sessionId]);
    },
    focus: async (sessionId) => {
      calls.push(["focus", sessionId]);
    },
  });

  assert.equal(await MODULE_TERMINAL_SESSIONS.launch(request), session);
  await MODULE_TERMINAL_SESSIONS.focus(session.id);
  await MODULE_TERMINAL_SESSIONS.stop(session.id);

  assert.deepEqual(calls, [
    ["launch", request],
    ["focus", session.id],
    ["stop", session.id],
  ]);
  unbind();
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
    stop: async () => undefined,
    focus: async () => undefined,
  });
  const secondCleanup = bindTerminalSessionsRuntime({
    launch: async () => ({ ...session, id: "second" }),
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
