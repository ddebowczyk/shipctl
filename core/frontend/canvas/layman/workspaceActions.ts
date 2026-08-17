import type { LaymanControllerTransition } from "react-layman";

import type { WorkspaceCanvasAction } from "@shipctl/core/workspace";

import {
  workspaceStackIdFromLaymanWindowId,
  type LaymanCanvasPaneData,
} from "./workspaceProjection.ts";

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
  if (
    command?.type === "tab.move"
    && command.target.kind === "window"
  ) {
    const targetStackId = workspaceStackIdFromLaymanWindowId(command.target.windowId);
    if (targetStackId !== null && command.placement === "center") {
      return Object.freeze({
        kind: "move",
        instanceId: command.tabId,
        targetStackId,
        position: "end",
        relativeInstanceId: null,
      });
    }
    if (targetStackId !== null) {
      const split = command.placement === "left"
        ? { axis: "horizontal" as const, position: "before" as const }
        : command.placement === "right"
          ? { axis: "horizontal" as const, position: "after" as const }
          : command.placement === "top"
            ? { axis: "vertical" as const, position: "before" as const }
            : command.placement === "bottom"
              ? { axis: "vertical" as const, position: "after" as const }
              : null;
      if (split !== null) {
        return Object.freeze({
          kind: "split",
          instanceId: command.tabId,
          targetStackId,
          ...split,
        });
      }
    }
  }
  return null;
}
