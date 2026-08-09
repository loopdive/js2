---
id: 2106
model: fable
fable_role: spec
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: done
completed: 2026-07-24
model: fable
fable_role: spec
sprint: 76
created: 2026-06-11
updated: 2026-07-24
split_note: "2026-07-24 (lead-approved split): the P3 headline deliverable — the observable-`undefined` channel — SHIPPED via PR #1701 (commit 347f3c79a). Marked `done` against that shipped scope. The OPEN value-rep numeric-leg remainder (S1 standalone $undefined singleton + S2 sNaN + S3 number|undefined→externref + S4 union-collapse + typeof-null) is atomic fable/value-rep substrate and is carved into #3580 (tagged value-rep-substrate). Full diagnosis history stays in this body; #3580 is the live tracker for the remainder."
s1_note: "S1 (standalone tag-1 $undefined singleton) NOT COMPLETE — PR #2025 was AUTO-PARKED in merge_group (2026-06-24): standalone high-water floor breached (pass 23729 vs mark 24956), NET −1245 test262 rows (1654 regressed / 409 gained). Root cause (diagnosed by sdev-s1fix 2026-06-25, see '## S1 merge_group regression — diagnosis'): S1.1 flipped the CONSUMER __extern_is_undefined to singleton-only but did NOT flip the matching PRODUCERS (notably __extern_get's missing-key return at object-runtime.ts:856, still ref.null.extern), so destructuring/param defaults stop firing. This is the architect-spec's full ~40-site producer+consumer sweep done as a partial subset — there is NO narrow floor-saving fix. RESOLUTION 2026-06-25: S1.1+S1.2 behavioral flips REVERTED on the branch (kept inert S1.0); PR #2025 re-targets to a floor-neutral revert. S1 to be re-landed as a fully-scoped complete sweep (architect re-spec). REMAINING slices unchanged: S2 (sNaN carve-out), S3 (number|undefined→externref), S4 (union-collapse reversal), typeof-null→object."
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2004, 2051, 2030, 2001]
# (#3102) PR-1 array-absence producer completion adds gated singleton arms +
# explanatory comments to three god-files (destructuring-params +13, type-coercion
# +13, array-methods +11). The growth is intended (byte-inert flag-OFF producer
# fixes at their canonical sites, not a barrel/driver); allow it for this change-set.
#
# (#2106 PR-3) hoisted-var RegExp-match undefined-init retype fix: hoist gate in
# index.ts (+14, hoistVarDecl is the canonical hoist site) + the retype predicate
# in statements/variables.ts (+23). Byte-inert flag-OFF, at the canonical sites.
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/type-coercion.ts
  - src/codegen/array-methods.ts
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
origin: "2026-06-11 analysis program (report 02 phase P3); stub 08-E21"
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): SUSPENDED, not dev-claimable as a fresh sprint task. P3 headline landed (PR #1701, commit 347f3c79a). The remaining S1 standalone $undefined tag-1 singleton is an ATOMIC ~40-site change (producer flip breaks all ref.is_null nullish consumers) — see memory project_2106_undefined_singleton_s1_atomic; branch issue-2106-s1-undefined-singleton. Resume-only for a senior-dev (max effort), NOT a routine sprint-65 dev pull. → backlog."
---

# #2106 — T | undefined collapses to bare T

> **DONE (2026-07-24, lead-approved split).** The P3 headline — the observable-
> `undefined` channel — shipped via **PR #1701** (commit `347f3c79a`). This issue
> is `done` against that shipped scope. The OPEN value-rep numeric-leg remainder
> (S1 standalone `$undefined` singleton + S2–S4 + typeof-null) is atomic
> fable/value-rep substrate, now tracked in **#3580**. The full diagnosis history
> below is retained as reference for #3580.

> **2026-06-26 — rescheduled to s67 (upcoming).** PR #1961 (standalone strict-eq
> over type-erased nullish — the manual rep-block partial) CLOSED as superseded.
> The standalone `===`/`!==` nullish observability it targeted is delivered by S1
> (the `$undefined` tag-1 singleton), to be re-landed as the architect-re-spec'd
> full producer+consumer sweep (a partial S1 subset breaches the standalone floor
> — see #2025).

## Problem

`T | undefined` collapses to bare T at the type mapper, so undefined
becomes NaN/0 in numeric carriers and is unobservable to `===`/`??`/`?.`/
typeof/ToString (#2004 codePointAt, optional-chain representation #2051
slug, #2030 exhausted .value, the #2001 destructuring addendum). In
standalone mode `undefined` and `null` are the SAME bit pattern
(ref.null extern) — indistinguishable by construction.

## Root cause

Union collapse at index.ts:9108-9117 / type-mapper.ts:79-99; observers
never check the existing sNaN sentinel; late-imports.ts:535-543
null-extern fallback. No standalone `$undefined` singleton.

## Fix direction

Per the value-rep spec P3: standardize the sNaN sentinel
(0x7FF00000DEADC0DE) for `number|undefined` carriers with observer
support; reverse union collapse behind a feature flag with measured
blast radius; add the standalone tag-1 `$undefined` singleton global.
Erasure stays for pure ToNumber/ToBoolean sinks (proven sound).

## Acceptance criteria

- `codePointAt(oob) ?? -1`, `=== undefined`, typeof, and stringification
  observe undefined in both modes; null vs undefined distinct standalone
- Flag-gated collapse reversal lands with perf/size measurements

## Ownership reconcile (#2142, 2026-06-15) — READ BEFORE DISPATCH

#2142 reconciled the two-document conflict (this issue's `UNDEF_F64` sentinel
vs #2051's externref widening). Authoritative decision in
[`2142-undefined-rep-owner-reconcile.md`](2142-undefined-rep-owner-reconcile.md#decision-authoritative--2026-06-15-arch1).
Net effect on this issue's scope:

**Decision rule:** widen to **externref + host `undefined`** when the value
must be observable to `===`/`!==`/`typeof`/ToString/`??`; use the **sNaN
sentinel** only inside hot f64 carriers whose sole consumer is
`emitDefaultValueCheck` (destructuring/default-parameter reads, array/tuple
holes).

**Producer list — #2051's sites are REMOVED from this issue.** The
optional-chain short-circuit sites (`a?.b` / `a?.[i]` / `a?.m()`) are owned by
**#2051** (externref widening, per its own `## Implementation Plan`). Do **not**
apply the `UNDEF_F64` sentinel to optional-chain sites — that channel cannot
reach `===`/`typeof`/ToString (verified: `=== undefined` on an f64 is
unconditionally `false`, `binary-ops.ts:479-482`; the sNaN sentinel is observed
*only* by `emitDefaultValueCheck`, `shared.ts:418`).

**This issue's remaining scope after the reconcile is three disjoint pieces:**

1. **General `number|undefined` observability → externref.** For
   `number|undefined` carriers consumed by `===`/`!==`/`typeof`/ToString/`??`
   (NOT optional-chain — those are #2051), widen to externref + host
   `undefined`, composing with the #2072/#2104 value-rep boxing. This is the
   same mechanism #2051 uses, applied to the non-optional-chain producers.
2. **Codify the sNaN sentinel carve-out (erasure stays).** The existing
   `0x7FF00000DEADC0DE` sentinel for default-check / hole carriers
   (`type-coercion.ts:2672`, `emitDefaultValueCheck`) is **kept** — erasure is
   proven sound for pure ToNumber/ToBoolean and default-initializer sinks. Do
   not widen these to externref (hot path, zero observability gain).
3. **Standalone `$undefined` singleton.** Add the standalone tag-1 `$undefined`
   global so `undefined` is distinct from `null` in standalone mode
   (`late-imports.ts:553-571` currently falls both back to `ref.null extern`).
   This is orthogonal to the host-vs-sentinel choice and aligns with #2104's
   JsTag module.

**Do NOT re-claim `codePointAt(oob) ?? rhs`** — already shipped via the
`??`-site NaN special-case (`logical-ops.ts:208-216`, `isCodePointAtCall`);
#2004 is `done`. Neither this issue nor #2051 touches it.

The flag-gated union-collapse reversal (index.ts:9108-9117 /
type-mapper.ts:79-99) stays in this issue's scope and lands with the
perf/size blast-radius measurement as the acceptance criteria require.

## Dupe check

Symptom issues filed; the representation phase is unfiled. New (analysis
program).

## Implementation Plan — 4 slices (sdev1, 2026-06-15)

Decomposed per the #2142 authoritative reconcile (3 disjoint pieces + the
flag-gated reversal). Each slice is an independently green-mergeable PR. Built
on #2104's `value-tags.ts` (`JsTag.Undefined`, `boxToAny`). Slice order is
risk-ascending.

### S0 — array-element boolean tag-recovery (cleanest first slice; tag-recovery root)  ← START HERE

Per the tech-lead's reframe (own the `any`=externref / tag-recovery root, not the
literal "undefined" text), the cleanest highest-leverage entry point is a pure
`boxToAny(jsStaticType)` application — no representation widening, no flag.

**Concrete bug (host mode, verified @ 2026-06-16):** a boolean stored in `any[]`
loses its tag on read-back —
- `const a: any[] = [true]; typeof a[0]` → `"number"` (should be `"boolean"`)
- `const a: any[] = [true]; "" + a[0]` → `"1"` (should be `"true"`)
- string/number elements are fine; `a[0] === true` is fine (so the value is
  stored, only the TAG is wrong).

**Root cause (WAT-confirmed):** the array-literal `[true]` builds an i32 array,
then the typed-array→`any[]` promotion copy-loop boxes each element by **Wasm
kind**: `array.get; f64.convert_i32_s; call __box_f64` → tag-3 **number** instead
of tag-4 boolean. This is the §1.1 "i32 boxes as number" disease at the
**vec→any-vec coercion** site (a `coerceType(elem→AnyValue)` inside the array
promotion, NOT the literal fast-paths).

**Fix:** thread the source array's **element static type** into that box site and
call `boxToAny(ctx, fctx, from, jsStaticType(elemType))` (#2104 API) — `[true]`'s
element type is `boolean` → `__box_bool` (tag 4). Find the vec→any-vec promotion
copy-loop emitter (grep the `array.new_default` + per-element box near the
typed-array→`any[]` coercion in `type-coercion.ts`/`literals.ts`); pass the TS
element type already available at the coercion call site. Smallest, safest
tag-recovery slice; pure #2104 composition; host-reproducible test gate.

#### S0 fix-site correction (sdev7, 2026-06-16 — investigated before #1503 merged)

The plan's "thread the TS element type into the vec→any-vec copy-loop
(`emitVecToVecBody`)" is **not viable at that site** — I traced it end to end:

- The actual lossy box is at `type-coercion.ts:887`, inside `emitVecToVecBody`,
  reached via `coerceType → emitSafeStructConversion (type-coercion.ts:680-704)`.
  That whole path is **purely Wasm-type-driven** (it works from `fromTypeIdx`/
  `toTypeIdx` and `getVecInfo`'s `ValType` element only). The TS `boolean` type is
  already fully erased there.
- **WAT-confirmed the disease**: `[true]` builds `__vec_i32` (`array.new_fixed
  10 1`), then the copy-loop does `array.get 10; f64.convert_i32_s; call 1`
  (`__box_number`, tag 3). And critically: **`boolean[]` and `number[]` SHARE
  `__vec_i32`** — the vec types are named by Wasm kind (`__vec_i32`/`__vec_f64`/
  `__vec_externref`), there is NO `__vec_boolean`. So the boolean tag is
  irrecoverable from the source vec type alone at `emitVecToVecBody`.

**Correct fix site = `compileArrayLiteral` (`literals.ts:2691`), not the
coercion.** The literal already calls `getContextualType(expr)` and the
per-element TS types are available there (`getTypeAtLocation(el)`). For `[true]`
the contextual type IS `any[]`, but the element-type selection at
`literals.ts:2872-2933` only adopts the contextual element type when the first
element resolves to a **ref** (`:2886` guard) — `boolean→i32` is not a ref, so
the `any` context is dropped and `elemWasm` stays `i32`, building `__vec_i32` and
deferring the lossy coercion. **Fix:** when the contextual element type is `any`
(`isAnyValue` of the resolved contextual element, or `getContextualType` element
= `any`), set `elemWasm` to the `$AnyValue` ref type and, in the non-spread
element loop (`:2942-2961`), box each element with
`boxToAny(ctx, fctx, <elemWasm-of-el>, jsStaticType(getTypeAtLocation(el)))`
instead of `compileExpression(…, elemWasm)` + a downstream Wasm-kind coerce. This
builds an AnyValue-vec directly with the right per-element tag (`true`→tag-4),
eliminating the i32-vec→any-vec coercion for this shape entirely. It is the spec
§2.2 literal-fast-path pattern #2104 already preserves, extended to the `any[]`
target. Scope strictly to `contextual elem === any` so number[]/string[]/struct[]
vecs are byte-identical (no blast radius outside `any[]` literals). Test gate:
the host repros above + a standalone variant; guard the heterogeneous mixed case
`[true,1,"x"]` (each element boxed by its own `jsStaticType`).

### S1 — standalone `$undefined` singleton (so undefined ≠ null in standalone)

- **Today**: `emitUndefined` (`src/codegen/expressions/late-imports.ts:563`)
  falls back to `ref.null.extern` in `nativeStrings`/standalone — undefined and
  null share the bit pattern. `ensureGetUndefined` (:553) returns undefined in
  standalone; `__extern_is_undefined` standalone convention is bare
  `ref.is_null` (so it can't tell them apart).
- **Change**: add an immutable module global `$undefined : ref $AnyValue` (tag 1,
  built via the tag-1 box / `JsTag.Undefined`), emitted once lazily (like
  `ensureAnyValueType`). Standalone `emitUndefined` returns `global.get
  $undefined` instead of `ref.null.extern`. Standalone `__extern_is_undefined`
  becomes "ref.eq against `$undefined`" (or tag==1 check) rather than
  `ref.is_null`. `null` stays `ref.null.extern`.
- **HAZARD (#329, documented at late-imports.ts:545)**: introducing a
  standalone undefined value that is NOT `ref.null.extern` must NOT add a late
  import *after* the native-string helpers are emitted — that drives
  `reconcileNativeStrFinalizeShift` an extra time and off-by-ones the baked
  `__str_flatten`→`__str_copy_tree` call. Mitigation: the `$undefined` global is
  a GLOBAL (not a func import) and must be reserved up-front (at
  `ensureAnyValueType` time), so no late func-index shift. Verify with the #329
  repro (`let g: any; g = function(){…}; g()`) standalone.
- **Blast radius**: `emitUndefined` callers (28 `__get_undefined` sites) +
  standalone `__extern_is_undefined` consumers (~10 files). Gate every change on
  `ctx.standalone`/`nativeStrings` so host mode is byte-identical.
- **Test gate**: `(undefined === null)` → false, `(undefined == null)` → true,
  `typeof undefined` → "undefined" vs `typeof null` → "object", all standalone.

### S2 — codify the sNaN sentinel carve-out (erasure stays)

- Document + guard the existing `0x7FF00000DEADC0DE` sentinel
  (`type-coercion.ts:2672`, `emitDefaultValueCheck` at `shared.ts:418`,
  consumers at `destructuring-params.ts:830`, `literals.ts:1759/2317/2886`) as
  the ONE sanctioned f64-undefined channel — sole consumer
  `emitDefaultValueCheck`. Route it through `value-tags.ts`'s `UNDEF_F64_BITS` /
  `pushUndefF64` / `emitIsUndefF64` (P1 already centralized these). No behaviour
  change — consolidation + a comment/invariant that these f64 carriers are
  default-check-only and must not be widened. Small.

### S3 — general `number|undefined` → externref widening (NON-optional-chain)  ← HIGHEST IMPACT, host-reproducible

**Concrete failing cases (host mode, verified on the #2104 branch @ 2026-06-16)
— these are the S3 test gates:**

| Repro | Got | Expect | Why |
|---|---|---|---|
| `[1,2,3].find(x=>x>5) === undefined` | `0` (false) | `1` | `find` miss returns the f64 NaN-sentinel, not observable undefined |
| `function f(x?: number){return x ?? -1} f()` | `NaN` | `-1` | optional numeric param absent → f64 NaN-sentinel; `??` short-circuits "never nullish" on f64 (`logical-ops.ts:188-191`) |
| `typeof [1].find(x=>x>5) === "undefined"` | `0` | `1` | typeof of the f64 carrier can't observe undefined |

`Map.get` miss already works (returns externref). So the broken producers are
the ones carrying `T|undefined` as **bare f64**: `Array.find`/`findLast`-family
(`array-methods.ts`) and **optional numeric parameters** (param prologue /
`destructuring-params.ts`). NOT optional-chain (#2051), NOT default-check
carriers (S2 keeps the sentinel there).

- **Fix (per #2142 rule)**: widen these carriers to externref + host `undefined`
  (host) / `$undefined` tag-1 (standalone, needs S1), composing with
  #2072/#2104 `boxToAny`. Producers emit `emitUndefined` (externref) for the
  absent case instead of `f64.const NaN`; their result ValType becomes externref
  so the existing externref-aware `===`/`??`/`typeof` observers (already
  discriminate, #2142 fact 1) light up with zero new observer code. Reuse
  #2051's widening mechanism (`variables.ts:100-102` `isNullablePrimitiveType`).
- **Watch**: changes `find`/optional-param result type f64→externref — measure
  the test262 delta (arithmetic-on-find-result may need an unbox). Medium-risk;
  gate carefully.
- **Decision rule (from #2142)**: widen when observable to the general
  nullish/identity/stringify set; sentinel only for the S2 default-check carriers.

### S4 — flag-gated union-collapse reversal (RISKY, last)

- The blanket `T|undefined`/`T|null` → bare `T` collapse at
  `index.ts:9108-9117` (`resolveWasmType`) / `type-mapper.ts:79-99`
  (`mapTsTypeToWasm`) is the erasure factory. Reverse it **behind a feature
  flag**, only for Null/undefined-bearing unions where observability is needed
  (rule §2.4(3)), and **measure perf/size + test262 blast radius before
  default-on** (acceptance criterion). This is the only slice with uncertain
  test262 delta — flag + measure-first protocol is mandatory.

### Sequencing / notes

- All slices need #2104 (`value-tags.ts`) merged. Build stacked on the #2104
  branch until #1503 lands, then branch from origin/main.
- S1 + S2 are clean/self-contained; S3 is medium; S4 is the risky flagged one
  and should land last with measurements. Recommend S3/S4 get fresh
  max-reasoning context.
- `codePointAt(oob) ?? rhs` is already done (#2004, `logical-ops.ts:208`) —
  do NOT re-represent it. Optional-chain sites are #2051 — do NOT touch.

## S3 producer map (sdev7, 2026-06-16) — exact sites, verified on main @ 24e520df8

Confirmed the S3 host repros still fail and pinned the producers, so S3 is
turnkey for its own focused (measure-first) PR:

**Repros (host, all reproduce):**
- `[1,2,3].find(x=>x>5) === undefined` → `0` (want `1`)
- `typeof [1].find(x=>x>5)` → `"number"` (want `"undefined"`)
- `function f(x?:number){return x ?? -1} f()` → `NaN` (want `-1`)
- `function f(x?:number){return typeof x} f()` → `"number"` (want `"undefined"`)
- `function f(x?:number){return x === undefined} f()` → `0` (want `1`)
- Working (keep green): `f(5)`→5, `f(0) ?? -1`→0 (0 is not nullish), `find` HIT
  cases, the generic externref-array `find` (already `ref.null.extern`).

**Producer 1 — typed/numeric `find`/`findLast` fast-path.** The GENERIC array
`find` (`array-methods.ts:856`) already returns `externref` with a
`ref.null.extern` miss — but the numeric/typed fast-path returns an **f64 NaN
sentinel**: `array-methods.ts:6522-6529` (`find`) and `:6712-6719` (`findLast`):
`findResType = ctx.fast ? elemType : { kind: "f64" }`, miss = `f64.const 0;
f64.const 0; f64.div` (NaN). For `number[]` the result local is f64
(WAT-confirmed: `$__arr_find_res_9 f64`), so the miss is unobservable to
`===`/`typeof`/`??`. Widen the **non-fast** branch's miss to `emitUndefined`
(externref) and the result type to externref; the `ctx.fast` i32 branch is a
separate (native-int) story — scope carefully.

**Producer 2 — absent optional numeric parameter.** `f(x?: number)` called with
no arg materializes `x` as an f64 NaN sentinel (param prologue /
`destructuring-params.ts` default-fill), so `x ?? -1`→NaN, `typeof x`→"number",
`x === undefined`→false. Widen the absent-optional-numeric-param carrier to
externref + host `undefined` (standalone needs S1's `$undefined`).

**Mechanism (per #2142 rule):** both producers emit `emitUndefined` (externref)
for the absent case instead of `f64.const NaN`; result ValType becomes externref
so the existing externref-aware `===`/`??`/`typeof` observers light up with zero
new observer code (#2142 fact 1). Reuse #2051's widening helper
(`variables.ts` `isNullablePrimitiveType`).

**RISK / measure-first (why this is its own PR):** changing `find`/optional-param
result type f64→externref means any **arithmetic** on the result needs an unbox
(`arr.find(...) + 1`, `f() * 2`). Must measure the test262 delta before
default-on; gate carefully and check the arithmetic-on-result paths. Standalone
correctness depends on S1 (`$undefined` ≠ `null`). Recommend: land S1 first (or
concurrently), then S3 with a CI-measured blast radius.

### S3 Producer-1 attempt + box-protocol blocker (cs-2158, 2026-06-18)

Attempted S3 Producer-1 (find/findLast numeric miss → externref) in isolation:
widened the **non-`ctx.fast`** branch of `compileArrayFind`/`compileArrayFindLast`
(`array-methods.ts`) so the result carrier is externref — found element boxed via
`coerceType(elemType→externref)`, miss = `emitUndefined`, return type externref.
**Partial success:** `typeof [1].find(x=>x>5)` correctly became `"undefined"`.
**But a runtime regression blocks it:** even a plain HIT (`[1,2,3].find(x=>x>1)!`
→ expect 2) and `findLast` HIT throw `RuntimeError: dereferencing a null
pointer` at runtime, through the real equivalence harness (not a probe-env
artifact). The emitted WAT looked correct in isolation (`local.set $res
(call $__box_number $elem)` on hit, `call $__unbox_number $res` on return), so
the null-deref is a **box/unbox-protocol mismatch** between the find-result
externref and how the consuming numeric/`!`-assertion context unwraps it (the
`__box_number`↔`__unbox_number` round-trip derefs null in this configuration —
likely a `$AnyValue`-struct vs host-box shape mismatch, or a double-unbox via the
`!` + numeric coercion path). `Map.get` miss `=== undefined` works (externref
baseline), so externref *results* are consumable — the break is specific to the
find-result→numeric-consumer coercion.

**Conclusion:** S3 is NOT a tractable single slice — it needs dedicated
max-reasoning work to align the find-result box protocol with the numeric
consumer/`!`-assertion unwrap (and likely should land **after/with S1** and a
measured test262 run, as the plan already says). Reverted the attempt cleanly
(no code landed). Next agent: investigate why `__unbox_number(__box_number(x))`
null-derefs in the find-HIT consuming context before re-widening — that
box-protocol fix is the real prerequisite, not the find emit site itself.

## S1 — Architect spec: standalone tag-1 `$undefined` singleton (sdev-async, 2026-06-23)

Promoted from "fix direction" to a concrete, ripple-mapped implementation plan
after the **S1a hold** (PR #1961) proved no inline strict-eq fix can split
null/undefined while they share the `ref.null extern` bit pattern. S1 gives
`undefined` a **distinct representation** so all four nullish strict-eq cases —
and `typeof`, `Object.is`, `in`-vs-undefined — resolve correctly. Verified
against `origin/main` @ `c8cd5ba8f`; re-grep anchors if drifted.

### The core decision: undefined = a tag-1 `$AnyValue` singleton; null = `ref.null extern`

In standalone (`ctx.nativeStrings`/`ctx.standalone`) there is no host `undefined`.
Today `emitUndefined` (`late-imports.ts:596`) falls back to `ref.null.extern` —
**identical to `null`**. The fix: a single immutable module global
`$undefined : (ref $AnyValue)` holding a **tag-1** box
(`{tag:1, i32val:0, f64val:NaN, refval:null, externval:null}` — the exact shape
`__any_from_extern`'s `nullAny` already synthesises at `any-helpers.ts:186-193`).
`null` stays `ref.null extern`. The two are then distinguishable everywhere a
value flows as an externref/anyref because undefined is a *non-null* ref to the
singleton, while null is a true null.

### HARD CONSTRAINT — the null-vs-undefined RIPPLE is the whole difficulty

This is NOT a localised change. The blast radius (measured on `origin/main`):
- **33** `emitUndefined(...)` call sites (the producers).
- **35** `__extern_is_undefined` emit sites + its native impl (`index.ts`
  registers it as bare `ref.is_null` in standalone — `index.ts:4300` comments
  the convention).
- **42** `ref.is_null` uses across `src/codegen/`, of which **~13** are
  *undefined-specific* checks and the rest are genuine null / generic-nullish
  checks.

The danger: making undefined a non-null singleton **breaks every `ref.is_null`
site that currently relies on "undefined IS null"** to detect undefined. Those
fall into three classes that MUST be triaged individually:

1. **Genuine nullish checks (`== null`, `?.`, `??`, default-value fill,
   array-hole, `Object.is` SameValueZero on nullish)** — these want BOTH null and
   undefined to count. After S1 a bare `ref.is_null` no longer catches the
   undefined singleton, so each must become `is_null(x) || is_undefined_singleton(x)`.
   **This is the dominant ripple and the #1 regression source.** Centralise it:
   add `emitIsNullish(ctx, fctx)` (= `ref.is_null` OR ref.eq-against-`$undefined`)
   and route every nullish consumer through it.
2. **Undefined-specific checks (`=== undefined`, `typeof x === "undefined"`,
   `void`-result, optional-param absence)** — these want ONLY undefined. After S1
   they become `is_undefined_singleton(x)` (ref.eq vs `$undefined` / tag==1),
   NOT `ref.is_null`. The `__extern_is_undefined` native impl flips from
   `ref.is_null` to the tag-1 check.
3. **Null-specific checks (`=== null`, `typeof x === "object" && !x`)** — want ONLY
   null. These STAY `ref.is_null` AND must additionally EXCLUDE the undefined
   singleton (a non-null ref) — which they already do, since the singleton is
   non-null. Low risk; audit only.

### HAZARD — #329 native-string finalize shift (documented at late-imports.ts:581-584)

A standalone undefined value that is NOT `ref.null extern` must NOT be introduced
via a **late func import added AFTER the native-string helpers are emitted** — that
re-drives `reconcileNativeStrFinalizeShift` and off-by-ones the baked
`__str_flatten`→`__str_copy_tree` call (#329 repro: `let g: any; g = function(){…};
g()` → invalid wasm). Mitigation: `$undefined` is a **GLOBAL**, not a func import,
and is reserved **up-front at `ensureAnyValueType` time** (`any-helpers.ts:23`) so
no late func-index shift occurs. The global's init (a `struct.new $AnyValue`) is a
constant expression — emit it in the module's global-init, never lazily mid-body.

### Staged plan (each stage independently green-mergeable; gate every change on `ctx.standalone`/`nativeStrings`; host mode byte-identical)

- **S1.0 — reserve the singleton (INERT).** At `ensureAnyValueType`, also register
  the `$undefined` global (tag-1 `$AnyValue`, constant init). Add
  `ctx.undefinedGlobalIdx?: number`. Add two emit helpers in `late-imports.ts`:
  `emitUndefinedSingleton(ctx, fctx)` (`global.get $undefined`) and
  `emitIsUndefinedSingleton(ctx, fctx)` (recover tag, `i32.eq 1` — or `ref.eq`
  against the singleton when the operand is already a `ref $AnyValue`). Nothing
  calls them yet. *Acceptance: existing standalone tests byte-identical; the global
  appears but is unreferenced.*
- **S1.1 — flip the producers + the undefined-specific consumers TOGETHER.**
  Standalone `emitUndefined` → `emitUndefinedSingleton`; `__extern_is_undefined`
  native impl → tag-1 check; the `=== undefined` / `typeof === "undefined"`
  consumers → `emitIsUndefinedSingleton`. These MUST land in one PR (a producer
  flip without the matching undefined-consumer flip, or vice-versa, is a
  half-state that regresses). *Acceptance: `undefined === undefined` true,
  `null === null` true, `null === undefined` FALSE, `typeof undefined` →
  "undefined" vs `typeof null` → "object" — all standalone, the issue's S1 test
  gate. PLUS the strict-eq cascade in `binary-ops.ts` now distinguishes them with
  NO `bothNullishGuard` collapse (this is where #1961's held guard becomes correct
  — re-key it on the singleton, not bare `ref.is_null`).*
- **S1.2 — sweep the nullish consumers (the ripple).** Route every `== null` /
  `?.` / `??` / default-fill / array-hole / SameValueZero-nullish site through the
  new `emitIsNullish` so they still catch the undefined singleton. This is the
  largest, most regression-prone stage — do it last, with a full `merge_group`
  baseline (value-rep broad-impact protocol — NEVER a scoped sweep, per
  `project_broad_impact_validate_full_ci`). *Acceptance: `undefined == null` true,
  `x ?? y` fires for undefined, `a?.b` short-circuits on undefined, destructuring
  default fires for undefined, no test262 regression.*

### #329 + funcIdx-authority cross-check (#1899)
S1 lands after #1899's funcIdx-authority contract (task #36, done) — verify the
`$undefined` global reservation composes with the finalize-shift accounting; the
global path avoids the func-shift entirely but confirm the global-index
accounting (`ctx.numImportGlobals + ctx.mod.globals.length`) is taken at
reservation time, not lazily.

### Why this is the real fix (and #1961 is held, not abandoned)
#1961's `bothNullishGuard` is correct in shape but, keyed on bare `ref.is_null`,
collapses null/undefined. Once S1.1 gives undefined distinct bits, that same guard
— re-keyed on `is_null(x) || is_undefined_singleton(x)` for the loose arm and the
plain tag check for strict — becomes exactly right. So #1961 stays open as the
diagnosis + repro harness and folds into S1.1/S1.2. The acceptance-criterion
"null vs undefined distinct standalone" is met ONLY by S1, not by #1961 alone.
## Producer/consumer site inventory for the S1 re-land (architect re-spec input)

> CONTEXT (2026-06-25): S1.1 + S1.2 behavioral edits are REVERTED on this branch
> (kept only the inert S1.0 reservation). The section below was originally the
> "Suspended Work — S1.0 done + S1.1 WIP" note; it is RETAINED because it is the
> most complete enumeration of the producer/consumer sites the full atomic S1
> sweep must flip in lockstep. The architect re-spec should expand THIS into the
> exhaustive site list. The "Landed/committed" and "repro status" lines below
> describe the now-REVERTED S1.1 state — read them as the *plan*, not current
> branch state.

**Branch:** `issue-2106-s1-undefined-singleton`
**State (HISTORICAL — now reverted):** S1.0 (inert singleton reservation) is
COMPLETE + validated. S1.1/S1.2 (producer + chokepoint + equality flips) were
implemented but REVERTED 2026-06-25 (incomplete subset, −1245 floor breach).

### Landed (committed)
- **S1.0** (commit on branch): `$undefined` tag-1 global reserved at
  `ensureAnyValueType` (`any-helpers.ts`), `ctx.undefinedGlobalIdx`,
  `emitUndefinedSingleton` / `emitIsUndefinedSingleton` helpers. Inert, validated.
- **S1.1 WIP** (this checkpoint):
  - `emitUndefined` (`late-imports.ts`): standalone → `global.get $undefined` +
    `extern.convert_any` (was `ref.null.extern`).
  - `__extern_is_undefined` (`object-runtime.ts`): singleton-only (recover anyref,
    `ref.test $AnyValue`, tag==1); legacy `ref.is_null` fallback when no `$AnyValue`.
  - `__typeof_undefined` (`index.ts`): singleton-only (same tag-1 test).
  - strict-eq cascade (`binary-ops.ts`): the loose-only nullish guard is now
    applied to BOTH modes (`(lNull||rNull)?(lNull&&rNull):core`) — correct under S1
    because undefined is the non-null singleton.

### Repro status (`tests/issue-2106-standalone-nullish-strict-eq.test.ts`)
PASS: `null===null`, `nullish!==non-nullish`, `5===5`.
FAIL (3), with root causes:

1. **`undefined === undefined` → false (want true)** AND **`undefined !== undefined`
   → true (want false).** ROOT CAUSE: array/object literals push **raw
   `ref.null.extern`** for `undefined`-like values (`literals.ts:575/605/646/657/685`
   etc.), NOT `emitUndefined`. So `[undefined, undefined]` stores TWO NULLS, read
   back as null — but then `null===null`-via-the-guard should give true... it gives
   false, so the stored value is NOT plain null either (likely the S0 contextual-`any`
   boxing path tags the literal `undefined` as a tag-1 `$AnyValue` element via
   `boxToAny(jsStaticType=undefined)` — but `boxToAny`'s "undefined" case currently
   `break`s at `value-tags.ts:168`, so it falls to the Wasm-kind dispatch and boxes
   as... INVESTIGATE: dump the WAT of `[undefined,undefined]` element store).
   **NEXT:** make the literal-`undefined` producers (and `boxToAny`'s undefined arm)
   emit the singleton consistently so a stored `undefined` IS the singleton; then
   two reads `ref.eq` true. Either route literal undefined through `emitUndefined`,
   or implement `boxToAny`'s tag-1 arm to push the `$undefined` global.

2. **loose `null == undefined` → false (want true).** ROOT CAUSE: the loose nullish
   guard uses bare `ref.is_null`, which no longer catches the undefined singleton
   (non-null). **NEXT (the S1.2 ripple):** add `emitIsNullish(ctx,fctx)` =
   `is_null(x) || is_undefined_singleton(x)` and route the LOOSE `==`/`!=` nullish
   arm (binary-ops `looseNullish` guard) + `??` + `?.` + default-fill +
   array-hole + SameValueZero-nullish through it. ~42 `ref.is_null` sites to triage
   (nullish-intent → `emitIsNullish`; null-specific `=== null` → stays `ref.is_null`).

### Remaining work to finish S1 (atomic PR)
- Fix (1): consistent singleton production for ALL `undefined` producers
  (literals, `boxToAny` tag-1 arm, omitted-arg padding that uses raw
  `ref.null.extern` e.g. `calls.ts:1352/1700` thisArg — verify those are
  this-arg-only and not default-param relevant).
- Fix (2): `emitIsNullish` + the nullish-consumer sweep (S1.2).
- `typeof null` → "object": `__typeof_object` currently returns 0 for
  `ref.is_null`; flip null→"object" (return 1) so typeof null is correct (separate
  small follow-up, not strictly blocking the strict-eq fix).
- Validate via merge_group (value-rep broad-impact). Report net delta to
  sdev-coercion-impl / lead for the land decision. Supersede/close held PR #1961
  if S1 lands net-positive.

### Validation done so far
tsc clean; S1.0 inert validated (36 tests green: #1776/#1021/strict+loose
equality/#2106 S0/#2029). The 3 repro failures above are the WIP frontier.

> NOTE (2026-06-25): the "## S1.2 resolution" section that previously claimed
> S1.2 was "implemented, 6/6 + no new regressions" has been REMOVED — it was
> wrong. S1.2's equality scoping was real, but the underlying S1.1 producer flip
> was an incomplete subset that breached the standalone floor by −1245 rows in
> the merge_group. Both S1.1 and S1.2 behavioral edits are now reverted on this
> branch. See the diagnosis below.

## S1 merge_group regression — diagnosis (sdev-s1fix, 2026-06-25)

PR #2025 (HEAD ffb0dbba8) was **auto-parked** by github-actions[bot]: it passed
all PR-level checks but FAILED the `merge shard reports` gate in the merge_group
(run 28134749722, branch gh-readonly-queue/main/pr-2025-…). The failing step is
`scripts/check-standalone-highwater.mjs`:

```
[standalone-highwater] current pass=23729, mark=24956 (floor=24906, tolerance=50, delta=-1227).
##[error]STANDALONE pass-count floor breached
```

**Per-row delta** (merged standalone report jsonl vs
`loopdive/js2wasm-baselines/test262-standalone-current.jsonl`):
- 1654 rows REGRESSED (962 pass→compile_error, 688 pass→fail, 4 pass→timeout),
  409 gained, **NET −1245**.
- 1150/1654 (70%) are destructuring / default-param / binding-pattern
  (`/dstr/`, `dflt`, `ptrn`). The rest (504) are spread across
  expressions/class, Object.defineProperty(ies), eval-code, RegExp, super, and
  the verifyProperty/assert harness — all "is-undefined"-classifier consumers.
- 948 of the 962 compile-errors carry the message "Cannot convert object to
  primitive value" (the singleton reaching a to-primitive path that doesn't
  recognize it); 212 of the fails are "illegal cast" in the same dstr cluster.

**Root cause — partial sweep (producer/consumer inconsistency).**
S1.1 flipped `emitUndefined` to produce the tag-1 `$undefined` SINGLETON
(non-null externref) and flipped the CONSUMER `__extern_is_undefined`
(object-runtime.ts ~5681) to a singleton-ONLY tag-1 test, but did NOT flip the
matching PRODUCERS. The decisive one: **`__extern_get` (object-runtime.ts:856)
still returns `ref.null.extern` for a MISSING key**. So a missing-property read
is null, `__extern_is_undefined(null)` now returns 0, and destructuring / param
defaults never fire.

Validated repros on the branch (standalone, probes since removed):
- `const {a=7} = {}` → returns 0, should be 7  ← REGRESSION (the bulk).
- `const {a=7} = {a:null}` → correctly does NOT fire default  ← the S1 GAIN
  (null/undefined distinctness) working as intended.
- `"v="+undefined` (→"v=undefined") and `+undefined` (→NaN) still work — those
  go through `__any_to_string` / `__unbox_number`, which already have tag-1 arms.

**Why there is NO narrow floor-saving fix.** Producer and consumer are now in an
inconsistent intermediate state. Reconciling them = the architect spec's full
~40-site sweep (memory `project_2106_undefined_singleton_s1_atomic`): flip EVERY
undefined producer to the singleton (`__extern_get` miss, omitted-arg/element
padding, literal element stores) AND convert EVERY `ref.is_null`-based
absence/nullish consumer to also recognize the singleton, in lockstep.
`__extern_get` alone has 111 callers; its null return doubles as `__extern_has`'s
absence signal and the prototype-walk loop terminator — flipping it ripples
through the whole object runtime. The branch shipped a partial subset, which is
net −1245.

**Recommendation:** revert the S1.1/S1.2 producer+consumer flips to restore the
green floor (keep the inert S1.0 reservation + spec/docs), and re-land S1 as a
complete, properly-sequenced sweep in a fresh PR with the full producer+consumer
site set flipped together, validated via merge_group BEFORE enqueue (route to
architect to enumerate the full producer/consumer site list first). The hold on
#2025 must stay until this is resolved.

## S1 re-land plan — FULL sweep behind `undefinedSingleton` flag (fable-2106, 2026-07-04)

Resumed on branch `issue-2106-s1-undefined-singleton` (fast-forwarded to main
@ 02cc6d108 — the old branch content had fully landed via PR #2025's
floor-neutral revert; S1.0 inert reservation IS on main in `any-helpers.ts`).

**Why flagged, not default-on:** the June partial flip measured −1245 net; the
diagnosis proved producer+consumer must flip in lockstep across the WHOLE
standalone runtime. A compile-flag regime (`undefinedSingleton`, default OFF →
byte-identical, precedent: #2141 `honestAnyBoxing`) lets the complete sweep land
green and floor-safe, with the default flip as a separate, measured, one-line PR.
This is the issue's own S4 measure-first protocol applied to S1.

**Key re-ground findings (2026-07-04, main @ 02cc6d108):**
- Host mode ALREADY has non-null undefined (`__get_undefined`), so shared
  expression-layer consumers are already dual-predicate: `??` emits
  `ref.is_null || __extern_is_undefined` (logical-ops.ts:225-232); `=== undefined`
  routes through `__extern_is_undefined` (binary-ops.ts:464-478). Flipping the
  ONE native `__extern_is_undefined` body covers all of them at once.
- The ripple is concentrated in STANDALONE-NATIVE bodies where null doubles as
  absence/undefined: `__extern_get` 3 miss sites (object-runtime.ts:1012+),
  `__extern_get_idx` miss, internal `call __extern_get; ref.is_null` absence
  checks (to-primitive/method-dispatch/iterator/json — the 948 June CEs),
  the standalone looseNullish guard (binary-ops.ts:2641 — bare `ref.is_null`),
  externref ToBoolean (singleton must be falsy), ToNumber (null→0 vs
  undefined→NaN — currently conflated), ToString ("null" vs "undefined").
- `__extern_is_undefined` gained a #2979 UNDEF_F64-boxed-sentinel arm since the
  June spec — the flag body must KEEP that arm (singleton-test ∨ UNDEF-box),
  dropping only the `ref.is_null` arm.
- #2949 coherence: `JsTag.Undefined = 1` is payload-less; identity via
  `tag.test` — the tag-1 singleton IS the JsTag-lattice-conformant carrier.
  `__any_to_extern` already round-trips tag-0/1 boxes wrapped (any-helpers.ts:632);
  under the flag tag-1 canonicalizes to the singleton and tag-0 to
  `ref.null.extern` (fixing the tag-0→tag-1 round-trip lie that comment documents,
  in the flag regime).

**Flag semantics (standalone/nativeStrings only; host byte-identical always):**
undefined = the S1.0 `$undefined` tag-1 global (extern-wrapped at the externref
plane); null = `ref.null.extern`. Producers emit the singleton; undefined-specific
consumers test tag-1 (∨ UNDEF-box); null-specific stay `ref.is_null`; nullish =
either (new native `__extern_is_nullish`).

### S1 flagged sweep — DELIVERED (fable-2106, 2026-07-04, this branch)

Implemented the complete lockstep sweep behind `undefinedSingleton` (default
OFF; `JS2WASM_UNDEF_SINGLETON=1` env A/B, mirroring `JS2WASM_TAG5_CLASSIFIER`):

- **Producers**: `emitUndefined` → singleton; `__extern_get` 3 miss sites;
  `__extern_get_idx` misses (builder `missInstrs` factory — fresh instr objects
  per branch, finalize-splice safe); `boxToAny` null/undefined jsType arms →
  `__any_box_null`/`__any_box_undefined`; `__any_from_extern` null arm → tag-0.
- **The boxing chokepoint that made dynamic eq work**: `__any_box_extern_s1` —
  NULLISH-honest externref boxing (null→tag-0, singleton/UNDEF-box→tag-1,
  everything else keeps the #1888 tag-5 wrap byte-equivalently). Deliberately
  NOT #2141's full-honest classification (its solo flip measured −788/−794).
  Routed from `boxToAny`'s externref arm under the flag. Without it,
  `u === miss` boxed both nullish values tag-5 and `__any_strict_eq` said 0
  (WAT-verified).
- **Consumers**: `__extern_is_undefined` → tag-1 ∨ UNDEF-box (drops
  `ref.is_null`); `__extern_is_nullish` + `__nullish_to_null` natives —
  internal null-keyed lookups (to-primitive valueOf/toString: the June 948-CE
  site; proxy traps; descriptor fields; `__extern_method_call`; groupBy)
  NORMALIZE nullish→null at the read so their downstream logic stays
  byte-identical; `__is_truthy` tag≤1 falsy; typeof cluster (predicate +
  `__typeof_object` + materialized `__typeof`): null→"object",
  singleton→"undefined"; strict/loose dynamic-eq nullish guard in the #1776
  cascade (the #1961 bothNullishGuard re-keyed as spec'd); `?.` receiver
  guards OR the singleton test; `__dyn_get` stops remapping stored-null→
  undefined, `__dyn_has` tests nullish; join renders singleton as "";
  `__extern_toString(null)` → "null"; destructure container guard tests tag-1
  ONLY (preserves #3010's scalarized-`[undefined]` fix).
- **Zero-change wins** (already tag-correct, verified): `__any_strict_eq`
  (same-tag<2 equal), `__any_eq` (both-tags<2 arm), `__any_to_string`
  (tag-0 "null"/tag-1 "undefined"), `__any_to_f64` (tag-1 NaN),
  `__unbox_number` (null→0, opaque→NaN), dstr/param defaults
  (`__extern_is_undefined`-exclusive per #1021 — spec-correct under the flag),
  `holeToUndefinedInstrs` (routes via emitUndefined).
- **Validation**: `tests/issue-2106-s1-undefined-singleton.test.ts` — 8 flag-on
  standalone cases (strict/loose distinctness incl. cross-producer, typeof,
  missing-vs-stored-null property reads, dstr defaults null-kept, ??/?./
  truthiness, ToString/ToNumber split, container-guard TypeError) + a flag-off
  legacy control. Byte-inertness: 10-program × {gc,wasi} corpus sha256 —
  IDENTICAL to pre-change tree with flag off.
- **Known flag-on residuals** (pre-existing, flag-NEUTRAL — confirmed both
  regimes behave identically): `{ b: null }` shape-struct literals read via
  bare `__extern_get` miss the field (dstr default fires either way);
  `.join()` on an `any` receiver; `""+arr` to-primitive of any-array.

**Next steps (follow-up PRs):** (1) A/B-measure the standalone test262 delta
with `JS2WASM_UNDEF_SINGLETON=1` (runner-level env, no code change needed);
(2) if net-positive, flip the default in a one-line PR validated via
merge_group; (3) S2 (sNaN carve-out codify), S3 (number|undefined→externref,
needs the box-protocol fix), S4 (union-collapse reversal) remain per plan.

## Default-flip A/B — authoritative measurement + residual (opus-2106flip, 2026-07-13)

Ran the AUTHORITATIVE fork A/B for the default-ON flip (branch
`issue-2106-undef-default-flip`, the one-line `undefinedSingleton` default
OFF→ON in `create-context.ts`, rollback `JS2WASM_UNDEF_SINGLETON=0`).

**STALE-A/B trap (documented so nobody repeats it):** the FIRST A/B (run
29234941937) merged `origin/main` at 7a895d20c8 — a few minutes BEFORE PR-1
(#3003 = commit `dfe4ff7bac` "complete the array-absence producer arm") landed.
It measured the flip WITHOUT PR-1 → floor delta **-952**, dominated (958 rows)
by "Cannot destructure 'null' or 'undefined'" in destructuring PARAMETER
defaults. Root cause: the omitted-arg padding producer (`emitUndefinedValue`,
type-coercion.ts — a dedupe copy of the canonical `emitUndefined`) still emitted
`ref.null.extern`, which the singleton-only `__extern_is_undefined` consumer no
longer recognized → param defaults stopped firing → the null flowed into the
destructure guard and threw. **PR-1 already fixes exactly this** (routes
`emitUndefinedValue` through `undefinedExternInstrs` under the flag). Repro:
`function f([a,b]=[10,20]){return a+b}; f()` throws flag-ON on pre-PR-1 main,
PASSES both flag ON/OFF on freshest main. Lesson: always re-base onto freshest
`origin/main` and confirm the intended predecessor commit is an ancestor BEFORE
triggering the fork A/B.

**Authoritative re-run (run 29236694670, freshest main + PR-1):**

  current pass (flip ON) = 22399 · mark (flag OFF) = 22727 · floor 22677
  **DELTA = -328 host_free_pass → still a floor breach → NO-GO.**

Trend: -952 → -328 (PR-1 recovered ~624 host-free passes; the entire
destructuring-param-default bucket — 958 "Cannot destructure" + 374 async-dstr
"vacuous" — is GONE).

**Residual -328 bucketing** (fresh baseline jsonl re-fetched to match the mark;
raw-pass NET -133, 654 regressed / 522 gained). ONE cluster dominates:

- **231 "illegal cast [in test()]" — RegExp** (e.g.
  `built-ins/RegExp/S15.10.2.6_A4_T4.js`). 35% of all regressions, CONSTANT
  across every diff (pre/post-PR-1, stale/fresh baseline) → a genuine flip-caused
  residual PR-1 does not touch. **This is the next byte-inert completion PR
  target.** Hypothesis: an absent/undefined value on a RegExp-result path is now
  the tag-1 `$undefined` singleton (a non-null `$AnyValue` ref) instead of
  `ref.null.extern`, so a downstream `ref.cast` to a typed struct (or an
  externref-expecting call) traps ("illegal cast"). Fix = a singleton-aware arm
  at that RegExp-result box/cast site, gated on `undefinedSingletonActive(ctx)`
  (byte-inert flag-OFF), same pattern as PR-1.
- Long-tail (thin, ~6-13 each): `Object.defineProperty`/`create`/
  `defineProperties` + class-element ASI `verifyProperty {value: undefined}` /
  `typeof desc.set === "undefined"` asserts. **Largely NOISE** — a direct
  `Object.getOwnPropertyDescriptor` + `typeof desc.set === "undefined"` repro
  PASSES both flag ON and OFF; the test262 failures are verifyProperty-harness
  edge cases, not the core descriptor path. Do NOT chase these before the RegExp
  cluster.

**Next step:** file the RegExp-illegal-cast byte-inert completion PR (flag-OFF
default, merges on normal gates), then re-run the fork A/B. Repeat until the
A/B is net-non-negative, at which point the default-flip (PR-2) is floor-safe
— go/no-go routes through the lead each time. Flag stays default-OFF meanwhile;
flip PR-2 is unopened. Artifacts: run 29236694670 `test262-merged-report`.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — the referencing merged PR was a REVERT (PR #2025 auto-parked: standalone floor breach, NET -1245 test262 rows), so it is floor-neutral undo, NOT progress. S1 (standalone tag-1 $undefined singleton) still requires the FULL ~40-site producer+consumer sweep (architect re-spec) — no narrow floor-saving subset exists. S2 (sNaN carve-out), S3 (number|undefined→externref), S4 (union-collapse reversal), typeof-null→object all remain. Stays in-progress; resume-only for a senior-dev at max effort.

---

# S1 default-flip RE-MEASURE + array-absence producer COMPLETION (opus-2580, 2026-07-13, max-reasoning)

> Scope-first re-measure of the default-flip NO-GO (PR #2655) against CURRENT
> main, then a bounded, byte-inert completion of the residual producer gap. The
> flagged sweep (PR #2633) IS on main; this is PR-1 of a two-step decoupling
> (PR-1 = byte-inert completion; PR-2 = the default flip, gated on a FULL fork
> A/B). All probes per-process; the fork run's floor step decoded, not trusted.

## Why the last default-flip (PR #2655) was declined — VERIFIED, not stale-inferred

PR #2655 (flip `undefinedSingleton` default ON) was closed citing the fork A/B
"conclusion=failure". Decoded fork run **28716643775**: all 30 shards were GREEN;
the failing job is `merge shard reports` → step **"Standalone pass-count
high-water floor (#2097)"**: `current pass=19062, mark=20952, delta=-1890`. So
the decline was correct — flag-ON was a genuine **−1890** standalone floor breach
(worse than June's partial −1245), NOT infra. BUT that A/B is against main @
`265a26fc3` (8 days / hundreds of commits stale; #3053 U0-U2 carrier, #3033,
#3183, #3169 landed since).

## The −1890 is a BOUNDED lockstep gap, not a representation cost (current-main A/B)

Re-measured flag-ON vs flag-OFF per-process on current main. Flag-ON is ALREADY
correct for: null/undefined distinctness, `typeof null === "object"`, the June
−1245 ROOT (dstr default no longer fires on a present `null`), `""+undefined`,
**object** missing-key default (`{a=7}={}`→7), explicit `[undefined]` element,
`fn(undefined)`. The ONLY live regression class was the **array-element-absence
producers** — they still emitted raw `ref.null.extern` for "absent", while their
dstr-default CONSUMER (`emitExternrefDefaultCheck` → `__extern_is_undefined`,
which is **singleton-only** under the flag, dropping the `ref.is_null` arm) was
flipped → the default spuriously failed to fire:

| shape | flag-OFF | flag-ON (before) | producer |
| --- | --- | --- | --- |
| `[x=9]=[]` (hole) | 9 | **0** | array-OOB decl/param read |
| `[,y=9]=[1]` (elision) | 9 | **0** | array-OOB decl/param read |
| `[a,b=9]=[1]` (past-end) | 9 | **0** | array-OOB decl/param read |
| `fn(x=9)` absent param | 9 | **0** | absent optional/default param padding |
| `for(const [a=9] of [[]])` | 9 | **0** | for-of loop-head array-destructure |

Object-key-absence and explicit-undefined were already flipped; only the
array-absence + absent-param producers were missed — the dstr/dflt/ptrn cluster
that was ~70% of June's −1245, hence it plausibly dominates the −1890.

## PR-1 (this change) — the array-absence producer completion (byte-inert)

Three producers now route the "absent → undefined" value through the `$undefined`
singleton under the flag (byte-identical flag-OFF, so PR-1 cannot breach the floor
— it only matters once PR-2 flips the default). Each is the `emitUndefined`/
`undefinedExternInstrs` singleton vehicle, gated so flag-OFF emits the exact prior
`ref.null.extern`:

1. **`emitBoundsCheckedArrayGetUndef`** (`destructuring-params.ts`) — the OOB
   else-arm of the decl/param array-element read. Standalone flag-ON → singleton;
   host unchanged (`__get_undefined`); standalone flag-OFF → legacy fallback.
2. **`emitUndefinedValue`** (`type-coercion.ts`, the param-padding chokepoint used
   by `pushDefaultValue`/`pushParamSentinel`) — absent optional/default param.
   Standalone flag-ON → singleton; else `ref.null.extern` (byte-identical).
3. **`emitBoundsCheckedArrayGet`** (`array-methods.ts`) — the `useUndefinedSentinel`
   OOB else-arm (the for-of loop-head destructuring path). Gated on
   `useUndefinedSentinel` so non-destructuring array reads are byte-identical.

**Validated** (per-process A/B, both flag states + `tests/issue-2106-s1-array-absence-producers.test.ts`,
5 cases): all 5 shapes above flip to correct under flag-ON; present-value / explicit-
undefined / present-`null` unaffected; flag-OFF byte-inert (control green). Existing
`issue-2106-s1-undefined-singleton` (9) + `issue-2574` (7) + default-param/dstr batch
(32/33; the 1 fail is a pre-existing `wasm:js-string` host-import env artifact in
`issue-1016b`, flag-OFF, unrelated). tsc + prettier clean.

## PR-2 (NEXT, separate) — the default flip, gated on a FULL fork A/B

Do NOT flip the default from this PR. After PR-1 lands, re-run the FULL fork
sharded A/B (`JS2WASM_UNDEF_SINGLETON=1`, the merge_group standalone-floor #2097 —
NEVER a local/scoped measurement) and flip the default OFF→ON only if
`host_free_pass` is net-non-negative vs the flag-OFF floor. If a residual remains,
document the next producer bucket and keep the flag OFF — PR-1's completion still
banks as progress toward a future flip. The −1245/−1890 history is unambiguous:
the flip decision is a full-gate measurement, not a local judgment.

**Audit note (heeded):** this is NOT a single-site fix — the broad per-process
audit (nested `[[a=9]]`/`[{p=9}]`, rest, multi-param, object defaults, arrow,
expression-default side-effects, for-of) is all green flag-ON after the three
producer flips. Any producer still missed is byte-inert (flag-OFF default) and
will surface as a residual bucket in PR-2's fork A/B, not a floor breach now.

## PR-3 (this change) — hoisted-`var` RegExp-match undefined-init retype fix (byte-inert)

opus-flip measured the authoritative flip A/B at **−328** (NO-GO) after PR-1's
array-absence completion, and pinned the residual: **ONE cluster dominates — 231
"illegal cast" RegExp regressions** (constant across every diff → a genuine
flip-caused residual; the descriptor long-tail is noise, verified pass ON+OFF).
This PR eliminates that cluster.

### Root cause (WAT-confirmed, opus-regexp 2026-07-13, max-reasoning)

The trap is NOT on the exec-RESULT path — it is at the **hoisted `var` init**. A
function-scoped `var e = /re/.exec(s)` has its static type widened to include
`undefined`, so `hoistVarDecl` (`src/codegen/index.ts` ~14890) allocates the slot
as **externref** and emits `emitUndefined; local.set` at function entry. Under the
`undefinedSingleton` regime `emitUndefined` produces the tag-1 `$undefined`
singleton — a **NON-null** `$AnyValue` ref (`global.get $undefined;
extern.convert_any`), where flag-OFF emits `ref.null.extern`.

The declaration statement then **retypes** the slot externref → the concrete
match-array struct ref `(ref null N)` at `statements/variables.ts:1252`
(`standaloneRegExpMatchArrayType && existingIsExternref && newIsRef`) — the SOLE
externref → concrete-ref hoist retype (the general #962 guard at ~1272 refuses
every other). The `local-set-coerce` stack-balance fixup
(`stack-balance.ts` → `callArgCoercionInstrs` externref→ref arm) then splices an
**UNGUARDED** `any.convert_extern; ref.cast_null N` before the hoist `local.set`.
Flag-OFF: `ref.null.extern → any.convert_extern → ref.cast_null N` = `ref.null N`
(null casts cleanly). Flag-ON: the non-null singleton is not a type-N →
`ref.cast_null` **TRAPS "illegal cast"** at the very first instruction of the
function. RegExp dominates because `var __executed = re.exec(...)` (hoisted var,
no null-narrowing) is ubiquitous in the RegExp harness (`assert.sameValue(
__executed.length, …)`), and the test262 wrapper puts it inside a `try {}`.

### Fix

A concrete-ref slot **cannot represent the singleton** anyway (it is not `any`;
undefined-vs-null observability there is the out-of-scope S3/S4 union-collapse
story), so the correct value is `null`. The hoist now emits the flag-OFF
`ref.null.extern` for a var whose declaration will retype the slot to a concrete
ref — detected via the new exported predicate `hoistedVarRetypesToConcreteRef`
(= `inferStandaloneRegExpMatchArrayType(...) !== null`, the exact retype
condition). This casts cleanly to `ref.null N` after the retype. Placed at the
**hoist** (not the retype site) because `fctx.body` is the root function body
there — a retype-site patch misses the init when the decl compiles inside a
swapped body (try/if/loop), which is exactly the test262 harness shape.

**Byte-inert flag-OFF**: gated on `undefinedSingletonActive(ctx)` (false flag-OFF
→ the exact prior `emitUndefined` path). Proven: SHA A/B over gc/standalone/wasi
× 7 programs (incl. `var e = exec()`) is byte-identical before/after.

**Validation**: `tests/issue-2106-s1-regexp-hoisted-var.test.ts` (5 cases incl.
the try-wrapped harness shape); real file `RegExp/S15.10.2.6_A4_T4.js` flips
fail→pass flag-ON; a 180-file RegExp A/B shows **0 remaining illegal-cast
regressions** and **0 regressions introduced by this change** (the 5 residual
`fail`s are a PRE-EXISTING, separately-verified "unmatched capture group →
undefined representation" bucket on INLINE `.match()`/`.exec()` — not hoisted
vars — confirmed identical with this change stashed). Existing S1 suites
(undefined-singleton 9, array-absence 5, #2574 7) all green; tsc + prettier clean.

**Next (PR-4)**: after this lands, re-run the fork A/B. Expected residual bucket
if any: the "unmatched capture group / named-group `.groups.x` = undefined"
representation on inline match results (`captures*.js`, `*-references.js`,
`lookbehind.js`) — a distinct producer, separate byte-inert PR. Report the new
`#2097 host_free_pass` floor delta to the lead for the flip go/no-go.

## Implementation Plan (Fable, 2026-07-18) — residual assessment: the singleton half is SHIPPED; what remains is the NUMERIC-CARRIER leg + close-out

### Verified state (current main)

- **The `$undefined` tag-1 singleton regime is DEFAULT ON**
  (`undefinedSingleton: boolean` — "Default TRUE (#2106 flip)",
  `src/codegen/context/types.ts:125/:2415`). The S1 sweep, the flip, and the
  follow-on miss-guard fixes (#3307/#3319/#3328) are all on main.
- **The post-flip null-guard hazard class is closed**: #3331 ("AUDIT: #2106
  $undefined-singleton null-guard bug class — systematic sweep") is `done`.
  New consumers of externref misses must keep using the audit's dual
  predicate (`ref.is_null` ∨ singleton/UNDEF-box) — that discipline is now
  the settled pattern, not an open risk.
- So the issue's headline ("null vs undefined distinct standalone,
  observable to `===`/`??`/typeof/ToString") is **satisfied for
  reference-plane carriers**. The issue stays open for exactly one leg:

### The remaining leg — numeric-carrier undefined (UNDEF_F64 / union-collapse reversal)

`number | undefined` still collapses to bare `f64` at the type mapper
(`resolveWasmType` unwraps 2-member nullable unions), so undefined entering
an f64 carrier becomes NaN and is unobservable — the acceptance rows
`codePointAt(oob) ?? -1`, `=== undefined` on a numeric local, and the #2860
census signature family (`assert.sameValue(rest.a, undefined)`, ~109 gap
rows where the rest/absence value flows through numeric positions).

**Design verdict (choose the sentinel, NOT the `$AnyValue` carrier):** with
#745 S2–S4 landed, mapping `number | undefined` to `$AnyValue` is now
technically possible — REJECT it for this leg. `number | undefined` is the
hottest union shape in numeric code (array reads, optional params, find/
indexOf results); boxing every op is the exact cost profile #745 accepted
only for genuinely heterogeneous unions. The June P3 design stands: keep the
f64 carrier with the **sNaN sentinel** (`0x7FF00000DEADC0DE`, the same bit
pattern the default-param machinery already uses) as the in-carrier
representation of undefined, with observer support. The #2979
`UNDEF_F64`-boxed arm in `__extern_is_undefined` already recognizes the
boxed form — the sentinel is half-adopted; this leg completes it.

**Slices (flag-gated like the singleton sweep — `undefF64Observers`,
default OFF, byte-inert):**

1. **N1 (M) — producer inventory + emit.** Sites where undefined enters an
   f64 position: union-collapsed var/param init, absent optional param
   (already sNaN), OOB/miss reads coerced to f64, destructuring
   defaults/rest misses. Each emits the sentinel instead of NaN — behind
   the flag. NB the sentinel is a signaling-NaN PAYLOAD: arithmetic on it
   must degrade to ordinary NaN (spec: undefined→NaN under ToNumber), which
   f64 ops do for free — only IDENTITY observers may test the payload.
2. **N2 (M) — observers.** `=== undefined` / `??` / `?.` / `typeof` /
   ToString on a statically `number|undefined` position: test the exact
   bit pattern (`i64.reinterpret_f64` + `i64.eq` const) BEFORE NaN-ness;
   plain NaN stays "number"/NaN. Boundary coercions f64→externref /
   f64→`$AnyValue` map sentinel→singleton/tag-1 (and back), so the two
   regimes compose at every plane crossing (the #2979 arm is the
   precedent).
3. **N3 (S) — measured flip.** A/B on the standalone lane against the
   2026-07-18 baseline with the ~109-row signature family as the named
   expected-win list; perf spot-check on numeric-loop benchmarks (the
   sidebar suite) since N2 adds a branch to hot observer sites — the
   acceptance criterion's "perf/size measurements" clause.

**Hazard:** an sNaN payload does NOT survive every Wasm op (canonicalization
on arithmetic) — that is CORRECT here (arithmetic = ToNumber(undefined) =
NaN) but means the sentinel must never be relied on after passing through
any arithmetic. N1's inventory must classify each producer as
identity-plane (sentinel sound) vs arithmetic-plane (NaN fine); document
per site.

### Close-out recommendation

After N1–N3 (or a decision to demote the numeric leg), re-run the four
acceptance rows and CLOSE this issue — it has been `in-progress` since
June with its main deliverable shipped; the open remainder should either
execute as N1–N3 (M+M+S) or be split to a successor issue so #2106 can be
marked `done` against its shipped half. The stale `assignee:
ttraenkler/opus-regexp` should be cleared either way (that lane's PR-3/PR-4
RegExp work is recorded above and its residual bucket is the inline
capture-group producer, which belongs to the RegExp lane, not here).
