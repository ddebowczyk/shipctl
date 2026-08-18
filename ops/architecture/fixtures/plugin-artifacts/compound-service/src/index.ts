import type * as ModuleApi from "@shipctl/module-api";
import { createElement } from "react";

import "./compound.css";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

const MODULE_ID = "fixture.compound-service";
const SURFACE_ID = "fixture.compound-service.surface";
const BACKGROUND_EFFECT_ID = "fixture.compound-service.heartbeat";

function CompoundSurface() {
  return createElement(
    "section",
    { className: "fixture-compound-service" },
    "External compound fixture",
  );
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    role: "compound",
    backgroundEffects: [BACKGROUND_EFFECT_ID],
    module: {
      id: MODULE_ID,
      version: "1.0.0",
      globalSurfaces: [{
        id: SURFACE_ID,
        moduleId: MODULE_ID,
        unavailable: {
          title: "Compound fixture unavailable",
          description: "The external compound proof fixture could not be loaded.",
        },
        load: async () => ({ default: CompoundSurface }),
      }],
      activate: ({ activation }) => {
        activation.own(() => undefined, BACKGROUND_EFFECT_ID);
        return { deactivate: () => undefined };
      },
    },
  });
}
