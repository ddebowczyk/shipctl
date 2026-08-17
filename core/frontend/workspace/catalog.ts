import {
  WORKSPACE_CATALOG_SCHEMA_VERSION,
  type ModuleActivationId,
  type WorkspaceCatalogSnapshot,
  type WorkspaceCloseBehavior,
  type WorkspaceViewCardinality,
  type WorkspaceViewDefinition,
  type WorkspaceViewScope,
  type WorkspaceViewStatePolicy,
} from "@shipctl/module-api";

import {
  cloneAndFreeze,
  hasIdentity,
  hasOnlyKeys,
  hasSafePositiveInteger,
  hasWorkspaceName,
  isPlainRecord,
  sortedUnique,
} from "./internal.ts";

/** Stable admission failure. Its diagnostic never includes a renderer payload. */
export class WorkspaceCatalogParseError extends Error {
  readonly code = "workspace.invalid-catalog";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCatalogParseError";
  }
}

function invalid(message: string): never {
  throw new WorkspaceCatalogParseError(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, keys)) {
    invalid(`${label} has unsupported fields.`);
  }
  return value;
}

function stringList(value: unknown, label: string, validate: (value: unknown) => value is string): readonly string[] {
  if (!Array.isArray(value) || !value.every(validate)) invalid(`${label} is invalid.`);
  const unique = sortedUnique(value);
  if (!unique) invalid(`${label} contains duplicate values.`);
  return unique;
}

function scope(value: unknown): WorkspaceViewScope {
  if (
    value !== "global"
    && value !== "project"
    && value !== "terminal"
    && value !== "panel"
    && value !== "assistant-session"
  ) invalid("Workspace view scope is invalid.");
  return value;
}

function cardinality(value: unknown): WorkspaceViewCardinality {
  if (value !== "singleton" && value !== "one-per-resource" && value !== "multiple") {
    invalid("Workspace view cardinality is invalid.");
  }
  return value;
}

function closeBehavior(value: unknown): WorkspaceCloseBehavior {
  if (value !== "hide" && value !== "dispose" && value !== "forbid") {
    invalid("Workspace view close behavior is invalid.");
  }
  return value;
}

function statePolicy(value: unknown): WorkspaceViewStatePolicy {
  const candidate = record(value, "Workspace view state", ["kind", "schemaVersion"]);
  if (candidate.kind === "none") {
    if (Object.keys(candidate).length !== 1) invalid("Workspace view state is invalid.");
    return Object.freeze({ kind: "none" });
  }
  if (candidate.kind === "json" && hasSafePositiveInteger(candidate.schemaVersion)) {
    return Object.freeze({ kind: "json", schemaVersion: candidate.schemaVersion });
  }
  return invalid("Workspace view state is invalid.");
}

function definition(value: unknown): WorkspaceViewDefinition {
  const candidate = record(value, "Workspace view definition", [
    "viewTypeId",
    "ownerModuleId",
    "ownerActivationId",
    "label",
    "scope",
    "cardinality",
    "closeBehavior",
    "requiredCapabilityIds",
    "placement",
    "state",
    "presentation",
    "migrationAliases",
  ]);
  if (
    !hasWorkspaceName(candidate.viewTypeId)
    || !hasWorkspaceName(candidate.ownerModuleId)
    || !hasIdentity(candidate.ownerActivationId)
    || !hasIdentity(candidate.label)
  ) invalid("Workspace view identity is invalid.");

  const placement = record(candidate.placement, "Workspace view placement", [
    "defaultRegion",
    "allowSplit",
  ]);
  if (
    (placement.defaultRegion !== "primary" && placement.defaultRegion !== "secondary")
    || typeof placement.allowSplit !== "boolean"
  ) invalid("Workspace view placement is invalid.");

  const presentation = record(candidate.presentation, "Workspace view presentation", [
    "loaderId",
    "exportName",
  ]);
  if (!hasIdentity(presentation.loaderId) || !hasIdentity(presentation.exportName)) {
    invalid("Workspace view presentation is invalid.");
  }

  return cloneAndFreeze({
    viewTypeId: candidate.viewTypeId,
    ownerModuleId: candidate.ownerModuleId,
    ownerActivationId: candidate.ownerActivationId as ModuleActivationId,
    label: candidate.label,
    scope: scope(candidate.scope),
    cardinality: cardinality(candidate.cardinality),
    closeBehavior: closeBehavior(candidate.closeBehavior),
    requiredCapabilityIds: stringList(
      candidate.requiredCapabilityIds,
      "Workspace required capability IDs",
      hasWorkspaceName,
    ),
    placement: {
      defaultRegion: placement.defaultRegion,
      allowSplit: placement.allowSplit,
    },
    state: statePolicy(candidate.state),
    presentation: {
      loaderId: presentation.loaderId,
      exportName: presentation.exportName,
    },
    migrationAliases: stringList(
      candidate.migrationAliases,
      "Workspace migration aliases",
      hasWorkspaceName,
    ),
  });
}

/**
 * Admits data-only view definitions from the already accepted runtime catalog.
 * The closed field set is intentional: `load`, React components, Layman nodes,
 * and every other renderer implementation detail fail before workspace state
 * is touched.
 */
export function parseWorkspaceCatalogSnapshot(value: unknown): WorkspaceCatalogSnapshot {
  const candidate = record(value, "Workspace catalog", [
    "schemaVersion",
    "revision",
    "definitions",
  ]);
  if (candidate.schemaVersion !== WORKSPACE_CATALOG_SCHEMA_VERSION) {
    invalid("Workspace catalog schema version is unsupported.");
  }
  if (!hasSafePositiveInteger(candidate.revision) || !Array.isArray(candidate.definitions)) {
    invalid("Workspace catalog revision or definitions are invalid.");
  }

  const definitions = candidate.definitions.map(definition)
    .sort((left, right) => left.viewTypeId.localeCompare(right.viewTypeId));
  const ids = new Set<string>();
  for (const item of definitions) {
    for (const id of [item.viewTypeId, ...item.migrationAliases]) {
      if (ids.has(id)) invalid(`Workspace view identity ${id} is declared more than once.`);
      ids.add(id);
    }
  }

  return cloneAndFreeze({
    schemaVersion: WORKSPACE_CATALOG_SCHEMA_VERSION,
    revision: candidate.revision,
    definitions,
  });
}

export function findWorkspaceViewDefinition(
  catalog: WorkspaceCatalogSnapshot,
  viewTypeId: string,
): WorkspaceViewDefinition | undefined {
  return catalog.definitions.find((definition) =>
    definition.viewTypeId === viewTypeId || definition.migrationAliases.includes(viewTypeId));
}
