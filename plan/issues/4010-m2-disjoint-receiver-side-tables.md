---
id: 4010
title: "M2 — own properties on a non-$Object receiver live in TWO DISJOINT side tables that clobber each other; unify them"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-03
assignee: ttraenkler/senior-4010-s3
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

---

# S2 — DONE. What landed, what it cost, and what S3 inherits

Slice table:

| slice | status | PR | what it changed |
| --- | --- | --- | --- |
| **S1′** clobber fix | done | #4058 | `defineProperty` stopped destroying the bag's value |
| **S2** tombstones | **done** | this PR | `delete` is real on array + function own-property stores |
| **S3** visibility | not started | — | `hasOwn`/`in`/gOPD/`keys` widening; **gated**, see below |

## The mechanism, and the half the sketch did not predict

The sketch's option (1) — "tombstone flag on the companion `$PropEntry`" — was
**not** what the defect needed, and building it that way would have fixed
nothing. The measured root cause is one level up:

> `__delete_property`'s non-`$Object` arm **returned 1 (success) without
> deleting anything.** `delete a.q` on an array reported `true` while `a.q`
> stayed `12`. A loud claim of success covering a silent wrong answer.

The values live in a per-receiver `$Object` **bag** (`vec-props.ts` #3537 for
arrays, `closure-props.ts` #3468 for functions). Because a bag **is** an
ordinary `$Object`, all of OrdinaryDelete already exists for it —
`FLAG_TOMBSTONE`, the §10.1.10 configurability preflight, the count/tombstone
bookkeeping. **No delete semantics were re-implemented.** The new native
(`src/codegen/carrier-bag-delete.ts`) only finds the right bag and delegates,
which is why a non-configurable entry still refuses correctly and why the
refusal is byte-identical to the `$Object` control.

**The half the sketch flagged as a "risk" turned out to be half the defect, and
it needed its own fix.** The sketch said a companion-only tombstone *might*
leave `__extern_get` answering from the bag. It does, always:

```js
a.q = 12;
Object.defineProperty(a, "q", { writable: true });   // now in BOTH tables
delete a.q;                                          // companion tombstoned
a.q                                                  // => 12   (measured)
```

`__obj_find` **skips** tombstoned entries, so tombstoning the companion simply
restores the fall-through to the bag. So the vec arm now **shadows the bag**
after a successful companion delete. Confirmed by measurement, not by reading
the sketch.

## Why the result is tri-state, and why that is the whole safety argument

`__carrier_bag_delete` returns **-1 not handled / 0 refused / 1 deleted**.
Collapsing `-1` into `1` reproduces the original defect exactly — "I could not
see anything" becoming indistinguishable from "there was nothing". Keeping them
apart is also what makes the change **strictly additive**: the arm fires only
for a key the bag *demonstrably holds*, so every receiver/key the old code
answered for keeps its answer bit-for-bit.

In particular the **#2896 builtin-fn arm still runs FIRST and returns**, so
`delete fn.name` / `delete fn.length` never reach the new code. That is
deliberate and load-bearing: `built-ins/**/{name,length}.js` is the ~700-file
population that cost #4055 v1 **-684** host-free passes, and S2 does not touch
it. A committed regression guard pins it.

## Acceptance — the delete column, on TWO derivations each

Every cell is precondition-gated (a failed precondition returns a distinct code
so the case fails loudly instead of measuring nothing), and every compiled
module is asserted to have **zero imports**.

| cell | derivation | before | after |
| --- | --- | --- | --- |
| array named expando | value read | **STILL PRESENT** | genuinely absent |
| array named expando | **bag's own record** — an attribute-only redefine re-seeds from the bag via S1′, never touching the read lane | bag still held `12` | bag empty |
| array, key in BOTH tables | value read | **STILL PRESENT** | genuinely absent |
| array, companion-only key | value read + gOPD | already correct | unchanged |
| function expando | value read | **STILL PRESENT** | genuinely absent |
| function expando | **closure bag's own record** — `__desc_has_own` via #4055's function-as-descriptor path, a different consumer entirely | bag still held `42` | bag empty |
| `$Object` **CONTROL** | value read · hasOwn · non-configurable refusal | 3/3 correct | 3/3 correct |

The delete's own return value is the reason one derivation was never enough:
before S2 it already answered **`true`** on both arms while the value survived.

Promoted into `tests/issue-4010.test.ts` (26 cases, incl. 3 SCOPE PINs and 2
regression guards). `.tmp/matrix4010.mts`'s known-misleading delete column is
superseded by it.

## Byte-neutrality and blast radius

- **gc/host mode: byte-identical** — same sha256 on a mixed probe module
  exercising array/function/object deletes and for-in. Only standalone and wasi
  binaries change (+166 / +133 bytes).
- **No visibility surface moved.** `hasOwnProperty` / `__object_hasOwn` /
  `__vec_gopd` / `Object.keys` reach is unchanged on both receivers, pinned by
  the SCOPE PIN cases. S1′'s two pins are untouched; S2 adds three more.
- `src/codegen/vec-overlay.ts` **shrank** (its `__delete_property` arm moved to
  `vec-bag-seed.ts`, which now owns both directions of the seam); `object-runtime.ts`
  shrank by 19 lines. No `loc-budget-allow` grant was needed or taken.

## Found while measuring — NOT fixed here, and not caused here

**`Reflect.deleteProperty` throws for every non-`$Object` receiver**, including
plain success cases (`Reflect.deleteProperty(arr, "q")` on an ordinary expando).
Verified **identical on base and after** — pre-existing, independent of S2. The
`delete` operator is unaffected; only the `Reflect` spelling is. Worth a
separate issue; deliberately out of S2's scope because fixing it would move a
surface this slice promised not to move.

## What S3 inherits

1. **Deletability is now real, so visibility widening can pay out.** The -684
   mechanism was `propertyHelper.js` getting a longer runway and then dying at
   the `configurable` wall because `delete` did not work. That wall is gone for
   array/function *named* keys.
2. **The composition pattern to preserve** is still #4055 v2's: consult the
   existing helper **first**, the bag **only on `false`** — additive, never a
   redirection. `carrier-bag-delete.ts` follows it and is the shape to copy;
   `__carrier_bag_delete`'s tri-state is the same idea for a non-boolean answer.
3. **The gate is unchanged and non-negotiable**: run the entire
   `built-ins/**/{name,length}.js` stratum (~700 files) explicitly, before the
   PR goes near the queue.
4. **Restore-after-delete is the new thing to check.** `verifyProperty` deletes
   a property and then restores it with `Object.defineProperty`. On an **array**
   that round-trips (the companion takes the redefine). On a **function** it does
   **not**: `Object.defineProperty(fn, "p", …)` still lands nowhere (#4055's
   finding), so a harness-driven delete of a function expando is now
   irreversible where it used to be a silent no-op. S2's scoped sweep found no
   file that hits this, but S3 widens exactly the visibility that gives
   `propertyHelper` the runway to reach it — measure it explicitly.
5. Class instances / Date / RegExp / Error remain **out of scope**: they have no
   bag, so `__carrier_bag_delete` answers `-1` for them and nothing changed.
   Their expando substrate is still greenfield (matrix rows 4-7).

# S2 RESULT — landed (PR #4063, merged 73ee7169b, 2026-08-03)

Root cause was NOT the sketch's companion-tombstone: `__obj_find` skips
tombstoned entries, so tombstoning alone restores the fall-through to the bag
(measured — the value survived). The real defect was one level up:
**`__delete_property`'s non-`$Object` arm returned 1 (success) without deleting
anything.** Fix: `src/codegen/carrier-bag-delete.ts` finds the receiver's bag
and delegates to the existing `$Object` OrdinaryDelete; the vec arm also
SHADOWS the bag (do not "simplify" that away). Tri-state result (`-1` not
handled / `0` refused / `1` deleted) — collapsing `-1` into `1` IS the original
defect.

**Certifying numbers (merge_group on the merged state, 43,487 files):
improvements=13, wasm-change regressions=0, net +13.** The
`built-ins/**/{name,length}.js` −684 stratum untouched (the #2896 builtin-fn
arm runs first). Full evidence table: PR #4063's comment thread.

S3 inherits (see task): visibility widening now legal; the ~700-file stratum
control mandatory pre-merge; NEW hazard — `verifyProperty` deletes-then-
restores and a define on a FUNCTION still lands nowhere, so a harness delete of
a function expando is irreversible where it was a no-op; S3 widens exactly the
runway that reaches it. S2's partial local stratum data was measured against a
superseded tree — not reusable; run the control fresh, both arms.

---

# S3 — DONE. The −684 mechanism, finally isolated — and it was never the query

Slice table (final):

| slice | status | PR | what it changed |
| --- | --- | --- | --- |
| **S1′** clobber fix | done | #4058 | `defineProperty` stopped destroying the bag's value |
| **S2** tombstones | done | #4063 (73eee7169b) | `delete` is real on array + function own-property stores |
| **S3** visibility | **done** | this PR | `hasOwn` / `in` / gOPD / `keys` / for-in / gOPN / `propertyIsEnumerable` reach the store |

## ⛔ THE HEADLINE: the −684 was NOT caused by widening the query

`carrier-bag-hasown.ts` records that #4055 measured three candidate mechanisms
for the −684 and **none reproduced outside the full harness assembly**, and drew
the (correct-for-then) conclusion "narrow the change until the mechanism is out
of scope". S3 had to widen the same surface, so the mechanism had to be found.
It reproduces in **six lines**, standalone, host-free, on the pre-S3 tree:

```js
const f = Array.prototype.push;
f.name = "unlikelyValue";   // REFUSED by the read path (#2896 meta arm wins)
f.name;                     // => "push"           — looks correct
delete f.name;              // #2896 arm clears the meta bit
f.name;                     // => "unlikelyValue"  ← THE BAG KEPT IT
```

**`__extern_set` had no builtin-fn arm.** A write to a builtin's non-writable
`name` / `length` was deposited in the #3468 closure bag and sat there
invisibly, shadowed by the #2896 read arm. `propertyHelper.js` performs exactly
that write, in exactly the wrong order:

| line | what it does |
| --- | --- |
| `isWritable`, called from `verifyProperty:113` | `obj[name] = "unlikelyValue"` → **pollutes the bag** |
| `isConfigurable`, called from `verifyProperty:120` | `delete obj[name]; return !__hasOwnProperty(obj, name)` |

So a bag-aware `hasOwnProperty` answers **`true`** after the delete,
`isConfigurable` returns **`false`**, and every file asserting
`configurable: true` fails with *"descriptor should be configurable"* — the 696.
The pollution was **already on main**; #4055 v1 only made it observable. Any
future widening of any own-property query would have hit it again.

**Fixed at the SOURCE, not at the query.** §10.1.9 OrdinarySet over an existing
non-writable own data property is a no-op, so `__extern_set`'s non-`$Object` arm
now refuses a key the #2896 metadata still owns (`buildBuiltinFnSetRefusalArm`,
sited in `vec-props.ts`, prose in `carrier-bag-visibility.ts`). The refusal is
scoped to **live** metadata: after `delete fn.name` an assignment lands again,
which is also what the spec says. Three committed cases pin all three states.

## What shipped

`src/codegen/carrier-bag-visibility.ts` — four natives over both bags
(`__closure_bag_lookup` / `__vec_bag_lookup`, **LOOKUP never ensure**):

| native | answer | "not handled" is |
| --- | --- | --- |
| `__carrier_bag_of(o)` | the bag, `ref.test $Object`-screened | null |
| `__carrier_bag_has(o,k)` | `__obj_find(bag,k) != null` | 0 |
| `__carrier_bag_gopd(o,k)` | `__getOwnPropertyDescriptor(bag,k)` | **null, kept distinct from "absent"** |
| `__carrier_bag_push_keys(o,vec,nonEnum)` | `__obj_ordered{,_all}(bag)` keys | 0 |

Wired at seven sites, every one of them a place whose previous answer was the
literal "absent" constant — `__hasOwnProperty` / `__object_hasOwn`,
`__extern_has` (both the base body and the vec arm), `__getOwnPropertyDescriptor`
(function receiver) and `__vec_gopd`'s miss (array — which also widens
`hasOwnProperty` and `propertyIsEnumerable`, since `fillVecHasOwnHelpers`
derives both from that descriptor), `__object_keys` / `__object_keys_forin`
(base + vec arm) and `__getOwnPropertyNames`.

**Composition is #4055 v2's throughout**: the existing helper answers FIRST and
the bag is consulted only on a miss, so this can add a `true` and never override
one. The #2896 arms still run first and return, so `{name,length}` on a builtin
never reaches the bag. Tombstones are free — `__obj_find` / `__obj_ordered` /
`__obj_ordered_all` all skip them.

## The one place the two slices could have silently disagreed

Making `__vec_gopd` bag-aware lets a **bag-only** key reach S2's
companion-delete arm, where `__delete_property(comp, k)` answers **1 (absent ⇒
success)** while `bagShadow`'s own refusal is discarded — a loud success over a
possibly-surviving value, i.e. precisely the defect S2 existed to remove.
`vec-bag-seed.ts` now routes a key the companion does not own back to the
tri-state bag delete. Found by reasoning about S2's arm before running it, and
pinned by S2's own "key held by BOTH tables" case, which still passes.

## Acceptance — the matrix's two rows, and the screens

24-cell probe (`.tmp/s3matrix.mts`), standalone, **zero imports asserted per
module**, run on the final tree: **24/24**. Matrix cells flipped:

| receiver | read | hasOwn | `in` | gOPD | keys | delete | defineProp→read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **`$Object` (CONTROL)** | ok | ok | ok | ok | ok | ok | ok |
| array | ok | ABSENT→**ok** | ABSENT→**ok** | ABSENT→**ok** | ABSENT→**ok** | ok (S2) | ABSENT→**ok** |
| function | ok | ABSENT→**ok** | ABSENT→**ok** | ABSENT→**ok** | ABSENT→**ok** | ok (S2) | ok |
| Date / RegExp / Error / class instance | unchanged — **no bag exists**, `__carrier_bag_of` answers null |

Screens that did NOT move, each with a committed guard: `Object.keys(new
Date(0))` and `Object.keys(/ab/)` stay `[]` (#4071's −5); builtin `name`/`length`
reflection byte-unchanged; `Object.defineProperty` on a function still lands
nowhere **and gOPD still reports it absent** (no new lie); #4055's
function-as-descriptor path unchanged.

`tests/issue-4010.test.ts`: **47 cases**. S1′/S2's **five SCOPE PINs are flipped
deliberately** — that is what they existed to force — and kept, not deleted, so
the before/after of the ordering law reads in one place.

## No `loc-budget-allow` was taken

The first cut grew three god-files (`object-runtime.ts` +45, `vec-overlay.ts`
+25, `object-runtime-descriptors.ts` +20) and the gate refused it. Restructured
instead of granted: `fillVecHasOwnHelpers` **moved** out of `vec-overlay.ts` into
`vec-bag-seed.ts` (which already owns both directions of the overlay↔bag seam),
the builtin-fn refusal is sited in `vec-props.ts`, and every god-file call site
is one line calling a composite builder, with the prose in the subsystem module.
Final: `object-runtime.ts` −3, `vec-overlay.ts` −58,
`object-runtime-descriptors.ts` −1 against baseline.

## ⛔ THE MANDATORY STRATUM CONTROL — `built-ins/**/{name,length}.js`

Run explicitly, before the PR went near the queue, per this issue's own
non-negotiable S3 gate.

**Population — complete, not sampled.** The glob is **1,240** files; **729** of
them pass in the published CI standalone baseline. A file that already fails
cannot regress, so the 729 are the **complete at-risk set** — the ~700-file
population that cost #4055 v1 −684.

| | files |
| --- | ---: |
| `built-ins/**/{name,length}.js` (whole glob) | 1,240 |
| …passing in the CI standalone baseline ⇒ **at risk** | **729** |
| rows measured in the post arm (floor check) | **729 / 729** |
| pass | 724 |
| compile **timeout** (60–74 s vs a 60 s limit) | 5 |
| **regressions** | **0** |

All five timeouts were re-run **SOLO**: **5/5 pass in 9–17 s**, against 60–74 s
under three-shard contention at load 13–16. They are load artifacts of the
instrument, not semantic failures — none carries an assertion signature, let
alone *"descriptor should be configurable"*. **Net: 729/729, zero regressions in
the −684 population.**

**Be precise about the arms.** The base arm here is the **published CI
standalone baseline** (generated 13:19Z the same day, from the commit this
branch forked from), not a fresh local base sweep of all 729 — a local base arm
would have cost another ~3 h of wall clock for files that provably did not move.
What makes that sound: the post arm moved **nowhere**, so there was nothing to
attribute; every post-arm non-pass got a fresh, same-instrument solo re-run; and
the local instrument was calibrated against that same baseline at **16/16**
pass/not-pass agreement before use. Where a genuine flip DID exist — the four
gains below — a full two-arm, same-instrument comparison was run.

## Payout — measured, with the funnel and its denominators

| stage | files |
| --- | ---: |
| standalone baseline rows | 48,619 |
| `status = fail` | 14,859 |
| …own-property / descriptor error signature | 1,111 |
| …unreadable source (floored) | **0** |
| …static array/function-expando + reflection shape | **11** |

Ran **121** files: the **complete** 11-file shape-candidate set ∪ a deterministic
stride sample of 112 from the 1,111 bucket.

**4 gains, 0 regressions.**

| file | |
| --- | --- |
| `built-ins/Object/freeze/15.2.3.9-2-a-7.js` | shape candidate |
| `built-ins/Object/freeze/15.2.3.9-2-a-9.js` | shape candidate |
| `built-ins/Object/seal/object-seal-p-is-own-property-of-a-function-object-that-uses-object-s-get-own-property.js` | shape candidate |
| `built-ins/Object/seal/object-seal-p-is-own-property-of-an-arguments-object-which-implements-its-own-get-own-property.js` | shape candidate |

**Attribution by kill-switch REMOVAL**, not by narrative: all four re-run with
the eight changed codegen files restored to their `609c995ce` contents (file
copies — `git stash` is a single shared stack across every worktree of this repo
and is never safe here) → **0/4 pass**. With S3 → **4/4**.

**The informative number is the 0/110.** The random-stride sample of the broad
own-property/descriptor bucket moved **not at all**, while the statically
derived at-risk set moved **4/11**. That is the matrix speaking: the bucket is
dominated by receivers that have **no bag** — class instances, Date, RegExp,
Error — which is precisely #4098's population and precisely what S3 does not
claim to fix. A low flip count here is the expected outcome for substrate work
(#4084 precedent, and this issue's own S1′ note), not a shortfall.

## Instrument note — `runTest262File` cannot run this corpus unaided

`runTest262File` does **not** supply the separately compiled
`js2wasm:runtime-eval` provider that the CI worker links
(`scripts/test262-worker.mjs` → `instantiateRuntimeEvalNamespace`). Any
standalone module carrying those two imports therefore dies at
`WebAssembly.instantiate`. **Measured: `propertyHelper.js` in the assembly is the
trigger** (prefix alone = 0 imports; prefix + propertyHelper = 2), so a pilot of
the `{name,length}.js` stratum scored **0 / 11 runnable** — the instrument was
blind, not the compiler broken. Neutralising `$262.evalScript`'s `eval` in a
local copy of `scripts/test262-fyi-runtime.js` (a function no `{name,length}.js`
test calls) restores it, and the repaired instrument agrees with the published
CI standalone baseline **16/16** pass/not-pass. Anyone measuring standalone
locally needs this; it is not a defect on main.

## What this closes

#4010 is **done**: all three slices landed, and own-property truth for array and
function receivers now has ONE owner — the bag — that every reflective surface
reads. **#4098 is unblocked** for its own substrate work; note that its 124-file
population is **class instances**, which have no bag at all (matrix row 7), so it
still needs the per-instance store its file specifies. #4006 / #4007 remain
deliberately unfunded symptoms. #4129 (`Reflect.deleteProperty` throws for every
non-`$Object` receiver, pre-existing) is untouched.
