---
id: 6939
title: "`for (var i …)` head re-declaration re-types a boxed ref-cell slot (eval cell / closure capture) to the counter type — invalid Wasm (Octane earley-boyer `sc_jsNew`)"
status: done
sprint: current
created: 2026-10-10
updated: 2026-10-10
completed: 2026-10-10
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: for-loop, var-hoisting, direct-eval, closures
goal: compilable
related: [874, 3396, 1453, 3419]
assignee: "ttraenkler/claude-session-c-octane-forinit-boxed-retype-20261010"
# 2026-10-10: +2 call-site lines in compileForStatement (the boxed-head early
# branch in both declarator arms); the logic lives in three new small helpers
# (tryStoreBoxedVarHead / liveBoxedVarCell / emitBoxedVarHeadStore) in the same
# file, ~75 lines, because the plan keeps variables.ts read-only and loops.ts
# is the only module that lowers a for-head declarator.
loc-budget-allow:
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForStatement
---

# #6939 — `for (var i …)` head re-types a boxed cell slot → invalid Wasm

Found by the Octane triage for [#874](https://js2wasm.loopdive.com/dashboard/issue.html?slug=874-benchmark-compare-all-js-to)
(Session C, 2026-10-10, main `01e4888aae`). `compile()` reports
`success=true` for Octane `earley-boyer.js` (+ `base.js`) on both lanes, but the
binary is rejected:

```
gc:         Compiling function #294:"sc_jsNew" failed: local.tee[0] expected type (ref null 103), found local.get of type i32 @+105701
standalone: Compiling function #285:"sc_jsNew" failed: local.tee[0] expected type (ref null 827), found local.get of type i32 @+607278
```

`sc_jsNew` (earley-boyer.js:1867) is an `eval`-using function whose body has a
`for (var i = 2; …; i++)` loop.

## Minimized repro (both lanes, validate: false then `WebAssembly.compile`)

```js
// eb7.js — direct eval + for-head var (the Octane shape)
function f(c) {
    for (var i = 0; i < 1; i++) {}
    return eval("c");
}
export function run() { return f(1); }
```

```js
// eb8.js — same defect without eval: a closure captures the for-head var
function f(c) {
    var g = function () { return i; };
    for (var i = 0; i < 1; i++) {}
    return g() + c;
}
export function run() { return f(1); }
```

| program | node | js2 gc | js2 standalone |
| --- | --- | --- | --- |
| eb7 | `run() === 1` | INVALID `local.tee[0] expected (ref null 13), found local.get of type i32` | INVALID (same, `ref null 159`) |
| eb8 | `run() === 2` | INVALID `struct.new[3] expected (ref null 8), found local.tee of type i32` | INVALID (same, `ref null 134`) |

Negative controls (VALID): `var i = 2; i++;` or `var i = 2; s += i;` instead of
the `for` head inside the eval function (eb5/eb6) — the plain
`compileVariableStatement` path already carries the guard this issue asks for.

Commands: `node --import tsx .tmp/min.mjs .tmp/eb7.js gc` (driver: `compile(src,
{fileName:"repro.js", allowJs:true, skipSemanticDiagnostics:true, validate:false})`,
then `WebAssembly.compile(result.binary)`).

## Root cause (confirmed)

`src/codegen/statements/loops.ts` `compileForStatement`, head-declaration arm,
L502–L514 (and the function-expression twin at L467–L477):

```ts
// Reuse existing local for var re-declaration
const existingIdx = fctx.localMap.get(name);
const localIdx = isVar && existingIdx !== undefined && existingIdx >= fctx.params.length ? existingIdx : allocLocal(...);
// If reusing a pre-hoisted slot, update the local's type to match
if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
  const localSlot = fctx.locals[localIdx - fctx.params.length];
  if (localSlot && !valTypesMatch(wasmType, localSlot.type)) localSlot.type = wasmType;   // <-- retypes the CELL slot
}
```

`localMap[i]` does not point at the hoisted `f64` value slot here. It was
re-aimed at a **ref-cell** local:

- eb7: `reifyCurrentDirectEvalBindings` (`direct-eval-environment.ts:324–388`)
  promotes every eval-visible binding to the canonical `(mut externref)` cell
  (`__direct_eval_cell_i_N`), sets `localMap[i] = cell`, `boxedCaptures[i]`.
- eb8: closure construction boxes the captured `i` the same way (#1177/#3396
  family), before the loop is compiled.

The for-head then (1) promotes `i` to `i32` via `detectI32LoopVar` and (2)
**overwrites the cell local's declared type with `i32`** and `local.set`s an
`i32.const` into it, while every already-emitted and later read goes through
`boxedCaptures` (`local.tee cell` → `ref.is_null` → `struct.get`). WAT of eb7:

```
(local $10 i32)                            ;; was the externref cell local
(local.set $10 (i32.const 0))              ;; for-head init writes the counter
(local.tee $11 (local.get $10))            ;; $11 : (ref null $cell) — eval-cell read of `i` → INVALID
```

`compileVariableStatement` has exactly this guard since #3396
(`variables.ts:2227–2243`: skip the re-type when `fctx.boxedCaptures?.has(name)`,
and store through the cell via `boxedForInitStore`, L2552–2575). The for-head
arm never received it.

## Implementation Plan

All in `src/codegen/statements/loops.ts::compileForStatement` (head-declaration
loop, L399–L536). No lane split: the defect is in the shared statement lowering
and reproduces on gc and standalone identically (linear lane: same file is
shared; verify once).

1. **Boxed-slot guard (mirror #3396).** Compute
   `const boxed = isVar ? fctx.boxedCaptures?.get(name) : undefined` (with the
   same `dropStaleBindingBox` liveness check `variables.ts:2554` uses). When
   `boxed` is set:
   - do NOT re-type the slot (both the L509–L513 block and the closure twin
     L474–L477);
   - do NOT promote to `i32` (`isI32LoopVar` must be `false` when `boxed`;
     the cell's `valType` is externref/f64 and `emitPromotedI32Increment`
     already bails because `getLocalType(cell).kind !== "i32"`, so the
     incrementor stays on the generic path — keep it that way);
   - emit the initializer with `boxed.valType` as the hint, coerce to it, then
     store through the cell exactly like `variables.ts:2566–2575`:
     `local.get <cell>; ref.as_non_null; <value>; struct.set cellType 0`
     (re-resolve `fctx.localMap.get(name)` AFTER compiling the initializer —
     #4368: the initializer itself can be what first boxes the name).
2. **Ordering constraint (ECMA-262 §14.7.4.2 / §14.7.4.3).** A `var` head is
   just VariableDeclarationList evaluation in the function's VariableEnvironment;
   nothing changes about when the initializer runs. Only the storage changes,
   so no observable-order difference is allowed: the initializer is evaluated
   once, before the first test, in source order.
3. **Keep the fast path.** Unboxed `var` counters keep the i32 promotion and the
   slot re-type exactly as today (`#3419` constraint on `var` redeclarations
   stands); the guard adds one `Map.get` per head declaration.
4. **Regression tests** (`tests/issue-6939-for-head-boxed-var.test.ts`, pattern
   of `tests/issue-3396-closure-struct-type.test.ts`): compile eb7 and eb8
   through the public `compile()` on `gc` and `target: "standalone"`,
   `WebAssembly.compile` must accept, instantiate and `run()` must return the
   node values (1 and 2). Add the eval-after-loop variant (`eval("i")` → `1`
   after the loop) and a `let`-head negative control (unchanged path). Keep
   eb5/eb6 as "already valid" controls.
5. **Acceptance check.** Octane `earley-boyer.js` + `base.js` compiled with the
   `.tmp/oct-repro.mjs` driver shape (prelude `var alert; var performance = {now(){return 0}}; var print = function(){};`
   + exported `octane_run`) yields a `WebAssembly.compile`-valid module on gc and
   standalone. Whether it then *runs* is a separate question (eval is
   deferred-feature); the acceptance here is VALID wasm.

## Implementation notes (2026-10-10, Session C)

- `loops.ts` gained two small helpers next to `emitPromotedI32Increment`:
  `liveBoxedVarCell` (the `dropStaleBindingBox` liveness rule, inlined so
  `variables.ts` stays untouched) and `emitBoxedVarHeadStore` (the
  `boxedForInitStore` null-guarded `struct.set` idiom, cell local re-resolved
  after the initializer per #4368).
- General head arm: a live boxed `var` takes an early branch BEFORE type
  resolution / `detectI32LoopVar` — initializer compiled with the cell's
  `valType` hint, stored through the cell, `continue`. So no i32 promotion,
  no slot re-type, no `allocLocal` (which would have re-aimed `localMap`).
  Unboxed heads are byte-identical to before.
- Function-expression arm: same store after compiling the closure, instead of
  overwriting the slot type with the closure type.
- Evaluation order unchanged: the initializer is still evaluated exactly once,
  before the first test.

Results (file-copy A/B against `.tmp/base-loops.ts`):

| program | base gc / standalone | head gc / standalone |
| --- | --- | --- |
| eb7 | INVALID / INVALID | VALID `1` / VALID `1` |
| eb8 | INVALID / INVALID | VALID `2` / VALID `2` |
| eb5, eb6 controls | VALID (runtime-eval provider missing) | unchanged |
| Octane earley-boyer (+base.js) | INVALID `sc_jsNew` both lanes | **VALID** gc (16 s) + standalone (43 s) |

`tests/issue-6939-for-head-boxed-var.test.ts`: 14/14 on head, 10 fail on base
(the 4 negative controls pass on both). Focused suite (17 loop/closure/eval
test files, 185 tests): identical failure set base vs head (19 pre-existing).

Found, NOT fixed (separate pre-existing defects, reproduce with a plain
`var` statement too, so not this issue): a boxed function-valued `var`
(`var g = function(){ return typeof h }; var h = function(){}`) yields
`illegal cast` / wrong `typeof` at runtime; a boxed string `var` read via
`.length` derefs null on standalone.

## Acceptance criteria

- eb7/eb8 → valid Wasm on gc + standalone, results match node.
- earley-boyer compiles to valid Wasm on both lanes (`sc_jsNew` no longer the
  first validation failure).
- No test262 regression (merge_group), equivalence gate green, `check:ir-fallbacks`
  unchanged (this is legacy-path code).

## Ownership note

Files are in Session A's WasmGC/shared-IR area; implementation is done by
Session C at the project lead's direction. Exact touch points so A can check
overlap: `src/codegen/statements/loops.ts::compileForStatement` (head
declaration arm L399–L536 only — the `isI32LoopVar`, slot re-type and
`emitCoercedLocalSet` lines); read-only reuse of
`variables.ts::dropStaleBindingBox` and the `boxedForInitStore` idiom. No
change to `direct-eval-environment.ts`, `closures.ts`, or `variables.ts`.

## Overlap check (2026-10-10)

- `grep -ril` over `plan/issues` for the symptom: #3396 (done) fixed only
  `variables.ts`; #1453 (`let`/`const` per-iteration cells) and #3419 (`var`
  counter redeclaration) touch the same block but not this defect.
- Open PRs (`/pulls?state=open`): none touch `loops.ts` head-declaration code.
- Claim ledger: no claim on this id; #874 slice `octane-harness` is Session C's.
