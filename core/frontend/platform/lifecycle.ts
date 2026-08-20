import { invoke } from "@tauri-apps/api/core";

/** Requests the native application shutdown sequence. */
export function shutdownAndQuit(): Promise<void> {
  return invoke("shutdown_and_quit");
}
