import type * as ModuleApi from "@shipctl/module-api";

interface ArtifactHost {
  readonly pluginApi: typeof ModuleApi;
}

const MODULE_ID = "fixture.post-package-deployment";
const COMMAND_ID = "fixture.post-package-deployment.command";
const RECORD_KEY = "post-package-deployment";

/**
 * This fixture is deliberately direct: activation owns both its command
 * registration and an admitted Plugin Data write. It therefore proves the
 * external artifact path without depending on a bundled module adapter.
 */
export function createShipctlPlugin(
  host: ArtifactHost,
): ModuleApi.DirectShipctlPluginDefinition {
  return host.pluginApi.defineShipctlPlugin({
    id: MODULE_ID,
    version: "1.0.0",
    role: "presentation",
    requiredGrants: ["plugin-data.read", "plugin-data.write"],
    requires: [host.pluginApi.pluginDataService],
    async activate(context) {
      const pluginData = context.services.require(host.pluginApi.pluginDataService);
      const current = await pluginData.readRecord.execute({
        scope: { kind: "global" },
        key: RECORD_KEY,
      });
      if (!current.result.ok) {
        throw new Error(`Could not read post-package fixture state: ${current.result.error.message}`);
      }
      const written = await pluginData.writeRecord.execute({
        scope: { kind: "global" },
        key: RECORD_KEY,
        expectedRevision: current.result.value?.revision ?? null,
        schemaVersion: 1,
        value: {
          activated: true,
          source: "post-package-deployment",
        },
      });
      if (!written.result.ok) {
        throw new Error(`Could not write post-package fixture state: ${written.result.error.message}`);
      }
      context.contributions.commands.register({
        id: COMMAND_ID,
        moduleId: MODULE_ID,
        label: "Post-package deployment fixture",
        run: () => undefined,
      });
    },
  });
}
