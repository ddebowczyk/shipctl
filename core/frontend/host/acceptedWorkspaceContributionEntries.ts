import type {
  ContributionId,
  ModuleActivationContext,
  ModuleActivationId,
  ModuleId,
} from "@shipctl/module-api";

import type { ActivatedWorkspaceContribution } from "./workspaceContributionCatalog.ts";

/**
 * Return an activation only when it is the exact accepted activation that
 * owned the contribution. Module IDs can be reused by a replacement.
 */
export function currentModuleActivation(
  moduleId: ModuleId,
  activationId: ModuleActivationId,
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): ModuleActivationContext | undefined {
  const activation = activations.get(moduleId);
  if (
    activation === undefined
    || activation.disposed
    || activation.identity.moduleId !== moduleId
    || activation.identity.activationId !== activationId
  ) {
    return undefined;
  }
  return activation;
}

/**
 * Select only entries whose original activation is still the current live
 * activation. A module ID alone is not sufficient after replacement.
 */
export function activeWorkspaceContributionEntries<
  T extends { readonly id: ContributionId; readonly moduleId: ModuleId },
>(
  entries: readonly ActivatedWorkspaceContribution<T>[],
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): readonly ActivatedWorkspaceContribution<T>[] {
  return entries.filter(({ contribution, owner }) => (
    contribution.moduleId === owner.moduleId
    && currentModuleActivation(owner.moduleId, owner.activationId, activations) !== undefined
  ));
}

/**
 * Select the current activation for a private renderer surface. Runtime-built
 * canvas entries carry an exact owner ID; the no-ID branch is only for the
 * legacy static compiler while it remains available outside the live path.
 */
export function currentCanvasSurfaceActivation(
  surface: {
    readonly moduleId: ModuleId;
    readonly ownerActivationId?: ModuleActivationId;
  },
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): ModuleActivationContext | undefined {
  if (surface.ownerActivationId !== undefined) {
    return currentModuleActivation(surface.moduleId, surface.ownerActivationId, activations);
  }
  const activation = activations.get(surface.moduleId);
  if (
    activation === undefined
    || activation.disposed
    || activation.identity.moduleId !== surface.moduleId
  ) {
    return undefined;
  }
  return activation;
}

/**
 * React identity for a lazily loaded host surface. A replacement may retain
 * its contribution ID, but it must never retain the previous activation's
 * component or error-boundary state.
 */
export function canvasSurfaceComponentKey(surface: {
  readonly id: ContributionId;
  readonly moduleId: ModuleId;
  readonly ownerActivationId?: ModuleActivationId;
}): string {
  return `${surface.moduleId}:${surface.ownerActivationId ?? "legacy"}:${surface.id}`;
}
