import type { WorkspaceCatalogSnapshot } from "@shipctl/module-api";
import {
  type WorkspaceCanvas,
  type WorkspaceCanvasAction,
  type WorkspaceRuntimeDiagnostic,
  type WorkspaceRuntimePersistence,
} from "@shipctl/core/workspace";

import type { ReconciliationDiagnostic } from "./liveReconciler.ts";

export type ApplicationRuntimeLifecycle = "idle" | "starting" | "running" | "failed" | "stopped";
export type ApplicationRuntimePersistence = WorkspaceRuntimePersistence;
export type ApplicationRuntimeDiagnosticKind = "persistence" | "workspace" | "reconciliation" | "startup";

/** A durable runtime fact; renderers may dismiss its notice, never this record. */
export interface ApplicationRuntimeDiagnostic {
  readonly id: string;
  readonly kind: ApplicationRuntimeDiagnosticKind;
  readonly code: string;
  readonly message: string;
  readonly registryRevision?: number;
  readonly moduleId?: string;
  readonly activationId?: string;
  readonly action?: WorkspaceCanvasAction["kind"];
}

export interface ApplicationRuntimeSnapshot<Family> {
  readonly lifecycle: ApplicationRuntimeLifecycle;
  readonly persistence: ApplicationRuntimePersistence;
  readonly family: Family;
  readonly workspaceCanvas: WorkspaceCanvas | undefined;
  readonly diagnostics: readonly ApplicationRuntimeDiagnostic[];
}

export interface ApplicationRuntimeSupervisor {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The host-facing edge of the bundled workspace plugin. The application
 * runtime never receives its authority or persistence port directly.
 */
export interface ApplicationWorkspaceRuntime {
  readonly persistence: WorkspaceRuntimePersistence;
  diagnostics(): readonly WorkspaceRuntimeDiagnostic[];
  snapshot(): WorkspaceCanvas;
  subscribeCanvas(listener: (canvas: WorkspaceCanvas) => void): () => void;
  subscribeDiagnostic(listener: (diagnostic: WorkspaceRuntimeDiagnostic) => void): () => void;
  submitCatalog(catalog: WorkspaceCatalogSnapshot): Promise<void>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ApplicationRuntimeSupervisorContext<Family> {
  /** Publishes only a complete family accepted by the live reconciler. */
  publish(family: Family): void;
  /** Keeps a rejected candidate available after renderer notices are dismissed. */
  reportReconciliationFailure(diagnostic: ReconciliationDiagnostic): void;
}

export interface ApplicationRuntimeOptions<Family> {
  readonly workspace: ApplicationWorkspaceRuntime;
  /** The existing bootstrap family; no service is invented by this entrypoint. */
  readonly initialFamily: Family;
  readonly workspaceCatalog: (family: Family) => WorkspaceCatalogSnapshot;
  readonly createSupervisor: (
    context: ApplicationRuntimeSupervisorContext<Family>,
  ) => ApplicationRuntimeSupervisor;
}

interface RuntimeResources {
  readonly unsubscribeCanvas: () => void;
  readonly unsubscribeDiagnostic: () => void;
  readonly workspace: ApplicationWorkspaceRuntime;
  readonly supervisor: ApplicationRuntimeSupervisor;
}

type Listener<Family> = (snapshot: ApplicationRuntimeSnapshot<Family>) => void;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Builds the application lifecycle outside React. The caller supplies the
 * already-activated workspace-plugin edge and presentation-family
 * construction; this function owns only their combined lifetime and snapshot.
 */
export function createApplicationRuntime<Family>(
  options: ApplicationRuntimeOptions<Family>,
): {
  snapshot(): ApplicationRuntimeSnapshot<Family>;
  subscribe(listener: Listener<Family>): () => void;
  start(): Promise<void>;
  dispose(): Promise<void>;
} {
  const listeners = new Set<Listener<Family>>();
  let diagnosticSequence = 0;
  let run = 0;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let resources: RuntimeResources | null = null;
  let snapshot: ApplicationRuntimeSnapshot<Family> = Object.freeze({
    lifecycle: "idle",
    persistence: "available",
    family: options.initialFamily,
    workspaceCanvas: undefined,
    diagnostics: Object.freeze([]),
  });

  const emit = () => {
    for (const listener of listeners) listener(snapshot);
  };

  const replaceSnapshot = (next: Partial<ApplicationRuntimeSnapshot<Family>>) => {
    snapshot = Object.freeze({ ...snapshot, ...next });
    emit();
  };

  const report = (
    input: Omit<ApplicationRuntimeDiagnostic, "id">,
  ): ApplicationRuntimeDiagnostic => {
    const diagnostic = Object.freeze({
      id: `runtime-${++diagnosticSequence}`,
      ...input,
    });
    replaceSnapshot({ diagnostics: Object.freeze([...snapshot.diagnostics, diagnostic]) });
    return diagnostic;
  };

  const active = (token: number) => token === run;

  const release = async (current: RuntimeResources | null): Promise<void> => {
    if (current === null) return;
    current.unsubscribeCanvas();
    current.unsubscribeDiagnostic();
    try {
      await current.supervisor.dispose();
    } finally {
      await current.workspace.dispose();
    }
  };

  const failStartup = async (token: number, error: unknown): Promise<void> => {
    if (!active(token) || snapshot.lifecycle === "failed") return;
    report({
      kind: "startup",
      code: "runtime.start-failed",
      message: errorMessage(error, "Application runtime could not start."),
    });
    const current = resources;
    resources = null;
    await release(current).catch((releaseError) => {
      report({
        kind: "startup",
        code: "runtime.dispose-failed",
        message: errorMessage(releaseError, "Application runtime cleanup failed."),
      });
    });
    replaceSnapshot({ lifecycle: "failed", workspaceCanvas: undefined });
  };

  const start = (): Promise<void> => {
    if (snapshot.lifecycle === "running") return Promise.resolve();
    if (starting !== null) return starting;
    if (stopping !== null) return stopping.then(() => start());

    const token = ++run;
    replaceSnapshot({
      lifecycle: "starting",
      persistence: "available",
      workspaceCanvas: undefined,
    });
    const boot = (async () => {
      const reportedWorkspaceDiagnostics = new Set<WorkspaceRuntimeDiagnostic>();
      const reportWorkspaceDiagnostic = (diagnostic: WorkspaceRuntimeDiagnostic) => {
        if (!active(token) || reportedWorkspaceDiagnostics.has(diagnostic)) return;
        reportedWorkspaceDiagnostics.add(diagnostic);
        replaceSnapshot({ persistence: options.workspace.persistence });
        report({
          kind: diagnostic.kind,
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.registryRevision === undefined
            ? {}
            : { registryRevision: diagnostic.registryRevision }),
          ...(diagnostic.action === undefined ? {} : { action: diagnostic.action }),
        });
      };
      let unsubscribeDiagnostic: (() => void) | null = null;
      let current: RuntimeResources | null = null;
      try {
        unsubscribeDiagnostic = options.workspace.subscribeDiagnostic(reportWorkspaceDiagnostic);
        await options.workspace.start();
      } catch (error) {
        unsubscribeDiagnostic?.();
        await options.workspace.dispose().catch(() => undefined);
        throw error;
      }
      try {
        if (!active(token)) {
          unsubscribeDiagnostic?.();
          await options.workspace.dispose();
          return;
        }
        for (const diagnostic of options.workspace.diagnostics()) {
          reportWorkspaceDiagnostic(diagnostic);
        }
        replaceSnapshot({ persistence: options.workspace.persistence });

        const publish = (family: Family) => {
          if (!active(token)) return;
          let catalog: WorkspaceCatalogSnapshot;
          try {
            catalog = options.workspaceCatalog(family);
          } catch (error) {
            report({
              kind: "workspace",
              code: "workspace.catalog-unavailable",
              message: errorMessage(error, "Accepted runtime family has no workspace catalog."),
            });
            return;
          }
          replaceSnapshot({ family });
          // Reconciliation is serialized inside the workspace plugin after a
          // family has been accepted. It can only add a durable diagnostic.
          void options.workspace.submitCatalog(catalog).catch((error) => {
            if (!active(token)) return;
            report({
              kind: "workspace",
              code: "workspace.catalog-synchronization-failed",
              message: errorMessage(error, "Workspace catalog could not be synchronized."),
              registryRevision: catalog.revision,
            });
          });
        };
        const reportReconciliationFailure = (diagnostic: ReconciliationDiagnostic) => {
          if (!active(token)) return;
          report({
            kind: "reconciliation",
            code: diagnostic.code,
            message: diagnostic.message,
            registryRevision: diagnostic.desiredRevision,
            ...(diagnostic.moduleId === undefined ? {} : { moduleId: diagnostic.moduleId }),
            ...(diagnostic.activationId === undefined ? {} : { activationId: diagnostic.activationId }),
          });
        };
        const supervisor = options.createSupervisor({ publish, reportReconciliationFailure });
        const unsubscribeCanvas = options.workspace.subscribeCanvas((workspaceCanvas) => {
          if (active(token)) replaceSnapshot({ workspaceCanvas });
        });
        current = {
          unsubscribeCanvas,
          unsubscribeDiagnostic: unsubscribeDiagnostic!,
          workspace: options.workspace,
          supervisor,
        };
        if (!active(token)) {
          await release(current);
          return;
        }
        resources = current;
        replaceSnapshot({ workspaceCanvas: options.workspace.snapshot() });

        await supervisor.start();

        if (!active(token)) {
          resources = null;
          await release(current);
          return;
        }
        replaceSnapshot({ lifecycle: "running" });
      } catch (error) {
        if (current === null) {
          unsubscribeDiagnostic?.();
          await options.workspace.dispose().catch(() => undefined);
        }
        throw error;
      }
    })().catch(async (error: unknown) => {
      await failStartup(token, error);
      throw error;
    });
    starting = boot;
    void boot.then(
      () => { if (starting === boot) starting = null; },
      () => { if (starting === boot) starting = null; },
    );
    return boot;
  };

  const dispose = (): Promise<void> => {
    if (stopping !== null) return stopping;
    ++run;
    const waitForStart = starting;
    const current = resources;
    resources = null;
    const stop = (async () => {
      await waitForStart?.catch(() => undefined);
      try {
        await release(current);
      } catch (error) {
        report({
          kind: "startup",
          code: "runtime.dispose-failed",
          message: errorMessage(error, "Application runtime cleanup failed."),
        });
      } finally {
        replaceSnapshot({ lifecycle: "stopped", workspaceCanvas: undefined });
      }
    })();
    stopping = stop;
    void stop.then(
      () => { if (stopping === stop) stopping = null; },
      () => { if (stopping === stop) stopping = null; },
    );
    return stop;
  };

  return Object.freeze({
    snapshot: () => snapshot,
    subscribe: (listener: Listener<Family>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    dispose,
  });
}
