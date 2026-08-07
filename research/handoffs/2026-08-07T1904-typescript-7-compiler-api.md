# TypeScript 7 compiler API compatibility

**Date:** 2026-08-07
**Context:** shep-he0 (upstream dependency refresh, integrated in `4bf779e`)
**Status:** Resolved with the official side-by-side TypeScript 7/6 arrangement.
**Decision:** Adopt corrected option B; option C remains optional future
decoupling.

## Resolution

TypeScript 7 supplies the native `tsc` binary through an npm alias, while
Microsoft's TypeScript 6 compatibility package supplies the legacy API at the
unchanged `typescript` import:

```json
{
  "@typescript/native": "npm:typescript@^7.0.2",
  "typescript": "npm:@typescript/typescript6@^6.0.2"
}
```

With pnpm, `pnpm exec tsc` resolves to 7.0.2 and `pnpm exec tsc6` resolves to
the compatibility compiler. The two ops scripts continue to import
`typescript` unchanged. The fixture's obsolete `baseUrl` setting was also
removed.

Proof on the live checkout:

- `just build app` passed with native TypeScript 7.0.2.
- `just test fast` passed, including all boundary and plug-out transformation
  tests.
- `just check all` passed, including all three TypeScript projects and the
  modularity gate.
- `pnpm install --frozen-lockfile` and `git diff --check` passed.

## Problem

`ops/` has two Node scripts that import the `typescript` package for its
programmatic compiler API. Directly replacing that package with TypeScript 7
makes both fail at import-time resolution of the API surface, so
`just build app` and `just check all` cannot run under a direct upgrade.

```
$ pnpm add -D typescript@7.0.2 && just build app
node ../modularity/bin/check-module-boundaries.mjs ../..
    ts.ScriptTarget.Latest,
                    ^
TypeError: Cannot read properties of undefined (reading 'Latest')
    at checkModuleBoundaries (ops/modularity/bin/check-module-boundaries.mjs:177:23)
```

The compiler itself is fine: `tsc --noEmit` passes on the whole repo under 7.0.2, including
both fixture projects, once `baseUrl` is removed (see *Secondary blocker*). Only the
programmatic API is affected.

## Correction to the first read

The first shep-he0 ledger read said the JavaScript API was gone because
importing `typescript` under 7.0.2 yields only `version` and
`versionMajorMinor`. That is true of the default entry point and causes the
error above, but it was incomplete remediation guidance. TypeScript 7 also
exposes redesigned unstable APIs, and Microsoft ships a TypeScript 6
compatibility package specifically for side-by-side API consumers. The
implemented solution uses that compatibility package rather than the unstable
API.

TypeScript 7's `exports` map:

```json
{
  ".":                        "./lib/version.cjs",
  "./unstable/ast":           "./dist/ast/index.js",
  "./unstable/ast/is":        "./dist/ast/is.js",
  "./unstable/ast/visitor":   "./dist/ast/visitor.js",
  "./unstable/ast/scanner":   "./dist/ast/scanner.js",
  "./unstable/ast/factory":   "./dist/ast/factory.generated.js",
  "./unstable/ast/clone":     "./dist/ast/clone.js",
  "./unstable/ast/utils":     "./dist/ast/utils.js",
  "./unstable/sync":          "./dist/api/sync/api.js",
  "./unstable/async":         "./dist/api/async/api.js",
  "./unstable/fs":            "./dist/api/fs.js",
  "./unstable/proto":         "./dist/api/proto.js"
}
```

`tsc` is now a native binary shipped through 20 platform-specific optional dependencies
(`@typescript/typescript-darwin-arm64` and friends). The `unstable/sync` and
`unstable/async` entries are a handle-based bridge to that binary — the exported names
include `NodeHandle`, `Snapshot`, `documentURIToFileName`, and `API.prototype` carries
`ensureInitialized`, `parseConfigFile`, `updateSnapshot`, `clearSourceFileCache`,
`close`. This is a project/session-oriented API, not the old free-function parser.

## What our scripts use, and what 7.0.2 offers

Both scripts do the same thing: parse one file at a time with `createSourceFile`, walk it
with `forEachChild`, and pull out import specifiers. Neither ever type-checks.

| Our call | In `typescript@7.0.2` | Verified |
| --- | --- | --- |
| `ts.createSourceFile` | absent from `unstable/ast` | yes |
| `ts.forEachChild` | absent; `unstable/ast/visitor` has `visitNode`, `visitEachChild`, `visitNodes` (transform-oriented) | yes |
| `ts.ScriptTarget`, `ts.ScriptKind`, `ts.SyntaxKind` | present in `unstable/ast` | yes |
| `ts.isImportDeclaration`, `isExportDeclaration`, `isCallExpression` | present in `unstable/ast/is` (347 predicates) | yes |
| `ts.isStringLiteralLike` | **absent** — predicate set was renamed/reshaped | yes |
| `sourceFile.getLineAndCharacterOfPosition`, `node.getStart(sourceFile)` | no equivalent found on `unstable/ast` | yes (absence only) |
| `node.parent` (needs `setParentNodes`) | unknown | no |

Open questions, all cheap to answer with a spike:

1. Can `unstable/sync` parse a **single ad-hoc file** without a tsconfig/project? `API.prototype`
   suggests config-driven setup. `unstable/fs`'s `createVirtualFileSystem` may be the way in.
2. Is the AST plain data, or `NodeHandle` proxies over the native process? That decides
   whether a synchronous recursive walk is even the right shape.
3. How do we get line/column for a node? Both scripts report `file:line:column`, and
   `unstable/ast/scanner` exposes `computeLineStarts`, which may be the intended route.

## Consumers

Both are in `ops/`; no application code imports `typescript`.

- **`ops/modularity/bin/check-module-boundaries.mjs`** (288 lines) — the boundary gate.
  Uses `createSourceFile`, `forEachChild`, `SyntaxKind.ImportKeyword`, `ScriptTarget`,
  `ScriptKind`, `isImportDeclaration`, `isExportDeclaration`, `isCallExpression`,
  `isStringLiteralLike`, plus `getLineAndCharacterOfPosition` and `getStart` for
  diagnostics. Run by `just build app`, `just check all`, and `just test fast`.
- **`ops/modularity/bin/plugout.mjs`** — module plug-out automation. Same parsing plus
  `isStringLiteral`, `isCaseClause`, `isExpressionStatement`, `isSourceFile`,
  `isVariableStatement`, `isArrayLiteralExpression`, and **`node.parent`**, which requires
  `setParentNodes: true`. This one is the harder port.

Constraint worth knowing before choosing an approach:
`ops/modularity/tests/moduleBoundaries.test.mjs` drives `checkModuleBoundaries(root)`
against **synthetic trees built in `mkdtemp`** — no tsconfig, no installed packages, just
files on disk. Whatever replaces the parser must work on a bare directory.

## Secondary blocker

TypeScript 7 removed `baseUrl`:

```
ops/modularity/fixtures/module-fixture/tsconfig.json(4,5): error TS5102:
  Option 'baseUrl' has been removed. Use '"paths": {"*": ["./*"]}' instead.
```

One file, one line. Independent of the API problem and safe to fix now — the `paths`
entries there are already relative, so `baseUrl: "."` is doing nothing.

## Options

**A. Port both scripts to `typescript/unstable/*`.**
Tracks upstream TypeScript. But the subpath is named `unstable` and TypeScript makes no
compatibility promise about it, so the gate can break again on any 7.x release. The port is
not mechanical: no single-file parser, a transform-shaped visitor instead of `forEachChild`,
and no position helpers yet identified. `plugout.mjs`'s `node.parent` use may not be
expressible at all.

**B. Use Microsoft's TypeScript 6 compatibility package beside TypeScript 7.**
`"@typescript/native": "npm:typescript@^7.0.2"` supplies the native `tsc`
binary, while `"typescript": "npm:@typescript/typescript6@^6.0.2"` supplies
the legacy API under the existing import name. This is the official transition
arrangement, requires no script changes, and keeps the parser on the maintained
6.x compatibility line.

**C. Drop TypeScript from the scripts entirely.**
Neither script type-checks. They use a whole compiler to extract import specifiers and their
positions. `oxc-parser` (TS/TSX, fast, plain-data AST with spans) or `ast-grep` — already a
documented tool in this repo — would do the job with a stable, purpose-fit API, and the gate
would stop being coupled to compiler versions at all. This removes the recurring failure
rather than deferring it. Cost: rewriting both walkers, and `plugout.mjs`'s `node.parent`
logic needs rethinking against a different AST shape.

**D. Stay on TypeScript 5.9.3.** No compiler improvements, and the problem
returns whenever we do want 7.

## Recommendation

**B now. C is optional future decoupling, not a prerequisite for TypeScript 7.**

The official compatibility package makes B a supported transition path rather
than a custom TypeScript 5 pin. It satisfies the upgrade contract without
rewriting the parent- and source-range-sensitive plug-out transformations. C
could still simplify the dependency model later, but the TypeScript 7 upgrade
does not justify that larger change by itself.

Whichever is chosen, fix the `baseUrl` line independently — it is unrelated and free.

## Acceptance criteria

1. `just check all`, `just build app`, and `just test fast` pass with `tsc` at 7.x.
2. `ops/modularity/tests/moduleBoundaries.test.mjs` passes unmodified, including its
   `mkdtemp` synthetic roots — the gate's behavior and parser must not change.
3. Every rule in `check-module-boundaries.mjs` still fires: `src-entry-only`,
   `app-ops-import`, `core-capability-deep-import`, `module-host-import`,
   `module-api-deep-import`, `module-sibling-import`, `host-module-deep-import`,
   `host-module-import-outside-composition`.
4. Diagnostics keep their existing `file:line:column` behavior through the
   unchanged parser.
5. `plugout.mjs` still drives a full module plug-out (`ops/modularity` has the existing
   proof recipes).
6. `ops/modularity/fixtures/module-fixture/tsconfig.json` no longer sets `baseUrl`.

## Reproduction

```bash
sed -i '' 's/"typescript": "\^5\.9\.3"/"typescript": "^7.0.2"/' package.json
pnpm install
just build app        # TypeError at check-module-boundaries.mjs:177
just check types-all  # TS5102 baseUrl in the module-fixture project
pnpm exec tsc --noEmit  # passes — the compiler is not the problem
```

To inspect the new API without touching the repo:

```bash
mkdir /tmp/ts7 && cd /tmp/ts7
printf '{"name":"probe","private":true,"type":"module"}' > package.json
pnpm add typescript@7.0.2
node -e "import('typescript/unstable/ast').then(m=>console.log(Object.keys(m).length))"
```
