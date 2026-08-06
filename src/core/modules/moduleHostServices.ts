import type {
  ModuleHostServices,
  ModuleSettingsSnapshot,
  ModuleSkillsSnapshot,
} from "@shep/module-api";

import type { ProjectSettings } from "../../lib/types";
import { openUrl } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { useSkillStore } from "../../stores/useSkillStore";

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

let skillsSource: ReturnType<typeof useSkillStore.getState> | null = null;
let skillsSnapshot: ModuleSkillsSnapshot = { byProject: {} };

function getSkillsSnapshot(): ModuleSkillsSnapshot {
  const source = useSkillStore.getState();
  if (source !== skillsSource) {
    skillsSource = source;
    skillsSnapshot = { byProject: source.skillsByRepo };
  }
  return skillsSnapshot;
}

export const MODULE_HOST_SERVICES: ModuleHostServices = {
  settings: {
    getSnapshot: getSettingsSnapshot,
    subscribe: (listener) => useProjectSettingsStore.subscribe(listener),
    update: (values) => useProjectSettingsStore
      .getState()
      .updateSettings(values as Partial<ProjectSettings>),
  },
  skills: {
    getSnapshot: getSkillsSnapshot,
    subscribe: (listener) => useSkillStore.subscribe(listener),
    install: (projectPath, name) => useSkillStore.getState().install(projectPath, name),
  },
  notices: {
    push: (notice) => {
      useNoticeStore.getState().pushNotice(notice);
    },
  },
  externalLinks: {
    open: openUrl,
  },
};
