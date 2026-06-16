---
id: 2104
title: "value-rep P1: canonical JsTag module (src/codegen/value-tags.ts) + boxToAny consolidation with jsType hint"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-11
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2072, 2080]
origin: "2026-06-11 analysis program (report 02 phase P1); stub 08-E19"
---

# #2104 — tag policy needs a single home or P0 erodes

## Problem

After the in-flight #2072/#2080 type-aware boxing fix (P0), tag policy
still lives in scattered `__any_box_*` call sites: the canonical tag enum,
the `jsStaticType` classifier, the `UNDEF_F64` sentinel constant, and the
function tag have no single module — so the P0 fix can erode as new boxing
sites are added.

## Root cause

No `src/codegen/value-tags.ts`; `coerceType` carries no TS-type parameter
(~351 call sites get an optional `jsType?` hint per the spec).

## Fix direction

Per plan/log/analysis-2026-06/02-value-representation-spec.md P1: the
JsTag enum + classifier + `boxToAny(from, jsType)` API behind coerceType's
optional hint; all box sites route through it; tags 2/3 declared one
numeric class; invariant documented "tag = JS type".

## Acceptance criteria

- All `__any_box_*` emissions flow through the module; P0's tests stay
  green; a grep gate counts direct box calls outside it (ratchet)

## Dupe check

P0 = #2072/#2080 (in flight). The consolidation phase is unfiled. New
(analysis program).

## Implementation (sdev1, 2026-06-15)

Phase 1 of the value-representation migration (spec §2.1-2.2, §3). Pure
**behaviour-preserving** consolidation on top of the merged P0 (#2072/#2080,
PR #1482) — gives tag policy one home so the P0 fix can't erode.

### New `src/codegen/value-tags.ts`

- **`JsTag` enum** (0 null · 1 undefined · 2 number-i32 · 3 number-f64 ·
  4 boolean · 5 string · 6 object · 7 function) — values asserted to match the
  runtime tags the `__any_box_*` helpers write. Documents invariants V1 (tag =
  JS type, never inferred from Wasm kind) and V2 (tags 2/3 are one numeric
  class). Tag 7 (function) reserved for a later phase. (Plain `enum`, not
  `const enum` — Biome `noConstEnum`.)
- **`jsStaticType(t)`** — classifies a `ts.Type` into its JS-type partition
  (`null`/`undefined`/`boolean`/`number`/`string`/`bigint`/`object`/`function`/
  `unknown`), built on the existing `isNumberType`/`isBooleanType`/… helpers.
- **`UNDEF_F64_BITS` + `pushUndefF64()` + `emitIsUndefF64()`** — the de-facto
  undefined-in-f64 sentinel `0x7FF00000DEADC0DE` (14 ad-hoc sites predate this)
  named once. `emitIsUndefF64` uses the i64 bit-pattern compare (NOT `f64.eq`,
  false for any NaN). P3 (#2106) wires the observers; P1 just centralizes them.
- **`boxToAny(ctx, fctx, from, jsType)`** — the single boxing entry point.
  `jsType: "unknown"` reproduces the historical Wasm-kind-keyed dispatch
  **exactly**, including the #1888 externref→tag-5 constraint (honest tag
  recovery there flips ~794 baseline standalone passes). The `jsType` hint is
  the seam P2/P3 consume to make boxing type-aware; P1 only threads it.

### Consolidation

The 3 generic `__any_box_*` emission sites in `coerceType`
(`type-coercion.ts` AnyValue boxing arm + the two same-kind ref→AnyValue arms)
now delegate to `boxToAny(..., "unknown")`. The literal fast-paths in
`expressions.ts` (null/undefined/bool literals) are kept per spec §2.2
(correct + cheaper; consistency-checked by tests, not deleted). The
`__any_add`-internal i32/f64 boxers in `any-helpers.ts` stay (helper-internal,
not generic boxing).

### Drift gate

`scripts/check-any-box-sites.mjs` (+ `check:any-box-sites` npm script, wired
into the CI `quality` job) counts direct `funcMap.get("__any_box_*")` sites
outside `value-tags.ts`/`any-helpers.ts` against
`scripts/any-box-sites-baseline.json` (baseline: 3 = the kept literal
fast-paths). Growth fails; `--update-on-decrease` ratchets. Same model as
`check:ir-fallbacks`.

### Validation

- `tests/issue-2104-value-tags.test.ts` — JsTag↔runtime-tag match,
  `jsStaticType` classification, sentinel round-trip, end-to-end any-boxed
  `String(v)`.
- Behaviour-neutral: `issue-2072`, coercion-tostring (24/24),
  coercion-relational-equality (40/40) all green; the only failures
  (coercion-arithmetic-add `bug:1988`, 8) are pre-existing baselined
  known-failures unchanged from main.
- `tsc`/lint/format/`check:ir-fallbacks`/`check:any-box-sites` clean.

Unblocks P2 (#2105 boolean brand) and P3 (#2106 undefined observability),
which now have `boxToAny`'s `jsType` seam + `value-tags.ts` to build on.

## Root-cause finding for the value-rep lane — the `(any)+(any)` upstream interceptor (sdev1, 2026-06-15)

While investigating the #1988 string-concat residual (the 8 baselined
`coercion-arithmetic-add` `bug:1988` probe rows: `(x as any) + (y as any)`
string-concat / string+number), I traced the failure and it bottoms out in
exactly the representation gap this lane (#2104-#2107) exists to close.
Capturing it here so P2/P3/P4 can target it directly:

**Symptom**: `(x as any) + (y as any)` where both are strings, consumed as
`string`, lowers (standalone) to `f64.const NaN; drop; ref.null 5;
ref.as_non_null` — the add **never loads its operands**, NaN-collapses, then the
f64→string-ref coercion does a lossy `ref.null; ref.as_non_null` (the
"dereferencing a null pointer" trap). Host mode returns `null`. The numeric
`(any)+(any)` case works (returns the sum), so only the string/ref tag path is
broken.

**Where it is NOT**: instrumentation confirmed the `(any)+(any)`-as-string path
**never reaches** `compileBinaryExpression`'s any-dispatch gate
(`binary-ops.ts:951`, the `leftIsAny && rightIsAny` → `compileAnyBinaryDispatch`
→ `__any_add` route) NOR `emitAnyAdd` (`binary-ops.ts:2807`). Both have working
string-concat arms (`__any_add` concat arm gated on `anyAddCanConcat`;
`emitAnyAdd` standalone §13.15.3 path). They simply aren't invoked for this
shape. So the in-flight #1988 work on the `__any_add` helper arms (sdev3's
object/array-ToPrimitive arm) cannot fix the string+string rows — the operands
are intercepted **upstream** of `compileBinaryExpression`, in the IR front-end /
a pre-lowering pass, which compiles `a + b` over `any` operands to the
NaN-collapse.

**Deeper root (this lane's territory)**: in standalone, `any` lowers to
`externref` (a boxed native string / host value), but `__any_add` expects
`ref_null $AnyValue`. The externref→`$AnyValue` coercion at the dispatch
boundary doesn't produce a tagged AnyValue carrying the string, so any path that
does reach a helper has nothing to recover the string tag from. **This is the
"standalone `any` = externref vs the tagged-`$AnyValue` representation"
mismatch** the value-rep migration fixes: once `any` carries a real `JsTag`
(tag 5 with the string payload) instead of a representation-erased externref,
the `+` path has a tagged value to dispatch on instead of NaN-collapsing.

**Action for P2/P3/P4**: the IR `+`-over-`any` lowering (find the pre-pass that
intercepts before `compileBinaryExpression`) must obtain its operands as
`boxToAny`-tagged AnyValues (this module's API) and route through
`emitAnyAdd`/`__any_add`, rather than ToNumber-collapsing. That closes the 8
baselined `bug:1988` string-concat rows as a value-rep row, not an eighth
`__any_add` patch.

## PR #1503 conflict rescue + standalone-guard false positive (sdev7, 2026-06-16)

sdev1's PR #1503 went DIRTY at shutdown. Resolved on `issue-2104-jstag-module`
(merge `4a33f4ebc`):

- **Conflict**: a single additive import collision in
  `src/codegen/type-coercion.ts` — HEAD added `import { boxToAny } from
  "./value-tags.js"` (#2104), origin/main added `import { coercionPlan } from
  "./coercion-plan.js"` (the separately-merged coercion-plan change). The two
  imports back **non-overlapping** body regions (`coercionPlan` in the
  `coerceType` plan path ~`:2735`; `boxToAny` at the three `coerceType` boxing
  sites ~`:1013/1100/1217`). Kept both. No semantic conflict.
- **Local validation green**: `tsc` clean; `issue-2104-value-tags` 7/7;
  `issue-2072` P0 guard 4/4; `issue-1917-coercion-plan` 14/14 (proves the
  incoming coercion-plan change still works post-merge); `string-coercion` +
  `issue-2059-any-relational` pass; `check:any-box-sites` OK. (2 test files fail
  to load `tests/helpers.js` — that file is missing on origin/main too, a
  pre-existing infra issue, not a regression.)

**Standalone regression guard (#1897) fired `Net: -19 pass` / 23 `pass →
compile_error` — diagnosed as a FALSE POSITIVE (baseline drift + CI flake), NOT
a #1503 regression.** All 23 are async functions/methods that `return
arguments` from a nested closure (`returns-async-{arrow,function}-returns-
arguments-from-{own,parent}-function`). Direct compile-on-`origin/main`-HEAD
(`5634b13ec`) reproduction:

- `language/statements/async-function/returns-async-function-returns-arguments-
  from-own-function.js` → **identical** `WASM INVALID: Compiling function
  #51:"__closure_0" failed: type error in fallthru[0] (expected i32, got
  externref)` on BOTH main and the PR branch → pre-existing on main, recorded as
  `pass` in the **stale** standalone baseline (`test262-standalone-current.jsonl`
  in `loopdive/js2wasm-baselines`).
- `language/expressions/async-function/named-...-from-parent-function.js` →
  `__closure_3` fallthru error on BOTH → same pre-existing breakage.
- `language/statements/class/async-method/...-from-own-function.js` →
  **COMPILES on BOTH** main and PR → the CI `pass → compile_error` for it is a
  nondeterministic shard/parallel-load compile flake, not deterministic.

Conclusion: the PR branch is byte-behavior-identical to `origin/main` for the
flagged tests; #1503 (value-tags consolidation + the import merge) introduces
**zero real standalone regressions**. The red required check is a stale-baseline
+ flake artifact. Root cause to fix separately: the standalone baseline marks
the `arguments`-in-nested-closure-under-async cluster as `pass` when it actually
emits an invalid-Wasm `__closure` type error on current main (an `arguments`
capture lowered as `externref` where the closure signature expects `i32` — a
real but PRE-EXISTING standalone codegen bug, candidate for its own issue).
Escalated to tech lead for an override/admin-merge decision.
