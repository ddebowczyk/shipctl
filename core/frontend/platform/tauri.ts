import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  RepoGroup,
  RegisteredRepo,
  WorkspaceConfig,
  ProjectSettings,
  EditorSettings,
  KeybindingSettings,
  TerminalSettings,
  TerminalSettingsCommit,
  SidebarSettings,
  FontFamily,
  FontFaceData,
  PreferredEditor,
  UiState,
} from "./types";
import type {
  TerminalAnchorId,
  TerminalAttachment,
  TerminalAttachmentId,
  TerminalCloseResult,
  TerminalColorTheme,
  TerminalDescriptor,
  TerminalId,
  TerminalInput,
  TerminalLaunchRequest,
  TerminalMetadata,
  TerminalRegistryEvent,
  TerminalRegistrySubscriptionId,
  TerminalAttachmentBootstrap,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
  TerminalRuntimeSnapshot,
  TerminalSelectionRequest,
  TerminalSelectionState,
  TerminalTransport,
} from "@shipctl/core/terminal";


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

export function getTerminalSettings(): Promise<TerminalSettingsCommit> {
  return invoke("get_terminal_settings");
}

export function saveTerminalSettings(settings: TerminalSettings): Promise<TerminalSettingsCommit> {
  return invoke("save_terminal_settings", { settings });
}

export function getSidebarSettings(): Promise<SidebarSettings> {
  return invoke("get_sidebar_settings");
}

export function getUiState(): Promise<UiState> {
  return invoke("get_ui_state");
}

export function setLastRepoPath(path: string | null): Promise<UiState> {
  return invoke("set_last_repo_path", { path });
}

export function saveAppearanceState(
  themeId: string,
  customTheme: unknown | null,
): Promise<UiState> {
  return invoke("save_appearance_state", { themeId, customTheme });
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

export interface TerminalAttachmentHandle extends TerminalAttachment {
  /** Release events buffered during the attach invoke after replay is installed. */
  activate(): void;
}

export interface TerminalRegistrySubscription {
  readonly id: TerminalRegistrySubscriptionId;
  dispose(): Promise<void>;
}

export function spawnTerminal(request: TerminalLaunchRequest): Promise<TerminalDescriptor> {
  return invoke("spawn_terminal", { request });
}

export function listTerminals(): Promise<TerminalDescriptor[]> {
  return invoke("list_terminals");
}

export async function subscribeTerminalRegistry(
  onEvent: (event: TerminalRegistryEvent) => void,
): Promise<TerminalRegistrySubscription> {
  const channel = new Channel<TerminalRegistryEvent>();
  channel.onmessage = onEvent;
  const id = await invoke<TerminalRegistrySubscriptionId>("subscribe_terminal_registry", {
    onEvent: channel,
  });
  return {
    id,
    dispose: () => invoke("unsubscribe_terminal_registry", { subscriptionId: id }),
  };
}

export function getTerminal(terminalId: TerminalId): Promise<TerminalDescriptor> {
  return invoke("get_terminal", { terminalId });
}

export function getTerminalSnapshot(
  terminalId: TerminalId,
): Promise<TerminalRuntimeSnapshot> {
  return invoke("get_terminal_snapshot", { terminalId });
}

/**
 * Open a host attachment.
 *
 * The adapter never interprets a host event. `bootstrap` owns decoding and
 * arrival order, so an event that violates the host contract is rejected at
 * this boundary instead of reaching client state.
 */
export async function attachTerminal(
  terminalId: TerminalId,
  claimsResize: boolean,
  bootstrap: TerminalAttachmentBootstrap,
  transport: TerminalTransport,
): Promise<TerminalAttachmentHandle> {
  const channel = new Channel<unknown>();
  channel.onmessage = bootstrap.deliver;
  const attachment = await invoke<TerminalAttachment>("attach_terminal", {
    terminalId,
    claimsResize,
    transport,
    onEvent: channel,
  });
  return { ...attachment, activate: bootstrap.activate };
}

export function detachTerminal(attachmentId: TerminalAttachmentId): Promise<void> {
  return invoke("detach_terminal", { attachmentId });
}

const terminalInputEncoder = new TextEncoder();

export function writeTerminal(terminalId: TerminalId, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === "string" ? terminalInputEncoder.encode(data) : data;
  return invoke("write_terminal", { terminalId, data: Array.from(bytes) });
}

/**
 * Report what a person did and let the host encode it.
 *
 * The answer is how many bytes the current modes made of it, and zero is a
 * normal answer: a focus report or a mouse motion produces nothing unless the
 * child asked for it.
 */
export function inputTerminal(terminalId: TerminalId, input: TerminalInput): Promise<number> {
  return invoke("input_terminal", { terminalId, input });
}

/**
 * Read the rows behind one terminal's viewport.
 *
 * The answer is handed back unchecked on purpose: the client model's decoder is
 * the only door into client state, and typing it here would be a second, weaker
 * reading of the host's shape.
 */
export function historyTerminal(
  terminalId: TerminalId,
  startRow: number,
  rows: number,
): Promise<unknown> {
  return invoke("history_terminal", { terminalId, startRow, rows });
}

/**
 * Pin one cell, so a client can keep naming that line while row numbers move.
 *
 * Unchecked for the same reason a history window is: the client model's decoder
 * is the only door into client state.
 */
export function anchorTerminal(
  terminalId: TerminalId,
  space: TerminalProjectedSpace,
  at: TerminalProjectedPoint,
): Promise<unknown> {
  return invoke("anchor_terminal", { terminalId, space, at });
}

/** Where an anchored line is now. Null for a handle the host does not hold. */
export function resolveTerminalAnchor(
  terminalId: TerminalId,
  anchor: TerminalAnchorId,
): Promise<unknown> {
  return invoke("resolve_terminal_anchor", { terminalId, anchor });
}

/** Drop an anchor. The host holds one only while a client asks it to. */
export function releaseTerminalAnchor(
  terminalId: TerminalId,
  anchor: TerminalAnchorId,
): Promise<unknown> {
  return invoke("release_terminal_anchor", { terminalId, anchor });
}

/**
 * Ask the host to select, and receive what it holds.
 *
 * The request is an intent; the host decides which cells it covers and returns
 * the text with the answer, so nothing here reconstructs a selection from the
 * screen.
 */
export function selectTerminal(
  terminalId: TerminalId,
  request: TerminalSelectionRequest,
): Promise<TerminalSelectionState> {
  return invoke("select_terminal", { terminalId, request });
}

export function updateTerminalColorTheme(colorTheme: TerminalColorTheme): Promise<void> {
  return invoke("update_terminal_color_theme", { colorTheme });
}

export function updateTerminalMetadata(
  terminalId: TerminalId,
  metadata: TerminalMetadata,
): Promise<TerminalDescriptor> {
  return invoke("update_terminal_metadata", { terminalId, metadata });
}

export function resizeTerminal(
  terminalId: TerminalId,
  attachmentId: TerminalAttachmentId,
  columns: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { terminalId, attachmentId, columns, rows });
}

export function closeTerminal(terminalId: TerminalId): Promise<TerminalCloseResult> {
  return invoke("close_terminal", { terminalId });
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

export interface MemoryStats {
  app_rss: number;
  children_rss: number;
}

export function getMemoryStats(): Promise<MemoryStats> {
  return invoke("get_memory_stats");
}
