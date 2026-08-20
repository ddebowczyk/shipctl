import { createElement, lazy } from "react";
import {
  SEMANTIC_TERMINAL_GRANTS,
  TERMINAL_SESSION_GRANTS,
  semanticTerminalsService,
  terminalDriverId,
  terminalSessionsService,
  type TerminalPresentationProps,
  type TerminalPresentationProvider,
} from "@shipctl/module-api";

export const SEMANTIC_TERMINAL_MODULE_ID = "shipctl.semantic-terminal" as const;
export const SEMANTIC_TERMINAL_PLUGIN_VERSION = "0.0.0" as const;
/** The stable id shared by the native factory and the semantic presentation. */
export const SEMANTIC_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");
export const SEMANTIC_TERMINAL_REQUIRED_GRANTS = Object.freeze([
  TERMINAL_SESSION_GRANTS.attach,
  TERMINAL_SESSION_GRANTS.input,
  TERMINAL_SESSION_GRANTS.resize,
  SEMANTIC_TERMINAL_GRANTS.attach,
  SEMANTIC_TERMINAL_GRANTS.input,
  SEMANTIC_TERMINAL_GRANTS.inspect,
] as const);

const SemanticTerminalPresentationView = lazy(async () => {
  const module = await import("./presentation/SemanticTerminalPresentation.tsx");
  return { default: module.SemanticTerminalPresentation };
});

function SemanticTerminalProvider(props: TerminalPresentationProps) {
  return createElement(SemanticTerminalPresentationView, props);
}

/**
 * Inert presentation declarations. The artifact registers these only while
 * its direct activation is alive, so ordinary tab or workspace visibility
 * changes retain the semantic session and its mounted presentation.
 */
export const semanticTerminalContributions = Object.freeze({
  terminalPresentations: Object.freeze([
    {
      moduleId: SEMANTIC_TERMINAL_MODULE_ID,
      driverId: SEMANTIC_TERMINAL_DRIVER_ID,
      requiredServices: [terminalSessionsService, semanticTerminalsService],
      Presentation: SemanticTerminalProvider,
    },
  ] satisfies readonly TerminalPresentationProvider[]),
});

export { SemanticTerminalProvider as SemanticTerminalPresentation };
