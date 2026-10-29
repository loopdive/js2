---
id: 7177
title: "WASI IR: `.length` / `[i]` on a dynamic array or string returns undefined"
status: ready
sprint: Backlog
created: 2026-10-27
updated: 2026-10-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [7113]
---

# #7177 — WASI IR: `.length` / `[i]` on a dynamic array or string returns undefined

Found in the round-11 review of PR #6834 (#7113, finding A). The bug is already on main.

On WASI, the IR read of a property or element of the boxed-any carrier (the `dynamic` value
that a planned member closure's untyped parameter holds) has no string or vec receiver arm. So
`m.length` and `m[0]` answer `undefined` when `m` holds an array or a string. Named properties of
objects (`m.x`) read correctly. Standalone and gc native-first are correct.

```js
/** @returns {number} */ function subject() { return 0; }
subject.f = function (m, k) { if (k === 9) return; throw m.length; };
export function run() {
  try { subject.f([1, 2], 0); } catch (e) { return typeof e === "number" ? e : e === undefined ? -3 : -2; }
  return -9;
}
```

Measured on origin/main `72e8b57763` (`-3` = undefined; a string result is shown as `1000 + length`):

| Closure body | Input | node | wasi IR (claimed on main) | wasi legacy | standalone / gc |
| --- | --- | --- | --- | --- | --- |
| `throw m.length` | `[1, 2]` | 2 | **-3** | — | 2 |
| `throw m.length` | `"ab"` | 2 | **-3** | — | 2 |
| `throw m[0]` | `[1, 2]` | 1 | **-3** | — | 1 |
| `throw m[0]` | `"ab"` | 1001 | **-3** | — | 1001 |
| `var r = m ? m : 1; throw r.length` | `[1, 2]` | 2 | (refused) | 2 | 2 |
| `var r = m ? m : 1; throw r.length` | `"ab"` | 2 | (refused) | **-3** | 2 |
| `var r = m ? m : 1; throw r[1]` | `"ab"` | 1001 | (refused) | **-3** | 1001 |

The legacy wasi path is wrong for string receivers too, so this issue covers both paths.

Two more gaps in the same carrier member access affect every lane. On standalone and on WASI, an
IR element read on a carrier holding `null` / `undefined` returns a value instead of throwing a
TypeError: `throw m[k]` with `m = null` gives `-1` (null) on standalone, and main claims it. The IR
dynamic method call behaves the same way when the receiver is `null` or has no callable member:
`if (m.g() === null) throw "n"` gives `"n"` for `m = null` and for `m = [1, 2]`, where node
throws.

Inherited named reads are wrong on every lane, in the IR and in legacy alike, with the same value.
`typeof r.push` gives `"undefined"` for `[1, 2]` where node gives `"function"`; likewise
`typeof r.charAt` for `"ab"`, and `r.constructor` gives `undefined` for any input. They are not
refused, because legacy gives the same wrong value (#6834 round-12 review J).

Since #6834 round 12 the selector refuses these reads and calls at select
(`carrierMemberReadAdmissible`, `carrierMethodCallAdmissible` in
`src/ir/analysis/operand-admissibility.ts`). It refuses every element read and method call on the
carrier, and `.length` on a lane without the `native-dynamic-member-read` capability (true on
standalone, false on WASI). The refusal applies only to the shapes #6834 newly plans: a planned
member closure that mints a joined carrier (`var r = m ? m : 1`), or a throw-only body. So no new
claim carries these bugs. Main's existing claims, such as `throw m.length` above, keep their
behaviour; on WASI they are right for `null` / `undefined` receivers, where legacy is wrong. Once
this issue is fixed, retire the refusal.

## Implementation Plan

1. **Find the reader.** Locate the WASI lowering of the dynamic member read and element read that
   the IR emits for a carrier receiver (`__dyn_member_get` / the dynamic element read in the WASI
   runtime family), and compare its receiver dispatch with the standalone regime's.
2. **Add the missing arms.** Add the string and vec arms: `length`, and an integer index into the
   string's code units or the vec's elements. Reuse the standalone helpers if the WASI runtime can
   link them.
3. **Fix legacy.** Fix the WASI legacy string `.length` / `[i]` on an externref-carried string
   the same way.
4. **Fix the nullish receiver.** Make the element read and the method call on a `null` /
   `undefined` carrier (or a missing / non-callable method) throw the TypeError on every lane.
5. **Retire the gate.** Flip `native-dynamic-member-read` to true for WASI in
   `src/ir/backend/legality.ts`, let `carrierMemberReadAdmissible` admit element reads and `carrierMethodCallAdmissible` admit
   method calls, and drop
   the refusal rows from `tests/issue-7106-member-closure-shapes.test.ts`.
6. **Inherited members.** Resolve a named read through the receiver's prototype (`Array.prototype`,
   `String.prototype`, `Object.prototype`) on every lane.
7. **Tests.** Cover `.length`, `[0]`, `[k]` and out-of-range reads on array, string, object and
   number inputs, on all three lanes, executed.
