import { useSyncExternalStore } from "react";
import type { ModuleAppearancePort } from "@shep/module-api";

export function useAppearance(port: ModuleAppearancePort) {
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot);
}
