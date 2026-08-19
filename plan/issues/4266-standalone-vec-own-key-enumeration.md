---
id: 4266
title: "Standalone key enumeration over a vec: the #3251 overlay is invisible to `Object.keys`/for-in/`getOwnPropertyNames`, and gOPN has no vec arm at all"
status: done
completed: 2026-08-09
sprint: 78
created: 2026-08-09
updated: 2026-08-18
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
# All the SUBSTANCE of this change is in the new satellite module
# `src/codegen/vec-overlay-keys.ts` (~430 lines), which is why neither god-file
# grows by more than its call sites:
#   object-runtime.ts +20 — one import, the `reserveVecOverlayPushKeys` call,
#     the `bagKeysTail` → `buildBagPushKeys` + overlay push + tail split inside
#     the EXISTING vec arm, and the one-line `__extern_has` overlay arm. Each is
#     in-place inside the arm it modifies; extracting them would put a two-line
#     wrapper behind an import and hide the branch from the code that has to
#     reason about the arm's stack shape.
#   context/types.ts +17 — the `vecOwnKeysDirty` field plus its doc comment.
#     The comment is load-bearing: it records WHY the flag is not folded into
#     `vecAccessorDescriptorDirty` (that one fires only for a NON-data
#     descriptor, so it would have missed 15.2.3.6-4-277, the head of the
#     family). One line of field, sixteen of the reason.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/context/types.ts
# Same reason, per function. `fillDynamicForinVecArms` +18: the overlay push had
# to land INSIDE the existing `__object_keys` / `__object_keys_forin` vec arm
# (before `bagKeysTail`'s `return`), so the tail is spelled out rather than
# called — moving it out would mean handing a builder the arm's local numbers
# and its stack shape. `createCodegenContext` +1 is the one new flag initializer.
func-budget-allow:
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  - src/codegen/context/create-context.ts::createCodegenContext
# coercion-sites: `vec-overlay-keys.ts` is a NEW module that CALLS the canonical
# engine helpers rather than hand-rolling anything — `number_toString` is the
# very helper the vec index loop uses to build the index keys this filter has to
# recognise, and `__str_to_number` is the one `__extern_has`'s numeric arm
# already parses keys with. Using the SAME two is what makes the dedup filter
# agree with the loop it is deduplicating against; a private ToString/ToNumber
# here would be the actual defect. The gate counts per-FILE vocabulary, so code
# in a new module registers as growth even when the vocabulary is reused
# verbatim (same grant, same reason, as #4222's `vec-overlay-presence.ts`).
coercion-sites-allow:
  - src/codegen/vec-overlay-keys.ts
---

# #4266 — the vec key walk over the #3251 overlay (the #4230 L1 follow-up)

Wave 4 of the ES5-standalone-90 program. #4230 fixed the vec key source *inside*
`__defineProperties` and named the general read surface as its main leftover
("L1 — the overlay is invisible to every KEY-ENUMERATION surface"), together
with a dedup hazard for whoever took it. This is that issue.

## Measured on `upstream/main` (e1aeff7c2, PR #4265), `--target standalone`

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

**Canonicity is a ROUND TRIP *plus* an integer test — and the round trip alone
is NOT enough.** The filter is `n === ToNumber(key)`, `n >= 0`, `n < length`,
`n === floor(n)`, `ToString(n) === key`.

- Dropping the round trip loses `"00"` / `" 1"` / `"+1"` — they parse to an
  in-range number but are ordinary named properties.
- Dropping the **floor** test loses `"1.5"`: `ToString(1.5) === "1.5"`, so a
  fraction round-trips perfectly and gets discarded as if it were an index.
  This is not hypothetical — the first cut had exactly the round trip and no
  floor test, and `t_keys_noncanonical_fraction` measured **2 where Node says
  3**. The row is in the suite for that reason.

The round trip costs one `number_toString` per overlay entry, so the whole test
is skipped when `length === 0` — the dominant shape (`var arrObj = []`), where
no index key can exist in any store.

A **non-string** key (a symbol) is screened structurally before either filter:
both would `ref.cast $AnyStr` it, which TRAPS inside a helper that must never
throw. A symbol is not an own *name*, so skipping the entry is also the right
answer.

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
  expectation the value Node produces for identical source, plus a demand-gate
  test that asserts the native is absent from an unarmed module and present in
  an armed one.

## Gate status

`check:{loc-budget,func-budget,oracle-ratchet,coercion-sites,pushraw,ir-fallbacks,dead-exports,issues,stack-balance,issue-spec-coverage,issue-ids:against-main}`
all OK; `npx tsc --noEmit` clean; `npm run lint` exit 0 with zero diagnostics on
the new file. `check:oracle-ratchet` reports `getTypeAtLocation +0, ctx.checker
+0` — this change asks no type questions at all, it is pure funcMap wiring plus
one syntactic AST pre-scan.

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

### Regression watch — all 2,863 currently-PASSING rows this change can reach

`built-ins/Object/{defineProperty,defineProperties,create,keys,getOwnPropertyNames,getOwnPropertyDescriptor,entries,values,assign,freeze,isFrozen,seal,isSealed,getOwnPropertyDescriptors,hasOwn,prototype/hasOwnProperty,prototype/propertyIsEnumerable}`,
`built-ins/Reflect/ownKeys`, `built-ins/JSON/stringify`,
`language/statements/for-in`, `language/expressions/{in,delete}` — every row the
promoted standalone baseline records as `pass`.

| | |
| --- | --- |
| rows scored | 2,863 both arms |
| arm A pass | **2,862** |
| arm B pass | **2,862** |
| **net** | **0** |
| **lost** | **0** |
| status churn | **0** |

The single non-passing row is the same on both arms and is **not** this change:
`language/expressions/in/private-field-in-nested.js` →
`CompileError: … "C_init" failed: local.tee[0] expected type anyref, found i32`.
It is a `pass` in the promoted baseline, so it is a pre-existing local↔CI
divergence in the private-field lowering; recorded here rather than waved off.

Two honest caveats about the arms:

- Rows 1–2,740 of arm B ran before the **symbol screen** was added. The screen
  only prevents a `ref.cast $AnyStr` trap on a symbol-keyed overlay entry, so it
  can turn a trap into a non-trap and nothing else; no scored row changed
  category.
- The **floor** test in the dedup filter also landed after the watch arms. It
  only makes the filter STRICTER (it stops discarding non-integer numeric keys
  such as `"1.5"`), and the index loop never emits such a key, so it cannot
  introduce a duplicate. Both refinements are covered by the vitest suite.

### Demand gate — PROVED byte-identical, not assumed

`.tmp/identity.mts`: an 8-module corpus that never mentions a descriptor /
own-key builtin (array for-in, `Object.keys` over an array, array HOFs, dynamic
object for-in, `delete arr[i]`, string+number, a class, and the one-argument
`Object.create(proto)` that must NOT arm the gate), compiled on BOTH lanes
(16 binaries), swapping the six touched sources for their `upstream/main` copies
by **file copy** (never `git stash`).

**All 16 sha256/length pairs identical.** The `Object.create(proto)` row is the
one that would break if the pre-scan matched `create` unconditionally.

### gc/host lane

Unchanged by construction, twice over: every entry point is behind
`ctx.standalone` (via `vecOwnKeysEnumerationActive`), and in gc/host mode the
`env::__object_keys` / `env::__extern_has` / `env::__getOwnPropertyNames`
imports own these paths — the natives this change edits are not even emitted.
The gc half of the identity corpus above is the measured form of that.

### `tests/es5-standalone-harness-selftests.test.ts` (the #4251 ratchet) — checked, no flip

That file landed on `main` AFTER this branch's base (e1aeff7c2), so it is not in
this diff. It was checked anyway rather than assumed, by copying `main`'s copy
into `tests/` and running it against this branch: **19 / 19, exit 0** — no
`"pass"` entry regressed and no `"fail"` entry got fixed, so the EXPECTED table
needs no edit in this change. The copy was then removed; `main`'s version
arrives with the merge.

That result is also the expected one, mechanically: every `"fail"` entry in the
table is #4251 **RC1 constructor identity** (`err.constructor !== Test262Error`)
or `Test262Error.prototype`, and the load-bearing `"pass"` entries
(`propertyhelper-verifyenumerable-enumerable.js` et al.) exercise
propertyHelper against **plain objects**, which no arm of this change touches —
every arm is `$__vec_base`-gated.

### `tests/equivalence/**` (the gc lane's own suite)

Full run: **24 failed | 1637 passed | 3 todo** across 215 files. Every one of
the 24 was chased rather than waved off: re-running the 11 failing FILES on the
BASE arm gives **24 failed | 102 passed**, and the failing test-name lists are
**identical** (`.tmp/equiv-base.log` vs `.tmp/equiv-new.log`). **Zero
regressions.**

Worth flagging separately: those 24 (TDZ, null-deref guards, `Reflect.construct`,
`yield` as expression, …) fail on clean `upstream/main` in this container while
CI's `equivalence-gate` is green on main — i.e. a local↔CI environment
divergence that predates this change and is not this issue's to fix.

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
