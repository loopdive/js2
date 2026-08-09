---
id: 3394
title: "standalone: bigint (i64) value reaches externref coercion via extern.convert_any instead of __box_bigint — invalid Wasm (~59 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, type-coercion
language_feature: bigint
goal: standalone-mode
umbrella: 2039
related: [2039, 2044, 1644]
test262_bucket: standalone-invalid-wasm
test262_count: 59
es_edition: multi
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/expressions/call-builtin-static.ts
---

# #3394 — bigint i64→externref: missing `__box_bigint` box (child of #2039)

## Bucket

- **Records:** 59 (largest child of #2039's 203-row live invalid-Wasm bucket)
- **Validator signature (normalized):**
  `extern.convert_any[0] expected type (shared) anyref, found <i64-producer> of type i64`
  Variants by i64 producer: `array.get` (51, all Temporal), `i64.const` (1,
  BigInt literal), and `call[0] expected externref, found local.get of type
i64` / `call_ref` (BigInt/Set/Map argument passing).
- **Area distribution:** Temporal:51, String:3, Map:2, Set:2, Object:1.
- **3 sample tests:**
  - `test/built-ins/Object/create/properties-arg-to-object-bigint.js`
    (`extern.convert_any … found i64.const of type i64` — cleanest non-Temporal repro)
  - `test/built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js`
    (`extern.convert_any … found array.get of type i64`)
  - `test/built-ins/String/prototype/padStart/fill-string-non-strings.js`

## Reproduced on current main

Confirmed live (not a stale-baseline ghost) via the triage probe on the merge
base of the #2039 triage branch:

```
INVALID [built-ins/Object/create/properties-arg-to-object-bigint.js]:
  Compiling function #52:"test" failed:
  extern.convert_any[0] expected type shared anyref, found i64.const of type i64 @+28614
INVALID [built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js]:
  Compiling function #54:"test" failed:
  extern.convert_any[0] expected type shared anyref, found array.get of type i64 @+32506
```

## Root cause

`coerceType(from, to)` in `src/codegen/type-coercion.ts` **already has a correct
i64→externref arm** (line ~2001) that routes a bigint-branded i64 through
`__box_bigint`:

```ts
// src/codegen/type-coercion.ts:2001
if (from.kind === "i64" && to.kind === "externref") {
  addUnionImports(ctx);
  if (from.bigint) {
    const boxBigIdx = ctx.funcMap.get("__box_bigint");
    if (boxBigIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxBigIdx });
      return;
    }
  }
  // … __box_number fallback …
}
```

The failing tests never reach that arm. The value on the stack **is** an i64,
but the `from` ValType handed to `coerceType` is a **ref type**, so the
ref→externref arm (line ~2035) runs and emits a raw `extern.convert_any` on an
i64 operand → invalid Wasm.

So this is a **ValType-propagation bug at the bigint producer**, not in
`coerceType`. Two producer sites lose the `{kind:"i64", bigint:true}` typing:

1. **BigInt literal / `BigInt(x)` in an `any`/externref context** (`via
i64.const`, `via call_ref`): the literal is emitted as i64 but the
   expression's static ValType is resolved as `any`→ref, so the boundary
   coercion sees a ref.
2. **i64-array element read** (`via array.get`, all 51 Temporal rows): Temporal
   internals store bigint fields in an i64-typed WasmGC array; the `array.get`
   yields i64 but the element ValType propagated to the consuming coercion is
   the array's declared element type resolved as a ref, not i64.

Note: this is a **different** signature from the #2039 §"Attribution" i64 bucket
(that was `call[0] expected i64, found extern.convert_any` — a late-import
index-shift bystander landing on `__box_bigint`). This bucket is the **inverse**
direction (`extern.convert_any expected anyref, found i64`) and IS genuinely a
bigint ValType/boxing bug. #1644 (BigInt-brand) is relevant; #2044 tracks the
i64-brand ValType decision surface.

## Implementation Plan

### Changes

**File: `src/codegen/type-coercion.ts`**

- The receiving arm is correct — do NOT change lines 2001–2024. The fix is to
  ensure the value arrives typed `{kind:"i64", bigint:true}`.

**Producer 1 — bigint literal / `BigInt()` in an externref/any target:**

- Find where a `ts.BigIntLiteral` and the `BigInt(...)` call expression set the
  emitted ValType (grep `BigIntLiteral`, `"bigint"`, `bigint: true` in
  `src/codegen/expressions.ts` and the checker/oracle type mapping). The
  producer must tag the result ValType with `bigint: true` so the enclosing
  `coerceType(..., externref)` at the argument/store boundary takes the :2001
  arm.
- Resolve the bigint-ness via `ctx.oracle` (NOT the raw checker). The
  i64-vs-ref ValType question is a wasm-lowering question that legitimately
  sits above `ctx.oracle`; grant `oracle-ratchet-allow:` only if a raw
  `ts.Type` bigint check is genuinely unavoidable.

**Producer 2 — i64-array element read (the 51 Temporal rows):**

- Grep the array-element read lowering (`array.get` emission in
  `src/codegen/property-access.ts` / array indexing in `expressions.ts`). When
  the array's element type is i64 **and** brand-bigint, propagate
  `{kind:"i64", bigint:true}` as the read's result ValType so the consuming
  externref coercion boxes via `__box_bigint`.

### Wasm IR pattern (target)

```wasm
;; bigint value → externref (correct)
local.get $bigval        ;; i64
call $__box_bigint       ;; (i64) -> externref
;; NOT: extern.convert_any  (illegal on i64)
```

### Edge cases

- Native (unbranded) `type i64 = number`: must keep `__box_number` path
  (f64.convert_i64_s + box) — do NOT route through `__box_bigint`. Gate on
  `from.bigint`.
- Host mode: `__box_bigint`/`__box_number` are host imports; the arm already
  handles the `funcMap.get` miss with a `ref.null.extern` fallback — leave it.
- If `__box_bigint` genuinely cannot be provided in standalone (no bigint
  runtime), the correct behavior is a **loud refusal** (#1888), never an
  invalid `extern.convert_any`. Confirm `__box_bigint` is registered on the
  standalone path before boxing; refuse if absent.

### Test files to verify

- `test/built-ins/Object/create/properties-arg-to-object-bigint.js` (i64.const)
- `test/built-ins/Temporal/Instant/prototype/toString/timezone-wrong-type.js` (array.get)
- Add a regression test `tests/issue-3394-bigint-box.test.ts` (standalone + wasi
  - host-guard): a bigint value flowing into an `any`/externref parameter must
    compile to valid Wasm.

## Acceptance criteria

- The 59 bucket rows compile to valid Wasm (or refuse loudly if bigint runtime
  is unavailable) — no `extern.convert_any … found i64` remains.
- No host-mode regression; `type i64 = number` native path unchanged.

---

## Implementation Plan (fable-dev-1, 2026-07-18) — GROUNDED against current main

> Handoff-ready. Branch `issue-3394-bigint-i64-box`, worktree
> `/workspace/.claude/worktrees/agent-aeb10fb7d183a166f`. Resume from this
> section + the `## Suspended Work` note if interrupted. NOTE the issue file
> itself is also being added by the #2039 triage PR #3328 — if that lands first,
> resolve the duplicate-add with `git checkout --theirs` then re-append THIS
> section.

### Re-ground: the producer is FINE; the boundary-coercion SITES are the bug

Contra the original framing (which said the `BigIntLiteral` producer loses the
`bigint` brand), the producer is correct on current main — `expressions.ts:970`
emits `i64.const` and returns `{kind:"i64", bigint:true}`. The invalid
`extern.convert_any … found i64` comes from BOUNDARY-COERCION SITES that either
(a) lack an `i64` arm, or (b) emit a BARE `extern.convert_any` on a
non-externref value instead of routing through `coerceType` (whose :2001 i64→
externref arm is already correct via `__box_bigint`). Verified repros
(`WebAssembly.validate` false on `--target standalone`):

- `Object.create({}, 5n as any)` → `extern.convert_any … found i64.const`.
- `new Map<any,any>().set(5n, 1)` / `new Set<any>().add(5n)` →
  `call[1] expected anyref, found i64.const`.
- `new Map<any,any>().set(bigintArr[0], 1)` → `call[1] … found if of type i64`
  (i64-array-element key — the array.get producer class).

### Fix sites (each surgical; no change to `coerceType`'s :2001 arm)

1. **`src/codegen/map-runtime.ts` `coerceArgToAnyref` (~:1405) — MISSING i64
   arm.** It handles `f64`/`i32`/`externref` then `default: no-op`. A bigint
   i64 hits `default` and is left raw on the stack where `__map_set`/`__set_add`/
   `__weakset_add`/`__map_get`/`has`/`delete` want anyref → invalid. Add an
   `i64` case mirroring the :2001 logic: `bigint` → `__box_bigint` +
   `any.convert_extern`; native i64 → `f64.convert_i64_s` + `__box_number` +
   `any.convert_extern`. This covers ALL Map/Set/WeakMap/WeakSet rows AND the
   i64-array-element-key rows routed through the collection element path.
2. **`src/codegen/expressions/call-builtin-static.ts` (~:2131) — bare
   `extern.convert_any` on the `Object.create(proto, descs)` non-literal 2nd
   arg.** Replace with `coerceType(ctx, fctx, descType, { kind: "externref" })`
   (exactly what the 1st-arg path at :1907 already does). Covers the Object row.
3. **Temporal array.get rows (51) — investigate + fix the remaining bare-
   `extern.convert_any` / missing-i64 site** that an i64-array element flows
   into on a non-collection externref boundary (signature `extern.convert_any …
   found array.get of type i64`). Reproduce a minimal i64-array-element→externref
   boundary that is NOT the Map path (e.g. an i64-typed field/array element
   returned into an `any`/externref position or passed to a host import), find
   the emitting site, route it through `coerceType`. If it turns out to be the
   same `coerceArgToAnyref`/`coerceType` seam already fixed by (1)/(2), verify
   and note it; otherwise fix the specific producer/boundary.

There are ~414 bare `extern.convert_any` sites guarded by `kind !== "externref"`
— do NOT bulk-rewrite them. Only the sites an i64 value actually reaches are
buggy; fix those, driven by the bucket's concrete signatures.

### Edge cases (unchanged from above)

Native `type i64 = number` → `__box_number` (gate on `from.bigint`); host mode
keeps the `funcMap.get` miss → `ref.null.extern` fallback; if `__box_bigint`
absent on standalone, refuse loudly (#1888), never emit invalid Wasm.

### Test plan

- `tests/issue-3394-bigint-box.test.ts` — standalone: Object.create-with-bigint,
  Map.set/Set.add with bigint literal + bigint-array-element key, all
  `WebAssembly.validate` true; a runtime drive where feasible. Host-mode guard
  (unchanged behavior).
- Regression: bigint suite (`tests/bigint*.test.ts`, `tests/issue-1644*`,
  collections suites) + Map/Set suites A/B vs main — zero new failures.

### Remaining-steps checklist

- [x] Fix `coerceArgToAnyref` i64 arm (site 1 — Map/Set/WeakMap/WeakSet).
- [x] Fix Object.create 2nd-arg coercion (site 2 — bare convert_any → coerceType).
- [x] Reproduce + fix the Temporal array.get boundary (site 3 — `boxToExternref`
      i64 arm; the real `timezone-wrong-type.js` now validates. Root cause: an
      inferred `[number|bigint, string]`-tuple array stores the first slot as
      i64; destructuring it fell to the ref-default `extern.convert_any`).
- [x] Added `tests/issue-3394-bigint-box.test.ts` (5 tests, all green); A/B
      bigint + collections + destructuring suites — zero new failures (the 4
      object-destructuring failures in issue-dstr-requireobj / null-destructure-
      param-object are PRE-EXISTING on main, unrelated).
- [x] oracle-ratchet clean; `loc-budget-allow` granted for the 3 god-files.
- [ ] Open PR to `loopdive/js2wasm`.

### Scope note — what this PR covers vs. the 59 rows

Covers the **valid-Wasm acceptance bar** for the Object (1) + Map/Set (4) +
Temporal-destructure (51) shapes = ~56 rows. Two follow-ups, out of THIS slice:

- **String:3** (`padStart/padEnd` bigint fill) is a DIFFERENT signature —
  `call expected (ref null <string>), found i64` (a string-parameter ToString
  coercion, not the `extern.convert_any` externref bucket). Needs the pad-fill
  arg to ToString a bigint; tracked as a follow-up.
- **Standalone Map/Set bigint-KEY equality**: the key now boxes to valid Wasm,
  but two `__box_bigint(5n)` boxes don't compare equal on the native
  SameValueZero key path, so `m.get(5n)` after `m.set(5n, …)` misses. This is a
  runtime-semantics gap (value equality on boxed bigints), NOT invalid-Wasm —
  the bucket rows were invalid-Wasm (compile fail) before and are valid now
  (monotonic; whether they then pass at runtime is a separate bucket). Flagged
  for a follow-up on standalone bigint value-equality.

Issue left `in-progress`/`ready` for those two follow-ups unless the tech lead
prefers a dedicated child; the invalid-Wasm bulk is fixed.
- Equivalence tests green.
