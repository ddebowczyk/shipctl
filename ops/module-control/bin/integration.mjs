#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
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
const capabilityOutput = path.join(repositoryRoot, "target", "module-control");
const workRoot = path.join(capabilityOutput, "work", runId);
const evidenceDirectory = path.join(capabilityOutput, "evidence");
const evidencePath = path.join(evidenceDirectory, `phase-2-${runId}.json`);
const runtimeRoot = path.join(workRoot, "runtime");
const stateRoots = {
  alpha: path.join(workRoot, "alpha"),
  bravo: path.join(workRoot, "bravo"),
};
const names = {
  alpha: `module-control-${process.pid}-alpha`,
  bravo: `module-control-${process.pid}-bravo`,
};
const guardedStateRoot = path.join(workRoot, "unexpected-default-state");
const guardedRuntimeRoot = path.join(workRoot, "unexpected-default-runtime");
const moduleId = "shipctl.assistants";
const evidence = {
  schemaVersion: 1,
  phase: 2,
  runId,
  startedAt: new Date().toISOString(),
  status: "running",
  repositoryRoot,
  workRoot,
  runtimeRoot,
  productionStateRoot: path.join(os.homedir(), ".shipctl"),
  binaries: {},
  operations: [],
  assertions: [],
  cleanup: {},
};

function exists(target) {
  try {
    return Boolean(statSync(target));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function recordAssertion(name, passed, details = {}) {
  evidence.assertions.push({ name, passed, details });
  if (!passed) throw new Error(`Assertion failed: ${name}`);
}

function binaryFingerprint(target) {
  const stat = statSync(target);
  return {
    path: path.relative(repositoryRoot, target),
    size: stat.size,
    modifiedAtMs: stat.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
  };
}

function parseDocument(stdout, stderr, exitCode, label) {
  const source = (exitCode === 0 ? stdout : stderr).trim();
  if (!source) throw new Error(`${label} returned no structured response`);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function runCommand(executable, args, label, expectedExit = 0, extraEnvironment = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SHIPCTL_STATE_DIR: guardedStateRoot,
      SHIPCTL_RUNTIME_DIR: guardedRuntimeRoot,
      ...extraEnvironment,
    },
  });
  if (result.error) throw result.error;
  const exitCode = result.status ?? 1;
  const document = parseDocument(result.stdout ?? "", result.stderr ?? "", exitCode, label);
  evidence.operations.push({
    label,
    executable: path.relative(repositoryRoot, executable),
    args,
    exitCode,
    response: document,
  });
  recordAssertion(`${label}.exit`, exitCode === expectedExit, { expectedExit, exitCode });
  return document;
}

function runShipctl(args, label, expectedExit = 0, extraEnvironment = {}) {
  return runCommand(
    shipctl,
    [...args, "--output", "json"],
    label,
    expectedExit,
    extraEnvironment,
  );
}

function start(name, stateRoot, label) {
  return runShipctl(
    ["ui", "start", "--name", name, "--state-root", stateRoot, "--runtime-root", runtimeRoot],
    label,
  ).data;
}

function stop(selector, label) {
  return runShipctl(
    ["instances", "stop", selector, "--runtime-root", runtimeRoot, "--force"],
    label,
  );
}

function inspectModule(selector, label, extraEnvironment = {}) {
  const args = ["modules", "inspect", moduleId, "--runtime-root", runtimeRoot];
  if (selector) args.push("--instance", selector);
  return runShipctl(args, label, 0, extraEnvironment).data;
}

function assertJoinedInspection(inspection, instanceId, label) {
  recordAssertion(`${label}.desired.present`, inspection.desired.moduleId === moduleId, {
    desired: inspection.desired,
  });
  recordAssertion(`${label}.observed.one`, inspection.observed.length === 1, {
    observedCount: inspection.observed.length,
  });
  const observed = inspection.observed[0];
  recordAssertion(`${label}.target`, observed.instanceId === instanceId, {
    expectedInstanceId: instanceId,
    observedInstanceId: observed.instanceId,
  });
  recordAssertion(
    `${label}.identity.joined`,
    inspection.manifest.id === inspection.desired.selectedArtifact?.id &&
      inspection.manifest.id === observed.artifact?.id &&
      inspection.manifest.contentDigest === inspection.desired.selectedArtifact?.contentDigest &&
      inspection.manifest.contentDigest === observed.artifact?.contentDigest,
  );
  recordAssertion(
    `${label}.revisions.distinct`,
    inspection.desired.configurationRevision !== observed.appliedRegistryRevision,
    {
      configurationRevision: inspection.desired.configurationRevision,
      appliedRegistryRevision: observed.appliedRegistryRevision,
    },
  );
  recordAssertion(
    `${label}.contribution.owner`,
    inspection.contributions.length > 0 &&
      inspection.contributions.every(
        (contribution) => contribution.ownerInstanceId === observed.moduleInstanceId,
      ),
    { contributions: inspection.contributions },
  );
}

function permissionBits(target) {
  return statSync(target).mode & 0o777;
}

function assertEndpointBoundary(instance) {
  if (process.platform === "win32") return;
  const descriptors = path.join(runtimeRoot, "instances");
  const descriptor = path.join(descriptors, `${instance.instanceId}.json`);
  recordAssertion("endpoint.descriptor_directory.owner_only", permissionBits(descriptors) === 0o700, {
    mode: permissionBits(descriptors).toString(8),
  });
  recordAssertion("endpoint.descriptor.owner_only", permissionBits(descriptor) === 0o600, {
    mode: permissionBits(descriptor).toString(8),
  });
  if (process.platform === "darwin") {
    const endpoint = path.join("/tmp", `shipctl.${instance.instanceId.replaceAll("-", "")}`);
    recordAssertion("endpoint.socket.owner_only", permissionBits(endpoint) === 0o600, {
      mode: permissionBits(endpoint).toString(8),
    });
  }
}

function assertNoTcpListener(instance) {
  if (process.platform === "win32") return;
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(instance.processId), "-iTCP", "-sTCP:LISTEN"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const listeners = (result.stdout ?? "").trim();
  recordAssertion(`instance.${instance.name}.no_tcp_listener`, listeners.length === 0, {
    listeners,
  });
}

function publicContract() {
  recordAssertion("binary.cli.present", exists(shipctl), { path: shipctl });
  recordAssertion("binary.ui.present", exists(shipctlUi), { path: shipctlUi });
  const before = {
    cli: binaryFingerprint(shipctl),
    ui: binaryFingerprint(shipctlUi),
  };
  evidence.binaries.before = before;
  evidence.binaries.cliVersion = runCommand(
    shipctl,
    ["--version", "--output", "json"],
    "binary.cli.version",
  );
  evidence.binaries.uiVersion = runCommand(
    shipctlUi,
    ["--version", "--output", "json"],
    "binary.ui.version",
  );
  recordAssertion(
    "binary.protocols.match",
    evidence.binaries.cliVersion.controlProtocolVersion ===
      evidence.binaries.uiVersion.controlProtocolVersion,
  );

  const alpha = start(names.alpha, stateRoots.alpha, "instance.alpha.start");
  const bravo = start(names.bravo, stateRoots.bravo, "instance.bravo.start");
  recordAssertion("instances.identities.distinct", alpha.instanceId !== bravo.instanceId);
  recordAssertion("instances.state_roots.distinct", alpha.stateRoot !== bravo.stateRoot);

  const listed = runShipctl(
    ["instances", "list", "--runtime-root", runtimeRoot],
    "instances.list.two",
  );
  recordAssertion("instances.list.two", listed.data.count === 2, { count: listed.data.count });

  const alphaByName = inspectModule(names.alpha, "modules.alpha.inspect.name");
  assertJoinedInspection(alphaByName, alpha.instanceId, "modules.alpha.inspect.name");
  const bravoById = inspectModule(bravo.instanceId, "modules.bravo.inspect.id");
  assertJoinedInspection(bravoById, bravo.instanceId, "modules.bravo.inspect.id");
  const bravoInjected = inspectModule(null, "modules.bravo.inspect.injected", {
    SHIPCTL_INSTANCE_ID: bravo.instanceId,
  });
  assertJoinedInspection(bravoInjected, bravo.instanceId, "modules.bravo.inspect.injected");

  const ambiguous = runShipctl(
    ["modules", "inspect", moduleId, "--runtime-root", runtimeRoot],
    "modules.inspect.ambiguous",
    1,
    { SHIPCTL_INSTANCE_ID: "" },
  );
  recordAssertion("modules.inspect.ambiguous.code", ambiguous.code === "control.instance.ambiguous", {
    code: ambiguous.code,
  });

  const diagnostics = runShipctl(
    ["instances", "diagnose", names.alpha, "--runtime-root", runtimeRoot],
    "instance.alpha.diagnose",
  ).data;
  recordAssertion(
    "instance.alpha.diagnostics.complete",
    diagnostics.healthy &&
      diagnostics.instance.moduleControl.registryAvailable &&
      diagnostics.instance.moduleControl.runtimeSnapshotAvailable &&
      diagnostics.instance.moduleControl.revisionLag === 0,
    { moduleControl: diagnostics.instance.moduleControl },
  );
  for (const code of [
    "control.instance.descriptor.valid",
    "control.instance.endpoint.accessible",
    "control.instance.handshake.valid",
    "control.instance.protocol.compatible",
    "control.instance.build.compatible",
    "module.registry.health.ok",
    "module.runtime.snapshot.available",
  ]) {
    recordAssertion(
      `instance.alpha.diagnostic.${code}`,
      diagnostics.diagnostics.some((diagnostic) => diagnostic.code === code),
    );
  }

  const mutation = runShipctl(
    [
      "modules",
      "disable",
      moduleId,
      "--target-revision",
      String(diagnostics.instance.moduleControl.registryRevision),
      "--instance",
      names.alpha,
      "--runtime-root",
      runtimeRoot,
    ],
    "modules.disable.phase2_unavailable",
    1,
  );
  recordAssertion(
    "modules.disable.phase2_unavailable.code",
    mutation.code === "module.control.mutation_unavailable",
    { code: mutation.code },
  );

  assertEndpointBoundary(alpha);
  assertNoTcpListener(alpha);
  assertNoTcpListener(bravo);

  const registryRevision = diagnostics.instance.moduleControl.registryRevision;
  stop(names.alpha, "instance.alpha.stop");
  const stoppedOnline = runShipctl(
    ["modules", "inspect", moduleId, "--instance", names.alpha, "--runtime-root", runtimeRoot],
    "modules.alpha.inspect.stopped",
    1,
  );
  recordAssertion("modules.alpha.stopped.unavailable", stoppedOnline.code === "control.instance.absent", {
    code: stoppedOnline.code,
  });
  const offline = runShipctl(
    ["modules", "inspect", moduleId, "--offline", "--state-root", stateRoots.alpha],
    "modules.alpha.inspect.offline_after_stop",
  ).data;
  recordAssertion(
    "modules.alpha.registry.survives_stop",
    offline.registryRevision === registryRevision &&
      offline.runtimeAvailable === false &&
      offline.desired[0]?.enabled === true,
    {
      onlineRegistryRevision: registryRevision,
      offlineRegistryRevision: offline.registryRevision,
      runtimeAvailable: offline.runtimeAvailable,
    },
  );

  stop(names.bravo, "instance.bravo.stop");
  const empty = runShipctl(
    ["instances", "list", "--runtime-root", runtimeRoot],
    "instances.list.empty",
  );
  recordAssertion(
    "instances.list.empty",
    empty.data.count === 0 && empty.data.problems.length === 0,
    empty.data,
  );

  const after = {
    cli: binaryFingerprint(shipctl),
    ui: binaryFingerprint(shipctlUi),
  };
  evidence.binaries.after = after;
  recordAssertion("binary.cli.unchanged", JSON.stringify(after.cli) === JSON.stringify(before.cli));
  recordAssertion("binary.ui.unchanged", JSON.stringify(after.ui) === JSON.stringify(before.ui));
}

function cleanup() {
  if (exists(shipctl)) {
    for (const name of Object.values(names)) {
      try {
        stop(name, `cleanup.stop.${name}`);
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
