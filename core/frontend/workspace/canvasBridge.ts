import type {
  ModuleJsonValue,
  UiWorkspaceDocument,
  WorkspaceInspection,
  WorkspaceMutationResult,
  WorkspacePlacementIntent,
  WorkspaceRevision,
  WorkspaceResourceReference,
  WorkspaceViewDefinition,
  WorkspaceViewInstance,
} from "@shipctl/module-api";

import { WorkspaceAuthority } from "./authority.ts";

/** The semantic operations that a canvas adapter may issue in this slice. */
export type WorkspaceCanvasAction =
  | {
      readonly kind: "open";
      readonly instanceId: string;
      readonly viewTypeId: string;
      readonly resource: WorkspaceResourceReference;
      readonly placement?: WorkspacePlacementIntent;
      readonly label?: string | null;
      readonly stateRef?: ModuleJsonValue | null;
    }
  | { readonly kind: "select"; readonly instanceId: string }
  | { readonly kind: "close"; readonly instanceId: string };

/** A resolved, data-only view for one canvas projection. */
export interface WorkspaceCanvasView {
  readonly instance: WorkspaceViewInstance;
  readonly definition: WorkspaceViewDefinition | null;
  readonly title: string;
  readonly closeable: boolean;
  readonly splitAllowed: boolean;
}

/**
 * The renderer-neutral canvas input. It is derived from the semantic
 * workspace inspection and contains no Layman, React, or Tauri values.
 */
export interface WorkspaceCanvasProjection {
  readonly workspaceId: string;
  readonly revision: WorkspaceRevision;
  readonly catalogRevision: number;
  readonly document: UiWorkspaceDocument;
  readonly views: readonly WorkspaceCanvasView[];
}

/** A live canvas handle supplied by the host shell to a canvas adapter. */
export interface WorkspaceCanvas {
  readonly projection: WorkspaceCanvasProjection;
  readonly execute: (action: WorkspaceCanvasAction) => Promise<WorkspaceMutationResult>;
}

export interface WorkspaceCanvasBridgeOptions {
  readonly authority: WorkspaceAuthority;
  readonly originId?: string;
  readonly onFailure?: (action: WorkspaceCanvasAction, error: unknown) => void;
}

type Listener = (canvas: WorkspaceCanvas) => void;

function documentFrom(inspection: WorkspaceInspection): UiWorkspaceDocument {
  if (inspection.document === undefined) {
    throw new Error("Workspace canvas projection requires an inspected document.");
  }
  return inspection.document;
}

/** Build a pure canvas projection from an authority inspection. */
export function createWorkspaceCanvasProjection(
  inspection: WorkspaceInspection,
): WorkspaceCanvasProjection {
  const document = documentFrom(inspection);
  const definitions = new Map(
    inspection.viewDefinitions.map((definition) => [definition.viewTypeId, definition]),
  );
  const views = document.instances.map((instance) => {
    const definition = definitions.get(instance.viewTypeId) ?? null;
    return Object.freeze({
      instance,
      definition,
      title: instance.label ?? definition?.label ?? instance.viewTypeId,
      // Missing definitions use the authority's recoverable default: hide.
      closeable: definition?.closeBehavior !== "forbid",
      splitAllowed: definition?.placement.allowSplit ?? false,
    });
  });

  return Object.freeze({
    workspaceId: inspection.workspaceId,
    revision: inspection.revision,
    catalogRevision: inspection.catalogRevision,
    document,
    views: Object.freeze(views),
  });
}

/**
 * Serializes canvas requests through the semantic authority. The bridge is a
 * projection adapter, not a plugin registry or a second workspace store.
 */
export class WorkspaceCanvasBridge {
  readonly #authority: WorkspaceAuthority;
  readonly #originId: string;
  readonly #onFailure: ((action: WorkspaceCanvasAction, error: unknown) => void) | undefined;
  readonly #listeners = new Set<Listener>();
  readonly #execute: WorkspaceCanvas["execute"];
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #unsubscribe: (() => void) | undefined;

  constructor({
    authority,
    originId = "shipctl.canvas.adapter",
    onFailure,
  }: WorkspaceCanvasBridgeOptions) {
    this.#authority = authority;
    this.#originId = originId;
    this.#onFailure = onFailure;
    this.#execute = (action) => this.execute(action);
    this.#unsubscribe = authority.subscribe(() => this.#publish());
  }

  snapshot(): WorkspaceCanvas {
    return Object.freeze({
      projection: createWorkspaceCanvasProjection(this.#authority.inspect(true)),
      execute: this.#execute,
    });
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#listeners.clear();
  }

  execute(action: WorkspaceCanvasAction): Promise<WorkspaceMutationResult> {
    const scheduled = this.#tail.then(async () => {
      if (this.#disposed) {
        throw new Error("Workspace canvas bridge is disposed.");
      }
      const expectedRevision = this.#authority.revision;
      switch (action.kind) {
        case "open":
          return this.#authority.mutate({
            kind: "open",
            instanceId: action.instanceId,
            viewTypeId: action.viewTypeId,
            resource: action.resource,
            placement: action.placement ?? { kind: "default" },
            label: action.label ?? null,
            stateRef: action.stateRef ?? null,
            expectedRevision,
            originId: this.#originId,
          });
        case "select":
          return this.#authority.mutate({
            kind: "select",
            instanceId: action.instanceId,
            expectedRevision,
            originId: this.#originId,
          });
        case "close":
          return this.#authority.mutate({
            kind: "close",
            instanceId: action.instanceId,
            expectedRevision,
            originId: this.#originId,
          });
      }
    });
    this.#tail = scheduled.then(() => undefined, () => undefined);

    return scheduled.catch((error: unknown) => {
      // A compare-and-save conflict updates authority state before it fails.
      // Re-publish it so a renderer cannot retain an optimistic Layman state.
      this.#publish();
      this.#onFailure?.(action, error);
      throw error;
    });
  }

  #publish(): void {
    if (this.#disposed) return;
    const canvas = this.snapshot();
    for (const listener of this.#listeners) listener(canvas);
  }
}
