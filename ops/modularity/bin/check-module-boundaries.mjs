import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MODULE_API_PACKAGE = "@shipctl/module-api";
const TAURI_EVENT_PACKAGE = "@tauri-apps/api/event";
const MODULE_PLATFORM_EVENT_LISTENERS = new Map([
  ["@shipctl/module-git", new Set(["git-fs-changed"])],
]);
// The host's own capabilities ship as a workspace package so that node, tsc and
// Vite resolve them identically. That makes the host reachable by name, so it
// needs the same treatment as a relative reach into src/.
const HOST_PACKAGE = "@shipctl/core";
const HOST_ROOTS = ["src", "core/frontend"];
const COMPOSITION_FILES = new Set(["core/frontend/host/enabledModules.ts"]);
const SRC_ENTRY_FILES = new Set(["src/main.tsx", "src/vite-env.d.ts"]);
// The packaged-app scenario harness claims that the terminal surface can be
// driven entirely through its port. That claim is only evidence if the
// scenarios cannot reach past it, so the directory is held to its own siblings:
// no xterm, no renderer, no DOM helper, no capability entrypoint. The one way
// out is the dev-only entry, which loads the composition root that binds the
// real surface — and that reach is named below rather than implied.
const SCENARIO_ROOTS = ["core/frontend/terminal/scenarios"];
const SCENARIO_IMPORT_EXCEPTIONS = new Set([
  "core/frontend/terminal/scenarios/terminalScenarioEntry.ts->../terminalScenarioHost.ts",
]);
const CORE_DEEP_IMPORT_EXCEPTIONS = new Set([
  "core/frontend/host/index.ts->terminal/terminalSessions.ts",
  "core/frontend/host/moduleHostServices.ts->appearance/useThemeStore.ts",
  "core/frontend/host/moduleHostServices.ts->projects/useProjectSettingsStore.ts",
  "core/frontend/host/moduleHostServices.ts->projects/useRepoStore.ts",
  "core/frontend/host/moduleHostServices.ts->terminal/terminalSessions.ts",
  "core/frontend/host/moduleHostServices.ts->terminal/useTerminalStore.ts",
  "core/frontend/host/projectFacts.ts->projects/projectFacts.ts",
]);

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

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
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

function moduleTauriEventUsage(sourceFile) {
  const eventAliases = new Map();
  const namespaceAliases = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== TAURI_EVENT_PACKAGE
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        eventAliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceAliases.add(bindings.name.text);
    }
  }

  const listeners = [];
  const escapes = [];
  function visit(node) {
    let eventApi = null;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      eventApi = eventAliases.get(node.expression.text) ?? null;
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && namespaceAliases.has(node.expression.expression.text)
    ) {
      eventApi = node.expression.name.text;
    }
    if (eventApi === "listen") {
      const argument = node.arguments[0];
      const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
      listeners.push({
        specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : "<dynamic>",
        line: position.line + 1,
        column: position.character + 1,
      });
    } else if (eventApi !== null) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
      escapes.push({
        specifier: `${TAURI_EVENT_PACKAGE}#${eventApi}`,
        line: position.line + 1,
        column: position.character + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { listeners, escapes };
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

async function coreEntrypoints(root) {
  const coreRoot = path.join(root, "core/frontend");
  try {
    const manifest = JSON.parse(await readFile(path.join(coreRoot, "package.json"), "utf8"));
    const entries = Object.entries(manifest.exports ?? {});
    return {
      specifiers: new Set(entries.map(([key]) =>
        key === "." ? HOST_PACKAGE : `${HOST_PACKAGE}/${key.slice(2)}`
      )),
      targets: new Set(entries.map(([, target]) => path.resolve(coreRoot, target))),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { specifiers: new Set(), targets: new Set() };
    throw error;
  }
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
  const coreRoot = path.join(absoluteRoot, "core/frontend");
  const opsRoot = path.join(absoluteRoot, "ops");
  const coreEntries = await coreEntrypoints(absoluteRoot);
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

  try {
    for (const file of await allFiles(path.join(absoluteRoot, "src"))) {
      const relativeFile = path.relative(absoluteRoot, file);
      if (!SRC_ENTRY_FILES.has(relativeFile)) {
        diagnostics.push(diagnostic(
          file,
          { line: 1, column: 1, specifier: relativeFile },
          "src-entry-only",
          "src may contain only the Vite entry files",
          absoluteRoot,
        ));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

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
    const directTauriUsage = owner ? moduleTauriEventUsage(sourceFile) : { listeners: [], escapes: [] };

    if (owner) {
      const allowedEvents = MODULE_PLATFORM_EVENT_LISTENERS.get(owner.name) ?? new Set();
      for (const event of directTauriUsage.listeners) {
        if (!allowedEvents.has(event.specifier)) {
          diagnostics.push(diagnostic(
            file,
            event,
            "module-direct-tauri-event",
            "module communication must use declared message routes; only classified platform events may use Tauri listeners",
            absoluteRoot,
          ));
        }
      }
      for (const escape of directTauriUsage.escapes) {
        diagnostics.push(diagnostic(
          file,
          escape,
          "module-direct-tauri-event",
          "module communication must use declared message routes; only classified platform events may use Tauri listeners",
          absoluteRoot,
        ));
      }
    }

    const scenarioRoot = SCENARIO_ROOTS.find((root) => isWithin(path.join(absoluteRoot, root), file));

    for (const entry of importSpecifiers(sourceFile)) {
      const matchedPackage = packageMatch(entry.specifier, packages);
      const isComposition = COMPOSITION_FILES.has(relativeFile);
      const isRelative = entry.specifier.startsWith(".");

      if (scenarioRoot) {
        const target = isRelative ? path.resolve(path.dirname(file), entry.specifier) : null;
        const staysInside = target !== null
          && isWithin(path.join(absoluteRoot, scenarioRoot), target);
        if (!staysInside && !SCENARIO_IMPORT_EXCEPTIONS.has(`${relativeFile}->${entry.specifier}`)) {
          diagnostics.push(diagnostic(
            file,
            entry,
            "scenario-port-only",
            "scenarios may reach the surface only through their port; a scenario that "
              + "imports a renderer, a DOM helper or a capability entrypoint proves that it "
              + "ran, not where authority sits",
            absoluteRoot,
          ));
          continue;
        }
      }

      if (isRelative) {
        const target = path.resolve(path.dirname(file), entry.specifier);
        if (isWithin(opsRoot, target)) {
          diagnostics.push(diagnostic(file, entry, "app-ops-import", "application code may not import repo operations", absoluteRoot));
          continue;
        }

        if (isWithin(coreRoot, file) && isWithin(coreRoot, target)) {
          const sourceCapability = path.relative(coreRoot, file).split(path.sep)[0];
          const targetRelative = path.relative(coreRoot, target);
          const targetCapability = targetRelative.split(path.sep)[0];
          const exception = `${relativeFile}->${targetRelative}`;
          if (
            sourceCapability !== targetCapability
            && targetCapability !== "platform"
            && targetCapability !== "shared"
            && !coreEntries.targets.has(target)
            && !CORE_DEEP_IMPORT_EXCEPTIONS.has(exception)
          ) {
            diagnostics.push(diagnostic(
              file,
              entry,
              "core-capability-deep-import",
              "cross-capability imports must use a public entrypoint",
              absoluteRoot,
            ));
            continue;
          }
        }
      } else if (
        (entry.specifier === HOST_PACKAGE || entry.specifier.startsWith(`${HOST_PACKAGE}/`))
        && !coreEntries.specifiers.has(entry.specifier)
      ) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "core-capability-deep-import",
          "use an exported core capability entrypoint",
          absoluteRoot,
        ));
        continue;
      }

      if (owner) {
        if (entry.specifier === TAURI_EVENT_PACKAGE) {
          if (
            directTauriUsage.listeners.length === 0
            && directTauriUsage.escapes.length === 0
          ) {
            diagnostics.push(diagnostic(
              file,
              entry,
              "module-direct-tauri-event",
              "module communication must use declared message routes; only classified platform events may use Tauri listeners",
              absoluteRoot,
            ));
          }
          continue;
        }
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
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const diagnostics = await checkModuleBoundaries(root);
  if (diagnostics.length > 0) {
    console.error(`Frontend module boundary violations:\n${formatDiagnostics(diagnostics)}`);
    process.exitCode = 1;
  } else {
    console.log("Frontend module boundaries: OK");
  }
}
