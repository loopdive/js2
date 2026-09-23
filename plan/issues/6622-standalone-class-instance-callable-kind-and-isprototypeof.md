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
- **Four-family sample, FULL 120 files each** (`PlainDate`/`Duration`/
  `PlainDateTime`/`ZonedDateTime/prototype`), `--target standalone`, real
  provider linked, sequential, fresh `JS2WASM_TEMPORAL_CACHE` per label, each
  family run in three 40-file thirds (foreground, explicit tool timeout, never
  backgrounded by choice):

  | family | base pass/120 | S35 pass/120 | Δ | pass→fail | fail→pass |
  | --- | --- | --- | --- | --- | --- |
  | `PlainDate/**` | 111 | 111 | 0 | 0 | 0 |
  | `Duration/**` | 104 | 104 | 0 | 0 | 0 |
  | `PlainDateTime/**` | 112 | 112 | 0 | 0 | 0 |
  | `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
  | **total** | **430/480** | **430/480** | **0** | **0** | **0** |

  **Per-file diff, not just counts** (`.tmp/s35/diff_full.py` over all 12
  `.tmp/s35/fam/*-t{0,1,2}.tsv` files, 480 common rows both labels): **zero
  `pass→fail`, zero `fail→pass`, in all 480 rows.** All 480 rows are literal
  `pass`/`fail` on both labels — zero `compile_error`, zero `timeout`, zero
  `__temporal_*` leak.

  The count-neutral 0/0 result is consistent with S30/S34: the `typeof`/
  `isPrototypeOf` assertions these two mechanisms answer are not the FIRST
  failing assertion in most of these 480 rows (most fail earlier, on
  unrelated pre-existing buckets), so the fix is real and reached but does not
  move the headline count for this sample.
- **45-file `subclassing-ignored.js` corpus-wide** (the headline metric),
  `.tmp/s35/subclass-measure.mts`, `--target standalone`, real provider
  linked, per file, fresh cache each label:

  | label | pass | fail | total |
  | --- | --- | --- | --- |
  | base | 0 | 45 | 45 |
  | S35 | 0 | 45 | 45 |

  **Still 0 → 0.** Every one of the 45 rows fails with the SAME literal
  message text on both labels (`.tmp/s35/subclass-base.tsv` /
  `-branch.tsv`, byte-identical row-for-row): `Test262Error: [null ]Expected
  SameValue(«null», «null») to be true` (35 of 45 carry an extra leading
  `null ` token; 10 of 45 do not — cosmetic, the underlying assertion is the
  same either way). **Correction to an earlier draft of this
  section**: the signature is `«null», «null»`, not `«false», «true»` — the
  `«false»/«true»` text never appeared in either run's actual output.

  **What the two "null"s in that message actually are** — traced with three
  purpose-built probes (`.tmp/s35probe/debug{1,2,3}.js`, run through
  `runTest262File` with the real linked provider, `--target standalone`;
  `temporalHelpers.js`'s `checkSubclassingIgnored` runs nine checks in a fixed
  order — `checkSubclassConstructorNotObject`,
  `checkSubclassConstructorUndefined`, `checkSubclassConstructorThrows`, …
  each ending in `assert.sameValue(Object.getPrototypeOf(result),
  construct.prototype[, description])`):
  - `checkSubclassConstructorNotObject` (setting `instance.constructor =
    null`/etc. on an UN-subclassed instance) is **not** the failure —
    `Object.getPrototypeOf(result) === construct.prototype` holds (`debug1.js`:
    `p1===p2=true p1===null=false p2===null=false`). This mechanism was
    already fixed by S30/S34/this-slice's own work.
  - `checkSubclassConstructorUndefined` (the very next check — `class
    MySubclass extends Temporal.Duration { … }`, `new MySubclass()`, then
    `instance.abs()`) **is** the failure: `Object.getPrototypeOf(result)` is a
    genuine, real `null` (`debug2.js`: `p1===null=true p2===null=false
    typeof(p1)=object` — `typeof null === "object"`, consistent). So one side
    of the `«null», «null»` pair is a real bug: **the prototype link of a
    Temporal method's return value is lost specifically when the receiver is
    an instance of a user-defined `extends Temporal.X` subclass** — a THIRD,
    previously-undocumented mechanism, distinct from both Mechanism A
    (`typeof`) and Mechanism B (`isPrototypeOf`) above and distinct from the
    "Residual" `instanceof` gap (that one is about `inst instanceof C`; this
    one is about `Object.getPrototypeOf(methodCall())` on a subclass
    instance).
  - The OTHER side of the pair is a red herring, not a second null: `p2`
    (`construct.prototype`, e.g. `Temporal.Duration.prototype`) is a real,
    non-null object (`typeof p2 === "object"`, `p2 !== null`) — but
    `String(p2)` itself returns the literal text `"null"` (`debug3.js`:
    `String(p2)=null String(null)=null`, both identical text). `assert.js`'s
    `formatSimpleValue` falls back to `String(value)` for any non-primitive,
    so the harness's error-message renderer prints a real object as `"null"`
    text — a separate, narrower stringification bug (`String()`/default
    `toString()` of a provider-linked class prototype object), NOT evidence
    that `construct.prototype` is itself null. Reported here as observed, not
    root-caused — the FIRST mechanism (real `null` from a subclass-instance
    method call) is the one that actually blocks all 45 corpus files, since
    it fails the assertion regardless of how `p2` renders.

  **Next-slice pointer**: the reduced target is `Object.getPrototypeOf` (or
  whatever wasm-level prototype-link write) on the value RETURNED by a
  built-in Temporal method when `this` is an instance of a JS subclass of that
  Temporal class. That is a different code path than `__isPrototypeOf`'s
  candidate walk (Mechanism B, already fixed) — likely the constructor-linking
  step for the method's result object needs to special-case (or unwrap) a
  subclass receiver the same way `Reflect.construct`'s `newTarget` handling
  already does (#6621/S34), rather than always defaulting the result's
  prototype from the ORIGINAL (superclass) constructor. `reflect-construct-native.ts`
  and `native-dynamic-instanceof.ts` are the two files this slice and its
  predecessor already touched for adjacent mechanisms — start there.
- **Must-not-move groups, per file, both labels, file-copy revert A/B**
  (base = `git show 0a66b22d9b:<path>` for both changed source files, applied
  as a plain file copy, not a git checkout, then reverted back —
  `.tmp/s35/reflect-construct-native.ts.{base,branch}` /
  `.tmp/s35/object-runtime-prototype.ts.{base,branch}`; group A sharded across
  3 concurrent processes for wall-clock speed, driver `.tmp/s35/mnm-shard.mts`,
  combined before diffing):

  | group | rows | base pass | S35 pass | flips |
  | --- | --- | --- | --- | --- |
  | A: `Object/keys` (59) + `expressions/object` (1170) + `Reflect/{get,has}` (21) | 1250 | 1125 | 1125 | 0 |
  | B: `Object/{entries,values,getOwnPropertyNames}` (86) + `for-in` (119) | 205 | 179 | 179 | 0 |
  | C: `typeof` (16) + `instanceof` (43) + `isPrototypeOf` (10) + `Reflect/construct` (10) + `subclass` first 100 | 179 | 122 | 122 | 0 |

  **1,634 rows total, 0 flips in either direction on any group.** Driver
  `.tmp/s35/mnm.mts` (single-process, groups B/C) and `.tmp/s35/mnm-shard.mts`
  (3-way sharded, group A only — same file list and per-file 30 s timeout,
  split `i % 3 === shardIdx`); diffed with `.tmp/s35/diff_mnm.py`
  (base-vs-branch per file, common-row pass/fail only).
- **Corpus byte A/B** (42 modules under `website/playground/examples` +
  `tests/fixtures`, × {`gc`, `standalone`} = 84 compiles per label,
  `.tmp/s35/corpus.mts`, sha256[:16] of the compiled binary):

  | lane | artifacts | moved | note |
  | --- | --- | --- | --- |
  | `gc` | 42 | 0 | byte-identical, expected — this fix is standalone-only |
  | `standalone` | 42 | 14 | see below |

  **0/42 `gc`-lane artifacts moved** (confirms the fix is gated correctly to
  standalone). **14/42 `standalone`-lane artifacts moved** — every moved
  artifact still compiles `ok` (no new `CE`/`THREW`; only the byte content
  changed). This is NOT a null result and is not claimed as one: both touched
  files (`reflect-construct-native.ts`, `object-runtime-prototype.ts`) are
  shared standalone-runtime natives compiled into every module that reaches
  the changed code paths, so any module touching `Reflect`/dynamic-class/
  prototype machinery is expected to move. The other 28/42 modules don't
  reach the changed natives (dead-code elimination trims them), hence 0 B
  bytes moved there. Moved: `benchmarks.ts`, `benchmarks/helpers.ts`,
  `js/algorithms.ts`, `js/async.ts`, `eslint-shims/{debug,espree,esquery}.ts`,
  `ir-retirement/{class-closure,dynamic,entry,math}.ts`,
  `issue-3521-r2-multi-entry.ts`, `npm-resolve/entry.ts`,
  `strict-mode/needs-host.ts`.
- **Equivalence gate**: `npm run -s test:equivalence:gate`, run to completion
  this session (no timeout truncation) — **22 failing, 1720 passing, 22
  known-failures in baseline. No new regressions.** Matches every prior
  S-slice in this stack (S17 through S34) exactly.
