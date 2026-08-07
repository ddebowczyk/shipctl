import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { CommandConfig, CommandState, SessionMode } from "../../lib/types";
import type { BuiltinPanelLoaders } from "./builtinPanelAdapters";

export interface BuiltinPanelRuntimeValue {
  readonly commands: CommandState[];
  readonly onStartCommand: (name: string) => void;
  readonly onStopCommand: (name: string) => void;
  readonly onCreateCommand: (command: CommandConfig) => Promise<boolean> | boolean;
  readonly onUpdateCommand: (
    previousName: string,
    command: CommandConfig,
  ) => Promise<boolean> | boolean;
  readonly onDeleteCommand: (name: string) => void;
  readonly onStartAllCommands: () => Promise<void> | void;
  readonly onStopAllCommands: () => Promise<void> | void;
  readonly onStartSession: (
    assistantId: string,
    mode: SessionMode,
    model?: string,
  ) => Promise<boolean>;
}

const BuiltinPanelRuntimeContext = createContext<BuiltinPanelRuntimeValue | null>(null);

export function BuiltinPanelRuntimeProvider({
  value,
  children,
}: {
  readonly value: BuiltinPanelRuntimeValue;
  readonly children: ReactNode;
}) {
  return (
    <BuiltinPanelRuntimeContext.Provider value={value}>
      {children}
    </BuiltinPanelRuntimeContext.Provider>
  );
}

function useBuiltinPanelRuntime(): BuiltinPanelRuntimeValue {
  const runtime = useContext(BuiltinPanelRuntimeContext);
  if (!runtime) {
    throw new Error("Built-in panel rendered without its runtime adapter");
  }
  return runtime;
}

export const BUILTIN_PANEL_LOADERS = {
  commands: async () => {
    const { default: CommandsPanel } = await import("../../components/commands/CommandsPanel");
    return {
      default: function CommandsPanelAdapter() {
        const runtime = useBuiltinPanelRuntime();
        return <CommandsPanel {...runtime} />;
      },
    };
  },
  launcher: async () => {
    const { default: SessionLauncher } = await import("../../components/session/SessionLauncher");
    return {
      default: function SessionLauncherAdapter() {
        const { onStartSession } = useBuiltinPanelRuntime();
        return <SessionLauncher onStartSession={onStartSession} />;
      },
    };
  },
} satisfies BuiltinPanelLoaders;
