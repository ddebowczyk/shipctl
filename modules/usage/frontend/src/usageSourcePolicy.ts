import type {
  UsageSourceDataset,
  UsageSourceId,
  UsageSourceRecord,
  UsageSourceResourceRequest,
  UsageSourceResourceResult,
} from "@shipctl/module-api";

import type {
  UsagePresentationDataset,
  UsageProvider,
  UsageProviderObservation,
  UsageProviderWindow,
} from "./types";

/**
 * Everything in this file is artifact policy: source identity, local paths,
 * credential lookups, wire formats, quota interpretation, and the ephemeral
 * presentation cache. The host only executes bounded generic resource reads.
 */
export const USAGE_SOURCE_IDS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "pi",
] as const satisfies readonly UsageSourceId[];

export interface UsageSourceResourceReader {
  read(request: UsageSourceResourceRequest): Promise<UsageSourceResourceResult>;
}

export interface UsageSourceCollection {
  readonly sourceId: UsageSourceId;
  readonly records: readonly UsageSourceRecord[];
  readonly observation: UsageProviderObservation;
}

export type UsageSourceCollector = (
  reader: UsageSourceResourceReader,
) => Promise<UsageSourceCollection>;

export interface UsageSourcePolicy {
  readonly sourceIds: readonly UsageSourceId[];
  collect(
    sourceId: UsageSourceId,
    reader: UsageSourceResourceReader,
  ): Promise<UsageSourceCollection>;
  update(collections: readonly UsageSourceCollection[]): void;
  present(dataset: UsageSourceDataset): UsagePresentationDataset;
}

export interface UsageSourcePolicyOptions {
  readonly sourceIds?: readonly UsageSourceId[];
  readonly collectors?: Readonly<Record<string, UsageSourceCollector | undefined>>;
}

type JsonRecord = Readonly<Record<string, unknown>>;
type ResourceRequestFor<Kind extends UsageSourceResourceRequest["kind"]> = Extract<
  UsageSourceResourceRequest,
  { readonly kind: Kind }
>;
type ResourceResultFor<Kind extends UsageSourceResourceResult["kind"]> = Extract<
  UsageSourceResourceResult,
  { readonly kind: Kind }
>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function objectAt(value: unknown, ...path: readonly string[]): JsonRecord | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function arrayAt(value: unknown, ...path: readonly string[]): readonly unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function stringAt(value: unknown, ...path: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function numberAt(value: unknown, ...path: readonly string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function pathSegments(path: string): readonly string[] {
  return path.split("/").filter(Boolean);
}

function fileStem(path: string): string {
  const file = pathSegments(path).at(-1) ?? "";
  return file.replace(/\.[^.]+$/, "") || "unknown";
}

function parentSegment(path: string, offset = 1): string {
  const segments = pathSegments(path);
  return segments.at(-1 - offset) ?? "unknown";
}

function projectName(path: string | null): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function jsonLines(content: string): readonly JsonRecord[] {
  return content.split("\n").flatMap((line) => {
    const parsed = parseJson(line);
    return isRecord(parsed) ? [parsed] : [];
  });
}

function record(
  sourceId: UsageSourceId,
  values: Partial<Omit<UsageSourceRecord, "sourceId">>,
): UsageSourceRecord {
  return {
    grain: "message",
    sourceId,
    sessionId: null,
    date: null,
    project: null,
    model: null,
    timestamp: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheWrite: 0,
    tokensCacheRead: 0,
    tokensThoughts: 0,
    tokensTotal: 0,
    messageCount: 1,
    pricingProvider: sourceId,
    recordedCost: null,
    ...values,
  };
}

function now(): string {
  return new Date().toISOString();
}

function unavailable(sourceId: UsageSourceId): UsageProviderObservation {
  return {
    provider: sourceId,
    available: false,
    fetchedAt: null,
    summaryWindows: [],
    extraWindows: [],
  };
}

function localObservation(sourceId: UsageSourceId): UsageProviderObservation {
  return {
    provider: sourceId,
    available: true,
    fetchedAt: now(),
    summaryWindows: [],
    extraWindows: [],
  };
}

function observation(
  sourceId: UsageSourceId,
  summaryWindows: readonly UsageProviderWindow[],
  extraWindows: readonly UsageProviderWindow[] = [],
): UsageProviderObservation {
  return {
    provider: sourceId,
    available: true,
    fetchedAt: now(),
    summaryWindows,
    extraWindows,
  };
}

function window(
  provider: UsageProvider,
  values: Pick<UsageProviderWindow, "windowId" | "window" | "label" | "scope"> &
    Partial<UsageProviderWindow>,
): UsageProviderWindow {
  const used = values.used ?? null;
  const limit = values.limit ?? 100;
  const usedPercent = values.usedPercent ?? used;
  return {
    provider,
    windowId: values.windowId,
    window: values.window,
    label: values.label,
    scope: values.scope,
    limit,
    used,
    sourceType: values.sourceType ?? "provider",
    confidence: values.confidence ?? "official",
    costKind: values.costKind ?? "included",
    usedPercent,
    remainingPercent: values.remainingPercent ?? (
      usedPercent === null ? null : Math.max(0, 100 - usedPercent)
    ),
    resetAt: values.resetAt ?? null,
    tokenTotal: values.tokenTotal ?? null,
    paceStatus: values.paceStatus ?? null,
  };
}

async function read<Kind extends UsageSourceResourceRequest["kind"]>(
  reader: UsageSourceResourceReader,
  request: ResourceRequestFor<Kind>,
): Promise<ResourceResultFor<Kind>> {
  const result = await reader.read(request);
  if (result.kind !== request.kind || result.resourceId !== request.resourceId) {
    throw new Error("Usage source resource response did not match its request");
  }
  return result as ResourceResultFor<Kind>;
}

async function readFile(
  reader: UsageSourceResourceReader,
  resourceId: string,
  relativePath: string,
): Promise<string> {
  return (await read(reader, {
    kind: "file",
    resourceId,
    relativePath,
  })).content;
}

async function readTree(
  reader: UsageSourceResourceReader,
  resourceId: string,
  relativePath: string,
  extensions: readonly string[],
): Promise<readonly { readonly relativePath: string; readonly content: string }[]> {
  return (await read(reader, {
    kind: "tree",
    resourceId,
    relativePath,
    extensions,
  })).files;
}

async function readHttp(
  reader: UsageSourceResourceReader,
  resourceId: string,
  request: Omit<ResourceRequestFor<"http">, "kind" | "resourceId">,
): Promise<string> {
  const response = await read(reader, { kind: "http", resourceId, ...request });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("Usage source endpoint is unavailable");
  }
  return response.body;
}

async function readKeychain(
  reader: UsageSourceResourceReader,
  resourceId: string,
  service: string,
): Promise<string> {
  return (await read(reader, {
    kind: "keychain-password",
    resourceId,
    service,
  })).secret;
}

function claudeRecords(files: readonly { readonly relativePath: string; readonly content: string }[]): UsageSourceRecord[] {
  return files.flatMap(({ relativePath, content }) => {
    const sessionId = fileStem(relativePath);
    const project = parentSegment(relativePath);
    return jsonLines(content).flatMap((entry) => {
      const message = objectAt(entry, "message");
      const usage = objectAt(message, "usage");
      if (usage === null) return [];
      const input = nonNegative(usage.input_tokens);
      const output = nonNegative(usage.output_tokens);
      const cacheWrite = nonNegative(usage.cache_creation_input_tokens);
      const cacheRead = nonNegative(usage.cache_read_input_tokens);
      return [record("claude", {
        sessionId,
        project,
        model: stringAt(message, "model") ?? "unknown",
        timestamp: timestamp(entry.timestamp),
        tokensInput: input,
        tokensOutput: output,
        tokensCacheWrite: cacheWrite,
        tokensCacheRead: cacheRead,
        tokensTotal: input + output + cacheWrite + cacheRead,
        pricingProvider: "anthropic",
      })];
    });
  });
}

async function collectClaudeRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  return claudeRecords(await readTree(reader, "claude-transcripts", ".claude/projects", ["jsonl"]));
}

async function collectClaudeObservation(reader: UsageSourceResourceReader): Promise<UsageProviderObservation> {
  const credentials = parseJson(await readKeychain(
    reader,
    "claude-credentials",
    "Claude Code-credentials",
  ));
  const token = stringAt(credentials, "claudeAiOauth", "accessToken");
  if (token === null) throw new Error("Claude credentials have no access token");
  const body = parseJson(await readHttp(reader, "claude-quota", {
    url: "https://api.anthropic.com/api/oauth/usage",
    method: "GET",
    headers: [
      { name: "Authorization", value: `Bearer ${token}` },
      { name: "anthropic-beta", value: "oauth-2025-04-20" },
    ],
  }));
  const claudeWindow = (
    id: "5h" | "7d" | "7d_sonnet",
    scope: "session" | "plan",
  ): UsageProviderWindow | null => {
    const source = objectAt(body, id === "5h" ? "five_hour" : id === "7d" ? "seven_day" : "seven_day_sonnet");
    if (source === null) return null;
    const used = numberAt(source, "utilization");
    return window("claude", {
      windowId: `claude-${id}`,
      window: id,
      label: id.replace("_", " "),
      scope,
      used,
      usedPercent: used,
      resetAt: stringAt(source, "resets_at"),
    });
  };
  const summaryWindows = [claudeWindow("5h", "session"), claudeWindow("7d", "plan")]
    .filter((value): value is UsageProviderWindow => value !== null);
  if (summaryWindows.length === 0) throw new Error("Claude quota response has no windows");
  const extra = claudeWindow("7d_sonnet", "plan");
  return observation("claude", summaryWindows, extra === null ? [] : [extra]);
}

function codexRecords(files: readonly { readonly relativePath: string; readonly content: string }[]): UsageSourceRecord[] {
  return files.flatMap(({ relativePath, content }) => {
    let sessionId = fileStem(relativePath);
    let project = "unknown";
    let model = "unknown";
    let recordedAt = 0;
    let usage: JsonRecord | null = null;
    for (const entry of jsonLines(content)) {
      switch (entry.type) {
        case "session_meta": {
          const payload = objectAt(entry, "payload");
          sessionId = stringAt(payload, "id") ?? sessionId;
          project = projectName(stringAt(payload, "cwd"));
          recordedAt = timestamp(entry.timestamp) || recordedAt;
          break;
        }
        case "turn_context":
          model = stringAt(entry, "payload", "model") ?? model;
          break;
        case "event_msg": {
          if (stringAt(entry, "payload", "type") !== "token_count") break;
          const totals = objectAt(entry, "payload", "info", "total_token_usage");
          if (totals !== null) {
            usage = totals;
            recordedAt = timestamp(entry.timestamp) || recordedAt;
          }
          break;
        }
      }
    }
    if (usage === null) return [];
    const input = nonNegative(usage.input_tokens);
    const cacheRead = nonNegative(usage.cached_input_tokens);
    const output = nonNegative(usage.output_tokens);
    const thoughts = nonNegative(usage.reasoning_output_tokens);
    return [record("codex", {
      sessionId,
      project,
      model,
      timestamp: recordedAt,
      tokensInput: Math.max(0, input - cacheRead),
      tokensOutput: output,
      tokensCacheRead: cacheRead,
      tokensThoughts: thoughts,
      tokensTotal: nonNegative(usage.total_tokens),
      pricingProvider: "openai",
    })];
  });
}

async function collectCodexRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  return codexRecords(await readTree(reader, "codex-transcripts", ".codex/sessions", ["jsonl"]));
}

function percentWindow(
  id: "5h" | "7d",
  source: JsonRecord,
): UsageProviderWindow {
  const used = numberAt(source, "used_percent");
  return window("codex", {
    windowId: `codex-${id}`,
    window: id,
    label: id,
    scope: id === "5h" ? "session" : "plan",
    used,
    usedPercent: used,
    resetAt: source.reset_at === undefined ? null : String(source.reset_at),
  });
}

async function collectCodexObservation(reader: UsageSourceResourceReader): Promise<UsageProviderObservation> {
  const auth = parseJson(await readFile(reader, "codex-auth", ".codex/auth.json"));
  const token = stringAt(auth, "tokens", "access_token") ?? stringAt(auth, "access_token");
  if (token === null) throw new Error("Codex auth file has no access token");
  const response = parseJson(await readHttp(reader, "codex-quota", {
    url: "https://chatgpt.com/backend-api/wham/usage",
    method: "GET",
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  }));
  const primary = objectAt(response, "rate_limit", "primary_window");
  const secondary = objectAt(response, "rate_limit", "secondary_window");
  if (primary === null || secondary === null) throw new Error("Codex quota response has no windows");
  return observation("codex", [percentWindow("5h", primary), percentWindow("7d", secondary)]);
}

function geminiRecords(files: readonly { readonly relativePath: string; readonly content: string }[]): UsageSourceRecord[] {
  return files.flatMap(({ relativePath, content }) => {
    if (!pathSegments(relativePath).includes("chats")) return [];
    const session = parseJson(content);
    const sessionId = stringAt(session, "sessionId") ?? fileStem(relativePath);
    const segments = pathSegments(relativePath);
    const chatsAt = segments.lastIndexOf("chats");
    const project = chatsAt > 0 ? segments[chatsAt - 1] ?? "unknown" : "unknown";
    const recordedAt = timestamp(stringAt(session, "lastUpdated") ?? stringAt(session, "startTime"));
    return arrayAt(session, "messages").flatMap((message) => {
      const tokens = objectAt(message, "tokens");
      if (tokens === null) return [];
      const input = nonNegative(tokens.input);
      const output = nonNegative(tokens.output);
      const cacheRead = nonNegative(tokens.cached);
      const thoughts = nonNegative(tokens.thoughts);
      return [record("gemini", {
        sessionId,
        project,
        model: stringAt(message, "model") ?? "unknown",
        timestamp: recordedAt,
        tokensInput: input,
        tokensOutput: output,
        tokensCacheRead: cacheRead,
        tokensThoughts: thoughts,
        tokensTotal: numberAt(tokens, "total") ?? input + output + cacheRead + thoughts,
        pricingProvider: "google",
      })];
    });
  });
}

async function collectGeminiRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  return geminiRecords(await readTree(reader, "gemini-transcripts", ".gemini/tmp", ["json"]));
}

function geminiTier(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("pro")) return "pro";
  if (normalized.includes("flash") && normalized.includes("lite")) return "flash_lite";
  if (normalized.includes("flash")) return "flash";
  if (normalized.includes("lite")) return "lite";
  return "quota";
}

async function collectGeminiObservation(reader: UsageSourceResourceReader): Promise<UsageProviderObservation> {
  try {
    const settings = parseJson(await readFile(reader, "gemini-settings", ".gemini/settings.json"));
    const selectedType = stringAt(settings, "security", "auth", "selectedType");
    if (selectedType === "api-key" || selectedType === "vertex-ai") {
      throw new Error("Gemini selected authentication does not expose OAuth quota");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not expose")) throw error;
  }
  const credentials = parseJson(await readFile(reader, "gemini-oauth", ".gemini/oauth_creds.json"));
  const token = stringAt(credentials, "access_token");
  if (token === null) throw new Error("Gemini credentials have no access token");
  const headers = [
    { name: "Authorization", value: `Bearer ${token}` },
    { name: "Content-Type", value: "application/json" },
  ];
  const projectResponse = parseJson(await readHttp(reader, "gemini-project", {
    url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
  }));
  const project = stringAt(projectResponse, "cloudaicompanionProject");
  const quotaResponse = parseJson(await readHttp(reader, "gemini-quota", {
    url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    method: "POST",
    headers,
    body: project === null ? "{}" : JSON.stringify({ project }),
  }));
  const byTier = new Map<string, JsonRecord>();
  for (const bucket of arrayAt(quotaResponse, "buckets")) {
    const bucketRecord = isRecord(bucket) ? bucket : null;
    if (bucketRecord === null || numberAt(bucketRecord, "remainingFraction") === null) continue;
    const tier = geminiTier(`${stringAt(bucketRecord, "modelId") ?? ""} ${stringAt(bucketRecord, "tokenType") ?? ""}`);
    const existing = byTier.get(tier);
    if (
      existing === undefined
      || (numberAt(bucketRecord, "remainingFraction") ?? 1) < (numberAt(existing, "remainingFraction") ?? 1)
    ) {
      byTier.set(tier, bucketRecord);
    }
  }
  const windows = [...byTier.entries()].map(([tier, bucket]) => {
    const remaining = Math.min(1, Math.max(0, numberAt(bucket, "remainingFraction") ?? 0));
    const used = (1 - remaining) * 100;
    return window("gemini", {
      windowId: `gemini-24h-${tier}`,
      window: `24h_${tier}`,
      label: `24h ${tier.replace("_", " ")}`,
      scope: "plan",
      used,
      usedPercent: used,
      remainingPercent: remaining * 100,
      resetAt: stringAt(bucket, "resetTime"),
    });
  }).sort((left, right) => left.label.localeCompare(right.label));
  if (windows.length === 0) throw new Error("Gemini quota response has no windows");
  return observation("gemini", windows);
}

function antigravitySessionId(relativePath: string): string {
  const segments = pathSegments(relativePath);
  return segments.at(-4) ?? segments.at(-2) ?? fileStem(relativePath);
}

function selectedAntigravityModel(content: string): string | null {
  const marker = "Model Selection` from ";
  const start = content.indexOf(marker);
  if (start < 0) return null;
  const after = content.slice(start + marker.length);
  const selection = after.split(" to ")[1]?.split(". No need")[0]?.split("\n")[0]
    ?.trim().replaceAll("`", "") ?? "";
  return selection && selection !== "None" ? selection : null;
}

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil([...text].length / 4);
}

function antigravityPricingProvider(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return "google";
  if (lower.includes("claude")) return "anthropic";
  return "antigravity";
}

async function antigravityHistory(reader: UsageSourceResourceReader): Promise<ReadonlyMap<string, string>> {
  try {
    const content = await readFile(reader, "antigravity-history", ".gemini/antigravity-cli/history.jsonl");
    return new Map(jsonLines(content).flatMap((entry) => {
      const id = stringAt(entry, "conversationId");
      const workspace = stringAt(entry, "workspace");
      return id === null || workspace === null ? [] : [[id, workspace] as const];
    }));
  } catch {
    return new Map();
  }
}

async function collectAntigravityRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  const [files, history] = await Promise.all([
    readTree(reader, "antigravity-transcripts", ".gemini/antigravity-cli/brain", ["jsonl"]),
    antigravityHistory(reader),
  ]);
  const selected = new Map<string, { readonly relativePath: string; readonly content: string }>();
  for (const file of files) {
    const name = pathSegments(file.relativePath).at(-1);
    if (name !== "transcript.jsonl" && name !== "transcript_full.jsonl") continue;
    const sessionId = antigravitySessionId(file.relativePath);
    const existing = selected.get(sessionId);
    if (existing === undefined || name === "transcript_full.jsonl") selected.set(sessionId, file);
  }
  return [...selected].flatMap(([sessionId, file]) => {
    let input = 0;
    let output = 0;
    let model = "unknown";
    let recordedAt = 0;
    for (const entry of jsonLines(file.content)) {
      recordedAt = timestamp(entry.created_at) || recordedAt;
      const source = stringAt(entry, "source") ?? "";
      const type = stringAt(entry, "type") ?? "";
      const content = stringAt(entry, "content") ?? "";
      if (type === "USER_INPUT" || source === "USER_EXPLICIT") {
        input += estimateTokens(content);
        model = selectedAntigravityModel(content) ?? model;
      } else if (source === "MODEL" && type === "PLANNER_RESPONSE") {
        output += estimateTokens(content);
        output += estimateTokens(stringAt(entry, "thinking") ?? "");
        output += estimateTokens(JSON.stringify(entry.tool_calls ?? ""));
      }
    }
    const total = input + output;
    if (total === 0) return [];
    return [record("antigravity", {
      sessionId,
      project: projectName(history.get(sessionId) ?? null),
      model,
      timestamp: recordedAt,
      tokensInput: input,
      tokensOutput: output,
      tokensTotal: total,
      pricingProvider: antigravityPricingProvider(model),
    })];
  });
}

function commandFlag(command: string, flag: string): string | null {
  const match = command.match(new RegExp(`${flag}(?:=|\\s+)([^\\s]+)`));
  return match?.[1] ?? null;
}

interface AntigravityProcess {
  readonly pid: string;
  readonly csrfToken: string;
  readonly extensionPort: string | null;
  readonly extensionCsrfToken: string | null;
}

function antigravityProcess(output: string): AntigravityProcess | null {
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match === null) continue;
    const [, pid, command] = match;
    const normalized = command.toLowerCase();
    const ide = normalized.includes("language_server") && normalized.includes("antigravity");
    const cli = /(?:^|[\\s/])agy(?:[\\s]|$)/.test(normalized)
      || /(?:^|[\\s/])antigravity(?:[-_]cli)?(?:[\\s]|$)/.test(normalized);
    if (!ide && !cli) continue;
    const csrfToken = commandFlag(command, "--csrf_token") ?? (cli ? "" : null);
    if (csrfToken === null) continue;
    return {
      pid,
      csrfToken,
      extensionPort: commandFlag(command, "--extension_server_port"),
      extensionCsrfToken: commandFlag(command, "--extension_server_csrf_token"),
    };
  }
  return null;
}

function portsForProcess(output: string, pid: string): readonly string[] {
  return [...new Set(output.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== pid || !line.includes("(LISTEN)")) return [];
    const port = line.match(/:(\d+)(?:\s|\(|$)/)?.[1];
    return port === undefined ? [] : [port];
  }))];
}

function safeWindowId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quota";
}

interface AntigravityQuota {
  readonly label: string;
  readonly model: string;
  readonly remaining: number;
  readonly resetAt: string | null;
}

function antigravityQuotas(value: unknown): readonly AntigravityQuota[] {
  const configs = arrayAt(value, "userStatus", "cascadeModelConfigData", "clientModelConfigs");
  const fallback = configs.length > 0 ? configs : arrayAt(value, "clientModelConfigs");
  return fallback.flatMap((config) => {
    const quota = objectAt(config, "quotaInfo");
    const remaining = numberAt(quota, "remainingFraction");
    if (quota === null || remaining === null) return [];
    const model = stringAt(config, "modelOrAlias", "model") ?? "unknown";
    return [{
      label: stringAt(config, "label") ?? model,
      model,
      remaining: Math.min(1, Math.max(0, remaining)),
      resetAt: stringAt(quota, "resetTime"),
    }];
  });
}

function antigravityWindows(quotas: readonly AntigravityQuota[]): UsageProviderObservation {
  const family = (quota: AntigravityQuota): string => {
    const text = `${quota.label} ${quota.model}`.toLowerCase();
    if (text.includes("claude")) return "claude";
    if (text.includes("gemini") && text.includes("pro") && !text.includes("flash")) return "gemini_pro";
    if (text.includes("gemini") && text.includes("flash")) return "gemini_flash";
    return "other";
  };
  const pick = (name: string) => quotas.filter((quota) => family(quota) === name)
    .sort((left, right) => left.remaining - right.remaining)[0];
  const summary = [
    ["claude", "24h_claude", "Claude quota"],
    ["gemini_pro", "24h_gemini_pro", "Gemini Pro quota"],
    ["gemini_flash", "24h_gemini_flash", "Gemini Flash quota"],
  ].flatMap(([familyName, id, label]) => {
    const quota = pick(familyName);
    return quota === undefined ? [] : [window("antigravity", {
      windowId: `antigravity-${id}`,
      window: id,
      label,
      scope: "plan",
      used: (1 - quota.remaining) * 100,
      usedPercent: (1 - quota.remaining) * 100,
      remainingPercent: quota.remaining * 100,
      resetAt: quota.resetAt,
    })];
  });
  const fallback = summary.length > 0 ? summary : quotas.slice(0, 1).map((quota) => window("antigravity", {
    windowId: "antigravity-quota",
    window: "quota",
    label: quota.label,
    scope: "plan",
    used: (1 - quota.remaining) * 100,
    usedPercent: (1 - quota.remaining) * 100,
    remainingPercent: quota.remaining * 100,
    resetAt: quota.resetAt,
  }));
  if (fallback.length === 0) throw new Error("Antigravity quota response has no models");
  const extra = quotas.map((quota) => window("antigravity", {
    windowId: `antigravity-model-${safeWindowId(quota.model)}`,
    window: safeWindowId(quota.model),
    label: quota.label,
    scope: "plan",
    used: (1 - quota.remaining) * 100,
    usedPercent: (1 - quota.remaining) * 100,
    remainingPercent: quota.remaining * 100,
    resetAt: quota.resetAt,
  })).sort((left, right) => left.label.localeCompare(right.label));
  return observation("antigravity", fallback, extra);
}

async function collectAntigravityObservation(reader: UsageSourceResourceReader): Promise<UsageProviderObservation> {
  const processOutput = (await read(reader, { kind: "processes", resourceId: "antigravity-processes" })).output;
  const process = antigravityProcess(processOutput);
  if (process === null) throw new Error("Antigravity language server is unavailable");
  const portOutput = (await read(reader, { kind: "listening-ports", resourceId: "antigravity-ports" })).output;
  const endpoints = [
    ...portsForProcess(portOutput, process.pid).map((port) => ({ scheme: "https", port, token: process.csrfToken })),
    ...(process.extensionPort === null ? [] : [
      { scheme: "http", port: process.extensionPort, token: process.extensionCsrfToken ?? process.csrfToken },
      ...(process.extensionCsrfToken === null || process.extensionCsrfToken === process.csrfToken
        ? []
        : [{ scheme: "http", port: process.extensionPort, token: process.csrfToken }]),
    ]),
  ];
  const body = JSON.stringify({ metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  } });
  for (const endpoint of endpoints) {
    for (const path of [
      "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
    ]) {
      try {
        const response = parseJson(await readHttp(reader, `antigravity-quota-${endpoint.port}`, {
          url: `${endpoint.scheme}://127.0.0.1:${endpoint.port}${path}`,
          method: "POST",
          headers: [
            { name: "Content-Type", value: "application/json" },
            { name: "Connect-Protocol-Version", value: "1" },
            { name: "X-Codeium-Csrf-Token", value: endpoint.token },
          ],
          body,
        }));
        const quotas = antigravityQuotas(response);
        if (quotas.length > 0) return antigravityWindows(quotas);
      } catch {
        // Another loopback endpoint may be the active language server.
      }
    }
  }
  throw new Error("Antigravity quota endpoint is unavailable");
}

async function collectOpenCodeRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  const result = await read(reader, {
    kind: "sqlite",
    resourceId: "opencode-messages",
    relativePath: ".local/share/opencode/opencode.db",
    query: "SELECT m.rowid, m.session_id, s.directory, m.time_created, m.data FROM message m JOIN session s ON s.id = m.session_id WHERE json_extract(m.data, '$.role') = 'assistant' ORDER BY m.rowid ASC",
  });
  return result.rows.flatMap((row) => {
    const payload = parseJson(typeof row.data === "string" ? row.data : "");
    const tokens = objectAt(payload, "tokens");
    const input = nonNegative(tokens?.input);
    const output = nonNegative(tokens?.output);
    const thoughts = nonNegative(tokens?.reasoning);
    const cacheRead = nonNegative(objectAt(tokens, "cache")?.read);
    const cacheWrite = nonNegative(objectAt(tokens, "cache")?.write);
    const total = numberAt(tokens, "total") ?? input + output + thoughts + cacheRead + cacheWrite;
    const completed = numberAt(payload, "time", "completed") ?? numberAt(payload, "time", "created");
    const created = typeof row.time_created === "number" ? row.time_created : 0;
    return [record("opencode", {
      sessionId: typeof row.session_id === "string" ? row.session_id : "unknown",
      project: projectName(typeof row.directory === "string" ? row.directory : null),
      model: stringAt(payload, "modelID") ?? "unknown",
      timestamp: Math.floor((completed ?? created) / 1_000),
      tokensInput: input,
      tokensOutput: output,
      tokensCacheWrite: cacheWrite,
      tokensCacheRead: cacheRead,
      tokensThoughts: thoughts,
      tokensTotal: total,
      pricingProvider: stringAt(payload, "providerID") ?? "opencode",
      recordedCost: numberAt(payload, "cost"),
    })];
  });
}

function piPricingProvider(value: string): string {
  if (value === "azure") return "openai";
  return value.startsWith("google") ? "google" : value;
}

function piRecords(files: readonly { readonly relativePath: string; readonly content: string }[]): UsageSourceRecord[] {
  return files.flatMap(({ relativePath, content }) => {
    const rows = jsonLines(content);
    const stem = fileStem(relativePath);
    const sessionId = stem.includes("_") ? stem.slice(stem.lastIndexOf("_") + 1) : stem;
    const project = projectName(stringAt(rows[0], "cwd"));
    return rows.flatMap((entry) => {
      if (stringAt(entry, "type") !== "message") return [];
      const message = objectAt(entry, "message");
      if (stringAt(message, "role") !== "assistant") return [];
      const usage = objectAt(message, "usage");
      if (usage === null) return [];
      const input = nonNegative(usage.input);
      const output = nonNegative(usage.output);
      const cacheRead = nonNegative(usage.cacheRead);
      const cacheWrite = nonNegative(usage.cacheWrite);
      const recordedCost = amount(objectAt(usage, "cost")?.total);
      return [record("pi", {
        sessionId,
        project,
        model: stringAt(message, "model") ?? "unknown",
        timestamp: timestamp(entry.timestamp),
        tokensInput: input,
        tokensOutput: output,
        tokensCacheWrite: cacheWrite,
        tokensCacheRead: cacheRead,
        tokensTotal: numberAt(usage, "totalTokens") ?? input + output + cacheRead + cacheWrite,
        pricingProvider: piPricingProvider(stringAt(message, "provider") ?? "pi"),
        recordedCost: recordedCost > 0 ? recordedCost : null,
      })];
    });
  });
}

async function collectPiRecords(reader: UsageSourceResourceReader): Promise<UsageSourceRecord[]> {
  return piRecords(await readTree(reader, "pi-transcripts", ".pi/agent/sessions", ["jsonl"]));
}

async function collected(
  sourceId: UsageSourceId,
  records: Promise<UsageSourceRecord[]>,
  quota: Promise<UsageProviderObservation>,
): Promise<UsageSourceCollection> {
  const [collectedRecords, collectedObservation] = await Promise.all([
    records,
    quota.catch(() => unavailable(sourceId)),
  ]);
  return { sourceId, records: collectedRecords, observation: collectedObservation };
}

const DEFAULT_COLLECTORS: Readonly<Record<string, UsageSourceCollector>> = Object.freeze({
  claude: (reader) => collected("claude", collectClaudeRecords(reader), collectClaudeObservation(reader)),
  codex: (reader) => collected("codex", collectCodexRecords(reader), collectCodexObservation(reader)),
  antigravity: (reader) => collected(
    "antigravity",
    collectAntigravityRecords(reader),
    collectAntigravityObservation(reader),
  ),
  gemini: (reader) => collected("gemini", collectGeminiRecords(reader), collectGeminiObservation(reader)),
  opencode: async (reader) => ({
    sourceId: "opencode",
    records: await collectOpenCodeRecords(reader),
    observation: localObservation("opencode"),
  }),
  pi: async (reader) => ({
    sourceId: "pi",
    records: await collectPiRecords(reader),
    observation: localObservation("pi"),
  }),
});

/**
 * Builds a per-activation policy/cache. Tests and future artifacts can supply
 * new source identities and collectors without changing the native host.
 */
export function createUsageSourcePolicy(
  options: UsageSourcePolicyOptions = {},
): UsageSourcePolicy {
  const sourceIds = Object.freeze([...(options.sourceIds ?? USAGE_SOURCE_IDS)]);
  const collectors = options.collectors ?? DEFAULT_COLLECTORS;
  const observations = new Map<UsageSourceId, UsageProviderObservation>();
  const known = new Set(sourceIds);

  return Object.freeze({
    sourceIds,
    async collect(sourceId, reader) {
      if (!known.has(sourceId)) throw new Error(`Usage source '${sourceId}' is not declared by this artifact`);
      const collector = collectors[sourceId];
      if (collector === undefined) {
        return { sourceId, records: [], observation: unavailable(sourceId) };
      }
      const collection = await collector(reader);
      if (collection.sourceId !== sourceId || collection.records.some((item) => item.sourceId !== sourceId)) {
        throw new Error(`Usage source '${sourceId}' collector returned an out-of-scope record`);
      }
      return collection;
    },
    update(collections) {
      for (const collection of collections) {
        if (known.has(collection.sourceId)) observations.set(collection.sourceId, collection.observation);
      }
    },
    present(dataset) {
      return {
        capturedAt: dataset.capturedAt,
        records: dataset.records,
        providerObservations: sourceIds.map((sourceId) => observations.get(sourceId) ?? unavailable(sourceId)),
      };
    },
  });
}
