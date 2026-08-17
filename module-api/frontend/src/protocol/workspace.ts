import { defineSemanticService } from "./semanticServices.ts";
import type { ModuleJsonValue } from "./services";
import type {
  ModuleActivationId,
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";

declare const workspaceRevisionBrand: unique symbol;

/** The semantic document format. It is independent from storage and renderers. */
export const WORKSPACE_DOCUMENT_SCHEMA_VERSION = 1;
/** The durable envelope format. It is independent from the document format. */
export const WORKSPACE_PERSISTENCE_SCHEMA_VERSION = 2;
/** The accepted definition-catalog format. */
export const WORKSPACE_CATALOG_SCHEMA_VERSION = 1;

/** A JavaScript-safe revision of one accepted semantic workspace record. */
export type WorkspaceRevision = number & {
  readonly [workspaceRevisionBrand]: true;
};

export type WorkspaceViewScope =
  | "global"
  | "project"
  | "terminal"
  | "panel"
  | "assistant-session";

export type WorkspaceViewCardinality =
  | "singleton"
  | "one-per-resource"
  | "multiple";

export type WorkspaceCloseBehavior = "hide" | "dispose" | "forbid";

/**
 * A data-only lazy-view reference. A private renderer maps this identifier to
 * code after catalog admission. It is deliberately not a React component or
 * a renderer object.
 */
export interface WorkspaceViewPresentationRef {
  readonly loaderId: string;
  readonly exportName: string;
}

export interface WorkspaceViewPlacement {
  readonly defaultRegion: "primary" | "secondary";
  readonly allowSplit: boolean;
}

export type WorkspaceViewStatePolicy =
  | { readonly kind: "none" }
  | { readonly kind: "json"; readonly schemaVersion: number };

/**
 * One admitted, renderer-neutral view definition. Definitions are catalog
 * facts, never persisted inside a workspace document.
 */
export interface WorkspaceViewDefinition {
  readonly viewTypeId: string;
  readonly ownerModuleId: string;
  readonly ownerActivationId: ModuleActivationId;
  readonly label: string;
  readonly scope: WorkspaceViewScope;
  readonly cardinality: WorkspaceViewCardinality;
  readonly closeBehavior: WorkspaceCloseBehavior;
  readonly requiredCapabilityIds: readonly string[];
  readonly placement: WorkspaceViewPlacement;
  readonly state: WorkspaceViewStatePolicy;
  readonly presentation: WorkspaceViewPresentationRef;
  readonly migrationAliases: readonly string[];
}

/** A validated immutable input from the accepted runtime catalog. */
export interface WorkspaceCatalogSnapshot {
  readonly schemaVersion: typeof WORKSPACE_CATALOG_SCHEMA_VERSION;
  readonly revision: number;
  readonly definitions: readonly WorkspaceViewDefinition[];
}

export type WorkspaceResourceReference =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly projectId: string }
  | {
      readonly kind: "terminal";
      readonly terminalId: string;
      readonly projectId: string;
    }
  | {
      readonly kind: "panel";
      readonly panelId: string;
      readonly panelInstanceId: string;
      readonly projectId: string | null;
    }
  | {
      readonly kind: "assistant-session";
      readonly sessionId: string;
      readonly projectId: string | null;
    }
  | {
      readonly kind: "unavailable";
      readonly sourceKind: Exclude<WorkspaceViewScope, "global">;
      readonly stableId: string;
    };

export type WorkspaceViewAvailability =
  | { readonly kind: "available" }
  | {
      readonly kind: "missing-definition";
      readonly lastKnownViewTypeId: string;
      readonly catalogRevision: number;
    };

/** One stable product view, separate from its placement in the layout tree. */
export interface WorkspaceViewInstance {
  readonly instanceId: string;
  readonly viewTypeId: string;
  readonly ownerModuleId: string;
  readonly ownerActivationId: ModuleActivationId;
  readonly resource: WorkspaceResourceReference;
  readonly label: string | null;
  readonly stateRef: ModuleJsonValue | null;
  readonly availability: WorkspaceViewAvailability;
  /** Hidden instances have explicit lifecycle state but no tree placement. */
  readonly lifecycle: "placed" | "hidden";
}

export interface WorkspaceStackNode {
  readonly kind: "stack";
  readonly stackId: string;
  readonly instanceIds: readonly string[];
  readonly selectedInstanceId: string;
}

export interface WorkspaceSplitNode {
  readonly kind: "split";
  readonly nodeId: string;
  readonly axis: "horizontal" | "vertical";
  readonly firstShare: number;
  readonly first: WorkspaceNode;
  readonly second: WorkspaceNode;
}

export type WorkspaceNode = WorkspaceStackNode | WorkspaceSplitNode;

export interface WorkspaceFloatingStack {
  readonly floatingId: string;
  readonly stack: WorkspaceStackNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Renderer-neutral product state. Revision belongs to the record envelope so
 * it cannot diverge from durable compare-and-save behavior.
 */
export interface UiWorkspaceDocument {
  readonly schemaVersion: typeof WORKSPACE_DOCUMENT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly instances: readonly WorkspaceViewInstance[];
  readonly root: WorkspaceNode | null;
  readonly floating: readonly WorkspaceFloatingStack[];
  readonly maximizedStackId: string | null;
}

/** Durable compare-and-save envelope; never a renderer snapshot. */
export interface WorkspacePersistedRecord {
  readonly storageSchemaVersion: typeof WORKSPACE_PERSISTENCE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly revision: WorkspaceRevision;
  readonly originId: string;
  readonly catalogRevision: number;
  readonly document: UiWorkspaceDocument;
}

export type WorkspacePlacementIntent =
  | { readonly kind: "default" }
  | { readonly kind: "stack"; readonly stackId: string };

interface WorkspaceCommandBase {
  readonly expectedRevision: WorkspaceRevision;
  readonly originId: string;
}

export interface OpenWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "open";
  readonly instanceId: string;
  readonly viewTypeId: string;
  readonly resource: WorkspaceResourceReference;
  readonly placement: WorkspacePlacementIntent;
  readonly label: string | null;
  readonly stateRef: ModuleJsonValue | null;
}

export interface CloseWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "close";
  readonly instanceId: string;
}

export interface FocusWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "focus";
  readonly instanceId: string;
  readonly placement: WorkspacePlacementIntent;
}

export interface SelectWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "select";
  readonly instanceId: string;
}

export interface MoveWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "move";
  readonly instanceId: string;
  readonly targetStackId: string;
  readonly position: "start" | "end" | "before" | "after";
  readonly relativeInstanceId: string | null;
}

export interface SplitWorkspaceViewCommand extends WorkspaceCommandBase {
  readonly kind: "split";
  readonly instanceId: string;
  readonly targetStackId: string;
  /**
   * Optional caller-selected identities for deterministic replay. When both
   * values are omitted, the workspace authority allocates opaque, unique
   * document identities.
   */
  readonly splitId?: string;
  readonly newStackId?: string;
  readonly axis: "horizontal" | "vertical";
  readonly position: "before" | "after";
}

export interface ResetWorkspaceCommand extends WorkspaceCommandBase {
  readonly kind: "reset";
  readonly profileId: string;
}

export type WorkspaceCommand =
  | OpenWorkspaceViewCommand
  | CloseWorkspaceViewCommand
  | FocusWorkspaceViewCommand
  | SelectWorkspaceViewCommand
  | MoveWorkspaceViewCommand
  | SplitWorkspaceViewCommand
  | ResetWorkspaceCommand;

export interface WorkspaceMutationResult {
  readonly status: "applied" | "no-change";
  readonly revision: WorkspaceRevision;
  readonly affectedInstanceIds: readonly string[];
  readonly affectedStackIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface WorkspaceViewInspection {
  readonly instanceId: string;
  readonly viewTypeId: string;
  readonly ownerModuleId: string;
  readonly resource: WorkspaceResourceReference;
  readonly lifecycle: WorkspaceViewInstance["lifecycle"];
  readonly availability: WorkspaceViewAvailability;
  readonly hasState: boolean;
}

/** Stable inspection for agents. `document` is opt-in because state is opaque. */
export interface WorkspaceInspection {
  readonly workspaceId: string;
  readonly revision: WorkspaceRevision;
  readonly originId: string;
  readonly catalogRevision: number;
  readonly profileId: string;
  readonly viewDefinitions: readonly WorkspaceViewDefinition[];
  readonly instances: readonly WorkspaceViewInspection[];
  readonly rootStackId: string | null;
  readonly floatingStackIds: readonly string[];
  readonly maximizedStackId: string | null;
  readonly document?: UiWorkspaceDocument;
}

export interface InspectWorkspaceInput {
  readonly workspaceId: string;
  readonly includeDocument: boolean;
}

export interface MutateWorkspaceInput {
  readonly workspaceId: string;
  readonly command: WorkspaceCommand;
}

export interface WorkspaceObservationScope {
  readonly workspaceId: string;
}

export interface WorkspaceObservation {
  readonly kind: "workspace-changed" | "catalog-reconciled";
  readonly workspaceId: string;
  readonly revision: WorkspaceRevision;
  readonly originId: string;
  readonly catalogRevision: number;
  readonly affectedInstanceIds: readonly string[];
  readonly affectedStackIds: readonly string[];
  readonly warnings: readonly string[];
}

export type WorkspaceErrorCode =
  | "workspace.activation-disposed"
  | "workspace.cancelled"
  | "workspace.conflict"
  | "workspace.forbidden"
  | "workspace.invalid-catalog"
  | "workspace.invalid-document"
  | "workspace.invalid-request"
  | "workspace.not-found"
  | "workspace.persistence-failed"
  | "workspace.unavailable";

/**
 * The public module-facing capability. Catalog publication is host-only: a
 * plugin may request semantic changes and observe accepted state, but cannot
 * discover, authorize, or activate other plugins.
 */
export interface WorkspaceService {
  readonly mutateWorkspace: SemanticRequestOperation<
    MutateWorkspaceInput,
    WorkspaceMutationResult,
    WorkspaceErrorCode
  >;
  readonly inspectWorkspace: SemanticRequestOperation<
    InspectWorkspaceInput,
    WorkspaceInspection,
    WorkspaceErrorCode
  >;
  readonly observeWorkspace: SemanticEventSource<
    WorkspaceObservationScope,
    WorkspaceObservation
  >;
}

export const workspaceService = defineSemanticService<WorkspaceService>(
  "shipctl.workspace",
  1,
);
