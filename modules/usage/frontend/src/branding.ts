import claudeSrc from "./assets/claude.svg";
import codexSrc from "./assets/openai.svg";
import geminiSrc from "./assets/gemini.svg";
import opencodeSrc from "./assets/opencode-logo-dark.svg";
import piSrc from "./assets/pi.svg";

export const usageProviderLogoSrc: Record<string, string> = {
  claude: claudeSrc,
  codex: codexSrc,
  gemini: geminiSrc,
  // Antigravity is Gemini CLI's successor; reuse the Gemini mark until an official asset lands
  antigravity: geminiSrc,
  opencode: opencodeSrc,
  pi: piSrc,
};

const MONO_USAGE_PROVIDER_LOGOS = new Set(["codex", "opencode", "pi"]);

export function getUsageProviderLogoClass(provider: string): string | undefined {
  return MONO_USAGE_PROVIDER_LOGOS.has(provider) ? "themed-mono-logo" : undefined;
}
