import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleHostServices, ModulePanelProps } from "@shep/module-api";
import { CircleHelp, List, Play, Plus, Save, Square, Trash2, X } from "lucide-react";

import {
  createCommand,
  deleteCommand,
  startAllCommands,
  startCommand,
  stopAllCommands,
  stopCommand,
  updateCommand,
} from "./runtime";
import { useCommandsStore } from "./store";
import type { CommandConfig, CommandState } from "./types";

interface CommandDraft {
  command: string;
  autostart: boolean;
}

const EMPTY_COMMANDS: readonly CommandState[] = [];

function createDraft(command?: CommandState): CommandDraft {
  return {
    command: command?.command ?? "",
    autostart: command?.autostart ?? false,
  };
}

export function generateCommandName(commandText: string, commands: readonly CommandState[]) {
  const base = commandText
    .trim()
    .toLowerCase()
    .slice(0, 32)
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const root = base || "command";
  const names = new Set(commands.map((command) => command.name));
  if (!names.has(root)) return root;
  let index = 2;
  while (names.has(`${root}_${index}`)) index += 1;
  return `${root}_${index}`;
}

interface CommandRowProps {
  readonly projectPath: string;
  readonly services: ModuleHostServices;
  readonly command?: CommandState;
  readonly isNew?: boolean;
  readonly commands: readonly CommandState[];
  readonly onCancelNew?: () => void;
  readonly onSavedNew?: () => void;
}

function CommandRow({
  projectPath,
  services,
  command,
  isNew = false,
  commands,
  onCancelNew,
  onSavedNew,
}: CommandRowProps) {
  const [draft, setDraft] = useState<CommandDraft>(createDraft(command));
  const [error, setError] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const isRunning = command?.status === "running";
  const isDirty = isNew
    ? draft.command.trim().length > 0 || draft.autostart
    : draft.command !== command?.command || draft.autostart !== command?.autostart;

  useEffect(() => {
    if (!isNew && command) {
      setDraft(createDraft(command));
      setError(null);
    }
  }, [command, isNew]);

  const buildConfig = (showErrors: boolean): CommandConfig | null => {
    const shellCommand = draft.command.trim();
    if (!shellCommand) {
      if (showErrors) setError("Command is required.");
      return null;
    }
    setError(null);
    return {
      name: command?.name ?? generateCommandName(shellCommand, commands),
      command: shellCommand,
      autostart: draft.autostart,
      env: command?.env ?? {},
      cwd: command?.cwd ?? null,
    };
  };

  const save = async (showErrors: boolean) => {
    const next = buildConfig(showErrors);
    if (!next) return false;
    const saved = isNew
      ? await createCommand(projectPath, next, services)
      : await updateCommand(projectPath, command!.name, next, services);
    if (saved && isNew) onSavedNew?.();
    return saved;
  };

  useEffect(() => {
    if (isNew || !isDirty) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void save(false), 500);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, isDirty, isNew]);

  const handleRun = async () => {
    if (isRunning && command) {
      await stopCommand(projectPath, command.name, services);
      return;
    }
    if (isNew || isDirty) {
      const name = command?.name ?? generateCommandName(draft.command.trim(), commands);
      if (!await save(true)) return;
      await startCommand(projectPath, name, services);
      return;
    }
    if (command) await startCommand(projectPath, command.name, services);
  };

  return (
    <div className="commands-panel__row-shell">
      <div className="commands-panel__row-line">
        <div className={`commands-panel__row ${isNew ? "is-new" : ""}`}>
          <input
            className="commands-panel__input commands-panel__input--command"
            placeholder={isNew ? "e.g. pnpm dev, docker compose up, redis-server" : "Command"}
            value={draft.command}
            onChange={(event) => setDraft((current) => ({
              ...current,
              command: event.target.value,
            }))}
          />
          <label className="commands-panel__auto">
            <input
              type="checkbox"
              checked={draft.autostart}
              onChange={(event) => setDraft((current) => ({
                ...current,
                autostart: event.target.checked,
              }))}
            />
            <span>Auto</span>
            <button
              type="button"
              className="commands-panel__auto-help"
              title="Auto starts this command when you open the project in Shep."
            >
              <CircleHelp size={12} />
            </button>
          </label>
          <div className="commands-panel__row-actions">
            <button
              className="icon-btn commands-panel__action"
              onClick={() => void handleRun()}
              title={isRunning ? "Stop" : "Start"}
            >
              {isRunning
                ? <Square size={14} fill="currentColor" />
                : <Play size={14} fill="currentColor" />}
            </button>
            {isNew && (
              <button
                className="icon-btn commands-panel__action"
                onClick={onCancelNew}
                title="Cancel"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        {isNew ? (
          <button
            className="icon-btn commands-panel__delete"
            onClick={() => void save(true)}
            title="Save"
          >
            <Save size={14} />
          </button>
        ) : (
          <button
            className="icon-btn commands-panel__delete"
            onClick={() => void deleteCommand(projectPath, command!.name, services)}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {error && <div className="commands-panel__row-error">{error}</div>}
    </div>
  );
}

export default function CommandsPanel({ project, services }: ModulePanelProps) {
  const projectPath = project?.path ?? null;
  const commands = useCommandsStore(
    (state) => projectPath ? state.projectCommands[projectPath] ?? EMPTY_COMMANDS : EMPTY_COMMANDS,
  );
  const [creating, setCreating] = useState(false);
  const runningCount = useMemo(
    () => commands.filter((command) => command.status === "running").length,
    [commands],
  );

  if (!projectPath) {
    return <div className="commands-panel commands-panel--empty">Select a project to manage commands</div>;
  }

  return (
    <div className="commands-panel">
      <div className="commands-panel__header">
        <div className="commands-panel__title-wrap">
          <span className="shrink-0"><List size={15} /></span>
          <div className="commands-panel__title-block">
            <div className="commands-panel__title">Commands</div>
            <div className="commands-panel__subtitle">
              {runningCount} running · {commands.length} total
            </div>
          </div>
        </div>
        <div className="commands-panel__header-actions">
          <button className="btn-ghost" onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>Add Command</span>
          </button>
          <button
            className="commands-panel__header-btn glass-button"
            disabled={commands.length === 0}
            onClick={() => void startAllCommands(projectPath, services)}
          >
            <Play size={13} fill="currentColor" />
            <span>Play All</span>
          </button>
          <button
            className="commands-panel__header-btn glass-button"
            disabled={runningCount === 0}
            onClick={() => void stopAllCommands(projectPath, services)}
          >
            <Square size={13} fill="currentColor" />
            <span>Stop All</span>
          </button>
        </div>
      </div>
      <div className="commands-panel__simple-list">
        {commands.length === 0 && !creating && (
          <div className="commands-panel__empty-inline">
            Add the commands you always run for this project.
          </div>
        )}
        {commands.map((command) => (
          <CommandRow
            key={command.name}
            projectPath={projectPath}
            services={services}
            command={command}
            commands={commands}
          />
        ))}
        {creating && (
          <CommandRow
            isNew
            projectPath={projectPath}
            services={services}
            commands={commands}
            onSavedNew={() => setCreating(false)}
            onCancelNew={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  );
}
