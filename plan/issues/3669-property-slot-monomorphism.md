---
id: 3669
title: Property slot monomorphism — a slot seeded with a number/boolean corrupts on some later writes
status: done
sprint: 77
priority: high
horizon: l
feasibility: hard
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [2773, 2760, 2949, 3667, 3668, 3671]
assignee: ttraenkler/opus-loop-g
created: 2026-07-26
completed: 2026-07-26
---

# #3669 — property slot monomorphism

## Problem

A property slot seeded with a **number** or **boolean** corrupts on _some_ later
writes of a different value kind. The read-back is a value that is **not equal
to itself** — the sNaN-like type-default sentinel #2760 already names.

```js
var o = {};
o.p = 1;
o.p = "unlikelyValue";
o.p === "unlikelyValue"; // false
typeof o.p; // "string"   <-- tag says string
o.p !== o.p; // true       <-- payload is sNaN
```

The tag and the payload disagree: `typeof` reports `"string"` while the stored
value behaves as sNaN. So this is not "the write was rejected" — the write
partially landed.

## Why it matters (reach bounds, NOT a flip count)

`propertyHelper.js:isWritable` decides writability by assigning the **string**
`"unlikelyValue"` over the property's current value and reading it back
(`isSameValue(obj[name], newValue)`). On a numeric property that read-back
fails, so `isWritable` returns `false` and `verifyProperty` reports
_"obj['p'] descriptor should be writable"_ on a perfectly ordinary property:

```js
var o = {};
o.p = 1;
verifyProperty(o, "p", { value: 1, writable: true, enumerable: true, configurable: true });
//   -> Test262Error: obj['p'] descriptor should be writable
```

**Bounds only:** 5,067 corpus tests call `verifyProperty`, and the `isWritable`
path runs in essentially every call that asserts `writable`. That is a ceiling
on reachability, **not** a predicted flip count — measure with
`scripts/harness-flip-probe.ts` (#3668) before quoting any number. The
circulating "~1,038" figure is unrelated and must not be reused.

## Characterisation (measured)

Through the real assembled harness on `upstream/main`, positive control on every
run, **reading verified deterministic** (byte-identical on repeat).
Reproducer: `scripts/fixtures/issue-3669-monomorphism/transitions.js`.

### Transition matrix — seed kind → overwrite kind

Harness lane (authoritative — this is the lane the corpus is scored on):

| seed \ write | number     | string     | boolean   | null       | undefined | object     |
| ------------ | ---------- | ---------- | --------- | ---------- | --------- | ---------- |
| **number**   | ok (ctrl)  | **BROKEN** | ok        | **BROKEN** | ok        | **BROKEN** |
| **string**   | ok         | ok (ctrl)  | ok        | ok         | –         | ok         |
| **boolean**  | **BROKEN** | **BROKEN** | ok (ctrl) | **BROKEN** | ok        | **BROKEN** |
| **object**   | ok         | ok         | –         | ok         | –         | –          |

**7 broken of 15 cross-kind cells measured.** All same-type controls pass.

**The pattern is not arbitrary:** a slot seeded with an **unboxed primitive**
(number or boolean) corrupts when written with a **reference-kind** value
(string / null / object); a slot seeded with a **reference** (string / object)
never corrupts. `undefined` writes always work. The boolean seed is strictly
worse than the number seed — it additionally breaks on `number`.

**It is still selective, not uniform** — `num→bool`, `num→undefined`,
`bool→undefined`, `str→*` and `obj→*` all work — so this is not one missing
widening primitive. The sharpest single lead is the asymmetry **`num→bool`
works while `bool→num` fails**: two adjacent transitions with opposite outcomes.

### The test shape matters — bare `compile()` misses two cells

A plain `compile()` (properly awaited, using `result.importObject`) reproduces
**most** of the matrix but **disagrees with the harness lane on two cells**:

| cell             | harness lane | bare `compile()` |
| ---------------- | ------------ | ---------------- |
| `bool→number`    | **BROKEN**   | ok               |
| `bool→undefined` | ok           | **BROKEN**       |

So a fast unit test written against bare `compile()` would **silently pass**
`bool→num` — which is one half of the asymmetry above, i.e. the single most
diagnostic cell. **Red tests for this issue must run through the assembled
harness path**, not a bare compile. (This is the third instance this session of
bare `compile()` disagreeing with the harness on the same broad surface; see
#3670.)

### Scope

- **Per-SLOT, not per-shape.** A sibling object built identically but only ever
  holding a string is unaffected (`shape-sibling:ok`). So this is the individual
  property slot's state, not a hidden class / shape transition.
- **Object-literal initialiser behaved exactly like assignment** —
  `{p: 1}` then `.p = "s"` broke identically, while `{p: "a"}` then `.p = "b"`
  was fine. So the seeding happens at first _value_, wherever it comes from.
  **This case is the residual left by the fix below** and is now tracked as
  **#3671**: a non-empty literal takes a different code path from the
  `var o = {}` widening pre-pass.
- **The slot does not recover.** A third, same-kind-as-the-second write
  (`o.p = 1; o.p = "s"; o.p = "t"`) still reads back wrong.
- The corrupted value is **self-unequal**, matching the "type-default sentinel
  (sNaN / `false` / `null`)" that #2760 describes for OOB array element reads.

## Adjacency — inherit, don't reinvent

This belongs to the **`value-rep-substrate` goal (#2773)**, not to
builtin dispatch:

- **#2760** (plain-array OOB → type-default sentinel) is the closest sibling:
  same class of defect (a slot's static Wasm type yielding a sentinel instead of
  the JS value), same sNaN signature. #2773 explicitly frames it as _"the
  element-read result needs an externref-or-undefined representation that
  ripples to every f64 consumer — a value-rep-shape decision, not a helper-flag
  flip."_ The same sentence applies here with "element-read" replaced by
  "property-slot read".
- **#2773** is the umbrella epic and asks the governing question directly:
  _what is the in-flight representation of a value as it crosses a
  dispatch/host/array boundary?_
- **#2949** would subsume this at the IR level (`{kind:"dynamic", tag?: JsTag}`),
  but is XL and not a prerequisite for a targeted repair.

**Lane note (ruled):** `value-rep-substrate` is nominally Lane B
(fable/porffor) under `plan/method/lane-partition.md`. The tech lead has ruled
that **implementation proceeds in Lane A**: no Lane B agent is active on this,
so there is nothing to duplicate, and the partition exists to prevent collision
rather than to route by topic. The defect is also **selective rather than a
substrate rewrite**, which is not the case the partition was written for.
Lane B should claim it if they turn out to be working adjacent — and if the fix
reaches deeper than the selective picture suggests, that is the point to stop
and re-route rather than push into the substrate.

## What this is NOT

- Not the detached-builtin defect (#3667). That is a real but narrow bug —
  exactly one cell (`write-detached + read-direct`) — and its author measured
  their candidate fix as a **no-op**, then parked it. It cannot explain this:
  the reproducer above uses plain assignment, no `defineProperty`, no detached
  reference, no descriptor sidecar.
- Not explained by descriptor-sidecar enrichment. The prediction that failing
  `propertyHelper` tests would be enriched for `defineProperty`-defined
  properties was **measured and falsified** (#3668): 671 of 893 such tests pass.

## Fix (landed) and its measured effect

**Root cause, localised:** `src/codegen/declarations/object-shape-widening.ts`,
`collectPropsFromStatements`. The pre-pass that types the widened struct's
fields was **first-write-wins**, guarded by a `seenProps` set — a second
assignment to the same key with a different RHS type was silently ignored for
typing. The field stayed frozen at the first write's `ValType` (`f64` for
`o.p = 1`), and every later `struct.set`
(`src/codegen/expressions/assignment.ts`, `emitAssignToTarget`) force-coerced
through `coerceType`, whose `f64`↔`i32` paths are raw Wasm numeric conversions.
A string therefore landed as a genuine NaN payload.

**The tag/payload divergence has a separate cause:** `typeof o.p`
(`src/codegen/typeof-delete.ts`, `compileTypeofExpression`) folds at compile
time from the checker's flow-narrowed static type, which tracks the _last_
textual write — independent of the frozen slot. So `typeof` said `"string"`
while the payload was NaN. There is **no runtime tag field** on this slot; the
`JsTag`/`$AnyValue` boxed-any carrier is a different substrate that this
widened-struct fast path bypasses entirely.

**Fix:** on a repeat assignment whose resolved `ValType` differs from the
recorded one, widen the field to `externref` instead of keeping the first
write's type.

**Verified by reverting**, not merely by controls: with the fix removed, the
`num→{str,null,obj}`, `bool→{num,str,null,obj}` and `third-write` arms return to
`BROKEN`; with it applied they report `ok`. The with/without diff is non-trivial
— this is not a no-op.

**Measured corpus effect: ZERO flips.** Local-vs-local A/B via
`scripts/harness-flip-probe.ts` over a **40-file** sample of
`built-ins/Object` propertyHelper/`verifyProperty` tests:
`0 gained, 0 lost, 0 other change, 40 unchanged`, partition verified 40 == 40,
`{"fail":14,"pass":26}` on both arms.

**Reported as a result, not massaged.** The sample was drawn _before_ the root
cause was known, and it is small and not representative; the 14 failures in it
are evidently dominated by other defects (descriptor sidecar, accessors) rather
than by this path. A larger or differently-targeted measurement may well show
flips — but re-picking the filter after seeing a zero would be exactly the
post-hoc fishing this project has been burned by, so the number stands as
measured. **No conformance improvement is claimed.** The fix is justified as a
correctness repair with a demonstrated with/without diff, not as a conformance
win.

**Residual scoped out:** non-empty object literals (`var o = {p: 1}`) take a
different path and are still monomorphic — filed as **#3671**, guarded by an
`it.fails` block that errors when it starts passing.

## Suggested next step

1. Find where a property slot's Wasm type is chosen from its first assigned
   value, and what the write path does when a later value doesn't fit.
2. The asymmetry (`num→bool` ok, `bool→num` broken) is the sharpest lead — two
   adjacent transitions with opposite outcomes should localise the gap quickly.
3. Measure the fix with `scripts/harness-flip-probe.ts` (#3668), local-vs-local
   A/B. **Report zero flips as a result if that is what it measures.**

## Probe hazards (cost real time here)

Two probe shapes fail to compile for reasons unrelated to this defect. A
CompileError is not evidence:

- Wrapping each arm in `function () { …; return o.p === x; }` →
  `call[0] expected type externref, found if of type f64`. Arms must be inline.
- `if (d.writable === true)` on a descriptor field, and `"…" + err.message` in a
  `catch` → `if[0] expected type i32, found global.get of type externref`.
