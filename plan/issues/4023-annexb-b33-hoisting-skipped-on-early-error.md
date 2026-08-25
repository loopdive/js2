---
id: 4023
title: "annexB B.3.3: web-compat function hoisting not skipped on Early Error — 96 ES5 standalone + host failures in annexB/language/{global,function}-code"
status: done
sprint: 78
created: 2026-08-01
completed: 2026-08-01
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: function-declarations
goal: es5
related: [3977, 3974, 2200, 2552, 3419]
origin: "2026-08-01 es5 goal, cluster #3 of #3977 (annexB hoisting, 207 reachable ES5 standalone failures)"
---

# #3980 — Annex B B.3.3 hoisting is not skipped when it would be an Early Error

## The semantics gap

A sloppy-mode `function F` nested in a block, an `if` clause, or a `switch`
case/default normally gets a **var-scoped** binding in the enclosing function or
global scope (B.3.3.1 / B.3.3.2). The spec creates it **only when replacing the
`FunctionDeclaration` with `var F` would not produce an Early Error**. When an
intervening **lexical** `F` exists — a `let`/`const`/`class` in an enclosing
block or case clause, a lexical `for` / `for-in` / `for-of` head, or a
_destructuring_ `catch` parameter (B.3.5) — the extension is skipped and **no
binding for `F` is created at all**: reading `F` throws ReferenceError and
`typeof F` is `"undefined"`.

js2wasm's `localMap` is **flat per function**, so the _lexical_ `F` declared in
an inner block / loop head / catch pattern allocated a function-level slot that
any nested closure captured from anywhere in the function. All 96 generated
`*-skip-early-err-*` tests assert exactly against that with
`assert.throws(ReferenceError, function () { f; })` — a read from a **nested
closure**, which is precisely where the pre-existing per-`FunctionContext`
guard (`fctx.annexBCancelled`, #2200 Phase 1) could not see. That guard also
recognised only a `function` whose _direct parent is a `Block`_ (missing the
`if`-clause and `switch` case/default positions) and only a lexical shadow at
the top of an enclosing `Block`/case clause (missing loop heads and catch
patterns).

Separately, the same guard **over**-fired: it treated a same-named **parameter**
as a cancellation and walked up into the function's own body block, so
`*-skip-param.js` and `*-skip-early-err.js` — where the enclosing scope already
binds the name and Annex B merely declines to create an _additional_ binding —
threw `ReferenceError: f is not defined` instead of reading the existing value.

## Minimal repro

```ts
// standalone or host, both identical
var __r = 0;
function readF() {
  try {
    f;
    return 0;
  } catch (e) {
    return 1;
  }
}
__r += readF() * 1; // want 1 (ReferenceError)
__r += (typeof f === "undefined" ? 1 : 0) * 2; // want 2
{
  let f = 123;
  {
    function f() {}
  }
}
__r += readF() * 4; // want 4 (ReferenceError)
__r += (typeof f === "undefined" ? 1 : 0) * 8; // want 8
// want __r === 15;  before this fix: 10 — `readF` resolved `f` to the number 123
```

All eight declaration positions × six cancelling binders reproduce; see
`tests/issue-3980.test.ts`.

## Lane

**Lane-independent.** The same 96 tests fail identically in the host lane
(`test262-current.jsonl`) and the standalone lane
(`test262-standalone-current.jsonl`), and the fix pays into both.

## Fix

New `src/codegen/annexb-cancel.ts` — the position-based, whole-`SourceFile`
counterpart to the per-`FunctionContext` map:

- `collectAnnexBCancelSites(sf)` collects every name whose web-compat var
  binding is cancelled, recording `{scopeStart, scopeEnd, blockStart, blockEnd}`.
  It recognises all three Annex B declaration positions (`Block`, `CaseClause` /
  `DefaultClause`, `if` then/else clause) and all cancelling binders (block /
  case-clause `let`/`const`/`class`, lexical loop heads, destructuring `catch`
  parameters — a _simple_ `catch (f)` deliberately does **not** cancel, per
  B.3.5). Memoized per `SourceFile`.
- It suppresses a site when the enclosing scope already binds the name
  (parameter, `var`, scope-top-level `let`/`const`/`class`/`function`) or when a
  **sibling** Annex B declaration of the same name in the same scope _is_
  eligible (`staging/sm/.../block-scoped-functions-annex-b-notapplicable.js`).
- `annexBReadIsUnbound(sites, id)` answers for a read **anywhere** in the module,
  including inside nested closures, skipping reads bound by an intervening scope.
- `compileIdentifierCore` consults it right after the existing
  `fctx.annexBCancelled` check. The ReferenceError emission moves to
  `emitAnnexBUnboundReferenceError` in the leaf module `src/codegen/js-errors.ts`
  (alongside `emitThrowReferenceError`), so both detectors share one emitter and
  neither god-file grows.
- `annexBHoistCancels` — the narrow per-`FunctionContext` detector — moves out of
  `nested-declarations.ts` into `annexb-cancel.ts` next to its superset, gains a
  `scopeBindsName` bail-out, and loses its wrong param-exclusion branch (which
  used to _cancel_ on a same-named parameter, turning `*-skip-param` reads into
  ReferenceErrors). `nested-declarations.ts` shrinks by 63 lines.

**Blast radius, measured:** `collectAnnexBCancelSites` returns a non-empty list
for **96 of 53,259** test262 files — exactly the 96 target tests, nothing else.
Every other module short-circuits on the empty list and is byte-identical.

## Measured before/after

Corpus: `annexB/language/{global-code,function-code}` (312 files), run through
`tests/test262-runner.ts` `runTest262File`.

| lane       | before    | after         | delta   | regressions |
| ---------- | --------- | ------------- | ------- | ----------- |
| standalone | 104 / 312 | **199 / 312** | **+95** | 0           |
| host       | 107 / 312 | **201 / 312** | **+94** | 0           |

(Host "before" is the committed baseline `test262-current.jsonl`, run
`20260801-090441`; the +94/+95 difference is the two `*-skip-param` /
`*-skip-early-err` tests whose standalone baseline differs.)

All 96 `*-skip-early-err-*` tests now pass, plus `block-decl-func-skip-param.js`
and `block-decl-func-skip-early-err.js`.

Wider regression sweep — 977 files across
`language/statements/{function,switch,try,if}` + `language/block-scope`,
standalone: **FIXED 2, BROKE 0.** (The sweep initially reported 8 "BROKE"
`$DONOTEVALUATE` negative-parse tests; re-running those same 8 files against
**unmodified `HEAD`** reproduces all 8 identically, so they are in-process-runner
vs sharded-CI-baseline drift, not a regression from this change.)

Suites: `tests/issue-3980.test.ts` (16 new), plus
`issue-2200-annexb-block-fn-hoist`, `issue-2552-annexb-phase2`, `issue-3419`,
`issue-2923-eval-const-broaden` and 17 scope/function/closure equivalence suites
all green. (`tests/equivalence/arguments-nested-and-loops.test.ts:181` fails —
verified pre-existing on unmodified `HEAD`.)

Gates: `tsc --noEmit`, `biome lint`, `prettier --check`, `check:loc-budget`,
`check:func-budget`, `check:oracle-ratchet`, `check:pushraw` all clean.

## Left blocked (not in scope here)

The remaining 113 standalone failures in the same two directories:

- **24** — `js2wasm:runtime-eval` unsupported (eval-gated, #2928 / #3974).
- **15** `Initialized binding created prior to evaluation` + **8**
  `SameValue(«function …», «undefined»)` — the _positive_ B.3.3 lifecycle: the
  outer var binding must exist as `undefined` before the block is evaluated and
  take the function value only at the declaration's evaluation point. #2200
  Phase 2 (`annexBOuterBindings`) implements this only for the narrow #2552
  window; widening it is a separate slice.
- **13** `outer declaration`/`inner declaration` + **13** `first
declaration`/`second declaration` — B.3.3 interaction with an existing
  same-named `var`/`function` (`existing-fn-update`, `function-redeclaration-*`).
- **5** `*-skip-dft-param` — a same-named **default**-valued parameter reads as
  `NaN`; a default-parameter issue rather than an Annex B one.
- **3** `illegal cast` / **1** null-deref in `*-block-scoping`, **1**
  `Cannot redeclare block-scoped variable 'a'` (TS front-end rejection).

## Acceptance criteria

- [x] All 96 `annexB/language/{global,function}-code/*-skip-early-err-*` tests pass.
- [x] `*-skip-param` / `*-skip-early-err` (scope already binds the name) do not
      regress into ReferenceError — both now pass.
- [x] No regression in the 312-file annexB corpus, either lane.
- [x] Blast radius verified to be exactly the target cluster across all of test262.
- [x] `tests/issue-3980.test.ts` covers all eight declaration positions, the six
      cancelling binders, and the non-cancelling counterparts.
