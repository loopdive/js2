---
id: 1919
title: "standalone invalid-Wasm residual bucket after #1623/#1666/#1677: async-gen i64 ABI, __obj_find externref key, __str_flatten, arguments arity (~1,135 tests)"
status: in-progress
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: codegen, emit
language_feature: async-generators, classes, private-names, strings
goal: standalone-mode
related: [1623, 1666, 1677, 1776, 1807, 1916]
test262_bucket: standalone-invalid-wasm
test262_count: 1135
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff: 1,330 non-Temporal gap rows are WebAssembly.instantiate validation failures; 195 are owned by #1916 (Array generics); this issue tracks the remaining ~1,135, split by signature."
---

# #1919 — standalone invalid-Wasm residual bucket (split by signature)

## Problem

After the #1623/#1666/#1677 type-boundary fixes, the 2026-06-10 standalone
baseline still contains ~1,135 gap tests (host-pass) whose standalone binary
**fails Wasm validation** at instantiate time. Every one of these violates the
#1888 dual-mode invariant (refuse loudly, never emit invalid Wasm). Split by
validator signature (function × first mismatch):

| Count | Signature | Representative test | Suspected area |
| ---: | --- | --- | --- |
| ~230 | `"f"` / `"fn"` `call[0] expected type i64, found extern.convert_any of type (ref extern)` and variants | `language/statements/async-generator/dstr/obj-ptrn-prop-ary-trailing-comma.js` | async-generator resume ABI: some callee takes an **i64** param (state/brand slot?) but the standalone path passes an externref. NB: i64 here may be the BigInt-brand ValType decision surface (see #1349/#1644 i64-bigint-brand gate) |
| ~150 | `"f"`/`"C_method"`/`"C___priv_method"` `if[0] expected type i32, found call of type externref` | `language/statements/async-generator/dstr/dflt-ary-ptrn-rest-id.js` | a boolean-position call returns externref where the host path returns i32 (truthiness helper not branded for standalone) |
| 146 | `"__obj_find" i32.and[0] expected type i32, found call of type externref` | `language/statements/class/elements/after-same-line-static-method-rs-static-async-generator-method-privatename-identifier.js` | the `$Object` hash-probe helper is instantiated with a **non-i32 key hash**: private-name/symbol keys reach `__obj_find` as externref. Confirmed by local probe on main @ 936d1ac51 |
| ~165 | `"__str_flatten" call[0] expected (ref null N), found i32.const` + null-deref flavor | `language/statements/class/elements/set-access-of-missing-private-setter.js`, `language/statements/while/S12.6.2_A4_T4.js` | string-rope flatten helper compiled with mismatched string-rep (nativeStrings i16-array vs extern string) — same family as #1677 Signature A but for the rope arg |
| 93 | `"test" not enough arguments on the stack for call (need N, got M)` | `language/eval-code/direct/async-gen-meth-fn-body-cntns-arguments-lex-bind-declare-arguments-and-assign.js` | `arguments` object materialization in async-gen methods emits a call whose arity doesn't match the standalone helper signature |
| ~120 | `throw[0]` type mismatches in `C_method`/`C___priv_method`/`__anon_0_method` | class-elements private methods | exception-tag payload type differs between host/standalone lowering |
| ~230 | long tail (`local.set`, `call[1]`, `__closure_*`, `inner`, …) | | per-signature triage needed |

(Counts from the standalone-vs-host gap diff; signatures normalized over
function name + mismatch instruction.)

## Attribution: the ~230-row i64 bucket is NOT BigInt (from #1924, 2026-06-10)

The `call[0] expected type i64, found extern.convert_any` signature is **ruled
out as the BigInt-brand representation surface** — the "NB" in the table row
above is resolved. Root cause (reproduced on main `8ba0a82b6`):

- The failing instruction is the **destructuring null/undefined TypeError
  throw** emitted by `buildDestructureNullThrow`
  (`src/codegen/destructuring-params.ts:247-252`) in the function's param
  prologue. Its baked `call` index to the in-module `__new_TypeError` is
  **stale by exactly one slot** and lands on the adjacent
  `__box_bigint(i64)→externref` — the i64 in the validator message is the
  bystander's signature, not an async-gen/BigInt ABI.
- Mechanism: **late-import index shift missing detached instruction arrays**
  (#1923 / #1109 / #1384 class). Instrumented trace: the throw bakes
  `call 49` at `numImportFuncs=14`; four late imports follow
  (`__array_from_iter_n`, `__get_undefined` during the same param
  destructure; `Promise_resolve`, `Promise_reject` later); the baked call
  receives only 3 of the 4 `flushLateImportShifts` +1 repairs (ends at 52,
  `__new_TypeError` ends at 53).
- Minimal repro (standalone target): a **nested** `async function*` (or plain
  `async function`) with a destructured parameter —
  `export function test() { async function* f({ x: [y], }) {} f({x:[45]}).next(); return 1; }`.
  Top-level async generators refuse loudly (#680); nested ones slip past the
  gate. The non-generator variant fails with `expected i32` — different
  bystander, same mechanism — and likely shares roots with the ~150-row
  `if[0] expected i32` row above (same nested-async destructure window).
- Full evidence and trace in
  `plan/issues/1924-bigint-i64-brand-valtype-decision.md` (§ #1919
  attribution). No #1644 BigInt slice gates or fixes this bucket; fix lives
  in the late-import-shift lane, and #1923's emit-time total index validation
  would catch the class at compile time.

## Re-measurement on main @ 3b8013d37 (2026-06-10, post slice-1 + #1923)

Representative-test probe (`.tmp/standalone-audit/probe-file.mts`) results
after the slice-1 flush guards (fork PR #4) and #1923 validation landed:

| Sub-bucket | Representative | Status on 3b8013d37 |
| --- | --- | --- |
| `__obj_find` (146) | class/elements/after-same-line-static-method-…privatename-identifier | **FIXED** (returns 1) |
| arguments arity (93) | eval-code/direct/async-gen-meth-…arguments-lex-bind… | **FIXED** (returns 1) — slice-1 guards covered it |
| async-gen `i64` (~230) | async-generator/dstr/obj-ptrn-prop-ary-trailing-comma | **still invalid** — `call[0] expected i64, found extern.convert_any` in `f` |
| truthiness `if[0]` (~150) | async-generator/dstr/dflt-ary-ptrn-rest-id | **still invalid** — `if[0] expected i32, found call of type externref` in `f` (the addUnionImports guard did NOT cover this; see slice 3) |
| `__str_flatten` validation flavor (~165) | class/elements/set-access-of-missing-private-setter | **still invalid** until slice 2 (fixed by this PR) |
| `__str_flatten` null-deref flavor | while/S12.6.2_A4_T4, Array/prototype/indexOf/15.4.4.14-5-23 | **separate bug** — binary instantiates but traps `dereferencing a null pointer` at runtime; not an invalid-Wasm row, needs its own triage |
| long tail | class/elements/private-{getter,method}-is-not-a-own-property | `C_checkPrivateGetter/Method`: `call[0] expected externref, found local.get (ref null 27)` — arg-type flavor, untriaged |
| long tail | for-await-of/async-func-dstr-var-async-obj-ptrn-empty | runtime `illegal cast` (instantiates) — not this bucket |

## Root cause — `__str_flatten` sub-bucket (~165 tests) — FIXED (slice 2, this PR)

**Mechanism (instrumented):** two shift regimes overlap. When an
`ensureLateImport` batch lands, `shiftLateImportIndices` repairs the
native-string helper map AND the helper bodies (it walks `mod.functions`) —
but did not advance `nativeStrHelperImportBase`. The next
`reconcileNativeStrFinalizeShift` computed `added = numImportFuncs - base`
over the SAME imports and re-applied the delta: `__str_flatten`'s internal
`call __str_copy_tree` ended one slot high (calling itself, hence the
`call[0] expected (ref null N), found i32.const` signature — the i32.const
on the stack was meant for the sibling's later parameter).

**Fix:** `shiftLateImportIndices` and `addStringImports`' inline shift now
re-base `nativeStrHelperImportBase = numImportFuncs` after repairing the
helpers — the exact re-base `addUnionImports`' inline shift has done since
#1677-fast-path. Base stays -1 on the default GC path (host mode hard no-op,
#618 hazard). Also: `ensureNativeStringHelpers` settles any pending
late-import batch before baking funcIdx values (same slice-1 guard as
`ensureObjectRuntime`). Regression test: `tests/issue-1919-strflatten.test.ts`
(standalone + wasi + host-guard).

## Why this is the right next split

This bucket is pure compiler bugs — no spec work, no new runtime features.
Each signature is mechanical to reproduce (the JSONL rows carry exact function
names and offsets) and most cluster on the async-generator + class-private
paths that recently gained standalone lowering (#1665/#1326). Fixing the top
three signatures alone recovers ~530 tests.

## Suggested approach

1. Like #1909 did for RegExp: take each signature row above and either fix it
   in one slice or spawn a child issue with the WAT diff. Suggested order:
   `__obj_find` (single helper, 146 tests) → async-gen `i64` ABI (~230) →
   `__str_flatten` (~165) → truthiness `if[0]` (~150) → arguments arity (93).
2. For each: compile the representative test with `--target standalone`, dump
   WAT around the cited offset, identify the producer, fix the standalone arm
   or add a loud refusal.
3. Add a regression gate: any `invalid Wasm binary` row in the standalone
   lane should be triaged as a P1 compiler bug class, distinct from
   `Codegen error:` refusals (see #1853 hard-error stability bucket).

## Root cause — `__obj_find` sub-bucket (146 tests) — FIXED (slice 1)

**Mechanism (confirmed by instrumentation, not just WAT reading):** a
pending-late-import-batch over-shift, *not* a bad hash-key type. The key is
externref by signature; the probe call `call $__obj_hash` was simply pointing
one function past `__obj_hash` (at `$__new_plain_object`, which returns
externref → `i32.and[0] expected i32, found call of type externref`).

Sequence (representative test, instrumented on main @ 8ba0a82b6):

1. Codegen calls `ensureLateImport(A)` for some name that falls through to
   `addImport` — this **defers** the index shift by recording
   `ctx.pendingLateImportShift = {importsBefore: 74}` (`numImportFuncs` → 75).
2. Within the same batch window, `ensureLateImport("__extern_get_idx")`
   routes to `ensureObjectRuntime(ctx)` (standalone open-object runtime).
   `registerNative` bakes every helper's funcIdx as
   `ctx.numImportFuncs (=75, post-batch) + position` — **final-correct** values
   (`__obj_hash` = 157), into both `funcMap` and the sibling-call instruction
   literals (`__obj_find`/`__obj_insert` → `call 157`).
3. The caller then runs `flushLateImportShifts` → `shiftLateImportIndices`
   bumps every funcIdx ≥ 74 by +1 — **including the just-baked 157s** → 158,
   while the function's actual emitted index stays 157. Every internal
   object-runtime call and `funcMap` entry is now one too high. Helpers
   registered *before* the batch (e.g. `__str_flatten`) baked stale-low values
   and were *corrected* by the same flush — which is why only the
   object-runtime-internal calls misresolve.
4. `eliminateDeadImports` later remaps everything uniformly (75→16 imports),
   preserving the relative off-by-one into the final binary.

**Fix:** end any pending batch *before* native defined-function registration,
so registration always happens in a settled index regime. Two guards:
`flushLateImportShifts(ctx, null)` at the top of `ensureObjectRuntime`
(covers the `ensureLateImport` route AND `ensureObjVecBuilders` & co.) and at
the top of `addUnionImports` (covers the standalone `__is_truthy`/box/typeof
native registration — likely the same mechanism behind the truthiness
`if[0] expected i32, found call of type externref` sub-bucket — and the
host-mode flavor where the deferred flush's `added` over-counts imports that
`addUnionImports`' internal shift already handled). `shiftLateImportIndices`
/ `flushLateImportShifts` now accept `fctx: null` for these fctx-less flushes
— same body coverage (`mod.functions` + `currentFunc` + `funcStack` +
`liveBodies` + `parentBodiesStack` + `pendingInitBody`) that
`addUnionImports`' own internal shift has always relied on.

**Why not "shift-aware registration" instead** (registering with
`importsBefore`-regime indices and letting the flush correct them): callers of
`ensureLateImport` hold the returned funcIdx as a plain number and push it
*after* flushing — a stale-low return value would never be repaired. Ending
the batch first keeps the "funcMap values are always current" invariant.

## Acceptance criteria

- `__obj_find` validates with private-name/symbol keys (146 rows → 0).
- Async-generator destructuring tests instantiate (i64/`if[0]` signatures → 0).
- Standalone baseline `invalid Wasm binary` total drops below 300, with the
  remainder mapped to child issues by signature.
- No new host-mode regressions; equivalence tests green.
