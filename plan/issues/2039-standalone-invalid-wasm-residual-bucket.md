---
id: 2039
title: "UMBRELLA: standalone invalid-Wasm residual bucket — 203 live rows split into children #3394-#3398 (bigint box, extern boxing, closure/struct type, scalar unbox, tail-call long tail)"
status: ready
sprint: current
created: 2026-06-10
updated: 2026-07-18
priority: critical
feasibility: hard
reasoning_effort: max
model: fable
task_type: umbrella
area: codegen, emit
language_feature: async-generators, classes, private-names, strings, bigint, closures
goal: standalone-mode
related: [1623, 1666, 1677, 1776, 1807, 2036, 2044]
children: [3394, 3395, 3396, 3397, 3398]
test262_bucket: standalone-invalid-wasm
test262_count: 203
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff; RE-TRIAGED 2026-07-18 against the fresh standalone baseline (test262-standalone-current.jsonl, 48,119 records). The bucket shrank from ~1,135 to 203 live invalid-Wasm rows; decomposed into children #3394-#3398 by root-cause lane."
---

# #2039 — UMBRELLA: standalone invalid-Wasm residual bucket

> **This issue is now an umbrella / tracking issue.** The 2026-07-18 re-triage
> replaces direct dispatch (the old TaskList task for #2039 is superseded by the
> per-child tasks below). Do NOT assign #2039 to a dev to "fix" — assign the
> children #3394–#3398.

## Blocker verdict (2026-07-18)

**No longer blocked.** The old `blocked_by: [2167]` (Fable model disabled) is
resolved — #2167 is `status: done` on `origin/main`. The umbrella is flipped
`blocked → in-progress` (tracking). All five children are `ready`/`sprint:
current` and independently dispatchable (they touch overlapping files —
`type-coercion.ts`, `expressions.ts`, `index.ts` — so serialize or coordinate
file locks, but there is no external blocker).

## 2026-07-18 re-triage (fresh baseline)

Grounded in the tonight-refreshed standalone baseline
`test262-standalone-current.jsonl` (48,119 records, fetched to
`.test262-cache/`). Extraction: every record whose `error` contains
`invalid Wasm binary` (the `WebAssembly.instantiate/compile` validation-failure
class). This is the true invalid-Wasm bucket — the `error_category:
wasm_compile` bucket (199) plus 4 rows mis-categorized `promise_error`. Records
that merely mention "expected type" in an assertion message, and `Codegen
error:` **loud refusals** (correct #1888 behavior), were excluded as
false-positives (179 such rows filtered out).

**Live invalid-Wasm total: 203 rows** (down from the ~1,135 estimated
2026-06-10 — the #1623/#1666/#1677 line plus subsequent slices closed most of
it; the `__obj_find`, arguments-arity, and `__str_flatten` sub-buckets from the
old table are GONE from the fresh data). No embedded `#NNNN` tracking-issue
citations were found in the error strings (the `#217`–`#245` fragments are
test262 spec-clause markers like `S11.9.1`, not issue refs) — no duplicate
children to avoid.

All five child signatures were **reproduced on the current merge base** via the
triage probe (`tests/probe-2039.test.ts`, gitignored) — none are stale-baseline
ghosts.

### Bucket table → children

| Child     | Rows | Validator signature (normalized)                                                                                                   | Root-cause one-liner                                                                                                                                    | Top areas                               |
| --------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **#3394** |   59 | `extern.convert_any expected (shared) anyref, found i64 (via array.get / i64.const)`                                               | bigint (i64) value reaches the ref→externref arm and emits `extern.convert_any` instead of `__box_bigint` — bigint ValType lost at the producer         | Temporal:51, String, Map, Set           |
| **#3395** |   34 | `call/any.convert_extern expected externref, found (ref N)/ref.null` + `extern.convert_any expected anyref, found call(externref)` | object/closure GC ref not boxed (or double-boxed) at externref call/store boundaries; typed `ref.null` fed to `any.convert_extern`; `==` double-convert | expressions(==,class), WeakSet, Promise |
| **#3396** |   70 | `struct.set/get/call expected (ref A), found (ref B)/externref`                                                                    | closure-env / promise-reaction / for-loop struct type resolved to a different type index (or externref) between capture and use                         | statements, Promise:13, expressions     |
| **#3397** |   27 | `f64.ne/i32.lt_s/ref.is_null/array.len expected scalar/arrayref, found externref/f64/i32`                                          | boxed/wrong-rep value used directly in a scalar op without unbox (`coerceType` not bridging)                                                            | line-terminators, Atomics, TypedArray   |
| **#3398** |   13 | `return_call tail-call type error` · `fallthru type error` · `not enough args for struct.new` · `ref.test/cast rec-group`          | structurally-distinct long tail: TCO result-type mismatch, block-result type, arity, externref fed to `ref.test`/`ref.cast`                             | expressions(private-in), Array          |

Total: 203 (202 assigned to a family + 1 struct-ref straggler folded into #3396).

**Suggested dispatch order** (by size × mechanical-ness): #3396 (70, needs WAT
sub-slicing first) or #3394 (59, cleanest single-arm fix) → #3395 (34) → #3397
(27) → #3398 (13). #3394 and #3397 are the same discipline (route producers/
consumers through `coerceType`) on opposite sides (box vs unbox) and could be
done by the same dev back-to-back.

### Reproduction / data provenance

- Baseline: `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl` (fetched 2026-07-18, 48,119 records).
- Extraction + bucketing scratch: `.tmp/2039-wasm-recs.json`, `.tmp/2039-families.json` (gitignored).
- Probe harness: `tests/probe-2039.test.ts` (gitignored; uses `wrapTest` + `compile({target:"standalone"})` + `WebAssembly.compile`).

---

## Historical triage (2026-06-10 — superseded by the re-triage above)

The sections below are the ORIGINAL 2026-06-10 analysis, kept for provenance.
Several sub-buckets described here (`__obj_find`, arguments-arity, `__str_flatten`)
are no longer present in the fresh baseline. The current live buckets are the
children #3394–#3398 above.

## Problem

After the #1623/#1666/#1677 type-boundary fixes, the 2026-06-10 standalone
baseline still contains ~1,135 gap tests (host-pass) whose standalone binary
**fails Wasm validation** at instantiate time. Every one of these violates the
#1888 dual-mode invariant (refuse loudly, never emit invalid Wasm). Split by
validator signature (function × first mismatch):

| Count | Signature                                                                                              | Representative test                                                                                                           | Suspected area                                                                                                                                                                                                                        |
| ----: | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  ~230 | `"f"` / `"fn"` `call[0] expected type i64, found extern.convert_any of type (ref extern)` and variants | `language/statements/async-generator/dstr/obj-ptrn-prop-ary-trailing-comma.js`                                                | async-generator resume ABI: some callee takes an **i64** param (state/brand slot?) but the standalone path passes an externref. NB: i64 here may be the BigInt-brand ValType decision surface (see #1349/#1644 i64-bigint-brand gate) |
|  ~150 | `"f"`/`"C_method"`/`"C___priv_method"` `if[0] expected type i32, found call of type externref`         | `language/statements/async-generator/dstr/dflt-ary-ptrn-rest-id.js`                                                           | a boolean-position call returns externref where the host path returns i32 (truthiness helper not branded for standalone)                                                                                                              |
|   146 | `"__obj_find" i32.and[0] expected type i32, found call of type externref`                              | `language/statements/class/elements/after-same-line-static-method-rs-static-async-generator-method-privatename-identifier.js` | the `$Object` hash-probe helper is instantiated with a **non-i32 key hash**: private-name/symbol keys reach `__obj_find` as externref. Confirmed by local probe on main @ 936d1ac51                                                   |
|  ~165 | `"__str_flatten" call[0] expected (ref null N), found i32.const` + null-deref flavor                   | `language/statements/class/elements/set-access-of-missing-private-setter.js`, `language/statements/while/S12.6.2_A4_T4.js`    | string-rope flatten helper compiled with mismatched string-rep (nativeStrings i16-array vs extern string) — same family as #1677 Signature A but for the rope arg                                                                     |
|    93 | `"test" not enough arguments on the stack for call (need N, got M)`                                    | `language/eval-code/direct/async-gen-meth-fn-body-cntns-arguments-lex-bind-declare-arguments-and-assign.js`                   | `arguments` object materialization in async-gen methods emits a call whose arity doesn't match the standalone helper signature                                                                                                        |
|  ~120 | `throw[0]` type mismatches in `C_method`/`C___priv_method`/`__anon_0_method`                           | class-elements private methods                                                                                                | exception-tag payload type differs between host/standalone lowering                                                                                                                                                                   |
|  ~230 | long tail (`local.set`, `call[1]`, `__closure_*`, `inner`, …)                                          |                                                                                                                               | per-signature triage needed                                                                                                                                                                                                           |

(Counts from the standalone-vs-host gap diff; signatures normalized over
function name + mismatch instruction.)

## Attribution: the ~230-row i64 bucket is NOT BigInt (from #2044, 2026-06-10)

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
  (#2043 / #1109 / #1384 class). Instrumented trace: the throw bakes
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
  `plan/issues/2044-bigint-i64-brand-valtype-decision.md` (§ #2039
  attribution). No #1644 BigInt slice gates or fixes this bucket; fix lives
  in the late-import-shift lane, and #2043's emit-time total index validation
  would catch the class at compile time.

## Re-measurement on main @ 3b8013d37 (2026-06-10, post slice-1 + #2043)

Representative-test probe (`.tmp/standalone-audit/probe-file.mts`) results
after the slice-1 flush guards (fork PR #4) and #2043 validation landed:

| Sub-bucket                               | Representative                                                       | Status on 3b8013d37                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `__obj_find` (146)                       | class/elements/after-same-line-static-method-…privatename-identifier | **FIXED** (returns 1)                                                                                                                     |
| arguments arity (93)                     | eval-code/direct/async-gen-meth-…arguments-lex-bind…                 | **FIXED** (returns 1) — slice-1 guards covered it                                                                                         |
| async-gen `i64` (~230)                   | async-generator/dstr/obj-ptrn-prop-ary-trailing-comma                | **still invalid** — `call[0] expected i64, found extern.convert_any` in `f`                                                               |
| truthiness `if[0]` (~150)                | async-generator/dstr/dflt-ary-ptrn-rest-id                           | **still invalid** — `if[0] expected i32, found call of type externref` in `f` (the addUnionImports guard did NOT cover this; see slice 3) |
| `__str_flatten` validation flavor (~165) | class/elements/set-access-of-missing-private-setter                  | **still invalid** until slice 2 (fixed by this PR)                                                                                        |
| `__str_flatten` null-deref flavor        | while/S12.6.2_A4_T4, Array/prototype/indexOf/15.4.4.14-5-23          | **separate bug** — binary instantiates but traps `dereferencing a null pointer` at runtime; not an invalid-Wasm row, needs its own triage |
| long tail                                | class/elements/private-{getter,method}-is-not-a-own-property         | `C_checkPrivateGetter/Method`: `call[0] expected externref, found local.get (ref null 27)` — arg-type flavor, untriaged                   |
| long tail                                | for-await-of/async-func-dstr-var-async-obj-ptrn-empty                | runtime `illegal cast` (instantiates) — not this bucket                                                                                   |

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
`ensureObjectRuntime`). Regression test: `tests/issue-2039-strflatten.test.ts`
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
pending-late-import-batch over-shift, _not_ a bad hash-key type. The key is
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
   registered _before_ the batch (e.g. `__str_flatten`) baked stale-low values
   and were _corrected_ by the same flush — which is why only the
   object-runtime-internal calls misresolve.
4. `eliminateDeadImports` later remaps everything uniformly (75→16 imports),
   preserving the relative off-by-one into the final binary.

**Fix:** end any pending batch _before_ native defined-function registration,
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
_after_ flushing — a stale-low return value would never be repaired. Ending
the batch first keeps the "funcMap values are always current" invariant.

## Acceptance criteria

- `__obj_find` validates with private-name/symbol keys (146 rows → 0).
- Async-generator destructuring tests instantiate (i64/`if[0]` signatures → 0).
- Standalone baseline `invalid Wasm binary` total drops below 300, with the
  remainder mapped to child issues by signature.
- No new host-mode regressions; equivalence tests green.
