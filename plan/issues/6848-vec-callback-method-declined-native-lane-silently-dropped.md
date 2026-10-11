---
id: 6848
title: "host lane: `Object.entries(o).forEach(cb)` whose callback captures an `any` binding is silently DROPPED — the callback never runs (hono `parseBody({ dot: true })`)"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
# (#6848, 2026-10-05) One extra disjunct in the #3201 arm's condition; the
# predicate lives in expressions/vec-callback-method-host-delegation.ts.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
---

## Problem

hono `src/utils/body.test.ts` — ten `parseBody` rows (`dot: true`, `__proto__`
keys, `File` values) fail. `convertFormDataToBodyData` runs

```js
Object.entries(form).forEach(([key, value]) => {
  if (key.includes(".")) { handleParsingNestedValues(form, key, value); delete form[key]; }
});
```

with `form` from `Object.create(null)` (typed `any`). Measured on upstream/main
`c3e3fab33d` (untyped `.js`, host lane): the callback never runs.
`[["x", 1]].forEach((e) => { form[e[0]] = 2; })` leaves `form` untouched,
while the same loop written as `for…of` works.

The emitted Wasm evaluates `__extern_get(arr, "forEach")`, builds the
callback with `__make_callback`, DROPS both and pushes `ref.null.extern`:
`compileCallDispatchTail`'s graceful fallback.

Why: `compileArrayMethodCall` lowers callback methods over a vec of REFERENCE
elements natively only when `hofRefElemClosureLaneSafe` holds, and since
#4728 a callback capturing an outer binding typed `any` is not lane-safe —
a deliberate decline to the host lane. But no host arm then claims a call on a
NATIVE vec receiver: the any/externref ladder needs an any-typed receiver, and
the #3201 native-receiver arm in `compileMethodCallOnReceiver` claims only
EXPANDO members (`forEach` is declared on `Array`).

Same defect for `map` / `filter` / `some` / `every` / `find` / `findIndex` /
`reduce` (measured: `filter` traps `dereferencing a null pointer`, `some`
answers `false`, `reduce` answers its seed).

## Implementation Plan

Widen the #3201 arm (the last step of `compileMethodCallOnReceiver`, reached
only after every native arm declined) to a native vec receiver calling one of
the callback methods that `compileArrayMethodCall` gates on `hofElemKindOk`
(`forEach map filter reduce reduceRight find findIndex findLast findLastIndex
some every`). The predicate lives in a new
`src/codegen/expressions/vec-callback-method-host-delegation.ts`; the arm itself
is unchanged — it passes the RAW vec struct to `__extern_method_call`, which
live-mirrors it for the host, and the callback is a `__make_callback` closure
with its own captures. Host lane only (`!standalone && !wasi`), so the
standalone lane is untouched.

Acceptance: the reductions above match node; regression test (base-failing
`forEach`/`filter`/`some` rows, plus an anti-vacuity row whose callback is
lane-safe and must keep the native lowering — no `__extern_method_call` for
it); hono `body.test.ts` 27/37 → 37/37.

## Resolution

Implemented as planned (`isDeclinedVecCallbackMethod` in
`src/codegen/expressions/vec-callback-method-host-delegation.ts`, one extra
disjunct in the #3201 arm). The `forEach` / `filter` / `some` / `every` /
`reduce` reductions match node; the lane-safe control keeps the native
lowering (no `__extern_method_call` import). Regression test
`tests/issue-6848-vec-callback-method-host-delegation.test.ts`. hono
`body.test.ts` 27/37 -> 37/37. Full A/B in
[#6846](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6846-async-nested-leading-await-replay).

Not covered (pre-existing, unchanged): a callback that WRITES into the tuple
element it receives (`pairs.forEach((p) => { p[1] = ... })`) -- the host sees
the mirrored element, so the write does not reach the Wasm tuple.
