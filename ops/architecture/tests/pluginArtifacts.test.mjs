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
let runtimeLoader;
let runtimeApi;
let declarationRuntime;
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
  runtimeLoader = await vite.ssrLoadModule("/core/frontend/host/runtimeModuleLoader.ts");
  runtimeApi = await vite.ssrLoadModule(
    "/core/frontend/runtime/cordis/staticPluginRuntime.ts",
  );
  declarationRuntime = await vite.ssrLoadModule(
    "/core/frontend/runtime/pluginArtifactDeclarations.ts",
  );
  semanticRuntime = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  );
  testingApi = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts");
  commandsSource = await vite.ssrLoadModule("/modules/commands/artifact/src/index.ts");
  portsSource = await vite.ssrLoadModule("/modules/ports/artifact/src/index.ts");
  todosSource = await vite.ssrLoadModule("/modules/todos/artifact/src/index.ts");
  gitSource = await vite.ssrLoadModule("/modules/git/artifact/src/index.ts");
  skillsSource = await vite.ssrLoadModule("/modules/skills/artifact/src/index.ts");
  thinTerminalSource = await vite.ssrLoadModule(
    "/modules/thin-terminal/artifact/src/index.ts",
  );
  semanticTerminalSource = await vite.ssrLoadModule(
    "/modules/semantic-terminal/artifact/src/index.ts",
  );
  assistantsSource = await vite.ssrLoadModule(
    "/modules/assistants/artifact/src/index.ts",
  );
  usageSource = await vite.ssrLoadModule("/modules/usage/artifact/src/index.ts");
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

test("architecture.post-package-plugin-deployment.property", async () => {
  const externalArtifact = fc.record({
    moduleSuffix: fc.integer({ min: 1, max: 1_000_000 }),
    digest: fc.array(fc.constantFrom(..."0123456789abcdef"), {
      minLength: 64,
      maxLength: 64,
    }).map((characters) => characters.join("")),
    styleIndexes: fc.uniqueArray(fc.integer({ min: 0, max: 9_999 }), { maxLength: 3 }),
  });

  await fc.assert(fc.asyncProperty(externalArtifact, async ({
    moduleSuffix,
    digest,
    styleIndexes,
  }) => {
    const moduleId = `fixture.post-package-${moduleSuffix}`;
    const version = `1.0.${moduleSuffix}`;
    const entryPath = `/external/post-package/${digest}/dist/plugin-${moduleSuffix}.mjs`;
    const stylePaths = styleIndexes.map(
      (index) => `/external/post-package/${digest}/styles/style-${index}.css`,
    );
    const application = {
      schemaVersion: 1,
      role: "headless",
      requiredServices: [],
      providedServices: [],
      backgroundEffects: [],
      contributions: [],
    };
    const definition = {
      id: moduleId,
      version,
      role: "headless",
      requiredGrants: [],
      activate: () => undefined,
    };
    const resolved = [];
    const imported = [];
    const catalog = {
      schemaVersion: 1,
      registryRevision: moduleSuffix,
      modules: [{
        schemaVersion: 1,
        moduleId,
        version,
        contentDigest: digest,
        entryPath,
        stylePaths,
        manifest: {
          schemaVersion: 2,
          lifecycle: "live",
          application,
          messages: EMPTY_MESSAGES,
          requestedGrants: [],
        },
        capabilities: { definitions: [] },
      }],
    };

    const loaded = await runtimeLoader.loadRuntimeModules(catalog, {
      resolveArtifactUrl: (artifactPath, contentDigest) => {
        resolved.push({ artifactPath, contentDigest });
        return loader.moduleArtifactUrl(
          artifactPath,
          contentDigest,
          (file) => `asset://localhost/${encodeURIComponent(file)}`,
        );
      },
      importModule: async (entryUrl) => {
        imported.push(entryUrl);
        return { createShipctlPlugin: () => definition };
      },
    });

    const expectedEntryUrl = `asset://localhost/${encodeURIComponent(entryPath)}`;
    assert.deepEqual(loaded.failures, []);
    assert.equal(loaded.definitions.length, 1);
    assert.equal(loaded.definitions[0]?.id, moduleId);
    assert.deepEqual(imported, [expectedEntryUrl]);
    assert.deepEqual(resolved, [
      { artifactPath: entryPath, contentDigest: digest },
      ...stylePaths.map((artifactPath) => ({ artifactPath, contentDigest: digest })),
    ]);
    assert.deepEqual(loaded.admissionsByModule.get(moduleId)?.artifact, {
      contentDigest: digest,
      entryUrl: expectedEntryUrl,
      moduleId,
      version,
    });
  }), propertyParameters());
});

function commandsCatalog(contributions) {
  return {
    commands: contributions.commands.map(({ id, moduleId, label }) => ({ id, moduleId, label })),
    panels: contributions.panels.map((panel) => ({
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
    projectNavigation: contributions.projectNavigation.map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
  };
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

async function runCommandsDefinition({ definition, admission, projectPath }) {
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakePluginDataServiceProvider(),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    undefined,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.commands", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const contributions = activation.contributionsByModule.get("shipctl.commands");
  assert.ok(contributions);
  const panelActions = [];
  const command = contributions.commands.find(({ id }) => id === "commands.open-panel");
  assert.ok(command);
  assert.equal(command.isEnabled({ activeProjectId: projectPath }), true);
  command.run({
    activeProjectId: projectPath,
    openPanel: (panelId) => panelActions.push(panelId),
  });
  assert.ok(admission.application);
  const runtimeDeclarations = declarationRuntime.collectPluginArtifactDeclarations(
    definition,
    activation.inspect().contributions,
  );
  assert.equal(
    declarationRuntime.samePluginArtifactDeclarations(admission.application, runtimeDeclarations),
    true,
  );
  const result = {
    catalog: commandsCatalog(contributions),
    inspection: normalizedInspection(activation.inspect()),
    panelActions,
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
    assert.equal(loaded.module, undefined);
    assert.equal("module" in loaded.definition, false);
    const sourceDefinition = commandsSource.createShipctlPlugin({ pluginApi: api });
    assert.equal("module" in sourceDefinition, false);
    assert.deepEqual(
      {
        id: loaded.definition.id,
        version: loaded.definition.version,
        role: loaded.definition.role,
        requiredGrants: loaded.definition.requiredGrants,
        backgroundEffects: loaded.definition.backgroundEffects,
      },
      {
        id: sourceDefinition.id,
        version: sourceDefinition.version,
        role: sourceDefinition.role,
        requiredGrants: sourceDefinition.requiredGrants,
        backgroundEffects: sourceDefinition.backgroundEffects,
      },
    );

    await fc.assert(fc.asyncProperty(fc.integer(), async (projectKey) => {
      const result = await runCommandsDefinition({
        definition: loaded.definition,
        admission: loaded.admission,
        projectPath: `/workspace/project-${projectKey}`,
      });
      assert.deepEqual(result.catalog, {
        commands: [{
          id: "commands.open-panel",
          moduleId: "shipctl.commands",
          label: "New Commands Panel",
        }],
        panels: [{
          id: "core.commands",
          moduleId: "shipctl.commands",
          scope: "project",
          label: "Commands",
          icon: { name: "list", label: "Commands" },
          shortcut: "⇧⌘C",
          singleton: "per-project",
          order: 20,
          unavailable: {
            title: "Commands panel unavailable",
            description: "The project command runner module could not be loaded.",
          },
          migrationAlias: { kind: "commands", label: "Commands" },
        }],
        projectNavigation: [{
          id: "commands.project-navigation",
          moduleId: "shipctl.commands",
          panelId: "core.commands",
          order: 20,
        }],
      });
      assert.deepEqual(result.panelActions, ["core.commands"]);
      assert.deepEqual(
        result.inspection.contributions,
        [
          { moduleId: "shipctl.commands", family: "command", id: "commands.open-panel" },
          { moduleId: "shipctl.commands", family: "panel", id: "core.commands" },
          { moduleId: "shipctl.commands", family: "project-navigation", id: "commands.project-navigation" },
        ],
      );
      assert.deepEqual(links, [], "artifact styles must leave with their activation");
    }), propertyParameters());
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function portsCatalog(contributions) {
  return {
    globalSurfaces: contributions.globalSurfaces.map((surface) => ({
      id: surface.id,
      moduleId: surface.moduleId,
      unavailable: surface.unavailable,
    })),
    globalNavigation: contributions.globalNavigation.map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      surfaceId: navigation.surfaceId,
      label: navigation.label,
      icon: navigation.icon,
      order: navigation.order,
    })),
  };
}

async function runPortsDefinition({
  definition,
  admission,
  inspections,
  deniedOperation,
  projectPaths,
}) {
  const trace = [];
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeProcessesServiceProvider({
      inspections: () => inspections,
      deniedOperations: deniedOperation === "none" ? [] : [deniedOperation],
      trace,
    }),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    undefined,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.ports", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.ports");
  assert.ok(context);
  const contributions = activation.contributionsByModule.get("shipctl.ports");
  assert.ok(contributions);

  const surfaceModule = await contributions.globalSurfaces[0].load();
  assert.equal(typeof surfaceModule.default, "function");
  const processes = context.services.require(api.processesService);
  const scan = await surfaceModule.scanPorts(processes, projectPaths);
  const stop = scan.status === "ready" && scan.ports.length > 0
    ? await surfaceModule.stopPort(scan.ports[0], processes)
    : null;
  assert.ok(admission.application);
  const runtimeDeclarations = declarationRuntime.collectPluginArtifactDeclarations(
    definition,
    activation.inspect().contributions,
  );
  assert.equal(
    declarationRuntime.samePluginArtifactDeclarations(admission.application, runtimeDeclarations),
    true,
  );
  const result = {
    catalog: portsCatalog(contributions),
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
  assert.equal(loaded.module, undefined);
  assert.equal("module" in loaded.definition, false);
  const sourceDefinition = portsSource.createShipctlPlugin({ pluginApi: api });
  assert.equal("module" in sourceDefinition, false);
  assert.deepEqual(
    {
      id: loaded.definition.id,
      version: loaded.definition.version,
      role: loaded.definition.role,
      requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
    },
    {
      id: sourceDefinition.id,
      version: sourceDefinition.version,
      role: sourceDefinition.role,
      requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
    },
  );
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
    const sourceResult = await runPortsDefinition({
      definition: sourceDefinition,
      admission: loaded.admission,
      ...request,
    });
    const artifactResult = await runPortsDefinition({
      definition: loaded.definition,
      admission: loaded.admission,
      ...request,
    });
    assert.deepEqual(artifactResult, sourceResult);
  }), propertyParameters());
});

function todosCatalog(contributions) {
  return {
    configuration: contributions.configuration.map((configuration) => ({
      id: configuration.id,
      moduleId: configuration.moduleId,
      scope: configuration.scope,
      key: configuration.key,
      schemaVersion: configuration.schemaVersion,
      defaults: configuration.defaults,
    })),
    panels: contributions.panels.map((panel) => ({
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
    projectNavigation: contributions.projectNavigation.map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
    settings: contributions.settings.map((settings) => ({
      id: settings.id,
      moduleId: settings.moduleId,
      order: settings.order,
    })),
  };
}

async function runTodosDefinition({
  definition,
  admission,
  projectPaths,
  denied,
  styleLinks,
}) {
  const trace = [];
  const projectTrace = [];
  const projects = new testingApi.FakeProjectsChangeController(projectPaths);
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
    testingApi.createFakeProjectsServiceProvider({ changes: projects, trace: projectTrace }),
    testingApi.createFakePluginDataServiceProvider(),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    undefined,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.todos", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const contributions = activation.contributionsByModule.get("shipctl.todos");
  assert.ok(contributions);

  const loadedContributions = await Promise.all([
    contributions.panels[0].load(),
    contributions.projectNavigation[0].load(),
    contributions.settings[0].load(),
  ]);
  assert.equal(loadedContributions.every(({ default: contribution }) => (
    typeof contribution === "function"
  )), true);
  await projects.publishFilesystemChanged(projectPaths);
  await projects.setProjects(projectPaths.slice(1));
  assert.ok(admission.application);
  const runtimeDeclarations = declarationRuntime.collectPluginArtifactDeclarations(
    definition,
    activation.inspect().contributions,
  );
  assert.equal(
    declarationRuntime.samePluginArtifactDeclarations(admission.application, runtimeDeclarations),
    true,
  );
  if (styleLinks !== undefined) {
    assert.equal(styleLinks.length > 0, true, "artifact styles attach with the activation");
  }

  const inspection = normalizedInspection(activation.inspect());
  const result = {
    catalog: todosCatalog(contributions),
    inspection: {
      ...inspection,
      // Artifact style attachment is an intentionally opaque activation-owned
      // lease. Source and packaged behavior must agree on public effects.
      effects: inspection.effects.filter(({ kind }) => kind !== "owned-lease"),
    },
    trace: trace.map(({ operation, request }) => ({
      operation,
      moduleId: request.activation.moduleId,
      input: request.input,
    })),
    projectTrace: projectTrace.map(({ operation, request }) => ({
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
    assert.equal(loaded.module, undefined);
    assert.equal("module" in loaded.definition, false);
    const sourceDefinition = todosSource.createShipctlPlugin({ pluginApi: api });
    assert.equal("module" in sourceDefinition, false);
    assert.deepEqual(
      {
        id: loaded.definition.id,
        version: loaded.definition.version,
        role: loaded.definition.role,
        requiredGrants: loaded.definition.requiredGrants,
        requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
        backgroundEffects: loaded.definition.backgroundEffects,
      },
      {
        id: sourceDefinition.id,
        version: sourceDefinition.version,
        role: sourceDefinition.role,
        requiredGrants: sourceDefinition.requiredGrants,
        requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
        backgroundEffects: sourceDefinition.backgroundEffects,
      },
    );
    assert.equal(loaded.definition.role, "compound");
    assert.deepEqual(
      todosArtifact.manifest.application.requiredServices,
      [
        { id: "shipctl.plugin-data", version: 1 },
        { id: "shipctl.project-documents", version: 1 },
        { id: "shipctl.projects", version: 1 },
      ],
    );
    assert.deepEqual(todosArtifact.manifest.requestedGrants, [
      "plugin-data.read",
      "plugin-data.write",
    ]);

    await fc.assert(fc.asyncProperty(
      fc.record({
        denied: fc.boolean(),
        projectKeys: fc.uniqueArray(fc.integer(), { minLength: 1, maxLength: 4 }),
      }),
      async ({ denied, projectKeys }) => {
        const request = {
          denied,
          projectPaths: projectKeys.map((key) => `/workspace/project-${key}`),
        };
        const sourceResult = await runTodosDefinition({
          definition: sourceDefinition,
          admission: loaded.admission,
          ...request,
        });
        const artifactResult = await runTodosDefinition({
          definition: loaded.definition,
          admission: loaded.admission,
          styleLinks: links,
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

function gitCatalog(contributions) {
  return {
    configuration: contributions.configuration.map((configuration) => ({
      id: configuration.id,
      moduleId: configuration.moduleId,
      scope: configuration.scope,
      key: configuration.key,
      schemaVersion: configuration.schemaVersion,
      defaults: configuration.defaults,
    })),
    panels: contributions.panels.map((panel) => ({
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
    projectNavigation: contributions.projectNavigation.map((navigation) => ({
      id: navigation.id,
      moduleId: navigation.moduleId,
      panelId: navigation.panelId,
      order: navigation.order,
    })),
    projectLayout: contributions.projectLayouts.map(({ id, moduleId, slot, order }) => ({
      id,
      moduleId,
      slot,
      order,
    })),
    projectActions: contributions.projectActions.map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
    projectFacts: contributions.projectFacts.map(({ id, moduleId }) => ({ id, moduleId })),
    projectImports: contributions.projectImports.map(({ id, moduleId }) => ({ id, moduleId })),
    settings: contributions.settings.map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
  };
}

async function runGitDefinition({
  definition,
  admission,
  projectPath,
  branchName,
  dirty,
  denied,
  autoImportWorktrees,
  expandRelated,
  styleLinks,
}) {
  const linkedPath = `${projectPath}-linked`;
  const worktrees = [
    { projectId: projectPath, branchName, isMain: true },
    { projectId: linkedPath, branchName: `${branchName}-linked`, isMain: false },
  ];
  const trace = [];
  const projectTrace = [];
  const projects = new testingApi.FakeProjectsChangeController([projectPath, linkedPath]);
  const gitChanges = new testingApi.FakeGitChangeController();
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
      changes: gitChanges,
    }),
    testingApi.createFakeProjectsServiceProvider({ changes: projects, trace: projectTrace }),
    testingApi.createFakePluginDataServiceProvider({
      records: [{
        ownerModuleId: "shipctl.git",
        scope: { kind: "global" },
        key: "preferences",
        schemaVersion: 1,
        value: { autoImportWorktrees },
      }],
    }),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    undefined,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.git", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.git");
  assert.ok(context);
  const contributions = activation.contributionsByModule.get("shipctl.git");
  assert.ok(contributions);

  const relatedPaths = await contributions.projectImports[0].relatedPaths(
    projectPath,
    { expandRelated },
    {},
    context,
  );
  await gitChanges.publish(projectPath);
  await projects.publishFilesystemChanged([projectPath]);
  await projects.setProjects([projectPath]);
  await gitChanges.publish(linkedPath);
  const project = { id: projectPath, path: projectPath, label: projectPath };
  const facts = contributions.projectFacts[0].getFacts(project);
  assert.ok(admission.application);
  const runtimeDeclarations = declarationRuntime.collectPluginArtifactDeclarations(
    definition,
    activation.inspect().contributions,
  );
  assert.equal(
    declarationRuntime.samePluginArtifactDeclarations(admission.application, runtimeDeclarations),
    true,
  );
  if (styleLinks !== undefined) {
    assert.equal(styleLinks.length > 0, true, "artifact styles attach with the activation");
  }
  const inspection = normalizedInspection(activation.inspect());
  const result = {
    catalog: gitCatalog(contributions),
    facts,
    relatedPaths,
    inspection: {
      ...inspection,
      // Artifact style attachment is an intentionally opaque activation-owned
      // lease. Source and packaged behavior must agree on public effects.
      effects: inspection.effects.filter(({ kind }) => kind !== "owned-lease"),
    },
    trace: trace.map(({ operation, request }) => ({
      operation,
      moduleId: request.activation.moduleId,
      input: request.input,
    })),
    projectTrace: projectTrace.map(({ operation, request }) => ({
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
    assert.equal(loaded.module, undefined);
    assert.equal("module" in loaded.definition, false);
    const sourceDefinition = gitSource.createShipctlPlugin({ pluginApi: api });
    assert.equal("module" in sourceDefinition, false);
    assert.deepEqual(
      {
        id: loaded.definition.id,
        version: loaded.definition.version,
        role: loaded.definition.role,
        requiredGrants: loaded.definition.requiredGrants,
        requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
        backgroundEffects: loaded.definition.backgroundEffects,
      },
      {
        id: sourceDefinition.id,
        version: sourceDefinition.version,
        role: sourceDefinition.role,
        requiredGrants: sourceDefinition.requiredGrants,
        requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
        backgroundEffects: sourceDefinition.backgroundEffects,
      },
    );
    assert.equal(loaded.definition.role, "compound");
    assert.deepEqual(
      gitArtifact.manifest.application.requiredServices,
      [
        { id: "shipctl.git", version: 1 },
        { id: "shipctl.projects", version: 1 },
        { id: "shipctl.plugin-data", version: 1 },
      ],
    );
    assert.deepEqual(gitArtifact.manifest.requestedGrants, [
      "plugin-data.read",
      "plugin-data.write",
    ]);

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
          definition: sourceDefinition,
          admission: loaded.admission,
          ...input,
        });
        const artifactResult = await runGitDefinition({
          definition: loaded.definition,
          admission: loaded.admission,
          styleLinks: links,
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

function skillsCatalog(contributions) {
  return {
    projectActions: contributions.projectActions.map(({ id, moduleId, order }) => ({
      id,
      moduleId,
      order,
    })),
    skillsProviders: contributions.skillsProviders.map(({ id, moduleId }) => ({ id, moduleId })),
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
  admission,
  projectPaths,
  installedTodos,
  installedOrchestrate,
  deniedOperation,
  action,
}) {
  const trace = [];
  const projects = new testingApi.FakeProjectsChangeController(projectPaths);
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeSkillInstallationServiceProvider({
      projects: projectPaths.map((projectId) => ({
        projectId,
        skills: skillInspection(api, installedTodos, installedOrchestrate),
      })),
      deniedOperations: deniedOperation === "none" ? [] : [deniedOperation],
      trace,
    }),
    testingApi.createFakeProjectsServiceProvider({ changes: projects }),
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
    false,
    new Map([["shipctl.skills", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.skills");
  assert.ok(context);
  const contributions = activation.contributionsByModule.get("shipctl.skills");
  assert.ok(contributions);
  const provider = contributions.skillsProviders[0];
  const projectActions = contributions.projectActions;
  await projects.publishFilesystemChanged(projectPaths);
  const project = {
    id: projectPaths[0],
    name: projectPaths[0],
    path: projectPaths[0],
  };
  const group = projectActions[0].getGroup(project, services, context);
  let actionOutcome = "not-run";
  try {
    if (action === "provider-install-todos") {
      await provider.port.install(project.path, "shipctl-todos");
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

  assert.ok(admission.application);
  const runtimeDeclarations = declarationRuntime.collectPluginArtifactDeclarations(
    definition,
    activation.inspect().contributions,
  );
  assert.equal(
    declarationRuntime.samePluginArtifactDeclarations(admission.application, runtimeDeclarations),
    true,
  );
  const inspection = normalizedInspection(activation.inspect());
  const result = {
    actionOutcome,
    catalog: skillsCatalog(contributions),
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
    snapshot: cloneSkillsSnapshot(provider.port.getSnapshot()),
    trace: normalizedSkillTrace(trace),
  };

  await projects.setProjects([]);
  assert.deepEqual(
    cloneSkillsSnapshot(provider.port.getSnapshot()),
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
    provider.port.install(project.path, "shipctl-todos"),
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
  assert.equal(loaded.module, undefined);
  assert.equal("module" in loaded.definition, false);
  const sourceDefinition = skillsSource.createShipctlPlugin({ pluginApi: api });
  assert.equal("module" in sourceDefinition, false);
  assert.deepEqual(
    {
      id: loaded.definition.id,
      version: loaded.definition.version,
      role: loaded.definition.role,
      requiredGrants: loaded.definition.requiredGrants,
      requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
      backgroundEffects: loaded.definition.backgroundEffects,
    },
    {
      id: sourceDefinition.id,
      version: sourceDefinition.version,
      role: sourceDefinition.role,
      requiredGrants: sourceDefinition.requiredGrants,
      requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
      backgroundEffects: sourceDefinition.backgroundEffects,
    },
  );
  assert.equal(loaded.definition.role, "compound");
  assert.deepEqual(
    skillsArtifact.manifest.application.requiredServices,
    [
      { id: "shipctl.skill-installation", version: 2 },
      { id: "shipctl.projects", version: 1 },
    ],
  );
  assert.deepEqual(skillsArtifact.manifest.application.backgroundEffects, ["skills.runtime"]);

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
        definition: sourceDefinition,
        admission: loaded.admission,
        ...input,
      });
      const artifactResult = await runSkillsDefinition({
        definition: loaded.definition,
        admission: loaded.admission,
        ...input,
      });
      assert.deepEqual(artifactResult, sourceResult);
    },
  ), propertyParameters());
});

function terminalPresentationContributionCatalog(contributions) {
  return contributions.terminalPresentations.map((presentation) => ({
    moduleId: presentation.moduleId,
    driverId: presentation.driverId,
    requiredServices: presentation.requiredServices.map(({ id, version }) => ({ id, version })),
    presentationType: typeof presentation.Presentation,
  }));
}

function terminalPresentationContributionElement(contributions, props) {
  const presentation = contributions.terminalPresentations[0];
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
    assert.equal(loaded.module, undefined);
    assert.equal("module" in loaded.definition, false);
    const sourceDefinition = thinTerminalSource.createShipctlPlugin({ pluginApi: api });
    assert.equal("module" in sourceDefinition, false);
    assert.deepEqual(
      {
        id: loaded.definition.id,
        version: loaded.definition.version,
        role: loaded.definition.role,
        requiredGrants: loaded.definition.requiredGrants,
        requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
      },
      {
        id: sourceDefinition.id,
        version: sourceDefinition.version,
        role: sourceDefinition.role,
        requiredGrants: sourceDefinition.requiredGrants,
        requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
      },
    );
    assert.equal(loaded.definition.role, "presentation");

    const sourceFixture = testingApi.createFakeTerminalSessionsServiceProvider();
    const sourceActivation = await runtimeApi.activatePluginDefinitionsObserved(
      undefined,
      [sourceDefinition],
      new Map(),
      new semanticRuntime.SemanticServiceRegistry([sourceFixture.provider]),
      false,
      new Map([["shipctl.thin-terminal", loaded.admission]]),
    );
    assert.deepEqual(sourceActivation.failures, []);
    const sourceContext = sourceActivation.activationContextsByModule.get("shipctl.thin-terminal");
    const sourceContributions = sourceActivation.contributionsByModule.get("shipctl.thin-terminal");
    assert.ok(sourceContext);
    assert.ok(sourceContributions);

    const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
    const activation = await runtimeApi.activatePluginDefinitionsObserved(
      undefined,
      [loaded.definition],
      new Map(),
      new semanticRuntime.SemanticServiceRegistry([terminalFixture.provider]),
      false,
      new Map([["shipctl.thin-terminal", loaded.admission]]),
    );
    assert.deepEqual(activation.failures, []);
    assert.equal(links.length, 1);
    assert.equal(links[0].dataset.shipctlModule, "shipctl.thin-terminal");
    const context = activation.activationContextsByModule.get("shipctl.thin-terminal");
    const contributions = activation.contributionsByModule.get("shipctl.thin-terminal");
    assert.ok(context);
    assert.ok(contributions);
    assert.deepEqual(
      terminalPresentationContributionCatalog(contributions),
      terminalPresentationContributionCatalog(sourceContributions),
    );
    assert.ok(thinTerminalArtifact.manifest.application);
    for (const [definition, observed] of [
      [sourceDefinition, sourceActivation],
      [loaded.definition, activation],
    ]) {
      const declarations = declarationRuntime.collectPluginArtifactDeclarations(
        definition,
        observed.inspect().contributions,
      );
      assert.equal(
        declarationRuntime.samePluginArtifactDeclarations(
          thinTerminalArtifact.manifest.application,
          declarations,
        ),
        true,
      );
    }
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
          terminalPresentationContributionElement(contributions, props),
          terminalPresentationContributionElement(sourceContributions, {
            ...props,
            activation: sourceContext,
          }),
        );
      },
    ), propertyParameters());

    assert.deepEqual(
      activation.inspect().contributions.map(({ family, id }) => ({ family, id })),
      [{ family: "terminal-presentation", id: "thin-terminal" }],
    );
    await sourceActivation.deactivate();
    await sourceActivation.deactivate();
    assert.deepEqual(sourceActivation.inspect().contributions, []);
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
    assert.equal(loaded.module, undefined);
    assert.equal("module" in loaded.definition, false);
    const sourceDefinition = semanticTerminalSource.createShipctlPlugin({ pluginApi: api });
    assert.equal("module" in sourceDefinition, false);
    assert.deepEqual(
      {
        id: loaded.definition.id,
        version: loaded.definition.version,
        role: loaded.definition.role,
        requiredGrants: loaded.definition.requiredGrants,
        requires: loaded.definition.requires?.map(({ id, version }) => ({ id, version })),
      },
      {
        id: sourceDefinition.id,
        version: sourceDefinition.version,
        role: sourceDefinition.role,
        requiredGrants: sourceDefinition.requiredGrants,
        requires: sourceDefinition.requires?.map(({ id, version }) => ({ id, version })),
      },
    );
    assert.equal(loaded.definition.role, "presentation");

    const sourceTerminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
    const sourceSemanticTerminalFixture =
      testingApi.createFakeSemanticTerminalsServiceProvider();
    const sourceActivation = await runtimeApi.activatePluginDefinitionsObserved(
      undefined,
      [sourceDefinition],
      new Map(),
      new semanticRuntime.SemanticServiceRegistry([
        sourceTerminalFixture.provider,
        sourceSemanticTerminalFixture.provider,
      ]),
      false,
      new Map([["shipctl.semantic-terminal", loaded.admission]]),
    );
    assert.deepEqual(sourceActivation.failures, []);
    const sourceContext = sourceActivation.activationContextsByModule.get("shipctl.semantic-terminal");
    const sourceContributions = sourceActivation.contributionsByModule.get("shipctl.semantic-terminal");
    assert.ok(sourceContext);
    assert.ok(sourceContributions);

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
      false,
      new Map([["shipctl.semantic-terminal", loaded.admission]]),
    );
    assert.deepEqual(activation.failures, []);
    assert.equal(links.length, 1);
    assert.equal(links[0].dataset.shipctlModule, "shipctl.semantic-terminal");
    const context = activation.activationContextsByModule.get("shipctl.semantic-terminal");
    const contributions = activation.contributionsByModule.get("shipctl.semantic-terminal");
    assert.ok(context);
    assert.ok(contributions);
    assert.deepEqual(
      terminalPresentationContributionCatalog(contributions),
      terminalPresentationContributionCatalog(sourceContributions),
    );
    assert.ok(semanticTerminalArtifact.manifest.application);
    for (const [definition, observed] of [
      [sourceDefinition, sourceActivation],
      [loaded.definition, activation],
    ]) {
      const declarations = declarationRuntime.collectPluginArtifactDeclarations(
        definition,
        observed.inspect().contributions,
      );
      assert.equal(
        declarationRuntime.samePluginArtifactDeclarations(
          semanticTerminalArtifact.manifest.application,
          declarations,
        ),
        true,
      );
    }
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
          terminalPresentationContributionElement(contributions, props),
          terminalPresentationContributionElement(sourceContributions, {
            ...props,
            activation: sourceContext,
          }),
        );
      },
    ), propertyParameters());

    assert.deepEqual(
      activation.inspect().contributions.map(({ family, id }) => ({ family, id })),
      [{ family: "terminal-presentation", id: "semantic-terminal" }],
    );
    await sourceActivation.deactivate();
    await sourceActivation.deactivate();
    assert.deepEqual(sourceActivation.inspect().contributions, []);
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

function assistantsCatalog(definition, contributions) {
  return {
    id: definition.id,
    version: definition.version,
    requiredGrants: [...definition.requiredGrants ?? []],
    requires: (definition.requires ?? []).map(({ id, version }) => ({ id, version })),
    backgroundEffects: [...definition.backgroundEffects ?? []],
    panels: contributions.panels.map((panel) => ({
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
    hasActivate: typeof definition.activate === "function",
    hasBeforeShutdown: typeof definition.beforeShutdown === "function",
  };
}

function assistantsHostServices() {
  const trace = [];
  return {
    trace,
    services: {
      notices: {
        push: (notice) => trace.push(["notice", notice.tone, notice.title, notice.message]),
      },
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
  admission,
  commandAvailable,
  configuredCredential,
  provider,
}) {
  const assistantTrace = [];
  const credentialTrace = [];
  const processTrace = [];
  const terminalTrace = [];
  const projectTrace = [];
  const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider({
    traces: terminalTrace,
  });
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeAssistantLaunchServiceProvider({
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
    testingApi.createFakeProjectsServiceProvider({ trace: projectTrace }),
  ]);
  const host = assistantsHostServices();
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    host.services,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.assistants", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const context = activation.activationContextsByModule.get("shipctl.assistants");
  assert.ok(context);

  const contributions = activation.contributionsByModule.get("shipctl.assistants");
  assert.ok(contributions);
  const panelNamespace = await contributions.panels[0].load();
  const processOutcome = await context.services.require(api.processesService)
    .inspectCommand.execute({ command: provider });
  const credentialOutcome = await context.services.require(api.credentialStoreService)
    .hasCredential.execute({ credentialId: api.credentialId("pi.api-key", provider) });
  const terminalOutcome = await context.services.require(api.terminalSessionsService)
    .inspectSessions.execute({ owner: "activation" });
  await activation.beforeShutdown();

  const result = {
    assistantTrace: normalizedRequestTrace(assistantTrace),
    catalog: assistantsCatalog(definition, contributions),
    credentialResult: credentialOutcome.result,
    credentialTrace: normalizedCredentialTrace(credentialTrace),
    inspection: normalizedInspection(activation.inspect()),
    panelExports: Object.keys(panelNamespace).sort(),
    panelType: typeof panelNamespace.default,
    processResult: processOutcome.result,
    processTrace: normalizedRequestTrace(processTrace),
    projectTrace: normalizedRequestTrace(projectTrace),
    terminalResult: terminalOutcome.result,
    terminalTrace: normalizedRequestTrace(terminalTrace),
  };

  await activation.deactivate();
  await activation.deactivate();
  assert.deepEqual(host.trace, []);
  const disposed = activation.inspect();
  assert.deepEqual(disposed.contributions, []);
  assert.deepEqual(disposed.effects, []);
  assert.deepEqual(disposed.services, []);
  assert.equal(disposed.activations[0].status, "disposed");
  return result;
}

async function runAssistantsRestoreOnce(definition, admission) {
  const assistantTrace = [];
  const terminalFixture = testingApi.createFakeTerminalSessionsServiceProvider();
  const projects = new testingApi.FakeProjectsChangeController(["/workspace/restore-project"]);
  const semanticServices = new semanticRuntime.SemanticServiceRegistry([
    testingApi.createFakeAssistantLaunchServiceProvider({
      startupWarning: "Fixture restore warning",
      trace: assistantTrace,
    }),
    testingApi.createFakeCredentialStoreServiceProvider(),
    testingApi.createFakeProcessesServiceProvider(),
    terminalFixture.provider,
    testingApi.createFakeProjectsServiceProvider({ changes: projects }),
  ]);
  const host = assistantsHostServices();
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    host.services,
    [definition],
    new Map(),
    semanticServices,
    false,
    new Map([["shipctl.assistants", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const result = {
    assistantTrace: normalizedRequestTrace(assistantTrace),
    hostTrace: host.trace.filter((entry) => Array.isArray(entry)),
  };
  await activation.deactivate();
  assert.deepEqual(activation.inspect().contributions, []);
  assert.deepEqual(activation.inspect().effects, []);
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
    "assistant.resource.read",
    "assistant.resource.write",
    "assistant.resource.execute",
    "credential.inspect",
    "credential.write",
    "terminal.start",
    "terminal.attach",
  ]);
  assert.deepEqual(assistantsArtifact.manifest.application.requiredServices, [
    { id: "shipctl.assistant-launch", version: 2 },
    { id: "shipctl.credential-store", version: 1 },
    { id: "shipctl.processes", version: 1 },
    { id: "shipctl.terminal-sessions", version: 1 },
    { id: "shipctl.projects", version: 1 },
  ]);
  assert.deepEqual(assistantsArtifact.manifest.application.backgroundEffects, [
    "assistants.runtime",
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
  const sourceDefinition = assistantsSource.createShipctlPlugin({ pluginApi: api });
  assert.equal(loaded.module, undefined);
  assert.equal(sourceDefinition.id, "shipctl.assistants");
  assert.deepEqual(sourceDefinition.requiredGrants, assistantsArtifact.manifest.requestedGrants);
  assert.deepEqual(
    sourceDefinition.requires.map(({ id, version }) => ({ id, version })),
    assistantsArtifact.manifest.application.requiredServices,
  );
  assert.deepEqual(sourceDefinition.backgroundEffects, ["assistants.runtime"]);
  assert.equal(loaded.definition.role, "compound");
  assert.deepEqual(
    await runAssistantsRestoreOnce(loaded.definition, loaded.admission),
    await runAssistantsRestoreOnce(sourceDefinition, loaded.admission),
  );

  await fc.assert(fc.asyncProperty(
    fc.record({
      commandAvailable: fc.boolean(),
      configuredCredential: fc.boolean(),
      provider: fc.constantFrom("claude", "codex", "antigravity", "opencode", "pi"),
    }),
    async (input) => {
      const sourceResult = await runAssistantsDefinition({
        definition: sourceDefinition,
        admission: loaded.admission,
        ...input,
      });
      const artifactResult = await runAssistantsDefinition({
        definition: loaded.definition,
        admission: loaded.admission,
        ...input,
      });
      assert.deepEqual(artifactResult, sourceResult);
    },
  ), propertyParameters());
});

function usageCatalog(definition, contributions) {
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
  const messages = contributions.messages[0] ?? EMPTY_MESSAGES;
  return {
    id: definition.id,
    version: definition.version,
    requiredGrants: [...definition.requiredGrants ?? []],
    requires: (definition.requires ?? []).map(({ id, version }) => ({ id, version })),
    backgroundEffects: [...definition.backgroundEffects ?? []],
    globalSurfaces: presentation(contributions.globalSurfaces),
    globalNavigation: presentation(contributions.globalNavigation),
    sidebar: presentation(contributions.sidebars),
    settings: presentation(contributions.settings),
    scheduledTasks: contributions.scheduledTasks.map(({ id, moduleId, schedule }) => ({
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
    hasActivate: typeof definition.activate === "function",
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

async function settleUsageActivation() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runUsageDefinition({ definition, admission, provider, settings }) {
  const activationId = "shipctl.usage@0.0.0#artifact-parity";
  const usageTrace = [];
  const dataTrace = [];
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
        grants: definition.requiredGrants ?? [],
        messages: EMPTY_MESSAGES,
      }],
    }),
    testingApi.createFakeSchedulerServiceProvider({ trace: schedulerTrace }),
  ]);
  const activation = await runtimeApi.activatePluginDefinitionsObserved(
    { panels: {} },
    [definition],
    new Map([["shipctl.usage", activationId]]),
    semanticServices,
    false,
    new Map([["shipctl.usage", admission]]),
  );
  assert.deepEqual(activation.failures, []);
  const contributions = activation.contributionsByModule.get("shipctl.usage");
  assert.ok(contributions);
  assert.equal(contributions.messages.length, 1);
  await settleUsageActivation();

  const messages = contributions.messages[0];
  const channel = messages?.handles?.[0]?.channel;
  assert.ok(channel);
  const scheduledTask = contributions.scheduledTasks[0];
  assert.ok(scheduledTask);
  assert.equal(scheduledTask.schedule.target.kind, "channel");
  assert.equal(scheduledTask.schedule.target.endpoint.id, channel.id);
  await messages.handles[0].handle(scheduledTask.schedule.payload);
  await changes.publish([provider]);
  await settleUsageActivation();

  const presentation = {};
  for (const [key, family] of [
    ["globalSurfaces", "globalSurfaces"],
    ["sidebar", "sidebars"],
    ["settings", "settings"],
  ]) {
    const contribution = contributions[family]?.[0];
    assert.ok(contribution);
    const namespace = await contribution.load();
    presentation[key] = {
      exports: Object.keys(namespace).sort(),
      defaultType: typeof namespace.default,
    };
  }

  const result = {
    catalog: usageCatalog(definition, contributions),
    dataTrace: normalizedPluginDataTrace(dataTrace),
    inspection: normalizedInspection(activation.inspect()),
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
    { id: "shipctl.usage-sources", version: 3 },
    { id: "shipctl.plugin-data", version: 1 },
    { id: "shipctl.messages", version: 1 },
    { id: "shipctl.scheduler", version: 1 },
  ]);
  assert.deepEqual(usageArtifact.manifest.application.backgroundEffects, ["usage.runtime"]);
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
  const sourceDefinition = usageSource.createShipctlPlugin({ pluginApi: api });
  assert.equal(loaded.module, undefined);
  assert.equal("module" in loaded.definition, false);
  assert.equal("module" in sourceDefinition, false);
  assert.equal(sourceDefinition.id, "shipctl.usage");
  assert.deepEqual(sourceDefinition.requiredGrants, usageArtifact.manifest.requestedGrants);
  assert.deepEqual(
    sourceDefinition.requires.map(({ id, version }) => ({ id, version })),
    usageArtifact.manifest.application.requiredServices,
  );
  assert.deepEqual(sourceDefinition.backgroundEffects, ["usage.runtime"]);
  assert.equal(loaded.definition.role, "compound");

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
        definition: sourceDefinition,
        admission: loaded.admission,
        ...input,
      });
      const artifactResult = await runUsageDefinition({
        definition: loaded.definition,
        admission: loaded.admission,
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
