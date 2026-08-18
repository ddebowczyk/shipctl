import { open } from "@tauri-apps/plugin-dialog";

/** Selects one project directory through the native desktop picker. */
export async function selectProjectDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select project folder",
  });
  return typeof selected === "string" ? selected : null;
}
