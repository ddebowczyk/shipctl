import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";

/** The host-owned catalog of registered project identities. */
export interface ProjectCatalog {
  readonly projectIds: readonly string[];
}

export type ProjectCatalogChange =
  | {
      readonly kind: "catalog-changed";
      readonly projectIds: readonly string[];
    }
  | {
      readonly kind: "filesystem-changed";
      readonly projectIds: readonly string[];
    }
  | {
      readonly kind: "project-removed";
      readonly projectId: string;
    };

export type ProjectCatalogScope = "catalog";
export type ListProjectsInput = Readonly<Record<never, never>>;

export type ProjectsErrorCode =
  | "projects.transport-failed"
  | "projects.unavailable"
  | "projects.cancelled"
  | "projects.activation-disposed";

/**
 * Semantic project catalog and lifecycle source. Project feature policy stays
 * in modules; this service only exposes host-known identities and changes.
 */
export interface ProjectsService {
  readonly listProjects: SemanticRequestOperation<
    ListProjectsInput,
    ProjectCatalog,
    ProjectsErrorCode
  >;
  readonly observeProjects: SemanticEventSource<ProjectCatalogScope, ProjectCatalogChange>;
}

export const projectsService = defineSemanticService<ProjectsService>("shipctl.projects", 1);
