import type { ComponentType } from "react";

import type {
  ContributionId,
  ModuleId,
  PanelIconDescriptor,
  PanelUnavailableMetadata,
  ProjectRef,
} from "./panels";
import type { ModuleHostServices } from "./services";

export interface GlobalSurfaceContributionProps {
  readonly close: () => void;
  readonly services: ModuleHostServices;
}

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

export interface ProjectNavigationContributionProps {
  readonly project: ProjectRef;
  readonly active: boolean;
  readonly open: () => void;
  readonly services: ModuleHostServices;
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

export interface ProjectFacts {
  readonly revision?: {
    readonly label: string;
    readonly state: "clean" | "changed";
  };
  readonly lineage?: {
    readonly parentLabel: string;
  };
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

export type ProjectLayoutSlot = "workspace.trailing";

export interface ProjectLayoutContributionProps {
  readonly project: ProjectRef;
  readonly services: ModuleHostServices;
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

export interface ProjectActionSurfaceHost {
  addProject(projectPath: string): Promise<void>;
  moveProjectToGroup(
    projectPath: string,
    groupId: string | null,
  ): Promise<void>;
}

export interface ProjectActionSurfacePosition {
  readonly x: number;
  readonly y: number;
}

export interface ProjectActionSurfaceProps {
  readonly project: ProjectRef;
  readonly position: ProjectActionSurfacePosition;
  readonly close: () => void;
  readonly host: ProjectActionSurfaceHost;
  readonly services: ModuleHostServices;
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

export interface SettingsContributionProps {
  readonly projectPaths: readonly string[];
  readonly services: ModuleHostServices;
}

export interface SettingsContribution {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly order?: number;
  readonly load: () => Promise<{
    readonly default: ComponentType<SettingsContributionProps>;
  }>;
}

export interface ModuleProjectLifecycle {
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
