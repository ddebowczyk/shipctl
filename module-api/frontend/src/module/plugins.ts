import type { AnySemanticServiceProvider } from "../host/semanticServices";
import type { ModuleActivationContext, SemanticServiceReference } from "../protocol/semanticServices";
import type { ModuleDeactivation, ShipctlModule } from "./module";

export type ShipctlPluginRole = "headless" | "presentation" | "compound";

/**
 * Public application definition. Cordis is an implementation detail of the
 * trusted host and must never appear in this contract.
 */
interface ShipctlPluginDefinitionBase {
  readonly role: ShipctlPluginRole;
  readonly requires?: readonly SemanticServiceReference<unknown>[];
  readonly provides?: readonly AnySemanticServiceProvider[];
  /** Stable background responsibilities which activation must register by ID. */
  readonly backgroundEffects?: readonly string[];
}

/** The direct, activation-owned public plugin contract. */
export interface DirectShipctlPluginDefinition extends ShipctlPluginDefinitionBase {
  readonly id: ShipctlModule["id"];
  readonly version: string;
  /** Runtime grants are checked against the accepted artifact admission. */
  readonly requiredGrants?: readonly string[];
  activate(context: ModuleActivationContext): void | ModuleDeactivation | Promise<void | ModuleDeactivation>;
  /** Runs in accepted plugin order before the host signals native shutdown. */
  beforeShutdown?(context: ModuleActivationContext): void | Promise<void>;
}

/**
 * Transitional internal shape for artifacts not yet converted to direct
 * registrations. The Cordis adapter is the sole consumer and is deleted when
 * the last artifact conversion lands.
 */
export interface LegacyShipctlPluginDefinition extends ShipctlPluginDefinitionBase {
  readonly module: ShipctlModule;
}

export type ShipctlPluginDefinition =
  | DirectShipctlPluginDefinition
  | LegacyShipctlPluginDefinition;

/** Pure declaration helper. Importing a plugin never activates it. */
export function defineShipctlPlugin<Definition extends ShipctlPluginDefinition>(
  definition: Definition,
): Definition {
  return Object.freeze({ ...definition }) as unknown as Definition;
}

export type PluginActivationStatus = "preparing" | "active" | "failed" | "disposed";

export type PluginContributionFamily =
  | "command"
  | "configuration"
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

export interface PluginContributionDeclaration {
  readonly family: PluginContributionFamily;
  readonly id: string;
  readonly schemaVersion: number;
}

/** Closed application declaration carried by artifact manifest schema v2. */
export interface PluginArtifactDeclarations {
  readonly schemaVersion: 1;
  readonly role: ShipctlPluginRole;
  readonly requiredServices: readonly {
    readonly id: string;
    readonly version: number;
  }[];
  readonly providedServices: readonly {
    readonly id: string;
    readonly version: number;
  }[];
  readonly backgroundEffects: readonly string[];
  readonly contributions: readonly PluginContributionDeclaration[];
}

export type PluginEffectKind =
  | "activation"
  | "background"
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
