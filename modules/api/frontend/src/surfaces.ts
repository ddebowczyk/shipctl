import type { ComponentType } from "react";

import type { ContributionId, ModuleId, ProjectRef } from "./panels";
import type { ModuleHostServices } from "./services";

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
