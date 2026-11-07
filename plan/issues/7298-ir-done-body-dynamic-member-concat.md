---
id: 7298
title: "IR: $DONE body — dynamic member read as a string-`+` operand (measured: 0 stride units; $DONE blocked by call-graph closure)"
status: blocked
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7297, 7277, 7287, 7276, 2949]
assignee: "ttraenkler/c-lane-opus"
---

# #7298 — `$DONE`'s body: a dynamic member read as a string-`+` operand

## Problem

The harness `$DONE(error)` (`test262/harness/doneprintHandle.js`, in every
async test) is legacy-compiled. With #7277's parameter-slot adoption
stacked (#7297), its own first refusal is `move-only[concrete]` on
`'Test262:AsyncTestFailure:' + error.name + ': ' + error.message`: property
reads on the dynamic `error` used as string-`+` operands. The brief: admit
that shape as a general admission, with one predicate in
`dynamicUsesAreMoveOnly`, only where the read flows straight into a string
`+` whose other operand is a proven string.

## Measurement (2026-11-07, main c03f7d0e, wrapped stride-40 standalone ledger)

**1. `$DONE` cannot go IR while its callee stays legacy.** The Step-2
call-graph closure in `selectIrFunctions` (`src/ir/select.ts`, the
`for (c of myCallees) if (!claimed.has(c))` loop) drops every claimed
function with an unclaimed local callee, unconditionally. A minimal program
confirms it:

```js
var print = function (v) { console.log(v); };
function h(msg) { print(msg); }
function d(e) { if (e) { h('a'); } else { h('b'); } }
```

→ `h` `external-call`, `d` `call-graph-closure` (its own shape is admitted).
`$DONE` calls `__consolePrintHandle__` on every path, and that function is
legacy for two independent reasons: its `msg` carrier (#7277) and the call
through the harness's `print` script-var function value (#7287). So the
slice's metric (−1 legacy unit per async file) is unreachable until both
land.

**2. The general shape has no other consumer on the stride.** Census of
every legacy unit's first refusal:

- `move-only*` first refusals: **134 units, none of them a member read as a
  `+` operand**. The groups are:
  - `makeArrayLike` (51): `{ length: arr.length }`;
  - `printStringCodePoints` (14): for-of;
  - private-method `this` (24);
  - Intl list returns (20);
  - `Convert` / `ToNumbers` / `CollectValuesAndResize` (9);
  - a handful of singletons.
- First refusals of any code on a `BinaryExpression` `+` /
  `PropertyAccessExpression` / `ElementAccessExpression` containing a member
  read: 12 units, all of them other shapes (`new Temporal.X`, `X.prototype`
  stores, `obj['try']()` callees).
- `operand-coercion-unsupported` first refusals (6, all `<module-init>`): wrapper
  predicates and mixed-family operators (`true & undefined`, `"1" | 1`,
  `{valueOf…} > 1`, `'…' + (void 0)`), none a member read.

**Units the admission would move on the stride today: 0.** That is below the
brief's threshold of 5, so this slice is docs-only.

## Conclusion

- Parked: `status: blocked` until #7277 and #7287 land (not `depends_on`, since neither issue file is on main yet).
- Once both land, `$DONE` is the deferred consumer. The admission is then
  worth one IR unit per async file, about 139 files on the stride. The
  remaining parts of the body are:
  - (1) `if (error)`: externref truthiness, which exists;
  - (2) `'name' in error`: native `in`, `src/ir/native-in.ts`, fixed for
    `Object.prototype` keys in #7276 / PR #7142;
  - (4) `String(error)`: to be verified against the ambient-call admission.
- Contract this would rely on: #2949's move-only scan treats a dynamic
  value's use as concrete unless an arm proves the consumer reads the
  carrier. The admission would be one more such arm: the member read's result
  is consumed only by a `+` whose other operand is a proven string, so it is
  ToPrimitive'd and ToString'd there, the way legacy's dynamic `+` does. The
  open contract question (comment 6698013955, the value-used seam) is not
  needed for that.
- No code change on this id.
