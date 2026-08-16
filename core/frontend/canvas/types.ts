import type {
  ContributionId,
  GlobalNavigationContribution,
  ModuleActivationContext,
  ModuleHostServices,
  ModuleId,
  PanelContribution,
  ProjectRef,
  TerminalDriverId,
  TerminalHostDescriptor,
} from "@shipctl/module-api";
import type {
  CanvasSurfaceCatalog,
} from "@shipctl/core/host";
import type { TerminalPresentationRegistry } from "@shipctl/core/terminal-host";
import type {
  RepoGroup,
  RepoInfo,
  TerminalTabData,
  UnifiedTab,
} from "@shipctl/core/platform";

export type CanvasContentTarget =
  | {
      readonly kind: "global-surface";
      readonly surfaceId: ContributionId;
    }
  | {
      readonly kind: "panel";
      readonly panelId: ContributionId;
      readonly instanceId: string;
      readonly project: ProjectRef | null;
    }
  | {
      readonly kind: "empty";
      readonly message: string;
    }
  | {
      readonly kind: "none";
    };

/** A live terminal tab and the host descriptor needed to present it. */
export interface CanvasTerminalSlotInput {
  readonly tab: TerminalTabData;
  readonly projectPath: string;
  readonly descriptor: TerminalHostDescriptor;
}

/** A terminal presentation request. Visibility never changes its mount. */
export interface CanvasTerminalSlot {
  readonly key: string;
  readonly tabId: string;
  readonly terminalId: string;
  readonly projectPath: string;
  readonly descriptor: TerminalHostDescriptor;
  readonly visible: boolean;
}

export interface CanvasModelInput {
  readonly repos: readonly RepoInfo[];
  readonly groups: readonly RepoGroup[];
  readonly sidebarVisible: boolean;
  readonly tabDropProjectPath: string | null;
  readonly activeProjectPath: string | null;
  readonly activeTabId: string | null;
  readonly tabs: readonly UnifiedTab[];
  readonly activeTab: UnifiedTab | null;
  readonly activeGlobalSurfaceId: ContributionId | null;
  readonly activePanelId: ContributionId | null;
  readonly activeProject: ProjectRef | null;
  readonly panels: readonly PanelContribution[];
  readonly globalNavigation: readonly GlobalNavigationContribution[];
  readonly terminalSlots: readonly CanvasTerminalSlotInput[];
  readonly trailingLayoutVisible: boolean;
}

export interface CanvasModel {
  readonly sidebar: {
    readonly visible: boolean;
    readonly repos: readonly RepoInfo[];
    readonly groups: readonly RepoGroup[];
    readonly activeProjectPath: string | null;
    readonly tabDropProjectPath: string | null;
    /** Global surfaces intentionally suppress the sidebar tab highlight. */
    readonly activeTabId: string | null;
    readonly activeGlobalSurfaceId: ContributionId | null;
    readonly globalNavigation: readonly GlobalNavigationContribution[];
  };
  readonly tabBar: {
    readonly panels: readonly PanelContribution[];
  };
  readonly content: CanvasContentTarget;
  readonly terminalSlots: readonly CanvasTerminalSlot[];
  readonly trailingLayout: {
    readonly visible: boolean;
    readonly project: ProjectRef | null;
  };
}

/** Explicit operations available to a canvas adapter. The shell owns them. */
export interface CanvasActions {
  readonly selectRepo: (repoPath: string) => Promise<boolean>;
  readonly addProject: (repoPath: string) => Promise<void>;
  readonly removeProject: (repoPath: string) => void | Promise<void>;
  readonly newModuleSession: () => void;
  readonly openInEditor: (repoPath: string) => void | Promise<void>;
  readonly selectTab: (tabId: string) => void;
  readonly selectProjectTab: (repoPath: string, tabId: string) => void | Promise<void>;
  readonly closeTab: (tabId: string) => void;
  readonly moveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  readonly newDefaultTerminal: () => void;
  readonly newTerminal: (driverId: TerminalDriverId) => void;
  readonly openPanel: (panel: PanelContribution) => void;
  readonly renameTab: (tabId: string, label: string) => void | Promise<void>;
  readonly reorderTab: (tabId: string, destinationIndex: number) => void;
  readonly renameGroup: (groupId: string, newName: string) => void | Promise<void>;
  readonly deleteGroup: (groupId: string) => void | Promise<void>;
  readonly moveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  readonly setTabDropProjectPath: (projectPath: string | null) => void;
  readonly toggleGlobalSurface: (surfaceId: ContributionId) => void;
  readonly closeGlobalSurface: () => void;
  readonly setTabTitle: (tabId: string, title: string | null) => void;
}

/** Host-owned rendering dependencies. Feature modules are reached through these ports. */
export interface CanvasPorts {
  readonly surfaceCatalog: CanvasSurfaceCatalog;
  readonly terminalPresentationRegistry: TerminalPresentationRegistry;
  readonly moduleHostServices: ModuleHostServices;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}
