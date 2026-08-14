#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const MAP_PATH = "ops/repository/root-map.yaml";
const SCHEMA_PATH = path.join(repositoryRoot, "ops/repository/schema/root-map.schema.yaml");

function diagnostic(rule, message, file = null) {
  return { rule, message, file };
}

function readYaml(file) {
  return JSON.parse(execFileSync("yq", ["-o=json", ".", file], { encoding: "utf8" }));
}

function schemaDiagnostics(root) {
  const map = path.join(root, MAP_PATH);
  try {
    execFileSync("ys", ["-f", SCHEMA_PATH, map], { encoding: "utf8" });
    return [];
  } catch (error) {
    return [diagnostic(
      "root-map-schema",
      (error.stdout || error.stderr || error.message).trim(),
      MAP_PATH,
    )];
  }
}

function entryKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

export function rootEntries(root) {
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => ({ path: entry.name, kind: entryKind(entry) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readRootMap(root) {
  return readYaml(path.join(root, MAP_PATH));
}

export function validateRootMap(root) {
  const diagnostics = schemaDiagnostics(root);
  let map;
  try {
    map = readRootMap(root);
  } catch (error) {
    return [
      ...diagnostics,
      diagnostic("root-map-read", (error.stderr || error.message).trim(), MAP_PATH),
    ];
  }
  if (diagnostics.length > 0) return diagnostics;

  const groups = new Map();
  for (const group of map.groups) {
    if (groups.has(group.id)) {
      diagnostics.push(diagnostic("duplicate-root-group", `${group.id} is declared more than once`, MAP_PATH));
    }
    groups.set(group.id, group);
  }
  if (!groups.has("unknown")) {
    diagnostics.push(diagnostic("missing-unknown-group", "declare the reserved unknown holding group", MAP_PATH));
  }

  const mapped = new Map();
  for (const entry of map.entries) {
    if (mapped.has(entry.path)) {
      diagnostics.push(diagnostic("duplicate-root-entry", `${entry.path} is mapped more than once`, MAP_PATH));
      continue;
    }
    mapped.set(entry.path, entry);
    if (!groups.has(entry.group)) {
      diagnostics.push(diagnostic("unknown-root-group", `${entry.path} uses undeclared group ${entry.group}`, MAP_PATH));
    }
  }

  const actual = new Map(rootEntries(root).map((entry) => [entry.path, entry]));
  for (const [entryPath, entry] of actual) {
    const mapping = mapped.get(entryPath);
    if (!mapping) {
      diagnostics.push(diagnostic(
        "unmapped-root-entry",
        `${entryPath} is present at the repository root but absent from ${MAP_PATH}`,
        entryPath,
      ));
      continue;
    }
    if (mapping.kind !== entry.kind) {
      diagnostics.push(diagnostic(
        "root-entry-kind",
        `${entryPath} is a ${entry.kind}, but the map declares ${mapping.kind}`,
        entryPath,
      ));
    }
    if (mapping.group === "unknown") {
      diagnostics.push(diagnostic(
        "root-entry-needs-classification",
        `${entryPath} is explicitly unknown: ${mapping.description}`,
        entryPath,
      ));
    }
  }
  for (const [entryPath] of mapped) {
    if (!actual.has(entryPath)) {
      diagnostics.push(diagnostic(
        "stale-root-entry",
        `${entryPath} is mapped but no longer exists at the repository root`,
        MAP_PATH,
      ));
    }
  }
  return diagnostics.sort((left, right) =>
    `${left.file ?? ""}:${left.rule}:${left.message}`.localeCompare(
      `${right.file ?? ""}:${right.rule}:${right.message}`,
    ),
  );
}

export function renderRootMap(root) {
  const map = readRootMap(root);
  const lines = ["Repository root map:"];
  for (const group of map.groups) {
    const entries = map.entries
      .filter((entry) => entry.group === group.id)
      .sort((left, right) => left.path.localeCompare(right.path));
    lines.push("", `${group.id}: ${group.description}`);
    for (const entry of entries) lines.push(`  ${entry.path} — ${entry.description}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatDiagnostics(diagnostics) {
  return diagnostics.map(({ rule, message, file }) => `${file ? `${file}: ` : ""}[${rule}] ${message}`).join("\n");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "check";
  if (command === "show") {
    process.stdout.write(renderRootMap(repositoryRoot));
  } else if (command === "check") {
    const diagnostics = validateRootMap(repositoryRoot);
    if (diagnostics.length > 0) {
      process.stderr.write(`${formatDiagnostics(diagnostics)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Repository root map: OK\n");
    }
  } else {
    process.stderr.write("Usage: root-map.mjs <show|check>\n");
    process.exitCode = 2;
  }
}
