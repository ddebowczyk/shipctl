import type { TabActivity } from "@shipctl/core/platform";
import {
  activityLabel,
  type ActivityIndicatorStatus,
} from "./activityStatus.ts";

export {
  getAggregateActivityStatus,
  getTabActivityStatus,
} from "./activityStatus.ts";
export type { ActivityIndicatorStatus, AggregateActivity } from "./activityStatus.ts";

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
