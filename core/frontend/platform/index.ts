// The host's boundary with the outside world: named native resource adapters,
// their private wire values, and error extraction. No transport-shaped facade
// is re-exported here. Capabilities import this entry point; nothing imports
// its files directly.
//
// Extensions are explicit because these are runtime re-exports: the node --test
// lanes resolve them through Node's ESM resolver, which does not extension-guess.
export * from "./types.ts";
export * from "./errors.ts";
export * from "./projects.ts";
export * from "./configuration.ts";
export * from "./terminalRetention.ts";
export * from "./legacyUiState.ts";
export * from "./fonts.ts";
export * from "./system.ts";
export * from "./lifecycle.ts";
export * from "./runtimeMessages.ts";
export * from "./semanticServiceAdapter.ts";
export * from "./processes.ts";
export * from "./projectDocuments.ts";
export * from "./git.ts";
export * from "./skillInstallation.ts";
export * from "./credentials.ts";
export * from "./assistantLaunch.ts";
export * from "./usageSources.ts";
export * from "./pluginData.ts";
export * from "./messages.ts";
export * from "./scheduler.ts";
export * from "./terminalSessions.ts";
export * from "./semanticTerminals.ts";
export * from "./moduleControl.ts";
export * from "./moduleArtifactAssets.ts";
export * from "./projectSelection.ts";
export * from "./projectEvents.ts";
export * from "./desktopApp.ts";
export * from "./desktopWindow.ts";
export * from "./desktopNotifications.ts";
export * from "./runtimeDiagnostics.ts";
