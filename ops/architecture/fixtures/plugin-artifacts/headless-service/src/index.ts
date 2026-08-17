import type * as ModuleApi from "@shipctl/module-api";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

interface EchoService {
  echo(value: string): string;
}

const MODULE_ID = "fixture.headless-service";
const SERVICE_ID = "fixture.headless-service.echo";
const BACKGROUND_EFFECT_ID = "fixture.headless-service.poller";
const events: string[] = [];

/** Test-only observation which does not mutate the plugin lifecycle. */
export function inspectFixtureEvents(): readonly string[] {
  return [...events];
}

export function createShipctlPlugin(host: ArtifactHost): ModuleApi.ShipctlPluginDefinition {
  events.push("factory");
  const service = host.pluginApi.defineSemanticService<EchoService>(SERVICE_ID, 1);
  return host.pluginApi.defineShipctlPlugin({
    role: "headless",
    provides: [{
      service,
      bind: () => {
        events.push("service-bind");
        return {
          echo: (value) => {
            events.push(`service-use:${value}`);
            return value;
          },
        };
      },
    }],
    backgroundEffects: [BACKGROUND_EFFECT_ID],
    module: {
      id: MODULE_ID,
      version: "1.0.0",
      activate: ({ activation }) => {
        events.push("activate");
        const echo = activation.services.require(service);
        echo.echo("ready");
        activation.own(
          () => { events.push("background-dispose"); },
          BACKGROUND_EFFECT_ID,
        );
        return {
          deactivate: () => { events.push("module-deactivate"); },
        };
      },
    },
  });
}
