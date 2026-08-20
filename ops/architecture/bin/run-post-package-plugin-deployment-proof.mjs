#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repositoryIdentity } from "./property-evidence.mjs";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const MODULE_ID = "fixture.post-package-deployment";
const COMMAND_ID = "fixture.post-package-deployment.command";
const RECORD_KEY = "post-package-deployment";
const TEST_ID = "architecture.post-package-plugin-deployment.property";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timelineEvent(timeline, name, fields = {}) {
  timeline.push(Object.freeze({ at: new Date().toISOString(), name, ...fields }));
}

async function requireFile(file, label) {
  assert.equal((await stat(file)).isFile(), true, `${label} is not a file: ${file}`);
}

async function requireDirectory(directory, label) {
  assert.equal((await stat(directory)).isDirectory(), true, `${label} is not a directory: ${directory}`);
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
  const value = JSON.parse(await run(command, args, options));
  assert.ok(
    value.status === "success" || value.status === "no_op",
    `${value.operation} did not succeed: ${value.status}`,
  );
  return value;
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
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const report = await runJson(cli, [
      "instances",
      "list",
      "--runtime-root",
      runtimeRoot,
      "--output",
      "json",
    ], { env: environment });
    if (!report.data.instances.some(({ name }) => name === instanceName)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${instanceName} to stop`);
}

async function waitForAppliedRevision(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  targetRevision,
) {
  const deadline = Date.now() + 45_000;
  let lastStatus;
  while (Date.now() < deadline) {
    const instance = await currentInstance(cli, environment, instanceName, runtimeRoot);
    const status = instance.moduleControl;
    lastStatus = status;
    if (status.registryRevision === targetRevision
      && status.observedRegistryRevision === targetRevision
      && status.revisionLag === 0) {
      return instance;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out applying registry revision ${targetRevision}: ${JSON.stringify(lastStatus)}`,
  );
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

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function hostHashes(cli, ui) {
  return Object.freeze({
    native: await hashFile(cli),
    frontend: await hashFile(ui),
  });
}

async function productionLoadChain() {
  const [runtimeLoader, artifactLoader, applicationRuntime] = await Promise.all([
    readFile(path.join(repositoryRoot, "core/frontend/host/runtimeModuleLoader.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "core/frontend/host/moduleArtifactLoader.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "core/frontend/shell/applicationRuntime.ts"), "utf8"),
  ]);
  assert.match(runtimeLoader, /catalog \?\? await getRuntimeModuleLoadCatalog\(\)/);
  assert.match(runtimeLoader, /options\.resolveArtifactUrl \?\? moduleArtifactUrl/);
  assert.match(
    runtimeLoader,
    /options\.importModule === undefined \? \{\} : \{ importModule: options\.importModule \}/,
  );
  assert.match(artifactLoader, /importModule = \(url\) => import\(\/\* @vite-ignore \*\/ url\)/);
  assert.match(applicationRuntime, /getCatalog: getRuntimeModuleCatalog,/);
  assert.match(applicationRuntime, /loadModules: loadRuntimeModules,/);
  return Object.freeze({
    catalog: "getRuntimeModuleCatalog",
    loader: "loadRuntimeModules",
    urlResolver: "moduleArtifactUrl",
    importer: "import(/* @vite-ignore */ url)",
    productionOverrides: Object.freeze({ resolver: false, importer: false }),
  });
}

function timestampFileName() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
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
const fixtureSource = path.join(
  repositoryRoot,
  "ops/architecture/fixtures/plugin-artifacts/post-package-deployment",
);
await requireDirectory(app, "Packaged Shipctl application");
await requireFile(cli, "Bundled Shipctl CLI");
await requireFile(ui, "Bundled Shipctl UI");
await requireFile(path.join(fixtureSource, "module.template.json"), "External plugin fixture manifest");
await requireFile(path.join(fixtureSource, "src/index.ts"), "External plugin fixture entry");

const timeline = [];
const testRoot = await mkdtemp(path.join(os.tmpdir(), "shipctl-post-package-plugin-"));
const home = path.join(testRoot, "home");
const stateRoot = path.join(testRoot, "state");
const runtimeRoot = path.join(testRoot, "runtime");
const archive = path.join(testRoot, "post-package-deployment.tar");
const instanceName = `post-package-plugin-${path.basename(testRoot)}`;
const environment = { ...process.env, HOME: home };
let instanceRunning = false;

try {
  const loadChain = await productionLoadChain();
  const beforeHashes = await hostHashes(cli, ui);
  timelineEvent(timeline, "host_package_preexisting", { app, hashes: beforeHashes });
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ]);

  // Boot the packaged host before the fixture is even compiled. This creates a
  // strict package -> boot -> external pack ordering in the retained evidence.
  const initialStarted = await runJson(cli, [
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
  instanceRunning = true;
  const initialInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    initialStarted.data.moduleControl.registryRevision,
  );
  timelineEvent(timeline, "initial_packaged_host_boot", {
    instanceId: initialInstance.instanceId,
    processId: initialInstance.processId,
    registryRevision: initialInstance.moduleControl.registryRevision,
  });
  await runJson(cli, [
    "instances",
    "stop",
    "--instance",
    instanceName,
    "--runtime-root",
    runtimeRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  instanceRunning = false;
  await waitForInstanceAbsent(cli, environment, instanceName, runtimeRoot);
  timelineEvent(timeline, "initial_host_stopped");

  const packed = JSON.parse(await run(process.execPath, [
    "ops/architecture/bin/build-plugin-artifact.mjs",
    "--source",
    fixtureSource,
    "--to",
    archive,
    "--shipctl",
    cli,
  ], { env: environment }));
  assert.equal(packed.status, "success");
  assert.equal(packed.operation, "architecture.plugin_artifact.build");
  timelineEvent(timeline, "external_fixture_packed_after_host_boot", {
    archive,
    moduleId: packed.data.build.moduleId,
  });

  const added = await runJson(cli, [
    "modules",
    "add",
    "--offline",
    archive,
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  const admittedApplication = added.data.artifact.canonical.manifest.application;
  assert.equal(admittedApplication.role, "presentation");
  assert.deepEqual(admittedApplication.requiredServices, [{ id: "shipctl.plugin-data", version: 1 }]);
  assert.deepEqual(admittedApplication.contributions, [{
    family: "command",
    id: COMMAND_ID,
    schemaVersion: 1,
  }]);
  const addRevision = added.data.receipt.registryRevision;
  timelineEvent(timeline, "fixture_installed_via_public_registry", {
    registryRevision: addRevision,
    contentDigest: added.data.receipt.artifact.contentDigest,
  });

  const enabled = await runJson(cli, [
    "modules",
    "enable",
    MODULE_ID,
    "--offline",
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  assert.equal(enabled.data.desired.enabled, true);
  assert.equal(enabled.data.registryRevision, addRevision + 1);
  assert.equal(enabled.data.operation.kind, "enable");
  assert.equal(enabled.data.operation.result, "succeeded");
  const enableRevision = enabled.data.registryRevision;
  const offlineInspection = await runJson(cli, [
    "modules",
    "inspect",
    MODULE_ID,
    "--offline",
    "--state-root",
    stateRoot,
    "--output",
    "json",
    "--full",
  ], { env: environment });
  assert.equal(offlineInspection.data.desired.enabled, true);
  timelineEvent(timeline, "fixture_enabled_via_public_operation", {
    registryRevision: enableRevision,
    operation: enabled.data.operation,
  });

  // This is a restart of the exact app hashed above. There is intentionally no
  // host build, signing, release, resolver injection, or importer injection
  // between fixture packaging and this activation.
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
  instanceRunning = true;
  const restartedInstance = await waitForAppliedRevision(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    enableRevision,
  );
  const activeModule = await inspectActiveModule(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    MODULE_ID,
  );
  assert.equal(activeModule.manifest.contentDigest, added.data.receipt.artifact.contentDigest);
  assert.deepEqual(
    activeModule.contributions
      .map(({ kind, id }) => `${kind}:${id}`)
      .sort(),
    [`command:${COMMAND_ID}`],
  );
  timelineEvent(timeline, "unchanged_host_restarted_and_artifact_active", {
    instanceId: restartedInstance.instanceId,
    processId: restartedInstance.processId,
    registryRevision: restartedInstance.moduleControl.registryRevision,
  });

  const pluginData = JSON.parse(await readFile(path.join(stateRoot, "plugin-data.json"), "utf8"));
  const record = Object.values(pluginData.records).find((candidate) => (
    candidate.ownerModuleId === MODULE_ID
      && candidate.key === RECORD_KEY
      && candidate.scope?.kind === "global"
  ));
  assert.ok(record, "The external plugin did not write its activation-scoped configuration");
  assert.equal(record.schemaVersion, 1);
  assert.ok(record.revision >= 1);
  assert.deepEqual(record.value, {
    activated: true,
    source: "post-package-deployment",
  });
  timelineEvent(timeline, "plugin_data_configuration_write_observed", {
    ownerModuleId: record.ownerModuleId,
    key: record.key,
    revision: record.revision,
  });

  const afterHashes = await hostHashes(cli, ui);
  assert.deepEqual(afterHashes, beforeHashes, "The host package changed after external fixture packaging");
  timelineEvent(timeline, "host_hashes_unchanged", { hashes: afterHashes });

  const evidence = {
    schemaVersion: 1,
    testId: TEST_ID,
    propertyId: "PROP-H-POST-PACKAGE-PLUGIN-DEPLOY-001",
    operation: "architecture.post_package_plugin_deployment",
    status: "pass",
    repository: await repositoryIdentity(repositoryRoot),
    package: {
      app,
      cli,
      ui,
      hashes: {
        before: beforeHashes,
        after: afterHashes,
        unchanged: true,
      },
    },
    productionLoadChain: loadChain,
    fixture: {
      source: fixtureSource,
      archive,
      build: packed.data.build,
      identity: added.data.receipt.artifact,
      admittedApplication,
    },
    registry: {
      addRevision,
      enableRevision,
      offlineInspection: offlineInspection.data,
      enableOperation: enabled.data.operation,
    },
    restart: {
      initial: {
        instanceId: initialInstance.instanceId,
        processId: initialInstance.processId,
        registryRevision: initialInstance.moduleControl.registryRevision,
      },
      activated: {
        instanceId: restartedInstance.instanceId,
        processId: restartedInstance.processId,
        registryRevision: restartedInstance.moduleControl.registryRevision,
        observedRegistryRevision: restartedInstance.moduleControl.observedRegistryRevision,
        revisionLag: restartedInstance.moduleControl.revisionLag,
      },
    },
    activated: {
      module: activeModule,
      contribution: `command:${COMMAND_ID}`,
      pluginDataRecord: record,
    },
    timeline,
  };
  const evidenceDirectory = path.join(
    repositoryRoot,
    "target/architecture-evidence/post-package-plugin-deployment",
  );
  const evidenceFile = path.join(evidenceDirectory, `proof-${timestampFileName()}.json`);
  const latestFile = path.join(evidenceDirectory, "latest.json");
  await mkdir(evidenceDirectory, { recursive: true });
  const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  await Promise.all([
    writeFile(evidenceFile, serializedEvidence),
    writeFile(latestFile, serializedEvidence),
  ]);
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceFile, latestFile, evidence }, null, 2)}\n`);
} finally {
  if (instanceRunning) {
    await runJson(cli, [
      "instances",
      "stop",
      "--instance",
      instanceName,
      "--runtime-root",
      runtimeRoot,
      "--force",
      "--output",
      "json",
      "--full",
    ], { env: environment }).catch(() => undefined);
  }
  await rm(testRoot, { recursive: true, force: true });
}
