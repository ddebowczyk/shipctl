import type { GitStatus, RepoGroup, RepoInfo } from "./types";

export interface ProjectGroupSection {
  group: RepoGroup;
  repos: RepoInfo[];
}

export interface ProjectGrouping {
  sections: ProjectGroupSection[];
  ungroupedRepos: RepoInfo[];
}

/** Keep project ordering consistent between the sidebar and project menus. */
export function groupProjects(
  repos: RepoInfo[],
  groups: RepoGroup[],
  gitStatuses: Record<string, GitStatus>,
): ProjectGrouping {
  const validGroupIds = new Set(groups.map((group) => group.id));
  const grouped = new Map<string, RepoInfo[]>();
  const ungroupedRepos: RepoInfo[] = [];

  for (const repo of repos) {
    if (repo.group && validGroupIds.has(repo.group)) {
      const groupRepos = grouped.get(repo.group) ?? [];
      groupRepos.push(repo);
      grouped.set(repo.group, groupRepos);
    } else {
      ungroupedRepos.push(repo);
    }
  }

  const sortRepos = (a: RepoInfo, b: RepoInfo) => {
    const aWorktreeParent = gitStatuses[a.path]?.worktree_parent ?? null;
    const bWorktreeParent = gitStatuses[b.path]?.worktree_parent ?? null;
    const aSortName = aWorktreeParent ?? a.name;
    const bSortName = bWorktreeParent ?? b.name;
    const groupCompare = aSortName.localeCompare(bSortName);
    if (groupCompare !== 0) return groupCompare;
    if (aWorktreeParent == null && bWorktreeParent != null) return -1;
    if (aWorktreeParent != null && bWorktreeParent == null) return 1;
    return a.name.localeCompare(b.name);
  };

  for (const groupRepos of grouped.values()) {
    groupRepos.sort(sortRepos);
  }
  ungroupedRepos.sort(sortRepos);

  return {
    sections: [...groups]
      .sort((a, b) => a.order - b.order)
      .map((group) => ({ group, repos: grouped.get(group.id) ?? [] })),
    ungroupedRepos,
  };
}
