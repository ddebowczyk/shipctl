import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "../../..");

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(directory, predicate) {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target, predicate));
    else if (entry.isFile() && predicate(target)) files.push(target);
  }
  return files.sort();
}

export async function validateYaml(file, schema) {
  await exec("ys", ["-f", schema, file]);
}

async function schemaTargets(root) {
  const capabilitySchema = path.join(root, "ops/schema/capability.schema.yaml");
  const targets = [];
  const capabilityFiles = await filesUnder(path.join(root, "ops"), (file) => path.basename(file) === "capability.yaml");
  for (const file of capabilityFiles) targets.push([file, capabilitySchema]);
  targets.push([path.join(root, "ops/ops.yaml"), path.join(root, "ops/schema/ops.schema.yaml")]);
  targets.push([
    path.join(root, "ops/version/current.yaml"),
    path.join(root, "ops/version/schema/current.v1.schema.yaml"),
  ]);
  targets.push([
    path.join(root, "ops/repository/root-map.yaml"),
    path.join(root, "ops/repository/schema/root-map.schema.yaml"),
  ]);

  const moduleFiles = await filesUnder(path.join(root, "modules"), (file) => path.basename(file) === "module.yaml");
  const fixtureManifest = path.join(root, "examples/module-fixture/module.yaml");
  if (await exists(fixtureManifest)) moduleFiles.push(fixtureManifest);
  if (moduleFiles.length) {
    const moduleSchema = path.join(root, "ops/modularity/schema/module.schema.yaml");
    if (!await exists(moduleSchema)) throw new Error("module.yaml files exist without ops/modularity/schema/module.schema.yaml");
    for (const file of moduleFiles) targets.push([file, moduleSchema]);
  }
  return targets;
}

export async function checkSchemas(root = defaultRoot) {
  for (const [file, schema] of await schemaTargets(root)) await validateYaml(file, schema);

  const yamlFiles = [
    ...await filesUnder(path.join(root, "ops"), (file) => /\.ya?ml$/.test(file)),
    ...await filesUnder(path.join(root, "modules"), (file) => path.basename(file) === "module.yaml"),
    ...await filesUnder(path.join(root, "examples/module-fixture"), (file) => /\.ya?ml$/.test(file)),
  ];
  if (yamlFiles.length) await exec("yamllint", yamlFiles);

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkSchemas().then(() => {
    process.stdout.write("Schemas and YAML: OK\n");
  }).catch((error) => {
    process.stderr.write(`${error.stdout || error.stderr || error.message}\n`);
    process.exitCode = 1;
  });
}
