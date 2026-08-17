import type {
  ModuleActivationContext,
  ModuleId,
  PluginRuntimeInspection,
  ShipctlModule,
} from "@shipctl/module-api";

import { RuntimeReconciliationError } from "./liveReconciler.ts";

export interface RuntimeFamilyValidationInput {
  readonly modules: readonly ShipctlModule[];
  readonly activationContextsByModule: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly inspection: PluginRuntimeInspection;
  readonly expectedActivationIdsByModule: ReadonlyMap<string, string>;
}

function fail(
  code: string,
  message: string,
  moduleId?: string,
  activationId?: string,
): never {
  throw new RuntimeReconciliationError(code, message, { moduleId, activationId });
}

/** Validate the complete static plus dynamic graph before it can become public. */
export function assertCompleteRuntimeFamily(input: RuntimeFamilyValidationInput): void {
  const moduleIds = new Set<string>();
  for (const module of input.modules) {
    if (moduleIds.has(module.id)) {
      fail(
        "module.runtime.duplicate_module",
        `Runtime family contains module ${module.id} more than once`,
        module.id,
      );
    }
    moduleIds.add(module.id);
  }

  const activeByModule = new Map<string, string>();
  const activeById = new Map<string, string>();
  for (const activation of input.inspection.activations) {
    if (activation.status !== "active") continue;
    if (activeByModule.has(activation.moduleId)) {
      fail(
        "module.runtime.duplicate_activation",
        `Module ${activation.moduleId} has more than one active activation`,
        activation.moduleId,
        activation.activationId,
      );
    }
    if (activeById.has(activation.activationId)) {
      fail(
        "module.runtime.duplicate_activation",
        `Activation ${activation.activationId} is owned by more than one module`,
        activation.moduleId,
        activation.activationId,
      );
    }
    activeByModule.set(activation.moduleId, activation.activationId);
    activeById.set(activation.activationId, activation.moduleId);
  }

  for (const moduleId of moduleIds) {
    const activationId = activeByModule.get(moduleId);
    if (activationId === undefined || !input.activationContextsByModule.has(moduleId as ModuleId)) {
      fail(
        "module.runtime.incomplete_family",
        `Runtime family has no active context for module ${moduleId}`,
        moduleId,
        activationId,
      );
    }
  }
  for (const [moduleId, activationId] of activeByModule) {
    if (!moduleIds.has(moduleId)) {
      fail(
        "module.runtime.incomplete_family",
        `Active module ${moduleId} is absent from the public family`,
        moduleId,
        activationId,
      );
    }
  }
  if (input.activationContextsByModule.size !== moduleIds.size) {
    fail(
      "module.runtime.incomplete_family",
      "Runtime activation contexts do not match the public module family",
    );
  }

  for (const [moduleId, expectedActivationId] of input.expectedActivationIdsByModule) {
    const observedActivationId = activeByModule.get(moduleId);
    if (observedActivationId !== expectedActivationId) {
      fail(
        "module.runtime.activation_identity_mismatch",
        `Module ${moduleId} did not activate with its admitted artifact identity`,
        moduleId,
        observedActivationId ?? expectedActivationId,
      );
    }
  }

  const contributionOwners = new Set<string>();
  for (const contribution of input.inspection.contributions) {
    const key = `${contribution.family}:${contribution.id}`;
    if (contributionOwners.has(key)) {
      fail(
        "module.runtime.duplicate_contribution",
        `Contribution ${key} has more than one owner`,
        contribution.moduleId,
        contribution.ownerActivationId,
      );
    }
    contributionOwners.add(key);
    assertOwner(
      activeById,
      contribution.moduleId,
      contribution.ownerActivationId,
      `contribution ${key}`,
    );
  }

  const serviceOwners = new Set<string>();
  for (const service of input.inspection.services) {
    const key = `${service.id}@${service.version}`;
    if (serviceOwners.has(key)) {
      fail(
        "module.runtime.duplicate_service",
        `Semantic service ${key} has more than one owner`,
        service.moduleId,
        service.ownerActivationId,
      );
    }
    serviceOwners.add(key);
    assertOwner(
      activeById,
      service.moduleId,
      service.ownerActivationId,
      `semantic service ${key}`,
    );
  }

  for (const effect of input.inspection.effects) {
    assertOwner(
      activeById,
      effect.moduleId,
      effect.ownerActivationId,
      `effect ${effect.kind}:${effect.id}`,
    );
  }
}

function assertOwner(
  activeById: ReadonlyMap<string, string>,
  moduleId: string,
  activationId: string,
  subject: string,
): void {
  const ownerModuleId = activeById.get(activationId);
  if (ownerModuleId === undefined) {
    fail(
      "module.runtime.owner_missing",
      `Runtime ${subject} refers to inactive activation ${activationId}`,
      moduleId,
      activationId,
    );
  }
  if (ownerModuleId !== moduleId) {
    fail(
      "module.runtime.owner_mismatch",
      `Runtime ${subject} claims module ${moduleId}, but its activation belongs to ${ownerModuleId}`,
      moduleId,
      activationId,
    );
  }
}
