import {
  WORKSPACE_CATALOG_SCHEMA_VERSION,
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  type UiWorkspaceDocument,
  type WorkspaceCatalogSnapshot,
} from "@shipctl/module-api";

import { parseWorkspaceCatalogSnapshot } from "./catalog.ts";
import { parseUiWorkspaceDocument } from "./document.ts";

export const CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID = "shipctl.legacy-canvas";
export const CURRENT_CANVAS_WORKSPACE_ID = "shipctl.canvas";
export const CURRENT_CANVAS_WORKSPACE_PROFILE_ID = "shipctl.compatibility.v1";

export interface WorkspaceProfileInput {
  readonly workspaceId: string;
  readonly catalog: WorkspaceCatalogSnapshot;
}

export type WorkspaceProfileFactory = (input: WorkspaceProfileInput) => UiWorkspaceDocument;

/**
 * The first semantic catalog expresses the existing one-pane canvas as data.
 * It does not import LegacyCanvas, Layman, React, or an enabled-module list.
 */
export function createCurrentCanvasWorkspaceCatalog(): WorkspaceCatalogSnapshot {
  return parseWorkspaceCatalogSnapshot({
    schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
    revision: 1,
    definitions: [{
      viewTypeId: CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
      ownerModuleId: "shipctl.host",
      ownerActivationId: "shipctl.host@1#compatibility",
      label: "Shipctl",
      scope: "global",
      cardinality: "singleton",
      closeBehavior: "forbid",
      requiredCapabilityIds: [],
      placement: { defaultRegion: "primary", allowSplit: false },
      state: { kind: "none" },
      presentation: {
        loaderId: "shipctl.canvas.compatibility",
        exportName: "default",
      },
      migrationAliases: [],
    }],
  });
}

/**
 * A deterministic profile of today's canvas. If the compatibility definition
 * is not accepted, it returns an empty but valid host workspace instead of
 * trying to load the absent implementation.
 */
export function createCurrentCanvasWorkspaceProfile(
  input: WorkspaceProfileInput,
): UiWorkspaceDocument {
  const definition = input.catalog.definitions.find(
    (item) => item.viewTypeId === CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
  );
  if (!definition) {
    return parseUiWorkspaceDocument({
      schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      profileId: CURRENT_CANVAS_WORKSPACE_PROFILE_ID,
      instances: [],
      root: null,
      floating: [],
      maximizedStackId: null,
    });
  }
  const instanceId = "shipctl.canvas.compatibility";
  return parseUiWorkspaceDocument({
    schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    profileId: CURRENT_CANVAS_WORKSPACE_PROFILE_ID,
    instances: [{
      instanceId,
      viewTypeId: definition.viewTypeId,
      ownerModuleId: definition.ownerModuleId,
      ownerActivationId: definition.ownerActivationId,
      resource: { kind: "global" },
      label: definition.label,
      stateRef: null,
      availability: { kind: "available" },
      lifecycle: "placed",
    }],
    root: {
      kind: "stack",
      stackId: "shipctl.canvas.primary",
      instanceIds: [instanceId],
      selectedInstanceId: instanceId,
    },
    floating: [],
    maximizedStackId: null,
  });
}
