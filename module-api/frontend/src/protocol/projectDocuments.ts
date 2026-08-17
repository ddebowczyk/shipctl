import { defineSemanticService } from "./semanticServices.ts";
import type { SemanticRequestOperation } from "./semanticServices";

declare const projectDocumentRevisionBrand: unique symbol;

/** Opaque revision of the exact document bytes returned by the service. */
export type ProjectDocumentRevision = string & {
  readonly [projectDocumentRevisionBrand]: true;
};

export interface ProjectDocument {
  readonly projectId: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly revision: ProjectDocumentRevision;
}

export interface DiscoverProjectDocumentsInput {
  readonly projectId: string;
  readonly fileNames: readonly string[];
}

export interface ReadProjectDocumentInput {
  readonly projectId: string;
  readonly relativePath: string;
}

export interface WriteProjectDocumentInput {
  readonly projectId: string;
  readonly relativePath: string;
  /** Null permits creation only. A revision permits replacement only. */
  readonly expectedRevision: ProjectDocumentRevision | null;
  readonly contents: string;
}

export type ProjectDocumentsErrorCode =
  | "project-documents.transport-failed"
  | "project-documents.denied"
  | "project-documents.invalid-project"
  | "project-documents.invalid-path"
  | "project-documents.not-found"
  | "project-documents.conflict"
  | "project-documents.too-large"
  | "project-documents.invalid-content"
  | "project-documents.invalid-request"
  | "project-documents.cancelled"
  | "project-documents.activation-disposed";

export interface ProjectDocumentsService {
  readonly discoverDocuments: SemanticRequestOperation<
    DiscoverProjectDocumentsInput,
    readonly ProjectDocument[],
    ProjectDocumentsErrorCode
  >;
  readonly readDocument: SemanticRequestOperation<
    ReadProjectDocumentInput,
    ProjectDocument,
    ProjectDocumentsErrorCode
  >;
  readonly writeDocument: SemanticRequestOperation<
    WriteProjectDocumentInput,
    ProjectDocument,
    ProjectDocumentsErrorCode
  >;
}

export const projectDocumentsService = defineSemanticService<ProjectDocumentsService>(
  "shipctl.project-documents",
  1,
);
