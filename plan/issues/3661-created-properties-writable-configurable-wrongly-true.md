---
id: 3661
title: "Created properties report writable/configurable TRUE when the spec requires FALSE (202 + 134 tests)"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-31
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: property-descriptors
es_edition: es5
goal: es5
related: [3647, 3662, 3663, 739, 3603]
origin: "2026-07-26 lead measurement of the #3603 host de-inflation regression set (merge_group run 30179758665), decomposed per failed assertion."
assignee: ttraenkler/dev-es5-descriptors
# (#3102 ratchet) The freeze/seal slice adds `_clampFrozenDescriptor` — a small
# read-side clamp that must live beside `_readOwnDescriptor` in runtime.ts,
# whose return sites it wraps. There is no descriptor-MOP subsystem module to
# move it to; most of the growth is the rationale comment.
loc-budget-allow:
  - src/runtime.ts
---

# #3661 — created properties report `writable`/`configurable` TRUE when the spec requires FALSE

## Measured population

Computed from the #3603 de-inflation merged report (`test262-results-merged.jsonl`,
merge_group run `30179758665`) diffed against the baseline JSONL. The
reconstruction totals **exactly 1,066**, matching the gate, so the regression set
is correct.

Decomposing each failure message into its individual failed assertions:

| defect kind                     | tests affected |
| ------------------------------- | -------------: |
| `enumerable` wrongly TRUE       |        838 → **#3647** |
| **`writable` wrongly TRUE**     |        **202** |
| descriptor **value** wrong      |        153 → **#3662** |
| **`configurable` wrongly TRUE** |        **134** |
| `configurable` wrongly FALSE    |         72 → **#3663** |
| `writable` wrongly FALSE        |         16 → **#3663** |

A test can fail several assertions, so these overlap. **This issue owns the two
"wrongly TRUE" rows: 202 + 134.**

## The defect

`verifyProperty` reads the descriptor back and finds `writable: true` /
`configurable: true` where the spec requires `false`. The two most likely
mechanisms, which must be distinguished before fixing:

1. **Creation defaults.** A property created by class-member definition or by
   `Object.defineProperty` with the attribute **omitted** must default to
   `false`. If we default to `true` (or leave a struct field's natural
   mutability showing through), every such property reports wrongly.
2. **Descriptor read-back.** The property is created correctly but
   `getOwnPropertyDescriptor` synthesises the attributes rather than reporting
   the stored ones.

These have completely different fixes. **Probe both before choosing** — the
sibling issue #3647 turned out to be a read-back contradiction
(`propertyIsEnumerable` disagreeing with `gOPD`), not a creation bug, and
assuming symmetry here would be exactly the mistake this project keeps making.

## MEASURED 2026-07-26 (opus-loop-d) — mechanism (1) is RULED OUT; do NOT fix `defineProperty`

Probed on HEAD against the real population (the 12 paths from run
`30179758665`), with V8-verified expectations. Descriptor state encoded as
`100*writable + 10*configurable + enumerable`.

**Two measurements that disagree, both non-vacuous:**

1. **The 12 real population files reproduce** — 12/12 fail, control passes.
   Errors are `verifyProperty`-shaped ("descriptor should not be writable…").
2. **The same shapes read through `getOwnPropertyDescriptor` are CORRECT**
   (V8 = `0` for each): array generic prop → `0`; array index `"0"` → `0`;
   arguments generic prop → `0`; mapped arguments index 0 → `0`.

So **`defineProperty` stores and reports the flags correctly** on Array and
Arguments receivers. Mechanism (1) "creation defaults" is ruled out; the
disagreement is between `verifyProperty` and `gOPD` about the same property.

⚠️ **The first version of measurement (2) was VACUOUS** — every expectation
encoded to `0` *and so did the sentinel*, so "0" proved nothing. Re-run with a
sentinel returning **999** plus a known-broken case (`freeze` → **111**) in the
same harness; both surfaced, so the four `0`s are real readings.

### The live hypothesis is ENFORCEMENT, not reflection (corrected by opus-loop-a)

An earlier framing of this — that the cluster shares #3647's *reflective-route*
mechanism — is **wrong**, and was corrected by reading
`test262/harness/propertyHelper.js` rather than reasoning about it. The three
`verifyProperty` checks use **three different routes**:

| check | route | kind |
| --- | --- | --- |
| `enumerable` | for-in && `hasOwnProperty` && **`propertyIsEnumerable`** | reflection — this is #3647 |
| `writable` | `isWritable` performs a real **WRITE**, reads back, reverts | **enforcement** |
| `configurable` | `isConfigurable` performs a real **DELETE**, then `hasOwnProperty` | **enforcement** |

`propertyIsEnumerable` never appears in the `writable`/`configurable` paths, so
#3647 cannot explain this cluster. The fix site is the **write/delete rejection
paths on Array and Arguments receivers**, not `propertyIsEnumerable`.

**Next axis to test — the reconciling one: `isWritable` does a NON-STRICT
write.** A strict-mode write to a non-writable property *is* correctly rejected
on HEAD (measured). In sloppy mode the write must **silently fail** with the
value unchanged; if we instead mutate it, `isWritable` reads back the new value
and reports "writable" — exactly this symptom, while strict mode still looks
correct. That single unvaried axis would reconcile the strict-mode pass, the
census §2.2 refutation, and these failures.

**Two warnings before starting:**

1. This lands in census §2.2's A1/A2 territory, which **opus-loop-e has
   refuted** (A2's cluster was a swallowed-exception artifact — the `delete`
   throws, so the probe's next expression never ran). The refutation was of the
   census's *probe*, not necessarily of the behaviour. **Check with loop-e
   first**; there may be overlapping work in flight.
2. **`isWritable`/`isConfigurable` are destructive and self-contaminating** —
   `isConfigurable` deletes the property, and `isWritable` reverts only if the
   write succeeded. This is how `verifyProperty(WeakMap.prototype, "get", …)`
   deleted a realm intrinsic in #3603. **Use a fresh receiver per case.**

### Also found: a separate Array-`length` sub-defect

Some population messages carry a **value** mismatch alongside the flag one
(`15.2.3.7-6-a-164`: "obj['length'] value should be 2"; `15.2.3.6-4-167`:
"value should be 1"). That looks like an independent Array `length` truncation
defect on a non-writable redefine. It should not be folded into the enforcement
story, and means this bucket is **≥2 mechanisms**, not one.

### Landed here: the freeze/seal read-back slice (~13/229, 6 %)

`Object.freeze`/`seal` record flags in the sidecar table, which misses the two
shapes whose value lives outside it — a **bare struct field** and a **vec
element**. Measured on the merge base: frozen literal field `111` (V8 `001`);
frozen array element `111`; sealed literal field `111` (V8 `101`). Enforcement
and `isFrozen`/`isSealed` were already correct — only the read-back lied.
Fixed by clamping on the read side (`_clampFrozenDescriptor`), per
SetIntegrityLevel §7.3.15. Covered by
`tests/issue-3661-freeze-seal-descriptor-readback.test.ts`; verified by
reverting (exactly 3 tests go red, sentinel + guards stay green).

**This is 6 % of the cluster and must not be quoted as its mechanism.** The
remaining ~94 % is the enforcement question above, still open.

## MEASURED 2026-07-31 (dev-es5-descriptors) — the discriminator is the VALUE CARRIER + script/module mode, not strictness and not creation defaults

Probes in `.tmp/probe-3661{b..f}.mjs`, all certified non-vacuous (999 sentinel
surfaced; positive control `writable: true` accepts its write; ≥2 distinct
expected values; **fresh receiver per case**). V8 reference computed per case at
runtime, never hardcoded.

### 1. Re-measured the real population (authoritative harness, not a probe shape)

Ran 24 `built-ins/Object/defineProperty/*` files that use `propertyHelper` +
`writable: false` through `runTest262File` (the same path CI uses):
**16 pass / 8 fail (denominator 24).** Every one of the 8 failures is an
**Array receiver** — `length` or index `'0'`. **All plain-object files pass.**
So this bucket is Array-shaped; a plain-object repro is NOT the population.

### 2. "Creation defaults" (mechanism 1) is ruled out — now including the case the earlier probe never covered

The earlier ruling-out was sound but its evidence was narrower than stated: it
always passed `writable: false` **explicitly**, while the failing population
files (`15.2.3.6-4-201/190/204/214`) **OMIT** the attribute, which §6.2.5.6
CompletePropertyDescriptor must default to `false`. That untested combination
was the obvious hole. **Measured it: there is no defect there.** Encoded
`100*w + 10*c + e`, wasm == V8 on all of: plain/Array × index/named ×
omit-all/omit-writable/explicit (9/9 match). `gOPD` read-back is correct.

### 3. What IS broken: [[Set]]/[[Delete]] rejection, and it fails in OPPOSITE directions per carrier

| case | V8 (sloppy) | wasm | defect |
| --- | --- | --- | --- |
| plain object, write to non-writable | silent no-op | **value LANDS** | under-enforcement |
| Array (index or named), write to non-writable | silent no-op | **throws TypeError** | over-enforcement |
| plain object, `delete` of non-configurable | silent `false` | **throws TypeError** | over-enforcement |

Bookkeeping is right in every case (after a rejected write the value is
unchanged; after a rejected delete the property is still present) — so this is
**not** a storage or read-back defect. It is the rejection path only.

### 4. Strictness is NOT the axis — the earlier "next axis to test" is refuted

The predicted reconciling axis was "`isWritable` does a NON-STRICT write". It is
**wrong**: adding `"use strict"` changes **neither** result. Named writes land
in both modes; computed writes throw in both modes. The compiler selects
`__extern_set_strict` vs `__extern_set` for **named** writes
(`member-set-dispatch.ts:90`) but **hardcodes the strict setter on the dynamic /
computed paths** (`dyn-read.ts:831,1046,1507`), so a sloppy computed write can
never be silent.

### 5. The carrier — reproducible, and the sharpest clue for the next agent

The same source-level write changes behaviour depending on **downstream code**:

```ts
const o: any = {};
Object.defineProperty(o, "p", { value: 1, writable: false, ... });
o.p = 42;
return o.p;                                    // → 42   (write LANDED)
// …but append a trailing gOPD call and the SAME write throws instead:
return Object.getOwnPropertyDescriptor(o, "p").value;   // → TypeError
```

Adding the `gOPD` forces the object to materialise to the host, which switches
the write from the struct/vec field lane to the host lane. **No carrier
implements the spec's sloppy contract** (silent no-op, value retained).

**Root cause statement:** rejection semantics for a non-writable data property
are chosen by *value carrier*, not by the spec — the struct lane materialises
the rejected value, the host lane throws unconditionally.

### ⚠️ Correction to the record, and a warning for the next agent

`runtime.ts:4823-4832`'s sloppy catch is **NOT** the site: patching it to
silently return on a non-writable descriptor changed **nothing** in any probe —
the failing named write never reaches that catch. That edit was reverted rather
than shipped unexercised. **Do not re-attempt it.** Name the site from a `wat`
dump of the failing write before editing source.

### Not yet done

No fix landed for the remaining ~94 %. The three defects in §3 are separable;
the Array over-enforcement is the one the measured population actually hits.
**Scope caution:** this is the same `[[Set]]` surface as **#3475** (writes
wrongly *dropped* — the opposite direction), which is claimed by
`ttraenkler/senior-dev`. Coordinate before editing that path.

## Where it lives

The `enumerable` cluster (#3647) is 695/838 in class bodies. **Re-derive the
path spread for these two rows specifically** rather than assuming it matches —
the whole point of splitting these issues is that they may not share a site.

## Acceptance

- [ ] Distinguish mechanism (1) from (2) by direct probe on HEAD, recorded in
      this issue.
- [ ] Fix, with a regression test that goes **red on the merge base**.
- [ ] Report the **measured flip count** from a re-run, with its denominator.

## ⚠️ Do not quote 202 or 134 as a flip count

These are **floors for tests that fail on this assertion**, not a forecast of
tests that will flip. A test failing on `writable` may also be blocked by
something else once that is fixed. Only a re-run measures the true number.

## ⚠️ This area's history of vacuous evidence

Three separate probes in this exact surface produced artifacts in one session
(2026-07-25/26):

- The ES5 census's §2.2 "probe-confirmed" A2 row recorded a defect that **does
  not exist** — its probe read `'x' in o` after a `delete` that **throws**, so
  the expression never evaluated.
- Its A1 row had the **direction inverted**: over-restriction dominates, not
  under-enforcement — which the table above independently confirms (202 wrongly
  TRUE against 16 wrongly FALSE for `writable`, but 134 vs 72 for
  `configurable`, so the picture is attribute-specific).
- `verifyProperty` itself reported pass for **any** expectation until #3603
  landed.

**Verify any green against a known-failing control**, and make sure no assertion
in your probe can throw before the value you are reading is evaluated.

## Provenance caveat

The baseline used was the then-current cache, not the exact artifact the gate
read (#3648 — the gate clones the baselines repo at step time). The total
matching 1,066 exactly means the regression **set** is right; individual counts
may shift by a few.
