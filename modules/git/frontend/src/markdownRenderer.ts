import markdownit, { type MarkdownIt, type RendererRule } from "markdown-it";
import { fromHighlighter } from "@shikijs/markdown-it/core";
import type { HighlighterGeneric } from "shiki";
// Explicit extension: the renderer's configuration is covered by node --test,
// which resolves relative specifiers the way the ESM spec does, not the way
// the bundler does.
import { getHighlighter } from "./shikiHighlighter.ts";

const cached = new Map<string, Promise<MarkdownIt>>();
let plainRenderer: MarkdownIt | null = null;

function createMarkdownRenderer(): MarkdownIt {
  const markdown = markdownit({
    html: false,
    linkify: true,
    typographer: true,
  });

  // markdown-it 15 stopped linkifying bare domains by default. Shipctl's file
  // viewer relied on it, so ask for it back explicitly.
  markdown.linkify.set({ fuzzyLink: true });

  const defaultLinkOpen: RendererRule =
    markdown.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noreferrer noopener");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return markdown;
}

export async function getMarkdownRenderer(theme: string): Promise<MarkdownIt> {
  if (!cached.has(theme)) {
    cached.set(theme, (async () => {
      const markdown = createMarkdownRenderer();
      const highlighter = await getHighlighter();
      markdown.use(
        fromHighlighter(highlighter as unknown as HighlighterGeneric<any, any>, {
          theme,
        }),
      );
      return markdown;
    })());
  }

  const markdown = await cached.get(theme)!;
  return markdown;
}

export function getPlainMarkdownRenderer(): MarkdownIt {
  if (!plainRenderer) {
    plainRenderer = createMarkdownRenderer();
  }
  return plainRenderer;
}

export function isMarkdownFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  return base.endsWith(".md") || base.endsWith(".markdown");
}
