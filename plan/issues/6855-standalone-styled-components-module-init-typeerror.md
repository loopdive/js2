---
id: 6855
title: "standalone: styled-components module init throws TypeError: called value is not a function"
status: done
completed: 2026-10-16
sprint: current
created: 2026-10-05
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: calls
goal: standalone
requested_by: ttraenkler/wave9-styled-hostimports
related: [6841]
---

# #6855 — styled-components standalone-dynamic: module init throws `TypeError`

## What you will see

After [#6841](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6841-standalone-browser-dom-globals-host-imports)
removed the 12 lib.dom host imports, the styled-components standalone-dynamic
lane compiles to a zero-import binary (1.86 MB optimized) and then fails at
instantiation time:

```
npx tsx scripts/generate-npm-compat-report.mjs --only styled-components --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: runtime-error, phase module-init — "TypeError: called value is not a function"
  moduleImportCount 0, binaryBytes 1853070
```

Same verdict on the unoptimized binary (2.51 MB), so it is a codegen issue,
not an optimizer one. The error object is in-module; read it with
`e.getArg(exports.__exn_tag, 0)` and `__exn_render_prepare` /
`__exn_render_char` (see `tests/v8x-tla-graph.test.ts` `renderGraphValue`).

## What is already ruled out

- React's default import: `import t from "react"; t.createContext(5)` at
  module scope runs fine standalone (driver probe, 0 imports).
- `_t.forEach(e => { Tt[e] = kt(e) })` (properties on an arrow, `jt` closure
  factory) runs fine as a reduced fixture.
- The DOM / `navigator` / `window` reads: those throw `ReferenceError`, not
  `TypeError`, and are guarded by `typeof` at module scope.

## Remaining module-scope calls to bisect

From the top-level statements of `dist/styled-components.esm.js` 6.4.4:
`f("REACT_APP_SC_DISABLE_SPEEDY")` (process.env reads), `z(u)` (hash),
`new je` + `nt()` (stylis instance: `o.compile`, `o.serialize`,
`o.middleware`, `o.stringify` through `import * as o from "stylis"`),
`me(() => new Set)`, `Symbol.for(...)`, `new RegExp(...)` in the `ye` class
field, and the `@emotion/is-prop-valid` default import.

## Implementation Plan

1. Bisect the module-scope statements with a generated, truncated copy of
   the package entry (keep every `FunctionDeclaration`, replace later
   `const`/`let` statements with bare declarations). Caveat found while doing
   this: re-pointing the bare imports to absolute paths changes which
   `stylis` entry resolves — use the package's `exports.import`
   (`stylis/index.js`) or the harness diverges (RegExp compile errors with
   `dist/stylis.mjs`).
2. Reduce the failing statement to a fixture and fix the call lowering in
   standalone; add a regression test under `tests/`.
3. Re-measure the lane and report the next blocker.

Note for the lane measurement: on a loaded box the `--skip-pass=flatten`
retry inside `src/optimize.ts` can hit its 600 s timeout and the lane reads
`optimization-error`; that is load, not a regression (82 s CPU, 15 min wall
at 9 % CPU when measured on 2026-10-05).

## Implementation Plan (2026-10-16, wave14 re-measure on `ee58c1aa26`)

Re-measured on upstream/main `ee58c1aa26`: still `runtime-error`, phase
`module-init`, `TypeError: called value is not a function` (0 imports,
2,100,125 B optimized).

**Bisection result — not a call-lowering defect.** Making the throw trap
(`unreachable`, debug-only patch in `buildThrowJsErrorInstrs`) gives the wasm
stack `__module_init → nt → __extern_method_call`: the statement is
`const lt = nt()` → `o.rulesheet(...)` through `import * as o from "stylis"`.
Reduced: `import { rulesheet } from "stylis"; rulesheet(cb)` throws
`rulesheet is not a function`; the same import spelled
`./node_modules/stylis/index.js` (or `dist/stylis.mjs`) works, and spelled
`./node_modules/stylis/dist/umd/stylis.js` fails identically.

Root cause: `ModuleResolver.resolve` hands bare specifiers to TypeScript's
`Node10` resolver, which ignores package.json `exports` and picks `main` —
for stylis that is the UMD build `dist/umd/stylis.js`, whose
`typeof exports === "object" ? r(exports) : … r(e.stylis = {})` wrapper never
populates an ESM namespace, so every named import of stylis is `undefined`.
Node resolves the same ESM `import "stylis"` through
`exports["."].import` → `./index.js`.

Fix (standalone only — the resolver's existing target-gated seam, like
`foldSource`; the gc/JS-host lane keeps Node10 resolution byte-identical):

1. `src/resolve.ts` — `ModuleResolver.resolve(specifier, containingFile,
   edge?)`: when `edge === "esm-import"`, the resolver was built for
   `--target standalone`, and the specifier is a bare package specifier,
   resolve it with Node's PACKAGE_EXPORTS_RESOLVE: find
   `node_modules/<pkg>` walking up from the importer, read `exports`, match
   the subpath (`.` / `./sub`, exact then single-`*` pattern — the existing
   `matchSubpathImports`) under the conditions `node`, `import`, `default`
   (the existing `SUBPATH_IMPORT_CONDITIONS`). No `exports`, no match, or a
   target that is not a file → fall through to the unchanged Node10 path.
   The cache key carries the edge kind.
2. `resolveAllImports.visit` — pass `"esm-import"` only for the file's own
   `import` / `export … from` declarations, and only when
   `rewriteCjsRequire` left the file unchanged (a pure-ESM importer). A
   `require` edge (rewritten or nested) keeps the legacy resolution, because
   Node would pick the `require` condition there.
3. Regression test `tests/issue-6855-standalone-esm-package-exports.test.ts`:
   a temp project with a dual package whose `main` is a UMD build and whose
   `exports.import` is ESM; named + namespace imports must be callable under
   standalone (red on parent). Controls: a package without `exports`
   (unchanged Node10 `main`), and a CJS `require` edge (keeps `main`).
4. Re-measure styled-components standalone-dynamic; report the next blocker.

## Resolution (2026-10-16)

Root cause was module resolution, not call lowering (see the plan above):
under `--target standalone`, `ModuleResolver.resolve` now resolves a bare
specifier on an ESM `import` / `export … from` edge of a pure-ESM file through
the package's `exports` map, under the conditions `module`, `node`, `import`,
`default` (Node's ESM set plus the bundler `module` condition — with Node's set
alone `@emotion/is-prop-valid` moved from its ESM build to a `cjs.mjs` →
`cjs.js` CommonJS wrapper and init then failed with
`ReferenceError: exports is not defined`). Packages without `exports`, unmatched
subpaths and `require` edges keep the Node10 path; the gc lane is untouched
(identical sha256 of the unoptimized gc binary of the styled-components driver
before/after). Scoped standalone test262 (`language/module-code`,
`language/import`, `language/export`, 731 rows): identical before/after
(376 pass / 214 fail / 41 CE / 100 skip, same non-pass list) — test262 has no
bare-package imports, so the change cannot reach it.

styled-components (`--perf-only`, opt level 4):

| lane | before (`ee58c1aa26`) | after |
| --- | --- | --- |
| standalone-dynamic | runtime-error, module-init, `TypeError: called value is not a function` | measured, checksum 41 = 41, ratio 0.23, 0 imports, 1,916,998 B |
| standalone-static | runtime-error, module-init, same TypeError | measured, checksum 12 = 12, ratio 10.3, 0 imports, 1,916,900 B |

Regression test: `tests/issue-6855-standalone-esm-package-exports.test.ts`
(2 of 4 rows red on the parent; controls: `require` edge and gc graph keep
`main`).

Not covered here: the gc/JS-host resolver still ignores `exports`
(out of scope under the standalone-only policy), and the opt-in
`consumerDrivenBarrels` walker keeps Node10 for every edge.
