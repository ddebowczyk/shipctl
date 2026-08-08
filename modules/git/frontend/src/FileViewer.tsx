import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { useAppearance } from "./useAppearance";
import type { ModuleAppearancePort } from "@shipctl/module-api";
import {
  highlightSource,
  langForFile,
  shikiThemeFor,
  type ThemedToken,
} from "./shikiHighlighter";
import MarkdownViewer from "./MarkdownViewer";
import { isMarkdownFile } from "./markdownRenderer";

interface FileViewerProps {
  appearance: ModuleAppearancePort;
  contents: string;
  filePath: string;
  loading?: boolean;
  error?: string | null;
  /** Find-in-file term from the right-panel search. When non-empty, lines
   *  whose content contains the term (case-insensitive) get a highlight
   *  class, and the first match is scrolled into view. */
  findTerm?: string;
  /** When true, renders raw source instead of markdown preview. */
  rawMarkdown?: boolean;
  /** Scroll position to restore on mount (from persistent store). */
  initialScrollTop?: number;
  /** Called (debounced) when the user scrolls, so the caller can persist position. */
  onScrollChange?: (pos: number) => void;
}

/** Files above this byte count skip Shiki and render as plain monospace —
 *  tokenizing a huge file freezes the UI for seconds and explodes memory.
 *  The Rust side enforces a hard cap at 2 MB; this is the soft cap for
 *  "still preview but without syntax colors." */
const SHIKI_MAX_BYTES = 200 * 1024; // 200 KB

export default function FileViewer({
  appearance,
  contents,
  filePath,
  loading,
  error,
  findTerm = "",
  rawMarkdown = false,
  initialScrollTop,
  onScrollChange,
}: FileViewerProps) {
  const theme = useAppearance(appearance);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lang = useMemo(() => langForFile(filePath), [filePath]);
  const markdownFile = useMemo(() => isMarkdownFile(filePath), [filePath]);
  const oversized = contents.length > SHIKI_MAX_BYTES;

  // Restore scroll position before first paint to avoid visible jump.
  useLayoutEffect(() => {
    if (initialScrollTop && scrollRef.current) {
      scrollRef.current.scrollTop = initialScrollTop;
    }
  }, []); // intentionally runs only on mount

  const handleScroll = useCallback(() => {
    if (!onScrollChange || !scrollRef.current) return;
    const pos = scrollRef.current.scrollTop;
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => onScrollChange(pos), 300);
  }, [onScrollChange]);

  // Pre-compute the set of line indices that match the find term.
  const matchSet = useMemo(() => {
    const s = new Set<number>();
    const needle = findTerm.trim().toLowerCase();
    if (!needle) return s;
    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) s.add(i);
    }
    return s;
  }, [contents, findTerm]);

  // Scroll to the first find match whenever the term changes.
  useEffect(() => {
    if (matchSet.size === 0 || !scrollRef.current) return;
    const firstIdx = matchSet.values().next().value;
    const el = scrollRef.current.querySelector<HTMLDivElement>(
      `[data-line-idx="${firstIdx}"]`,
    );
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchSet]);

  // Tokenize once per (contents, file, theme) triple.
  useEffect(() => {
    if (!lang || !contents || oversized || (markdownFile && !rawMarkdown)) {
      setTokens(null);
      return;
    }
    const shikiTheme = shikiThemeFor(theme);
    let cancelled = false;
    void (async () => {
      try {
        const result = await highlightSource(contents, lang, shikiTheme);
        if (!cancelled) setTokens(result);
      } catch {
        if (!cancelled) setTokens(null);
      }
    })();
    return () => { cancelled = true; };
  }, [contents, lang, theme, oversized, markdownFile, rawMarkdown]);

  if (error) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.55, fontSize: 12 }}>{error}</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>Loading…</div>
      </div>
    );
  }
  if (!contents) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>
          (empty file)
        </div>
      </div>
    );
  }

  if (markdownFile && !rawMarkdown) {
    return (
      <div className="git-panel__diff" ref={scrollRef} onScroll={handleScroll}>
        <MarkdownViewer contents={contents} appearance={appearance} />
      </div>
    );
  }

  const lines = contents.split("\n");

  return (
    <div className="git-panel__diff" ref={scrollRef} onScroll={handleScroll}>
      <div className="diff-content file-view">
        {lines.map((line, i) => {
          const lineTokens = tokens?.[i];
          const isMatch = matchSet.has(i);
          return (
            <div
              key={i}
              data-line-idx={i}
              className={`diff-line diff-line--context${isMatch ? " diff-line--find-match" : ""}`}
            >
              <span className="file-view__line-no">{i + 1}</span>
              {lineTokens && lineTokens.length > 0 ? (
                lineTokens.map((t, ti) => (
                  <span key={ti} style={{ color: t.color }}>
                    {t.content}
                  </span>
                ))
              ) : (
                <span>{line || " "}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
