import { listen } from "@tauri-apps/api/event";

type Unsubscribe = () => void;

interface GitFilesystemChangePayload {
  readonly paths: readonly string[];
}

function readGitFilesystemChangePayload(value: unknown): GitFilesystemChangePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const paths = (value as Record<string, unknown>).paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) return null;
  return { paths };
}

/**
 * Converts the one native repository-watch event into a payload-only host
 * subscription. Callers never receive a Tauri event or event name.
 */
export function observeGitFilesystemChanges(
  receive: (paths: readonly string[]) => void,
): Promise<Unsubscribe> {
  return listen<unknown>("git-fs-changed", (event) => {
    const payload = readGitFilesystemChangePayload(event.payload);
    if (payload !== null) receive(payload.paths);
  });
}
