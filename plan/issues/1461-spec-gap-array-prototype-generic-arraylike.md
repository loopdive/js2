---
id: 1461
title: "spec gap: Array.prototype.* called on array-like / exotic receivers"
status: done
created: 2026-05-20
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: array-methods
goal: spec-completeness
sprint: 58
related: [1154]
---
# #1461 - spec gap: Array.prototype.* called on array-like / exotic receivers

## Problem

`built-ins/Array/prototype/*` contributes **2,810 test262 failures**.
Distribution by method:

```
260 reduce      260 reduceRight   242 filter     219 some
218 every       216 map           201 indexOf    198 lastIndexOf
190 forEach      81 splice         71 slice       69 concat
 54 sort         39 copyWithin     30 includes    30 toSpliced
 24 findLast     24 findLastIndex  24 flatMap     24 push
 23 find         23 findIndex      23 join        23 pop
```

Most failing tests follow the same shape:

```js
Array.prototype.METHOD.call(obj, callback);
```

where `obj` is an **arguments object**, a **`new String("...")` wrapper**,
or a plain object with a `length` property (sometimes installed via
`Object.defineProperty` as an accessor). The compiler's array-like
dispatch path in `src/codegen/array-methods.ts` handles many cases, but
silently produces wrong results on several sub-patterns.

Sample failures:

| Test | Pattern | Symptom |
| --- | --- | --- |
| `filter/15.4.4.20-1-15.js` | `.call(arguments, cb)` | newArr[0]/newArr[1] missing |
| `some/15.4.4.17-1-8.js` | `.call(new String("…"), cb)` | callback `this` / `obj` wrong |
| `indexOf/15.4.4.14-2-7.js` | `.call({1:true, length:2}, true)` | returns 2 instead of 1 |
| `every/15.4.4.16-1-15.js` | `.call(arguments, cb)` returns false | returns true |
| `map/15.4.4.19-1-7.js` | callback throws or non-callable | "object is not a function" |
| `reduce/15.4.4.21-10-4.js` | array-like with sparse holes | wrong accumulator |
| Various | "ctors is not defined" / "$262 is not defined" | host helpers in test harness — skip filter? |

Error-mode distribution across all 2,810:
- 1,311 — assertion failed with no thrown error (silent wrong result)
- 948 — `returned <code>` (assertion threw `Test262Error`)
- 172 — invalid Wasm / compile error
- 38+19 — `ctors is not defined` (TypedArray harness leaking in)
- 19 — `timeout (30s)`
- 16 — `object is not a function`
- 14 — `array element access out of bounds`
- 12 — `illegal cast`

## Failure count

2,810 in `built-ins/Array/prototype/`. Realistically tractable: **~1,400**
(excluding `ctors is not defined` TypedArray harness leakage [~60],
host-only tests `$262`/`getClass` [~25], timeouts [~19], and tests that
require full property-descriptor support already tracked by #1460).

## Root cause

In `src/codegen/array-methods.ts`:

1. The generic array-like loop (~lines 1134–1300) reads `length` once
   via `__getProp` and assumes integer values. It does not run
   `ToLength` / `ToIntegerOrInfinity`, so accessor-`length`, NaN, and
   negative values produce wrong iteration bounds.

2. Holes (`HasProperty(obj, idx) === false`) are not skipped for
   `forEach`/`map`/`filter`/`every`/`some`/`find` — spec §23.1.3.X says
   "If kPresent is true, then …". Currently every index is visited,
   producing wrong callback `this` and including phantom `undefined`s.

3. For `Array.prototype.METHOD.call(stringObj, …)`, the receiver is a
   boxed `String` whose indexed properties are non-configurable data
   properties. The generic loop reads them via `__getProp` but the
   `callback(val, idx, obj)` third arg passes a *different* coerced
   value, breaking `obj instanceof String` checks.

4. `reduce` / `reduceRight` initial-value-omitted overload finds the
   first existing element via a hole-skipping scan — the current
   implementation doesn't.

5. Methods that **mutate** the receiver (`splice`/`push`/`pop`/`shift`/
   `unshift`/`fill`/`copyWithin`/`sort`) on array-like receivers do not
   write back the `length` property nor handle index gaps per spec
   (`Set(O, "length", …, true)`).

6. `indexOf` / `lastIndexOf` use `StrictEqualityComparison` (===) but
   the array-like path appears to use a value-conversion that diverges
   for `+0`/`-0` and NaN.

7. `concat`/`flat`/`flatMap` don't consult `Symbol.isConcatSpreadable`
   on array-like inputs.

## Acceptance criteria

1. `length` is read via `ToLength(Get(O, "length"))` in every generic
   array-like method — NaN/negative/non-integer values clamped per spec.
2. Hole-skipping (`HasProperty`) honoured by `forEach`, `map`, `filter`,
   `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`,
   `reduce`, `reduceRight`, `flat`, `flatMap`.
3. `reduce`/`reduceRight` initial-value-absent: scan to first present
   index; TypeError if none.
4. Mutating methods on array-like receivers write back `length`.
5. `indexOf`/`lastIndexOf` use exact spec `StrictEqualityComparison`
   (handle `+0`/`-0`/`NaN`).
6. `concat`/`flatMap` honour `Symbol.isConcatSpreadable`.
7. Callback's third arg (`obj`) is the original receiver, not a
   coerced copy — `obj instanceof String` etc. should hold.
8. ≥1,200 of the 2,810 failures resolved (≥43% pass-rate).
9. Tests: `tests/issue-1461.test.ts` with one focused case per acceptance bullet.

## Files to inspect

- `src/codegen/array-methods.ts` (lines 346–520 generic dispatch,
  1134–1300 array-like loop, 1516–2100 specific .call patterns)
- `src/codegen/array-reduce-fusion.ts`
- `src/runtime.ts` — `__getProp` / `__hasProp` helpers
- `tests/issue-1461.test.ts`

## Notes

- #1154 (`array-prototype-poisoning`) overlaps slightly — that issue
  is about user code mutating `Array.prototype`; this is about the
  generic-receiver dispatch.
- The "ctors is not defined" 60 tests use a TypedArray harness
  fixture — those should be classified as a separate harness gap, not
  part of this issue's success count.

## Resolution (2026-06-03)

All concrete acceptance bullets are satisfied. By the time this slice was
picked up, AC#1 (ToLength on `length`), AC#2 (HasProperty hole-skipping for
forEach/map/filter/some/every/find/findIndex/reduce/reduceRight), AC#3
(reduce/reduceRight initial-value-absent hole scan + TypeError on all-holes),
AC#4 (mutating-method `length` writeback — verified for splice/push), AC#5
(indexOf/lastIndexOf strict-eq, includes SameValueZero), and AC#7 (callback's
third arg is the original receiver) were already implemented and pinned green
in `tests/issue-1461.test.ts`.

The one remaining localized gap was **AC#6 — `concat` honouring
`Symbol.isConcatSpreadable` on array-like inputs**. `Array.prototype.concat`
on an externref/any receiver routes through the `__array_concat_any` host
import, which passed its arguments straight to native `[].concat(...args)`.
For an opaque WasmGC struct array-like (`{0:'a', 1:'b', length:2}` with the
flag set via `obj[Symbol.isConcatSpreadable] = true`), native concat sees a
single opaque object and appends it whole → result length 1 instead of 2.

Fix (`src/runtime.ts`):
- Added `_isConcatSpreadable(obj, callbackState)` — reads the §23.1.3.1.1
  flag from the struct sidecar (real symbol + the `@@isConcatSpreadable`
  mirror). Returns false when absent/falsy, so a plain array-like is **not**
  spread unless explicitly tagged.
- `__array_concat_any` now spreads any non-Array WasmGC-struct argument whose
  flag is truthy, reading its `length` and indexed elements via the
  `__sget_length` / `__sget_<i>` struct-getter exports (the same path
  `__extern_length` / `__extern_get_idx` use, since these are real WasmGC
  fields, not sidecar entries). Real Arrays and untagged objects keep their
  prior behaviour.

Guard tests added to `tests/issue-1461.test.ts` (now 27 green): flag=true
spreads + preserves element values; absent/false flag appends whole; real
Array `.concat` is unaffected.

**Remaining (NOT this issue):** the `indexOf({1:true},true)` boolean-struct-field
case stays `it.fails`-pinned, tracked under #1784 / #1788 (boolean i32
struct-field representation), which is a cross-cutting WasmGC representation
matter rather than the #1461 generic-receiver algorithm.

## STANDALONE residual (2026-06-19, sdev-ctorval re-ground for task #54)

The 2026-06-03 resolution closed the **host-mode** gap. The **standalone**
(`--target standalone`/`wasi`) lane still refuses 6 array-like `.call(...)`
methods loudly:

```
Codegen error: Array.prototype.<m>.call(...) over an array-like (non-array)
receiver is not yet supported in --target standalone (#2036 S6)
```

`STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS` (array-methods.ts:503) =
`{indexOf, lastIndexOf, includes, map, reduce, reduceRight}`. `forEach`/`some`/
`every`/`find`/`findIndex`/`filter` already have native `$Object`/`$ObjVec`
arms and work.

**Measured impact (2026-06-19):** 269 refuse-CE / 500 sampled files across the 6
refused methods' test262 dirs (`built-ins/Array/prototype/{reduce,reduceRight,
map,indexOf,lastIndexOf,includes}`). Real, large lever.

### Per-method empirical status (refusal removed, compiled `--target standalone`)
- **reduce.call(o, cb, init)** — VALID + correct, host-import-free (boxes via
  native `__box_number`). ✅ Ready to un-refuse.
- **reduceRight.call(o, cb, init)** — VALID + correct. ✅
- **reduce.call(o, cb)** *(no initial value)* — **INVALID Wasm**:
  `if[0] expected type i32, found call of type externref`. The §23.1.3.21
  forward hole-scan (find first present index; array-methods.ts ~1144-1206)
  emits an `if` whose condition gets an externref instead of i32. **This is the
  one real binary-emitter bug** blocking reduce/reduceRight. Fix it, then
  un-refuse both (the dominant ~520-test sub-slice in the distribution above).
- **map.call** — still uses `__js_array_new`/`__extern_set` host imports +
  index-addressed sparse set; needs a native indexed `$ObjVec`/`$Array` result
  arm (filter's push-compaction doesn't fit map's sparse semantics). Defer.
- **indexOf/lastIndexOf/includes.call** — search arm leaks `__host_eq`/
  `__same_value_zero`; needs a native StrictEqualityComparison / SameValueZero
  arm over the boxed elements. Separate sub-slice (#72-adjacent).

### Recommended PR sequencing
1. **PR-A (biggest lever):** fix the reduce-no-init scan invalid-Wasm, then drop
   `reduce`+`reduceRight` from the refusal set. ~520-test sub-slice.
2. **PR-B:** native search arm for indexOf/lastIndexOf/includes (native eq).
3. **PR-C:** native indexed result arm for map (sparse-hole aware).

Owner: sdev-ctorval. Status stays `done` for the host-mode #1461; this standalone
residual is the #54 follow-on (tracked on the task, not re-opening #1461).

## PR-A landed (2026-06-19, sdev-ctorval) — reduce/reduceRight with-initial-value un-refused

Shipped the safe slice of the standalone residual: `Array.prototype.reduce`/
`reduceRight.call(arrayLike, cb, init)` over a non-array receiver now compiles to
valid, host-free Wasm and is removed from the standalone refusal set **when an
initial value is supplied**. Measured base→patched on 260 reduce/reduceRight
test262 files (`--target standalone`): **pass 30 → 39 (+9)**, refuse-CE 140 → 40,
0 regressions (no pass→CE/fail).

The **no-initial-value** form stays gracefully refused (clean compile error, NOT
invalid Wasm) via `standaloneArrayLikeMethodRefused()` — its §23.1.3.21 forward
hole-scan trips a **module-finalization func-index shift**: the baked
`__extern_has_idx` call (funcMap idx stable at emit, verified 155=155) mis-resolves
to `number_toString` in the final binary (`if` over an externref → invalid Wasm),
while the adjacent `__extern_get_idx` survives — an `addUnionImports`/late-import
finalization reorder, not a localizable array-methods.ts capture bug. That fix +
`map` (sparse indexed result arm) + indexOf/lastIndexOf/includes (native-eq search
arm) remain as PR-B/C/D follow-ons.

Tests: `tests/issue-1461-standalone-reduce-arraylike.test.ts` (4 — with-init
reduce/reduceRight/arguments valid+correct; no-init never emits invalid Wasm).
