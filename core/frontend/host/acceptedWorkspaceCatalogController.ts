import type { WorkspaceCatalogSnapshot } from "@shipctl/module-api";
import { WorkspaceAuthority } from "@shipctl/core/workspace";

export interface WorkspaceCatalogSynchronizationFailure {
  readonly catalogRevision: number;
  readonly message: string;
}

export interface AcceptedWorkspaceCatalogControllerOptions {
  readonly authority: WorkspaceAuthority;
  /** Post-commit diagnostics only. A failure here cannot reject a runtime family. */
  readonly onFailure?: (failure: WorkspaceCatalogSynchronizationFailure) => void | Promise<void>;
}

/**
 * Reconciles semantic workspace state from runtime families that were already
 * accepted by `LiveModuleSupervisor`.
 *
 * It deliberately sits after the native route/schedule transaction. Making
 * workspace persistence part of that transaction would create a distributed
 * commit across independent durable authorities. A failed reconciliation is
 * reported and can retry on a later accepted catalog; it never unpublishes the
 * working message routes or plugin services.
 */
export class AcceptedWorkspaceCatalogController {
  readonly #authority: WorkspaceAuthority;
  readonly #onFailure: ((failure: WorkspaceCatalogSynchronizationFailure) => void | Promise<void>) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #highestSubmittedRevision = -1;
  #disposed = false;

  constructor(options: AcceptedWorkspaceCatalogControllerOptions) {
    this.#authority = options.authority;
    this.#onFailure = options.onFailure;
  }

  /**
   * Queue one already accepted catalog. Revisions older than this controller's
   * own accepted stream cannot regress workspace state. Equal revisions remain
   * valid: they are useful after a persistence failure and for bootstrap.
   */
  submit(catalog: WorkspaceCatalogSnapshot): Promise<void> {
    const revisionIsOrderable = Number.isSafeInteger(catalog.revision) && catalog.revision >= 0;
    if (
      this.#disposed
      || (revisionIsOrderable && catalog.revision < this.#highestSubmittedRevision)
    ) {
      return Promise.resolve();
    }
    // The authority validates every catalog. Do not let an invalid observer
    // payload poison this local high-water mark and suppress a later valid
    // accepted catalog.
    if (revisionIsOrderable) {
      this.#highestSubmittedRevision = Math.max(this.#highestSubmittedRevision, catalog.revision);
    }
    const scheduled = this.#queue.then(() => this.#reconcile(catalog));
    this.#queue = scheduled.catch(() => undefined);
    return scheduled;
  }

  dispose(): void {
    this.#disposed = true;
  }

  async #reconcile(catalog: WorkspaceCatalogSnapshot): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#authority.reconcileCatalog({
        catalog,
        expectedRevision: this.#authority.revision,
        originId: `runtime.catalog:${catalog.revision}`,
      });
    } catch (error) {
      const failure: WorkspaceCatalogSynchronizationFailure = {
        catalogRevision: catalog.revision,
        message: error instanceof Error ? error.message : "Workspace catalog could not be synchronized.",
      };
      try {
        await this.#onFailure?.(failure);
      } catch {
        // A diagnostic sink must not turn a post-commit workspace failure into
        // a runtime activation failure or an unhandled promise rejection.
      }
    }
  }
}
