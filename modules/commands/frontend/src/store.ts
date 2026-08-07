import { create } from "zustand";

import type { CommandConfig, CommandState, CommandStatus } from "./types";

interface CommandsStore {
  readonly projectCommands: Record<string, readonly CommandState[]>;
  load(projectPath: string, commands: readonly CommandConfig[]): void;
  hasProject(projectPath: string): boolean;
  removeProject(projectPath: string): void;
  add(projectPath: string, command: CommandConfig): void;
  update(projectPath: string, previousName: string, command: CommandConfig): void;
  remove(projectPath: string, name: string): void;
  setRuntime(
    projectPath: string,
    name: string,
    status: CommandStatus,
    sessionId: string | null,
  ): void;
}

export const useCommandsStore = create<CommandsStore>((set, get) => ({
  projectCommands: {},

  load(projectPath, commands) {
    set((state) => ({
      projectCommands: {
        ...state.projectCommands,
        [projectPath]: commands.map((command) => ({
          ...command,
          env: { ...command.env },
          status: "stopped",
          sessionId: null,
        })),
      },
    }));
  },

  hasProject: (projectPath) => projectPath in get().projectCommands,

  removeProject(projectPath) {
    set((state) => {
      const { [projectPath]: _, ...projectCommands } = state.projectCommands;
      return { projectCommands };
    });
  },

  add(projectPath, command) {
    set((state) => ({
      projectCommands: {
        ...state.projectCommands,
        [projectPath]: [
          ...(state.projectCommands[projectPath] ?? []),
          { ...command, env: { ...command.env }, status: "stopped", sessionId: null },
        ],
      },
    }));
  },

  update(projectPath, previousName, command) {
    set((state) => ({
      projectCommands: {
        ...state.projectCommands,
        [projectPath]: (state.projectCommands[projectPath] ?? []).map((existing) => (
          existing.name === previousName
            ? { ...existing, ...command, env: { ...command.env } }
            : existing
        )),
      },
    }));
  },

  remove(projectPath, name) {
    set((state) => ({
      projectCommands: {
        ...state.projectCommands,
        [projectPath]: (state.projectCommands[projectPath] ?? []).filter(
          (command) => command.name !== name,
        ),
      },
    }));
  },

  setRuntime(projectPath, name, status, sessionId) {
    set((state) => ({
      projectCommands: {
        ...state.projectCommands,
        [projectPath]: (state.projectCommands[projectPath] ?? []).map((command) => (
          command.name === name ? { ...command, status, sessionId } : command
        )),
      },
    }));
  },
}));
