import type {
  ContributionId,
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
} from "@shipctl/module-api";

export type GlobalSurfaceRegistrationErrorCode =
  | "duplicate-navigation-id"
  | "duplicate-surface-id"
  | "invalid-navigation-id"
  | "invalid-surface-id"
  | "missing-surface"
  | "module-mismatch";

export class GlobalSurfaceRegistrationError extends Error {
  readonly code: GlobalSurfaceRegistrationErrorCode;
  readonly contributionId: string;

  constructor(
    code: GlobalSurfaceRegistrationErrorCode,
    contributionId: string,
    message: string,
  ) {
    super(message);
    this.name = "GlobalSurfaceRegistrationError";
    this.code = code;
    this.contributionId = contributionId;
  }
}

function isNamespacedId(id: string): id is ContributionId {
  const separator = id.indexOf(".");
  return separator > 0 && separator < id.length - 1;
}

function compareNavigation(
  left: GlobalNavigationContribution,
  right: GlobalNavigationContribution,
): number {
  const orderDifference = (left.order ?? 0) - (right.order ?? 0);
  return orderDifference || left.id.localeCompare(right.id);
}

export class GlobalSurfaceRegistry {
  readonly #surfaces = new Map<ContributionId, GlobalSurfaceContribution>();
  readonly #navigation = new Map<ContributionId, GlobalNavigationContribution>();

  static create({
    surfaces = [],
    navigation = [],
  }: {
    readonly surfaces?: readonly GlobalSurfaceContribution[];
    readonly navigation?: readonly GlobalNavigationContribution[];
  } = {}): GlobalSurfaceRegistry {
    const registry = new GlobalSurfaceRegistry();
    for (const contribution of surfaces) registry.registerSurface(contribution);
    for (const contribution of navigation) registry.registerNavigation(contribution);
    return registry;
  }

  registerSurface(contribution: GlobalSurfaceContribution): void {
    if (!isNamespacedId(contribution.id)) {
      throw new GlobalSurfaceRegistrationError(
        "invalid-surface-id",
        contribution.id,
        `Global surface ID "${contribution.id}" must be namespaced`,
      );
    }
    const existing = this.#surfaces.get(contribution.id);
    if (existing) {
      throw new GlobalSurfaceRegistrationError(
        "duplicate-surface-id",
        contribution.id,
        `Global surface ID "${contribution.id}" is registered by both `
          + `"${existing.moduleId}" and "${contribution.moduleId}"`,
      );
    }
    this.#surfaces.set(contribution.id, contribution);
  }

  registerNavigation(contribution: GlobalNavigationContribution): void {
    if (!isNamespacedId(contribution.id)) {
      throw new GlobalSurfaceRegistrationError(
        "invalid-navigation-id",
        contribution.id,
        `Global navigation ID "${contribution.id}" must be namespaced`,
      );
    }
    const existing = this.#navigation.get(contribution.id);
    if (existing) {
      throw new GlobalSurfaceRegistrationError(
        "duplicate-navigation-id",
        contribution.id,
        `Global navigation ID "${contribution.id}" is registered by both `
          + `"${existing.moduleId}" and "${contribution.moduleId}"`,
      );
    }
    const surface = this.#surfaces.get(contribution.surfaceId);
    if (!surface) {
      throw new GlobalSurfaceRegistrationError(
        "missing-surface",
        contribution.id,
        `Global navigation ID "${contribution.id}" targets unregistered surface `
          + `"${contribution.surfaceId}"`,
      );
    }
    if (surface.moduleId !== contribution.moduleId) {
      throw new GlobalSurfaceRegistrationError(
        "module-mismatch",
        contribution.id,
        `Global navigation ID "${contribution.id}" and surface `
          + `"${contribution.surfaceId}" must have the same module owner`,
      );
    }
    this.#navigation.set(contribution.id, contribution);
  }

  surface(id: ContributionId): GlobalSurfaceContribution | undefined {
    return this.#surfaces.get(id);
  }

  has(id: ContributionId): boolean {
    return this.#surfaces.has(id);
  }

  surfaces(): readonly GlobalSurfaceContribution[] {
    return [...this.#surfaces.values()].sort((left, right) =>
      left.id.localeCompare(right.id));
  }

  navigation(): readonly GlobalNavigationContribution[] {
    return [...this.#navigation.values()].sort(compareNavigation);
  }
}
