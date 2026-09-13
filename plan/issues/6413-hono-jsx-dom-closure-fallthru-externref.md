---
id: 6413
title: "hono's `jsx/dom` subpaths emit an invalid module — closure falls through with `externref` where `i32` is expected"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
loc-budget-allow:
  # 2026-09-12 (#6413) — +7 lines in the `||=` arm: the reorder itself is
  # size-neutral, the growth is the comment naming this as the seventh
  # instance of the late-import shift-staleness family. Without it the next
  # reader "tidies" the arms back into source order and reintroduces the bug.
  - src/codegen/expressions/operator-assignment.ts
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

Three hono subpath modules compile successfully and then fail
`WebAssembly.compile` with the same fallthrough type mismatch:

| module | engine message |
| --- | --- |
| `dist/jsx/dom/client.js` | `Compiling function #195:"__closure_64" failed: type error in fallthru[0] (expected i32, got externref) @+110178` |
| `dist/jsx/dom/jsx-runtime.js` | `Compiling function #157:"__closure_35" failed: type error in fallthru[0] (expected i32, got externref) @+80404` |
| `dist/jsx/dom/jsx-dev-runtime.js` | `Compiling function #157:"__closure_35" failed: type error in fallthru[0] (expected i32, got externref) @+80363` |

A generated closure is declared to return `i32` but its body falls off the end
leaving an `externref` on the stack — the declared result type and the value
the last expression actually produces disagree. The shape is adjacent to
[#5339](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5339-hono-dev-index-whole-module)
(`type error in return[0] (expected i32, got externref)`), which was an
inlined-IIFE `return` inside a `catch` clause left as a Wasm `return`; here it
is the implicit fallthrough rather than an explicit return, so the #5676 fix
does not cover it. Whether the two share a root cause is unverified.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12). `dist/jsx/dom/index.js`, `css.js` and `server.js`
compile and validate, so the defect is in what `client.js` / the runtimes reach,
not in the jsx/dom core.

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/jsx/dom/jsx-runtime.js
```

## Acceptance criteria

1. All three modules compile to binaries that pass `validateEmittedBinary`.
2. Their three rows are deleted from `KNOWN_INVALID_MODULES` in
   `scripts/check-dogfood-validation.mjs`.
3. A regression test that fails on the parent commit and passes with the fix.

## Implementation Plan

**Diagnosis (verified on 23a0ddaa26, still reproduces).** The issue's "closure declared i32 but falls through externref" is the symptom of a stale *global index*, not a function-result mismatch, and it is not the #5339 IIFE-return shape. The failing closure is hono's `jsxFn` in `dist/jsx/base.js` (reached by all three modules via `jsx/dom/index.js`), specifically `nameSpaceContext ||= createContext("")`. In `compileLogicalAssignment` (`src/codegen/expressions/operator-assignment.ts`, the `BarBarEqualsToken` arm ~L327) the then-arm `emitGet()` (a `global.get`) is emitted into a fresh array *before* the RHS is compiled, then `fctx.body = []` orphans that array while the RHS compiles. `createContext` is an imported `var` arrow, so its call emits null-guard `__new_TypeError` message strings → `ensureLateImport` of string-constant globals → `shiftGlobalIndices` (`src/codegen/registry/imports.ts` L426–486) bumps every `global.get/set` in `fctx.body`, `savedBodies` and `funcStack`, but never the detached `thenInstrs`. Result: condition and `global.set` read slot N+δ (the real, i32 `nameSpaceContext` global), the then-arm reads slot N (an externref neighbour) → `if (result i32)` falls through externref. δ=2 in hono (`$global$30` vs `$global$32`), δ=1 in the reduction. `&&=`/`??=` compile the RHS first and are safe; the property-target `||=` (`emitLogicalAssignmentPattern` ~L1066) uses `local.get tmpKeep` and is safe.

**Reduction (already run, put under `.tmp/6413/`).** `ctx.js`: `var createContext = (v) => ({ value: v, kind: "ctx-6413" }); export { createContext };` — `main.js`: `import { createContext } from "./ctx.js"; var nameSpaceContext = void 0; var tag = (t) => { if (t === "svg" || t === "head") { nameSpaceContext ||= createContext(""); return nameSpaceContext.kind; } return "plain"; }; export function run() { return tag("svg") + "|" + tag("head") + "|" + tag("div"); }`. `compileProject(main.js, {allowJs, skipSemanticDiagnostics, target:"gc", platform:"node"})` + `validateEmittedBinary` → `fallthru[0] (expected i32, got externref)`. A `function createContext` declaration (direct call, no late import) validates — that is the anti-vacuity control.

**Fix (one site, order-preserving).** In the `||=` arm: `pushBody`; compile `expr.right` + `emitSet()` into `fctx.body` → `elseInstrs`; then `fctx.body = []; emitGet()` → `thenInstrs`; restore `savedBody` and push the same `if`. Emission order changes, execution order does not (the `if` still selects by the condition; `emitGet` is a pure read whose index is re-resolved at emit time via `getStorageIndex`/`emitCapturedBoxGlobalRead`). Applied transiently: both hono-shaped fixtures validate. Add a one-line comment naming this as the seventh instance of the shift-staleness family (see the #5276 note in `imports.ts`); do NOT add a general "walk detached arrays" mechanism here.

**Second defect, out of AC scope — flag, do not bundle blind.** With only the reorder, the `void 0` fixture runs `null|null|plain` (native: `ctx-6413|ctx-6413|plain`); with `var nameSpaceContext;` it runs correctly. `moduleGlobalWasmType` (`src/codegen/declarations.ts` ~L3483–3620) deliberately excludes the `void 0` arm for module globals (#4491 note: widening regressed filter harness 15.4.4.20-9-2/-3/-4/-6), so `nameSpaceContext` is an i32 slot and `||=` stores `i32.trunc_sat(__unbox_number(ctx))` = 0 — hono's svg/head namespace context is wrong at runtime even though the module now validates. Allocate a follow-up issue (`claim-issue.mjs --allocate`) for "module `var x = void 0` rebound to an object via assignment/`||=` → externref slot (consult `bindingHasMixedAssignmentCarrier` at module scope)"; only fold it in if a full A/B on that consult is test262-neutral.

**Regression test** `tests/issue-6413-logical-or-assign-global-shift.test.ts`, shape of `tests/issue-5339-iife-return-in-catch.test.ts` (untyped `.js` two-file fixtures in a mkdtemp root, `entry.ts` calling `run`): (1) hono shape `var ns = void 0; ns ||= createContext("")` with the arrow-callee `ctx.js` — assert `validateEmittedBinary(...).valid` (parent: false); (2) `var ns; ns ||= createContext("")` — assert validate AND run() === `"ctx-6413|ctx-6413|plain"` (parent: invalid); (3) controls passing on parent: same with `function createContext` declaration, and `ns ??= createContext("")` / `ns &&= …`. Mark (1)'s runtime value as the follow-up's todo in a comment, not an assertion.

**Expected movement.** `check:dogfood-validation` — hono `dist/jsx/dom/{client,jsx-runtime,jsx-dev-runtime}.js` go invalid → valid. `KNOWN_INVALID_MODULES` does NOT exist on this HEAD (`grep -rF` over `scripts/` and `tests/dogfood/` is empty); if it lands before dispatch, delete the three rows, else AC 2 is vacuous — say so in the PR. Suite anchors: hono 259/324 stays or gains (the selected upstream tests do not exercise `jsx/dom` client, so expect 0/+small); every other suite unchanged (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356). Standalone lane: same shared lowering, so no movement expected; the string-constant late-import path is host-side, so standalone was likely never invalid here — run `tests/equivalence.test.ts` and let the merge_group floor confirm.

**Gates before commit:** `check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`, `check:dogfood-validation`, `tsc --noEmit -p tsconfig.ts7.json`; the reorder is size-neutral, no allowance needed.

## Dispatch

**opus** — the fix is a ten-line reorder at one named site with a ready reduction, but the implementer must keep the bundled-typing temptation out (the `void 0` i32 slot is a separate, test262-sensitive change) and write a fixture-based test that fails on parent; that judgment is medium, not mechanical.

## Resolution

Fixed in `src/codegen/expressions/operator-assignment.ts` by compiling the
`||=` RHS **before** building the then-arm. One reorder, no new mechanism.

**Root cause — not a fallthrough/return defect at all.** `compileLogicalAssignment`
built the `||=` arms in source order: the then-arm ("keep the current value",
a bare `emitGet()`) was emitted into a fresh array first, then `fctx.body = []`
detached that array while the RHS compiled into a second one. Compiling the RHS
can call `ensureLateImport`, which inserts imported globals and then runs
`shiftGlobalIndices` to re-index every `global.get`/`global.set` at or above the
insertion point. That walk reaches `fctx.body`, `fctx.savedBodies`,
`ctx.funcStack` and friends — the detached then-arm array is reachable from
none of them, so its `global.get` kept the pre-shift slot while the condition
and the `global.set` (both re-resolved after the shift) moved. The then-arm
read the **neighbouring** global.

hono reaches it through `dist/jsx/base.js`'s `jsxFn`:
`nameSpaceContext ||= createContext("")`. `createContext` is an imported `var`
arrow, so calling it emits null-guard `__new_TypeError` message strings →
string-constant globals → the shift. The stale read landed on an `externref`
neighbour of the `i32` `nameSpaceContext` slot, inside an `if (result i32)` —
hence `fallthru[0] (expected i32, got externref)`. Seventh instance of the
family documented at the `#5276` note in `src/codegen/registry/imports.ts`.

`&&=` and `??=` compile their RHS first and were never affected; the
property-target form (`emitLogicalAssignmentPattern`) reads through
`local.get tmpKeep` and never holds a global index across a subexpression
compile. Emission order changes, execution order does not.

**Verified.** `dogfood-surface-probe --package hono` on the three modules,
parent vs fix at one HEAD:

| module | parent | fix |
| --- | --- | --- |
| `dist/jsx/dom/client.js` | invalid — `#195:"__closure_64" … fallthru[0] (expected i32, got externref) @+109794` | valid |
| `dist/jsx/dom/jsx-runtime.js` | invalid — `#157:"__closure_35" … @+80404` | valid |
| `dist/jsx/dom/jsx-dev-runtime.js` | invalid — `#157:"__closure_35" … @+80363` | valid |

### Dogfood suite A/B (base vs fix, one HEAD, all 17 suites)

| suite | base | fix |
| --- | --- | --- |
| webpack | 16/16 | 16/16 |
| three | 17/18 | 17/18 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| lodash | 59/62 | 59/62 |
| redux | 67/82 | 67/82 |
| axios | 208/231 | 208/231 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 |
| uuid | 75/75 | 75/75 |
| marked | 16/30 | 16/30 |
| moment | 10/10 | 10/10 |
| prettier | 107/151 | 107/151 |
| jest | 335/356 | 335/356 |
| hono | 261/324 | 261/324 |

Zero movement in either direction, per file as well as per headline. hono reads
**261/324 on BOTH sides**, not the 259 in the dispatch anchors — that +2 is
main-side drift since the anchors were taken, not an effect of this change. The
three repaired modules are `jsx/dom` client/runtime entry points, which the
selected upstream hono tests do not exercise, so no suite movement was expected
and none appeared.

**AC 2 is vacuous on this HEAD.** `KNOWN_INVALID_MODULES` does not exist —
`grep -rF` over `scripts/` and `tests/dogfood/` is empty — so there are no rows
to delete, exactly as the plan anticipated.

### Corrections to the plan

- The plan expected the `var ns;` (uninitialised) fixture to be **invalid** on
  the parent. It is not: an uninitialised module `var` gets an `externref`
  slot, so the stale read lands on a type-compatible neighbour and the module
  validates. It can even produce the right value, because `tag` is emitted
  three times and only the FIRST copy predates the shift — the later copies
  resolve correctly and may be the ones dispatched. The defect there is
  visible in the instruction stream rather than in validation, so the
  regression test asserts the `if`'s condition and then-arm name the same
  global (parent: `[["21","20"],["21","21"],["21","21"]]`).
- The `+7` lines are a comment, not code; the plan's "no allowance needed"
  therefore did not hold. Granted above with a dated rationale.

### Follow-up, deliberately not bundled

[#6434](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6434-module-var-void-0-rebound-to-object)
— with the reorder applied, the hono-shaped `var ns = void 0` fixture now
**validates but traps** (`dereferencing a null pointer`).
`moduleGlobalWasmType` excludes the `void 0` initializer arm for module globals
(#4491 note: widening regressed filter harness 15.4.4.20-9-2/-3/-4/-6), so the
binding gets an `i32` slot and `||=` stores a truncated `0`. That is a
test262-sensitive typing change on its own budget, not part of this fix.
