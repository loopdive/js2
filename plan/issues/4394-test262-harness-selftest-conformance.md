---
id: 4394
title: "Test262 harness self-tests: drive the 116-test cohort to 100% (GC lane)"
status: in-progress
sprint: current
priority: high
horizon: xl
goal: test-infrastructure
created: 2026-08-13
related: [4251, 4304, 4262]
loc-budget-allow:
  # The host-side `Test262Error` class and the `__new_Test262Error_ctor` builtin
  # belong to the runtime's import-resolution table, which lives here; there is
  # no separate host-error subsystem module to add them to.
  - src/runtime.ts
  # +18 lines: one more arm in the top-level-statement keep ladder, which lives
  # here next to the #2671 / #3666 / #2660 arms it mirrors. Splitting a single
  # arm out would separate it from the ladder whose order is load-bearing.
  - src/codegen/declarations.ts
func-budget-allow:
  # +23 lines: one more entry in the host import-resolution table. The table is
  # a flat dispatch over import names; there is no sub-unit to split it into
  # that would not just move the same switch arm behind an indirection.
  - src/runtime.ts::resolveImport
  # +5 lines: the new arm's body lives in its own module
  # (expressions/test262-error-ctor.ts); what remains here is the guarded call.
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  # +18 lines: one more arm in this function's top-level-statement keep ladder,
  # whose arm ORDER is load-bearing (each `continue`s past the later ones).
  - src/codegen/declarations.ts::collectDeclarations
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/compiler/import-manifest.ts
  - src/runtime.ts
  - tests/issue-4394-test262-error-ctor-identity.test.ts
---

# #4394 — make the Test262 harness self-tests pass (GC lane)

## Problem

`test262/test/harness/*.js` are the harness's **own** self-tests: each one
exercises a harness helper (`assert.throws`, `verifyProperty`, `compareArray`,
`asyncTest`, `deepEqual`, …) and fails if the helper misbehaves. #4304 admitted
the cohort into the canonical census; it measured **54 pass / 116** in the GC
lane at compiler `b363f29d3c43` / Test262 `b363f29d3c43`.

A broken harness helper is worse than a broken feature: it silently changes what
every conformance test that includes it actually measures.

## Baseline (GC lane, this container, 2026-08-13)

```
54 pass / 62 fail / 116 total
```

Reproduce with `runTest262File(<abs>, "harness")` over `findTestFiles("harness")`.

## Root cause 1 (dominant, ~27 tests) — `Test262Error` constructor identity

`src/codegen/expressions/new-builtin-globals.ts` intercepts `new
Test262Error(msg)` **by name, with no shadow guard**, and in the JS-host lane
lowers it to the `env::__new_Test262Error` host import, which builds a real
`Error` subclass declared in `src/runtime.ts`.

The literal upstream harness always **declares** `Test262Error` itself (sta.js:
`function Test262Error(message) { … }`), so the module's `Test262Error`
identifier reads a compiled WasmGC closure struct while the thrown object's
`.constructor` is the *host* class. The two can never be `===`:

| expression | before | correct |
| --- | --- | --- |
| `typeof Test262Error` | `"function"` | `"function"` |
| `e.constructor.name` | `"Test262Error"` | `"Test262Error"` |
| `e.message` | `"boom"` | `"boom"` |
| `e.constructor === Test262Error` | **`false`** | `true` |

Compiled `===` on two externrefs internalises both operands and uses `ref.eq`
when the right operand is statically a GC struct, so it does not even reach the
`__host_eq` shim (`_hostStrictEqual`) that was written for this case — it
short-circuits to `0`.

Every self-test in the `assert.throws` / `assert.sameValue` / `propertyhelper-*`
/ `verifyProperty-*` families reduces to this, reporting the tell-tale
`Expected a Test262Error, but a "Test262Error" was thrown.` (the message renders
`err.constructor.name`, which is right — only the *identity* is wrong).

### Fix

Keep the host `Error` (the exception bridge, `String(err)` and the failure
renderer all depend on a real `Error` subclass) and pass the module's own
constructor value alongside the message:

- new host import `__new_Test262Error_ctor(message, ctor) -> externref`,
  classified as a `builtin` intent in `src/compiler/import-manifest.ts` (it must
  precede the generic `__new_*` `extern_class` arm, which would otherwise read
  it as a class named `Test262Error_ctor`);
- the runtime handler stamps `ctor` as a non-enumerable own `constructor`
  property on the constructed error;
- codegen emits it only when the module has a top-level **function** declaration
  named `Test262Error` (`ctx.topLevelFunctionNames`, excluding `ctx.classSet` —
  class carriers take a different identifier path, the same carve-out
  `error-ctor-carrier.ts` documents), compiling the SAME identifier node the
  comparison site compiles so both reads resolve to one carrier global.

The host-side `class Test262Error extends Error` was also being minted **fresh
per resolver call**; hoisted to a single module-level `_HostTest262Error` so
constructor identity does not depend on which import a module bound.

### Measured

| | pass | fail |
| --- | ---: | ---: |
| before | 54 | 62 |
| after | **80** | 36 |

Regression check — zero status changes on both samples:

- `built-ins/Object/defineProperty`, first 400 files: 325 pass / 75 fail, **0 diffs**
- 205-file stratified sample of the 1,841 suite tests that call
  `assert.throws(Test262Error, …)`: 146 pass / 58 fail / 1 skip, **0 diffs**

## Root cause 2 (7 tests) — the second-level function-static write is dropped

`collectDeclarations` drops a top-level assignment whose root identifier is not
a module global. #2671 added a keep for `F.<prop> = …` with a **bare identifier**
receiver, and #3666 added the nested-receiver keep — but **for standalone only**.

So in the host/GC lane

```js
assert.deepEqual._compare = (function () { … })();   // deepEqual.js:142
```

compiled to **nothing**. `_compare` silently never existed; `typeof` still
answered `"function"` from a static inference, and the actual read returned
null, so the whole family failed with `TypeError: _compare is not a function`.

### Fix

Give the host/GC arm the same nested-receiver keep, gated identically to the
standalone one (`isTopLevelFunctionPropertyReceiver` — the root must be a
top-level function and the oracle must prove the receiver itself callable, which
excludes `F.prototype.m` and ordinary object-valued chains).

### Measured

80 → **84** pass. All 76 suite tests that include `deepEqual.js`: 4 fail → pass,
0 regressions; `built-ins/Object/defineProperty` first 400: 0 diffs.

## Remaining buckets (GC lane, 32 fail)

| bucket | n | signature |
| --- | ---: | --- |
| `deepEqual` | 7 | `TypeError: _compare is not a function` |
| asyncHelpers / `asyncTest` / `throwsAsync` | 8 | sync-vs-async throw ordering, `$DONE` flag plumbing, one null-deref trap |
| `verifyProperty` restore | 5 | `Expected SameValue(«false», «true»)` after descriptor restore |
| propertyHelper, symbol-keyed | 3 | symbol key reaches the integer-typed property path |
| `compareArray` | 2 | `arguments` formatting, `assert.throws` inside the comparator |
| `Object` method on null receiver | 2 | `TypeError: Object method called on null or undefined` |
| singletons | 9 | `isConstructor`, `testTypedArray`, `wellKnownIntrinsicObjects`, `fnGlobalObject`, `detachArrayBuffer` ×2, `assert-throws-native`, `assert-throws-custom-typeerror`, `verifyProperty-value`, `verifyProperty-desc-is-not-object` |

## Acceptance criteria

- [x] `e.constructor === Test262Error` holds for the literal-harness declaration
      in the GC lane, with no status change on a conformance sample.
- [ ] `assert.deepEqual` runs (the `_compare` closure resolves).
- [ ] The harness cohort reaches 116/116 in the GC lane.
- [ ] Every change is measured both ways; a previously-"passing" test that flips
      to failing because a helper stopped lying is a **correct** outcome and is
      reported, not suppressed.
