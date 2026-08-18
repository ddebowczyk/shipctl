import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Resolves an already-admitted module artifact file through Tauri's asset
 * protocol. Artifact identity and directory admission stay with the loader.
 */
export function moduleArtifactAssetUrl(entryPath: string): string {
  return convertFileSrc(entryPath);
}
