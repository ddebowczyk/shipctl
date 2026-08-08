import { useEffect, useState } from "react";
import { useAppearance } from "./useAppearance";
import type { ModuleAppearancePort } from "@shipctl/module-api";
import {
  getMarkdownRenderer,
  getPlainMarkdownRenderer,
} from "./markdownRenderer";
import { shikiThemeFor } from "./shikiHighlighter";

interface MarkdownViewerProps {
  contents: string;
  appearance: ModuleAppearancePort;
}

export default function MarkdownViewer({ contents, appearance }: MarkdownViewerProps) {
  const theme = useAppearance(appearance);
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    const themeName = shikiThemeFor(theme);

    void (async () => {
      try {
        const renderer = await getMarkdownRenderer(themeName);
        const next = renderer.render(contents);
        if (!cancelled) setHtml(next);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("Markdown render failed, falling back to plain markdown:", error);
        }
        try {
          const fallback = getPlainMarkdownRenderer().render(contents);
          if (!cancelled) setHtml(fallback);
        } catch (fallbackError) {
          if (import.meta.env.DEV) {
            console.error("Plain markdown fallback also failed:", fallbackError);
          }
          if (!cancelled) setHtml("");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contents, theme]);

  return (
    <div className="markdown-view">
      <div
        className="markdown-view__content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
