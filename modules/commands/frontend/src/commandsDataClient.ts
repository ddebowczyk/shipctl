import {
  pluginDataService,
  type ModuleActivationContext,
  type ModuleJsonValue,
  type PluginDataErrorCode,
  type PluginDataRevision,
  type PluginDataService,
  type SemanticRequestOperation,
} from "@shipctl/module-api";

export class CommandsDataError extends Error {
  constructor(readonly code: PluginDataErrorCode, message: string) {
    super(message);
    this.name = "CommandsDataError";
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, PluginDataErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new CommandsDataError(outcome.result.error.code, outcome.result.error.message);
  }
  return outcome.result.value;
}

export interface CommandsDataClient {
  read(projectId: string): Promise<ModuleJsonValue | null>;
  replace(projectId: string, value: ModuleJsonValue): Promise<void>;
  forget(projectId: string): void;
}

export function createCommandsDataClient(service: PluginDataService): CommandsDataClient {
  const revisions = new Map<string, PluginDataRevision | null>();
  const writes = new Map<string, Promise<void>>();

  const read = async (projectId: string) => {
    const record = await execute(service.readRecord, {
      scope: { kind: "project", projectId },
      key: "commands",
    });
    revisions.set(projectId, record?.revision ?? null);
    return record?.value ?? null;
  };

  return Object.freeze({
    read,
    async replace(projectId: string, value: ModuleJsonValue) {
      const previous = writes.get(projectId) ?? Promise.resolve();
      const write = previous.then(async () => {
        if (!revisions.has(projectId)) await read(projectId);
        const record = await execute(service.writeRecord, {
          scope: { kind: "project", projectId },
          key: "commands",
          expectedRevision: revisions.get(projectId) ?? null,
          schemaVersion: 1,
          value,
        });
        revisions.set(projectId, record.revision);
      });
      writes.set(projectId, write.catch(() => undefined));
      await write;
    },
    forget(projectId: string) {
      revisions.delete(projectId);
      writes.delete(projectId);
    },
  });
}

export function commandsDataClientFor(
  activation: ModuleActivationContext,
): CommandsDataClient {
  return createCommandsDataClient(activation.services.require(pluginDataService));
}

let activeClient: CommandsDataClient | null = null;

export function configureCommandsDataClient(client: CommandsDataClient | null): void {
  activeClient = client;
}

export function activeCommandsDataClient(): CommandsDataClient {
  if (!activeClient) throw new Error("Commands data service is unavailable");
  return activeClient;
}
