import type {
  ModuleActivationContext,
  ModuleActivationIdentity,
  SemanticServiceReference,
} from "../protocol/semanticServices";
import type { AcceptedPluginAdmission } from "../protocol/admission";

/** Host-side factory for one service implementation bound to one activation. */
export interface SemanticServiceProviderContext {
  readonly activation: ModuleActivationIdentity;
  /**
   * Trusted host binding for this provider's own activation. It is absent for
   * host/bootstrap activations and is never exposed through ModuleActivationContext.
   */
  readonly acceptedAdmission: AcceptedPluginAdmission | null;
  readonly active: boolean;
  own: ModuleActivationContext["own"];
}

export interface SemanticServiceProvider<Service> {
  readonly service: SemanticServiceReference<Service>;
  bind(context: SemanticServiceProviderContext): Service;
}

export type AnySemanticServiceProvider = SemanticServiceProvider<unknown>;
