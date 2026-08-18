#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repositoryIdentity } from "./property-evidence.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function requireFile(file, label) {
  assert.equal((await stat(file)).isFile(), true, `${label} is not a file: ${file}`);
}

async function run(command, args, options = {}) {
  const result = await exec(command, args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  process.stderr.write(result.stderr);
  return result.stdout;
}

async function runJson(command, args, options = {}) {
  const stdout = await run(command, args, options);
  const value = JSON.parse(stdout);
  assert.ok(
    value.status === "success" || value.status === "no_op",
    `${value.operation} did not succeed: ${value.status}`,
  );
  return value;
}

async function runOutcomeJson(command, args, options = {}) {
  try {
    return JSON.parse(await run(command, args, options));
  } catch (error) {
    if (typeof error?.stdout !== "string" || error.stdout.length === 0) throw error;
    return JSON.parse(error.stdout);
  }
}

function targetArgs(instanceName, runtimeRoot) {
  return ["--instance", instanceName, "--runtime-root", runtimeRoot, "--output", "json", "--full"];
}

async function currentInstance(cli, environment, instanceName, runtimeRoot) {
  const report = await runJson(cli, [
    "instances",
    "list",
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
  ], { env: environment });
  const instance = report.data.instances.find(({ name }) => name === instanceName);
  assert.ok(instance, `Running instance ${instanceName} disappeared`);
  return instance;
}

async function waitForInstanceAbsent(cli, environment, instanceName, runtimeRoot) {
  for (;;) {
    const report = await runJson(cli, [
      "instances",
      "list",
      "--runtime-root",
      runtimeRoot,
      "--output",
      "json",
    ], { env: environment });
    if (!report.data.instances.some(({ name }) => name === instanceName)) return;
  }
}

async function createTerminal(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  projectPath,
  driverId,
) {
  const spawned = await runJson(cli, [
    "terminals",
    "spawn",
    "--driver",
    driverId,
    "--project",
    projectPath,
    "--columns",
    "80",
    "--rows",
    "24",
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(spawned.data.driverId, driverId);
  return spawned.data.id;
}

async function terminalGet(cli, environment, instanceName, runtimeRoot, terminalId) {
  return (await runJson(cli, [
    "terminals",
    "get",
    terminalId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment })).data;
}

async function writeCanary(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  terminalId,
  canary,
) {
  const before = await terminalGet(cli, environment, instanceName, runtimeRoot, terminalId);
  const source = `printf '${canary}\\n'\n`;
  const written = await runJson(cli, [
    "terminals",
    "write",
    terminalId,
    ...targetArgs(instanceName, runtimeRoot),
    "--data",
    source,
  ], { env: environment });
  assert.equal(written.data.acceptedBytes, Buffer.byteLength(source));
  for (;;) {
    const after = await terminalGet(cli, environment, instanceName, runtimeRoot, terminalId);
    if (after.revision > before.revision && after.lastOutputAtMs !== before.lastOutputAtMs) {
      return { before, after, acceptedBytes: written.data.acceptedBytes };
    }
  }
}

async function waitForAppliedRevision(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  targetRevision,
) {
  for (;;) {
    const instance = await currentInstance(cli, environment, instanceName, runtimeRoot);
    const status = instance.moduleControl;
    if (status.registryRevision === targetRevision
      && status.observedRegistryRevision === targetRevision
      && status.revisionLag === 0) {
      return instance;
    }
    const diagnosed = await runOutcomeJson(cli, [
      "instances",
      "diagnose",
      "--instance",
      instanceName,
      "--runtime-root",
      runtimeRoot,
      "--output",
      "json",
    ], { env: environment });
    const rejection = diagnosed.data?.diagnostics?.find((diagnostic) => (
      diagnostic.code === "module.runtime.reconciliation_failed"
      && diagnostic.evidence?.fields?.registryRevision === String(targetRevision)
    ));
    if (rejection) {
      throw new Error(
        `Runtime revision ${targetRevision} was rejected: ${rejection.summary}`,
      );
    }
  }
}

async function inspectActiveModule(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  moduleId,
) {
  const report = await runJson(cli, [
    "modules",
    "inspect",
    moduleId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(report.data.manifest.runtimeKind, "frontend_esm");
  assert.equal(report.data.desired.enabled, true);
  assert.ok(
    report.data.observed.some(({ lifecycle, moduleInstanceId }) => (
      lifecycle === "active" && typeof moduleInstanceId === "string"
    )),
    `${moduleId} did not publish an active artifact observation`,
  );
  return report.data;
}

async function inspectRemovedModule(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  moduleId,
) {
  const report = await runOutcomeJson(cli, [
    "modules",
    "inspect",
    moduleId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(report.status, "error");
  assert.equal(report.code, "module.registry.desired_state.absent");
  return report;
}

function stableTerminalIdentity(descriptor) {
  return {
    id: descriptor.id,
    driverId: descriptor.driverId,
    lifecycle: descriptor.lifecycle,
    metadata: descriptor.metadata,
  };
}

assert.equal(process.platform, "darwin", "The packaged application proof requires macOS");

const app = path.resolve(
  repositoryRoot,
  option("--app") ?? "target/debug/bundle/macos/shipctl.app",
);
const cli = path.resolve(
  repositoryRoot,
  option("--shipctl") ?? path.join(app, "Contents/MacOS/shipctl"),
);
const ui = path.join(app, "Contents/MacOS/shipctl-ui");
await requireFile(cli, "Bundled Shipctl CLI");
await requireFile(ui, "Bundled Shipctl UI");

const testRoot = await mkdtemp(path.join(os.tmpdir(), "shipctl-phase-f-package-"));
const home = path.join(testRoot, "home");
const stateRoot = path.join(testRoot, "state");
const runtimeRoot = path.join(testRoot, "runtime");
const repository = path.join(testRoot, "repo");
const headlessArchive = path.join(testRoot, "headless-service.tar");
const compoundArchive = path.join(testRoot, "compound-service.tar");
const instanceName = `phase-f-package-${path.basename(testRoot)}`;
const environment = { ...process.env, HOME: home };
let thinTerminalId;
let semanticTerminalId;

try {
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(repository, { recursive: true }),
  ]);
  await run("git", ["init", "-q", repository]);
  const canonicalRepository = await realpath(repository);
  await writeFile(path.join(stateRoot, "config.yml"), `version: 1
repos:
  - path: ${repository}
groups: []
projects:
  autoImportWorktrees: true
  showAgentSessionsInSidebar: true
editor:
  preferredEditor: null
keybindings:
  shiftEnterNewline: true
  optionDeleteWord: true
  cmdKClear: true
terminal:
  cursorStyle: block
  cursorBlink: true
  scrollbackBytes: 16777216
  fontFamily: MesloLGS NF
  fontSize: 14
  urlAllowlist: [http, https]
  confirmUnsafePaste: false
sidebar:
  fontSize: 13
  fontFamily: SF Pro Display, IBM Plex Sans, Segoe UI, sans-serif
  width: 288
ui:
  canvas: legacy
`);
  await writeFile(
    path.join(stateRoot, "ui-state.json"),
    `${JSON.stringify({ lastRepoPath: repository, themeId: null, customTheme: null })}\n`,
  );
  await run(process.execPath, [
    "ops/architecture/bin/build-plugin-artifact.mjs",
    "--to",
    headlessArchive,
    "--shipctl",
    cli,
  ], { env: environment });
  await run(process.execPath, [
    "ops/architecture/bin/build-plugin-artifact.mjs",
    "--source",
    "ops/architecture/fixtures/plugin-artifacts/compound-service",
    "--to",
    compoundArchive,
    "--shipctl",
    cli,
  ], { env: environment });

  const started = await runJson(cli, [
    "ui",
    "start",
    "--instance",
    instanceName,
    "--state-root",
    stateRoot,
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  const initialInstance = started.data;
  await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    initialInstance.moduleControl.registryRevision,
  );
  const bundledModules = Object.fromEntries(await Promise.all(
    [
      "shipctl.assistants",
      "shipctl.commands",
      "shipctl.git",
      "shipctl.ports",
      "shipctl.semantic-terminal",
      "shipctl.skills",
      "shipctl.thin-terminal",
      "shipctl.todos",
      "shipctl.usage",
    ].map(async (moduleId) => [
      moduleId,
      await inspectActiveModule(
        cli,
        environment,
        instanceName,
        runtimeRoot,
        moduleId,
      ),
    ]),
  ));
  assert.deepEqual(
    bundledModules["shipctl.assistants"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    ["panel:assistants.launcher"],
  );
  assert.deepEqual(
    bundledModules["shipctl.git"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "panel:core.git",
      "project_action:git.project-actions",
      "project_facts_provider:git.project-facts",
      "project_import:git.related-projects",
      "project_layout:git.diff-summary",
      "project_navigation:git.project-navigation",
      "settings:git.settings",
    ],
  );
  assert.deepEqual(
    bundledModules["shipctl.commands"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "panel:core.commands",
      "project_navigation:commands.project-navigation",
    ],
  );
  assert.deepEqual(
    bundledModules["shipctl.ports"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "global_navigation:ports.global-navigation",
      "global_surface:ports.overview",
    ],
  );
  assert.deepEqual(
    bundledModules["shipctl.semantic-terminal"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    ["terminal_presentation:semantic-terminal"],
  );
  assert.deepEqual(
    bundledModules["shipctl.skills"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "project_action:skills.project-actions",
      "skills_provider:skills.provider",
    ],
  );
  assert.deepEqual(
    bundledModules["shipctl.thin-terminal"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    ["terminal_presentation:thin-terminal"],
  );
  assert.deepEqual(
    bundledModules["shipctl.todos"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "panel:todos.board",
      "project_navigation:todos.project-navigation",
      "settings:todos.settings",
    ],
  );
  assert.deepEqual(
    bundledModules["shipctl.usage"].contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [
      "global_navigation:usage.global-navigation",
      "global_surface:core.usage",
      "message_contract:usage.ingest-completed",
      "message_contract:usage.refresh-request",
      "message_handler:usage.refresh-request",
      "message_publisher:usage.ingest-completed",
      "message_subscription:usage.ingest-completed",
      "scheduled_task:usage.periodic-refresh",
      "settings:usage.settings",
      "sidebar:usage.sidebar",
    ],
  );
  thinTerminalId = await createTerminal(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    canonicalRepository,
    "thin-terminal",
  );
  const initialTerminal = await terminalGet(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
  );
  assert.equal(initialTerminal.lifecycle, "running");
  assert.equal(initialTerminal.driverId, "thin-terminal");
  assert.equal(initialTerminal.metadata.cwd, canonicalRepository);
  const beforeTransition = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_BEFORE__",
  );
  semanticTerminalId = await createTerminal(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    canonicalRepository,
    "semantic-terminal",
  );
  const initialSemanticTerminal = await terminalGet(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
  );
  assert.equal(initialSemanticTerminal.lifecycle, "running");
  assert.equal(initialSemanticTerminal.driverId, "semantic-terminal");
  assert.equal(initialSemanticTerminal.metadata.cwd, canonicalRepository);
  const semanticBeforeTransition = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_BEFORE__",
  );

  // This unique artifact is installed only after the packaged app has started.
  // It proves that the product admits and activates a React/CSS compound
  // module through the external path, rather than merely re-selecting a
  // byte-identical bundled artifact.
  const compoundAdded = await runJson(cli, [
    "modules",
    "add",
    "--offline",
    compoundArchive,
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  const compoundManifest = compoundAdded.data.artifact.canonical.manifest;
  assert.equal(compoundManifest.application.role, "compound");
  assert.ok(compoundManifest.styles.length > 0, "Compound artifact must carry CSS");
  assert.ok(
    compoundManifest.assets.includes("assets/compound-proof.txt"),
    "Compound artifact must carry its declared supplemental asset",
  );
  assert.ok(
    compoundManifest.assets.includes("schemas/compound-proof.schema.json"),
    "Compound artifact must carry its declared supplemental schema",
  );
  assert.deepEqual(compoundManifest.application.contributions, [{
    family: "global-surface",
    id: "fixture.compound-service.surface",
    schemaVersion: 1,
  }]);
  const compoundAddRevision = compoundAdded.data.receipt.registryRevision;
  assert.equal(compoundAddRevision, initialInstance.moduleControl.registryRevision + 1);
  await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    compoundAddRevision,
  );
  const compoundDigest = compoundAdded.data.receipt.artifact.contentDigest;
  const compoundEnableRevision = compoundAddRevision + 1;
  const compoundEnabled = await runJson(cli, [
    "modules",
    "enable",
    "fixture.compound-service",
    "--target-revision",
    String(compoundEnableRevision),
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  const compoundInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    compoundEnableRevision,
  );
  const compoundOperation = await runJson(cli, [
    "operations",
    "inspect",
    compoundEnabled.data.requestId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(compoundOperation.data.result, "succeeded");
  const activeCompound = await inspectActiveModule(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    "fixture.compound-service",
  );
  assert.equal(activeCompound.manifest.contentDigest, compoundDigest);
  assert.deepEqual(
    activeCompound.contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    ["global_surface:fixture.compound-service.surface"],
  );
  const afterCompoundEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_COMPOUND_ENABLE__",
  );
  const semanticAfterCompoundEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_COMPOUND_ENABLE__",
  );

  const added = await runJson(cli, [
    "modules",
    "add",
    "--offline",
    headlessArchive,
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  const addRevision = added.data.receipt.registryRevision;
  assert.equal(addRevision, compoundEnableRevision + 1);
  await waitForAppliedRevision(cli, environment, instanceName, runtimeRoot, addRevision);

  const enableRevision = addRevision + 1;
  const enabled = await runJson(cli, [
    "modules",
    "enable",
    "fixture.headless-service",
    "--target-revision",
    String(enableRevision),
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  const enabledInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    enableRevision,
  );
  const enableOperation = await runJson(cli, [
    "operations",
    "inspect",
    enabled.data.requestId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(enableOperation.data.result, "succeeded");
  const activeHeadless = await inspectActiveModule(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    "fixture.headless-service",
  );
  assert.equal(
    activeHeadless.manifest.contentDigest,
    added.data.receipt.artifact.contentDigest,
  );
  const afterHeadlessEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_HEADLESS_ENABLE__",
  );
  const semanticAfterHeadlessEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_HEADLESS_ENABLE__",
  );

  const removeRevision = enableRevision + 1;
  const removed = await runJson(cli, [
    "modules",
    "remove",
    "fixture.headless-service",
    "--target-revision",
    String(removeRevision),
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  const removedInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    removeRevision,
  );
  const removeOperation = await runJson(cli, [
    "operations",
    "inspect",
    removed.data.requestId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(removeOperation.data.result, "succeeded");
  const afterHeadlessRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_HEADLESS_REMOVE__",
  );
  const semanticAfterHeadlessRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_HEADLESS_REMOVE__",
  );
  const compoundRemoveRevision = removeRevision + 1;
  const compoundRemoved = await runJson(cli, [
    "modules",
    "remove",
    "fixture.compound-service",
    "--target-revision",
    String(compoundRemoveRevision),
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  const compoundRemovedInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    compoundRemoveRevision,
  );
  const compoundRemoveOperation = await runJson(cli, [
    "operations",
    "inspect",
    compoundRemoved.data.requestId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  assert.equal(compoundRemoveOperation.data.result, "succeeded");
  const removedCompound = await inspectRemovedModule(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    "fixture.compound-service",
  );
  const afterCompoundRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_COMPOUND_REMOVE__",
  );
  const semanticAfterCompoundRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_COMPOUND_REMOVE__",
  );
  const finalTerminal = afterCompoundRemove.after;
  const finalSemanticTerminal = semanticAfterCompoundRemove.after;

  assert.deepEqual(
    stableTerminalIdentity(finalTerminal),
    stableTerminalIdentity(initialTerminal),
  );
  assert.deepEqual(
    stableTerminalIdentity(finalSemanticTerminal),
    stableTerminalIdentity(initialSemanticTerminal),
  );
  assert.equal(enabledInstance.instanceId, initialInstance.instanceId);
  assert.equal(removedInstance.instanceId, initialInstance.instanceId);
  assert.equal(compoundInstance.instanceId, initialInstance.instanceId);
  assert.equal(compoundRemovedInstance.instanceId, initialInstance.instanceId);
  assert.equal(enabledInstance.processId, initialInstance.processId);
  assert.equal(removedInstance.processId, initialInstance.processId);
  assert.equal(compoundInstance.processId, initialInstance.processId);
  assert.equal(compoundRemovedInstance.processId, initialInstance.processId);

  await runJson(cli, [
    "terminals",
    "close",
    thinTerminalId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  thinTerminalId = undefined;
  await runJson(cli, [
    "terminals",
    "close",
    semanticTerminalId,
    ...targetArgs(instanceName, runtimeRoot),
  ], { env: environment });
  semanticTerminalId = undefined;
  await runJson(cli, [
    "instances",
    "stop",
    "--instance",
    instanceName,
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
  ], { env: environment });
  await waitForInstanceAbsent(cli, environment, instanceName, runtimeRoot);

  const restarted = await runJson(cli, [
    "ui",
    "start",
    "--instance",
    instanceName,
    "--state-root",
    stateRoot,
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  const restartedInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    compoundRemoveRevision,
  );
  assert.notEqual(restartedInstance.instanceId, initialInstance.instanceId);
  assert.equal(restartedInstance.processId, restarted.data.processId);
  const restartedCommands = await inspectActiveModule(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    "shipctl.commands",
  );
  assert.equal(
    restartedCommands.manifest.contentDigest,
    bundledModules["shipctl.commands"].manifest.contentDigest,
  );
  const headlessRestartInspection = await runJson(cli, [
    "modules",
    "inspect",
    "fixture.headless-service",
    "--offline",
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  assert.equal(headlessRestartInspection.data.registryRevision, compoundRemoveRevision);
  assert.equal(headlessRestartInspection.data.runtimeAvailable, false);
  assert.equal(headlessRestartInspection.data.callable, false);
  assert.equal(headlessRestartInspection.data.desired.enabled, false);
  assert.equal(headlessRestartInspection.data.desired.selectedArtifact, null);
  const compoundRestartInspection = await runJson(cli, [
    "modules",
    "inspect",
    "fixture.compound-service",
    "--offline",
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  assert.equal(compoundRestartInspection.data.registryRevision, compoundRemoveRevision);
  assert.equal(compoundRestartInspection.data.runtimeAvailable, false);
  assert.equal(compoundRestartInspection.data.callable, false);
  assert.equal(compoundRestartInspection.data.desired.enabled, false);
  assert.equal(compoundRestartInspection.data.desired.selectedArtifact, null);

  const evidence = {
    schemaVersion: 1,
    operation: "architecture.live_reconciliation.package_proof",
    status: "pass",
    repository: await repositoryIdentity(repositoryRoot),
    package: {
      app,
      cli,
      appVersion: initialInstance.build.appVersion,
      bundledModules,
    },
    instance: {
      instanceId: initialInstance.instanceId,
      processId: initialInstance.processId,
      initialRevision: initialInstance.moduleControl.registryRevision,
      compoundAddRevision,
      compoundEnableRevision,
      addRevision,
      enableRevision,
      removeRevision,
      compoundRemoveRevision,
      restart: {
        instanceId: restartedInstance.instanceId,
        processId: restartedInstance.processId,
        registryRevision: restartedInstance.moduleControl.registryRevision,
        observedRegistryRevision:
          restartedInstance.moduleControl.observedRegistryRevision,
        revisionLag: restartedInstance.moduleControl.revisionLag,
      },
    },
    thinTerminal: {
      identity: stableTerminalIdentity(initialTerminal),
      writes: {
        beforeTransition,
        afterCompoundEnable,
        afterHeadlessEnable,
        afterHeadlessRemove,
        afterCompoundRemove,
      },
    },
    semanticTerminal: {
      identity: stableTerminalIdentity(initialSemanticTerminal),
      writes: {
        beforeTransition: semanticBeforeTransition,
        afterCompoundEnable: semanticAfterCompoundEnable,
        afterHeadlessEnable: semanticAfterHeadlessEnable,
        afterHeadlessRemove: semanticAfterHeadlessRemove,
        afterCompoundRemove: semanticAfterCompoundRemove,
      },
    },
    operations: {
      compoundEnable: compoundOperation.data,
      enable: enableOperation.data,
      remove: removeOperation.data,
      compoundRemove: compoundRemoveOperation.data,
    },
    compoundArtifact: {
      identity: compoundAdded.data.receipt.artifact,
      manifest: compoundManifest,
      activated: {
        instanceId: compoundInstance.instanceId,
        processId: compoundInstance.processId,
        module: activeCompound,
      },
      removed: removedCompound,
      restart: compoundRestartInspection.data,
    },
    headlessArtifact: {
      identity: added.data.receipt.artifact,
      activated: activeHeadless,
      restart: headlessRestartInspection.data,
    },
  };
  const evidenceFile = path.join(
    repositoryRoot,
    "target/architecture-evidence/live-reconciliation/package-proof.json",
  );
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceFile, evidence }, null, 2)}\n`);
} finally {
  if (thinTerminalId !== undefined) {
    await runJson(cli, [
      "terminals",
      "close",
      thinTerminalId,
      ...targetArgs(instanceName, runtimeRoot),
    ], { env: environment }).catch(() => undefined);
  }
  if (semanticTerminalId !== undefined) {
    await runJson(cli, [
      "terminals",
      "close",
      semanticTerminalId,
      ...targetArgs(instanceName, runtimeRoot),
    ], { env: environment }).catch(() => undefined);
  }
  await runJson(cli, [
    "instances",
    "stop",
    "--instance",
    instanceName,
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
  ], { env: environment }).catch(() => undefined);
  if (!process.argv.includes("--keep-workspace")) {
    await rm(testRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Kept proof workspace: ${testRoot}\n`);
  }
}
