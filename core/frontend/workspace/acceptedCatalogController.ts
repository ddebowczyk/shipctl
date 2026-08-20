import type { WorkspaceCatalogSnapshot } from "@shipctl/module-api";

import { WorkspaceAuthority } from "./authority.ts";

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
 * The workspace owner's post-commit catalog reconciliation queue. Accepted
 * runtime families are never rolled back when durable workspace reconciliation
 * fails: this controller records the diagnostic and later accepted catalogs
 * retry the work in revision order.
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

  submit(catalog: WorkspaceCatalogSnapshot): Promise<void> {
    const revisionIsOrderable = Number.isSafeInteger(catalog.revision) && catalog.revision >= 0;
    if (
      this.#disposed
      || (revisionIsOrderable && catalog.revision < this.#highestSubmittedRevision)
    ) {
      return Promise.resolve();
    }
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
        // Diagnostics cannot convert an accepted runtime family into a failed one.
      }
    }
  }
}
