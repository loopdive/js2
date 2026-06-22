---
id: 1917
title: "One coercion engine — four divergent coercion matrices disagree about lossiness"
status: in-progress
sprint: 65
model: opus
created: 2026-06-10
updated: 2026-06-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1917 — One coercion engine

## Problem

Four independently-maintained type-coercion matrices coexist in the WasmGC
backend, and they **disagree semantically**:

- `coerceType` (`src/codegen/type-coercion.ts:980`, ~1,100 lines for one function)
- `coercionInstrs` (`type-coercion.ts:2695-2903`)
- `callArgCoercionInstrs` (`src/codegen/stack-balance.ts:1179-1310`)
- `fixBranchType` (`stack-balance.ts:678-764`), plus `fixLocalSetCoercion`

Observed divergence:
- externref→f64: `callArgCoercionInstrs` calls `__unbox_number` (correct);
  `fixBranchType` emits lossy `drop; f64.const 0` (`stack-balance.ts:724-728`).
- ref→f64: `coercionInstrs` pushes `f64.const NaN` (line 2786);
  `fixBranchType` pushes `0` (lines 737-742).

So the runtime value a coercion produces depends on *which syntactic context
triggered it* — call argument vs branch result vs local.set. Additionally,
the guarded-ref-cast idiom (tee tmp → ref.test → if/then cast / else null) is
copy-pasted ≥6 times within type-coercion.ts alone (1026-1048, 1067-1089,
2820-2834, 2843-2857, 2865-2878, 2885-2898).

## Proposed approach

1. Extract a single `coercionPlan(from: ValType, to: ValType, ctx) →
   { instrs: Instr[] } | { needsTemp: ... } | { lossy: true, instrs }` table
   in `type-coercion.ts`.
2. Consume it from all four call sites; delete the local matrices.
3. `lossy` arms emit a located diagnostic (ties into #1918's strict mode) —
   a lossy coercion in a branch fixup is an emitter bug being masked, and
   should be visible.
4. Extract one `guardedRefCast(toTypeIdx)` helper for the 6+ copies.
5. Add table-driven unit tests: for every (from, to) pair, all consumers
   produce identical instruction sequences.

## Acceptance criteria

- One coercion table; `callArgCoercionInstrs`/`fixBranchType` delegate to it.
- The externref→f64 and ref→f64 divergences are gone (branch context unboxes
  / NaNs identically to call-arg context), with a regression test for each.
- Equivalence + test262 CI green.

## Source

Compiler quality review 2026-06. Related: #1918 (fixup ratchet), #1858
(fail-loud umbrella).

## Amendment (2026-06-11, analysis program)

Two corpus-driven changes to this spec (full detail:
plan/log/analysis-2026-06/03-coercion-engine-spec.md and
05-structure-review.md §2a):

1. **The engine API must carry a `staticJsType?` hint.** The June corpus
   proved that dispatching on Wasm ValType alone mis-classifies values —
   the #2072 investigation showed booleans (i32) boxing as numbers,
   undefined/null (externref) as strings, native strings (eqref) as
   objects. A ValType-only engine reproduces that disease. Every entry
   point (`emitToString`, `emitToPrimitive`, `emitLooseEq`, …) takes the
   source expression's static TS classification when resolvable.
2. **The site inventory is larger than this issue assumed.** Report 03
   catalogued 37 sites: 13 ToString (the §7.1.17 matrix hand-rolled 7× —
   incl. template spans string-ops.ts:272-285, join elemToStr
   array-methods.ts:4543, standalone emitArrayJoin :4487+,
   $__any_to_string native-strings.ts:5417), 11 ToNumber/ToPrimitive,
   8 equality, 5 ToBoolean (incl. buildTruthyCheck, #2085). Migration
   order and the per-site bug map live in report 03 §3.

Sequencing: Step 0 (ValType table) is dependency-safe now; Steps 1+ land
AFTER the type-aware boxing P0 (#2072/#2080) so the engine consumes
correct tags. Drift gate: #2108.

## Implementation — Step 0 landed (sdev1, 2026-06-15)

**Scope: Step 0 only** (the ValType `coercionPlan` table). Steps 1-4 (the
JS-semantic `emitToString`/`emitToPrimitive`/`emitStrictEq`/`emitLooseEq`
engine) remain — they land after value-rep P0 (#2072/#2080, now done) per the
spec's migration order; this issue stays `in-progress` until they do.

### What landed

- **New `src/codegen/coercion-plan.ts`** — a single **pure** function
  `coercionPlan(from: ValType, to: ValType, {boxNumberIdx, unboxNumberIdx})`
  returning the exact instruction sequence for the **scalar / numeric /
  box-unbox** rows the three ValType matrices shared, plus a `lossy` flag for
  the genuine no-bridge rows (funcref→externref; ref→number with no unbox
  helper available → NaN/0 per §7.1.4).
- **`callArgCoercionInstrs` (stack-balance.ts)** delegates its scalar rows to
  `coercionPlan`; keeps only the externref→ref/ref_null guarded cast (needs the
  expected struct typeIdx).
- **`fixBranchType` (stack-balance.ts)** now routes scalar/box-unbox
  conversions through `coercionPlan`, threading `boxNumberIdx`/`unboxNumberIdx`
  down through `fixBranch`/`fixBody` from `stackBalance`. **This kills the
  headline divergence**: it previously emitted lossy `drop; f64.const 0` for
  externref→f64 and ref→f64 (silently zeroing the value during a stack-balance
  fixup) while the call-arg path correctly unboxed via `__unbox_number`. It
  also fixed a latent funcref→externref bug (old code emitted an INVALID
  `extern.convert_any` on a funcref; the table now uses the lossy null
  fallback, matching `coercionInstrs`).
- **`coercionInstrs` (type-coercion.ts)** delegates its non-ref scalar rows to
  `coercionPlan` (kept its own `ref→f64=NaN` / AnyValue→externref helper /
  guarded ref.cast arms, which need `ctx`/`fctx` and a deliberately different
  ref ToNumber policy — those are Step 2 engine concerns, not Step 0).

### Why ref→f64 differs between consumers (intentional, for now)

`callArgCoercionInstrs`/`fixBranchType` unbox a `ref` carrying a boxed number
(`extern.convert_any; __unbox_number`); `coercionInstrs` NaNs a bare GC ref
(ToNumber of an object without valueOf). Step 0 unifies the **box-unbox** rows
that were genuinely divergent-by-accident; the ref→f64 *policy* split is real
JS semantics that the Step 2 `emitToPrimitive` engine will own with a
`staticJsType` hint (boxed-number-ref vs object-ref). Step 0 does not force
them together to avoid changing array-callback-loop ToNumber behavior.

### Validation

- `tests/issue-1917-coercion-plan.test.ts` — 10 table-driven unit cases
  (asserting the exact sequence per `(from,to)` incl. the non-lossy externref→f64
  / ref→f64 guarantee) + 4 end-to-end any→number regression cases (host +
  standalone). All pass.
- Behavior-neutral: full `tests/equivalence/` dir green (exit 0); coercion +
  stack-balance suites unchanged (the 2 pre-existing `stack-balance.test.ts`
  failures and the IR-fallback/void-NaN equivalence failures reproduce
  identically on unmodified HEAD).
- `tsc --noEmit` clean; lint/format clean; `check:ir-fallbacks` OK.

### Next (Steps 1-4, separate PRs, now unblocked by #2072/#2080)

`coercion-engine.ts` skeleton + `emitToString` (Step 1, fixes #2005/#2006/
#1998/#2074), `emitToPrimitive` (Step 2, #1989/#2022/#1990/#1988),
`emitStrictEq`/`emitLooseEq` (Step 3, #1986/#1987/#2081), `emitToNumber`/
`emitToBoolean` (Step 4), then the drift gate (Step 5, #2108).

---

## Implementation Plan — Steps 1-5 (architect, 2026-06-21; consolidated against current main, folds in value-rep keystones)

> **Re-grounding note.** This plan supersedes the bare "Next" line above and
> concretizes report `plan/log/analysis-2026-06/03-coercion-engine-spec.md`
> (the full site inventory — read it; it is still authoritative for the §2
> per-site bug map). Two things changed since report 03 was written (2026-06-11)
> and MUST be folded in rather than re-derived:
>
> 1. **The drift gate (#2108) is already built and wired** —
>    `scripts/check-coercion-sites.mjs` + `scripts/coercion-sites-baseline.json`,
>    `package.json:98` `check:coercion-sites`, run in the `quality` CI job. It
>    already SANCTIONS `coercion-engine.ts` (which does **not exist yet** — it is
>    pre-listed so the gate is live the moment Step 1 creates the file),
>    `any-helpers.ts`, `native-strings.ts`. So Step 5 is **NOT "build the gate"**
>    — it is "ratchet the baseline to ~0 and flip the seal". Every migration PR
>    (Steps 1-4) MUST ratchet the baseline DOWN (`pnpm run check:coercion-sites
>    -- --update-on-decrease`) for the files it drains, or CI's growth check
>    stays flat and the migration shows no progress. **Never let a step grow a
>    per-file count** — that fails the `quality` gate.
> 2. **The value-rep keystones landed.** `#2187`/`#2576` (string-method dispatch
>    by ValType — DONE), `#2583` ($Vec-base any-array brand dispatch — task #27
>    done), `#2584` (dot-vs-bracket dual storage — task #28 done), and the
>    **unified tag-5 field-4 equality spec** (`#2040`/`#2585`, arch commit
>    `4cfb5b9c6`, in-flight impl = task #32 on `sdev-vecdispatch`). Step 3
>    (`emitStrictEq`/`emitLooseEq`) **does not re-derive the equality classifier**
>    — it WRAPS the helper that task #32 produces. See Step 3 below.

### Hard constraint that shapes every step: the tag-5 representation lie is frozen

`boxToAny` (`src/codegen/value-tags.ts:139`, the renamed/relocated successor to
report 03's `type-coercion.ts:1207-1219`) deliberately boxes a generic externref
as **tag 5 / STRING** (`value-tags.ts:185`, `return emit("__any_box_string")`).
This is the #1888 `−794` contract: honest tag recovery at the box site flipped
−794 standalone test262 because the harness `isSameValue` comparator is tuned to
the lie (#2141 tracks retiring it; **blocked on #2167, do not touch it here**).

**Consequence for this engine:** the engine MUST classify by `staticClass`
(static TS type) at emit time wherever resolvable, and where it must fall to the
dynamic tail it MUST go through the **consumer-side** discriminators
(`ref.test`/`ref.eq` over field-4) that the keystone helpers already use — NOT
by trusting the runtime tag for tag-5 values. `__any_to_f64`'s #1888
`$BoxedNumber` recovery arm (`any-helpers.ts:866-905`, gated
`ctx.nativeBoxNumberTypeIdx >= 0`) and the unified eq classifier are the model.
Any engine row that assumes "tag 5 ⇒ it's a string" reproduces the #2585/#2040
disease. This is the single most important invariant in the whole migration.

### Engine API (Step 1 establishes it; current-main types)

Create `src/codegen/coercion-engine.ts`. Exactly the shape from report 03 §3.1,
with these current-main bindings:

- `CoercionMode = "js-host" | "native-strings-host" | "standalone"` — derive
  ONCE from the three ad-hoc spellings that exist today (`noJsHost(ctx)`;
  `ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0`; `ctx.wasi || ctx.standalone`).
- `Operand { valType: ValType | null; staticClass: StaticClass }`. `StaticClass`
  is the classifier from report 03 §3.1; it reuses the **existing** static-type
  facts the matrices already compute — do not invent a parallel type system.
  Source the TS classification from the same `JsStaticType` that `boxToAny`
  already takes (`value-tags.ts:139` param `jsType: JsStaticType`) so the engine
  and the box site agree on the value's static identity.
- Emitters write into an optional `sink?: Instr[]` (default `fctx.body`) so the
  loop builders (join `elemToStr` at `array-methods.ts:5173`, the callback
  truthiness builders) can capture an `Instr[]` instead of emitting inline —
  this is required, the join path constructs an instr array, not a live emit.
- **Representation changes delegate to Step 0's `coercionPlan`**
  (`src/codegen/coercion-plan.ts`, `coercionPlan(from, to, helpers)`). The engine
  is the JS-semantic layer ON TOP; it calls `coercionPlan` for the final
  ValType→ValType bridge and never re-hand-rolls a box/unbox row.

The engine is, per emitter, **one switch over `staticClass` × one switch over
`coercionMode`**, one row per (class, mode). Symbol rows throw TypeError
(absorb `tryThrowOnSymbolStringCoercion`, `emitSymbolToNumberThrow`).

### Step 1 — `emitToString` + skeleton (highest bug density; PR-sized)

**Fixes:** #2005 (`${true}`→"1"), #2006 (`${null}` illegal-cast trap), #1998
(array `join` externref elems trap), #2074 (native-string ref elems null-deref).
Regression-guards the #1997/#2007/#2008 family.

**Files & current-main anchors (verify each before editing — line numbers
drifted from report 03):**

- `src/codegen/string-ops.ts`
  - `compileTemplateExpression` (now `:311`, host templates) — **broken site S4**:
    no bool→"true"/"false" arm (#2005), no null→"null" arm (#2006), opaque
    externref passed raw. Replace its span-conversion with `emitToString`.
  - `compileNativeTemplateExpression` (now `:442`, NS+SA) — **broken site S5**:
    no bool branch (#2005 native half). Same replacement.
  - `compileNativeConcatOperand` (`:127`) and `compileAndCoerceConcatOperand`
    (the batched `__concat_N` site) and the `compileStringBinaryOp` inline
    left/right arms — these are the **correct reference copies** (S1/S2/S3);
    migrate mechanically (behaviour-neutral, diff-checked), they become thin
    `emitToString` callers. `emitBoolToString` (`:380`, `:519`) is the leaf —
    move it INTO `coercion-engine.ts` as a non-exported internal so the seal
    (Step 5) has no exported bypass.
- `src/codegen/array-methods.ts`
  - `compileArrayJoinNative` `elemToStr` (now `:5173`, the `Instr[]` builder) —
    **broken site S7**: handles only f64/i32 (#1998 trap on externref elems,
    #2074 null-deref on native-string ref elems). Build `elemToStr` via
    `emitToString(ctx, fctx, op, sink=elemToStr)`. This is the `sink` motivating
    case.
- `src/codegen/expressions/calls.ts`
  - `String(x)` lowering (report 03 S6, region ~`:8051`+; **re-locate**, calls.ts
    has been split since) — fourth full copy; becomes an `emitToString` caller.

**Dynamic tails stay shared helpers (do NOT inline):** `$__any_to_string`
(`native-strings.ts`, SA tail) and `__extern_toString` (`runtime.ts`, host tail).
The engine's tag-5/dynamic arm calls the mode-appropriate one. **Tag-5 caveat:**
the SA `$__any_to_string` already tag-dispatches over `$AnyValue`; the engine
must hand it the externref unchanged (no "assume string" shortcut like the
current S4 line that says "externref assumed to be string already").

**Ratchet:** after migrating, run `pnpm run check:coercion-sites --
--update-on-decrease`; the per-file counts for `string-ops.ts`,
`array-methods.ts`, `calls.ts` MUST drop. Commit the new baseline.

**Test gate:** repro tests for #2005/#2006/#1998/#2074 (host + standalone),
plus a diff-neutrality pass over `playground/examples/` (reuse the IR-fallback
walker corpus) to prove already-correct programs emit identical Wasm.

### Step 2 — `emitToPrimitive` (+ `+` hint routing)

**Fixes:** #1989 (name-keyed valueOf dispatch — last same-shape literal wins),
#2022 (`+` pre-commits to string concat before ToPrimitive), #1990
(`host_loose_eq` throws on opaque struct with valueOf), #1988 (`__any_to_f64`
ref/string tags fall through to garbage f64val → `1+{}`→NaN).

**Files & anchors:**

- `src/codegen/type-coercion.ts`
  - The `coerceType` ref→f64 ToPrimitive static dispatch (report 03 N3,
    region ~`:1713`+). The **eqref path is the broken half** (#1989) — dispatch
    keyed by struct *type name*. Move the ToPrimitive internals into the engine
    `emitToPrimitive`; keep `coerceType(…, hint)` as a **façade** delegating to
    the engine (do NOT touch its ~100 callers in this PR — report 03 §6 risk).
    Fix #1989 per its own Implementation Plan: per-instance funcref dispatch
    (literals.ts field typing + eqref-path demotion), not name-keyed.
  - `emitToPrimitiveHostCall` / `toPrimitiveHostCallInstrs` (N4, `:94-160`) →
    move into the engine as the host tail chokepoint.
- `src/codegen/any-helpers.ts`
  - `__any_to_f64` (N6, builder around `:830`+; #1888 recovery arm `:866-905`).
    Fix #1988: the ref/string tag arms must do ToPrimitive(number) — route the
    tag-5 externval through the engine's number-ToPrimitive tail, then the
    existing `$BoxedNumber` recovery for genuine boxed numbers. `__any_add`
    (the SA `+` helper) then does ToPrimitive(default) on ref operands before
    re-dispatching concat-vs-add — this is the #1988/#2058 `[]+[]`/`1+{}` fix.
- `src/codegen/binary-ops.ts`
  - `+` operator hint routing (N7, the `compileStringBinaryOp` early-return at
    `:1061`/`:1096`/`:1099`). **#2022 fix:** for ref operands, call
    `emitToPrimitive(op,"default")` FIRST, then branch concat/add on the
    returned primitive `Operand` — do not pre-commit to the string-concat path
    on a string-typed operand. Keep the operator control flow; only the
    conversion source changes.
- SA tail: call #1900's native `$Object` OrdinaryToPrimitive helper
  (`index.ts` ~`:2286` region, PR 1251) — **do not re-implement it**. If #1900
  is still in-review when this lands, the façade isolates the target (report 03
  §6); thread it as the SA `emitToPrimitive` tail.

**Ratchet:** `type-coercion.ts`, `binary-ops.ts`, `any-helpers.ts` (the call
sites, not the sanctioned helper bodies) counts drop. Commit baseline.

**Test gate:** #1989/#2022/#1990/#1988 repros + #2058 (`'1'+1`, `[]+[]`,
`1+{}`) + diff-neutrality.

### Step 3 — `emitStrictEq` / `emitLooseEq` (FOLD INTO the keystone, do not re-derive)

**Fixes:** #1986 (`===` looser than `==`: `null===0`→true), #1987
(`__any_strict_eq` bails on tagA≠tagB before numeric compare → `0===-0`→false),
#2081 (SA any/any loose eq is ref-identity only: `'1'==1`→false), #2073 (SA
`__host_loose_eq` import leak — fix already in flight, engine absorbs its inline
ToNumber closure).

**CRITICAL — this step is a WRAPPER, not a rewrite.** The hard part of equality —
the **tag-5 field-4 3-way classifier** — is owned by the unified spec
(#2040 / #2585, arch commit `4cfb5b9c6`) and being implemented by
**task #32** (`sdev-vecdispatch`, `fix(#2040/#2585)`). That classifier lives in
the **`__any_strict_eq` / `__any_eq` helper bodies** (`any-helpers.ts`, builders
at `:1482` / `:1221`) and does:
- both field-4 externvals genuine strings → `__str_equals` (content);
- either is a `$BoxedNumber` (`ref.test nativeBoxNumberTypeIdx`) →
  `__any_to_f64`+`f64.eq` (keeps `23===23.0` true, `NaN===NaN` false);
- both eqref objects → `ref.eq` (the #2585 proto-identity fix);
- else → conservative content-eq (today's behaviour).

`emitStrictEq`/`emitLooseEq` in the engine are the **dispatch layer that decides
WHICH helper to call and on which boxed operands** — they must NOT contain a
second copy of the classifier. Specifically:

- `src/codegen/binary-ops.ts` equality sites E1-E8 (E2 `__host_loose_eq` at
  `:872`/`:947`/`:952`; E3 `__any_eq`/`__any_strict_eq` dispatch; the
  single-side-any path E4; SA tag dispatch E6) collapse into `emitStrictEq` /
  `emitLooseEq` calls.
- **#1986 fix:** the single-side-any case must BOX the non-any side and route to
  `__any_strict_eq` (so `===` uses the same algorithm as `==`), not fall to the
  numeric `__any_to_f64`+`f64.eq` path that makes `null===0` true. The gate at
  report 03's `:906-908` ("both sides any") is the bug — widen it to "either side
  any" with boxing of the typed side.
- **#1987** is fixed INSIDE the keystone classifier (numeric branch before the
  tag mismatch bail) — the engine just needs to call the fixed helper.
- **#2081 / #2073:** the SA loose-eq tail is the keystone helper plus a
  ToNumber/string-content arm; reuse Step 4's `emitToNumber` (which owns
  `__str_to_number`) — do NOT let #2073's inline `emitToNumber` closure
  (report 03 N9) survive as a 2nd ToNumber matrix; absorb it.
- **Sequencing:** Step 3 BLOCKS ON task #32 landing (the classifier must exist
  before the engine wraps it). If task #32 has merged by the time Step 3 starts,
  this is a clean wrap; if not, Step 3 waits. Do not fork the classifier.

**Ratchet:** `binary-ops.ts` count drops sharply (it is the single largest at
38 in the baseline). Commit baseline.

**Test gate:** #1986/#1987/#2081 repros + #2585 proto-identity (regression-guard
the keystone) + #2073 SA loose-eq + diff-neutrality.

### Step 4 — `emitToNumber` + `emitToBoolean`

**Fixes:** the latently-divergent `buildTruthyCheck`/`buildFalsyCheck` (report 03
B2 — `f64.ne 0` counts NaN truthy; `ref.is_null` counts boxed `0`/`""`/`false`
truthy) — **file this as an issue in this PR** (no number yet per report 03).
Unifies N1 (unary `+`/`-`/`~`) and N2 (`Number(x)`) ToNumber matrices.

**Files & anchors:**

- `src/codegen/expressions/unary.ts` (N1, `:45-165`) and
  `src/codegen/expressions/calls.ts` `Number(x)` (N2, ~`:7907`, re-locate) →
  `emitToNumber`.
- `src/codegen/array-methods.ts` `buildTruthyCheck`/`buildFalsyCheck` (B2,
  region ~`:5121` in report 03, re-locate) and the filter-extern callback
  truthiness (B3) → `emitToBoolean`. This is where the engine's `sink` matters
  again (predicate builders construct `Instr[]`).
- Dynamic tails: `__any_to_f64` (now correct from Step 2), `__str_to_number`
  (`parse-number-native.ts`, SA), `__is_truthy`/`__any_unbox_bool` (host/any).
  `ensureI32Condition` (`index.ts` ~`:11687`, the canonical-ish ToBoolean with
  25 call sites) stays as the primary ToBoolean entry but **delegates its body**
  to `emitToBoolean` so B1 and B2 share one row table.

**Ratchet:** `unary.ts`, `calls.ts`, `array-methods.ts`, `index.ts` counts drop.
Commit baseline.

**Test gate:** `[NaN].filter(x=>x)` drops NaN; boxed-`0`/`""`/`false`
predicates are falsy; unary/`Number()` parity + diff-neutrality. (#1955-family
variadic `fromCharCode`/`fromCodePoint` lowering is a SEPARATE follow-up — it is
arg-forwarding drift, not coercion; do not pull it in.)

### Step 5 — seal the gate (ratchet to ~0, flip to hard)

The gate already exists (#2108). After Steps 1-4 have ratcheted each file's
count down, this step:
1. Confirms the per-file baseline counts are at their floor (the irreducible
   residue is the sanctioned helper bodies + any deliberately-deferred sites,
   each annotated).
2. Moves the remaining engine-internal leaves (`emitBoolToString`,
   `compileNativeConcatOperand`, `compileAndCoerceConcatOperand`,
   `emitToPrimitiveHostCall`) INTO `coercion-engine.ts` as **non-exported**
   internals, and adds the single `ensureCoercionImport()` chokepoint so the
   host-import names have no exported registration path outside the engine
   (report 03 §5.2).
3. Tightens `check-coercion-sites.mjs` from "growth fails" to "any nonzero
   count outside the engine fails" for the tokens whose migration is complete
   (per-token seal, not all-or-nothing — a token seals as soon as its sites are
   all drained).

### Migration order, sequencing & regression plan

- **Order:** 1 → 2 → 4 → 3 → 5 is also acceptable (Step 3 blocks on task #32;
  Step 4's `emitToNumber` is a Step 3 dependency for the SA loose-eq tail, so if
  task #32 is slow, do 1, 2, 4, then 3, then 5). Report 03's 1→2→3→4→5 assumes
  the classifier is ready; honour whichever unblocks first.
- **Each step independently green-mergeable**, ends with: (a) repro tests for
  its named issues, (b) diff-neutrality over `playground/examples/`, (c) a
  RATCHETED `coercion-sites-baseline.json` (counts strictly down for migrated
  files — verify with `pnpm run check:coercion-sites`), (d) `tsc --noEmit`,
  lint/format, `check:ir-fallbacks` clean.
- **Do NOT regress the #2108 gate:** the gate fails on per-file *growth*. Adding
  an `emitToString` call site in `coercion-engine.ts` is free (sanctioned file);
  but if a migration accidentally leaves a NEW hand-rolled token in a
  non-sanctioned file (e.g. a helper extracted to a new file that isn't
  sanctioned), the count grows and CI fails — keep all engine code in the
  already-sanctioned `coercion-engine.ts`/`any-helpers.ts`/`native-strings.ts`.
- **#1888 −794 / −788 contract:** no step changes the boxing (`boxToAny`,
  `value-tags.ts:185`) or the tag table. Steps 1-4 are consumer-side only. CI
  must show no net standalone test262 regression per step (the keystone-touching
  Step 3 is the one to watch — the full-baseline `merge_group` run is gated per
  the #2585 escalation; honour it).
- **`coerceType` entanglement:** Steps 2/4 extract via a delegating façade,
  never a big-bang rewrite of the 1100-line function (report 03 §6).
- **funcidx shifting:** engine tails registered via `ensureLateImport` keep the
  `flushLateImportShifts` discipline (the `addUnionImports` caveats in CLAUDE.md
  apply unchanged); centralizing them in the engine removes a class of
  mid-body-registration index bugs.

### Risks / open questions

- **Task #32 (the equality classifier) is the long pole for Step 3.** Until it
  lands, Step 3 cannot be a clean wrapper. Mitigation: do Steps 1/2/4 first.
- **#1900 (native ToPrimitive) in-review** — if PR 1251 churns, Step 2's SA tail
  target moves; the façade isolates it.
- **Bug-corpus issues remain individually fixable** — nothing here blocks
  #2005/#2006/etc. landing solo first, but each such fix MUST land **as the
  engine row** (Step 1 can split per-issue if scheduling prefers), never as an
  8th hand-rolled copy. The #2108 gate enforces this.
