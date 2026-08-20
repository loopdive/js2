---
id: 4230
title: "Standalone: `Object.defineProperties`/`Object.create` refuse a dynamic descriptor bag — the vec `Properties` key source misses the #3251 overlay, and the receiver-carrier gate fires before the key walk"
status: done
sprint: 78
created: 2026-08-08
updated: 2026-08-20
completed: 2026-08-08
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

## Measurement

Sequential in-process `runTest262File` on the standalone lane over a 25-file
gated set (13 `[SITE-PROPS-BAG-…]` + 2 `[SITE-O-NO-CARRIER]` + the 4 array-hole
files + 6 controls). **Sequential on purpose**: a timeout reports as
`compile_error`, so a parallel run under load manufactures phantom
transitions. Logs: `.tmp/dp/base.log` / `.tmp/dp/new.log`.

| | |
| --- | --- |
| rows scored | 25 both arms |
| arm A (base) pass | **9 / 25** |
| arm B (fix) pass | **19 / 25** |
| **net** | **+10** |
| lost | **0** |
| controls | **all held** |

Flipped — no scatter, exactly the two predicted families:

- RC1 (vec key source), 8: `create/15.2.3.5-4-6` `-4-29` `-4-38`;
  `defineProperties/15.2.3.7-2-10` `-5-a-8` `-5-a-17` `-5-b-240` `-5-b-249`
- RC2 (deferred carrier gate), 2: `defineProperties/15.2.3.7-2-5` `-2-7`

### gc lane: proved byte-identical, not assumed

Paired A/B over a 5-case gc corpus (`.tmp/dp/gc-identity.mts`), swapping the
two touched sources for their `HEAD` copies via file copy (never `git stash`):
all five sha256/length pairs identical. Mechanically: RC2 is
`ctx.standalone`-gated, and RC1's builders return `undefined` when the #3537
substrate is absent, so both the body AND the local vector are unchanged.

### Directly asserted against Node

`tests/es5-standalone-descriptor-bags.test.ts` — 15 rows, every expectation the
value Node produces for identical source: both stores separately, both together,
`arguments`, a getter that must RUN for its side effect, a non-enumerable map
entry that must define nothing, `Object.create`, the two RC2 rows, the two
refusal rows, and three controls (plain-object Properties, `#3984` array-length
routing, vec RECEIVER index define).

## Leftovers — measured, with the discriminator that isolates each

### L1 — the overlay is invisible to every KEY-ENUMERATION surface (the next lever)

This issue fixed the vec key source **inside `__defineProperties`**. The general
read surface still has the same hole, and it is what the `descriptor should be
enumerable` family (`15.2.3.6-4-277`, `-4-210`, `-4-313`, `15.2.3.7-6-a-206`,
`-a-266`, `-a-302`, …) is actually failing on. Measured (`.tmp/dp/probe6.mts`),
array with one `defineProperty` expando:

| surface | ours | Node |
| --- | --- | --- |
| `a.property` (read) | 12 | 12 ✓ |
| `getOwnPropertyDescriptor` | enumerable:true | ✓ |
| **`Object.keys(a).length`** | **0** | 1 ✗ |
| **`for-in` count** | **0** | 1 ✗ |
| **`getOwnPropertyNames(a).length`** | **0** | 2 ✗ |

So the value and the descriptor are both fine; only the KEY WALK misses it —
`propertyHelper.js` decides enumerability by walking keys, hence the family.

**Named hazard for whoever takes it:** this is not a copy-paste of
`__vec_props_keysrc`. The overlay SEEDS real array elements as companion
entries (`SEED_FLAGS = 0xbf`, enumerable), so unioning it into `Object.keys`
would DUPLICATE index keys the vec path already emits — and that surface builds
an `$objvec` of strings via `__objvec_push`, not an `$Object`, so dedup is not
free the way `__obj_insert` made it free here. Combined with the history of
enumeration widenings (#4055 measured **-684**, #4071 **-5**), this needs its
own paired A/B and its own issue rather than a rider on this one.

### L2 — a builtin prototype's expando is invisible to `for-in` (`verifyEnumerable`, 6)

`15.2.3.6-4-404` / `-409` / `-419` / `-580` / `-585` / `-595`. Discriminated:
for-in over a **plain** prototype chain works, over a **builtin** prototype does
not — so this is a builtin-prototype-carrier enumeration gap, NOT L1.

```
Object.defineProperty(Boolean.prototype, "prop", {value:1001, enumerable:true, …});
for (var p in new Boolean()) …   // ours: never sees "prop"; node: sees it
Object.defineProperty(plainProto, "prop", {value:1, enumerable:true});
for (var p in Object.create(plainProto)) …   // ours: sees it ✓
```

### L3 — gOPD on the global object: the brief's diagnosis does not hold (~11)

The task framed these as "descriptors missing fields". Measured, they are not:
`Object.getOwnPropertyDescriptor(globalThis, "eval"|"NaN"|"parseInt")` returns
**`undefined`**, and `globalThis.hasOwnProperty("NaN")` is **`false`**. The
global object has no own-property record for its intrinsic bindings at all —
they are compiler globals, not properties. Completing descriptor FIELDS cannot
reach this; it needs the global object modelled as an ordinary object with own
property records, which is its own substrate issue. (The
`<Builtin>.prototype.constructor` sub-family, 5 of the 20, was already known
#4200-blocked and is untouched.)

### L4 — array holes have no representation (the WP1 item-2 leftover)

See "Not in scope" below: not a `defineProperties` defect at all. Closest
existing owner is **#4222** (`delete arr[k]` / `new Array(n)` holes), which
landed the `vec-overlay-presence.ts` substrate — the literal-elision case
(`[0,,2]`) is the piece that substrate does not yet cover.

## Gate status at hand-off

Run locally on this branch: `check:loc-budget` OK (the `+95` on
`object-runtime-descriptors.ts` is granted by this file's frontmatter),
`check:func-budget` OK (`+92` on `buildObjectDescriptorHelpers`, likewise
granted), `check:oracle-ratchet` OK (no raw `checker.*` added — this change is
pure funcMap wiring), `check:stack-balance` OK, `tsc --noEmit` clean.

`tests/equivalence/**` was run in full. It reported **5** failures, and the run
**OOM'd** partway (`FatalProcessOutOfMemory` + `ERR_IPC_CHANNEL_CLOSED` — the
full-suite hazard CLAUDE.md warns about). Every one was chased down
individually rather than waved off as "probably the OOM":

| failure | verdict | how established |
| --- | --- | --- |
| `arguments-nested-and-loops > for-loop with function declaration in body` | **pre-existing** | isolated A/B: `1 failed \| 45 passed` identically at base and with the fix |
| `logical-conditional-identity > isNaN(void x)…` + 2 sibling `void`/NaN rows | **pre-existing** | isolated A/B: the same 3 rows fail at base |
| `weakmap-weakset > WeakMap set and get` | **OOM collateral** | passes in isolation (it had taken 35 s in the full run) |

Zero regressions. Two independent reasons, not one: the isolated A/Bs above,
and the mechanism — this suite exercises the DEFAULT gc lane, which the
byte-identity A/B already proves unchanged.

**Method note for the next agent:** the wrapper `npm test … > log; echo "EXIT=$?"`
reports the *echo*'s status, so an OOM-killed suite can read as exit 0 (it did
here, in a background-task notification). Read the log, not the exit code — and
never let "the run OOM'd" stand in for a per-failure verdict.

`check:godfiles` **fails with 13 regressions, none of them from this change** —
every entry is in `src/codegen/expressions/calls.ts`, `src/codegen/index.ts` or
`src/codegen/object-runtime.ts`, three files this issue does not touch. They are
pre-existing on the Wave-1/2 program branch and need a deliberate
`node scripts/profile-godfiles.mjs --update` from the branch owner. This issue
kept its own substance out of the god-file precisely to avoid adding to that
list: the key-source builder lives in the new `vec-props-key-source.ts`, and
what remains in `object-runtime-descriptors.ts` is the composed arm wiring plus
the reasoning comments.

## Not in scope (measured, and why)

- **Array holes materialising as own properties** (the WP1 item-2 leftover).
  Two corrections to the brief, both measured:
  1. The four cited files (`15.2.3.7-6-a-155/-156/-161/-162`) **already pass on
     this branch** — arm A of the sweep, `.tmp/dp/base.log`. Whatever fixed
     them landed in Wave 1/2 (most likely #4227's standalone gate, which routes
     the plural `length` define through the overlay-aware native).
  2. The residual defect is real but is **not on the `defineProperties` path**.
     `.tmp/dp/probe-holes.mts` isolates it with a no-define control:
     ```
     [0,,2].hasOwnProperty("1")            // ours: true   node: false
     // ^ WITH NO Object.defineProperties CALL AT ALL
     ```
     So the define does not "materialise" anything — array elisions have no
     hole representation in the vec model to begin with. Fixing it means giving
     `$data` a hole sentinel that every read / write / enumerate / `length`
     path honours: an XL representational change, and a separate issue. Filing
     it as a `defineProperties` bug would send the next agent to the wrong file.
- **`Date`/`RegExp` `Properties`** — no authoritative store in this slice.
  Error was subsequently promoted to an authoritative own-property carrier by
  #4098 and is now covered positively by the #4230 regression test.
- **`<Builtin>.prototype.constructor` gOPD** — #4200-blocked.

## Acceptance criteria

- A vec (`Array` / `arguments`) `Properties` map with `length === 0` is
  accepted, and its descriptors are read from BOTH the #3537 bag and the #3251
  overlay companion.
- A vec `Properties` with index elements keeps refusing, under
  `[SITE-PROPS-VEC-INDEXED]`.
- A carrier-less `Properties` (Date/RegExp) keeps refusing, unchanged. Error
  instances are accepted after #4098 and copy their enumerable descriptor map.
- `Object.defineProperties(o, <primitive>)` returns `o` for any receiver.
- No regression on the gc/host lane (the arms are standalone-gated and the
  builders return `undefined` when the substrate is absent, keeping host output
  byte-identical).
