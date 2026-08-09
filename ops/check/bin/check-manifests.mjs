import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readStructured(file, inputFormat) {
  return JSON.parse(
    execFileSync("yq", [`-p=${inputFormat}`, "-o=json", ".", file], { encoding: "utf8" }),
  );
}

function compact(value) {
  return value.replace(/\s+/g, "").replaceAll(",)", ")");
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function capability(config, identifier) {
  return (config.app?.security?.capabilities ?? []).find(
    (entry) => typeof entry === "object" && entry?.identifier === identifier,
  );
}

export function validateManifests(root) {
  const failures = [];
  const fail = (id, message) => failures.push(`${id}: ${message}`);
  const moduleRoot = path.join(root, "modules");
  const manifests = readdirSync(moduleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(moduleRoot, entry.name, "module.yaml"))
    .filter(existsSync)
    .map((manifestPath) => ({ manifestPath, kind: "product" }));
  const fixtureManifestPath = path.join(
    root,
    "examples/module-fixture/module.yaml",
  );
  if (existsSync(fixtureManifestPath)) {
    manifests.push({ manifestPath: fixtureManifestPath, kind: "fixture" });
  }
  manifests.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));

  if (manifests.length === 0) return ["No modules/*/module.yaml manifests found"];

  const rootPackagePath = path.join(root, "package.json");
  const rootPackage = existsSync(rootPackagePath) ? readJson(rootPackagePath) : { dependencies: {} };
  const enabledModulesPath = path.join(root, "core/frontend/host/enabledModules.ts");
  const enabledModules = existsSync(enabledModulesPath) ? readFileSync(enabledModulesPath, "utf8") : "";
  const cargoPath = path.join(root, "src-tauri/Cargo.toml");
  const cargo = existsSync(cargoPath) ? readStructured(cargoPath, "toml") : null;
  const moduleHostPath = path.join(root, "src-tauri/src/modules/mod.rs");
  const moduleHost = existsSync(moduleHostPath) ? readFileSync(moduleHostPath, "utf8") : "";
  const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
  const tauri = existsSync(tauriPath) ? readJson(tauriPath) : null;

  for (const { manifestPath, kind } of manifests) {
    const manifest = readStructured(manifestPath, "yaml");
    const id = manifest.id ?? path.basename(path.dirname(manifestPath));
    const directoryId = path.basename(path.dirname(manifestPath));
    if (kind === "product" && id !== directoryId) fail(id, `id does not match modules/${directoryId}`);

    const frontend = manifest.frontend;
    const frontendPackagePath = path.join(root, frontend.path, "package.json");
    if (!existsSync(frontendPackagePath)) {
      fail(id, `${frontend.path}/package.json does not exist`);
    } else if (readJson(frontendPackagePath).name !== frontend.package) {
      fail(id, `${frontend.path}/package.json name does not match ${frontend.package}`);
    }

    const fixtureProfile = manifest.profile !== null && !manifest.profile.includes("-disabled/");
    if (!fixtureProfile && rootPackage.dependencies?.[frontend.package] !== "workspace:*") {
      fail(id, `package.json must depend on ${frontend.package} as workspace:*`);
    }

    if (frontend.composition_symbol) {
      const compositionPath = fixtureProfile
        ? path.join(root, "ops/modularity/fixtures/module-fixture/enabledModules.ts")
        : enabledModulesPath;
      const composition = fixtureProfile && existsSync(compositionPath)
        ? readFileSync(compositionPath, "utf8")
        : enabledModules;
      const importMarker = `import { ${frontend.composition_symbol} } from "${frontend.package}";`;
      if (!composition.includes(importMarker)) {
        fail(id, `${path.relative(root, compositionPath)} must import ${frontend.composition_symbol}`);
      }
      const symbolUses = composition.match(new RegExp(`\\b${frontend.composition_symbol}\\b`, "g")) ?? [];
      if (symbolUses.length < 2) {
        fail(id, `${path.relative(root, compositionPath)} must compose ${frontend.composition_symbol}`);
      }
    }

    const backend = manifest.backend;
    if (backend) {
      const backendPackagePath = path.join(root, backend.path, "Cargo.toml");
      if (!existsSync(backendPackagePath)) {
        fail(id, `${backend.path}/Cargo.toml does not exist`);
      } else if (readStructured(backendPackagePath, "toml").package?.name !== backend.crate) {
        fail(id, `${backend.path}/Cargo.toml package does not match ${backend.crate}`);
      }
      if (!cargo) {
        fail(id, "src-tauri/Cargo.toml does not exist");
      } else {
        const alias = backend.dependency_alias ?? backend.crate;
        const dependency = cargo.dependencies?.[alias];
        if (!dependency) {
          fail(id, `src-tauri/Cargo.toml is missing dependency ${alias}`);
        } else {
          const expectedPath = `../${backend.path}`;
          const actualPath = typeof dependency === "object" ? dependency.path : null;
          if (actualPath !== expectedPath) fail(id, `${alias} path must be ${expectedPath}`);
          if (backend.dependency_alias && dependency.package !== backend.crate) {
            fail(id, `${alias} package must be ${backend.crate}`);
          }
          if (backend.dependency_alias && dependency.optional !== true) {
            fail(id, `${alias} must be optional`);
          }
        }

        if (backend.cargo_feature) {
          const feature = cargo.features?.[backend.cargo_feature];
          if (!Array.isArray(feature) || !feature.includes(`dep:${backend.dependency_alias}`)) {
            fail(id, `${backend.cargo_feature} must enable dep:${backend.dependency_alias}`);
          }
          if (manifest.profile?.includes("-disabled/") && !cargo.features?.default?.includes(backend.cargo_feature)) {
            fail(id, `default Cargo features must include ${backend.cargo_feature}`);
          }
          if (!moduleHost.includes(`#[cfg(feature = "${backend.cargo_feature}")]`)) {
            fail(id, `src-tauri/src/modules/mod.rs is missing the ${backend.cargo_feature} cfg gate`);
          }
          if (!compact(moduleHost).includes(compact(`builder.plugin(${backend.plugin_init})`))) {
            fail(id, `src-tauri/src/modules/mod.rs is missing plugin init ${backend.plugin_init}`);
          }
        }
      }

      for (const hostGlue of backend.host_glue ?? []) {
        if (!existsSync(path.join(root, hostGlue))) fail(id, `${hostGlue} does not exist`);
      }
      if ((backend.host_glue ?? []).length > 0 && !moduleHost.includes(`pub mod ${id.replaceAll("-", "_")};`)) {
        fail(id, `src-tauri/src/modules/mod.rs is missing pub mod ${id.replaceAll("-", "_")};`);
      }
    }

    if (manifest.tauri) {
      const identifier = manifest.tauri.capability_identifier;
      const expectedPermissions = manifest.tauri.permissions;
      if (fixtureProfile) {
        const profilePath = path.join(root, manifest.profile);
        const profile = existsSync(profilePath) ? readJson(profilePath) : null;
        const declared = profile && capability(profile, identifier);
        if (!declared || !sameStrings(declared.permissions ?? [], expectedPermissions)) {
          fail(id, `${manifest.profile} capability ${identifier} does not match the manifest`);
        }
      } else {
        const declared = tauri && capability(tauri, identifier);
        if (!declared || !sameStrings(declared.permissions ?? [], expectedPermissions)) {
          fail(id, `src-tauri/tauri.conf.json capability ${identifier} does not match the manifest`);
        }
        const profilePath = path.join(root, manifest.profile);
        if (!existsSync(profilePath)) {
          fail(id, `${manifest.profile} does not exist`);
        } else if (capability(readJson(profilePath), identifier)) {
          fail(id, `${manifest.profile} still enables capability ${identifier}`);
        }
      }
    } else if (tauri && capability(tauri, id)) {
      fail(id, `src-tauri/tauri.conf.json declares undeclared capability ${id}`);
    }
  }

  return failures;
}

export function runManifestCheck(root) {
  const failures = validateManifests(root);
  if (failures.length > 0) {
    console.error(`Module manifest drift:\n\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
    return 1;
  }
  console.log("Module manifests match all declaration sites.");
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = runManifestCheck(path.resolve(process.argv[2] ?? defaultRoot));
}
