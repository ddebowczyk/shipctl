import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

import fc from "fast-check";
import { createServer } from "vite";

import {
  buildPluginArtifactStaging,
  inspectSharedRuntimeClosure,
} from "../lib/plugin-artifact-build.mjs";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureRoot = path.join(
  repositoryRoot,
  "ops/architecture/fixtures/plugin-artifacts/headless-service",
);
const shipctlPath = path.resolve(
  repositoryRoot,
  process.env.SHIPCTL_PHASE_E_CLI ?? "target/debug/shipctl",
);
const EMPTY_MESSAGES = Object.freeze({
  schemaVersion: 1,
  provides: [],
  handles: [],
  publishes: [],
  subscribes: [],
  ports: [],
});

let temporaryRoot;
let artifact;
let vite;
let api;
let loader;
let runtimeApi;
let semanticRuntime;
let testingApi;
let commandsSource;
let commandsArtifact;
let portsSource;
let portsArtifact;
let todosSource;
let todosArtifact;
let gitSource;
let gitArtifact;
let skillsSource;
let skillsArtifact;
let thinTerminalSource;
let thinTerminalArtifact;
let semanticTerminalSource;
let semanticTerminalArtifact;
let assistantsSource;
let assistantsArtifact;
let usageSource;
let usageArtifact;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

async function shipctl(args) {
  const { stdout } = await exec(shipctlPath, ["--output", "json", ...args], {
    cwd: repositoryRoot,
  });
  return JSON.parse(stdout);
}

before(async () => {
  if (process.env.SHIPCTL_PHASE_E_CLI === undefined) {
    await exec("cargo", ["build", "-p", "shipctl-cli"], {
      cwd: repositoryRoot,
    });
  }
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shipctl-phase-e-test-"));
  const stagingA = path.join(temporaryRoot, "staging-a");
  const stagingB = path.join(temporaryRoot, "staging-b");
  const archiveA = path.join(temporaryRoot, "a.shipctl-module");
  const archiveB = path.join(temporaryRoot, "b.shipctl-module");
  const stateRoot = path.join(temporaryRoot, "state");

  const buildA = await buildPluginArtifactStaging({
    sourceDirectory: fixtureRoot,
    stagingDirectory: stagingA,
  });
  const buildB = await buildPluginArtifactStaging({
    sourceDirectory: fixtureRoot,
    stagingDirectory: stagingB,
  });
  const packA = await shipctl(["modules", "pack", stagingA, "--to", archiveA]);
  const packB = await shipctl(["modules", "pack", stagingB, "--to", archiveB]);
  const archiveBytesA = await readFile(archiveA);
  const archiveBytesB = await readFile(archiveB);
  assert.deepEqual(archiveBytesA, archiveBytesB, "repeated artifact builds must be byte-identical");
  assert.equal(
    packA.data.archiveDigestSha256,
    packB.data.archiveDigestSha256,
    "repeated artifact builds must report the same archive digest",
  );

  const preflight = await shipctl([
    "modules", "preflight", archiveA, "--offline", "--state-root", stateRoot,
  ]);
  const admitted = await shipctl([
    "modules", "add", archiveA, "--offline", "--state-root", stateRoot,
  ]);
  const manifest = preflight.data.artifact.canonical.manifest;
  const digest = admitted.data.artifact.identity.contentDigest;
  const entryPath = path.join(stateRoot, "modules", digest, manifest.entry);
  artifact = {
    buildA,
    buildB,
    digest,
    entryPath,
    manifest,
    archiveBytes: archiveBytesA,
  };

  const commandsSourceDirectory = path.join(repositoryRoot, "modules/commands/artifact");
  const commandsStaging = path.join(temporaryRoot, "commands-staging");
  const commandsArchive = path.join(temporaryRoot, "commands.shipctl-module");
  const commandsStateRoot = path.join(temporaryRoot, "commands-state");
  const commandsBuild = await buildPluginArtifactStaging({
    sourceDirectory: commandsSourceDirectory,
    stagingDirectory: commandsStaging,
  });
  await shipctl(["modules", "pack", commandsStaging, "--to", commandsArchive]);
  const commandsPreflight = await shipctl([
    "modules", "preflight", commandsArchive, "--offline", "--state-root", commandsStateRoot,
  ]);
  const commandsAdmitted = await shipctl([
    "modules", "add", commandsArchive, "--offline", "--state-root", commandsStateRoot,
  ]);
  const commandsManifest = commandsPreflight.data.artifact.canonical.manifest;
  const commandsDigest = commandsAdmitted.data.artifact.identity.contentDigest;
  commandsArtifact = {
    build: commandsBuild,
    digest: commandsDigest,
    entryPath: path.join(commandsStateRoot, "modules", commandsDigest, commandsManifest.entry),
    manifest: commandsManifest,
  };

  const portsSourceDirectory = path.join(repositoryRoot, "modules/ports/artifact");
  const portsStaging = path.join(temporaryRoot, "ports-staging");
  const portsArchive = path.join(temporaryRoot, "ports.shipctl-module");
  const portsStateRoot = path.join(temporaryRoot, "ports-state");
  const portsBuild = await buildPluginArtifactStaging({
    sourceDirectory: portsSourceDirectory,
    stagingDirectory: portsStaging,
  });
  await shipctl(["modules", "pack", portsStaging, "--to", portsArchive]);
  const portsPreflight = await shipctl([
    "modules", "preflight", portsArchive, "--offline", "--state-root", portsStateRoot,
  ]);
  const portsAdmitted = await shipctl([
    "modules", "add", portsArchive, "--offline", "--state-root", portsStateRoot,
  ]);
  const portsManifest = portsPreflight.data.artifact.canonical.manifest;
  const portsDigest = portsAdmitted.data.artifact.identity.contentDigest;
  portsArtifact = {
    build: portsBuild,
    digest: portsDigest,
    entryPath: path.join(portsStateRoot, "modules", portsDigest, portsManifest.entry),
    manifest: portsManifest,
  };

  const todosSourceDirectory = path.join(repositoryRoot, "modules/todos/artifact");
  const todosStaging = path.join(temporaryRoot, "todos-staging");
  const todosArchive = path.join(temporaryRoot, "todos.shipctl-module");
  const todosStateRoot = path.join(temporaryRoot, "todos-state");
  const todosBuild = await buildPluginArtifactStaging({
    sourceDirectory: todosSourceDirectory,
    stagingDirectory: todosStaging,
  });
  await shipctl(["modules", "pack", todosStaging, "--to", todosArchive]);
  const todosPreflight = await shipctl([
    "modules", "preflight", todosArchive, "--offline", "--state-root", todosStateRoot,
  ]);
  const todosAdmitted = await shipctl([
    "modules", "add", todosArchive, "--offline", "--state-root", todosStateRoot,
  ]);
  const todosManifest = todosPreflight.data.artifact.canonical.manifest;
  const todosDigest = todosAdmitted.data.artifact.identity.contentDigest;
  todosArtifact = {
    build: todosBuild,
    digest: todosDigest,
    entryPath: path.join(todosStateRoot, "modules", todosDigest, todosManifest.entry),
    manifest: todosManifest,
  };

  const gitSourceDirectory = path.join(repositoryRoot, "modules/git/artifact");
  const gitStaging = path.join(temporaryRoot, "git-staging");
  const gitArchive = path.join(temporaryRoot, "git.shipctl-module");
  const gitStateRoot = path.join(temporaryRoot, "git-state");
  const gitBuild = await buildPluginArtifactStaging({
    sourceDirectory: gitSourceDirectory,
    stagingDirectory: gitStaging,
  });
  await shipctl(["modules", "pack", gitStaging, "--to", gitArchive]);
  const gitPreflight = await shipctl([
    "modules", "preflight", gitArchive, "--offline", "--state-root", gitStateRoot,
  ]);
  const gitAdmitted = await shipctl([
    "modules", "add", gitArchive, "--offline", "--state-root", gitStateRoot,
  ]);
  const gitManifest = gitPreflight.data.artifact.canonical.manifest;
  const gitDigest = gitAdmitted.data.artifact.identity.contentDigest;
  gitArtifact = {
    build: gitBuild,
    digest: gitDigest,
    entryPath: path.join(gitStateRoot, "modules", gitDigest, gitManifest.entry),
    manifest: gitManifest,
  };

  const skillsSourceDirectory = path.join(repositoryRoot, "modules/skills/artifact");
  const skillsStaging = path.join(temporaryRoot, "skills-staging");
  const skillsArchive = path.join(temporaryRoot, "skills.shipctl-module");
  const skillsStateRoot = path.join(temporaryRoot, "skills-state");
  const skillsBuild = await buildPluginArtifactStaging({
    sourceDirectory: skillsSourceDirectory,
    stagingDirectory: skillsStaging,
  });
  await shipctl(["modules", "pack", skillsStaging, "--to", skillsArchive]);
  const skillsPreflight = await shipctl([
    "modules", "preflight", skillsArchive, "--offline", "--state-root", skillsStateRoot,
  ]);
  const skillsAdmitted = await shipctl([
    "modules", "add", skillsArchive, "--offline", "--state-root", skillsStateRoot,
  ]);
  const skillsManifest = skillsPreflight.data.artifact.canonical.manifest;
  const skillsDigest = skillsAdmitted.data.artifact.identity.contentDigest;
  skillsArtifact = {
    build: skillsBuild,
    digest: skillsDigest,
    entryPath: path.join(skillsStateRoot, "modules", skillsDigest, skillsManifest.entry),
    manifest: skillsManifest,
  };

  const thinTerminalSourceDirectory = path.join(
    repositoryRoot,
    "modules/thin-terminal/artifact",
  );
  const thinTerminalStaging = path.join(temporaryRoot, "thin-terminal-staging");
  const thinTerminalArchive = path.join(temporaryRoot, "thin-terminal.shipctl-module");
  const thinTerminalStateRoot = path.join(temporaryRoot, "thin-terminal-state");
  const thinTerminalBuild = await buildPluginArtifactStaging({
    sourceDirectory: thinTerminalSourceDirectory,
    stagingDirectory: thinTerminalStaging,
  });
  await shipctl(["modules", "pack", thinTerminalStaging, "--to", thinTerminalArchive]);
  const thinTerminalPreflight = await shipctl([
    "modules", "preflight", thinTerminalArchive, "--offline",
    "--state-root", thinTerminalStateRoot,
  ]);
  const thinTerminalAdmitted = await shipctl([
    "modules", "add", thinTerminalArchive, "--offline",
    "--state-root", thinTerminalStateRoot,
  ]);
  const thinTerminalManifest = thinTerminalPreflight.data.artifact.canonical.manifest;
  const thinTerminalDigest = thinTerminalAdmitted.data.artifact.identity.contentDigest;
  thinTerminalArtifact = {
    build: thinTerminalBuild,
    digest: thinTerminalDigest,
    entryPath: path.join(
      thinTerminalStateRoot,
      "modules",
      thinTerminalDigest,
      thinTerminalManifest.entry,
    ),
    manifest: thinTerminalManifest,
  };

  const semanticTerminalSourceDirectory = path.join(
    repositoryRoot,
    "modules/semantic-terminal/artifact",
  );
  const semanticTerminalStaging = path.join(temporaryRoot, "semantic-terminal-staging");
  const semanticTerminalArchive = path.join(
    temporaryRoot,
    "semantic-terminal.shipctl-module",
  );
  const semanticTerminalStateRoot = path.join(temporaryRoot, "semantic-terminal-state");
  const semanticTerminalBuild = await buildPluginArtifactStaging({
    sourceDirectory: semanticTerminalSourceDirectory,
    stagingDirectory: semanticTerminalStaging,
  });
  await shipctl([
    "modules", "pack", semanticTerminalStaging, "--to", semanticTerminalArchive,
  ]);
  const semanticTerminalPreflight = await shipctl([
    "modules", "preflight", semanticTerminalArchive, "--offline",
    "--state-root", semanticTerminalStateRoot,
  ]);
  const semanticTerminalAdmitted = await shipctl([
    "modules", "add", semanticTerminalArchive, "--offline",
    "--state-root", semanticTerminalStateRoot,
  ]);
  const semanticTerminalManifest = semanticTerminalPreflight.data.artifact.canonical.manifest;
  const semanticTerminalDigest = semanticTerminalAdmitted.data.artifact.identity.contentDigest;
  semanticTerminalArtifact = {
    build: semanticTerminalBuild,
    digest: semanticTerminalDigest,
    entryPath: path.join(
      semanticTerminalStateRoot,
      "modules",
      semanticTerminalDigest,
      semanticTerminalManifest.entry,
    ),
    manifest: semanticTerminalManifest,
  };

  const assistantsSourceDirectory = path.join(
    repositoryRoot,
    "modules/assistants/artifact",
  );
  const assistantsStaging = path.join(temporaryRoot, "assistants-staging");
  const assistantsArchive = path.join(temporaryRoot, "assistants.shipctl-module");
  const assistantsStateRoot = path.join(temporaryRoot, "assistants-state");
  const assistantsBuild = await buildPluginArtifactStaging({
    sourceDirectory: assistantsSourceDirectory,
    stagingDirectory: assistantsStaging,
  });
  await shipctl(["modules", "pack", assistantsStaging, "--to", assistantsArchive]);
  const assistantsPreflight = await shipctl([
    "modules", "preflight", assistantsArchive, "--offline",
    "--state-root", assistantsStateRoot,
  ]);
  const assistantsAdmitted = await shipctl([
    "modules", "add", assistantsArchive, "--offline",
    "--state-root", assistantsStateRoot,
  ]);
  const assistantsManifest = assistantsPreflight.data.artifact.canonical.manifest;
  const assistantsDigest = assistantsAdmitted.data.artifact.identity.contentDigest;
  assistantsArtifact = {
    build: assistantsBuild,
    digest: assistantsDigest,
    entryPath: path.join(
      assistantsStateRoot,
      "modules",
      assistantsDigest,
      assistantsManifest.entry,
    ),
    manifest: assistantsManifest,
  };

  const usageSourceDirectory = path.join(repositoryRoot, "modules/usage/artifact");
  const usageStaging = path.join(temporaryRoot, "usage-staging");
  const usageArchive = path.join(temporaryRoot, "usage.shipctl-module");
  const usageStateRoot = path.join(temporaryRoot, "usage-state");
  const usageBuild = await buildPluginArtifactStaging({
    sourceDirectory: usageSourceDirectory,
    stagingDirectory: usageStaging,
  });
  await shipctl(["modules", "pack", usageStaging, "--to", usageArchive]);
  const usagePreflight = await shipctl([
    "modules", "preflight", usageArchive, "--offline", "--state-root", usageStateRoot,
  ]);
  const usageAdmitted = await shipctl([
    "modules", "add", usageArchive, "--offline", "--state-root", usageStateRoot,
  ]);
  const usageManifest = usagePreflight.data.artifact.canonical.manifest;
  const usageDigest = usageAdmitted.data.artifact.identity.contentDigest;
  usageArtifact = {
    build: usageBuild,
    digest: usageDigest,
    entryPath: path.join(usageStateRoot, "modules", usageDigest, usageManifest.entry),
    manifest: usageManifest,
  };

  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { hmr: false, middlewareMode: true },
  });
  api = await vite.ssrLoadModule("/module-api/frontend/src/index.ts");
  loader = await vite.ssrLoadModule("/core/frontend/host/moduleArtifactLoader.ts");
  runtimeApi = await vite.ssrLoadModule(
    "/core/frontend/runtime/cordis/staticPluginRuntime.ts",
  );
  semanticRuntime = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  );
  testingApi = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts");
  commandsSource = await vite.ssrLoadModule("/modules/commands/frontend/src/index.ts");
  portsSource = await vite.ssrLoadModule("/modules/ports/frontend/src/index.ts");
  todosSource = await vite.ssrLoadModule("/modules/todos/frontend/src/index.ts");
  gitSource = await vite.ssrLoadModule("/modules/git/frontend/src/index.ts");
  skillsSource = await vite.ssrLoadModule("/modules/skills/frontend/src/index.ts");
  thinTerminalSource = await vite.ssrLoadModule(
    "/modules/thin-terminal/frontend/src/index.ts",
  );
  semanticTerminalSource = await vite.ssrLoadModule(
    "/modules/semantic-terminal/frontend/src/index.ts",
  );
  assistantsSource = await vite.ssrLoadModule(
    "/modules/assistants/frontend/src/index.ts",
  );
  usageSource = await vite.ssrLoadModule("/modules/usage/frontend/src/index.ts");
});

after(async () => {
  await vite?.close();
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
});

test("architecture.artifact-roundtrip.property", () => {
  assert.deepEqual(artifact.buildA.emittedFiles, ["dist/plugin.mjs", "module.yaml"]);
  assert.deepEqual(artifact.buildA.sharedRuntimeViolations, []);
  assert.deepEqual(artifact.buildB.sharedRuntimeViolations, []);
  assert.equal(artifact.archiveBytes.length > 0, true);
  assert.equal(artifact.manifest.entry, "dist/plugin.mjs");
});

test("architecture.artifact-executable-is-single-file.property", () => {
  for (const builtin of [
    commandsArtifact,
    portsArtifact,
    todosArtifact,
    gitArtifact,
    skillsArtifact,
    thinTerminalArtifact,
    semanticTerminalArtifact,
    assistantsArtifact,
    usageArtifact,
  ]) {
    const executableFiles = builtin.build.emittedFiles.filter(
      (file) => file.endsWith(".js") || file.endsWith(".mjs"),
    );
    assert.deepEqual(executableFiles, [builtin.manifest.entry]);
    assert.equal(
      builtin.manifest.assets.some((file) => file.endsWith(".js") || file.endsWith(".mjs")),
      false,
      "Tauri asset URLs cannot safely resolve relative executable chunks",
    );
  }
});

test("architecture.headless-artifact.property", async () => {
  assert.equal(artifact.manifest.application.role, "headless");
  assert.deepEqual(artifact.manifest.application.contributions, []);
  assert.deepEqual(artifact.manifest.styles, []);
  assert.deepEqual(artifact.manifest.assets, []);

  const entryUrl = pathToFileURL(artifact.entryPath).href;
  const namespace = await import(entryUrl);
  assert.deepEqual(namespace.inspectFixtureEvents(), [], "artifact import must be passive");

  const loaded = await loader.loadShipctlModuleArtifact({
    digest: artifact.digest,
    entryUrl,
    expectedModuleId: artifact.manifest.id,
    expectedVersion: artifact.manifest.version,
    admittedApplication: artifact.manifest.application,
    admittedMessages: artifact.manifest.messages,
    admittedGrants: artifact.manifest.requestedGrants,
    importModule: async () => namespace,
  });
  assert.deepEqual(namespace.inspectFixtureEvents(), ["factory"]);

  const observed = await runtimeApi.activatePluginDefinitionsObserved(
    { panels: {} },
    [loaded.definition],
  );
  assert.deepEqual(observed.failures, []);
  assert.deepEqual(namespace.inspectFixtureEvents(), [
    "factory",
    "service-bind",
    "activate",
    "service-use:ready",
  ]);
  const active = observed.inspect();
  assert.deepEqual(
    active.services.map(({ id, version }) => ({ id, version })),
    artifact.manifest.application.providedServices,
  );
  assert.deepEqual(
    active.effects.filter(({ kind }) => kind === "background").map(({ id }) => id),
    artifact.manifest.application.backgroundEffects,
  );
  assert.deepEqual(active.contributions, []);

  await observed.deactivate();
  await observed.deactivate();
  const events = namespace.inspectFixtureEvents();
  assert.equal(events.filter((event) => event === "background-dispose").length, 1);
  assert.equal(events.filter((event) => event === "module-deactivate").length, 1);
  const disposed = observed.inspect();
  assert.deepEqual(disposed.services, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.contributions, []);
  assert.equal(disposed.activations[0].status, "disposed");

  const graphs = fc.record({
    serviceIds: fc.uniqueArray(
      fc.integer({ min: 0 }).map((value) => `fixture.generated-service-${value}`),
    ),
    effectIds: fc.uniqueArray(
      fc.integer({ min: 0 }).map((value) => `fixture.generated-effect-${value}`),
    ),
  });
  await fc.assert(fc.asyncProperty(graphs, async ({ serviceIds, effectIds }) => {
    const references = serviceIds.map((id) => api.defineSemanticService(id, 1));
    const cleanup = [];
    const definition = api.defineShipctlPlugin({
      role: "headless",
      requires: references,
      provides: references.map((service) => ({ service, bind: () => ({ service: service.id }) })),
      backgroundEffects: effectIds,
      module: {
        id: "fixture.generated-headless",
        version: "1.0.0",
        activate: ({ activation }) => {
          for (const service of references) activation.services.require(service);
          for (const effectId of effectIds) {
            activation.own(() => { cleanup.push(effectId); }, effectId);
          }
        },
      },
    });
    const candidate = await runtimeApi.activatePluginDefinitionsObserved(
      { panels: {} },
      [definition],
    );
    assert.deepEqual(candidate.failures, []);
    const inspection = candidate.inspect();
    assert.deepEqual(
      inspection.services.map(({ id }) => id).sort(),
      [...serviceIds].sort(),
    );
    assert.deepEqual(
      inspection.effects.filter(({ kind }) => kind === "background").map(({ id }) => id).sort(),
      [...effectIds].sort(),
    );
    assert.deepEqual(inspection.contributions, []);
    await candidate.deactivate();
    await candidate.deactivate();
    assert.deepEqual(cleanup.sort(), [...effectIds].sort());
  }), propertyParameters());
});

test("architecture.artifact-externals.property", async () => {
  const shared = [
    ["react/jsx-runtime", "/node_modules/react/index.js", "react"],
    ["react-dom/client", "/node_modules/react-dom/index.js", "react-dom"],
    ["cordis", "/core/frontend/runtime/cordis/vendor/cordis.js", "cordis"],
    ["@shipctl/module-api/testing", "/module-api/frontend/src/index.ts", "@shipctl/module-api"],
    ["@shipctl/core/host", "/core/frontend/host/index.ts", "@shipctl/core"],
  ];
  const dependency = fc.constantFrom(...shared);
  const arbitrary = fc.record({
    shared: dependency,
    shape: fc.constantFrom("external", "bundled", "allowed"),
    file: fc.integer({ min: 0 }).map((value) => `chunk-${value}.mjs`),
  });

  await fc.assert(fc.asyncProperty(
    arbitrary,
    async ({ shared: [specifier, moduleId, dependencyName], shape, file }) => {
    const output = {
      type: "chunk",
      fileName: file,
      imports: shape === "external" ? [specifier] : [],
      dynamicImports: [],
      modules: shape === "bundled" ? { [moduleId]: {} } : { "/fixture/allowed.ts": {} },
    };
    const violations = inspectSharedRuntimeClosure([output]);
    const expectedKind = shape === "external"
      ? "unresolved-shared-import"
      : shape === "bundled" ? "bundled-shared-module" : undefined;
    assert.equal(violations.length, expectedKind === undefined ? 0 : 1);
    if (expectedKind !== undefined) {
      assert.equal(violations[0].kind, expectedKind);
      assert.equal(violations[0].dependency, dependencyName);
    }
  }), propertyParameters());
});

function commandsCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    commands: (module.commands ?? []).map(({ id, moduleId, label }) => ({ id, moduleId, label })),
    panels: (module.panels ?? []).map((panel) => ({
      id: panel.id,
      moduleId: panel.moduleId,
      scope: panel.scope,
      label: panel.label,
      icon: panel.icon,
      shortcut: panel.shortcut,
      singleton: panel.singleton,
      order: panel.order,
      unavailable: panel.unavailable,
      migrationAlias: panel.migrationAlias,
    })),
    projectNavigation: (module.projectNavigation ?? []).map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
    projectLifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
  };
}

function commandsServices({ launchResult }) {
  const terminalCalls = [];
  const notices = [];
  let listener = null;
  const services = {
    panels: {
      open: () => "fixture-panel",
      reveal: () => undefined,
      close: () => undefined,
    },
    appearance: {
      getSnapshot: () => ({ themeId: "fixture", background: "#000" }),
      subscribe: () => () => undefined,
    },
    terminalSessions: {
      list: () => [],
      getDimensions: () => ({ columns: 132, rows: 42 }),
      launch: async (request) => {
        terminalCalls.push(["launch", request]);
        if (launchResult === "failure") throw new Error("fixture launch failed");
        const session = {
          id: request.moduleSessionId,
          terminalId: "00000000-0000-4000-8000-000000000001",
          moduleId: "commands",
          projectPath: request.projectPath,
          ownerKey: request.ownerKey,
          label: request.label,
          ownerMetadata: request.ownerMetadata,
        };
        listener?.({ type: "launched", session });
        return session;
      },
      launchManaged: async () => { throw new Error("not used"); },
      update: async () => { throw new Error("not used"); },
      stop: async (sessionId) => { terminalCalls.push(["stop", sessionId]); },
      focus: async (sessionId) => { terminalCalls.push(["focus", sessionId]); },
      subscribe: (next) => {
        listener = next;
        return () => { if (listener === next) listener = null; };
      },
    },
    settings: {
      getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
    skills: {
      getSnapshot: () => ({ byProject: {} }),
      subscribe: () => () => undefined,
      install: async () => undefined,
    },
    notices: { push: (notice) => notices.push(notice) },
    externalLinks: { open: async () => undefined },
  };
  return { notices, services, terminalCalls };
}

function normalizedTerminalCalls(calls) {
  return calls.map(([operation, request]) => operation !== "launch"
    ? [operation, request]
    : [operation, {
        ...request,
        moduleSessionId: "<generated>",
        ownerKey: "<generated>",
        ownerMetadata: { ...request.ownerMetadata, invocationId: "<generated>" },
      }]);
}

function normalizedInspection(inspection) {
  return {
    activations: inspection.activations.map(({ moduleId, role, status }) => ({
      moduleId,
      role,
      status,
    })),
    contributions: inspection.contributions
      .map(({ moduleId, family, id }) => ({ moduleId, family, id }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    effects: inspection.effects
      .map(({ moduleId, kind, id }) => ({
        moduleId,
        kind,
        id: kind === "owned-lease" ? "<lease>" : id,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    services: inspection.services.map(({ moduleId, id, version }) => ({ moduleId, id, version })),
  };
}

async function runCommandsDefinition({ definition, projectPath, savedCommands, launchResult }) {
  const dataTrace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakePluginDataServiceProvider({
      records: [{
        ownerModuleId: "shipctl.commands",
        scope: { kind: "project", projectId: projectPath },
        key: "commands",
        schemaVersion: 1,
        value: savedCommands,
      }],
      trace: dataTrace,
    }),
  ]);
  const fixture = commandsServices({ launchResult });
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    fixture.services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.commands");
  assert.ok(context);
  const panelActions = [];
  const command = definition.module.commands.find(({ id }) => id === "commands.open-panel");
  assert.ok(command);
  assert.equal(command.isEnabled({ activeProjectId: projectPath }), true);
  command.run({
    activeProjectId: projectPath,
    openPanel: (panelId) => panelActions.push(panelId),
  });
  await definition.module.projectLifecycle.onProjectOpened(
    projectPath,
    fixture.services,
    context,
  );
  const result = {
    catalog: commandsCatalog(definition.module),
    dataTrace: dataTrace.map(({ operation, activation: owner, scope, key }) => ({
      operation,
      moduleId: owner.moduleId,
      scope,
      key,
    })),
    inspection: normalizedInspection(activation.inspect()),
    notices: fixture.notices,
    panelActions,
    terminalCalls: normalizedTerminalCalls(fixture.terminalCalls),
  };
  await definition.module.projectLifecycle.onProjectRemoved(
    projectPath,
    fixture.services,
    context,
  );
  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

test("architecture.commands-artifact-parity.property", async () => {
  assert.deepEqual(commandsArtifact.build.sharedRuntimeViolations, []);
  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: { append: (link) => links.push(link) },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const entryUrl = pathToFileURL(commandsArtifact.entryPath).href;
    const loaded = await loader.loadShipctlModuleArtifact({
      digest: commandsArtifact.digest,
      entryUrl,
      expectedModuleId: commandsArtifact.manifest.id,
      expectedVersion: commandsArtifact.manifest.version,
      admittedApplication: commandsArtifact.manifest.application,
      admittedMessages: commandsArtifact.manifest.messages,
      admittedGrants: commandsArtifact.manifest.requestedGrants,
      styleUrls: commandsArtifact.manifest.styles.map((style) => pathToFileURL(path.join(
        path.dirname(commandsArtifact.entryPath),
        "..",
        style,
      )).href),
    });
    assert.deepEqual(links, [], "artifact loading must remain passive");
    const staticDefinition = runtimeApi.adaptShipctlModule(commandsSource.commandsModule);
    assert.deepEqual(commandsCatalog(loaded.module), commandsCatalog(commandsSource.commandsModule));

    const commands = fc.uniqueArray(
      fc.record({
        key: fc.integer(),
        command: fc.constantFrom("pnpm dev", "pnpm test", "cargo check"),
        cwd: fc.option(fc.constantFrom("apps/web", "./tools", "../shared"), { nil: null }),
        environmentValue: fc.string(),
      }),
      { minLength: 1, selector: ({ key }) => key },
    );
    await fc.assert(fc.asyncProperty(
      fc.record({
        projectKey: fc.integer(),
        commands,
        launchResult: fc.constantFrom("success", "failure"),
      }),
      async ({ projectKey, commands: generated, launchResult }) => {
        const projectPath = `/workspace/project-${projectKey}`;
        const savedCommands = generated.map(({ key, command, cwd, environmentValue }) => ({
          name: `command-${key}`,
          command,
          autostart: true,
          env: { FIXTURE: environmentValue },
          cwd,
        }));
        const sourceResult = await runCommandsDefinition({
          definition: staticDefinition,
          projectPath,
          savedCommands,
          launchResult,
        });
        const artifactResult = await runCommandsDefinition({
          definition: loaded.definition,
          projectPath,
          savedCommands,
          launchResult,
        });
        assert.deepEqual(artifactResult, sourceResult);
        assert.deepEqual(links, [], "artifact styles must leave with their activation");
      },
    ), propertyParameters());
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function portsCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    globalSurfaces: (module.globalSurfaces ?? []).map((surface) => ({
      id: surface.id,
      moduleId: surface.moduleId,
      unavailable: surface.unavailable,
    })),
    globalNavigation: (module.globalNavigation ?? []).map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      surfaceId: navigation.surfaceId,
      label: navigation.label,
      icon: navigation.icon,
      order: navigation.order,
    })),
  };
}

async function runPortsDefinition({ definition, inspections, deniedOperation, projectPaths }) {
  const trace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeProcessesServiceProvider({
      inspections: () => inspections,
      deniedOperations: deniedOperation === "none" ? [] : [deniedOperation],
      trace,
    }),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    { panels: {} },
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.ports");
  assert.ok(context);

  const surfaceModule = await definition.module.globalSurfaces[0].load();
  assert.equal(typeof surfaceModule.default, "function");
  const processes = context.services.require(api.processesService);
  const scan = await surfaceModule.scanPorts(processes, projectPaths);
  const stop = scan.status === "ready" && scan.ports.length > 0
    ? await surfaceModule.stopPort(scan.ports[0], processes)
    : null;
  const result = {
    catalog: portsCatalog(definition.module),
    inspection: normalizedInspection(activation.inspect()),
    scan,
    stop,
    trace: trace.map(({ operation, request }) => ({
      operation,
      moduleId: request.activation.moduleId,
      input: request.input,
    })),
  };

  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

test("architecture.ports-artifact-parity.property", async () => {
  assert.deepEqual(portsArtifact.build.sharedRuntimeViolations, []);
  const entryUrl = pathToFileURL(portsArtifact.entryPath).href;
  const loaded = await loader.loadShipctlModuleArtifact({
    digest: portsArtifact.digest,
    entryUrl,
    expectedModuleId: portsArtifact.manifest.id,
    expectedVersion: portsArtifact.manifest.version,
    admittedApplication: portsArtifact.manifest.application,
    admittedMessages: portsArtifact.manifest.messages,
    admittedGrants: portsArtifact.manifest.requestedGrants,
  });
  const staticDefinition = runtimeApi.adaptShipctlModule(portsSource.portsModule);
  assert.deepEqual(portsCatalog(loaded.module), portsCatalog(portsSource.portsModule));
  assert.equal(loaded.definition.role, "presentation");
  assert.deepEqual(
    portsArtifact.manifest.application.requiredServices,
    [{ id: "shipctl.processes", version: 1 }],
  );

  const cases = fc.record({
    port: fc.integer({ min: 1, max: 65_535 }),
    processId: fc.integer({ min: 1 }),
    processName: fc.constantFrom("node", "Slack Helper", "python3"),
    commandLine: fc.constantFrom("vite dev", "python -m uvicorn app:main", "serve"),
    projectKey: fc.integer(),
    failure: fc.constantFrom(
      "none",
      "inspect-listening-ports",
      "terminate-inspected-process",
    ),
  });
  await fc.assert(fc.asyncProperty(cases, async ({
    port,
    processId,
    processName,
    commandLine,
    projectKey,
    failure,
  }) => {
    const projectPath = `/workspace/project-${projectKey}`;
    const inspections = [{
      inspectionId: `inspection-${processId}`,
      port,
      processId,
      name: processName,
      workingDirectory: `${projectPath}/apps/web`,
      commandLine,
      observedProjectFiles: commandLine.includes("vite") ? ["vite.config.ts"] : [],
      uptime: "01:02",
      memoryKilobytes: 2048,
    }];
    const request = {
      inspections,
      deniedOperation: failure,
      projectPaths: ["/workspace", projectPath],
    };
    const sourceResult = await runPortsDefinition({ definition: staticDefinition, ...request });
    const artifactResult = await runPortsDefinition({ definition: loaded.definition, ...request });
    assert.deepEqual(artifactResult, sourceResult);
  }), propertyParameters());
});

function todosCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    panels: (module.panels ?? []).map((panel) => ({
      id: panel.id,
      moduleId: panel.moduleId,
      scope: panel.scope,
      label: panel.label,
      icon: panel.icon,
      singleton: panel.singleton,
      order: panel.order,
      unavailable: panel.unavailable,
      migrationAlias: panel.migrationAlias,
    })),
    projectNavigation: (module.projectNavigation ?? []).map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
    settings: (module.settings ?? []).map((settings) => ({
      id: settings.id,
      moduleId: settings.moduleId,
      order: settings.order,
    })),
    lifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
  };
}

async function runTodosDefinition({ definition, enabled, projectPaths, denied }) {
  const trace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeProjectDocumentsServiceProvider({
      documents: projectPaths.map((projectId, index) => ({
        projectId,
        relativePath: "TODO.md",
        contents: `- [ ] task-${index}\n`,
      })),
      deniedOperations: denied ? ["discover"] : [],
      trace,
    }),
  ]);
  const services = {
    panels: {},
    settings: {
      getSnapshot: () => ({ values: { showTodos: enabled } }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
  };
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.todos");
  assert.ok(context);

  const loadedContributions = await Promise.all([
    definition.module.panels[0].load(),
    definition.module.projectNavigation[0].load(),
    definition.module.settings[0].load(),
  ]);
  assert.equal(loadedContributions.every(({ default: contribution }) => (
    typeof contribution === "function"
  )), true);
  definition.module.projectLifecycle.onProjectsChanged(projectPaths, services, context);
  await new Promise((resolve) => setImmediate(resolve));
  definition.module.projectLifecycle.onFilesystemChanged(projectPaths, services, context);
  await new Promise((resolve) => setImmediate(resolve));

  const inspection = normalizedInspection(activation.inspect());
  const result = {
    catalog: todosCatalog(definition.module),
    inspection: {
      activations: inspection.activations,
      contributions: inspection.contributions,
      services: inspection.services,
    },
    trace: trace.map(({ operation, request }) => ({
      operation,
      moduleId: request.activation.moduleId,
      input: request.input,
    })),
  };
  for (const projectPath of projectPaths) {
    definition.module.projectLifecycle.onProjectRemoved(projectPath);
  }
  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

test("architecture.todos-artifact-parity.property", async () => {
  assert.deepEqual(todosArtifact.build.sharedRuntimeViolations, []);
  assert.equal(todosArtifact.manifest.styles.length > 0, true);
  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: { append: (link) => links.push(link) },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const entryUrl = pathToFileURL(todosArtifact.entryPath).href;
    const loaded = await loader.loadShipctlModuleArtifact({
      digest: todosArtifact.digest,
      entryUrl,
      expectedModuleId: todosArtifact.manifest.id,
      expectedVersion: todosArtifact.manifest.version,
      admittedApplication: todosArtifact.manifest.application,
      admittedMessages: todosArtifact.manifest.messages,
      admittedGrants: todosArtifact.manifest.requestedGrants,
      styleUrls: todosArtifact.manifest.styles.map((style) => pathToFileURL(path.join(
        path.dirname(todosArtifact.entryPath),
        "..",
        style,
      )).href),
    });
    assert.deepEqual(links, [], "artifact loading must remain passive");
    const staticDefinition = runtimeApi.adaptShipctlModule(todosSource.todosModule);
    assert.deepEqual(todosCatalog(loaded.module), todosCatalog(todosSource.todosModule));
    assert.equal(loaded.definition.role, "compound");
    assert.deepEqual(
      todosArtifact.manifest.application.requiredServices,
      [{ id: "shipctl.project-documents", version: 1 }],
    );

    await fc.assert(fc.asyncProperty(
      fc.record({
        enabled: fc.boolean(),
        denied: fc.boolean(),
        projectKeys: fc.uniqueArray(fc.integer(), { minLength: 1, maxLength: 4 }),
      }),
      async ({ enabled, denied, projectKeys }) => {
        const request = {
          enabled,
          denied,
          projectPaths: projectKeys.map((key) => `/workspace/project-${key}`),
        };
        const sourceResult = await runTodosDefinition({
          definition: staticDefinition,
          ...request,
        });
        const artifactResult = await runTodosDefinition({
          definition: loaded.definition,
          ...request,
        });
        assert.deepEqual(artifactResult, sourceResult);
        assert.deepEqual(links, [], "artifact styles must leave with their activation");
      },
    ), propertyParameters());
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function gitCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    panels: (module.panels ?? []).map((panel) => ({
      id: panel.id,
      moduleId: panel.moduleId,
      scope: panel.scope,
      label: panel.label,
      icon: panel.icon,
      shortcut: panel.shortcut,
      singleton: panel.singleton,
      order: panel.order,
      unavailable: panel.unavailable,
      migrationAlias: panel.migrationAlias,
    })),
    projectNavigation: (module.projectNavigation ?? []).map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
    projectLayout: (module.projectLayout ?? []).map(({ id, moduleId, slot, order }) => ({
      id,
      moduleId,
      slot,
      order,
    })),
    projectActions: (module.projectActions ?? []).map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
    projectFactsProvider: module.projectFactsProvider === undefined ? null : {
      id: module.projectFactsProvider.id,
      moduleId: module.projectFactsProvider.moduleId,
    },
    projectImport: module.projectImport === undefined ? null : {
      id: module.projectImport.id,
      moduleId: module.projectImport.moduleId,
    },
    settings: (module.settings ?? []).map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
    lifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
  };
}

function gitHostServices(autoImportWorktrees) {
  return {
    panels: {},
    settings: {
      getSnapshot: () => ({ values: { autoImportWorktrees } }),
      subscribe: () => () => undefined,
      update: async () => undefined,
    },
  };
}

async function runGitDefinition({
  definition,
  projectPath,
  branchName,
  dirty,
  denied,
  autoImportWorktrees,
  expandRelated,
}) {
  const linkedPath = `${projectPath}-linked`;
  const worktrees = [
    { projectId: projectPath, branchName, isMain: true },
    { projectId: linkedPath, branchName: `${branchName}-linked`, isMain: false },
  ];
  const trace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeGitServiceProvider({
      repositories: [
        {
          projectId: projectPath,
          status: { branchName, dirty },
          worktrees,
        },
        {
          projectId: linkedPath,
          status: {
            branchName: `${branchName}-linked`,
            dirty: !dirty,
            worktreeParentProjectId: projectPath,
          },
          worktrees,
        },
      ],
      deniedOperations: denied ? ["inspect-status"] : [],
      trace,
    }),
  ]);
  const services = gitHostServices(autoImportWorktrees);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.git");
  assert.ok(context);

  const relatedPaths = await definition.module.projectImport.relatedPaths(
    projectPath,
    { expandRelated },
    services,
    context,
  );
  await definition.module.projectLifecycle.onProjectsChanged(
    [projectPath, linkedPath],
    services,
    context,
  );
  await definition.module.projectLifecycle.onFilesystemChanged(
    [projectPath],
    services,
    context,
  );
  const project = { id: projectPath, path: projectPath, label: projectPath };
  const facts = definition.module.projectFactsProvider.getFacts(project);
  const inspection = normalizedInspection(activation.inspect());
  const result = {
    catalog: gitCatalog(definition.module),
    facts,
    relatedPaths,
    inspection: {
      activations: inspection.activations,
      contributions: inspection.contributions,
      services: inspection.services,
    },
    trace: trace.map(({ operation, request }) => ({
      operation,
      moduleId: request.activation.moduleId,
      input: request.input,
    })),
  };

  definition.module.projectLifecycle.onProjectRemoved(projectPath, services, context);
  definition.module.projectLifecycle.onProjectRemoved(linkedPath, services, context);
  assert.equal(definition.module.projectFactsProvider.getFacts(project), null);
  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

test("architecture.git-artifact-parity.property", async () => {
  assert.deepEqual(gitArtifact.build.sharedRuntimeViolations, []);
  assert.equal(gitArtifact.manifest.styles.length > 0, true);
  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: { append: (link) => links.push(link) },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const entryUrl = pathToFileURL(gitArtifact.entryPath).href;
    const loaded = await loader.loadShipctlModuleArtifact({
      digest: gitArtifact.digest,
      entryUrl,
      expectedModuleId: gitArtifact.manifest.id,
      expectedVersion: gitArtifact.manifest.version,
      admittedApplication: gitArtifact.manifest.application,
      admittedMessages: gitArtifact.manifest.messages,
      admittedGrants: gitArtifact.manifest.requestedGrants,
      styleUrls: gitArtifact.manifest.styles.map((style) => pathToFileURL(path.join(
        path.dirname(gitArtifact.entryPath),
        "..",
        style,
      )).href),
    });
    assert.deepEqual(links, [], "artifact loading must remain passive");
    const staticDefinition = runtimeApi.adaptShipctlModule(gitSource.gitModule);
    assert.deepEqual(gitCatalog(loaded.module), gitCatalog(gitSource.gitModule));
    assert.equal(loaded.definition.role, "compound");
    assert.deepEqual(
      gitArtifact.manifest.application.requiredServices,
      [{ id: "shipctl.git", version: 1 }],
    );

    await fc.assert(fc.asyncProperty(
      fc.record({
        projectKey: fc.integer(),
        branchName: fc.constantFrom("main", "feature/runtime", "release-0.7"),
        dirty: fc.boolean(),
        denied: fc.boolean(),
        autoImportWorktrees: fc.boolean(),
        expandRelated: fc.boolean(),
      }),
      async ({ projectKey, ...request }) => {
        const input = { projectPath: `/workspace/project-${projectKey}`, ...request };
        const sourceResult = await runGitDefinition({
          definition: staticDefinition,
          ...input,
        });
        const artifactResult = await runGitDefinition({
          definition: loaded.definition,
          ...input,
        });
        assert.deepEqual(artifactResult, sourceResult);
        assert.deepEqual(links, [], "artifact styles must leave with their activation");
      },
    ), propertyParameters());
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function skillsCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    projectActions: (module.projectActions ?? []).map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
    skillsProvider: module.skillsProvider === undefined ? null : {
      id: module.skillsProvider.id,
      moduleId: module.skillsProvider.moduleId,
    },
    lifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
  };
}

function skillInspection(api, installedTodos, installedOrchestrate) {
  return [
    {
      skillId: api.skillId("shipctl-todos"),
      title: "Project to-dos",
      description: "Teaches agents to keep TODO.md as a kanban board: move cards when starting or finishing work, add discovered work to the backlog, and reconcile the board before ending a session.",
      installed: installedTodos,
    },
    {
      skillId: api.skillId("orchestrate"),
      title: "Orchestrate",
      description: "Turns any agent into a planner/orchestrator that delegates implementation to a different agent CLI running headless (codex, claude, opencode), reviews each task, and finishes with a fresh-context audit.",
      installed: installedOrchestrate,
    },
  ];
}

function normalizedSkillTrace(trace) {
  return trace.map(({ operation, request }) => {
    const input = request.input;
    const normalizedInput = operation === "inspect-skills"
      ? {
          projectId: input.projectId,
          catalog: input.catalog.map(({ skillId, title, description }) => ({
            skillId,
            title,
            description,
          })),
        }
      : operation === "install-skill"
        ? {
            projectId: input.projectId,
            skill: {
              skillId: input.skill.skillId,
              title: input.skill.title,
              description: input.skill.description,
              markdownLength: input.skill.markdown.length,
            },
          }
        : { projectId: input.projectId, skillId: input.skillId };
    return {
      operation,
      moduleId: request.activation.moduleId,
      input: normalizedInput,
    };
  });
}

function cloneSkillsSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.byProject).map(([projectId, skills]) => [
    projectId,
    skills.map((skill) => ({ ...skill })),
  ]));
}

async function runSkillsDefinition({
  definition,
  projectPaths,
  installedTodos,
  installedOrchestrate,
  deniedOperation,
  action,
}) {
  const trace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeSkillInstallationServiceProvider({
      projects: projectPaths.map((projectId) => ({
        projectId,
        skills: skillInspection(api, installedTodos, installedOrchestrate),
      })),
      deniedOperations: deniedOperation === "none" ? [] : [deniedOperation],
      trace,
    }),
  ]);
  const notices = [];
  const services = {
    panels: {},
    notices: { push: (notice) => notices.push(notice) },
  };
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.skills");
  assert.ok(context);

  await definition.module.projectLifecycle.onProjectsChanged(
    projectPaths,
    services,
    context,
  );
  await definition.module.projectLifecycle.onFilesystemChanged(
    projectPaths,
    services,
    context,
  );
  const project = {
    id: projectPaths[0],
    name: projectPaths[0],
    path: projectPaths[0],
  };
  const group = definition.module.projectActions[0].getGroup(project, services, context);
  let actionOutcome = "not-run";
  try {
    if (action === "provider-install-todos") {
      await definition.module.skillsProvider.port.install(project.path, "shipctl-todos");
      actionOutcome = "success";
    } else if (action !== "none" && group !== null) {
      const actionId = action === "toggle-todos"
        ? "skills.shipctl-todos"
        : "skills.orchestrate";
      await group.actions.find(({ id }) => id === actionId)?.run();
      actionOutcome = "success";
    }
  } catch (error) {
    actionOutcome = error instanceof Error ? error.message : String(error);
  }

  const inspection = normalizedInspection(activation.inspect());
  const result = {
    actionOutcome,
    catalog: skillsCatalog(definition.module),
    group: group === null ? null : {
      label: group.label,
      actions: group.actions.map(({ id, label, selected, keepOpen }) => ({
        id,
        label,
        selected,
        keepOpen,
      })),
    },
    inspection,
    notices,
    snapshot: cloneSkillsSnapshot(definition.module.skillsProvider.port.getSnapshot()),
    trace: normalizedSkillTrace(trace),
  };

  for (const projectPath of projectPaths) {
    definition.module.projectLifecycle.onProjectRemoved(projectPath, services, context);
  }
  assert.deepEqual(
    cloneSkillsSnapshot(definition.module.skillsProvider.port.getSnapshot()),
    {},
  );
  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  await assert.rejects(
    definition.module.skillsProvider.port.install(project.path, "shipctl-todos"),
    /Skills module is not active/,
  );
  return result;
}

test("architecture.skills-artifact-parity.property", async () => {
  assert.deepEqual(skillsArtifact.build.sharedRuntimeViolations, []);
  assert.deepEqual(skillsArtifact.manifest.styles, []);
  assert.deepEqual(skillsArtifact.manifest.assets, []);
  assert.deepEqual(skillsArtifact.manifest.peerDependencies, {});

  const entryUrl = pathToFileURL(skillsArtifact.entryPath).href;
  const loaded = await loader.loadShipctlModuleArtifact({
    digest: skillsArtifact.digest,
    entryUrl,
    expectedModuleId: skillsArtifact.manifest.id,
    expectedVersion: skillsArtifact.manifest.version,
    admittedApplication: skillsArtifact.manifest.application,
    admittedMessages: skillsArtifact.manifest.messages,
    admittedGrants: skillsArtifact.manifest.requestedGrants,
  });
  const staticDefinition = runtimeApi.adaptShipctlModule(skillsSource.skillsModule);
  assert.deepEqual(skillsCatalog(loaded.module), skillsCatalog(skillsSource.skillsModule));
  assert.equal(loaded.definition.role, "compound");
  assert.deepEqual(
    skillsArtifact.manifest.application.requiredServices,
    [{ id: "shipctl.skill-installation", version: 2 }],
  );

  await fc.assert(fc.asyncProperty(
    fc.record({
      primaryKey: fc.integer(),
      secondaryKey: fc.integer(),
      installedTodos: fc.boolean(),
      installedOrchestrate: fc.boolean(),
      deniedOperation: fc.constantFrom(
        "none",
        "inspect-skills",
        "install-skill",
        "remove-skill",
      ),
      action: fc.constantFrom(
        "none",
        "toggle-todos",
        "toggle-orchestrate",
        "provider-install-todos",
      ),
    }),
    async ({ primaryKey, secondaryKey, ...request }) => {
      const input = {
        ...request,
        projectPaths: [
          `/workspace/project-${primaryKey}-primary`,
          `/workspace/project-${secondaryKey}-secondary`,
        ],
      };
      const sourceResult = await runSkillsDefinition({
        definition: staticDefinition,
        ...input,
      });
      const artifactResult = await runSkillsDefinition({
        definition: loaded.definition,
        ...input,
      });
      assert.deepEqual(artifactResult, sourceResult);
    },
  ), propertyParameters());
});

function terminalPresentationCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    requiredGrants: [...module.requiredGrants ?? []],
    terminalPresentations: (module.terminalPresentations ?? []).map((presentation) => ({
      moduleId: presentation.moduleId,
      driverId: presentation.driverId,
      requiredServices: presentation.requiredServices.map(({ id, version }) => ({ id, version })),
      presentationType: typeof presentation.Presentation,
    })),
  };
}

function terminalPresentationElement(module, props) {
  const presentation = module.terminalPresentations[0];
  const element = presentation.Presentation(props);
  return {
    elementKind: String(element.$$typeof),
    componentKind: String(element.type?.$$typeof ?? typeof element.type),
    terminalId: element.props.terminalId,
    visible: element.props.visible,
    preservesActivation: element.props.activation === props.activation,
    preservesServices: element.props.services === props.services,
  };
}

test("architecture.thin-terminal-artifact-parity.property", async () => {
  assert.deepEqual(thinTerminalArtifact.build.sharedRuntimeViolations, []);
  assert.equal(thinTerminalArtifact.manifest.styles.length, 1);
  assert.match(thinTerminalArtifact.manifest.styles[0], /\.css$/);
  assert.deepEqual(thinTerminalArtifact.manifest.assets, []);
  assert.deepEqual(thinTerminalArtifact.manifest.peerDependencies, {
    react: "^19.0.0",
  });
  assert.deepEqual(thinTerminalArtifact.manifest.requestedGrants, [
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
  ]);
  assert.deepEqual(thinTerminalArtifact.manifest.application.requiredServices, [
    { id: "shipctl.terminal-sessions", version: 1 },
  ]);

  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: { append: (link) => links.push(link) },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const entryUrl = pathToFileURL(thinTerminalArtifact.entryPath).href;
    const loaded = await loader.loadShipctlModuleArtifact({
      digest: thinTerminalArtifact.digest,
      entryUrl,
      expectedModuleId: thinTerminalArtifact.manifest.id,
      expectedVersion: thinTerminalArtifact.manifest.version,
      admittedApplication: thinTerminalArtifact.manifest.application,
      admittedMessages: thinTerminalArtifact.manifest.messages,
      admittedGrants: thinTerminalArtifact.manifest.requestedGrants,
      styleUrls: thinTerminalArtifact.manifest.styles.map((style) => pathToFileURL(path.join(
        path.dirname(thinTerminalArtifact.entryPath),
        "..",
        style,
      )).href),
    });
    assert.deepEqual(links, [], "artifact import and validation must remain passive");
    assert.deepEqual(
      terminalPresentationCatalog(loaded.module),
      terminalPresentationCatalog(thinTerminalSource.thinTerminalModule),
    );
    assert.equal(loaded.definition.role, "presentation");

    const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
    const semanticServices = new semanticRuntime.SemanticServiceRegistry([
      terminalFixture.provider,
    ]);
    const activation = await runtimeApi.activatePluginDefinitionsObserved(
      { panels: {} },
      [loaded.definition],
      new Map(),
      semanticServices,
    );
    assert.deepEqual(activation.failures, []);
    assert.equal(links.length, 1);
    assert.equal(links[0].dataset.shipctlModule, "shipctl.thin-terminal");
    const context = activation.activationContextsByModule.get("shipctl.thin-terminal");
    assert.ok(context);
    const services = { notices: { push: () => undefined } };

    await fc.assert(fc.asyncProperty(
      fc.record({ terminalKey: fc.integer(), visible: fc.boolean() }),
      async ({ terminalKey, visible }) => {
        const props = {
          activation: context,
          terminalId: `terminal-${terminalKey}`,
          services,
          visible,
        };
        assert.deepEqual(
          terminalPresentationElement(loaded.module, props),
          terminalPresentationElement(thinTerminalSource.thinTerminalModule, props),
        );
      },
    ), propertyParameters());

    assert.deepEqual(
      activation.inspect().contributions.map(({ family, id }) => ({ family, id })),
      [{ family: "terminal-presentation", id: "thin-terminal" }],
    );
    await activation.deactivate();
    await activation.deactivate();
    assert.deepEqual(links, [], "artifact styles must leave with their activation");
    const disposed = activation.inspect();
    assert.deepEqual(disposed.contributions, []);
    assert.deepEqual(disposed.effects, []);
    assert.deepEqual(disposed.services, []);
    assert.equal(disposed.activations[0].status, "disposed");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("architecture.semantic-terminal-artifact-parity.property", async () => {
  assert.deepEqual(semanticTerminalArtifact.build.sharedRuntimeViolations, []);
  assert.equal(semanticTerminalArtifact.manifest.styles.length, 1);
  assert.match(semanticTerminalArtifact.manifest.styles[0], /\.css$/);
  assert.deepEqual(semanticTerminalArtifact.manifest.assets, []);
  assert.deepEqual(semanticTerminalArtifact.manifest.peerDependencies, {
    react: "^19.0.0",
  });
  assert.deepEqual(semanticTerminalArtifact.manifest.requestedGrants, [
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "semantic-terminal.attach",
    "semantic-terminal.input",
    "semantic-terminal.inspect",
  ]);
  assert.deepEqual(semanticTerminalArtifact.manifest.application.requiredServices, [
    { id: "shipctl.semantic-terminals", version: 1 },
    { id: "shipctl.terminal-sessions", version: 1 },
  ]);

  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: { append: (link) => links.push(link) },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    const entryUrl = pathToFileURL(semanticTerminalArtifact.entryPath).href;
    const loaded = await loader.loadShipctlModuleArtifact({
      digest: semanticTerminalArtifact.digest,
      entryUrl,
      expectedModuleId: semanticTerminalArtifact.manifest.id,
      expectedVersion: semanticTerminalArtifact.manifest.version,
      admittedApplication: semanticTerminalArtifact.manifest.application,
      admittedMessages: semanticTerminalArtifact.manifest.messages,
      admittedGrants: semanticTerminalArtifact.manifest.requestedGrants,
      styleUrls: semanticTerminalArtifact.manifest.styles.map((style) => pathToFileURL(path.join(
        path.dirname(semanticTerminalArtifact.entryPath),
        "..",
        style,
      )).href),
    });
    assert.deepEqual(links, [], "artifact import and validation must remain passive");
    assert.deepEqual(
      terminalPresentationCatalog(loaded.module),
      terminalPresentationCatalog(semanticTerminalSource.semanticTerminalModule),
    );
    assert.equal(loaded.definition.role, "presentation");

    const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
    const semanticTerminalFixture =
      testingApi.createFakeSemanticTerminalsServiceProvider();
    const semanticServices = new semanticRuntime.SemanticServiceRegistry([
      terminalFixture.provider,
      semanticTerminalFixture.provider,
    ]);
    const activation = await runtimeApi.activatePluginDefinitionsObserved(
      { panels: {} },
      [loaded.definition],
      new Map(),
      semanticServices,
    );
    assert.deepEqual(activation.failures, []);
    assert.equal(links.length, 1);
    assert.equal(links[0].dataset.shipctlModule, "shipctl.semantic-terminal");
    const context = activation.activationContextsByModule.get("shipctl.semantic-terminal");
    assert.ok(context);
    const services = { notices: { push: () => undefined } };

    await fc.assert(fc.asyncProperty(
      fc.record({ terminalKey: fc.integer(), visible: fc.boolean() }),
      async ({ terminalKey, visible }) => {
        const props = {
          activation: context,
          terminalId: `terminal-${terminalKey}`,
          services,
          visible,
        };
        assert.deepEqual(
          terminalPresentationElement(loaded.module, props),
          terminalPresentationElement(semanticTerminalSource.semanticTerminalModule, props),
        );
      },
    ), propertyParameters());

    assert.deepEqual(
      activation.inspect().contributions.map(({ family, id }) => ({ family, id })),
      [{ family: "terminal-presentation", id: "semantic-terminal" }],
    );
    await activation.deactivate();
    await activation.deactivate();
    assert.deepEqual(links, [], "artifact styles must leave with their activation");
    const disposed = activation.inspect();
    assert.deepEqual(disposed.contributions, []);
    assert.deepEqual(disposed.effects, []);
    assert.deepEqual(disposed.services, []);
    assert.equal(disposed.activations[0].status, "disposed");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function assistantsCatalog(module) {
  return {
    id: module.id,
    version: module.version,
    requiredGrants: [...module.requiredGrants ?? []],
    panels: (module.panels ?? []).map((panel) => ({
      id: panel.id,
      moduleId: panel.moduleId,
      scope: panel.scope,
      label: panel.label,
      icon: panel.icon,
      singleton: panel.singleton,
      order: panel.order,
      shortcut: panel.shortcut,
      newSession: panel.newSession,
      unavailable: panel.unavailable,
      migrationAlias: panel.migrationAlias,
    })),
    lifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
    hasActivate: typeof module.activate === "function",
    hasBeforeShutdown: typeof module.beforeShutdown === "function",
  };
}

function assistantsHostServices() {
  const trace = [];
  return {
    trace,
    services: {
      panels: {},
      terminalSessions: {
        subscribe: () => {
          trace.push("subscribe");
          return () => trace.push("unsubscribe");
        },
      },
      notices: { push: (notice) => trace.push(["notice", notice]) },
    },
  };
}

function normalizedRequestTrace(trace) {
  return trace.map(({ operation, grant, request }) => ({
    operation,
    ...(grant === undefined ? {} : { grant }),
    moduleId: request.activation.moduleId,
    input: request.input,
  }));
}

function normalizedCredentialTrace(trace) {
  return trace.map(({ operation, activation, credentialId, secret }) => ({
    operation,
    moduleId: activation.moduleId,
    credentialId,
    ...(secret === undefined ? {} : { secret }),
  }));
}

async function runAssistantsDefinition({
  definition,
  commandAvailable,
  configuredCredential,
  provider,
  models,
}) {
  const assistantTrace = [];
  const credentialTrace = [];
  const processTrace = [];
  const terminalTrace = [];
  const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider({
    traces: terminalTrace,
  });
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeAssistantLaunchServiceProvider({
      models: { [provider]: models },
      trace: assistantTrace,
    }),
    testingApi.createFakeCredentialStoreServiceProvider({
      configuredCredentials: configuredCredential
        ? [api.credentialId("pi.api-key", provider)]
        : [],
      trace: credentialTrace,
    }),
    testingApi.createFakeProcessesServiceProvider({
      availableCommands: commandAvailable ? [provider] : [],
      trace: processTrace,
    }),
    terminalFixture.provider,
  ]);
  const host = assistantsHostServices();
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    host.services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.assistants");
  assert.ok(context);

  const panelNamespace = await definition.module.panels[0].load();
  const processOutcome = await context.services.require(api.processesService)
    .inspectCommand.execute({ command: provider });
  const modelOutcome = await context.services.require(api.assistantLaunchService)
    .inspectModels.execute({ provider: api.assistantProviderId(provider) });
  const credentialOutcome = await context.services.require(api.credentialStoreService)
    .hasCredential.execute({ credentialId: api.credentialId("pi.api-key", provider) });
  const terminalOutcome = await context.services.require(api.terminalSessionsService)
    .inspectSessions.execute({ owner: "activation" });
  await definition.module.beforeShutdown(host.services, context);

  const result = {
    assistantTrace: normalizedRequestTrace(assistantTrace),
    catalog: assistantsCatalog(definition.module),
    credentialResult: credentialOutcome.result,
    credentialTrace: normalizedCredentialTrace(credentialTrace),
    inspection: normalizedInspection(activation.inspect()),
    modelResult: modelOutcome.result,
    panelExports: Object.keys(panelNamespace).sort(),
    panelType: typeof panelNamespace.default,
    processResult: processOutcome.result,
    processTrace: normalizedRequestTrace(processTrace),
    terminalResult: terminalOutcome.result,
    terminalTrace: normalizedRequestTrace(terminalTrace),
  };

  await activation.deactivate();
  await activation.deactivate();
  assert.deepEqual(host.trace, ["subscribe", "unsubscribe"]);
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

async function runAssistantsRestoreOnce(definition) {
  const assistantTrace = [];
  const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeAssistantLaunchServiceProvider({
      startupWarning: "Fixture restore warning",
      trace: assistantTrace,
    }),
    testingApi.createFakeCredentialStoreServiceProvider(),
    testingApi.createFakeProcessesServiceProvider(),
    terminalFixture.provider,
  ]);
  const host = assistantsHostServices();
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    host.services,
    [definition],
    new Map(),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.assistants");
  assert.ok(context);
  await definition.module.projectLifecycle.onProjectsChanged(
    ["/workspace/restore-project"],
    host.services,
    context,
  );
  const result = {
    assistantTrace: normalizedRequestTrace(assistantTrace),
    hostTrace: host.trace.filter((entry) => Array.isArray(entry)),
  };
  await activation.deactivate();
  return result;
}

test("architecture.assistants-artifact-parity.property", async () => {
  assert.deepEqual(assistantsArtifact.build.sharedRuntimeViolations, []);
  assert.deepEqual(assistantsArtifact.manifest.styles, []);
  assert.deepEqual(assistantsArtifact.manifest.assets, []);
  assert.deepEqual(assistantsArtifact.manifest.peerDependencies, {
    react: "^19.0.0",
  });
  assert.deepEqual(assistantsArtifact.manifest.requestedGrants, [
    "assistant.launch",
    "assistant.session-record",
    "credential.inspect",
    "credential.write",
    "terminal.start",
    "terminal.attach",
  ]);
  assert.deepEqual(assistantsArtifact.manifest.application.requiredServices, [
    { id: "shipctl.assistant-launch", version: 1 },
    { id: "shipctl.credential-store", version: 1 },
    { id: "shipctl.processes", version: 1 },
    { id: "shipctl.terminal-sessions", version: 1 },
  ]);
  assert.deepEqual(assistantsArtifact.manifest.application.contributions, [
    { family: "panel", id: "assistants.launcher", schemaVersion: 1 },
  ]);

  const entryUrl = pathToFileURL(assistantsArtifact.entryPath).href;
  const loaded = await loader.loadShipctlModuleArtifact({
    digest: assistantsArtifact.digest,
    entryUrl,
    expectedModuleId: assistantsArtifact.manifest.id,
    expectedVersion: assistantsArtifact.manifest.version,
    admittedApplication: assistantsArtifact.manifest.application,
    admittedMessages: assistantsArtifact.manifest.messages,
    admittedGrants: assistantsArtifact.manifest.requestedGrants,
  });
  const staticDefinition = api.defineShipctlPlugin({
    module: assistantsSource.assistantsModule,
    role: "compound",
    requires: [
      api.assistantLaunchService,
      api.credentialStoreService,
      api.processesService,
      api.terminalSessionsService,
    ],
  });
  assert.deepEqual(
    assistantsCatalog(loaded.module),
    assistantsCatalog(assistantsSource.assistantsModule),
  );
  assert.equal(loaded.definition.role, "compound");
  assert.deepEqual(
    await runAssistantsRestoreOnce(loaded.definition),
    await runAssistantsRestoreOnce(staticDefinition),
  );

  await fc.assert(fc.asyncProperty(
    fc.record({
      commandAvailable: fc.boolean(),
      configuredCredential: fc.boolean(),
      provider: fc.constantFrom("claude", "codex", "antigravity", "opencode", "pi"),
      models: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9._-]{0,15}$/)),
    }),
    async (input) => {
      const sourceResult = await runAssistantsDefinition({
        definition: staticDefinition,
        ...input,
      });
      const artifactResult = await runAssistantsDefinition({
        definition: loaded.definition,
        ...input,
      });
      assert.deepEqual(artifactResult, sourceResult);
    },
  ), propertyParameters());
});

function usageCatalog(module) {
  const presentation = (values) => (values ?? []).map((value) => ({
    id: value.id,
    moduleId: value.moduleId,
    surfaceId: value.surfaceId,
    label: value.label,
    icon: value.icon,
    order: value.order,
    slot: value.slot,
    unavailable: value.unavailable,
    hasLoader: typeof value.load === "function",
  }));
  const messages = module.messages ?? EMPTY_MESSAGES;
  return {
    id: module.id,
    version: module.version,
    requiredGrants: [...module.requiredGrants ?? []],
    globalSurfaces: presentation(module.globalSurfaces),
    globalNavigation: presentation(module.globalNavigation),
    sidebar: presentation(module.sidebar),
    settings: presentation(module.settings),
    scheduledTasks: (module.scheduledTasks ?? []).map(({ id, moduleId, schedule }) => ({
      id,
      moduleId,
      schedule,
    })),
    messages: {
      provides: (messages.provides ?? []).map(({ message, schema }) => ({ message, schema })),
      handles: (messages.handles ?? []).map((value) => ({
        channel: value.channel,
        capacity: value.capacity,
        requiredGrant: value.requiredGrant,
        schedulerAllowed: value.schedulerAllowed,
        hasHandler: typeof value.handle === "function",
      })),
      publishes: (messages.publishes ?? []).map((value) => ({
        topic: value.topic,
        capacity: value.capacity,
        requiredGrant: value.requiredGrant,
        schedulerAllowed: value.schedulerAllowed,
      })),
      subscribes: (messages.subscribes ?? []).map((value) => ({
        topic: value.topic,
        hasHandler: typeof value.handle === "function",
      })),
    },
    hasActivate: typeof module.activate === "function",
  };
}

function normalizedPluginDataTrace(trace) {
  return trace.map(({ operation, activation, scope, key, migrationId }) => ({
    operation,
    moduleId: activation.moduleId,
    ...(scope === undefined ? {} : { scope }),
    ...(key === undefined ? {} : { key }),
    ...(migrationId === undefined ? {} : { migrationId }),
  }));
}

function normalizedMessageTrace(trace) {
  return trace.map(({ operation, activation, envelope }) => ({
    operation,
    moduleId: activation.moduleId,
    envelope: {
      schemaVersion: envelope.schemaVersion,
      endpoint: envelope.endpoint,
      message: envelope.message,
      payload: envelope.payload,
    },
  }));
}

async function settleUsageActivation() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runUsageDefinition({ definition, provider, settings }) {
  const activationId = "shipctl.usage@0.0.0#artifact-parity";
  const usageTrace = [];
  const dataTrace = [];
  const messageTrace = [];
  const schedulerTrace = [];
  const changes = new testingApi.FakeUsageSourceChangeController();
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeUsageSourcesServiceProvider({ changes, trace: usageTrace }),
    testingApi.createFakePluginDataServiceProvider({
      records: [{
        ownerModuleId: "shipctl.usage",
        scope: { kind: "global" },
        key: "settings",
        schemaVersion: 1,
        value: settings,
      }],
      trace: dataTrace,
    }),
    testingApi.createFakeMessagesServiceProvider({
      registrations: [{
        activation: { moduleId: "shipctl.usage", activationId },
        grants: definition.module.requiredGrants ?? [],
        messages: definition.module.messages ?? EMPTY_MESSAGES,
      }],
      trace: messageTrace,
    }),
    testingApi.createFakeSchedulerServiceProvider({ trace: schedulerTrace }),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    { panels: {} },
    [definition],
    new Map([["shipctl.usage", activationId]]),
    semanticServices,
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.usage");
  assert.ok(context);
  await settleUsageActivation();

  const channel = definition.module.messages?.handles?.[0]?.channel;
  assert.ok(channel);
  const messageOutcome = await context.services.require(api.messagesService)
    .sendMessage.execute({ channel, payload: {} });
  assert.equal(messageOutcome.result.ok, true);
  await changes.publish([provider]);
  await settleUsageActivation();

  const presentation = {};
  for (const family of ["globalSurfaces", "sidebar", "settings"]) {
    const contribution = definition.module[family]?.[0];
    assert.ok(contribution);
    const namespace = await contribution.load();
    presentation[family] = {
      exports: Object.keys(namespace).sort(),
      defaultType: typeof namespace.default,
    };
  }

  const result = {
    catalog: usageCatalog(definition.module),
    dataTrace: normalizedPluginDataTrace(dataTrace),
    inspection: normalizedInspection(activation.inspect()),
    messageResult: messageOutcome.result,
    messageTrace: normalizedMessageTrace(messageTrace),
    presentation,
    schedulerTrace: normalizedRequestTrace(schedulerTrace),
    usageTrace: normalizedRequestTrace(usageTrace),
  };

  await activation.deactivate();
  await activation.deactivate();
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

test("architecture.usage-artifact-parity.property", async () => {
  assert.deepEqual(usageArtifact.build.sharedRuntimeViolations, []);
  assert.equal(usageArtifact.manifest.styles.length, 1);
  assert.match(usageArtifact.manifest.styles[0], /^dist\/assets\/.+\.css$/);
  assert.deepEqual(usageArtifact.manifest.assets, []);
  assert.deepEqual(usageArtifact.manifest.peerDependencies, {
    react: "^19.0.0",
  });
  assert.deepEqual(usageArtifact.manifest.requestedGrants, [
    "usage-source.read",
    "usage-source.refresh",
    "usage-source.observe",
    "plugin-data.read",
    "plugin-data.write",
    "message.send.usage.refresh-request",
    "message.publish.usage.ingest-completed",
    "message.subscribe.usage.ingest-completed",
    "schedule.register",
  ]);
  assert.deepEqual(usageArtifact.manifest.application.requiredServices, [
    { id: "shipctl.usage-sources", version: 2 },
    { id: "shipctl.plugin-data", version: 1 },
    { id: "shipctl.messages", version: 1 },
    { id: "shipctl.scheduler", version: 1 },
  ]);
  assert.deepEqual(usageArtifact.manifest.application.contributions, [
    { family: "global-surface", id: "core.usage", schemaVersion: 1 },
    { family: "global-navigation", id: "usage.global-navigation", schemaVersion: 1 },
    { family: "sidebar", id: "usage.sidebar", schemaVersion: 1 },
    { family: "settings", id: "usage.settings", schemaVersion: 1 },
    { family: "scheduled-task", id: "usage.periodic-refresh", schemaVersion: 1 },
    { family: "message-graph", id: "shipctl.usage.messages", schemaVersion: 1 },
  ]);

  const loaded = await loader.loadShipctlModuleArtifact({
    digest: usageArtifact.digest,
    entryUrl: pathToFileURL(usageArtifact.entryPath).href,
    expectedModuleId: usageArtifact.manifest.id,
    expectedVersion: usageArtifact.manifest.version,
    admittedApplication: usageArtifact.manifest.application,
    admittedMessages: usageArtifact.manifest.messages,
    admittedGrants: usageArtifact.manifest.requestedGrants,
  });
  const staticDefinition = api.defineShipctlPlugin({
    module: usageSource.usageModule,
    role: "compound",
    requires: [
      api.usageSourcesService,
      api.pluginDataService,
      api.messagesService,
      api.schedulerService,
    ],
  });
  assert.equal(loaded.definition.role, "compound");
  assert.deepEqual(usageCatalog(loaded.module), usageCatalog(usageSource.usageModule));

  await fc.assert(fc.asyncProperty(
    fc.record({
      provider: fc.constantFrom("claude", "codex", "antigravity", "gemini", "opencode", "pi"),
      show: fc.boolean(),
      budgetMode: fc.constantFrom("subscription", "custom"),
      monthlyBudget: fc.option(fc.integer({ min: 0 }), { nil: null }),
    }),
    async ({ provider, ...providerSettings }) => {
      const input = {
        provider,
        settings: {
          [provider]: providerSettings,
          preservedExtension: { owner: "fixture" },
        },
      };
      const sourceResult = await runUsageDefinition({
        definition: staticDefinition,
        ...input,
      });
      const artifactResult = await runUsageDefinition({
        definition: loaded.definition,
        ...input,
      });
      assert.deepEqual(artifactResult, sourceResult);
    },
  ), propertyParameters());
});

function applicationFor(specification) {
  return {
    schemaVersion: 1,
    role: specification.commandIds.length === 0 ? "headless" : "compound",
    requiredServices: specification.requiredIds.map((id) => ({ id, version: 1 })),
    providedServices: specification.providedIds.map((id) => ({ id, version: 1 })),
    backgroundEffects: [...specification.effectIds],
    contributions: specification.commandIds.map((id) => ({
      family: "command",
      id,
      schemaVersion: 1,
    })),
  };
}

function definitionFor(specification) {
  const moduleId = "fixture.generated-artifact";
  return api.defineShipctlPlugin({
    role: specification.commandIds.length === 0 ? "headless" : "compound",
    requires: specification.requiredIds.map((id) => api.defineSemanticService(id, 1)),
    provides: specification.providedIds.map((id) => ({
      service: api.defineSemanticService(id, 1),
      bind: () => ({}),
    })),
    backgroundEffects: specification.effectIds,
    module: {
      id: moduleId,
      version: "1.0.0",
      requiredGrants: specification.grantIds,
      commands: specification.commandIds.map((id) => ({
        id,
        moduleId,
        label: id,
        run: () => undefined,
      })),
    },
  });
}

test("architecture.manifest-runtime.property", async () => {
  const scopedIds = (prefix) => fc.uniqueArray(
    fc.integer({ min: 0 }).map((value) => `fixture.${prefix}-${value}`),
  );
  const specifications = fc.record({
    requiredIds: scopedIds("required"),
    providedIds: scopedIds("provided"),
    effectIds: scopedIds("effect"),
    commandIds: scopedIds("command"),
    grantIds: scopedIds("grant"),
  });
  const cases = fc.tuple(specifications, fc.constantFrom(
    "equal",
    "reordered",
    "service-extra",
    "effect-extra",
    "contribution-extra",
    "grant-extra",
    "message-extra",
  ));

  await fc.assert(fc.asyncProperty(cases, async ([specification, kind]) => {
    const definition = definitionFor(specification);
    const application = applicationFor(specification);
    const admitted = structuredClone(application);
    const grants = [...specification.grantIds];
    const messages = structuredClone(EMPTY_MESSAGES);
    if (kind === "reordered") {
      admitted.requiredServices.reverse();
      admitted.providedServices.reverse();
      admitted.backgroundEffects.reverse();
      admitted.contributions.reverse();
      grants.reverse();
    } else if (kind === "service-extra") {
      admitted.requiredServices.push({ id: "fixture.unexpected-service", version: 1 });
    } else if (kind === "effect-extra") {
      admitted.backgroundEffects.push("fixture.unexpected-effect");
    } else if (kind === "contribution-extra") {
      admitted.contributions.push({
        family: "command",
        id: "fixture.unexpected-command",
        schemaVersion: 1,
      });
    } else if (kind === "grant-extra") {
      grants.push("fixture.unexpected-grant");
    } else if (kind === "message-extra") {
      messages.subscribes.push({
        id: "fixture.unexpected-topic",
        message: { id: "fixture.unexpected-message", version: 1 },
      });
    }

    const request = loader.loadShipctlModuleArtifact({
      digest: "a".repeat(64),
      entryUrl: `asset://localhost/modules/${"a".repeat(64)}/plugin.mjs`,
      expectedModuleId: definition.module.id,
      expectedVersion: definition.module.version,
      admittedApplication: admitted,
      admittedMessages: messages,
      admittedGrants: grants,
      importModule: async () => ({ createShipctlPlugin: () => definition }),
    });
    if (kind === "equal" || kind === "reordered") {
      await request;
    } else {
      await assert.rejects(request, (error) => error.code === "module.loader.invalid_artifact");
    }
  }), propertyParameters());
});
