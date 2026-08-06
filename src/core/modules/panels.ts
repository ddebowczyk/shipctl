import type { ComponentType } from "react";

export type ModuleId = string;
export type ContributionId = `${string}.${string}`;

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
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
}

export interface PanelContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly scope: "project" | "global";
  readonly label: string;
  readonly icon: PanelIconDescriptor;
  readonly shortcut?: string;
  readonly singleton: "per-project" | "global" | false;
  readonly order?: number;
  readonly requiredCapabilities?: readonly ContributionId[];
  readonly unavailable?: PanelUnavailableMetadata;
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
