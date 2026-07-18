---
id: 838
title: "BigInt64Array / BigUint64Array typed arrays"
status: done
assignee: ttraenkler/dev-spec
completed: 2026-07-17
created: 2026-03-28
updated: 2026-07-17
priority: low
feasibility: medium
reasoning_effort: high
goal: spec-completeness
sprint: current
test262_skip: 19
test262_ce: 25
# Intended registry growth: registering a new typed-array family (BigInt64Array/
# BigUint64Array) requires touching the central type/storage registries in the
# codegen barrel + the count-constructor dispatch. New logic itself lives in the
# subsystem modules; these two are the single-source-of-truth registration sites.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/new-super.ts
---

# #838 -- BigInt typed arrays (BigInt64Array, BigUint64Array)

## Problem

19 tests use BigInt64Array or BigUint64Array which aren't supported. Our TypedArray implementation stores elements as f64, not BigInt. These are separate from SharedArrayBuffer — they work with regular ArrayBuffers.

The latest full recheck (`benchmarks/results/test262-results-20260407-111308.jsonl`)
also shows **25 constructor compile errors**:

- `Unsupported new expression for class: BigInt64Array` — 18 tests
- `Unsupported new expression for class: BigUint64Array` — 7 tests

Representative samples:

- `test/built-ins/TypedArrayConstructors/ctors-bigint/typedarray-arg/custom-proto-access-throws.js` — `L41:14 BigInt64Array`
- `test/built-ins/TypedArray/prototype/sort/BigInt/sorted-values.js` — `L30:14 BigInt64Array`
- `test/built-ins/TypedArrayConstructors/internals/Set/BigInt/bigint-tobigint64.js` — `L86:18 BigInt64Array`
- `test/built-ins/Atomics/wait/bigint/non-shared-bufferdata-throws.js` — `L17:14 BigInt64Array`
- `test/built-ins/TypedArrayConstructors/internals/Set/BigInt/bigint-tobiguint64.js` — `L88:18 BigUint64Array`

So this is no longer just a skip/coverage item; it is also a concrete CE bucket
in official-scope constructor coverage.

## Fix

Register BigInt64Array and BigUint64Array as TypedArray constructors with i64 element type instead of f64. Requires BigInt ↔ i64 coercion in array element access.

## ECMAScript spec reference

- [§23.2 TypedArray Objects](https://tc39.es/ecma262/#sec-typedarray-objects) — Table 69: BigInt64Array (i64) and BigUint64Array (u64) element types
- [§21.2 BigInt Objects](https://tc39.es/ecma262/#sec-bigint-objects) — BigInt values as typed array elements

## Acceptance criteria

- BigInt64Array/BigUint64Array constructors work
- Element access returns BigInt values
- 19 skipped tests unskipped
- 25 constructor compile errors eliminated

## Implementation

Both BigInt views use a dedicated **i64 element vec** (`typedArrayVecStorage`
returns `{ key: "i64", type: { kind: "i64" } }` for them) in BOTH the host/gc
and standalone/WASI lanes — an f64 cannot hold a 64-bit BigInt. BigInt is
already a first-class `{ kind: "i64", bigint: true }` value in the compiler, so
`array.get`/`array.set` on the i64 backing array need no packing/unpacking, and
ToBigInt64/ToBigUint64 (both reduce mod 2^64) come free from i64 wraparound.

Changes (all in `src/codegen/`):

- `index.ts` — new exported `BIGINT_TYPED_ARRAY_NAMES` set; `typedArrayVecStorage`
  returns i64 storage for the two views unconditionally; `resolveWasmType` maps
  the two view types to the i64 vec. Deliberately kept OUT of `TYPED_ARRAY_NAMES`
  so the f64-assuming host marshalling classifier treats them as "other".
- `expressions/new-builtin-globals.ts` — added the two names to the native
  TypedArray count/copy constructor set; added an **i64/bigint dest arm** to the
  array-literal copy conversion matrix (boxed source elements go through §7.1.13
  ToBigInt via `__to_bigint`, not ToNumber).
- `expressions/new-super.ts` — added the two names to the count-constructor set.

### Known representation limit

Shared with `BigInt.asUintN(64, …)` (#3148): the compiler's BigInt IS a signed
wasm i64, so a `BigUint64Array` element ≥ 2^63 reads back as its signed i64
interpretation (2^64-1 reads as -1n). ToBigUint64 mod-2^64 write semantics are
still correct, and every value < 2^63 round-trips exactly.

## Test Results

`tests/issue-838.test.ts` — 11/11 pass (host + standalone): count + array-literal
constructors for both views, element write/read, `.length`/`.byteLength`,
`BYTES_PER_ELEMENT`, ToBigInt64/ToBigUint64 mod-2^64 wrapping, for-loop
write/read with `BigInt()` coercion, max/min i64 round-trip, standalone compile.
No regressions in `bigint.test.ts` or the numeric typed-array paths
(Float64Array/Int32Array/Uint8Array verified unchanged host + standalone).

## Takeover + js-host Atomics gate (fable-dev-5, 2026-07-18)

**Author retired** (branch idle since 2026-07-17 20:03, ~11h; takeover per the
tech-lead [CI-FIX] task). The PR was hold-parked on a merge_group "check for
test262 regressions" (−3 net). Root-caused via a **contrabase isolation**
(re-ran the cited tests on current main WITHOUT the 3 #838 src files vs WITH
them, js-host lane):

- **5 genuine #838 regressions** (pass on main, fail with #838): all
  `Atomics/*/bigint/*` — `wait/{negative,out-of-range}-index-throws`,
  `waitAsync/{negative,out-of-range}-index-throws`,
  `notify/non-shared-bufferdata-count-evaluation-throws`. Cause: #838 routed the
  BigInt views to a native i64-vec in **all** lanes, but the js-host
  `Atomics.wait/notify/waitAsync` bridge does not validate indices over an i64
  native vec (the numeric-vec bridge does), so the spec RangeError/TypeError is
  not thrown first and the tests' poisoned args get evaluated.
- **3 pre-existing failures MIS-ATTRIBUTED to #838** by the merge_group diff
  (they fail on plain main too — baseline-stale, NOT this PR):
  `TypedArrayConstructors/BigInt64Array/prototype.js` +
  `.../BigUint64Array/prototype.js` (`verifyProperty` — undefined/null proto
  descriptor) and
  `ctors-bigint/typedarray-arg/other-ctor-returns-new-typedarray.js`
  (`Duplicate identifier 'isPrimitive'` compile_error). These should NOT be
  re-blamed on #838 in future regression diffs.

**Fix — standalone/wasi gate** (mirrors the numeric packed-view lane-gating
precedent, dual-mode principle: host lane rides host paths). The BigInt views
now take the native i64-vec path ONLY in standalone/wasi; js-host keeps the
host-global `BigInt64Array` (main's behavior). Sites tagged `#838 gate` in
`new-builtin-globals.ts`, `new-super.ts`, `index.ts:resolveWasmType`.

**Measured (js-host lane):** the 5 Atomics regressions → **5/5 recovered**;
broad `Atomics/{wait,waitAsync,notify}/bigint` scan is **byte-for-byte
identical to main (18 pass / 59 fail** — the 59 are agent/wait-suspend harness
gaps main also has), i.e. **zero js-host regression from the gate**. Standalone
BigInt64Array wins intact (`new BigInt64Array([1n,2n,3n])[1]` → 2, count-ctor
length → 4). Net vs main: standalone improvements only, strictly ≥ main.

**Follow-up filed: #3405** — extend the js-host Atomics bridge to i64-element
native vecs so js-host BigInt64Array can also use the native path (post-Monday
Opus work). The gate is removed once that lands.
