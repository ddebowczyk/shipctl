import { createElement, lazy } from "react";
import {
  TERMINAL_SESSION_GRANTS,
  terminalDriverId,
  terminalSessionsService,
  type TerminalPresentationProps,
  type TerminalPresentationProvider,
} from "@shipctl/module-api";

export const THIN_TERMINAL_MODULE_ID = "shipctl.thin-terminal" as const;
export const THIN_TERMINAL_PLUGIN_VERSION = "0.0.0" as const;
export const THIN_TERMINAL_DRIVER_ID = terminalDriverId("thin-terminal");
export const THIN_TERMINAL_REQUIRED_GRANTS = Object.freeze([
  TERMINAL_SESSION_GRANTS.attach,
  TERMINAL_SESSION_GRANTS.input,
  TERMINAL_SESSION_GRANTS.resize,
] as const);

const ThinTerminalPresentation = lazy(async () => {
  const module = await import("./ThinTerminalPresentation.tsx");
  return { default: module.ThinTerminalPresentation };
});

function ThinTerminalProvider(props: TerminalPresentationProps) {
  return createElement(ThinTerminalPresentation, props);
}

/**
 * Inert presentation declarations. The artifact registers these only while
 * its direct activation is alive, so hiding a terminal never re-registers or
 * recreates its xterm view.
 */
export const thinTerminalContributions = Object.freeze({
  terminalPresentations: Object.freeze([
    {
      moduleId: THIN_TERMINAL_MODULE_ID,
      driverId: THIN_TERMINAL_DRIVER_ID,
      requiredServices: [terminalSessionsService],
      Presentation: ThinTerminalProvider,
    },
  ] satisfies readonly TerminalPresentationProvider[]),
});

export { ThinTerminalProvider as ThinTerminalPresentation };
