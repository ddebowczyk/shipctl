import type {
  ModuleHostServices,
  ModuleSettingsSnapshot,
} from "@shipctl/module-api";

import type { ProjectSettingsPatch } from "@shipctl/core/configuration";
import { contributedPanelTabId } from "@shipctl/core/platform";
import {
  openUrl,
} from "@shipctl/core/platform";
import { useNoticeStore } from "../shared/useNoticeStore.ts";
import { useProjectSettingsStore } from "../projects/useProjectSettingsStore.ts";
import { useRepoStore } from "../projects/useRepoStore.ts";
import { useThemeStore } from "../appearance/useThemeStore.ts";
import { useTerminalStore } from "../terminal-host/useTerminalStore.ts";
import { modulePanelContributions, moduleSkillsProvider } from "./moduleComposition.ts";
import { MODULE_TERMINAL_SESSIONS } from "../terminal-host/terminalSessions.ts";
import {
  terminalPresentationPort,
  useTerminalSettingsStore,
} from "@shipctl/core/terminal-host";

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
  terminalSessions: MODULE_TERMINAL_SESSIONS,
  terminalPresentation: terminalPresentationPort,
  settings: {
    getSnapshot: getSettingsSnapshot,
    subscribe: (listener) => useProjectSettingsStore.subscribe(listener),
    update: (values) => useProjectSettingsStore
      .getState()
      .updateSettings(values as ProjectSettingsPatch),
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
    open: (url) => openUrl(url, useTerminalSettingsStore.getState().settings.urlAllowlist),
  },
};
