import type { TabActivity } from "@shipctl/core/platform";

import type { TerminalDescriptor } from "./types.ts";

/**
 * Descriptor revision orders host record mutations, while activity revision
 * independently orders reports. Preserve a newer report if a later descriptor
 * observation happens to carry an older activity projection.
 */
export function mergeTerminalDescriptorActivity(
  current: TerminalDescriptor | undefined,
  incoming: TerminalDescriptor,
): TerminalDescriptor {
  const currentActivity = current?.agentActivity;
  const incomingActivity = incoming.agentActivity;
  if (
    currentActivity
    && (!incomingActivity || currentActivity.revision > incomingActivity.revision)
  ) {
    return { ...incoming, agentActivity: currentActivity };
  }
  return incoming;
}

export function tabActivityFromDescriptor(
  descriptor: TerminalDescriptor,
  previous?: TabActivity,
): TabActivity {
  const agent = descriptor.agentActivity;
  const agentAttention = agent?.attention?.kind ?? null;
  return {
    alive: descriptor.lifecycle !== "exited",
    active: agent ? agent.state === "working" : (previous?.active ?? false),
    exitCode: descriptor.exit?.code ?? null,
    bell: previous?.bell ?? false,
    lastOutputAt: descriptor.lastOutputAtMs,
    lastAttentionAt: agentAttention ? agent?.updatedAtMs ?? null : (previous?.lastAttentionAt ?? null),
    lastNotificationMessage: agentAttention
      ? agent?.message ?? null
      : (previous?.lastNotificationMessage ?? null),
    agentState: agent?.state ?? null,
    agentAttention,
    agentRevision: agent?.revision ?? null,
    agentUpdatedAt: agent?.updatedAtMs ?? null,
    agentSource: agent ? `${agent.source.identifier}@${agent.source.version}` : null,
    agentMessage: agent?.message ?? null,
  };
}
