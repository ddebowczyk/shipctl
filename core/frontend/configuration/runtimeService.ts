import {
  configurationService,
  pluginDataService,
  type AcceptedPluginAdmission,
  type ConfigurationContribution,
  type ConfigurationService,
  type ConfigurationServiceErrorCode,
  type HostConfigurationInspection as PublicHostConfigurationInspection,
  type HostConfigurationResolution as PublicHostConfigurationResolution,
  type InspectConfigurationInput,
  type ModuleJsonValue,
  type PluginDataService,
  type ResolveConfigurationInput,
  type SemanticCorrelationId,
  type SemanticRequestOperation,
  type SemanticRequestOptions,
  type SemanticRequestOutcome,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
  type UpdateConfigurationInput,
} from "@shipctl/module-api";
import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "@shipctl/core/runtime/headless";

import {
  HOST_CONFIGURATION,
  HOST_CONFIGURATION_CONTRIBUTIONS,
  HOST_CONFIGURATION_MODULE_ID,
  type HostConfigurationKey,
  type HostConfigurationValue,
} from "./schemas.ts";
import {
  ConfigurationRuntime,
  ConfigurationRuntimeError,
  type ConfigurationInspection,
  type ConfigurationResolution,
  type LegacyConfigurationReader,
} from "./runtime.ts";

const HOST_CONFIGURATION_GRANTS = [
  "plugin-data.read",
  "plugin-data.write",
  "plugin-data.migrate",
] as const;

const HOST_CONFIGURATION_ADMISSION: AcceptedPluginAdmission = Object.freeze({
  artifact: Object.freeze({
    contentDigest: "0".repeat(64),
    entryUrl: "shipctl://trusted-host/configuration",
    moduleId: HOST_CONFIGURATION_MODULE_ID,
    version: "1",
  }),
  effectiveGrants: Object.freeze([...HOST_CONFIGURATION_GRANTS]),
});

const GLOBAL_SCOPE = { kind: "global" } as const;

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED: SemanticServiceError<ConfigurationServiceErrorCode> = Object.freeze({
  code: "configuration.cancelled",
  message: "Configuration request was cancelled.",
  retryable: false,
});

const DISPOSED: SemanticServiceError<ConfigurationServiceErrorCode> = Object.freeze({
  code: "configuration.activation-disposed",
  message: "Configuration activation is disposed.",
  retryable: false,
});

let nextRequest = 1;

function requestId(): SemanticCorrelationId {
  const id = `configuration-request#${nextRequest}`;
  nextRequest += 1;
  return id as SemanticCorrelationId;
}

export interface HostConfigurationRuntime {
  inspect<Key extends HostConfigurationKey>(
    key: Key,
  ): Promise<ConfigurationInspection<HostConfigurationValue<Key>>>;
  resolve<Key extends HostConfigurationKey>(
    key: Key,
  ): Promise<ConfigurationResolution<HostConfigurationValue<Key>>>;
  update<Key extends HostConfigurationKey>(
    key: Key,
    value: HostConfigurationValue<Key>,
  ): Promise<ConfigurationResolution<HostConfigurationValue<Key>>>;
  dispose(): Promise<void>;
}

export interface CreateHostConfigurationRuntimeOptions {
  /** A host-selected durable provider; headless callers supply an in-memory one. */
  readonly pluginDataServiceProvider: SemanticServiceProvider<PluginDataService>;
  /** Compatibility reads are explicit so this runtime has no native dependency. */
  readonly legacy: LegacyConfigurationReader;
}

export interface HostConfigurationServiceProviderOptions {
  readonly runtime: HostConfigurationRuntime;
}

function contribution<Key extends HostConfigurationKey>(
  key: Key,
): ConfigurationContribution<HostConfigurationValue<Key>> {
  return HOST_CONFIGURATION[key] as unknown as ConfigurationContribution<HostConfigurationValue<Key>>;
}

function failure(cause: unknown): SemanticServiceError<ConfigurationServiceErrorCode> {
  if (cause instanceof ConfigurationRuntimeError) {
    const diagnostic = cause.diagnostic;
    const details: ModuleJsonValue = diagnostic === undefined
      ? { code: cause.code }
      : {
        code: cause.code,
        diagnostic: {
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        },
      };
    return {
      code: "configuration.failed",
      message: cause.message,
      retryable: false,
      details,
    };
  }
  return {
    code: "configuration.failed",
    message: cause instanceof Error ? cause.message : "Configuration operation failed.",
    retryable: false,
  };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  handle: (input: Input) => Promise<Output>,
): SemanticRequestOperation<Input, Output, ConfigurationServiceErrorCode> {
  return Object.freeze({
    policy: POLICY,
    async execute(
      input: Input,
      options?: SemanticRequestOptions,
    ): Promise<SemanticRequestOutcome<Output, ConfigurationServiceErrorCode>> {
      const correlationId = requestId();
      if (!context.active) {
        return { correlationId, result: { ok: false, error: DISPOSED } };
      }
      if (options?.cancellation?.cancelled) {
        return { correlationId, result: { ok: false, error: CANCELLED } };
      }
      try {
        return { correlationId, result: { ok: true, value: await handle(input) } };
      } catch (cause) {
        return { correlationId, result: { ok: false, error: failure(cause) } };
      }
    },
  });
}

function inspection<Key extends HostConfigurationKey>(
  key: Key,
  value: ConfigurationInspection<HostConfigurationValue<Key>>,
): PublicHostConfigurationInspection {
  switch (value.state) {
    case "stored":
    case "migration":
      return { key, state: value.state, value: value.value, record: value.record };
    case "default":
    case "legacy":
      return { key, state: value.state, value: value.value };
    case "invalid":
      return {
        key,
        state: "invalid",
        diagnostic: value.diagnostic,
        ...(value.record === undefined ? {} : { record: value.record }),
      };
  }
}

function resolution<Key extends HostConfigurationKey>(
  key: Key,
  value: ConfigurationResolution<HostConfigurationValue<Key>>,
): PublicHostConfigurationResolution {
  return { key, record: value.record, value: value.value, changed: value.changed };
}

/**
 * Construct the trusted host configuration semantics without selecting a
 * native transport. This is safe for the in-memory headless runtime.
 */
export function createHostConfigurationRuntime(
  options: CreateHostConfigurationRuntimeOptions,
): HostConfigurationRuntime {
  const services = new SemanticServiceRegistry([options.pluginDataServiceProvider]);
  const activation = services.activate(
    createModuleActivationIdentity(HOST_CONFIGURATION_MODULE_ID, "1", "configuration"),
    HOST_CONFIGURATION_ADMISSION,
  );
  for (const value of HOST_CONFIGURATION_CONTRIBUTIONS) {
    activation.context.contributions.configuration.register(value);
  }
  const runtime = new ConfigurationRuntime({
    ownerModuleId: HOST_CONFIGURATION_MODULE_ID,
    contributions: activation.contributions.snapshot().configuration,
    pluginData: activation.context.services.require(pluginDataService),
    legacy: options.legacy,
  });

  let disposed = false;
  const checkActive = () => {
    if (disposed) throw new Error("Host configuration runtime is disposed");
  };
  return Object.freeze({
    inspect: async <Key extends HostConfigurationKey>(key: Key) => {
      checkActive();
      return runtime.inspect(contribution(key), GLOBAL_SCOPE);
    },
    resolve: async <Key extends HostConfigurationKey>(key: Key) => {
      checkActive();
      return runtime.resolve(contribution(key), GLOBAL_SCOPE);
    },
    update: async <Key extends HostConfigurationKey>(
      key: Key,
      value: HostConfigurationValue<Key>,
    ) => {
      checkActive();
      return runtime.update(contribution(key), GLOBAL_SCOPE, value as ModuleJsonValue);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await activation.dispose();
    },
  });
}

/**
 * Public, data-only configuration capability. It delegates to a caller-owned
 * trusted runtime and never exposes configuration contribution callbacks.
 */
export function createHostConfigurationServiceProvider(
  options: HostConfigurationServiceProviderOptions,
): SemanticServiceProvider<ConfigurationService> {
  return {
    service: configurationService,
    bind(context) {
      const { runtime } = options;
      return Object.freeze({
        inspectConfiguration: request<InspectConfigurationInput, PublicHostConfigurationInspection>(
          context,
          async ({ key }) => inspection(key, await runtime.inspect(key)),
        ),
        resolveConfiguration: request<ResolveConfigurationInput, PublicHostConfigurationResolution>(
          context,
          async ({ key }) => resolution(key, await runtime.resolve(key)),
        ),
        updateConfiguration: request<UpdateConfigurationInput, PublicHostConfigurationResolution>(
          context,
          async ({ key, value }) => resolution(
            key,
            await runtime.update(key, value as HostConfigurationValue<typeof key>),
          ),
        ),
      });
    },
  };
}
