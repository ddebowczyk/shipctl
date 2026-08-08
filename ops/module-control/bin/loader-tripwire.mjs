#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as React from "react";
import { build } from "vite";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const schemaVersion = 1;
const moduleId = "shipctl.loader-fixture";
const moduleVersion = "0.0.0";

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const options = {
    output: "text",
    evidenceRoot: path.join(repositoryRoot, "target/module-control/evidence"),
    packaged: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") options.output = args[++index] ?? fail("--output requires a value");
    else if (argument === "--evidence-root") options.evidenceRoot = path.resolve(args[++index] ?? fail("--evidence-root requires a value"));
    else if (argument === "--lower-level") options.packaged = false;
    else fail(`Unknown argument: ${argument}`);
  }
  if (options.output !== "json" && options.output !== "text") fail("--output must be json or text");
  return options;
}

async function filesBelow(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
    else fail(`Artifact contains unsupported entry: ${path.relative(root, absolute)}`);
  }
  return files;
}

async function digestDirectory(root) {
  const hash = createHash("sha256");
  const files = await filesBelow(root);
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

async function buildArtifact({ artifactRoot, fixture, workRoot }) {
  const staging = path.join(workRoot, `staging-${fixture}`);
  const source = path.join(repositoryRoot, "ops/module-control/fixtures/loader", `${fixture.toLowerCase()}.ts`);
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      emptyOutDir: true,
      lib: { entry: source, formats: ["es"], fileName: () => "module.mjs" },
      outDir: staging,
      sourcemap: true,
    },
  });
  const { digest, files } = await digestDirectory(staging);
  const destination = path.join(artifactRoot, moduleId, moduleVersion, digest);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(staging, destination);
  return {
    fixture,
    marker: fixture,
    digestSha256: digest,
    entryPath: path.join(destination, "module.mjs"),
    entryRelativePath: path.relative(artifactRoot, path.join(destination, "module.mjs")),
    files,
  };
}

async function importArtifact(artifact) {
  const namespace = await import(pathToFileURL(artifact.entryPath).href);
  assert.equal(namespace.runtimeMarker, artifact.marker);
  assert.equal(typeof namespace.activate, "function");
  const runtime = namespace.activate({ react: React });
  assert.equal(runtime.marker, artifact.marker);
  assert.equal(runtime.react, React);
  return { marker: runtime.marker, reactSingleton: runtime.react === React };
}

async function cspConfiguration() {
  const configPath = path.join(repositoryRoot, "src-tauri/tauri.conf.json");
  const shellPath = path.join(repositoryRoot, "src-tauri/src/lib.rs");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const shell = await readFile(shellPath, "utf8");
  const security = config.app?.security ?? {};
  const staticScope = security.assetProtocol?.scope;
  const scriptSources = security.csp?.["script-src"];
  return {
    configPath,
    assetProtocolEnabled: security.assetProtocol?.enable === true,
    staticScope,
    staticScopeIsEmpty: Array.isArray(staticScope) && staticScope.length === 0,
    scriptSrcAllowsAsset: typeof scriptSources === "string"
      ? scriptSources.split(/\s+/).includes("asset:")
      : Array.isArray(scriptSources) && scriptSources.includes("asset:"),
    dynamicScopeIsArtifactRoot: /allow_directory\(&module_artifact_root, true\)/.test(shell),
    dynamicScopeDoesNotGrantStateRoot: !/allow_directory\(&paths\.state_root, true\)/.test(shell),
  };
}

function hostBinary() {
  return process.env.SHIPCTL_UI_BINARY ?? path.join(repositoryRoot, "target/debug/shipctl-ui");
}

async function binaryFingerprint(binary) {
  const details = await stat(binary).catch(() => null);
  if (!details) return null;
  return {
    path: binary,
    size: details.size,
    mtimeMs: details.mtimeMs,
    sha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
  };
}

async function runProcess(command, args, defaultStateRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, SHIPCTL_STATE_DIR: defaultStateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function packagedProbe({ a, b, c, stateRoot, runtimeRoot, defaultStateRoot }) {
  const requestPath = path.join(stateRoot, "module-control", "loader-probe-request.json");
  const resultPath = path.join(stateRoot, "module-control", "evidence", "loader-probe-result.json");
  await mkdir(path.dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify({
    schemaVersion,
    artifacts: [a, b, c].map(({ fixture, digestSha256, entryRelativePath }) => ({
      label: fixture,
      digestSha256,
      entryRelativePath,
    })),
  }, null, 2)}\n`);
  const binary = hostBinary();
  if (!(await stat(binary).catch(() => null))) {
    return {
      status: "failed",
      diagnostic: {
        code: "module.loader.host_not_built",
        phase: "packaged_probe",
        summary: `Once build the host with \`just module-control build-loader-probe-host\`; expected ${binary}`,
      },
    };
  }
  const processResult = await runProcess(binary, [
    "--name", "loader-tripwire",
    "--state-root", stateRoot,
    "--runtime-root", runtimeRoot,
    "--module-loader-probe", requestPath,
  ], defaultStateRoot);
  const result = await readFile(resultPath, "utf8").then(JSON.parse).catch((error) => null);
  const passed = processResult.code === 0 && result?.success === true;
  return {
    status: passed ? "passed" : "failed",
    binary,
    process: processResult,
    result,
    diagnostic: passed ? null : {
      code: result ? "module.loader.packaged_probe_failed" : "module.loader.packaged_probe_no_evidence",
      phase: "packaged_probe",
      summary: result
        ? "The packaged webview completed the loader probe with a failed result."
        : "The packaged host exited before it wrote loader-probe evidence.",
    },
  };
}

export async function runLoaderTripwire(options = {}) {
  const workRoot = await mkdtemp(path.join(tmpdir(), "shipctl-loader-tripwire-"));
  const stateRoot = path.join(workRoot, "isolated-state");
  const artifactRoot = path.join(stateRoot, "modules");
  const runtimeRoot = path.join(workRoot, "isolated-runtime");
  const defaultStateRoot = path.join(workRoot, "unexpected-default-state");
  try {
    // The host must already exist. This tripwire never invokes Cargo or Tauri
    // build; it fingerprints that immutable host around data-only A/B/C swaps.
    const hostBefore = options.packaged === false ? null : await binaryFingerprint(hostBinary());
    const a = await buildArtifact({ artifactRoot, fixture: "A", workRoot });
    const b = await buildArtifact({ artifactRoot, fixture: "B", workRoot });
    const c = await buildArtifact({ artifactRoot, fixture: "C", workRoot });
    const csp = await cspConfiguration();
    const lowerLevel = options.packaged === false ? await (async () => {
      const loadedA = await importArtifact(a);
      const loadedB = await importArtifact(b);
      let failedC;
      try { await importArtifact(c); fail("Fixture C unexpectedly imported"); }
      catch (error) { failedC = { code: "module.loader.import_failed", phase: "import", summary: error instanceof Error ? error.message : String(error) }; }
      const usableAfterC = await importArtifact(b);
      return { loadedA, loadedB, failedC, usableAfterC };
    })() : null;
    const packagedWebview = options.packaged === false
      ? { status: "not_requested" }
      : await packagedProbe({ a, b, c, stateRoot, runtimeRoot, defaultStateRoot });
    const hostAfter = options.packaged === false ? null : await binaryFingerprint(hostBinary());
    const hostUnchanged = hostBefore !== null
      && hostAfter !== null
      && JSON.stringify(hostBefore) === JSON.stringify(hostAfter);
    const assetBoundaryConfigured = csp.assetProtocolEnabled
      && csp.staticScopeIsEmpty
      && csp.scriptSrcAllowsAsset
      && csp.dynamicScopeIsArtifactRoot
      && csp.dynamicScopeDoesNotGrantStateRoot;
    const defaultStateUntouched = !(await stat(defaultStateRoot).catch(() => null));
    const result = {
      schemaVersion,
      fixture: "module-loader-tripwire",
      status: options.packaged === false ? "passed" : (packagedWebview.status === "passed" && hostUnchanged && assetBoundaryConfigured ? "passed" : "failed"),
      expected: {
        markers: ["A", "B"], failedFixture: "C", noWebviewReload: true, hostReactSingleton: true,
      },
      observed: options.packaged === false
        ? { artifacts: [a, b, c], ...lowerLevel, markerAfterSwap: lowerLevel.loadedB.marker, defaultStateUntouched }
        : { artifacts: [a, b, c], defaultStateUntouched },
      paths: { stateRoot, runtimeRoot, artifactRoot, defaultStateRoot },
      productionBoundary: { csp, hostBefore, hostAfter, hostUnchanged, packagedWebview },
      diagnostics: [
        ...(packagedWebview.diagnostic ? [packagedWebview.diagnostic] : []),
        ...(!hostUnchanged && options.packaged !== false ? [{
          code: "module.loader.host_binary_changed",
          phase: "packaged_probe",
          summary: "The compiled host changed while the data-only A/B/C artifact probe ran.",
        }] : []),
        ...(!assetBoundaryConfigured && options.packaged !== false ? [{
          code: "module.loader.packaged_csp_or_scope_unconfigured",
          phase: "packaged_probe",
          summary: "The host does not have the narrow asset-protocol configuration required for immutable artifacts.",
        }] : []),
      ],
    };
    return result;
  } finally {
    if (!options.keepWorkRoot) await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLoaderTripwire(options);
  await mkdir(options.evidenceRoot, { recursive: true });
  const evidencePath = path.join(options.evidenceRoot, `loader-tripwire-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.output === "json") process.stdout.write(`${JSON.stringify({ ...result, evidencePath })}\n`);
  else process.stdout.write(`${result.status}: ${result.diagnostics[0]?.code ?? "module.loader.packaged_webview_passed"}\n${evidencePath}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
