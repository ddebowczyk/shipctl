import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  prepareFileTreeInput,
  type FileTreeIconConfig,
  type GitStatusEntry,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

/** Change classification for a node in the tree. `added` covers untracked
 *  and newly-staged files (rendered green); `modified` covers existing
 *  files with edits and folders that contain any changed descendants
 *  (rendered in the theme's attention/dirty color). */
export type ChangeKind = "added" | "modified" | null;

export interface FileTreeProps {
  /** Flat list of repo-relative paths to render. */
  files: string[];
  /** Map of repo-relative paths to their change kind. Files not in the
   *  map render without any change indicator. Folders derive their kind
   *  from descendants at tree-build time. */
  changedPaths: Map<string, Exclude<ChangeKind, null>>;
  /** Paths that are not yet tracked by git (status `?`). Rendered with a
   *  dimmed name so the eye can distinguish "new on disk, not in git yet"
   *  from "new and already staged" even though both are colored green. */
  untrackedPaths: Set<string>;
  /** Filter term from the Git panel search. When non-empty, paths are
   *  filtered before reaching Trees so the same term can also highlight
   *  matching lines in the file viewer. */
  search: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedPaths: string[];
  onExpandedChange: (expanded: string[]) => void;
}

type TreeStyle = CSSProperties & Record<`--${string}`, string | number>;

const TREE_ICONS: FileTreeIconConfig = {
  set: "complete",
  colored: true,
};

const TREE_STYLE: TreeStyle = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--text-secondary)",
  "--trees-fg-muted-override": "var(--text-muted)",
  "--trees-bg-muted-override": "color-mix(in srgb, var(--overlay) 5%, transparent)",
  "--trees-accent-override": "var(--status-running)",
  "--trees-border-color-override": "transparent",
  "--trees-focus-ring-color-override": "transparent",
  "--trees-focus-ring-width-override": "0px",
  "--trees-selected-fg-override": "var(--text-primary)",
  "--trees-selected-bg-override": "color-mix(in srgb, var(--overlay) 6%, transparent)",
  "--trees-selected-focused-border-color-override": "transparent",
  "--trees-status-added-override": "color-mix(in srgb, var(--status-added) var(--color-opacity-utilization), var(--text-primary))",
  "--trees-status-untracked-override": "color-mix(in srgb, var(--status-added) var(--color-opacity-utilization), var(--text-primary))",
  "--trees-status-modified-override": "color-mix(in srgb, var(--status-attention) var(--color-opacity-utilization), var(--text-primary))",
  "--trees-status-renamed-override": "color-mix(in srgb, var(--status-attention) var(--color-opacity-utilization), var(--text-primary))",
  "--trees-status-deleted-override": "var(--status-deleted)",
  "--trees-git-added-color-override": "var(--trees-status-added)",
  "--trees-git-untracked-color-override": "var(--trees-status-untracked)",
  "--trees-git-modified-color-override": "var(--trees-status-modified)",
  "--trees-git-renamed-color-override": "var(--trees-status-renamed)",
  "--trees-git-deleted-color-override": "var(--trees-status-deleted)",
  "--trees-font-family-override": "inherit",
  "--trees-font-size-override": "13px",
  "--trees-font-weight-regular-override": "400",
  "--trees-font-weight-semibold-override": "600",
  "--trees-item-height": "26px",
  "--trees-level-gap-override": "8px",
  "--trees-item-padding-x-override": "4px",
  "--trees-item-margin-x-override": "0px",
  "--trees-padding-inline-override": "0px",
  "--trees-icon-width-override": "14px",
  "--trees-git-lane-width-override": "12px",
  "--trees-action-lane-width-override": "0px",
};

const TREE_UNSAFE_CSS = `
  [data-item-git-status='untracked'] > [data-item-section='content'] {
    opacity: 0.6;
  }

  [data-item-section='action'] {
    display: none;
  }
`;

function normalizeDirectoryPath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function collectDirectoryPaths(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return Array.from(directories).sort();
}

function collectAncestorPaths(path: string): string[] {
  const parts = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index++) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

function areSamePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createPathListKey(paths: readonly string[]): string {
  return paths.join("\0");
}

function resolveInitialExpandedPaths(
  expandedPaths: readonly string[],
  directoryPaths: readonly string[],
  searchValue: string,
): string[] {
  if (!searchValue) return [...expandedPaths];
  return Array.from(new Set([...expandedPaths, ...directoryPaths])).sort();
}

function buildGitStatus(
  changedPaths: Map<string, Exclude<ChangeKind, null>>,
  untrackedPaths: Set<string>,
): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const seen = new Set<string>();

  for (const path of untrackedPaths) {
    entries.push({ path, status: "untracked" });
    seen.add(path);
  }

  for (const [path, kind] of changedPaths) {
    if (seen.has(path)) continue;
    entries.push({ path, status: kind === "added" ? "added" : "modified" });
  }

  return entries;
}

interface TreesFileTreeProps extends FileTreeProps {
  directoryPaths: string[];
  gitStatus: GitStatusEntry[];
  hasSearchMatches: boolean;
  searchValue: string;
}

function TreesFileTree({
  files,
  directoryPaths,
  expandedPaths,
  gitStatus,
  hasSearchMatches,
  onExpandedChange,
  onSelect,
  search,
  searchValue,
  selectedPath,
}: TreesFileTreeProps) {
  const filesKey = useMemo(() => createPathListKey(files), [files]);
  const fileSet = useMemo(() => new Set(files), [filesKey]);
  const fileSetRef = useRef(fileSet);
  const onSelectRef = useRef(onSelect);
  const expandedPathsRef = useRef(expandedPaths);
  const directoryPathsRef = useRef(directoryPaths);
  const preparedInput = useMemo(
    () => prepareFileTreeInput(files, { flattenEmptyDirectories: false }),
    [filesKey],
  );
  const lastExpandedRef = useRef<string[]>([...expandedPaths].sort());

  useEffect(() => {
    fileSetRef.current = fileSet;
  }, [fileSet]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    directoryPathsRef.current = directoryPaths;
  }, [directoryPaths]);

  const { model } = useFileTree({
    preparedInput,
    initialExpandedPaths: resolveInitialExpandedPaths(
      expandedPaths,
      directoryPaths,
      searchValue,
    ),
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    fileTreeSearchMode: "hide-non-matches",
    gitStatus,
    icons: TREE_ICONS,
    itemHeight: 26,
    overscan: 10,
    search: false,
    searchBlurBehavior: "retain",
    stickyFolders: false,
    unsafeCSS: TREE_UNSAFE_CSS,
    onSelectionChange: (selectedPaths) => {
      const selectedFile = selectedPaths.find((path) => fileSetRef.current.has(path));
      if (selectedFile) onSelectRef.current(selectedFile);
    },
  });

  useEffect(() => {
    model.resetPaths(files, {
      preparedInput,
      initialExpandedPaths: resolveInitialExpandedPaths(
        expandedPathsRef.current,
        directoryPathsRef.current,
        searchValue,
      ),
    });
  }, [filesKey, model, preparedInput, searchValue]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    if (!selectedPath || !fileSet.has(selectedPath)) return;

    const ancestorPaths = collectAncestorPaths(selectedPath).filter((path) =>
      directoryPathsRef.current.includes(path),
    );
    for (const path of ancestorPaths) {
      const item = model.getItem(path);
      if (item?.isDirectory() && "expand" in item) item.expand();
    }

    if (!searchValue && ancestorPaths.length > 0) {
      const nextExpandedPaths = Array.from(
        new Set([
          ...expandedPathsRef.current.map(normalizeDirectoryPath),
          ...ancestorPaths.map(normalizeDirectoryPath),
        ]),
      ).sort();

      if (!areSamePaths(lastExpandedRef.current, nextExpandedPaths)) {
        lastExpandedRef.current = nextExpandedPaths;
        onExpandedChange(nextExpandedPaths);
      }
    }

    const selectedItem = model.getItem(selectedPath);
    selectedItem?.select();
    selectedItem?.focus();
  }, [fileSet, model, onExpandedChange, searchValue, selectedPath]);

  useEffect(() => {
    const syncExpandedPaths = () => {
      if (searchValue) return;

      const expandedVisiblePaths = directoryPaths
        .filter((path) => {
          const item = model.getItem(path);
          return item?.isDirectory() && "isExpanded" in item && item.isExpanded();
        })
        .map(normalizeDirectoryPath)
        .sort();

      if (areSamePaths(lastExpandedRef.current, expandedVisiblePaths)) return;
      lastExpandedRef.current = expandedVisiblePaths;
      onExpandedChange(expandedVisiblePaths);
    };

    syncExpandedPaths();
    return model.subscribe(syncExpandedPaths);
  }, [directoryPaths, model, onExpandedChange, searchValue]);

  if (!files.length || (search.trim() && !hasSearchMatches)) {
    return (
      <div className="repo-browser__tree">
        <div style={{ padding: 16, opacity: 0.5, fontSize: 12 }}>
          {search ? "No matches" : "No files to browse"}
        </div>
      </div>
    );
  }

  return (
    <div className="repo-browser__tree repo-browser__tree--trees">
      <FileTree
        model={model}
        className="repo-browser__trees-host"
        style={TREE_STYLE}
      />
    </div>
  );
}

/**
 * File browser tree for GitPanel. The public props stay controlled by GitPanel,
 * while the rendering, keyboard navigation, icons, virtualization, and row
 * status presentation are delegated to @pierre/trees.
 */
export default function RepoFileTree({
  files,
  changedPaths,
  untrackedPaths,
  search,
  selectedPath,
  onSelect,
  expandedPaths,
  onExpandedChange,
}: FileTreeProps) {
  const gitStatus = useMemo(
    () => buildGitStatus(changedPaths, untrackedPaths),
    [changedPaths, untrackedPaths],
  );
  const allFilesKey = useMemo(() => createPathListKey(files), [files]);
  const searchValue = search.trim().toLowerCase();
  const visibleFiles = useMemo(() => {
    if (!searchValue) return files;
    return files.filter((path) => path.toLowerCase().includes(searchValue));
  }, [allFilesKey, files, searchValue]);
  const visibleFilesKey = useMemo(() => createPathListKey(visibleFiles), [visibleFiles]);
  const directoryPaths = useMemo(
    () => collectDirectoryPaths(visibleFiles),
    [visibleFilesKey],
  );
  const hasSearchMatches = useMemo(() => {
    if (!searchValue) return true;
    return visibleFiles.length > 0;
  }, [searchValue, visibleFiles.length]);

  return (
    <TreesFileTree
      key="repo-file-tree"
      files={visibleFiles}
      changedPaths={changedPaths}
      untrackedPaths={untrackedPaths}
      search={search}
      searchValue={searchValue}
      selectedPath={selectedPath}
      onSelect={onSelect}
      expandedPaths={expandedPaths}
      onExpandedChange={onExpandedChange}
      directoryPaths={directoryPaths}
      gitStatus={gitStatus}
      hasSearchMatches={hasSearchMatches}
    />
  );
}
