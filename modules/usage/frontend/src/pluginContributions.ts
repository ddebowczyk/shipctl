import type {
  BroadcastTopic,
  DirectedChannel,
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  MessageTypeContract,
  ModuleActivationContext,
  ModuleMessageContributions,
  ModuleScheduledTask,
  SemanticEventLease,
  SettingsContribution,
  SidebarContribution,
} from "@shipctl/module-api";

import { notifyUsageIngestCompleted } from "./ingestCompleted";
import {
  activeUsageSourcesClient,
  configureUsageSourcesClient,
  usageSourcesClientFor,
} from "./usageSourcesClient";
import { usageSettingsDataClientFor } from "./usageSettingsDataClient";
import {
  configureUsageSettingsPersistence,
  useUsageSettingsStore,
} from "./usageSettingsStore";
import { useUsageStore } from "./usageStore";

export const USAGE_MODULE_ID = "shipctl.usage" as const;
export const USAGE_PLUGIN_VERSION = "0.0.0" as const;
export const USAGE_SURFACE_ID = "core.usage" as const;
export const USAGE_RUNTIME_EFFECT_ID = "usage.runtime" as const;

export const USAGE_REQUIRED_GRANTS = [
  "usage-source.read",
  "usage-source.refresh",
  "usage-source.observe",
  "plugin-data.read",
  "plugin-data.write",
  "message.send.usage.refresh-request",
  "message.publish.usage.ingest-completed",
  "message.subscribe.usage.ingest-completed",
  "schedule.register",
] as const;

type UsageIngestCompleted = Record<string, never>;
type UsageRefreshRequest = Record<string, never>;

const USAGE_INGEST_COMPLETED = {
  id: "usage.ingest-completed",
  version: 1,
} as const;

const USAGE_INGEST_COMPLETED_TOPIC: BroadcastTopic<UsageIngestCompleted> = {
  id: "usage.ingest-completed",
  message: USAGE_INGEST_COMPLETED,
};

const USAGE_INGEST_COMPLETED_CONTRACT: MessageTypeContract<UsageIngestCompleted> = {
  message: USAGE_INGEST_COMPLETED,
  schema: {
    draft: "https://json-schema.org/draft/2020-12/schema",
    root: "messages/ingest-completed.schema.json",
    resources: {
      "messages/ingest-completed.schema.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "shipctl-artifact:///messages/ingest-completed.schema.json",
        type: "object",
        additionalProperties: false,
      },
    },
    // The only legal compact JSON value is `{}`.
    maxEncodedBytes: 2,
    redactedFields: [],
    compatibleVersions: [1],
  },
};

const USAGE_REFRESH_REQUEST = {
  id: "usage.refresh-request",
  version: 1,
} as const;

export const USAGE_REFRESH_CHANNEL: DirectedChannel<UsageRefreshRequest> = {
  id: "usage.refresh-request",
  message: USAGE_REFRESH_REQUEST,
};

const USAGE_REFRESH_REQUEST_CONTRACT: MessageTypeContract<UsageRefreshRequest> = {
  message: USAGE_REFRESH_REQUEST,
  schema: {
    draft: "https://json-schema.org/draft/2020-12/schema",
    root: "messages/refresh-request.schema.json",
    resources: {
      "messages/refresh-request.schema.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "shipctl-artifact:///messages/refresh-request.schema.json",
        type: "object",
        additionalProperties: false,
      },
    },
    // The only legal compact JSON value is `{}`.
    maxEncodedBytes: 2,
    redactedFields: [],
    compatibleVersions: [1],
  },
};

function fetchUsageSnapshots(): Promise<void> {
  return useUsageStore.getState().fetchSnapshots();
}

export async function refreshUsageAndSnapshots(): Promise<void> {
  await activeUsageSourcesClient().refreshUsageData();
  await fetchUsageSnapshots();
}

/**
 * Inert declarations remain plain values until the direct artifact registers
 * them through its activation context. They intentionally do not form a
 * transitional `ShipctlModule` compatibility object.
 */
export const usageContributions = Object.freeze({
  globalSurfaces: Object.freeze([
    {
      id: USAGE_SURFACE_ID,
      moduleId: USAGE_MODULE_ID,
      unavailable: {
        title: "Usage unavailable",
        description: "The Usage module could not be loaded.",
      },
      load: () => import("./UsagePanel"),
    },
  ] satisfies readonly GlobalSurfaceContribution[]),
  globalNavigation: Object.freeze([
    {
      id: "usage.global-navigation",
      moduleId: USAGE_MODULE_ID,
      surfaceId: USAGE_SURFACE_ID,
      label: "Usage",
      icon: { name: "chart-no-axes-combined" },
      order: 20,
    },
  ] satisfies readonly GlobalNavigationContribution[]),
  sidebars: Object.freeze([
    {
      id: "usage.sidebar",
      moduleId: USAGE_MODULE_ID,
      surfaceId: USAGE_SURFACE_ID,
      order: 100,
      load: () => import("./SidebarUsage"),
    },
  ] satisfies readonly SidebarContribution[]),
  settings: Object.freeze([
    {
      id: "usage.settings",
      moduleId: USAGE_MODULE_ID,
      slot: "terminal.after",
      order: 10,
      load: () => import("./UsageSettingsSection"),
    },
  ] satisfies readonly SettingsContribution[]),
  scheduledTasks: Object.freeze([
    {
      id: "usage.periodic-refresh",
      moduleId: USAGE_MODULE_ID,
      schedule: {
        cron: "* * * * * Etc/UTC",
        target: { kind: "channel", endpoint: USAGE_REFRESH_CHANNEL },
        payload: {},
      },
    },
  ] satisfies readonly ModuleScheduledTask[]),
  messages: {
    provides: [USAGE_INGEST_COMPLETED_CONTRACT, USAGE_REFRESH_REQUEST_CONTRACT],
    handles: [{
      channel: USAGE_REFRESH_CHANNEL,
      // Provider refresh accepts one in-flight operation, so one pending
      // request preserves the existing refresh coalescing semantics.
      capacity: 1,
      requiredGrant: "message.send.usage.refresh-request",
      schedulerAllowed: true,
      handle: refreshUsageAndSnapshots,
    }],
    publishes: [{
      topic: USAGE_INGEST_COMPLETED_TOPIC,
      // Completion is a coalescible state signal: one pending notification is
      // sufficient because consumers refresh from the authoritative snapshot.
      capacity: 1,
      requiredGrant: "message.publish.usage.ingest-completed",
      schedulerAllowed: false,
    }],
    subscribes: [{
      topic: USAGE_INGEST_COMPLETED_TOPIC,
      // The semantic Usage Sources observer performs the refresh. Retain this
      // handler until the declared compatibility topic can be removed.
      handle() {},
    }],
  } satisfies ModuleMessageContributions,
});

/**
 * Bind the global store adapters and retain the semantic source observer for
 * exactly one direct activation. The artifact owns this cleanup as its stable
 * `usage.runtime` background effect.
 */
export async function activateUsageRuntime(
  activation: ModuleActivationContext,
): Promise<() => Promise<void>> {
  let active = true;
  let sourceSubscription: SemanticEventLease | null = null;
  const usageSources = usageSourcesClientFor(activation);

  configureUsageSourcesClient(usageSources);
  configureUsageSettingsPersistence(usageSettingsDataClientFor(activation));

  const cleanup = async () => {
    if (!active) return;
    active = false;
    await sourceSubscription?.dispose();
    configureUsageSourcesClient(null);
    configureUsageSettingsPersistence(null);
  };

  try {
    sourceSubscription = await usageSources.subscribeChanges(async () => {
      if (!active) return;
      await Promise.allSettled([
        fetchUsageSnapshots(),
        notifyUsageIngestCompleted(),
      ]);
    });
    void useUsageSettingsStore.getState().loadSettings();
    void fetchUsageSnapshots();
    void usageSources.refreshUsageData().catch((error) => {
      if (active && import.meta.env.DEV) {
        console.error("Usage source refresh failed:", error);
      }
    });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
