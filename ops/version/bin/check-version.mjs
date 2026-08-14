import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compareStableVersions, latestLocalReleaseVersion, STABLE_SEMVER } from "./release-history.mjs";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Operator intent lives here. Tauri needs its own JSON projection at packaging
// time, and this check prevents that generated requirement from becoming a
// competing source of product identity.
const SOURCE = "ops/version/current.yaml";
const TAURI_PROJECTION = "src-tauri/tauri.conf.json";

// Cargo and npm both require a version field, so internal manifests carry a
// placeholder rather than a second copy of the app version that can drift.
const PLACEHOLDER = "0.0.0";

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "builds", ".git"]);
const STATE_FIELDS = new Set([
  "schema_version",
  "product",
  "product_version",
  "description",
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readToml(file) {
  return JSON.parse(execFileSync("yq", ["-p=toml", "-o=json", ".", file], { encoding: "utf8" }));
}

function readYaml(file) {
  return JSON.parse(execFileSync("yq", ["-o=json", ".", file], { encoding: "utf8" }));
}

function manifests(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name === "package.json" || entry.name === "Cargo.toml") {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

export function validateVersions(root, { checkReleaseHistory = true } = {}) {
  const failures = [];
  const fail = (file, message) => failures.push(`${file}: ${message}`);

  const sourcePath = path.join(root, SOURCE);
  if (!existsSync(sourcePath)) return [`${SOURCE}: does not exist`];

  const state = readYaml(sourcePath);
  for (const field of Object.keys(state)) {
    if (!STATE_FIELDS.has(field)) fail(SOURCE, `contains unsupported field ${JSON.stringify(field)}`);
  }
  if (state.schema_version !== 1) fail(SOURCE, "schema_version must be 1");
  const version = state.product_version;
  if (version === undefined) {
    fail(SOURCE, "must declare product_version");
  } else if (!STABLE_SEMVER.test(version)) {
    fail(SOURCE, `product_version must be a literal stable semver string, got ${JSON.stringify(version)}`);
  }
  if (state.product !== "shipctl") {
    fail(SOURCE, `product must be "shipctl", got ${JSON.stringify(state.product)}`);
  }
  if (typeof state.description !== "string" || state.description.length === 0) {
    fail(SOURCE, "description must be a non-empty string");
  }

  const tauriPath = path.join(root, TAURI_PROJECTION);
  if (!existsSync(tauriPath)) {
    fail(TAURI_PROJECTION, "does not exist");
  } else {
    const projected = readJson(tauriPath).version;
    if (projected !== version) {
      fail(
        TAURI_PROJECTION,
        `packaging version ${JSON.stringify(projected)} must match ${SOURCE} ${JSON.stringify(version)}`,
      );
    }
  }

  for (const file of manifests(root)) {
    const relative = path.relative(root, file);

    if (path.basename(file) === "package.json") {
      const declared = readJson(file).version;
      if (declared !== undefined && declared !== PLACEHOLDER) {
        fail(relative, `version must be ${PLACEHOLDER}; ${SOURCE} is the single source`);
      }
      continue;
    }

    const parsed = readToml(file);
    if (parsed.workspace?.package?.version !== undefined) {
      fail(relative, `[workspace.package] must not declare a version; ${SOURCE} is the single source`);
    }
    const declared = parsed.package?.version;
    if (declared === undefined) continue;
    if (typeof declared === "object") {
      fail(relative, `version must not be inherited; set it to ${PLACEHOLDER}`);
    } else if (declared !== PLACEHOLDER) {
      fail(relative, `version must be ${PLACEHOLDER}; ${SOURCE} is the single source`);
    }
  }

  // Profile overlays are merged over the base config at build time, so a
  // version here would silently ship a different number than a normal build.
  const profilesDir = path.join(root, "ops/modularity/profiles");
  if (existsSync(profilesDir)) {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const overlay = path.join(profilesDir, entry.name, "tauri.conf.json");
      if (existsSync(overlay) && readJson(overlay).version !== undefined) {
        fail(
          path.relative(root, overlay),
          `must not override the app version; ${SOURCE} is the single source`,
        );
      }
    }
  }

  if (checkReleaseHistory && STABLE_SEMVER.test(version)) {
    const latestRelease = latestLocalReleaseVersion(root);
    if (latestRelease !== null && compareStableVersions(version, latestRelease) < 0) {
      fail(
        SOURCE,
        `product_version ${JSON.stringify(version)} must not precede local release tag v${latestRelease}`,
      );
    }
  }

  return failures;
}

export function runVersionCheck(root) {
  const failures = validateVersions(root);
  if (failures.length > 0) {
    console.error(`App version drift:\n\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
    return 1;
  }
  const { product_version: version } = readYaml(path.join(root, SOURCE));
  console.log(`Shipctl product version ${version} is authoritative in ${SOURCE}.`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runVersionCheck(path.resolve(process.argv[2] ?? defaultRoot));
}
