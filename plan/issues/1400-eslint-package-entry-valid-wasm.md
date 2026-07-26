---
id: 1400
title: "npm: compile ESLint package entry to valid Wasm"
status: in-progress
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
sprint: current
depends_on: [3653, 3654, 3655, 3656, 3672]
es_edition: n/a
related: [1044, 1075, 1277, 1279, 1282, 1287, 1289, 1573, 1575, 2690, 2691, 2693, 2700, 3657]
---

# #1400 - Compile ESLint package entry to valid Wasm

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
5. #3672 keeps the 146-file checker graph intact while restricting codegen to
   the 77 executable sources reachable from the direct Linter entry, then
   measures the remaining phases against the integration budget.
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

## Suspended Work (2026-07-27, PR #3687 shepherding session)

- **Worktree**: `/workspace/.claude/worktrees/agent-aa8024785860501f4`
- **Branch**: `codex/1400-eslint-e2e` (upstream head repo — push with
  `git push upstream codex/1400-eslint-e2e`; do NOT create a fork copy)
- **PR**: loopdive/js2#3687 (draft; everything below is pushed — nothing local-only)

### Done this session

1. **Merged upstream/main twice** (through #3679/#3678/#3690, then #3686) and
   resolved all 17 conflicted files / 42 hunks. Key calls, recorded in the merge
   commit message (`c5fa0ad2e`): main's refactors adopted (multi-file-paths.ts,
   ir-imported-call-planning.ts, compileMultiIrOverlaySource,
   IncrementalProjectLanguageService param), branch's genuinely-new work kept
   (compile profiling, static-JSON resolver, var/let CJS requires, checker-only
   roots codegen exclusion, scope-aware identity work).
2. **Renumber 3658→3672 completed on the branch** (main's #3658 is an unrelated
   issue): `tests/issue-3658.test.ts` → `tests/issue-3672.test.ts`, stale issue
   file dropped, branch's investigation content carried onto #3672.
3. Typecheck green (one dup `ambientClassCalls` field removed); biome lint,
   prettier, issue-schema/id gates, IR gates, loc/func/oracle ratchets all pass
   locally (change-scoped allowances added to `plan/issues/3672-*.md`).
4. Pushed: PR went DIRTY → BLOCKED; green now: cheap gate, linear-tests,
   equivalence shards 1/5/6/8, PR-level test262 checks, cla-check.

### Failing checks — diagnosis so far

- `equivalence-shard (2,3,4,7)` + `equivalence-gate` + `quality` (guard suite,
  `tests/issue-3164.test.ts`). **7 regressions, one shared family**: calls
  through a VALUE-held function binding misdispatch —
  - issue-3164 guard: `var ref: any; ref = function*(){ if (arguments.length===2) ... }; ref(42,43).next()` → callCount 0 (expected 1). REPRODUCED in
    `.tmp/repro3164.mts` in the worktree (compiles, validates, wrong result).
  - equivalence: async module-const-arrow dispatch (#1730 pattern), detached
    prototype methods (#1388/#1394), custom `[Symbol.iterator]()` object
    (issue-1610, iterator-protocol-custom), async arrow in promise-chains.
- **Suspected cause (NOT yet proven — needs the control below)**: the branch's
  scope-aware module-global identity work in `3ba9d4dd2` (`registerImportBindingAliases` rework, `moduleGlobalDeclarations`,
  `reassigned: Set<ts.FunctionDeclaration>` in codegen/index.ts,
  `moduleGlobalForSymbol`/`moduleGlobalAtIdentifier`), possibly interacting
  with the merge's adoption of main's refactored planning path.
- **Control experiment still missing**: run `tests/issue-3164.test.ts` at
  pre-merge head `3ba9d4dd2` to split branch-regression vs merge-resolution
  error. A control worktree at `/workspace/.claude/worktrees/pr3687-premerge-ctl`
  exists but its checkout is INCOMPLETE (git worktree add timed out under
  load ~27) — repair with `git -C <path> checkout -f HEAD` from an unrestricted
  session, or delete and recreate.

### Stress status (the PR's known defect)

- The closure-2056 REDUCED repro passes post-merge (`tests/issue-3672.test.ts`,
  "does not route minified esquery helpers through same-named globals from
  another module") — 38/38 focused tests green.
- The FULL `tests/stress/eslint-tier1.test.ts` run was **inconclusive**: probe
  SIGTERMed at the 3600 s wall budget under system load ~27 (author measured
  688–747 s idle). Re-run on a quiet box; log of the attempt in
  `.tmp/eslint-tier1-full.log`.
- Local-env note: `node --import tsx` needs tsx in node_modules; the shared
  `/workspace/node_modules` lacked it — symlinked from the npx cache
  (`~/.npm/_npx/fd45a72a545557e9/node_modules/tsx`) including `.bin/tsx`.

### Resume steps

1. Fix the value-held-function dispatch family first (repro:
   `npx tsx .tmp/repro3164.mts`, expect `test(): 1`). Run the pre-merge control
   to decide where to look (branch identity work vs merge resolution).
2. `npx vitest run tests/issue-3164.test.ts tests/equivalence/issue-1610.test.ts tests/equivalence/issue-1388.test.ts tests/equivalence/async-function.test.ts tests/equivalence/iterator-protocol-custom.test.ts tests/equivalence/promise-chains.test.ts`
3. Push, confirm equivalence shards + quality green.
4. Re-run the full stress on an idle box; if green (verify()===0), flip
   3654/3655/3656/3657 (+3672 with measurements recorded) per the self-merge
   status convention, update the PR body, and mark ready for review.
5. `check:godfiles` fails on CLEAN main too (object-runtime growths) — NOT a
   required check, not this PR's problem; do not chase it.
