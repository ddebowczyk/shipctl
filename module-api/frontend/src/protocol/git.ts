import { defineSemanticService } from "./semanticServices.ts";
import type {
  SemanticEventSource,
  SemanticRequestOperation,
} from "./semanticServices";

export interface GitProjectInput {
  readonly projectId: string;
}

export interface GitRepositoryStatus {
  readonly isRepository: boolean;
  readonly branchName: string;
  readonly dirty: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly worktreeParentProjectId: string | null;
}

export interface GitWorktree {
  readonly projectId: string;
  readonly branchName: string | null;
  readonly isMain: boolean;
}

export interface GitChangedFile {
  readonly relativePath: string;
  readonly status: string;
  readonly area: string;
  readonly previousRelativePath: string | null;
}

export interface GitDiffStat {
  readonly relativePath: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitMutationReceipt {
  readonly projectId: string;
}

export interface GitBranchInput extends GitProjectInput {
  readonly branchName: string;
}

export interface GitCreateWorktreeInput extends GitBranchInput {}

export interface GitCreatedWorktree {
  readonly projectId: string;
  readonly branchName: string;
}

export interface GitFileInput extends GitProjectInput {
  readonly relativePath: string;
}

export interface GitReadFileInput extends GitFileInput {
  readonly source: "working" | "staged" | "head";
}

export interface GitReadDiffInput extends GitFileInput {
  readonly staged: boolean;
}

export interface GitTextResult {
  readonly contents: string;
}

export interface GitCommitInput extends GitProjectInput {
  readonly message: string;
}

export interface GitRepositoryChangeScope {
  readonly projectId: string;
}

export interface GitRepositoryChanged {
  readonly projectId: string;
}

export type GitErrorCode =
  | "git.transport-failed"
  | "git.denied"
  | "git.invalid-project"
  | "git.invalid-path"
  | "git.invalid-request"
  | "git.not-repository"
  | "git.conflict"
  | "git.cancelled"
  | "git.activation-disposed";

export interface GitService {
  readonly isRepository: SemanticRequestOperation<GitProjectInput, boolean, GitErrorCode>;
  readonly initializeRepository: SemanticRequestOperation<
    GitProjectInput,
    GitMutationReceipt,
    GitErrorCode
  >;
  readonly inspectStatus: SemanticRequestOperation<
    GitProjectInput,
    GitRepositoryStatus,
    GitErrorCode
  >;
  readonly currentBranch: SemanticRequestOperation<GitProjectInput, string, GitErrorCode>;
  readonly listBranches: SemanticRequestOperation<
    GitProjectInput,
    readonly string[],
    GitErrorCode
  >;
  readonly pushBranch: SemanticRequestOperation<
    GitBranchInput,
    GitMutationReceipt,
    GitErrorCode
  >;
  readonly listWorktrees: SemanticRequestOperation<
    GitProjectInput,
    readonly GitWorktree[],
    GitErrorCode
  >;
  readonly createWorktree: SemanticRequestOperation<
    GitCreateWorktreeInput,
    GitCreatedWorktree,
    GitErrorCode
  >;
  readonly listChangedFiles: SemanticRequestOperation<
    GitProjectInput,
    readonly GitChangedFile[],
    GitErrorCode
  >;
  readonly readFileDiff: SemanticRequestOperation<GitReadDiffInput, GitTextResult, GitErrorCode>;
  readonly readFile: SemanticRequestOperation<GitReadFileInput, GitTextResult, GitErrorCode>;
  readonly listFiles: SemanticRequestOperation<
    GitProjectInput,
    readonly string[],
    GitErrorCode
  >;
  readonly stageFile: SemanticRequestOperation<GitFileInput, GitMutationReceipt, GitErrorCode>;
  readonly stageAll: SemanticRequestOperation<GitProjectInput, GitMutationReceipt, GitErrorCode>;
  readonly commit: SemanticRequestOperation<GitCommitInput, GitMutationReceipt, GitErrorCode>;
  readonly unstageFile: SemanticRequestOperation<GitFileInput, GitMutationReceipt, GitErrorCode>;
  readonly unstageAll: SemanticRequestOperation<GitProjectInput, GitMutationReceipt, GitErrorCode>;
  readonly switchBranch: SemanticRequestOperation<GitBranchInput, GitMutationReceipt, GitErrorCode>;
  readonly createBranch: SemanticRequestOperation<GitBranchInput, GitMutationReceipt, GitErrorCode>;
  readonly diffStats: SemanticRequestOperation<
    GitProjectInput,
    readonly GitDiffStat[],
    GitErrorCode
  >;
  readonly repositoryChanges: SemanticEventSource<
    GitRepositoryChangeScope,
    GitRepositoryChanged
  >;
}

export const gitService = defineSemanticService<GitService>("shipctl.git", 1);
