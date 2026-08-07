import type {
  ModuleHostServices,
  ModuleSettingsSnapshot,
} from "@shep/module-api";

import type { ProjectSettings } from "@shep/core/platform";
import { contributedPanelTabId } from "@shep/core/platform";
import {
  getGlobalCapabilityData,
  loadWorkspace,
  openUrl,
  replaceGlobalCapabilityData,
  saveWorkspace,
} from "@shep/core/platform";
import { useNoticeStore } from "../shared/useNoticeStore.ts";
import { useProjectSettingsStore } from "../projects/useProjectSettingsStore.ts";
import { useRepoStore } from "../projects/useRepoStore.ts";
import { useThemeStore } from "../appearance/useThemeStore.ts";
import { useTerminalStore } from "../terminal/useTerminalStore.ts";
import { modulePanelContributions, moduleSkillsProvider } from "./moduleComposition.ts";
import { createProjectCapabilityDataPort } from "./projectCapabilityData.ts";
import { createGlobalCapabilityDataPort } from "./globalCapabilityData.ts";
import { MODULE_TERMINAL_SESSIONS } from "../terminal/terminalSessions.ts";

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

const globalData = createGlobalCapabilityDataPort({
  read: getGlobalCapabilityData,
  replace: replaceGlobalCapabilityData,
});

export const MODULE_HOST_SERVICES: ModuleHostServices = {
  panels: {
    open: (panelId) => {
      const panel = modulePanelContributions().find(({ id }) => id === panelId);
      if (!panel) throw new Error(`Panel ${panelId} is unavailable`);
      const projectPath = useRepoStore.getState().activeRepoPath;
      if (projectPath) {
        useTerminalStore.getState().addContributedPanelTab(projectPath, panelId, panel.label);
      }
      return contributedPanelTabId(panelId);
    },
    reveal: (instanceId) => {
      const projectPath = useRepoStore.getState().activeRepoPath;
      if (projectPath) useTerminalStore.getState().setActiveTab(projectPath, instanceId);
    },
    close: (instanceId) => {
      const projectPath = useRepoStore.getState().activeRepoPath;
      if (projectPath) useTerminalStore.getState().removeTab(projectPath, instanceId);
    },
  },
  appearance: {
    getSnapshot: getAppearanceSnapshot,
    subscribe: (listener) => useThemeStore.subscribe(listener),
  },
  globalData,
  projectData,
  terminalSessions: MODULE_TERMINAL_SESSIONS,
  settings: {
    getSnapshot: getSettingsSnapshot,
    subscribe: (listener) => useProjectSettingsStore.subscribe(listener),
    update: (values) => useProjectSettingsStore
      .getState()
      .updateSettings(values as Partial<ProjectSettings>),
  },
  skills: skillsProvider,
  notices: {
    push: (notice, options) => {
      useNoticeStore.getState().pushNotice(
        {
          ...notice,
          actions: notice.actions ? [...notice.actions] : undefined,
        },
        options,
      );
    },
  },
  externalLinks: {
    open: openUrl,
  },
};
