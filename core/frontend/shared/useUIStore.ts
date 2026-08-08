import { create } from "zustand";
import type { ContributionId } from "@shipctl/module-api";

interface UIStore {
  activeGlobalSurfaceId: ContributionId | null;
  sidebarVisible: boolean;
  diffPanelVisible: boolean;
  username: string | null;
  computerName: string | null;
  toggleGlobalSurface: (surfaceId: ContributionId) => void;
  closeGlobalSurface: () => void;
  toggleSidebar: () => void;
  toggleDiffPanel: () => void;
  setUsername: (name: string) => void;
  setComputerName: (name: string) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  activeGlobalSurfaceId: null,
  sidebarVisible: true,
  diffPanelVisible: true,
  username: null,
  computerName: null,
  toggleGlobalSurface: (surfaceId) =>
    set((state) => ({
      activeGlobalSurfaceId: state.activeGlobalSurfaceId === surfaceId ? null : surfaceId,
    })),
  closeGlobalSurface: () => set({ activeGlobalSurfaceId: null }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleDiffPanel: () => set((s) => ({ diffPanelVisible: !s.diffPanelVisible })),
  setUsername: (name: string) => set({ username: name }),
  setComputerName: (name: string) => set({ computerName: name }),
}));
