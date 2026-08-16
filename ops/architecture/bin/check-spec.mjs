import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultSpecRoot = path.join(
  defaultRepositoryRoot,
  "docs/4-layer-architecture/spec",
);

const schemaByCollection = {
  phases: "schema/phase.v1.schema.yaml",
  capabilities: "schema/capability.v1.schema.yaml",
  modules: "schema/module-disposition.v1.schema.yaml",
};

function diagnostic(code, recordPath, message) {
  return { code, path: recordPath, message };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function exactSetDiagnostics(actual, expected, code, recordPath) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expectedSet.has(item));
  if (!missing.length && !extra.length && actual.length === expected.length) {
    return [];
  }
  return [diagnostic(
    code,
    recordPath,
    `index mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
  )];
}

function graphDiagnostics(records, group, dependencyCode, cycleCode) {
  const diagnostics = [];
  const ids = new Set(records.map((record) => record.id));
  const byId = new Map(records.map((record) => [record.id, record]));

  for (const record of records) {
    for (const dependency of record.depends_on ?? []) {
      if (!ids.has(dependency)) {
        diagnostics.push(diagnostic(
          dependencyCode,
          `${group}/${record.id}`,
          `unknown dependency: ${dependency}`,
        ));
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const reported = new Set();

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = [...new Set(cycle)].sort().join(":");
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push(diagnostic(
          cycleCode,
          `${group}/${id}`,
          `dependency cycle: ${cycle.join(" -> ")}`,
        ));
      }
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of [...ids].sort()) visit(id);
  return diagnostics;
}

function idDiagnostics(records, group, code) {
  return duplicateValues(records.map((record) => record.id)).map((id) => (
    diagnostic(code, group, `duplicate id: ${id}`)
  ));
}

export function validateArchitectureRecords(spec) {
  const diagnostics = [];
  const { program, phases, capabilities, modules } = spec;

  diagnostics.push(...idDiagnostics(
    phases,
    "phases",
    "architecture.phase.id.duplicate",
  ));
  diagnostics.push(...idDiagnostics(
    capabilities,
    "capabilities",
    "architecture.capability.id.duplicate",
  ));
  diagnostics.push(...idDiagnostics(
    modules,
    "migrations",
    "architecture.module.id.duplicate",
  ));
  diagnostics.push(...graphDiagnostics(
    phases,
    "phases",
    "architecture.phase.dependency.unknown",
    "architecture.phase.dependency.cycle",
  ));
  diagnostics.push(...graphDiagnostics(
    capabilities,
    "capabilities",
    "architecture.capability.dependency.unknown",
    "architecture.capability.dependency.cycle",
  ));

  const semanticOwners = new Map();
  const propertyOwners = new Map();
  const deletionGates = new Map();

  for (const phase of phases) {
    for (const semantic of phase.semantics ?? []) {
      if (semanticOwners.has(semantic.id)) {
        diagnostics.push(diagnostic(
          "architecture.semantic.id.duplicate",
          `phases/${phase.id}`,
          `duplicate semantic id: ${semantic.id}`,
        ));
      } else {
        semanticOwners.set(semantic.id, phase.id);
      }
    }
    for (const property of phase.properties ?? []) {
      if (propertyOwners.has(property.id)) {
        diagnostics.push(diagnostic(
          "architecture.property.id.duplicate",
          `phases/${phase.id}`,
          `duplicate property id: ${property.id}`,
        ));
      } else {
        propertyOwners.set(property.id, phase.id);
      }
    }
    for (const gate of phase.deletion_gates ?? []) {
      if (deletionGates.has(gate.id)) {
        diagnostics.push(diagnostic(
          "architecture.deletion-gate.id.duplicate",
          `phases/${phase.id}`,
          `duplicate deletion gate id: ${gate.id}`,
        ));
      } else {
        deletionGates.set(gate.id, phase.id);
      }
    }
  }

  for (const phase of phases) {
    const localSemantics = new Set(
      (phase.semantics ?? []).map((semantic) => semantic.id),
    );
    const covered = new Set();
    const localGates = new Set(
      (phase.deletion_gates ?? []).map((gate) => gate.id),
    );
    for (const property of phase.properties ?? []) {
      for (const evidence of property.evidence ?? []) {
        if (!localSemantics.has(evidence)) {
          diagnostics.push(diagnostic(
            "architecture.property.evidence.unknown",
            `phases/${phase.id}/properties/${property.id}`,
            `evidence is not a semantic in this phase: ${evidence}`,
          ));
        } else {
          covered.add(evidence);
        }
      }
      for (const gate of property.deletion_gates ?? []) {
        if (!localGates.has(gate)) {
          diagnostics.push(diagnostic(
            "architecture.property.deletion-gate.unknown",
            `phases/${phase.id}/properties/${property.id}`,
            `unknown local deletion gate: ${gate}`,
          ));
        }
      }
      if (
        ["implemented", "passing"].includes(property.status)
        && !property.runner?.test_id
      ) {
        diagnostics.push(diagnostic(
          "architecture.property.test-id.missing",
          `phases/${phase.id}/properties/${property.id}`,
          "implemented properties must name an executable test",
        ));
      }
    }
    for (const semantic of phase.semantics ?? []) {
      if (["MUST", "MUST-NOT"].includes(semantic.kind) && !covered.has(semantic.id)) {
        diagnostics.push(diagnostic(
          "architecture.semantic.evidence.missing",
          `phases/${phase.id}/semantics/${semantic.id}`,
          "mandatory semantic has no local property evidence",
        ));
      }
    }
  }

  const phaseIds = new Set(phases.map((phase) => phase.id));
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  for (const capability of capabilities) {
    for (const propertyId of capability.property_ids ?? []) {
      if (!propertyOwners.has(propertyId)) {
        diagnostics.push(diagnostic(
          "architecture.capability.property.unknown",
          `capabilities/${capability.id}`,
          `unknown property: ${propertyId}`,
        ));
      }
    }
  }

  for (const module of modules) {
    for (const phaseId of module.phases ?? []) {
      if (!phaseIds.has(phaseId)) {
        diagnostics.push(diagnostic(
          "architecture.module.phase.unknown",
          `migrations/${module.id}`,
          `unknown phase: ${phaseId}`,
        ));
      }
    }
    for (const capabilityId of module.target?.capabilities ?? []) {
      if (!capabilityIds.has(capabilityId)) {
        diagnostics.push(diagnostic(
          "architecture.module.capability.unknown",
          `migrations/${module.id}`,
          `unknown capability: ${capabilityId}`,
        ));
      }
    }
    for (const gate of module.deletion_gates ?? []) {
      if (!deletionGates.has(gate.id)) {
        diagnostics.push(diagnostic(
          "architecture.module.deletion-gate.unknown",
          `migrations/${module.id}`,
          `unknown deletion gate: ${gate.id}`,
        ));
      }
      for (const propertyId of gate.proof_ids ?? []) {
        if (!propertyOwners.has(propertyId)) {
          diagnostics.push(diagnostic(
            "architecture.module.proof.unknown",
            `migrations/${module.id}/deletion-gates/${gate.id}`,
            `unknown property proof: ${propertyId}`,
          ));
        }
      }
    }
  }

  const expectedLayers = [
    "native-kernel",
    "tauri-adapters",
    "application-runtime",
    "application-plugins",
  ];
  diagnostics.push(...exactSetDiagnostics(
    program.target_layers.map((layer) => layer.id),
    expectedLayers,
    "architecture.program.layers.mismatch",
    "program.yaml",
  ));

  return diagnostics.sort((left, right) => (
    left.code.localeCompare(right.code)
      || left.path.localeCompare(right.path)
      || left.message.localeCompare(right.message)
  ));
}

async function yamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
}

async function loadYaml(file) {
  const { stdout } = await exec("yq", ["-o=json", ".", file]);
  return JSON.parse(stdout);
}

async function validateYaml(file, schema) {
  await exec("ys", ["-f", schema, file]);
}

async function executableTestIds(repositoryRoot) {
  const roots = ["ops", "core", "modules"].map((item) => (
    path.join(repositoryRoot, item)
  ));
  try {
    const { stdout } = await exec("rg", [
      "-o",
      "--no-filename",
      "architecture\\.[a-zA-Z0-9.-]+\\.property",
      ...roots,
    ]);
    return new Set(stdout.split(/\r?\n/).filter(Boolean));
  } catch (error) {
    if (error.code === 1) return new Set();
    throw error;
  }
}

function resolveIndexedPath(specRoot, relativePath) {
  const resolved = path.resolve(specRoot, relativePath);
  if (!resolved.startsWith(`${specRoot}${path.sep}`)) {
    throw new Error(`indexed path escapes specification root: ${relativePath}`);
  }
  return resolved;
}

export async function loadArchitectureSpec(specRoot = defaultSpecRoot) {
  const programPath = path.join(specRoot, "program.yaml");
  const program = await loadYaml(programPath);
  const loadCollection = async (name) => Promise.all(
    program.records[name].map((relativePath) => (
      loadYaml(resolveIndexedPath(specRoot, relativePath))
    )),
  );
  return {
    program,
    phases: await loadCollection("phases"),
    capabilities: await loadCollection("capabilities"),
    modules: await loadCollection("modules"),
  };
}

async function validateFileContracts(repositoryRoot, specRoot, spec) {
  const diagnostics = [];
  const programSchema = path.join(specRoot, "schema/program.v1.schema.yaml");
  await validateYaml(path.join(specRoot, "program.yaml"), programSchema);

  for (const [collection, schemaPath] of Object.entries(schemaByCollection)) {
    const schema = path.join(specRoot, schemaPath);
    for (const relativePath of spec.program.records[collection]) {
      await validateYaml(resolveIndexedPath(specRoot, relativePath), schema);
    }
  }
  await exec("yamllint", [specRoot]);

  for (const [collection, directory] of [
    ["phases", "phases"],
    ["capabilities", "capabilities"],
    ["modules", "migrations"],
  ]) {
    const discovered = (await yamlFiles(path.join(specRoot, directory)))
      .map((name) => `${directory}/${name}`);
    diagnostics.push(...exactSetDiagnostics(
      spec.program.records[collection],
      discovered,
      "architecture.program.index.mismatch",
      `program.yaml/records/${collection}`,
    ));
  }

  const evidenceSchema = resolveIndexedPath(
    specRoot,
    spec.program.evidence_schema,
  );
  await readFile(evidenceSchema);
  for (const source of spec.program.source_documents) {
    await readFile(path.resolve(repositoryRoot, source));
  }
  for (const module of spec.modules) {
    const manifestPath = path.resolve(repositoryRoot, module.source_manifest);
    const manifest = await loadYaml(manifestPath);
    if (manifest.id !== module.id) {
      diagnostics.push(diagnostic(
        "architecture.module.manifest-id.mismatch",
        module.source_manifest,
        `expected ${module.id}, found ${manifest.id}`,
      ));
    }
    await access(path.resolve(repositoryRoot, module.current.frontend));
    for (const currentPath of [
      ...module.current.backend_crates,
      ...module.current.host_crates,
    ]) {
      await access(path.resolve(repositoryRoot, currentPath));
    }
  }
  const testIds = await executableTestIds(repositoryRoot);
  for (const phase of spec.phases) {
    for (const property of phase.properties ?? []) {
      if (
        ["implemented", "passing"].includes(property.status)
        && !testIds.has(property.runner.test_id)
      ) {
        diagnostics.push(diagnostic(
          "architecture.property.test-id.unknown",
          `phases/${phase.id}/properties/${property.id}`,
          `executable test not found: ${property.runner.test_id}`,
        ));
      }
    }
  }
  return diagnostics;
}

export async function checkArchitectureSpec({
  repositoryRoot = defaultRepositoryRoot,
  specRoot = path.join(repositoryRoot, "docs/4-layer-architecture/spec"),
  validateFiles = true,
} = {}) {
  const spec = await loadArchitectureSpec(specRoot);
  const diagnostics = validateArchitectureRecords(spec);
  if (validateFiles) {
    diagnostics.push(...await validateFileContracts(
      repositoryRoot,
      specRoot,
      spec,
    ));
  }
  diagnostics.sort((left, right) => (
    left.code.localeCompare(right.code)
      || left.path.localeCompare(right.path)
      || left.message.localeCompare(right.message)
  ));
  const propertyCount = spec.phases.reduce(
    (count, phase) => count + (phase.properties?.length ?? 0),
    0,
  );
  return {
    ok: diagnostics.length === 0,
    counts: {
      phases: spec.phases.length,
      capabilities: spec.capabilities.length,
      modules: spec.modules.length,
      semantics: spec.phases.reduce(
        (count, phase) => count + (phase.semantics?.length ?? 0),
        0,
      ),
      properties: propertyCount,
      implemented_properties: spec.phases.reduce(
        (count, phase) => count + (phase.properties ?? []).filter(
          (property) => ["implemented", "passing"].includes(property.status),
        ).length,
        0,
      ),
    },
    diagnostics,
  };
}

export function architectureGraph(spec) {
  return {
    phases: spec.phases.map((phase) => ({
      id: phase.id,
      status: phase.status,
      depends_on: phase.depends_on,
    })),
    capabilities: spec.capabilities.map((capability) => ({
      id: capability.id,
      status: capability.status,
      depends_on: capability.depends_on,
    })),
    modules: spec.modules.map((module) => ({
      id: module.id,
      status: module.status,
      phases: module.phases,
      capabilities: module.target.capabilities,
    })),
  };
}

async function main() {
  if (process.argv.includes("--graph")) {
    process.stdout.write(`${JSON.stringify(
      architectureGraph(await loadArchitectureSpec()),
      null,
      2,
    )}\n`);
    return;
  }
  const result = await checkArchitectureSpec();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.stderr || error.stdout || error.message,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
