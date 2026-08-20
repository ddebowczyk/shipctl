import type {
  ConfigurationContribution,
  ConfigurationDiagnostic,
  ConfigurationMigration,
  ConfigurationValidation,
  ModuleJsonValue,
} from "@shipctl/module-api";

import type {
  CanvasAdapterId,
  CursorStyle,
  EditorSettings,
  KeybindingSettings,
  ProjectSettings,
  RuntimeSettings,
  SidebarSettings,
  TerminalSettings,
} from "./types.ts";

export const HOST_CONFIGURATION_MODULE_ID = "shipctl.host";
export const HOST_CONFIGURATION_SCHEMA_VERSION = 2;
const RUNTIME_CONFIGURATION_SCHEMA_VERSION = 3;

const MIB = 1024 * 1024;
const DEFAULT_TERMINAL_SCROLLBACK_BYTES = 16 * MIB;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  canvasAdapter: "standard",
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  preferredEditor: null,
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  showAgentSessionsInSidebar: true,
};

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  shiftEnterNewline: true,
  optionDeleteWord: true,
  cmdKClear: true,
};

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  cursorStyle: "block",
  cursorBlink: true,
  scrollbackBytes: DEFAULT_TERMINAL_SCROLLBACK_BYTES,
  fontFamily: "MesloLGS NF",
  fontSize: 14,
  urlAllowlist: ["http", "https"],
  confirmUnsafePaste: false,
};

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
  fontSize: 13,
  fontFamily: "SF Pro Display, IBM Plex Sans, Segoe UI, sans-serif",
  width: 288,
};

function diagnostic(code: string, message: string, path?: string): ConfigurationDiagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

function invalid<Value extends ModuleJsonValue>(
  code: string,
  message: string,
  path?: string,
): ConfigurationValidation<Value> {
  return { ok: false, diagnostic: diagnostic(code, message, path) };
}

function valid<Value extends ModuleJsonValue>(value: Value): ConfigurationValidation<Value> {
  return { ok: true, value };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function moduleJson(value: unknown, ancestors = new Set<object>()): value is ModuleJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const accepted = Array.isArray(value)
    ? value.every((item) => moduleJson(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => moduleJson(item, ancestors));
  ancestors.delete(value);
  return accepted;
}

function editor(value: unknown): value is EditorSettings["preferredEditor"] {
  return value === null
    || value === "vscode"
    || value === "zed"
    || value === "cursor"
    || value === "sublime_text";
}

function canvasAdapter(value: unknown): value is CanvasAdapterId {
  return value === "standard" || value === "layman";
}

function cursorStyle(value: unknown): value is CursorStyle {
  return value === "block" || value === "underline" || value === "bar";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*$/i.test(value);
}

function urlAllowlist(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && validScheme(entry));
}

function migration<Value extends ModuleJsonValue>(
  migrationId: string,
  migrate: (value: ModuleJsonValue) => ConfigurationValidation<Value>,
): readonly ConfigurationMigration<Value>[] {
  return [{ fromSchemaVersion: 1, migrationId, migrate }];
}

function hostConfiguration<Value extends ModuleJsonValue>(input: Omit<
  ConfigurationContribution<Value>,
  "moduleId" | "schemaVersion"
> & {
  readonly schemaVersion?: number;
}): ConfigurationContribution<Value> {
  const { schemaVersion = HOST_CONFIGURATION_SCHEMA_VERSION, ...contribution } = input;
  return {
    ...contribution,
    moduleId: HOST_CONFIGURATION_MODULE_ID,
    schemaVersion,
  };
}

function validateRuntimeSettings(value: unknown): ConfigurationValidation<RuntimeSettings> {
  const source = record(value);
  if (source === null || !canvasAdapter(source.canvasAdapter)) {
    return invalid("configuration.invalid-runtime", "Canvas adapter must be a bundled adapter.", "canvasAdapter");
  }
  return valid({ canvasAdapter: source.canvasAdapter });
}

function migrateRuntimeSettings(value: ModuleJsonValue): ConfigurationValidation<RuntimeSettings> {
  const source = record(value);
  if (source === null) {
    return invalid("configuration.invalid-runtime", "Runtime settings must be an object.");
  }
  return validateRuntimeSettings({
    canvasAdapter: source.canvasAdapter === "legacy" ? "standard" : source.canvasAdapter,
  });
}

function runtimeMigrations(): readonly ConfigurationMigration<RuntimeSettings>[] {
  return [
    {
      fromSchemaVersion: 1,
      migrationId: "shipctl.host.runtime.v1-to-v3",
      migrate: migrateRuntimeSettings,
    },
    {
      fromSchemaVersion: 2,
      migrationId: "shipctl.host.runtime.v2-to-v3",
      migrate: migrateRuntimeSettings,
    },
  ];
}

function validateEditorSettings(value: unknown): ConfigurationValidation<EditorSettings> {
  const source = record(value);
  if (source === null || !editor(source.preferredEditor)) {
    return invalid("configuration.invalid-editor", "Preferred editor is invalid.", "preferredEditor");
  }
  return valid({ preferredEditor: source.preferredEditor });
}

function migrateEditorSettings(value: ModuleJsonValue): ConfigurationValidation<EditorSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-editor", "Editor settings must be an object.");
  const preferredEditor = source.preferredEditor ?? null;
  return validateEditorSettings({ preferredEditor });
}

function validateProjectSettings(value: unknown): ConfigurationValidation<ProjectSettings> {
  const source = record(value);
  if (source === null || typeof source.showAgentSessionsInSidebar !== "boolean") {
    return invalid(
      "configuration.invalid-projects",
      "Project sidebar visibility must be a boolean.",
      "showAgentSessionsInSidebar",
    );
  }
  if (!moduleJson(source)) {
    return invalid("configuration.invalid-projects", "Project settings must be JSON-safe.");
  }
  return valid({
    ...source as Record<string, ModuleJsonValue>,
    showAgentSessionsInSidebar: source.showAgentSessionsInSidebar,
  });
}

function migrateProjectSettings(value: ModuleJsonValue): ConfigurationValidation<ProjectSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-projects", "Project settings must be an object.");
  return validateProjectSettings({
    ...source,
    showAgentSessionsInSidebar: source.showAgentSessionsInSidebar ?? true,
  });
}

function validateKeybindingSettings(value: unknown): ConfigurationValidation<KeybindingSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-keybindings", "Keybindings must be an object.");
  for (const key of ["shiftEnterNewline", "optionDeleteWord", "cmdKClear"] as const) {
    if (typeof source[key] !== "boolean") {
      return invalid("configuration.invalid-keybindings", `${key} must be a boolean.`, key);
    }
  }
  return valid({
    shiftEnterNewline: source.shiftEnterNewline as boolean,
    optionDeleteWord: source.optionDeleteWord as boolean,
    cmdKClear: source.cmdKClear as boolean,
  });
}

function migrateKeybindingSettings(value: ModuleJsonValue): ConfigurationValidation<KeybindingSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-keybindings", "Keybindings must be an object.");
  return validateKeybindingSettings({ ...DEFAULT_KEYBINDING_SETTINGS, ...source });
}

function validateTerminalSettings(value: unknown): ConfigurationValidation<TerminalSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-terminal", "Terminal settings must be an object.");
  if (!cursorStyle(source.cursorStyle)) {
    return invalid("configuration.invalid-terminal", "Cursor style is invalid.", "cursorStyle");
  }
  if (typeof source.cursorBlink !== "boolean") {
    return invalid("configuration.invalid-terminal", "Cursor blink must be a boolean.", "cursorBlink");
  }
  if (!safeNonNegativeInteger(source.scrollbackBytes)) {
    return invalid("configuration.invalid-terminal", "Scrollback bytes must be a non-negative integer.", "scrollbackBytes");
  }
  if (!nonEmptyString(source.fontFamily)) {
    return invalid("configuration.invalid-terminal", "Font family is required.", "fontFamily");
  }
  if (typeof source.fontSize !== "number" || !Number.isFinite(source.fontSize) || source.fontSize <= 0) {
    return invalid("configuration.invalid-terminal", "Font size must be positive.", "fontSize");
  }
  if (!urlAllowlist(source.urlAllowlist)) {
    return invalid("configuration.invalid-terminal", "URL allowlist contains an invalid scheme.", "urlAllowlist");
  }
  if (typeof source.confirmUnsafePaste !== "boolean") {
    return invalid("configuration.invalid-terminal", "Unsafe paste confirmation must be a boolean.", "confirmUnsafePaste");
  }
  return valid({
    cursorStyle: source.cursorStyle,
    cursorBlink: source.cursorBlink,
    scrollbackBytes: source.scrollbackBytes,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize,
    urlAllowlist: [...source.urlAllowlist],
    confirmUnsafePaste: source.confirmUnsafePaste,
  });
}

function migrateTerminalSettings(value: ModuleJsonValue): ConfigurationValidation<TerminalSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-terminal", "Terminal settings must be an object.");
  return validateTerminalSettings({ ...DEFAULT_TERMINAL_SETTINGS, ...source });
}

function validateSidebarSettings(value: unknown): ConfigurationValidation<SidebarSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-sidebar", "Sidebar settings must be an object.");
  if (typeof source.fontSize !== "number" || !Number.isFinite(source.fontSize) || source.fontSize <= 0) {
    return invalid("configuration.invalid-sidebar", "Sidebar font size must be positive.", "fontSize");
  }
  if (!nonEmptyString(source.fontFamily)) {
    return invalid("configuration.invalid-sidebar", "Sidebar font family is required.", "fontFamily");
  }
  if (typeof source.width !== "number" || !Number.isFinite(source.width) || source.width <= 0) {
    return invalid("configuration.invalid-sidebar", "Sidebar width must be positive.", "width");
  }
  return valid({ fontSize: source.fontSize, fontFamily: source.fontFamily, width: source.width });
}

function migrateSidebarSettings(value: ModuleJsonValue): ConfigurationValidation<SidebarSettings> {
  const source = record(value);
  if (source === null) return invalid("configuration.invalid-sidebar", "Sidebar settings must be an object.");
  return validateSidebarSettings({ ...DEFAULT_SIDEBAR_SETTINGS, ...source });
}

export const HOST_CONFIGURATION = {
  runtime: hostConfiguration<RuntimeSettings>({
    id: "shipctl.host.runtime",
    scope: "global",
    key: "runtime",
    schemaVersion: RUNTIME_CONFIGURATION_SCHEMA_VERSION,
    defaults: DEFAULT_RUNTIME_SETTINGS,
    validate: validateRuntimeSettings,
    migrations: runtimeMigrations(),
    legacySource: {
      key: "ui",
      schemaVersion: 1,
      transform: (value) => {
        const source = record(value);
        return {
          canvasAdapter: typeof source?.canvas === "string" ? source.canvas : null,
        };
      },
    },
  }),
  editor: hostConfiguration<EditorSettings>({
    id: "shipctl.host.editor",
    scope: "global",
    key: "editor",
    defaults: DEFAULT_EDITOR_SETTINGS,
    validate: validateEditorSettings,
    migrations: migration("shipctl.host.editor.v1-to-v2", migrateEditorSettings),
    legacySource: { key: "editor", schemaVersion: 1 },
  }),
  projects: hostConfiguration<ProjectSettings>({
    id: "shipctl.host.projects",
    scope: "global",
    key: "projects",
    defaults: DEFAULT_PROJECT_SETTINGS,
    validate: validateProjectSettings,
    migrations: migration("shipctl.host.projects.v1-to-v2", migrateProjectSettings),
    legacySource: { key: "projects", schemaVersion: 1 },
  }),
  keybindings: hostConfiguration<KeybindingSettings>({
    id: "shipctl.host.keybindings",
    scope: "global",
    key: "keybindings",
    defaults: DEFAULT_KEYBINDING_SETTINGS,
    validate: validateKeybindingSettings,
    migrations: migration("shipctl.host.keybindings.v1-to-v2", migrateKeybindingSettings),
    legacySource: { key: "keybindings", schemaVersion: 1 },
  }),
  terminal: hostConfiguration<TerminalSettings>({
    id: "shipctl.host.terminal",
    scope: "global",
    key: "terminal",
    defaults: DEFAULT_TERMINAL_SETTINGS,
    validate: validateTerminalSettings,
    migrations: migration("shipctl.host.terminal.v1-to-v2", migrateTerminalSettings),
    legacySource: { key: "terminal", schemaVersion: 1 },
  }),
  sidebar: hostConfiguration<SidebarSettings>({
    id: "shipctl.host.sidebar",
    scope: "global",
    key: "sidebar",
    defaults: DEFAULT_SIDEBAR_SETTINGS,
    validate: validateSidebarSettings,
    migrations: migration("shipctl.host.sidebar.v1-to-v2", migrateSidebarSettings),
    legacySource: { key: "sidebar", schemaVersion: 1 },
  }),
} as const;

export type HostConfigurationKey = keyof typeof HOST_CONFIGURATION;

export type HostConfigurationValue<Key extends HostConfigurationKey> =
  typeof HOST_CONFIGURATION[Key] extends ConfigurationContribution<infer Value> ? Value : never;

export const HOST_CONFIGURATION_CONTRIBUTIONS: readonly ConfigurationContribution[] = Object.freeze(
  Object.values(HOST_CONFIGURATION),
);
