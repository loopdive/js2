---
id: 4266
title: "Standalone key enumeration over a vec: the #3251 overlay is invisible to `Object.keys`/for-in/`getOwnPropertyNames`, and gOPN has no vec arm at all"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: property-model, descriptors, arrays, enumeration
goal: es5
related: [4230, 4222, 4010, 4055, 4071, 3251, 3537, 4159, 4232, 4098]
---

# #4266 — the vec key walk over the #3251 overlay (the #4230 L1 follow-up)

Wave 4 of the ES5-standalone-90 program. #4230 fixed the vec key source *inside*
`__defineProperties` and named the general read surface as its main leftover
("L1 — the overlay is invisible to every KEY-ENUMERATION surface"), together
with a dedup hazard for whoever took it. This is that issue.

## Measured on `upstream/main` (803a68c13), `--target standalone`

```js
const a = [];  Object.defineProperty(a, "p", { value: 12, enumerable: true });
a.p                                    // 12                         ✓
Object.getOwnPropertyDescriptor(a,"p") // {value:12,enumerable:true}  ✓
a.hasOwnProperty("p")                  // true                        ✓
a.propertyIsEnumerable("p")            // true                        ✓
"p" in a                               // false   node: true          ✗ RC1b
Object.keys(a).length                  // 0       node: 1             ✗ RC1
for (k in a) …                         // 0       node: 1             ✗ RC1 + RC1b
Object.getOwnPropertyNames(a).length   // 0       node: 2             ✗ RC1 + RC2

Object.getOwnPropertyNames([1,2,3]).length  // 0   node: 4            ✗ RC2
```

## Three root causes, and why two of them are invisible alone

**RC1 — the overlay is not a key source.** A vec has THREE own-key stores: its
`$data` elements, the #3537 expando bag, and the #3251 overlay companion.
`fillDynamicForinVecArms` enumerates the first, #4010 S3's `bagKeysTail` the
second, and **nothing** the third. So `Object.defineProperty(arr, k, d)` on a
non-index key produces a property that is readable and describable but not
enumerable — exactly what `propertyHelper.js`'s `verifyEnumerable` measures,
which is why the family shows up as `descriptor should be enumerable`.

**RC1b — `__extern_has` was the one presence surface #4010 S3 did not reach.**
`fillVecHasOwnHelpers` (`vec-bag-seed.ts`) gave `__hasOwnProperty`,
`__object_hasOwn` and `__propertyIsEnumerable` a `__vec_gopd` prologue; `in`
never got one. That is a visible inconsistency on its own (`hasOwnProperty`
true, `in` false for the same key), but the reason it is load-bearing HERE is
structural: the standalone for-in loop takes its key list from `__object_keys`
and then **re-checks every key through `__extern_has`**. Fixing RC1 alone
produces a correct key list that the loop then silently drops again — the
measured `t_forin_*` rows were still 0 after RC1 landed and only moved when
RC1b did. Neither half is observable without the other; that is why they ship
together.

**RC2 — `__getOwnPropertyNames` has no `$__vec_base` arm.** Its non-`$Object`
branch is `bagKeysIf`, which pushes the (usually empty) carrier bag and
`return`s, so a vec receiver never reaches the index keys or `length`. gOPN over
*any* array answered `[]`.

## The dedup hazard #4230 named, and the filter that closes it

#4230's leftover section is explicit:

> this is not a copy-paste of `__vec_props_keysrc`. The overlay SEEDS real array
> elements as companion entries (`SEED_FLAGS = 0xbf`, enumerable), so unioning it
> into `Object.keys` would DUPLICATE index keys the vec path already emits — and
> that surface builds an `$objvec` of strings via `__objvec_push`, not an
> `$Object`, so dedup is not free the way `__obj_insert` made it free here.

`__vec_props_keysrc` sidesteps the hazard by refusing any vec with
`length !== 0`. That escape is not available here — enumerating a non-empty
array is the point. So the seeds are filtered by identity:

- an overlay entry whose key is a **canonical array-index string below
  `length`** is skipped, because the index loop already emitted exactly that
  key;
- `"length"` is skipped by name (the vec arm emits it itself, and the overlay's
  `LENGTH_SEED_FLAGS` entry is non-enumerable so only gOPN's `__obj_ordered_all`
  would ever reach it);
- `FLAG_INTERNAL` and `FLAG_DELETED_INDEX` entries are skipped, as in
  `__vec_props_keysrc`.

**Canonicity is a ROUND TRIP, not a parse.** `ToString(ToNumber(key)) === key`.
"Parses as an in-range number" would silently delete `"00"`, `"1.5"`, `" 1"`,
`"+1"` — all ordinary named properties. That distinction is pinned by the
`t_keys_noncanonical_*` rows, which a numeric-parse filter fails. The round trip
costs one `number_toString` per overlay entry, so it is skipped outright when
`length === 0` — the dominant shape (`var arrObj = []`), where no index key can
exist in any store.

## Demand gate — a module that never asks is byte-identical

#4232's lesson (unconditional pull-ins cost code size and compile time on every
module that does not use the feature) is applied literally: the whole feature
hangs off ONE new pre-scan flag, `ctx.vecOwnKeysDirty` (`array-holes.ts`), set
only by a syntactic `Object`/`Reflect` mention of `defineProperty` /
`defineProperties` / two-argument `create` / `getOwnPropertyNames` / `ownKeys` /
`getOwnPropertyDescriptors`. No mention ⇒ no overlay named expando can exist and
nobody asks for own names ⇒ not one instruction, local, type or function is
added.

It is deliberately NOT folded into `vecAccessorDescriptorDirty`: that flag is set
only for a **non-data** descriptor (#4159 needs it for the accessor write-back
hole), while a plain `Object.defineProperty(arr, "p", {value: 12})` lands a named
expando in the overlay that must still enumerate. Reusing it would have missed
`15.2.3.6-4-277`, the head of the family.

`Object.create` is matched only in **call position with two arguments**:
`Object.create(proto)` installs no descriptors and is far too common an idiom to
arm the feature for.

gc/host output is unchanged twice over — the flag is only consulted under
`ctx.standalone`, and the `env::__object_keys` / `env::__getOwnPropertyNames`
imports own these paths there.

## Reserve / fill ordering

`__vec_overlay_lookup` is minted inside `ensureOverlayCore` at FINALIZE, after
`fillDynamicForinVecArms` has already baked the `__object_keys` vec arm. So
`__vec_overlay_push_keys` follows the #4230 / #1888-S5b reserve-then-fill
discipline: reserved as a placeholder returning `0` ("nothing added"), the call
baked into the key-walk arms, the real body installed from
`fillObjVecReflectionHelpers`. **A skipped fill degrades to exactly today's
answer** — never a trap, never a silent extra key.

## Files

- `src/codegen/vec-overlay-keys.ts` (new) — the whole feature: the demand-gate
  predicate, `__vec_overlay_push_keys` (reserve + fill), the `__extern_has`
  overlay arm, and the `__getOwnPropertyNames` vec arm.
- `src/codegen/object-runtime.ts` — three call sites in `fillDynamicForinVecArms`
  (`bagKeysTail` split into `buildBagPushKeys` + overlay push + tail, on both
  `__object_keys` and `__object_keys_forin`; the `__extern_has` overlay arm).
- `src/codegen/objvec-array-proto.ts` — the two fills, in the pass that already
  owns the overlay↔bag seam.
- `src/codegen/array-holes.ts`, `context/types.ts`, `context/create-context.ts` —
  the `vecOwnKeysDirty` pre-scan flag.
- `tests/es5-standalone-vec-key-enumeration.test.ts` — 18 rows, every
  expectation the value Node produces for identical source.

## Measurement

Sequential, in-process `runTest262File(abs, cat, 30000, "standalone")`, Node
25.7.0. **Sequential on purpose**: a timeout reports as `compile_error`, so a
parallel run under load manufactures phantom transitions.

### Instrument note — the runtime-eval provider must be prebuilt, or half the lever is invisible

The first A/B scored **+2** and every `descriptor should be enumerable` file
read `TypeError: WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval":
module is not an object or function`. That is #4162's documented instrument gap,
not a compiler result: a fresh worktree has no
`.test262-cache/runtime-eval-provider-*.wasm`, so `selectCachedRuntimeEvalProvider`
returns the NONE tier and every eval-mentioning module fails to LINK — masking
whatever the test would otherwise have measured. After
`node --import tsx scripts/build-runtime-eval-provider.mjs` (81 s) and re-running
BOTH arms with `TEST262_FULL_RUNTIME_EVAL=1`, the same change scored **+7**.
Anyone measuring an ES5-standalone lever in a fresh worktree must build the
provider first; the "+2" reading was 5 files of instrument artifact.

### Gain set — all 223 non-passing rows in `built-ins/Object/{defineProperty,defineProperties,create,keys,getOwnPropertyNames,getOwnPropertyDescriptor}`

| | |
| --- | --- |
| rows scored | 223 both arms |
| arm A (upstream/main) pass | **6** |
| arm B (this change) pass | **13** |
| **net** | **+7** |
| lost | **0** |
| fail→fail churn | **0** |

Flipped — no scatter, exactly the two predicted families:

- RC1/RC1b (`verifyEnumerable` over a vec / `arguments`), 5:
  `defineProperty/15.2.3.6-4-277`, `-4-313`, `-4-313-1`;
  `defineProperties/15.2.3.7-6-a-266`, `-a-302`
- RC2 (gOPN vec arm), 2: `getOwnPropertyNames/15.2.3.4-4-48`, `-4-49`

## Leftovers — measured, with the mechanism named

### L-A — a NON-ENUMERABLE index is still enumerated (`15.2.3.6-4-210`, `15.2.3.7-6-a-206`)

`Object.defineProperty(arr, "0", {})` over an existing element leaves the index
enumerable in our model no matter what the descriptor says, because the vec
arm's index loop pushes `"0".."length-1"` gated only on **presence**
(`__extern_has_idx`), never on the overlay's `FLAG_ENUMERABLE`. The fix is a
second gate on the same loop — an overlay flag read per index — and it is a
`Object.keys`/for-in-only change (gOPN must keep the key). Deliberately not
taken here: it changes the hot dense path, so it wants its own paired A/B.

### L-B — `Object.keys` over a dense array with an ACCESSOR expando (`15.2.3.14-5-12`)

Same union, but the entry is an accessor. Still reports "Property not found"
after this change; not yet isolated to a store or a flag.

### L-C — `hasOwnProperty` in the assembled harness disagrees with the probe (`15.2.3.14-6-1`)

`denseArray.hasOwnProperty(p)` answers **true** in an isolated compile
(`.tmp/p5.mts`, both `any` and typed receivers) yet the harness-assembled test
builds an empty `tempArray`, i.e. the same call answers false there. So the
receiver shape the harness produces differs from every probe shape; measure the
harness module, not a snippet, before touching `hasOwnProperty` — and note
#4010's **−684** for widening it.

### L-D — huge index keys (`15.2.3.6-4-184/-185/-186`)

`arrObj.hasOwnProperty("4294967295")` — per §10.4.2.2 that is a NAMED property,
not an array index. Already named as a leftover by #4222 item 3.

## Acceptance criteria

- `Object.keys` / for-in / `Object.getOwnPropertyNames` over a vec see the
  #3251 overlay's named expandos, exactly once each, with the enumerable filter
  honoured per surface.
- `"k" in arr` agrees with `arr.hasOwnProperty("k")` for an overlay expando.
- `Object.getOwnPropertyNames(arr)` reports indices + `length` + both side
  tables.
- A seeded index key or `length` is never double-reported; a non-canonical
  numeric-looking key (`"00"`, `"1.5"`) is never dropped.
- A module with no descriptor / own-key mention is byte-identical.
- No regression on the gc/host lane.
