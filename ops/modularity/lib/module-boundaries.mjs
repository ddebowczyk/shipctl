import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MODULE_API_PACKAGE = "@shipctl/module-api";
const TAURI_EVENT_PACKAGE = "@tauri-apps/api/event";
// The host's own capabilities ship as a workspace package so that node, tsc and
// Vite resolve them identically. That makes the host reachable by name, so it
// needs the same treatment as a relative reach into src/.
const HOST_PACKAGE = "@shipctl/core";
const HOST_ROOTS = ["src", "core/frontend"];
const CANVAS_ROOT = "core/frontend/canvas";
const PLATFORM_ROOT = "core/frontend/platform";
const RUNTIME_ROOT = "core/frontend/runtime";
const SHELL_ROOT = "core/frontend/shell";
const SRC_ENTRY_FILES = new Set(["src/main.tsx", "src/vite-env.d.ts"]);
// Terminal scenario harnesses, when present, can only use their local contract
// and the explicitly named composition entry. This preserves the port-only
// rule without restoring the retired terminal capability.
const SCENARIO_ROOTS = ["core/frontend/terminal-host/scenarios"];
const SCENARIO_IMPORT_EXCEPTIONS = new Set();
const CORE_DEEP_IMPORT_EXCEPTIONS = new Map([
  [
    "core/frontend/host/moduleHostServices.ts->appearance/useThemeStore.ts",
    {
      owner: "core/frontend/host/moduleHostServices.ts",
      rationale: "The legacy host-service adapter supplies concrete appearance state.",
      deletionCondition: "Step 08: delete after all legacy artifacts use direct activation.",
    },
  ],
  [
    "core/frontend/host/moduleHostServices.ts->projects/useProjectSettingsStore.ts",
    {
      owner: "core/frontend/host/moduleHostServices.ts",
      rationale: "The legacy host-service adapter supplies concrete project settings.",
      deletionCondition: "Step 08: delete after all legacy artifacts use direct activation.",
    },
  ],
  [
    "core/frontend/host/moduleHostServices.ts->projects/useRepoStore.ts",
    {
      owner: "core/frontend/host/moduleHostServices.ts",
      rationale: "The legacy host-service adapter supplies concrete repository state.",
      deletionCondition: "Step 08: delete after all legacy artifacts use direct activation.",
    },
  ],
  [
    "core/frontend/host/moduleHostServices.ts->terminal-host/terminalSessions.ts",
    {
      owner: "core/frontend/host/moduleHostServices.ts",
      rationale: "The legacy host-service adapter supplies raw terminal session access.",
      deletionCondition: "Step 08: delete after all legacy artifacts use direct activation.",
    },
  ],
  [
    "core/frontend/host/moduleHostServices.ts->terminal-host/useTerminalStore.ts",
    {
      owner: "core/frontend/host/moduleHostServices.ts",
      rationale: "The legacy host-service adapter supplies concrete terminal state.",
      deletionCondition: "Step 08: delete after all legacy artifacts use direct activation.",
    },
  ],
]);

export function parseTypeScriptSource(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function sourceFiles(directory) {
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

export function importSpecifiers(sourceFile) {
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

export function staticImportSpecifiers(sourceFile) {
  return sourceFile.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function withoutSourceExtension(value) {
  return value.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function canvasPersistenceReferences(file, sourceFile, root) {
  const persistencePaths = new Set([
    "core/frontend/workspace/persistence.ts",
    "core/frontend/platform/workspacePersistence.ts",
  ].map((relative) => withoutSourceExtension(path.join(root, relative))));
  const references = [];
  for (const entry of importSpecifiers(sourceFile)) {
    const target = entry.specifier.startsWith(".")
      ? withoutSourceExtension(path.resolve(path.dirname(file), entry.specifier))
      : null;
    if (target !== null && persistencePaths.has(target)) {
      references.push(entry);
    } else if (entry.specifier === "shipctl.plugin-data") {
      references.push(entry);
    }
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node) && node.text === "shipctl.plugin-data") {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const duplicate = references.some((entry) =>
        entry.line === position.line + 1 && entry.column === position.character + 1);
      if (!duplicate) {
        references.push({
          specifier: node.text,
          line: position.line + 1,
          column: position.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

function declarationForbiddenSpecifiers(declaration) {
  const references = new Set();
  for (const match of declaration.matchAll(/(?:from\s*|import\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (
      specifier === "cordis"
      || specifier.startsWith("cordis/")
      || specifier.startsWith("@cordis/")
      || specifier === "@shipctl/cordis-source"
      || specifier.startsWith("@shipctl/cordis-source/")
      || specifier.startsWith("@tauri-apps/")
    ) {
      references.add(specifier);
    }
  }
  return references;
}

async function moduleApiDeclarationPurityDiagnostics(root, moduleApi) {
  if (!moduleApi) return [];
  let files;
  try {
    files = await sourceFiles(path.join(moduleApi.root, "src"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (files.length === 0) return [];
  const declarationOutputs = [];
  const compilerOptions = {
    allowImportingTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmitOnError: false,
    removeComments: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2021,
  };
  const program = ts.createProgram(files, compilerOptions);
  program.emit(
    undefined,
    (fileName, text) => declarationOutputs.push({ fileName, text }),
    undefined,
    true,
  );
  const specifiers = new Set(declarationOutputs.flatMap(({ text }) =>
    [...declarationForbiddenSpecifiers(text)]));
  const entrypoint = path.join(moduleApi.root, "src", "index.ts");
  return [...specifiers].sort().map((specifier) => diagnostic(
    entrypoint,
    { line: 1, column: 1, specifier },
    "module-api-purity",
    "@shipctl/module-api declaration output may not reference Cordis or Tauri types",
    root,
  ));
}

export function moduleTauriEventUsage(sourceFile) {
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

async function frontendPackage(root, relativeRoot) {
  const frontendRoot = path.join(root, relativeRoot);
  try {
    const manifest = JSON.parse(await readFile(path.join(frontendRoot, "package.json"), "utf8"));
    return { name: manifest.name, root: frontendRoot };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function frontendPackages(root) {
  const modulesRoot = path.join(root, "modules");
  let entries = [];
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRecord = await frontendPackage(root, path.join("modules", entry.name, "frontend"));
    if (packageRecord) packages.push(packageRecord);
  }
  const moduleApi = await frontendPackage(root, path.join("module-api", "frontend"));
  if (moduleApi) packages.push(moduleApi);
  return packages;
}

export const DEFAULT_PASSIVE_IMPORT_RULES = Object.freeze({
  filesystemPackagePrefixes: Object.freeze(["node:fs"]),
  moduleLoadGlobals: Object.freeze(["import"]),
  networkGlobals: Object.freeze(["fetch", "WebSocket"]),
  registryReceivers: Object.freeze(["customElements", "registry"]),
  tauriPackagePrefixes: Object.freeze(["@tauri-apps/"]),
  tauriReceivers: Object.freeze(["__TAURI_INTERNALS__"]),
  timerGlobals: Object.freeze(["setInterval", "setTimeout"]),
});

function importBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) {
      bindings.set(clause.name.text, { imported: "default", specifier });
    }
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, { imported: "*", specifier });
    } else if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          specifier,
        });
      }
    }
  }
  return bindings;
}

function expressionSegments(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return ["import"];
  if (ts.isPropertyAccessExpression(expression)) {
    return [...expressionSegments(expression.expression), expression.name.text];
  }
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return [...expressionSegments(expression.expression), expression.argumentExpression.text];
  }
  return [];
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value === prefix || value.startsWith(prefix));
}

function effectForExpression(expression, bindings, rules) {
  const segments = expressionSegments(expression);
  const root = segments[0];
  const binding = root ? bindings.get(root) : null;
  if (binding && startsWithAny(binding.specifier, rules.filesystemPackagePrefixes)) {
    return { channel: "filesystem", specifier: binding.specifier };
  }
  if (binding && startsWithAny(binding.specifier, rules.tauriPackagePrefixes)) {
    return { channel: "tauri", specifier: binding.specifier };
  }
  if (segments.some((segment) => rules.tauriReceivers.includes(segment))) {
    return { channel: "tauri", specifier: segments.join(".") };
  }
  if (segments.some((segment) => rules.registryReceivers.includes(segment))) {
    return { channel: "registry", specifier: segments.join(".") };
  }
  if (root && rules.timerGlobals.includes(root)) {
    return { channel: "timer", specifier: root };
  }
  if (root && rules.networkGlobals.includes(root)) {
    return { channel: "network", specifier: root };
  }
  if (root && rules.moduleLoadGlobals.includes(root)) {
    return { channel: "module-load", specifier: root };
  }
  return null;
}

/**
 * Inspect only expressions evaluated while an entrypoint is imported. Function
 * and class bodies are activation-time code and are deliberately excluded.
 */
export function moduleTopLevelEffects(
  sourceFile,
  rules = DEFAULT_PASSIVE_IMPORT_RULES,
) {
  const bindings = importBindings(sourceFile);
  const effects = [];

  function inspect(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        const isStatic = ts.isClassStaticBlockDeclaration(member)
          || member.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic) inspect(member);
      }
      return;
    }
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isMethodDeclaration(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const effect = effectForExpression(node.expression, bindings, rules);
      if (effect) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
        effects.push({
          ...effect,
          line: position.line + 1,
          column: position.character + 1,
        });
      }
    }
    ts.forEachChild(node, inspect);
  }

  for (const statement of sourceFile.statements) inspect(statement);
  return effects.sort((left, right) => left.line - right.line || left.column - right.column);
}

function resolveStaticModule(specifier, importer, sourceFileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(base);
  const candidates = extension
    ? [
        base,
        ...(
          [".js", ".jsx", ".mjs", ".cjs"].includes(extension)
            ? [...SOURCE_EXTENSIONS].map((sourceExtension) =>
                `${base.slice(0, -extension.length)}${sourceExtension}`)
            : []
        ),
      ]
    : [
        base,
        ...[...SOURCE_EXTENSIONS].map((sourceExtension) => `${base}${sourceExtension}`),
        ...[...SOURCE_EXTENSIONS].map((sourceExtension) => path.join(base, `index${sourceExtension}`)),
      ];
  return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

export function staticImportClosure(entrypoint, sourceFilesByPath) {
  if (!entrypoint || !sourceFilesByPath.has(entrypoint)) return [];
  const reachable = new Set();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const sourceFile = sourceFilesByPath.get(file);
    for (const specifier of staticImportSpecifiers(sourceFile)) {
      const target = resolveStaticModule(specifier, file, sourceFilesByPath);
      if (target && !reachable.has(target)) queue.push(target);
    }
  }
  return [...reachable].sort();
}

export async function inspectFrontendArchitecture(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const packages = (await frontendPackages(absoluteRoot))
    .filter(({ name }) => name !== MODULE_API_PACKAGE);
  const modules = [];
  for (const packageRecord of packages.sort((left, right) => left.name.localeCompare(right.name))) {
    const manifest = JSON.parse(await readFile(path.join(packageRecord.root, "package.json"), "utf8"));
    const entryTarget = manifest.exports?.["."];
    const entrypoint = typeof entryTarget === "string"
      ? path.resolve(packageRecord.root, entryTarget)
      : null;
    const files = (await sourceFiles(path.join(packageRecord.root, "src"))).sort();
    const imports = [];
    const tauriImports = [];
    const sourceFilesByPath = new Map();
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const sourceFile = parseTypeScriptSource(file, source);
      sourceFilesByPath.set(file, sourceFile);
      for (const entry of importSpecifiers(sourceFile)) {
        const item = {
          file: path.relative(absoluteRoot, file),
          line: entry.line,
          specifier: entry.specifier,
        };
        imports.push(item);
        if (entry.specifier.startsWith("@tauri-apps/")) tauriImports.push(item);
      }
    }
    const importClosure = staticImportClosure(entrypoint, sourceFilesByPath);
    const entrypointEffects = importClosure.flatMap((file) =>
      moduleTopLevelEffects(sourceFilesByPath.get(file)).map((effect) => ({
        file: path.relative(absoluteRoot, file),
        ...effect,
      })));
    modules.push({
      package: packageRecord.name,
      package_root: path.relative(absoluteRoot, packageRecord.root),
      entrypoint: entrypoint ? path.relative(absoluteRoot, entrypoint) : null,
      source_files: files.map((file) => path.relative(absoluteRoot, file)),
      import_closure: importClosure.map((file) => path.relative(absoluteRoot, file)),
      imports: imports.sort((left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.specifier.localeCompare(right.specifier)),
      tauri_imports: tauriImports.sort((left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.specifier.localeCompare(right.specifier)),
      entrypoint_effects: entrypointEffects,
    });
  }
  return {
    composition: [],
    modules,
  };
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
  const packages = await frontendPackages(absoluteRoot);
  const moduleApi = packages.find(({ name }) => name === MODULE_API_PACKAGE);
  const packagePassiveFiles = new Map();
  for (const packageRecord of packages) {
    const manifest = JSON.parse(await readFile(path.join(packageRecord.root, "package.json"), "utf8"));
    const entryTarget = manifest.exports?.["."];
    if (typeof entryTarget === "string") {
      const entrypoint = path.resolve(packageRecord.root, entryTarget);
      if (packageRecord.name !== MODULE_API_PACKAGE) {
        const packageFiles = await sourceFiles(path.join(packageRecord.root, "src"));
        const sourceFilesByPath = new Map();
        for (const file of packageFiles) {
          sourceFilesByPath.set(
            file,
            parseTypeScriptSource(file, await readFile(file, "utf8")),
          );
        }
        packagePassiveFiles.set(
          packageRecord.name,
          new Set(staticImportClosure(entrypoint, sourceFilesByPath)),
        );
      }
    }
  }
  const coreRoot = path.join(absoluteRoot, "core/frontend");
  const canvasRoot = path.join(absoluteRoot, CANVAS_ROOT);
  const platformRoot = path.join(absoluteRoot, PLATFORM_ROOT);
  const runtimeRoot = path.join(absoluteRoot, RUNTIME_ROOT);
  const shellRoot = path.join(absoluteRoot, SHELL_ROOT);
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

  diagnostics.push(...await moduleApiDeclarationPurityDiagnostics(absoluteRoot, moduleApi));

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
    const isCanvas = isWithin(canvasRoot, file);
    const isRuntime = isWithin(runtimeRoot, file);
    const source = await readFile(file, "utf8");
    const sourceFile = parseTypeScriptSource(file, source);
    const directTauriUsage = owner ? moduleTauriEventUsage(sourceFile) : { listeners: [], escapes: [] };
    const canvasPersistenceEntries = isCanvas
      ? canvasPersistenceReferences(file, sourceFile, absoluteRoot)
      : [];
    const canvasPersistenceSpecifiers = new Set(
      canvasPersistenceEntries.map(({ specifier }) => specifier),
    );

    if (isCanvas) {
      for (const entry of canvasPersistenceEntries) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "canvas-persistence-import",
          "canvas adapters use the workspace service and may not reach persistence or plugin data directly",
          absoluteRoot,
        ));
      }
    }

    if (owner) {
      if (
        owner.name !== MODULE_API_PACKAGE
        && packagePassiveFiles.get(owner.name)?.has(file)
      ) {
        for (const effect of moduleTopLevelEffects(sourceFile)) {
          diagnostics.push(diagnostic(
            file,
            effect,
            "module-entrypoint-side-effect",
            `module package import performs ${effect.channel}; move it behind explicit activation`,
            absoluteRoot,
          ));
        }
      }
      for (const event of directTauriUsage.listeners) {
        diagnostics.push(diagnostic(
          file,
          event,
          "module-direct-tauri-event",
          "module communication must use declared message routes; only classified platform events may use Tauri listeners",
          absoluteRoot,
        ));
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
      const isRelative = entry.specifier.startsWith(".");
      const isTauriImport = entry.specifier.startsWith("@tauri-apps/");
      const target = isRelative ? path.resolve(path.dirname(file), entry.specifier) : null;
      const runtimeImportsPresentation = target !== null
        && (isWithin(canvasRoot, target) || isWithin(shellRoot, target));
      const runtimeImportsPresentationPackage = entry.specifier === `${HOST_PACKAGE}/canvas`
        || entry.specifier.startsWith(`${HOST_PACKAGE}/canvas/`)
        || entry.specifier === `${HOST_PACKAGE}/shell`
        || entry.specifier.startsWith(`${HOST_PACKAGE}/shell/`);

      if (
        isRuntime
        && (
          entry.specifier === "react"
          || entry.specifier.startsWith("react/")
          || isTauriImport
          || runtimeImportsPresentation
          || runtimeImportsPresentationPackage
          || (matchedPackage && matchedPackage.name !== MODULE_API_PACKAGE)
        )
      ) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "runtime-import-boundary",
          "runtime stays React-, Tauri-, presentation-, and module-package-free",
          absoluteRoot,
        ));
        continue;
      }

      if (isTauriImport && !isWithin(platformRoot, file)) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "tauri-import-outside-platform",
          "frontend Tauri imports belong in core/frontend/platform; modules use semantic services",
          absoluteRoot,
        ));
        continue;
      }

      if (isCanvas && entry.specifier.startsWith("@tauri-apps/")) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "canvas-tauri-import",
          "canvas adapters receive host facts and actions; native Tauri APIs stay in shell or platform",
          absoluteRoot,
        ));
        continue;
      }

      if (isCanvas && matchedPackage && matchedPackage.name !== MODULE_API_PACKAGE) {
        diagnostics.push(diagnostic(
          file,
          entry,
          "canvas-feature-module-import",
          "canvas adapters render feature contributions through host ports and may not import feature modules",
          absoluteRoot,
        ));
        continue;
      }

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

        if (canvasPersistenceSpecifiers.has(entry.specifier)) continue;

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
        if (
          entry.specifier === "cordis"
          || entry.specifier.startsWith("cordis/")
          || entry.specifier.startsWith("@cordis")
          || entry.specifier === "@shipctl/cordis-source"
          || entry.specifier.startsWith("@shipctl/cordis-source/")
        ) {
          diagnostics.push(diagnostic(
            file,
            entry,
            "module-cordis-import",
            "plugins use the Shipctl runtime contract; Cordis lifecycle authority stays in the runtime adapter",
            absoluteRoot,
          ));
          continue;
        }
        if (entry.specifier === "react-layman" || entry.specifier.startsWith("react-layman/")) {
          diagnostics.push(diagnostic(
            file,
            entry,
            "module-renderer-import",
            "modules publish semantic views; canvas renderer implementations stay in core",
            absoluteRoot,
          ));
          continue;
        }
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
        diagnostics.push(diagnostic(
          file,
          entry,
          isDeep ? "host-module-deep-import" : "host-module-import-outside-composition",
          isDeep ? "host must use the module public entrypoint" : "host may not statically import module packages; use admitted runtime artifacts",
          absoluteRoot,
        ));
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
