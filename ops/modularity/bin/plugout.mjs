#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  readJson,
  removeCargoDefaultFeature,
  removeNativeModuleFeatureFromScripts,
  verifyModulePlugout,
  writeJson,
} from "./module-plugout.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export function readManifest(root, id) {
  const file = path.join(
    root,
    id === "fixture" ? "examples/module-fixture/module.yaml" : `modules/${id}/module.yaml`,
  );
  if (!existsSync(file)) throw new Error(`Unknown module: ${id}`);
  return JSON.parse(execFileSync("yq", ["-o=json", ".", file], { encoding: "utf8" }));
}

function removeLine(root, relativePath, line) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf8");
  const marker = `${line}\n`;
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Expected one manifest-derived line in ${relativePath}: ${line}`);
  }
  writeFileSync(file, source.replace(marker, ""));
}

function backendDependencies(backend) {
  const dependencies = [{
    crate: backend.crate,
    path: backend.path,
    dependencyAlias: backend.dependency_alias ?? backend.crate,
  }];
  if (backend.host) {
    dependencies.push({
      crate: backend.host.crate,
      path: backend.host.path,
      dependencyAlias: backend.host.dependency_alias,
    });
  }
  return dependencies;
}

function cargoDependencyLine(dependency) {
  const packageProperty = dependency.dependencyAlias === dependency.crate
    ? ""
    : `package = "${dependency.crate}", `;
  return `${dependency.dependencyAlias} = { ${packageProperty}path = "../${dependency.path}", optional = true }`;
}

function cargoFeatureLine(backend) {
  const dependencies = backendDependencies(backend)
    .map(({ dependencyAlias }) => `"dep:${dependencyAlias}"`)
    .join(", ");
  return `${backend.cargo_feature} = [${dependencies}]`;
}

function removeFeatureStatements(root, backend) {
  const relativePath = "src-tauri/src/modules/mod.rs";
  const file = path.join(root, relativePath);
  let source = readFileSync(file, "utf8");
  const cfg = `    #[cfg(feature = "${backend.cargo_feature}")]\n`;
  let removalCount = 0;

  while (source.includes(cfg)) {
    const start = source.indexOf(cfg);
    const statementStart = start + cfg.length;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    let end = -1;
    for (let index = statementStart; index < source.length; index += 1) {
      if (source[index] === "(") parentheses += 1;
      if (source[index] === ")") parentheses -= 1;
      if (source[index] === "[") brackets += 1;
      if (source[index] === "]") brackets -= 1;
      if (source[index] === "{") braces += 1;
      if (source[index] === "}") braces -= 1;
      if (
        source[index] === ";" &&
        parentheses === 0 &&
        brackets === 0 &&
        braces === 0
      ) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) throw new Error(`Unterminated ${backend.cargo_feature} statement`);
    while (source[end] === "\n") end += 1;
    source = `${source.slice(0, start)}${source.slice(end)}`;
    removalCount += 1;
  }

  if (removalCount === 0) {
    throw new Error(`Missing ${backend.cargo_feature} composition in ${relativePath}`);
  }
  writeFileSync(file, source);
}

function removeInverseCfgStatement(root, backend) {
  const relativePath = "src-tauri/src/modules/mod.rs";
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf8");
  const cfg = `    #[cfg(not(feature = "${backend.cargo_feature}"))]\n`;
  const start = source.indexOf(cfg);
  if (start < 0) return;
  const statementEnd = source.indexOf(";", start + cfg.length);
  if (statementEnd < 0) throw new Error(`Unterminated inverse cfg for ${backend.cargo_feature}`);
  let end = statementEnd + 1;
  while (source[end] === "\n") end += 1;
  writeFileSync(file, `${source.slice(0, start)}${source.slice(end)}`);
}

function removeCapability(root, relativePath, identifier) {
  const file = path.join(root, relativePath);
  if (!existsSync(file)) return;
  const config = readJson(root, relativePath);
  const capabilities = config.app?.security?.capabilities;
  if (!Array.isArray(capabilities)) return;
  config.app.security.capabilities = capabilities.filter(
    (entry) => typeof entry !== "object" || entry?.identifier !== identifier,
  );
  writeJson(root, relativePath, config);
}

function tauriConfigs(root) {
  const configs = ["src-tauri/tauri.conf.json"];
  const profiles = path.join(root, "ops/modularity/profiles");
  if (!existsSync(profiles)) return configs;
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relativePath = `ops/modularity/profiles/${entry.name}/tauri.conf.json`;
    if (existsSync(path.join(root, relativePath))) configs.push(relativePath);
  }
  return configs;
}

function removeSmokeDependencies(root, manifest) {
  const relativePath = "ops/modularity/fixtures/panel-host/main.tsx";
  const file = path.join(root, relativePath);
  if (!existsSync(file)) return;
  let source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const namespaces = new Set(
    (manifest.tauri?.permissions ?? []).map((permission) => permission.split(":")[0]),
  );
  const removals = [];
  const walk = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === manifest.frontend.package
    ) {
      removals.push([node.getFullStart(), node.end]);
      return;
    }
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      [...namespaces].some((namespace) => node.expression.text.startsWith(`plugin:${namespace}|`))
    ) {
      removals.push([node.getFullStart(), node.end]);
      return;
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isSourceFile(node.parent) &&
      node.getText(parsed).includes(manifest.frontend.composition_symbol)
    ) {
      removals.push([node.getFullStart(), node.end]);
      return;
    }
    if (
      ts.isVariableStatement(node) &&
      ts.isSourceFile(node.parent) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.initializer
          ?.getText(parsed)
          .includes(manifest.frontend.composition_symbol),
      )
    ) {
      removals.push([node.getFullStart(), node.end]);
      return;
    }
    if (
      node.parent &&
      ts.isArrayLiteralExpression(node.parent) &&
      node.getText(parsed).includes(manifest.frontend.composition_symbol)
    ) {
      const siblings = node.parent.elements;
      const index = siblings.indexOf(node);
      const start = index === 0 ? node.getStart(parsed) : siblings[index - 1].end;
      const end = index === 0 && siblings.length > 1 ? siblings[1].getStart(parsed) : node.end;
      removals.push([start, end]);
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    source = `${source.slice(0, start)}${source.slice(end)}`;
  }
  source = source.replaceAll(
    `${manifest.frontend.composition_symbol}.panels[0].id`,
    'registry.list()[0]?.id ?? ("missing.panel" as ContributionId)',
  );
  writeFileSync(file, source);
}

function assertManifestContract(root, manifest) {
  const fail = (message) => {
    throw new Error(`${manifest.id} manifest contract failed: ${message}`);
  };
  const exists = (relativePath) => existsSync(path.join(root, relativePath));
  const structured = (relativePath, inputFormat) => JSON.parse(execFileSync(
    "yq",
    [`-p=${inputFormat}`, "-o=json", ".", path.join(root, relativePath)],
    { encoding: "utf8" },
  ));
  const capability = (config, identifier) => (config.app?.security?.capabilities ?? []).find(
    (entry) => typeof entry === "object" && entry?.identifier === identifier,
  );
  const sameStrings = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const compact = (value) => value.replace(/\s+/g, "").replaceAll(",)", ")");
  const frontend = manifest.frontend;
  const runtimeArtifact = frontend.delivery === "runtime-artifact";
  const fixtureProfile = manifest.profile && !manifest.profile.includes("-disabled/");
  const frontendPackagePath = path.join(frontend.path, "package.json");

  if (!exists(frontendPackagePath)) fail(`${frontendPackagePath} does not exist`);
  if (readJson(root, frontendPackagePath).name !== frontend.package) {
    fail(`${frontendPackagePath} name does not match ${frontend.package}`);
  }
  const rootDependency = readJson(root, "package.json").dependencies?.[frontend.package];
  if (!fixtureProfile && !runtimeArtifact && rootDependency !== "workspace:*") {
    fail(`package.json must depend on ${frontend.package} as workspace:*`);
  }
  if (!fixtureProfile && runtimeArtifact && rootDependency !== undefined) {
    fail(`package.json must not statically depend on runtime artifact ${frontend.package}`);
  }
  if (runtimeArtifact) {
    if (frontend.composition_symbol) {
      fail("runtime artifact must not declare a static composition symbol");
    }
    for (const relativePath of ["module.template.json", "src/index.ts"]) {
      if (!exists(path.join(frontend.artifact ?? "", relativePath))) {
        fail(`${frontend.artifact}/${relativePath} does not exist`);
      }
    }
  }
  if (frontend.composition_symbol) {
    const compositionPath = fixtureProfile
      ? "ops/modularity/fixtures/module-fixture/enabledModules.ts"
      : "core/frontend/host/enabledModules.ts";
    if (!exists(compositionPath)) fail(`${compositionPath} does not exist`);
    const composition = readFileSync(path.join(root, compositionPath), "utf8");
    const importMarker = `import { ${frontend.composition_symbol} } from "${frontend.package}";`;
    if (!composition.includes(importMarker)) fail(`${compositionPath} must import ${frontend.composition_symbol}`);
    if ((composition.match(new RegExp(`\\b${frontend.composition_symbol}\\b`, "g")) ?? []).length < 2) {
      fail(`${compositionPath} must compose ${frontend.composition_symbol}`);
    }
  }

  const backend = manifest.backend;
  if (backend) {
    const backendPackagePath = path.join(backend.path, "Cargo.toml");
    if (!exists(backendPackagePath)) fail(`${backendPackagePath} does not exist`);
    if (structured(backendPackagePath, "toml").package?.name !== backend.crate) {
      fail(`${backendPackagePath} package does not match ${backend.crate}`);
    }
    if (!exists("src-tauri/Cargo.toml")) fail("src-tauri/Cargo.toml does not exist");
    const cargo = structured("src-tauri/Cargo.toml", "toml");
    const alias = backend.dependency_alias ?? backend.crate;
    const dependency = cargo.dependencies?.[alias];
    if (!dependency) fail(`src-tauri/Cargo.toml is missing dependency ${alias}`);
    if (dependency.path !== `../${backend.path}`) fail(`${alias} path does not match ${backend.path}`);
    if (backend.dependency_alias && (dependency.package !== backend.crate || dependency.optional !== true)) {
      fail(`${alias} must be an optional alias for ${backend.crate}`);
    }
    if (backend.cargo_feature) {
      if (!cargo.features?.[backend.cargo_feature]?.includes(`dep:${backend.dependency_alias}`)) {
        fail(`${backend.cargo_feature} must enable dep:${backend.dependency_alias}`);
      }
      if (backend.host) {
        const hostPackagePath = path.join(backend.host.path, "Cargo.toml");
        if (!exists(hostPackagePath)) fail(`${hostPackagePath} does not exist`);
        if (structured(hostPackagePath, "toml").package?.name !== backend.host.crate) {
          fail(`${hostPackagePath} package does not match ${backend.host.crate}`);
        }
        const hostDependency = cargo.dependencies?.[backend.host.dependency_alias];
        if (!hostDependency) {
          fail(`src-tauri/Cargo.toml is missing dependency ${backend.host.dependency_alias}`);
        }
        if (hostDependency.path !== `../${backend.host.path}`) {
          fail(`${backend.host.dependency_alias} path does not match ${backend.host.path}`);
        }
        if ((hostDependency.package ?? backend.host.dependency_alias) !== backend.host.crate) {
          fail(`${backend.host.dependency_alias} package does not match ${backend.host.crate}`);
        }
        if (hostDependency.optional !== true) {
          fail(`${backend.host.dependency_alias} must be optional`);
        }
        if (!cargo.features[backend.cargo_feature].includes(`dep:${backend.host.dependency_alias}`)) {
          fail(`${backend.cargo_feature} must enable dep:${backend.host.dependency_alias}`);
        }
      }
      if (manifest.profile?.includes("-disabled/") && !cargo.features?.default?.includes(backend.cargo_feature)) {
        fail(`default Cargo features must include ${backend.cargo_feature}`);
      }
      const moduleHostPath = "src-tauri/src/modules/mod.rs";
      if (!exists(moduleHostPath)) fail(`${moduleHostPath} does not exist`);
      const moduleHost = readFileSync(path.join(root, moduleHostPath), "utf8");
      if (!moduleHost.includes(`#[cfg(feature = "${backend.cargo_feature}")]`)) {
        fail(`${moduleHostPath} is missing the ${backend.cargo_feature} cfg gate`);
      }
      const install = backend.install ?? `builder.plugin(${backend.plugin_init})`;
      if (!compact(moduleHost).includes(compact(install))) {
        fail(`${moduleHostPath} is missing module install ${install}`);
      }
    }
  }

  if (manifest.tauri) {
    const identifier = manifest.tauri.capability_identifier;
    const profilePath = manifest.profile;
    if (!profilePath || !exists(profilePath)) fail(`${profilePath ?? "profile"} does not exist`);
    const profile = readJson(root, profilePath);
    if (fixtureProfile) {
      const declared = capability(profile, identifier);
      if (!declared || !sameStrings(declared.permissions ?? [], manifest.tauri.permissions)) {
        fail(`${profilePath} capability ${identifier} does not match the manifest`);
      }
    } else {
      const tauriPath = "src-tauri/tauri.conf.json";
      if (!exists(tauriPath)) fail(`${tauriPath} does not exist`);
      const declared = capability(readJson(root, tauriPath), identifier);
      if (!declared || !sameStrings(declared.permissions ?? [], manifest.tauri.permissions)) {
        fail(`${tauriPath} capability ${identifier} does not match the manifest`);
      }
      if (capability(profile, identifier)) fail(`${profilePath} still enables capability ${identifier}`);
    }
  }
}

function frontendDisabledContract(root, manifest) {
  const composition = readFileSync(path.join(root, "core/frontend/host/enabledModules.ts"), "utf8");
  if (manifest.frontend.delivery === "runtime-artifact") {
    if (composition.includes(manifest.frontend.package)) {
      throw new Error(`${manifest.id} runtime artifact must not be statically composed`);
    }
    return "runtime-artifact";
  }

  const envName = `VITE_SHIPCTL_${manifest.id.toUpperCase().replaceAll("-", "_")}_MODULE`;
  if (!composition.includes(`import.meta.env.${envName}`)) {
    throw new Error(`${manifest.id} has no frontend-disabled composition contract`);
  }
  const escapedSymbol = manifest.frontend.composition_symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contract = new RegExp(
    `import\\.meta\\.env\\.${envName}\\s*===\\s*["']disabled["']\\s*\\?\\s*\\[\\]\\s*:\\s*\\[\\s*${escapedSymbol}\\s*\\]`,
  );
  if (!contract.test(composition)) {
    throw new Error(`${manifest.id} frontend-disabled composition must omit ${manifest.frontend.composition_symbol}`);
  }
  return "static-bundle";
}

export function frontendDisabled(root, id) {
  const manifest = readManifest(root, id);
  assertManifestContract(root, manifest);
  const delivery = frontendDisabledContract(root, manifest);
  process.stdout.write(`\n${id} frontend-disabled ${delivery} contract: OK (no rebuild)\n`);
}

export function nativeDisabled(root, id) {
  const manifest = readManifest(root, id);
  if (!manifest.backend?.cargo_feature || !manifest.profile?.includes("-disabled/")) {
    throw new Error(`${id} has no native-disabled static contract`);
  }
  assertManifestContract(root, manifest);
  process.stdout.write(`\n${id} native-disabled static contract: OK (no rebuild)\n`);
}

export function prepareDisabled(root, manifest) {
  if (!manifest.frontend.composition_symbol) return;
  if (manifest.profile && !manifest.profile.includes("-disabled/")) return;
  const relativePath = "core/frontend/host/enabledModules.ts";
  const file = path.join(root, relativePath);
  let source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const removals = [];
  for (const statement of parsed.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === manifest.frontend.package
    ) {
      removals.push([statement.getFullStart(), statement.end]);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      let compositionArray = null;
      const findCompositionArray = (node) => {
        if (
          !compositionArray &&
          ts.isArrayLiteralExpression(node) &&
          node.getText(parsed).includes(manifest.frontend.composition_symbol)
        ) {
          compositionArray = node;
          return;
        }
        ts.forEachChild(node, findCompositionArray);
      };
      findCompositionArray(declaration.initializer);
      if (!compositionArray) continue;
      for (const element of compositionArray.elements) {
        if (!element.getText(parsed).includes(manifest.frontend.composition_symbol)) continue;
        let end = element.end;
        if (source[end] === ",") end += 1;
        removals.push([element.getFullStart(), end]);
      }
    }
  }
  if (removals.length !== 2) {
    throw new Error(`Expected one import and one composition for ${manifest.id} in ${relativePath}`);
  }
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    source = `${source.slice(0, start)}${source.slice(end)}`;
  }
  writeFileSync(file, source);
}

export function prepareSourceAbsent(root, manifest) {
  prepareDisabled(root, manifest);
  removeSmokeDependencies(root, manifest);
  const backend = manifest.backend;
  if (backend?.cargo_feature) {
    const cargo = JSON.parse(
      execFileSync("yq", ["-p=toml", "-o=json", ".", path.join(root, "src-tauri/Cargo.toml")], {
        encoding: "utf8",
      }),
    );
    if (cargo.features?.default?.includes(backend.cargo_feature)) {
      removeCargoDefaultFeature(root, backend.cargo_feature);
    }
    removeLine(root, "src-tauri/Cargo.toml", cargoFeatureLine(backend));
    for (const dependency of backendDependencies(backend)) {
      removeLine(root, "src-tauri/Cargo.toml", cargoDependencyLine(dependency));
    }
    removeFeatureStatements(root, backend);
    removeInverseCfgStatement(root, backend);
  }

  rmSync(path.join(root, path.dirname(manifest.frontend.path)), { recursive: true, force: true });
  if (manifest.profile && !manifest.profile.includes("-disabled/")) {
    rmSync(path.join(root, "ops/modularity/fixtures/module-fixture"), { recursive: true, force: true });
  }
  if (manifest.profile) {
    rmSync(path.join(root, path.dirname(manifest.profile)), { recursive: true, force: true });
  }
  const packageStem = manifest.frontend.package.split("/").at(-1);
  for (const stem of new Set([manifest.id, packageStem])) {
    rmSync(path.join(root, "scripts", `verify-${stem}-plugout.mjs`), { force: true });
    rmSync(path.join(root, "scripts", `verify-${stem}-frontend-disabled.mjs`), { force: true });
  }

  const packageJson = readJson(root, "package.json");
  delete packageJson.dependencies?.[manifest.frontend.package];
  const scriptNamePattern = new RegExp(
    `(^|[:-])(?:${[manifest.id, packageStem]
      .filter(Boolean)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?:[:-]|$)`,
  );
  const commandMarkers = [
    manifest.frontend.package,
    manifest.frontend.path,
    manifest.backend?.path,
    manifest.backend?.host?.path,
  ].filter(Boolean);
  for (const [script, command] of Object.entries(packageJson.scripts ?? {})) {
    if (scriptNamePattern.test(script) || commandMarkers.some((marker) => command.includes(marker))) {
      delete packageJson.scripts[script];
    }
  }
  if (backend?.cargo_feature && manifest.profile?.includes("-disabled/")) {
    removeNativeModuleFeatureFromScripts(packageJson, backend.cargo_feature);
  }
  writeJson(root, "package.json", packageJson);

  if (manifest.tauri) {
    for (const config of tauriConfigs(root)) {
      removeCapability(root, config, manifest.tauri.capability_identifier);
    }
  }
}

export function sourceAbsentPatterns(manifest) {
  const patterns = [manifest.frontend.package, manifest.frontend.composition_symbol];
  if (manifest.backend) {
    for (const dependency of backendDependencies(manifest.backend)) {
      patterns.push(
        dependency.crate,
        dependency.dependencyAlias,
        dependency.dependencyAlias.replaceAll("-", "_"),
      );
    }
    patterns.push(manifest.backend.cargo_feature);
  }
  if (manifest.tauri) {
    const permissionNamespaces = manifest.tauri.permissions.map((permission) => permission.split(":")[0]);
    patterns.push(
      ...manifest.tauri.permissions,
      ...permissionNamespaces.map((namespace) => `plugin:${namespace}`),
    );
  }
  return [...new Set(patterns.filter(Boolean))];
}

export function assertSourceAbsent(root, manifest) {
  const targets = [
    "src",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "profiles",
    "ops/modularity/fixtures",
    "package.json",
  ].filter((target) => existsSync(path.join(root, target)));
  const args = [
    "-n",
    "-F",
    ...sourceAbsentPatterns(manifest).flatMap((pattern) => ["-e", pattern]),
    ...targets,
  ];
  const result = spawnSync("rg", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(`${manifest.id} module reference remains after plug-out:\n${result.stdout}`);
  }
  if (result.status !== 1) throw new Error(result.stderr || `rg exited with status ${result.status}`);
}

function verifyEnabled(root, manifest) {
  assertManifestContract(root, manifest);
}

function verifyDisabled(root, manifest) {
  const envName = `VITE_SHIPCTL_${manifest.id.toUpperCase().replaceAll("-", "_")}_MODULE`;
  const composition = readFileSync(path.join(root, "core/frontend/host/enabledModules.ts"), "utf8");
  if (composition.includes(`import.meta.env.${envName}`)) frontendDisabledContract(root, manifest);
  if (manifest.backend?.cargo_feature && manifest.profile?.includes("-disabled/")) {
    nativeDisabled(root, manifest.id);
  }
}

function verifySourceAbsent(root, manifest) {
  // prepareSourceAbsent is exercised in plugoutRunner.test.mjs. This gate
  // establishes that its manifest-derived removal sites are still current,
  // without materializing or compiling a disposable application copy.
  assertManifestContract(root, manifest);
}

export function plugout(root, id, { sourceAbsentOnly = false } = {}) {
  const manifest = readManifest(root, id);
  verifyModulePlugout({
    repositoryRoot: root,
    moduleName: manifest.id,
    verifyEnabled: (copyRoot) => verifyEnabled(copyRoot, manifest),
    verifyDisabled: (copyRoot) => verifyDisabled(copyRoot, manifest),
    verifySourceAbsent: (copyRoot) => verifySourceAbsent(copyRoot, manifest),
    sourceAbsentOnly,
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!id) throw new Error("Usage: plugout.mjs <module-id> [--source-absent-only]");
  plugout(repositoryRoot, id, { sourceAbsentOnly: process.argv.includes("--source-absent-only") });
}
