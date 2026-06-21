---
id: 2043
title: "architecture: retire the late-import function-index-shift bug class (always-on emit-time index validation + stale-proof func references)"
status: done
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
completed: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: refactor
area: codegen, emit
language_feature: compiler-internals
goal: standalone-mode
related: [1809, 1839, 1602, 1886, 1666, 1677, 2029, 2039]
origin: "2026-06-10 standalone gap review: the index-shift class has recurred ≥6 times (#1809, #1839, #1602, #1886, #1666, #1677) and is back again as #2029 (497 tests) — each fix was a point patch; this issue is the structural fix that ends the class."
---

# #2043 — Retire the late-import index-shift bug class structurally

## Problem

The single most-recurrent compiler bug class: a function/type/global index is
captured into a JS variable, a deferred late-import flush
(`flushLateImportShifts` / `addUnionImports` / `addStringImports`) shifts the
index space, and the captured value goes stale — or a failed `funcMap` lookup
bakes `-1`. Symptoms range from the opaque
`Binary emit error: u32 out of range: -1` to *silently valid-but-wrong*
indices that surface as random `expected externref, found i32` validator
failures on unrelated tests.

History of point fixes, each closing one instance and leaving the class open:

| Issue | Instance |
| --- | --- |
| #1809 | shift walker missed method-trampoline funcIdx pointing at an import |
| #1839 | `addStringImports` shift omitted `pendingInitBody` / `nativeStrHelpers` / `startFuncIdx` |
| #1602 / #1886 | earlier instances of the same capture-then-shift pattern |
| #1666 / #1677 | `--target wasi` native-helper func-index shifts (`__str_flatten` / `__str_to_extern`) |
| **#2029** | **current**: 497 standalone tests, `u32 out of range: -1` — and the env-gated `validateFuncRefs` guard does NOT catch it, so the poisoned index is outside the walked funcref locations (type/global/export/element) |

The pattern recurs because the design invites it: raw integer indices are
copied freely while the index space is still mutable, and nothing structurally
prevents a stale copy from reaching the encoder.

## Scope — the structural fix (architect-level decision)

Evaluate and ratify one (or a layered combination) of:

1. **Always-on, total emit-time validation.** Promote `validateFuncRefs`
   (`src/emit/binary.ts:105`, currently env-gated behind
   `JS2WASM_VALIDATE_FUNCREFS`) to always-on, and extend it from
   `call`/`return_call`/`ref.func` to **every index space the encoder writes**:
   type indices (`call_ref`/`struct.*`/`array.*`/block types/`ref null <t>`),
   global indices, table/element/export/start entries, and exception tags.
   Cost is a single linear walk per emit; it converts every future instance
   into a named, located codegen error at compile time (#2029 proves the
   current walker's coverage is insufficient).
2. **Stale-proof references.** Replace raw captured `funcIdx: number` with a
   handle that survives shifts — either (a) symbolic references (name or
   handle object) resolved to integers only inside `emitBinary`, after the
   last possible shift; or (b) a `FuncRef` cell object `{ idx }` that the
   shift walker updates in place, so every holder sees the shift. (a) is the
   clean fix; (b) is the incremental one that doesn't require touching every
   call site at once.
3. **Freeze-point discipline.** A module-level `indexSpaceFrozen` flag set
   after the final flush; any `ensureLateImport`/`addImport` afterwards
   throws immediately at the call site (the producer), not later at the
   encoder (the symptom).

Deliverable: an `## Implementation Plan` ratifying the design with exact
touch points (`src/emit/binary.ts`, `src/codegen/expressions/late-imports.ts`,
`addUnionImports` in `src/codegen/index.ts`), the migration order, and the
perf budget — then sized child slices for an Opus dev to implement.

## Why model: fable

Six Opus-level point fixes have not ended the class. The fix that does is a
cross-cutting representation/invariant decision touching every index producer
and both backends — wrong choices here either false-fire on long-tail
constructs (a hard validator rejecting valid modules) or miss the next
instance again. This is decision work, not instance work.

## Acceptance criteria

- A ratified design doc (in this issue) choosing among options 1–3 with
  rationale, plus sized child issues.
- Emit-time validation covers all index spaces and is always-on (or the
  ratified equivalent), with measured emit-time overhead < 5% on the
  playground-examples corpus.
- #2029's repro (`class A extends Uint8Array {}` under `--target standalone`)
  produces a named, located codegen error (or compiles correctly) — never the
  raw encoder RangeError.
- A regression test that simulates a stale captured index and asserts the
  named-error path fires.

## Implementation Plan (ratified 2026-06-10, sd-fable-emit)

### Decision: layered — Option 1 now (landed in this PR), Option 3 + Option 2(b) as child slices

**Option 1 is ratified and landed, with one deliberate deviation from the
issue text: the checks live INLINE at the encoder write sites, not in a
separate pre-emit walk.** Measured on the playground-examples corpus
(CPU-time, interleaved A/B with forced GC, `process.cpuUsage` — wall-clock
was unusable at load ≈ 15): a separate full walk costs **~15% of emit CPU**
(emit does less work per instruction than the issue's "single linear walk is
cheap" framing assumed — even after numeric-kind dispatch and a charcode
fast-path, the walk's per-instruction dispatch rivals the encoder's own).
Inline checks measured **median overhead −7% / +0.5% / +3.1% across three
runs — statistically indistinguishable from zero**, comfortably inside the
<5% budget. Inline also gives *coverage by construction*: every `ValType`
serialization funnels through `encodeValType`, every instruction immediate
through `encodeInstr`, every import/export/supertype/block-type through its
single encode helper — a future emission site cannot dodge the guard,
whereas a separate walker must be remembered and extended (exactly how
`validateFuncRefs` missed #2029's `global.get -1`).

**What landed (`src/emit/binary.ts`):**

- `EmitValidationCtx` + module-scoped `valCtx`, armed only inside
  `emitBinaryWithSourceMap` (try/finally). The relocatable object emitter
  (`src/emit/object.ts`) reuses the encode helpers with **symbolic
  placeholder indices** and intentionally runs unchecked — that is why the
  context is nullable rather than the checks being unconditional.
- Per-space range checks at every index write: functions
  (call/return_call/ref.func/exports/elements/declaredFuncRefs/start), types
  (function & import & tag signatures, call_indirect/call_ref/struct/array
  immediates, block types, supertypes), heap-type s33 positions
  (ref.null/ref.cast/ref.cast_null/ref.test + `ValType` ref/ref_null —
  negative abstract heap codes in [-64, -2] stay legal; **-1 is rejected
  even though negative**: 0x7f is not a heap type and -1 is exactly the
  failed-lookup poison, see #1338), globals, locals (against params+locals
  resolved from the flat type table), exception tags (throw/try-catch/
  exports), tables, struct field indices (when the struct resolves), memory
  exports.
- `rec`-wrapper safety: if `mod.types` ever contains rec wrappers (positions
  ≠ indices), resolution-dependent checks (struct fields, local param
  counts) self-disable; pure bound checks stay valid via nested counting.
- Always-on; `JS2WASM_SKIP_INDEX_VALIDATION=1` is the escape hatch. The old
  `JS2WASM_VALIDATE_FUNCREFS` opt-in gate and its walker are retired.
- Soundness: a pure range check accepts every in-range index, so it can
  never reject a module the encoder would have serialized into a
  structurally valid binary. False-fire sweep: all 39 corpus compiles
  (gc/wasi/standalone × 13 files) have **identical outcomes** with and
  without validation; wasi suite 24/24; scoped equivalence subset 39/39;
  the 10 `imported-string-constants` failures are pre-existing on main
  (#1677 note, `__box_number requires a callable`).

**Diagnostic yield for #2029 (producers identified, NOT fixed here):** the
repro's poison is a **`global.get -1` in `MyArr_new`**, baked by
`emitSetSubclassProto` (`src/codegen/class-bodies.ts:232-250`): under
standalone/nativeStrings, `addStringConstantGlobal`
(`src/codegen/registry/imports.ts:74`) stores the documented **-1 sentinel**
in `stringGlobalMap` ("materialize inline at use sites"), and
`emitSetSubclassProto` checks only `undefined`, not the -1 sentinel, before
emitting `global.get`. Any other unchecked `stringGlobalMap.get` consumer is
suspect for the same bucket (Object.create / Iterator.prototype /
DisposableStack clusters) — that is task `fix(#2029)`.

### Why options 2/3 are still needed (residual risk)

Range checks cannot see an **in-range stale** index (captured before a
+delta shift, still pointing at a real-but-wrong slot — the wasmtime
"expected externref, found i32" flavor). Two child slices close that:

- **#1984 (Option 3, freeze-point discipline)** — small, next.
  `ctx.indexSpaceFrozen` set after the last legitimate flush in
  `generateModule`/`generateMultiModule` finalize; `addImport`/
  `ensureLateImport` throw at the *producer* call site afterwards. Converts
  "wrong index emitted later" into "illegal import added HERE".
- **#1985 (Option 2(b), stale-proof index cells)** — incremental.
  Replace raw captured `funcIdx: number` with a shared `{ idx }` cell the
  shift walker updates in place, starting with the recurring offenders:
  `pendingMethodTrampolines.methodFuncIdx` (#1809), `nativeStrHelpers`
  (#1839/#1677), late-import bridge captures. Option 2(a) (fully symbolic
  references resolved at emit) remains the end-state for NEW emission paths
  but is not worth a big-bang migration: with #2043 + #1984 landed, every
  instance is a located compile error instead of silent corruption, so the
  cells can migrate site-by-site at low risk (the #618 lesson: big-bang
  shift-regime changes regress thousands of tests).

### Migration order

1. **This PR** — inline always-on validation + named errors + regression
   tests (`tests/issue-2043.test.ts`, `tests/funcref-emit-guard.test.ts`).
2. **#1984** freeze-point (cheap; catches producers at the cause site).
3. **fix(#2029)** producer fixes using the new named errors (497 tests).
4. **#1985** index cells for the three recurring capture sites, then
   opportunistically as sites are touched.

## Harvest update — 2026-06-19 (run `e9579720`, dated 2026-06-18)

The structural validation **worked in the default lane**: only **2** records
still hit the late-import index-shift class there (down from the dozens of prior
recurrences). **Standalone is not retired**: **229** records still emit the
named errors — `function index out of range — … late-import index-shift class
(#2043)` and `global index out of range — … late-import index-shift` — confirming
this is now a standalone-codegen producer gap, exactly the **#2029** territory
(`in-progress`, 497 tests). No regression of the validation itself; the
remaining producers are owned by #2029. Cross-ref recorded for the harvest.
