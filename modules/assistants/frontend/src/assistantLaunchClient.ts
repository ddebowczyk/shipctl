import {
  assistantLaunchService,
  assistantProviderId,
  assistantSessionId,
  processesService,
  type AssistantLaunchErrorCode,
  type AssistantLaunchService,
  type AssistantProviderSettings,
  type ModuleActivationContext,
  type ModuleManagedTerminalStartContext,
  type ProcessesErrorCode,
  type ProcessesService,
  type SemanticRequestOperation,
  type StartedAssistantSession,
} from "@shipctl/module-api";

import type {
  AssistantSessionRecord,
  PiConfig,
  PiSettings,
  RestorableAssistantProvider,
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

export interface AssistantLaunchClient {
  checkCommandExists(command: string): Promise<boolean>;
  getModelsForProvider(provider: string): Promise<readonly string[]>;
  spawnAssistantSession(
    request: {
      readonly provider: RestorableAssistantProvider;
      readonly launchRepoPath: string;
      readonly placementProjectPath: string;
      readonly label: string;
      readonly sessionMode: SessionMode;
      readonly model?: string;
    },
    context: ModuleManagedTerminalStartContext,
  ): Promise<StartedAssistantSession>;
  resumeAssistantSession(
    recordId: string,
    context: ModuleManagedTerminalStartContext,
  ): Promise<StartedAssistantSession>;
  tryCaptureSessionIdentity(recordId: string): Promise<AssistantSessionRecord | null>;
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
  const piProvider = assistantProviderId("pi");
  const client: AssistantLaunchClient = {
    checkCommandExists: async (command) => (
      await execute(processes.inspectCommand, { command })
    ).available,
    getModelsForProvider: async (provider) => (
      await execute(service.inspectModels, { provider: assistantProviderId(provider) })
    ).models,
    spawnAssistantSession: (request, terminal) => execute(service.startSession, {
      ...request,
      provider: assistantProviderId(request.provider),
      terminal,
    }),
    resumeAssistantSession: (recordId, terminal) => execute(service.resumeSession, {
      recordId: assistantSessionId(recordId),
      terminal,
    }),
    tryCaptureSessionIdentity: (recordId) => execute(service.refreshSessionIdentity, {
      recordId: assistantSessionId(recordId),
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
    getPiConfig: async () => {
      const config = await execute(service.inspectProviderConfiguration, {
        provider: piProvider,
      });
      return {
        settings: config.settings,
        configuredProviders: config.configuredCredentialProviders,
      };
    },
    savePiSettings: async (settings: AssistantProviderSettings) => {
      await execute(service.saveProviderConfiguration, { provider: piProvider, settings });
    },
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
