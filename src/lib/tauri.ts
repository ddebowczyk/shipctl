import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  RepoGroup,
  RegisteredRepo,
  WorkspaceConfig,
  PtyColorTheme,
  PtyOutput,
  ProjectSettings,
  EditorSettings,
  KeybindingSettings,
  TerminalSettings,
  SidebarSettings,
  FontFamily,
  FontFaceData,
  PreferredEditor,
  ProviderUsageSnapshot,
  LocalUsageDetails,
  UsageSettings,
  UsageOverview,
  UsageProjectAliasReviewItem,
  PiConfig,
  PiSettings,
} from "./types";

// ── Workspace commands ──────────────────────────────────────────────

export function listRepos(): Promise<RepoInfo[]> {
  return invoke("list_repos");
}

export function registerRepo(repoPath: string): Promise<RegisteredRepo> {
  return invoke("register_repo", { repoPath });
}

export function unregisterRepo(repoPath: string): Promise<void> {
  return invoke("unregister_repo", { repoPath });
}

// ── Group commands ────────────────────────────────────────────────

export function listGroups(): Promise<RepoGroup[]> {
  return invoke("list_groups");
}

export function createGroup(name: string): Promise<RepoGroup> {
  return invoke("create_group", { name });
}

export function renameGroup(groupId: string, newName: string): Promise<void> {
  return invoke("rename_group", { groupId, newName });
}

export function deleteGroup(groupId: string): Promise<void> {
  return invoke("delete_group", { groupId });
}

export function moveRepoToGroup(repoPath: string, groupId: string | null): Promise<void> {
  return invoke("move_repo_to_group", { repoPath, groupId });
}

export function loadWorkspace(repoPath: string): Promise<WorkspaceConfig> {
  return invoke("load_workspace", { repoPath });
}

export function saveWorkspace(
  repoPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  return invoke("save_workspace", { repoPath, config });
}

export function getGlobalCapabilityData(capabilityId: string): Promise<unknown> {
  return invoke("get_global_capability_data", { capabilityId });
}

export function replaceGlobalCapabilityData(
  capabilityId: string,
  value: unknown,
): Promise<void> {
  return invoke("replace_global_capability_data", { capabilityId, value });
}

export function getEditorSettings(): Promise<EditorSettings> {
  return invoke("get_editor_settings");
}

export function getProjectSettings(): Promise<ProjectSettings> {
  return invoke("get_project_settings");
}

export function saveEditorSettings(settings: EditorSettings): Promise<void> {
  return invoke("save_editor_settings", { settings });
}

export function saveProjectSettings(settings: ProjectSettings): Promise<void> {
  return invoke("save_project_settings", { settings });
}

export function getKeybindingSettings(): Promise<KeybindingSettings> {
  return invoke("get_keybinding_settings");
}

export function saveKeybindingSettings(settings: KeybindingSettings): Promise<void> {
  return invoke("save_keybinding_settings", { settings });
}

export function getTerminalSettings(): Promise<TerminalSettings> {
  return invoke("get_terminal_settings");
}

export function saveTerminalSettings(settings: TerminalSettings): Promise<void> {
  return invoke("save_terminal_settings", { settings });
}

export function getSidebarSettings(): Promise<SidebarSettings> {
  return invoke("get_sidebar_settings");
}

export function listMonospaceFamilies(): Promise<FontFamily[]> {
  return invoke("list_monospace_families");
}

export function loadFontFamily(family: string): Promise<FontFaceData[]> {
  return invoke("load_font_family", { family });
}

export function openInEditor(
  repoPath: string,
  editorOverride?: PreferredEditor | null,
): Promise<void> {
  return invoke("open_in_editor", {
    repoPath,
    editorOverride: editorOverride ?? null,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

// ── PTY commands ────────────────────────────────────────────────────

export function spawnPty(
  command: string,
  args: string[] | null,
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number,
  colorTheme: PtyColorTheme,
  onMessage: (msg: PtyOutput) => void,
): Promise<number> {
  const channel = new Channel<PtyOutput>();
  channel.onmessage = onMessage;
  return invoke("spawn_pty", {
    command,
    args,
    cwd,
    env,
    cols,
    rows,
    colorTheme,
    onData: channel,
  });
}

export function writePty(ptyId: number, data: string): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export function updatePtyColorTheme(colorTheme: PtyColorTheme): Promise<void> {
  return invoke("update_pty_color_theme", { colorTheme });
}

export function resizePty(
  ptyId: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_pty", { ptyId, cols, rows });
}

export function killPty(ptyId: number): Promise<void> {
  return invoke("kill_pty", { ptyId });
}

// ── App lifecycle commands ────────────────────────────────────────

export function shutdownAndQuit(): Promise<void> {
  return invoke("shutdown_and_quit");
}

// ── File watcher commands ─────────────────────────────────────────

export function watchRepo(path: string): Promise<void> {
  return invoke("watch_repo", { path });
}

export function unwatchRepo(path: string): Promise<void> {
  return invoke("unwatch_repo", { path });
}

// ── System commands ────────────────────────────────────────────────

export function getUsername(): Promise<string> {
  return invoke("get_username");
}

export function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory");
}

export function getDefaultShell(): Promise<string> {
  return invoke("get_default_shell");
}

export function getComputerName(): Promise<string> {
  return invoke("get_computer_name");
}

export function checkCommandExists(command: string): Promise<boolean> {
  return invoke("check_command_exists", { command });
}

export function getUsageSettings(): Promise<UsageSettings> {
  return invoke("get_usage_settings");
}

export function saveUsageSettings(settings: UsageSettings): Promise<void> {
  return invoke("save_usage_settings", { settings });
}

export function getAllUsageSnapshots(): Promise<ProviderUsageSnapshot[]> {
  return invoke("get_all_usage_snapshots");
}

export function getUsageSnapshot(provider: string): Promise<ProviderUsageSnapshot> {
  return invoke("get_usage_snapshot", { provider });
}

export function getUsageDetails(provider: string, window: string): Promise<LocalUsageDetails> {
  return invoke("get_usage_details", { provider, window });
}

export function getUsageOverview(window: string): Promise<UsageOverview> {
  return invoke("get_usage_overview", { window });
}

export function getProjectAliasReviewQueue(): Promise<UsageProjectAliasReviewItem[]> {
  return invoke("get_project_alias_review_queue");
}

export function getModelsForProvider(provider: string): Promise<string[]> {
  return invoke("get_models_for_provider", { provider });
}

export function refreshUsageData(): Promise<void> {
  return invoke("refresh_usage_data");
}

export interface MemoryStats {
  app_rss: number;
  children_rss: number;
}

export function getMemoryStats(): Promise<MemoryStats> {
  return invoke("get_memory_stats");
}

// ── Pi config commands ────────────────────────────────────────────

export function getPiConfig(): Promise<PiConfig> {
  return invoke("get_pi_config");
}

export function savePiSettings(settings: PiSettings): Promise<void> {
  return invoke("save_pi_settings", { settings });
}

export function savePiApiKey(provider: string, apiKey: string): Promise<void> {
  return invoke("save_pi_api_key", { provider, apiKey });
}

export function deletePiApiKey(provider: string): Promise<void> {
  return invoke("delete_pi_api_key", { provider });
}
