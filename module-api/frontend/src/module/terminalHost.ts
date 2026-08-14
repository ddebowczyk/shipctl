import type { ComponentType } from "react";

import type { TerminalDriverId } from "../protocol/terminalHost";
import type { TerminalPresentationProps } from "../host/terminalHost";

/** A build-installed module presentation for one selected driver. */
export interface TerminalPresentationProvider {
  readonly driverId: TerminalDriverId;
  readonly Presentation: ComponentType<TerminalPresentationProps>;
}
