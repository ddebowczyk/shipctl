import {
  projectsService,
  terminalSessionsService,
  type ModuleActivationContext,
  type ModuleTerminalSession,
  type ModuleTerminalSessionLifecycleEvent,
  type SemanticEventLease,
  type SemanticRequestOperation,
  type TerminalSessionsErrorCode,
} from "@shipctl/module-api";

import { assistantPresentation } from "./branding";
import { CODING_ASSISTANTS } from "./catalog";
import { assistantLaunchClientFor, type AssistantLaunchClient } from "./assistantLaunchClient";
import {
  assistantProviderPolicy,
  type AssistantCaptureSnapshot,
} from "./assistantProviderPolicy";
import type {
  AssistantOwnerMetadata,
  AssistantSessionRecord,
  SessionMode,
} from "./types";

const OWNER_PREFIX = "assistants:";
const CAPTURE_RETRY_MS = 500;
const CAPTURE_MAX_ATTEMPTS = 20;
const RESTORE_PROBATION_MS = 5000;

const metadataBySession = new Map<string, AssistantOwnerMetadata>();
const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
const restoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingCaptures = new Map<string, {
  readonly record: AssistantSessionRecord;
  readonly snapshot: AssistantCaptureSnapshot;
}>();
let restoreAttempted = false;

class AssistantTerminalSessionsError extends Error {
  readonly code: TerminalSessionsErrorCode;

  constructor(code: TerminalSessionsErrorCode, message: string) {
    super(message);
    this.name = "AssistantTerminalSessionsError";
    this.code = code;
  }
}

async function executeTerminal<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, TerminalSessionsErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new AssistantTerminalSessionsError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

function terminalSessionsFor(activation: ModuleActivationContext) {
  return activation.services.require(terminalSessionsService);
}

function isOwned(session: ModuleTerminalSession) {
  return session.ownerKey.startsWith(OWNER_PREFIX);
}

function metadataOf(session: ModuleTerminalSession): AssistantOwnerMetadata | null {
  if (!isOwned(session)) return null;
  const value = session.ownerMetadata;
  if (typeof value !== "object" || value === null) return null;
  const metadata = value as Partial<AssistantOwnerMetadata>;
  return typeof metadata.provider === "string"
    && typeof metadata.mode === "string"
    && typeof metadata.restoring === "boolean"
    && (metadata.record === null || typeof metadata.record === "object")
    ? metadata as AssistantOwnerMetadata
    : null;
}

function clearTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  sessionId: string,
) {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
}

async function updateMetadata(
  activation: ModuleActivationContext,
  sessionId: string,
  metadata: AssistantOwnerMetadata,
) {
  metadataBySession.set(sessionId, metadata);
  if (metadata.record) {
    const pending = pendingCaptures.get(metadata.record.recordId);
    if (pending) pendingCaptures.set(metadata.record.recordId, { ...pending, record: metadata.record });
  }
  await executeTerminal(terminalSessionsFor(activation).updateSession, {
    sessionId,
    patch: {
      ownerMetadata: metadata,
      presentation: assistantPresentation(
        metadata.provider,
        metadata.record?.captureState ?? null,
      ),
    },
  });
}

async function capturePendingIdentity(
  record: AssistantSessionRecord,
  client: AssistantLaunchClient,
): Promise<AssistantSessionRecord | null> {
  const pending = pendingCaptures.get(record.recordId);
  const policy = assistantProviderPolicy(record.provider);
  if (!pending || !policy?.capture) {
    throw new Error("Assistant transcript capture snapshot was not available");
  }
  const identity = await policy.capture.findIdentity(record, pending.snapshot, client);
  if (identity === null) return null;
  const captured = await client.recordSessionIdentity(record.recordId, identity);
  pendingCaptures.delete(record.recordId);
  return captured;
}

function capturePendingSession(
  session: ModuleTerminalSession,
  metadata: AssistantOwnerMetadata,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  const record = metadata.record;
  if (!record
    || !["pending", "assigned"].includes(record.captureState)
    || !assistantProviderPolicy(record.provider)?.capture) return;
  let attempts = 0;

  const attemptCapture = async () => {
    if (activation.disposed) return;
    try {
      const captured = await capturePendingIdentity(record, client);
      if (captured) {
        clearTimer(captureTimers, session.id);
        await updateMetadata(activation, session.id, { ...metadata, record: captured });
        return;
      }

      attempts += 1;
      if (attempts < CAPTURE_MAX_ATTEMPTS) {
        captureTimers.set(
          session.id,
          setTimeout(() => void attemptCapture(), CAPTURE_RETRY_MS),
        );
        return;
      }

      if (record.captureState === "assigned") {
        clearTimer(captureTimers, session.id);
        return;
      }

      const failed = await client.failSessionCapture(record.recordId);
      pendingCaptures.delete(record.recordId);
      await updateMetadata(activation, session.id, { ...metadata, record: failed });
      activation.notices.push({
        tone: "info",
        title: `${record.provider} restore was not enabled`,
        message: "Shipctl could not identify this assistant session without guessing. The terminal is still running normally.",
      });
    } catch (error) {
      clearTimer(captureTimers, session.id);
      if (record.captureState === "assigned") return;
      pendingCaptures.delete(record.recordId);
      const failed = await client.failSessionCapture(record.recordId).catch(() => null);
      if (failed) {
        await updateMetadata(activation, session.id, { ...metadata, record: failed })
          .catch(() => undefined);
      }
      if (!activation.disposed) {
        activation.notices.push({
          tone: "info",
          title: `${record.provider} restore was not enabled`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  void attemptCapture();
}

async function handleLifecycle(
  event: ModuleTerminalSessionLifecycleEvent,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  if (!isOwned(event.session)) return;
  const metadata = metadataBySession.get(event.session.id) ?? metadataOf(event.session);
  if (!metadata) return;

  if (["launched", "adopted", "updated"].includes(event.type)) {
    metadataBySession.set(event.session.id, metadata);
    if (event.type !== "updated") capturePendingSession(event.session, metadata, activation, client);
    return;
  }

  if (event.type === "rename-requested") {
    if (!metadata.record) return;
    const record = await client.updateSessionLabel(metadata.record.recordId, event.label);
    await updateMetadata(activation, event.session.id, { ...metadata, record });
    return;
  }

  if (event.type === "placement-requested") {
    if (!metadata.record) return;
    const record = await client.updateSessionPlacement(metadata.record.recordId, event.projectPath);
    await updateMetadata(activation, event.session.id, { ...metadata, record });
    return;
  }

  if (event.type === "stop-requested") {
    clearTimer(captureTimers, event.session.id);
    clearTimer(restoreTimers, event.session.id);
    if (metadata.record) {
      pendingCaptures.delete(metadata.record.recordId);
      await client.discardSession(metadata.record.recordId);
    }
    return;
  }

  if (event.type === "closed") {
    clearTimer(captureTimers, event.session.id);
    clearTimer(restoreTimers, event.session.id);
    metadataBySession.delete(event.session.id);
    if (metadata.record) pendingCaptures.delete(metadata.record.recordId);
    return;
  }

  clearTimer(captureTimers, event.session.id);
  clearTimer(restoreTimers, event.session.id);
  metadataBySession.delete(event.session.id);
  if (!metadata.record) return;

  pendingCaptures.delete(metadata.record.recordId);

  if (metadata.restoring) {
    await client.rearmSession(metadata.record.recordId);
    activation.notices.push({
      tone: "info",
      title: `Couldn’t restore ${event.session.label}`,
      message: "The resumed process exited immediately. The saved session was kept for the next launch.",
    });
    return;
  }

  await client.discardSession(metadata.record.recordId).catch(() => undefined);
}

export async function launchAssistant(
  projectPath: string,
  assistantId: string,
  mode: SessionMode,
  model: string | undefined,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient = assistantLaunchClientFor(activation),
): Promise<boolean> {
  const assistant = CODING_ASSISTANTS.find(({ id }) => id === assistantId);
  if (!assistant) return false;
  const policy = assistantProviderPolicy(assistantId);
  if (!policy) return false;
  const metadata: AssistantOwnerMetadata = {
    provider: assistantId,
    mode,
    record: null,
    restoring: false,
  };

  try {
    const terminal = terminalSessionsFor(activation);
    const dimensions = await executeTerminal(terminal.dimensions, {});
    const moduleSessionId = `${OWNER_PREFIX}${crypto.randomUUID()}`;
    if (!policy.restorable) {
      const args: string[] = [];
      if (model) args.push(assistant.modelFlag, model);
      if (mode === "yolo" && assistant.yoloFlag) args.push(assistant.yoloFlag);
      await executeTerminal(terminal.startSession, {
        projectPath,
        moduleSessionId,
        ownerKey: `${OWNER_PREFIX}${assistantId}`,
        command: assistant.command,
        arguments: args,
        cwd: projectPath,
        label: assistant.name,
        ownerMetadata: metadata,
        presentation: assistantPresentation(assistantId),
        columns: dimensions.columns,
        rows: dimensions.rows,
      });
      return true;
    }

    const prepareNew = policy.prepareNew;
    if (!prepareNew) throw new Error(`Assistant provider '${policy.id}' has no launch policy`);
    await executeTerminal(terminal.startManagedSession, {
      projectPath,
      moduleSessionId,
      ownerKey: `${OWNER_PREFIX}${assistantId}`,
      cwd: projectPath,
      label: assistant.name,
      ownerMetadata: metadata,
      presentation: assistantPresentation(assistantId, "pending"),
      columns: dimensions.columns,
      rows: dimensions.rows,
      start: async (context) => {
        const preparation = prepareNew({ mode, model });
        const snapshot = policy.capture === undefined
          ? null
          : await policy.capture.snapshot(
            projectPath,
            client,
            preparation.initialSessionIdentity,
          );
        const spawned = await client.spawnAssistantSession(
          {
            provider: policy.id,
            launchRepoPath: projectPath,
            placementProjectPath: projectPath,
            label: assistant.name,
            sessionMode: mode,
            model,
            launch: preparation.launch,
            initialSessionIdentity: preparation.initialSessionIdentity,
          },
          context,
        );
        if (snapshot) {
          pendingCaptures.set(spawned.record.recordId, {
            record: spawned.record,
            snapshot,
          });
        }
        return {
          terminalId: spawned.terminalId,
          ownerMetadata: { ...metadata, record: spawned.record },
          presentation: assistantPresentation(policy.id, spawned.record.captureState),
        };
      },
    });
    return true;
  } catch (error) {
    activation.notices.push({
      tone: "error",
      title: `Couldn’t launch ${assistant.name}`,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function resumeRecord(
  record: AssistantSessionRecord,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  const policy = assistantProviderPolicy(record.provider);
  if (!policy?.restorable || !policy.prepareResume) {
    throw new Error(`Assistant provider '${record.provider}' is not declared by this artifact`);
  }
  const launch = policy.prepareResume(record);
  const terminal = terminalSessionsFor(activation);
  const dimensions = await executeTerminal(terminal.dimensions, {});
  const metadata: AssistantOwnerMetadata = {
    provider: record.provider,
    mode: record.sessionMode,
    record,
    restoring: true,
  };
  const session = await executeTerminal(terminal.startManagedSession, {
    projectPath: record.placementProjectPath,
    moduleSessionId: `${OWNER_PREFIX}${record.recordId}`,
    ownerKey: `${OWNER_PREFIX}${record.provider}`,
    cwd: record.launchRepoPath,
    label: record.label,
    ownerMetadata: metadata,
    presentation: assistantPresentation(record.provider, record.captureState),
    columns: dimensions.columns,
    rows: dimensions.rows,
    start: async (context) => {
      const snapshot = record.captureState === "assigned" && policy.capture
        ? await policy.capture.snapshot(record.launchRepoPath, client)
        : null;
      const spawned = await client.resumeAssistantSession(record.recordId, launch, context);
      if (snapshot) {
        pendingCaptures.set(spawned.record.recordId, { record: spawned.record, snapshot });
      }
      return {
        terminalId: spawned.terminalId,
        ownerMetadata: { ...metadata, record: spawned.record },
        presentation: assistantPresentation(spawned.record.provider, spawned.record.captureState),
      };
    },
  });

  restoreTimers.set(session.id, setTimeout(() => {
    const current = metadataBySession.get(session.id);
    if (!current || activation.disposed) return;
    void updateMetadata(activation, session.id, { ...current, restoring: false })
      .catch(() => undefined);
    restoreTimers.delete(session.id);
  }, RESTORE_PROBATION_MS));
}

function showRestoreRecovery(
  record: AssistantSessionRecord,
  message: string,
  projectPaths: ReadonlySet<string>,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  const retry = () => void restoreRecord(record, projectPaths, activation, client);
  const discard = () => void discardSavedRecord(record, projectPaths, activation, client);
  activation.notices.push({
    tone: "info",
    title: `Couldn’t restore ${record.label}`,
    message: `${message} The saved session was kept for a future retry.`,
    actions: [
      { label: "Retry", onClick: retry },
      { label: "Discard saved session", variant: "secondary", onClick: discard },
    ],
  }, { durationMs: 0 });
}

async function discardSavedRecord(
  record: AssistantSessionRecord,
  projectPaths: ReadonlySet<string>,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  try {
    await client.discardSession(record.recordId);
    activation.notices.push({
      tone: "success",
      title: `Discarded ${record.label}`,
      message: "Shipctl will not attempt to restore this saved session again.",
    });
  } catch (error) {
    showRestoreRecovery(
      record,
      error instanceof Error ? error.message : String(error),
      projectPaths,
      activation,
      client,
    );
  }
}

async function restoreRecord(
  record: AssistantSessionRecord,
  projectPaths: ReadonlySet<string>,
  activation: ModuleActivationContext,
  client: AssistantLaunchClient,
) {
  if (!projectPaths.has(record.placementProjectPath)) {
    showRestoreRecovery(
      record,
      "Its placement project is no longer registered in Shipctl.",
      projectPaths,
      activation,
      client,
    );
    return;
  }
  try {
    await resumeRecord(record, activation, client);
  } catch (error) {
    showRestoreRecovery(
      record,
      error instanceof Error ? error.message : String(error),
      projectPaths,
      activation,
      client,
    );
  }
}

export async function restoreAssistantSessions(
  projectPaths: readonly string[],
  activation: ModuleActivationContext,
  client: AssistantLaunchClient = assistantLaunchClientFor(activation),
) {
  if (restoreAttempted || projectPaths.length === 0) return;
  restoreAttempted = true;
  const registered = new Set(projectPaths);
  try {
    const warning = await client.takeStartupWarning();
    if (warning) {
      activation.notices.push({
        tone: "info",
        title: "Assistant sessions were not restored",
        message: warning,
      });
    }
    const records = await client.listRestorableSessions();
    for (const record of records) await restoreRecord(record, registered, activation, client);
  } catch (error) {
    activation.notices.push({
      tone: "info",
      title: "Assistant sessions were not restored",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Give plugin-owned capture strategies one final bounded attempt before the
 * generic native registry freezes ready records for a normal shutdown.
 */
export async function prepareAssistantsForShutdown(
  activation: ModuleActivationContext,
  client: AssistantLaunchClient = assistantLaunchClientFor(activation),
): Promise<void> {
  for (const { record } of [...pendingCaptures.values()]) {
    try {
      const captured = await capturePendingIdentity(record, client);
      if (!captured) continue;
      const session = [...metadataBySession.entries()].find(
        ([, metadata]) => metadata.record?.recordId === captured.recordId,
      );
      if (session) {
        await updateMetadata(activation, session[0], {
          ...session[1],
          record: captured,
        });
      }
    } catch {
      // Match the previous native final scan: it is best-effort and the
      // registry removes still-pending records during the shutdown freeze.
    }
  }
  await client.beginAssistantSessionPreservingShutdown();
}

/** Own terminal and project leases through a direct plugin activation. */
export async function activateAssistantsRuntime(
  activation: ModuleActivationContext,
  client: AssistantLaunchClient = assistantLaunchClientFor(activation),
): Promise<() => Promise<void>> {
  let active = true;
  let terminalSubscription: SemanticEventLease | null = null;
  let projectSubscription: SemanticEventLease | null = null;

  const cleanup = async () => {
    if (!active) return;
    active = false;
    await terminalSubscription?.dispose();
    await projectSubscription?.dispose();
    for (const sessionId of [...captureTimers.keys()]) clearTimer(captureTimers, sessionId);
    for (const sessionId of [...restoreTimers.keys()]) clearTimer(restoreTimers, sessionId);
    metadataBySession.clear();
    pendingCaptures.clear();
    restoreAttempted = false;
  };

  try {
    const terminal = terminalSessionsFor(activation);
    const projects = activation.services.require(projectsService);
    terminalSubscription = await terminal.lifecycle.subscribe({ owner: "activation" }, ({ value }) =>
      handleLifecycle(value, activation, client));
    projectSubscription = await projects.observeProjects.subscribe("catalog", async ({ value }) => {
      if (!active) return;
      if (value.kind === "catalog-changed" || value.kind === "filesystem-changed") {
        await restoreAssistantSessions(value.projectIds, activation, client);
      }
    });
    const initial = await projects.listProjects.execute({});
    if (initial.result.ok) {
      await restoreAssistantSessions(initial.result.value.projectIds, activation, client);
    } else {
      activation.notices.push({
        tone: "info",
        title: "Assistant sessions were not restored",
        message: initial.result.error.message,
      });
    }
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
