import { listen } from "@tauri-apps/api/event";
import type { ShepModule } from "@shep/module-api";

import { refreshUsageData } from "../../lib/tauri";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUsageStore } from "../../stores/useUsageStore";

function fetchUsageSnapshots() {
  return useUsageStore.getState().fetchSnapshots();
}

/**
 * Temporary composition adapter while Usage still lives in host source.
 * The Usage frontend extraction replaces this object with the module package.
 */
export const usageHostAdapter = {
  id: "usage",
  version: "0.5.0",
  sidebar: [
    {
      id: "usage.sidebar",
      moduleId: "usage",
      order: 100,
      load: () => import("../../components/sidebar/SidebarUsage"),
    },
  ],
  scheduledTasks: [
    {
      id: "usage.snapshots-after-startup",
      moduleId: "usage",
      schedule: { kind: "delay", delayMs: 3_000 },
      run: fetchUsageSnapshots,
    },
    {
      id: "usage.periodic-refresh",
      moduleId: "usage",
      schedule: { kind: "interval", intervalMs: 60_000 },
      async run() {
        await refreshUsageData();
        await fetchUsageSnapshots();
      },
    },
  ],
  activate() {
    void useUsageSettingsStore.getState().loadSettings();
    void fetchUsageSnapshots();
    void refreshUsageData();

    const unlisten = listen("usage-ingest-complete", fetchUsageSnapshots);
    return {
      async deactivate() {
        (await unlisten)();
      },
    };
  },
} as const satisfies ShepModule;
