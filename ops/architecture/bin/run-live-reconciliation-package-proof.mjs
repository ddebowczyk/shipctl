#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

async function terminalList(cli, environment, instanceName, runtimeRoot) {
  return runJson(cli, ["terminals", "list", ...targetArgs(instanceName, runtimeRoot)], {
    env: environment,
  });
}

async function clickTerminalMenu(processId, menuItemLabel) {
  const script = `
tell application "System Events"
  repeat with applicationProcess in application processes
    if unix id of applicationProcess is ${processId} then
      tell applicationProcess to click menu item "${menuItemLabel}" of menu 1 of menu bar item "File" of menu bar 1
      return "clicked"
    end if
  end repeat
  error "Shipctl application process ${processId} is unavailable"
end tell`;
  const result = await run("osascript", ["-e", script]);
  assert.equal(result.trim(), "clicked");
}

async function createTerminal(
  cli,
  environment,
  instanceName,
  runtimeRoot,
  processId,
  menuItemLabel,
  driverId,
) {
  const before = await terminalList(cli, environment, instanceName, runtimeRoot);
  const existingIds = new Set(before.data.terminals.map(({ id }) => id));
  await clickTerminalMenu(processId, menuItemLabel);
  for (;;) {
    const listed = await terminalList(cli, environment, instanceName, runtimeRoot);
    const created = listed.data.terminals.filter(({ id }) => !existingIds.has(id));
    for (const terminal of created) {
      const descriptor = await terminalGet(
        cli,
        environment,
        instanceName,
        runtimeRoot,
        terminal.id,
      );
      if (descriptor.driverId === driverId) return descriptor.id;
    }
  }
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

async function inspectActiveBundledModule(
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
const archive = path.join(testRoot, "headless-service.tar");
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
    archive,
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
      await inspectActiveBundledModule(
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
    initialInstance.processId,
    "New Thin Terminal",
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
  assert.equal(initialTerminal.metadata.cwd, repository);
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
    initialInstance.processId,
    "New Semantic Terminal",
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
  assert.equal(initialSemanticTerminal.metadata.cwd, repository);
  const semanticBeforeTransition = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_BEFORE__",
  );

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
  const addRevision = added.data.receipt.registryRevision;
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
  const afterEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_ENABLE__",
  );
  const semanticAfterEnable = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_ENABLE__",
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
  const afterRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    thinTerminalId,
    "__PHASE_F_AFTER_REMOVE__",
  );
  const semanticAfterRemove = await writeCanary(
    cli,
    environment,
    instanceName,
    runtimeRoot,
    semanticTerminalId,
    "__PHASE_F_SEMANTIC_AFTER_REMOVE__",
  );
  const finalTerminal = afterRemove.after;
  const finalSemanticTerminal = semanticAfterRemove.after;

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
  assert.equal(enabledInstance.processId, initialInstance.processId);
  assert.equal(removedInstance.processId, initialInstance.processId);

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
    removeRevision,
  );
  assert.notEqual(restartedInstance.instanceId, initialInstance.instanceId);
  assert.equal(restartedInstance.processId, restarted.data.processId);
  const restartInspection = await runJson(cli, [
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
  assert.equal(restartInspection.data.registryRevision, removeRevision);
  assert.equal(restartInspection.data.runtimeAvailable, false);
  assert.equal(restartInspection.data.callable, false);
  assert.equal(restartInspection.data.desired.enabled, false);
  assert.equal(restartInspection.data.desired.selectedArtifact, null);

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
      addRevision,
      enableRevision,
      removeRevision,
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
        afterEnable,
        afterRemove,
      },
    },
    semanticTerminal: {
      identity: stableTerminalIdentity(initialSemanticTerminal),
      writes: {
        beforeTransition: semanticBeforeTransition,
        afterEnable: semanticAfterEnable,
        afterRemove: semanticAfterRemove,
      },
    },
    operations: {
      enable: enableOperation.data,
      remove: removeOperation.data,
    },
    restartInspection: restartInspection.data,
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
