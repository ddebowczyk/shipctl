import { useCallback, useEffect } from "react";
import { terminalDriverId } from "@shipctl/module-api";
import type {
  ModuleManagedTerminalSessionLaunchRequest,
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionObservationEvent,
  ModuleTerminalSessionUpdate,
  TerminalDriverId,
} from "@shipctl/module-api";
import { hexLuminance, useThemeStore } from "@shipctl/core/appearance";
import { getErrorMessage } from "@shipctl/core/platform";
import { useNoticeStore } from "@shipctl/core/shared";

import { toTerminalColorTheme } from "./terminalColorTheme.ts";
import {
  bindTerminalSessionsRuntime,
  requestTerminalSessionOwnerAction,
  terminalSessionFromDescriptor,
} from "./terminalSessions.ts";
import { TERMINAL_CLIENT_RUNTIME } from "./terminalClientRuntime.ts";
import {
  defaultTerminalViewId,
  isJsonValue,
  type TerminalDescriptor,
  type TerminalId,
  type TerminalOwner,
} from "./types.ts";
import { useTerminalStore } from "./useTerminalStore.ts";

/** Modules that do not select a terminal implementation retain the current product default. */
const DEFAULT_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");

function requireModuleSession(descriptor: TerminalDescriptor): ModuleTerminalSession {
  const session = terminalSessionFromDescriptor(descriptor);
  if (!session) throw new Error(`Terminal ${descriptor.id} has no module owner descriptor`);
  return session;
}

function findModuleSession(sessionId: string) {
  for (const descriptor of TERMINAL_CLIENT_RUNTIME.descriptors()) {
    const session = terminalSessionFromDescriptor(descriptor);
    if (session?.id === sessionId) return { descriptor, session };
  }
  return null;
}

/**
 * React composition façade for terminal user actions. All identity, lifecycle,
 * and module-session lookup is derived from the host inventory; this hook owns
 * no terminal registry, output channel, activity timer, or stop correlator.
 */
export function useTerminalActions(
  activeProjectPath: string | null,
  focusProject: (projectPath: string) => Promise<boolean>,
) {
  const pushNotice = useNoticeStore((state) => state.pushNotice);

  const spawnSession = useCallback(async (
    command: string,
    commandArgs: string[] | null,
    environment: Record<string, string>,
    columns: number,
    rows: number,
    cwd: string,
    driverId: TerminalDriverId,
    metadata: {
      label: string;
      projectPath: string;
      owner: TerminalOwner;
      ownerMetadata?: unknown;
      presentation?: unknown;
    },
  ) => {
    const theme = useThemeStore.getState().theme;
    const colorfgbg = hexLuminance(theme.appBg) > 0.3 ? "0;15" : "15;0";
    return TERMINAL_CLIENT_RUNTIME.spawn({
      driverId,
      target: command.length === 0
        ? { type: "shell" }
        : commandArgs === null
          ? { type: "shell_command", source: command }
          : { type: "program", program: command, argv: commandArgs },
      cwd,
      environment: { COLORFGBG: colorfgbg, ...environment },
      columns,
      rows,
      colorTheme: toTerminalColorTheme(theme),
      metadata: {
        label: metadata.label,
        cwd,
        projectPath: metadata.projectPath,
        displayCommand: command || "shell",
        createdAtMs: Date.now(),
        owner: metadata.owner,
        ownerMetadata: isJsonValue(metadata.ownerMetadata) ? metadata.ownerMetadata : null,
        presentation: isJsonValue(metadata.presentation) ? metadata.presentation : null,
      },
    });
  }, []);

  const launchTerminalSessionForModule = useCallback(async (
    moduleId: string,
    request: ModuleTerminalSessionLaunchRequest,
  ) => {
    const descriptor = await spawnSession(
      request.command,
      request.arguments ? [...request.arguments] : null,
      { ...request.environment },
      request.columns,
      request.rows,
      request.cwd,
      DEFAULT_TERMINAL_DRIVER_ID,
      {
        label: request.label,
        projectPath: request.projectPath,
        owner: {
          type: "module",
          moduleId,
          ownerKey: request.ownerKey,
          moduleSessionId: request.moduleSessionId,
        },
        ownerMetadata: request.ownerMetadata,
        presentation: request.presentation,
      },
    );
    return requireModuleSession(descriptor);
  }, [spawnSession]);

  const launchTerminalSession = useCallback((
    request: ModuleTerminalSessionLaunchRequest,
  ) => launchTerminalSessionForModule(
    request.ownerKey.split(":", 1)[0] || "unknown",
    request,
  ), [launchTerminalSessionForModule]);

  const launchManagedTerminalSession = useCallback(async (
    request: ModuleManagedTerminalSessionLaunchRequest,
  ) => {
    const theme = useThemeStore.getState().theme;
    const colorfgbg = hexLuminance(theme.appBg) > 0.3 ? "0;15" : "15;0";
    const started = await request.start({
      moduleSessionId: request.moduleSessionId,
      columns: request.columns,
      rows: request.rows,
      environment: { COLORFGBG: colorfgbg },
      colorTheme: toTerminalColorTheme(theme),
    });
    await TERMINAL_CLIENT_RUNTIME.reconcile();
    const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(
      started.terminalId as unknown as TerminalId,
    );
    if (!descriptor) {
      throw new Error(`Managed terminal ${started.terminalId} was not registered by the host`);
    }
    const ownerMetadata = started.ownerMetadata ?? request.ownerMetadata ?? null;
    const presentation = started.presentation ?? request.presentation ?? null;
    const updated = await TERMINAL_CLIENT_RUNTIME.updateMetadata(descriptor.id, {
      ...descriptor.metadata,
      label: request.label,
      projectPath: request.projectPath,
      ownerMetadata: isJsonValue(ownerMetadata) ? ownerMetadata : null,
      presentation: isJsonValue(presentation) ? presentation : null,
    });
    return requireModuleSession(updated);
  }, []);

  const updateTerminalSession = useCallback(async (
    sessionId: string,
    patch: ModuleTerminalSessionUpdate,
  ) => {
    const owned = findModuleSession(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);
    const ownerMetadata = Object.prototype.hasOwnProperty.call(patch, "ownerMetadata")
      ? patch.ownerMetadata
      : owned.descriptor.metadata.ownerMetadata;
    const presentation = patch.presentation === undefined
      ? owned.descriptor.metadata.presentation
      : patch.presentation;
    const descriptor = await TERMINAL_CLIENT_RUNTIME.updateMetadata(
      owned.descriptor.id,
      {
        ...owned.descriptor.metadata,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ownerMetadata: isJsonValue(ownerMetadata) ? ownerMetadata : null,
        presentation: isJsonValue(presentation) ? presentation : null,
      },
    );
    return requireModuleSession(descriptor);
  }, []);

  const stopTerminalSession = useCallback(async (sessionId: string) => {
    const owned = findModuleSession(sessionId);
    if (owned) await TERMINAL_CLIENT_RUNTIME.close(owned.descriptor.id);
  }, []);

  const observeTerminalSession = useCallback(async (
    sessionId: string,
    listener: (event: ModuleTerminalSessionObservationEvent) => void,
  ) => {
    const owned = findModuleSession(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);

    const deliver = (event: ModuleTerminalSessionObservationEvent) => {
      try {
        listener(event);
      } catch {
        // An observer cannot interrupt host event delivery or other attachments.
      }
    };
    const attachment = await TERMINAL_CLIENT_RUNTIME.attach(
      owned.descriptor.id,
      false,
      (event) => {
        if (event.event === "output" && event.data) {
          deliver({ type: "data", data: event.data });
        } else if (event.event === "exited") {
          deliver({ type: "exit", exitCode: event.descriptor?.exit?.code ?? null });
        } else if (event.event === "resync_required" || event.event === "detached") {
          deliver({ type: "resync", reason: event.reason ?? "raw_stream_closed" });
        }
      },
    );

    if (!attachment.live) {
      deliver({
        type: "exit",
        exitCode: attachment.descriptor.exit?.code ?? null,
      });
    }
    attachment.activate();

    let disposed = false;
    return {
      async dispose() {
        if (disposed) return;
        disposed = true;
        await TERMINAL_CLIENT_RUNTIME.detach(attachment.attachmentId);
      },
    };
  }, []);

  const focusTerminalSession = useCallback(async (sessionId: string) => {
    const owned = findModuleSession(sessionId);
    if (!owned || !await focusProject(owned.session.projectPath)) return;
    useTerminalStore.getState().setActiveTab(
      owned.session.projectPath,
      defaultTerminalViewId(owned.descriptor.id),
    );
  }, [focusProject]);

  const listTerminalSessions = useCallback(() => TERMINAL_CLIENT_RUNTIME
    .descriptors()
    .flatMap((descriptor) => {
      const session = terminalSessionFromDescriptor(descriptor);
      return session ? [session] : [];
    }), []);

  useEffect(() => bindTerminalSessionsRuntime({
    launch: launchTerminalSession,
    launchForModule: launchTerminalSessionForModule,
    launchManaged: launchManagedTerminalSession,
    update: updateTerminalSession,
    observe: observeTerminalSession,
    stop: stopTerminalSession,
    focus: focusTerminalSession,
    list: listTerminalSessions,
  }), [
    focusTerminalSession,
    launchManagedTerminalSession,
    launchTerminalSession,
    launchTerminalSessionForModule,
    listTerminalSessions,
    observeTerminalSession,
    stopTerminalSession,
    updateTerminalSession,
  ]);

  const requestTerminalSessionRename = useCallback(async (
    sessionId: string,
    label: string,
  ) => {
    const owned = findModuleSession(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);
    await requestTerminalSessionOwnerAction({
      type: "rename-requested",
      session: owned.session,
      label,
    });
    await updateTerminalSession(sessionId, { label });
  }, [updateTerminalSession]);

  const requestTerminalSessionPlacement = useCallback(async (
    sessionId: string,
    projectPath: string,
  ) => {
    const owned = findModuleSession(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);
    await requestTerminalSessionOwnerAction({
      type: "placement-requested",
      session: owned.session,
      projectPath,
    });
    await TERMINAL_CLIENT_RUNTIME.updateMetadata(owned.descriptor.id, {
      ...owned.descriptor.metadata,
      projectPath,
    });
  }, []);

  const spawnBlankShell = useCallback(async (
    driverId: TerminalDriverId,
    columns: number,
    rows: number,
  ) => {
    if (!activeProjectPath) return;
    try {
      const descriptor = await spawnSession(
        "",
        null,
        {},
        columns,
        rows,
        activeProjectPath,
        driverId,
        {
          label: "Terminal",
          projectPath: activeProjectPath,
          owner: { type: "core" },
        },
      );
      useTerminalStore.getState().setActiveTab(
        activeProjectPath,
        defaultTerminalViewId(descriptor.id),
      );
      return descriptor.id;
    } catch (error) {
      if (import.meta.env.DEV) console.error("Failed to spawn shell:", error);
      pushNotice({
        tone: "error",
        title: "Couldn’t open shell",
        message: getErrorMessage(error),
      });
      return null;
    }
  }, [activeProjectPath, pushNotice, spawnSession]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = Object.values(useTerminalStore.getState().projectState)
      .flatMap((project) => project.tabs)
      .find((entry) => entry.id === tabId);
    if (!tab || tab.kind !== "terminal") return;

    const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(tab.terminalId);
    const session = descriptor ? terminalSessionFromDescriptor(descriptor) : null;
    try {
      if (session) {
        await requestTerminalSessionOwnerAction({
          type: "stop-requested",
          session,
          reason: "tab-close",
        });
      }
      await TERMINAL_CLIENT_RUNTIME.close(tab.terminalId);
    } catch (error) {
      pushNotice({
        tone: "error",
        title: session ? "Couldn’t close session" : "Couldn’t close terminal",
        message: getErrorMessage(error),
      });
    }
  }, [pushNotice]);

  const closeProjectTerminals = useCallback(async (repoPath: string) => {
    const tabs = useTerminalStore.getState().getAllProjectTabs(repoPath);
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(tab.terminalId);
      const session = descriptor ? terminalSessionFromDescriptor(descriptor) : null;
      if (session) {
        await requestTerminalSessionOwnerAction({
          type: "stop-requested",
          session,
          reason: "project-removal",
        });
      }
      await TERMINAL_CLIENT_RUNTIME.close(tab.terminalId);
    }
  }, []);

  return {
    spawnBlankShell,
    closeTab,
    closeProjectTerminals,
    requestTerminalSessionPlacement,
    requestTerminalSessionRename,
  };
}
