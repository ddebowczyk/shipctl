import { PatchDiff } from "@pierre/diffs/react";
import { useAppearance } from "./useAppearance";
import type { ModuleAppearancePort } from "@shipctl/module-api";
import { getCodeViewCSSVariables, getDiffViewOptions } from "./codeViewTheme";

interface DiffViewerProps {
  appearance: ModuleAppearancePort;
  diff: string;
  filePath: string;
  loading?: boolean;
  error?: string | null;
}

export default function DiffViewer({
  appearance,
  diff,
  filePath,
  loading = false,
  error = null,
}: DiffViewerProps) {
  const theme = useAppearance(appearance);
  const codeViewCSSVariables = getCodeViewCSSVariables();
  const diffViewOptions = getDiffViewOptions(theme);

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

  if (!diff) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>
          No diff available for {filePath}
        </div>
      </div>
    );
  }

  return (
    <div className="git-panel__diff git-panel__diff--pierre">
      <PatchDiff
        patch={diff}
        className="git-panel__diff-surface"
        // Inline background + color override the shadow DOM's base-layer
        // defaults (`--diffs-bg: light-dark(#fff, #000)`) that paint for one
        // tick before our unsafeCSS stylesheet is attached — otherwise the
        // host flashes black whenever the OS is in dark mode. Transparent
        // lets the frame show through, so glass themes stay glassy and
        // opaque themes pick up --frame-tint from the frame behind.
        style={{ ...codeViewCSSVariables, background: "transparent", color: "var(--text-primary)" }}
        options={diffViewOptions}
      />
    </div>
  );
}
