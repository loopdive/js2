---
id: 4047
title: "standalone Object.defineProperties: the #1906 refusal is a RECEIVER-representation gate, not a descriptor-shape one — resolve what is resolvable"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: m
complexity: M
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: property-descriptors, object-defineproperties, object-create
es_edition: es5
goal: standalone-gap
related: [1906, 3246, 3251, 3468, 3537, 3957, 3991, 4010, 4032, 4071]
assignee: ttraenkler/H-descriptor
origin: "2026-08-02 harvest — the 61 official / 50 goal-scope `unsupported descriptor shape in standalone mode (#1906)` records."
# (#3102 / #3400 ratchet) Both edits are in-place changes to the single existing
# builder for this operation. The bulk of the added lines are the rationale for
# WHICH shapes may be resolved and which must keep refusing — separating that
# comment from the instruction sequence it guards is precisely the regression
# #3957 measured and rejected.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
---

# #4047 — the `#1906` refusal is a receiver-representation gate

## The finding that reframes this

The #1906 issue file reads `status: done`, yet its refusal string —
`Object.defineProperties unsupported descriptor shape in standalone mode (#1906)`
— was still the single largest in-scope failure signature.

**It is not a regression.** #1906 shipped the native plural path for a
`$Object`-to-`$Object` apply and deliberately installed a fail-loud refusal for
everything else; the issue's own 2026-07-13 harvest note already recorded the
residual (79 records then, 61 now). The `done` status is accurate for what
#1906 claimed.

**What WAS wrong is the attribution.** That harvest note blamed "a residual
descriptor-shape family (accessor descriptors / mixed data+accessor /
non-object entries)". Measured against the actual failures, that is false:

> **Zero** of the 61 records reach either per-descriptor refusal site.
> **100%** are refusals of the RECEIVER's wasm representation — `Properties`
> (or `O`) is not the open-object `$Object` struct.

The message names a descriptor problem and the defect is a representation
problem, which is why the family survived four consecutive fixes aimed at
descriptor handling (#3983, #3984, #3991, #4032).

## Measurement

Corpus `b363f29d`. Standalone baseline force-refetched, row timestamp
2026-08-02 03:32 — official **43,505 run / 25,995 pass (59.75%)**, goal scope
(`es5id:` present, or none of `es5id`/`es6id`/`esid`) **8,545 run / 6,298 pass
(73.70%)**, **0** corpus files unopenable.

Method: tag all five `throwUnsupported()` sites in `__defineProperties` with a
distinct suffix, then run the **CI path** (`assembleOriginalHarness` →
`CompilerPool(n,"unified")` → `scripts/test262-worker.mjs`) over **all 952**
files under `built-ins/Object/{defineProperties,create}`.

Instrument validated twice, because a signature is not a mechanism:

- **951 / 952** file-level agreement with the committed standalone baseline.
  The one disagreement is `BASE-FAIL / LOCAL-PASS` on `15.2.3.7-5-b-236.js`,
  i.e. a landed fix not yet promoted — not an instrument error.
- **0 flips** on a file-level diff of the tagged run against the untagged run,
  so the tagging itself is inert. (The raw vitest *test* counts differ, 348 vs
  359, because of strict-rerun duplicates; the file-level diff is the one that
  answers the question.)

| refusal site | files | goal scope | what `Properties` / `O` actually is |
| --- | --- | --- | --- |
| `PROPS-NOT-OBJ/OBJ` | 27 | 26 | object, no bag carrier — Date / RegExp / Error / ctor-instance / closed struct |
| `PROPS-NOT-OBJ/VEC` | 9 | 9 | Array or `arguments` |
| `O-NOT-OBJ` | 8 | 8 | Array receiver |
| `PROPS-NOT-OBJ/FUNC` | 5 | 5 | Function |
| `PROPS-NOT-OBJ/PRIM` | 4 | 2 | primitive / `undefined` |
| **total** | **53** | **50** | matches the harvest's 50 exactly |
| `DESC-NULL`, `DESC-NOT-OBJ` | **0** | **0** | the family the old note blamed |

The remaining 8 official records outside this scope are the
`TypedArrayConstructors/internals/Delete` family.

## Why the old gate could not simply be widened — and what changed

#3957's comment on that gate was **correct and still is**: the own-enumerable-key
walk needs a real key source, and `__object_keys` returns an *empty* `$ObjVec`
for every non-`$Object` receiver, so a blanket widening trades a loud refusal
for a silent no-op. Re-measured 2026-08-02 in standalone, both halves still hold:

```
Object.keys([10,20,30]).length          === 0
Object.keys(fnWithOwnProp).length       === 0
```

…while the corresponding **writes round-trip** (`r.p = 7; r.p === 7`) for both
Arrays and functions. Enumeration is the dead half. That is a strictly larger
lever than this issue and was handed over rather than folded in — it is now
**#4071**.

What this issue changes is that the widening is no longer blanket. Each receiver
shape is resolved to a key source that is **complete**, or it keeps refusing.
No arm answers "define nothing" unless "nothing" is what the spec says.

## The change

### 1. `O` — the gate had no downstream dependency at all

`__defineProperties` cast `O` to `$Object` into `L_OBJ` and then **never read
it** (`void L_OBJ;` at the end of the block). Pass 2 hands the raw
`local.get 0` externref to `__defineProperty_value` /
`__defineProperty_accessor`, which carry their own receiver dispatch
(`vecOverlayArm` → the #3251 per-index/expando companion). The `ref.test
$Object` on `O` decided nothing except whether to refuse.

Replaced with the spec question plus an honesty check:

- `Type(O)` is not Object → **TypeError** (§20.1.2.3.1 step 1);
- `$Object` or a vec carrier → proceed, the appliers store;
- object with no carrier (Date / RegExp / Error) → **keep the loud refusal**.

The third arm is load-bearing. `__defineProperty_value`'s terminal arm for a
carrier-less receiver is a *lenient no-op* that returns `O` unchanged (matching
the host import). Letting such a receiver through would convert a loud refusal
into a silent wrong answer — the exact vacuity the refusal exists to prevent.

### 2. `Properties` — resolve per shape, using the bags that already exist

- **native string**: `ToObject("")` is a String exotic with no own enumerable
  keys, so the empty string is a complete, spec-correct **no-op**. A non-empty
  string has own enumerable index keys whose values are single-character
  strings, and `ToPropertyDescriptor` on a primitive is a TypeError — that case
  **keeps refusing** (`[SITE-PROPS-STRING-INDICES]`).
- **`undefined`**: `ToObject(undefined)` is a TypeError (§7.1.18). Under the
  #2106 singleton regime `undefined` is a *struct*, so the `ref.is_null` guard
  never caught it and it would otherwise fall into the primitive no-op below.
  Explicit tag test, same one the accessor reader uses.
- **any other primitive** (boolean / number / symbol / bigint): `ToObject`
  yields a **fresh** wrapper with zero own enumerable properties, so the key
  walk is empty and the operation is a no-op returning `O`. This is a complete
  answer, not a degraded one.
- **object without the open representation** (Array / arguments / Function /
  Date / RegExp / Error / closed struct): **keeps refusing**
  (`[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`). See the next section — this arm was
  built, measured, and deliberately reverted.

## The arm I built, measured at +6, and REVERTED

The obvious move for the Function and Array buckets is to resolve the
receiver's own-property **bag** — `__vec_bag_*` (#3537) or `__closure_bag_*`
(#3468), both of which *are* `$Object`s — through the same `__integrity_bag`
resolver #4032 introduced, and enumerate that. It was implemented, and it
worked: 6 more test262 files flipped, including
`15.2.3.7-5-b-239`/`-240` where a descriptor **setter must actually fire**, so
those were not vacuous passes.

**It is still unsound, and `tests/issue-3957.test.ts` caught it.** The bag is
not the complete own-property store for a carrier:

```
props.p = v                        → lands in the expando bag              ✓
Object.defineProperty(props,"p",…) → Array:    the SEPARATE #3251 overlay companion
                                     Function: NOWHERE — __defineProperty_value's
                                               terminal arm is a lenient no-op
                                               for a closure receiver
```

Nothing distinguishes those at runtime. So for the second spelling the arm
enumerated an empty bag, defined nothing, and **returned normally** — the exact
silent no-op #3957 wrote its Function/Array invariant cases to forbid. Both
fired.

Reverted. **+6 that manufactures a silent wrong answer on a common spelling is
negative value**, and the shape it breaks (`Object.defineProperty` on the
Properties map) is the *more* idiomatic of the two.

This is direct, reproducible evidence for **#4010**: the arm becomes sound the
moment one store is authoritative for a carrier's own properties. A narrower
prerequisite that would unlock the Function half alone: give
`__defineProperty_value` / `__defineProperty_accessor` a closure arm that
recurses on `__closure_bag_ensure(recv)`, mirroring the existing
`vecOverlayArm`. That also fixes a pre-existing silent no-op —
`Object.defineProperty(fn, "p", desc)` currently drops the write entirely.

Because the arm is gone, the `__integrity_bag` registration stays where #4032
put it; nothing about function emission order moves.

### 3. `Object.create(O, undefined)` — §20.1.2.2 step 3 is conditional

"If properties is **not undefined**, return ? ObjectDefineProperties(obj,
properties)". The generic arm handed `undefined` straight to
`__defineProperties`, whose own step-1 `ToObject(undefined)` correctly throws.
Two different spec steps, one of which does not apply. The static spelling
(`undefined` / `void 0`) is now folded away, with the argument still compiled
for its side effects.

**Residual, stated plainly:** a *runtime-valued* `properties` that happens to be
`undefined` still reaches the helper and throws. Folding that needs an
is-undefined test at the externref boundary and is left to #4010.

## Refusals that deliberately survive

`[SITE-O-NO-CARRIER]`, `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`,
`[SITE-PROPS-STRING-INDICES]`. Each is tagged so the next harvest reads the
*mechanism* rather than the family — the failure mode that let the previous
attribution stand unchallenged for three weeks. The 41-file
`BAG-NOT-AUTHORITATIVE` bucket is blocked on the exotic-receiver own-property
substrate (#4010) and is not fixable here.

## Result

Scoped CI-path run over the same 952 files, read from the JSONL (the artifact
CI actually diffs — the vitest `it()`-level tallies drift under machine load
and are not the number):

```
before          604 pass / 347 fail / 1 CE
with the arm    617 pass / 334 fail / 1 CE     +13   ← REVERTED, unsound
shipped         611 pass / 340 fail / 1 CE     +7    0 regressions
```

The `+13` line is recorded on purpose: it is what the carrier-bag arm scored
before #3957's invariant guard proved it unsound. **6 of those 13 were bought
with a silent wrong answer** on the `Object.defineProperty`-written spelling.
The shipped number is 7.

The `+13` run was executed **twice**, at 1-min load 8 and 13, with **0 flips
between the two runs** file for file — so the instrument is stable and the
difference between 13 and 7 is the code, not contention.

Attribution proved by **kill-switch removal**, not correlation.

**Flips (7), by arm:**

| arm | files |
| --- | --- |
| `O` is an Array | `15.2.3.7-6-a-243`, `-246`, `-255`, `-258` |
| primitive `Properties` (ToObject) | `15.2.3.7-2-3`, `create/properties-arg-to-object`, `…-bigint` |

5 are goal-scope; 2 (`properties-arg-to-object*`) are not.

**Reachable ≠ flipped, and three of the misses are progress, not failure.**
Removing a refusal exposes whatever it was masking:

- `create/15.2.3.5-4-2.js` — the `Object.create(O, undefined)` fix works; the
  file now fails on `newObj instanceof Object`, an unrelated downstream defect
  the refusal had been hiding.
- `15.2.3.7-6-a-147` — passes the `O` gate now, then fails on `arr.length`
  (array-length descriptor, #3984/#4006 territory).
- `15.2.3.7-2-5` / `-2-7` — the receiver `var obj = {"123": 100}` is a closed
  struct with no carrier, so it hits the new `[SITE-O-NO-CARRIER]` refusal.
  Correctly refused, not vacuously passed.

**Blast radius outside the measured set.** Only three behaviours change:
non-`$Object` `O` (refuse → refuse-or-proceed), primitive `Properties`
(throw → spec no-op), and static `Object.create(x, undefined)`. A test could
only regress by asserting one of the *old* non-conformant outcomes. The scoped
952-file run shows 0 such regressions; the wider corpus population is floored
below, and the merge-queue standalone floor is the backstop.

**Trigger population** (files that can move for this reason at all): 683 corpus
files mention `defineProperties`, 338 spell `Object.create(x, y)`, union
**1,018**. **Zero harness files** carry either shape, so the trigger set is a
real subset rather than "everything". Files without the shape cannot move
through the edited paths. The one caveat: hoisting the `__integrity_bag`
registration changes the *emission order* of one defined function, so byte
identity does not hold module-wide even for non-trigger files; behaviour is
`funcMap`-resolved and the #4032 consumer is pinned by test G4.

## Validation

`tests/issue-4047.test.ts` — 23 cases, all zero-import, each pinned to an exact
expected outcome rather than "does not throw":

- 2 controls (a `$Object` map must define; a primitive descriptor entry must
  still throw) — these fail if the harness itself stops discriminating;
- 9 cases for the shapes that now resolve;
- 6 **negative** cases pinning the refusals that must SURVIVE — non-empty
  string, non-empty array, Date as `Properties`, Date as `O`, primitive `O`,
  `undefined` / `null` `Properties`. Without these, a later "simplification"
  that drops a refusal reads as a pure win while manufacturing vacuous passes;
- 4 regression guards for the gains this touches: #3957 RC1 (accessor-defined
  descriptor entry), #3957 RC2 (closed-struct map via identifier), the static
  object-literal expansion, and #4032 `Object.freeze`/`isFrozen` on an Array
  (which shares the resolver whose registration moved).
