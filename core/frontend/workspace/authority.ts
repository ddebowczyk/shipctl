import {
  WORKSPACE_PERSISTENCE_SCHEMA_VERSION,
  type ModuleJsonValue,
  type UiWorkspaceDocument,
  type WorkspaceCatalogSnapshot,
  type WorkspaceCloseBehavior,
  type WorkspaceCommand,
  type WorkspaceFloatingStack,
  type WorkspaceInspection,
  type WorkspaceMutationResult,
  type WorkspaceNode,
  type WorkspaceObservation,
  type WorkspacePersistedRecord,
  type WorkspacePlacementIntent,
  type WorkspaceResourceReference,
  type WorkspaceRevision,
  type WorkspaceStackNode,
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
  hasOnlyKeys,
  hasSafeNonNegativeInteger,
  hasWorkspaceName,
  isPlainRecord,
  jsonSafe,
} from "./internal.ts";
import type { WorkspacePersistencePort } from "./persistence.ts";
import {
  createCurrentCanvasWorkspaceProfile,
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

export interface WorkspaceAuthorityOptions {
  readonly workspaceId: string;
  /** A snapshot already accepted by the runtime lifecycle transaction. */
  readonly catalog: WorkspaceCatalogSnapshot;
  readonly persistence: WorkspacePersistencePort;
  readonly defaultProfile?: WorkspaceProfileFactory;
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

/** Runtime validation for commands that can arrive through an agent transport. */
export function parseWorkspaceCommand(value: unknown): WorkspaceCommand {
  const candidate = exact(value, "Workspace command", [
    "kind",
    "expectedRevision",
    "originId",
    "instanceId",
    "viewTypeId",
    "resource",
    "placement",
    "label",
    "stateRef",
    "targetStackId",
    "position",
    "relativeInstanceId",
    "splitId",
    "newStackId",
    "axis",
    "profileId",
  ]);
  const expectedRevision = assertRevision(candidate.expectedRevision);
  const originId = assertIdentity(candidate.originId, "Workspace origin ID");
  const base = { expectedRevision, originId };
  switch (candidate.kind) {
    case "open":
      exactCommand(candidate, "Open", ["instanceId", "viewTypeId", "resource", "placement", "label", "stateRef"]);
      if (
        !hasIdentity(candidate.instanceId)
        || !hasWorkspaceName(candidate.viewTypeId)
        || (candidate.label !== null && !hasIdentity(candidate.label))
        || !jsonSafe(candidate.stateRef)
      ) invalidRequest("Open workspace command is invalid.");
      return Object.freeze({
        ...base,
        kind: "open" as const,
        instanceId: candidate.instanceId,
        viewTypeId: candidate.viewTypeId,
        resource: parseResource(candidate.resource),
        placement: parsePlacement(candidate.placement),
        label: candidate.label,
        stateRef: candidate.stateRef,
      });
    case "close":
    case "select":
      exactCommand(candidate, candidate.kind === "close" ? "Close" : "Select", ["instanceId"]);
      if (!hasIdentity(candidate.instanceId)) invalidRequest(`${candidate.kind} workspace command is invalid.`);
      return Object.freeze({ ...base, kind: candidate.kind, instanceId: candidate.instanceId });
    case "focus":
      exactCommand(candidate, "Focus", ["instanceId", "placement"]);
      if (!hasIdentity(candidate.instanceId)) invalidRequest("Focus workspace command is invalid.");
      return Object.freeze({
        ...base,
        kind: "focus" as const,
        instanceId: candidate.instanceId,
        placement: parsePlacement(candidate.placement),
      });
    case "move":
      exactCommand(candidate, "Move", ["instanceId", "targetStackId", "position", "relativeInstanceId"]);
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
        ...base,
        kind: "move" as const,
        instanceId: candidate.instanceId,
        targetStackId: candidate.targetStackId,
        position: candidate.position,
        relativeInstanceId: candidate.relativeInstanceId,
      });
    case "split":
      exactCommand(candidate, "Split", ["instanceId", "targetStackId", "splitId", "newStackId", "axis", "position"]);
      if (
        !hasIdentity(candidate.instanceId)
        || !hasIdentity(candidate.targetStackId)
        || !hasIdentity(candidate.splitId)
        || !hasIdentity(candidate.newStackId)
        || (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
        || (candidate.position !== "before" && candidate.position !== "after")
      ) invalidRequest("Split workspace command is invalid.");
      return Object.freeze({
        ...base,
        kind: "split" as const,
        instanceId: candidate.instanceId,
        targetStackId: candidate.targetStackId,
        splitId: candidate.splitId,
        newStackId: candidate.newStackId,
        axis: candidate.axis,
        position: candidate.position,
      });
    case "reset":
      exactCommand(candidate, "Reset", ["profileId"]);
      if (!hasIdentity(candidate.profileId)) invalidRequest("Reset workspace command is invalid.");
      return Object.freeze({ ...base, kind: "reset" as const, profileId: candidate.profileId });
    default:
      return invalidRequest("Workspace command kind is invalid.");
  }
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
  return { ...document, root, floating };
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
  if (workspaceStack(document, newStackId) || workspaceStacks(document).some((stack) => stack.stackId === splitId)) {
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
  readonly #listeners = new Set<Listener>();

  private constructor(
    options: WorkspaceAuthorityOptions,
    catalog: WorkspaceCatalogSnapshot,
    state: WorkspaceState,
  ) {
    this.#workspaceId = options.workspaceId;
    this.#persistence = options.persistence;
    this.#defaultProfile = options.defaultProfile ?? createCurrentCanvasWorkspaceProfile;
    this.#catalog = catalog;
    this.#state = state;
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
      return authority;
    }
    const profile = options.defaultProfile ?? createCurrentCanvasWorkspaceProfile;
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
      profileId: document.profileId,
      viewDefinitions: Object.freeze([...this.#catalog.definitions]),
      instances: Object.freeze(document.instances.map((item) => Object.freeze({
        instanceId: item.instanceId,
        viewTypeId: item.viewTypeId,
        ownerModuleId: item.ownerModuleId,
        resource: item.resource,
        lifecycle: item.lifecycle,
        availability: item.availability,
        hasState: item.stateRef !== null,
      }))),
      rootStackId,
      floatingStackIds: Object.freeze(document.floating.map((item) => item.stack.stackId)),
      maximizedStackId: document.maximizedStackId,
      ...(includeDocument ? { document } : {}),
    });
  }

  async mutate(rawCommand: WorkspaceCommand): Promise<WorkspaceMutationResult> {
    const command = parseWorkspaceCommand(rawCommand);
    ensureExpectedRevision(this.#state, command.expectedRevision);
    const before = this.#state.document;
    let next = before;
    let affectedInstances: readonly string[] = [];
    let affectedStacks: readonly string[] = [];
    let warnings: readonly string[] = [];

    switch (command.kind) {
      case "open": {
        const definition = findWorkspaceViewDefinition(this.#catalog, command.viewTypeId);
        if (!definition) notFound(`Workspace view ${command.viewTypeId} is not accepted.`);
        if (!scopeMatches(definition, command.resource)) {
          invalidRequest(`Workspace resource does not match ${definition.viewTypeId}.`);
        }
        const matching = before.instances.find((item) => (
          item.viewTypeId === definition.viewTypeId
          && (definition.cardinality === "singleton"
            || (definition.cardinality === "one-per-resource"
              && workspaceResourceEqual(item.resource, command.resource))
            || (definition.cardinality === "multiple" && item.instanceId === command.instanceId))
        ));
        if (matching) {
          next = matching.lifecycle === "hidden"
            ? placeInIntent({
                ...before,
                instances: before.instances.map((item) => item.instanceId === matching.instanceId
                  ? { ...item, lifecycle: "placed" as const }
                  : item),
              }, matching.instanceId, command.placement)
            : selectInstance(before, matching.instanceId);
          affectedInstances = [matching.instanceId];
          affectedStacks = workspaceStacks(next)
            .filter((stack) => stack.instanceIds.includes(matching.instanceId))
            .map((stack) => stack.stackId);
          break;
        }
        if (before.instances.some((item) => item.instanceId === command.instanceId)) {
          invalidRequest(`Workspace instance ${command.instanceId} is already used.`);
        }
        const created: WorkspaceViewInstance = {
          instanceId: command.instanceId,
          viewTypeId: definition.viewTypeId,
          ownerModuleId: definition.ownerModuleId,
          ownerActivationId: definition.ownerActivationId,
          resource: command.resource,
          label: command.label ?? definition.label,
          stateRef: command.stateRef,
          availability: { kind: "available" },
          lifecycle: "placed",
        };
        next = placeInIntent({ ...before, instances: [...before.instances, created] }, created.instanceId, command.placement);
        affectedInstances = [created.instanceId];
        affectedStacks = workspaceStacks(next)
          .filter((stack) => stack.instanceIds.includes(created.instanceId))
          .map((stack) => stack.stackId);
        break;
      }
      case "close": {
        const item = before.instances.find((candidate) => candidate.instanceId === command.instanceId);
        if (!item) notFound(`Workspace instance ${command.instanceId} does not exist.`);
        const behavior = closeBehavior(this.#catalog, item);
        if (behavior === "forbid") {
          throw new WorkspaceAuthorityError("workspace.forbidden", `Workspace view ${item.viewTypeId} cannot be closed.`);
        }
        next = removeInstance(before, item.instanceId);
        if (behavior === "hide") {
          next = {
            ...next,
            instances: next.instances.map((candidate) => candidate.instanceId === item.instanceId
              ? { ...candidate, lifecycle: "hidden" as const }
              : candidate),
          };
        } else {
          next = { ...next, instances: next.instances.filter((candidate) => candidate.instanceId !== item.instanceId) };
        }
        affectedInstances = [item.instanceId];
        break;
      }
      case "focus": {
        const item = before.instances.find((candidate) => candidate.instanceId === command.instanceId);
        if (!item) notFound(`Workspace instance ${command.instanceId} does not exist.`);
        next = item.lifecycle === "hidden"
          ? placeInIntent({
              ...before,
              instances: before.instances.map((candidate) => candidate.instanceId === item.instanceId
                ? { ...candidate, lifecycle: "placed" as const }
                : candidate),
            }, item.instanceId, command.placement)
          : selectInstance(before, item.instanceId);
        affectedInstances = [item.instanceId];
        affectedStacks = workspaceStacks(next)
          .filter((stack) => stack.instanceIds.includes(item.instanceId))
          .map((stack) => stack.stackId);
        break;
      }
      case "select": {
        if (!before.instances.some((candidate) => candidate.instanceId === command.instanceId)) {
          notFound(`Workspace instance ${command.instanceId} does not exist.`);
        }
        next = selectInstance(before, command.instanceId);
        affectedInstances = [command.instanceId];
        affectedStacks = workspaceStacks(next)
          .filter((stack) => stack.instanceIds.includes(command.instanceId))
          .map((stack) => stack.stackId);
        break;
      }
      case "move":
        next = moveInstance(
          before,
          command.instanceId,
          command.targetStackId,
          command.position,
          command.relativeInstanceId,
        );
        affectedInstances = [command.instanceId];
        affectedStacks = [command.targetStackId];
        break;
      case "split":
        next = splitStack(
          before,
          command.instanceId,
          command.targetStackId,
          command.splitId,
          command.newStackId,
          command.axis,
          command.position,
        );
        affectedInstances = [command.instanceId];
        affectedStacks = [command.targetStackId, command.newStackId];
        break;
      case "reset":
        if (command.profileId !== this.#state.document.profileId) {
          notFound(`Workspace profile ${command.profileId} is not available.`);
        }
        next = parseUiWorkspaceDocument(this.#defaultProfile({
          workspaceId: this.#workspaceId,
          catalog: this.#catalog,
        }));
        affectedInstances = next.instances.map((item) => item.instanceId);
        affectedStacks = workspaceStacks(next).map((stack) => stack.stackId);
        break;
    }

    next = parseUiWorkspaceDocument(next);
    if (workspaceDocumentEqual(before, next)) {
      return result("no-change", this.#state.revision, affectedInstances, affectedStacks, warnings);
    }
    return this.#commit({
      document: next,
      catalogRevision: this.#catalog.revision,
      originId: command.originId,
      kind: "workspace-changed",
      affectedInstances,
      affectedStacks,
      warnings,
    });
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
    if (!catalogChanged && workspaceDocumentEqual(this.#state.document, reconciliation.document)) {
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
    if (input.catalog) this.#catalog = input.catalog;
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
