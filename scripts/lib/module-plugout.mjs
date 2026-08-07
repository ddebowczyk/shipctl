import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

export function run(
  command,
  args,
  cwd,
  env = {},
  { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `${command} timed out after ${Math.round(timeoutMs / 1000)} seconds`,
      { cause: result.error },
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

export function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

export function replaceOnce(root, relativePath, expected, replacement) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf8");
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`Expected one plug-out marker in ${relativePath}`);
  }
  writeFileSync(file, source.replace(expected, replacement));
}

export function removeFrontendModuleComposition(root, packageName, variableName) {
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    `import { ${variableName} } from "${packageName}";\n`,
    "",
  );
  replaceOnce(
    root,
    "src/core/modules/enabledModules.ts",
    `  ${variableName},\n`,
    "",
  );
}

export function removeCargoDefaultFeature(root, featureName) {
  const relativePath = "src-tauri/Cargo.toml";
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf8");
  const match = source.match(/^default = (\[[^\n]*\])$/m);
  if (!match) throw new Error(`Expected one default feature list in ${relativePath}`);
  const features = JSON.parse(match[1]);
  const remaining = features.filter((feature) => feature !== featureName);
  if (remaining.length !== features.length - 1) {
    throw new Error(`Expected default feature ${featureName} in ${relativePath}`);
  }
  writeFileSync(file, source.replace(match[0], `default = ${JSON.stringify(remaining)}`));
}

export function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

export function writeJson(root, relativePath, value) {
  writeFileSync(
    path.join(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function exportWorktree(repositoryRoot, destination) {
  const trackedAndUnignored = capture(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repositoryRoot,
  );
  for (const relativePath of trackedAndUnignored.split("\0").filter(Boolean)) {
    const source = path.join(repositoryRoot, relativePath);
    if (!existsSync(source)) continue;
    const target = path.join(destination, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
    }
  }
}

function assertDependencyGraphsAbsent(root, packages) {
  if (packages.pnpm) {
    const workspacePackages = JSON.parse(
      capture("pnpm", ["--recursive", "list", "--depth", "-1", "--json"], root),
    );
    if (workspacePackages.some(({ name }) => name === packages.pnpm)) {
      throw new Error(`${packages.pnpm} remains in the pnpm workspace graph`);
    }
  }

  if (packages.cargo) {
    const metadata = JSON.parse(capture(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "src-tauri/Cargo.toml"],
      root,
    ));
    if (metadata.packages.some(({ name }) => name === packages.cargo)) {
      throw new Error(`${packages.cargo} remains in the Cargo workspace graph`);
    }
  }
}

function withDisposableCopy(repositoryRoot, prefix, callback) {
  const temporaryPrefix = path.join(os.tmpdir(), prefix);
  const temporaryRoot = mkdtempSync(temporaryPrefix);
  try {
    exportWorktree(repositoryRoot, temporaryRoot);
    callback(temporaryRoot);
  } finally {
    if (!temporaryRoot.startsWith(temporaryPrefix)) {
      throw new Error(`Refusing to remove unexpected path: ${temporaryRoot}`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function verifyModulePlugout({
  repositoryRoot,
  moduleName,
  packages,
  verifyEnabled,
  prepareDisabled,
  verifyDisabled,
  prepareSourceAbsent,
  assertSourceAbsent,
  verifySourceAbsent,
  sourceAbsentOnly = false,
}) {
  const discoveredRoot = path.resolve(
    capture("git", ["rev-parse", "--show-toplevel"], repositoryRoot).trim(),
  );
  if (discoveredRoot !== repositoryRoot) {
    throw new Error(`Expected repository root ${repositoryRoot}, found ${discoveredRoot}`);
  }

  if (!sourceAbsentOnly) {
    verifyEnabled(repositoryRoot);
    withDisposableCopy(repositoryRoot, `shep-${moduleName}-disabled-`, (root) => {
      prepareDisabled(root);
      run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], root);
      verifyDisabled(root);
    });
  }

  withDisposableCopy(repositoryRoot, `shep-${moduleName}-source-absent-`, (root) => {
    prepareSourceAbsent(root);
    assertSourceAbsent(root);
    run("pnpm", ["install", "--offline", "--ignore-scripts"], root);
    assertDependencyGraphsAbsent(root, packages);
    verifySourceAbsent(root);
  });

  const verifiedProfiles = sourceAbsentOnly
    ? "source-absent profile"
    : "enabled, disabled, and source-absent profiles";
  process.stdout.write(`\n${moduleName} ${verifiedProfiles}: OK\n`);
}
