---
id: 1130
title: "Array methods — getter-observing property access on indices and length"
status: ready
created: 2026-04-20
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: high
goal: property-model
---
# #1130 — Array methods: getter-observing property access on indices and length

## Problem

**~80 test262 failures** in `assertion_fail / /Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight}/` install a getter via `Object.defineProperty` on an array index or the `length` property, and expect the getter to fire when the Array iteration method accesses that slot:

```js
var accessed = false;
var arr = [0, 1, 2];
Object.defineProperty(arr, "1", {
  get: function () {
    accessed = true;
    return 99;
  },
});
arr.forEach(function (v) {
  /* ... */
});
assert(accessed, "accessed !== true"); // fails — our impl reads data[1] directly, bypassing getter
```

Spec §23.1.3.{method} — each step calls `HasProperty(O, ! ToString(ℱ(k)))` and `Get(O, ! ToString(ℱ(k)))`, which invoke accessor getters when present. Our `src/codegen/array-methods.ts` generates a tight Wasm loop that reads from the underlying `array.get` instruction — no accessor machinery.

Same mechanism for `length`:

```js
Object.defineProperty(arr, "length", {
  get: function () {
    lengthAccessed = true;
    return 2;
  },
});
```

## Scope

- **~80 tests** — auto-classified with the regex `Object\.defineProperty\([^)]+, "(?:\d+|length)", .*get:` + `accessed|testResult`.
- Covers forEach, map, every, some, filter, reduce, reduceRight.
- Related: 68 "accessed !== true" + 7 "lengthAccessed !== true" + portions of "testResult" variants.

## Why this is hard

1. **Indexed access currently goes to `struct.get`/`array.get` directly.** No [[Get]] semantics.
2. **Spec-compliant iteration** requires HasProperty + Get for every index from 0 to ToLength(O.length). Each of those can trigger a user getter.
3. **`length` coercion** — ToLength(O.length) also goes through a Get. If length has a getter that returns a non-number (e.g. string `"2"` in filter/15.4.4.20-3-11.js), ToLength must still produce `2`.
4. Touches the property-access machinery (`src/codegen/property-access.ts`, `src/codegen/object-ops.ts`) — any change must keep the fast-path for real Arrays without accessors.
5. Interacts with **#1129 array-like receiver** (pattern B) — both need a general "read element via [[Get]]" primitive; fix for B may pave the way for A.

## Sample failing tests

- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-10.js` (getter on `length`, ToLength(getter result) expected)
- `test/built-ins/Array/prototype/every/15.4.4.16-7-b-3.js` (getter on index, flag check)
- `test/built-ins/Array/prototype/forEach/15.4.4.18-7-b-15.js` (getter on `"1"`, flag check)

All three FAIL today (codes 2 or 3) — confirmed via compile-verify probe.

## Implementation sketch (needs architect spec)

1. **Runtime representation** — for arrays that have had `defineProperty` called on an own index or `length`, flip a "has-accessors" bit in the vector struct. Fast-path: no-accessors → current direct read.
2. **Slow-path**: when accessors present, iterate via a host-bridge or Wasm-native [[Get]] that checks for an accessor descriptor and invokes the getter closure.
3. **`length` descriptor** — extend the vec struct to carry an optional length-accessor descriptor, or route length reads through a general property-access helper.
4. **ToLength coercion on getter result** — piggyback on the existing number-coercion path used by array bracket access.

## Acceptance criteria

- [ ] **Architect spec**: where the accessor descriptor lives on the vec struct, the fast-path/slow-path branching, how each callback method's loop is adjusted, interaction with `Array.prototype.X.call(plainObj, cb)` (issue #1131 — the B fix).
- [ ] **Regression test** `tests/issue-1130.test.ts` — one test per getter-on-index, getter-on-length, getter returning non-number with ToLength coercion, forEach/map/filter/every/some/reduce/reduceRight.
- [ ] **≥60 of 80 target tests** flip from FAIL to PASS.

## Related

- Probe report: `.tmp/array-callback-probe.md` in worktree `issue-cluster-b-dstr`
- Sub-pattern A of the array-proto-callback cluster (parent: 874 assertion_fail tests).
- Related: #1129 (thisArg ABI), #1131 (array-like receiver via .call).
- Spec: <https://tc39.es/ecma262/#sec-array.prototype.foreach> and siblings.

## Dispatch notes

Route to architect for implementation spec. `reasoning_effort: high`. Recommend **filing after #1131 lands** — if the B fix introduces a general "[[Get]](O, k)" helper, this issue can reuse it for the slow-path.

## Implementation Plan

(Author: architect, 2026-05-21. Builds on the sketch above; adds
exact struct field, branch placement, and the `__array_get_via_get`
helper.)

### Entry point

- `src/codegen/array-methods.ts` — every Array.prototype.X loop
  generator (forEach, map, every, some, filter, reduce, reduceRight,
  find, findIndex, indexOf, lastIndexOf, includes).
- New runtime helper `__array_get_via_get(arr, index)` in
  `src/runtime.ts` that performs spec-compliant [[Get]].

### Data structure changes

1. Vec struct (existing) gets a flag field:
   ```wat
   (type $vec_externref (struct
     (field $len    (mut i32))
     (field $data   (mut (ref $arr_externref)))
     (field $flags  (mut i32))          ;; NEW: bit 0 = has-index-accessors
     (field $lenDesc (mut (ref null any))) ;; NEW: optional length descriptor
   ))
   ```
   Bit 0 of `$flags` is set when any `Object.defineProperty(arr,
   numericKey, {get|set})` is invoked.

2. `$lenDesc` (nullable) holds the length getter descriptor when
   `defineProperty(arr, "length", ...)` is invoked with an accessor.

### Algorithm — array method loop with branch

For each loop method (e.g. `forEach`):

```wat
local.get $arr
struct.get $vec_externref $flags
i32.const 1
i32.and
if
  ;; slow path: spec-compliant loop using [[Get]]
  ;; for k from 0 to ToLength(Get(arr, "length")):
  ;;   if HasProperty(arr, ToString(k)):
  ;;     let v = Get(arr, ToString(k));
  ;;     callback(v, k, arr);
  ;; (calls __array_get_via_get, __array_has_via_get, callback)
else
  ;; fast path: existing tight loop
end
```

### Spec compliance — `length` coercion

When `$lenDesc` is non-null:
1. Invoke the getter (a funcref or externref).
2. Apply ToLength: ToNumber (coerce via existing `__to_number`),
   then floor / clamp to [0, 2^53-1].
3. Use the result as the loop bound. (Spec: ToLength of a string
   "2" → 2; of NaN → 0; etc.)

### Fast-path preservation

The bit-flag check is one `struct.get + i32.and + if`. For arrays
with no accessors, the branch predictor will pin the false path;
overhead < 1ns per call. Acceptable.

### Where the flag is set

`compileObjectDefineProperty` in `src/codegen/object-ops.ts:336`
already has a branch for arrays. When the key is numeric AND the
descriptor includes `get` or `set`, OR the key is "length" AND
descriptor is accessor, emit:

```wat
local.get $arr
struct.get $vec_externref $flags
i32.const 1
i32.or
struct.set $vec_externref $flags
```

Plus, for length-accessor: store the descriptor in `$lenDesc`.

### `__array_get_via_get(arr, index)`

```ts
function __array_get_via_get(arr, index) {
  const key = String(index);
  // Check own accessor on this index
  const accGet = _sidecarGet(arr, "__get_" + key);
  if (accGet) return _invokeCallback(accGet, arr, []);
  // Fall through to indexed read
  return _vecGet(arr, index);
}
```

### Edge cases

- **Getter throws** — must propagate (existing exception machinery).
- **Sparse arrays / HasProperty** — `HasProperty(arr, "5")` must
  return false for unset indices in `forEach` (spec skips them);
  `every` must NOT call the callback for missing indices. The
  helper `__array_has_via_get` returns based on sidecar + length +
  defined-bitmap.
- **Mutation during iteration** — spec snapshots `length` at start
  for some methods (map, filter, reduce — implementation-defined
  behaviour for some). Match V8: cache initial length.
- **`length` setter** — orthogonal; if user installs a length
  setter, writes to length now dispatch to the setter. Handle in
  array-length-write path (separate from this issue's scope but
  same flag).
- **`Array.prototype.X.call(plainObject, cb)`** — covered by #1131
  not here; coordinate the [[Get]] helper.
- **Reduce with no initial value, empty getter-driven array** —
  throws TypeError per spec; the slow path must mirror this.
- **`forEach` with a getter that returns `undefined`** — callback
  still invoked with undefined; do NOT skip.

### Test262 paths

- `test/built-ins/Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight,find,findIndex,indexOf,lastIndexOf,includes}/15.4.4.*-*`
- Specifically the `accessed` / `lengthAccessed` / `testResult`
  patterns called out above.

Acceptance: ≥60 of 80 target tests pass.

### Dependencies

- **#1131** — array-like receiver via .call; introduces the
  [[Get]] helper. This issue should land *after* #1131 to reuse it.
  If #1131 stalls, implement the helper here and #1131 reuses.
- **#739** — Object.defineProperty correctness; the flag-setting
  branch lives in the same file. Coordinate.
- **#929** — Object.defineProperty receiver validation; harmless
  overlap.

### Risks

- **Fast-path regression**: any incorrect bit-check could redirect
  hot arrays to the slow path. Add a vitest in
  `tests/issue-1130.test.ts` measuring iteration count delta
  before/after (microbench).
- **Spec corners**: ToLength returning 2^53-1 with no array data →
  loop must terminate; cap at a max of 2^32-1 for safety (matches
  V8 fast-path limit).
