import { createElement, lazy } from "react";
import {
  terminalDriverId,
  type ShipctlModule,
  type TerminalPresentationProps,
} from "@shipctl/module-api";

export {
  createTerminalImeLifecycle,
  placeTerminalIme,
  reportTerminalEffectOutcome,
  reviewTerminalPaste,
  type TerminalEffectOutcomePorts,
  type TerminalImeFrame,
  type TerminalImeLifecycle,
  type TerminalImePlacement,
  type TerminalImeState,
  type TerminalPasteReviewPorts,
  type SemanticTerminalEffect,
} from "./browserInteraction.ts";

export * from "./presentation/terminalClientModel.ts";
export * from "./presentation/terminalCellPaint.ts";
export * from "./presentation/terminalCellSurface.ts";
export * from "./presentation/terminalCellPresenter.ts";
export * from "./presentation/terminalViewportComposition.ts";
export * from "./presentation/terminalCanvasTarget.ts";
export * from "./presentation/terminalSemanticInput.ts";
export * from "./presentation/terminalClipboard.ts";
export * from "./presentation/terminalFitPlan.ts";
export * from "./presentation/terminalFitScheduler.ts";
export * from "./presentation/terminalViewportPin.ts";
export * from "./presentation/terminalScrollPin.ts";
export * from "./presentation/terminalMeasure.ts";
export * from "./presentation/terminalFontMetrics.ts";
export * from "./presentation/terminalSelectionGestures.ts";
export * from "./presentation/terminalPointerRouter.ts";
export * from "./presentation/terminalReadingAnchor.ts";
export * from "./presentation/terminalLinkTargets.ts";
export * from "./presentation/terminalSurface.ts";
export * from "./presentation/terminalSemanticSurface.ts";
export * from "./presentation/semanticTerminalAttachmentController.ts";
export * from "./presentation/semanticTerminalViewSession.ts";
export * from "./presentation/terminalContainerBinding.ts";
export * from "./presentation/terminalCache.ts";
export * from "./presentation/terminalTheme.ts";
export * from "./presentation/keybindingPresets.ts";
export * from "./presentation/semanticTerminalCanvasBinding.ts";
export * from "./presentation/semanticTerminalBrowserSession.ts";
export * from "./semanticTypes.ts";
export * from "./protocol/terminalEventDecoder.ts";
export * from "./protocol/terminalAttachmentBootstrap.ts";
export * from "./protocol/semanticTerminalClient.ts";
export * from "./scenarios/scenarioContract.ts";
export * from "./scenarios/capabilityRegister.ts";
export * from "./scenarios/scenarioRunner.ts";
export * from "./scenarios/scenarioCatalog.ts";
export * from "./scenarios/semanticTerminalScenarioEntry.ts";
export * from "./terminalPerformanceMetrics.ts";

/** The stable id shared by the native factory and the semantic presentation. */
export const SEMANTIC_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");

const SemanticTerminalPresentationView = lazy(async () => {
  const module = await import("./presentation/SemanticTerminalPresentation.tsx");
  return { default: module.SemanticTerminalPresentation };
});

function SemanticTerminalProvider(props: TerminalPresentationProps) {
  return createElement(SemanticTerminalPresentationView, props);
}

/**
 * Build-installed semantic terminal implementation and presentation.
 */
export const semanticTerminalModule = {
  id: "shipctl.semantic-terminal",
  version: "0.0.0",
  terminalPresentations: [{
    driverId: SEMANTIC_TERMINAL_DRIVER_ID,
    Presentation: SemanticTerminalProvider,
  }],
} as const satisfies ShipctlModule;

export { SemanticTerminalProvider as SemanticTerminalPresentation };
