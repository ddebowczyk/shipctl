import type { ComponentType } from "react";

import type {
  ContributionId,
  ModuleId,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
} from "../protocol/panels";
import type { ModulePanelProps } from "../host/panels";

export interface PanelContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly scope: "project" | "global";
  readonly label: string;
  readonly icon: PanelIconDescriptor;
  readonly shortcut?: string;
  readonly singleton: "per-project" | "global" | false;
  readonly order?: number;
  /** Places this project panel in the generic new-session menu. */
  readonly newSession?: {
    readonly label?: string;
    readonly order?: number;
  };
  readonly requiredCapabilities?: readonly ContributionId[];
  readonly unavailable?: PanelUnavailableMetadata;
  /** Module-owned migration metadata for tabs persisted before generic panels. */
  readonly migrationAlias?: {
    readonly kind: string;
    readonly label?: string;
  };
  readonly load: () => Promise<{
    readonly default: ComponentType<ModulePanelProps>;
  }>;
}
