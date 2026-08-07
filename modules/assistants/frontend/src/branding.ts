import type { ModuleTerminalSessionPresentation } from "@shep/module-api";

import claudeSrc from "./assets/claude.svg";
import codexSrc from "./assets/openai.svg";
import geminiSrc from "./assets/gemini.svg";
import opencodeSrc from "./assets/opencode-logo-dark.svg";
import piSrc from "./assets/pi.svg";
import type { AssistantCaptureState } from "./types";

export const assistantLogoSrc: Readonly<Record<string, string>> = {
  claude: claudeSrc,
  codex: codexSrc,
  antigravity: geminiSrc,
  opencode: opencodeSrc,
  pi: piSrc,
};

const MONO_ASSISTANT_LOGOS = new Set(["codex", "opencode", "pi"]);

export function getAssistantLogoClass(id: string): string | undefined {
  return MONO_ASSISTANT_LOGOS.has(id) ? "themed-mono-logo" : undefined;
}

export function assistantPresentation(
  provider: string,
  captureState: AssistantCaptureState | null = null,
): ModuleTerminalSessionPresentation {
  const src = assistantLogoSrc[provider];
  return {
    role: "assistant",
    ...(src
      ? { icon: { src, alt: provider, className: getAssistantLogoClass(provider) } }
      : {}),
    ...(captureState === "pending"
      ? { badge: { label: "saving", title: "Identifying this session for restore", tone: "muted" } as const }
      : captureState === "failed"
        ? { badge: { label: "not saved", title: "This live session cannot be restored", tone: "attention" } as const }
        : {}),
  };
}
