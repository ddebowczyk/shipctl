import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateVersions } from "./check-version.mjs";
import {
  compareStableVersions,
  latestLocalReleaseVersion,
  nextStableVersion,
  STABLE_SEMVER,
} from "./release-history.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const statePath = path.join(root, "ops/version/current.yaml");
const tauriPath = path.join(root, "src-tauri/tauri.conf.json");

export function replaceYamlProductVersion(source, version) {
  const matches = [...source.matchAll(
    /^([ \t]*product_version:[ \t]*)(?:"[^"]*"|'[^']*'|[^ \t#\r\n]+)([ \t]*(?:#.*)?)(\r?\n|$)/gm,
  )];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one product_version field, found ${matches.length}`);
  }
  const match = matches[0];
  return `${source.slice(0, match.index)}${match[1]}${version}${match[2]}${match[3]}${source.slice(match.index + match[0].length)}`;
}

export function replaceTauriProductVersion(source, version) {
  const matches = [...source.matchAll(/^([ \t]*"version"[ \t]*:[ \t]*)"[^"]*"([ \t]*,?[ \t]*)$/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Tauri version field, found ${matches.length}`);
  }
  const match = matches[0];
  return `${source.slice(0, match.index)}${match[1]}"${version}"${match[2]}${source.slice(match.index + match[0].length)}`;
}

function readState() {
  return JSON.parse(execFileSync("yq", ["-o=json", ".", statePath], { encoding: "utf8" }));
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

function check({ checkReleaseHistory = true } = {}) {
  const failures = validateVersions(root, { checkReleaseHistory });
  if (failures.length > 0) {
    fail(`product version drift:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
    return false;
  }
  return true;
}

function show() {
  const state = readState();
  const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
  const latestRelease = latestLocalReleaseVersion(root);
  const relation = latestRelease === null
    ? "no-local-release"
    : compareStableVersions(state.product_version, latestRelease) < 0
      ? "behind-local-release"
      : compareStableVersions(state.product_version, latestRelease) === 0
        ? "matches-local-release"
        : "ahead-of-local-release";
  const failures = validateVersions(root);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    product: state.product,
    productVersion: state.product_version,
    authority: "ops/version/current.yaml",
    projections: { "src-tauri/tauri.conf.json": tauri.version },
    releaseLedger: {
      latestLocalTag: latestRelease === null ? null : `v${latestRelease}`,
      relation,
    },
    valid: failures.length === 0,
    problems: failures,
  }, null, 2)}\n`);
}

function next(part) {
  if (!check({ checkReleaseHistory: false })) return;
  if (!["patch", "minor", "major"].includes(part)) {
    fail(`next requires patch, minor, or major; got ${JSON.stringify(part)}`);
    return;
  }
  const current = readState().product_version;
  const latestRelease = latestLocalReleaseVersion(root);
  const base = latestRelease !== null && compareStableVersions(latestRelease, current) > 0
    ? latestRelease
    : current;
  process.stdout.write(`${nextStableVersion(base, part)}\n`);
}

function setVersion(requested) {
  // Allow this command to repair a source version that is behind the release
  // ledger, while still requiring every non-history invariant to hold.
  if (!check({ checkReleaseHistory: false })) return;
  if (!STABLE_SEMVER.test(requested ?? "")) {
    fail(`version must be stable SemVer, got ${JSON.stringify(requested)}`);
    return;
  }

  const current = readState().product_version;
  const latestRelease = latestLocalReleaseVersion(root);
  if (requested === current) {
    fail(`version is already ${requested}`);
    return;
  }
  if (compareStableVersions(requested, current) <= 0) {
    fail(`version ${requested} must be greater than current product version ${current}`);
    return;
  }
  if (latestRelease !== null && compareStableVersions(requested, latestRelease) <= 0) {
    fail(`version ${requested} must be greater than local release tag v${latestRelease}`);
    return;
  }

  const stateTemporary = `${statePath}.tmp`;
  const tauriTemporary = `${tauriPath}.tmp`;
  try {
    const stateYaml = replaceYamlProductVersion(readFileSync(statePath, "utf8"), requested);
    const tauriJson = replaceTauriProductVersion(readFileSync(tauriPath, "utf8"), requested);
    writeFileSync(stateTemporary, stateYaml);
    writeFileSync(tauriTemporary, tauriJson);

    execFileSync("ys", ["-f", "ops/version/schema/current.v1.schema.yaml", stateTemporary], {
      cwd: root,
      stdio: "pipe",
    });
    JSON.parse(tauriJson);
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

function git(args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", ...options }).trim();
}

function verifyRelease() {
  if (!check()) return;

  const version = readState().product_version;
  const tag = `v${version}`;
  let objectType;
  try {
    objectType = git(["cat-file", "-t", `refs/tags/${tag}`]);
  } catch {
    fail(`release tag ${tag} does not exist`);
    return;
  }
  if (objectType !== "tag") {
    fail(`release tag ${tag} must be annotated`);
    return;
  }

  const tagCommit = git(["rev-parse", `${tag}^{commit}`]);
  const headCommit = git(["rev-parse", "HEAD"]);
  if (tagCommit !== headCommit) {
    fail(`release tag ${tag} points to ${tagCommit}, not HEAD ${headCommit}`);
    return;
  }
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") {
    fail(`release source is not clean:\n${status}`);
    return;
  }
  const latestRelease = latestLocalReleaseVersion(root);
  if (latestRelease !== version) {
    fail(`release tag ${tag} is not the latest local stable release tag`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    productVersion: version,
    tag,
    commit: headCommit,
    tagKind: "annotated",
    sourceClean: true,
    latestLocalTag: tag,
  }, null, 2)}\n`);
}

function syncReleaseTags() {
  try {
    execFileSync("git", ["-C", root, "fetch", "--tags", "origin"], { stdio: "inherit" });
  } catch {
    fail("could not fetch release tags from origin");
    return;
  }
  process.stdout.write("Release tags from origin: synchronized\n");
}

function main(command, argument) {
  if (command === "show") show();
  else if (command === "check") {
    if (check()) process.stdout.write(`Shipctl product version ${readState().product_version}: OK\n`);
  } else if (command === "next") next(argument);
  else if (command === "set") setVersion(argument);
  else if (command === "verify-release" && argument === undefined) verifyRelease();
  else if (command === "sync") syncReleaseTags();
  else fail("usage: just version show|check|next <patch|minor|major>|set <semver>|verify-release|sync");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  main(command, argument);
}
