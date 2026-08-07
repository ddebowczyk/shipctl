# TypeScript 7 breaks the module-boundary gate

**Date:** 2026-08-07
**Context:** shep-he0 (upstream dependency refresh, integrated in `4bf779e`)
**Status:** TypeScript held at `^5.9.3`. This is the one upgrade from upstream `4dce7ea` that did not land.
**Owner:** unassigned — needs a senior decision on approach before implementation.

## Problem

`ops/` has two Node scripts that import the `typescript` package for its programmatic
compiler API. Under TypeScript 7 both fail at import-time resolution of the API surface,
so `just build app` and `just check all` cannot run.

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

The shep-he0 ledger entry (`ops/upstream/log/4dce7ea.md`) says the JavaScript API "is gone:
importing `typescript` under 7.0.2 yields exactly two exports, `version` and
`versionMajorMinor`." That is literally true of the **default entry point** and it is what
the error above comes from, but it is misleading about remediation, because the compiler API
did not disappear — it moved and was redesigned. The ledger has been corrected to point here.

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

**B. Pin TypeScript 5 for the tooling, run 7 for the compiler.**
`"typescript": "^7"` for `tsc`, plus `"typescript-api": "npm:typescript@^5.9.3"` as an ops
devDependency for the two scripts. Small, reversible, unblocks the compiler upgrade today.
Cost: two TypeScript copies, and the parser drifts from the compiler that actually checks
the code — acceptable here because the scripts only read import specifiers, and import
syntax is stable.

**C. Drop TypeScript from the scripts entirely.**
Neither script type-checks. They use a whole compiler to extract import specifiers and their
positions. `oxc-parser` (TS/TSX, fast, plain-data AST with spans) or `ast-grep` — already a
documented tool in this repo — would do the job with a stable, purpose-fit API, and the gate
would stop being coupled to compiler versions at all. This removes the recurring failure
rather than deferring it. Cost: rewriting both walkers, and `plugout.mjs`'s `node.parent`
logic needs rethinking against a different AST shape.

**D. Stay on TypeScript 5.9.3.** Current state. Zero cost, no compiler improvements, and the
problem returns whenever we do want 7.

## Recommendation

**C, with B as the unblock if TypeScript 7 is wanted before C is done.**

The root cause is that a lint gate depends on a compiler's internal API for a job that needs
a parser. Option A re-buys that coupling against an explicitly unstable surface; C ends it.
B is a legitimate two-line stopgap that makes the choice unhurried, and it composes with C
(do B now, C later) without wasted work.

Whichever is chosen, fix the `baseUrl` line independently — it is unrelated and free.

## Acceptance criteria

1. `just check all`, `just build app`, and `just test fast` pass with `tsc` at 7.x.
2. `ops/modularity/tests/moduleBoundaries.test.mjs` passes unmodified, including its
   `mkdtemp` synthetic roots — the gate's behavior must not change, only its parser.
3. Every rule in `check-module-boundaries.mjs` still fires: `src-entry-only`,
   `app-ops-import`, `core-capability-deep-import`, `module-host-import`,
   `module-api-deep-import`, `module-sibling-import`, `host-module-deep-import`,
   `host-module-import-outside-composition`.
4. Diagnostics keep `file:line:column` accuracy; add a test asserting a known violation's
   exact line and column, since that is the part a parser swap most easily gets wrong.
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
