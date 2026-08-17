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
const evidenceDirectory = path.join(repositoryRoot, "target/architecture-evidence/workspace");

function configuredSeed() {
  const argument = process.argv.find((value) => value.startsWith("--seed="));
  if (argument === undefined) return randomBytes(4).readInt32LE(0);
  const seed = Number(argument.slice("--seed=".length));
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  return seed;
}

const seed = configuredSeed();
const testFiles = [
  "ops/architecture/tests/workspaceCapability.test.mjs",
  "ops/architecture/tests/canvasAdapterParity.test.mjs",
  "ops/architecture/tests/workspaceContributionCatalog.test.mjs",
  "ops/architecture/tests/pluginAbsence.test.mjs",
];
const testArguments = ["exec", "node", "--test", "--test-concurrency=1", ...testFiles];
const replayCommand = [
  `SHIPCTL_PROPERTY_SEED=${seed}`,
  "pnpm exec node --test --test-concurrency=1",
  ...testFiles,
].join(" ");

const { stdout, stderr } = await exec("pnpm", testArguments, {
  cwd: repositoryRoot,
  env: { ...process.env, SHIPCTL_PROPERTY_SEED: String(seed) },
});
process.stdout.write(stdout);
process.stderr.write(stderr);

await mkdir(evidenceDirectory, { recursive: true });
const repository = await repositoryIdentity(repositoryRoot);
const fastCheckVersion = require("fast-check/package.json").version;
const properties = [
  {
    propertyId: "PROP-G-WORKSPACE-001",
    testId: "architecture.workspace-reconcile.property",
    classifications: {
      catalog: ["added", "replaced", "missing", "restored"],
      layout: ["moved", "focused", "split"],
    },
  },
  {
    propertyId: "PROP-G-RENDERER-001",
    testId: "architecture.canvas-adapter-parity.property",
    classifications: {
      topology: ["single-stack", "tabs"],
      action: ["select", "close", "select-noop"],
      availability: ["available", "missing"],
    },
  },
  {
    propertyId: "PROP-G-LAYMAN-MOVE-001",
    testId: "architecture.layman-semantic-move.property",
    classifications: {
      topology: ["two-tiled-stacks"],
      action: ["center-move", "source-retained", "source-collapsed", "target-append"],
      availability: ["available", "missing"],
    },
  },
  {
    propertyId: "PROP-G-LAYMAN-SPLIT-001",
    testId: "architecture.layman-semantic-split.property",
    classifications: {
      topology: ["two-tiled-stacks"],
      action: ["edge-split", "horizontal", "vertical", "before", "after"],
      identity: ["semantic-action", "renderer-local-window"],
    },
  },
  {
    propertyId: "PROP-G-LAYOUT-001",
    testId: "architecture.workspace-roundtrip.property",
    classifications: {
      topology: ["tabs", "splits", "floating"],
      retention: ["identity", "plugin-state", "missing"],
    },
  },
  {
    propertyId: "PROP-G-CONTRIBUTION-SCHEMA-001",
    testId: "architecture.workspace-contribution-schema.property",
    classifications: {
      declaration: ["valid", "layman-node", "renderer-prop", "eager-view", "missing-identity"],
    },
  },
  {
    propertyId: "PROP-G-CONTRIBUTION-CLEANUP-001",
    testId: "architecture.contribution-cleanup.property",
    classifications: {
      lifecycle: ["replacement", "failed-candidate", "removal", "re-add"],
      family: [
        "command",
        "panel",
        "global-surface",
        "global-navigation",
        "sidebar",
        "project-navigation",
        "project-layout",
        "project-action",
        "settings",
      ],
      observable: [
        "workspace-view",
        "style",
        "command-route",
        "menu",
        "navigation",
        "component-cache",
      ],
    },
  },
  {
    propertyId: "PROP-G-ABSENCE-001",
    testId: "architecture.plugin-absence.property",
    classifications: {
      subset: ["empty-optional", "singleton", "mixed"],
      candidate: ["load-failure", "not-ready"],
    },
  },
];

const evidenceFiles = [];
for (const property of properties) {
  const evidence = propertyEvidence({
    ...property,
    phaseId: "phase-g",
    language: "typescript",
    library: "fast-check",
    version: fastCheckVersion,
    repository,
    seed,
    replayCommand,
    result: "pass",
    deletionGates: ["DELETE-G-STATIC-WORKSPACE"],
  });
  const file = path.join(evidenceDirectory, `${property.propertyId}.evidence.json`);
  await writePropertyEvidence({ repositoryRoot, file, evidence });
  evidenceFiles.push(path.relative(repositoryRoot, file));
}

process.stdout.write(`${JSON.stringify({ ok: true, seed, evidence_files: evidenceFiles }, null, 2)}\n`);
