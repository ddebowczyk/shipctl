import type { ComponentType } from "react";

import type {
  ContributionId,
  ModuleId,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectRef,
} from "../protocol/panels";
import type {
  ProjectFacts,
  ProjectLayoutSlot,
  SettingsSlot,
} from "../protocol/surfaces";
import type { ModuleHostServices } from "../host/services";
import type {
  GlobalSurfaceContributionProps,
  ProjectActionSurfaceProps,
  ProjectLayoutContributionProps,
  ProjectNavigationContributionProps,
  SettingsContributionProps,
  SidebarContributionProps,
} from "../host/surfaces";

export interface GlobalSurfaceContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly unavailable?: PanelUnavailableMetadata;
  readonly load: () => Promise<{
    readonly default: ComponentType<GlobalSurfaceContributionProps>;
  }>;
}

export interface GlobalNavigationContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly surfaceId: ContributionId;
  readonly label: string;
  readonly icon: PanelIconDescriptor;
  readonly order?: number;
}

export interface SidebarContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly surfaceId: ContributionId;
  readonly order?: number;
  readonly load: () => Promise<{
    readonly default: ComponentType<SidebarContributionProps>;
  }>;
}

export interface ProjectNavigationContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly panelId: ContributionId;
  readonly order?: number;
  readonly load: () => Promise<{
    readonly default: ComponentType<ProjectNavigationContributionProps>;
  }>;
}

export interface ProjectFactsProviderContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  getFacts(
    project: ProjectRef,
    services: ModuleHostServices,
  ): ProjectFacts | null;
  subscribe?(
    listener: () => void,
    services: ModuleHostServices,
  ): () => void;
  refresh?(
    project: ProjectRef,
    services: ModuleHostServices,
  ): void | Promise<void>;
}

export interface ProjectLayoutContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly slot: ProjectLayoutSlot;
  readonly order?: number;
  readonly load: () => Promise<{
    readonly default: ComponentType<ProjectLayoutContributionProps>;
  }>;
}

interface ProjectActionBase {
  readonly id: ContributionId;
  readonly label: string;
  readonly icon?: PanelIconDescriptor;
  readonly selected?: boolean;
  readonly keepOpen?: boolean;
  readonly danger?: boolean;
}

export interface ProjectCommandAction extends ProjectActionBase {
  readonly surface?: never;
  run(): void | Promise<void>;
}

export interface ProjectSurfaceAction extends ProjectActionBase {
  readonly surface: {
    readonly load: () => Promise<{
      readonly default: ComponentType<ProjectActionSurfaceProps>;
    }>;
  };
  readonly run?: never;
}

export type ProjectAction = ProjectCommandAction | ProjectSurfaceAction;

export interface ProjectActionGroup {
  /** Null places actions directly in the host menu instead of a submenu. */
  readonly label: string | null;
  readonly icon?: PanelIconDescriptor;
  readonly actions: readonly ProjectAction[];
}

export interface ProjectActionContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly order?: number;
  subscribe?(
    listener: () => void,
    services: ModuleHostServices,
  ): () => void;
  refresh?(
    project: ProjectRef,
    services: ModuleHostServices,
  ): void | Promise<void>;
  getGroup(
    project: ProjectRef,
    services: ModuleHostServices,
  ): ProjectActionGroup | null;
}

export interface SettingsContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly slot?: SettingsSlot;
  readonly order?: number;
  readonly load: () => Promise<{
    readonly default: ComponentType<SettingsContributionProps>;
  }>;
}

export interface ModuleProjectLifecycle {
  onProjectOpened?(
    projectPath: string,
    services: ModuleHostServices,
  ): void | Promise<void>;
  onProjectsChanged?(
    projectPaths: readonly string[],
    services: ModuleHostServices,
  ): void | Promise<void>;
  onFilesystemChanged?(
    projectPaths: readonly string[],
    services: ModuleHostServices,
  ): void | Promise<void>;
  onProjectRemoved?(
    projectPath: string,
    services: ModuleHostServices,
  ): void | Promise<void>;
}

export interface ProjectImportContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  relatedPaths(
    projectPath: string,
    options: { readonly expandRelated: boolean },
    services: ModuleHostServices,
  ): readonly string[] | Promise<readonly string[]>;
}
