import type {
  ModuleActivationContext,
  ModuleActivationIdentity,
  SemanticServiceReference,
} from "../protocol/semanticServices";

/** Host-side factory for one service implementation bound to one activation. */
export interface SemanticServiceProviderContext {
  readonly activation: ModuleActivationIdentity;
  readonly active: boolean;
  own: ModuleActivationContext["own"];
}

export interface SemanticServiceProvider<Service> {
  readonly service: SemanticServiceReference<Service>;
  bind(context: SemanticServiceProviderContext): Service;
}

export type AnySemanticServiceProvider = SemanticServiceProvider<unknown>;
