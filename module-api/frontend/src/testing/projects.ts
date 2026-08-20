import {
  projectsService,
  type ListProjectsInput,
  type ProjectCatalog,
  type ProjectCatalogChange,
  type ProjectCatalogScope,
  type ProjectsErrorCode,
  type ProjectsService,
} from "../protocol/projects";
import type { SemanticServiceError } from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import {
  createFakeRequestOperation,
  TestEventSource,
  type FakeRequestTrace,
} from "./semanticServices";

export interface FakeProjectsTrace {
  readonly operation: "list-projects";
  readonly request: FakeRequestTrace<ListProjectsInput>;
}

export interface FakeProjectsProviderOptions {
  readonly projectIds?: readonly string[];
  readonly unavailable?: boolean;
  readonly changes?: FakeProjectsChangeController;
  readonly trace?: FakeProjectsTrace[];
}

class FakeProjectsFailure extends Error {
  readonly code: ProjectsErrorCode;

  constructor(code: ProjectsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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

function normalizedProjectIds(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim() || seen.has(value)) {
      throw new FakeProjectsFailure(
        "projects.transport-failed",
        "Project catalog identities must be non-empty and unique",
      );
    }
    seen.add(value);
  }
  return Object.freeze([...values]);
}

function failedError(error: unknown): SemanticServiceError<ProjectsErrorCode> {
  if (error instanceof FakeProjectsFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "projects.transport-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/** Drives catalog and project filesystem changes for fake activation bindings. */
export class FakeProjectsChangeController {
  readonly #sources = new Set<TestEventSource<ProjectCatalogScope, ProjectCatalogChange>>();
  #projectIds: readonly string[];

  constructor(initialProjectIds: readonly string[] = []) {
    this.#projectIds = normalizedProjectIds(initialProjectIds);
  }

  current(): ProjectCatalog {
    return Object.freeze({ projectIds: this.#projectIds });
  }

  attach(
    context: SemanticServiceProviderContext,
    source: TestEventSource<ProjectCatalogScope, ProjectCatalogChange>,
  ): void {
    this.#sources.add(source);
    context.own(() => { this.#sources.delete(source); });
  }

  async setProjects(nextProjectIds: readonly string[]): Promise<void> {
    const next = normalizedProjectIds(nextProjectIds);
    const previous = new Set(this.#projectIds);
    this.#projectIds = next;
    for (const projectId of previous) {
      if (!next.includes(projectId)) await this.#publish({ kind: "project-removed", projectId });
    }
    await this.#publish({ kind: "catalog-changed", projectIds: next });
  }

  async publishFilesystemChanged(changedProjectIds: readonly string[]): Promise<void> {
    const known = new Set(this.#projectIds);
    const changed = normalizedProjectIds(changedProjectIds).filter((projectId) => known.has(projectId));
    if (changed.length > 0) {
      await this.#publish({ kind: "filesystem-changed", projectIds: changed });
    }
  }

  async #publish(change: ProjectCatalogChange): Promise<void> {
    await Promise.all([...this.#sources].map((source) => source.publish("catalog", change)));
  }
}

/** Tauri-free catalog provider for direct plugin lifecycle tests. */
export function createFakeProjectsServiceProvider(
  options: FakeProjectsProviderOptions = {},
): SemanticServiceProvider<ProjectsService> {
  const changes = options.changes ?? new FakeProjectsChangeController(options.projectIds);
  return {
    service: projectsService,
    bind(context) {
      const source = new TestEventSource<ProjectCatalogScope, ProjectCatalogChange>(
        context,
        "shipctl.projects.changed",
        (left, right) => left === right,
      );
      changes.attach(context, source);
      const trace: FakeRequestTrace<ListProjectsInput>[] = [];
      const request = createFakeRequestOperation({
        context,
        policy: POLICY,
        handle: () => {
          if (options.unavailable) {
            throw new FakeProjectsFailure("projects.unavailable", "Project catalog is unavailable");
          }
          return changes.current();
        },
        failedError,
        cancelledError: CANCELLED,
        disposedError: DISPOSED,
        trace,
      });
      const execute = request.execute.bind(request);
      return Object.freeze({
        listProjects: Object.freeze({
          policy: request.policy,
          async execute(input: ListProjectsInput, requestOptions?: Parameters<typeof execute>[1]) {
            const traceCount = trace.length;
            const outcome = await execute(input, requestOptions);
            const captured = trace[traceCount];
            if (captured) options.trace?.push({ operation: "list-projects", request: captured });
            return outcome;
          },
        }),
        observeProjects: source,
      });
    },
  };
}
