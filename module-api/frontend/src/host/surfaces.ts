import type { ProjectRef } from "../protocol/panels";
import type { ProjectActionSurfacePosition } from "../protocol/surfaces";
import type { ModuleHostServices } from "./services";

export interface GlobalSurfaceContributionProps {
  readonly close: () => void;
  readonly services: ModuleHostServices;
}

export interface SidebarContributionProps {
  readonly open: () => void;
  readonly services: ModuleHostServices;
}

export interface ProjectNavigationContributionProps {
  readonly project: ProjectRef;
  readonly active: boolean;
  readonly open: () => void;
  readonly services: ModuleHostServices;
}

export interface ProjectLayoutContributionProps {
  readonly project: ProjectRef;
  readonly services: ModuleHostServices;
}

export interface ProjectActionSurfaceHost {
  addProject(projectPath: string): Promise<void>;
  moveProjectToGroup(
    projectPath: string,
    groupId: string | null,
  ): Promise<void>;
}

export interface ProjectActionSurfaceProps {
  readonly project: ProjectRef;
  readonly position: ProjectActionSurfacePosition;
  readonly close: () => void;
  readonly host: ProjectActionSurfaceHost;
  readonly services: ModuleHostServices;
}

export interface SettingsContributionProps {
  readonly projectPaths: readonly string[];
  readonly services: ModuleHostServices;
}
