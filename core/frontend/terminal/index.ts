// The terminal capability's logic surface: geometry and viewport helpers, the
// xterm theme bridge, the live-terminal cache, the host action façade, terminal and
// terminal-settings stores, module-contributed sessions, and agent notifications.
//
// React components are deliberately NOT exported here. The node --test lanes
// import this entry point through Node's type stripping, which handles .ts but
// not JSX; mixing views in would make the capability's logic untestable there.
// The views are reachable at "@shipctl/core/terminal/views".
export * from "./terminalCache.ts";
export * from "./types.ts";
// Only the renderer policy is exported here; "./terminalRendererAddons.ts"
// value-imports the xterm addon bundles and stays out of this entry point.
export * from "./terminalRenderer.ts";
export * from "./terminalOutputQueue.ts";
export * from "./terminalProjection.ts";
export * from "./terminalClientRuntime.ts";
export * from "./terminalScrollPin.ts";
export * from "./terminalTheme.ts";
export * from "./terminalMeasure.ts";
export * from "./terminalViewport.ts";
export * from "./terminalColorTheme.ts";
export * from "./notifications.ts";
export * from "./useTerminalActions.ts";
export * from "./useTerminalStore.ts";
export * from "./useTerminalSettingsStore.ts";
export * from "./terminalSessions.ts";
export * from "./keybindingPresets.ts";
export * from "./useKeybindingStore.ts";
