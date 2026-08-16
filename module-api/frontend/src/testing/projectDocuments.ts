import {
  projectDocumentsService,
  type ProjectDocument,
  type ProjectDocumentRevision,
  type ProjectDocumentsErrorCode,
  type ProjectDocumentsService,
} from "../protocol/projectDocuments";
import type { SemanticServiceError } from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import { createFakeRequestOperation, type FakeRequestTrace } from "./semanticServices";

export type FakeProjectDocumentsOperation = "discover" | "read" | "write";

export interface FakeProjectDocumentSeed {
  readonly projectId: string;
  readonly relativePath: string;
  readonly contents: string;
}

export interface FakeProjectDocumentsTrace {
  readonly operation: FakeProjectDocumentsOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeProjectDocumentsProviderOptions {
  readonly documents?: readonly FakeProjectDocumentSeed[];
  readonly deniedOperations?: readonly FakeProjectDocumentsOperation[];
  readonly trace?: FakeProjectDocumentsTrace[];
}

class FakeProjectDocumentsFailure extends Error {
  readonly code: ProjectDocumentsErrorCode;

  constructor(code: ProjectDocumentsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "project-documents.cancelled",
  message: "Project document request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "project-documents.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(error: unknown): SemanticServiceError<ProjectDocumentsErrorCode> {
  if (error instanceof FakeProjectDocumentsFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "project-documents.transport-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeProjectDocumentsOperation,
  options: FakeProjectDocumentsProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => {
      if (options.deniedOperations?.includes(name)) {
        throw new FakeProjectDocumentsFailure(
          "project-documents.denied",
          `Fake project document operation denied: ${name}`,
        );
      }
      return handle(input);
    },
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    trace: traces,
  });
  const execute = request.execute.bind(request);
  return Object.freeze({
    policy: request.policy,
    async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
      const traceCount = traces.length;
      const outcome = await execute(input, requestOptions);
      const captured = traces[traceCount];
      if (captured) options.trace?.push({ operation: name, request: captured });
      return outcome;
    },
  });
}

function key(projectId: string, relativePath: string): string {
  return `${projectId}\0${relativePath}`;
}

function fileName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function requireProjectId(projectId: string): void {
  if (projectId.trim().length === 0) {
    throw new FakeProjectDocumentsFailure(
      "project-documents.invalid-project",
      "Project identity cannot be empty",
    );
  }
}

function requireRelativePath(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new FakeProjectDocumentsFailure(
      "project-documents.invalid-path",
      "Document path must be a normalized relative path",
    );
  }
}

function compareDiscoveryOrder(left: ProjectDocument, right: ProjectDocument): number {
  const depth = left.relativePath.split("/").length - right.relativePath.split("/").length;
  return depth || left.relativePath.localeCompare(right.relativePath);
}

/** Test-only in-memory provider with compare-and-write revision behavior. */
export function createFakeProjectDocumentsServiceProvider(
  options: FakeProjectDocumentsProviderOptions = {},
): SemanticServiceProvider<ProjectDocumentsService> {
  return {
    service: projectDocumentsService,
    bind(context) {
      let nextRevision = 1;
      const documents = new Map<string, ProjectDocument>();
      const newRevision = () => `fake-revision-${nextRevision++}` as ProjectDocumentRevision;
      for (const seed of options.documents ?? []) {
        documents.set(key(seed.projectId, seed.relativePath), Object.freeze({
          ...seed,
          revision: newRevision(),
        }));
      }
      const requireDocument = (projectId: string, relativePath: string) => {
        const current = documents.get(key(projectId, relativePath));
        if (!current) {
          throw new FakeProjectDocumentsFailure(
            "project-documents.not-found",
            `Project document does not exist: ${relativePath}`,
          );
        }
        return current;
      };
      return Object.freeze({
        discoverDocuments: operation(
          context,
          "discover",
          options,
          ({ projectId, fileNames }) => {
            requireProjectId(projectId);
            if (fileNames.length === 0) {
              throw new FakeProjectDocumentsFailure(
                "project-documents.invalid-path",
                "Discovery names must be non-empty file names",
              );
            }
            for (const name of fileNames) {
              requireRelativePath(name);
              if (name.includes("/")) {
                throw new FakeProjectDocumentsFailure(
                  "project-documents.invalid-path",
                  "Discovery entries must be file names",
                );
              }
            }
            const names = new Set(fileNames.map((name: string) => name.toLowerCase()));
            return [...documents.values()]
              .filter((candidate) => candidate.projectId === projectId
                && names.has(fileName(candidate.relativePath).toLowerCase()))
              .sort(compareDiscoveryOrder);
          },
        ),
        readDocument: operation(
          context,
          "read",
          options,
          ({ projectId, relativePath }) => {
            requireProjectId(projectId);
            requireRelativePath(relativePath);
            return requireDocument(projectId, relativePath);
          },
        ),
        writeDocument: operation(
          context,
          "write",
          options,
          ({ projectId, relativePath, expectedRevision, contents }) => {
            requireProjectId(projectId);
            requireRelativePath(relativePath);
            const documentKey = key(projectId, relativePath);
            const current = documents.get(documentKey);
            const conflict = expectedRevision === null ? current !== undefined : (
              current === undefined || current.revision !== expectedRevision
            );
            if (conflict) {
              throw new FakeProjectDocumentsFailure(
                "project-documents.conflict",
                "Project document revision does not match",
              );
            }
            const updated = Object.freeze({
              projectId,
              relativePath,
              contents,
              revision: newRevision(),
            });
            documents.set(documentKey, updated);
            return updated;
          },
        ),
      });
    },
  };
}
