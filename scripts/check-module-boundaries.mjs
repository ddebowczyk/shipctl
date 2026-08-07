import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MODULE_API_PACKAGE = "@shep/module-api";
// The host's own capabilities ship as a workspace package so that node, tsc and
// Vite resolve them identically. That makes the host reachable by name, so it
// needs the same treatment as a relative reach into src/.
const HOST_PACKAGE = "@shep/core";
const HOST_ROOTS = ["src", "core/frontend"];
const COMPOSITION_FILES = new Set(["core/frontend/host/enabledModules.ts"]);

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

function importSpecifiers(sourceFile) {
  const imports = [];
  function visit(node) {
    let literal = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      imports.push({
        specifier: literal.text,
        line: position.line + 1,
        column: position.character + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

async function modulePackages(root) {
  const modulesRoot = path.join(root, "modules");
  const entries = await readdir(modulesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const frontendRoot = path.join(modulesRoot, entry.name, "frontend");
    try {
      const manifest = JSON.parse(await readFile(path.join(frontendRoot, "package.json"), "utf8"));
      packages.push({ name: manifest.name, root: frontendRoot });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return packages;
}

function packageMatch(specifier, packages) {
  return packages.find(({ name }) => specifier === name || specifier.startsWith(`${name}/`));
}

function diagnostic(file, entry, rule, message, root) {
  return {
    file: path.relative(root, file),
    line: entry.line,
    column: entry.column,
    specifier: entry.specifier,
    rule,
    message,
  };
}

export async function checkModuleBoundaries(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const packages = await modulePackages(absoluteRoot);
  const hostFiles = (await Promise.all(
    HOST_ROOTS.map(async (hostRoot) => {
      try {
        return await sourceFiles(path.join(absoluteRoot, hostRoot));
      } catch (error) {
        // Synthetic roots in the boundary tests carry only the trees they exercise.
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    }),
  )).flat();
  const files = [
    ...hostFiles,
    ...(
      await Promise.all(packages.map(({ root: packageRoot }) => sourceFiles(path.join(packageRoot, "src"))))
    ).flat(),
  ];
  const diagnostics = [];

  for (const file of files) {
    const relativeFile = path.relative(absoluteRoot, file);
    const owner = packages.find(({ root: packageRoot }) => isWithin(packageRoot, file));
    const source = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    for (const entry of importSpecifiers(sourceFile)) {
      const matchedPackage = packageMatch(entry.specifier, packages);
      const isComposition = COMPOSITION_FILES.has(relativeFile);
      const isRelative = entry.specifier.startsWith(".");

      if (owner) {
        if (isRelative) {
          const target = path.resolve(path.dirname(file), entry.specifier);
          if (!isWithin(owner.root, target)) {
            diagnostics.push(diagnostic(file, entry, "module-host-import", "module imports outside its package", absoluteRoot));
          }
        } else if (entry.specifier === "src" || entry.specifier.startsWith("src/")) {
          diagnostics.push(diagnostic(file, entry, "module-host-import", "module imports host source", absoluteRoot));
        } else if (entry.specifier === HOST_PACKAGE || entry.specifier.startsWith(`${HOST_PACKAGE}/`)) {
          diagnostics.push(diagnostic(file, entry, "module-host-import", "module imports host capabilities; use the module API", absoluteRoot));
        } else if (entry.specifier.startsWith(`${MODULE_API_PACKAGE}/`)) {
          diagnostics.push(diagnostic(file, entry, "module-api-deep-import", "use the public module API entrypoint", absoluteRoot));
        } else if (matchedPackage && matchedPackage.name !== MODULE_API_PACKAGE) {
          diagnostics.push(diagnostic(file, entry, "module-sibling-import", "modules may not import another module", absoluteRoot));
        }
        continue;
      }

      if (isRelative) {
        const target = path.resolve(path.dirname(file), entry.specifier);
        if (packages.some(({ root: packageRoot }) => isWithin(packageRoot, target))) {
          diagnostics.push(diagnostic(file, entry, "host-module-deep-import", "host must use a module public package entrypoint", absoluteRoot));
        }
      } else if (matchedPackage && matchedPackage.name !== MODULE_API_PACKAGE) {
        const isDeep = entry.specifier !== matchedPackage.name;
        if (isDeep || !isComposition) {
          diagnostics.push(diagnostic(
            file,
            entry,
            isDeep ? "host-module-deep-import" : "host-module-import-outside-composition",
            isDeep ? "host must use the module public entrypoint" : "module entrypoints may be imported only by enabledModules.ts",
            absoluteRoot,
          ));
        }
      }
    }
  }

  return diagnostics.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
  );
}

export function formatDiagnostics(diagnostics) {
  return diagnostics.map((item) =>
    `${item.file}:${item.line}:${item.column} [${item.rule}] ${item.message}: "${item.specifier}"`,
  ).join("\n");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const diagnostics = await checkModuleBoundaries();
  if (diagnostics.length > 0) {
    console.error(`Frontend module boundary violations:\n${formatDiagnostics(diagnostics)}`);
    process.exitCode = 1;
  } else {
    console.log("Frontend module boundaries: OK");
  }
}
