import {
  gitService,
  type GitChangedFile,
  type GitCreatedWorktree,
  type GitDiffStat,
  type GitErrorCode,
  type GitRepositoryStatus,
  type GitService,
  type GitWorktree,
  type ModuleActivationContext,
  type SemanticEventLease,
  type SemanticRequestOperation,
} from "@shipctl/module-api";

export class GitClientError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitClientError";
    this.code = code;
  }
}

async function execute<Input, Output>(
  operation: SemanticRequestOperation<Input, Output, GitErrorCode>,
  input: Input,
): Promise<Output> {
  const outcome = await operation.execute(input);
  if (!outcome.result.ok) {
    throw new GitClientError(outcome.result.error.code, outcome.result.error.message);
  }
  return outcome.result.value;
}

export interface GitClient {
  status(projectId: string): Promise<GitRepositoryStatus>;
  listWorktrees(projectId: string): Promise<readonly GitWorktree[]>;
  createWorktree(projectId: string, branchName: string): Promise<GitCreatedWorktree>;
  changedFiles(projectId: string): Promise<readonly GitChangedFile[]>;
  fileDiff(projectId: string, relativePath: string, staged: boolean): Promise<string>;
  fileContents(
    projectId: string,
    relativePath: string,
    source: "working" | "staged" | "head",
  ): Promise<string>;
  listFiles(projectId: string): Promise<readonly string[]>;
  diffStats(projectId: string): Promise<readonly GitDiffStat[]>;
  subscribeChanges(projectId: string, listener: () => void | Promise<void>): Promise<SemanticEventLease>;
}

export function createGitClient(service: GitService): GitClient {
  const client: GitClient = {
    status: (projectId) => execute(service.inspectStatus, { projectId }),
    listWorktrees: (projectId) => execute(service.listWorktrees, { projectId }),
    createWorktree: (projectId, branchName) => execute(service.createWorktree, {
      projectId,
      branchName,
    }),
    changedFiles: (projectId) => execute(service.listChangedFiles, { projectId }),
    fileDiff: async (projectId, relativePath, staged) => (
      execute(service.readFileDiff, { projectId, relativePath, staged })
        .then(({ contents }) => contents)
    ),
    fileContents: async (projectId, relativePath, source) => (
      execute(service.readFile, { projectId, relativePath, source })
        .then(({ contents }) => contents)
    ),
    listFiles: (projectId) => execute(service.listFiles, { projectId }),
    diffStats: (projectId) => execute(service.diffStats, { projectId }),
    subscribeChanges: (projectId, listener) => service.repositoryChanges.subscribe(
      { projectId },
      listener,
    ),
  };
  return Object.freeze(client);
}

export function gitClientFor(activation: ModuleActivationContext): GitClient {
  return createGitClient(activation.services.require(gitService));
}
