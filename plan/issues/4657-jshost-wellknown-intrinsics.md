---
id: 4657
title: "js-host: wellKnownIntrinsicObjects harness self-test — new Function(dynamic source) cannot obtain %Array%"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4633, 4650, 4626]
trap-growth-allow:
  count: 16
  reason: "Stale-baseline reclassification carried from merged PR #4794 (realm shim #4634): 16 cross-realm tests that were ALREADY failing null-deref instead of failing an assertion. Named per #3596; failure-flavour reclassification only. Inert once the baseline re-promotes."
  tests:
    - test/built-ins/AsyncFunction/proto-from-ctor-realm.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Function/internals/Call/class-ctor-realm.js
    - test/built-ins/Function/internals/Construct/derived-return-val-realm.js
    - test/built-ins/Function/internals/Construct/derived-this-uninitialized-realm.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Proxy/apply/arguments-realm.js
    - test/built-ins/Proxy/construct/arguments-realm.js
    - test/language/eval-code/indirect/realm.js
    - test/language/expressions/async-generator/eval-body-proto-realm.js
    - test/language/expressions/generators/eval-body-proto-realm.js
    - test/language/expressions/tagged-template/cache-realm.js
    - test/language/types/reference/get-value-prop-base-primitive-realm.js
    - test/language/types/reference/put-value-prop-base-primitive-realm.js
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
files:
  - src/codegen/array-methods.ts
  - src/runtime-eval.ts
  - src/runtime.ts
---

# js-host: `wellKnownIntrinsicObjects` — cannot obtain %Array%

Last of the harness self-test failures with no owner. Goal context: 100% of
`test/harness/` in BOTH lanes. Measured on main at `16eba04e8` (2026-08-23):
standalone **115/116**, js-host **102/116** (the three queued PRs #4801/#4803/
#4804 take js-host to ~113/116; this test is not among their fixes).

## Symptom

```
Test262Error: this implementation could not obtain %Array%
  at L11: assert(Object.is(Array, intrinsicArray))
```

## Mechanism

`test262/harness/wellKnownIntrinsicObjects.js` L374-384 obtains every intrinsic
with a **dynamically built source string**:

```js
WellKnownIntrinsicObjects.forEach((wkio) => {
  var actual;
  try { actual = new Function("return " + wkio.source)(); } catch (e) { /* ignore */ }
  wkio.value = actual;
});
```

`getWellKnownIntrinsicObject` then throws "could not obtain" when `value` is
`undefined` — so the js-host failure means the `new Function(...)()` call either
**threw** (swallowed by the harness's own catch) or **returned undefined**.

Two facts that shape the work:

- **The standalone twin is FIXED but by a different mechanism** (#4633, merged
  as PR #4800): it publishes the compiled `__builtin_Array` singleton on the
  shared runtime-eval realm carrier and seeds the QuickJS provider's identity
  registry. The js-host lane has no such provider — it uses the host's real
  `eval`/`Function` — so #4633's fix does not apply here. The js-host error
  string differs from standalone's old one (`could not obtain %Array%` vs
  `Object.is(Array, intrinsicArray)` false), confirming a different root.
- **#4650 (PR #4803, queued) added the `Function(<string>)` VALUE form** plus
  `__extern_new_function` `this`-routing (`src/runtime/dynamic-function-import.ts`).
  That work targeted `Function("return this;")()` — the PLAIN-call form. This
  test uses `new Function(...)` with a **computed** argument.

## Implementation Plan

1. **MEASURE FIRST, on a base that already contains PR #4803** (do not start
   until it merges — otherwise you will re-diagnose plumbing that is already
   fixed). Re-run the test js-host and confirm it still fails:
   `F=test/harness/wellKnownIntrinsicObjects.js npx tsx .tmp/one-host.mts`.
2. Determine which of the two branches holds: instrument a probe that does NOT
   swallow the exception —
   `var f = new Function("return " + s); var v = f();` with `s` a runtime
   variable holding `"Array"` — and print the thrown error or the returned
   value. A **literal** argument const-folds in-lane (`eval-inline.ts`) and
   measures the wrong path; #4633 lost time to exactly that. The argument must
   be computed at runtime.
3. Likely candidates, in order: (a) the host `Function` constructor shim
   rejects/does not receive a computed (non-literal) body string; (b) the
   returned callable is invoked through a path that yields `undefined` rather
   than the body's completion value; (c) the identifier `Array` resolves inside
   the host-evaluated body to something that does not survive the boundary back
   into compiled code.
4. Whatever the fix, `Object.is(Array, intrinsicArray)` must hold — the value
   must be the SAME object the compiled module's `Array` binding denotes, not a
   fresh wrapper. Check how `__get_builtin("Array")` and the host `globalThis`
   view relate before choosing where to fix.
5. The harness obtains ~380 intrinsics this way; only `%Array%` is asserted, but
   avoid a fix that special-cases one name. A general dynamic-`new Function`
   repair is in scope; a name table is not.

## Acceptance criteria

- `wellKnownIntrinsicObjects.js` passes js-host.
- Full js-host harness category does not regress (base measured on your branch,
  expected ~113/116 once #4801/#4803/#4804 are on main).
- Full standalone harness category stays 115/116 — in particular the standalone
  twin of this test, fixed by #4633, must not flip back.
- js-host 60-sample and the equivalence gate clean.

## Diagnosis (what it actually was)

The plan's step-2 branch question — "did the call throw, or return undefined?"
— had a **third** answer: the call was never reached. Two independent defects
stacked, and both had to fall. Neither is in the two files the plan listed.

### Defect 1 — the callback never ran (this is the "could not obtain")

Narrowing probe (runtime-built source, exception NOT swallowed) over six
callable shapes, all with `new Function("return " + w.source)` in the body:

| shape | before |
| --- | --- |
| `arr.forEach(arrow)` | **body produced nothing, `ran=0`** |
| `arr.map(arrow)` | works |
| user-defined HOF | works |
| function expression in a var | works |
| IIFE | works |
| declared function | works |

Only `forEach`, and only when the `new Function` is **inside the callback**
(the same module with `new Function` elsewhere is fine). The receiver matters
too: `WellKnownIntrinsicObjects` is an array of object literals, so its element
type is a **`ref` (object struct)**, not `f64`/`externref`.

That combination lands on `hofElemKindOk` in `src/codegen/array-methods.ts`.
A ref-element receiver is admitted to the native HOF lane only if
`hofRefElemClosureLaneSafe` says the callback body is closure-safe, and that
predicate treats **any identifier resolving to a declaration file** as a
host-only ambient (the #4616 Temporal guard). `Function` is declared in
`lib.d.ts` and was not in `CLOSURE_SAFE_AMBIENT_GLOBALS`, so it was
misclassified.

The misclassification was not a safe degrade. The gc-lane fallback for a
ref-element receiver is the **#3126 silent no-op** — already documented in the
`hofElemKindOk` comment as a known residual. The emitted module fetched
`arr.forEach`, **dropped** it, built a callback, **dropped** it, and never
called anything. Zero iterations, zero diagnostics, `wkio.value` never
assigned. `Function` genuinely has a dedicated native arm on this lane
(`emitDynamicNewFunctionHostEval` → `env::__extern_new_function`, #2960/#4650)
and resolves inside a lifted closure exactly as at top level, so it belongs in
the safe set alongside `Math`/`JSON`/`Object`/….

### Defect 2 — the value was obtained but was the wrong realm's object

With defect 1 fixed the error changed to
`Expected true but got false` at the same line: the intrinsic came back, but
`Object.is(Array, intrinsicArray)` was false. Measured, this was **specific to
`Array`** — `Object.is(Object, …)` and `Object.is(Math, …)` were already true,
and the mismatched `Array` had the same `.name`, the same `.prototype` and the
same statics as the module's. Only an identity test could see it.

Cause: the default `compat` policy builds the function meta-circularly —
`createNewFunctionShim` compiles the body into a **child Wasm module**. That
child was constructed with `createNewFunctionShim({})`, i.e. **no realm**, so
`buildImports(..., undefined, ...)` resolved the child's `global_Array`
declared-global import against the host `globalThis`, while the parent module
resolved its own `Array` against `globalSandbox` (the test262 per-test realm —
see the `_sandboxConstructorValue` note at `src/runtime.ts` ~L16703).
Two realms, one name.

`new Function` is realm-transparent per §20.2.1.1, so the fix is to thread the
parent's realm into the child: a new `EvalShimOptions.globalSandbox`, forwarded
to `buildImports`, supplied at the `__extern_new_function` construction site.
This repairs **all ~380 intrinsics at once** — no name table, which the brief
explicitly ruled out.

### Why the #4633 standalone fix did not transfer

Confirmed rather than assumed: #4633 published the compiled `__builtin_Array`
singleton on the runtime-eval realm carrier and seeded the QuickJS provider's
identity registry. js-host has no such provider — it has a *sandbox object* and
a *meta-circular child module*, and the gap was between those two. Standalone
stayed at 115/116 across this change, so the twin did not flip back.

## Measurements (this branch, provider built)

| run | before | after |
| --- | --- | --- |
| js-host full `test/harness/` | 105 / 116 | **106 / 116** |
| standalone full `test/harness/` | 115 / 116 | 115 / 116 |
| js-host 60-sample | — | 59 / 60 |

Failure-set diffs, not just totals: js-host flipped exactly
`wellKnownIntrinsicObjects.js` and gained nothing; standalone's failure set is
byte-identical. The 60-sample residual is the pre-existing
`AsyncDisposableStack/prototype/adopt/not-a-constructor.js`.

Base numbers were measured on this branch, not inherited: the brief's
102/116 predates PR #4803 landing on main.

## Residual (deliberately out of scope)

`[] instanceof v1` for a dynamically-obtained `v1 === Array` reads `false`
while `[] instanceof Array` reads `true`. That is the dynamic-RHS `instanceof`
path disagreeing with the specially-lowered builtin-identifier path; it is
independent of realm threading (the same disagreement exists for the
already-identical `Object`) and is not what this issue asserts. Worth its own
issue if it bites.

## Permanent repro

`test262/test/harness/wellKnownIntrinsicObjects.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
