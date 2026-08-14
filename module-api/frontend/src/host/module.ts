import type { ModuleMessages } from "../protocol/messages";
import type { PanelHostPort } from "./panels";
import type { ModuleHostServices } from "./services";

export interface ModuleHost {
  readonly panels: PanelHostPort;
  readonly services: ModuleHostServices;
  /** Present for activations whose artifact declares message contributions. */
  readonly messages?: ModuleMessages;
}
