import type { ComponentType } from "react";

import type { ModuleHostServices } from "./services";

export type ModuleId = string;
export type ContributionId = `${string}.${string}`;

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly groupId?: string | null;
}

export interface PanelIconDescriptor {
  readonly name: string;
  readonly label?: string;
}

export interface PanelUnavailableMetadata {
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
}

export interface ModulePanelProps {
  readonly instanceId: string;
  readonly project: ProjectRef | null;
  readonly visible: boolean;
  readonly close: () => void;
  readonly setTitle: (title: string | null) => void;
  readonly services: ModuleHostServices;
}

export interface PanelContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly scope: "project" | "global";
  readonly label: string;
  readonly icon: PanelIconDescriptor;
  readonly shortcut?: string;
  /** Native host event that should open this panel when emitted. */
  readonly menuEvent?: string;
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

export interface PanelHostPort {
  open(
    panelId: ContributionId,
    options?: { readonly projectId?: string },
  ): string;
  reveal(instanceId: string): void;
  close(instanceId: string): void;
}
