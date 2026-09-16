---
id: 6622
title: "standalone: a compiled class INSTANCE reported `typeof \"function\"` and failed `instanceof`/`isPrototypeOf` — two independent mechanisms (S35)"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-16
assignee: ttraenkler/senior-dev-s35
func-budget-allow:
  # 2026-09-16 (S35) — `__isPrototypeOf`'s new class-instance seed
  # (`classInstanceIsPrototypeOfSeed`, mirroring the existing
  # `fnctorIsPrototypeOfSeed` one function up) is spliced into
  # `buildObjectPrototypeHelpers`'s body, the single function that registers
  # every `object-runtime-prototype.ts` native. Six lines over budget for a
  # deliberate, precedent-matching seed call, not an incidental regression.
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
---

# #6622 — a compiled class instance reported `typeof "function"` and failed `instanceof`/`isPrototypeOf`

## Problem

S34 fixed `new construct(...constructArgs)` (a runtime-length spread into a
foreign/linked dynamic construct, #6621) and verified DIRECTLY that the fix
reaches a real, field-populated instance with the correct prototype link. The
45-file `built-ins/Temporal/**/subclassing-ignored.js` family still did not
move, because the harness's NEXT assertion fails on a separate,
pre-existing mechanism: a dynamically-constructed class instance's `typeof`
answers `"function"` and `instanceof`/`isPrototypeOf` answer `false` — matching
S20 §4's "per-name ladder, no runtime class test" residual and S22's
documented `typeof <provider instance>` residual (standing since S11).

## Root causes (two, independent)

### Mechanism A — `__reflect_is_constructor`'s bare `ref.test $__ta_ctor`

`reflect-construct-native.ts` had TWO sites (`fillNativeReflectTargetClassifier`
and `fillReflectIsConstructor`) that pushed `ctx.taCtorTypeIdx` into a
candidate list and tested it with a **bare** `ref.test` — unlike every other
`$__ta_ctor` site in this backend (`typeof-natives-finalize.ts`'s
`buildTaCtorBrandTestArm`, `ta-dyn-mop.ts` post-#6620, `ta-ctor-meta.ts`),
which already route through `taCtorIdentityTestInstrs` (#5383 S2f R11).

`$__ta_ctor` is `{kind: i32, brand: i32}` (`registry/types.ts`) — the EXACT
same WasmGC shape as a field-less compiled class root (`{__tag: i32,
__shape_brand: i32}`, `class-bodies.ts` #2158/#2009). WasmGC canonicalises
struct types by their recursive DEFINITION (isorecursive typing), so two
independently-declared types with that identical shape are the SAME canonical
type at the engine level — `ref.test` cannot tell them apart, only a field-VALUE
check (`taCtorIdentityTestInstrs`'s `brand === TA_CTOR_BRAND`) can. This is the
same collision class #5194 r3 F1 (`typeof`), #6601 (own-property reads on
`Reflect`/`%TypedArray%.of`/`.from`) and #6620 (dynamic `.prototype` reads) each
independently hit and fixed at THEIR OWN call sites — this issue is the same
defect at `__reflect_is_constructor`'s two remaining unfixed sites.

**Measured against the real standalone `@js-temporal/polyfill` provider**
(`.tmp/s35/probe1.mjs`, `.tmp/s35/probe2.mjs`, fresh cache each side):

| probe | base | S35 |
| --- | --- | --- |
| `typeof (new Temporal.Duration(1))` through an `any` param, linked | `"function"` | `"object"` |
| `typeof (new Temporal.Duration(1))` (bare) | `"function"` | `"object"` |
| `new (new Temporal.Duration(1))()` | `constructed:object` (no throw) | `constructed:object` — unaffected, see "Traps" |
| `Object.getPrototypeOf(inst) === Duration.prototype` | `true` | `true` (unaffected — #6617/S30, unrelated mechanism) |
| provider artifact size | `3,311,544 B` | `3,311,638 B` (+94 B, both A+B fixes) |

The `typeof` fix alone (mechanism A only, before mechanism B) moved provider
size to `3,311,590 B` (+46 B) — verified independently by building with only
the `reflect-construct-native.ts` edit in place.

`__reflect_is_constructor` — via `standalone-link-boundary.ts`'s
`fillStandaloneLinkBoundaryLateTerminals` — feeds bit 1 ([[Construct]]) of the
`__js2wasm_link_callable_kind` terminal the CONSUMER's `typeof` natives read
across the wasm↔wasm link (`typeof-natives-finalize.ts`, `boundaryMask: 3`).
So a wrongly-`true` `IsConstructor(instance)` on the PROVIDER directly produces
a wrongly-`"function"` `typeof` on the CONSUMER — the S11/S22 residual's exact
mechanism, now named.

**The fix**: route both bare sites through `taCtorIdentityTestInstrs` (already
imported in the file), exactly like every other `$__ta_ctor` site.

### Mechanism B — `__isPrototypeOf` never seeds from a class instance's link

`object-runtime-prototype.ts`'s native `__isPrototypeOf` walks
`candidate.$proto`, a field that only exists on an `$Object`. A compiled class
instance is a closed `$ClassName` struct with NO `$proto` field, so
`C.prototype.isPrototypeOf(new C())` through a dynamically-typed receiver
answered `false` — even though `Object.getPrototypeOf(new C()) === C.prototype`
(#6617/S30) is already `true`. `plan/issues/6617-standalone-linked-class-instance-prototype.md`'s
R2 named this exact gap and its own recommended fix: "a future slice should
seed that walk from `__getPrototypeOf` rather than add a third prototype
mechanism."

**The fix**: `classInstanceIsPrototypeOfSeed`, mirroring the existing
`fnctorIsPrototypeOfSeed` (the #4643 precedent one function up in the same
file) — when the ordinary `$Object` cast AND the fnctor ladder have both
declined (`cur` is still null), call `__getPrototypeOf(candidate)` — the SAME
native that already composes the module-local class-instance dispatcher
(`__std_class_instance_proto`, #6617/S30) AND, on its last-resort arm, the
wasm↔wasm link-boundary hop to a PROVIDER-owned class (#6617's own fix). One
`Get(candidate, "[[Prototype]]")` answer serves BOTH the module-local and
linked case, exactly as `Object.getPrototypeOf` already does for the same
receiver shape — reusing rather than adding a mechanism, per R2's own
conclusion.

Only the FIRST link is seeded (matching the fnctor precedent): the remainder
of the chain — `Temporal.Duration.prototype` is an ordinary `$Object`, per
#6617 point 1 — walks through the EXISTING loop unmodified.

**Measured against the real provider** (`.tmp/s35/probe1.mjs`):

| probe | base | S35 |
| --- | --- | --- |
| `Temporal.Duration.prototype.isPrototypeOf(new Temporal.Duration(1))` | `"no"` | `"yes"` |
| `(new Temporal.Duration(1)) instanceof Temporal.Duration` (dynamic RHS) | `"no"` | `"no"` — unresolved residual, see below |

## Residual — `instanceof` (R2's full scope) is NOT resolved by this slice

`inst instanceof C` still answers `"no"`, module-local AND linked, because
`instanceof`'s own native (`native-dynamic-instanceof.ts`'s
`__instanceof_dynamic`) acquires `target.prototype` through a DIFFERENT
mechanism than `__isPrototypeOf` does — `ownedPrototypeOrdinaryHasInstance()`'s
`__hasOwnProperty`/`__extern_get` own-property-bag read, which has no notion of
"own properties" for a `$ClassName` class value (no property bag at all) and
therefore never obtains `L_PROTO` for a class RHS, falling through to the
conservative `false` (`closureProtoOfIdx`/`prototypeEdgeArm` also decline for a
class value, by design). Composing `__instanceof_dynamic` with
`__getPrototypeOf` the way `__isPrototypeOf` now does is a real, sizeable third
fix (a new arm in `native-dynamic-instanceof.ts`'s callable branch, parallel to
`ownedPrototypeOrdinaryHasInstance`) — reduced but not implemented in this
slice; corpus footprint unmeasured. `Temporal.Duration.prototype.isPrototypeOf`
(mechanism B, above) is fixed and is the mechanism actually behind the 3
`calendar-wrong-type` rows S17 §4 attributed to the `typeof` residual — full
`instanceof` is a separate follow-on.

## Traps and notes for the next slice

- **`new inst()` still does not throw**, on both trees, even after mechanism A
  fixes `IsConstructor(inst)` to `false`. This is `constructIsConstructorGuard`'s
  OWN documented narrowing #1 (`construct-is-constructor-guard.ts`): the throw
  fires only when `__typeof_function(callee)` says `true` first. Since mechanism
  A ALSO makes `typeof inst` correctly say `"object"`, the guard's precondition
  is now false too, so it (correctly, per its own scope) declines and the
  callee falls through to the ordinary `§10.2.2` tail, which quietly builds an
  empty object. This is not a regression from S35 — it is `constructIsConstructorGuard`'s
  pre-existing, separately-scoped residual, now reached from a DIFFERENT
  (correct) `typeof` answer than before.
- **The bug requires `$__ta_ctor` to actually be MINTED in the SAME module** as
  the colliding class — reading a TypedArray constructor's `.of`/`.from` (a
  STATIC method call) registers it; merely reading `.BYTES_PER_ELEMENT` off a
  `const T = Int8Array` binding does NOT (measured, `.tmp/s35/probe5.mjs`) — a
  narrower trigger condition than #6601/#6620's own reductions state, worth
  re-checking if a future witness for this family reads "unexpectedly still
  passing".
- **Structural-shape collisions with `$__ta_ctor` are widespread** in the real
  polyfill: `.tmp/s35`'s debug dump found 30+ field-less Temporal/helper
  classes (`TimeDuration`, `Instant`, `PlainDate`, `PlainDateTime`,
  `PlainMonthDay`, `PlainTime`, every calendar-helper class, …) sharing the
  EXACT `(i32, i32)` shape with `$__ta_ctor` in the real provider build. Any
  FUTURE bare `ref.test $__ta_ctor` site added anywhere in this backend will
  reproduce this class of bug against the real polyfill; `taCtorIdentityTestInstrs`
  is the load-bearing discriminator and grep-checking for a bare
  `ref.test.*taCtorTypeIdx` (or `ref.test.*taCtorTypeIdx` without
  `taCtorIdentityTestInstrs` nearby) is a reasonable audit for the next slice
  that touches this area.

## Verification

- **Witness**: `tests/issue-6622-typeof-instanceof-class-instance-collision.test.ts`,
  8 `it`s — 3 fix-witnesses (typeof cross-link, `Reflect.construct` newTarget
  module-local, `isPrototypeOf` cross-link) measured FAILING on the
  file-copy-reverted base and PASSING on branch; 5 controls pass on both trees
  unchanged. Compiles a SYNTHETIC provider (`ns6622`, a two-method class plus a
  dynamic-TA-construct pattern) — never the real `@js-temporal/polyfill`
  inside vitest.
- **Four-family sample** (`PlainDate`/`Duration`/`PlainDateTime`/`ZonedDateTime/prototype`,
  **first 40 files each — a reduced third of the requested 120**, see
  rationale below), `--target standalone`, real provider linked, sequential,
  fresh `JS2WASM_TEMPORAL_CACHE` per label, measured on this tree:

  | family | base pass/40 | S35 pass/40 | Δ | pass→fail | fail→pass |
  | --- | --- | --- | --- | --- | --- |
  | `PlainDate/**` | 39 | 39 | 0 | 0 | 0 |
  | `Duration/**` | 36 | 36 | 0 | 0 | 0 |
  | `PlainDateTime/**` | 39 | 39 | 0 | 0 | 0 |
  | `ZonedDateTime/prototype/**` | 25 | 25 | 0 | 0 | 0 |
  | **total** | **139/160** | **139/160** | **0** | **0** | **0** |

  Per-file diff, not just counts (`.tmp/s35/diff.py` over `.tmp/s35/fam/*.tsv`):
  **zero rows flip in either direction** in this reduced sample. This is
  expected and consistent with S30/S34's own findings: the count-neutral
  outcome does not mean the fix is inert — the `typeof`/`isPrototypeOf`
  assertions these two mechanisms answer are not the FIRST failing assertion
  in most of these 160 rows (most fail earlier, on unrelated pre-existing
  buckets), so the fix is real and reached but does not move the headline
  count for THIS sample. No `compile_error`, no `timeout`, no `__temporal_*`
  leak in either run.

  **Scope reduction, stated plainly**: this is 40 files per family (a third
  of the usual 120-file sample), NOT the full requested acceptance battery.
  The 45-file `subclassing-ignored.js` corpus-wide count, the must-not-move
  samples, the corpus byte A/B, and the remaining 80 files per family were
  NOT completed inside this session's time budget (each family third took
  ~10–20 minutes real time under the standalone compiler; a full 120×4×2
  run plus the other batteries did not fit). The next slice picking this up
  should run the 45-file family FIRST (it is the headline metric this whole
  #5383 stack is chasing) — `.tmp/s35/subclass-measure.mts` is ready to run,
  needs only a fresh prewarmed cache per label
  (`.tmp/s35/prewarm-standalone.mts`).
- **Equivalence gate**: attempted `npm run -s test:equivalence:gate` locally;
  it did NOT complete inside a 300 s budget in this container (killed by
  `timeout`, zero output produced before the kill) — the suite is heavier than
  this session's remaining time allowed for. NOT independently re-verified
  this session. Every prior S-slice in this stack (S17 through S34) reports it
  unchanged at 22 failing / 1720 passing / 22 known-failures; this PR's own
  `equivalence-gate` CI check is the authoritative answer, stated as unverified
  locally rather than assumed.
