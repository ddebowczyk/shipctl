import { createElement, lazy } from "react";
import {
  terminalDriverId,
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
  terminalPresentations: [{
    driverId: THIN_TERMINAL_DRIVER_ID,
    Presentation: ThinTerminalProvider,
  }],
} as const satisfies ShipctlModule;

export { ThinTerminalProvider as ThinTerminalPresentation };
export { parseOscNotificationMessage } from "./oscNotification.ts";
