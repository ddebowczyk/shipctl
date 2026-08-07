import type { TabActivity } from "@shep/core/platform";

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
  if (activity.bell) return "attention";
  if (activity.active) return "active";
  return "running";
}

export function getAggregateActivityStatus(activity: AggregateActivity | undefined): ActivityIndicatorStatus | null {
  if (!activity) return null;
  if (activity.hasCrash) return "failed";
  if (activity.hasAttention) return "attention";
  if (activity.hasActive) return "active";
  if (activity.hasRunning) return "running";
  return null;
}

function activityLabel(status: ActivityIndicatorStatus, activity?: TabActivity): string {
  if (status === "failed") return activity?.exitCode == null ? "Failed" : `Failed with exit code ${activity.exitCode}`;
  if (status === "attention") return activity?.lastNotificationMessage || "Needs attention";
  if (status === "active") return "Active output";
  if (status === "running") return "Running, quiet";
  return "Idle";
}

interface ActivityIndicatorProps {
  status: ActivityIndicatorStatus;
  activity?: TabActivity;
  className?: string;
}

export default function ActivityIndicator({
  status,
  activity,
  className = "",
}: ActivityIndicatorProps) {
  const label = activityLabel(status, activity);

  return (
    <span
      className={`activity-indicator activity-indicator--${status}${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
    />
  );
}
