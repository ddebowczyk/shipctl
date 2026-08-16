import { invoke } from "@tauri-apps/api/core";
import {
  projectDocumentsService,
  type DiscoverProjectDocumentsInput,
  type ProjectDocument,
  type ProjectDocumentRevision,
  type ProjectDocumentsErrorCode,
  type ProjectDocumentsService,
  type ReadProjectDocumentInput,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type WriteProjectDocumentInput,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const DISCOVER_DOCUMENTS_COMMAND = "plugin:shipctl-todos|discover_project_documents";
const READ_DOCUMENT_COMMAND = "plugin:shipctl-todos|read_project_document";
const WRITE_DOCUMENT_COMMAND = "plugin:shipctl-todos|write_project_document";

interface RawProjectDocument {
  readonly projectId: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly revision: string;
}

interface NativeProjectDocumentsError {
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface LegacyProjectDocumentsTransport {
  discover(
    request: PrivateSemanticRequestEnvelope<DiscoverProjectDocumentsInput>,
  ): Promise<readonly RawProjectDocument[]>;
  read(
    request: PrivateSemanticRequestEnvelope<ReadProjectDocumentInput>,
  ): Promise<RawProjectDocument>;
  write(
    request: PrivateSemanticRequestEnvelope<WriteProjectDocumentInput>,
  ): Promise<RawProjectDocument>;
}

export interface ProjectDocumentsServiceProviderOptions {
  readonly transport?: LegacyProjectDocumentsTransport;
}

const TAURI_TRANSPORT: LegacyProjectDocumentsTransport = {
  discover: ({ input }) => invoke(DISCOVER_DOCUMENTS_COMMAND, { request: input }),
  read: ({ input }) => invoke(READ_DOCUMENT_COMMAND, { request: input }),
  write: ({ input }) => invoke(WRITE_DOCUMENT_COMMAND, { request: input }),
};

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

const ERROR_CODES = new Set<ProjectDocumentsErrorCode>([
  "project-documents.transport-failed",
  "project-documents.denied",
  "project-documents.invalid-project",
  "project-documents.invalid-path",
  "project-documents.not-found",
  "project-documents.conflict",
  "project-documents.too-large",
  "project-documents.invalid-content",
  "project-documents.cancelled",
  "project-documents.activation-disposed",
]);

function transportError(error: unknown): SemanticServiceError<ProjectDocumentsErrorCode> {
  const native = error && typeof error === "object" ? error as NativeProjectDocumentsError : null;
  const code = typeof native?.code === "string" && ERROR_CODES.has(native.code as ProjectDocumentsErrorCode)
    ? native.code as ProjectDocumentsErrorCode
    : "project-documents.transport-failed";
  const message = typeof native?.message === "string"
    ? native.message
    : error instanceof Error ? error.message : String(error);
  return { code, message, retryable: false };
}

function invalidPath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\")) {
    return true;
  }
  return relativePath.split("/").some((part) => part === "" || part === "." || part === "..");
}

function invalidInput(
  input: { readonly projectId: string; readonly relativePath?: string },
): SemanticServiceError<ProjectDocumentsErrorCode> | null {
  if (input.projectId.trim().length === 0) {
    return {
      code: "project-documents.invalid-project",
      message: "Project identity cannot be empty",
      retryable: false,
    };
  }
  if (input.relativePath !== undefined && invalidPath(input.relativePath)) {
    return {
      code: "project-documents.invalid-path",
      message: "Document path must be a normalized relative path",
      retryable: false,
    };
  }
  return null;
}

function document(raw: RawProjectDocument): ProjectDocument {
  return Object.freeze({
    projectId: raw.projectId,
    relativePath: raw.relativePath,
    contents: raw.contents,
    revision: raw.revision as ProjectDocumentRevision,
  });
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, ProjectDocumentsErrorCode>,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: POLICY,
    transport,
    transportError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
  });
}

export function createProjectDocumentsServiceProvider(
  options: ProjectDocumentsServiceProviderOptions = {},
): SemanticServiceProvider<ProjectDocumentsService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  return {
    service: projectDocumentsService,
    bind(context) {
      return Object.freeze({
        discoverDocuments: request<
          DiscoverProjectDocumentsInput,
          readonly ProjectDocument[]
        >(context, {
          async request(envelope) {
            const invalid = invalidInput(envelope.input);
            const invalidName = envelope.input.fileNames.some(
              (name) => invalidPath(name) || name.includes("/"),
            );
            if (invalid || invalidName || envelope.input.fileNames.length === 0) {
              return {
                ok: false,
                error: invalid ?? {
                  code: "project-documents.invalid-path",
                  message: "Discovery names must be non-empty file names",
                  retryable: false,
                },
              };
            }
            const raw = await transport.discover(envelope);
            return { ok: true, value: raw.map(document) };
          },
        }),
        readDocument: request<ReadProjectDocumentInput, ProjectDocument>(context, {
          async request(envelope) {
            const invalid = invalidInput(envelope.input);
            if (invalid) return { ok: false, error: invalid };
            return { ok: true, value: document(await transport.read(envelope)) };
          },
        }),
        writeDocument: request<WriteProjectDocumentInput, ProjectDocument>(context, {
          async request(envelope) {
            const invalid = invalidInput(envelope.input);
            if (invalid) return { ok: false, error: invalid };
            return { ok: true, value: document(await transport.write(envelope)) };
          },
        }),
      });
    },
  };
}
