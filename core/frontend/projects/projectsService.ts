import {
  projectsService,
  type ListProjectsInput,
  type ProjectCatalog,
  type ProjectCatalogChange,
  type ProjectCatalogScope,
  type ProjectsErrorCode,
  type ProjectsService,
  type SemanticCorrelationId,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticRequestOperation,
  type SemanticRequestOptions,
  type SemanticRequestOutcome,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
} from "@shipctl/module-api";
import { observeGitFilesystemChanges } from "@shipctl/core/platform";

import { useRepoStore } from "./useRepoStore.ts";

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "projects.cancelled",
  message: "Project catalog request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "projects.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

const CHANGES_SOURCE_ID = "shipctl.projects.changed";

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function catalog(): ProjectCatalog {
  return Object.freeze({
    projectIds: Object.freeze(useRepoStore.getState().repos.map(({ path }) => path)),
  });
}

function sameProjectIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((projectId, index) => projectId === right[index]);
}

function failure(error: unknown) {
  return {
    code: "projects.transport-failed" as const,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function listProjects(
  context: SemanticServiceProviderContext,
): SemanticRequestOperation<ListProjectsInput, ProjectCatalog, ProjectsErrorCode> {
  return Object.freeze({
    policy: POLICY,
    async execute(
      _input: ListProjectsInput,
      options?: SemanticRequestOptions,
    ): Promise<SemanticRequestOutcome<ProjectCatalog, ProjectsErrorCode>> {
      const requestCorrelationId = correlationId();
      if (!context.active) {
        return { correlationId: requestCorrelationId, result: { ok: false, error: DISPOSED } };
      }
      if (options?.cancellation?.cancelled) {
        return { correlationId: requestCorrelationId, result: { ok: false, error: CANCELLED } };
      }
      try {
        return { correlationId: requestCorrelationId, result: { ok: true, value: catalog() } };
      } catch (error) {
        return { correlationId: requestCorrelationId, result: { ok: false, error: failure(error) } };
      }
    },
  });
}

function projectChanges(context: SemanticServiceProviderContext) {
  let nextSequence = 0;
  return Object.freeze({
    async subscribe(
      scope: ProjectCatalogScope,
      listener: (event: SemanticEventRecord<ProjectCatalogChange>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED.message);
      if (scope !== "catalog") throw new Error("Project catalog scope is invalid");

      let active = true;
      let queue = Promise.resolve();
      const publish = (value: ProjectCatalogChange) => {
        if (!active || !context.active) return;
        nextSequence += 1;
        const event = { sourceId: CHANGES_SOURCE_ID, sequence: nextSequence, value };
        queue = queue.then(async () => {
          if (active && context.active) await listener(event);
        }).catch(() => undefined);
      };

      const unsubscribeStore = useRepoStore.subscribe((next, previous) => {
        const current = next.repos.map(({ path }) => path);
        const prior = previous.repos.map(({ path }) => path);
        if (sameProjectIds(current, prior)) return;
        const currentSet = new Set(current);
        for (const projectId of prior) {
          if (!currentSet.has(projectId)) publish({ kind: "project-removed", projectId });
        }
        publish({ kind: "catalog-changed", projectIds: current });
      });

      let unlisten: (() => void | Promise<void>) | null = null;
      try {
        unlisten = await observeGitFilesystemChanges((paths) => {
          const known = new Set(catalog().projectIds);
          const projectIds = [...new Set(paths.filter((path) => known.has(path)))];
          if (projectIds.length > 0) publish({ kind: "filesystem-changed", projectIds });
        });
      } catch (error) {
        unsubscribeStore();
        throw error;
      }

      if (!context.active) {
        active = false;
        unsubscribeStore();
        await unlisten();
        throw new Error(DISPOSED.message);
      }

      return context.own(async () => {
        active = false;
        unsubscribeStore();
        await unlisten?.();
        await queue;
      });
    },
  });
}

/** Trusted adapter from the host's registered projects to the public catalog. */
export function createProjectsServiceProvider(): SemanticServiceProvider<ProjectsService> {
  return {
    service: projectsService,
    bind(context) {
      return Object.freeze({
        listProjects: listProjects(context),
        observeProjects: projectChanges(context),
      });
    },
  };
}
