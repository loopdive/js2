---
id: 1400
title: "npm: compile ESLint package entry to valid Wasm"
status: blocked
created: 2026-05-11
updated: 2026-07-26
completed: 2026-05-20
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler, resolver, codegen
language_feature: commonjs, package-exports, classes
goal: npm-library-support
sprint: 76
depends_on: [3653, 3654, 3655, 3656, 3672]
es_edition: n/a
related: [1044, 1075, 1277, 1279, 1282, 1287, 1289, 1573, 1575, 2690, 2691, 2693, 2700, 3657]
---

# #1400 - Compile ESLint package entry to valid Wasm

## PR #3687 is CLOSED — dependency chain re-stated (2026-07-31)

PR #3687 (`fix(eslint): advance real Linter graph compilation`, branch
`codex/1400-eslint-e2e`) was the vehicle for this issue. It is **closed, not
merged**, by stakeholder decision: it sat `DIRTY` behind a
`github-actions[bot]` park-hold, a held PR is skipped by the `auto-enqueue`
backstop so it could not recover on its own, and `main` moved far enough
underneath it (~12.9k lines of divergence) that rescuing it was not viable.
It was treated as a **source of slices** instead.

Its branch ref `codex/1400-eslint-e2e`
(`561c933af16651e49f50556b8128967892ce529e`) is retained; several issues below
cite specific files on it as prior art. **Do not try to revive the PR.**

### What already landed by other routes (do NOT re-do)

| Was on PR #3687                                     | State on `main`                                       |
| --------------------------------------------------- | ----------------------------------------------------- |
| static CommonJS JSON require                        | **#3655 done** 2026-07-31 (PR #3867, different impl)  |
| resolved-graph heap/timeout bound + enforced budget | **#3672 done** 2026-07-31                             |
| `CompileOptions.emitWatOnlyFunctions`               | **#3743 done** 2026-07-28                             |
| `fix(resolver): restore ESLint package graph resolution` | on `main` as `c9507546`                          |
| `fix(resolver): scope JSDoc imports to comments`    | on `main` as `d3cb7b9e`                               |
| `collectNodeBuiltinImports`                         | **superseded** — `main` has `collectGraphNodeBuiltinImports` (`src/compiler/node-builtin-import-collector.ts`), wired at `compiler.ts:1608`; the PR's copy was imported but never called |
| uncatchable-trap → catchable TypeError (guarded-cast backup drop in `call-identifier.ts` / `string-ops.ts`) | **not needed** — self-inflicted by the PR's own identity rework. Probed on `main` @ `e4187572`: `` getF()`${n-1}` `` throws a catchable `tag is not a function`, and `var g = f; g(n-1)` returns the correct value |

### Updated blocker chain

1. **#3653** — measures as substantially already met on `main`; needs a status
   reconcile, not implementation. See the note in that file.
2. **#3654** — importer-scoped deps and extensionless CJS (still `ready`).
3. ~~#3655~~ **done**.
4. **#3656** — dynamic destructured parameter (still `ready`).
5. ~~#3672~~ **done**.
6. **#3798** — declaration-keyed module globals vs the structural program-ABI
   registry. **This is now the load-bearing blocker**: it is the architectural
   conflict that stopped PR #3687, and the identity work the ESLint graph needs
   cannot land until it is decided.
7. **#3930** — nested static `require()` never enters the compileProject graph
   (silent link hole; `debug`/`esrecurse` shapes).
8. **#3657** — the runtime host seam (`deprecate is not a function`), which is
   what the pre-merge control on that branch bottomed out on.

## Reopened 2026-07-26 — current package entry does not compile

The issue's title-level goal is not satisfied on current `origin/main`
(`a365357aff6eb6a1a720dfb93ccdb33c2db1c735`, ESLint 10.0.3). The historical
`completed:` date is retained as the record of the narrower May fix, but the
issue is reopened as `blocked`.

Measured real-package sample:

| Target                                    |  Compile |         Validate |
| ----------------------------------------- | -------: | ---------------: |
| bare `import { Linter } from "eslint"`    | **fail** |      not reached |
| `lib/linter/linter.js` direct             | **fail** |      not reached |
| `config/config.js`                        |     pass |             pass |
| `linter/apply-disable-directives.js`      |     pass |             pass |
| `languages/js/source-code/source-code.js` |     pass |             pass |
| `rule-tester/rule-tester.js`              |     pass | **fail** (#2690) |

Honest split: **3/6 compile+validate, 1/6 compiles invalid, 2/6 do not
compile**. This is a bounded critical-target sample, not a replacement for the
older 21-module #1573 survey.

The bare package entry produced four fatal diagnostics and two warnings. Its
fatal frontier is:

```text
Module '"eslint"' has no exported member 'Linter'.
Internal error compiling expression: Cannot read properties of undefined (reading 'kind')  (2×)
Codegen error: IR path failed for getInactivityReasonMessage:
  object destructuring source must be IrType.object or IrType.class (got dynamic)
```

Direct `linter.js` produced **141 diagnostics: 52 errors / 89 warnings**. Those
counts are not work-item counts; most type/export errors cascade from a smaller
module-resolution layer.

Current dependency order:

1. #3653 makes the integration tests portable and non-vacuous.
2. #3654 resolves installed importer-scoped packages, relative
   extensionless/directory modules, and types-only exports, while preserving
   Node builtins as dependencies of the Node JS host.
3. #3655 adds static CommonJS JSON loading for `../../package.json`.
4. #3656 fixes the independently reproduced IR failure in real
   `eslint/lib/shared/flags.js`.
5. #3672 bounds the now-expanded 149-file direct graph so the child compile
   returns a structured result inside the integration budget.
6. Re-measure compile and Wasm validation. #2690 remains the known
   RuleTester validator blocker; any newly exposed errors must be measured
   rather than inferred.
7. Runtime host-delegation then depends on #3657.

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

### First-proof execution lane

The first runnable proof is deliberately **not standalone ESLint**. Compile it
for the default JS-host lane, instantiate it under Node, and pass Node builtin
imports through to the real Node host modules. Standalone/WASI implementations
of `node:*` APIs are follow-up portability work and must not block—or be
silently substituted into—this initial `Linter.verify()` gate.

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
