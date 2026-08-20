import {
  assistantLaunchService,
  assistantProviderId,
  assistantSessionId,
  processesService,
  type AssistantLaunchErrorCode,
  type AssistantLaunchService,
  type AssistantProcessLaunch,
  type AssistantResourceExecuteInput,
  type AssistantResourceExecuteResult,
  type AssistantResourceReadInput,
  type AssistantResourceReadResult,
  type AssistantResourceWriteInput,
  type ModuleActivationContext,
  type ModuleManagedTerminalStartContext,
  type ProcessesErrorCode,
  type ProcessesService,
  type SemanticRequestOperation,
  type StartedAssistantSession,
} from "@shipctl/module-api";

import {
  getAssistantModels,
  readPiConfig,
  writePiSettings,
  type AssistantProviderPolicyResources,
} from "./assistantProviderPolicy";
import type {
  AssistantSessionRecord,
  PiConfig,
  PiSettings,
  SessionMode,
} from "./types";

type AssistantClientErrorCode = AssistantLaunchErrorCode | ProcessesErrorCode;

export class AssistantLaunchClientError extends Error {
  readonly code: AssistantClientErrorCode;

  constructor(code: AssistantClientErrorCode, message: string) {
    super(message);
    this.name = "AssistantLaunchClientError";
    this.code = code;
  }
}

async function execute<Input, Output, ErrorCode extends AssistantClientErrorCode>(
  operation: SemanticRequestOperation<Input, Output, ErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new AssistantLaunchClientError(
      outcome.result.error.code,
      outcome.result.error.message,
    );
  }
  return outcome.result.value;
}

export interface AssistantLaunchClient extends AssistantProviderPolicyResources {
  checkCommandExists(command: string): Promise<boolean>;
  getModelsForProvider(provider: string): Promise<readonly string[]>;
  spawnAssistantSession(
    request: {
      readonly provider: string;
      readonly launchRepoPath: string;
      readonly placementProjectPath: string;
      readonly label: string;
      readonly sessionMode: SessionMode;
      readonly model?: string;
      readonly launch: AssistantProcessLaunch;
      readonly initialSessionIdentity?: string;
    },
    context: ModuleManagedTerminalStartContext,
  ): Promise<StartedAssistantSession>;
  resumeAssistantSession(
    recordId: string,
    launch: AssistantProcessLaunch,
    context: ModuleManagedTerminalStartContext,
  ): Promise<StartedAssistantSession>;
  recordSessionIdentity(recordId: string, providerSessionId: string): Promise<AssistantSessionRecord>;
  failSessionCapture(recordId: string): Promise<AssistantSessionRecord>;
  updateSessionPlacement(recordId: string, projectPath: string): Promise<AssistantSessionRecord>;
  updateSessionLabel(recordId: string, label: string): Promise<AssistantSessionRecord>;
  discardSession(recordId: string): Promise<void>;
  rearmSession(recordId: string): Promise<void>;
  listRestorableSessions(): Promise<readonly AssistantSessionRecord[]>;
  takeStartupWarning(): Promise<string | null>;
  beginAssistantSessionPreservingShutdown(): Promise<void>;
  getPiConfig(): Promise<PiConfig>;
  savePiSettings(settings: PiSettings): Promise<void>;
}

export function createAssistantLaunchClient(
  service: AssistantLaunchService,
  processes: ProcessesService,
): AssistantLaunchClient {
  const resources: AssistantProviderPolicyResources = {
    readResource: (input: AssistantResourceReadInput): Promise<AssistantResourceReadResult> => (
      execute(service.readResource, input)
    ),
    writeResource: (input: AssistantResourceWriteInput): Promise<void> => (
      execute(service.writeResource, input)
    ),
    executeResource: (input: AssistantResourceExecuteInput): Promise<AssistantResourceExecuteResult> => (
      execute(service.executeResource, input)
    ),
  };
  const client: AssistantLaunchClient = {
    ...resources,
    checkCommandExists: async (command) => (
      await execute(processes.inspectCommand, { command })
    ).available,
    getModelsForProvider: (provider) => getAssistantModels(provider, resources),
    spawnAssistantSession: (request, terminal) => execute(service.startSession, {
      ...request,
      provider: assistantProviderId(request.provider),
      terminal,
    }),
    resumeAssistantSession: (recordId, launch, terminal) => execute(service.resumeSession, {
      recordId: assistantSessionId(recordId),
      launch,
      terminal,
    }),
    recordSessionIdentity: (recordId, providerSessionId) => execute(service.recordSessionIdentity, {
      recordId: assistantSessionId(recordId),
      providerSessionId,
    }),
    failSessionCapture: (recordId) => execute(service.markSessionIdentityFailed, {
      recordId: assistantSessionId(recordId),
    }),
    updateSessionPlacement: (recordId, placementProjectPath) => execute(
      service.recordSessionPlacement,
      { recordId: assistantSessionId(recordId), placementProjectPath },
    ),
    updateSessionLabel: (recordId, label) => execute(service.recordSessionLabel, {
      recordId: assistantSessionId(recordId),
      label,
    }),
    discardSession: async (recordId) => {
      await execute(service.discardSession, { recordId: assistantSessionId(recordId) });
    },
    rearmSession: async (recordId) => {
      await execute(service.rearmSession, { recordId: assistantSessionId(recordId) });
    },
    listRestorableSessions: () => execute(service.inspectRestorableSessions, {}),
    takeStartupWarning: () => execute(service.takeStartupWarning, {}),
    beginAssistantSessionPreservingShutdown: async () => {
      await execute(service.prepareForShutdown, {});
    },
    getPiConfig: () => readPiConfig(resources),
    savePiSettings: (settings) => writePiSettings(settings, resources),
  };
  return Object.freeze(client);
}

export function assistantLaunchClientFor(
  activation: ModuleActivationContext,
): AssistantLaunchClient {
  return createAssistantLaunchClient(
    activation.services.require(assistantLaunchService),
    activation.services.require(processesService),
  );
}
