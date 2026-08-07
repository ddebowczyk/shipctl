import { Folder } from "lucide-react";
import type { ContextMenuItem } from "./ContextMenu";
import type { ProjectFactsByPath } from "../../core/modules/projectFacts";
import type { RepoGroup, RepoInfo } from "../../lib/types";
import { groupProjects } from "../../lib/projectGrouping";

interface ProjectMoveMenuOptions {
  repos: RepoInfo[];
  groups: RepoGroup[];
  projectFacts: ProjectFactsByPath;
  currentProjectPath: string | null;
  onMove: (destinationPath: string) => void;
}

/** Build the same grouped project order used by the left navigation. */
export function buildProjectMoveMenuItems({
  repos,
  groups,
  projectFacts,
  currentProjectPath,
  onMove,
}: ProjectMoveMenuOptions): ContextMenuItem[] {
  const moveTargets = repos.filter((repo) => repo.path !== currentProjectPath);
  const { sections, ungroupedRepos } = groupProjects(moveTargets, groups, projectFacts);
  const projectItem = (repo: RepoInfo): ContextMenuItem => ({
    label: repo.name,
    onClick: () => onMove(repo.path),
  });

  return [
    ...sections
      .filter((section) => section.repos.length > 0)
      .map((section) => ({
        label: section.group.name,
        icon: <Folder size={14} />,
        children: section.repos.map(projectItem),
      })),
    ...ungroupedRepos.map(projectItem),
  ];
}
