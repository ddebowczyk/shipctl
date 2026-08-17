import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  gitService,
  type GitBranchInput,
  type GitChangedFile,
  type GitCommitInput,
  type GitCreatedWorktree,
  type GitDiffStat,
  type GitErrorCode,
  type GitFileInput,
  type GitMutationReceipt,
  type GitProjectInput,
  type GitReadDiffInput,
  type GitReadFileInput,
  type GitRepositoryChanged,
  type GitRepositoryChangeScope,
  type GitRepositoryStatus,
  type GitService,
  type GitTextResult,
  type GitWorktree,
  type ModuleActivationIdentity,
  type SemanticCorrelationId,
  type SemanticEventLease,
  type SemanticEventRecord,
  type SemanticServiceError,
  type SemanticServiceProvider,
  type SemanticServiceProviderContext,
} from "@shipctl/module-api";

import {
  createSemanticRequestAdapter,
  type PrivateSemanticRequestEnvelope,
  type PrivateSemanticRequestTransport,
} from "./semanticServiceAdapter.ts";

const COMMANDS = {
  isRepository: "git_is_repository",
  initializeRepository: "git_initialize_repository",
  currentBranch: "git_current_branch",
  listBranches: "git_list_branches",
  pushBranch: "git_push_branch",
  listWorktrees: "git_list_worktrees",
  createWorktree: "git_create_worktree",
  inspectStatus: "git_inspect_status",
  listChangedFiles: "git_list_changed_files",
  readFileDiff: "git_read_file_diff",
  readFile: "git_read_file",
  listFiles: "git_list_files",
  stageFile: "git_stage_file",
  stageAll: "git_stage_all",
  commit: "git_commit",
  unstageFile: "git_unstage_file",
  unstageAll: "git_unstage_all",
  switchBranch: "git_switch_branch",
  createBranch: "git_create_branch",
  diffStats: "git_diff_stats",
  releaseActivation: "release_git_activation",
} as const;

const CHANGES_EVENT = "git-fs-changed";
const CHANGES_SOURCE_ID = "shipctl.git.repository-changes";

interface RawGitStatus {
  readonly is_git_repo: boolean;
  readonly branch: string;
  readonly dirty: boolean;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly ahead: number;
  readonly behind: number;
  readonly worktree_parent: string | null;
}

interface RawGitWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly is_main: boolean;
}

interface RawCreatedWorktree {
  readonly path: string;
  readonly branch: string;
}

interface RawChangedFile {
  readonly path: string;
  readonly status: string;
  readonly area: string;
  readonly old_path: string | null;
}

interface RawDiffStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

interface RawGitChangeEvent {
  readonly paths: readonly string[];
}

type EmptyInput = Readonly<Record<never, never>>;

interface NativeGitError {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly retryable?: unknown;
}

export interface NativeGitTransport {
  isRepository(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<boolean>;
  initializeRepository(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<void>;
  currentBranch(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<string>;
  listBranches(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<readonly string[]>;
  pushBranch(request: PrivateSemanticRequestEnvelope<GitBranchInput>): Promise<void>;
  listWorktrees(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<readonly RawGitWorktree[]>;
  createWorktree(request: PrivateSemanticRequestEnvelope<GitBranchInput>): Promise<RawCreatedWorktree>;
  inspectStatus(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<RawGitStatus>;
  listChangedFiles(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<readonly RawChangedFile[]>;
  readFileDiff(request: PrivateSemanticRequestEnvelope<GitReadDiffInput>): Promise<string>;
  readFile(request: PrivateSemanticRequestEnvelope<GitReadFileInput>): Promise<string>;
  listFiles(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<readonly string[]>;
  stageFile(request: PrivateSemanticRequestEnvelope<GitFileInput>): Promise<void>;
  stageAll(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<void>;
  commit(request: PrivateSemanticRequestEnvelope<GitCommitInput>): Promise<void>;
  unstageFile(request: PrivateSemanticRequestEnvelope<GitFileInput>): Promise<void>;
  unstageAll(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<void>;
  switchBranch(request: PrivateSemanticRequestEnvelope<GitBranchInput>): Promise<void>;
  createBranch(request: PrivateSemanticRequestEnvelope<GitBranchInput>): Promise<void>;
  diffStats(request: PrivateSemanticRequestEnvelope<GitProjectInput>): Promise<readonly RawDiffStat[]>;
  releaseActivation(request: PrivateSemanticRequestEnvelope<EmptyInput>): Promise<boolean>;
  subscribeChanges(
    activation: ModuleActivationIdentity,
    listener: (event: RawGitChangeEvent) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface GitServiceProviderOptions {
  readonly transport?: NativeGitTransport;
  readonly createCorrelationId?: () => SemanticCorrelationId;
}

const TAURI_TRANSPORT: NativeGitTransport = {
  isRepository: (request) => invoke(COMMANDS.isRepository, { request }),
  initializeRepository: (request) => invoke(COMMANDS.initializeRepository, { request }),
  currentBranch: (request) => invoke(COMMANDS.currentBranch, { request }),
  listBranches: (request) => invoke(COMMANDS.listBranches, { request }),
  pushBranch: (request) => invoke(COMMANDS.pushBranch, { request }),
  listWorktrees: (request) => invoke(COMMANDS.listWorktrees, { request }),
  createWorktree: (request) => invoke(COMMANDS.createWorktree, { request }),
  inspectStatus: (request) => invoke(COMMANDS.inspectStatus, { request }),
  listChangedFiles: (request) => invoke(COMMANDS.listChangedFiles, { request }),
  readFileDiff: (request) => invoke(COMMANDS.readFileDiff, { request }),
  readFile: (request) => invoke(COMMANDS.readFile, { request }),
  listFiles: (request) => invoke(COMMANDS.listFiles, { request }),
  stageFile: (request) => invoke(COMMANDS.stageFile, { request }),
  stageAll: (request) => invoke(COMMANDS.stageAll, { request }),
  commit: (request) => invoke(COMMANDS.commit, { request }),
  unstageFile: (request) => invoke(COMMANDS.unstageFile, { request }),
  unstageAll: (request) => invoke(COMMANDS.unstageAll, { request }),
  switchBranch: (request) => invoke(COMMANDS.switchBranch, { request }),
  createBranch: (request) => invoke(COMMANDS.createBranch, { request }),
  diffStats: (request) => invoke(COMMANDS.diffStats, { request }),
  releaseActivation: (request) => invoke(COMMANDS.releaseActivation, { request }),
  subscribeChanges: async (_activation, listener) => listen<RawGitChangeEvent>(
    CHANGES_EVENT,
    (event) => listener(event.payload),
  ),
};

const REQUEST_POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED_ERROR = {
  code: "git.cancelled",
  message: "Git request was cancelled",
  retryable: false,
} as const;

const DISPOSED_ERROR = {
  code: "git.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

const ERROR_CODES = new Set<GitErrorCode>([
  "git.transport-failed",
  "git.denied",
  "git.invalid-project",
  "git.invalid-path",
  "git.invalid-request",
  "git.not-repository",
  "git.conflict",
  "git.cancelled",
  "git.activation-disposed",
]);

function transportError(error: unknown): SemanticServiceError<GitErrorCode> {
  const native = error && typeof error === "object" ? error as NativeGitError : null;
  if (typeof native?.code === "string" && ERROR_CODES.has(native.code as GitErrorCode)) {
    return {
      code: native.code as GitErrorCode,
      message: errorMessage(error),
      retryable: native.retryable === true,
    };
  }
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  const code: GitErrorCode = normalized.includes("project is not registered")
    ? "git.invalid-project"
    : normalized.includes("not a git repository")
      ? "git.not-repository"
      : normalized.includes("path") && (
          normalized.includes("invalid")
          || normalized.includes("outside")
          || normalized.includes("relative")
        )
        ? "git.invalid-path"
        : normalized.includes("permission")
          || normalized.includes("denied")
          || normalized.includes("not permitted")
          || normalized.includes("not allowed")
          ? "git.denied"
          : normalized.includes("conflict") || normalized.includes("lock")
            ? "git.conflict"
            : "git.transport-failed";
  return { code, message, retryable: false };
}

function request<Input, Output>(
  context: SemanticServiceProviderContext,
  transport: PrivateSemanticRequestTransport<Input, Output, GitErrorCode>,
  createCorrelationId?: () => SemanticCorrelationId,
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
    correlationId: createCorrelationId,
    transportError,
    cancelledError: CANCELLED_ERROR,
    disposedError: DISPOSED_ERROR,
  });
}

function invalidRequest(code: GitErrorCode, message: string) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function validProject(projectId: string): boolean {
  return projectId.trim().length > 0;
}

function validRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return relativePath.length > 0
    && !relativePath.startsWith("/")
    && !relativePath.includes("\\")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function projectRequest<Input extends GitProjectInput, Output, Mapped = Output>(
  context: SemanticServiceProviderContext,
  dispatch: (envelope: PrivateSemanticRequestEnvelope<Input>) => Promise<Output>,
  map: (output: Output, input: Input) => Mapped = (output) => output as unknown as Mapped,
  createCorrelationId?: () => SemanticCorrelationId,
) {
  return request<Input, Mapped>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest("git.invalid-project", "Project identity cannot be empty");
      }
      return { ok: true, value: map(await dispatch(envelope), envelope.input) };
    },
  }, createCorrelationId);
}

function fileRequest<Input extends GitFileInput, Output, Mapped = Output>(
  context: SemanticServiceProviderContext,
  dispatch: (envelope: PrivateSemanticRequestEnvelope<Input>) => Promise<Output>,
  map: (output: Output, input: Input) => Mapped = (output) => output as unknown as Mapped,
  createCorrelationId?: () => SemanticCorrelationId,
) {
  return request<Input, Mapped>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest("git.invalid-project", "Project identity cannot be empty");
      }
      if (!validRelativePath(envelope.input.relativePath)) {
        return invalidRequest("git.invalid-path", "Git file path must be a normalized relative path");
      }
      return { ok: true, value: map(await dispatch(envelope), envelope.input) };
    },
  }, createCorrelationId);
}

function branchRequest(
  context: SemanticServiceProviderContext,
  dispatch: (envelope: PrivateSemanticRequestEnvelope<GitBranchInput>) => Promise<void>,
  createCorrelationId?: () => SemanticCorrelationId,
) {
  return request<GitBranchInput, GitMutationReceipt>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest("git.invalid-project", "Project identity cannot be empty");
      }
      if (envelope.input.branchName.trim().length === 0) {
        return invalidRequest("git.invalid-request", "Branch name cannot be empty");
      }
      await dispatch(envelope);
      return { ok: true, value: { projectId: envelope.input.projectId } };
    },
  }, createCorrelationId);
}

function correlationId(): SemanticCorrelationId {
  return crypto.randomUUID() as SemanticCorrelationId;
}

function releaseEnvelope(
  activation: ModuleActivationIdentity,
  createCorrelationId: () => SemanticCorrelationId,
): PrivateSemanticRequestEnvelope<EmptyInput> {
  return {
    activation,
    correlationId: createCorrelationId(),
    input: {},
  };
}

function mapStatus(raw: RawGitStatus): GitRepositoryStatus {
  return {
    isRepository: raw.is_git_repo,
    branchName: raw.branch,
    dirty: raw.dirty,
    stagedCount: raw.staged,
    unstagedCount: raw.unstaged,
    untrackedCount: raw.untracked,
    aheadCount: raw.ahead,
    behindCount: raw.behind,
    worktreeParentProjectId: raw.worktree_parent,
  };
}

function mapWorktree(raw: RawGitWorktree): GitWorktree {
  return { projectId: raw.path, branchName: raw.branch, isMain: raw.is_main };
}

function mapChangedFile(raw: RawChangedFile): GitChangedFile {
  return {
    relativePath: raw.path,
    status: raw.status,
    area: raw.area,
    previousRelativePath: raw.old_path,
  };
}

function mapDiffStat(raw: RawDiffStat): GitDiffStat {
  return {
    relativePath: raw.path,
    additions: raw.additions,
    deletions: raw.deletions,
  };
}

function createRepositoryChanges(
  context: SemanticServiceProviderContext,
  transport: NativeGitTransport,
) {
  let sequence = 0;
  return Object.freeze({
    async subscribe(
      scope: GitRepositoryChangeScope,
      listener: (event: SemanticEventRecord<GitRepositoryChanged>) => void | Promise<void>,
    ): Promise<SemanticEventLease> {
      if (!context.active) throw new Error(DISPOSED_ERROR.message);
      if (!validProject(scope.projectId)) throw new Error("Project identity cannot be empty");
      let active = true;
      let queue = Promise.resolve();
      const unlisten = await transport.subscribeChanges(context.activation, (event) => {
        if (!active || !event.paths.includes(scope.projectId)) return;
        sequence += 1;
        const record = {
          sourceId: CHANGES_SOURCE_ID,
          sequence,
          value: { projectId: scope.projectId },
        };
        queue = queue
          .then(async () => {
            if (active && context.active) await listener(record);
          })
          .catch(() => undefined);
      });
      if (!context.active) {
        active = false;
        await unlisten();
        throw new Error(DISPOSED_ERROR.message);
      }
      return context.own(async () => {
        active = false;
        await unlisten();
        await queue;
      });
    },
  });
}

/** Trusted adapter for the permanent native Git provider and filesystem event. */
export function createGitServiceProvider(
  options: GitServiceProviderOptions = {},
): SemanticServiceProvider<GitService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  const createCorrelationId = options.createCorrelationId ?? correlationId;
  return {
    service: gitService,
    bind(context) {
      context.own(() => transport.releaseActivation(
        releaseEnvelope(context.activation, createCorrelationId),
      ).then(() => undefined));

      const mutation = <Input extends GitProjectInput>(
        dispatch: (envelope: PrivateSemanticRequestEnvelope<Input>) => Promise<void>,
      ) => projectRequest(
        context,
        dispatch,
        (_output, input): GitMutationReceipt => ({ projectId: input.projectId }),
        createCorrelationId,
      );

      return Object.freeze({
        isRepository: projectRequest(
          context,
          transport.isRepository,
          undefined,
          createCorrelationId,
        ),
        initializeRepository: mutation(transport.initializeRepository),
        inspectStatus: projectRequest(
          context,
          transport.inspectStatus,
          mapStatus,
          createCorrelationId,
        ),
        currentBranch: projectRequest(
          context,
          transport.currentBranch,
          undefined,
          createCorrelationId,
        ),
        listBranches: projectRequest(
          context,
          transport.listBranches,
          undefined,
          createCorrelationId,
        ),
        pushBranch: branchRequest(context, transport.pushBranch, createCorrelationId),
        listWorktrees: projectRequest(
          context,
          transport.listWorktrees,
          (worktrees): readonly GitWorktree[] => worktrees.map(mapWorktree),
          createCorrelationId,
        ),
        createWorktree: projectRequest(
          context,
          transport.createWorktree,
          (created): GitCreatedWorktree => ({
            projectId: created.path,
            branchName: created.branch,
          }),
          createCorrelationId,
        ),
        listChangedFiles: projectRequest(
          context,
          transport.listChangedFiles,
          (files): readonly GitChangedFile[] => files.map(mapChangedFile),
          createCorrelationId,
        ),
        readFileDiff: fileRequest(
          context,
          transport.readFileDiff,
          (contents): GitTextResult => ({ contents }),
          createCorrelationId,
        ),
        readFile: fileRequest(
          context,
          transport.readFile,
          (contents): GitTextResult => ({ contents }),
          createCorrelationId,
        ),
        listFiles: projectRequest(
          context,
          transport.listFiles,
          undefined,
          createCorrelationId,
        ),
        stageFile: fileRequest(
          context,
          transport.stageFile,
          (_output, input): GitMutationReceipt => ({ projectId: input.projectId }),
          createCorrelationId,
        ),
        stageAll: mutation(transport.stageAll),
        commit: request<GitCommitInput, GitMutationReceipt>(context, {
          async request(envelope) {
            if (!validProject(envelope.input.projectId)) {
              return invalidRequest("git.invalid-project", "Project identity cannot be empty");
            }
            if (envelope.input.message.trim().length === 0) {
              return invalidRequest("git.invalid-request", "Commit message cannot be empty");
            }
            await transport.commit(envelope);
            return { ok: true, value: { projectId: envelope.input.projectId } };
          },
        }, createCorrelationId),
        unstageFile: fileRequest(
          context,
          transport.unstageFile,
          (_output, input): GitMutationReceipt => ({ projectId: input.projectId }),
          createCorrelationId,
        ),
        unstageAll: mutation(transport.unstageAll),
        switchBranch: branchRequest(context, transport.switchBranch, createCorrelationId),
        createBranch: branchRequest(context, transport.createBranch, createCorrelationId),
        diffStats: projectRequest(
          context,
          transport.diffStats,
          (stats): readonly GitDiffStat[] => stats.map(mapDiffStat),
          createCorrelationId,
        ),
        repositoryChanges: createRepositoryChanges(context, transport),
      });
    },
  };
}
