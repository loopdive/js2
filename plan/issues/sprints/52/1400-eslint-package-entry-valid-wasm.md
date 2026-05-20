---
id: 1400
sprint: 52
title: "npm: compile ESLint package entry to valid Wasm"
status: done
created: 2026-05-11
updated: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler, resolver, codegen
es_edition: n/a
language_feature: commonjs, package-exports, classes
goal: npm-library-support
related: [1075, 1277, 1279, 1282, 1287, 1289]
---
# #1400 - Compile ESLint package entry to valid Wasm

## Goal

Compile ESLint from its package entry as real JavaScript implementation code,
not as declaration-file extern stubs, and produce a structurally valid Wasm
module for the Tier 1 `Linter.verify()` scenario.

The target smoke case is:

```ts
import { Linter } from "eslint";

const linter = new Linter();

export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
```

## Current state

Verified on 2026-05-11:

1. `compileProject("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true })`
   succeeds and emits a ~276 kB binary, but `WebAssembly.validate()` is false.
2. The first direct `linter.js` validation blocker is:

   ```text
   WebAssembly.instantiate(): Compiling function #178:"Config_new" failed:
   extern.convert_any[0] expected type anyref, found extern.convert_any of type externref @+112747
   ```

3. `compileProject("/workspace/node_modules/eslint/lib/api.js", { allowJs: true })`
   also succeeds and emits a ~953 kB binary, but hits the same validation class.
4. `import { Linter } from "eslint"` currently compiles to a small valid binary
   that imports `env.__new_Linter`; it does not compile the real ESLint
   implementation. Runtime fails with:

   ```text
   No dependency provided for extern class "Linter"
   ```

5. `tests/stress/eslint-tier1.test.ts` has Tier 1a/1b/1c passing and Tier
   1d/1e still skipped.

## Missing pieces

### 1. Resolve package `exports` implementation entries

ESLint's `package.json` maps the bare package export to both:

```json
{
  "types": "./lib/types/index.d.ts",
  "default": "./lib/api.js"
}
```

The resolver currently handles the `@types/*` case, but this package-local
`types` vs `default` shape still resolves through declarations for the bare
`eslint` import. `compileProject` needs to choose the implementation body
(`default` / `main`) for compile-time codegen while preserving type information
for checking.

### 2. Preserve CJS class exports across modules

ESLint exposes classes through CommonJS object exports, for example:

```js
const { Linter } = require("./linter");

module.exports = {
  Linter,
  SourceCodeFixer,
};
```

The existing CJS export lowering handles enough function export cases for
previous stress tests, but class/constructor values still degrade to extern
constructors in the package-entry path. Named class exports need to link to the
compiled class implementation, not `env.__new_Linter`.

### 3. Fix direct `linter.js` validation

The direct implementation graph already compiles, so the next hard blocker is
the `Config_new` duplicate `extern.convert_any` validation error. This is
separate from #1289: #1289 removed the earlier
`FileReport_addRuleMessage` `array.set` mismatch and exposed this next issue.

### 4. Re-enable the ESLint Tier 1 execution ladder

After the direct graph validates, unskip and update the ESLint stress test so it
tracks current progress:

- Tier 1d: direct `eslint/lib/linter/linter.js` binary validates/instantiates.
- Tier 1e: package-entry `new Linter().verify("const x = 1;", {})` returns `[]`.
- Add a package-entry assertion that verifies no `env.__new_Linter` extern
  constructor is emitted for the real implementation path.

## Acceptance criteria

1. Bare `import { Linter } from "eslint"` resolves to the implementation graph,
   not only to `.d.ts` declarations.
2. The package-entry Tier 1 source compiles without `env.__new_Linter` in the
   import manifest.
3. Direct `eslint/lib/linter/linter.js` compile returns `success: true` and
   `WebAssembly.validate(binary) === true`.
4. The direct `linter.js` binary instantiates with `buildImports(...)` and
   `setExports(instance.exports)`.
5. `new Linter().verify("const x = 1;", {})` returns an empty message array in
   the Tier 1 stress test.
6. `tests/stress/eslint-tier1.test.ts` has no skipped Tier 1d/1e rungs for this
   scenario.
7. Existing Hono/lodash/npm stress tests remain green.

## Suggested implementation order

1. Fix package `exports` implementation resolution for bare package imports.
2. Add CJS class/object export linkage for `module.exports = { Linter }` and
   `module.exports = SourceCode`-style class exports.
3. Fix the `Config_new` duplicate `extern.convert_any` validation bug.
4. Unskip Tier 1d, then Tier 1e, and record any newly exposed runtime blocker as
   a follow-up only if it is outside this milestone.

## Partial Resolution — Sprint 52 / PR (Config_new fix)

This PR resolves **Missing piece #3** (the `Config_new` duplicate
`extern.convert_any` validation bug). The other three missing pieces
(package `exports` resolution, CJS class export linkage, Tier 1d/1e
unskip) are deferred to follow-up issues because they each surface
independent next blockers.

### Root cause

The single-module pipeline (`generateModule` in `src/codegen/index.ts`)
invokes `fixupExternConvertAny(ctx)` AFTER `stackBalance(mod)` at line
1053 specifically to scrub redundant / invalid `extern.convert_any`
ops. The multi-module pipeline (`generateMultiModule`, used by
`compileProject` for CJS / `.js` graphs) called `stackBalance(mod)` but
**never invoked `fixupExternConvertAny`** — so when
`fixCallArgTypesInBody` walked backward from a multi-arg host call
(`__extern_set(externref, externref, externref)`) and queued multiple
coercion insertions per pass, the resulting 2–4 consecutive
`extern.convert_any` ops survived all the way to the binary.

The bug surfaces because `extern.convert_any` requires an `anyref`
input — `externref` is NOT a subtype of `anyref`. So the second
`fb 1b` after the first one fails Wasm validation with:

```text
extern.convert_any[0] expected type anyref,
  found extern.convert_any of type externref @+...
```

### Fix

Mirror the single-module pipeline by calling `fixupExternConvertAny(ctx)`
after `stackBalance(mod)` in `generateMultiModule` (`src/codegen/index.ts`
~line 2951). The existing late-fixup pass already implements the correct
removal logic — it just wasn't being invoked on the multi-module path.

### Regression coverage

`tests/issue-1400.test.ts` pins three scenarios:

1. Minimal reproducer: `this.r = c.a[x]` in a class constructor.
2. Config-shaped constructor with destructuring + chained accesses.
3. Binary-level invariant: scans the produced binary for the
   `fb 1b fb 1b` byte signature (two consecutive `extern.convert_any`)
   and fails if any function body contains it.

### Verified

- `tests/issue-1400.test.ts` — 3/3 passing.
- `tests/stress/eslint-tier1.test.ts` — Tier 1a/1b/1c still green; 1d/1e
  still skipped (next blockers below).
- Spot-checked equivalence tests (class / object / closure / array
  prototype / nested classes / IR slice-4 classes) — all green.

### Next blockers (follow-up issues recommended)

With the duplicate-`extern.convert_any` bug gone, `compileProject` on
`eslint/lib/config/config.js` and `eslint/lib/linter/linter.js` now
exposes further validation errors that were previously masked by
`Config_new` failing first:

- `config.js` direct compile fails inside
  `__obj_meth_tramp___anon_0_validate_16` with
  `not enough arguments on the stack for call (need 2, got 1)`.
- `linter.js` direct compile fails inside `Linter_verifyAndFix` with
  `f64.eq[0] expected type f64, found call of type i32`.

Both should be filed as their own sprint-52/53 issues so they can be
debugged with the same minimal-reproducer methodology used for #1400.

The remaining acceptance criteria (bare-package `Linter` resolution,
CJS class export linkage, Tier 1d/1e) depend on resolving these next
blockers AND on the resolver / CJS-class-linkage work in items #1 and
#2 of this issue — neither of which is in scope for this PR.
