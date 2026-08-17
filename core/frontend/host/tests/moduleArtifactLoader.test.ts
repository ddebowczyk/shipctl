import assert from "node:assert/strict";
import test from "node:test";

import * as PluginApi from "@shipctl/module-api";
import * as React from "react";
import * as ReactDom from "react-dom";

import {
  assertDigestQualifiedArtifactUrl,
  loadShipctlModuleArtifact,
  MODULE_ARTIFACT_HOST_SYMBOL,
  moduleArtifactUrl,
  ModuleArtifactLoadError,
} from "../moduleArtifactLoader.ts";
import {
  collectPluginArtifactDeclarations,
  parsePluginArtifactDeclarations,
} from "../pluginArtifactDeclarations.ts";
import { loadRuntimeModules } from "../runtimeModuleLoader.ts";

const DIGEST_A = "a".repeat(64);
const EMPTY_MESSAGES = {
  schemaVersion: 1,
  provides: [],
  handles: [],
  publishes: [],
  subscribes: [],
  ports: [],
} as const;
test("the production URL adapter only accepts the requested immutable directory", () => {
  const entryPath = `/isolated/modules/shipctl.fixture/0.0.0/${DIGEST_A}/module.mjs`;
  assert.equal(
    moduleArtifactUrl(entryPath, DIGEST_A, (file) => `asset://localhost/${encodeURIComponent(file)}`),
    `asset://localhost/${encodeURIComponent(entryPath)}`,
  );
  assert.throws(
    () => assertDigestQualifiedArtifactUrl("asset://localhost/other/module.mjs", DIGEST_A),
    (error: unknown) => error instanceof ModuleArtifactLoadError && error.phase === "resolve",
  );
});

test("the live runtime rejects a restart-required artifact before import", async () => {
  const loaded = await loadRuntimeModules({
    schemaVersion: 1,
    registryRevision: 1,
    modules: [{
      schemaVersion: 1,
      moduleId: "fixture.restart-only",
      version: "1.0.0",
      contentDigest: DIGEST_A,
      entryPath: `/isolated/modules/${DIGEST_A}/module.mjs`,
      stylePaths: [],
      manifest: {
        schemaVersion: 2,
        lifecycle: "restart_required",
        messages: EMPTY_MESSAGES,
        requestedGrants: [],
      },
      capabilities: { definitions: [] },
    }],
  });

  assert.deepEqual(loaded.modules, []);
  assert.deepEqual(loaded.definitions, []);
  assert.equal(loaded.failures.length, 1);
  assert.equal(loaded.failures[0]?.phase, "validate");
  assert.equal(loaded.failures[0]?.code, "module.loader.invalid_artifact");
  assert.match(loaded.failures[0]?.message ?? "", /cannot enter the live runtime/);
});

test("runtime loader accepts only the admitted headless module identity", async () => {
  const module = {
    id: "test.headless-module",
    version: "1.0.0",
    messages: { provides: [] },
  };
  const loaded = await loadShipctlModuleArtifact({
    digest: DIGEST_A,
    entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
    expectedModuleId: module.id,
    expectedVersion: module.version,
    importModule: async () => ({ createShipctlModule: () => module }),
  });
  assert.equal(loaded.module, module);

  await assert.rejects(
    () => loadShipctlModuleArtifact({
      digest: DIGEST_A,
      entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
      expectedModuleId: module.id,
      expectedVersion: module.version,
      importModule: async () => ({
        createShipctlModule: () => ({ ...module, panels: [] }),
      }),
    }),
    (error: unknown) => error instanceof ModuleArtifactLoadError
      && error.code === "module.loader.invalid_artifact",
  );
});

test("runtime loader rejects undeclared command and canvas contributions", async () => {
  const module = {
    id: "test.headless-module",
    version: "1.0.0",
  };
  for (const [field, value] of [
    ["commands", []],
    ["globalSurfaces", []],
  ] as const) {
    await assert.rejects(
      () => loadShipctlModuleArtifact({
        digest: DIGEST_A,
        entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
        expectedModuleId: module.id,
        expectedVersion: module.version,
        importModule: async () => ({
          createShipctlModule: () => ({ ...module, [field]: value }),
        }),
      }),
      (error: unknown) => error instanceof ModuleArtifactLoadError
        && error.code === "module.loader.invalid_artifact"
        && error.message.includes(field),
    );
  }
});

test("contribution IDs follow their public domain contracts", () => {
  const terminalModule = {
    id: "fixture.thin-terminal",
    version: "1.0.0",
    terminalPresentations: [{
      moduleId: "fixture.thin-terminal",
      driverId: PluginApi.terminalDriverId("thin-terminal"),
      Presentation: () => null,
    }],
  } satisfies PluginApi.ShipctlModule;
  assert.deepEqual(
    collectPluginArtifactDeclarations({ module: terminalModule, role: "presentation" }),
    {
      schemaVersion: 1,
      role: "presentation",
      requiredServices: [],
      providedServices: [],
      backgroundEffects: [],
      contributions: [{
        family: "terminal-presentation",
        id: "thin-terminal",
        schemaVersion: 1,
      }],
    },
  );

  const declarations = {
    schemaVersion: 1,
    role: "presentation",
    requiredServices: [],
    providedServices: [],
    backgroundEffects: [],
    contributions: [{
      family: "terminal-presentation",
      id: "Thin Terminal",
      schemaVersion: 1,
    }],
  } as const;
  assert.throws(() => parsePluginArtifactDeclarations(declarations));
  assert.throws(() => parsePluginArtifactDeclarations({
    ...declarations,
    contributions: [{ ...declarations.contributions[0], family: "panel", id: "thin-terminal" }],
  }));
});

test("schema v2 loading seeds exact host singletons and remains passive", async () => {
  const requiredService = PluginApi.defineSemanticService<unknown>("fixture.required-service", 1);
  const providedService = PluginApi.defineSemanticService<unknown>("fixture.provided-service", 2);
  let declarationFactoryCalls = 0;
  let activationCalls = 0;
  const module = {
    id: "fixture.compound-artifact",
    version: "1.2.3",
    requiredGrants: ["fixture.grant"],
    commands: [{
      id: "fixture.compound-artifact.command",
      moduleId: "fixture.compound-artifact",
      label: "Fixture",
      run: () => undefined,
    }],
    activate: () => {
      activationCalls += 1;
    },
  } satisfies PluginApi.ShipctlModule;
  const definition = {
    module,
    role: "compound",
    requires: [requiredService],
    provides: [{ service: providedService, bind: () => ({}) }],
    backgroundEffects: ["fixture.compound-artifact.background"],
  } satisfies PluginApi.ShipctlPluginDefinition;
  const application = {
    schemaVersion: 1,
    role: "compound",
    requiredServices: [{ id: requiredService.id, version: requiredService.version }],
    providedServices: [{ id: providedService.id, version: providedService.version }],
    backgroundEffects: ["fixture.compound-artifact.background"],
    contributions: [{
      family: "command",
      id: "fixture.compound-artifact.command",
      schemaVersion: 1,
    }],
  } as const;

  const loaded = await loadShipctlModuleArtifact({
    digest: DIGEST_A,
    entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
    expectedModuleId: module.id,
    expectedVersion: module.version,
    admittedApplication: application,
    admittedMessages: EMPTY_MESSAGES,
    admittedGrants: ["fixture.grant"],
    importModule: async () => {
      const installed = (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[
        MODULE_ARTIFACT_HOST_SYMBOL
      ] as Record<string, unknown>;
      assert.equal(installed.react, React);
      assert.equal(installed.reactDom, ReactDom);
      assert.equal(installed.pluginApi, PluginApi);
      return {
      createShipctlPlugin: (host) => {
        declarationFactoryCalls += 1;
        assert.equal(host.react, React);
        assert.equal(host.reactDom, ReactDom);
        assert.equal(host.pluginApi, PluginApi);
        return definition;
      },
      };
    },
  });

  assert.equal(loaded.definition, definition);
  assert.equal(loaded.module, module);
  assert.equal(declarationFactoryCalls, 1);
  assert.equal(activationCalls, 0);
});

test("artifact styles are passive until activation and leave with their owner", async () => {
  const links: Array<{ href: string; rel: string; dataset: Record<string, string>; remove(): void }> = [];
  let deactivationCalls = 0;
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {} as Record<string, string>,
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: {
      append: (link: (typeof links)[number]) => links.push(link),
    },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const styleUrl = `asset://localhost/modules/${DIGEST_A}/commands.css`;
    const loaded = await loadShipctlModuleArtifact({
      digest: DIGEST_A,
      entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
      expectedModuleId: "fixture.styled-artifact",
      expectedVersion: "1.0.0",
      admittedApplication: {
        schemaVersion: 1,
        role: "headless",
        requiredServices: [],
        providedServices: [],
        backgroundEffects: [],
        contributions: [],
      },
      admittedMessages: EMPTY_MESSAGES,
      admittedGrants: [],
      styleUrls: [styleUrl],
      importModule: async () => ({
        createShipctlPlugin: () => ({
          role: "headless",
          module: {
            id: "fixture.styled-artifact",
            version: "1.0.0",
            activate: () => ({ deactivate: () => { deactivationCalls += 1; } }),
          },
        }),
      }),
    });

    assert.deepEqual(links, [], "loading must not mutate the document");
    const deactivation = loaded.module.activate?.({} as PluginApi.ModuleHost);
    assert.equal(links.length, 1);
    assert.equal(links[0].href, styleUrl);
    assert.equal(links[0].dataset.shipctlModule, "fixture.styled-artifact");
    await deactivation?.deactivate();
    assert.deepEqual(links, []);
    assert.equal(deactivationCalls, 1);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("schema v2 loading rejects every declaration difference before activation", async () => {
  const requiredService = PluginApi.defineSemanticService<unknown>("fixture.required-service", 1);
  const providedService = PluginApi.defineSemanticService<unknown>("fixture.provided-service", 2);
  const module = {
    id: "fixture.closed-artifact",
    version: "1.0.0",
    requiredGrants: ["fixture.grant"],
    commands: [{
      id: "fixture.closed-artifact.command",
      moduleId: "fixture.closed-artifact",
      label: "Fixture",
      run: () => undefined,
    }],
  } satisfies PluginApi.ShipctlModule;
  const definition = {
    module,
    role: "compound",
    requires: [requiredService],
    provides: [{ service: providedService, bind: () => ({}) }],
    backgroundEffects: ["fixture.closed-artifact.background"],
  } satisfies PluginApi.ShipctlPluginDefinition;
  const admittedApplication = {
    schemaVersion: 1,
    role: "compound",
    requiredServices: [{ id: requiredService.id, version: 1 }],
    providedServices: [{ id: providedService.id, version: 2 }],
    backgroundEffects: ["fixture.closed-artifact.background"],
    contributions: [{
      family: "command",
      id: "fixture.closed-artifact.command",
      schemaVersion: 1,
    }],
  } as const;
  const variants: readonly PluginApi.ShipctlPluginDefinition[] = [
    { ...definition, role: "headless" },
    { ...definition, requires: [] },
    { ...definition, provides: [] },
    { ...definition, backgroundEffects: [] },
    { ...definition, module: { ...module, commands: [] } },
  ];

  for (const candidate of variants) {
    await assert.rejects(
      () => loadShipctlModuleArtifact({
        digest: DIGEST_A,
        entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
        expectedModuleId: module.id,
        expectedVersion: module.version,
        admittedApplication,
        admittedMessages: EMPTY_MESSAGES,
        admittedGrants: ["fixture.grant"],
        importModule: async () => ({ createShipctlPlugin: () => candidate }),
      }),
      (error: unknown) => error instanceof ModuleArtifactLoadError
        && error.phase === "validate",
    );
  }

  for (const mismatch of [
    { admittedMessages: { ...EMPTY_MESSAGES, schemaVersion: 2 } },
    { admittedGrants: ["fixture.other-grant"] },
    { admittedApplication: { ...admittedApplication, unknown: true } },
  ]) {
    await assert.rejects(
      () => loadShipctlModuleArtifact({
        digest: DIGEST_A,
        entryUrl: `asset://localhost/modules/${DIGEST_A}/module.mjs`,
        expectedModuleId: module.id,
        expectedVersion: module.version,
        admittedApplication,
        admittedMessages: EMPTY_MESSAGES,
        admittedGrants: ["fixture.grant"],
        importModule: async () => ({ createShipctlPlugin: () => definition }),
        ...mismatch,
      }),
      (error: unknown) => error instanceof ModuleArtifactLoadError
        && error.phase === "validate",
    );
  }
});
