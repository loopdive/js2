---
id: 5354
title: "`instanceof` against a linked-provider class is always false — consumer-constructed instances lose prototype identity across the module boundary (32 of 123 Temporal calendar rows)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5354 — class-VALUE prototype identity does not cross the linked-module boundary

## Problem

Measured by dev-5251 (PR for #5251) from the consumer side of the #4628 linked
Temporal provider, with instances the CONSUMER constructs itself:

```js
const d = new Temporal.PlainDate(1997, 12, 1);
d instanceof Temporal.PlainDate                         // false  (node: true)
Object.getPrototypeOf(d) === Temporal.PlainDate.prototype // false
d.constructor                                            // undefined
```

test262's `TemporalHelpers.assertPlainDate` (and every `assert*` sibling)
opens with an `instanceof`, so **32 of the 123 #5249 calendar rows** stop at
exactly this line after #5249/#5352/#5250/#5251 cleared the layers beneath.
It is the largest remaining Temporal blocker that is ours (the other, #5355,
is an Intl capability gap).

Adjacent, none of them this: #5237 (cross-module member resolution), #5239
(`Object.create(C.prototype)`), #5242 (ctor bridge for classes reached as
values). Those made construction and method calls work across the seam; the
OBJECT identity graph — `[[Prototype]]`, `constructor`, and what `instanceof`
consults — still does not.

## Implementation Plan (Fable, 2026-09-06)

1. **Measure which identity is missing.** Three probes, consumer side, both
   lanes (linked provider vs single-module control): (a) `getPrototypeOf(d)`
   — is it the provider's `PlainDate.prototype` object, a mirror, or `null`;
   (b) `Temporal.PlainDate.prototype` — is it the provider's object or a
   fresh host mirror each read (identity stability across two reads);
   (c) `Temporal.PlainDate[Symbol.hasInstance]` — present? The single-module
   control answers `true` for all, so the diff localises the seam.
2. **Locate the host-mirror minting** for a provider class reached as a value
   (`src/runtime.ts`: `_makeClassCtorMirrorForHost` and the #5242 ctor bridge;
   the #5239 `Object.create` path; the #5237 member-resolution cache). The
   likely root: the ctor mirror is a fresh host `Function` whose `.prototype`
   is a mirror OBJECT unrelated to the struct-side prototype registry, so an
   instance minted by the compiled `_new` never links to it, and
   `instanceof` (OrdinaryHasInstance walks `[[Prototype]]`) finds nothing.
3. **Fix at identity, not at `instanceof`**: the mirror's `.prototype` must be
   the SAME host object that `getPrototypeOf(instance)` answers, cached per
   class object (module-keyed — #5225's minting-module rule applies: the
   prototype belongs to the module that owns the struct). Then `instanceof`,
   `getPrototypeOf`, and `constructor` all follow from one fix. Do not
   special-case `Symbol.hasInstance` unless step 1 shows identity is already
   right and only `hasInstance` is missing.
4. **Reduction + test** in both lanes; base-failing on the linked lane, green
   on the single-module control (which pins that this is seam-only).
5. **Measure** `family-123.txt` (provider linked, fresh cache per compiler
   revision): expect the 32 `assertPlainDate` rows to move; state the next
   layer. Suites: #5237/#5239/#5242 families + the 9 provider suites +
   equivalence at 24/1718.

## Acceptance criteria

1. Step 1 evidence in the PR (which identity was missing, both lanes).
2. `instanceof`, `getPrototypeOf`, `constructor` correct for consumer-
   constructed instances of a linked class; base-failing test.
3. 123-row re-measurement with counts and next-layer reasons.

## Notes

- Filed from dev-5251's residual census (PR for #5251, 2026-09-06).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
