import { createElement, lazy } from "react";
import {
  TERMINAL_SESSION_GRANTS,
  terminalDriverId,
  terminalSessionsService,
  type ShipctlModule,
  type TerminalPresentationProps,
} from "@shipctl/module-api";

export const THIN_TERMINAL_DRIVER_ID = terminalDriverId("thin-terminal");

const ThinTerminalPresentation = lazy(async () => {
  const module = await import("./ThinTerminalPresentation.tsx");
  return { default: module.ThinTerminalPresentation };
});

function ThinTerminalProvider(props: TerminalPresentationProps) {
  return createElement(ThinTerminalPresentation, props);
}

export const thinTerminalModule = {
  id: "shipctl.thin-terminal",
  version: "0.0.0",
  requiredGrants: [
    TERMINAL_SESSION_GRANTS.attach,
    TERMINAL_SESSION_GRANTS.input,
    TERMINAL_SESSION_GRANTS.resize,
  ],
  terminalPresentations: [{
    moduleId: "shipctl.thin-terminal",
    driverId: THIN_TERMINAL_DRIVER_ID,
    requiredServices: [terminalSessionsService],
    Presentation: ThinTerminalProvider,
  }],
} as const satisfies ShipctlModule;

export { ThinTerminalProvider as ThinTerminalPresentation };
export { parseOscNotificationMessage } from "./oscNotification.ts";
