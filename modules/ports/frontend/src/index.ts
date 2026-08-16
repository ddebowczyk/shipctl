import type { ShipctlModule } from "@shipctl/module-api";

export const PORTS_SURFACE_ID = "ports.overview" as const;

export const portsModule = {
  id: "shipctl.ports",
  version: "0.0.0",
  globalSurfaces: [
    {
      id: PORTS_SURFACE_ID,
      moduleId: "shipctl.ports",
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
      moduleId: "shipctl.ports",
      surfaceId: PORTS_SURFACE_ID,
      label: "Ports",
      icon: { name: "radio" },
      order: 30,
    },
  ],
} as const satisfies ShipctlModule;

export type { PortInfo } from "./types";
