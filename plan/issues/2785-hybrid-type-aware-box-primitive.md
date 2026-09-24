---
id: 2785
title: "Hybrid: type-aware box primitive (box keyed on the TS type, not the Wasm kind) + re-enable boolean[] OOB→undefined"
status: done
completed: 2026-06-28
assignee: ttraenkler/sendev-box
sprint: 69
created: 2026-06-28
updated: 2026-09-24
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: boxing
goal: correctness
related: [2760, 2766, 2782, 2105, 1788, 864]
---

# #2785 — Type-aware box primitive (box keyed on the TS type, not the Wasm kind)

The foundational enabler that unblocks the deferred i32-arms across the hybrid
lane. It cost **two R1 parks** and forced f64-only / deferred scoping on #2760
and #2782.

## Problem (root cause)

Boxing an `i32`/`f64` value to `externref` went through a **type-BLIND** box at
the single coercion site:

```
coerceType(i32 → externref)  ==>  f64.convert_i32_s ; call __box_number
```

But `i32` at the Wasm level is **overloaded**. It backs:

- `number[]` (fast-mode i32 packing),
- `boolean[]` (a boolean is `i32` 1/0, branded `{ kind:"i32", boolean:true }`),
- `symbol[]` / symbol-handle arrays (a symbol is an `i32` _handle_/id), and
- other handle reps.

`__box_number` treats the `i32` as a number, so it turns a boolean `true`
(`i32` 1) into the **number 1** and a symbol handle into a **number**. Concretely:

- The R1 floor F1 (#2760, folded into #2766) widened a plain-array OOB read to
  `OOB → undefined` by boxing the in-bounds element via
  `coerceType(i32→externref)`. That mis-boxed boolean/symbol `i32` elements →
  **two merge_group parks**:
  - `built-ins/Object/values/symbols-omitted.js` — `Object.values({k:sym})[0]
=== sym` failed (symbol handle boxed as a number);
  - 21 standalone `built-ins/Array/prototype/map/15.4.4.19-*` — `result[0] ===
true` failed (boolean `true` boxed as the number 1; in standalone native
    `===`, `number 1 !== boolean true`).
- ef2a591 (#2766) therefore **narrowed F1 to the `f64` (`number[]`) element
  ONLY** — `f64` is unambiguously a number, so `__box_number` is always correct
  there. `i32` (boolean[]/symbol[]) OOB→undefined was **deferred** "pending a
  type-aware box".

This issue builds that type-aware box.

## The fix

A box choice **keyed on the TS type, never on the Wasm kind**. The carrier of
the TS type onto the `ValType` is the existing **brand** field (the same
mechanism as the `bigint` brand on `i64` and the `boolean` brand on `i32`):

| element TS type | branded ValType           | box helper      |
| --------------- | ------------------------- | --------------- |
| `number`        | `{ kind:"f64" }` / `i32`  | `__box_number`  |
| `boolean`       | `{ kind:"i32", boolean }` | `__box_boolean` |
| `symbol`        | `{ kind:"i32", symbol }`  | `__box_symbol`  |

The box site (`coerceType(i32 → externref)`) now **reads the brand** and selects
the right helper instead of unconditionally calling `__box_number`.

### Runtime helpers — all three already exist

- `__box_number` — host: identity `(v)=>v`; standalone: native `__box_number`
  struct (`addUnionImportsAsNativeFuncs`).
- `__box_boolean` — host: `(v)=>Boolean(v)` (import-manifest `box`/`boolean`);
  standalone: native `__box_boolean` struct (a **distinct** struct type from
  `__box_number`, classified as a boolean — tag 4 — by `__any_from_extern`, so
  `boxedBoolean === true` is value-correct in standalone). No new helper needed.
- `__box_symbol` — host: `(id)=>cachedSymbol(id)` (runtime.ts, identity-stable).
  **Standalone has NO native `__box_symbol`** → symbol box in standalone is a
  genuine fast-follow (see below).

## Scope landed in this PR (kept landable)

1. **Type-aware box primitive (core).** `coerceType` `i32 → externref` (the
   `f64`/`i64` arms left unchanged) consults the brand: `boolean → __box_boolean`,
   `symbol → __box_symbol` (host; guarded — falls back if the helper is absent),
   else `__box_number`. Added the `symbol?: true` brand to the `i32` `ValType`
   variant (`src/ir/types.ts`) — structurally inert, every `.kind === "i32"`
   check still matches.
2. **End-to-end proof — re-enable `boolean[]` OOB→`undefined`** (host +
   standalone). The brand is **erased in `arrDef.element`** by structural array
   dedup (arrays dedupe by structure, so `boolean[]`/`number[]`/`symbol[]` share
   one `$vec_i32` struct — confirmed by array-methods.ts:5318), so the F1 call
   sites in `compileElementAccessBody` **reconstruct the box ValType from the
   receiver's TS element type** (`f1ElementBoxType`) and pass it to
   `emitPlainArrayUndefinedOobGet`, which forwards it to `coerceType`. Only
   `f64` (number, unchanged) and brand-reconstructed **boolean** `i32` are
   widened; every other `i32` (symbol / packed-number / unknown handle),
   externref, and ref element **falls through to the unchanged shared-helper
   read** (bounds-checked type-default, never traps) exactly as on current main.

## Fast-follow (documented, NOT in this PR)

- **`symbol[]` OOB→undefined at the array-read site** — needs a **native
  standalone `__box_symbol`** (host already works). Until then `symbol[]`
  elements fall through (so `symbols-omitted` stays green). The primitive's
  symbol arm is already wired in `coerceType`.
- **Broad symbol branding in `type-mapper.ts`** (`ESSymbol`/`UniqueESSymbol` →
  `{ kind:"i32", symbol:true }`) so symbol locals/params/returns coerced to
  `externref` route through `__box_symbol`. Deferred to bound blast radius;
  the array-read proof reconstructs the brand at the call site instead.
- **The #2782 i32-number-local box arm** — re-enable now that the primitive
  exists.
- **`coercionInstrs` brand routing** (the #1917 coercion-table `coercionPlan`
  path) — parallel to the imperative `coerceType` fix; not on the proof path.

## Why brand-at-the-call-site (not brand-on-arrDef.element)

The `boolean`/`symbol` brand is **structural-only** and does NOT survive into
`arrDef.element` (arrays dedupe by structure). So the array-element-read site
cannot read the brand off the element ValType — it must recover the semantic
element type from the receiver's TS type (the same discipline
`arrayElementIsBoolean` already uses for `Array.prototype.join`). The reusable
primitive (`coerceType` reading the brand) is correct wherever the ValType DOES
carry the brand (typed locals/params/returns, the IR box-demote, #2782's arm);
the array-read site re-grounds the brand that dedup erased.

## IR path

The IR has **no box primitive** — `coerceReturnValue` / the throw-statement box
/ the #2782 box arm all **demote to legacy** for any numeric→externref box
(`emitSafeVecGet` keeps the element ValType and defers the "observed as
`undefined`" case to legacy F1). So the IR inherits the type-aware box for free
via demote-to-legacy; only the deferral doc-comments are updated.

## Acceptance criteria

- `coerceType(i32→externref)` boxes `boolean → __box_boolean`,
  `symbol → __box_symbol` (host), `number → __box_number`.
- `boolean[]` OOB read → JS `undefined`; in-bounds read → correct `true`/`false`
  (host + standalone).
- `number[]` OOB→undefined regression guard stays green (F1 unchanged for f64).
- Canaries green: `Object/values/symbols-omitted.js` and the standalone
  `Array/prototype/map/15.4.4.19-*` boolean tests.
- No net test262 regression in the `merge_group` re-validation.

## Files changed

- `src/ir/types.ts` — add the `symbol?: true` brand to the `i32` `ValType`.
- `src/codegen/type-coercion.ts` — `coerceType(i32 → externref)` is now
  type-aware (brand → `__box_boolean` / `__box_symbol` / `__box_number`).
- `src/codegen/property-access.ts` — `f1ElementBoxType` (brand reconstruction
  from the receiver TS type); `emitPlainArrayUndefinedOobGet` takes a branded
  `boxType`; both F1 call sites widen `number[]` (f64) **and** `boolean[]`
  (branded i32), defer the rest.
- `src/ir/from-ast.ts` — doc note: legacy's box is now type-aware, so the IR's
  numeric→externref demote-to-legacy is type-correct for boolean/symbol too.
- `tests/issue-2785.test.ts` (new), `tests/issue-2760.test.ts` (boolean[] OOB
  assertion flipped `false`→`undefined`), `plan/log/hybrid-fastpath-audit.md`.

## Test Results

Local (scoped — broad-impact conformance validated by full CI/merge_group):

- `tests/issue-2785.test.ts` (20) + `tests/issue-2760.test.ts` (19) +
  `tests/issue-2766.test.ts` (15) = **54 green**.
- Array / coercion / element-access sweep (bounds-elim, OOB, array-methods,
  externref/class element access, call-arg + relational coercion, #1788,
  functional-array, standalone-map): **67 green** (6 files skipped — a
  pre-existing missing `tests/helpers.js` load issue on origin/main, unrelated
  to codegen).
- Symbol / `Object.values` / array-method lane (#2105, #864, object-keys-values,
  symbol-iterator, #2610/#2378 symbol value-read, #1732): **76 green** — the
  first-park lane (symbol[] deferred, not mis-boxed) intact.
- `check:ir-fallbacks` OK (no bucket growth); `check:stack-balance` OK
  (`default-value-lossy` −36, no increases); `tsc --noEmit` clean.

Empirical probes (host + standalone), all correct:

- `boolean[]` OOB → `undefined`; in-bounds → `true`/`false` (boxed via
  `__box_boolean`, value-correct in standalone native `===`).
- `number[]` OOB → `undefined` (regression guard).
- Canaries: `Object.values({k:sym})[0] === sym` (symbol identity preserved);
  `[1,-1,2].map(x=>x>0)[i] === true/false` (the 2nd-park boolean-map shape);
  `Array.prototype.map.call(arrayLike, cb)[2] === false` (S2 externref OOB,
  host — unchanged).

## Follow-up (2026-09-24): map-on-array-like canary regressed on main

The host canary `map-on-array-like (15.4.4.19-8-b-2)` in
`tests/issue-2785.test.ts` failed on `main` with `TypeError: object is not a
function`. Nothing ran it: CI only runs the test files a PR touches, and it
surfaced when PR #6044 edited this file's harness.

Cause: `__proto_method_call` host-wraps every struct arg first, then passed
that Proxy to `_maybeWrapCallable`. A Proxy is not a Wasm ref, so
`__is_closure` rejected it and the compiled callback reached V8 as a plain
object. Any `Array.prototype.<callback-method>.call(nonArray, fn)` hit it.

Fix: classify the RAW arg and substitute the wrapper only when it is callable.
Regression test: `tests/issue-2785-proto-call-callback.test.ts`.
