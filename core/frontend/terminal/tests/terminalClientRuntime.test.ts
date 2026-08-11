import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModuleTerminalSessionLifecycleEvent } from "@shipctl/module-api";

import {
  TerminalClientRuntime,
  type TerminalHostPort,
} from "../terminalClientRuntime.ts";
import {
  bindTerminalSessionsRuntime,
  MODULE_TERMINAL_SESSIONS,
} from "../terminalSessions.ts";
import type { TerminalInput } from "../terminalSemanticInput.ts";
import { useTerminalStore } from "../useTerminalStore.ts";
import type {
  TerminalCloseResult,
  TerminalDescriptor,
  TerminalId,
  TerminalRevision,
} from "../types.ts";

// The module session port replays adoptions on subscribe, so it needs a bound
// runtime. Nothing in these traces calls through it.
bindTerminalSessionsRuntime({
  list: () => [],
  launch: () => Promise.reject(new Error("unused")),
  launchManaged: () => Promise.reject(new Error("unused")),
  update: () => Promise.reject(new Error("unused")),
  observe: () => Promise.reject(new Error("unused")),
  stop: () => Promise.reject(new Error("unused")),
  focus: () => Promise.reject(new Error("unused")),
});

let nextTerminal = 0;

/** A distinct terminal per test, so no trace can be read as another's leak. */
function terminalId(): TerminalId {
  nextTerminal += 1;
  return `00000000-0000-4000-8000-${String(nextTerminal).padStart(12, "0")}` as TerminalId;
}

function descriptor(
  id: TerminalId,
  revision: number,
  lifecycle: TerminalDescriptor["lifecycle"] = "running",
): TerminalDescriptor {
  return {
    id,
    revision: revision as TerminalRevision,
    lifecycle,
    exit: lifecycle === "exited"
      ? { code: 0, reason: "process_exit", observedAtMs: 2 }
      : null,
    metadata: {
      label: "dev",
      cwd: "/repo",
      projectPath: "/repo",
      displayCommand: "pnpm",
      createdAtMs: 1,
      owner: {
        type: "module",
        moduleId: "commands",
        ownerKey: "commands:dev",
        moduleSessionId: `commands:${id}`,
      },
      ownerMetadata: null,
      presentation: null,
    },
    columns: 80,
    rows: 24,
    lastOutputAtMs: null,
    agentActivity: null,
  };
}

class FakeHost implements TerminalHostPort {
  listed: TerminalDescriptor[] = [];
  listCalls = 0;
  subscribeCalls = 0;
  closeCalls: TerminalId[] = [];
  writes: (string | Uint8Array)[] = [];
  inputs: TerminalInput[] = [];
  subscribeError: unknown = null;
  writeError: unknown = null;
  disposed = false;
  /** Runs inside `list`, after the reducer has taken its request boundary. */
  onList: (() => void) | null = null;
  /** Runs inside `close`, before the command resolves. */
  onClose: ((terminalId: TerminalId) => void) | null = null;

  async list(): Promise<TerminalDescriptor[]> {
    this.listCalls += 1;
    this.onList?.();
    return [...this.listed];
  }

  spawn(): Promise<TerminalDescriptor> {
    return Promise.reject(new Error("spawn is not part of these traces"));
  }

  updateMetadata(): Promise<TerminalDescriptor> {
    return Promise.reject(new Error("updateMetadata is not part of these traces"));
  }

  async subscribeRegistry(): Promise<{ id: string; dispose: () => Promise<void> }> {
    this.subscribeCalls += 1;
    if (this.subscribeError) throw this.subscribeError;
    return {
      id: `subscription-${this.subscribeCalls}`,
      dispose: async () => {
        this.disposed = true;
      },
    } as never;
  }

  attach(): Promise<never> {
    return Promise.reject(new Error("attach is not part of these traces"));
  }

  async detach(): Promise<void> {}

  async write(_terminalId: TerminalId, data: string | Uint8Array): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  async input(_terminalId: TerminalId, input: TerminalInput): Promise<number> {
    if (this.writeError) throw this.writeError;
    this.inputs.push(input);
    return input.kind === "key" ? 1 : 0;
  }

  async resize(): Promise<void> {}

  async close(terminalId: TerminalId): Promise<TerminalCloseResult> {
    this.closeCalls.push(terminalId);
    this.onClose?.(terminalId);
    return { existed: true, exit: null };
  }
}

/** Collect the module lifecycle stream for the duration of one trace. */
function recordModuleEvents(): {
  events: ModuleTerminalSessionLifecycleEvent[];
  stop: () => void;
} {
  const events: ModuleTerminalSessionLifecycleEvent[] = [];
  const stop = MODULE_TERMINAL_SESSIONS.subscribe((event) => {
    events.push(event);
  });
  return { events, stop };
}

test("a removal observed while a list is in flight defeats the stale row", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  host.listed = [descriptor(id, 1)];
  await runtime.reconcile();
  assert.ok(runtime.descriptor(id));

  // The host list still carries the row; the removal arrived after the request.
  host.onList = () => {
    runtime.observeRegistryEvent({ event: "removed", terminalId: id });
  };
  await runtime.reconcile();

  assert.equal(runtime.descriptor(id), undefined, "a stale list resurrected a removed terminal");
});

test("a descriptor observed while a list is in flight survives the older snapshot", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  host.listed = [descriptor(id, 1)];
  host.onList = () => {
    runtime.observeDescriptor(descriptor(id, 5));
  };
  await runtime.reconcile();

  assert.equal(runtime.descriptor(id)?.revision, 5);
});

test("a close whose removal already arrived needs no reconcile", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  host.onClose = (closed) => {
    runtime.observeRegistryEvent({ event: "removed", terminalId: closed });
  };

  assert.deepEqual(await runtime.close(id), { status: "closed" });
  assert.equal(host.listCalls, 0, "the removal was already reduced");
  assert.equal(runtime.descriptor(id), undefined);
});

test("a close whose removal has not arrived is settled by one reconcile", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  host.listed = [];

  assert.deepEqual(await runtime.close(id), { status: "closed" });
  assert.equal(host.listCalls, 1);
  assert.equal(runtime.descriptor(id), undefined);
});

test("an unconfirmed close reports itself and writes nothing", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  // The host command succeeded but the terminal is still listed and no removal
  // has been published.
  host.listed = [descriptor(id, 1)];
  const { events, stop } = recordModuleEvents();

  assert.deepEqual(await runtime.close(id), { status: "unconfirmed", terminalId: id });
  stop();

  assert.ok(runtime.descriptor(id), "an unconfirmed close must not synthesize a removal");
  assert.deepEqual(events.map((event) => event.type), []);
});

test("closing an already-absent terminal is a closed outcome", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();

  assert.deepEqual(await runtime.close(id), { status: "closed" });
  assert.deepEqual(host.closeCalls, [id], "the host stays the close authority");
  assert.equal(host.listCalls, 0);
});

test("a duplicate removal publishes one closed projection", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  const { events, stop } = recordModuleEvents();

  runtime.observeRegistryEvent({ event: "removed", terminalId: id });
  runtime.observeRegistryEvent({ event: "removed", terminalId: id });
  stop();

  assert.deepEqual(events.map((event) => event.type), ["closed"]);
});

test("an exit is announced once however many observations carry it", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  const { events, stop } = recordModuleEvents();

  runtime.observeDescriptor(descriptor(id, 2, "exited"));
  runtime.observeDescriptor(descriptor(id, 3, "exited"));
  host.listed = [descriptor(id, 4, "exited")];
  await runtime.reconcile();
  stop();

  assert.deepEqual(events.map((event) => event.type), ["exited"]);
});

test("an exit followed by a removal reports exit then close, once each", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  const { events, stop } = recordModuleEvents();

  runtime.observeDescriptor(descriptor(id, 2, "exited"));
  runtime.observeRegistryEvent({ event: "removed", terminalId: id });
  stop();

  assert.deepEqual(events.map((event) => event.type), ["exited", "closed"]);
});

test("an older or duplicate observation changes nothing", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 4), "adopted");
  const { events, stop } = recordModuleEvents();

  assert.equal(runtime.observeDescriptor(descriptor(id, 3)), false);
  assert.equal(runtime.observeDescriptor(descriptor(id, 4)), false);
  stop();

  assert.equal(runtime.descriptor(id)?.revision, 4);
  assert.deepEqual(events.map((event) => event.type), []);
});

test("the Zustand projection follows the reducer, including removal", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();

  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  assert.ok(
    useTerminalStore.getState().findTabByTerminalId(id),
    "a committed upsert must reach the projection",
  );

  runtime.observeRegistryEvent({ event: "removed", terminalId: id });
  assert.equal(
    useTerminalStore.getState().findTabByTerminalId(id),
    undefined,
    "a committed removal must leave the projection",
  );
  assert.equal(useTerminalStore.getState().tabActivity[id], undefined);
});

test("a subscription failure leaves no subscription and can be retried", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  host.subscribeError = new Error("registry channel refused");

  await assert.rejects(runtime.startRegistry());
  assert.equal(host.listCalls, 0, "a failed subscription must not reconcile");

  host.subscribeError = null;
  await runtime.startRegistry();
  assert.equal(host.subscribeCalls, 2);
  assert.equal(host.listCalls, 1, "a successful subscription reconciles once");
});

test("input to a terminal that is not running is unavailable, not a failure", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();

  assert.deepEqual(await runtime.write(id, "ls"), {
    status: "unavailable",
    reason: "not_found",
  });

  runtime.observeDescriptor(descriptor(id, 2, "exited"), "adopted");
  assert.deepEqual(await runtime.write(id, "ls"), {
    status: "unavailable",
    reason: "exited",
  });
  assert.deepEqual(host.writes, [], "nothing may reach the host");
});

test("accepted input reaches the host exactly as submitted", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");

  assert.deepEqual(await runtime.write(id, "ls\r"), { status: "accepted" });
  assert.deepEqual(host.writes, ["ls\r"]);
});

test("a host lifecycle refusal after the check is still unavailable", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  // The projection says running; the host has already seen the process exit.
  host.writeError = { code: "exited", message: "Terminal has exited" };

  assert.deepEqual(await runtime.write(id, "ls"), {
    status: "unavailable",
    reason: "exited",
  });
});

test("a real host failure is reported as a failure", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");

  for (const error of [
    { code: "io", message: "write failed" },
    { code: "invalid_request", message: "input too large" },
    new Error("the IPC bridge is gone"),
  ]) {
    host.writeError = error;
    const outcome = await runtime.write(id, "ls");
    assert.equal(outcome.status, "failed", `${JSON.stringify(error)} was not reported`);
  }
});

test("semantic input reaches the host as meaning, and the byte count is not carried on", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  const focus: TerminalInput = { kind: "focus", gained: true };

  // The host encodes nothing for a focus report the child never asked for.
  // That is an accepted input, not an unavailable one.
  assert.deepEqual(await runtime.input(id, focus), { status: "accepted" });
  assert.deepEqual(host.inputs, [focus]);
  assert.deepEqual(host.writes, [], "meaning never becomes bytes on this side");
});

test("semantic input obeys the same lifecycle rule as bytes", async () => {
  const host = new FakeHost();
  const runtime = new TerminalClientRuntime(host);
  const id = terminalId();
  runtime.observeDescriptor(descriptor(id, 1), "adopted");
  host.writeError = { code: "exited", message: "Terminal has exited" };

  assert.deepEqual(await runtime.input(id, { kind: "focus", gained: false }), {
    status: "unavailable",
    reason: "exited",
  });

  const unknown = terminalId();
  assert.deepEqual(await runtime.input(unknown, { kind: "focus", gained: false }), {
    status: "unavailable",
    reason: "not_found",
  });
});
