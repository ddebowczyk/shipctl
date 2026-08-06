import { invoke } from "@tauri-apps/api/core";

export const FIXTURE_PING_COMMAND = "plugin:shep-fixture|ping";

export function pingFixture(): Promise<string> {
  return invoke<string>(FIXTURE_PING_COMMAND);
}
