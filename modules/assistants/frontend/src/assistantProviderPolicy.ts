import type {
  AssistantProcessLaunch,
  AssistantRecoveryRecord,
  AssistantResourceExecuteInput,
  AssistantResourceExecuteResult,
  AssistantResourceReadInput,
  AssistantResourceReadResult,
  AssistantResourceWriteInput,
} from "@shipctl/module-api";

import type { PiConfig, PiSettings, SessionMode } from "./types";

/**
 * The only native authority exposed to a provider policy. Product names,
 * transcript formats, command arguments, and configuration formats stay in
 * this artifact (or another TypeScript artifact), never in the Rust host.
 */
export interface AssistantProviderPolicyResources {
  readResource(input: AssistantResourceReadInput): Promise<AssistantResourceReadResult>;
  writeResource(input: AssistantResourceWriteInput): Promise<void>;
  executeResource(input: AssistantResourceExecuteInput): Promise<AssistantResourceExecuteResult>;
}

export interface AssistantLaunchIntent {
  readonly mode: SessionMode;
  readonly model?: string;
}

export interface AssistantLaunchPreparation {
  readonly launch: AssistantProcessLaunch;
  readonly initialSessionIdentity?: string;
}

/** A snapshot is deliberately in-memory: it scopes one pending capture only. */
export interface AssistantCaptureSnapshot {
  readonly knownTranscriptPaths: ReadonlySet<string>;
  readonly resourceRelativePath: string;
}

export interface AssistantCaptureStrategy {
  snapshot(resources: AssistantProviderPolicyResources): Promise<AssistantCaptureSnapshot>;
  findIdentity(
    record: AssistantRecoveryRecord,
    snapshot: AssistantCaptureSnapshot,
    resources: AssistantProviderPolicyResources,
  ): Promise<string | null>;
}

export interface AssistantProviderPolicy {
  readonly id: string;
  readonly restorable: boolean;
  readonly prepareNew?: (intent: AssistantLaunchIntent) => AssistantLaunchPreparation;
  readonly prepareResume?: (record: AssistantRecoveryRecord) => AssistantProcessLaunch;
  readonly capture?: AssistantCaptureStrategy;
  readonly models?: (resources: AssistantProviderPolicyResources) => Promise<readonly string[]>;
}

export interface AssistantProviderPolicyCatalog {
  readonly policies: readonly AssistantProviderPolicy[];
  get(providerId: string): AssistantProviderPolicy | null;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
const CODEX_CAPTURE_RESOURCE_ID = "codex-session-transcripts";
type AssistantResourceTreeRequest = Extract<
  AssistantResourceReadInput["request"],
  { readonly kind: "tree" }
>;

function codexCaptureRelativePath(at: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10).replaceAll("-", "/");
  return `.codex/sessions/${day}`;
}

function codexCaptureRequest(relativePath: string): AssistantResourceTreeRequest {
  return {
    kind: "tree",
    resourceId: CODEX_CAPTURE_RESOURCE_ID,
    relativePath,
    maxFiles: 256,
    extensions: ["jsonl"],
    metadataOnly: true,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringAt(value: unknown, ...path: readonly string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function commandArguments(
  model: string | undefined,
  mode: SessionMode,
  yoloFlag: string | null,
): string[] {
  const args: string[] = [];
  if (model?.trim()) args.push("--model", model);
  if (mode === "yolo" && yoloFlag !== null) args.push(yoloFlag);
  return args;
}

function claudePreparation(intent: AssistantLaunchIntent): AssistantLaunchPreparation {
  const initialSessionIdentity = crypto.randomUUID();
  return {
    launch: {
      program: "claude",
      arguments: [
        ...commandArguments(intent.model, intent.mode, "--dangerously-skip-permissions"),
        "--session-id",
        initialSessionIdentity,
      ],
    },
    initialSessionIdentity,
  };
}

function codexPreparation(intent: AssistantLaunchIntent): AssistantLaunchPreparation {
  return {
    launch: {
      program: "codex",
      arguments: commandArguments(intent.model, intent.mode, "--yolo"),
    },
  };
}

function restoreMode(record: AssistantRecoveryRecord): SessionMode {
  if (record.sessionMode === "standard" || record.sessionMode === "yolo") return record.sessionMode;
  throw new Error(`Assistant provider '${record.provider}' has an unsupported saved session mode`);
}

function claudeResume(record: AssistantRecoveryRecord): AssistantProcessLaunch {
  return {
    program: "claude",
    arguments: [
      ...commandArguments(record.model ?? undefined, restoreMode(record), "--dangerously-skip-permissions"),
      "--resume",
      { kind: "captured-session-id" },
    ],
  };
}

function codexResume(record: AssistantRecoveryRecord): AssistantProcessLaunch {
  return {
    program: "codex",
    arguments: [
      ...commandArguments(record.model ?? undefined, restoreMode(record), "--yolo"),
      "resume",
      { kind: "captured-session-id" },
    ],
  };
}

async function readFile(
  resources: AssistantProviderPolicyResources,
  resourceId: string,
  relativePath: string,
): Promise<string> {
  const result = await resources.readResource({
    request: { kind: "file", resourceId, relativePath },
  });
  if (result.kind !== "file" || result.resourceId !== resourceId) {
    throw new Error("Assistant resource response did not match its request");
  }
  return result.content;
}

async function readFirstLine(
  resources: AssistantProviderPolicyResources,
  resourceId: string,
  relativePath: string,
): Promise<string> {
  const result = await resources.readResource({
    request: {
      kind: "file",
      resourceId,
      relativePath,
      maxBytes: 256 * 1024,
      firstLineOnly: true,
    },
  });
  if (result.kind !== "file" || result.resourceId !== resourceId) {
    throw new Error("Assistant resource response did not match its request");
  }
  return result.content;
}

async function readTree(
  resources: AssistantProviderPolicyResources,
  request: AssistantResourceTreeRequest,
): Promise<readonly { readonly relativePath: string; readonly content: string }[]> {
  const result = await resources.readResource({ request });
  if (result.kind !== "tree" || result.resourceId !== request.resourceId) {
    throw new Error("Assistant resource response did not match its request");
  }
  return result.files;
}

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

function modelLines(value: string): readonly string[] {
  return lines(value).map((line) => line.trim()).filter(Boolean);
}

async function commandModels(
  resources: AssistantProviderPolicyResources,
  resourceId: string,
  program: string,
  arguments_: readonly string[],
): Promise<readonly string[]> {
  const result = await resources.executeResource({
    resourceId,
    program,
    arguments: [...arguments_],
    timeoutMs: 7_000,
  });
  if (result.status !== 0) throw new Error(`${program} did not expose a selectable model catalog`);
  return modelLines(result.stdout);
}

async function claudeModels(resources: AssistantProviderPolicyResources): Promise<readonly string[]> {
  const cached = await readFile(resources, "claude-model-cache", ".claude.json")
    .then((content) => {
      const parsed = parseJson(content);
      if (!isRecord(parsed) || !Array.isArray(parsed.additionalModelOptionsCache)) return [];
      return parsed.additionalModelOptionsCache.flatMap((option) => stringAt(option, "value") ?? []);
    })
    .catch(() => []);
  return [...new Set([...cached, ...CLAUDE_MODEL_ALIASES])];
}

function codexModelsFromOutput(output: string): readonly string[] {
  for (const line of lines(output)) {
    const response = parseJson(line);
    if (!isRecord(response) || response.id !== 2) continue;
    const error = stringAt(response, "error", "message");
    if (error !== null) throw new Error(`Codex model catalog request failed: ${error}`);
    const data = isRecord(response.result) && Array.isArray(response.result.data)
      ? response.result.data
      : [];
    const models = data.flatMap((model) => (
      isRecord(model) && model.hidden !== true ? stringAt(model, "model") ?? [] : []
    ));
    if (models.length === 0) throw new Error("Codex returned no selectable models");
    return models;
  }
  throw new Error("Codex closed before returning its model catalog");
}

async function codexModels(resources: AssistantProviderPolicyResources): Promise<readonly string[]> {
  const stdin = [
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "shipctl", version: "unknown" } },
    }),
    JSON.stringify({
      id: 2,
      method: "model/list",
      params: { limit: 100, cursor: null, includeHidden: false },
    }),
  ].join("\n");
  const result = await resources.executeResource({
    resourceId: "codex-model-catalog",
    program: "codex",
    arguments: ["app-server", "--stdio"],
    stdin,
    timeoutMs: 7_000,
    completion: { kind: "jsonl-response-id", id: 2 },
  });
  return codexModelsFromOutput(result.stdout);
}

async function antigravityModels(resources: AssistantProviderPolicyResources): Promise<readonly string[]> {
  const primary = await commandModels(resources, "antigravity-model-catalog", "agy", ["--list-models"])
    .catch(() => []);
  return primary.length > 0
    ? primary
    : commandModels(resources, "antigravity-model-catalog", "agy", ["models"]);
}

async function piModels(resources: AssistantProviderPolicyResources): Promise<readonly string[]> {
  const result = await commandModels(resources, "pi-model-catalog", "pi", ["--list-models"]);
  return result.slice(1).flatMap((line) => {
    const [provider, model] = line.split(/\s+/, 3);
    return provider && model ? [`${provider}/${model}`] : [];
  });
}

async function codexCaptureSnapshot(
  resources: AssistantProviderPolicyResources,
): Promise<AssistantCaptureSnapshot> {
  const resourceRelativePath = codexCaptureRelativePath();
  const files = await readTree(resources, codexCaptureRequest(resourceRelativePath));
  return Object.freeze({
    knownTranscriptPaths: new Set(
      files.map(({ relativePath }) => `${resourceRelativePath}/${relativePath}`),
    ),
    resourceRelativePath,
  });
}

function scopedCodexFiles(
  resourceRelativePath: string,
  files: readonly { readonly relativePath: string; readonly content: string }[],
) {
  return files.map(({ relativePath, content }) => ({
    relativePath: `${resourceRelativePath}/${relativePath}`,
    content,
  }));
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Interprets only Codex's public `session_meta` row. It deliberately ignores
 * incomplete files and rejects more than one new matching transcript rather
 * than guessing which concurrent process belongs to this terminal.
 */
export function selectCodexCaptureIdentity(
  knownTranscriptPaths: ReadonlySet<string>,
  launchRepoPath: string,
  files: readonly { readonly relativePath: string; readonly content: string }[],
): string | null {
  const candidates = files.flatMap(({ relativePath, content }) => {
    if (knownTranscriptPaths.has(relativePath)) return [];
    for (const line of lines(content)) {
      const row = parseJson(line);
      if (!isRecord(row) || row.type !== "session_meta") continue;
      const id = stringAt(row, "payload", "id");
      const cwd = stringAt(row, "payload", "cwd");
      return id !== null && cwd !== null && normalizedPath(cwd) === normalizedPath(launchRepoPath)
        ? [id]
        : [];
    }
    return [];
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `Found ${candidates.length} new Codex sessions for this directory; restore was not enabled so Shipctl will not guess which one to resume`,
  );
}

const codexCapture: AssistantCaptureStrategy = Object.freeze({
  snapshot: codexCaptureSnapshot,
  async findIdentity(
    record: AssistantRecoveryRecord,
    snapshot: AssistantCaptureSnapshot,
    resources: AssistantProviderPolicyResources,
  ) {
    const currentRelativePath = codexCaptureRelativePath();
    const resourceRelativePaths = snapshot.resourceRelativePath === currentRelativePath
      ? [currentRelativePath]
      : [snapshot.resourceRelativePath, currentRelativePath];
    const files = (await Promise.all(resourceRelativePaths.map(async (resourceRelativePath) => (
      scopedCodexFiles(
        resourceRelativePath,
        await readTree(resources, codexCaptureRequest(resourceRelativePath)),
      )
    )))).flat();
    const candidates = files.filter(({ relativePath }) => (
      !snapshot.knownTranscriptPaths.has(relativePath)
    ));
    const candidateContents = await Promise.all(candidates.map(async ({ relativePath }) => ({
      relativePath,
      content: await readFirstLine(
        resources,
        CODEX_CAPTURE_RESOURCE_ID,
        relativePath,
      ),
    })));
    return selectCodexCaptureIdentity(
      snapshot.knownTranscriptPaths,
      record.launchRepoPath,
      candidateContents,
    );
  },
});

const DEFAULT_PROVIDER_POLICIES: readonly AssistantProviderPolicy[] = Object.freeze([
  {
    id: "claude",
    restorable: true,
    prepareNew: claudePreparation,
    prepareResume: claudeResume,
    models: claudeModels,
  },
  {
    id: "codex",
    restorable: true,
    prepareNew: codexPreparation,
    prepareResume: codexResume,
    capture: codexCapture,
    models: codexModels,
  },
  {
    id: "antigravity",
    restorable: false,
    models: antigravityModels,
  },
  {
    id: "opencode",
    restorable: false,
    models: (resources) => commandModels(resources, "opencode-model-catalog", "opencode", ["models"]),
  },
  {
    id: "pi",
    restorable: false,
    models: piModels,
  },
]);

function validPolicyId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/**
 * Validates a trusted artifact policy before it is activated. An external
 * artifact can provide an additional policy without compiling the Rust host.
 */
export function createAssistantProviderPolicyCatalog(
  policies: readonly AssistantProviderPolicy[] = DEFAULT_PROVIDER_POLICIES,
): AssistantProviderPolicyCatalog {
  const byId = new Map<string, AssistantProviderPolicy>();
  for (const policy of policies) {
    if (!validPolicyId(policy.id) || byId.has(policy.id)) {
      throw new Error("Assistant provider policy identities must be unique bounded identifiers");
    }
    const hasLaunch = policy.prepareNew !== undefined && policy.prepareResume !== undefined;
    if (policy.restorable !== hasLaunch || (!policy.restorable && policy.capture !== undefined)) {
      throw new Error(`Assistant provider policy '${policy.id}' has an invalid recovery declaration`);
    }
    byId.set(policy.id, Object.freeze({ ...policy }));
  }
  return Object.freeze({
    policies: Object.freeze([...byId.values()]),
    get(providerId: string) { return byId.get(providerId) ?? null; },
  });
}

const DEFAULT_POLICY_CATALOG = createAssistantProviderPolicyCatalog();

export function assistantProviderPolicy(providerId: string): AssistantProviderPolicy | null {
  return DEFAULT_POLICY_CATALOG.get(providerId);
}

export async function getAssistantModels(
  providerId: string,
  resources: AssistantProviderPolicyResources,
): Promise<readonly string[]> {
  const policy = assistantProviderPolicy(providerId);
  if (!policy?.models) return [];
  return policy.models(resources);
}

function piSettings(value: unknown): PiSettings {
  return {
    defaultProvider: stringAt(value, "defaultProvider"),
    defaultModel: stringAt(value, "defaultModel"),
    defaultThinkingLevel: stringAt(value, "defaultThinkingLevel"),
  };
}

/** Pi's persisted shape and merge policy are artifact-owned. */
export async function readPiConfig(resources: AssistantProviderPolicyResources): Promise<PiConfig> {
  const [settingsText, authText] = await Promise.all([
    readFile(resources, "pi-settings", ".pi/agent/settings.json").catch(() => "{}"),
    readFile(resources, "pi-auth", ".pi/agent/auth.json").catch(() => "{}"),
  ]);
  const auth = parseJson(authText);
  return {
    settings: piSettings(parseJson(settingsText)),
    configuredProviders: isRecord(auth) ? Object.keys(auth).sort() : [],
  };
}

export async function writePiSettings(
  settings: PiSettings,
  resources: AssistantProviderPolicyResources,
): Promise<void> {
  const current = parseJson(
    await readFile(resources, "pi-settings", ".pi/agent/settings.json").catch(() => "{}"),
  );
  const merged: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  const fields = [
    ["defaultProvider", settings.defaultProvider],
    ["defaultModel", settings.defaultModel],
    ["defaultThinkingLevel", settings.defaultThinkingLevel],
  ] as const;
  for (const [key, value] of fields) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  await resources.writeResource({
    resourceId: "pi-settings",
    relativePath: ".pi/agent/settings.json",
    content: `${JSON.stringify(merged, null, 2)}\n`,
  });
}
