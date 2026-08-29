import { create } from "zustand";
import type { ContributionId } from "@shipctl/module-api";

interface UIStore {
  activeGlobalSurfaceId: ContributionId | null;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  usagePanelVisible: boolean;
  trailingStripVisible: boolean;
  projectsPanelVisible: boolean;
  username: string | null;
  computerName: string | null;
  toggleGlobalSurface: (surfaceId: ContributionId) => void;
  closeGlobalSurface: () => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleUsagePanel: () => void;
  toggleTrailingStrip: () => void;
  toggleProjectsPanel: () => void;
  setUsername: (name: string) => void;
  setComputerName: (name: string) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  activeGlobalSurfaceId: null,
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  usagePanelVisible: true,
  trailingStripVisible: true,
  projectsPanelVisible: true,
  username: null,
  computerName: null,
  toggleGlobalSurface: (surfaceId) =>
    set((state) => ({
      activeGlobalSurfaceId: state.activeGlobalSurfaceId === surfaceId ? null : surfaceId,
    })),
  closeGlobalSurface: () => set({ activeGlobalSurfaceId: null }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarVisible: !s.leftSidebarVisible })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  toggleUsagePanel: () => set((s) => ({ usagePanelVisible: !s.usagePanelVisible })),
  toggleTrailingStrip: () => set((s) => ({ trailingStripVisible: !s.trailingStripVisible })),
  toggleProjectsPanel: () => set((s) => ({ projectsPanelVisible: !s.projectsPanelVisible })),
  setUsername: (name: string) => set({ username: name }),
  setComputerName: (name: string) => set({ computerName: name }),
}));
