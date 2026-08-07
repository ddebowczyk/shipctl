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

export function BuiltinPanelRuntimeProvider({
  children,
}: {
  readonly value: BuiltinPanelRuntimeValue;
  readonly children: ReactNode;
}) {
  return children;
}

export const BUILTIN_PANEL_LOADERS = {
  launcher: async () => {
    return {
      default: function RetiredBuiltinLauncher() {
        throw new Error("The built-in launcher was replaced by the Assistants module");
      },
    };
  },
} satisfies BuiltinPanelLoaders;
