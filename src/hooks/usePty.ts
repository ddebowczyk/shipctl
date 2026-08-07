import { useCallback } from "react";
import {
  discardAssistantSession,
  failAssistantSessionCapture,
  getDefaultShell,
  killPty,
  rearmAssistantSession,
  resumeAssistantSession,
  spawnAssistantSession,
  spawnPty,
  tryCaptureCodexAssistantSession,
} from "../lib/tauri";
import { useThemeStore } from "../stores/useThemeStore";
import { hexLuminance } from "../lib/themes";
import type {
  AssistantSessionRecord,
  CommandConfig,
  PtyOutput,
  RestorableAssistantProvider,
  SessionMode,
} from "../lib/types";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { useCommandStore } from "../stores/useCommandStore";
import { useTerminalStore, nextTabId } from "../stores/useTerminalStore";
import { useRepoStore } from "../stores/useRepoStore";
import { useNoticeStore } from "../stores/useNoticeStore";
import { CODING_ASSISTANTS } from "../components/sidebar/constants";
import type { Terminal } from "@xterm/xterm";
import { getErrorMessage } from "../lib/errors";

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
const codexCaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CODEX_CAPTURE_RETRY_MS = 500;
const CODEX_CAPTURE_MAX_ATTEMPTS = 20;
const RESTORE_PROBATION_MS = 5000;
const restoreProbations = new Map<
  number,
  { recordId: string; timer: ReturnType<typeof setTimeout> }
>();

function cleanupActivityState(ptyId: number) {
  const timer = activityTimers.get(ptyId);
  if (timer) { clearTimeout(timer); activityTimers.delete(ptyId); }
  activityActive.delete(ptyId);
}

function clearCodexCaptureTimer(recordId: string) {
  const timer = codexCaptureTimers.get(recordId);
  if (timer) clearTimeout(timer);
  codexCaptureTimers.delete(recordId);
}

function clearRestoreProbation(ptyId: number) {
  const probation = restoreProbations.get(ptyId);
  if (probation) clearTimeout(probation.timer);
  restoreProbations.delete(ptyId);
  return probation;
}

function restorableProvider(assistantId: string): RestorableAssistantProvider | null {
  return assistantId === "claude" || assistantId === "codex" ? assistantId : null;
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

export function resolveCommandCwd(repoPath: string, commandCwd: string | null) {
  const trimmed = commandCwd?.trim();
  if (!trimmed) return repoPath;
  const relativePath = trimmed.replace(/^\.?\//, "").replace(/^\/+/, "");
  return `${repoPath}/${relativePath}`;
}

export function usePty() {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    setCommandStatus,
    setCommandPtyId,
    setCommandStatusForProject,
    setCommandPtyIdForProject,
  } = useCommandStore.getState();
  const {
    addTab,
    removeTabFromProject,
    findTabByCommand,
    findTabByCommandForProject,
    setActiveTab,
    initActivity,
    setTabActive,
    setTabExited,
    removeActivity,
    updateTerminalTabById,
    findTabByPtyId,
    addTabToProject,
  } =
    useTerminalStore.getState();

  const handlePtyMessage = useCallback(
    (
      ptyId: number,
      commandName: string | null,
      repoPath: string,
      msg: PtyOutput,
    ) => {
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
        const restoreProbation = clearRestoreProbation(ptyId);
        const tab = findTabByPtyId(ptyId);
        if (tab?.restoreRecordId && !stoppedByUser) {
          clearCodexCaptureTimer(tab.restoreRecordId);
          if (restoreProbation?.recordId === tab.restoreRecordId) {
            // Spawning the provider only proves that the executable started.
            // A quick natural exit usually means the resume itself failed, so
            // keep the durable record available instead of consuming it.
            void rearmAssistantSession(tab.restoreRecordId)
              .then(() => {
                pushNotice({
                  tone: "info",
                  title: `Couldn’t restore ${tab.label}`,
                  message: "The resumed process exited immediately. The saved session was kept for the next launch.",
                });
              })
              .catch(() => {});
          } else {
            // A naturally exited established provider has no live session to
            // restore. During app shutdown the backend freezes this mutation
            // before signals are sent, so the failed discard is intentional.
            void discardAssistantSession(tab.restoreRecordId).catch(() => {});
          }
        }
        if (commandName) {
          const command = useCommandStore.getState().projectCommands[repoPath]
            ?.find((entry) => entry.name === commandName);
          const nextStatus = stoppedByUser || msg.data.code === 0 ? "stopped" : "crashed";
          if (command?.status !== "stopped" || nextStatus === "crashed") {
            setCommandStatusForProject(repoPath, commandName, nextStatus);
          }
          setCommandPtyIdForProject(repoPath, commandName, null);
        }
      }
    },
    [
      findTabByPtyId,
      pushNotice,
      setCommandStatusForProject,
      setCommandPtyIdForProject,
      setTabActive,
      setTabExited,
    ],
  );

  const captureCodexSession = useCallback(
    (record: AssistantSessionRecord, tabId: string) => {
      let attempts = 0;
      const attemptCapture = async () => {
        try {
          const captured = await tryCaptureCodexAssistantSession(record.recordId);
          if (captured) {
            updateTerminalTabById(tabId, {
              providerSessionId: captured.providerSessionId,
              captureState: captured.captureState,
            });
            clearCodexCaptureTimer(record.recordId);
            return;
          }

          attempts += 1;
          if (attempts < CODEX_CAPTURE_MAX_ATTEMPTS) {
            codexCaptureTimers.set(
              record.recordId,
              setTimeout(attemptCapture, CODEX_CAPTURE_RETRY_MS),
            );
            return;
          }
          const failed = await failAssistantSessionCapture(record.recordId);
          updateTerminalTabById(tabId, { captureState: failed.captureState });
          pushNotice({
            tone: "info",
            title: "Codex restore was not enabled",
            message: "Shep could not identify this Codex session without guessing. The terminal is still running normally.",
          });
        } catch (error) {
          clearCodexCaptureTimer(record.recordId);
          const failed = await failAssistantSessionCapture(record.recordId).catch(() => null);
          updateTerminalTabById(tabId, { captureState: failed?.captureState ?? "failed" });
          pushNotice({
            tone: "info",
            title: "Codex restore was not enabled",
            message: getErrorMessage(error),
          });
        }
      };

      void attemptCapture();
    },
    [pushNotice, updateTerminalTabById],
  );

  const spawnSession = useCallback(
    async (
      command: string,
      commandArgs: string[] | null,
      env: Record<string, string>,
      cols: number,
      rows: number,
      commandName: string | null,
      repoPath: string,
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

          handlePtyMessage(resolvedPtyId, commandName, repoPath, msg);
        },
      );

      resolvedPtyId = ptyId;
      initActivity(ptyId);

      for (const msg of bufferedMessages) {
        handlePtyMessage(ptyId, commandName, repoPath, msg);
      }

      return ptyId;
    },
    [handlePtyMessage, initActivity],
  );

  const startCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      if (!activeRepoPath) return;
      const commandName = command.name;

      const basePath = activeRepoPath;

      try {
        const ptyId = await spawnSession(
          command.command,
          null,
          command.env,
          cols,
          rows,
          commandName,
          resolveCommandCwd(basePath, command.cwd ?? null),
        );
        if (!ptyId) return;

        setCommandStatus(commandName, "running");
        setCommandPtyId(commandName, ptyId);

        const existing = findTabByCommand(commandName);
        if (existing) {
          setActiveTab(existing.id);
        } else {
          const id = nextTabId();
          addTab({
            id,
            kind: "terminal",
            label: commandName,
            ptyId,
            repoPath: activeRepoPath,
            commandName,
            assistantId: null,
            sessionMode: null,
            restoreRecordId: null,
            providerSessionId: null,
            captureState: null,
          });
        }

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to start command "${commandName}":`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t start ${commandName}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [
      activeRepoPath,
      spawnSession,
      setCommandStatus,
      setCommandPtyId,
      findTabByCommand,
      setActiveTab,
      addTab,
      pushNotice,
    ],
  );

  const stopCommand = useCallback(
    async (commandName: string) => {
      const path = useCommandStore.getState().activeProjectPath;
      if (!path) return;
      const state = useTerminalStore.getState();
      const commands = useCommandStore.getState().projectCommands[path] ?? [];
      const command = commands.find((c) => c.name === commandName);
      const tab = findTabByCommandForProject(path, commandName);
      if (command?.ptyId) {
        cleanupActivityState(command.ptyId);
        stoppingPtys.add(command.ptyId);
        await killPty(command.ptyId).catch(() => {
          stoppingPtys.delete(command.ptyId!);
        });
        unregisterTerminal(command.ptyId);
        removeActivity(command.ptyId);
      }
      if (tab) {
        const tabProjectPath = Object.entries(state.projectState).find(([, project]) =>
          project.tabs.some((entry) => entry.id === tab.id),
        )?.[0];
        if (tabProjectPath) removeTabFromProject(tabProjectPath, tab.id);
      }
      setCommandStatusForProject(path, commandName, "stopped");
      setCommandPtyIdForProject(path, commandName, null);
    },
    [setCommandStatusForProject, setCommandPtyIdForProject, findTabByCommandForProject, removeTabFromProject, removeActivity],
  );

  const restartCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      await stopCommand(command.name);
      return startCommand(command, cols, rows);
    },
    [stopCommand, startCommand],
  );

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
          null,
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

  const launchAssistant = useCallback(
    async (
      assistantId: string,
      cols: number,
      rows: number,
      mode: SessionMode = "standard",
      model?: string,
    ) => {
      if (!activeRepoPath) return;
      const assistant = CODING_ASSISTANTS.find((a) => a.id === assistantId);
      if (!assistant) return;
      const provider = restorableProvider(assistantId);

      const commandArgs: string[] = [];
      if (model) {
        commandArgs.push(assistant.modelFlag, model);
      }
      if (mode === "yolo" && assistant.yoloFlag) {
        commandArgs.push(assistant.yoloFlag);
      }

      try {
        if (!provider) {
          const ptyId = await spawnSession(
            assistant.command,
            commandArgs,
            {},
            cols,
            rows,
            null,
            activeRepoPath,
          );
          if (!ptyId) return;

          const id = nextTabId();
          addTab({
            id,
            kind: "assistant",
            label: assistant.name,
            ptyId,
            repoPath: activeRepoPath,
            commandName: null,
            assistantId,
            sessionMode: mode,
            restoreRecordId: null,
            providerSessionId: null,
            captureState: null,
          });
          return ptyId;
        }

        let resolvedPtyId: number | null = null;
        const bufferedMessages: PtyOutput[] = [];
        const theme = useThemeStore.getState().theme;
        const colorfgbg = hexLuminance(theme.appBg) > 0.3 ? "0;15" : "15;0";
        const spawned = await spawnAssistantSession(
          {
            provider,
            launchRepoPath: activeRepoPath,
            placementProjectPath: activeRepoPath,
            label: assistant.name,
            sessionMode: mode,
            model,
            env: { COLORFGBG: colorfgbg },
            cols,
            rows,
            colorTheme: toPtyColorTheme(theme),
          },
          (msg) => {
            if (resolvedPtyId === null) {
              bufferedMessages.push(msg);
              return;
            }
            handlePtyMessage(resolvedPtyId, null, activeRepoPath, msg);
          },
        );
        resolvedPtyId = spawned.ptyId;
        initActivity(spawned.ptyId);

        const id = nextTabId();
        addTab({
          id,
          kind: "assistant",
          label: assistant.name,
          ptyId: spawned.ptyId,
          repoPath: spawned.record.launchRepoPath,
          commandName: null,
          assistantId,
          sessionMode: mode,
          restoreRecordId: spawned.record.recordId,
          providerSessionId: spawned.record.providerSessionId,
          captureState: spawned.record.captureState,
        });
        for (const message of bufferedMessages) {
          handlePtyMessage(spawned.ptyId, null, activeRepoPath, message);
        }
        if (provider === "codex") {
          captureCodexSession(spawned.record, id);
        }

        return spawned.ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to launch ${assistant.name}:`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t launch ${assistant.name}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [
      activeRepoPath,
      spawnSession,
      addTab,
      captureCodexSession,
      handlePtyMessage,
      initActivity,
      pushNotice,
    ],
  );

  const resumeAssistant = useCallback(
    async (recordId: string, cols: number, rows: number) => {
      let resolvedPtyId: number | null = null;
      let resumeRepoPath = "";
      const bufferedMessages: PtyOutput[] = [];
      const theme = useThemeStore.getState().theme;
      const colorfgbg = hexLuminance(theme.appBg) > 0.3 ? "0;15" : "15;0";

      const spawned = await resumeAssistantSession(
        {
          recordId,
          env: { COLORFGBG: colorfgbg },
          cols,
          rows,
          colorTheme: toPtyColorTheme(theme),
        },
        (msg) => {
          if (resolvedPtyId === null) {
            bufferedMessages.push(msg);
            return;
          }
          handlePtyMessage(resolvedPtyId, null, resumeRepoPath, msg);
        },
      );
      resumeRepoPath = spawned.record.launchRepoPath;
      resolvedPtyId = spawned.ptyId;
      initActivity(spawned.ptyId);

      const probationTimer = setTimeout(() => {
        restoreProbations.delete(spawned.ptyId);
      }, RESTORE_PROBATION_MS);
      restoreProbations.set(spawned.ptyId, {
        recordId: spawned.record.recordId,
        timer: probationTimer,
      });

      const id = nextTabId();
      addTabToProject(spawned.record.placementProjectPath, {
        id,
        kind: "assistant",
        label: spawned.record.label,
        ptyId: spawned.ptyId,
        repoPath: spawned.record.launchRepoPath,
        commandName: null,
        assistantId: spawned.record.provider,
        sessionMode: spawned.record.sessionMode,
        restoreRecordId: spawned.record.recordId,
        providerSessionId: spawned.record.providerSessionId,
        captureState: spawned.record.captureState,
      });
      for (const message of bufferedMessages) {
        handlePtyMessage(spawned.ptyId, null, spawned.record.launchRepoPath, message);
      }
      return spawned.ptyId;
    },
    [addTabToProject, handlePtyMessage, initActivity],
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

      if (tab.restoreRecordId) {
        clearCodexCaptureTimer(tab.restoreRecordId);
        try {
          await discardAssistantSession(tab.restoreRecordId);
        } catch (error) {
          pushNotice({
            tone: "info",
            title: "Couldn’t remove restore data",
            message: getErrorMessage(error),
          });
        }
      }
      clearRestoreProbation(tab.ptyId);
      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);

      if (tab.commandName) {
        setCommandStatusForProject(tab.repoPath, tab.commandName, "stopped");
        setCommandPtyIdForProject(tab.repoPath, tab.commandName, null);
      }

      removeTabFromProject(tabProjectPath, tabId);
    },
    [
      setCommandStatusForProject,
      setCommandPtyIdForProject,
      removeTabFromProject,
      removeActivity,
      pushNotice,
    ],
  );

  const killProjectPtys = useCallback(async (repoPath: string) => {
    const state = useTerminalStore.getState();
    const tabs = state.getAllProjectTabs(repoPath);

    for (const tab of tabs) {
      if (tab.kind !== "terminal" && tab.kind !== "assistant") continue;
      if (tab.restoreRecordId) {
        clearCodexCaptureTimer(tab.restoreRecordId);
        await discardAssistantSession(tab.restoreRecordId).catch((error) => {
          pushNotice({
            tone: "info",
            title: "Couldn’t remove restore data",
            message: getErrorMessage(error),
          });
        });
      }
      clearRestoreProbation(tab.ptyId);
      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
    }
  }, [removeActivity, pushNotice]);

  return {
    startCommand,
    stopCommand,
    restartCommand,
    spawnBlankShell,
    launchAssistant,
    resumeAssistant,
    closeTab,
    killProjectPtys,
  };
}
