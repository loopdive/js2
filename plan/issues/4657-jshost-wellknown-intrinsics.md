---
id: 4657
title: "js-host: wellKnownIntrinsicObjects harness self-test — new Function(dynamic source) cannot obtain %Array%"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4633, 4650, 4626]
files:
  - src/codegen/expressions/dynamic-function-ctor-value.ts
  - src/runtime/dynamic-function-import.ts
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

## Permanent repro

`test262/test/harness/wellKnownIntrinsicObjects.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
