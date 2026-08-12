import type {
  ModuleTerminalPresentationPort,
  ModuleTerminalPresentationSnapshot,
} from "@shipctl/module-api";
import { buildCSSFontFamily, TERMINAL_LINE_HEIGHT, useThemeStore } from "@shipctl/core/appearance";
import { getErrorCode } from "@shipctl/core/platform";
import { reportTerminalDiagnostic } from "@shipctl/core/shared";

import { notifyAgent } from "./notifications.ts";
import { useKeybindingStore } from "./useKeybindingStore.ts";
import { useTerminalSettingsStore } from "./useTerminalSettingsStore.ts";

function snapshot(): ModuleTerminalPresentationSnapshot {
  const theme = useThemeStore.getState().theme;
  const settings = useTerminalSettingsStore.getState().settings;
  return {
    font: {
      family: buildCSSFontFamily(settings.fontFamily),
      sizePx: settings.fontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
    },
    palette: {
      foreground: theme.termForeground,
      background: theme.appBg,
      cursor: theme.termCursor,
      selection: theme.termSelection,
    },
    keybindings: useKeybindingStore.getState().settings,
    cursorBlink: settings.cursorBlink,
    confirmUnsafePaste: settings.confirmUnsafePaste,
  };
}

/**
 * Host support for browser terminal presentations. It provides application
 * preferences and desktop effects only. Each module owns its renderer,
 * protocol commands, and terminal meaning.
 */
export const terminalPresentationPort: ModuleTerminalPresentationPort = {
  getSnapshot: snapshot,
  subscribe(listener) {
    const unsubscribers = [
      useThemeStore.subscribe(listener),
      useTerminalSettingsStore.subscribe(listener),
      useKeybindingStore.subscribe(listener),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  },
  errorCode: getErrorCode,
  recordMetric: () => undefined,
  recordDiagnostic: (terminalId, event, facts) => {
    reportTerminalDiagnostic({
      occurredAt: new Date().toISOString(),
      terminalId,
      event,
      ...(facts === undefined ? {} : { facts }),
    });
  },
  notifyBell: (terminalId, message) => {
    void notifyAgent(terminalId as never, message);
  },
};
