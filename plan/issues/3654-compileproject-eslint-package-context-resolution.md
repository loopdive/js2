---
horizon: m
id: 3654
title: "compileProject ESLint graph: resolve importer-scoped deps and extensionless CJS modules"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: module-resolution
language_feature: commonjs-module-resolution
goal: npm-library-support
sprint: current
required_by: [1400, 2691]
es_edition: n/a
related: [81, 1044, 1279, 1400, 1559, 1560, 1575, 1791, 2691, 2700, 3653, 3655]
---

# #3654 — Restore the real ESLint `compileProject` module graph

## Problem

`compileProject("node_modules/eslint/lib/linter/linter.js",
{ allowJs: true })` stops before Wasm. The direct entry emitted 141
diagnostics on current `origin/main`: 52 errors and 89 warnings.

The 52 errors are **not 52 independent tasks**. A concentrated resolver layer
fails first and causes later missing-export/type cascades.

## Measured resolver failures (ESLint 10.0.3, 2026-07-26)

The compiler reports TS2307 for:

- `node:path`;
- installed package dependencies `eslint-scope`, `eslint-visitor-keys`,
  `@eslint/plugin-kit`, `debug`, and the type-only `@eslint/core`;
- existing relative modules such as `../shared/traverser`,
  `../languages/js/source-code`, `./apply-disable-directives`,
  `./source-code-fixer`, `./source-code-visitor`, and `./timing`;
- existing directory/type imports such as `../types`.

These are not absent files:

- `eslint-scope`, `eslint-visitor-keys`, `@eslint/plugin-kit`, `debug`,
  `espree`, and `esquery` resolve from ESLint's physical importer context;
- `@eslint/core@1.1.1` is installed and intentionally exports types only
  (`exports.types.import` / `exports.types.require`);
- every relative runtime module named above exists, including directory
  `index.js` entries.

`require("../../package.json")` is excluded from this issue and tracked as
#3655.

## Investigation boundary

Do not assume all forms share one root cause. Instrument the graph expansion
and record, for each specifier:

1. logical importer path;
2. physical/real importer path through pnpm symlinks;
3. resolution mode (CJS runtime, types-only/JSDoc import, Node builtin, JSON);
4. candidate paths and the point at which they are discarded.

If package-context resolution, extensionless relative resolution, and
types-only conditional exports are independent defects, split them into
separate implementation issues before coding. This issue owns the measured
frontier and the phase attribution.

## Implementation findings (2026-07-26)

The package, extensionless/directory, and type-only failures share one graph
boundary:

1. `ModuleResolver` asked TypeScript to resolve from ESLint's logical
   `node_modules/eslint` symlink. pnpm's private dependencies are reachable
   only from the physical importer under `.pnpm/eslint@10.0.3/node_modules`.
2. `resolveAllImports` only rewrote single-declarator CommonJS statements.
   ESLint's first dependency block is one grouped `const` statement, so its
   package and relative edges were never visited.
3. `compileProject` flattened resolved files into an in-memory record and
   discarded the exact importer/specifier/target edges. The virtual TypeScript
   host then attempted to rediscover pnpm resolution from flattened names.
4. JSDoc `import("...")` and `@import ... from "..."` type edges were not
   included in the graph, and the multi-file checker did not inject the Node
   ambient module surface used by the single-file Node lane.

The implementation therefore keeps these as one resolver-layer task: resolve
against physical importers, canonicalize graph identity, retain exact edges
through the virtual checker, traverse grouped static CommonJS and JSDoc type
edges, and register Node builtins as JS-host imports in multi-file codegen.
Static JSON loading remains separate in #3655.

After the change, direct `linter.js` analysis expands 149 canonical sources and
has no TS2307 for `node:path`, the listed installed packages, the listed
relative files, or `../types`. The sole entry-file TS2307 is
`../../package.json`, exactly the #3655 boundary.

The first full codegen probe no longer stops at resolver diagnostics, but it
does not complete within the existing 180-second ESLint test budget. That
post-resolution scale/performance frontier is split into #3672.

## Required behaviour

- Resolve transitive packages relative to the importing ESLint package, not
  only from the repository root.
- Honor CommonJS extension probing and directory `index.js` resolution.
- Honor `exports.types.require` / `exports.types.import` for type-only packages
  without requiring a runtime JavaScript entry.
- For the initial ESLint proof, compile in the JS-host lane and preserve Node
  builtins as host dependencies. Under the Node test host, `node:path` and
  other `node:*` imports must be supplied by the real Node modules rather than
  becoming a prerequisite for standalone/WASI builtin implementations.
- Preserve pnpm symlink identity without compiling duplicate logical/physical
  copies of a module.

## Acceptance criteria

- The direct `linter.js` compile has zero TS2307 errors for the installed
  packages and existing relative modules listed above.
- The resulting graph contains one canonical source per module.
- Reduced fixtures cover importer-scoped pnpm dependencies, extensionless
  files, directory indexes, types-only conditional exports, and a Node builtin
  passed through and executed in the Node-host JS lane.
- The first ESLint integration test does not claim or require standalone
  support; no standalone Node builtin shim is added merely to make this rung
  pass.
- `tests/issue-3654.test.ts` permanently covers importer-scoped pnpm
  resolution, extensionless and directory CommonJS imports, types-only
  conditional exports, and Node-host builtin pass-through.
- JSON loading remains explicitly owned by #3655.
- After the resolver layer is fixed, re-run and record the honest
  compile/validate split; do not claim the Linter runs merely because these
  diagnostics disappear.

## Implementation Plan

### Verdict — the resolver layer has LANDED; re-verified 2026-08-26 against main @ `0e65e238`

Every acceptance criterion in this issue is met on the current tree. The
"Implementation findings (2026-07-26)" section above describes shipped code, not
a proposal. Both split-out siblings (#3655 static JSON, #3672 codegen heap) are
already `status: done` at sprint 78; only this parent was never flipped — the
orphaned-issue failure mode described under "Issue status lifecycle" in
`CLAUDE.md`.

Measured on `node_modules/eslint/lib/linter/linter.js` (ESLint 10.0.3), driving
`ModuleResolver` → `resolveAllImports` → `analyzeMultiSource` with the exact
`projectResolutions` map `compileProject` builds:

| Claim in this issue                                   | Measured 2026-08-26                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| entry emits 141 diagnostics (52 errors, 89 warnings)  | entry emits **0** diagnostics, 0 errors, 0 warnings                          |
| TS2307 on the 15 listed specifiers                    | **all 15 resolve**; only `node:path` returns `null`, by design (host import) |
| `ModuleResolver` resolves from the logical symlink    | resolves from `/.pnpm/eslint@10.0.3/node_modules/eslint/...` (physical)      |
| grouped `const a = …, b = …` requires never visited   | visited — graph reaches `traverser`, `source-code`, `timing`, `../types`     |
| duplicate logical/physical copies                     | 146 files, **146** distinct realpaths — one canonical source per module      |
| `resolver.getDiagnostics()`                            | **0** — `compileProject` no longer bails at `src/index.ts:1282`              |

`tests/issue-3654.test.ts` (5 tests, incl. the real-ESLint case) passes in 6.1 s.

**Recommended disposition:** flip `status: done` and unblock #1400 / #2691 on
the resolver axis. Carve the two genuinely-open items below into new issues
rather than reopening this one — neither is required by this issue's acceptance
criteria.

### As-built map — do NOT re-implement

| Concern                                        | Location                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Physical-importer resolution context           | `src/resolve.ts:155-160` — `host.realpath(containingFile)` before resolve |
| Cache keyed on canonical importer identity     | `src/resolve.ts:162-166`                                                 |
| Graph identity / de-duplication                | `src/resolve.ts:288-292` `canonicalize()`                                |
| `.d.ts` → implementation-body preference       | `src/resolve.ts:198-208` (relative `.js`), `:225-230` (bare package)     |
| Extension / directory-index probing            | `src/resolve.ts:396-449` `probeImplementationPath()`                    |
| Importer-scoped `node_modules` walk            | `src/resolve.ts:325-367` `findImplementationBody()`                     |
| Grouped + nested static CJS `require` traversal| `src/resolve.ts:566-597`, `scanRequire` at `:580-592`                    |
| JSDoc `import("…")` / `@import … from "…"` edges| `src/resolve.ts:599-614` (scanner over comment trivia)                  |
| CJS→ESM rewrite feeding the walk               | `src/resolve.ts:544` → `src/cjs-rewrite.ts:41`                          |
| Exact edges captured per importer              | `src/resolve.ts:240-247`, read at `:299-301`                            |
| Edges threaded into the virtual host           | `src/index.ts:1312-1327` → `src/checker/index.ts:1106`, `:1129-1139`    |
| Exact-edge fast path in the virtual resolver   | `src/checker/multi-file-paths.ts:160-167` (before any name heuristic)   |
| Node ambient surface for multi-file JS graphs  | `src/checker/index.ts:1088-1100` (`NODE_ENV_DTS_NAME`, built once)      |

### R1 — `exports` / `imports` conditions are NOT honored (the one unmet "Required behaviour" bullet)

`src/resolve.ts:62` pins `moduleResolution: ts.ModuleResolutionKind.Node10`,
which ignores `exports` and `imports` entirely. The third "Required behaviour"
bullet ("Honor `exports.types.require` / `exports.types.import`") is satisfied
**by accident** for ESLint: `@eslint/core@1.1.1` also ships a top-level
`"types": "./dist/esm/types.d.ts"`, and Node10 finds it through that legacy
field. `@eslint/plugin-kit` likewise resolves via `main`, not `exports` — so a
CJS importer silently receives the ESM build (`dist/esm/index.js`) where Node
would give it `dist/cjs/index.cjs`.

The fixture at `tests/issue-3654.test.ts:67-80` carries both `types:` and
`exports.types.*`, so it does not discriminate either. Measured against
synthetic packages with **no** legacy fields (`.tmp/probe-3654-exports.mts`):

```
exports-only  -> NULL      dual -> NULL      subpath/sub -> NULL      #dep -> NULL
```

Mode comparison on the same fixtures (TypeScript 5.9.3), CJS importer:

| `moduleResolution`                          | exports-only | dual      | subpath/sub | `#dep` |
| ------------------------------------------- | ------------ | --------- | ----------- | ------ |
| `Node10` (current)                          | NULL         | NULL      | NULL        | NULL   |
| `Bundler`                                   | `t.d.ts`     | `i.d.ts`  | ok          | ok     |
| `Bundler` + `customConditions:["require","node"]` | `t.d.cts` | `i.d.cts` | ok      | ok     |
| `Node16`                                    | `t.d.cts`    | `i.d.cts` | ok          | ok     |

**Algorithm change — layered fallback, not a mode switch.** Keep the Node10
attempt at `src/resolve.ts:181` as the primary; add a second attempt fired
*only when it returns null*, mirroring the existing "TS first, then probe"
idiom already used at `:225-230`:

1. `resolved = ts.resolveModuleName(specifier, resolutionContainingFile, this.compilerOptions, this.host)` — unchanged.
2. If `resolved === null` **and** `getBarePackageName(specifier) !== null` or `specifier.startsWith("#")`:
   a. Derive the importer's module mode from `resolutionContainingFile`:
      `.cjs`/`.cts` → `require`; `.mjs`/`.mts` → `import`; `.js`/`.ts`/`.d.ts` →
      walk up to the nearest `package.json` and read `"type"` (`"module"` →
      `import`, otherwise `require`). Cache per directory — this walk runs once
      per package, not once per specifier.
   b. Retry with `{...this.compilerOptions, moduleResolution: Bundler,
      customConditions: [mode, "node"]}` — a **runtime** pass. `Bundler` already
      prepends `"types"`, so declaration-only packages still resolve.
   c. If (b) yields a `.d.ts`/`.d.cts`/`.d.mts`, run the existing
      `findImplementationBody()` (`:325`) to prefer a body, exactly as `:225-230`
      does today. If no body exists, keep the declaration — that is the
      `@eslint/core` types-only contract.
3. Everything downstream (`canonicalize`, `recordResolvedImport`, the
   `projectResolutions` map) is unchanged: the fallback returns the same shape.

**Why layered and not `Bundler`/`Node16` outright.** A mode switch changes
resolution for every package where Node10 *currently succeeds* but `exports`
would redirect elsewhere — that moves the whole `npm-compat.json` matrix in one
step, with no way to attribute a regression. `Node16` additionally enforces
mandatory extensions in ESM specifiers, which is precisely the class of breakage
#2833 covers. The fallback is byte-stable by construction: it cannot fire on any
graph that resolves today.

### R2 — lazy `require()` outside a `VariableStatement` is never traversed

`src/resolve.ts:579` gates the `scanRequire` walk on `ts.isVariableStatement(stmt)`.
ESLint's rule registry is an **`ExpressionStatement`**:

```js
module.exports = new LazyLoadingRuleMap(Object.entries({
  "accessor-pairs": () => require("./accessor-pairs"),   // ×292
```

Measured on `lib/rules/index.js`: 1 `require` in a `VariableStatement` (resolved
correctly) and **292 in an `ExpressionStatement`** (never resolved). Those 292
targets exist on disk, never enter `files`, and the virtual host at
`src/checker/multi-file-paths.ts:181` therefore returns `undefined` → TS2307.
This is a statement-kind filter, not a dynamic-`require` limitation: the
argument is a plain string literal in every case.

Fix shape: hoist the `scanRequire` walk out of the `isVariableStatement` branch
and run it over **every** statement — `ts.forEachChild(stmt, scanRequire)` — and
drop the early `return` at `:589` so sibling calls in the same subtree are all
visited. Guard against graph blow-up: this pulls all 292 rule modules in, which
lands squarely on #3672's territory, so gate it behind the same budget or land
it only once #3672's heap work is confirmed to hold.

### R3 — `resolve.extensions` is a dead field

`src/resolve.ts:54` assigns `this.extensions` from `options.resolve.extensions`
and nothing ever reads it; `probeImplementationPath` hardcodes
`["", ".js", ".mjs", ".cjs", ".ts"]` at `:337`. Either thread the option through
`probeImplementationPath(pkgRoot, afterPkg, this.extensions)` or delete the
field and the option. Silent no-op options are worse than absent ones.

### Edge cases

- **Scoped packages** — `getBarePackageName` (`src/resolve.ts:472-490`) already
  returns `@scope/pkg` for `@scope/pkg/sub`. Verified live on
  `@eslint/plugin-kit` and `@eslint/core`. No change needed for R1; the
  `customConditions` retry inherits the same specifier.
- **Self-referencing imports** — a package importing itself by name resolves
  today, but only because the physical-importer walk finds
  `node_modules/<self>/…` on the way up; true `exports`-based self-reference
  (name resolved against the *own* `exports` map, no `node_modules` entry) is
  unsupported. R1's `Bundler` retry covers it.
- **`imports` (`#dep`)** — currently NULL. Only reachable via R1; note the
  bare-package guard in step 2 must admit a leading `#`.
- **`.ts` vs `.js` specifier rewriting** — two rules already exist and must not
  be disturbed: an explicit relative `./x.js` prefers the real body over a
  sibling `.d.ts` (`:198-208`), and a bare-package `.d.ts` hit re-probes for an
  implementation (`:225-230`). The R1 retry runs *before* both, so both still
  apply to its result — do not short-circuit them.
- **Symlinked / hoisted installs** — resolution runs from
  `host.realpath(containingFile)` (`:160`) and graph keys are realpaths
  (`:289-291`), so a pnpm store path and its hoisted symlink collapse to one
  node. Do not "fix" the fallback by resolving from the logical path; that
  reintroduces the original defect. The 146/146 invariant is the regression
  guard.
- **Declaration-only packages** — must stay declarations. R1 step 2c keeps the
  `.d.ts` when no body exists; `tests/issue-3654.test.ts:144-153` asserts no
  `.js` from `types-only` enters the graph.
- **Missing optional peers** — `@typescript-eslint/types`, `@jsr/std__path` are
  not installed at all. Correct behaviour is degrading the type edge to `any`,
  not resolving it. Out of scope here (see below).

### Test plan

Existing, keep green:

- `tests/issue-3654.test.ts` — 5 tests: real-ESLint edges (`:98-126`),
  physical-importer identity + canonical de-dup (`:128-142`), types-only
  conditional (`:144-153`), `compileProject` through the virtual checker
  (`:155-160`), `node:path` host pass-through asserting the `env/__node_path`
  import (`:162-179`). Helper: `tests/helpers/eslint.ts`.
- `tests/issue-3655.test.ts`, `tests/issue-3672.test.ts` — sibling frontiers.

New, for R1 — extend `tests/issue-3654.test.ts` (same `mkdtempSync` fixture
root, same `.pnpm/<name>@<v>/node_modules/<name>` + symlink layout as
`:26-90`); do not add a new file, the fixture builder is the expensive part:

- `exports-only` package — `exports.types.{import,require}` with **no**
  top-level `types`/`main`. Assert resolution and assert the *condition* picked
  matches the importer's mode: `.cjs` importer → `.d.cts`, `.mjs` importer →
  `.d.ts`. This is the test the current fixture cannot express.
- `dual` package — `exports.require.default` vs `exports.import.default`, both
  bodies present. Assert a `require()` importer gets the CJS body.
- `subpath` package — `exports: {"./sub": …}` only. Assert `pkg/sub` resolves.
- `#imports` — `imports: {"#dep": "./dep.js"}`. Assert from inside the package.
- Byte-stability guard: assert `@eslint/plugin-kit` and `@eslint/core` still
  resolve to the *same* paths as today, proving the fallback did not fire.

New, for R2 — a fixture whose entry is
`module.exports = { a: () => require("./a"), b: () => require("./b") };`
(`ExpressionStatement`), asserting both `a` and `b` land in
`resolveAllImports`. Pair it with the ESLint case: assert
`lib/rules/index.js`'s targets are in the graph and that entry-scoped TS2307
stays 0.

Scratch probes used for this verification live in `.tmp/` (gitignored):
`probe-3654.mts`, `probe-3654-diag.mts`, `probe-3654-entry.mts`,
`probe-3654-residual.mts`, `probe-3654-exports.mts`, `probe-3654-modes.mts`.

### Out of scope — residual 374 TS2307, all in transitive files, none on the entry

Recorded here so the number is not mistaken for a regression of this issue:

| Count | Bucket                                                        | Owner                          |
| ----- | ------------------------------------------------------------- | ------------------------------ |
| 292   | `lib/rules/index.js` lazy `require` in an `ExpressionStatement`| R2 above (new issue)           |
| 18    | `@eslint-community/eslint-utils` JSDoc `import("./types.mjs")` | upstream — `types.mjs` is not shipped (only `index.d.mts`); needs type-edge degradation to `any`, not resolution |
| ~60   | `@typescript-eslint/types`, `@jsr/std__path`                   | uninstalled optional peers — same degradation fix |
| 1     | `ajv/lib/refs/json-schema-draft-04.json`                       | #3655                          |

`@eslint/plugin-kit` receiving the ESM build at a CJS require site is a latent
correctness divergence, not a diagnostic — it is fixed as a side effect of R1
step 2a and should be asserted there.
