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
} from "../protocol/git";
import type { SemanticServiceError } from "../protocol/semanticServices";
import type {
  SemanticServiceProvider,
  SemanticServiceProviderContext,
} from "../host/semanticServices";

import {
  createFakeRequestOperation,
  TestEventSource,
  type FakeRequestTrace,
} from "./semanticServices";

export type FakeGitOperation =
  | "is-repository"
  | "initialize-repository"
  | "inspect-status"
  | "current-branch"
  | "list-branches"
  | "push-branch"
  | "list-worktrees"
  | "create-worktree"
  | "list-changed-files"
  | "read-file-diff"
  | "read-file"
  | "list-files"
  | "stage-file"
  | "stage-all"
  | "commit"
  | "unstage-file"
  | "unstage-all"
  | "switch-branch"
  | "create-branch"
  | "diff-stats";

export interface FakeGitFileSeed {
  readonly relativePath: string;
  readonly working?: string;
  readonly staged?: string;
  readonly head?: string;
  readonly unstagedDiff?: string;
  readonly stagedDiff?: string;
}

export interface FakeGitRepositorySeed {
  readonly projectId: string;
  readonly status?: Partial<GitRepositoryStatus>;
  readonly branches?: readonly string[];
  readonly worktrees?: readonly GitWorktree[];
  readonly changedFiles?: readonly GitChangedFile[];
  readonly files?: readonly FakeGitFileSeed[];
  readonly diffStats?: readonly GitDiffStat[];
}

export interface FakeGitTrace {
  readonly operation: FakeGitOperation;
  readonly request: FakeRequestTrace<unknown>;
}

export interface FakeGitProviderOptions {
  readonly repositories?: readonly FakeGitRepositorySeed[];
  readonly deniedOperations?: readonly FakeGitOperation[];
  readonly trace?: FakeGitTrace[];
  readonly changes?: FakeGitChangeController;
  readonly worktreeProjectId?: (projectId: string, branchName: string) => string;
}

class FakeGitFailure extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface MutableRepository {
  readonly projectId: string;
  status: GitRepositoryStatus;
  branches: string[];
  worktrees: GitWorktree[];
  changedFiles: GitChangedFile[];
  readonly files: Map<string, FakeGitFileSeed>;
  diffStats: GitDiffStat[];
}

const DEFAULT_STATUS: GitRepositoryStatus = {
  isRepository: true,
  branchName: "main",
  dirty: false,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  aheadCount: 0,
  behindCount: 0,
  worktreeParentProjectId: null,
};

const POLICY = {
  cancellation: "before-dispatch",
  retry: { kind: "never" },
} as const;

const CANCELLED = {
  code: "git.cancelled",
  message: "Git request was cancelled",
  retryable: false,
} as const;

const DISPOSED = {
  code: "git.activation-disposed",
  message: "The module activation is no longer active",
  retryable: false,
} as const;

function failedError(error: unknown): SemanticServiceError<GitErrorCode> {
  if (error instanceof FakeGitFailure) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "git.transport-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function operation<Input, Output>(
  context: SemanticServiceProviderContext,
  name: FakeGitOperation,
  options: FakeGitProviderOptions,
  handle: (input: Input) => Output | Promise<Output>,
) {
  const traces: FakeRequestTrace<Input>[] = [];
  const request = createFakeRequestOperation({
    context,
    policy: POLICY,
    handle: ({ input }) => {
      if (options.deniedOperations?.includes(name)) {
        throw new FakeGitFailure("git.denied", `Fake Git operation denied: ${name}`);
      }
      return handle(input);
    },
    failedError,
    cancelledError: CANCELLED,
    disposedError: DISPOSED,
    trace: traces,
  });
  const execute = request.execute.bind(request);
  return Object.freeze({
    policy: request.policy,
    async execute(input: Input, requestOptions?: Parameters<typeof execute>[1]) {
      const traceCount = traces.length;
      const outcome = await execute(input, requestOptions);
      const captured = traces[traceCount];
      if (captured) options.trace?.push({ operation: name, request: captured });
      return outcome;
    },
  });
}

function requireProjectId(projectId: string): void {
  if (projectId.trim().length === 0) {
    throw new FakeGitFailure("git.invalid-project", "Project identity cannot be empty");
  }
}

function requireRelativePath(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new FakeGitFailure(
      "git.invalid-path",
      "Git file path must be a normalized relative path",
    );
  }
}

function requireBranch(branchName: string): void {
  if (branchName.trim().length === 0) {
    throw new FakeGitFailure("git.invalid-request", "Branch name cannot be empty");
  }
}

function copyStatus(status: Partial<GitRepositoryStatus> = {}): GitRepositoryStatus {
  return Object.freeze({ ...DEFAULT_STATUS, ...status });
}

function copyRepository(seed: FakeGitRepositorySeed): MutableRepository {
  requireProjectId(seed.projectId);
  return {
    projectId: seed.projectId,
    status: copyStatus(seed.status),
    branches: [...(seed.branches ?? [seed.status?.branchName ?? "main"])],
    worktrees: [...(seed.worktrees ?? [{
      projectId: seed.projectId,
      branchName: seed.status?.branchName ?? "main",
      isMain: true,
    }])],
    changedFiles: [...(seed.changedFiles ?? [])],
    files: new Map((seed.files ?? []).map((file) => [file.relativePath, { ...file }])),
    diffStats: [...(seed.diffStats ?? [])],
  };
}

/** Drives repository-change events for one or more fake activation bindings. */
export class FakeGitChangeController {
  readonly #sources = new Set<TestEventSource<GitRepositoryChangeScope, GitRepositoryChanged>>();

  attach(
    context: SemanticServiceProviderContext,
    source: TestEventSource<GitRepositoryChangeScope, GitRepositoryChanged>,
  ): void {
    this.#sources.add(source);
    context.own(() => { this.#sources.delete(source); });
  }

  async publish(projectId: string): Promise<void> {
    requireProjectId(projectId);
    await Promise.all([...this.#sources].map((source) => source.publish(
      { projectId },
      { projectId },
    )));
  }
}

/** Tauri-free Git provider for module workflows and lifecycle properties. */
export function createFakeGitServiceProvider(
  options: FakeGitProviderOptions = {},
): SemanticServiceProvider<GitService> {
  return {
    service: gitService,
    bind(context) {
      const repositories = new Map(
        (options.repositories ?? []).map((seed) => [seed.projectId, copyRepository(seed)]),
      );
      const changes = options.changes ?? new FakeGitChangeController();
      const source = new TestEventSource<GitRepositoryChangeScope, GitRepositoryChanged>(
        context,
        "shipctl.git.repository-changes",
        (left, right) => left.projectId === right.projectId,
      );
      changes.attach(context, source);

      const repository = (projectId: string): MutableRepository => {
        requireProjectId(projectId);
        const current = repositories.get(projectId);
        if (!current) throw new FakeGitFailure("git.invalid-project", "Project is not registered");
        return current;
      };
      const gitRepository = (projectId: string): MutableRepository => {
        const current = repository(projectId);
        if (!current.status.isRepository) {
          throw new FakeGitFailure("git.not-repository", "Project is not a Git repository");
        }
        return current;
      };
      const receipt = async (projectId: string): Promise<GitMutationReceipt> => {
        await changes.publish(projectId);
        return { projectId };
      };
      const file = (input: GitFileInput): [MutableRepository, FakeGitFileSeed] => {
        requireRelativePath(input.relativePath);
        const current = gitRepository(input.projectId);
        const value = current.files.get(input.relativePath);
        if (!value) throw new FakeGitFailure("git.invalid-path", "Git file does not exist");
        return [current, value];
      };

      return Object.freeze({
        isRepository: operation(context, "is-repository", options, ({ projectId }: GitProjectInput) => (
          repository(projectId).status.isRepository
        )),
        initializeRepository: operation(
          context,
          "initialize-repository",
          options,
          async ({ projectId }: GitProjectInput) => {
            const current = repository(projectId);
            current.status = copyStatus({ ...current.status, isRepository: true });
            return receipt(projectId);
          },
        ),
        inspectStatus: operation(context, "inspect-status", options, ({ projectId }: GitProjectInput) => (
          gitRepository(projectId).status
        )),
        currentBranch: operation(context, "current-branch", options, ({ projectId }: GitProjectInput) => (
          gitRepository(projectId).status.branchName
        )),
        listBranches: operation(context, "list-branches", options, ({ projectId }: GitProjectInput) => (
          [...gitRepository(projectId).branches]
        )),
        pushBranch: operation(context, "push-branch", options, async (input: GitBranchInput) => {
          requireBranch(input.branchName);
          gitRepository(input.projectId);
          return receipt(input.projectId);
        }),
        listWorktrees: operation(context, "list-worktrees", options, ({ projectId }: GitProjectInput) => (
          [...gitRepository(projectId).worktrees]
        )),
        createWorktree: operation(
          context,
          "create-worktree",
          options,
          async (input: GitBranchInput): Promise<GitCreatedWorktree> => {
            requireBranch(input.branchName);
            const current = gitRepository(input.projectId);
            if (current.branches.includes(input.branchName)) {
              throw new FakeGitFailure("git.conflict", "Branch already exists");
            }
            const projectId = options.worktreeProjectId?.(input.projectId, input.branchName)
              ?? `${input.projectId}#worktree:${input.branchName}`;
            current.branches.push(input.branchName);
            current.worktrees.push({ projectId, branchName: input.branchName, isMain: false });
            await changes.publish(input.projectId);
            return { projectId, branchName: input.branchName };
          },
        ),
        listChangedFiles: operation(
          context,
          "list-changed-files",
          options,
          ({ projectId }: GitProjectInput) => [...gitRepository(projectId).changedFiles],
        ),
        readFileDiff: operation(context, "read-file-diff", options, (input: GitReadDiffInput): GitTextResult => {
          const [, current] = file(input);
          return { contents: input.staged ? current.stagedDiff ?? "" : current.unstagedDiff ?? "" };
        }),
        readFile: operation(context, "read-file", options, (input: GitReadFileInput): GitTextResult => {
          const [, current] = file(input);
          return { contents: current[input.source] ?? "" };
        }),
        listFiles: operation(context, "list-files", options, ({ projectId }: GitProjectInput) => (
          [...gitRepository(projectId).files.keys()].sort()
        )),
        stageFile: operation(context, "stage-file", options, async (input: GitFileInput) => {
          const [current] = file(input);
          current.changedFiles = current.changedFiles.map((changed) => (
            changed.relativePath === input.relativePath ? { ...changed, area: "staged" } : changed
          ));
          return receipt(input.projectId);
        }),
        stageAll: operation(context, "stage-all", options, async ({ projectId }: GitProjectInput) => {
          const current = gitRepository(projectId);
          current.changedFiles = current.changedFiles.map((changed) => ({ ...changed, area: "staged" }));
          return receipt(projectId);
        }),
        commit: operation(context, "commit", options, async (input: GitCommitInput) => {
          if (input.message.trim().length === 0) {
            throw new FakeGitFailure("git.invalid-request", "Commit message cannot be empty");
          }
          const current = gitRepository(input.projectId);
          current.changedFiles = [];
          current.diffStats = [];
          current.status = copyStatus({ ...current.status, dirty: false, stagedCount: 0 });
          return receipt(input.projectId);
        }),
        unstageFile: operation(context, "unstage-file", options, async (input: GitFileInput) => {
          const [current] = file(input);
          current.changedFiles = current.changedFiles.map((changed) => (
            changed.relativePath === input.relativePath ? { ...changed, area: "unstaged" } : changed
          ));
          return receipt(input.projectId);
        }),
        unstageAll: operation(context, "unstage-all", options, async ({ projectId }: GitProjectInput) => {
          const current = gitRepository(projectId);
          current.changedFiles = current.changedFiles.map((changed) => ({ ...changed, area: "unstaged" }));
          return receipt(projectId);
        }),
        switchBranch: operation(context, "switch-branch", options, async (input: GitBranchInput) => {
          requireBranch(input.branchName);
          const current = gitRepository(input.projectId);
          if (!current.branches.includes(input.branchName)) {
            throw new FakeGitFailure("git.conflict", "Branch does not exist");
          }
          current.status = copyStatus({ ...current.status, branchName: input.branchName });
          return receipt(input.projectId);
        }),
        createBranch: operation(context, "create-branch", options, async (input: GitBranchInput) => {
          requireBranch(input.branchName);
          const current = gitRepository(input.projectId);
          if (current.branches.includes(input.branchName)) {
            throw new FakeGitFailure("git.conflict", "Branch already exists");
          }
          current.branches.push(input.branchName);
          current.status = copyStatus({ ...current.status, branchName: input.branchName });
          return receipt(input.projectId);
        }),
        diffStats: operation(context, "diff-stats", options, ({ projectId }: GitProjectInput) => (
          [...gitRepository(projectId).diffStats]
        )),
        repositoryChanges: source,
      });
    },
  };
}
