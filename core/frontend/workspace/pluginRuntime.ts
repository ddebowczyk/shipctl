import {
  defineShipctlPlugin,
  pluginDataService,
  type AcceptedPluginAdmission,
  type DirectShipctlPluginDefinition,
  type ModuleActivationContext,
  type PluginDataService,
  type SemanticServiceProvider,
  type WorkspaceCatalogSnapshot,
  type WorkspaceService,
} from "@shipctl/module-api";

import {
  AcceptedWorkspaceCatalogController,
  type WorkspaceCatalogSynchronizationFailure,
} from "./acceptedCatalogController.ts";
import { WorkspaceAuthority, WorkspaceAuthorityError } from "./authority.ts";
import {
  WorkspaceCanvasBridge,
  type WorkspaceCanvas,
  type WorkspaceCanvasAction,
} from "./canvasBridge.ts";
import { PluginDataWorkspacePersistence, WORKSPACE_PLUGIN_MODULE_ID } from "./pluginDataPersistence.ts";
import { UnavailableWorkspacePersistence } from "./persistence.ts";
import { type WorkspaceProfileFactory } from "./profiles.ts";
import { createWorkspaceServiceProvider } from "./service.ts";

const WORKSPACE_PLUGIN_VERSION = "1";
const WORKSPACE_PLUGIN_GRANTS = [
  "plugin-data.read",
  "plugin-data.write",
  "plugin-data.migrate",
] as const;

export const WORKSPACE_PLUGIN_ADMISSION: AcceptedPluginAdmission = Object.freeze({
  artifact: Object.freeze({
    contentDigest: "0".repeat(64),
    entryUrl: "shipctl://trusted-host/workspace",
    moduleId: WORKSPACE_PLUGIN_MODULE_ID,
    version: WORKSPACE_PLUGIN_VERSION,
  }),
  effectiveGrants: Object.freeze([...WORKSPACE_PLUGIN_GRANTS]),
});

export type WorkspaceRuntimePersistence = "available" | "unavailable";
export type WorkspaceRuntimeDiagnosticKind = "persistence" | "workspace";

export interface WorkspaceRuntimeDiagnostic {
  readonly kind: WorkspaceRuntimeDiagnosticKind;
  readonly code: string;
  readonly message: string;
  readonly registryRevision?: number;
  readonly action?: WorkspaceCanvasAction["kind"];
}

export interface WorkspacePluginRuntimeOptions {
  readonly workspaceId: string;
  readonly catalog: WorkspaceCatalogSnapshot;
  readonly defaultProfile?: WorkspaceProfileFactory;
}

type CanvasListener = (canvas: WorkspaceCanvas) => void;
type DiagnosticListener = (diagnostic: WorkspaceRuntimeDiagnostic) => void;

/**
 * The trusted, headless workspace plugin. Its direct activation owns the
 * authority, plugin-data persistence, accepted-catalog queue, public service
 * facade, and renderer-neutral canvas bridge. The surrounding host only
 * starts/stops this bundled plugin and consumes its snapshots.
 */
export class WorkspacePluginRuntime {
  readonly #options: WorkspacePluginRuntimeOptions;
  readonly #serviceProvider: SemanticServiceProvider<WorkspaceService>;
  readonly #canvasListeners = new Set<CanvasListener>();
  readonly #diagnosticListeners = new Set<DiagnosticListener>();
  #authority: WorkspaceAuthority | null = null;
  #bridge: WorkspaceCanvasBridge | null = null;
  #controller: AcceptedWorkspaceCatalogController | null = null;
  #unsubscribeBridge: (() => void) | null = null;
  #persistence: WorkspaceRuntimePersistence = "available";
  #diagnostics: readonly WorkspaceRuntimeDiagnostic[] = Object.freeze([]);

  readonly definition: DirectShipctlPluginDefinition;

  constructor(options: WorkspacePluginRuntimeOptions) {
    this.#options = options;
    this.#serviceProvider = createWorkspaceServiceProvider({
      getAuthority: () => this.#requireAuthority(),
    });
    this.definition = defineShipctlPlugin({
      id: WORKSPACE_PLUGIN_MODULE_ID,
      version: WORKSPACE_PLUGIN_VERSION,
      role: "headless",
      requires: [pluginDataService],
      provides: [this.#serviceProvider],
      requiredGrants: WORKSPACE_PLUGIN_GRANTS,
      activate: async (context) => this.#activate(context),
    });
  }

  get persistence(): WorkspaceRuntimePersistence {
    return this.#persistence;
  }

  diagnostics(): readonly WorkspaceRuntimeDiagnostic[] {
    return this.#diagnostics;
  }

  serviceProvider(): SemanticServiceProvider<WorkspaceService> {
    return this.#serviceProvider;
  }

  snapshot(): WorkspaceCanvas {
    const bridge = this.#bridge;
    if (bridge === null) throw new Error("Workspace plugin is not active.");
    return bridge.snapshot();
  }

  subscribeCanvas(listener: CanvasListener): () => void {
    this.#canvasListeners.add(listener);
    return () => this.#canvasListeners.delete(listener);
  }

  subscribeDiagnostic(listener: DiagnosticListener): () => void {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  submitCatalog(catalog: WorkspaceCatalogSnapshot): Promise<void> {
    const controller = this.#controller;
    if (controller === null) return Promise.reject(new Error("Workspace plugin is not active."));
    return controller.submit(catalog);
  }

  async dispose(): Promise<void> {
    await this.#deactivate();
  }

  async #activate(context: ModuleActivationContext): Promise<void> {
    if (this.#authority !== null) throw new Error("Workspace plugin is already active.");
    if (context.identity.moduleId !== WORKSPACE_PLUGIN_MODULE_ID) {
      throw new Error("Workspace plugin activation has an unexpected owner.");
    }
    const pluginData = context.services.require(pluginDataService);
    const authority = await this.#openAuthority(pluginData);
    const bridge = new WorkspaceCanvasBridge({
      authority,
      onFailure: (action, error) => {
        this.#report({
          kind: "workspace",
          code: error instanceof WorkspaceAuthorityError
            ? error.code
            : "workspace.canvas-action-failed",
          message: error instanceof Error ? error.message : "Workspace change could not be saved.",
          action: action.kind,
        });
      },
    });
    const controller = new AcceptedWorkspaceCatalogController({
      authority,
      onFailure: (failure) => this.#reportCatalogFailure(failure),
    });
    this.#authority = authority;
    this.#bridge = bridge;
    this.#controller = controller;
    this.#unsubscribeBridge = bridge.subscribe((canvas) => {
      for (const listener of this.#canvasListeners) listener(canvas);
    });
    context.own(() => this.#deactivate());
  }

  async #openAuthority(pluginData: PluginDataService): Promise<WorkspaceAuthority> {
    const open = (persistence: PluginDataWorkspacePersistence | UnavailableWorkspacePersistence) => (
      WorkspaceAuthority.open({
        workspaceId: this.#options.workspaceId,
        catalog: this.#options.catalog,
        persistence,
        ...(this.#options.defaultProfile === undefined
          ? {}
          : { defaultProfile: this.#options.defaultProfile }),
        deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
      })
    );
    try {
      return await open(new PluginDataWorkspacePersistence(pluginData));
    } catch (error) {
      if (!(error instanceof WorkspaceAuthorityError) || error.code !== "workspace.persistence-failed") {
        throw error;
      }
      const message = error.message;
      this.#persistence = "unavailable";
      this.#report({
        kind: "persistence",
        code: "workspace.persistence-unavailable",
        message,
      });
      return open(new UnavailableWorkspacePersistence(message));
    }
  }

  async #deactivate(): Promise<void> {
    const unsubscribe = this.#unsubscribeBridge;
    this.#unsubscribeBridge = null;
    unsubscribe?.();
    this.#bridge?.dispose();
    this.#bridge = null;
    this.#controller?.dispose();
    this.#controller = null;
    this.#authority = null;
  }

  #requireAuthority(): WorkspaceAuthority {
    if (this.#authority === null) {
      throw new WorkspaceAuthorityError("workspace.persistence-failed", "Workspace plugin is not active.");
    }
    return this.#authority;
  }

  #reportCatalogFailure(failure: WorkspaceCatalogSynchronizationFailure): void {
    this.#report({
      kind: "workspace",
      code: "workspace.catalog-synchronization-failed",
      message: `Revision ${failure.catalogRevision}: ${failure.message}`,
      registryRevision: failure.catalogRevision,
    });
  }

  #report(diagnostic: WorkspaceRuntimeDiagnostic): void {
    const frozen = Object.freeze({ ...diagnostic });
    this.#diagnostics = Object.freeze([...this.#diagnostics, frozen]);
    for (const listener of this.#diagnosticListeners) listener(frozen);
  }
}
