---
id: 4634
title: "Runner realm shim: distinct per-realm error constructors WITHOUT builtin-shadowing names (same-realm harness tests)"
status: ready
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: testing
goal: test262-conformance
lane: B
trap-growth-allow:
  count: 16
  reason: "#4634 realm shim: createRealm().global is now a narrowed forwarding object instead of the real globalThis, so 16 cross-realm tests that were ALREADY failing (all baseline fail) reach their failure differently — property reads/calls on the realm object (e.g. other.eval(...) via the any-channel call path) answer null and null-deref instead of failing an assertion. Failure-flavour reclassification only; no baseline-pass test traps. The underlying any-channel call gap is compiler territory tracked by the standalone realm work, not widened here."
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
files:
  - tests/test262-runner.ts
---

# #4634 — Non-shadowing realm-shim error constructors

## Problem

`test/harness/assert-throws-same-realm.js` and
`asyncHelpers-throwsAsync-same-realm.js` fail standalone (the latter also
traps — see #4630 step 4). They need `$262.createRealm()` to expose error
constructors with DISTINCT function identity, so
`assert.throws(TypeError, () => { throw new realm.TypeError(); })`
REJECTS the foreign instance.

## The trap already hit once — do not repeat it

The first attempt (PR #4782's parked commit c3a45f95b) wrote the shim as
NAMED function expressions:

```ts
realm.TypeError = function TypeError(msg: any) { ... };
```

The `$262` stub is COMPILED SOURCE prepended to every `needs262` test
module, and the compiler's fnctor machinery is NAME-keyed
(`funcConstructorMap`, `classSet`, brand registries) — so a preamble
function literally named `TypeError` shadowed the builtin in EVERY such
module: 367 js-host regressions with wasm-hash change, 216 "invalid Wasm
binary", `e instanceof TypeError` false across Temporal buckets. Full
post-mortem in `plan/issues/4626-standalone-harness-selftest-gaps.md`
(first-slice item 4).

## Implementation Plan

1. In the runner's `$262.createRealm()` shim (tests/test262-runner.ts,
   the `let $262 = {` template around L2301), add per-realm ctors via a
   factory so NO builtin name appears as a function name anywhere in the
   compiled preamble:

   ```ts
   const mkRealmCtor = function (n: any): any {
     const f: any = function (msg: any) { (this as any).message = msg; };
     return f;
   };
   realm.Error = mkRealmCtor("Error");
   realm.TypeError = mkRealmCtor("TypeError");
   // + RangeError, SyntaxError, ReferenceError, EvalError, URIError
   ```

   The same-realm tests assert IDENTITY (`err.constructor !==
   TypeError`), not `.name`, so the anonymous inner function suffices; if
   a test turns out to read `.name`, install it as a data property, never
   via the function's own name.
2. **Regression gate BEFORE pushing** (the exact check the first attempt
   lacked): compile one `needs262` js-host test (e.g.
   `built-ins/JSON/stringify/value-string-escape-ascii.js`) on the branch
   and on main via `runTest262File` and compare `wasm_sha` — they must be
   EQUAL for any module that does not call `createRealm` beyond what main
   does. Also re-run the 8 baseline-pass `createRealm` standalone tests.
3. `assert.throws`'s rejection path also needs `err.constructor` identity
   on the foreign instance — verify against #4626's third-slice
   `.constructor` findings (a module-level typed use of the fnctor
   registers the identity machinery; the shim's factory closure may need
   the same nudge; measure, don't assume).
4. **Acceptance**: both same-realm harness tests pass standalone (the
   async one also needs #4630's trap fixed); wasm_sha equality per step 2;
   js-host harness category unchanged.
