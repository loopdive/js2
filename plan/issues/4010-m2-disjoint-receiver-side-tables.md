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

## ⛔ THE ORDERING LAW OF THIS CODEBASE — read before proposing any slice here

> **Own-property VISIBILITY cannot ship before own-property DELETABILITY.**

This is not a design preference; it is a **receipt**. #4055 v1 widened
`__hasOwnProperty` / `__object_hasOwn` to see the carrier bag. Every flip held,
the PR was green, and the **`merge_group` parked it for breaching the standalone
host-free floor by −684**:

- **713 files lost host-free pass**;
- **682 of them (95.7 %) are `built-ins/**/{name,length}.js`**;
- **696 fail with "descriptor should be configurable"**;
- that ~700-file population was **disjoint from every stratum v1 sampled**.

**Mechanism** — identical to #4098's, at 700-file scale: `propertyHelper.js`
reaches `Object.prototype.hasOwnProperty` on every one of those files. Making a
property *visible* gives `verifyProperty` a longer runway, and it then dies at
the `configurable` wall, because `delete` does not work. **Visibility without
tombstones is negative value**, and the cost scales with how general the wiring
point is. #4055 v2's rescope — a separate `__desc_has_own` native that only
ToPropertyDescriptor calls, which consults `__hasOwnProperty` FIRST and the bag
only on `false` (additive, never a redirection) — is the composition pattern any
visibility work here must preserve.

**A first draft of this section proposed exactly the parked change** (S1 routing
`hasOwn`/`in`/gOPD/`keys` for array **+ function**; the function half is verbatim
#4055 v1). It was caught by reading `carrier-bag-hasown.ts`'s header, not by
measurement. Hence the law, stated up front.

## Slicing (corrected; the merge_group is the only certifier)

- **S1′ — the clobber fix ONLY.** `arr.q = 12;
  Object.defineProperty(arr,"q",{writable:false}); arr.q` returns **`undefined`**
  instead of `12`. Unify the two array tables so the descriptor op stops
  destroying the value the bag holds. This changes **a read value that is already
  visible**; **no own-property visibility surface moves**, so the −684 mechanism
  structurally cannot fire. Acceptance is the matrix cell + zero regressions —
  **a low flip count is an expected outcome, not a failure** (substrate value,
  #4084 precedent).
- **S2 — tombstones, making `delete` real.** Fixes the array/function
  **STILL PRESENT** cells; the slice #4098 is blocked on. **Acceptance is NOT
  pass-count**: tombstones alone also flip little, because currently-invisible
  properties fail *earlier* in `propertyHelper`. Deletability and visibility only
  pay out **together**. Accept on the delete-column cells going STILL-PRESENT →
  genuinely-absent, verified **both** by value read **and** by the store's own
  record (see the vacuity lesson above — one derivation is not enough).
- **S3 — visibility widening, LAST, riding on landed tombstones.** Then #4098's
  gOPD/keys/delete arms land on top as the "one coherent slice".
  **MANDATORY pre-merge control: run the entire `built-ins/**/{name,length}.js`
  stratum (~700 files) explicitly, before the PR goes near the queue.** That is
  the population every earlier sample was disjoint from; it does not get to be a
  surprise twice.

### Narrowest-site map for S3 (found while scoping S1′)

`fillVecHasOwnHelpers` (`vec-overlay.ts:619`) **already unshifts a prologue into
`__hasOwnProperty` and `__object_hasOwn`** which, for **every** vec receiver,
answers from `__vec_gopd` and **returns unconditionally**. That short-circuit is
why the matrix shows array `hasOwn` = ABSENT: it never reaches the #3537 bag.
That prologue is the precise site of the #3251-overlay-vs-#3537-bag split — and
`carrier-bag-hasown.ts` records that a vec arm there was written, measured
**unreachable**, and removed rather than shipped as decoration.

The `__extern_get` string-key prologue (`vec-overlay.ts:1779`) is the read-side
twin: for a **named (non-index) key** it treats the companion as authoritative
unconditionally (`FLAG_COMPANION_VALUE` OR key-is-not-an-index), returns the
companion entry's value field, and returns — so a descriptor-only
`defineProperty` entry, whose value field was never populated, shadows the bag's
real value with `undefined`. **That is the clobber, and it is S1′'s target.**

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

---

# S2 HANDOFF — read this first if you are picking up tombstones

S1′ landed as PR #4058. This section is everything that was only in the
authoring agent's head; the rest of this file is the measured record. **You do
not need to re-derive the matrix** — but do re-run it (both scripts) as your own
before/after instrument, and re-fetch the baseline (it goes stale within hours).

## Seam map — what S1′ built and where the two call sites are

`src/codegen/vec-bag-seed.ts` is the new leaf module and is **the one owner of
companion seeding for both key kinds**:

- `buildRealElementSeed(...)` — INDEX keys, sources the vec element. *Moved
  unchanged* from `vec-overlay.ts` (it was `seedIfRealElement`); behaviour is
  byte-identical.
- `buildBagValueSeed(ctx, ...)` — NAMED keys, sources the #3537 bag. The S1′ fix.

**There are TWO call sites of the index seed, with DIFFERENT local indices** —
this is the thing that will bite you:

| site | function | locals `{comp, compExt, key, vec, i, len}` | named-key seed too? |
| --- | --- | --- | --- |
| `vec-overlay.ts` ~1079 | `__vec_dp_value` | `{5, 6, 1, 0, 7, 8}` | **yes** (~1084) |
| `vec-overlay.ts` ~1227 | the accessor path | `{6, 7, 1, 0, 8, 9}` | **no — deliberate** |

**The accessor exclusion is deliberate, not an oversight**: §10.1.6.3 converting
a data property to an accessor does **not** preserve `[[Value]]`, so seeding
there would be wrong. The rationale is at the call site. If S2 adds a delete or
tombstone splice, decide the accessor case explicitly the same way — do not
pattern-match the data path.

A first pass missed the second site and typecheck caught it. **Grep for every
call site before editing either helper**, and note the locals differ.

## S2 design sketch — options considered, not yet measured

The requirement is fixed by measurement, not taste: **100 % of #4098's 124-file
population asserts `configurable: true`**, and `propertyHelper.js`'s
`isConfigurable` does a real `delete obj[name]` then requires `hasOwnProperty`
to become **false**. So `delete` must genuinely remove from the own-property
surface, not merely stop the read.

Representation options weighed (none implemented):

1. **Tombstone flag on the companion `$PropEntry`.** `FLAG_TOMBSTONE = 0x80` is
   **already defined** in `object-runtime.ts` and `FLAG_DELETED_INDEX = 0x40`
   already exists in `vec-overlay.ts` for *dense index* deletion — so the
   vocabulary and one precedent are there. Cheapest path, and it reuses the
   entry the seed now guarantees exists. **Risk**: the companion is only one of
   the tables; a tombstone there must also shadow the **bag**, or `__extern_get`
   will keep answering from the bag after a delete.
2. **Tombstone in the bag** (`vec-props.ts`). Symmetric problem in reverse.
3. **A single unified store** where both tables converge, with tombstones as
   first-class entries. Correct end state, largest slice — this is what the
   issue's title actually asks for. **S1′ deliberately did not force this
   choice**; it only made the two tables agree on *values*, which is why it was
   safe to land alone.

**Recommendation**: (1) plus an explicit bag-shadow step, measured against the
matrix. That keeps S2 landable, and it composes with S1′ — the seed already
guarantees a companion entry exists for exactly the keys that need shadowing.

**Where the delete arm must consult the store.** `delete o[k]` on a vec receiver
currently does *not* route through either table (matrix: array `delete` reports
"ok" only vacuously — see the delete-control warning above; the value survives).
Find the delete lowering's non-`$Object` arm; it is the twin of the
`__extern_get` named-key prologue at `vec-overlay.ts` ~1779, which is where the
read side resolves the same question.

## S2 acceptance — agreed with the tech lead, and it is NOT pass-count

> Accept on the **delete-column cells going STILL-PRESENT → genuinely-absent**,
> verified **both** by value read **and** by the store's own record.

Two derivations, deliberately — one is not enough here, because
`hasOwnProperty` being ABSENT on these receivers made "delete worked" **vacuously
true** in the first version of this file's own matrix. That is the #4065 family
and it already bit the instrument once.

**Do not accept S2 on pass-count.** Tombstones alone flip little, because
currently-invisible properties fail *earlier* in `propertyHelper`. Deletability
and visibility only pay out **together** — which is the whole reason they are
separate slices with separate acceptance.

## ⛔ S3 gate — non-negotiable

Before **any** visibility widening ships (`hasOwn` / `in` / gOPD / `keys` on
non-`$Object` receivers): **run the entire `built-ins/**/{name,length}.js`
stratum, ~700 files, explicitly, before the PR goes near the queue.** That is
the population #4055 v1's sampling was disjoint from, and it is what turned a
green PR into −684 in the `merge_group`. Preserve #4055 v2's composition pattern:
consult the existing helper **first**, the bag **only on `false`** — additive,
never a redirection.

## Loose ends worth knowing

- `#4098` is blocked on S2 and its 124-file population is the payout; its own
  file carries the instrument warning that **any probe here using a literal
  property name measures the static fast path**, not the dynamic one
  `verifyProperty` takes.
- `#4006` / `#4007` remain deliberately unfunded as symptoms of this substrate.
- The `delete` column of `.tmp/matrix4010.mts` is **known-misleading by
  construction**; `.tmp/delete-control.mts` is the precondition-gated version.
  S2 should promote the corrected control into a committed test rather than
  leave it in `.tmp/`.
