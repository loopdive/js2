---
id: 2106
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: in-progress
assignee: ttraenkler/sdev7
sprint: 63
created: 2026-06-11
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2004, 2051, 2030, 2001]
origin: "2026-06-11 analysis program (report 02 phase P3); stub 08-E21"
---

# #2106 — T | undefined collapses to bare T

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
