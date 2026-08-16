import type { ProjectRef } from "../protocol/panels";
import type { ModuleActivationContext } from "../protocol/semanticServices";
import type { ModuleHostServices } from "./services";

export interface ModulePanelProps {
  readonly instanceId: string;
  readonly project: ProjectRef | null;
  readonly visible: boolean;
  readonly close: () => void;
  readonly setTitle: (title: string | null) => void;
  readonly activation: ModuleActivationContext;
  readonly services: ModuleHostServices;
}

export interface PanelHostPort {
  open(
    panelId: import("../protocol/panels").ContributionId,
    options?: { readonly projectId?: string },
  ): string;
  reveal(instanceId: string): void;
  close(instanceId: string): void;
}
