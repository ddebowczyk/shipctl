// The terminal capability's logic surface: geometry and viewport helpers, the
// xterm theme bridge, the live-terminal cache, the host action façade, terminal and
// terminal-settings stores, module-contributed sessions, and agent notifications.
//
// React components are deliberately NOT exported here. The node --test lanes
// import this entry point through Node's type stripping, which handles .ts but
// not JSX; mixing views in would make the capability's logic untestable there.
// The views are reachable at "@shipctl/core/terminal/views".
//
// JSX is not the only way to break that. Anything reached from here must load
// in bare node, and xterm ships UMD, so a value-import of it fails the same way
// a .tsx would — silently, until something tries. This entry point went a long
// time unloadable for exactly that reason. "./tests/terminalEntryPoint.test.ts"
// now loads it and names the exports that must stay out; the "stays out of this
// entry point" comments below are what it enforces.
export * from "./terminalCache.ts";
export * from "./types.ts";
// Only the renderer policy is exported here; "./terminalRendererAddons.ts"
// value-imports the xterm addon bundles and stays out of this entry point.
export * from "./terminalRenderer.ts";
export * from "./terminalOutputQueue.ts";
export * from "./terminalProjection.ts";
export * from "./terminalClientRuntime.ts";
export * from "./terminalScrollPin.ts";
export * from "./terminalFitPlan.ts";
export * from "./terminalFitScheduler.ts";
export * from "./terminalViewportPin.ts";
export * from "./terminalSurface.ts";
// The session composes those seams; "./terminalXtermSurface.ts" and
// "./terminalBrowserSession.ts" bind them to xterm and the browser and stay out
// of this entry point.
export * from "./terminalViewSession.ts";
// The container's own lifetime, held apart from the component that mounts it.
export * from "./terminalContainerBinding.ts";
// The packaged-app scenario harness: its contract and register are plain data,
// and its entry installs nothing outside a dev build. The composition root that
// drives a live terminal is "./terminalScenarioHost.ts" and stays out of here.
export * from "./scenarios/scenarioContract.ts";
export * from "./scenarios/capabilityRegister.ts";
export * from "./scenarios/terminalScenarioEntry.ts";
export * from "./terminalOscNotification.ts";
export * from "./terminalAttachmentBootstrap.ts";
export * from "./terminalEventDecoder.ts";
export * from "./terminalClientModel.ts";
// What a person did, in the host's own vocabulary. The browser events it reads
// are described structurally, so it loads with no DOM.
export * from "./terminalSemanticInput.ts";
// What to draw for one frame of host state. Renderer-independent by design, so
// it is here rather than beside whichever surface ends up drawing it.
export * from "./terminalCellPaint.ts";
// The draw sequence and colour resolution for a plan, over a six-operation
// port. Whatever owns the pixels binds the port and stays out of here.
export * from "./terminalCellSurface.ts";
// When a presentation paints and how much of it: the lifecycle that joins a
// client model to a paint target. Renderer-independent, so it lives here.
export * from "./terminalCellPresenter.ts";
// The Canvas 2D binding for that port. It names the context structurally and
// value-imports nothing, so it loads in bare node and is proved there.
export * from "./terminalCanvasTarget.ts";
export * from "./terminalRetention.ts";
export * from "./terminalTheme.ts";
// The measurement policy only; "./terminalXtermMeasure.ts" value-imports xterm
// and the fit addon and stays out of this entry point.
export * from "./terminalMeasure.ts";
// What a cell measures, from the font rather than from a hidden terminal. It
// is the other half of the measurement, and it binds no engine.
export * from "./terminalFontMetrics.ts";
// What a pointer means: a gesture read as a selection request, the OSC 8 link
// a cell carries, and the router that decides which of the three destinations
// an event belongs to. All three read host facts and hold no terminal state.
// Which host rows a reader who scrolled back is shown, and the reads that view
// needs. Rows, never pixels, and never a row the host did not write.
export * from "./terminalViewportComposition.ts";
// The reading position, held as one of the host's lines instead of as a row
// number. It calls the host through a port and holds no terminal state.
export * from "./terminalReadingAnchor.ts";
export * from "./terminalSelectionGestures.ts";
export * from "./terminalLinkTargets.ts";
export * from "./terminalPointerRouter.ts";
// The surface that binds the model, the plan and the canvas. The peer of
// "./terminalXtermSurface.ts", and unlike it, xterm-free and exported here.
export * from "./terminalSemanticSurface.ts";
export * from "./terminalViewport.ts";
export * from "./terminalColorTheme.ts";
export * from "./notifications.ts";
export * from "./useTerminalActions.ts";
export * from "./useTerminalStore.ts";
export * from "./useTerminalSettingsStore.ts";
export * from "./terminalSessions.ts";
export * from "./keybindingPresets.ts";
export * from "./useKeybindingStore.ts";
