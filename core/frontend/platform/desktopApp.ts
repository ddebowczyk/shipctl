import {
  getIdentifier,
  getName,
  getTauriVersion,
  getVersion,
} from "@tauri-apps/api/app";

export interface DesktopAppMetadata {
  readonly name: string;
  readonly version: string;
  readonly identifier: string;
  readonly tauriVersion: string;
}

/** Reads the small stable metadata set rendered by Shipctl settings. */
export async function getDesktopAppMetadata(): Promise<DesktopAppMetadata> {
  const [name, version, identifier, tauriVersion] = await Promise.all([
    getName(),
    getVersion(),
    getIdentifier(),
    getTauriVersion(),
  ]);
  return { name, version, identifier, tauriVersion };
}
