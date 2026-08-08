import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ProjectLayoutContributionProps } from "@shipctl/module-api";
import { Diff } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  createFileTreeIconResolver,
  getBuiltInFileIconColor,
  getBuiltInSpriteSheet,
  type FileTreeIconConfig,
} from "@pierre/trees";
import { useGitStore } from "./store";
import { useGitPanelStore } from "./panelStore";
import { gitChangedFiles, gitDiffStats } from "./client";
import type { ChangedFile, DiffFileStat } from "./types";

// Clicking a row opens GitPanel in diff mode. Both chunks are lazy in AppShell,
// so preload them here — this module is evaluated whenever a repo is active,
// well before the user's first click.
void import("./GitPanel");
void import("./DiffViewer");

const DIFF_STRIP_ICONS: FileTreeIconConfig = {
  set: "complete",
  colored: true,
};

const DIFF_STRIP_ICON_SPRITE = getBuiltInSpriteSheet("complete");
const diffStripIconResolver = createFileTreeIconResolver(DIFF_STRIP_ICONS);

function statusLabel(status: string): string {
  return status.toLowerCase();
}

function formatNum(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function changedLineCount(stat: DiffFileStat | undefined): number {
  const additions = stat?.additions ?? 0;
  const deletions = stat?.deletions ?? 0;
  return additions + deletions;
}

function changeTone(stat: DiffFileStat | undefined): "add" | "del" | "mixed" {
  const additions = stat?.additions ?? 0;
  const deletions = stat?.deletions ?? 0;
  if (additions > 0 && deletions === 0) return "add";
  if (deletions > 0 && additions === 0) return "del";
  return "mixed";
}

interface TooltipState {
  file: ChangedFile;
  stat: DiffFileStat | undefined;
  rect: DOMRect;
}

function DiffTooltip({ tip }: { tip: TooltipState }) {
  const { file, stat } = tip;
  const top = tip.rect.top + tip.rect.height / 2;
  const right = window.innerWidth - tip.rect.left + 10;
  const filename = file.path.split("/").pop() ?? file.path;

  return (
    <div
      className="diff-strip__tooltip"
      style={{ top, right, transform: "translateY(-50%)" }}
    >
      <div className="diff-strip__tooltip-header">
        <span className="diff-strip__tooltip-filename">{filename}</span>
        <span className="diff-strip__tooltip-status" data-status={file.status}>
          {statusLabel(file.status)}
        </span>
      </div>
      {stat && (
        <div className="diff-strip__tooltip-rows">
          <div className="diff-strip__tooltip-row diff-strip__tooltip-row--add">
            <span>Added</span>
            <span>+{stat.additions}</span>
          </div>
          <div className="diff-strip__tooltip-row diff-strip__tooltip-row--del">
            <span>Removed</span>
            <span>−{stat.deletions}</span>
          </div>
        </div>
      )}
      <div className="diff-strip__tooltip-path">{file.path}</div>
    </div>
  );
}

export default function DiffSummaryPanel({ project, services }: ProjectLayoutContributionProps) {
  const activeProjectPath = project.path;
  const gitStatus = useGitStore(
    (s) => (activeProjectPath ? s.projectGitStatus[activeProjectPath] ?? null : null),
  );
  const panelState = useGitPanelStore((s) =>
    activeProjectPath ? s.perRepo[activeProjectPath] ?? null : null,
  );
  const repoSelectedPath = panelState?.repoSelectedPath ?? null;
  const viewerMode = panelState?.viewerMode ?? "file";
  const repoPreferredDiffArea = panelState?.repoPreferredDiffArea ?? {};

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [statsMap, setStatsMap] = useState<Map<string, DiffFileStat>>(new Map());
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const canLoad = !!activeProjectPath && !!gitStatus?.is_git_repo;

  const fetchData = useCallback(async () => {
    if (!canLoad || !activeProjectPath) {
      setFiles([]);
      setStatsMap(new Map());
      return;
    }
    const [changedFiles, diffStats] = await Promise.all([
      gitChangedFiles(activeProjectPath).catch(() => [] as ChangedFile[]),
      gitDiffStats(activeProjectPath).catch(() => [] as DiffFileStat[]),
    ]);
    setFiles(changedFiles);
    const m = new Map<string, DiffFileStat>();
    for (const s of diffStats) m.set(s.path, s);
    setStatsMap(m);
  }, [canLoad, activeProjectPath]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (!canLoad || !activeProjectPath) return;
    const repo = activeProjectPath;
    const unlistenP = listen<{ paths: string[] }>("git-fs-changed", (event) => {
      if (!event.payload.paths.includes(repo)) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchData(), 300);
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unlistenP.then((f) => f());
    };
  }, [canLoad, activeProjectPath, fetchData]);

  const dedupedFiles = useMemo(() => {
    const priority = (area: string) => {
      if (area === "unstaged" || area === "untracked") return 2;
      if (area === "staged") return 1;
      return 0;
    };
    const byPath = new Map<string, ChangedFile>();
    for (const f of files) {
      const current = byPath.get(f.path);
      if (!current || priority(f.area) > priority(current.area)) {
        byPath.set(f.path, f);
      }
    }
    const vals = Array.from(byPath.values());
    return vals.sort((a, b) => {
      const sa = statsMap.get(a.path);
      const sb = statsMap.get(b.path);
      const ta = sa ? sa.additions + sa.deletions : 0;
      const tb = sb ? sb.additions + sb.deletions : 0;
      return tb - ta;
    });
  }, [files, statsMap]);

  const maxChangedLines = useMemo(() => {
    let max = 1;
    for (const file of dedupedFiles) {
      max = Math.max(max, changedLineCount(statsMap.get(file.path)));
    }
    return max;
  }, [dedupedFiles, statsMap]);

  const handleFileClick = useCallback((file: ChangedFile) => {
    if (!activeProjectPath) return;
    if (file.area !== "staged" && file.area !== "unstaged" && file.area !== "untracked") return;
    services.panels.open("core.git");
    useGitPanelStore.getState().setRepoSelection(activeProjectPath, file.path);
    useGitPanelStore.getState().setRepoPreferredDiffArea(activeProjectPath, file.path, file.area);
    useGitPanelStore.getState().setViewerMode(activeProjectPath, "diff");
  }, [activeProjectPath, services.panels]);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  if (!activeProjectPath || !gitStatus?.is_git_repo) return null;

  return (
    <div className="diff-strip" onMouseLeave={handleMouseLeave}>
      <div className="diff-strip__header">
        <Diff size={14} className="diff-strip__header-icon" />
      </div>
      <span
        className="diff-strip__sprite"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: DIFF_STRIP_ICON_SPRITE }}
      />
      <div className="diff-strip__list">
        {dedupedFiles.length === 0 ? (
          <div className="diff-strip__clean" title="Working tree clean">·</div>
        ) : (
          dedupedFiles.map((file) => {
            const stat = statsMap.get(file.path);
            const isActive =
              viewerMode === "diff" &&
              repoSelectedPath === file.path &&
              (repoPreferredDiffArea[file.path] ?? file.area) === file.area;
            const filename = file.path.split("/").pop() ?? file.path;
            const icon = diffStripIconResolver.resolveIcon("file-tree-icon-file", file.path);
            const iconColor = icon.token ? getBuiltInFileIconColor(icon.token) : undefined;
            const additions = stat?.additions ?? 0;
            const deletions = stat?.deletions ?? 0;
            const total = additions + deletions;
            const barWidth = total > 0 ? Math.max(20, Math.round((total / maxChangedLines) * 100)) : 0;
            const addWidth = total > 0 ? (additions / total) * 100 : 0;
            const delWidth = total > 0 ? (deletions / total) * 100 : 0;
            const tone = changeTone(stat);

            return (
              <button
                key={`${file.area}:${file.path}`}
                className={`diff-strip__row${isActive ? " diff-strip__row--active" : ""}`}
                data-status={file.status}
                onClick={() => handleFileClick(file)}
                aria-label={filename}
                onMouseEnter={(e) => setTooltip({ file, stat, rect: e.currentTarget.getBoundingClientRect() })}
              >
                <span className="diff-strip__icon-wrap">
                  <svg
                    aria-hidden="true"
                    className="diff-strip__file-icon"
                    data-icon-name={icon.remappedFrom ?? icon.name}
                    data-icon-token={icon.token}
                    viewBox={icon.viewBox ?? `0 0 ${icon.width ?? 16} ${icon.height ?? 16}`}
                    width={icon.width ?? 16}
                    height={icon.height ?? 16}
                    style={iconColor ? { color: iconColor } : undefined}
                  >
                    <use href={`#${icon.name}`} />
                  </svg>
                  {total > 0 && (
                    <span className="diff-strip__change-meter" data-tone={tone}>
                      <span className="diff-strip__change-meter-fill" style={{ width: `${barWidth}%` }}>
                        {additions > 0 && (
                          <span className="diff-strip__change-meter-add" style={{ width: `${addWidth}%` }} />
                        )}
                        {deletions > 0 && (
                          <span className="diff-strip__change-meter-del" style={{ width: `${delWidth}%` }} />
                        )}
                      </span>
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
      {dedupedFiles.length > 0 && (
        <div className="diff-strip__footer">
          <span
            className="diff-strip__footer-stat"
            title={`${formatNum(dedupedFiles.length)} changed ${dedupedFiles.length === 1 ? "file" : "files"}`}
          >
            {formatNum(dedupedFiles.length)}
          </span>
        </div>
      )}
      {tooltip && <DiffTooltip tip={tooltip} />}
    </div>
  );
}
