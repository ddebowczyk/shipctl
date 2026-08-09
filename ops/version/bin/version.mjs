import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateVersions } from "./check-version.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const statePath = path.join(root, "ops/version/current.yaml");
const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
const semver = /^(\d+)\.(\d+)\.(\d+)$/;

function readState() {
  return JSON.parse(execFileSync("yq", ["-o=json", ".", statePath], { encoding: "utf8" }));
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

function check() {
  const failures = validateVersions(root);
  if (failures.length > 0) {
    fail(`product version drift:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
    return false;
  }
  return true;
}

function show() {
  if (!check()) return;
  const state = readState();
  const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    product: state.product,
    productVersion: state.product_version,
    channel: state.channel,
    milestone: state.milestone,
    authority: "ops/version/current.yaml",
    projections: { "src-tauri/tauri.conf.json": tauri.version },
  }, null, 2)}\n`);
}

function next(part) {
  if (!check()) return;
  if (!["patch", "minor", "major"].includes(part)) {
    fail(`next requires patch, minor, or major; got ${JSON.stringify(part)}`);
    return;
  }
  const current = readState().product_version;
  const match = current.match(semver);
  if (!match) {
    fail(`current product version is not stable SemVer: ${current}`);
    return;
  }
  let [, major, minor, patch] = match.map(Number);
  if (part === "patch") patch += 1;
  if (part === "minor") {
    minor += 1;
    patch = 0;
  }
  if (part === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  }
  process.stdout.write(`${major}.${minor}.${patch}\n`);
}

function setVersion(requested) {
  if (!check()) return;
  if (!semver.test(requested ?? "")) {
    fail(`version must be stable SemVer, got ${JSON.stringify(requested)}`);
    return;
  }

  const current = readState().product_version;
  if (requested === current) {
    fail(`version is already ${requested}`);
    return;
  }

  const stateTemporary = `${statePath}.tmp`;
  const tauriTemporary = `${tauriPath}.tmp`;
  try {
    const stateYaml = execFileSync(
      "yq",
      [`.product_version = "${requested}"`, statePath],
      { encoding: "utf8" },
    );
    const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
    tauri.version = requested;
    writeFileSync(stateTemporary, stateYaml);
    writeFileSync(tauriTemporary, `${JSON.stringify(tauri, null, 2)}\n`);

    execFileSync("ys", ["-f", "ops/version/schema/current.v1.schema.yaml", stateTemporary], {
      cwd: root,
      stdio: "pipe",
    });
    JSON.parse(readFileSync(tauriTemporary, "utf8"));
    renameSync(stateTemporary, statePath);
    renameSync(tauriTemporary, tauriPath);
  } finally {
    rmSync(stateTemporary, { force: true });
    rmSync(tauriTemporary, { force: true });
  }

  if (!check()) return;
  process.stdout.write(`Shipctl product version: ${current} -> ${requested}\n`);
  process.stdout.write("Changed: ops/version/current.yaml, src-tauri/tauri.conf.json\n");
}

const [command, argument] = process.argv.slice(2);
if (command === "show") show();
else if (command === "check") {
  if (check()) process.stdout.write(`Shipctl product version ${readState().product_version}: OK\n`);
} else if (command === "next") next(argument);
else if (command === "set") setVersion(argument);
else fail("usage: just version show|check|next <patch|minor|major>|set <semver>");
