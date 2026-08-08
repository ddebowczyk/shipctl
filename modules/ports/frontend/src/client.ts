import { invoke } from "@tauri-apps/api/core";

import type { PortInfo } from "./types";

export const PORT_COMMANDS = {
  list: "plugin:shipctl-ports|list_listening_ports",
  kill: "plugin:shipctl-ports|kill_port",
} as const;

export function listListeningPorts(): Promise<PortInfo[]> {
  return invoke(PORT_COMMANDS.list);
}

export function killPort(pid: number): Promise<void> {
  return invoke(PORT_COMMANDS.kill, { pid });
}
