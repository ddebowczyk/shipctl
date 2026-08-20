import type { PluginArtifactDeclarations } from "../module/plugins";
import type { ModuleId } from "./panels";
import type { MessageDeclarations } from "./messages";

/** Immutable identity of the exact artifact accepted by the trusted host. */
export interface AcceptedPluginArtifactIdentity {
  readonly contentDigest: string;
  readonly entryUrl: string;
  readonly moduleId: ModuleId;
  readonly version: string;
}

/**
 * Host-side binding created from a verified artifact candidate.
 *
 * It deliberately does not belong to ModuleActivationContext. A provider can
 * use the binding for its own activation, but plugin activation code cannot
 * manufacture authority or inspect another activation's admission.
 */
export interface AcceptedPluginAdmission {
  readonly artifact: AcceptedPluginArtifactIdentity;
  readonly effectiveGrants: readonly string[];
  readonly application?: PluginArtifactDeclarations;
  readonly messages?: MessageDeclarations;
}
