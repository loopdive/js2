---
id: 7479
title: "Standalone link: `this` does not cross the link, so an IR-claimed self-constructing function overflows the stack"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, link
goal: core-semantics
related: [7376, 7478, 6723, 5383]
---

# #7479 — `this` does not cross the standalone link

## Problem

In a standalone compile that links a provider (the Temporal polyfill provider,
`compileWithTemporalGlobal`), this unit overflows the stack instead of
throwing a `Test262Error`. Temporal itself need not be referenced:

```js
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message;
}
function fail(message) { throw new Test262Error(message); }
function ctorOf(thrown) { return thrown.constructor; } // makes the IR claim Test262Error
fail("boom");
```

- **Measured, 2026-11-26, main `6694a8b8`:** linked, the unit throws
  `RangeError: Maximum call stack size exceeded`. The IR compiles
  `Test262Error` and `ctorOf`. Unlinked, it throws the Test262Error.
- **Cycle, from a full stack and the WAT:** consumer `__native_construct_1`
  → provider `__js2wasm_link_construct` → provider `__apply_closure` /
  `__call_fn_method_1` → consumer `__fn_tramp_Test262Error_cached` →
  `__ir_dyn_construct_1` → consumer `__native_construct_1` → …
- **Why it never terminates:**
  - `this` is passed in a per-module `__current_this` global
    (`ensureCurrentThisGlobal`, `src/codegen/statements/nested-declarations.ts`).
    The provider's dispatcher sets the provider's copy, while the consumer's
    IR body reads the consumer's copy, which is still null. So
    `this instanceof Test262Error` is always false and the body constructs
    again.
  - The consumer's peer-first construct arm (`src/codegen/native-construct.ts`)
    asks the provider's `__js2wasm_link_callable_kind` first. Under
    `canonicalRuntimeTypes` the provider cannot tell a consumer closure from
    its own, so it accepts the consumer's own constructor.
- **Exposed by:** #7376. While the harness shim mentions `eval`, the
  runtime-eval boundary keeps `Test262Error` on the legacy path (a static
  fnctor), and the cycle is not reached. Without that mention, 53 of 120
  sampled Temporal `name.js` / `length.js` / `prop-desc.js` rows overflow.

## Implementation Plan

- **Module.** Generalise `src/codegen/standalone-link-error-ctor-cells.ts`
  (#6723 D4, which shares the Error constructor globals across the link) into
  one shared-link-cells mechanism. Add the `this` cell to it; do not write a
  sibling module.
  - The provider exports its `__current_this` under an ABI name.
  - A linked standalone consumer imports that cell instead of defining its own
    in `ensureCurrentThisGlobal`.
- **Not chosen:** reordering or guarding the peer-first construct arm. Under
  canonical types neither side can tell who owns a closure, so that breaks
  provider-owned constructors the other way.
- **Check:** whether other per-module call-convention globals (`__argc`,
  `__extras_argv`) have the same cross-link problem. This is a guess and has
  not been checked.
- **Unchanged:** gc output and unlinked standalone output stay byte-identical.
  The provider cache key changes.
- **Quality criterion:** one shared-cell mechanism, with no second list of
  link cells.

## Acceptance

1. The repro throws the Test262Error when linked.
2. The reverse case still works: `new NS.F()` on a provider function
   constructor that reads `this`.
3. A byte A/B shows gc and unlinked standalone output unchanged.
4. The `issue-5383-*` and `issue-6723-*` linked tests pass.
