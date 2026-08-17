import {
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
  type ModuleActivationId,
  type UiWorkspaceDocument,
  type WorkspaceFloatingStack,
  type WorkspaceNode,
  type WorkspacePersistedRecord,
  type WorkspaceResourceReference,
  type WorkspaceRevision,
  type WorkspaceStackNode,
  type WorkspaceViewAvailability,
  type WorkspaceViewInstance,
} from "@shipctl/module-api";

import {
  canonicalEqual,
  cloneAndFreeze,
  hasFiniteNumber,
  hasIdentity,
  hasOnlyKeys,
  hasSafeNonNegativeInteger,
  hasSafePositiveInteger,
  hasWorkspaceName,
  isPlainRecord,
  jsonSafe,
} from "./internal.ts";

export class WorkspaceDocumentParseError extends Error {
  readonly code = "workspace.invalid-document";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDocumentParseError";
  }
}

function invalid(message: string): never {
  throw new WorkspaceDocumentParseError(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, keys)) invalid(`${label} has unsupported fields.`);
  return value;
}

function identity(value: unknown, label: string): string {
  if (!hasIdentity(value)) invalid(`${label} is invalid.`);
  return value;
}

function resource(value: unknown): WorkspaceResourceReference {
  const candidate = record(value, "Workspace resource", [
    "kind",
    "projectId",
    "terminalId",
    "panelId",
    "panelInstanceId",
    "sessionId",
    "sourceKind",
    "stableId",
  ]);
  switch (candidate.kind) {
    case "global":
      if (Object.keys(candidate).length !== 1) invalid("Global workspace resource is invalid.");
      return Object.freeze({ kind: "global" });
    case "project":
      if (Object.keys(candidate).length !== 2) invalid("Project workspace resource is invalid.");
      return Object.freeze({ kind: "project", projectId: identity(candidate.projectId, "Project ID") });
    case "terminal":
      if (Object.keys(candidate).length !== 3) invalid("Terminal workspace resource is invalid.");
      return Object.freeze({
        kind: "terminal",
        terminalId: identity(candidate.terminalId, "Terminal ID"),
        projectId: identity(candidate.projectId, "Project ID"),
      });
    case "panel":
      if (Object.keys(candidate).length !== 4 || (candidate.projectId !== null && !hasIdentity(candidate.projectId))) {
        invalid("Panel workspace resource is invalid.");
      }
      return Object.freeze({
        kind: "panel",
        panelId: identity(candidate.panelId, "Panel ID"),
        panelInstanceId: identity(candidate.panelInstanceId, "Panel instance ID"),
        projectId: candidate.projectId,
      });
    case "assistant-session":
      if (Object.keys(candidate).length !== 3 || (candidate.projectId !== null && !hasIdentity(candidate.projectId))) {
        invalid("Assistant session workspace resource is invalid.");
      }
      return Object.freeze({
        kind: "assistant-session",
        sessionId: identity(candidate.sessionId, "Assistant session ID"),
        projectId: candidate.projectId,
      });
    case "unavailable":
      if (
        Object.keys(candidate).length !== 3
        || (candidate.sourceKind !== "project"
          && candidate.sourceKind !== "terminal"
          && candidate.sourceKind !== "panel"
          && candidate.sourceKind !== "assistant-session")
      ) invalid("Unavailable workspace resource is invalid.");
      return Object.freeze({
        kind: "unavailable",
        sourceKind: candidate.sourceKind,
        stableId: identity(candidate.stableId, "Unavailable resource ID"),
      });
    default:
      return invalid("Workspace resource kind is invalid.");
  }
}

function availability(value: unknown): WorkspaceViewAvailability {
  const candidate = record(value, "Workspace availability", [
    "kind",
    "lastKnownViewTypeId",
    "catalogRevision",
  ]);
  if (candidate.kind === "available" && Object.keys(candidate).length === 1) {
    return Object.freeze({ kind: "available" });
  }
  if (
    candidate.kind === "missing-definition"
    && Object.keys(candidate).length === 3
    && hasWorkspaceName(candidate.lastKnownViewTypeId)
    && hasSafePositiveInteger(candidate.catalogRevision)
  ) {
    return Object.freeze({
      kind: "missing-definition",
      lastKnownViewTypeId: candidate.lastKnownViewTypeId,
      catalogRevision: candidate.catalogRevision,
    });
  }
  return invalid("Workspace availability is invalid.");
}

function instance(value: unknown): WorkspaceViewInstance {
  const candidate = record(value, "Workspace instance", [
    "instanceId",
    "viewTypeId",
    "ownerModuleId",
    "ownerActivationId",
    "resource",
    "label",
    "stateRef",
    "availability",
    "lifecycle",
  ]);
  if (
    !hasIdentity(candidate.instanceId)
    || !hasWorkspaceName(candidate.viewTypeId)
    || !hasWorkspaceName(candidate.ownerModuleId)
    || !hasIdentity(candidate.ownerActivationId)
    || (candidate.label !== null && !hasIdentity(candidate.label))
    || (candidate.lifecycle !== "placed" && candidate.lifecycle !== "hidden")
    || !jsonSafe(candidate.stateRef)
  ) invalid("Workspace instance is invalid.");
  return cloneAndFreeze({
    instanceId: candidate.instanceId,
    viewTypeId: candidate.viewTypeId,
    ownerModuleId: candidate.ownerModuleId,
    ownerActivationId: candidate.ownerActivationId as ModuleActivationId,
    resource: resource(candidate.resource),
    label: candidate.label,
    stateRef: candidate.stateRef,
    availability: availability(candidate.availability),
    lifecycle: candidate.lifecycle,
  });
}

interface NodeParseState {
  readonly stackIds: Set<string>;
  readonly nodeIds: Set<string>;
}

function stack(value: unknown, state: NodeParseState): WorkspaceStackNode {
  const candidate = record(value, "Workspace stack", [
    "kind",
    "stackId",
    "instanceIds",
    "selectedInstanceId",
  ]);
  if (
    candidate.kind !== "stack"
    || !hasIdentity(candidate.stackId)
    || !Array.isArray(candidate.instanceIds)
    || candidate.instanceIds.length === 0
    || !candidate.instanceIds.every(hasIdentity)
    || !hasIdentity(candidate.selectedInstanceId)
  ) invalid("Workspace stack is invalid.");
  if (state.stackIds.has(candidate.stackId) || state.nodeIds.has(candidate.stackId)) {
    invalid(`Workspace node identity ${candidate.stackId} is duplicated.`);
  }
  const instanceIds = [...candidate.instanceIds];
  if (new Set(instanceIds).size !== instanceIds.length || !instanceIds.includes(candidate.selectedInstanceId)) {
    invalid("Workspace stack selection is invalid.");
  }
  state.stackIds.add(candidate.stackId);
  state.nodeIds.add(candidate.stackId);
  return cloneAndFreeze({
    kind: "stack" as const,
    stackId: candidate.stackId,
    instanceIds,
    selectedInstanceId: candidate.selectedInstanceId,
  });
}

function node(value: unknown, state: NodeParseState): WorkspaceNode {
  if (!isPlainRecord(value) || typeof value.kind !== "string") invalid("Workspace node is invalid.");
  if (value.kind === "stack") return stack(value, state);
  const candidate = record(value, "Workspace split", [
    "kind",
    "nodeId",
    "axis",
    "firstShare",
    "first",
    "second",
  ]);
  if (
    candidate.kind !== "split"
    || !hasIdentity(candidate.nodeId)
    || (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
    || !hasFiniteNumber(candidate.firstShare)
    || candidate.firstShare <= 0
    || candidate.firstShare >= 1
  ) invalid("Workspace split is invalid.");
  if (state.nodeIds.has(candidate.nodeId)) invalid(`Workspace node identity ${candidate.nodeId} is duplicated.`);
  state.nodeIds.add(candidate.nodeId);
  return cloneAndFreeze({
    kind: "split" as const,
    nodeId: candidate.nodeId,
    axis: candidate.axis,
    firstShare: candidate.firstShare,
    first: node(candidate.first, state),
    second: node(candidate.second, state),
  });
}

function floating(value: unknown, state: NodeParseState): WorkspaceFloatingStack {
  const candidate = record(value, "Workspace floating stack", [
    "floatingId",
    "stack",
    "x",
    "y",
    "width",
    "height",
  ]);
  if (
    !hasIdentity(candidate.floatingId)
    || !hasFiniteNumber(candidate.x)
    || !hasFiniteNumber(candidate.y)
    || !hasFiniteNumber(candidate.width)
    || !hasFiniteNumber(candidate.height)
    || candidate.width <= 0
    || candidate.height <= 0
  ) invalid("Workspace floating stack is invalid.");
  return cloneAndFreeze({
    floatingId: candidate.floatingId,
    stack: stack(candidate.stack, state),
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  });
}

function placedIds(documentRoot: WorkspaceNode | null, floatingStacks: readonly WorkspaceFloatingStack[]): Set<string> {
  const values = new Set<string>();
  const visit = (candidate: WorkspaceNode) => {
    if (candidate.kind === "stack") {
      for (const instanceId of candidate.instanceIds) {
        if (values.has(instanceId)) invalid(`Workspace instance ${instanceId} has multiple placements.`);
        values.add(instanceId);
      }
      return;
    }
    visit(candidate.first);
    visit(candidate.second);
  };
  if (documentRoot) visit(documentRoot);
  for (const item of floatingStacks) visit(item.stack);
  return values;
}

/** Parses, normalizes, clones, and freezes a semantic document. */
export function parseUiWorkspaceDocument(value: unknown): UiWorkspaceDocument {
  const candidate = record(value, "Workspace document", [
    "schemaVersion",
    "workspaceId",
    "profileId",
    "instances",
    "root",
    "floating",
    "maximizedStackId",
  ]);
  if (
    candidate.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION
    || !hasIdentity(candidate.workspaceId)
    || !hasIdentity(candidate.profileId)
    || !Array.isArray(candidate.instances)
    || !Array.isArray(candidate.floating)
    || (candidate.root !== null && !isPlainRecord(candidate.root))
    || (candidate.maximizedStackId !== null && !hasIdentity(candidate.maximizedStackId))
  ) invalid("Workspace document is invalid.");

  const instances = candidate.instances.map(instance)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (new Set(instances.map((item) => item.instanceId)).size !== instances.length) {
    invalid("Workspace instance identities are duplicated.");
  }

  const state: NodeParseState = { stackIds: new Set<string>(), nodeIds: new Set<string>() };
  const root = candidate.root === null ? null : node(candidate.root, state);
  const floatingStacks = candidate.floating.map((item) => floating(item, state));
  if (new Set(floatingStacks.map((item) => item.floatingId)).size !== floatingStacks.length) {
    invalid("Workspace floating identities are duplicated.");
  }
  if (candidate.maximizedStackId !== null && !state.stackIds.has(candidate.maximizedStackId)) {
    invalid("Workspace maximized stack is missing.");
  }

  const placed = placedIds(root, floatingStacks);
  const identities = new Set(instances.map((item) => item.instanceId));
  for (const instanceId of placed) {
    if (!identities.has(instanceId)) invalid(`Workspace placement ${instanceId} is missing its instance.`);
  }
  for (const item of instances) {
    if ((item.lifecycle === "placed") !== placed.has(item.instanceId)) {
      invalid(`Workspace instance ${item.instanceId} has invalid lifecycle placement.`);
    }
  }

  return cloneAndFreeze({
    schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
    workspaceId: candidate.workspaceId,
    profileId: candidate.profileId,
    instances,
    root,
    floating: floatingStacks,
    maximizedStackId: candidate.maximizedStackId,
  });
}

/** Parses the durable envelope and keeps its storage schema distinct from the document schema. */
export function parseWorkspacePersistedRecord(value: unknown): WorkspacePersistedRecord {
  const candidate = record(value, "Workspace persisted record", [
    "storageSchemaVersion",
    "workspaceId",
    "revision",
    "originId",
    "catalogRevision",
    "document",
  ]);
  if (
    candidate.storageSchemaVersion !== WORKSPACE_PERSISTENCE_SCHEMA_VERSION
    || !hasIdentity(candidate.workspaceId)
    || !hasSafePositiveInteger(candidate.revision)
    || !hasIdentity(candidate.originId)
    || !hasSafeNonNegativeInteger(candidate.catalogRevision)
  ) invalid("Workspace persisted record is invalid.");
  const document = parseUiWorkspaceDocument(candidate.document);
  if (document.workspaceId !== candidate.workspaceId) invalid("Workspace record and document identities differ.");
  return cloneAndFreeze({
    storageSchemaVersion: WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
    workspaceId: candidate.workspaceId,
    revision: candidate.revision as WorkspaceRevision,
    originId: candidate.originId,
    catalogRevision: candidate.catalogRevision,
    document,
  });
}

export function workspaceDocumentEqual(left: UiWorkspaceDocument, right: UiWorkspaceDocument): boolean {
  return canonicalEqual(left, right);
}

export function workspaceResourceEqual(
  left: WorkspaceResourceReference,
  right: WorkspaceResourceReference,
): boolean {
  return canonicalEqual(left, right);
}

export function workspaceStacks(document: UiWorkspaceDocument): readonly WorkspaceStackNode[] {
  const stacks: WorkspaceStackNode[] = [];
  const visit = (node: WorkspaceNode) => {
    if (node.kind === "stack") {
      stacks.push(node);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  if (document.root) visit(document.root);
  for (const item of document.floating) stacks.push(item.stack);
  return Object.freeze(stacks);
}

export function workspaceStack(
  document: UiWorkspaceDocument,
  stackId: string,
): WorkspaceStackNode | undefined {
  return workspaceStacks(document).find((stack) => stack.stackId === stackId);
}

export function asWorkspaceRevision(value: unknown): WorkspaceRevision {
  if (!hasSafeNonNegativeInteger(value)) invalid("Workspace revision is invalid.");
  return value as WorkspaceRevision;
}
