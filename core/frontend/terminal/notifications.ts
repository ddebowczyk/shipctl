import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
import { useTerminalStore } from "./useTerminalStore.ts";

let focused = true;
let permissionGranted = false;
let initialized = false;

export async function initNotifications() {
  if (initialized) return;
  initialized = true;

  listen("tauri://focus", () => {
    focused = true;
  });
  listen("tauri://blur", () => {
    focused = false;
  });

  permissionGranted = await isPermissionGranted();
}

async function ensureNotificationPermission() {
  if (permissionGranted) return true;

  const permission = await requestPermission();
  permissionGranted = permission === "granted";
  return permissionGranted;
}

export async function notifyAgent(ptyId: number, message: string) {
  useTerminalStore.getState().setTabBell(ptyId, message);

  if (focused) {
    return;
  }

  try {
    const hasPermission = await ensureNotificationPermission();
    if (!hasPermission) return;
    sendNativeNotification({ title: "Shipctl", body: message });
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error("[shipctl] notification error:", error);
    }
  }
}
