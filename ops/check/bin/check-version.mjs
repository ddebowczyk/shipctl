import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));

// The one place the application version is declared. Tauri compiles this into
// PackageInfo, so the About panel, `getVersion()`, the macOS bundle version,
// and the updater's current-version comparison all resolve to it. Cargo only
// supplies CARGO_PKG_VERSION as a fallback when the config omits the field.
const SOURCE = "src-tauri/tauri.conf.json";

// Cargo and npm both require a version field, so internal manifests carry a
// placeholder rather than a second copy of the app version that can drift.
const PLACEHOLDER = "0.0.0";

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "builds", ".git"]);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readToml(file) {
  return JSON.parse(execFileSync("yq", ["-p=toml", "-o=json", ".", file], { encoding: "utf8" }));
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

export function validateVersions(root) {
  const failures = [];
  const fail = (file, message) => failures.push(`${file}: ${message}`);

  const sourcePath = path.join(root, SOURCE);
  if (!existsSync(sourcePath)) return [`${SOURCE}: does not exist`];

  const version = readJson(sourcePath).version;
  if (version === undefined) {
    fail(SOURCE, "must declare the app version");
  } else if (!SEMVER.test(version)) {
    // Tauri also accepts a path to a package.json here, but it resolves that
    // path against the caller's working directory, so the same config would
    // yield different versions depending on which tool read it.
    fail(SOURCE, `version must be a literal semver string, got ${JSON.stringify(version)}`);
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
  const profilesDir = path.join(root, "profiles");
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

  return failures;
}

export function runVersionCheck(root) {
  const failures = validateVersions(root);
  if (failures.length > 0) {
    console.error(`App version drift:\n\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
    return 1;
  }
  const { version } = readJson(path.join(root, SOURCE));
  console.log(`App version ${version} is declared once, in ${SOURCE}.`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runVersionCheck(path.resolve(process.argv[2] ?? defaultRoot));
}
