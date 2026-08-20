import { invoke } from "@tauri-apps/api/core";

import type { UiState } from "./types.ts";

/**
 * Transitional durable UI-state commands.
 *
 * Step 05 replaces this bespoke record with TypeScript-owned durable state;
 * keeping it separate makes the remaining migration boundary explicit.
 */
export function getUiState(): Promise<UiState> {
  return invoke("get_ui_state");
}

export function setLastRepoPath(path: string | null): Promise<UiState> {
  return invoke("set_last_repo_path", { path });
}

export function saveAppearanceState(
  themeId: string,
  customTheme: unknown | null,
): Promise<UiState> {
  return invoke("save_appearance_state", { themeId, customTheme });
}
