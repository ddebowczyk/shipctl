import type {
  ModuleHostServices,
  ModuleSettingsSnapshot,
} from "@shep/module-api";

import type { ProjectSettings } from "../../lib/types";
import { openUrl } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { moduleSkillsProvider } from "./moduleComposition";

let settingsSource: ReturnType<typeof useProjectSettingsStore.getState> | null = null;
let settingsSnapshot: ModuleSettingsSnapshot = {
  values: {},
  isSaving: false,
  error: null,
};

function getSettingsSnapshot(): ModuleSettingsSnapshot {
  const source = useProjectSettingsStore.getState();
  if (source !== settingsSource) {
    settingsSource = source;
    settingsSnapshot = {
      values: source.settings as unknown as Readonly<Record<string, unknown>>,
      isSaving: source.isSaving,
      error: source.error,
    };
  }
  return settingsSnapshot;
}

const skillsProvider = moduleSkillsProvider() ?? {
  getSnapshot: () => ({ byProject: {} }),
  subscribe: () => () => undefined,
  install: async () => {
    throw new Error("Skills capability is unavailable in this build");
  },
};

export const MODULE_HOST_SERVICES: ModuleHostServices = {
  settings: {
    getSnapshot: getSettingsSnapshot,
    subscribe: (listener) => useProjectSettingsStore.subscribe(listener),
    update: (values) => useProjectSettingsStore
      .getState()
      .updateSettings(values as Partial<ProjectSettings>),
  },
  skills: skillsProvider,
  notices: {
    push: (notice) => {
      useNoticeStore.getState().pushNotice(notice);
    },
  },
  externalLinks: {
    open: openUrl,
  },
};
