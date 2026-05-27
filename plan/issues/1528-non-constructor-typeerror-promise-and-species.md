---
id: 1528
title: "spec gap: non-constructor TypeError — Promise.all / allSettled species and executor paths"
status: in-progress
created: 2026-05-20
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: promise, species, constructor-invariants
sprint: 52
es_edition: ES2015+
test262_category: built-ins/Promise, language/function-code
test262_count: 79
related: [1519]
---
# #1528 — `[object Object] is not a constructor` instead of spec TypeError

## Problem

79 test262 tests fail with:

```
[object Object] is not a constructor
```

The error wording is our runtime's host string, not the spec
`TypeError("X is not a constructor")` shape. Most cases come from
Promise combinators and from explicit non-constructor invocation
checks. Per spec, `Construct(C, …)` requires `IsConstructor(C)` and
throws `TypeError` otherwise — with the wording `"<X> is not a constructor"`.

## Failing test examples

- `test/built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js`
- `test/built-ins/Promise/allSettled/species-get-error.js`
- `test/built-ins/Promise/executor-function-not-a-constructor.js`
- `test/built-ins/Promise/allSettled/reject-element-function-length.js`
- `test/language/function-code/10.4.3-1-26gs.js`

Most tests do `assert.throws(TypeError, …)` so they fail because the
thrown object isn't recognised as `TypeError`. Two cases are related:

1. Promise species lookup (`@@species`) returns a non-constructor;
   we should call `IsConstructor` and throw spec `TypeError`.
2. `Promise.all/allSettled/any/race` executor handling — the *resolve*
   /*reject* element-function paths fall through into a `Construct`
   we don't gate.

## Approach

1. Make `IsConstructor` available at the codegen sites that perform
   `[[Construct]]` (Promise combinators, `new`).
2. Make the failure path raise spec `TypeError` with the canonical
   message instead of the host runtime string.
3. Bridge to #1519 (new-expression non-constructor TypeError) — there
   is likely a shared helper.

## Acceptance criteria

- The five example tests pass.
- The error string contains `"is not a constructor"` and the thrown
  object is `instanceof TypeError`.
- At least 50 of the 79 cluster tests flip to pass.

## Estimated impact

**~79 test262 tests** plus indirect downstream unblocks once Promise
combinators round-trip species correctly.

## Investigation + decomposition (2026-05-27)

Ran the five named test262 files and ground-truth compile/instantiate/run
probes on current main. The cluster is NOT a single Promise/species bug; it is
dominated by a **missing dynamic `[[Construct]]` path**, and the species half
is already spec-correct.

### Confirmed by probe
1. **Dynamic `new <runtime-value>()` does not perform IsConstructor + throw.**
   `new executorFunction()` where the callee is a runtime function value (the
   `isConstructor.js`-harness tests) is the dominant failing shape. Today such
   identifiers fall into the unknown-constructor `__new_<name>` extern-import
   path (throws a generic `No dependency provided` Error, not a TypeError) or
   silently no-throw. A type-checker heuristic cannot fix this safely: TS models
   plain function *declarations* as call-only (`construct=0, call=1`), identical
   to non-constructable function *expression values* — but `new f()` on a
   function value IS valid JS, so rejecting on the signature shape would regress
   valid constructions. This needs the architect-spec'd dynamic-construct path
   (route to `__reflect_construct` / Wasm-native IsConstructor), which touches
   the most-trafficked `new` dispatch. **Tracked as #1528a — needs architect
   sign-off; NOT landed here.**
2. **Species half already correct.** `Promise.allSettled.call(C, [])` does not
   spuriously read `@@species` (probe passed); the JS-host delegation in
   `runtime.ts` `Promise_allSettled` → native `Promise.allSettled.call` is
   spec-correct.
3. **`10.4.3-1-26gs.js` is mis-bucketed** — a strict-mode `new (anon fn)`
   returning `this` case, unrelated to non-constructor TypeError.

### Landed here (#1528b — safe static subset)
Broadened the static non-constructor guards in `new-super.ts` to unwrap
`as`/`!`/type-assertion wrappers (not just parens) via a shared
`unwrapNewTarget` helper, so `new ((() => {}) as any)()` and
`new (Math.abs as any)()` hit the real-TypeError throw path instead of slipping
into the dynamic path and silently no-throwing. The call-sig-only / prototype-
method guards now resolve the type on the *pre-cast* target. ~30 LOC, additive,
zero regressions in the constructor/new unit suites. Spec §7.3.15 Construct /
§7.2.4 IsConstructor.

**Status:** #1528b landed; #1528a (the dominant 79-test cluster) remains open,
escalated for an architect dynamic-construct spec.
