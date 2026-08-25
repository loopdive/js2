---
id: 4562
title: "STANDALONE + HOST: a function's intrinsic `length`/`name` are not materialised as property records, so the first partial define over them loses every omitted field"
status: in-progress
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
es_edition: 5
language_feature: property-descriptors
goal: es5
loc-budget-allow:
  # 2026-08-20: the §20.2.3.2 steps 5-8 `length` seed. All logic lives in the new
  # subsystem module src/codegen/bound-fn-meta.ts, including the local plumbing
  # (seedBoundFunctionLengthOnStack) that would otherwise sit at the call site —
  # the god-file grows by the IMPORT LINE plus the CALL LINE and nothing else,
  # down from +9.
  - src/codegen/expressions/calls.ts
  # 2026-08-21: the intrinsic-record seed. All logic lives in the new subsystem
  # module src/codegen/fn-intrinsic-seed.ts and it is invoked from
  # carrier-bag-define.ts (not a god-file); the finalize-time fill hangs off the
  # tail of fillFunctionInstanceProps, so the finalize driver src/codegen/index.ts
  # does NOT grow at all. What is left in this god-file is +2 lines: one
  # `keyLocalIdx: 1,` at each of the two define appliers that host the arm. The
  # arm cannot find the descriptor key without being told which local holds it,
  # and defaulting the index would silently misbehave for any future applier with
  # a different local layout — so the two lines are the irreducible residue.
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  # 2026-08-21: the same +2 lines as the loc allowance above, seen through the
  # function gate — both define appliers are emitted inside this one function,
  # so the two `keyLocalIdx: 1,` arguments land on it. Nothing else was added
  # here; the seed itself is a separate module.
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
coercion-sites-allow:
  # 2026-08-20: one `__unbox_number` call in the new src/codegen/bound-fn-meta.ts.
  # It is NOT a hand-rolled ToNumber: §20.2.3.2 step 6.b is answered FIRST by
  # `__typeof_number` (a non-coercing `typeof x === "number"` test), and the
  # unbox runs only on the branch where the value is already known to be a
  # Number primitive. Routing this through the coercion engine would be wrong,
  # not merely redundant — a coercing read answers 1 for `new Number(1)` and
  # `"1"` and THROWS on a Symbol, where §20.2.3.2 wants 0 in all three cases
  # (built-ins/Function/prototype/bind/instance-length-default-value).
  - src/codegen/bound-fn-meta.ts
related: [4437, 4555, 4563, 4491, 4163]
origin: "2026-08-19 ES5 standalone push, #4555 lane, while attempting bound-function `length`."
---

# #4562 — function intrinsic `length`/`name` have no record to merge with

## CORRECTION (2026-08-19): this issue was originally filed with a wrong, much broader diagnosis

The first version of this file claimed *"a partial `Object.defineProperty` over
an existing property resets the omitted attributes to false — §10.1.6.3
violated"*, and asserted it would likely unlock rows in the #4491 descriptor
lane. **That generalisation was mine and it is wrong.** The lane that found the
original symptom re-measured before building and corrected it; the correction is
recorded here rather than the file being quietly rewritten, because another lane
could have planned around the wrong claim.

**The general §10.1.6.3 merge is CORRECT.** Measured in standalone, with js-host
identical on every row:

| case | result | correct? |
| --- | --- | --- |
| fresh define, all attributes omitted | `1/---` | yes |
| partial value change on a `WEC` property | `2/WEC` | yes — attributes preserved |
| partial `enumerable:false` only | `1/W-C` | yes |
| literal property, then partial define | `5/WEC` | yes |
| non-configurable, redefine same value | allowed | yes |
| accessor, partial `enumerable:false` | `g/--C` | yes |
| data → accessor conversion | `g/-EC` | yes — E and C preserved |
| array `length`, partial define to 2 | `2/W--`, `arr.length === 2` | yes |
| class method descriptor | `W-C` | yes |

`built-ins/Object/defineProperty` is **1066/1131 in standalone** (16
QuickJS-blocked). The merge machinery is in good shape.

**Consequence: this does NOT unlock the #4491 descriptor lane.** Ordinary-object,
array and accessor descriptors all merge correctly today. That claim is withdrawn.

## The actual defect

A function's intrinsic `length` and `name` live in a shared per-declaration
`$__fn_instance_meta` struct (#4437), **not** in the property bag. So the first
`defineProperty` over them has **no existing record to merge with** and builds a
fresh one from the partial descriptor alone — losing everything omitted.

```js
function fn(a) {}
Object.getOwnPropertyDescriptor(fn, "length");   // 1/--C   correct
Object.defineProperty(fn, "length", { value: 7 });
Object.getOwnPropertyDescriptor(fn, "length");   // 7/---   configurable LOST
```

Worse — when `value` is the omitted field, the **value itself** is destroyed:

```js
function g(a, b) {}
Object.defineProperty(g, "length", { configurable: false });
g.length;   // undefined — want 2
```

A **custom** property on the same function merges correctly (`2/WEC`), which is
what isolates the cause to the intrinsic meta rather than to the merge.

## Shape of the fix

**Not a representation change.** Materialise the intrinsic as a real record on
first define — `{value: <meta>, writable: false, enumerable: false,
configurable: true}` — and let the existing, proven merge run. It reuses the
descriptor the gOPD arm already synthesises.

But it is **not cheap**, and it sits in delicate shared machinery:

- a seed step inside `__defineProperty_value` coordinating with
  `function-instance-props.ts`'s meta arms, **and**
- **the host lane needs its own fix**: there `gOPD(fn, "length")` returns
  `undefined` outright, so host starts from a different and worse place.

That makes it a genuine two-lane job — the cross-lane loop has to be **designed
in**, not merely verified in.

## Scope

~5 rows in `built-ins/Function/prototype/bind` plus an unknown few elsewhere.
Given that, and that it no longer unlocks #4491, **#4563 is the higher-value of
the pair**: single-lane, standalone-only, and it breaks a plain-JS idiom outright
rather than an attribute nuance.

## Verification required

Both lanes' conformance, GC-lane unit suites relative to the merge base, and the
121-module prototype-write corpus with its own `main` baseline via a per-test
`while read` loop (never `t262run.mjs <list> 1`).

QuickJS-blocked counts measured alongside: `Object/defineProperty` 16 of 1131,
`Function/prototype/bind` 9 of 100.

## 2026-08-21 — standalone fix MEASURED and a composition finding

Atomic base-vs-new (one script owning checkout/restore):

| | base | new |
| --- | --- | --- |
| `built-ins/Object/defineProperty` (1131) | 1077 | 1077 (±0) |
| `built-ins/Function` tree (509) | 265 | **268 (+3, 0 regressions)** |
| 551-row guard | 551 | 551 |
| js-host Function tree | 338 | 338 (±0) |

js-host output verified **byte-for-byte identical** by compiled-binary hash
(strong form: standalone hashes differ as they must, host hashes identical) —
after the lane caught its own first attempt being vacuous (an un-awaited async
`compile()` hashed the string "NO-BINARY" on every input; the tell was that the
STANDALONE lane also read "identical", contradicting an already-measured delta).

**Composition finding worth keeping:** the +3 are bind `instance-length-*` rows
that set `Object.defineProperty(target, "length", {value})` and THEN bind. The
old merge destroyed the target's own record, so the (already landed) bind-length
seed read a mangled value. Fixing the merge input fixed the bind rows — i.e.
**#4562 unblocked part of #4563's cluster, the reverse of the dependency
direction the issues describe.**

**Hardening added after measurement:** `__fninst_bag_owns` is reserved as a
constant-0 placeholder until `fillFunctionInstanceProps` clears its checks. A
placeholder answers "the bag never owns this key", which would re-fire the seed
on every define and silently revert a second define — a wrong value rather than
a missing one. `fillFnIntrinsicSeed` now refuses to fill while the placeholder
stands, degrading to no seed.
