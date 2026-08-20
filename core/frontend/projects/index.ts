// Projects: the repositories the user has opened, how they are grouped in the
// navigation, the per-project settings, and the module-contributed facts
// attached to each one.
//
// JSX-free by design; the React surface lives in ./views.ts.
export * from "./projectGrouping.ts";
export * from "./projectFacts.ts";
export * from "./useRepoStore.ts";
export * from "./projectsService.ts";
export * from "./useProjectSettingsStore.ts";
export * from "./useProjectWatcher.ts";
