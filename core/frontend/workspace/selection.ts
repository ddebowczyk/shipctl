import type { UiWorkspaceDocument, WorkspaceNode } from "@shipctl/module-api";

function selectedIdsInNode(node: WorkspaceNode): readonly string[] {
  if (node.kind === "stack") return [node.selectedInstanceId];
  return [
    ...selectedIdsInNode(node.first),
    ...selectedIdsInNode(node.second),
  ];
}

/**
 * Return the semantic selections in deterministic tree order. A split can
 * have one selected view in each stack; adapters decide which ones they can
 * present at once.
 */
export function selectedWorkspaceInstanceIds(
  document: UiWorkspaceDocument,
): readonly string[] {
  return Object.freeze([
    ...(document.root === null ? [] : selectedIdsInNode(document.root)),
    ...document.floating.map((floating) => floating.stack.selectedInstanceId),
  ]);
}

/** Stable singleton identity used when a host opens a global semantic view. */
export function workspaceGlobalInstanceId(viewTypeId: string): string {
  return `shipctl.workspace.global:${viewTypeId}`;
}

/** Stable per-project identity for a project-scoped semantic workspace view. */
export function workspaceProjectInstanceId(viewTypeId: string, projectId: string): string {
  return `shipctl.workspace.project:${encodeURIComponent(viewTypeId)}:${encodeURIComponent(projectId)}`;
}
