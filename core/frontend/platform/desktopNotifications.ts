import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let focused = true;
let permissionGranted = false;
let initialized = false;

/** Initializes the application-lifetime focus and notification permission state. */
export async function initializeDesktopNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    await Promise.all([
      listen("tauri://focus", () => {
        focused = true;
      }),
      listen("tauri://blur", () => {
        focused = false;
      }),
    ]);
    permissionGranted = await isPermissionGranted();
  } catch (error) {
    initialized = false;
    throw error;
  }
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted) return true;
  const permission = await requestPermission();
  permissionGranted = permission === "granted";
  return permissionGranted;
}

/** Delivers an attention notification only while Shipctl is not focused. */
export async function notifyDesktopWhenUnfocused(message: string): Promise<void> {
  if (focused) return;

  try {
    if (!await ensureNotificationPermission()) return;
    sendNotification({ title: "Shipctl", body: message });
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error("[shipctl] notification error:", error);
    }
  }
}
