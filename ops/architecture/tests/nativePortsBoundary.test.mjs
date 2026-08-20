import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const platform = path.join(root, "core/frontend/platform");

const RESOURCE_PORTS = Object.freeze({
  "configuration.ts": [
    "read_global_configuration_value",
    "read_project_configuration_value",
  ],
  "projects.ts": [
    "list_repos",
    "register_repo",
    "unregister_repo",
    "list_groups",
    "create_group",
    "rename_group",
    "delete_group",
    "move_repo_to_group",
    "load_workspace",
    "save_workspace",
  ],
  "terminalRetention.ts": ["set_terminal_retention"],
  "legacyUiState.ts": ["get_ui_state", "set_last_repo_path", "save_appearance_state"],
  "fonts.ts": ["list_monospace_families", "load_font_family"],
  "system.ts": [
    "open_in_editor",
    "reveal_in_finder",
    "open_url",
    "get_username",
    "get_home_directory",
    "get_default_shell",
    "get_computer_name",
    "check_command_exists",
    "get_memory_stats",
  ],
  "lifecycle.ts": ["shutdown_and_quit"],
  "projectEvents.ts": ["watch_repo", "unwatch_repo"],
  "terminalSessions.ts": [
    "spawn_terminal",
    "list_terminals",
    "subscribe_terminal_registry",
    "unsubscribe_terminal_registry",
    "get_terminal",
    "get_terminal_publication_stats",
    "attach_raw_terminal",
    "detach_terminal",
    "write_terminal",
    "update_terminal_color_theme",
    "update_terminal_metadata",
    "resize_terminal",
    "close_terminal",
  ],
});

test("architecture.native-ports-boundary", async () => {
  for (const retiredPort of ["tauri.ts", "canvasAdapter.ts", "legacySettings.ts"]) {
    await assert.rejects(
      access(path.join(platform, retiredPort), constants.F_OK),
      (error) => error?.code === "ENOENT",
    );
  }

  const index = await readFile(path.join(platform, "index.ts"), "utf8");
  assert.doesNotMatch(index, /tauri\.ts|canvasAdapter\.ts|legacySettings\.ts/);

  for (const [file, commands] of Object.entries(RESOURCE_PORTS)) {
    const source = await readFile(path.join(platform, file), "utf8");
    assert.match(source, /@tauri-apps\//, `${file} must own its native adapter`);
    assert.match(index, new RegExp(`export \\* from "\\./${file}"`));
    for (const command of commands) {
      assert.match(source, new RegExp(`"${command}"`), `${command} belongs to ${file}`);
    }
  }
});
