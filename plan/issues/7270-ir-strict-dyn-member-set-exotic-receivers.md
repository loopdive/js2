---
id: 7270
title: "IR strict `__dyn_member_set` throws TypeError for exotic receivers where legacy stores"
status: ready
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
related: [7260, 3795, 3797, 7106]
---

# IR strict `__dyn_member_set` throws TypeError for exotic receivers where legacy stores

## Problem

A strict-mode dynamic element store that the IR claims lowers to
`dyn.member_set` with `sloppy = false`, i.e. the native `__dyn_member_set`
helper. That helper throws TypeError whenever `__reflect_set` reports
`false`, and `__reflect_set` reports `false` for several receiver kinds
where the store succeeds (or must not throw), so the IR throws where legacy's
computed strict store (`__extern_set_strict`) does not. Found by the review of
PR #7107 ([#7260](7260-ir-move-only-dynamic-key-element-store.md),
comment 6677683015).

#7260 avoids it by admitting its new store in sloppy function code only. The
#3795/#3797 strict element stores still lower here, but no exotic receiver
reaches them (Acorn's receivers are plain objects).

## Where it lives

- `ensureDynMemberSet` (`src/codegen/dyn-read.ts`) builds the strict
  `__dyn_member_set`: `__reflect_set(recv, key, value)`, then `i32.eqz`, then
  throw TypeError ("Cannot assign to read only property").
- The selector admits the strict store in `scanExprInner`'s statement-store
  arm (#3797 / #7260); from-ast emits it in `lowerElementStore`
  (`src/ir/from-ast.ts`).

## Repro (head of #7260 before the narrowing, `73ea42c2`)

```js
/*---
flags: [onlyStrict]
---*/
function put(obj, name, v) { obj[name] = v; }
put({}, Symbol(), null);          // widens the params so the IR claims `put`
var a = [1, 2, 3];
put(a, 0, 9);
assert.sameValue(a[0], 9);
```

- The reviewer's measurement on gc, standalone and wasi: TypeError on head
  (IR), pass on base (legacy).
- My 17-receiver matrix (standalone and gc, the same `put`):

| receiver | legacy strict | IR strict (`73ea42c2`) |
| --- | --- | --- |
| array `[0]`, `[10]`, `["1"]`, `length` | stores | stores |
| Uint8Array in-bounds / string key | stores | stores |
| **Uint8Array out of bounds** (`u8[5] = 1`) | no throw | **TypeError** |
| Float64Array | stores | stores |
| **Map** (`m.x = 1`) | no throw | **TypeError** |
| Date, Error `message`, DataView, ArrayBuffer | stores | stores |
| plain object, function, RegExp | stores | stores |
| frozen object | TypeError | TypeError |

The reviewer's wider probe (`.tmp/rv/p5/ta.js`, strict, `put` claimed) also
saw TypeError on head for:
- typed arrays: in-bounds `t[0] = 300` / `t["1"] = 7`, `-0`, fractional and
  named keys, Float64Array;
- `a[10] = 1` on an array;
- DataView, ArrayBuffer, Map, Date, and Error `message`.

So the set of affected receivers depends on the store shape; the matrix
above is a lower bound.

Separate row, the same on both sides (legacy and IR, sloppy and strict):
`o[k] = "true"` with `o = [1]` and `k = 0` leaves `o[0] === 1`. The boxed
string-literal store to an array element is a no-op. Expected `"true"`.

## Acceptance criteria

- The strict helper agrees with legacy's `__extern_set_strict` for every
  receiver above: throws exactly where legacy throws, stores exactly where it
  stores. gc, standalone and wasi.
- Then #7260's sloppy-only restriction (`functionCodeStrictness(fn) ===
  false` in `dynamicLocalElementStoreIsLowerable`) can be lifted, with the
  matrix as the test.
- The array `"true"` store row is fixed, or split out with its own cause.
- Typed corpus byte-identical.
