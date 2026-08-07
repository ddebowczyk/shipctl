// Identifiers for the surfaces the host itself provides. They are well-known
// strings rather than a registry lookup so that a caller can name a built-in
// surface without depending on the host runtime that mounts it.
export const BUILTIN_GLOBAL_SURFACE_IDS = {
  settings: "core.settings",
} as const;
