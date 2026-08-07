import { useCallback, useEffect } from "react";
import type {
  ModuleManagedTerminalSessionLaunchRequest,
  ModuleTerminalSession,
  ModuleTerminalSessionLaunchRequest,
  ModuleTerminalSessionUpdate,
} from "@shep/module-api";
import {
  getDefaultShell,
  killPty,
  spawnPty,
} from "@shep/core/platform";
import { useThemeStore } from "@shep/core/appearance";
import { hexLuminance } from "@shep/core/appearance";
import type { PtyOutput } from "@shep/core/platform";
import { toPtyColorTheme } from "./ptyColorTheme.ts";
import { useTerminalStore, nextTabId } from "./useTerminalStore.ts";
import { useNoticeStore } from "@shep/core/shared";
import { getErrorMessage } from "@shep/core/platform";
import {
  bindTerminalSessionsRuntime,
  publishTerminalSessionEvent,
  requestTerminalSessionOwnerAction,
  terminalSessionExitReason,
} from "./terminalSessions.ts";
import { unregisterTerminal, writeTerminalOutput } from "./terminalOutputQueue.ts";

// Debounce timers for activity detection — clears "active" after 3s of silence.
// Activity state is tracked here (not in the store) on every data event to avoid
// high-frequency store updates during AI streaming. The store is only updated
// on transitions: idle→active and active→idle.
const activityTimers = new Map<number, ReturnType<typeof setTimeout>>();
const activityActive = new Set<number>();
const ACTIVITY_TIMEOUT = 3000;
const stoppingPtys = new Set<number>();
interface HostTerminalSession {
  session: ModuleTerminalSession;
  ptyId: number;
  tabId: string;
  state: "running" | "exited";
}

const hostTerminalSessions = new Map<string, HostTerminalSession>();
const hostTerminalSessionIdsByPty = new Map<number, string>();
let hostTerminalSessionCounter = 0;

function completeHostTerminalSession(
  ptyId: number,
  requestedStop: boolean,
  exitCode: number | null,
) {
  const sessionId = hostTerminalSessionIdsByPty.get(ptyId);
  if (!sessionId) return;
  const owned = hostTerminalSessions.get(sessionId);
  if (!owned) return;

  if (requestedStop) {
    hostTerminalSessionIdsByPty.delete(ptyId);
    hostTerminalSessions.delete(sessionId);
    if (owned.state === "exited") return;
  } else {
    if (owned.state === "exited") return;
    owned.state = "exited";
  }
  publishTerminalSessionEvent({
    type: "exited",
    session: owned.session,
    reason: requestedStop
      ? "manual-stop"
      : terminalSessionExitReason(false, exitCode ?? 1),
    exitCode,
  });
}

function cleanupActivityState(ptyId: number) {
  const timer = activityTimers.get(ptyId);
  if (timer) { clearTimeout(timer); activityTimers.delete(ptyId); }
  activityActive.delete(ptyId);
}

// Terminal registration, the write queue, and output acknowledgement live in
// "./terminalOutputQueue.ts"; this hook owns PTY lifecycle and session state.

export function usePty(
  activeProjectPath: string | null,
  focusProject: (projectPath: string) => Promise<boolean>,
) {
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    removeTabFromProject,
    initActivity,
    setTabActive,
    setTabExited,
    removeActivity,
    updateTerminalTabById,
    addTabToProject,
  } =
    useTerminalStore.getState();

  const handlePtyMessage = useCallback(
    (ptyId: number, msg: PtyOutput) => {
      if (msg.event === "data") {
        writeTerminalOutput(ptyId, msg.data);

        // Only update the store on the idle→active transition, not on every chunk.
        if (!activityActive.has(ptyId)) {
          activityActive.add(ptyId);
          setTabActive(ptyId, true);
        }

        // Reset the idle timer — after 3s of no output, mark as inactive
        const existing = activityTimers.get(ptyId);
        if (existing) clearTimeout(existing);
        activityTimers.set(ptyId, setTimeout(() => {
          activityActive.delete(ptyId);
          setTabActive(ptyId, false);
          activityTimers.delete(ptyId);
        }, ACTIVITY_TIMEOUT));
      } else if (msg.event === "exit") {
        cleanupActivityState(ptyId);
        setTabExited(ptyId, msg.data.code);
        const stoppedByUser = stoppingPtys.delete(ptyId);
        completeHostTerminalSession(ptyId, stoppedByUser, msg.data.code);
      }
    },
    [
      setTabActive,
      setTabExited,
    ],
  );

  const spawnSession = useCallback(
    async (
      command: string,
      commandArgs: string[] | null,
      env: Record<string, string>,
      cols: number,
      rows: number,
      repoPath: string,
      onSpawned?: (ptyId: number) => void,
    ) => {
      let resolvedPtyId: number | null = null;
      const bufferedMessages: PtyOutput[] = [];

      // Signal terminal background brightness to CLI tools via COLORFGBG.
      // Claude Code uses this to resolve "auto" theme when OSC 11 is unavailable.
      const theme = useThemeStore.getState().theme;
      const lum = hexLuminance(theme.appBg);
      const colorfgbg = lum > 0.3 ? "0;15" : "15;0";
      const fullEnv = { COLORFGBG: colorfgbg, ...env };

      const ptyId = await spawnPty(
        command,
        commandArgs,
        repoPath,
        fullEnv,
        cols,
        rows,
        toPtyColorTheme(theme),
        (msg) => {
          if (resolvedPtyId === null) {
            bufferedMessages.push(msg);
            return;
          }

          handlePtyMessage(resolvedPtyId, msg);
        },
      );

      resolvedPtyId = ptyId;
      initActivity(ptyId);
      onSpawned?.(ptyId);

      for (const msg of bufferedMessages) {
        handlePtyMessage(ptyId, msg);
      }

      return ptyId;
    },
    [handlePtyMessage, initActivity],
  );

  const launchTerminalSession = useCallback(
    async (request: ModuleTerminalSessionLaunchRequest) => {
      const session: ModuleTerminalSession = {
        id: `terminal-session-${++hostTerminalSessionCounter}`,
        projectPath: request.projectPath,
        ownerKey: request.ownerKey,
        label: request.label,
        ownerMetadata: request.ownerMetadata,
        presentation: request.presentation,
      };
      const tabId = nextTabId();

      await spawnSession(
        request.command,
        request.arguments ? [...request.arguments] : null,
        { ...request.environment },
        request.columns,
        request.rows,
        request.cwd,
        (ptyId) => {
          hostTerminalSessions.set(session.id, {
            session,
            ptyId,
            tabId,
            state: "running",
          });
          hostTerminalSessionIdsByPty.set(ptyId, session.id);
          addTabToProject(request.projectPath, {
            id: tabId,
            kind: "terminal",
            label: request.label,
            ptyId,
            repoPath: request.projectPath,
            commandName: null,
            moduleSessionId: session.id,
            modulePresentation: request.presentation,
          });
          publishTerminalSessionEvent({ type: "started", session });
        },
      );

      return session;
    },
    [addTabToProject, spawnSession],
  );

  const launchManagedTerminalSession = useCallback(
    async (request: ModuleManagedTerminalSessionLaunchRequest) => {
      let resolvedPtyId: number | null = null;
      const bufferedMessages: PtyOutput[] = [];
      const theme = useThemeStore.getState().theme;
      const colorfgbg = hexLuminance(theme.appBg) > 0.3 ? "0;15" : "15;0";
      const started = await request.start(
        {
          columns: request.columns,
          rows: request.rows,
          environment: { COLORFGBG: colorfgbg },
          colorTheme: toPtyColorTheme(theme),
        },
        (event) => {
          const message: PtyOutput = event.type === "data"
            ? { event: "data", data: event.data }
            : { event: "exit", data: { code: event.exitCode ?? 1 } };
          if (resolvedPtyId === null) {
            bufferedMessages.push(message);
            return;
          }
          handlePtyMessage(resolvedPtyId, message);
        },
      );
      resolvedPtyId = started.terminalId;
      initActivity(started.terminalId);

      const session: ModuleTerminalSession = {
        id: `terminal-session-${++hostTerminalSessionCounter}`,
        projectPath: request.projectPath,
        ownerKey: request.ownerKey,
        label: request.label,
        ownerMetadata: started.ownerMetadata ?? request.ownerMetadata,
        presentation: started.presentation ?? request.presentation,
      };
      const tabId = nextTabId();
      hostTerminalSessions.set(session.id, {
        session,
        ptyId: started.terminalId,
        tabId,
        state: "running",
      });
      hostTerminalSessionIdsByPty.set(started.terminalId, session.id);
      addTabToProject(request.projectPath, {
        id: tabId,
        kind: "terminal",
        label: session.label,
        ptyId: started.terminalId,
        repoPath: request.cwd,
        commandName: null,
        moduleSessionId: session.id,
        modulePresentation: session.presentation,
      });
      publishTerminalSessionEvent({ type: "started", session });
      for (const message of bufferedMessages) {
        handlePtyMessage(started.terminalId, message);
      }
      return session;
    },
    [addTabToProject, handlePtyMessage, initActivity],
  );

  const updateTerminalSession = useCallback(async (
    sessionId: string,
    patch: ModuleTerminalSessionUpdate,
  ) => {
    const owned = hostTerminalSessions.get(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);

    const next: ModuleTerminalSession = {
      ...owned.session,
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(Object.prototype.hasOwnProperty.call(patch, "ownerMetadata")
        ? { ownerMetadata: patch.ownerMetadata }
        : {}),
      ...(patch.presentation === undefined
        ? {}
        : { presentation: patch.presentation }),
    };
    owned.session = next;
    updateTerminalTabById(owned.tabId, {
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.presentation === undefined
        ? {}
        : { modulePresentation: patch.presentation }),
    });
    return next;
  }, [updateTerminalTabById]);

  const stopTerminalSession = useCallback(async (sessionId: string) => {
    const owned = hostTerminalSessions.get(sessionId);
    if (!owned) return;

    if (owned.state === "running") {
      cleanupActivityState(owned.ptyId);
      stoppingPtys.add(owned.ptyId);
      await killPty(owned.ptyId).catch(() => {
        stoppingPtys.delete(owned.ptyId);
      });
    }
    completeHostTerminalSession(owned.ptyId, true, null);
    unregisterTerminal(owned.ptyId);
    useTerminalStore.getState().removeActivity(owned.ptyId);
    useTerminalStore.getState().removeTabFromProject(
      owned.session.projectPath,
      owned.tabId,
    );
  }, []);

  const focusTerminalSession = useCallback(async (sessionId: string) => {
    const owned = hostTerminalSessions.get(sessionId);
    if (!owned) return;

    if (!await focusProject(owned.session.projectPath)) return;
    useTerminalStore.getState().setActiveTab(owned.session.projectPath, owned.tabId);
  }, [focusProject]);

  const requestTerminalSessionRename = useCallback(async (
    sessionId: string,
    label: string,
  ) => {
    const owned = hostTerminalSessions.get(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);
    await requestTerminalSessionOwnerAction({
      type: "rename-requested",
      session: owned.session,
      label,
    });
    owned.session = { ...owned.session, label };
  }, []);

  const requestTerminalSessionPlacement = useCallback(async (
    sessionId: string,
    projectPath: string,
  ) => {
    const owned = hostTerminalSessions.get(sessionId);
    if (!owned) throw new Error(`Terminal session ${sessionId} is unavailable`);
    await requestTerminalSessionOwnerAction({
      type: "placement-requested",
      session: owned.session,
      projectPath,
    });
    owned.session = { ...owned.session, projectPath };
  }, []);

  useEffect(() => bindTerminalSessionsRuntime({
    launch: launchTerminalSession,
    launchManaged: launchManagedTerminalSession,
    update: updateTerminalSession,
    stop: stopTerminalSession,
    focus: focusTerminalSession,
  }), [focusTerminalSession, launchManagedTerminalSession, launchTerminalSession, stopTerminalSession, updateTerminalSession]);

  const spawnBlankShell = useCallback(
    async (cols: number, rows: number) => {
      if (!activeProjectPath) return;

      try {
        const shell = await getDefaultShell();
        const ptyId = await spawnSession(
          `${shell} -l`,
          null,
          {},
          cols,
          rows,
          activeProjectPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTabToProject(activeProjectPath, {
          id,
          kind: "terminal",
          label: "Terminal",
          ptyId,
          repoPath: activeProjectPath,
          commandName: null,
        });

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error("Failed to spawn shell:", e);
        }
        pushNotice({
          tone: "error",
          title: "Couldn’t open shell",
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeProjectPath, spawnSession, addTabToProject, pushNotice],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const state = useTerminalStore.getState();
      const tabEntry = Object.entries(state.projectState).find(([, project]) =>
        project.tabs.some((entry) => entry.id === tabId),
      );
      if (!tabEntry) return;
      const [tabProjectPath, project] = tabEntry;
      const tab = project.tabs.find((entry) => entry.id === tabId);
      if (!tab || tab.kind !== "terminal") return;

      if (tab.moduleSessionId) {
        const owned = hostTerminalSessions.get(tab.moduleSessionId);
        if (!owned) return;
        try {
          await requestTerminalSessionOwnerAction({
            type: "stop-requested",
            session: owned.session,
            reason: "tab-close",
          });
          await stopTerminalSession(tab.moduleSessionId);
        } catch (error) {
          pushNotice({
            tone: "error",
            title: "Couldn’t close session",
            message: getErrorMessage(error),
          });
        }
        return;
      }

      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      completeHostTerminalSession(tab.ptyId, true, null);
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);

      removeTabFromProject(tabProjectPath, tabId);
    },
    [
      removeTabFromProject,
      removeActivity,
      pushNotice,
      stopTerminalSession,
    ],
  );

  const killProjectPtys = useCallback(async (repoPath: string) => {
    const state = useTerminalStore.getState();
    const tabs = state.getAllProjectTabs(repoPath);

    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      if (tab.moduleSessionId) {
        const owned = hostTerminalSessions.get(tab.moduleSessionId);
        if (!owned) continue;
        await requestTerminalSessionOwnerAction({
          type: "stop-requested",
          session: owned.session,
          reason: "project-removal",
        });
        await stopTerminalSession(tab.moduleSessionId);
        continue;
      }
      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      completeHostTerminalSession(tab.ptyId, true, null);
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
    }
  }, [removeActivity, stopTerminalSession]);

  return {
    spawnBlankShell,
    closeTab,
    killProjectPtys,
    requestTerminalSessionPlacement,
    requestTerminalSessionRename,
  };
}
