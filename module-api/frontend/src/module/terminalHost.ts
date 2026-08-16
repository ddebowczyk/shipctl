import type { ComponentType } from "react";

import type { ModuleId } from "../protocol/panels";
import type { TerminalDriverId } from "../protocol/terminalHost";
import type { SemanticServiceReference } from "../protocol/semanticServices";
import type { TerminalPresentationProps } from "../host/terminalHost";

/** A build-installed module presentation for one selected driver. */
export interface TerminalPresentationProvider {
  readonly moduleId: ModuleId;
  readonly driverId: TerminalDriverId;
  /** Public services which must be bound before the presentation can mount. */
  readonly requiredServices?: readonly SemanticServiceReference<unknown>[];
  readonly Presentation: ComponentType<TerminalPresentationProps>;
}
