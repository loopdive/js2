---
id: 6620
title: "standalone: `__extern_get`'s `$__ta_ctor` receiver arm used a bare ref.test, colliding with a provider class's empty-root shape and blocking a dynamic `.prototype` read on every Temporal class once ANY unrelated dynamic `new <any>(...)` armed the module (#6617 R1)"
status: done
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-16
assignee: ttraenkler/sendev-s33
loc-budget-allow:
  # 2026-09-16 (S33) — the `$__ta_ctor` receiver arm in `ta-dyn-mop.ts`
  # (`fillTaDynViewMopArms`) swapped a bare `ref.test $__ta_ctor` for the
  # established brand-VALUE-checked `taCtorIdentityTestInstrs` helper
  # (`registry/types.ts`, already used by `builtin-callable-brand.ts` and
  # `reflect-construct-native.ts` for this EXACT collision class). The growth
  # is the replacement instructions plus a doc comment recording the
  # structural-collision mechanism and the prior measurement it reproduces
  # (#5194 r3 review F1's own comment already measured the identical symptom
  # on this same provider) — not a new code path, a corrected receiver test on
  # an existing one.
  - src/codegen/ta-dyn-mop.ts
func-budget-allow:
  # 2026-09-16 (S33) — same change, same file: `fillTaDynViewMopArms` grew by
  # the doc comment above the corrected gate (the instruction-count delta
  # itself is a handful of ops: `local.tee` → `local.set` + a brand-checked
  # `if` sequence vs. a bare `ref.test`). Splitting the `$__ta_ctor` receiver
  # arm into its own function is a reasonable follow-up but is not this fix's
  # scope — the function was already over budget before this change touched
  # it (the whole file carries an inherited LOC/func allowance from #3177's
  # original slice).
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
---

# #6620 — a bare `ref.test $__ta_ctor` misclassifies a provider class's empty-root struct, breaking dynamic `.prototype` reads

## Problem

Reduced from #6617/#6619's R1 residual: a dynamic `.prototype` read on a
`Temporal.*` class through the standalone-linked `@js-temporal/polyfill`
provider answered `undefined` instead of the class's prototype object,
whenever the CONSUMER module ALSO contained any dynamic `new <any-typed
value>(...)` construct — anywhere in the module, unrelated to the class being
read. This blocked all 45 `built-ins/Temporal/**/subclassing-ignored.js`
test262 files, whose shared harness helper `checkSubclassConstructorNotObject`
does both in one function (`const p = construct.prototype; … new
construct(...constructArgs);`).

```js
function readOnly(c) { return c.prototype; }         // answers `undefined`
function justNew(c) { return new c(1); }              // unrelated construct
justNew(Temporal.Duration);                           // ANYWHERE in the module
readOnly(Temporal.Duration);                          // now broken
```

`readOnly(Temporal.Duration)` ALONE (no `justNew` call anywhere) answers
correctly.

## Root cause

S30–S32 (see "S32 findings" in #5383's issue file, and #6619's Residuals
section) reduced the trigger to `sourceHasDynamicTaConstruct`
(`source-scan-predicates.ts`, #2872) arming `ctx.moduleUsesDynTaView`
module-wide, without pinning down the exact key-specific wrong arm. This
slice reduced further by bisection:

1. **Forcing `ctx.moduleUsesDynTaView = true` alone** (no real dynamic
   construct anywhere in source) still broke a bare `readProto(Temporal.PlainDate)`
   probe with zero other module content — ruling out anything that needs an
   ACTUAL TypedArray-shaped construct site to fire.
2. Instrumenting `fillTaDynViewMopArms` (`ta-dyn-mop.ts`) showed
   `ctx.taDynViewTypeIdx` gets minted from the bare boolean alone (a chain
   through the standalone link boundary's `Object.prototype.toString`
   classifier, which calls `getOrRegisterTaDynViewType` unconditionally
   whenever the flag is set — unconditionally reserved for every
   provider-linked module).
3. **Disabling ONLY `fillTaDynViewMopArms` entirely** (with the flag still
   forced) restored the correct answer.
4. **Disabling ONLY its `$__ta_ctor` receiver arm** (the "`TA.prototype` /
   `TA.BYTES_PER_ELEMENT`" block, ~70 lines) — leaving every other dyn-view
   arm active (`get`/`has`/`set`/`delete` string-key arms, `__getPrototypeOf`,
   `__extern_length`, `__object_keys`) — ALSO restored the correct answer.
   This pinpointed the exact arm.

That arm's receiver gate was a **bare `ref.test $__ta_ctor`**:

```ts
getFn.body.unshift(
  { op: "local.get", index: 0 },
  { op: "any.convert_extern" },
  { op: "local.tee", index: cAny },
  { op: "ref.test", typeIdx: ctorIdx },          // ← bare, no brand check
  { op: "if", blockType: { kind: "empty" }, then: inner },
);
```

`ref.test` asks a purely STRUCTURAL question, and WasmGC canonicalizes
structurally-identical struct types across the WHOLE module graph (including
across a standalone link boundary — the runtime type identity is not
per-module). `$__ta_ctor` is `{kind: i32, brand: i32}`
(`registry/types.ts::getOrRegisterTaCtorType`) — **exactly** the shape of a
field-less class's compiled root: `{__tag: i32, __shape_brand: i32}`
(`class-bodies.ts` #2158/#2009, added when a hierarchy-root class has zero
instance fields and is left non-final because it has subclasses). Both
shapes were independently widened to two i32 fields to solve two DIFFERENT
prior collisions (`$__ta_ctor`'s own 1-field form collided with
`__box_boolean_struct`, #5194 r3 review F1; the empty class root's 1-field
form collided with `$AnyString`, #2158/#2009) — and the two widened shapes
then collided with EACH OTHER.

`Temporal.Duration` (and the other Temporal classes) compile to exactly this
root shape in the linked provider — their numeric fields live in an expando
side-table, not native struct fields, so the class's root struct carries only
`{__tag, __shape_brand}`. Once `ctx.taCtorTypeIdx` was armed by ANY dynamic
`new <any>(...)` in the CONSUMER, `ref.test $__ta_ctor` on
`Temporal.Duration`'s class-object value (a `$Object`-and-instance-sharing
struct per #3976) returned TRUE, and the arm's "prototype" key check matched
(the key really is `"prototype"`), returning the WRONG per-kind
TypedArray-view prototype glue instead of falling through to the correct
cross-module boundary call (`__js2wasm_link_member_get`, the SAME path a
`.name` read on the identical receiver correctly reaches — `.name` isn't
`"prototype"` or `"BYTES_PER_ELEMENT"`, so the misclassified arm's key checks
both miss and it falls through unharmed, which is why `.name` "already
worked" and only `.prototype` broke).

**This exact collision was already discovered and fixed once.** The
brand-VALUE-checked identity test `taCtorIdentityTestInstrs`
(`registry/types.ts`, #5194 r3 review F1) exists FOR THIS EXACT SHAPE
COLLISION — its own doc comment measures the IDENTICAL symptom on this SAME
provider:

> Measured 2026-09-08 on the standalone `@js-temporal/polyfill` provider:
> `typeof` through a one-parameter indirection answered `"function"` for
> `new qi.Duration(0,0,0,0,1)` and `new qi.PlainDate(2024,1,1)`; dumping the
> matched struct's two fields gave `{35, 0}` and `{33, 0}` — the class TAG
> and the `__shape_brand`, not `{kind, TA_CTOR_BRAND}`.

That fix was applied at two call sites (`builtin-callable-brand.ts`'s
`typeof` classifier, `reflect-construct-native.ts`'s `Reflect.construct`
dispatch) but **not** at `ta-dyn-mop.ts`'s `__extern_get $__ta_ctor` receiver
arm, which this fix touches — the third and (per a scan of every consult
site, see Residuals below) not the last.

## Fix

`ta-dyn-mop.ts`'s `$__ta_ctor` receiver arm now uses
`taCtorIdentityTestInstrs(ctx, [{op:"local.get", index: cAny}])` (the SAME
helper `builtin-callable-brand.ts`/`reflect-construct-native.ts` already use)
instead of a bare `ref.test`. The helper returns an i32 that is true only
when the receiver BOTH structurally matches `$__ta_ctor` AND carries the
`TA_CTOR_BRAND` sentinel in field 1 — a real `$__ta_ctor` singleton always
does (both mint sites write it), so this is answer-preserving for genuine
TypedArray constructor values and can only ever REMOVE a false positive.

## Criterion 4 — four-family sample, must-not-move groups, corpus byte A/B

Measured 2026-09-16, file-copy revert of `src/codegen/ta-dyn-mop.ts` only,
`--target standalone`, provider linked, sequential (one heavy job per Bash
call, no auto-backgrounding — each `measure.mts` invocation ran to
completion inside one foreground call), 60 s/row budget for the
Temporal-linked families, fresh `JS2WASM_TEMPORAL_CACHE` per label
(`.tmp/s33/measure-base-cache` / `.tmp/s33/measure-branch-cache`, QuickJS
present, 3 cache artifacts verified before starting):

**Provider bytes**: base 3,311,522 B → branch 3,311,544 B (**+22 B**, NOT a
null result — `ta-dyn-mop.ts` runs during the PROVIDER's own compile too,
since `@js-temporal/polyfill` carries the same internal dynamic-TA-construct
pattern that makes this defect reachable at all; +22 B matches the fix's
LOC delta). Both `cacheHit: true` on prewarm.

### Four-family sample (first 120 files each)

| family | base pass | branch pass | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| `PlainDate/**` | 110 | 110 | 0 | 0 |
| `Duration/**` | 102 | 102 | 0 | 0 |
| `PlainDateTime/**` | 112 | 112 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 |
| **total** | **427** | **427** | **0** | **0** |

Reproduces S32's own base measurement exactly (110/102/112/103 = 427) and
shows **zero net movement AND zero per-file flips** (verified by a `join`
on filename, not just count equality — the count-neutral-swap trap #2097/
edition-ratchet call out). This is an honest null result for THIS sample,
not evidence the fix does nothing: `subclassing-ignored.js` is one file per
leaf directory and — per S29/S30/S32's own corpus-wide numbers — the
family's *targeted* corpus (the 45 `subclassing-ignored.js` files
specifically) is where R1's effect actually shows (see the dedicated
45-file measurement below and in "Result"). The first-120-sorted sample and
the `subclassing-ignored.js` corpus are largely disjoint by design (test262
sorts alphabetically per directory; `subclassing-ignored.js` is not among
the first 120 in any of these four families).

### Must-not-move groups (per-file, 0 flips)

| group | base pass/total | branch pass/total | flips |
| --- | --- | --- | --- |
| A: `Object/keys` (59) | 55/59 | 55/59 | 0 |
| A: `expressions/object` (capped 500) | 476/500 | 476/500 | 0 |
| A: `Reflect/get` (11) | 10/11 | 10/11 | 0 |
| A: `Reflect/has` (10) | 9/10 | 9/10 | 0 |
| B: `Object/entries` (21) | 11/21 | 11/21 | 0 |
| B: `Object/values` (20) | 10/20 | 10/20 | 0 |
| B: `Object/getOwnPropertyNames` (45) | 42/45 | 42/45 | 0 |
| B: `statements/for-in` (119) | 116/119 | 116/119 | 0 |
| C: `built-ins/TypedArray` (first 150) | 86/150 | 86/150 | 0 |
| C: `TypedArrayConstructors/ctors` (first 100) | 60/100 | 60/100 | 0 |
| C: `expressions/member-expression` (1 — whole dir) | 0/1 | 0/1 | 0 |
| C: `statements/class/subclass` (first 100) | 55/100 | 55/100 | 0 |

Every group: **byte-for-byte identical pass/fail set** (a `join` on
filename+status, not just matching totals) — 0 flips across 1,136 rows
total. `built-ins/TypedArray` and `TypedArrayConstructors/ctors` are the
groups most likely to exercise the CHANGED `$__ta_ctor` receiver arm
directly (genuine TA constructors), and they are unmoved, confirming the
brand-check narrowing does not disturb real TA-constructor dispatch.

### Corpus byte A/B (42 modules × {gc, standalone} = 84 artifacts)

`website/playground/examples/**/*.ts` + `tests/fixtures/**/*.ts`, compiled
on both lanes, SHA-256 of the output binary: **0 of 84 moved** — every
artifact byte-identical between base and branch, `gc` lane included (the
fix is `ctx.standalone`-gated in `ta-dyn-mop.ts`, so the `gc` lane is
structurally unreachable regardless of content). A genuine null control:
none of the 42 corpus modules construct a field-less class dynamically
alongside an internal TypedArray construct, so none exercise the collision
this fix narrows.

**Equivalence gate**: unchanged — see "Result" below.

## Result

Verified against the real `@js-temporal/polyfill` provider, `--target
standalone`, host-free (`hostBridge: "off"`):

| probe | base | branch |
| --- | --- | --- |
| `readOnly(Temporal.Duration).prototype`, armed by an unrelated `new c(1)` elsewhere (r1f/r1j/w-broken shape) | `undef` | `object` |
| same receiver, `.name` (control) | `string` | `string` (unchanged) |
| `.prototype` with NO dynamic `new` anywhere (control) | `object` | `object` (unchanged) |
| a GENUINE `Uint8Array`/`Int32Array` `.prototype` / `.BYTES_PER_ELEMENT` (control) | `object` / `4` | `object` / `4` (unchanged) |

**Corpus-wide, all 45 `subclassing-ignored.js` test262 files**: every one of
them moved PAST the `.prototype` blocker — the failure message changed
uniformly from `SameValue(«null», «undefined»)` (R1's signature, the
`.prototype` read itself) to `SameValue(«null», «null»)` (a DIFFERENT,
already-documented residual: `new construct(...constructArgs)` on a
provider-linked class value still answers `null` — #6619's own Residuals
section names this as a separate mechanism, and the S30 hand-off already
recorded `new` on a dynamic construct value answering `null` in its own `p2`
probe). **0 → 0 pass for this family** — R1 is fixed and verified by the
uniform error-signature change, but a second, distinct blocker (dynamic
`new construct(...)` on a linked class returning `null`) still stops the
family from fully passing. See Residuals for the next slice.

Measured on BOTH trees by file-copy revert of `src/codegen/ta-dyn-mop.ts`
(2026-09-16, shared `JS2WASM_TEMPORAL_CACHE`, provider `cacheHit: true` on
BOTH — the provider binary is byte-identical; only the consumer's compiled
`__extern_get` differs).

**Equivalence gate**: `npm run -s test:equivalence:gate` — unchanged from
baseline (22 failing / 1,720 passing / 22 known-failures); this fix touches
only the standalone `$__ta_ctor` receiver arm, a lane the equivalence gate's
gc-target corpus never exercises (the arm is `noJsHost`-gated and standalone
`__extern_get`-only).

**Witness**: `tests/issue-6620-ta-ctor-brand-prototype-collision.test.ts`, 4
`it`s, all SYNTHETIC (no real `@js-temporal/polyfill` provider — that OOM'd
the vitest worker after ~84 s, `FATAL ERROR: Reached heap limit`, reproduced
twice; the real-provider version of this test that shipped in the first cut
of this issue is retired). The synthetic pair links a tiny npm package
(`ns6620`) exporting a field-less class `PD` whose compiled root
(`{__tag, __shape_brand}`) is made to collide with `$__ta_ctor` by giving the
PROVIDER its own internal dynamic-TA-construct pattern (`new k(4)` on a
parameter bound to `Uint8Array`) — this is what makes `PD`'s struct type and
`$__ta_ctor` land on the SAME type slot WITHIN the provider's own compile
(measured: `PD_new`'s declared return type and the provider's own
`$__ta_ctor` singleton globals share one type index once the provider
carries such a construct; `@js-temporal/polyfill` has the identical pattern
internally, which is why Duration hits this in production). 11 filler
classes ahead of `PD` push its compiler-assigned `__tag` to 11, outside
`TA_CTOR_KINDS`' 0..10 range, so the SEPARATE bare-`ref.test` site in
`ta-ctor-meta.ts` (R-other-bare-ref-test, below — real `Temporal.Duration`'s
own `__tag` is in the 30s, #5194 r3 review F1's `{35, 0}`, so production was
never exposed to that second site either) does not also intercept and mask
which arm is under test.

Base/branch counts, same synthetic pair, measured 2026-09-16 by file-copy
revert of `src/codegen/ta-dyn-mop.ts` only: **base 3 pass / 1 fail** (the
fix-witness fails: `undef` where `hasIdent=function ctorName=PD` is
expected); **branch 4 pass / 0 fail**. Full suite run alongside the other 21
`tests/issue-66*.test.ts` files: 22 files / 99 tests, all pass, ~122 s wall,
no OOM.

- Fix-witness: dynamic `.prototype` read under unrelated arming — base
  `undef`, branch `hasIdent=function ctorName=PD` (the real prototype, whose
  `.ident` method is real).
- Control 1: `.name` on the SAME armed receiver (a member read that does NOT
  chain through `.prototype`, so it is a genuine control, not a derived
  assertion of the same bug) — `string:PD` on both trees.
- Control 2: a lone `.prototype` read with no dynamic `new` anywhere —
  `hasIdent=function ctorName=PD` on both trees (the CONSUMER's own arming is
  required; the provider-side collision alone is not sufficient).
- Control 3: a genuine `Uint8Array`/`Int32Array` `.prototype`/
  `.BYTES_PER_ELEMENT` — `bpe=4 proto=object` on both trees (the fix narrows
  the arm's receiver test, it must not disable the arm for real TA ctors).

## Residuals — sized here, not given their own ids

### R-construct — `new construct(...constructArgs)` on a linked class value still answers a receiver that fails `SameValue` (blocks 45/45 `subclassing-ignored.js` files even after this fix)

Every one of the 45 files now fails at `Test262Error: […] Expected
SameValue(«null», «null») to be true` — a DIFFERENT assertion than R1's
`.prototype` read, further down `checkSubclassConstructorNotObject`. This
matches the ALREADY-DOCUMENTED residual from #5383's dispatch brief ("make
`new construct(...constructArgs)` on that value construct — it answered
`null` in S30's p2") and #6619's own Residuals section names a sibling
mechanism (`.from()`'s internal property extraction). Not reduced further in
this slice — the `.prototype` blocker was this slice's assigned target and
is fixed; this is the next layer, with its own repro budget needed. A
`dynNew(Local)`-style probe used during THIS slice's reduction (`r1j.js`)
independently showed the SAME symptom on a purely LOCAL (non-Temporal) class
(`tag(localInst)` answered `null`), which suggests R-construct may be a
GENERAL dynamic-construct-return defect, not Temporal-specific — worth
checking whether it shares a root cause with this issue's `$__ta_ctor`
collision (a genuinely-armed-by-accident receiver test somewhere in the
dynamic construct path) before assuming it needs a new mechanism.

### R-other-bare-ref-test — the SAME bare-`ref.test $__ta_ctor` collision exists at 7 OTHER consult sites, unaudited

A repo-wide grep for `ref.test` + `ctorIdx`/`taCtorTypeIdx` (excluding the
`taCtorIdentityTestInstrs`-routed sites) found bare, unbranded consults at:

- `dataview-native.ts` — 5 sites (lines ~4992, 5622, 5898, 6462, 7240 as of
  this slice)
- `property-access-dispatch.ts` — 1 site (~line 416)
- `ta-ctor-meta.ts` — 2 sites (~lines 183, 347)

Only THIS issue's site (`ta-dyn-mop.ts`) was confirmed to reproduce against
the real Temporal provider and fixed. The other 7 are the SAME shape of bug
(a bare `ref.test $__ta_ctor`/`taCtorTypeIdx` with no brand check) and are
PLAUSIBLE collision sites for the identical field-less-provider-class
scenario, but none were reduced to a concrete failing test262 row in this
slice — sizing and fixing them is future work, not assumed to be free. A scan
of every OTHER bare `ref.test` against a widened/brand-carrying WasmGC type
(not just `$__ta_ctor`) would also be worth doing generally — this is the
second time in this issue's history that "widen a struct shape to fix
collision A" created collision B with a different widened shape
(#5194 r3 F1 documents the same pattern once already).

## Traps, carried forward and added to

Everything in S26–S32 still holds (see #5383's "S32 findings", #6619's
"Traps, carried forward and added to"). One addition:

- **A `ref.test` against a struct type is a STRUCTURAL question, and WasmGC
  canonicalizes structurally-identical types ACROSS THE WHOLE MODULE GRAPH,
  including across a standalone link boundary.** Two shapes independently
  widened to escape TWO DIFFERENT prior collisions can still collide with
  EACH OTHER — widening a struct's field list to make it "unique" is only
  safe against the ONE collision it was measured against, not proof against
  future collisions with other equally-widened shapes. When a struct
  carries a discriminator field for exactly this reason (a `brand` /
  `TA_CTOR_BRAND` sentinel), a `ref.test` alone throws that discriminator
  away — every consult of such a struct's real IDENTITY (not just its shape)
  needs the VALUE check too, and a codebase-wide grep for the type's naked
  `ref.test` is the way to find every site that skipped it.
