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
  isRepository: "plugin:shipctl-git|is_git_repo",
  initializeRepository: "plugin:shipctl-git|git_init",
  currentBranch: "plugin:shipctl-git|git_current_branch",
  listBranches: "plugin:shipctl-git|git_list_branches",
  pushBranch: "plugin:shipctl-git|git_push_branch",
  listWorktrees: "plugin:shipctl-git|git_list_worktrees",
  createWorktree: "plugin:shipctl-git|git_create_worktree",
  inspectStatus: "plugin:shipctl-git|git_status",
  listChangedFiles: "plugin:shipctl-git|git_changed_files",
  readFileDiff: "plugin:shipctl-git|git_file_diff",
  readFile: "plugin:shipctl-git|git_file_contents",
  listFiles: "plugin:shipctl-git|git_list_files",
  stageFile: "plugin:shipctl-git|git_stage_file",
  stageAll: "plugin:shipctl-git|git_stage_all",
  commit: "plugin:shipctl-git|git_commit",
  unstageFile: "plugin:shipctl-git|git_unstage_file",
  unstageAll: "plugin:shipctl-git|git_unstage_all",
  switchBranch: "plugin:shipctl-git|git_switch_branch",
  createBranch: "plugin:shipctl-git|git_create_branch",
  diffStats: "plugin:shipctl-git|git_diff_stats",
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

export interface LegacyGitTransport {
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
  subscribeChanges(
    activation: ModuleActivationIdentity,
    listener: (event: RawGitChangeEvent) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface GitServiceProviderOptions {
  readonly transport?: LegacyGitTransport;
}

const TAURI_TRANSPORT: LegacyGitTransport = {
  isRepository: ({ input }) => invoke(COMMANDS.isRepository, { path: input.projectId }),
  initializeRepository: ({ input }) => invoke(COMMANDS.initializeRepository, { path: input.projectId }),
  currentBranch: ({ input }) => invoke(COMMANDS.currentBranch, { path: input.projectId }),
  listBranches: ({ input }) => invoke(COMMANDS.listBranches, { path: input.projectId }),
  pushBranch: ({ input }) => invoke(COMMANDS.pushBranch, {
    path: input.projectId,
    branch: input.branchName,
  }),
  listWorktrees: ({ input }) => invoke(COMMANDS.listWorktrees, { path: input.projectId }),
  createWorktree: ({ input }) => invoke(COMMANDS.createWorktree, {
    path: input.projectId,
    branchName: input.branchName,
  }),
  inspectStatus: ({ input }) => invoke(COMMANDS.inspectStatus, { path: input.projectId }),
  listChangedFiles: ({ input }) => invoke(COMMANDS.listChangedFiles, { path: input.projectId }),
  readFileDiff: ({ input }) => invoke(COMMANDS.readFileDiff, {
    path: input.projectId,
    filePath: input.relativePath,
    staged: input.staged,
  }),
  readFile: ({ input }) => invoke(COMMANDS.readFile, {
    path: input.projectId,
    filePath: input.relativePath,
    source: input.source,
  }),
  listFiles: ({ input }) => invoke(COMMANDS.listFiles, { path: input.projectId }),
  stageFile: ({ input }) => invoke(COMMANDS.stageFile, {
    path: input.projectId,
    filePath: input.relativePath,
  }),
  stageAll: ({ input }) => invoke(COMMANDS.stageAll, { path: input.projectId }),
  commit: ({ input }) => invoke(COMMANDS.commit, {
    path: input.projectId,
    message: input.message,
  }),
  unstageFile: ({ input }) => invoke(COMMANDS.unstageFile, {
    path: input.projectId,
    filePath: input.relativePath,
  }),
  unstageAll: ({ input }) => invoke(COMMANDS.unstageAll, { path: input.projectId }),
  switchBranch: ({ input }) => invoke(COMMANDS.switchBranch, {
    path: input.projectId,
    branchName: input.branchName,
  }),
  createBranch: ({ input }) => invoke(COMMANDS.createBranch, {
    path: input.projectId,
    branchName: input.branchName,
  }),
  diffStats: ({ input }) => invoke(COMMANDS.diffStats, { path: input.projectId }),
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
  return error instanceof Error ? error.message : String(error);
}

function transportError(error: unknown): SemanticServiceError<GitErrorCode> {
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
) {
  return createSemanticRequestAdapter({
    activation: context.activation,
    active: () => context.active,
    policy: REQUEST_POLICY,
    transport,
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
) {
  return request<Input, Mapped>(context, {
    async request(envelope) {
      if (!validProject(envelope.input.projectId)) {
        return invalidRequest("git.invalid-project", "Project identity cannot be empty");
      }
      return { ok: true, value: map(await dispatch(envelope), envelope.input) };
    },
  });
}

function fileRequest<Input extends GitFileInput, Output, Mapped = Output>(
  context: SemanticServiceProviderContext,
  dispatch: (envelope: PrivateSemanticRequestEnvelope<Input>) => Promise<Output>,
  map: (output: Output, input: Input) => Mapped = (output) => output as unknown as Mapped,
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
  });
}

function branchRequest(
  context: SemanticServiceProviderContext,
  dispatch: (envelope: PrivateSemanticRequestEnvelope<GitBranchInput>) => Promise<void>,
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
  });
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
  transport: LegacyGitTransport,
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

/** Trusted adapter for the current namespaced Git plugin and filesystem event. */
export function createGitServiceProvider(
  options: GitServiceProviderOptions = {},
): SemanticServiceProvider<GitService> {
  const transport = options.transport ?? TAURI_TRANSPORT;
  return {
    service: gitService,
    bind(context) {
      const mutation = <Input extends GitProjectInput>(
        dispatch: (envelope: PrivateSemanticRequestEnvelope<Input>) => Promise<void>,
      ) => projectRequest(context, dispatch, (_output, input): GitMutationReceipt => ({
        projectId: input.projectId,
      }));

      return Object.freeze({
        isRepository: projectRequest(context, transport.isRepository),
        initializeRepository: mutation(transport.initializeRepository),
        inspectStatus: projectRequest(context, transport.inspectStatus, mapStatus),
        currentBranch: projectRequest(context, transport.currentBranch),
        listBranches: projectRequest(context, transport.listBranches),
        pushBranch: branchRequest(context, transport.pushBranch),
        listWorktrees: projectRequest(
          context,
          transport.listWorktrees,
          (worktrees): readonly GitWorktree[] => worktrees.map(mapWorktree),
        ),
        createWorktree: projectRequest(
          context,
          transport.createWorktree,
          (created): GitCreatedWorktree => ({
            projectId: created.path,
            branchName: created.branch,
          }),
        ),
        listChangedFiles: projectRequest(
          context,
          transport.listChangedFiles,
          (files): readonly GitChangedFile[] => files.map(mapChangedFile),
        ),
        readFileDiff: fileRequest(
          context,
          transport.readFileDiff,
          (contents): GitTextResult => ({ contents }),
        ),
        readFile: fileRequest(
          context,
          transport.readFile,
          (contents): GitTextResult => ({ contents }),
        ),
        listFiles: projectRequest(context, transport.listFiles),
        stageFile: fileRequest(
          context,
          transport.stageFile,
          (_output, input): GitMutationReceipt => ({ projectId: input.projectId }),
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
        }),
        unstageFile: fileRequest(
          context,
          transport.unstageFile,
          (_output, input): GitMutationReceipt => ({ projectId: input.projectId }),
        ),
        unstageAll: mutation(transport.unstageAll),
        switchBranch: branchRequest(context, transport.switchBranch),
        createBranch: branchRequest(context, transport.createBranch),
        diffStats: projectRequest(
          context,
          transport.diffStats,
          (stats): readonly GitDiffStat[] => stats.map(mapDiffStat),
        ),
        repositoryChanges: createRepositoryChanges(context, transport),
      });
    },
  };
}
