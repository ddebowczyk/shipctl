import type { TabActivity } from "@shipctl/core/platform";

export type ActivityIndicatorStatus = "idle" | "running" | "active" | "attention" | "failed";

export interface AggregateActivity {
  hasAttention?: boolean;
  hasCrash?: boolean;
  hasActive?: boolean;
  hasRunning?: boolean;
}

export function getTabActivityStatus(activity: TabActivity | undefined): ActivityIndicatorStatus {
  if (!activity) return "idle";
  if (!activity.alive) return activity.exitCode === 0 ? "idle" : "failed";
  if (activity.agentRevision !== null) {
    if (activity.agentAttention !== null || activity.agentState === "blocked") return "attention";
    if (activity.agentState === "working") return "active";
    return "running";
  }
  if (activity.bell) return "attention";
  if (activity.active) return "active";
  return "running";
}

export function getAggregateActivityStatus(
  activity: AggregateActivity | undefined,
): ActivityIndicatorStatus | null {
  if (!activity) return null;
  if (activity.hasCrash) return "failed";
  if (activity.hasAttention) return "attention";
  if (activity.hasActive) return "active";
  if (activity.hasRunning) return "running";
  return null;
}

export function activityLabel(
  status: ActivityIndicatorStatus,
  activity?: TabActivity,
): string {
  if (status === "failed") {
    return activity?.exitCode == null ? "Failed" : `Failed with exit code ${activity.exitCode}`;
  }
  if (activity?.agentRevision !== null && activity?.agentRevision !== undefined) {
    const state = activity.agentAttention ?? activity.agentState ?? "idle";
    const headline = state === "completed"
      ? "Agent completed"
      : state === "blocked"
        ? "Agent blocked"
        : state === "working"
          ? "Agent working"
          : "Agent idle";
    const details = [
      activity.agentMessage,
      activity.agentSource,
      activity.agentUpdatedAt == null
        ? null
        : new Date(activity.agentUpdatedAt).toLocaleString(),
    ].filter((value): value is string => Boolean(value));
    return details.length === 0 ? headline : `${headline}: ${details.join(" · ")}`;
  }
  if (status === "attention") return activity?.lastNotificationMessage || "Needs attention";
  if (status === "active") return "Active output";
  if (status === "running") return "Running, quiet";
  return "Idle";
}
