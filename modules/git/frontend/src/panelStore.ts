import { create } from "zustand";

export const MIN_DIFF_STRIP_WIDTH = 56;

export function resizedDiffStripWidth(
  startWidth: number,
  startPointerX: number,
  currentPointerX: number,
  availableWidth: number,
): number {
  const maximumWidth = Math.max(MIN_DIFF_STRIP_WIDTH, availableWidth);
  const requestedWidth = startWidth + startPointerX - currentPointerX;
  return Math.min(maximumWidth, Math.max(MIN_DIFF_STRIP_WIDTH, requestedWidth));
}

export interface ProjectPanelState {
  repoSelectedPath: string | null;
  repoExpanded: string[];
  leftSearch: string;
  viewerMode: "file" | "diff";
  repoPreferredDiffArea: Record<string, "staged" | "unstaged" | "untracked">;
  sidebarCollapsed: boolean;
  repoScrollPositions: Record<string, number>;
}

const DEFAULT_STATE: ProjectPanelState = {
  repoSelectedPath: null,
  repoExpanded: [],
  leftSearch: "",
  viewerMode: "file",
  repoPreferredDiffArea: {},
  sidebarCollapsed: false,
  repoScrollPositions: {},
};

interface GitPanelStore {
  diffStripWidth: number;
  perRepo: Record<string, ProjectPanelState>;
  setDiffStripWidth: (width: number) => void;
  setRepoSelection: (repo: string, path: string | null) => void;
  setRepoExpanded: (repo: string, expanded: string[]) => void;
  setLeftSearch: (repo: string, search: string) => void;
  setViewerMode: (repo: string, mode: "file" | "diff") => void;
  setRepoPreferredDiffArea: (
    repo: string,
    filePath: string,
    area: "staged" | "unstaged" | "untracked",
  ) => void;
  setSidebarCollapsed: (repo: string, collapsed: boolean) => void;
  setRepoScrollPosition: (repo: string, filePath: string, pos: number) => void;
}

export const useGitPanelStore = create<GitPanelStore>((set) => ({
  diffStripWidth: MIN_DIFF_STRIP_WIDTH,
  perRepo: {},
  setDiffStripWidth: (width) => set({ diffStripWidth: width }),
  setRepoSelection: (repo, path) => set((state) => ({
    perRepo: { ...state.perRepo, [repo]: { ...(state.perRepo[repo] ?? DEFAULT_STATE), repoSelectedPath: path } },
  })),
  setRepoExpanded: (repo, expanded) => set((state) => ({
    perRepo: { ...state.perRepo, [repo]: { ...(state.perRepo[repo] ?? DEFAULT_STATE), repoExpanded: expanded } },
  })),
  setLeftSearch: (repo, search) => set((state) => ({
    perRepo: { ...state.perRepo, [repo]: { ...(state.perRepo[repo] ?? DEFAULT_STATE), leftSearch: search } },
  })),
  setViewerMode: (repo, mode) => set((state) => ({
    perRepo: { ...state.perRepo, [repo]: { ...(state.perRepo[repo] ?? DEFAULT_STATE), viewerMode: mode } },
  })),
  setRepoPreferredDiffArea: (repo, filePath, area) => set((state) => {
    const existing = state.perRepo[repo] ?? DEFAULT_STATE;
    return {
      perRepo: {
        ...state.perRepo,
        [repo]: {
          ...existing,
          repoPreferredDiffArea: { ...existing.repoPreferredDiffArea, [filePath]: area },
        },
      },
    };
  }),
  setSidebarCollapsed: (repo, collapsed) => set((state) => ({
    perRepo: { ...state.perRepo, [repo]: { ...(state.perRepo[repo] ?? DEFAULT_STATE), sidebarCollapsed: collapsed } },
  })),
  setRepoScrollPosition: (repo, filePath, pos) => set((state) => {
    const existing = state.perRepo[repo] ?? DEFAULT_STATE;
    return {
      perRepo: {
        ...state.perRepo,
        [repo]: {
          ...existing,
          repoScrollPositions: { ...existing.repoScrollPositions, [filePath]: pos },
        },
      },
    };
  }),
}));
