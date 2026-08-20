import { invoke } from "@tauri-apps/api/core";

import type { FontFaceData, FontFamily } from "./types.ts";

/** Operating-system font enumeration and loading. */
export function listMonospaceFamilies(): Promise<FontFamily[]> {
  return invoke("list_monospace_families");
}

export function loadFontFamily(family: string): Promise<FontFaceData[]> {
  return invoke("load_font_family", { family });
}
