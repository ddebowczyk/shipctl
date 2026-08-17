import type { LaymanControllerTransition } from "react-layman";

import type { WorkspaceCanvasAction } from "@shipctl/core/workspace";

import type { LaymanCanvasPaneData } from "./workspaceProjection.ts";

/**
 * Translate an accepted Layman user transition into a semantic workspace
 * action. Layout mechanics remain renderer-local until the workspace exposes
 * matching commands.
 */
export function laymanWorkspaceAction(
  transition: LaymanControllerTransition<LaymanCanvasPaneData>,
): WorkspaceCanvasAction | null {
  if (transition.kind !== "command" || transition.status !== "applied" || transition.meta.origin !== "user") {
    return null;
  }
  const command = transition.command;
  if (command?.type === "tab.select") {
    return Object.freeze({ kind: "select", instanceId: command.tabId });
  }
  if (command?.type === "tab.remove") {
    return Object.freeze({ kind: "close", instanceId: command.tabId });
  }
  return null;
}
