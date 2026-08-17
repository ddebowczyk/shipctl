import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const NATIVE_MODULE_FEATURES = Object.freeze([
  "assistants-module",
]);

export function removeNativeModuleFeatureFromScripts(packageJson, featureName) {
  if (!NATIVE_MODULE_FEATURES.includes(featureName)) {
    throw new Error(`Unknown native module feature: ${featureName}`);
  }

  for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
    if (typeof command !== "string") continue;
    packageJson.scripts[scriptName] = command.replace(
      /(--features\s+)([^\s]+)/g,
      (match, prefix, featureList) => {
        const features = featureList.split(",");
        if (!features.includes(featureName)) return match;
        const remaining = features.filter((feature) => feature !== featureName);
        return remaining.length > 0 ? `${prefix}${remaining.join(",")}` : "";
      },
    );
  }
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
    "core/frontend/host/enabledModules.ts",
    `import { ${variableName} } from "${packageName}";\n`,
    "",
  );
  replaceOnce(
    root,
    "core/frontend/host/enabledModules.ts",
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

export function verifyModulePlugout({
  repositoryRoot,
  moduleName,
  verifyEnabled,
  verifyDisabled,
  verifySourceAbsent,
  sourceAbsentOnly = false,
}) {
  if (!sourceAbsentOnly) {
    verifyEnabled(repositoryRoot);
    verifyDisabled(repositoryRoot);
  }

  verifySourceAbsent(repositoryRoot);
  const verifiedProfiles = sourceAbsentOnly
    ? "source-absent static contract"
    : "enabled, disabled, and source-absent static contracts";
  process.stdout.write(`\n${moduleName} ${verifiedProfiles}: OK (no rebuild)\n`);
}
