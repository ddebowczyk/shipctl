import type { AnySemanticServiceProvider } from "../host/semanticServices";
import type { ModuleActivationContext, SemanticServiceReference } from "../protocol/semanticServices";
import type { ShipctlModule } from "./module";

export type ShipctlPluginRole = "headless" | "presentation" | "compound";

/**
 * Public application definition. Cordis is an implementation detail of the
 * trusted host and must never appear in this contract.
 */
export interface ShipctlPluginDefinition {
  readonly module: ShipctlModule;
  readonly role: ShipctlPluginRole;
  readonly requires?: readonly SemanticServiceReference<unknown>[];
  readonly provides?: readonly AnySemanticServiceProvider[];
}

/** Pure declaration helper. Importing a plugin never activates it. */
export function defineShipctlPlugin(
  definition: ShipctlPluginDefinition,
): ShipctlPluginDefinition {
  return Object.freeze({ ...definition });
}

export type PluginActivationStatus = "preparing" | "active" | "failed" | "disposed";

export type PluginContributionFamily =
  | "command"
  | "global-navigation"
  | "global-surface"
  | "message-graph"
  | "panel"
  | "project-action"
  | "project-facts"
  | "project-import"
  | "project-layout"
  | "project-navigation"
  | "scheduled-task"
  | "settings"
  | "sidebar"
  | "skills-provider"
  | "terminal-presentation";

export interface PluginContributionInspection {
  readonly ownerActivationId: string;
  readonly moduleId: string;
  readonly family: PluginContributionFamily;
  readonly id: string;
}

export type PluginEffectKind =
  | "activation"
  | "contribution"
  | "owned-lease"
  | "scheduled-task"
  | "semantic-service";

export interface PluginEffectInspection {
  readonly ownerActivationId: string;
  readonly moduleId: string;
  readonly kind: PluginEffectKind;
  readonly id: string;
}

export interface PluginActivationInspection {
  readonly moduleId: string;
  readonly activationId: string;
  readonly role: ShipctlPluginRole;
  readonly status: PluginActivationStatus;
}

export interface PluginRuntimeInspection {
  readonly activations: readonly PluginActivationInspection[];
  readonly contributions: readonly PluginContributionInspection[];
  readonly effects: readonly PluginEffectInspection[];
  readonly services: readonly {
    readonly ownerActivationId: string;
    readonly moduleId: string;
    readonly id: string;
    readonly version: number;
  }[];
}

export interface PluginActivationView {
  readonly context: ModuleActivationContext;
  readonly definition: ShipctlPluginDefinition;
}
