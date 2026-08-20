import {
  WORKSPACE_CATALOG_SCHEMA_VERSION,
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  type UiWorkspaceDocument,
  type WorkspaceCatalogSnapshot,
} from "@shipctl/module-api";

import { parseWorkspaceCatalogSnapshot } from "./catalog.ts";
import { parseUiWorkspaceDocument } from "./document.ts";

// This semantic workspace is distinct from Layman's renderer-local state.
// They persist different contracts and must never share a durable record or
// revision stream.
export const CURRENT_CANVAS_WORKSPACE_ID = "shipctl.workspace";

export interface WorkspaceProfileInput {
  readonly workspaceId: string;
  readonly catalog: WorkspaceCatalogSnapshot;
}

export type WorkspaceProfileFactory = (input: WorkspaceProfileInput) => UiWorkspaceDocument;

/**
 * The host starts with no private workspace definitions. Every visible
 * semantic view arrives through an accepted runtime contribution.
 */
export function createDefaultWorkspaceCatalog(): WorkspaceCatalogSnapshot {
  return parseWorkspaceCatalogSnapshot({
    schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
    revision: 1,
    definitions: [],
  });
}

/**
 * A deterministic empty workspace profile. The mount-stable terminal stage is
 * the standard presentation when no contributed semantic view is selected.
 */
export function createDefaultWorkspaceProfile(
  input: WorkspaceProfileInput,
): UiWorkspaceDocument {
  return parseUiWorkspaceDocument({
    schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    instances: [],
    root: null,
    floating: [],
    maximizedStackId: null,
  });
}
