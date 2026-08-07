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
} from "../lib/tauri";
import { useThemeStore } from "../stores/useThemeStore";
import { hexLuminance } from "../lib/themes";
import type { PtyOutput } from "../lib/types";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { useTerminalStore, nextTabId } from "../stores/useTerminalStore";
import { useRepoStore } from "../stores/useRepoStore";
import { useNoticeStore } from "../stores/useNoticeStore";
import type { Terminal } from "@xterm/xterm";
import { getErrorMessage } from "../lib/errors";
import {
  bindTerminalSessionsRuntime,
  publishTerminalSessionEvent,
  requestTerminalSessionOwnerAction,
  terminalSessionExitReason,
} from "../core/modules/terminalSessions";

// Map ptyId -> xterm instance for writing output
const terminalInstances = new Map<number, Terminal>();

// Buffer for PTY output that arrives before terminal is registered
const pendingOutput = new Map<number, string[]>();

// Batch buffer for coalescing rapid PTY writes into single animation frames.
// Prevents screen tearing when TUI apps (Claude Code, opencode) send screen
// redraws larger than the 4KB PTY read buffer — without batching, xterm
// renders intermediate states where only the top of the screen is drawn.
const writeBatch = new Map<number, string[]>();
const writeBatchScheduled = new Set<number>();

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

export function registerTerminal(ptyId: number, term: Terminal) {
  terminalInstances.set(ptyId, term);
}

export function flushPendingOutput(ptyId: number) {
  const term = terminalInstances.get(ptyId);
  if (!term) return;

  // Flush any buffered output
  const buffered = pendingOutput.get(ptyId);
  if (buffered) {
    term.write(buffered.join(""));
    pendingOutput.delete(ptyId);
  }
}

export function unregisterTerminal(ptyId: number) {
  terminalInstances.delete(ptyId);
  pendingOutput.delete(ptyId);
  writeBatch.delete(ptyId);
  writeBatchScheduled.delete(ptyId);
}

function writeToPty(ptyId: number, data: string) {
  const term = terminalInstances.get(ptyId);
  if (term) {
    // Accumulate data and flush once per animation frame so xterm processes
    // a complete (or near-complete) screen update before the renderer paints.
    let batch = writeBatch.get(ptyId);
    if (!batch) {
      batch = [];
      writeBatch.set(ptyId, batch);
    }
    batch.push(data);

    if (!writeBatchScheduled.has(ptyId)) {
      writeBatchScheduled.add(ptyId);
      requestAnimationFrame(() => {
        writeBatchScheduled.delete(ptyId);
        const chunks = writeBatch.get(ptyId);
        if (chunks && chunks.length > 0) {
          term.write(chunks.join(""));
          chunks.length = 0;
        }
      });
    }
  } else {
    // Terminal not mounted yet — buffer the output
    let buf = pendingOutput.get(ptyId);
    if (!buf) {
      buf = [];
      pendingOutput.set(ptyId, buf);
    }
    buf.push(data);
  }
}

export function usePty() {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    addTab,
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
        writeToPty(ptyId, msg.data);

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
            kind: request.presentation?.role ?? "terminal",
            label: request.label,
            ptyId,
            repoPath: request.projectPath,
            commandName: null,
            assistantId: null,
            sessionMode: null,
            restoreRecordId: null,
            providerSessionId: null,
            captureState: null,
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
        kind: session.presentation?.role ?? "terminal",
        label: session.label,
        ptyId: started.terminalId,
        repoPath: request.cwd,
        commandName: null,
        assistantId: null,
        sessionMode: null,
        restoreRecordId: null,
        providerSessionId: null,
        captureState: null,
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
        : {
            kind: patch.presentation.role,
            modulePresentation: patch.presentation,
          }),
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

    if (useRepoStore.getState().activeRepoPath !== owned.session.projectPath) {
      await useRepoStore.getState().openRepo(owned.session.projectPath);
      useTerminalStore.getState().switchProject(owned.session.projectPath);
    }
    useTerminalStore.getState().setActiveTab(owned.tabId);
  }, []);

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
      if (!activeRepoPath) return;

      try {
        const shell = await getDefaultShell();
        const ptyId = await spawnSession(
          `${shell} -l`,
          null,
          {},
          cols,
          rows,
          activeRepoPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTab({
          id,
          kind: "terminal",
          label: "Terminal",
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId: null,
          sessionMode: null,
          restoreRecordId: null,
          providerSessionId: null,
          captureState: null,
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
    [activeRepoPath, spawnSession, addTab, pushNotice],
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
      if (!tab || (tab.kind !== "terminal" && tab.kind !== "assistant")) return;

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
      if (tab.kind !== "terminal" && tab.kind !== "assistant") continue;
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
