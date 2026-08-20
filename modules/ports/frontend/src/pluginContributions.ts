import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
} from "@shipctl/module-api";

export const PORTS_MODULE_ID = "shipctl.ports" as const;
export const PORTS_PLUGIN_VERSION = "0.0.0" as const;
export const PORTS_SURFACE_ID = "ports.overview" as const;

/**
 * Presentation declarations remain inert until the artifact registers them
 * through its activation context. This intentionally replaces the legacy
 * `ShipctlModule` compatibility shape rather than wrapping it.
 */
export const portsContributions = Object.freeze({
  globalSurfaces: Object.freeze([
    {
      id: PORTS_SURFACE_ID,
      moduleId: PORTS_MODULE_ID,
      unavailable: {
        title: "Ports unavailable",
        description: "The Ports module could not be loaded.",
      },
      load: () => import("./PortsPanel"),
    },
  ] satisfies readonly GlobalSurfaceContribution[]),
  globalNavigation: Object.freeze([
    {
      id: "ports.global-navigation",
      moduleId: PORTS_MODULE_ID,
      surfaceId: PORTS_SURFACE_ID,
      label: "Ports",
      icon: { name: "radio" },
      order: 30,
    },
  ] satisfies readonly GlobalNavigationContribution[]),
});
