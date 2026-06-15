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
