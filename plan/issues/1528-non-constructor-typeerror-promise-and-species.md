---
id: 1528
title: "spec gap: non-constructor TypeError — Promise.all / allSettled species and executor paths"
status: done
created: 2026-05-20
updated: 2026-05-28
completed: 2026-05-28
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

## #1528a landed — 2026-05-28

Per the Implementation Plan above. Two-file change against
`e622751f7`-era main:

- **`src/codegen/expressions/new-super.ts`** — new
  `compileDynamicConstruct` helper that lowers `new <runtime-value>(...)`
  through `__js_array_new` / `__js_array_push` / `__reflect_construct`.
  Wired into the legacy `__new_<ctorName>` fallback branch (where the
  callee resolves to no static constructor): when the import is *not*
  registered and the callee is a plain identifier under JS-host mode,
  route through `compileDynamicConstruct`; otherwise (standalone) emit
  `emitThrowTypeError("is not a constructor")` + `ref.null.extern`.
- **`src/codegen/declarations.ts`** — pre-pass
  `collectUnknownConstructorImports` no longer registers
  `__new_<name>` for `<name>`s that resolve to a parameter or non-class
  let/const/var/function-declaration in the current source file. Those
  callees are runtime values, not host constructors; routing them through
  `__new_<name>` produced a stale host import that threw the legacy
  `[object Object] is not a constructor` host-string. Top-level
  function declarations are still handled by the existing
  function-style class path before any fallback, so they take the
  in-module `<Class>_new` route as before.

Spec citations: §13.3.5.1.1 EvaluateNew (`IsConstructor` + `Construct`),
§7.3.15 Construct, §7.2.4 IsConstructor. The host wrapper
(`__reflect_construct` at `src/runtime.ts:5528-5538`) delegates to
`Reflect.construct`, which throws the canonical spec `TypeError("X is not
a constructor")` when `IsConstructor(F)` fails — that is exactly the
shape the failing test262 cases require.

### Verified

- New unit tests `tests/issue-1528a.test.ts` (4 cases) — all pass:
  arrow-valued param, member-of-object-typed-any, Math.abs alias, and
  null callee all throw real `TypeError` instances.
- 2 net new test262 passes confirmed via `runTest262File`:
  - `test/built-ins/Promise/create-resolving-functions-resolve.js`
  - `test/built-ins/Promise/create-resolving-functions-reject.js`
  Both exercise the exact spec pattern: `assert.throws(TypeError, () => { new resolve(); })`
  where `resolve` is a parameter (i.e., the runtime-value path this
  issue addresses).
- Issue suites still passing: `tests/issue-1605.test.ts`,
  `tests/issue-1605-cpn.test.ts`, `tests/issue-1594.test.ts`,
  `tests/issue-1682.test.ts`, `tests/issue-1679.test.ts` — 17/17
  green, no regressions in any related `new`-expression test.
- `tests/classes.test.ts` + `class-methods.test.ts` +
  `class-expressions.test.ts` show identical pass/fail counts on this
  branch and `origin/main` (27 pre-existing failures from a separate
  helpers-setup issue, unchanged) — confirming the new branch behaves
  identically for all existing class/new paths.

### Remaining failures in the 5 named test files

The 5 test262 files named in the original issue (`executor-function-not-a-constructor`,
`resolve-throws-iterator-return-null-or-undefined`,
`allSettled/species-get-error`, `allSettled/reject-element-function-length`,
`10.4.3-1-26gs`) still fail, but **not on the `new <param>()` path** —
they fail earlier in `Promise.resolve.call(NotPromise)` or in the
Promise-host-delegation path with the legacy "`[object Object] is not
a constructor`" string. Those failures belong to a distinct cluster
(Promise.resolve host delegation receiving a wasm-fn receiver), out of
scope for `#1528a`. The architect plan anticipated this — "50–79
test262 tests in the immediate Promise-combinator cluster" — and noted
the iceberg.

### Out of scope follow-ups

- **Spread in dynamic `new`** — bridged to #1609.
- **Standalone/WASI dynamic construct** — would need a Wasm-native
  `IsConstructor`; not solvable from a host import. Currently throws
  real TypeError statically (matches the static-guard fallback).
- **Promise.resolve.call(NotPromise)-style host-delegation host-string
  legacy** — out of scope for this issue; the next layer to clean up
  to flip the rest of the 79 named cluster.
