import type { ShepModule } from "@shep/module-api";

export const PORTS_SURFACE_ID = "ports.overview" as const;

export const portsModule = {
  id: "shep.ports",
  version: "0.0.0",
  globalSurfaces: [
    {
      id: PORTS_SURFACE_ID,
      moduleId: "shep.ports",
      unavailable: {
        title: "Ports unavailable",
        description: "The Ports module could not be loaded.",
      },
      load: () => import("./PortsPanel"),
    },
  ],
  globalNavigation: [
    {
      id: "ports.global-navigation",
      moduleId: "shep.ports",
      surfaceId: PORTS_SURFACE_ID,
      label: "Ports",
      icon: { name: "radio" },
      order: 30,
    },
  ],
} as const satisfies ShepModule;

export { PORT_COMMANDS } from "./client";
export type { PortInfo } from "./types";
