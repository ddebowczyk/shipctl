import {
  initializeDesktopNotifications,
  notifyDesktopWhenUnfocused,
} from "@shipctl/core/platform";
import { useTerminalStore } from "./useTerminalStore.ts";
import type { TerminalId } from "./types.ts";

export async function initNotifications(): Promise<void> {
  await initializeDesktopNotifications();
}

export async function notifyAgent(terminalId: TerminalId, message: string): Promise<void> {
  useTerminalStore.getState().setTabBell(terminalId, message);
  await notifyDesktopWhenUnfocused(message);
}
