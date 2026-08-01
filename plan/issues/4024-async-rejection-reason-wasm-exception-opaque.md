---
id: 4024
title: "Async test failures surface the rejection reason as `[object WebAssembly.Exception]` — 1,380 host-lane fails carry no diagnosable error"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: async-generators
goal: error-model
related: [1295, 1294, 2962, 2906, 3178]
origin: "2026-08-01 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260801-090441, gitHash c601e89b)"
---

# #3982 — async rejection reasons stringify to `[object WebAssembly.Exception]`

## TL;DR

**1,380 official failing tests** in the default (JS-host) lane report exactly
one error string:

```
Test262:AsyncTestFailure:Test262Error: [object WebAssembly.Exception]
```

This is the **single largest uncategorized bucket in the host lane** — bigger
than the next five `other` sub-buckets combined. Every record is `status:
fail` (none are `compile_error`), so these tests compile and run; they fail
with a rejection reason that has **lost its identity** on the way out.

The practical damage is diagnostic, not just cosmetic: 1,380 failures share a
single opaque signature, so they cannot be bucketed, triaged, or attributed to
a root cause by any downstream tooling. They are a blind spot in every harvest.

## Evidence

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260801-090441` (gitHash `c601e89b`), 43,098 official / 30,511 pass.

Distribution over the 1,380 records:

| Slice | Count |
| --- | --- |
| async-generator shapes (`async-gen*`, `async-generator`) | 847 |
| class elements (`class/elements/**`) | 384 |
| `for-await-of` | 268 |
| `built-ins/Promise` | 87 |
| `Array.fromAsync` | 24 |

By category: `language/statements` 634, `language/expressions` 591,
`built-ins/Promise` 87, `built-ins/AsyncFromSyncIteratorPrototype` 28,
`built-ins/Array` 24, `built-ins/AsyncGeneratorPrototype` 10.

Samples:

```
test/built-ins/Array/fromAsync/non-iterable-sync-mapped-callback-err.js
test/language/statements/class/elements/after-same-line-static-async-gen-rs-private-setter-alt.js
test/language/statements/class/elements/same-line-async-gen-private-method-getter-usage.js
test/language/statements/for-await-of/async-func-dstr-var-async-ary-ptrn-elision.js
test/language/statements/class/elements/async-gen-private-method-static/yield-star-getiter-async-not-callable-object-throw.js
```

## Root-cause hypothesis (needs confirmation)

`[object WebAssembly.Exception]` is the default `Object.prototype.toString`
rendering of a raw `WebAssembly.Exception` instance. So somewhere on the async
rejection path a thrown Wasm exception is passed to a **string coercion**
instead of being unwrapped into its payload (the JS `Error` / `Test262Error`
carried in the exception's tag fields).

The synchronous path already handles this: #1295 re-throws
`WebAssembly.Exception` out of `compiler.ts` internal catch blocks, and #1294
reclassifies them in the test262 worker. The **async** path (promise rejection
reason → `Test262:AsyncTestFailure:` reporting in `doneprintHandle.js`) appears
to have no equivalent unwrap, so the reason reaches the harness still boxed.

Two candidate sites, both worth checking before designing a fix:

1. the rejection carrier — where a thrown value crosses the async drive layer
   into a promise reject (`Promise_reject` / the CPS resume machinery of #2906),
2. the harness reporting shim that formats `AsyncTestFailure`.

If the payload is intact and only the *formatting* is lossy, this is a small
fix with a very large legibility payoff. If the payload is genuinely dropped at
the reject boundary, it is a real async-model bug and the tests are failing for
a second, hidden reason.

**Do not assume the tests would pass once the message is fixed.** The
deliverable here is *diagnosability first*: unwrap the reason so the 1,380
records split into real buckets. Some will then show genuine conformance bugs.
Re-harvest after landing to get the real distribution — that follow-up split is
expected to spawn child issues.

## Acceptance criteria

- [ ] An async test whose rejection reason is a Wasm-carried `Test262Error`
      reports the underlying message, not `[object WebAssembly.Exception]`.
- [ ] The `other:Test262:AsyncTestFailure:Test262Error: [object
      WebAssembly.Exception]` bucket drops to ~0 in a fresh host-lane harvest.
- [ ] Net official pass count does not regress.
- [ ] A follow-up harvest records the new sub-bucket distribution so the
      residual real failures can be filed as children of this issue.

## Notes

Scope is the **default (JS-host) lane**. The standalone lane has its own
native-error-identity work (#2962, `done`) and a separate 20-record
`other:[object WebAssembly.Exception]` bucket that is likely the same class —
check whether one fix covers both before splitting.
