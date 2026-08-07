import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { SessionMode } from "../../lib/types";
import type { BuiltinPanelLoaders } from "./builtinPanelAdapters";

export interface BuiltinPanelRuntimeValue {
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
