import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function frontmatter(markdown, file) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return `---\n${match[1]}\n`;
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
  targets.push([path.join(root, "ops/upstream/state.yaml"), path.join(root, "ops/upstream/schema/state.schema.yaml")]);
  targets.push([path.join(root, "ops/upstream/path-map.yaml"), path.join(root, "ops/upstream/schema/path-map.schema.yaml")]);

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

  const temporary = await mkdtemp(path.join(tmpdir(), "shipctl-ledger-schema-"));
  try {
    const entrySchema = path.join(root, "ops/upstream/schema/entry.schema.yaml");
    const entries = await filesUnder(path.join(root, "ops/upstream/log"), (file) => file.endsWith(".md"));
    for (const entry of entries) {
      const extracted = path.join(temporary, path.basename(entry, ".md") + ".yaml");
      await writeFile(extracted, frontmatter(await readFile(entry, "utf8"), entry));
      await validateYaml(extracted, entrySchema);
      await exec("yamllint", [extracted]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkSchemas().then(() => {
    process.stdout.write("Schemas and YAML: OK\n");
  }).catch((error) => {
    process.stderr.write(`${error.stdout || error.stderr || error.message}\n`);
    process.exitCode = 1;
  });
}
