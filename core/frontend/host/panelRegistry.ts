import type { ContributionId, PanelContribution } from "@shipctl/module-api";

export class PanelRegistrationError extends Error {
  readonly code: "duplicate-id" | "invalid-id";
  readonly contributionId: string;

  constructor(
    code: "duplicate-id" | "invalid-id",
    contributionId: string,
    message: string,
  ) {
    super(message);
    this.name = "PanelRegistrationError";
    this.code = code;
    this.contributionId = contributionId;
  }
}

function isNamespacedId(id: string): id is ContributionId {
  const separator = id.indexOf(".");
  return separator > 0 && separator < id.length - 1;
}

function compareContributions(
  left: PanelContribution,
  right: PanelContribution,
): number {
  const orderDifference = (left.order ?? 0) - (right.order ?? 0);
  return orderDifference || left.id.localeCompare(right.id);
}

export class PanelRegistry {
  readonly #panels = new Map<ContributionId, PanelContribution>();

  static create(
    contributions: readonly PanelContribution[] = [],
  ): PanelRegistry {
    const registry = new PanelRegistry();
    for (const contribution of contributions) {
      registry.register(contribution);
    }
    return registry;
  }

  register(contribution: PanelContribution): void {
    if (!isNamespacedId(contribution.id)) {
      throw new PanelRegistrationError(
        "invalid-id",
        contribution.id,
        `Panel contribution ID "${contribution.id}" must be namespaced`,
      );
    }

    const existing = this.#panels.get(contribution.id);
    if (existing) {
      throw new PanelRegistrationError(
        "duplicate-id",
        contribution.id,
        `Panel contribution ID "${contribution.id}" is registered by both `
          + `"${existing.moduleId}" and "${contribution.moduleId}"`,
      );
    }

    this.#panels.set(contribution.id, contribution);
  }

  panel(id: ContributionId): PanelContribution | undefined {
    return this.#panels.get(id);
  }

  has(id: ContributionId): boolean {
    return this.#panels.has(id);
  }

  list(): readonly PanelContribution[] {
    return [...this.#panels.values()].sort(compareContributions);
  }
}
