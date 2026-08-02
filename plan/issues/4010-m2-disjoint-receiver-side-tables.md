---
id: 4010
title: "M2 — own properties on a non-$Object receiver live in TWO DISJOINT side tables that clobber each other; unify them"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# M2 — own properties on a non-$Object receiver live in TWO DISJOINT side tables that clobber each other; unify them

## Problem

Own properties written onto a **non-`$Object` receiver** live in per-type side
tables that the generic own-property natives do not all consult. Arrays carry
**two disjoint, identity-keyed side tables**, built by different issues, each
explicitly scoping the other OUT in its own header comment:

- `src/codegen/vec-props.ts` — #3537, the expando **"bag"**; scopes reflection out
- `src/codegen/vec-overlay.ts` — #3251, the descriptor **"companion"**; scopes
  `length` out

**Neither is aware of the other.** Measured:

```js
arr.q = 12;
Object.defineProperty(arr, "q", {writable: false});
arr.q   // => undefined
```

The descriptor op on one table clobbers the value held in the other.

`Date` / `RegExp` / `Error` have **no expando substrate at all** —
`d.enumerable = true; d.enumerable` does not even round-trip.

## Why this is the lever, not the symptoms

**~318 of the 347 files** in the #3991 population are blocked behind this.
Two issues already filed are **symptoms of it, not independent arms**:

- **#4006** — array `length`'s `writable` dropped on store
- **#4007** — array `length` absent from descriptor reflection in standalone

Do **not** fund those separately; fixing either in isolation patches a symptom of
a substrate defect. Whoever takes this cites them.

## What is NOT broken — do not re-litigate

- **`ToPropertyDescriptor` IS implemented** for dynamic descriptors, dynamically
  and proto-inclusively (#3246). The defects sit one level above it and one below.
- **The descriptor model is not broadly broken.** A 10-receiver × 5-column probe
  (50/50 correct on Node first) shows it **9/9 correct on the open `$Object`
  substrate**. Every remaining failure is a receiver-**representation**
  reachability problem, which is exactly what this issue is.

## ⚠ Two hazards, both measured the hard way

1. **Making a dead path live surfaces defects underneath it**, and some green
   files are green only because the dead path returned a plausible constant.
   `15.2.3.7-5-b-122` was **passing because the broken expansion defined
   `undefined`** — precisely what it asserts. Correct routing exposed a real
   `undefined→null` normalisation defect (`getField` normalises `undefined→null`
   for the absent get/set halves per #2106 S1; on `value` that is wrong, and
   `typeof null === "object"`).
2. **It was 1 file in 634 — a sampled at-risk set would have missed it.**
   Enumerate the complete at-risk population over all 43,106 official files; do
   not sample. That is what caught it.

Evidence table: `plan/issues/3991-dynamic-descriptor-static-expansion.md`.

---

# Regrounding against current main, 2026-08-03 (dev-lever3)

Every claim in the body above **still reproduces** at `642291b26`. The
regrounding also produced the artifact this issue was missing: a **receiver ×
operation capability matrix**, which is the design input for "one owner for
own-property truth".

## ⚠ No "narrower ready-to-take prerequisite" exists

This was searched for before starting: `related: []`, and no issue file mentions
one. The only narrower issues in this area are **#4006** and **#4007** (both
`horizon: s`, `status: ready`) — and this issue's own body explicitly says
**do not fund those separately**, they are symptoms. Anyone told otherwise
should treat the prerequisite as **not existing** rather than hunt for it.

## The capability matrix (standalone, current main)

Each cell is a **separate module**, so one failure cannot mask another.

| receiver | read | hasOwn | `in` | gOPD | keys | delete | defineProp→read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **`$Object` (CONTROL)** | ok | ok | ok | ok | ok | ok | ok |
| array | **ok** | ABSENT | ABSENT | ABSENT | ABSENT | **STILL PRESENT** | ABSENT |
| function | **ok** | ABSENT | ABSENT | ABSENT | ABSENT | **STILL PRESENT** | **ok** |
| Date | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT | *vacuous* | ABSENT |
| RegExp | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT | *vacuous* | ABSENT |
| Error | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT | *vacuous* | ABSENT |
| class instance (expando) | ABSENT | ABSENT | ABSENT | ABSENT | ABSENT | *vacuous* | ABSENT |

**Control validated**: `$Object` is **7/7 ok**, matching #3991's independent
"9/9 correct on the open `$Object` substrate". A control that is not all-ok
means the instrument is broken, not the substrate.

## ⚠ The `delete` column needed its own control — the first matrix was WRONG

The first pass measured `delete` as `hasOwnProperty(o,"q")` after the delete and
reported **"ok" for all seven receivers**. That was wrong in **two different
ways at once**:

- For **array / function** the property is **STILL PRESENT** after `delete`. The
  probe only read "ok" because `hasOwnProperty` is itself ABSENT on those
  receivers, so it answered `false` whether or not the value survived. A
  value-read probe shows `o.q === 12` still true.
- For **Date / RegExp / Error / class instance** the delete is **vacuous** — the
  write never landed, so "not an own property afterwards" carries zero
  information.

**This is the #4065 family biting the instrument itself**: the same quantity —
*"is `q` an own property of `o`?"* — derived two ways (`hasOwnProperty` vs. value
read) disagreeing, with no home for the invariant. That is precisely the defect
this issue exists to fix, and it is strong independent evidence for the design
goal. Any future probe here **must** gate on a precondition
(`.tmp/delete-control.mts`) rather than trust a single derivation.

## What the matrix says about the design

1. **`$Object` is the only receiver with a coherent own-property store.** Every
   other receiver has a *different, partial* subset working — not one shared
   store with gaps.
2. **The stores disagree internally, not just with each other.** On an array,
   `read` works while `hasOwn`/`in`/gOPD/`keys` do not. So the value and the
   own-property *fact* already come from different places on the same receiver.
3. **Class instances have (at least) TWO surfaces.** #4098 measured a *declared
   field* as `hasOwn` ✓ / `read` ✓ / gOPD ✗ / keys ✗ / delete ✗; the matrix
   above measures an *expando* on the same receiver as ABSENT for everything.
   Declared fields and expandos are separate stores. Unification has to cover
   both or it will just add a third.
4. **Date / RegExp / Error have no substrate at all** — for them this is
   greenfield, not a merge of two tables.

## Proposed slicing (for landability — the merge_group is the only certifier)

- **S1 — one store + the read-side consumers.** Introduce the unified
  per-receiver own-property store and route `read`, `hasOwn`, `in`, gOPD and
  `keys` at it, starting with **array + function** (the two that already have
  substrates to merge: `vec-props.ts` #3537 and `vec-overlay.ts` #3251).
  Provably non-displacing: every cell it touches is currently ABSENT, so it can
  only convert. **Do not** include `delete`.
- **S2 — tombstones, making `delete` real.** This is where the array/function
  **STILL PRESENT** cells get fixed, and it is the slice #4098 is blocked on.
- **S3 — extend the store to the no-substrate receivers** (Date / RegExp /
  Error / class-instance expandos), then **#4098's gOPD/keys/delete arms** land
  on top as the "one coherent slice".

Ordering rationale: S1 is the only slice that is *provably* non-displacing, so
it is the right thing to put through the queue first and measure alone.

## Guardrails carried into the design (from the dispatch + adjacent issues)

- **#4086**: `startsWith("__")` is **not** a safe internal-name screen — object
  literals are `__anon_N` and carry USER data. Do not adopt it.
- **#4071**: Date/RegExp internals must **not** leak into `keys`; that was
  measured at **−5** and deliberately reverted. S3 must screen internals
  explicitly, not by name shape.
- **#4055 / #4017**: `__desc_has_own` composes with the bag — read #4017's final
  shape before changing the bag's contract.
- **#4099**: its direction is *excluding* non-enumerables; #4098's `keys` gap is
  *including* enumerables. Keep the two distinct in tests — they are adjacent,
  not the same, and one does not imply the other.

## Reproducing

`.tmp/matrix4010.mts` (the matrix, one module per cell) and
`.tmp/delete-control.mts` (the precondition-gated delete control). Run both —
the matrix alone is **not** trustworthy on the `delete` column.
