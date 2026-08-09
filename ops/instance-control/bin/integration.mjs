#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const executableExtension = process.platform === "win32" ? ".exe" : "";
const shipctl = path.join(repositoryRoot, "target", "debug", `shipctl${executableExtension}`);
const shipctlUi = path.join(repositoryRoot, "target", "debug", `shipctl-ui${executableExtension}`);
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const capabilityOutput = path.join(repositoryRoot, "target", "instance-control");
const workRoot = path.join(capabilityOutput, "work", runId);
const evidenceDirectory = path.join(capabilityOutput, "evidence");
const evidencePath = path.join(evidenceDirectory, `${runId}.json`);
const runtimeRoot = path.join(workRoot, "runtime");
const roots = {
  alpha: path.join(workRoot, "alpha"),
  bravo: path.join(workRoot, "bravo"),
  charlie: path.join(workRoot, "charlie"),
  conflict: path.join(workRoot, "conflict"),
};
const archivePath = path.join(workRoot, "alpha.shipctl-state");
const names = {
  alpha: `contract-${process.pid}-alpha`,
  bravo: `contract-${process.pid}-bravo`,
  charlie: `contract-${process.pid}-restored`,
  rootConflict: `contract-${process.pid}-root-conflict`,
};
const guardedStateRoot = path.join(workRoot, "unexpected-default-state");
const guardedRuntimeRoot = path.join(workRoot, "unexpected-default-runtime");
const evidence = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "running",
  repositoryRoot,
  workRoot,
  runtimeRoot,
  productionStateRoot: path.join(os.homedir(), ".shipctl"),
  guardedStateRoot,
  guardedRuntimeRoot,
  binaries: {},
  operations: [],
  assertions: [],
  cleanup: {},
};

function recordAssertion(name, passed, details = {}) {
  evidence.assertions.push({ name, passed, details });
  if (!passed) throw new Error(`Assertion failed: ${name}`);
}

function parseDocument(stdout, stderr, label) {
  const source = stdout.trim() || stderr.trim();
  if (!source) throw new Error(`${label} returned no structured response`);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function runCommand(executable, args, label, expectedExit = 0) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SHIPCTL_STATE_DIR: guardedStateRoot,
      SHIPCTL_RUNTIME_DIR: guardedRuntimeRoot,
    },
  });
  if (result.error) throw result.error;
  const exitCode = result.status ?? 1;
  const document = parseDocument(result.stdout ?? "", result.stderr ?? "", label);
  evidence.operations.push({
    label,
    executable: path.relative(repositoryRoot, executable),
    args,
    exitCode,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    response: document,
  });
  recordAssertion(`${label}.exit`, exitCode === expectedExit, { expectedExit, exitCode });
  return document;
}

function runShipctl(args, label, expectedExit = 0) {
  return runCommand(shipctl, [...args, "--output", "json"], label, expectedExit);
}

function buildBinaries() {
  const args = ["build", "-p", "shipctl-cli", "-p", "shipctl-ui"];
  const result = spawnSync("cargo", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  evidence.operations.push({
    label: "build.binaries",
    executable: "cargo",
    args,
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  });
  recordAssertion("build.binaries.exit", result.status === 0, { exitCode: result.status });
}

function exists(target) {
  try {
    return Boolean(statSync(target));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function writeFixtures() {
  mkdirSync(roots.alpha, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(roots.alpha, "config.yml"),
    "version: 1\nrepos: []\ngroups: []\nusage:\n  codex:\n    show: true\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(roots.alpha, "ui-state.json"),
    `${JSON.stringify({ lastRepoPath: "/tmp/shipctl-contract-repository", themeId: "contract-proof", customTheme: null }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(roots.alpha, "assistant-sessions.json"),
    `${JSON.stringify({ version: 1, sessions: [] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function start(name, stateRoot, label, extra = [], expectedExit = 0) {
  return runShipctl(
    ["ui", "start", "--name", name, "--state-root", stateRoot, "--runtime-root", runtimeRoot, ...extra],
    label,
    expectedExit,
  );
}

function stop(name, label, force = false) {
  const args = ["instances", "stop", name, "--runtime-root", runtimeRoot];
  if (force) args.push("--force");
  return runShipctl(args, label);
}

function verifyProviderAccounting(manifest) {
  const expectedProviders = [
    "assistants.continuity",
    "host.ui",
    "host.workspace",
    "modules.artifacts",
    "modules.registry",
    "scheduler.configuration",
    "usage.database",
  ];
  const observed = manifest.providers.map((provider) => provider.id);
  recordAssertion("archive.providers.complete", JSON.stringify(observed) === JSON.stringify(expectedProviders), {
    expectedProviders,
    observed,
  });
  const entries = manifest.providers.flatMap((provider) =>
    provider.entries.map((entry) => ({ provider: provider.id, ...entry })),
  );
  recordAssertion(
    "archive.entries.classified",
    entries.every((entry) => entry.classification && entry.decision),
    { count: entries.length },
  );
  recordAssertion(
    "archive.portable_entries.digested",
    entries
      .filter((entry) => entry.included)
      .every((entry) => entry.digestSha256?.length === 64 && entry.stateDigestSha256?.length === 64),
  );
  for (const excluded of [
    "provider_credentials",
    "provider_transcripts",
    "terminal_processes",
    "repository_contents",
    "repository_workspace_files",
    "sqlite_runtime",
    "transcript_sources",
  ]) {
    const entry = entries.find((candidate) => candidate.id === excluded);
    recordAssertion(`archive.exclusion.${excluded}`, entry?.included === false, {
      classification: entry?.classification,
      decision: entry?.decision,
    });
  }
}

function publicContract() {
  buildBinaries();
  evidence.binaries.cli = runCommand(shipctl, ["--version", "--output", "json"], "binary.cli.version");
  evidence.binaries.ui = runCommand(shipctlUi, ["--version", "--output", "json"], "binary.ui.version");
  recordAssertion(
    "binary.protocols.match",
    evidence.binaries.cli.controlProtocolVersion === evidence.binaries.ui.controlProtocolVersion,
    evidence.binaries,
  );

  writeFixtures();
  const alphaStart = start(names.alpha, roots.alpha, "instance.alpha.start");
  const bravoStart = start(names.bravo, roots.bravo, "instance.bravo.start");
  const alpha = alphaStart.data;
  const bravo = bravoStart.data;
  recordAssertion("instances.identities.distinct", alpha.instanceId !== bravo.instanceId, {
    alpha: alpha.instanceId,
    bravo: bravo.instanceId,
  });
  recordAssertion("instances.roots.distinct", alpha.stateRoot !== bravo.stateRoot, {
    alpha: alpha.stateRoot,
    bravo: bravo.stateRoot,
  });

  const idempotent = start(names.alpha, roots.alpha, "instance.alpha.idempotent");
  recordAssertion("instance.start.idempotent", idempotent.code === "control.instance.already_ready" && idempotent.data.instanceId === alpha.instanceId, {
    code: idempotent.code,
    instanceId: idempotent.data.instanceId,
  });
  const alphaTerminals = runShipctl(
    ["terminals", "list", "--instance", names.alpha, "--runtime-root", runtimeRoot],
    "terminals.alpha.list.empty",
  );
  const bravoTerminals = runShipctl(
    ["terminals", "list", "--instance", names.bravo, "--runtime-root", runtimeRoot],
    "terminals.bravo.list.empty",
  );
  recordAssertion(
    "terminals.instances.are_independent",
    alphaTerminals.data.count === 0 &&
      alphaTerminals.data.terminals.length === 0 &&
      bravoTerminals.data.count === 0 &&
      bravoTerminals.data.terminals.length === 0,
    { alpha: alphaTerminals.data, bravo: bravoTerminals.data },
  );
  const nameConflict = start(names.alpha, roots.conflict, "instance.name.conflict", [], 1);
  recordAssertion("instance.name.conflict.code", nameConflict.code === "control.instance.name_in_use", {
    code: nameConflict.code,
  });
  const rootConflict = start(names.rootConflict, roots.alpha, "instance.root.conflict", [], 1);
  recordAssertion("instance.root.conflict.code", rootConflict.code === "control.instance.state_root_in_use", {
    code: rootConflict.code,
  });

  const listed = runShipctl(["instances", "list", "--runtime-root", runtimeRoot], "instances.list.two");
  recordAssertion("instances.list.two.count", listed.data.count === 2, { count: listed.data.count });
  const alphaInspection = runShipctl(
    ["instances", "inspect", names.alpha, "--runtime-root", runtimeRoot],
    "instance.alpha.inspect.name",
  );
  const bravoInspection = runShipctl(
    ["instances", "inspect", bravo.instanceId, "--runtime-root", runtimeRoot],
    "instance.bravo.inspect.id",
  );
  recordAssertion("instance.alpha.inspect.identity", alphaInspection.data.instanceId === alpha.instanceId);
  recordAssertion("instance.bravo.inspect.identity", bravoInspection.data.name === names.bravo);

  const saved = runShipctl(
    ["state", "save", "--instance", names.alpha, "--to", archivePath, "--runtime-root", runtimeRoot],
    "state.alpha.save",
  );
  const inspected = runShipctl(["state", "inspect", archivePath], "state.archive.inspect");
  const verified = runShipctl(["state", "verify", archivePath], "state.archive.verify");
  recordAssertion("state.archive.verified", saved.data.verified && inspected.data.verified && verified.data.verified);
  recordAssertion(
    "state.archive.fingerprint.stable",
    saved.data.manifest.sourceStateFingerprint === verified.data.manifest.sourceStateFingerprint,
    { fingerprint: saved.data.manifest.sourceStateFingerprint },
  );
  verifyProviderAccounting(verified.data.manifest);

  const restoredStart = start(
    names.charlie,
    roots.charlie,
    "instance.restored.start",
    ["--load-state", archivePath],
  );
  const restored = restoredStart.data;
  recordAssertion("state.restore.new_identity", restored.instanceId !== alpha.instanceId, {
    source: alpha.instanceId,
    restored: restored.instanceId,
  });
  recordAssertion("state.restore.new_name", restored.name === names.charlie && restored.name !== alpha.name);
  recordAssertion("state.restore.new_root", restored.stateRoot !== alpha.stateRoot);
  recordAssertion(
    "state.restore.fingerprint_equivalent",
    restored.stateFingerprint === saved.data.manifest.sourceStateFingerprint,
    { source: saved.data.manifest.sourceStateFingerprint, restored: restored.stateFingerprint },
  );
  const three = runShipctl(["instances", "list", "--runtime-root", runtimeRoot], "instances.list.three");
  recordAssertion("instances.list.three.count", three.data.count === 3, { count: three.data.count });

  stop(names.alpha, "instance.alpha.stop.graceful");
  stop(names.bravo, "instance.bravo.stop.graceful");
  stop(names.charlie, "instance.restored.stop.force", true);
  const repeated = stop(names.charlie, "instance.restored.stop.noop");
  recordAssertion("instance.stop.idempotent", repeated.status === "no_op" && repeated.code === "control.instance.already_stopped", {
    status: repeated.status,
    code: repeated.code,
  });
  const empty = runShipctl(["instances", "list", "--runtime-root", runtimeRoot], "instances.list.empty");
  recordAssertion("instances.list.empty.count", empty.data.count === 0 && empty.data.problems.length === 0, {
    count: empty.data.count,
    problems: empty.data.problems,
  });

  const restarted = start(names.alpha, roots.alpha, "instance.alpha.restart.after_release");
  recordAssertion("instance.leases.released", restarted.data.instanceId !== alpha.instanceId, {
    original: alpha.instanceId,
    restarted: restarted.data.instanceId,
  });
  stop(names.alpha, "instance.alpha.restart.stop", true);
  const finalList = runShipctl(["instances", "list", "--runtime-root", runtimeRoot], "instances.list.final");
  recordAssertion("instances.finally.absent", finalList.data.count === 0 && finalList.data.problems.length === 0);
}

function cleanup() {
  if (exists(shipctl)) {
    for (const name of [names.alpha, names.bravo, names.charlie, names.rootConflict]) {
      try {
        stop(name, `cleanup.stop.${name}`, true);
      } catch (error) {
        evidence.cleanup[`stop.${name}`] = { status: "failed", message: error.message };
      }
    }
  }
  evidence.cleanup.guardedStateRootUntouched = !exists(guardedStateRoot);
  evidence.cleanup.guardedRuntimeRootUntouched = !exists(guardedRuntimeRoot);
  if (exists(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  evidence.cleanup.workRootRemoved = !exists(workRoot);
}

function writeEvidence() {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  evidence.finishedAt = new Date().toISOString();
  const temporary = `${evidencePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, evidencePath);
}

let failure = null;
try {
  publicContract();
  evidence.status = "success";
} catch (error) {
  failure = error;
  evidence.status = "failure";
  evidence.failure = { message: error.message, stack: error.stack };
} finally {
  cleanup();
  if (
    !evidence.cleanup.workRootRemoved ||
    !evidence.cleanup.guardedStateRootUntouched ||
    !evidence.cleanup.guardedRuntimeRootUntouched
  ) {
    evidence.status = "failure";
    failure ??= new Error("Cleanup or default-profile invariant failed");
  }
  writeEvidence();
}

const summary = JSON.stringify({ status: evidence.status, evidencePath });
if (failure) {
  console.error(summary);
  console.error(failure.message);
  process.exitCode = 1;
} else {
  console.log(summary);
}
