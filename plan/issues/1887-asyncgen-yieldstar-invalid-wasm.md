---
id: 1887
title: "async-generator yield* emits invalid Wasm (array.set in __closure) — 325 default-lane CE"
status: ready
sprint: 64
created: 2026-06-05
updated: 2026-06-05
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: async-generators
---

# async-generator `yield*` emits invalid Wasm (array.set in generated closure)

## Problem

Harvested from the default (JS-host) lane on 2026-06-04 (run `4ee32a3e`):
**325 official tests** fail at `WebAssembly.instantiate` with an invalid binary,
all in the async-generator `yield*` (delegation) family. The malformed
instruction is an `array.set` inside a compiler-generated closure function.

Representative error (default lane):

```
L60:21 invalid Wasm binary (WebAssembly.instantiate(): Compiling function
#42:"__closure_4" failed: array.set[...] expected type ..., found ...)
```

## Sample tests (3)

- `test/language/expressions/async-generator/yield-star-async-next.js`
- `test/language/expressions/async-generator/yield-star-sync-throw.js`
- (broader `language/expressions/async-generator/yield-star-*` + statement forms)

## Root-cause hypothesis

The `yield*` delegation lowering for **async** generators generates a closure
(`__closure_N`) that performs an `array.set` whose value/element type does not
match the target array's declared element type — i.e. a type-mismatched store
emitted into the delegation driver closure. This is specific to the async
generator path (the sync `yield*` path is not in this cluster), suggesting the
async CPS/driver wrapper around the delegation loop boxes/stores the inner
iterator result with the wrong ValType.

Likely sites: the async-generator lowering + `yield*` delegation codegen
(generators-native / async CPS), where the per-step result is stored into the
generator state/result array.

## Suggested fix

1. Reproduce with one `yield-star-async-next.js`; dump the offending
   `__closure_N` and identify which `array.set` mismatches (element type vs
   value on stack).
2. Coerce the stored value to the array's declared element type at the store
   site (the standard `coerceType` boundary), or fix the array's declared
   element type if it should be wider.
3. Add `tests/issue-1887.test.ts` covering async `yield*` next/throw/return
   delegation.

## Acceptance

- The 325 `yield-star-async-*` instantiation failures compile to a valid binary
  and run.
- No regression in the sync `yield*` path or the async-generator microtask
  tests.

## Notes

NEW issue from /harvest-errors 2026-06-04. Default-lane (not standalone) — does
not bear on the standalone-57% push; tracked separately. Count at filing: 325.

## 2026-06-21 sd-4 re-analysis — original symptom FIXED, residual is architectural

Re-bucketed `async-generator/yield-star-*` against the fresh baseline
(`.test262-cache/test262-current.jsonl`, run 2026-06-20):

| Bucket | Count |
|--------|-------|
| `invalid Wasm` / `array.set` (the FILED symptom) | **0** |
| `assertion_fail` (execution-order / laziness) | 72 |
| `runtime_error` | 13 |
| `illegal_cast` | 1 |
| **total** | **86** (was 325) |

**The original 325-CE invalid-Wasm `array.set` failures are gone** — that
codegen-validity bug was fixed by intervening async-generator / native-generator
work (#2170/#2171 + result-struct fixes). Reproducing the two named sample
tests now yields an **assertion failure**, not an instantiate error:

```
yield-star-async-next.js  → fail :: returned 2 | assert #1 at L147:
                              assert.sameValue(log.length, 0, "log.length")
```

### Residual root cause — eager-buffer async generators (architectural)

The remaining 86 fails are **execution-order / laziness** failures, not codegen
validity. The host generator runtime (`src/runtime.ts`) is **eager-buffered**:

```
src/runtime.ts:135
 *   buf: any[]   — eager-yield buffer (filled by the generator body)
```

The generator body runs up front and fills `buf` with every yielded value; the
consumer's `.next()` just reads from `buf`. So `yield* obj` eagerly drains
`obj`'s iterator into the buffer **before the consumer pulls the first
`.next()`**. The execution-order tests assert `log.length === 0` immediately
after constructing the async generator (nothing should have run yet) — but our
eager body has already invoked `get next` / `get return` / etc., so `log` is
non-empty → first assertion fails.

The native-generator `yield*` path (`generators-native.ts:436`, #2170/#2171)
only handles `yield* inner()` for a **numeric (f64) native-generator
declaration**; the 86 failing tests use async generators delegating to
sync/async iterables via `%AsyncFromSyncIteratorPrototype%`, which bail to the
eager host path.

**Making these pass requires a *lazy / suspending* async-generator runtime**
(true CPS state machine that suspends at each `yield`/`yield*` and resumes on
`.next()`), replacing the eager buffer — a multi-PR architectural change that
touches the generator runtime AND the codegen state-machine lowering. It is NOT
the localized "coerce one `array.set`" fix this issue was filed for, and it
overlaps the broader IR / front-end pipeline work (#1927).

### Recommendation (sd-4 → tech lead, escalated)

- **Close the filed symptom**: the 325-CE invalid-Wasm cluster is resolved;
  acceptance criterion #1 ("the 325 instantiation failures compile to a valid
  binary") is met on current main.
- **Re-scope / re-file** the residual 86 as an *architectural* issue —
  "Lazy/suspending async-generator runtime (replace eager-yield buffer) for
  `yield*` execution-order conformance" — which needs an architect spec, not a
  point-fix. sd-4 is NOT taking this as a solo codegen fix; releasing the claim
  so the lane stays clear.
