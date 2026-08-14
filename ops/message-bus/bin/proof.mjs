#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const executableExtension = process.platform === "win32" ? ".exe" : "";
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const evidenceDirectory = path.join(repositoryRoot, "target", "message-bus", "evidence");
const workRoot = path.join(repositoryRoot, "target", "message-bus", "work", runId);
const sharedGoldens = path.join(repositoryRoot, "module-api", "fixtures", "message-contracts.json");
const fixtureManifest = path.join(repositoryRoot, "modules", "fixture", "module.yaml");
const fixtureSchema = path.join(repositoryRoot, "modules", "fixture", "messages", "agent-wakeup.schema.json");
const shipctl = path.join(repositoryRoot, "target", "debug", `shipctl${executableExtension}`);
const shipctlUi = path.join(repositoryRoot, "target", "debug", `shipctl-ui${executableExtension}`);
const guardedStateRoot = path.join(workRoot, "unexpected-default-state");
const guardedRuntimeRoot = path.join(workRoot, "unexpected-default-runtime");
const isolatedHome = path.join(workRoot, "home");
const isolatedXdgConfigHome = path.join(workRoot, "xdg", "config");
const isolatedXdgDataHome = path.join(workRoot, "xdg", "data");
const isolatedXdgCacheHome = path.join(workRoot, "xdg", "cache");
const isolatedXdgStateHome = path.join(workRoot, "xdg", "state");
const isolatedXdgRuntimeDirectory = path.join(workRoot, "xdg", "runtime");
const inheritedCargoHome = process.env.CARGO_HOME
  ?? (process.env.HOME ? path.join(process.env.HOME, ".cargo") : null);
const inheritedRustupHome = process.env.RUSTUP_HOME
  ?? (process.env.HOME ? path.join(process.env.HOME, ".rustup") : null);

const mode = process.argv[2];
if (!["contract", "integration", "all"].includes(mode)) {
  process.stderr.write("usage: node ops/message-bus/bin/proof.mjs <contract|integration|all>\n");
  process.exitCode = 2;
} else {
  main(mode);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(target) {
  const stat = statSync(target);
  return {
    path: path.relative(repositoryRoot, target),
    size: stat.size,
    sha256: sha256(readFileSync(target)),
  };
}

function outputSummary(output) {
  return {
    bytes: Buffer.byteLength(output),
    sha256: sha256(output),
  };
}

function parseJsonLine(output) {
  const line = output.trim().split("\n").findLast((candidate) => candidate.startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function operationDocument(operation) {
  return parseJsonLine(`${operation.stdout}\n${operation.stderr}`);
}

function isolatedEnvironment(command) {
  for (const directory of [
    isolatedHome,
    isolatedXdgConfigHome,
    isolatedXdgDataHome,
    isolatedXdgCacheHome,
    isolatedXdgStateHome,
    isolatedXdgRuntimeDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedXdgConfigHome,
    XDG_DATA_HOME: isolatedXdgDataHome,
    XDG_CACHE_HOME: isolatedXdgCacheHome,
    XDG_STATE_HOME: isolatedXdgStateHome,
    XDG_RUNTIME_DIR: isolatedXdgRuntimeDirectory,
    SHIPCTL_STATE_DIR: guardedStateRoot,
    SHIPCTL_RUNTIME_DIR: guardedRuntimeRoot,
    ...(command === "cargo" && inheritedCargoHome ? { CARGO_HOME: inheritedCargoHome } : {}),
    ...(command === "cargo" && inheritedRustupHome ? { RUSTUP_HOME: inheritedRustupHome } : {}),
  };
}

function run(evidence, label, command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: isolatedEnvironment(command),
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  const operation = {
    label,
    command,
    args,
    exitCode,
    stdout: outputSummary(stdout),
    stderr: outputSummary(stderr),
    ...(result.error ? { error: result.error.name } : {}),
  };
  evidence.operations.push(operation);

  // Raw process output is needed only for this in-memory proof decision. It is
  // deliberately excluded from durable evidence because a bus proof must not
  // become a payload or diagnostic-history store.
  return { ...operation, stdout, stderr };
}

function assertion(evidence, name, passed, details = {}) {
  evidence.assertions.push({ name, passed, details });
  return passed;
}

function createEvidence(kind) {
  return {
    schemaVersion: 2,
    capability: "message-bus",
    proof: kind,
    scope: "bus_only",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    operations: [],
    assertions: [],
    diagnostics: [],
  };
}

function runRustTest(evidence, label, testName) {
  const operation = run(evidence, label, "cargo", [
    "test",
    "-p",
    "shipctl-core",
    testName,
    "--",
    "--exact",
  ]);
  const output = `${operation.stdout}\n${operation.stderr}`;
  assertion(evidence, label, operation.exitCode === 0, { exitCode: operation.exitCode });
  assertion(evidence, `${label}.selected_case`, output.includes(testName), { testName });
}

function runFrontendBridgeTests(evidence) {
  const selectedTests = [
    "activation facade binds identity and bridge while declarations stay data-only",
    "ordered dispatch contains handler failure and rejects stale activations",
    "broadcast contains a failed subscriber, diagnoses it, and continues dispatch",
  ];
  const namePattern = `^(${selectedTests.join("|")})$`;
  const operation = run(evidence, "integration.frontend_bridge_matrix", "pnpm", [
    "exec",
    "node",
    "--test",
    `--test-name-pattern=${namePattern}`,
    "core/frontend/host/tests/messageBusBridge.test.ts",
  ]);
  const output = `${operation.stdout}\n${operation.stderr}`;
  assertion(
    evidence,
    "integration.frontend_bridge_matrix",
    operation.exitCode === 0,
    { exitCode: operation.exitCode },
  );
  assertion(
    evidence,
    "integration.frontend_bridge_matrix.selected_cases",
    selectedTests.every((testName) => output.includes(testName)),
    { selectedTests },
  );
}

function snapshotMetadata(document) {
  const snapshot = document?.data?.runtime?.snapshot;
  if (!snapshot) return null;
  return {
    instanceId: snapshot.instanceId ?? null,
    incarnation: snapshot.incarnation ?? null,
    routeGeneration: snapshot.routeGeneration ?? null,
  };
}

function inspectionSummary(document) {
  const runtime = document?.data?.runtime;
  const snapshot = snapshotMetadata(document);
  if (!runtime || !snapshot) return null;
  return {
    ...snapshot,
    bridgeCount: runtime.bridgeCount ?? null,
    endpointCount: Array.isArray(runtime.endpoints) ? runtime.endpoints.length : null,
    activationCount: Array.isArray(runtime.activations) ? runtime.activations.length : null,
    registrationCount: Array.isArray(runtime.registrations) ? runtime.registrations.length : null,
    moduleCount: Array.isArray(document?.data?.modules) ? document.data.modules.length : null,
  };
}

function diagnosisSummary(document) {
  const snapshot = snapshotMetadata(document?.data?.inspection ? { data: document.data.inspection } : null);
  if (!snapshot) return null;
  return {
    ...snapshot,
    healthy: document?.data?.healthy ?? null,
    diagnosticCodes: Array.isArray(document?.data?.diagnostics)
      ? document.data.diagnostics.map((diagnostic) => diagnostic.code).sort()
      : null,
  };
}

function containsPayloadHistory(value) {
  if (Array.isArray(value)) return value.some(containsPayloadHistory);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    ["payload", "payloadHistory", "messageHistory", "messages"].includes(key)
    || containsPayloadHistory(nested)
  ));
}

function publicInstance(suffix) {
  return {
    key: suffix,
    name: `message-bus-${process.pid}-${suffix}`,
    stateRoot: path.join(workRoot, `${suffix}-state`),
    runtimeRoot: path.join(workRoot, "runtime"),
    beforeArchive: path.join(workRoot, `${suffix}-before.shipctl-state`),
    afterArchive: path.join(workRoot, `${suffix}-after.shipctl-state`),
  };
}

function startInstance(evidence, instance) {
  return run(evidence, `integration.public_instance.${instance.key}.start`, shipctl, [
    "ui", "start",
    "--name", instance.name,
    "--state-root", instance.stateRoot,
    "--runtime-root", instance.runtimeRoot,
    "--output", "json",
  ]);
}

function stopInstance(evidence, instance) {
  return run(evidence, `integration.public_instance.${instance.key}.stop`, shipctl, [
    "instances", "stop", instance.name,
    "--runtime-root", instance.runtimeRoot,
    "--force",
    "--output", "json",
  ]);
}

function inspectMessages(evidence, instance) {
  return run(evidence, `integration.public_messages.${instance.key}.inspect`, shipctl, [
    "messages", "inspect",
    "--instance", instance.name,
    "--runtime-root", instance.runtimeRoot,
    "--output", "json",
  ]);
}

function saveState(evidence, instance, archive, phase) {
  return run(evidence, `integration.public_state.${instance.key}.${phase}`, shipctl, [
    "state", "save",
    "--instance", instance.name,
    "--to", archive,
    "--runtime-root", instance.runtimeRoot,
    "--output", "json",
  ]);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function archiveDigestProjection(document) {
  const providers = document?.data?.manifest?.providers;
  if (!Array.isArray(providers)) return null;
  const entries = providers.flatMap((provider) => {
    if (!provider || typeof provider.id !== "string" || !Array.isArray(provider.entries)) return [];
    return provider.entries
      .filter((entry) => entry?.included === true)
      .map((entry) => ({
        provider: provider.id,
        entry: entry.id ?? null,
        digestSha256: entry.digestSha256 ?? null,
      }));
  });
  entries.sort((left, right) => (
    compareStrings(left.provider, right.provider)
    || compareStrings(String(left.entry), String(right.entry))
    || compareStrings(String(left.digestSha256), String(right.digestSha256))
  ));
  return entries.length > 0 && entries.every((entry) => (
    typeof entry.entry === "string"
    && typeof entry.digestSha256 === "string"
    && /^[a-f0-9]{64}$/.test(entry.digestSha256)
  )) ? entries : null;
}

function diagnoseMessages(evidence, instance) {
  return run(evidence, `integration.public_messages.${instance.key}.diagnose`, shipctl, [
    "messages", "diagnose",
    "--instance", instance.name,
    "--runtime-root", instance.runtimeRoot,
    "--output", "json",
  ]);
}

function contractProof() {
  const evidence = createEvidence("contract");
  evidence.artifactDigests = {
    sharedGoldens: fingerprint(sharedGoldens),
    extensionFixtureManifest: fingerprint(fixtureManifest),
    extensionFixtureSchema: fingerprint(fixtureSchema),
  };
  const goldens = JSON.parse(readFileSync(sharedGoldens, "utf8"));
  evidence.stableFailureCodes = goldens.invalid.map((fixture) => fixture.expectedCode);
  assertion(
    evidence,
    "contract.failure_codes.include_schema_confinement",
    evidence.stableFailureCodes.includes("message.contract.schema.reference_forbidden"),
  );
  assertion(
    evidence,
    "contract.failure_codes.include_secret_redaction",
    evidence.stableFailureCodes.includes("message.diagnostic.secret_leakage"),
  );
  assertion(
    evidence,
    "contract.failure_codes.include_payload_bound",
    evidence.stableFailureCodes.includes("message.payload.too_large"),
  );

  const rust = run(
    evidence,
    "contract.rust_shared_goldens",
    "cargo",
    ["test", "-p", "shipctl-core", "message_bus::contracts::tests"],
  );
  assertion(evidence, "contract.rust_shared_goldens", rust.exitCode === 0, { exitCode: rust.exitCode });

  runRustTest(
    evidence,
    "contract.rust_inspection_has_no_payload_history",
    "message_bus::inspection::tests::diagnostics_cover_public_failure_modes_without_payload_history",
  );

  const typescript = run(
    evidence,
    "contract.typescript_shared_goldens",
    "pnpm",
    ["exec", "node", "--test", "module-api/frontend/tests/messageContracts.test.ts"],
  );
  assertion(
    evidence,
    "contract.typescript_shared_goldens",
    typescript.exitCode === 0,
    { exitCode: typescript.exitCode },
  );

  const manifests = run(evidence, "contract.module_manifests", "just", ["check", "manifests"]);
  assertion(evidence, "contract.module_manifests", manifests.exitCode === 0, { exitCode: manifests.exitCode });

  return finish(evidence);
}

function integrationProof() {
  const evidence = createEvidence("integration");
  const build = run(
    evidence,
    "integration.build_host_once",
    "cargo",
    ["build", "-p", "shipctl-cli", "-p", "shipctl-ui"],
  );
  assertion(evidence, "integration.build_host_once", build.exitCode === 0, { exitCode: build.exitCode });
  if (!existsSync(shipctl) || !existsSync(shipctlUi)) {
    evidence.diagnostics.push({
      code: "message.proof.host_binary_missing",
      summary: "The bus-only proof requires both public control binaries after the one host build.",
    });
    return finish(evidence);
  }

  evidence.hostBinary = { before: { cli: fingerprint(shipctl), ui: fingerprint(shipctlUi) } };

  runRustTest(
    evidence,
    "integration.runtime_delivery_and_backpressure",
    "message_bus::runtime::tests::directed_delivery_preserves_order_applies_backpressure_and_contains_failures",
  );
  runRustTest(
    evidence,
    "integration.runtime_bounded_broadcast",
    "message_bus::runtime::tests::broadcast_reports_lag_then_continues_and_only_reaches_current_subscribers",
  );
  runRustTest(
    evidence,
    "integration.runtime_authorization",
    "message_bus::runtime::tests::registration_and_delivery_fail_closed_without_mutating_the_active_snapshot",
  );
  runRustTest(
    evidence,
    "integration.runtime_instance_isolation_and_zero_persistence",
    "message_bus::runtime::tests::instance_buses_are_isolated_and_delivery_does_not_touch_durable_roots",
  );
  runRustTest(
    evidence,
    "integration.bridge_delivery_with_active_fixture_registration",
    "message_bus::bridge::tests::ordered_bridge_delivers_directed_broadcast_and_port_frames",
  );
  runRustTest(
    evidence,
    "integration.bridge_authorization",
    "message_bus::bridge::tests::host_module_publish_uses_only_the_live_declared_module_authority",
  );
  runRustTest(
    evidence,
    "integration.bridge_failure_diagnosis",
    "message_bus::bridge::tests::reported_frontend_failure_is_bound_to_the_registered_subscription",
  );
  runRustTest(
    evidence,
    "integration.bridge_lifecycle",
    "message_bus::bridge::tests::bridge_authority_close_and_reopen_are_activation_scoped",
  );
  runFrontendBridgeTests(evidence);

  const alpha = publicInstance("alpha");
  const bravo = publicInstance("bravo");
  const started = new Set();
  try {
    const alphaStart = startInstance(evidence, alpha);
    const alphaRecord = operationDocument(alphaStart)?.data ?? null;
    const alphaStarted = alphaStart.exitCode === 0 && alphaRecord !== null;
    assertion(evidence, "integration.public_instance.alpha.start", alphaStarted, {
      exitCode: alphaStart.exitCode,
    });
    if (alphaStarted) started.add(alpha.key);

    const bravoStart = startInstance(evidence, bravo);
    const bravoRecord = operationDocument(bravoStart)?.data ?? null;
    const bravoStarted = bravoStart.exitCode === 0 && bravoRecord !== null;
    assertion(evidence, "integration.public_instance.bravo.start", bravoStarted, {
      exitCode: bravoStart.exitCode,
    });
    if (bravoStarted) started.add(bravo.key);

    if (!alphaStarted || !bravoStarted) {
      evidence.diagnostics.push({
        code: "message.proof.fixture_instance_unavailable",
        summary: "The bus-only proof could not start both isolated named host instances.",
      });
      return finish(evidence);
    }

    const listed = run(evidence, "integration.public_instances.list", shipctl, [
      "instances", "list",
      "--runtime-root", alpha.runtimeRoot,
      "--output", "json",
    ]);
    const listedData = operationDocument(listed)?.data ?? null;
    const listedNames = Array.isArray(listedData?.instances)
      ? listedData.instances.map((instance) => instance.name).sort()
      : [];
    assertion(
      evidence,
      "integration.public_named_instance_isolation",
      alphaRecord.instanceId !== bravoRecord.instanceId
        && alphaRecord.stateRoot !== bravoRecord.stateRoot
        && listed.exitCode === 0
        && listedData?.count === 2
        && JSON.stringify(listedNames) === JSON.stringify([alpha.name, bravo.name].sort()),
      { count: listedData?.count ?? null, instances: listedNames },
    );
    const alphaBeforeSave = saveState(evidence, alpha, alpha.beforeArchive, "before_message_inspection");
    const bravoBeforeSave = saveState(evidence, bravo, bravo.beforeArchive, "before_message_inspection");
    const stateBefore = {
      alpha: archiveDigestProjection(operationDocument(alphaBeforeSave)),
      bravo: archiveDigestProjection(operationDocument(bravoBeforeSave)),
    };
    assertion(
      evidence,
      "integration.public_state_archive_digests_present",
      alphaBeforeSave.exitCode === 0
        && bravoBeforeSave.exitCode === 0
        && stateBefore.alpha !== null
        && stateBefore.bravo !== null,
      stateBefore,
    );

    const alphaInspection = operationDocument(inspectMessages(evidence, alpha));
    const bravoInspection = operationDocument(inspectMessages(evidence, bravo));
    const alphaDiagnosis = operationDocument(diagnoseMessages(evidence, alpha));
    const bravoDiagnosis = operationDocument(diagnoseMessages(evidence, bravo));
    const alphaInspectionSummary = inspectionSummary(alphaInspection);
    const bravoInspectionSummary = inspectionSummary(bravoInspection);
    const alphaDiagnosisSummary = diagnosisSummary(alphaDiagnosis);
    const bravoDiagnosisSummary = diagnosisSummary(bravoDiagnosis);
    evidence.publicControl = {
      alpha: {
        inspection: alphaInspectionSummary,
        diagnosis: alphaDiagnosisSummary,
      },
      bravo: {
        inspection: bravoInspectionSummary,
        diagnosis: bravoDiagnosisSummary,
      },
    };

    assertion(
      evidence,
      "integration.public_messages.inspect",
      alphaInspection?.status === "success"
        && bravoInspection?.status === "success"
        && alphaInspectionSummary?.instanceId === alpha.name
        && bravoInspectionSummary?.instanceId === bravo.name
        && alphaInspectionSummary?.incarnation === alphaRecord.instanceId
        && bravoInspectionSummary?.incarnation === bravoRecord.instanceId
        && alphaInspectionSummary?.incarnation !== bravoInspectionSummary?.incarnation,
      { alpha: alphaInspectionSummary, bravo: bravoInspectionSummary },
    );
    assertion(
      evidence,
      "integration.public_messages.diagnose",
      alphaDiagnosis?.status === "success"
        && bravoDiagnosis?.status === "success"
        && alphaDiagnosisSummary?.healthy === true
        && bravoDiagnosisSummary?.healthy === true
        && alphaDiagnosisSummary?.instanceId === alphaInspectionSummary?.instanceId
        && bravoDiagnosisSummary?.instanceId === bravoInspectionSummary?.instanceId,
      { alpha: alphaDiagnosisSummary, bravo: bravoDiagnosisSummary },
    );
    assertion(
      evidence,
      "integration.public_messages.redacted_without_payload_history",
      !containsPayloadHistory(alphaInspection?.data)
        && !containsPayloadHistory(bravoInspection?.data)
        && !containsPayloadHistory(alphaDiagnosis?.data)
        && !containsPayloadHistory(bravoDiagnosis?.data),
    );

    const alphaAfterSave = saveState(evidence, alpha, alpha.afterArchive, "after_message_inspection");
    const bravoAfterSave = saveState(evidence, bravo, bravo.afterArchive, "after_message_inspection");
    const stateAfter = {
      alpha: archiveDigestProjection(operationDocument(alphaAfterSave)),
      bravo: archiveDigestProjection(operationDocument(bravoAfterSave)),
    };
    evidence.durableState = {
      source: "state.save.manifest.included.digestSha256",
      before: stateBefore,
      after: stateAfter,
    };
    assertion(
      evidence,
      "integration.public_state_digests_unchanged",
      alphaAfterSave.exitCode === 0
        && bravoAfterSave.exitCode === 0
        && stateAfter.alpha !== null
        && stateAfter.bravo !== null
        && JSON.stringify(stateBefore.alpha) === JSON.stringify(stateAfter.alpha)
        && JSON.stringify(stateBefore.bravo) === JSON.stringify(stateAfter.bravo),
      evidence.durableState,
    );
  } finally {
    for (const instance of [alpha, bravo]) {
      if (!started.has(instance.key)) continue;
      const stopped = stopInstance(evidence, instance);
      assertion(
        evidence,
        `integration.public_instance.${instance.key}.stop`,
        stopped.exitCode === 0,
        { exitCode: stopped.exitCode },
      );
    }
    if (started.size === 2) {
      const finalList = run(evidence, "integration.public_instances.cleaned_up", shipctl, [
        "instances", "list",
        "--runtime-root", alpha.runtimeRoot,
        "--output", "json",
      ]);
      const finalData = operationDocument(finalList)?.data ?? null;
      assertion(
        evidence,
        "integration.public_instances.cleaned_up",
        finalList.exitCode === 0 && finalData?.count === 0 && finalData?.problems?.length === 0,
        { count: finalData?.count ?? null, problems: finalData?.problems?.length ?? null },
      );
    }
    evidence.defaultProfile = {
      stateRootUntouched: !existsSync(guardedStateRoot),
      runtimeRootUntouched: !existsSync(guardedRuntimeRoot),
    };
    assertion(
      evidence,
      "integration.default_profile_untouched",
      evidence.defaultProfile.stateRootUntouched && evidence.defaultProfile.runtimeRootUntouched,
    );
    evidence.hostBinary.after = { cli: fingerprint(shipctl), ui: fingerprint(shipctlUi) };
    assertion(
      evidence,
      "integration.host_binary_unchanged",
      JSON.stringify(evidence.hostBinary.after) === JSON.stringify(evidence.hostBinary.before),
    );
  }

  return finish(evidence);
}

function finish(evidence) {
  evidence.finishedAt = new Date().toISOString();
  evidence.status = evidence.assertions.every((item) => item.passed) ? "success" : "failure";
  return evidence;
}

function writeEvidence(evidence) {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidencePath = path.join(evidenceDirectory, `${evidence.proof}-${runId}.json`);
  const temporary = `${evidencePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, evidencePath);
  return evidencePath;
}

function main(selectedMode) {
  let evidence;
  try {
    if (selectedMode === "contract") evidence = contractProof();
    else if (selectedMode === "integration") evidence = integrationProof();
    else {
      const contract = contractProof();
      const integration = integrationProof();
      evidence = createEvidence("all");
      evidence.contract = contract;
      evidence.integration = integration;
      for (const item of [...contract.assertions, ...integration.assertions]) {
        evidence.assertions.push({ ...item, name: `${item.name}` });
      }
      evidence.diagnostics.push(...contract.diagnostics, ...integration.diagnostics);
      finish(evidence);
    }
  } catch {
    evidence ??= createEvidence(selectedMode);
    evidence.diagnostics.push({
      code: "message.proof.unexpected_failure",
      summary: "The bus-only proof terminated before producing complete redacted evidence.",
    });
    evidence.status = "failure";
    evidence.finishedAt = new Date().toISOString();
  } finally {
    if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  }
  const evidencePath = writeEvidence(evidence);
  const summary = JSON.stringify({ status: evidence.status, evidencePath });
  if (evidence.status === "success") process.stdout.write(`${summary}\n`);
  else {
    process.stderr.write(`${summary}\n`);
    process.exitCode = 1;
  }
}
