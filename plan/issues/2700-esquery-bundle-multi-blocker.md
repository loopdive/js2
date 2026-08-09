---
id: 2700
title: "esquery@1.7.0 bundle fails to compile — multi-blocker (PEG parser codegen index-shift + syntax + hard-type errors)"
status: ready
created: 2026-06-26
updated: 2026-07-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: transpiled-bundle, peg-parser
goal: real-eslint-runs
sprint: current
horizon: l
assignee: ""
model: fable
es_edition: n/a
related: [1573, 1282, 2660, 2043, 2693, 3654, 3657]
origin: "Surfaced by sd-2674b validating the real-eslint Linter.verify npm dep tree (#1573 gate-list item 6). esquery is the rule-listener selector matcher on the verify path; it is the ONE external dep (of the 5: eslint-scope/eslint-visitor-keys/@eslint/plugin-kit/@eslint/core/esquery) that does NOT compile+validate."
---
# #2700 — esquery@1.7.0 bundle: multi-blocker compile failure

## 2026-07-26 integration note

The package is installed and resolvable from ESLint's real importer context.
Do not add a setup/download issue. Two distinct paths remain:

- native esquery compilation is still owned by this issue;
- the minimal real-Linter milestone intends to host-delegate selector matching,
  but its confirmation test currently stops earlier on IR ambient host-call
  issue #3657 (after #3653 removes the vacuous path return).

Direct `linter.js` also reports installed deps as unresolved inside the compiler
graph; that importer-context resolver layer is #3654 and is not evidence that
the npm packages are absent.

## Context

Validating the real-eslint `Linter.verify` external dep tree (#1573 gate-list
item 6). Of the 5 deps the tightened verify closure needs:

| package | entry | status |
|---|---|---|
| eslint-scope @9.1.2 | dist/eslint-scope.cjs | **validates** ✓ (120741 B) |
| eslint-visitor-keys @5.0.1 | dist/eslint-visitor-keys.cjs | **validates** ✓ (26848 B) |
| @eslint/plugin-kit @0.6.1 | dist/esm/index.js | **validates** ✓ (28861 B) |
| @eslint/core @1.1.1 | (types only) | **N/A** — zero runtime `.js`, type-only |
| **esquery @1.7.0** | dist/esquery.{esm,min}.js | **FAILS** (this issue) |

None of the 4 working deps pull any `node:` builtin (imports are only
`env`/`wasm:js-string`/`string_constants`) — so the dep tree needs NO host-glue
from sd-2671. esquery is the sole blocker.

## The blockers (verify-first, `compileProject(entry,{allowJs:true})`)

esquery ships only Rollup/Babel **bundles** (no unbundled lib on npm). Both
entries fail, for overlapping reasons:

- **`dist/esquery.min.js`** (the resolved `main`, UMD): `Cannot find name 'define'`
  (TS2304) — the AMD `define` global in the UMD wrapper.
- **`dist/esquery.esm.js`** (ESM, the better entry): **128 errors**, by code:
  `1005×25` (syntax `';' expected` — the parser chokes on bundle syntax),
  `2345×14` + `2322×7` (**HARD** type-mismatch codes — these bail), `8024×14`,
  `2454×14` (used-before-assigned), `2304×7` (`global`), `2532×10`/`18048×7`
  (possibly-undefined), `2630×1` (`_typeof` self-reassign), `2300`/`2339`/`2366`/
  `2538`/`2739`/`1345`, **plus 1 CODEGEN error**:
  ```
  Binary emit error: RangeError: Codegen error: local index out of range —
  168 (valid: [0, 8)) at function 'peg$computeLocation'. This is the
  late-import index-shift class (#2043).
  ```

So three independent fronts:

1. **Syntax (1005×25)** — the front-end parser rejects constructs in esquery's
   bundle. Must be diagnosed (which construct: likely the Babel `_typeof`/regex/
   the embedded PEG.js parser tables). Root-cause before anything else — if the
   parse is wrong, downstream codegen is moot.
2. **Hard TS errors (2322×7, 2345×14)** — type mismatches in the transpiled
   bundle that bail via `HARD_TS_DIAG_CODES`. For a JS dep these are almost
   certainly benign transpiled-bundle fictions; consider scoping
   `isHardTypeScriptDiagnostic` to NOT treat 2322/2345 as fatal for `allowJs`
   dependency (non-entry, or JS-extension) files — but VERIFY each is benign, do
   not blanket-suppress.
3. **Codegen late-import index-shift (#2043)** in `peg$computeLocation` —
   esquery embeds a PEG.js-generated parser; `peg$computeLocation` reads
   `local 168` with only 8 locals declared. Same class as #2075 (a captured
   index went stale across a deferred `flushLateImportShifts`/`addUnionImports`
   shift, or a local was allocated-then-truncated in a detached array). Needs the
   ensure→flush discipline applied at the offending site.

## Recommended approach

- **First**, decide with sd-eslint (owns the Linter integration) whether the
  MINIMAL verify (one simple rule, e.g. `semi`, selectors = bare node-type names)
  even reaches esquery's selector engine, or whether esquery can be
  host-delegated / stubbed for the first runnable milestone (mirrors how espree
  parse is host-delegated). If a minimal verify routes around esquery, this drops
  off the critical path and stays a Backlog hardening item.
- **If esquery must compile**: tackle in order — (1) syntax 1005 root-cause,
  (2) the `peg$computeLocation` #2043 codegen index-shift, (3) the hard-type
  scoping for JS deps. Each its own merge_group-floor-validated change.

## Reproduction

```bash
node node_modules/.pnpm/esquery@1.7.0/node_modules/esquery/package.json  # entry: dist/esquery.min.js
# compileProject(absEntry, {allowJs:true}) → success:false, 128 errors (esm.js)
```
(Harness used: a per-package `compileProject + WebAssembly.validate` driver; the
4 working deps validate identically.)

## Reproducibility note (NOT a blocker)

eslint ^10.0.3 is a committed devDependency and `pnpm-lock.yaml` is committed, so
the entire dep closure (incl. esquery) is already reproducibly installed by the
normal `pnpm install` CI runs — resolvable from eslint's context via pnpm
symlinks. No tarball-pinning setup script (the acorn-dogfood pattern, which
exists because acorn is NOT a devDep) is required for these deps.

Before this issue moves to `done`, `tests/issue-2700.test.ts` must retain the
reduced bundle repro and assert both compile success and Wasm validation for
the selected esquery entry.

## Carry-over from the closed PR #3687 — prefer `module` over `main` for a bare package root (2026-07-31)

The reproduction above pins esquery's entry to `dist/esquery.min.js`, which is
the package's **`main`** — a UMD bundle. PR #3687 (closed, branch
`codex/1400-eslint-e2e` @ `561c933af16651e49f50556b8128967892ce529e`) recorded
that this entry choice is itself part of the blocker: the UMD wrapper's browser
fallback reads `self`, and js2wasm deliberately does not synthesize CommonJS
`module`/`exports` host globals, so the bundle takes a branch that cannot work.

Its `src/resolve.ts` fix: for a **bare package-root** specifier
(`specifier === pkgName`), route through `findImplementationBody` so a
published ESM `module` field wins over `main` when both exist. Packages
without a `module` field keep standard TypeScript/Node resolution unchanged.

```ts
if (pkgName && specifier === pkgName) {
  const implementation = this.findImplementationBody(pkgName, specifier, resolutionContainingFile);
  if (implementation) {
    resolved = this.host.realpath?.(implementation) ?? implementation;
  }
}
```

This is **not** on `main` (verified 2026-07-31 against `e4187572`);
`findImplementationBody` exists but is only reached on the `@types/` path.

Suggested measurable criterion if this is adopted here: `new
ModuleResolver(...).resolve("esquery", <importer>)` returns the `module`-field
ESM entry rather than `dist/esquery.min.js`, and the "1005 syntax" error count
for the resolved entry is re-measured against that entry rather than the UMD
bundle — the current 128-error figure may be an artifact of compiling the wrong
file. **Measure before assuming the fix helps**; a different entry is a
different program, not necessarily a working one.
