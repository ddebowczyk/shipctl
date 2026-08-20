import type { ModuleJsonValue } from "@shipctl/module-api";

/** The host-owned main canvas selected by TypeScript configuration. */
export type CanvasAdapterId = "standard" | "layman";

export interface RuntimeSettings extends Record<string, ModuleJsonValue> {
  canvasAdapter: CanvasAdapterId;
}

export type PreferredEditor = "vscode" | "zed" | "cursor" | "sublime_text";

export interface EditorSettings extends Record<string, ModuleJsonValue> {
  preferredEditor: PreferredEditor | null;
}

/**
 * Existing projects records may contain independently-owned legacy values.
 * Keep them losslessly during the one-way import; new modules get their own
 * plugin-data namespaces instead of adding more keys here.
 */
export interface ProjectSettings extends Record<string, ModuleJsonValue> {
  showAgentSessionsInSidebar: boolean;
}

/** A JSON-safe patch from the legacy host settings bridge. */
export type ProjectSettingsPatch = Record<string, ModuleJsonValue>;

export interface KeybindingSettings extends Record<string, ModuleJsonValue> {
  shiftEnterNewline: boolean;
  optionDeleteWord: boolean;
  cmdKClear: boolean;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalSettings extends Record<string, ModuleJsonValue> {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** The terminal resource measures retained history in bytes, not rows. */
  scrollbackBytes: number;
  fontFamily: string;
  fontSize: number;
  urlAllowlist: string[];
  confirmUnsafePaste: boolean;
}

export interface SidebarSettings extends Record<string, ModuleJsonValue> {
  fontSize: number;
  fontFamily: string;
  width: number;
}
