import type {
  ModuleHostServices,
  ModuleTerminalSession,
  ModuleTerminalSessionLifecycleEvent,
} from "@shipctl/module-api";

import { assistantPresentation } from "./branding";
import { CODING_ASSISTANTS, restorableProvider } from "./catalog";
import {
  discardSession,
  failSessionCapture,
  listRestorableSessions,
  rearmSession,
  resumeAssistantSession,
  spawnAssistantSession,
  takeStartupWarning,
  tryCaptureCodexSession,
  updateSessionLabel,
  updateSessionPlacement,
} from "./client";
import type {
  AssistantOwnerMetadata,
  AssistantSessionRecord,
  SessionMode,
} from "./types";

const OWNER_PREFIX = "assistants:";
const CODEX_CAPTURE_RETRY_MS = 500;
const CODEX_CAPTURE_MAX_ATTEMPTS = 20;
const RESTORE_PROBATION_MS = 5000;

const metadataBySession = new Map<string, AssistantOwnerMetadata>();
const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
const restoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
let restoreAttempted = false;

function isOwned(session: ModuleTerminalSession) {
  return session.ownerKey.startsWith(OWNER_PREFIX);
}

function metadataOf(session: ModuleTerminalSession): AssistantOwnerMetadata | null {
  if (!isOwned(session)) return null;
  const value = session.ownerMetadata;
  if (typeof value !== "object" || value === null) return null;
  const metadata = value as Partial<AssistantOwnerMetadata>;
  return typeof metadata.provider === "string"
    && (metadata.mode === "standard" || metadata.mode === "yolo")
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
  services: ModuleHostServices,
  sessionId: string,
  metadata: AssistantOwnerMetadata,
) {
  metadataBySession.set(sessionId, metadata);
  await services.terminalSessions.update(sessionId, {
    ownerMetadata: metadata,
    presentation: assistantPresentation(
      metadata.provider,
      metadata.record?.captureState ?? null,
    ),
  });
}

function captureCodexSession(
  session: ModuleTerminalSession,
  metadata: AssistantOwnerMetadata,
  services: ModuleHostServices,
) {
  const record = metadata.record;
  if (record?.provider !== "codex" || record.captureState !== "pending") return;
  let attempts = 0;

  const attemptCapture = async () => {
    try {
      const captured = await tryCaptureCodexSession(record.recordId);
      if (captured) {
        clearTimer(captureTimers, session.id);
        await updateMetadata(services, session.id, { ...metadata, record: captured });
        return;
      }

      attempts += 1;
      if (attempts < CODEX_CAPTURE_MAX_ATTEMPTS) {
        captureTimers.set(
          session.id,
          setTimeout(() => void attemptCapture(), CODEX_CAPTURE_RETRY_MS),
        );
        return;
      }

      const failed = await failSessionCapture(record.recordId);
      await updateMetadata(services, session.id, { ...metadata, record: failed });
      services.notices.push({
        tone: "info",
        title: "Codex restore was not enabled",
        message: "Shipctl could not identify this Codex session without guessing. The terminal is still running normally.",
      });
    } catch (error) {
      clearTimer(captureTimers, session.id);
      const failed = await failSessionCapture(record.recordId).catch(() => null);
      if (failed) {
        await updateMetadata(services, session.id, { ...metadata, record: failed }).catch(() => undefined);
      }
      services.notices.push({
        tone: "info",
        title: "Codex restore was not enabled",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void attemptCapture();
}

async function handleLifecycle(
  event: ModuleTerminalSessionLifecycleEvent,
  services: ModuleHostServices,
) {
  if (!isOwned(event.session)) return;
  const metadata = metadataBySession.get(event.session.id) ?? metadataOf(event.session);
  if (!metadata) return;

  if (["launched", "adopted", "updated"].includes(event.type)) {
    metadataBySession.set(event.session.id, metadata);
    if (event.type !== "updated") captureCodexSession(event.session, metadata, services);
    return;
  }

  if (event.type === "rename-requested") {
    if (!metadata.record) return;
    const record = await updateSessionLabel(metadata.record.recordId, event.label);
    await updateMetadata(services, event.session.id, { ...metadata, record });
    return;
  }

  if (event.type === "placement-requested") {
    if (!metadata.record) return;
    const record = await updateSessionPlacement(metadata.record.recordId, event.projectPath);
    await updateMetadata(services, event.session.id, { ...metadata, record });
    return;
  }

  if (event.type === "stop-requested") {
    clearTimer(captureTimers, event.session.id);
    clearTimer(restoreTimers, event.session.id);
    if (metadata.record) await discardSession(metadata.record.recordId);
    return;
  }

  if (event.type === "closed") {
    clearTimer(captureTimers, event.session.id);
    clearTimer(restoreTimers, event.session.id);
    metadataBySession.delete(event.session.id);
    return;
  }

  clearTimer(captureTimers, event.session.id);
  clearTimer(restoreTimers, event.session.id);
  metadataBySession.delete(event.session.id);
  if (!metadata.record) return;

  if (metadata.restoring) {
    await rearmSession(metadata.record.recordId);
    services.notices.push({
      tone: "info",
      title: `Couldn’t restore ${event.session.label}`,
      message: "The resumed process exited immediately. The saved session was kept for the next launch.",
    });
    return;
  }

  await discardSession(metadata.record.recordId).catch(() => undefined);
}

export async function launchAssistant(
  projectPath: string,
  assistantId: string,
  mode: SessionMode,
  model: string | undefined,
  services: ModuleHostServices,
): Promise<boolean> {
  const assistant = CODING_ASSISTANTS.find(({ id }) => id === assistantId);
  if (!assistant) return false;
  const provider = restorableProvider(assistantId);
  const dimensions = services.terminalSessions.getDimensions();
  const metadata: AssistantOwnerMetadata = {
    provider: assistantId,
    mode,
    record: null,
    restoring: false,
  };

  try {
    const moduleSessionId = `${OWNER_PREFIX}${crypto.randomUUID()}`;
    if (!provider) {
      const args: string[] = [];
      if (model) args.push(assistant.modelFlag, model);
      if (mode === "yolo" && assistant.yoloFlag) args.push(assistant.yoloFlag);
      await services.terminalSessions.launch({
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

    await services.terminalSessions.launchManaged({
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
        const spawned = await spawnAssistantSession(
          {
            provider,
            launchRepoPath: projectPath,
            placementProjectPath: projectPath,
            label: assistant.name,
            sessionMode: mode,
            model,
          },
          context,
        );
        return {
          terminalId: spawned.terminalId,
          ownerMetadata: { ...metadata, record: spawned.record },
          presentation: assistantPresentation(provider, spawned.record.captureState),
        };
      },
    });
    return true;
  } catch (error) {
    services.notices.push({
      tone: "error",
      title: `Couldn’t launch ${assistant.name}`,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function resumeRecord(
  record: AssistantSessionRecord,
  services: ModuleHostServices,
) {
  const dimensions = services.terminalSessions.getDimensions();
  const metadata: AssistantOwnerMetadata = {
    provider: record.provider,
    mode: record.sessionMode,
    record,
    restoring: true,
  };
  const session = await services.terminalSessions.launchManaged({
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
      const spawned = await resumeAssistantSession(record.recordId, context);
      return {
        terminalId: spawned.terminalId,
        ownerMetadata: { ...metadata, record: spawned.record },
        presentation: assistantPresentation(spawned.record.provider, spawned.record.captureState),
      };
    },
  });

  restoreTimers.set(session.id, setTimeout(() => {
    const current = metadataBySession.get(session.id);
    if (!current) return;
    void updateMetadata(services, session.id, { ...current, restoring: false })
      .catch(() => undefined);
    restoreTimers.delete(session.id);
  }, RESTORE_PROBATION_MS));
}

function showRestoreRecovery(
  record: AssistantSessionRecord,
  message: string,
  projectPaths: ReadonlySet<string>,
  services: ModuleHostServices,
) {
  const retry = () => void restoreRecord(record, projectPaths, services);
  const discard = () => void discardSavedRecord(record, projectPaths, services);
  services.notices.push({
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
  services: ModuleHostServices,
) {
  try {
    await discardSession(record.recordId);
    services.notices.push({
      tone: "success",
      title: `Discarded ${record.label}`,
      message: "Shipctl will not attempt to restore this saved session again.",
    });
  } catch (error) {
    showRestoreRecovery(record, error instanceof Error ? error.message : String(error), projectPaths, services);
  }
}

async function restoreRecord(
  record: AssistantSessionRecord,
  projectPaths: ReadonlySet<string>,
  services: ModuleHostServices,
) {
  if (!projectPaths.has(record.placementProjectPath)) {
    showRestoreRecovery(
      record,
      "Its placement project is no longer registered in Shipctl.",
      projectPaths,
      services,
    );
    return;
  }
  try {
    await resumeRecord(record, services);
  } catch (error) {
    showRestoreRecovery(record, error instanceof Error ? error.message : String(error), projectPaths, services);
  }
}

export async function restoreAssistantSessions(
  projectPaths: readonly string[],
  services: ModuleHostServices,
) {
  if (restoreAttempted || projectPaths.length === 0) return;
  restoreAttempted = true;
  const registered = new Set(projectPaths);
  try {
    const warning = await takeStartupWarning();
    if (warning) {
      services.notices.push({
        tone: "info",
        title: "Assistant sessions were not restored",
        message: warning,
      });
    }
    const records = await listRestorableSessions();
    for (const record of records) await restoreRecord(record, registered, services);
  } catch (error) {
    services.notices.push({
      tone: "info",
      title: "Assistant sessions were not restored",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function activateAssistantRuntime(services: ModuleHostServices) {
  const unsubscribe = services.terminalSessions.subscribe((event) =>
    handleLifecycle(event, services));
  return () => {
    unsubscribe();
    for (const sessionId of captureTimers.keys()) clearTimer(captureTimers, sessionId);
    for (const sessionId of restoreTimers.keys()) clearTimer(restoreTimers, sessionId);
    metadataBySession.clear();
  };
}
