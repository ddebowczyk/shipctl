import type {
  BroadcastTopic,
  DirectedChannel,
  MessageTypeContract,
  ShipctlModule,
} from "@shipctl/module-api";

import "./usage.css";

import {
  activeUsageSourcesClient,
  configureUsageSourcesClient,
  usageSourcesClientFor,
} from "./usageSourcesClient";
import {
  configureUsageSettingsPersistence,
  useUsageSettingsStore,
} from "./usageSettingsStore";
import { usageSettingsDataClientFor } from "./usageSettingsDataClient";
import { useUsageStore } from "./usageStore";
import { notifyUsageIngestCompleted } from "./ingestCompleted";

export const USAGE_SURFACE_ID = "core.usage" as const;

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

const USAGE_REFRESH_CHANNEL: DirectedChannel<UsageRefreshRequest> = {
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

function fetchUsageSnapshots() {
  return useUsageStore.getState().fetchSnapshots();
}

async function refreshUsageAndSnapshots() {
  await activeUsageSourcesClient().refreshUsageData();
  await fetchUsageSnapshots();
}

export const usageModule = {
  id: "shipctl.usage",
  version: "0.0.0",
  requiredGrants: [
    "usage-source.read",
    "usage-source.refresh",
    "usage-source.observe",
    "plugin-data.read",
    "plugin-data.write",
    "message.send.usage.refresh-request",
    "message.publish.usage.ingest-completed",
    "message.subscribe.usage.ingest-completed",
    "schedule.register",
  ],
  globalSurfaces: [
    {
      id: USAGE_SURFACE_ID,
      moduleId: "shipctl.usage",
      unavailable: {
        title: "Usage unavailable",
        description: "The Usage module could not be loaded.",
      },
      load: () => import("./UsagePanel"),
    },
  ],
  globalNavigation: [
    {
      id: "usage.global-navigation",
      moduleId: "shipctl.usage",
      surfaceId: USAGE_SURFACE_ID,
      label: "Usage",
      icon: { name: "chart-no-axes-combined" },
      order: 20,
    },
  ],
  sidebar: [
    {
      id: "usage.sidebar",
      moduleId: "shipctl.usage",
      surfaceId: USAGE_SURFACE_ID,
      order: 100,
      load: () => import("./SidebarUsage"),
    },
  ],
  settings: [
    {
      id: "usage.settings",
      moduleId: "shipctl.usage",
      slot: "terminal.after",
      order: 10,
      load: () => import("./UsageSettingsSection"),
    },
  ],
  scheduledTasks: [
    {
      id: "usage.periodic-refresh",
      moduleId: "shipctl.usage",
      schedule: {
        cron: "* * * * * Etc/UTC",
        target: { kind: "channel", endpoint: USAGE_REFRESH_CHANNEL },
        payload: {},
      },
    },
  ],
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
  },
  activate({ activation }) {
    const usageSources = usageSourcesClientFor(activation);
    configureUsageSourcesClient(usageSources);
    configureUsageSettingsPersistence(usageSettingsDataClientFor(activation));
    void useUsageSettingsStore.getState().loadSettings();
    void fetchUsageSnapshots();
    void usageSources.refreshUsageData();
    void usageSources.subscribeChanges(async () => {
      await Promise.allSettled([
        fetchUsageSnapshots(),
        notifyUsageIngestCompleted(),
      ]);
    }).catch((error) => {
      if (import.meta.env.DEV) console.error("Usage source observation failed:", error);
    });

    return {
      deactivate() {
        configureUsageSourcesClient(null);
        configureUsageSettingsPersistence(null);
      },
    };
  },
} as const satisfies ShipctlModule;
