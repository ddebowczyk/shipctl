import type { CodingAssistant, RestorableAssistantProvider } from "./types";

export const CODING_ASSISTANTS: readonly CodingAssistant[] = [
  { id: "claude", name: "Claude Code", command: "claude", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
  { id: "codex", name: "Codex", command: "codex", yoloFlag: "--yolo", modelFlag: "--model" },
  { id: "antigravity", name: "Antigravity", command: "agy", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
  { id: "opencode", name: "Open Code", command: "opencode", yoloFlag: null, modelFlag: "--model" },
  { id: "pi", name: "pi", command: "pi", yoloFlag: null, modelFlag: "--model" },
];

export const ASSISTANT_INSTALL_URLS: Readonly<Record<string, string>> = {
  claude: "https://code.claude.com/docs/en",
  codex: "https://github.com/openai/codex",
  antigravity: "https://github.com/google-antigravity/antigravity-cli",
  opencode: "https://opencode.ai/",
  pi: "https://pi.dev/",
};

export function restorableProvider(id: string): RestorableAssistantProvider | null {
  return id === "claude" || id === "codex" ? id : null;
}
