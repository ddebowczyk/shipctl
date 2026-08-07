import type {
  ModuleHostServices,
  ModuleSettingsSnapshot,
} from "@shep/module-api";

import type { ProjectSettings } from "../../lib/types";
import { contributedPanelTabId } from "../../lib/types";
import { loadWorkspace, openUrl, saveWorkspace } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useThemeStore } from "../../stores/useThemeStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { modulePanelContributions, moduleSkillsProvider } from "./moduleComposition";
import { createProjectCapabilityDataPort } from "./projectCapabilityData";

let settingsSource: ReturnType<typeof useProjectSettingsStore.getState> | null = null;
let settingsSnapshot: ModuleSettingsSnapshot = {
  values: {},
  isSaving: false,
  error: null,
};

let appearanceSource: ReturnType<typeof useThemeStore.getState>["theme"] | null = null;
let appearanceSnapshot = { themeId: "", background: "" };

function getAppearanceSnapshot() {
  const theme = useThemeStore.getState().theme;
  if (theme !== appearanceSource) {
    appearanceSource = theme;
    appearanceSnapshot = { themeId: theme.id, background: theme.appBg };
  }
  return appearanceSnapshot;
}

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

const projectData = createProjectCapabilityDataPort({
  load: loadWorkspace,
  save: saveWorkspace,
  onSaved: (projectPath, document) => {
    const repoState = useRepoStore.getState();
    if (repoState.activeRepoPath === projectPath) {
      repoState.setActiveConfig(document);
    }
  },
});

export const MODULE_HOST_SERVICES: ModuleHostServices = {
  panels: {
    open: (panelId) => {
      const panel = modulePanelContributions().find(({ id }) => id === panelId);
      if (!panel) throw new Error(`Panel ${panelId} is unavailable`);
      useTerminalStore.getState().addContributedPanelTab(panelId, panel.label);
      return contributedPanelTabId(panelId);
    },
    reveal: (instanceId) => {
      const state = useTerminalStore.getState();
      if (state.activeProjectPath) state.setActiveTab(instanceId);
    },
    close: (instanceId) => useTerminalStore.getState().removeTab(instanceId),
  },
  appearance: {
    getSnapshot: getAppearanceSnapshot,
    subscribe: (listener) => useThemeStore.subscribe(listener),
  },
  projectData,
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
