import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "vite";

export const SHARED_RUNTIME_PACKAGES = Object.freeze([
  "@shipctl/module-api",
  "@shipctl/core",
  "react",
  "react-dom",
  "cordis",
]);

const HOST_RUNTIME_SYMBOL = "shipctl.plugin-host.v1";
const HOST_RUNTIME_IMPORTS = new Map([
  ["@shipctl/module-api", "pluginApi"],
  ["react", "react"],
  ["react-dom", "reactDom"],
  ["react-dom/client", "reactDomClient"],
  ["react/jsx-dev-runtime", "reactJsxDevRuntime"],
  ["react/jsx-runtime", "reactJsxRuntime"],
]);
const HOST_RUNTIME_PREFIX = "\0shipctl-host-runtime:";

function normalized(value) {
  return value.replaceAll(path.sep, "/");
}

function sharedPackage(specifier) {
  return SHARED_RUNTIME_PACKAGES.find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
}

function bundledSharedPackage(moduleId) {
  const value = normalized(moduleId);
  if (value.includes("/module-api/frontend/")) return "@shipctl/module-api";
  if (value.includes("/core/frontend/runtime/cordis/")) return "cordis";
  if (value.includes("/core/frontend/")) return "@shipctl/core";
  if (value.includes("/node_modules/cordis/")) return "cordis";
  if (value.includes("/node_modules/react-dom/")) return "react-dom";
  if (value.includes("/node_modules/react/")) return "react";
  return undefined;
}

/** Inspect Rollup output without trusting source-level external declarations. */
export function inspectSharedRuntimeClosure(outputs) {
  const violations = [];
  for (const output of outputs) {
    if (output.type !== "chunk") continue;
    for (const specifier of [...output.imports, ...output.dynamicImports]) {
      const dependency = sharedPackage(specifier);
      if (dependency !== undefined) {
        violations.push({
          kind: "unresolved-shared-import",
          dependency,
          file: output.fileName,
          reference: specifier,
        });
      }
    }
    for (const moduleId of Object.keys(output.modules)) {
      const dependency = bundledSharedPackage(moduleId);
      if (dependency !== undefined) {
        violations.push({
          kind: "bundled-shared-module",
          dependency,
          file: output.fileName,
          reference: normalized(moduleId),
        });
      }
    }
  }
  return violations.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function supplementalFiles(root, current = root) {
  const metadata = await lstat(current);
  assert.equal(metadata.isSymbolicLink(), false, `Artifact source cannot contain a link: ${current}`);
  if (metadata.isFile()) {
    return [{ relative: normalized(path.relative(root, current)), source: current }];
  }
  assert.equal(metadata.isDirectory(), true, `Artifact source entry is not regular: ${current}`);
  const entries = await readdir(current);
  const children = await Promise.all(
    entries.sort().map((entry) => supplementalFiles(root, path.join(current, entry))),
  );
  return children.flat();
}

async function copySupplementalFiles(sourceDirectory, stagingDirectory) {
  try {
    for (const file of await supplementalFiles(sourceDirectory)) {
      assert.notEqual(file.relative, "module.yaml", "Supplemental files cannot replace module.yaml");
      assert.notEqual(file.relative, "integrity.json", "Supplemental files cannot supply integrity.json");
      const destination = path.join(stagingDirectory, file.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(file.source));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function rollupOutputs(result) {
  return (Array.isArray(result) ? result : [result]).flatMap(({ output }) => output);
}

function uniqueSorted(values) {
  const sorted = [...new Set(values)].sort();
  assert.equal(sorted.length, values.length, "Artifact manifest paths must be unique");
  return sorted;
}

function hostRuntimePlugin() {
  return {
    name: "shipctl-host-runtime",
    enforce: "pre",
    resolveId(specifier) {
      if (HOST_RUNTIME_IMPORTS.has(specifier)) return `${HOST_RUNTIME_PREFIX}${specifier}`;
      const dependency = sharedPackage(specifier);
      if (dependency !== undefined) {
        throw new Error(
          `Artifact import ${specifier} is not part of the public host runtime bridge`,
        );
      }
      return null;
    },
    async load(moduleId) {
      if (!moduleId.startsWith(HOST_RUNTIME_PREFIX)) return null;
      const specifier = moduleId.slice(HOST_RUNTIME_PREFIX.length);
      const member = HOST_RUNTIME_IMPORTS.get(specifier);
      assert.notEqual(member, undefined, `Unknown host runtime import ${specifier}`);
      const namespace = await import(specifier);
      const namedExports = Object.keys(namespace)
        .filter((name) => name !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
        .sort()
        .map((name) => `export const ${name} = __module[${JSON.stringify(name)}];`);
      return {
        code: [
          `const host = globalThis[Symbol.for(${JSON.stringify(HOST_RUNTIME_SYMBOL)})];`,
          `if (!host) throw new Error(${JSON.stringify(`Shipctl host runtime is unavailable for ${specifier}`)});`,
          `const __module = host[${JSON.stringify(member)}];`,
          `if (!__module) throw new Error(${JSON.stringify(`Shipctl host runtime does not provide ${specifier}`)});`,
          ...namedExports,
          "export default (__module.default ?? __module);",
        ].join("\n"),
      };
    },
  };
}

/** Build one source plugin into an unsealed closed staging directory. */
export async function buildPluginArtifactStaging({ sourceDirectory, stagingDirectory }) {
  const templatePath = path.join(sourceDirectory, "module.template.json");
  const sourceEntry = path.join(sourceDirectory, "src/index.ts");
  const manifest = JSON.parse(await readFile(templatePath, "utf8"));
  assert.equal(typeof manifest.entry, "string", "Artifact manifest template requires entry");
  assert.equal(path.posix.isAbsolute(manifest.entry), false, "Artifact entry must be relative");
  assert.equal(manifest.entry.includes(".."), false, "Artifact entry cannot traverse directories");
  const outputDirectoryName = path.posix.dirname(manifest.entry);
  assert.notEqual(outputDirectoryName, ".", "Artifact entry must use a dedicated output directory");
  const entryFileName = path.posix.basename(manifest.entry);
  const outputDirectory = path.join(stagingDirectory, outputDirectoryName);

  await mkdir(stagingDirectory, { recursive: true });
  await copySupplementalFiles(path.join(sourceDirectory, "files"), stagingDirectory);
  const result = await build({
    configFile: false,
    root: sourceDirectory,
    logLevel: "silent",
    plugins: [hostRuntimePlugin()],
    build: {
      // Tauri's asset protocol encodes an approved absolute path as one URL
      // segment. A relative ESM import would therefore resolve outside that
      // approved path. Keep each executable artifact in one JS file; CSS stays
      // separate because the host gives every admitted stylesheet its own
      // digest-qualified asset URL.
      assetsInlineLimit: Number.POSITIVE_INFINITY,
      cssCodeSplit: true,
      emptyOutDir: true,
      lib: { entry: sourceEntry, formats: ["es"] },
      minify: false,
      outDir: outputDirectory,
      sourcemap: false,
      write: false,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
          codeSplitting: false,
          entryFileNames: entryFileName,
        },
      },
    },
  });
  const outputs = rollupOutputs(result);
  const violations = inspectSharedRuntimeClosure(outputs);
  assert.deepEqual(
    violations,
    [],
    `Artifact contains a shared runtime dependency: ${JSON.stringify(violations)}`,
  );

  const emittedFiles = [];
  for (const output of outputs.sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    const relative = path.posix.join(outputDirectoryName, normalized(output.fileName));
    const destination = path.join(stagingDirectory, relative);
    const contents = output.type === "chunk" ? output.code : output.source;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    emittedFiles.push(relative);
  }
  assert.equal(emittedFiles.includes(manifest.entry), true, "Vite did not emit the manifest entry");

  const generatedStyles = emittedFiles.filter((file) => file.endsWith(".css"));
  const generatedAssets = emittedFiles.filter(
    (file) => file !== manifest.entry && !file.endsWith(".css"),
  );
  manifest.styles = uniqueSorted([...(manifest.styles ?? []), ...generatedStyles]);
  manifest.assets = uniqueSorted([...(manifest.assets ?? []), ...generatedAssets]);
  await writeFile(
    path.join(stagingDirectory, "module.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    schemaVersion: 1,
    sourceDirectory,
    stagingDirectory,
    moduleId: manifest.id,
    entry: manifest.entry,
    emittedFiles: ["module.yaml", ...emittedFiles].sort(),
    sharedRuntimePackages: [...SHARED_RUNTIME_PACKAGES],
    sharedRuntimeViolations: violations,
  };
}
