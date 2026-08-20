import {
  MESSAGE_CONTRACT_SCHEMA_VERSION,
  isRuntimeOperation,
  parseCapabilityManifest,
  parseMessageDeclarations,
  parseRuntimeOperationRequest,
  parseRuntimeOperationResponse,
  runtimeOperationFailure,
  runtimeOperationUnavailable,
  type AcceptedPluginAdmission,
  type CapabilityDefinition,
  type CapabilityManifest,
  type CapabilityPortDefinition,
  type CapabilityPortHandler,
  type DirectShipctlPluginDefinition,
  type MessageDeclarations,
  type ModuleMessageContributions,
  type PluginArtifactDeclarations,
  type RuntimeOperation,
  type RuntimeOperationRequest,
  type RuntimeOperationResponse,
} from "@shipctl/module-api";

import { activatePluginDefinitionsObserved } from "./cordis/staticPluginRuntime.ts";
import {
  collectPluginArtifactDeclarations,
  parsePluginArtifactDeclarations,
  samePluginArtifactDeclarationMetadata,
  samePluginArtifactDeclarations,
} from "./pluginArtifactDeclarations.ts";
import type { RegisteredPluginContributions } from "./pluginContributionRegistry.ts";
import { SemanticServiceRegistry } from "./semanticServiceRuntime.ts";

export type HeadlessRuntimeErrorCode =
  | "headless.runtime.invalid-artifact"
  | "headless.runtime.activation-failed";

/** Stable, non-product failure reported while preparing an offline runtime. */
export class HeadlessRuntimeError extends Error {
  readonly code: HeadlessRuntimeErrorCode;

  constructor(code: HeadlessRuntimeErrorCode, message: string) {
    super(message);
    this.name = "HeadlessRuntimeError";
    this.code = code;
  }
}

/**
 * A direct definition accompanied by the immutable facts that were admitted
 * before its code was evaluated. Artifact decoding and signature validation
 * remain a packaged-runner responsibility.
 */
export interface HeadlessRuntimeArtifact {
  readonly definition: DirectShipctlPluginDefinition;
  readonly admission: AcceptedPluginAdmission;
  readonly capabilities: unknown;
}

export interface HeadlessRuntimeOptions {
  readonly artifacts: readonly HeadlessRuntimeArtifact[];
  /** The headless composition supplies only the semantic services it permits. */
  readonly semanticServices: SemanticServiceRegistry;
  /** Host contracts that an admitted artifact may bind without redefining. */
  readonly knownCapabilities?: readonly CapabilityDefinition[];
}

export interface HeadlessRuntimeInvocation {
  readonly capabilityId: string;
  readonly portId: string;
  readonly payload: unknown;
}

/**
 * Non-publishing runtime for the same request/response ports used by online
 * CapabilityInvocation. It deliberately exposes no UI, native host services,
 * scheduler, or long-running effect surface.
 */
export interface HeadlessRuntime {
  readonly activeModuleIds: ReadonlySet<string>;
  invoke(invocation: HeadlessRuntimeInvocation): Promise<RuntimeOperationResponse>;
  dispose(): Promise<void>;
}

interface PreparedArtifact {
  readonly definition: DirectShipctlPluginDefinition;
  readonly admission: AcceptedPluginAdmission;
  readonly application: PluginArtifactDeclarations;
  readonly messages: MessageDeclarations;
  readonly capabilities: CapabilityManifest;
}

interface HeadlessRoute {
  readonly capability: CapabilityDefinition;
  readonly port: CapabilityPortDefinition;
  readonly moduleId: string;
  readonly handler: CapabilityPortHandler<unknown, unknown>;
}

function failure(message: string): HeadlessRuntimeError {
  return new HeadlessRuntimeError("headless.runtime.invalid-artifact", message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameMessage(
  left: { readonly id: string; readonly version: number },
  right: { readonly id: string; readonly version: number },
): boolean {
  return left.id === right.id && left.version === right.version;
}

function sameCapability(
  left: CapabilityDefinition,
  right: { readonly id: string; readonly version: string; readonly definitionDigestSha256: string },
): boolean {
  return left.id === right.id
    && left.version === right.version
    && left.definitionDigestSha256 === right.definitionDigestSha256;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function sameData(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function declarationsFor(messages: ModuleMessageContributions): MessageDeclarations {
  return parseMessageDeclarations({
    schemaVersion: MESSAGE_CONTRACT_SCHEMA_VERSION,
    provides: messages.provides ?? [],
    handles: (messages.handles ?? []).map((handler) => ({
      endpoint: { id: handler.channel.id, message: handler.channel.message },
      capacity: handler.capacity,
      requiredGrant: handler.requiredGrant,
      schedulerAllowed: handler.schedulerAllowed,
    })),
    publishes: (messages.publishes ?? []).map((publisher) => ({
      endpoint: { id: publisher.topic.id, message: publisher.topic.message },
      capacity: publisher.capacity,
      requiredGrant: publisher.requiredGrant,
      schedulerAllowed: publisher.schedulerAllowed,
    })),
    subscribes: (messages.subscribes ?? []).map((subscription) => ({
      id: subscription.topic.id,
      message: subscription.topic.message,
    })),
    ports: (messages.ports ?? []).map((handler) => ({
      id: handler.port.id,
      request: handler.port.request,
      response: handler.port.response,
      capacity: handler.capacity,
      requiredGrant: handler.requiredGrant,
      schedulerAllowed: handler.schedulerAllowed,
    })),
  });
}

function nonMessageFamilies(contributions: RegisteredPluginContributions): readonly string[] {
  const families: readonly (readonly [string, readonly unknown[]])[] = [
    ["commands", contributions.commands],
    ["configuration", contributions.configuration],
    ["globalNavigation", contributions.globalNavigation],
    ["globalSurfaces", contributions.globalSurfaces],
    ["panels", contributions.panels],
    ["projectActions", contributions.projectActions],
    ["projectFacts", contributions.projectFacts],
    ["projectImports", contributions.projectImports],
    ["projectLayouts", contributions.projectLayouts],
    ["projectNavigation", contributions.projectNavigation],
    ["scheduledTasks", contributions.scheduledTasks],
    ["settings", contributions.settings],
    ["sidebars", contributions.sidebars],
    ["skillsProviders", contributions.skillsProviders],
    ["terminalPresentations", contributions.terminalPresentations],
  ];
  return families.filter(([, values]) => values.length > 0).map(([family]) => family);
}

function prepareArtifact(
  artifact: HeadlessRuntimeArtifact,
  knownCapabilities: readonly CapabilityDefinition[],
): PreparedArtifact {
  const { definition, admission } = artifact;
  if (
    definition.role !== "headless"
    || typeof definition.id !== "string"
    || definition.id.length === 0
    || typeof definition.version !== "string"
    || definition.version.length === 0
  ) {
    throw failure("Headless execution accepts only named direct headless plugins.");
  }
  if (
    admission.artifact.moduleId !== definition.id
    || admission.artifact.version !== definition.version
    || !/^[a-f0-9]{64}$/.test(admission.artifact.contentDigest)
    || !sameStrings(definition.requiredGrants ?? [], admission.effectiveGrants)
  ) {
    throw failure(`Accepted admission does not bind ${definition.id} exactly.`);
  }
  if (admission.application === undefined || admission.messages === undefined) {
    throw failure(`Accepted artifact ${definition.id} lacks its application or message declaration.`);
  }

  const application = parsePluginArtifactDeclarations(admission.application);
  const messages = parseMessageDeclarations(admission.messages);
  if (!samePluginArtifactDeclarationMetadata(application, definition)) {
    throw failure(`Accepted application metadata does not match ${definition.id}.`);
  }
  if (
    (definition.backgroundEffects?.length ?? 0) > 0
    || application.backgroundEffects.length > 0
  ) {
    throw failure(`Headless artifact ${definition.id} declares a background effect.`);
  }
  if (
    messages.handles.length > 0
    || messages.publishes.length > 0
    || messages.subscribes.length > 0
  ) {
    throw failure(`Headless artifact ${definition.id} declares a publishing message surface.`);
  }

  return {
    definition,
    admission,
    application,
    messages,
    capabilities: parseCapabilityManifest(artifact.capabilities, knownCapabilities),
  };
}

function capabilityFor(
  manifest: CapabilityManifest,
  knownCapabilities: readonly CapabilityDefinition[],
  reference: { readonly id: string; readonly version: string; readonly definitionDigestSha256: string },
): CapabilityDefinition {
  const capability = [...manifest.definitions, ...knownCapabilities]
    .find((candidate) => sameCapability(candidate, reference));
  if (capability === undefined) {
    throw failure(`Capability ${reference.id}@${reference.version} is not available to headless execution.`);
  }
  return capability;
}

function routesFor(
  artifact: PreparedArtifact,
  registered: RegisteredPluginContributions,
  knownCapabilities: readonly CapabilityDefinition[],
): readonly HeadlessRoute[] {
  const families = nonMessageFamilies(registered);
  if (families.length > 0 || registered.messages.length !== 1) {
    throw failure(
      `Headless artifact ${artifact.definition.id} must register exactly one message graph and no ${
        families.length === 0 ? "other contribution" : families.join(", ")
      }.`,
    );
  }
  const messages = registered.messages[0];
  if (messages === undefined) throw failure(`Headless artifact ${artifact.definition.id} has no message graph.`);
  const runtimeDeclarations = declarationsFor(messages);
  if (!sameData(artifact.messages, runtimeDeclarations)) {
    throw failure(`Runtime message registrations for ${artifact.definition.id} differ from admission.`);
  }

  const handlers = messages.ports ?? [];
  const handlersByPort = new Map(handlers.map((handler) => [handler.port.id, handler]));
  if (handlersByPort.size !== handlers.length) {
    throw failure(`Headless artifact ${artifact.definition.id} registers a duplicate request port.`);
  }

  const declaredPortIds = new Set<string>();
  const routes: HeadlessRoute[] = [];
  for (const provider of artifact.capabilities.providers) {
    if (
      provider.surfaces.events.length > 0
      || provider.surfaces.topics.length > 0
      || provider.surfaces.streams.length > 0
    ) {
      throw failure(`Headless provider ${provider.capability.id} declares a non-request surface.`);
    }
    const capability = capabilityFor(artifact.capabilities, knownCapabilities, provider.capability);
    if (!capability.agentAccess.inspect) {
      throw failure(`Headless provider ${capability.id} is not agent-inspectable.`);
    }
    for (const portId of provider.surfaces.ports) {
      const port = capability.ports.find((candidate) => candidate.id === portId);
      const declaration = artifact.messages.ports.find((candidate) => candidate.id === portId);
      const handler = handlersByPort.get(portId);
      if (
        port === undefined
        || declaration === undefined
        || handler === undefined
        || !capability.agentAccess.invoke.includes(portId)
        || !sameMessage(port.request, declaration.request)
        || !sameMessage(port.response, declaration.response)
        || !sameMessage(port.request, handler.port.request)
        || !sameMessage(port.response, handler.port.response)
        || !artifact.admission.effectiveGrants.includes(declaration.requiredGrant)
      ) {
        throw failure(`Headless provider ${capability.id} does not bind ${portId} exactly.`);
      }
      declaredPortIds.add(portId);
      routes.push({
        capability,
        port,
        moduleId: artifact.definition.id,
        handler,
      });
    }
  }
  for (const handler of handlers) {
    if (!declaredPortIds.has(handler.port.id)) {
      throw failure(`Headless artifact ${artifact.definition.id} exposes an unbound request port.`);
    }
  }
  return routes;
}

function operationFromPayload(payload: unknown): RuntimeOperation {
  if (
    payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && isRuntimeOperation((payload as Record<string, unknown>).operation)
  ) {
    return (payload as Record<string, unknown>).operation as RuntimeOperation;
  }
  return "workspace.inspect";
}

function requestOrFailure(
  payload: unknown,
): RuntimeOperationRequest | RuntimeOperationResponse {
  try {
    return parseRuntimeOperationRequest(payload);
  } catch {
    return runtimeOperationFailure(
      operationFromPayload(payload),
      "runtime.operation.invalid-request",
      "Runtime operation request is invalid.",
    );
  }
}

class ActiveHeadlessRuntime implements HeadlessRuntime {
  readonly activeModuleIds: ReadonlySet<string>;
  readonly #routesByCapability: ReadonlyMap<string, readonly HeadlessRoute[]>;
  readonly #activation: Awaited<ReturnType<typeof activatePluginDefinitionsObserved>>;
  #disposed = false;

  constructor(
    activeModuleIds: ReadonlySet<string>,
    routes: readonly HeadlessRoute[],
    activation: Awaited<ReturnType<typeof activatePluginDefinitionsObserved>>,
  ) {
    this.activeModuleIds = new Set(activeModuleIds);
    this.#activation = activation;
    const byCapability = new Map<string, HeadlessRoute[]>();
    for (const route of routes) {
      const existing = byCapability.get(route.capability.id) ?? [];
      existing.push(route);
      byCapability.set(route.capability.id, existing);
    }
    this.#routesByCapability = byCapability;
  }

  async invoke(invocation: HeadlessRuntimeInvocation): Promise<RuntimeOperationResponse> {
    const request = requestOrFailure(invocation.payload);
    if ("status" in request) return request;
    if (this.#disposed) {
      return runtimeOperationUnavailable(
        request.operation,
        "The headless runtime is no longer active.",
      );
    }
    const routes = (this.#routesByCapability.get(invocation.capabilityId) ?? [])
      .filter((route) => route.port.id === invocation.portId);
    if (routes.length !== 1) {
      return runtimeOperationUnavailable(
        request.operation,
        "The requested capability port is unavailable in the headless runtime.",
      );
    }
    try {
      return parseRuntimeOperationResponse(await routes[0]!.handler.handle(request));
    } catch {
      return runtimeOperationFailure(
        request.operation,
        "runtime.operation.failed",
        "Runtime operation failed.",
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.#activation.beforeShutdown();
    } finally {
      await this.#activation.deactivate();
    }
  }
}

/**
 * Activates a private, message-only capability graph. The caller must supply
 * immutable admission facts; no artifact outside that admitted set is loaded.
 */
export async function createHeadlessRuntime(
  options: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  const knownCapabilities = options.knownCapabilities ?? [];
  const artifacts = options.artifacts.map((artifact) => prepareArtifact(artifact, knownCapabilities));
  const moduleIds = new Set<string>();
  for (const artifact of artifacts) {
    if (moduleIds.has(artifact.definition.id)) {
      throw failure(`Headless artifact ${artifact.definition.id} is admitted more than once.`);
    }
    moduleIds.add(artifact.definition.id);
  }

  const activationIds = new Map<string, string>();
  const admissions = new Map<string, AcceptedPluginAdmission>();
  for (const artifact of artifacts) {
    activationIds.set(
      artifact.definition.id,
      `${artifact.definition.id}@${artifact.definition.version}#${artifact.admission.artifact.contentDigest}`,
    );
    admissions.set(artifact.definition.id, artifact.admission);
  }

  const activation = await activatePluginDefinitionsObserved(
    undefined,
    artifacts.map((artifact) => artifact.definition),
    activationIds,
    options.semanticServices,
    false,
    admissions,
  );
  try {
    if (activation.failures.length > 0 || activation.activeModuleIds.size !== artifacts.length) {
      throw new HeadlessRuntimeError(
        "headless.runtime.activation-failed",
        activation.failures[0]?.message ?? "Headless artifact activation did not complete.",
      );
    }

    const inspection = activation.inspect();
    const routes = artifacts.flatMap((artifact) => {
      const registered = activation.contributionsByModule.get(artifact.definition.id);
      if (registered === undefined) {
        throw failure(`Headless artifact ${artifact.definition.id} has no activation snapshot.`);
      }
      const runtimeApplication = collectPluginArtifactDeclarations(
        artifact.definition,
        inspection.contributions.filter((entry) => entry.moduleId === artifact.definition.id),
      );
      if (!samePluginArtifactDeclarations(artifact.application, runtimeApplication)) {
        throw failure(`Runtime contributions for ${artifact.definition.id} differ from admission.`);
      }
      return routesFor(artifact, registered, knownCapabilities);
    });
    return new ActiveHeadlessRuntime(activation.activeModuleIds, routes, activation);
  } catch (error) {
    await activation.deactivate().catch(() => undefined);
    throw error;
  }
}
