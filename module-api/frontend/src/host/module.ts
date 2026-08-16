import type { ModuleActivationContext } from "../protocol/semanticServices";
import type { PanelHostPort } from "./panels";
import type { ModuleHostServices } from "./services";

export interface ModuleHost {
  readonly activation: ModuleActivationContext;
  readonly panels: PanelHostPort;
  readonly services: ModuleHostServices;
}
