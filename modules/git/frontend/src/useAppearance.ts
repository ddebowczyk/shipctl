import { useSyncExternalStore } from "react";
import type { ModuleAppearancePort } from "@shipctl/module-api";

export function useAppearance(port: ModuleAppearancePort) {
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot);
}
