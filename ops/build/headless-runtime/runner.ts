import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import * as pluginApi from "@shipctl/module-api";
import type {
  AcceptedPluginAdmission,
  MigratePluginDataRecordsInput,
  PluginDataMigrationReceipt,
  PluginDataRecord,
  ReadPluginDataRecordInput,
  WritePluginDataRecordInput,
} from "@shipctl/module-api";

import {
  createHostConfigurationRuntime,
  createHostConfigurationServiceProvider,
} from "../../../core/frontend/configuration/headless.ts";
import {
  createPluginDataServiceProviderWithTransport,
  type PluginDataNativeRequest,
} from "../../../core/frontend/platform/pluginDataAdapter.ts";
import {
  createHeadlessRuntime,
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "../../../core/frontend/runtime/headless.ts";
import {
  createDefaultWorkspaceCatalog,
  WorkspacePluginRuntime,
  WORKSPACE_PLUGIN_ADMISSION,
  WORKSPACE_PLUGIN_MODULE_ID,
} from "../../../core/frontend/workspace/index.ts";
import { createShipctlPlugin } from "../../../modules/runtime-operations/artifact/src/index.ts";

const RUNNER_PROTOCOL_VERSION = 1;
const RUNNER_ABI_VERSION = 1;
const ADMISSION_SCHEMA_VERSION = 1;
const KERNEL_PROTOCOL_VERSION = 1;

interface RunnerRequest {
  readonly schemaVersion: number;
  readonly runnerAbi: number;
  readonly operation: string;
  readonly input?: unknown;
}

interface RunnerResponse {
  readonly schemaVersion: number;
  readonly runnerAbi: number;
  readonly operation: string;
  readonly status: "success" | "failure";
  readonly code: string;
  readonly data?: unknown;
}

interface RuntimeInvokeInput {
  readonly stateRoot?: string;
  readonly capabilityId: string;
  readonly portId: string;
  readonly payload: unknown;
}

interface AdmissionDocument {
  readonly admission: AcceptedPluginAdmission;
  readonly capabilities: unknown;
}

class RunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

function response(
  operation: string,
  status: RunnerResponse["status"],
  code: string,
  data?: unknown,
): RunnerResponse {
  return {
    schemaVersion: RUNNER_PROTOCOL_VERSION,
    runnerAbi: RUNNER_ABI_VERSION,
    operation,
    status,
    code,
    ...(data === undefined ? {} : { data }),
  };
}

function output(value: RunnerResponse): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(value.status === "success" ? 0 : 1);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerError("headless.runner.invalid_response", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerError("headless.runner.invalid_request", `${label} must be a non-empty string.`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label);
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RunnerError("headless.runner.admission_invalid", `${label} must be an array.`);
  }
  return Object.freeze(value.map((item, index) => text(item, `${label}[${index}]`)));
}

async function input(): Promise<RunnerRequest> {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new RunnerError("headless.runner.invalid_request", "Runner input is not valid JSON.");
  }
  const request = record(value, "Runner input");
  if (
    typeof request.operation !== "string"
    || typeof request.schemaVersion !== "number"
    || typeof request.runnerAbi !== "number"
  ) {
    throw new RunnerError("headless.runner.invalid_request", "Runner input has an invalid envelope.");
  }
  return request as RunnerRequest;
}

function kernelPath(): string | null {
  const index = process.argv.indexOf("--kernel");
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

function kernelCall<Output>(kernel: string, operation: string, value: unknown): Output {
  const invocation = spawnSync(kernel, ["__headless-kernel"], {
    encoding: "utf8",
    input: JSON.stringify({ schemaVersion: KERNEL_PROTOCOL_VERSION, operation, input: value }),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (invocation.error !== undefined) {
    throw new RunnerError(
      "headless.runner.kernel_failed",
      `The native headless kernel could not start: ${invocation.error.message}`,
    );
  }
  if (invocation.status !== 0) {
    throw new RunnerError(
      "headless.runner.kernel_failed",
      `The native headless kernel exited ${invocation.status ?? "without a status"}.`,
    );
  }
  let wire: unknown;
  try {
    wire = JSON.parse(String(invocation.stdout ?? ""));
  } catch {
    throw new RunnerError("headless.runner.kernel_invalid_response", "The native headless kernel returned invalid JSON.");
  }
  const envelope = record(wire, "Native headless kernel response");
  if (envelope.schemaVersion !== KERNEL_PROTOCOL_VERSION || envelope.operation !== operation) {
    throw new RunnerError("headless.runner.kernel_invalid_response", "The native headless kernel response mismatched its request.");
  }
  if (envelope.status !== "success") {
    const error = envelope.error === undefined ? undefined : record(envelope.error, "Native headless kernel error");
    throw new RunnerError(
      typeof envelope.code === "string" ? envelope.code : "headless.runner.kernel_failed",
      typeof error?.message === "string" ? error.message : "The native headless kernel rejected the request.",
    );
  }
  if (!("data" in envelope)) {
    throw new RunnerError("headless.runner.kernel_invalid_response", "The native headless kernel response omitted data.");
  }
  return envelope.data as Output;
}

async function readAdmission(): Promise<AdmissionDocument> {
  let source: string;
  try {
    source = await readFile(new URL("./shipctl-headless-runtime-admission.json", import.meta.url), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunnerError("headless.runner.admission_missing", `The packaged headless admission is unavailable: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new RunnerError("headless.runner.admission_invalid", "The packaged headless admission is not valid JSON.");
  }
  const document = record(parsed, "Headless admission");
  if (document.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new RunnerError("headless.runner.admission_invalid", "The packaged headless admission has an unsupported schema version.");
  }
  const artifact = record(document.artifact, "Headless admission artifact");
  const contentDigest = text(artifact.contentDigest, "Headless admission artifact contentDigest");
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) {
    throw new RunnerError("headless.runner.admission_invalid", "The packaged headless admission content digest is invalid.");
  }
  const application = record(document.application, "Headless admission application");
  const messages = record(document.messages, "Headless admission messages");
  const capabilities = record(document.capabilities, "Headless admission capabilities");
  return {
    admission: Object.freeze({
      artifact: Object.freeze({
        contentDigest,
        entryUrl: text(artifact.entryUrl, "Headless admission artifact entryUrl"),
        moduleId: text(artifact.moduleId, "Headless admission artifact moduleId"),
        version: text(artifact.version, "Headless admission artifact version"),
      }),
      effectiveGrants: strings(document.effectiveGrants, "Headless admission effectiveGrants"),
      application: application as AcceptedPluginAdmission["application"],
      messages: messages as AcceptedPluginAdmission["messages"],
    }),
    capabilities,
  };
}

function sameArtifact(value: unknown, admission: AcceptedPluginAdmission): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return artifact.id === admission.artifact.moduleId
    && artifact.version === admission.artifact.version
    && artifact.contentDigest === admission.artifact.contentDigest;
}

function runtimeArtifactMatches(value: unknown, admission: AcceptedPluginAdmission): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  const manifest = artifact.manifest;
  return artifact.contentDigest === admission.artifact.contentDigest
    && manifest !== null
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && (manifest as Record<string, unknown>).id === admission.artifact.moduleId
    && (manifest as Record<string, unknown>).version === admission.artifact.version;
}

function verifyAdmission(
  kernel: string,
  stateRoot: string | undefined,
  admission: AcceptedPluginAdmission,
): void {
  const result = kernelCall<unknown>(kernel, "registry.snapshot", {
    ...(stateRoot === undefined ? {} : { stateRoot }),
  });
  const snapshot = record(record(result, "Registry snapshot result").snapshot, "Registry snapshot");
  const desired = snapshot.desired;
  const runtimeArtifacts = snapshot.runtimeArtifacts;
  if (!Array.isArray(desired) || !Array.isArray(runtimeArtifacts)) {
    throw new RunnerError("headless.runner.artifact_not_admitted", "The selected registry has no dynamic artifact catalog.");
  }
  const selected = desired.some((state) => {
    if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
    const item = state as Record<string, unknown>;
    return item.moduleId === admission.artifact.moduleId
      && item.enabled === true
      && sameArtifact(item.selectedArtifact, admission);
  });
  const cataloged = runtimeArtifacts.some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    return runtimeArtifactMatches((entry as Record<string, unknown>).artifact, admission);
  });
  if (!selected || !cataloged) {
    throw new RunnerError(
      "headless.runner.artifact_not_admitted",
      "The selected state root does not enable this exact admitted headless artifact.",
    );
  }
}

function runtimeInvocation(value: unknown): RuntimeInvokeInput {
  const input = record(value, "Runtime invocation");
  if (!("payload" in input)) {
    throw new RunnerError("headless.runner.invalid_request", "Runtime invocation requires a payload.");
  }
  return {
    stateRoot: optionalText(input.stateRoot, "Runtime invocation stateRoot"),
    capabilityId: text(input.capabilityId, "Runtime invocation capabilityId"),
    portId: text(input.portId, "Runtime invocation portId"),
    payload: input.payload,
  };
}

function workspaceId(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return "shipctl.workspace";
  }
  const candidate = (payload as Record<string, unknown>).workspaceId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : "shipctl.workspace";
}

function pluginDataTransport(kernel: string, stateRoot: string | undefined) {
  const kernelInput = <Input>(request: PluginDataNativeRequest<Input>) => ({
    ...(stateRoot === undefined ? {} : { stateRoot }),
    request,
  });
  return {
    read: (request: PluginDataNativeRequest<ReadPluginDataRecordInput>) => kernelCall<PluginDataRecord | null>(
      kernel,
      "plugin-data.read",
      kernelInput(request),
    ),
    write: (request: PluginDataNativeRequest<WritePluginDataRecordInput>) => kernelCall<PluginDataRecord>(
      kernel,
      "plugin-data.write",
      kernelInput(request),
    ),
    migrate: (request: PluginDataNativeRequest<MigratePluginDataRecordsInput>) => kernelCall<PluginDataMigrationReceipt>(
      kernel,
      "plugin-data.migrate",
      kernelInput(request),
    ),
  };
}

async function invokeRuntime(kernel: string, rawInput: unknown): Promise<RunnerResponse> {
  const invocation = runtimeInvocation(rawInput);
  const artifact = await readAdmission();
  verifyAdmission(kernel, invocation.stateRoot, artifact.admission);

  const pluginData = createPluginDataServiceProviderWithTransport(
    pluginDataTransport(kernel, invocation.stateRoot),
  );
  const workspace = new WorkspacePluginRuntime({
    workspaceId: workspaceId(invocation.payload),
    catalog: createDefaultWorkspaceCatalog(),
  });
  const workspaceServices = new SemanticServiceRegistry([pluginData]);
  const workspaceActivation = workspaceServices.activate(
    createModuleActivationIdentity(WORKSPACE_PLUGIN_MODULE_ID, "1", "headless-workspace"),
    WORKSPACE_PLUGIN_ADMISSION,
  );
  let configuration: ReturnType<typeof createHostConfigurationRuntime> | undefined;
  let runtime: Awaited<ReturnType<typeof createHeadlessRuntime>> | undefined;
  try {
    await workspace.definition.activate(workspaceActivation.context);
    configuration = createHostConfigurationRuntime({
      pluginDataServiceProvider: pluginData,
      legacy: { read: async () => null },
    });
    const semanticServices = new SemanticServiceRegistry([
      pluginData,
      workspace.serviceProvider(),
      createHostConfigurationServiceProvider({ runtime: configuration }),
    ]);
    runtime = await createHeadlessRuntime({
      artifacts: [{
        definition: createShipctlPlugin({ pluginApi }),
        admission: artifact.admission,
        capabilities: artifact.capabilities,
      }],
      semanticServices,
    });
    return response("runtime.invoke", "success", "headless.runner.invoked", {
      response: await runtime.invoke({
        capabilityId: invocation.capabilityId,
        portId: invocation.portId,
        payload: invocation.payload,
      }),
    });
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      try {
        await configuration?.dispose();
      } finally {
        await workspaceActivation.dispose();
      }
    }
  }
}

async function run(): Promise<RunnerResponse> {
  const request = await input();
  try {
    if (request.schemaVersion !== RUNNER_PROTOCOL_VERSION || request.runnerAbi !== RUNNER_ABI_VERSION) {
      return response(request.operation, "failure", "headless.runner.abi_mismatch", {
        expected: { schemaVersion: RUNNER_PROTOCOL_VERSION, runnerAbi: RUNNER_ABI_VERSION },
        received: { schemaVersion: request.schemaVersion, runnerAbi: request.runnerAbi },
      });
    }
    const kernel = kernelPath();
    if (kernel === null) {
      return response(request.operation, "failure", "headless.runner.kernel_missing", {
        message: "The packaged headless runner needs its paired Shipctl CLI kernel.",
      });
    }
    if (request.operation === "runner.probe") {
      const admission = await readAdmission();
      return response(request.operation, "success", "headless.runner.ready", {
        nodeVersion: process.version,
        runnerAbi: RUNNER_ABI_VERSION,
        kernel,
        artifact: admission.admission.artifact,
      });
    }
    if (request.operation === "runtime.invoke") {
      // Await inside this request-scoped guard so every semantic failure keeps
      // the caller's operation name in the ABI response envelope.
      return await invokeRuntime(kernel, request.input);
    }
    return response(request.operation, "failure", "headless.runner.operation_unavailable", {
      message: `Headless runner operation ${request.operation} is unavailable.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RunnerError ? error.code : "headless.runner.failed";
    return response(request.operation, "failure", code, { message });
  }
}

void run().then(output).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof RunnerError ? error.code : "headless.runner.failed";
  output(response("runner.request", "failure", code, { message }));
});
