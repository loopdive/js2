---
id: 6434
title: "module `var x = void 0` later rebound to an object gets an i32 slot — the object is truncated to 0"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

A module-level `var x = void 0;` that is later assigned an object gets an
**i32** Wasm global slot, so the assignment stores
`i32.trunc_sat(__unbox_number(obj))` — i.e. `0` — and every later read sees a
null pointer instead of the object.

`moduleGlobalWasmType` (`src/codegen/declarations.ts` ~L3483–3620) deliberately
excludes the `void 0` initializer arm when choosing a module global's type. The
exclusion is load-bearing for a different reason: the #4491 note records that
widening it regressed the test262 filter harness cases
`15.4.4.20-9-2/-3/-4/-6`. So this is a typing change with a known blast radius,
not an oversight to be flipped.

Split out of
[#6413](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6413-hono-jsx-dom-closure-fallthru-externref),
where it was masked: the same fixture used to fail `WebAssembly.compile`
outright. With #6413's `||=` reorder landed the module validates and the defect
becomes a runtime trap instead.

This is hono's shape. `dist/jsx/base.js` declares `let nameSpaceContext` and
`jsxFn` does `nameSpaceContext ||= createContext("")`; bundled subpaths that
emit `var nameSpaceContext = void 0;` therefore lose the namespace context for
`<svg>` / `<head>` even though the module now compiles.

## Reproduce

Two untyped `.js` files plus a TS entry, compiled with
`compileProject(..., { allowJs: true, skipSemanticDiagnostics: true, target: "gc", platform: "node" })`:

`ctx.js`

```js
var createContext = (v) => ({ value: v, kind: "ctx-6434" });
export { createContext };
```

`main.js`

```js
import { createContext } from "./ctx.js";
var nameSpaceContext = void 0;
var tag = (t) => {
  if (t === "svg" || t === "head") {
    var got = (nameSpaceContext ||= createContext(""));
    return got ? got.kind : "null";
  }
  return "plain";
};
export function run() { return tag("svg") + "|" + tag("head") + "|" + tag("div"); }
```

Native: `ctx-6434|ctx-6434|plain`. Wasm (with #6413 applied): the module
validates and then traps with `RuntimeError: dereferencing a null pointer`.
Replacing `var nameSpaceContext = void 0;` with a bare `var nameSpaceContext;`
runs correctly — that is the whole difference.

## Acceptance criteria

1. The fixture above returns `ctx-6434|ctx-6434|plain` under the JS-host (gc)
   target.
2. A regression test that fails on the parent commit and passes with the fix,
   with the bare-`var` form kept as an anti-vacuity control.
3. **A full test262 A/B on the changed consult, reported in the PR.** The
   #4491 note names `15.4.4.20-9-2/-3/-4/-6` specifically; a net-negative or a
   regression in the filter-harness bucket blocks the change. If the widening
   cannot be made test262-neutral, close as `wont-fix` with the measurement
   rather than shipping a partial.

## Notes

The likely shape is to consult `bindingHasMixedAssignmentCarrier` at module
scope — the same question the function-local path already answers — rather than
widening the `void 0` arm unconditionally. That keeps the `void 0`-and-only-ever
-a-number bindings on their i32 slots, which is what the #4491 regression was
about.

## Implementation Plan

**Measured on upstream/main 54c36a9fe3** (probe: two-file untyped `.js` fixture, `compileProject(allowJs, target:"gc")`, kept in `.tmp/p6434/`): `var ns = void 0; ns ||= createContext("")` → `null|null|plain`, slot `(global $__mod_nameSpaceContext (mut i32) (i32.const 0))`. Same result for `ns = createContext("")` inside the closure, for `if (!ns) ns = …`, and for a top-level `ns = …`. Controls: bare `var ns;` and `var ns = undefined;` → `ctx-6434|ctx-6434|plain` with `(mut externref)`. On this HEAD the defect is a silent falsy `0`, not the null-deref trap the Problem section describes (that was the pre-#6413 base).

**Responsible arm — not the one the issue names.** `moduleGlobalWasmType` (`src/codegen/declarations.ts` ~L3483) has no arm that fires and falls through to `resolveWasmType(varType)` → i32 (the "void → no result" convention). The rebind widening that should catch it, `heterogeneousWidenedModuleGlobalType` → `collectHeterogeneouslyAssignedModuleVarNames` (`src/ir/heterogeneous-module-bindings.ts` ~L104–200), misses on two counts: (a) `initializerTagOf` only admits tags in `HETEROGENEOUS_PRIMITIVE_SLOT_TAGS` = {number,string,boolean,bigint}; `void 0` tags `"undefined"` (`jsTagOfFact`, oracle.ts L657) and is dropped; (b) `visit` only matches `EqualsToken`, so `||=` / `??=` / `&&=` are invisible. (a) alone explains the plain-`=` failures; (b) is what hono's `jsxFn` needs.

**About the #4491 note.** `15.4.4.20-9-2/-3/-4/-6` contain no `void 0` and include no harness file that does (only `harness/sm/assertThrowsValue.js` has one); each reads `srcArr` from a hoisted `callbackfn` before the declaration — that is the #4206 pre-init arm of `varBindingNeedsExternrefForUndefined`, which this plan does NOT touch. Treat "the `void 0` arm regressed filter" as an unverified attribution; AC3's A/B decides.

**Change (one file, then a test):**
1. `src/ir/heterogeneous-module-bindings.ts`, `initializerTagOf`: after the existing check, admit `"undefined"` as the slot tag **only when the (paren-stripped) initializer is a `ts.VoidExpression`** — a syntactic `void 0`, not "types as undefined" (optional reads / delete sentinels keep their slot, per the wave-4 rationale). Do not add `"undefined"` to `HETEROGENEOUS_PRIMITIVE_SLOT_TAGS` itself (it is shared with `redeclared-var-widening.ts` L157; leave that file's behaviour unchanged).
2. Same file, `visit`: accept `BarBarEqualsToken`, `QuestionQuestionEqualsToken`, `AmpersandAmpersandEqualsToken` alongside `EqualsToken`; `node.right` is the assigned value in all four, and `assignmentWidens("undefined", rhs)` already widens on any non-`undefined` or `mixed` tag. A numeric rebind (`var i = void 0; i = 0`) therefore also widens i32 → externref; that is intended — the i32 slot truncated `1.5` to `1` anyway — but it is a representation change on downlevelled `let` (`var x = void 0`) hot paths, so it is the first thing to narrow to "non-number RHS only" if the A/B or dogfood perf lanes object.
3. No reordering in `moduleGlobalWasmType`: the widening stays in the terminal `??` chain after every specific arm (holey/ta_view/fnctor/eval arms keep priority). Agreement constraint: IR reads the same collector via `heterogeneousAssignmentRetypesModuleBinding` (`src/ir/module-bindings.ts` L2100) and declines the binding, so IR and codegen cannot disagree on the slot — do not add a codegen-only arm.
4. Out of scope, note in PR: `scopeCarrierFacts` (`src/codegen/analysis/mixed-assignment-carrier.ts` L87) also indexes only `=`, so the function-local twin `var x = 0; x ||= obj` has the same `||=` blind spot.

**Probe first:** re-run `.tmp/p6434/probe.test.ts` (copy to `tests/probe-6434.test.ts`, gitignored, delete after) on parent and fix; expect variants A/B/D/E to flip to `ctx-6434|ctx-6434|plain` with `(mut externref)`.

**Regression test** `tests/issue-6434-module-var-void0-rebound.test.ts`, modelled on `tests/issue-6413-logical-or-assign-global-shift.test.ts` (same `ctx.js` arrow-`var` + `main.js` + TS entry, `compileProject` with `allowJs`): red-on-parent cases `void 0` + `||=`, `void 0` + `=` in closure, `void 0` + top-level `=` (assert the run string AND `(global … nameSpaceContext (mut externref)` in the WAT); anti-vacuity controls green on both arms: bare `var` + `||=`, `= undefined` + `||=`; narrowness control: `var ns = void 0;` never rebound keeps `(mut i32)` (assert slot only, not value).

**Test262 A/B (AC3, blocking):** `TEST262_PATH_FILTER=built-ins/Array/prototype/filter pnpm run test:262` on parent and fix, then the full merge_group run; report both. Standalone lane: the collector is target-agnostic and standalone already carries bare-`var` globals as externref, so expect neutral; a standalone-floor drop is a real finding.

**Dogfood expectation:** hono stays ~261/324 — its suite runs 20 non-DOM files and `jsx/dom` is deferred, so the `<svg>`/`<head>` fix is only witnessed by the fixture. Babel/tsc downlevel emits `var x = void 0` widely, so redux 67/82, axios 208/231, marked 16/30, prettier 107/151, jest 335/356 may move up; webpack 16/16, three 17/18, clsx 32/32, cookie 63740, lodash 59/62, uuid 75, moment 10 expected unchanged. Any anchor going down blocks.

## Dispatch

**opus** — a two-line predicate change in one shared collector plus a template-shaped test, but the value is in running the filter-bucket and full test262 A/B honestly and narrowing the numeric-rebind case if it moves; not mechanical enough for sonnet, not a design problem for fable.

## Resolution

Fixed in `src/ir/heterogeneous-module-bindings.ts` — the shared collector both
direct codegen and the IR module-binding resolver read, so the two cannot
disagree on a slot. Two independent misses, exactly as the plan predicted:

1. `initializerTagOf` admitted only `HETEROGENEOUS_PRIMITIVE_SLOT_TAGS`
   (number/string/boolean/bigint); `void 0` tags `"undefined"` and was dropped,
   so the binding was never a widening candidate at all. It is now admitted —
   but ONLY for a **syntactic** `void <e>` initializer (paren-stripped
   `ts.VoidExpression`), the downlevelled shape of an unassigned `let`. A
   binding whose initializer merely *has type* `undefined` (an optional read, a
   delete sentinel) keeps its specialized slot. `HETEROGENEOUS_PRIMITIVE_SLOT_TAGS`
   itself is unchanged, so `redeclared-var-widening.ts` is untouched.
2. `visit` matched only `EqualsToken`. It now also indexes `||=`, `??=` and
   `&&=` (`WIDENING_ASSIGNMENT_OPERATORS`) — conditional storage is the same
   representation question as unconditional storage for a Wasm slot. This is
   what hono's `nameSpaceContext ||= createContext("")` needs.

Probe on upstream/main `69ccb3494f`, seven variants, before → after:

| variant | slot before | run before | slot after | run after |
| --- | --- | --- | --- | --- |
| `void 0` + `\|\|=` (hono) | i32 | `null\|null\|plain` | externref | `ctx-6434\|ctx-6434\|plain` |
| `void 0` + `=` in closure | i32 | `null\|null\|plain` | externref | `ctx-6434\|ctx-6434\|plain` |
| `void 0` + top-level `=` | i32 | `null\|null\|plain` | externref | `ctx-6434\|ctx-6434\|plain` |
| bare `var` + `\|\|=` (control) | externref | correct | externref | correct |
| `= undefined` + `\|\|=` (control) | externref | correct | externref | correct |
| `void 0`, never rebound (narrowness) | i32 | — | **i32** | — |
| `void 0` + numeric rebind | i32 | correct | externref | correct |

On this HEAD the defect was a silent falsy `0`, not the null-deref trap the
Problem section describes — that was the pre-#6413 base, as the plan recorded.

**AC3 — test262 A/B, `built-ins/Array/prototype/filter`** (`TEST262_PATH_FILTER`,
gc target, same workspace, arms swapped by file copy): **186 pass / 242 both
arms, and a per-entry diff over all 242 rows shows ZERO status differences**
(pass 186 / fail 50 / compile_error 6 on each). The four tests the #4491 note
named are unchanged by this commit: `15.4.4.20-9-2` and `-9-4` pass on both
arms, `-9-3` and `-9-6` fail on both. That confirms the plan's reading — those
failures belong to the #4206 pre-init arm of
`varBindingNeedsExternrefForUndefined`, which this change does not touch — and
retires "the `void 0` arm regressed filter" as a misattribution. The full
sharded run is the `merge_group` re-validation on the merged state.

**Dogfood A/B, all 17 upstream suites**, both arms measured on this box at this
HEAD: byte-identical — same headline AND the same per-file `native; Wasm` line
for every file in every suite. webpack 16/16 · three 17/18 · clsx 32/32 ·
cookie 63740/63740 · lodash 59/62 · redux 67/82 · axios 208/231 ·
stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6 · styled-components 9/9 ·
uuid 75/75 · marked 16/30 · moment 10/10 · prettier 108/151 · jest 335/356 ·
hono 268/324. As the plan predicted, no upstream package witnesses the fix:
hono's suite runs 20 non-DOM files and `jsx/dom` is deferred, so the
`<svg>`/`<head>` path is only exercised by the regression fixture.

Regression test `tests/issue-6434-module-var-void0-rebound.test.ts`: 4 red on
the parent (the three slot+value cases plus `??=`), 3 green on both arms (two
anti-vacuity controls and the never-rebound narrowness control).

### Out of scope, still open

`scopeCarrierFacts` (`src/codegen/analysis/mixed-assignment-carrier.ts`) also
indexes only `=`, so the FUNCTION-LOCAL twin — `var x = 0; x ||= obj` inside a
function body — keeps the same `||=` blind spot. Not touched here; tracked as
#6469.
