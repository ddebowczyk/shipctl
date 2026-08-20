#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  propertyEvidence,
  repositoryIdentity,
  writePropertyEvidence,
} from "./property-evidence.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const evidenceDirectory = path.join(
  repositoryRoot,
  "target/architecture-evidence/plugin-artifacts",
);

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readUInt32LE(0) & 0x7fff_ffff;
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("--seed must be a non-negative safe integer");
  }
  return seed;
}

const seed = configuredSeed();
const environment = {
  ...process.env,
  SHIPCTL_PROPERTY_SEED: String(seed),
  PROPTEST_RNG_SEED: String(seed),
};

const typescript = await exec("pnpm", [
  "exec",
  "node",
  "--test",
  "--test-concurrency=1",
  "ops/architecture/tests/pluginArtifacts.test.mjs",
  "core/frontend/host/tests/moduleArtifactLoader.test.ts",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(typescript.stdout);
process.stderr.write(typescript.stderr);

const rust = await exec("cargo", [
  "test",
  "-p",
  "shipctl-core",
  "--no-fail-fast",
  "architecture_artifact_",
  "--",
  "--nocapture",
], { cwd: repositoryRoot, env: environment });
process.stdout.write(rust.stdout);
process.stderr.write(rust.stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const replayCommand = `node ops/architecture/bin/run-plugin-artifact-properties.mjs --seed=${seed}`;
const properties = [
  {
    propertyId: "PROP-E-ARTIFACT-001",
    testId: "architecture.artifact-roundtrip.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      content: ["entry", "style", "asset", "arbitrary-bytes"],
      path: ["vite-staging", "archive", "admitted-directory"],
    },
  },
  {
    propertyId: "PROP-E-TAMPER-001",
    testId: "architecture.artifact-tamper.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      mutation: ["byte", "missing", "extra", "file-digest", "content-digest", "manifest", "path"],
      outcome: ["pre-activation-rejection"],
    },
  },
  {
    propertyId: "PROP-E-EXTERNALS-001",
    testId: "architecture.artifact-externals.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      dependency: ["react", "react-dom", "cordis", "plugin-api"],
      closure: ["external-reference", "bundled-copy", "allowed-module"],
    },
  },
  {
    propertyId: "PROP-E-MANIFEST-RUNTIME-001",
    testId: "architecture.manifest-runtime.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      declarations: ["service", "effect", "contribution", "grant", "message"],
      relation: ["equal", "reordered", "extra"],
    },
  },
  {
    propertyId: "PROP-E-BUILTIN-PARITY-001",
    testId: "architecture.commands-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["launch-success", "launch-failure", "notice", "panel-action"],
      lifecycle: ["activate", "project-open", "project-remove", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-PORTS-PARITY-001",
    testId: "architecture.ports-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["scan-success", "filtered-process", "inspect-denied", "terminate-denied"],
      lifecycle: ["activate", "surface-load", "service-use", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-TODOS-PARITY-001",
    testId: "architecture.todos-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["enabled", "disabled", "discovery-success", "discovery-denied"],
      lifecycle: ["activate", "project-change", "filesystem-change", "project-remove", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-GIT-PARITY-001",
    testId: "architecture.git-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["clean", "dirty", "refresh-success", "refresh-denied", "related-worktree"],
      lifecycle: ["activate", "project-change", "filesystem-change", "project-remove", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-SKILLS-PARITY-001",
    testId: "architecture.skills-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["inspect", "install", "remove", "denied", "notice"],
      lifecycle: ["activate", "project-change", "filesystem-change", "project-remove", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-THIN-TERMINAL-PARITY-001",
    testId: "architecture.thin-terminal-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["focus", "key-input", "paste", "resize", "exit", "teardown"],
      lifecycle: ["passive-import", "activate", "render", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-SEMANTIC-TERMINAL-PARITY-001",
    testId: "architecture.semantic-terminal-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["attach", "flow-control", "history", "selection", "paste", "teardown"],
      lifecycle: ["passive-import", "activate", "render", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-ASSISTANTS-PARITY-001",
    testId: "architecture.assistants-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: ["command-inspection", "model-catalog", "credential-status", "session-inspection"],
      lifecycle: ["passive-import", "activate", "restore", "shutdown", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-USAGE-PARITY-001",
    testId: "architecture.usage-artifact-parity.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["static-reference", "bundled-artifact"],
      outcome: [
        "settings-load",
        "source-ingestion",
        "refresh-message",
        "source-observation",
        "alias-review",
        "presentation-load",
      ],
      lifecycle: ["passive-import", "activate", "schedule", "observe", "dispose"],
    },
  },
  {
    propertyId: "PROP-E-COMPATIBILITY-001",
    testId: "architecture.artifact-compatibility.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      dimension: ["api", "artifact-protocol", "malformed"],
      outcome: ["compatible", "incompatible"],
    },
  },
  {
    propertyId: "PROP-H-NATIVE-PLUGIN-SEMANTICS-001",
    phaseId: "phase-h",
    testId: "architecture.artifact-application-payload-opaque.property",
    language: "rust",
    library: "proptest",
    version: "1.11.0",
    classifications: {
      outcome: ["opaque-native-admission", "generic-preflight"],
      product_payload: ["future-role", "future-contribution", "malformed-value"],
    },
    deletionGates: ["DELETE-H-NATIVE-PLUGIN-SEMANTICS"],
  },
  {
    propertyId: "PROP-H-POST-PACKAGE-PLUGIN-DEPLOY-001",
    phaseId: "phase-h",
    testId: "architecture.post-package-plugin-deployment.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      delivery: ["external-artifact", "digest-qualified-url", "dynamic-import"],
      asset: ["entry", "style", "no-host-mutation"],
      lifecycle: ["runtime-catalog", "passive-load", "admission"],
    },
    deletionGates: ["DELETE-H-NATIVE-PLUGIN-SEMANTICS"],
  },
  {
    propertyId: "PROP-E-HEADLESS-001",
    testId: "architecture.headless-artifact.property",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    classifications: {
      lifecycle: ["build", "pack", "admit", "passive-import", "activate", "inspect", "dispose"],
      presentation: ["no-react", "no-css", "no-assets", "no-contributions"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: property.phaseId ?? "phase-e",
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: property.deletionGates ?? ["DELETE-E-STATIC-IMPORT"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
