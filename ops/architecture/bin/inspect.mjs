import { execFile } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectFrontendArchitecture } from "../../modularity/lib/module-boundaries.mjs";

const exec = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultBaseline = path.join(
  defaultRepositoryRoot,
  "docs/4-layer-architecture/spec/baseline/source-architecture.json",
);

async function structuredFile(file, input = "yaml") {
  const { stdout } = await exec("yq", [`-p=${input}`, "-o=json", ".", file]);
  return JSON.parse(stdout);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function nativeCrates(repositoryRoot, moduleRoot) {
  const crates = [];
  for (const directory of ["backend", "core", "host"]) {
    const relative = path.join(moduleRoot, directory, "Cargo.toml");
    const absolute = path.join(repositoryRoot, relative);
    if (!await exists(absolute)) continue;
    const manifest = await structuredFile(absolute, "toml");
    crates.push({
      name: manifest.package.name,
      path: relative,
      role: directory,
    });
  }
  return crates;
}

function normalizeManifest(manifest) {
  return {
    schema_version: manifest.schema_version,
    id: manifest.id,
    frontend: manifest.frontend,
    backend: manifest.backend ?? null,
    tauri: manifest.tauri ?? null,
    messages: manifest.messages ?? null,
    profile: manifest.profile ?? null,
    tests: manifest.tests,
  };
}

export async function inspectArchitecture(repositoryRoot = defaultRepositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const frontend = await inspectFrontendArchitecture(root);
  const sourceByPackage = new Map(frontend.modules.map((item) => [item.package, item]));
  const moduleDirectories = (await readdir(path.join(root, "modules"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const modules = [];
  for (const directory of moduleDirectories) {
    const manifestPath = path.join("modules", directory, "module.yaml");
    const absoluteManifest = path.join(root, manifestPath);
    if (!await exists(absoluteManifest)) continue;
    const manifest = await structuredFile(absoluteManifest);
    const source = sourceByPackage.get(manifest.frontend.package);
    modules.push({
      id: manifest.id,
      manifest_path: manifestPath,
      manifest: normalizeManifest(manifest),
      frontend_source: source
        ? {
            entrypoint: source.entrypoint,
            import_closure: source.import_closure,
            entrypoint_effects: source.entrypoint_effects,
            source_file_count: source.source_files.length,
            direct_tauri_imports: source.tauri_imports,
          }
        : null,
      native_crates: await nativeCrates(root, path.join("modules", directory)),
    });
  }
  return {
    schema_version: "source-architecture/v2",
    modules,
  };
}

function mismatch(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [{
        code: "architecture.baseline.changed",
        path: path.relative(defaultRepositoryRoot, defaultBaseline),
        message: "generated source architecture differs from the reviewed baseline",
      }];
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const check = process.argv.includes("--check");
  const write = process.argv.includes("--write");
  if (check && write) throw new Error("--check and --write are mutually exclusive");
  const architecture = await inspectArchitecture();
  if (write) {
    await writeFile(defaultBaseline, `${JSON.stringify(architecture, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ok: true,
      baseline: path.relative(defaultRepositoryRoot, defaultBaseline),
    }, null, 2));
  } else if (check) {
    const expected = JSON.parse(await readFile(defaultBaseline, "utf8"));
    const diagnostics = mismatch(architecture, expected);
    console.log(JSON.stringify({
      ok: diagnostics.length === 0,
      diagnostics,
      summary: {
        modules: architecture.modules.length,
        runtime_artifacts: architecture.modules.filter(
          ({ manifest }) => manifest.frontend.delivery === "runtime-artifact",
        ).length,
        direct_tauri_imports: architecture.modules.reduce(
          (count, module) => count + (module.frontend_source?.direct_tauri_imports.length ?? 0),
          0,
        ),
      },
    }, null, 2));
    if (diagnostics.length > 0) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(architecture, null, 2));
  }
}
