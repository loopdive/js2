---
id: 4167
title: "Async test failures surface the rejection reason as `[object WebAssembly.Exception]` — 1,380 host-lane fails carry no diagnosable error"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-09
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
loc-budget-allow:
  - src/runtime.ts
---

# #4167 — async rejection reasons stringify to `[object WebAssembly.Exception]`

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

### Fresh ES2015 gate cohort (2026-08-09)

On `origin/main` at `c7a26f9c` (the latest main when implementation began), an
authentic `runTest262File` harvest reproduced exactly 28 ES2015 Promise files
with the opaque signature: `Promise/all` 12, `Promise/race` 12, and
`Promise/resolve` 4. All 28 were runtime failures, not compile errors.

After the fix, the same 28-file local A/B produced 7 fail-to-pass gains, zero
losses, and 21 unchanged failures. Most importantly for this issue, the opaque
`[object WebAssembly.Exception]` signature fell from 28 to zero. The remaining
21 failures now expose specific Promise semantics gaps such as missing resolve
invocations, iterator errors, result-array identity, and wrong resolved values.
The 28 files are a diagnosis gate, not a promise that all underlying semantic
failures should flip in this slice.

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

- [x] An async test whose rejection reason is a Wasm-carried `Test262Error`
      reports the underlying message, not `[object WebAssembly.Exception]`.
- [x] The exact fresh 28-file ES2015 Promise gate drops the opaque signature
      from 28 to zero.
- [x] The paired local A/B has no losses (7 gains, net +7).
- [x] The follow-up cohort harvest records the new diagnostics so the
      residual real failures can be filed as children of this issue.

## Notes

Scope is the **default (JS-host) lane**. The standalone lane has its own
native-error-identity work (#2962, `done`) and a separate 20-record
`other:[object WebAssembly.Exception]` bucket that is likely the same class —
check whether one fix covers both before splitting.

## Implementation Summary

The IR `async.callback.wrap` adapter now declares an explicit
`module-tag-payload` exception policy. The shared host callback bridges apply
that policy at every relevant reaction edge: direct callback-maker dispatch,
compiled getter callbacks, and known- or dynamic-arity compiled closure
wrappers. When a callback throws a `WebAssembly.Exception` carrying the current
module's exported `__exn_tag`/`__tag`, the bridge extracts argument zero and
throws the exact JS payload. Foreign Wasm tags, `WebAssembly.RuntimeError`, and
ordinary host exceptions remain untouched.

The implementation intentionally does not repair the 21 newly visible Promise
semantics failures. Turning an opaque carrier into an honest, attributable
diagnostic is the boundary owned by this issue.

The adjacent #4103 schema assertion is also corrected to compare a manifest
requested from the seven mandatory async features with the mandatory subset of
the provider/capability catalogues. `value.undefined` is optional on current
`main`, so the untouched assertion was already red by expecting its provider
and capability even though that feature was not requested. This changes the
test expectation only; it does not add or remove a runtime provider.

The scoped `src/runtime.ts` LOC allowance covers 20 net lines at the existing
host-boundary wrapper functions. These are the last synchronous catch points
before native Promise turns a thrown carrier into a rejection: moving only the
payload helper to a subsystem file cannot move those wrapper-local dispatches,
and normalising later is too late. The tag inspection itself lives in
`src/runtime/native-function-source.ts`; the driver growth is limited to the
known-arity, dynamic-arity, callback-maker, and getter boundary wiring.

Files changed:

- `src/ir/async-runtime-providers.ts`
- `src/runtime/native-function-source.ts`
- `src/runtime.ts`
- `tests/issue-4167-async-rejection-identity.test.ts`
- `tests/issue-4167-test262.test.ts`
- `tests/issue-4103-ir-async-runtime-providers.test.ts`

## Test Results

- Focused identity matrix: exact `Error`, plain-object, primitive, and getter
  payload identity pass; foreign `WebAssembly.Exception` and
  `WebAssembly.RuntimeError` remain identical.
- Genuine IR ownership: the established single-await `fetchUser` source is IR
  emitted with `legacyBodyEmitted: false`, `irBodyEmitted: true`, and resolves
  `async.callback.wrap` to the policy-bearing adapter.
- Standalone control: the native Promise scheduler preserves rejection payload
  identity without host imports.
- Authentic Test262 28-file A/B: before 28 fail; after 7 pass / 21 fail; gained
  7, lost 0, net +7; opaque signature 28 to 0.
- `pnpm run typecheck`: pass.
