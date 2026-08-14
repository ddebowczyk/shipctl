import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkModuleBoundaries } from "../modularity/bin/check-module-boundaries.mjs";

const exec = promisify(execFile);
const EXECUTABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".sh", ".py"]);
const GENERATED_DIRECTORIES = new Set([".git", "dist", "node_modules", "target"]);
const SUBJECT_ROOTS = new Set([
  ".beads", ".git", "assets", "builds", "core", "dist", "docs", "module-api", "modules",
  "node_modules", "notes", "ops", "profiles", "research", "src", "src-tauri", "target",
]);

function diagnostic(rule, message, file = null) {
  return { rule, message, file };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(directory, excludedDirectories = GENERATED_DIRECTORIES) {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(...await filesUnder(target, excludedDirectories));
    }
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matches(pattern, relativePath) {
  return globRegex(pattern).test(relativePath.split(path.sep).join("/"));
}

function fixedPrefix(pattern) {
  const wildcard = pattern.search(/[?*]/);
  return (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, "");
}

function patternsOverlap(left, right) {
  if (left === right) return true;
  const leftPrefix = fixedPrefix(left);
  const rightPrefix = fixedPrefix(right);
  return left.endsWith("/**") && (rightPrefix === leftPrefix || rightPrefix.startsWith(`${leftPrefix}/`))
    || right.endsWith("/**") && (leftPrefix === rightPrefix || leftPrefix.startsWith(`${rightPrefix}/`));
}

async function readYaml(file) {
  const { stdout } = await exec("yq", ["-o=json", ".", file]);
  return JSON.parse(stdout);
}

export async function loadCapabilities(root) {
  const opsRoot = path.join(root, "ops");
  const entries = await readdir(opsRoot, { withFileTypes: true });
  const capabilities = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "bin" || entry.name === "schema") continue;
    const manifestPath = path.join(opsRoot, entry.name, "capability.yaml");
    if (!await exists(manifestPath)) continue;
    capabilities.push({ directory: entry.name, root: path.dirname(manifestPath), manifestPath, manifest: await readYaml(manifestPath) });
  }
  return capabilities.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

async function validateSchemas(root, capabilities) {
  const diagnostics = [];
  const capabilitySchema = path.join(root, "ops/schema/capability.schema.yaml");
  const opsSchema = path.join(root, "ops/schema/ops.schema.yaml");
  for (const { manifestPath } of capabilities) {
    try {
      await exec("ys", ["-f", capabilitySchema, manifestPath]);
    } catch (error) {
      diagnostics.push(diagnostic("schema", (error.stdout || error.stderr || error.message).trim(), path.relative(root, manifestPath)));
    }
  }
  try {
    await exec("ys", ["-f", opsSchema, path.join(root, "ops/ops.yaml")]);
  } catch (error) {
    diagnostics.push(diagnostic("schema", (error.stdout || error.stderr || error.message).trim(), "ops/ops.yaml"));
  }
  return diagnostics;
}

function validateOwnership(root, capabilities, opsFiles) {
  const diagnostics = [];
  const claims = capabilities.flatMap((capability) =>
    capability.manifest.owns.map((pattern) => ({ capability: capability.manifest.id, pattern }))
  );

  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      if (claims[left].capability !== claims[right].capability && patternsOverlap(claims[left].pattern, claims[right].pattern)) {
        diagnostics.push(diagnostic("overlapping-owns", `${claims[left].capability}:${claims[left].pattern} overlaps ${claims[right].capability}:${claims[right].pattern}`));
      }
    }
  }

  for (const file of opsFiles) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const owners = claims.filter(({ pattern }) => matches(pattern, relative));
    if (owners.length !== 1) diagnostics.push(diagnostic("ops-path-owner", `${relative} has ${owners.length} owners`, relative));
  }

  const generated = capabilities.flatMap((capability) =>
    capability.manifest.generates.map((pattern) => ({ capability: capability.manifest.id, pattern }))
  );
  for (const capability of capabilities) {
    for (const readPattern of capability.manifest.reads) {
      for (const writePattern of [...capability.manifest.owns, ...capability.manifest.generates]) {
        if (patternsOverlap(readPattern, writePattern)) {
          diagnostics.push(diagnostic("read-write-overlap", `${capability.manifest.id}:${readPattern} is both read-only and writable as ${writePattern}`));
        }
      }
    }
  }
  for (const output of generated) {
    for (const claim of claims) {
      if (output.capability !== claim.capability && patternsOverlap(output.pattern, claim.pattern)) {
        diagnostics.push(diagnostic("write-outside-boundary", `${output.capability}:${output.pattern} writes into ${claim.capability}:${claim.pattern}`));
      }
    }
  }
  return diagnostics;
}

async function validateLiteralWrites(root, capabilities) {
  const diagnostics = [];
  const writeCall = /\b(?:writeFile|appendFile|mkdir|rm)\s*\(\s*["']([^"']+)["']/g;
  for (const capability of capabilities) {
    for (const file of await filesUnder(capability.root)) {
      if (!EXECUTABLE_EXTENSIONS.has(path.extname(file))) continue;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(writeCall)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const relative = path.relative(root, target).split(path.sep).join("/");
        const allowed = [...capability.manifest.owns, ...capability.manifest.generates].some((pattern) => matches(pattern, relative));
        if (!allowed) diagnostics.push(diagnostic("write-outside-boundary", `${capability.manifest.id} writes ${relative} outside owns/generates`, path.relative(root, file)));
      }
    }
  }
  return diagnostics;
}

function validateCycles(capabilities) {
  const diagnostics = [];
  const graph = new Map(capabilities.map(({ manifest }) => [manifest.id, manifest.requires.capabilities]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      diagnostics.push(diagnostic("capability-cycle", [...trail, id].join(" -> ")));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!graph.has(dependency)) diagnostics.push(diagnostic("missing-capability", `${id} requires unknown capability ${dependency}`));
      else visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id, []);
  return diagnostics;
}

async function validateCommandsAndSkills(root, capabilities) {
  const diagnostics = [];
  for (const capability of capabilities) {
    const justfile = path.join(capability.root, "justfile");
    let recipes = {};
    try {
      const { stdout } = await exec("just", ["--justfile", justfile, "--dump", "--dump-format", "json"]);
      recipes = JSON.parse(stdout).recipes;
    } catch (error) {
      diagnostics.push(diagnostic("invalid-justfile", (error.stderr || error.message).trim(), path.relative(root, justfile)));
    }
    for (const command of capability.manifest.commands) {
      if (!recipes[command.name]) diagnostics.push(diagnostic("missing-recipe", `${capability.manifest.id}:${command.name} has no recipe`, path.relative(root, justfile)));
    }

    const skillsRoot = path.join(capability.root, "skills");
    const declared = new Set(capability.manifest.skills.map(({ name }) => name));
    const entries = await exists(skillsRoot) ? await readdir(skillsRoot, { withFileTypes: true }) : [];
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const name of directories) {
      if (!declared.has(name)) diagnostics.push(diagnostic("undeclared-skill", `${capability.manifest.id}:${name} is not declared`));
    }
    for (const skill of capability.manifest.skills) {
      const skillFile = path.join(skillsRoot, skill.name, "SKILL.md");
      if (!await exists(skillFile)) {
        diagnostics.push(diagnostic("missing-skill", `${capability.manifest.id}:${skill.name} has no SKILL.md`, path.relative(root, skillFile)));
        continue;
      }
      const source = await readFile(skillFile, "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter || !/^name:\s*\S+/m.test(frontmatter[1]) || !/^description:\s*\S+/m.test(frontmatter[1])) {
        diagnostics.push(diagnostic("invalid-skill-frontmatter", `${capability.manifest.id}:${skill.name} needs name and description`, path.relative(root, skillFile)));
      }
    }
  }
  return diagnostics;
}

async function validateActiveProviders(root, capabilities) {
  const diagnostics = [];
  const ops = await readYaml(path.join(root, "ops/ops.yaml"));
  for (const [interfaceName, provider] of Object.entries(ops.active)) {
    const capability = capabilities.find(({ manifest }) => manifest.id === provider);
    if (!capability) diagnostics.push(diagnostic("missing-provider", `${interfaceName} selects unknown provider ${provider}`));
    else if (capability.manifest.provides !== interfaceName) diagnostics.push(diagnostic("provider-interface", `${provider} provides ${capability.manifest.provides}, not ${interfaceName}`));
  }
  return diagnostics;
}

async function validateBuildIsolation(root) {
  const diagnostics = [];
  for (const file of await filesUnder(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (/^(?:vite\.config\.[^/]+|ops\/modularity\/fixtures\/[^/]+\/vite\.config\.[^/]+)$/.test(relative)) {
      if (/['"`]ops\//.test(await readFile(file, "utf8"))) diagnostics.push(diagnostic("ops-vite-input", `${relative} references ops/`, relative));
    }
  }
  for (const file of await filesUnder(path.join(root, "dist"), new Set())) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (/^dist\/.*\.(?:js|css|html|json|map)$/.test(relative)) {
      if ((await readFile(file, "utf8")).includes("ops/")) diagnostics.push(diagnostic("ops-built-bundle", `${relative} references ops/`, relative));
    }
  }
  const cargoFile = path.join(root, "Cargo.toml");
  if (await exists(cargoFile)) {
    const { stdout } = await exec("yq", ["-p", "toml", "-o", "json", ".workspace.members // []", cargoFile]);
    const members = JSON.parse(stdout);
    for (const member of members) {
      if (member === "ops" || member.startsWith("ops/")) diagnostics.push(diagnostic("ops-cargo-member", `Cargo workspace includes ${member}`, "Cargo.toml"));
    }
  }
  return diagnostics;
}

async function validateRootExecutables(root, capabilities) {
  const diagnostics = [];
  const claims = capabilities.flatMap((capability) =>
    capability.manifest.owns.map((pattern) => ({ capability: capability.manifest.id, pattern }))
  );
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SUBJECT_ROOTS.has(entry.name)) continue;
    const executables = (await filesUnder(path.join(root, entry.name)))
      .filter((file) => EXECUTABLE_EXTENSIONS.has(path.extname(file)));
    for (const file of executables) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const owners = claims.filter(({ pattern }) => matches(pattern, relative));
      if (owners.length !== 1) {
        diagnostics.push(diagnostic(
          "unowned-root-executables",
          `${relative} has ${owners.length} capability owners`,
          relative,
        ));
      }
    }
  }
  if (await exists(path.join(root, "scripts"))) {
    diagnostics.push(diagnostic("legacy-scripts-returned", "scripts/ is retired; move repository operations into their owning ops capability"));
  }
  return diagnostics;
}

async function validatePeerBinImports(root, capabilities) {
  const diagnostics = [];
  for (const capability of capabilities) {
    for (const file of await filesUnder(capability.root)) {
      if (!EXECUTABLE_EXTENSIONS.has(path.extname(file))) continue;
      const source = await readFile(file, "utf8");
      for (const peer of capabilities) {
        if (peer.manifest.id === capability.manifest.id) continue;
        const peerBin = path.relative(path.dirname(file), path.join(peer.root, "bin")).split(path.sep).join("/");
        if (source.includes(peerBin) || source.includes(`ops/${peer.directory}/bin`)) {
          diagnostics.push(diagnostic("peer-bin-import", `${capability.manifest.id} reaches ${peer.manifest.id}/bin`, path.relative(root, file)));
        }
      }
    }
  }
  return diagnostics;
}

export async function validateInvariants(root, capabilities = null) {
  capabilities ??= await loadCapabilities(root);
  const appDiagnostics = (await checkModuleBoundaries(root))
    .filter(({ rule }) => rule === "app-ops-import")
    .map(({ rule, message, file }) => diagnostic(rule, message, file));
  const opsFiles = await filesUnder(path.join(root, "ops"));
  return [
    ...appDiagnostics,
    ...await validateBuildIsolation(root),
    ...validateOwnership(root, capabilities, opsFiles),
    ...await validateLiteralWrites(root, capabilities),
    ...await validateRootExecutables(root, capabilities),
    ...validateCycles(capabilities),
    ...await validateCommandsAndSkills(root, capabilities),
    ...await validateActiveProviders(root, capabilities),
    ...await validatePeerBinImports(root, capabilities),
  ];
}

export async function validateOps(root) {
  const capabilities = await loadCapabilities(root);
  return [
    ...await validateSchemas(root, capabilities),
    ...await validateInvariants(root, capabilities),
  ];
}

export function formatDiagnostics(diagnostics) {
  return diagnostics.map(({ rule, message, file }) => `${file ? `${file}: ` : ""}[${rule}] ${message}`).join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const diagnostics = await validateOps(root);
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    process.exitCode = 1;
  } else {
    console.log("Repository operations: OK");
  }
}
