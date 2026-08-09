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
