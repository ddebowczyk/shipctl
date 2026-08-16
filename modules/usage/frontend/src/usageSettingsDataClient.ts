import {
  pluginDataService,
  type ModuleActivationContext,
  type ModuleJsonValue,
  type PluginDataErrorCode,
  type PluginDataRevision,
  type PluginDataService,
  type SemanticRequestOperation,
} from "@shipctl/module-api";

export class UsageSettingsDataError extends Error {
  constructor(readonly code: PluginDataErrorCode, message: string) {
    super(message);
    this.name = "UsageSettingsDataError";
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, PluginDataErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new UsageSettingsDataError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

export interface UsageSettingsDataClient {
  read(): Promise<ModuleJsonValue | null>;
  replace(value: ModuleJsonValue): Promise<void>;
}

export function createUsageSettingsDataClient(
  service: PluginDataService,
): UsageSettingsDataClient {
  let revision: PluginDataRevision | null | undefined;
  let writes: Promise<void> = Promise.resolve();

  const read = async () => {
    const record = await execute(service.readRecord, {
      scope: { kind: "global" },
      key: "settings",
    });
    revision = record?.revision ?? null;
    return record?.value ?? null;
  };

  return Object.freeze({
    read,
    async replace(value: ModuleJsonValue) {
      const write = writes.then(async () => {
        if (revision === undefined) await read();
        const record = await execute(service.writeRecord, {
          scope: { kind: "global" },
          key: "settings",
          expectedRevision: revision ?? null,
          schemaVersion: 1,
          value,
        });
        revision = record.revision;
      });
      writes = write.catch(() => undefined);
      await write;
    },
  });
}

export function usageSettingsDataClientFor(
  activation: ModuleActivationContext,
): UsageSettingsDataClient {
  return createUsageSettingsDataClient(activation.services.require(pluginDataService));
}
