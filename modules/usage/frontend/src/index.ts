import { listen } from "@tauri-apps/api/event";
import type { ShipctlModule } from "@shipctl/module-api";

import "./usage.css";

import { refreshUsageData } from "./client";
import {
  configureUsageSettingsPersistence,
  useUsageSettingsStore,
} from "./usageSettingsStore";
import { useUsageStore } from "./usageStore";

export const USAGE_SURFACE_ID = "core.usage" as const;

function fetchUsageSnapshots() {
  return useUsageStore.getState().fetchSnapshots();
}

export const usageModule = {
  id: "shipctl.usage",
  version: "0.0.0",
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
      id: "usage.snapshots-after-startup",
      moduleId: "shipctl.usage",
      schedule: { kind: "delay", delayMs: 3_000 },
      run: fetchUsageSnapshots,
    },
    {
      id: "usage.periodic-refresh",
      moduleId: "shipctl.usage",
      schedule: { kind: "interval", intervalMs: 60_000 },
      async run() {
        await refreshUsageData();
        await fetchUsageSnapshots();
      },
    },
  ],
  activate({ services }) {
    configureUsageSettingsPersistence(services.globalData);
    void useUsageSettingsStore.getState().loadSettings();
    void fetchUsageSnapshots();
    void refreshUsageData();

    const unlisten = listen("usage-ingest-complete", fetchUsageSnapshots);
    return {
      async deactivate() {
        (await unlisten)();
        configureUsageSettingsPersistence(null);
      },
    };
  },
} as const satisfies ShipctlModule;
