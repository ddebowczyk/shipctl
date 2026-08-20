import {
  WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
  type ModuleJsonValue,
  type UiWorkspaceDocument,
  type WorkspaceCatalogSnapshot,
  type WorkspaceCloseBehavior,
  type WorkspaceCommand,
  type WorkspaceCommandStep,
  type WorkspaceFloatingStack,
  type WorkspaceInspection,
  type WorkspaceMutationResult,
  type WorkspaceNode,
  type WorkspaceObservation,
  type WorkspacePlan,
  type WorkspacePersistedRecord,
  type WorkspacePlacementIntent,
  type WorkspaceResourceReference,
  type WorkspaceRevision,
  type WorkspaceStackNode,
  type WorkspaceValidation,
  type WorkspaceViewDefinition,
  type WorkspaceViewInstance,
} from "@shipctl/module-api";

import {
  findWorkspaceViewDefinition,
  parseWorkspaceCatalogSnapshot,
} from "./catalog.ts";
import {
  asWorkspaceRevision,
  parseUiWorkspaceDocument,
  parseWorkspacePersistedRecord,
  workspaceDocumentEqual,
  workspaceResourceEqual,
  workspaceStack,
  workspaceStacks,
} from "./document.ts";
import {
  hasIdentity,
  hasFiniteNumber,
  hasOnlyKeys,
  hasSafeNonNegativeInteger,
  hasWorkspaceName,
  isPlainRecord,
} from "./internal.ts";
import type { WorkspacePersistencePort } from "./persistence.ts";
import {
  createDefaultWorkspaceProfile,
  type WorkspaceProfileFactory,
} from "./profiles.ts";

export class WorkspaceAuthorityError extends Error {
  readonly code:
    | "workspace.conflict"
    | "workspace.forbidden"
    | "workspace.invalid-catalog"
    | "workspace.invalid-document"
    | "workspace.invalid-request"
    | "workspace.not-found"
    | "workspace.persistence-failed";
  readonly details: ModuleJsonValue | undefined;

  constructor(
    code: WorkspaceAuthorityError["code"],
    message: string,
    details?: ModuleJsonValue,
  ) {
    super(message);
    this.name = "WorkspaceAuthorityError";
    this.code = code;
    this.details = details;
  }
}

interface WorkspaceState {
  readonly revision: WorkspaceRevision;
  readonly originId: string;
  readonly catalogRevision: number;
  readonly document: UiWorkspaceDocument;
}

interface WorkspaceReduction {
  readonly document: UiWorkspaceDocument;
  readonly affectedInstanceIds: readonly string[];
  readonly affectedStackIds: readonly string[];
  readonly warnings: readonly string[];
}

interface WorkspaceEvaluation {
  readonly command: WorkspaceCommand;
  readonly document: UiWorkspaceDocument;
  readonly mutation: WorkspaceMutationResult;
}

export interface WorkspaceAuthorityOptions {
  readonly workspaceId: string;
  /** A snapshot already accepted by the runtime lifecycle transaction. */
  readonly catalog: WorkspaceCatalogSnapshot;
  readonly persistence: WorkspacePersistencePort;
  readonly defaultProfile?: WorkspaceProfileFactory;
  /**
   * Preserve a restored document until the host submits its first accepted
   * runtime catalog. This is only for application bootstrap, where the
   * workspace service must exist before dynamic module activation completes.
   */
  readonly deferCatalogReconciliationUntilFirstAcceptedSnapshot?: boolean;
}

export interface ReconcileWorkspaceCatalogInput {
  readonly catalog: WorkspaceCatalogSnapshot;
  readonly expectedRevision: WorkspaceRevision;
  readonly originId: string;
}

type Listener = (event: WorkspaceObservation) => void | Promise<void>;

function invalidRequest(message: string): never {
  throw new WorkspaceAuthorityError("workspace.invalid-request", message);
}

function notFound(message: string): never {
  throw new WorkspaceAuthorityError("workspace.not-found", message);
}

function assertIdentity(value: unknown, label: string): string {
  if (!hasIdentity(value)) invalidRequest(`${label} is invalid.`);
  return value;
}

function assertRevision(value: unknown): WorkspaceRevision {
  try {
    return asWorkspaceRevision(value);
  } catch {
    return invalidRequest("Workspace expected revision is invalid.");
  }
}

function exact(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, keys)) invalidRequest(`${label} is invalid.`);
  return value;
}

function exactCommand(
  value: Record<string, unknown>,
  kind: string,
  fields: readonly string[],
): void {
  if (!hasOnlyKeys(value, ["kind", "expectedRevision", "originId", ...fields])) {
    invalidRequest(`${kind} workspace command has unsupported fields.`);
  }
}

function exactStep(
  value: Record<string, unknown>,
  kind: string,
  fields: readonly string[],
): void {
  if (!hasOnlyKeys(value, ["kind", ...fields])) {
    invalidRequest(`${kind} workspace command has unsupported fields.`);
  }
}

function parseResource(value: unknown): WorkspaceResourceReference {
  const candidate = exact(value, "Workspace resource", [
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
      if (Object.keys(candidate).length !== 1) invalidRequest("Global workspace resource is invalid.");
      return Object.freeze({ kind: "global" });
    case "project":
      if (Object.keys(candidate).length !== 2) invalidRequest("Project workspace resource is invalid.");
      return Object.freeze({ kind: "project", projectId: assertIdentity(candidate.projectId, "Project ID") });
    case "terminal":
      if (Object.keys(candidate).length !== 3) invalidRequest("Terminal workspace resource is invalid.");
      return Object.freeze({
        kind: "terminal",
        terminalId: assertIdentity(candidate.terminalId, "Terminal ID"),
        projectId: assertIdentity(candidate.projectId, "Project ID"),
      });
    case "panel":
      if (Object.keys(candidate).length !== 4 || (candidate.projectId !== null && !hasIdentity(candidate.projectId))) {
        invalidRequest("Panel workspace resource is invalid.");
      }
      return Object.freeze({
        kind: "panel",
        panelId: assertIdentity(candidate.panelId, "Panel ID"),
        panelInstanceId: assertIdentity(candidate.panelInstanceId, "Panel instance ID"),
        projectId: candidate.projectId as string | null,
      });
    case "assistant-session":
      if (Object.keys(candidate).length !== 3 || (candidate.projectId !== null && !hasIdentity(candidate.projectId))) {
        invalidRequest("Assistant session workspace resource is invalid.");
      }
      return Object.freeze({
        kind: "assistant-session",
        sessionId: assertIdentity(candidate.sessionId, "Assistant session ID"),
        projectId: candidate.projectId as string | null,
      });
    case "unavailable":
      if (
        Object.keys(candidate).length !== 3
        || (candidate.sourceKind !== "project"
          && candidate.sourceKind !== "terminal"
          && candidate.sourceKind !== "panel"
          && candidate.sourceKind !== "assistant-session")
      ) invalidRequest("Unavailable workspace resource is invalid.");
      return Object.freeze({
        kind: "unavailable",
        sourceKind: candidate.sourceKind,
        stableId: assertIdentity(candidate.stableId, "Unavailable resource ID"),
      });
    default:
      return invalidRequest("Workspace resource kind is invalid.");
  }
}

function parsePlacement(value: unknown): WorkspacePlacementIntent {
  const candidate = exact(value, "Workspace placement", ["kind", "stackId"]);
  if (candidate.kind === "default" && Object.keys(candidate).length === 1) {
    return Object.freeze({ kind: "default" });
  }
  if (candidate.kind === "stack" && Object.keys(candidate).length === 2) {
    return Object.freeze({ kind: "stack", stackId: assertIdentity(candidate.stackId, "Workspace stack ID") });
  }
  return invalidRequest("Workspace placement is invalid.");
}

/** Runtime validation for one reducer step that can arrive through an agent transport. */
export function parseWorkspaceCommandStep(value: unknown): WorkspaceCommandStep {
  const candidate = exact(value, "Workspace command", [
    "kind",
    "instanceId",
    "viewTypeId",
    "resource",
    "placement",
    "label",
    "targetStackId",
    "position",
    "relativeInstanceId",
    "splitId",
    "newStackId",
    "axis",
    "firstShare",
    "floatingId",
    "stackId",
    "x",
    "y",
    "width",
    "height",
  ]);
  switch (candidate.kind) {
    case "open":
      exactStep(candidate, "Open", ["instanceId", "viewTypeId", "resource", "placement", "label"]);
      if (
        !hasIdentity(candidate.instanceId)
        || !hasWorkspaceName(candidate.viewTypeId)
        || (candidate.label !== null && !hasIdentity(candidate.label))
      ) invalidRequest("Open workspace command is invalid.");
      return Object.freeze({
        kind: "open" as const,
        instanceId: candidate.instanceId,
        viewTypeId: candidate.viewTypeId,
        resource: parseResource(candidate.resource),
        placement: parsePlacement(candidate.placement),
        label: candidate.label,
      });
    case "close":
    case "select":
      exactStep(candidate, candidate.kind === "close" ? "Close" : "Select", ["instanceId"]);
      if (!hasIdentity(candidate.instanceId)) invalidRequest(`${candidate.kind} workspace command is invalid.`);
      return Object.freeze({ kind: candidate.kind, instanceId: candidate.instanceId });
    case "focus":
      exactStep(candidate, "Focus", ["instanceId", "placement"]);
      if (!hasIdentity(candidate.instanceId)) invalidRequest("Focus workspace command is invalid.");
      return Object.freeze({
        kind: "focus" as const,
        instanceId: candidate.instanceId,
        placement: parsePlacement(candidate.placement),
      });
    case "move":
      exactStep(candidate, "Move", ["instanceId", "targetStackId", "position", "relativeInstanceId"]);
      if (
        !hasIdentity(candidate.instanceId)
        || !hasIdentity(candidate.targetStackId)
        || (candidate.position !== "start"
          && candidate.position !== "end"
          && candidate.position !== "before"
          && candidate.position !== "after")
        || (candidate.relativeInstanceId !== null && !hasIdentity(candidate.relativeInstanceId))
      ) invalidRequest("Move workspace command is invalid.");
      return Object.freeze({
        kind: "move" as const,
        instanceId: candidate.instanceId,
        targetStackId: candidate.targetStackId,
        position: candidate.position,
        relativeInstanceId: candidate.relativeInstanceId,
      });
    case "split":
      exactStep(candidate, "Split", ["instanceId", "targetStackId", "splitId", "newStackId", "axis", "position"]);
      const splitId = candidate.splitId === undefined
        ? undefined
        : assertIdentity(candidate.splitId, "Workspace split ID");
      const newStackId = candidate.newStackId === undefined
        ? undefined
        : assertIdentity(candidate.newStackId, "Workspace stack ID");
      if (
        !hasIdentity(candidate.instanceId)
        || !hasIdentity(candidate.targetStackId)
        || (splitId === undefined) !== (newStackId === undefined)
        || (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
        || (candidate.position !== "before" && candidate.position !== "after")
      ) invalidRequest("Split workspace command is invalid.");
      return Object.freeze({
        kind: "split" as const,
        instanceId: candidate.instanceId,
        targetStackId: candidate.targetStackId,
        ...(splitId === undefined ? {} : { splitId, newStackId: newStackId! }),
        axis: candidate.axis,
        position: candidate.position,
      });
    case "rename":
      exactStep(candidate, "Rename", ["instanceId", "label"]);
      if (!hasIdentity(candidate.instanceId) || (candidate.label !== null && !hasIdentity(candidate.label))) {
        invalidRequest("Rename workspace command is invalid.");
      }
      return Object.freeze({ kind: "rename" as const, instanceId: candidate.instanceId, label: candidate.label });
    case "resize-split":
      exactStep(candidate, "Resize split", ["splitId", "firstShare"]);
      if (
        !hasIdentity(candidate.splitId)
        || !hasFiniteNumber(candidate.firstShare)
        || candidate.firstShare <= 0
        || candidate.firstShare >= 1
      ) invalidRequest("Resize split workspace command is invalid.");
      return Object.freeze({
        kind: "resize-split" as const,
        splitId: candidate.splitId,
        firstShare: candidate.firstShare,
      });
    case "float":
      exactStep(candidate, "Float", ["instanceId", "floatingId", "stackId", "x", "y", "width", "height"]);
      if (
        !hasIdentity(candidate.instanceId)
        || !hasIdentity(candidate.floatingId)
        || !hasIdentity(candidate.stackId)
        || !hasFiniteNumber(candidate.x)
        || !hasFiniteNumber(candidate.y)
        || !hasFiniteNumber(candidate.width)
        || !hasFiniteNumber(candidate.height)
        || candidate.width <= 0
        || candidate.height <= 0
      ) invalidRequest("Float workspace command is invalid.");
      return Object.freeze({
        kind: "float" as const,
        instanceId: candidate.instanceId,
        floatingId: candidate.floatingId,
        stackId: candidate.stackId,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      });
    case "update-floating":
      exactStep(candidate, "Update floating", ["floatingId", "x", "y", "width", "height"]);
      if (
        !hasIdentity(candidate.floatingId)
        || !hasFiniteNumber(candidate.x)
        || !hasFiniteNumber(candidate.y)
        || !hasFiniteNumber(candidate.width)
        || !hasFiniteNumber(candidate.height)
        || candidate.width <= 0
        || candidate.height <= 0
      ) invalidRequest("Update floating workspace command is invalid.");
      return Object.freeze({
        kind: "update-floating" as const,
        floatingId: candidate.floatingId,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      });
    case "dock":
      exactStep(candidate, "Dock", ["floatingId", "targetStackId"]);
      if (!hasIdentity(candidate.floatingId) || (candidate.targetStackId !== null && !hasIdentity(candidate.targetStackId))) {
        invalidRequest("Dock workspace command is invalid.");
      }
      return Object.freeze({
        kind: "dock" as const,
        floatingId: candidate.floatingId,
        targetStackId: candidate.targetStackId as string | null,
      });
    case "maximize":
      exactStep(candidate, "Maximize", ["stackId"]);
      if (!hasIdentity(candidate.stackId)) invalidRequest("Maximize workspace command is invalid.");
      return Object.freeze({ kind: "maximize" as const, stackId: candidate.stackId });
    case "restore":
      exactStep(candidate, "Restore", []);
      return Object.freeze({ kind: "restore" as const });
    case "reset":
      exactStep(candidate, "Reset", []);
      return Object.freeze({ kind: "reset" as const });
    default:
      return invalidRequest("Workspace command kind is invalid.");
  }
}

/** Runtime validation for a revisioned command that can arrive through an agent transport. */
export function parseWorkspaceCommand(value: unknown): WorkspaceCommand {
  const candidate = exact(value, "Workspace command", [
    "kind",
    "expectedRevision",
    "originId",
    "commands",
    "instanceId",
    "viewTypeId",
    "resource",
    "placement",
    "label",
    "targetStackId",
    "position",
    "relativeInstanceId",
    "splitId",
    "newStackId",
    "axis",
    "firstShare",
    "floatingId",
    "stackId",
    "x",
    "y",
    "width",
    "height",
  ]);
  const expectedRevision = assertRevision(candidate.expectedRevision);
  const originId = assertIdentity(candidate.originId, "Workspace origin ID");
  if (candidate.kind === "apply") {
    exactCommand(candidate, "Apply", ["commands"]);
    if (!Array.isArray(candidate.commands)) invalidRequest("Apply workspace command is invalid.");
    return Object.freeze({
      kind: "apply" as const,
      expectedRevision,
      originId,
      commands: Object.freeze(candidate.commands.map(parseWorkspaceCommandStep)),
    });
  }
  const { expectedRevision: _expectedRevision, originId: _originId, ...step } = candidate;
  return Object.freeze({
    ...parseWorkspaceCommandStep(step),
    expectedRevision,
    originId,
  }) as WorkspaceCommand;
}

function scopeMatches(
  definition: WorkspaceViewDefinition,
  resource: WorkspaceResourceReference,
): boolean {
  if (resource.kind === "unavailable") return definition.scope === resource.sourceKind;
  return definition.scope === resource.kind;
}

function stackWith(
  stack: WorkspaceStackNode,
  instanceIds: readonly string[],
  selectedInstanceId: string,
): WorkspaceStackNode | null {
  if (instanceIds.length === 0) return null;
  return {
    kind: "stack",
    stackId: stack.stackId,
    instanceIds,
    selectedInstanceId,
  };
}

function removeInstanceFromNode(node: WorkspaceNode, instanceId: string): WorkspaceNode | null {
  if (node.kind === "stack") {
    if (!node.instanceIds.includes(instanceId)) return node;
    const ids = node.instanceIds.filter((id) => id !== instanceId);
    return stackWith(node, ids, node.selectedInstanceId === instanceId ? ids[0] ?? "" : node.selectedInstanceId);
  }
  const first = removeInstanceFromNode(node.first, instanceId);
  const second = removeInstanceFromNode(node.second, instanceId);
  if (first === null) return second;
  if (second === null) return first;
  if (first === node.first && second === node.second) return node;
  return {
    kind: "split",
    nodeId: node.nodeId,
    axis: node.axis,
    firstShare: node.firstShare,
    first,
    second,
  };
}

function removeInstance(document: UiWorkspaceDocument, instanceId: string): UiWorkspaceDocument {
  const root = document.root === null ? null : removeInstanceFromNode(document.root, instanceId);
  const floating: WorkspaceFloatingStack[] = [];
  for (const item of document.floating) {
    const next = removeInstanceFromNode(item.stack, instanceId);
    if (next === null) continue;
    if (next.kind !== "stack") {
      throw new Error("A floating workspace placement cannot become a split.");
    }
    floating.push({ ...item, stack: next });
  }
  const next = { ...document, root, floating };
  return next.maximizedStackId !== null && !workspaceStack(next, next.maximizedStackId)
    ? { ...next, maximizedStackId: null }
    : next;
}

function updateStackInNode(
  node: WorkspaceNode,
  stackId: string,
  update: (stack: WorkspaceStackNode) => WorkspaceNode,
): WorkspaceNode {
  if (node.kind === "stack") return node.stackId === stackId ? update(node) : node;
  const first = updateStackInNode(node.first, stackId, update);
  const second = updateStackInNode(node.second, stackId, update);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function updateStack(
  document: UiWorkspaceDocument,
  stackId: string,
  update: (stack: WorkspaceStackNode) => WorkspaceNode,
): UiWorkspaceDocument {
  const root = document.root === null ? null : updateStackInNode(document.root, stackId, update);
  const floating = document.floating.map((item) => (
    item.stack.stackId === stackId
      ? (() => {
          const next = update(item.stack);
          if (next.kind !== "stack") invalidRequest("A floating stack cannot become a split.");
          return { ...item, stack: next };
        })()
      : item
  ));
  return { ...document, root, floating };
}

function firstStack(document: UiWorkspaceDocument): WorkspaceStackNode | undefined {
  return workspaceStacks(document)[0];
}

function appendToStack(
  document: UiWorkspaceDocument,
  stackId: string,
  instanceId: string,
): UiWorkspaceDocument {
  if (!workspaceStack(document, stackId)) notFound(`Workspace stack ${stackId} does not exist.`);
  return updateStack(document, stackId, (stack) => ({
    ...stack,
    instanceIds: [...stack.instanceIds, instanceId],
    selectedInstanceId: instanceId,
  }));
}

function placeInIntent(
  document: UiWorkspaceDocument,
  instanceId: string,
  intent: WorkspacePlacementIntent,
): UiWorkspaceDocument {
  if (intent.kind === "stack") return appendToStack(document, intent.stackId, instanceId);
  const target = firstStack(document);
  if (target) return appendToStack(document, target.stackId, instanceId);
  return {
    ...document,
    root: {
      kind: "stack",
      stackId: `workspace.stack.${instanceId}`,
      instanceIds: [instanceId],
      selectedInstanceId: instanceId,
    },
  };
}

function selectInstance(document: UiWorkspaceDocument, instanceId: string): UiWorkspaceDocument {
  const target = workspaceStacks(document).find((stack) => stack.instanceIds.includes(instanceId));
  if (!target) notFound(`Workspace instance ${instanceId} is not placed.`);
  return updateStack(document, target.stackId, (stack) => ({ ...stack, selectedInstanceId: instanceId }));
}

function insertAt(
  ids: readonly string[],
  instanceId: string,
  position: "start" | "end" | "before" | "after",
  relativeInstanceId: string | null,
): readonly string[] {
  const without = ids.filter((id) => id !== instanceId);
  if (position === "start") return [instanceId, ...without];
  if (position === "end") return [...without, instanceId];
  if (relativeInstanceId === null) invalidRequest("Workspace move requires a relative instance.");
  const index = without.indexOf(relativeInstanceId);
  if (index < 0) notFound(`Workspace relative instance ${relativeInstanceId} is missing.`);
  const at = position === "before" ? index : index + 1;
  return [...without.slice(0, at), instanceId, ...without.slice(at)];
}

function moveInstance(
  document: UiWorkspaceDocument,
  instanceId: string,
  targetStackId: string,
  position: "start" | "end" | "before" | "after",
  relativeInstanceId: string | null,
): UiWorkspaceDocument {
  const target = workspaceStack(document, targetStackId);
  if (!target) notFound(`Workspace stack ${targetStackId} does not exist.`);
  const source = workspaceStacks(document).find((stack) => stack.instanceIds.includes(instanceId));
  if (!source) notFound(`Workspace instance ${instanceId} is not placed.`);
  if (source.stackId === target.stackId) {
    return updateStack(document, target.stackId, (stack) => ({
      ...stack,
      instanceIds: insertAt(stack.instanceIds, instanceId, position, relativeInstanceId),
      selectedInstanceId: instanceId,
    }));
  }
  const removed = removeInstance(document, instanceId);
  return updateStack(removed, targetStackId, (stack) => ({
    ...stack,
    instanceIds: insertAt(stack.instanceIds, instanceId, position, relativeInstanceId),
    selectedInstanceId: instanceId,
  }));
}

function workspaceNodeIds(document: UiWorkspaceDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: WorkspaceNode): void => {
    if (node.kind === "stack") {
      ids.add(node.stackId);
      return;
    }
    ids.add(node.nodeId);
    visit(node.first);
    visit(node.second);
  };
  if (document.root !== null) visit(document.root);
  for (const floating of document.floating) visit(floating.stack);
  return ids;
}

/**
 * Allocate semantic document identities without consulting a renderer. The
 * sequence is derived only from the current document, so restart and retry
 * cannot import transient canvas identifiers into persisted workspace state.
 */
function allocateWorkspaceSplitIdentity(
  document: UiWorkspaceDocument,
): Readonly<{ splitId: string; newStackId: string }> {
  const used = workspaceNodeIds(document);
  for (let suffix = 1; ; suffix += 1) {
    const splitId = `shipctl.workspace.split.${suffix}`;
    const newStackId = `shipctl.workspace.stack.${suffix}`;
    if (!used.has(splitId) && !used.has(newStackId)) {
      return Object.freeze({ splitId, newStackId });
    }
  }
}

function splitStack(
  document: UiWorkspaceDocument,
  instanceId: string,
  targetStackId: string,
  splitId: string,
  newStackId: string,
  axis: "horizontal" | "vertical",
  position: "before" | "after",
): UiWorkspaceDocument {
  const target = workspaceStack(document, targetStackId);
  if (!target) notFound(`Workspace stack ${targetStackId} does not exist.`);
  const existingIds = workspaceNodeIds(document);
  if (splitId === newStackId || existingIds.has(splitId) || existingIds.has(newStackId)) {
    invalidRequest("Workspace split identity already exists.");
  }
  const source = workspaceStacks(document).find((stack) => stack.instanceIds.includes(instanceId));
  if (!source) notFound(`Workspace instance ${instanceId} is not placed.`);
  if (source.stackId === targetStackId && source.instanceIds.length === 1) {
    invalidRequest("A one-instance stack cannot be split without another view.");
  }
  const removed = removeInstance(document, instanceId);
  if (!workspaceStack(removed, targetStackId)) {
    invalidRequest("Workspace split removed its target stack.");
  }
  const created: WorkspaceStackNode = {
    kind: "stack",
    stackId: newStackId,
    instanceIds: [instanceId],
    selectedInstanceId: instanceId,
  };
  return updateStack(removed, targetStackId, (remaining) => ({
    kind: "split",
    nodeId: splitId,
    axis,
    firstShare: 0.5,
    first: position === "before" ? created : remaining,
    second: position === "before" ? remaining : created,
  }));
}

function updateSplitInNode(
  node: WorkspaceNode,
  splitId: string,
  firstShare: number,
): { readonly node: WorkspaceNode; readonly updated: boolean } {
  if (node.kind === "stack") return { node, updated: false };
  if (node.nodeId === splitId) {
    return {
      node: { ...node, firstShare },
      updated: true,
    };
  }
  const first = updateSplitInNode(node.first, splitId, firstShare);
  const second = updateSplitInNode(node.second, splitId, firstShare);
  if (!first.updated && !second.updated) return { node, updated: false };
  return {
    node: { ...node, first: first.node, second: second.node },
    updated: true,
  };
}

function resizeSplit(
  document: UiWorkspaceDocument,
  splitId: string,
  firstShare: number,
): UiWorkspaceDocument {
  if (document.root === null) notFound(`Workspace split ${splitId} does not exist.`);
  const updated = updateSplitInNode(document.root, splitId, firstShare);
  if (!updated.updated) notFound(`Workspace split ${splitId} does not exist.`);
  return { ...document, root: updated.node };
}

function floatInstance(
  document: UiWorkspaceDocument,
  input: Extract<WorkspaceCommandStep, { readonly kind: "float" }>,
): UiWorkspaceDocument {
  const source = workspaceStacks(document).find((stack) => stack.instanceIds.includes(input.instanceId));
  if (!source) notFound(`Workspace instance ${input.instanceId} is not placed.`);
  if (workspaceNodeIds(document).has(input.stackId)) {
    invalidRequest(`Workspace stack ${input.stackId} already exists.`);
  }
  if (document.floating.some((item) => item.floatingId === input.floatingId)) {
    invalidRequest(`Workspace floating stack ${input.floatingId} already exists.`);
  }
  const removed = removeInstance(document, input.instanceId);
  return {
    ...removed,
    floating: [
      ...removed.floating,
      {
        floatingId: input.floatingId,
        stack: {
          kind: "stack",
          stackId: input.stackId,
          instanceIds: [input.instanceId],
          selectedInstanceId: input.instanceId,
        },
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      },
    ],
  };
}

function updateFloating(
  document: UiWorkspaceDocument,
  input: Extract<WorkspaceCommandStep, { readonly kind: "update-floating" }>,
): UiWorkspaceDocument {
  const floating = document.floating.find((item) => item.floatingId === input.floatingId);
  if (!floating) notFound(`Workspace floating stack ${input.floatingId} does not exist.`);
  return {
    ...document,
    floating: document.floating.map((item) => item.floatingId === input.floatingId
      ? { ...item, x: input.x, y: input.y, width: input.width, height: input.height }
      : item),
  };
}

function dockFloating(
  document: UiWorkspaceDocument,
  input: Extract<WorkspaceCommandStep, { readonly kind: "dock" }>,
): UiWorkspaceDocument {
  const floating = document.floating.find((item) => item.floatingId === input.floatingId);
  if (!floating) notFound(`Workspace floating stack ${input.floatingId} does not exist.`);
  const withoutFloating = {
    ...document,
    floating: document.floating.filter((item) => item.floatingId !== input.floatingId),
  };
  if (input.targetStackId === null) {
    if (withoutFloating.root !== null) {
      invalidRequest("Workspace floating stack can only become an empty tiled root.");
    }
    return {
      ...withoutFloating,
      root: floating.stack,
    };
  }
  if (input.targetStackId === floating.stack.stackId) {
    invalidRequest("Workspace floating stack cannot dock into itself.");
  }
  if (!workspaceStack(withoutFloating, input.targetStackId)) {
    notFound(`Workspace stack ${input.targetStackId} does not exist.`);
  }
  const maximizedStackId = document.maximizedStackId === floating.stack.stackId
    ? input.targetStackId
    : document.maximizedStackId;
  return updateStack(
    { ...withoutFloating, maximizedStackId },
    input.targetStackId,
    (stack) => ({
      ...stack,
      instanceIds: [...stack.instanceIds, ...floating.stack.instanceIds],
      selectedInstanceId: floating.stack.selectedInstanceId,
    }),
  );
}

function instanceDefinition(
  catalog: WorkspaceCatalogSnapshot,
  instance: WorkspaceViewInstance,
): WorkspaceViewDefinition | undefined {
  return findWorkspaceViewDefinition(catalog, instance.viewTypeId);
}

function closeBehavior(
  catalog: WorkspaceCatalogSnapshot,
  instance: WorkspaceViewInstance,
): WorkspaceCloseBehavior {
  return instanceDefinition(catalog, instance)?.closeBehavior ?? "hide";
}

function reconcileDocument(
  document: UiWorkspaceDocument,
  catalog: WorkspaceCatalogSnapshot,
): { readonly document: UiWorkspaceDocument; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const instances = document.instances.map((item) => {
    const definition = findWorkspaceViewDefinition(catalog, item.viewTypeId);
    if (!definition) {
      warnings.push(`workspace.missing-definition:${item.viewTypeId}`);
      return {
        ...item,
        availability: {
          kind: "missing-definition" as const,
          lastKnownViewTypeId: item.viewTypeId,
          catalogRevision: catalog.revision,
        },
      };
    }
    if (!scopeMatches(definition, item.resource)) {
      warnings.push(`workspace.resource-scope-mismatch:${item.instanceId}`);
    }
    return {
      ...item,
      viewTypeId: definition.viewTypeId,
      ownerModuleId: definition.ownerModuleId,
      ownerActivationId: definition.ownerActivationId,
      availability: { kind: "available" as const },
    };
  });
  return {
    document: parseUiWorkspaceDocument({ ...document, instances }),
    warnings: Object.freeze(warnings.sort((left, right) => left.localeCompare(right))),
  };
}

function result(
  status: WorkspaceMutationResult["status"],
  revision: WorkspaceRevision,
  affectedInstanceIds: readonly string[] = [],
  affectedStackIds: readonly string[] = [],
  warnings: readonly string[] = [],
): WorkspaceMutationResult {
  return Object.freeze({
    status,
    revision,
    affectedInstanceIds: Object.freeze([...new Set(affectedInstanceIds)].sort()),
    affectedStackIds: Object.freeze([...new Set(affectedStackIds)].sort()),
    warnings: Object.freeze([...new Set(warnings)].sort()),
  });
}

function ensureExpectedRevision(state: WorkspaceState, expectedRevision: WorkspaceRevision): void {
  if (state.revision !== expectedRevision) {
    throw new WorkspaceAuthorityError(
      "workspace.conflict",
      "Workspace revision is stale.",
      { currentRevision: state.revision },
    );
  }
}

function nextRevision(revision: WorkspaceRevision): WorkspaceRevision {
  if (!hasSafeNonNegativeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceAuthorityError("workspace.persistence-failed", "Workspace revision cannot advance safely.");
  }
  return (revision + 1) as WorkspaceRevision;
}

/**
 * The renderer-neutral Workspace authority. It receives immutable catalogs;
 * it cannot discover, load, authorize, or activate plugin code.
 */
export class WorkspaceAuthority {
  readonly #workspaceId: string;
  readonly #persistence: WorkspacePersistencePort;
  readonly #defaultProfile: WorkspaceProfileFactory;
  #catalog: WorkspaceCatalogSnapshot;
  #state: WorkspaceState;
  #catalogRequiresAcceptedSnapshot: boolean;
  readonly #listeners = new Set<Listener>();

  private constructor(
    options: WorkspaceAuthorityOptions,
    catalog: WorkspaceCatalogSnapshot,
    state: WorkspaceState,
  ) {
    this.#workspaceId = options.workspaceId;
    this.#persistence = options.persistence;
    this.#defaultProfile = options.defaultProfile ?? createDefaultWorkspaceProfile;
    this.#catalog = catalog;
    this.#state = state;
    this.#catalogRequiresAcceptedSnapshot =
      options.deferCatalogReconciliationUntilFirstAcceptedSnapshot === true;
  }

  static async open(options: WorkspaceAuthorityOptions): Promise<WorkspaceAuthority> {
    if (!hasIdentity(options.workspaceId)) invalidRequest("Workspace ID is invalid.");
    const catalog = parseWorkspaceCatalogSnapshot(options.catalog);
    let stored: WorkspacePersistedRecord | undefined;
    try {
      const loaded = await options.persistence.load(options.workspaceId);
      stored = loaded === undefined ? undefined : parseWorkspacePersistedRecord(loaded);
    } catch (error) {
      throw new WorkspaceAuthorityError(
        "workspace.persistence-failed",
        error instanceof Error ? error.message : "Workspace storage could not be read.",
      );
    }
    if (stored !== undefined && stored.workspaceId !== options.workspaceId) {
      throw new WorkspaceAuthorityError("workspace.persistence-failed", "Workspace storage returned another workspace.");
    }
    if (stored !== undefined) {
      const authority = new WorkspaceAuthority(options, catalog, {
        revision: stored.revision,
        originId: stored.originId,
        catalogRevision: stored.catalogRevision,
        document: stored.document,
      });
      if (!authority.#catalogRequiresAcceptedSnapshot) {
        const reconciliation = reconcileDocument(stored.document, catalog);
        if (
          stored.catalogRevision !== catalog.revision
          || !workspaceDocumentEqual(stored.document, reconciliation.document)
        ) {
          await authority.#commit({
            document: reconciliation.document,
            catalogRevision: catalog.revision,
            originId: "workspace.bootstrap-reconcile",
            kind: "catalog-reconciled",
            affectedInstances: reconciliation.document.instances.map((item) => item.instanceId),
            affectedStacks: workspaceStacks(reconciliation.document).map((stack) => stack.stackId),
            warnings: reconciliation.warnings,
            catalog,
          });
        }
      }
      return authority;
    }
    const profile = options.defaultProfile ?? createDefaultWorkspaceProfile;
    let document: UiWorkspaceDocument;
    try {
      document = parseUiWorkspaceDocument(profile({ workspaceId: options.workspaceId, catalog }));
    } catch (error) {
      if (error instanceof WorkspaceAuthorityError) throw error;
      throw new WorkspaceAuthorityError(
        "workspace.invalid-document",
        error instanceof Error ? error.message : "Workspace profile is invalid.",
      );
    }
    if (document.workspaceId !== options.workspaceId) {
      throw new WorkspaceAuthorityError("workspace.invalid-document", "Workspace profile returned another workspace.");
    }
    return new WorkspaceAuthority(options, catalog, {
      revision: 0 as WorkspaceRevision,
      originId: "workspace.initial",
      catalogRevision: catalog.revision,
      document,
    });
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  get revision(): WorkspaceRevision {
    return this.#state.revision;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  inspect(includeDocument = false): WorkspaceInspection {
    const document = this.#state.document;
    const stacks = workspaceStacks(document);
    const rootStackId = document.root === null
      ? null
      : (document.root.kind === "stack" ? document.root.stackId : stacks[0]?.stackId ?? null);
    return Object.freeze({
      workspaceId: this.#workspaceId,
      revision: this.#state.revision,
      originId: this.#state.originId,
      catalogRevision: this.#state.catalogRevision,
      viewDefinitions: Object.freeze([...this.#catalog.definitions]),
      instances: Object.freeze(document.instances.map((item) => Object.freeze({
        instanceId: item.instanceId,
        viewTypeId: item.viewTypeId,
        ownerModuleId: item.ownerModuleId,
        resource: item.resource,
        lifecycle: item.lifecycle,
        availability: item.availability,
      }))),
      rootStackId,
      floatingStackIds: Object.freeze(document.floating.map((item) => item.stack.stackId)),
      maximizedStackId: document.maximizedStackId,
      ...(includeDocument ? { document } : {}),
    });
  }

  /** Validate a command against the current revision without writing durable state. */
  validate(rawCommand: WorkspaceCommand): WorkspaceValidation {
    return this.#validation(this.#evaluate(rawCommand));
  }

  /** Return the exact normalized next document without writing durable state. */
  plan(rawCommand: WorkspaceCommand): WorkspacePlan {
    const evaluation = this.#evaluate(rawCommand);
    const validation = this.#validation(evaluation);
    return Object.freeze({ ...validation, document: evaluation.document });
  }

  /** Apply one command or an ordered batch in one compare-and-save revision. */
  async apply(rawCommand: WorkspaceCommand): Promise<WorkspaceMutationResult> {
    const evaluation = this.#evaluate(rawCommand);
    if (evaluation.mutation.status === "no-change") return evaluation.mutation;
    return this.#commit({
      document: evaluation.document,
      catalogRevision: this.#catalog.revision,
      originId: evaluation.command.originId,
      kind: "workspace-changed",
      affectedInstances: evaluation.mutation.affectedInstanceIds,
      affectedStacks: evaluation.mutation.affectedStackIds,
      warnings: evaluation.mutation.warnings,
    });
  }

  /** Backward-compatible mutation entrypoint; it has the same atomic behavior as apply. */
  async mutate(rawCommand: WorkspaceCommand): Promise<WorkspaceMutationResult> {
    return this.apply(rawCommand);
  }

  #evaluate(rawCommand: WorkspaceCommand): WorkspaceEvaluation {
    const command = parseWorkspaceCommand(rawCommand);
    ensureExpectedRevision(this.#state, command.expectedRevision);
    const before = this.#state.document;
    const steps: readonly WorkspaceCommandStep[] = command.kind === "apply"
      ? command.commands
      : [command];
    let document = before;
    const affectedInstanceIds: string[] = [];
    const affectedStackIds: string[] = [];
    const warnings: string[] = [];
    for (const step of steps) {
      const reduction = this.#reduce(document, step);
      document = parseUiWorkspaceDocument(reduction.document);
      affectedInstanceIds.push(...reduction.affectedInstanceIds);
      affectedStackIds.push(...reduction.affectedStackIds);
      warnings.push(...reduction.warnings);
    }
    return {
      command,
      document,
      mutation: result(
        workspaceDocumentEqual(before, document) ? "no-change" : "applied",
        this.#state.revision,
        affectedInstanceIds,
        affectedStackIds,
        warnings,
      ),
    };
  }

  #validation(evaluation: WorkspaceEvaluation): WorkspaceValidation {
    return Object.freeze({
      status: evaluation.mutation.status === "applied" ? "valid" : "no-change",
      revision: this.#state.revision,
      nextRevision: evaluation.mutation.status === "applied"
        ? nextRevision(this.#state.revision)
        : this.#state.revision,
      affectedInstanceIds: evaluation.mutation.affectedInstanceIds,
      affectedStackIds: evaluation.mutation.affectedStackIds,
      warnings: evaluation.mutation.warnings,
    });
  }

  #reduce(document: UiWorkspaceDocument, command: WorkspaceCommandStep): WorkspaceReduction {
    switch (command.kind) {
      case "open": {
        const definition = findWorkspaceViewDefinition(this.#catalog, command.viewTypeId);
        if (!definition) notFound(`Workspace view ${command.viewTypeId} is not accepted.`);
        if (!scopeMatches(definition, command.resource)) {
          invalidRequest(`Workspace resource does not match ${definition.viewTypeId}.`);
        }
        const matching = document.instances.find((item) => (
          item.viewTypeId === definition.viewTypeId
          && (definition.cardinality === "singleton"
            || (definition.cardinality === "one-per-resource"
              && workspaceResourceEqual(item.resource, command.resource))
            || (definition.cardinality === "multiple" && item.instanceId === command.instanceId))
        ));
        if (matching) {
          const next = matching.lifecycle === "hidden"
            ? placeInIntent({
                ...document,
                instances: document.instances.map((item) => item.instanceId === matching.instanceId
                  ? { ...item, lifecycle: "placed" as const }
                  : item),
              }, matching.instanceId, command.placement)
            : selectInstance(document, matching.instanceId);
          return {
            document: next,
            affectedInstanceIds: [matching.instanceId],
            affectedStackIds: workspaceStacks(next)
              .filter((stack) => stack.instanceIds.includes(matching.instanceId))
              .map((stack) => stack.stackId),
            warnings: [],
          };
        }
        if (document.instances.some((item) => item.instanceId === command.instanceId)) {
          invalidRequest(`Workspace instance ${command.instanceId} is already used.`);
        }
        const created: WorkspaceViewInstance = {
          instanceId: command.instanceId,
          viewTypeId: definition.viewTypeId,
          ownerModuleId: definition.ownerModuleId,
          ownerActivationId: definition.ownerActivationId,
          resource: command.resource,
          label: command.label ?? definition.label,
          availability: { kind: "available" },
          lifecycle: "placed",
        };
        const next = placeInIntent({ ...document, instances: [...document.instances, created] }, created.instanceId, command.placement);
        return {
          document: next,
          affectedInstanceIds: [created.instanceId],
          affectedStackIds: workspaceStacks(next)
            .filter((stack) => stack.instanceIds.includes(created.instanceId))
            .map((stack) => stack.stackId),
          warnings: [],
        };
      }
      case "close": {
        const item = document.instances.find((candidate) => candidate.instanceId === command.instanceId);
        if (!item) notFound(`Workspace instance ${command.instanceId} does not exist.`);
        const behavior = closeBehavior(this.#catalog, item);
        if (behavior === "forbid") {
          throw new WorkspaceAuthorityError("workspace.forbidden", `Workspace view ${item.viewTypeId} cannot be closed.`);
        }
        let next = removeInstance(document, item.instanceId);
        next = behavior === "hide"
          ? {
              ...next,
              instances: next.instances.map((candidate) => candidate.instanceId === item.instanceId
                ? { ...candidate, lifecycle: "hidden" as const }
                : candidate),
            }
          : { ...next, instances: next.instances.filter((candidate) => candidate.instanceId !== item.instanceId) };
        return {
          document: next,
          affectedInstanceIds: [item.instanceId],
          affectedStackIds: [],
          warnings: [],
        };
      }
      case "focus": {
        const item = document.instances.find((candidate) => candidate.instanceId === command.instanceId);
        if (!item) notFound(`Workspace instance ${command.instanceId} does not exist.`);
        const next = item.lifecycle === "hidden"
          ? placeInIntent({
              ...document,
              instances: document.instances.map((candidate) => candidate.instanceId === item.instanceId
                ? { ...candidate, lifecycle: "placed" as const }
                : candidate),
            }, item.instanceId, command.placement)
          : selectInstance(document, item.instanceId);
        return {
          document: next,
          affectedInstanceIds: [item.instanceId],
          affectedStackIds: workspaceStacks(next)
            .filter((stack) => stack.instanceIds.includes(item.instanceId))
            .map((stack) => stack.stackId),
          warnings: [],
        };
      }
      case "select": {
        if (!document.instances.some((candidate) => candidate.instanceId === command.instanceId)) {
          notFound(`Workspace instance ${command.instanceId} does not exist.`);
        }
        const next = selectInstance(document, command.instanceId);
        return {
          document: next,
          affectedInstanceIds: [command.instanceId],
          affectedStackIds: workspaceStacks(next)
            .filter((stack) => stack.instanceIds.includes(command.instanceId))
            .map((stack) => stack.stackId),
          warnings: [],
        };
      }
      case "move":
        return {
          document: moveInstance(
            document,
            command.instanceId,
            command.targetStackId,
            command.position,
            command.relativeInstanceId,
          ),
          affectedInstanceIds: [command.instanceId],
          affectedStackIds: [command.targetStackId],
          warnings: [],
        };
      case "split": {
        const identity = command.splitId === undefined
          ? allocateWorkspaceSplitIdentity(document)
          : { splitId: command.splitId, newStackId: command.newStackId! };
        return {
          document: splitStack(
            document,
            command.instanceId,
            command.targetStackId,
            identity.splitId,
            identity.newStackId,
            command.axis,
            command.position,
          ),
          affectedInstanceIds: [command.instanceId],
          affectedStackIds: [command.targetStackId, identity.newStackId],
          warnings: [],
        };
      }
      case "rename": {
        if (!document.instances.some((item) => item.instanceId === command.instanceId)) {
          notFound(`Workspace instance ${command.instanceId} does not exist.`);
        }
        return {
          document: {
            ...document,
            instances: document.instances.map((item) => item.instanceId === command.instanceId
              ? { ...item, label: command.label }
              : item),
          },
          affectedInstanceIds: [command.instanceId],
          affectedStackIds: [],
          warnings: [],
        };
      }
      case "resize-split": {
        const next = resizeSplit(document, command.splitId, command.firstShare);
        return {
          document: next,
          affectedInstanceIds: [],
          affectedStackIds: workspaceStacks(next).map((stack) => stack.stackId),
          warnings: [],
        };
      }
      case "float": {
        const next = floatInstance(document, command);
        return {
          document: next,
          affectedInstanceIds: [command.instanceId],
          affectedStackIds: [command.stackId],
          warnings: [],
        };
      }
      case "update-floating": {
        const next = updateFloating(document, command);
        const floating = next.floating.find((item) => item.floatingId === command.floatingId)!;
        return {
          document: next,
          affectedInstanceIds: [...floating.stack.instanceIds],
          affectedStackIds: [floating.stack.stackId],
          warnings: [],
        };
      }
      case "dock": {
        const floating = document.floating.find((item) => item.floatingId === command.floatingId);
        if (!floating) notFound(`Workspace floating stack ${command.floatingId} does not exist.`);
        const next = dockFloating(document, command);
        return {
          document: next,
          affectedInstanceIds: [...floating.stack.instanceIds],
          affectedStackIds: [floating.stack.stackId, ...(command.targetStackId === null ? [floating.stack.stackId] : [command.targetStackId])],
          warnings: [],
        };
      }
      case "maximize":
        if (!workspaceStack(document, command.stackId)) {
          notFound(`Workspace stack ${command.stackId} does not exist.`);
        }
        return {
          document: { ...document, maximizedStackId: command.stackId },
          affectedInstanceIds: [],
          affectedStackIds: [command.stackId],
          warnings: [],
        };
      case "restore":
        return {
          document: { ...document, maximizedStackId: null },
          affectedInstanceIds: [],
          affectedStackIds: document.maximizedStackId === null ? [] : [document.maximizedStackId],
          warnings: [],
        };
      case "reset": {
        const next = parseUiWorkspaceDocument(this.#defaultProfile({
          workspaceId: this.#workspaceId,
          catalog: this.#catalog,
        }));
        if (next.workspaceId !== this.#workspaceId) {
          throw new WorkspaceAuthorityError("workspace.invalid-document", "Workspace profile returned another workspace.");
        }
        return {
          document: next,
          affectedInstanceIds: next.instances.map((item) => item.instanceId),
          affectedStackIds: workspaceStacks(next).map((stack) => stack.stackId),
          warnings: [],
        };
      }
    }
  }

  async reconcileCatalog(input: ReconcileWorkspaceCatalogInput): Promise<WorkspaceMutationResult> {
    const catalog = (() => {
      try {
        return parseWorkspaceCatalogSnapshot(input.catalog);
      } catch (error) {
        throw new WorkspaceAuthorityError(
          "workspace.invalid-catalog",
          error instanceof Error ? error.message : "Workspace catalog is invalid.",
        );
      }
    })();
    const expectedRevision = assertRevision(input.expectedRevision);
    const originId = assertIdentity(input.originId, "Workspace origin ID");
    ensureExpectedRevision(this.#state, expectedRevision);
    const reconciliation = reconcileDocument(this.#state.document, catalog);
    const catalogChanged = this.#state.catalogRevision !== catalog.revision;
    const documentChanged = !workspaceDocumentEqual(this.#state.document, reconciliation.document);
    if (!catalogChanged && !documentChanged && !this.#catalogRequiresAcceptedSnapshot) {
      return result("no-change", this.#state.revision, [], [], reconciliation.warnings);
    }
    // A restored document may already have the exact accepted catalog
    // revision. Bootstrap still has to install the matching catalog object,
    // but a semantic no-op must not create a needless durable revision.
    if (!catalogChanged && !documentChanged && this.#catalogRequiresAcceptedSnapshot) {
      this.#catalog = catalog;
      this.#catalogRequiresAcceptedSnapshot = false;
      return result("no-change", this.#state.revision, [], [], reconciliation.warnings);
    }
    const committed = await this.#commit({
      document: reconciliation.document,
      catalogRevision: catalog.revision,
      originId,
      kind: "catalog-reconciled",
      affectedInstances: reconciliation.document.instances.map((item) => item.instanceId),
      affectedStacks: workspaceStacks(reconciliation.document).map((stack) => stack.stackId),
      warnings: reconciliation.warnings,
      catalog,
    });
    return committed;
  }

  async #commit(input: {
    readonly document: UiWorkspaceDocument;
    readonly catalogRevision: number;
    readonly originId: string;
    readonly kind: WorkspaceObservation["kind"];
    readonly affectedInstances: readonly string[];
    readonly affectedStacks: readonly string[];
    readonly warnings: readonly string[];
    readonly catalog?: WorkspaceCatalogSnapshot;
  }): Promise<WorkspaceMutationResult> {
    const revision = nextRevision(this.#state.revision);
    const record: WorkspacePersistedRecord = {
      storageSchemaVersion: WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
      workspaceId: this.#workspaceId,
      revision,
      originId: input.originId,
      catalogRevision: input.catalogRevision,
      document: input.document,
    };
    let saved: Awaited<ReturnType<WorkspacePersistencePort["compareAndSave"]>>;
    try {
      saved = await this.#persistence.compareAndSave({
        workspaceId: this.#workspaceId,
        expectedRevision: this.#state.revision,
        record,
      });
    } catch (error) {
      throw new WorkspaceAuthorityError(
        "workspace.persistence-failed",
        error instanceof Error ? error.message : "Workspace storage could not be written.",
      );
    }
    if (saved.status === "conflict") {
      if (saved.current !== undefined) {
        this.#state = {
          revision: saved.current.revision,
          originId: saved.current.originId,
          catalogRevision: saved.current.catalogRevision,
          document: saved.current.document,
        };
      }
      throw new WorkspaceAuthorityError(
        "workspace.conflict",
        "Workspace changed before this command could be saved.",
        { currentRevision: saved.current?.revision ?? null },
      );
    }
    this.#state = {
      revision: saved.record.revision,
      originId: saved.record.originId,
      catalogRevision: saved.record.catalogRevision,
      document: saved.record.document,
    };
    if (input.catalog) {
      this.#catalog = input.catalog;
      this.#catalogRequiresAcceptedSnapshot = false;
    }
    const mutation = result(
      "applied",
      this.#state.revision,
      input.affectedInstances,
      input.affectedStacks,
      input.warnings,
    );
    const event: WorkspaceObservation = {
      kind: input.kind,
      workspaceId: this.#workspaceId,
      revision: this.#state.revision,
      originId: this.#state.originId,
      catalogRevision: this.#state.catalogRevision,
      affectedInstanceIds: mutation.affectedInstanceIds,
      affectedStackIds: mutation.affectedStackIds,
      warnings: mutation.warnings,
    };
    await Promise.allSettled([...this.#listeners].map((listener) => listener(event)));
    return mutation;
  }
}
