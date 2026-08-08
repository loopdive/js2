---
id: 4230
title: "Standalone: `Object.defineProperties`/`Object.create` refuse a dynamic descriptor bag — the vec `Properties` key source misses the #3251 overlay, and the receiver-carrier gate fires before the key walk"
status: in-progress
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: property-model, descriptors, arrays
goal: es5
related: [3984, 4047, 3957, 4010, 4055, 4161, 3251, 3537, 3468, 4098, 4200, 4227]
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
---

# #4230 — dynamic descriptor bags in standalone mode

Wave 3 of the ES5-standalone-90 program; continues the WP1 descriptor work
(#3984 → #4227 → #4047 → #4161). This issue owns the design call those left
open: the `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusal.

## Symptom

```js
var obj = {};
var props = [];
Object.defineProperty(props, "prop", { value: { value: 8 }, enumerable: true });
Object.defineProperties(obj, props);
// standalone: TypeError: Object.defineProperties unsupported descriptor shape
//             in standalone mode (#1906) [SITE-PROPS-BAG-NOT-AUTHORITATIVE]
// node:       obj.prop === 8
```

and

```js
var obj = { "123": 100 };
Object.defineProperties(obj, -12);   // Properties is a NUMBER
// standalone: TypeError … [SITE-O-NO-CARRIER]
// node:       returns obj unchanged
```

## The design call this issue owns

`__defineProperties` (`src/codegen/object-runtime-descriptors.ts`) refused every
non-`$Object`, non-closure `Properties` map. The in-source comment stated the
precondition the #4161 agent would not decide alone:

> That arm becomes sound the moment **ONE store is authoritative** for a vec's
> own properties (#4010).

**Decision: the precondition is COMPLETENESS of the key source, not singularity
of the store.** "One authoritative store" is *sufficient* for completeness; it
is not *necessary*. A union over a **closed, individually-enumerable** set of
stores is equally complete, and it is available today.

That reframing is what unblocks the arm, and it is defensible because of what
`Properties` is actually used for in this helper. `L_DESCS` — the local the
refusal gates — feeds exactly **one** instruction: `__obj_ordered`. The
per-property *value* is read at §20.1.2.3.1 step 3.b from the ORIGINAL receiver
via `__extern_get(local 1, key)` (the #3957 fix), which already dispatches over
every carrier. So `Properties` is a **pure key source** here. The soundness
question therefore reduces to a single one: *can we enumerate every own
enumerable key of this receiver?* — not *is there one place they all live?*

### Measured store map (standalone, this branch, `.tmp/dp/probe2.mts`)

`Object.keys(p).length` is the direct read of the key source the helper gets.
Node answers `1` for every row.

| `Properties` shape | write path | key source today | value read today |
| --- | --- | --- | --- |
| Array, `p.prop = d` | #3537 vec bag | **1** ✓ | ✓ |
| Array, `defineProperty(p,…)` | #3251 overlay companion | **0** ✗ | ✓ (42) |
| `arguments`, either | same (it *is* a vec) | **0** ✗ | ✓ |
| `Error`, `p.prop = d` | — none — | **0** ✗ | **✗ (NaN)** |
| `Error`, `defineProperty(p,…)` | — none — | **0** ✗ | **✗ (NaN)** |

Two different diagnoses, not one:

- **A vec has TWO stores, both enumerable.** Defines land in the #3251 overlay
  companion, assignments in the #3537 bag. #4010 S3 wired `Object.keys` to the
  bag but never to the overlay, so the overlay half is invisible. The union is
  complete and computable ⇒ **admit**.
- **An `Error`/`Date`/`RegExp` has NO store.** The define lands nowhere and the
  read returns `undefined` — enumerating would yield an empty key source, i.e.
  the silent no-op #3957 forbade ⇒ **keep refusing**. That is #4098's
  greenfield, not this issue's.

So the refusal is split by *mechanism* rather than lifted: the receivers that
have a computable complete key source get one; the receivers that have no store
at all keep the loud refusal.

### The one place the union is NOT complete: index keys

A vec's own enumerable keys also include its **elements** (`"0"…"length-1"`),
which live in `$data`, not in either side table, and which this helper would
have to render as strings. Rather than approximate, a vec `Properties` with
`length !== 0` **keeps refusing**, under a new, honest tag
`[SITE-PROPS-VEC-INDEXED]` — a tag the #4047 comment had already reserved for
exactly this case. `length === 0` guarantees no index key exists in *any* of
the three stores (an index define grows the array), so bag ∪ overlay is
provably the whole own-key set.

### Known, deliberate inaccuracy: cross-store key ORDER

Keys are emitted bag-first, then overlay. True creation order across the two
stores is **not recoverable** — each `$Object` has its own `nextSeq` counter
(#1837), so the two stores' sequence numbers are not comparable. This is
observable only through side-effecting getters that interleave a plain
assignment with a `defineProperty` on the same `Properties` map. Stated here
rather than hidden: it is a strictly smaller error than refusing the call, but
it *is* an error, and it disappears if the stores are ever unified.

## Second root cause — `[SITE-O-NO-CARRIER]` is checked too early

The receiver-carrier gate ran as part of §20.1.2.3.1 step 1. But the receiver
only needs somewhere to *store* a descriptor if at least one descriptor is
actually going to be defined. With `Properties` a primitive (`-12`), a fresh
`ToObject` wrapper has zero own enumerable properties, the key walk is empty,
and "return O unchanged" is the complete spec answer for **any** receiver.

`Type(O) is not Object → TypeError` stays where it is (that is genuinely step
1). The *carrier* refusal moves to just before pass 2, guarded on a non-empty
gathered set. Strictly narrowing: every input that refused before and still has
something to define still refuses, with the same message.

## Not in scope (measured, and why)

- **Array holes materialising as own properties** (the WP1 leftover). The four
  cited files (`15.2.3.7-6-a-155/-156/-161/-162`) **already pass on this
  branch** — re-measured in `.tmp/dp/base.log`. The underlying defect is real
  but is *not* on the `defineProperties` path: `.tmp/dp/probe-holes.mts` shows
  `[0,,2].hasOwnProperty("1") === true` **with no define call at all**. Array
  elisions simply have no hole representation in the vec model, so fixing it
  means giving `$data` a hole sentinel that every read/write/enumerate path
  honours — an XL representational change, and a separate issue.
- **`Error`/`Date`/`RegExp` `Properties`** — no store (#4098).
- **`<Builtin>.prototype.constructor` gOPD** — #4200-blocked.

## Acceptance criteria

- A vec (`Array` / `arguments`) `Properties` map with `length === 0` is
  accepted, and its descriptors are read from BOTH the #3537 bag and the #3251
  overlay companion.
- A vec `Properties` with index elements keeps refusing, under
  `[SITE-PROPS-VEC-INDEXED]`.
- A carrier-less `Properties` (Error/Date/RegExp) keeps refusing, unchanged.
- `Object.defineProperties(o, <primitive>)` returns `o` for any receiver.
- No regression on the gc/host lane (the arms are standalone-gated and the
  builders return `undefined` when the substrate is absent, keeping host output
  byte-identical).
