---
id: 2039
title: "UMBRELLA: standalone invalid-Wasm residual bucket — 203 live rows split into children #3394-#3398 (bigint box, extern boxing, closure/struct type, scalar unbox, tail-call long tail)"
status: ready
sprint: current
created: 2026-06-10
updated: 2026-08-26
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
>
> **⚠ 2026-08-26: the 2026-07-18 table below and the #3394–#3398 split are
> STALE.** The bucket is 53 rows, not 203, and the family shapes changed. Read
> [`## Implementation Plan`](#implementation-plan) at the bottom — it carries the
> current bucket, the root causes, and the dispatchable slices. #3396 is `done`.

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

**Met, and superseded** — the "<300" bar was cleared (203 → 53). The live
criteria are in `## Implementation Plan` § Acceptance criteria (2026-08-26).

---

## Implementation Plan

**Verdict: ACTIONABLE, and the bucket is now small enough to close completely.**
53 live rows, every one reproduced or root-caused below. This section supersedes
the 2026-07-18 bucket table and the #3394–#3398 split — both are stale by 4–30×
and would send a dev chasing rows that no longer exist.

### Verification against current main (2026-08-26)

- Tree: `0e65e238`. Standalone baseline `benchmarks/results/test262-standalone-current.json`
  is from **today** (`baseline_generated_at 2026-08-26T19:59Z`, `baseline_sha
  91e77f73`, 3 commits behind HEAD), so this is not a stale-baseline reading.
- Extraction: `test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`
  (48,735 records, full scope). Rows whose `error` contains `invalid Wasm binary`:
  **53**. All 53 are `status: compile_error`, `error_category: wasm_compile`,
  `scope_official: true` (52 `standard`, 1 `annex_b`). The summary's
  `error_categories.wasm_compile` is 53 — the two agree exactly, so no filtering
  judgement is involved this time (2026-07-18 needed a 179-row false-positive
  filter; nothing to filter now).
- **203 → 53.** Gone since 2026-07-18: the whole `#3396` closure/promise-reaction
  struct-type family (70, fixed and `status: done` 2026-07-23), most of `#3394`
  (bigint 59 → 2), most of `#3395` (34 → ~11), most of `#3397` (27 → 4).
  `standalone-invalid-wasm` no longer appears as a bucket in the summary's
  `root_cause_map` at all.
- **Live-reproduced on `0e65e238`:** 19 representative upstream files were fetched
  at the pinned test262 SHA `b363f29d` and compiled with
  `wrapTest(src, meta, "standalone") → compile({target:"standalone"}) →
  WebAssembly.compile`. **13 of 19 reproduce the exact baseline signature.** The
  6 that did not are `wrapTest` artifacts, not fixes — `wrapTest` inlines a
  preamble, while the runner's authoritative path assembles the literal upstream
  harness. **Repro through `runTest262File` (`tests/test262-runner.ts:4431`), not
  `wrapTest`**, or you will wrongly declare rows already-fixed.

### Current bucket → slices (all 53 rows)

| Slice | Rows | Validator signature | Root cause | Status |
| ----- | ---: | ------------------- | ---------- | ------ |
| **S1** | 5 | `return_call: tail call type error` (`Parent_new`) · `local.tee[0] expected (ref null N), found block of type f64` | synthesized `<Class>_new` / `<Class>_init` stems collide with a user member named `new` / `init` | root-caused |
| **S2** | 8 | `call[0] expected externref, found local.tee of i32 / f64.const of f64` · `local.tee[0] expected anyref, found f64.const` | exact-model operand repair declines scalar ⇄ externref and any abstract-internal ref | root-caused |
| **S3** | 4 | `call[0] expected (ref null $AnyString), found i32.const / global.get of i32` | `padStart`/`padEnd` fillString skips ToString | root-caused |
| **S4** | 4 | `i32.ge_s[1] expected i32, found struct.get of (ref null N)` | for-of vec fast path entered on a `$Map` struct; field 0 never type-checked | root-caused |
| **S5** | 6 | `call_ref[0] expected (ref null $closure), found local.get of (ref null $ttStrings)/externref` | tagged-template pushes the strings array even when the tag declares 0 params | root-caused |
| **S6** | 3 | `extern.convert_any[0] expected anyref, found block of type externref` | already-externref value fed to `extern.convert_any`; producer is a `block`, invisible to both positional repairs | root-caused (fix choice open) |
| **S7** | 6 | `not enough arguments on the stack for local.set (need 1, got 0)` (`__async_resume_ffn`) | for-await-of `[[]]` empty array pattern emits a `local.set` with nothing pushed | needs WAT triage |
| **S8** | 4 | `type error in fallthru[0] (expected (ref null N), got i32)` (`__closure_48`) | Array `find`/`findIndex`/`findLast`/`findLastIndex` predicate block-result typed from the element, not the boolean | needs WAT triage |
| **S9** | 3 | `not enough arguments on the stack for call_ref (need N, got N-1)` (`__call_fn_0/1`) | rest-param dispatch arm under-pushes by one | needs WAT triage |
| **S10** | 3 | `struct.get[0] expected (ref null A), found local.get of (ref null B)` (`__cb_*`) | `new DataView(x)` reads ArrayBuffer fields off a local typed from the ARGUMENT | root-caused |
| **S11** | 2 | `call[0] expected (ref null N), found f64.const of f64` (`__cb_0`) | private-field get/put on a primitive receiver: no TypeError, raw f64 fed to the brand helper | root-caused |
| **S12** | 5 | singletons (see below) | five unrelated one-offs | needs WAT triage |

Total 5+8+4+4+6+3+6+4+3+3+2+5 = **53**.

**S12 singletons**, one row each:
`generators/yield-star-before-newline` (`__gen_resume_g local.tee[0] expected (ref null N), found ref.as_non_null of (ref eq)`) ·
`Atomics/waitAsync/bigint/value-not-equal-agent` (`__closure_82 call[0] expected i64, found if of externref`) ·
`class/super/in-static-methods` (`C_method` call arity 4 vs 3) ·
`optional-chaining/optional-expression` (`ref.test` fed an externref) ·
`String/prototype/indexOf/searchstring-tostring-bigint` (`call[0] expected anyref, found call_ref of i64`).
The last two are all that remains of #3394's bigint lane.

### S0 — infra first: the #1853 hard-error gate is VACUOUS

Not a row fix; do this first because every other slice's regression protection
depends on it.

`scripts/check-test262-hard-errors.mjs` gates `hard_errors` in the committed
summary against `scripts/test262-hard-error-baseline.json`. Today:
`test262-current.json` → `hard_errors: {}`, `test262-standalone-current.json` →
`hard_errors: {}`, baseline → `{}`. The gate passes while **93 malformed-Wasm
rows exist** (40 host + 53 standalone). It has been green-and-blind since the
vitest runner took over.

Cause: two producers, only one tagged.

- `tests/test262-vitest.test.ts:748` DOES pass `"malformed_wasm"` — but only on
  its own inline instantiate-failure branch.
- `scripts/test262-worker.mjs:1704-1713` is the branch that actually fires:
  `if (!WebAssembly.validate(result.binary))` →
  `buildInvalidBinaryError(...)` → `sendResult({ status: "compile_error", error })`
  with **no** hard-error flag. The runner then records it through a generic
  `recordResult(...)` call with `hardErrorKind` omitted. Every one of the 53
  rows carries the worker's `[wat: …]` suffix, which only that path emits — so
  all 53 take the untagged route. `hard_error_kind` appears **0 times** in the
  48,735-record baseline.

Changes:

1. `scripts/test262-worker.mjs:1710-1712` — add `hardError: "malformed_wasm"` to
   the `sendResult` payload (and to the `metaPath` JSON so a disk-cache hit
   replays it).
2. `tests/test262-vitest.test.ts` — forward `workerResult.hardError` into the
   `recordResult(...)` call that handles worker `compile_error` results
   (`recordResult` already accepts the parameter at `:311`).
3. `scripts/check-test262-hard-errors.mjs:48` — `SUMMARY_PATH` is hard-coded to
   the HOST summary. Accept both lanes: gate host + standalone, keyed
   separately in the baseline (`malformed_wasm` vs `standalone:malformed_wasm`),
   so a standalone regression can't hide behind a flat host count.
4. Re-baseline via `--update` once the counts are real, and wire
   `--update-on-decrease` into the post-merge job so each slice banks its own
   improvement.

Test: extend `tests/issue-1853.test.ts` with a case that drives the **worker**
path (not just the inline one) and asserts the JSONL row carries
`hard_error_kind: "malformed_wasm"`.

### S1 — reserved synthesized class stems (5 rows)

`class-bodies.ts:1146` mints `` `${className}_new` `` and `:1278` mints
`` `${className}_init` ``. `classMemberFuncKey` (`src/codegen/class-member-keys.ts:46-69`)
disambiguates a member key against (a) top-level user function names and (b) the
`static m()` / `m()` pair — but **not** against those two synthesized stems. A
class with a member literally named `init` or `new` mints the identical key.

Verified from the emitted binary for `private-field-presence-field-shadowed.js`
(the test declares `static init()`):

```wat
(func $Parent_new (result (ref null 49))
  (local $__self (ref null 49))
  i32.const 1  ref.null extern  struct.new 49  local.tee 0
  return_call 54)              ;; = $Parent_init
(func $Parent_init (type 59)   ;; 0 params, NO result — the USER's static init()
  global.get 12 ...  global.set 136)
```

The sibling classes in the same module show the intended shape
(`$Test262Error_new (result (ref null 45))` → `$Test262Error_init (param … (ref null 45)) (result (ref null 45))`),
so `Parent_new` tail-calls the wrong function entirely. The `ident-name-method-def-new-escaped`
rows are the same defect on the other stem: the test declares `new(){}`,
i.e. a method named `new`, and `<Class>_new` then returns the method's f64.

Change: relocate the **member**, never the synthesized function — 11 sites look
up `` `${className}_new` `` / `` `${className}_init` `` by literal string
(`new-super.ts:2699,2970,3335,5177`, `extern.ts:530`, `index.ts:1563`,
`class-callable-abi.ts:116,122`, `prepared-class-body-cutover.ts:185,196,221`),
whereas member keys already funnel through `classMemberFuncKey`.

- `class-member-keys.ts:46-69` — take the class name (or derive it from
  `fullName`'s prefix) and add "`fullName` equals the `_new` or `_init` stem of
  its own class" to the relocation condition, reusing the existing `__cm$`
  prefix + the `while` disambiguator at `:67`.
- `class-bodies.ts:1293-1296` — while here: `funcOptionalParams` /
  `funcRestParams` are keyed by the RAW `initName`, while the function is
  registered under `initKey`. Latent for the same reason; key both by `initKey`.

Edge cases: `new` and `init` as **static** members, as **instance** members, and
both at once (the `kind === "static"` arm at `:63` already stacks a second
prefix — verify it composes); a getter/setter/field named `new`; a computed name
that resolves to `"new"` via `resolveClassMemberName`; a class *named* `new`.

### S2 — widen the exact-model operand repair (8 rows) and S6 (3 rows)

`src/codegen/cross-hierarchy-operands.ts` already has exactly the machinery
needed — `locateOperandProducers` gives an exact forward stack model, so it sees
producers behind `if`/`block`/`local.tee` that the two legacy positional repairs
(`fixCallArgTypesInBody` stops at control flow; `fixLocalSetCoercion` looks only
at `body[i-1]`) cannot. It is deliberately narrowed to one mismatch class:

```ts
// :146-149
const crossed =
  (isConcreteInternalRef(actual) && isExternHierarchy(want)) ||
  (isExternHierarchy(actual) && isConcreteInternalRef(want));
```

Two holes fall out. `isConcreteInternalRef` (`:90-92`) requires a `typeIdx`, so
a bare `anyref`/`eqref` slot is never a `want` — that is the `C_init local.tee[0]
expected anyref, found f64.const` row. And a **scalar** producer is never an
`actual` — that is the 5 `Uint8Array.prototype.toBase64/toHex` rows
(`local.tee` of i32 into an externref param) and the 2 `SharedArrayBuffer`
options rows (`f64.const` into an externref param).

Change:

1. Add `isAbstractInternalRef(t)` (`anyref` / `eqref` / `i31ref`, i.e. internal
   hierarchy with no `typeIdx`) alongside `isConcreteInternalRef` at `:88-92`,
   and let both stand in for the internal side of `crossed`.
2. Add `isScalar(t)` (`i32` / `i64` / `f64` / `f32`) and admit
   `isScalar(actual) && (isExternHierarchy(want) || isAbstractInternalRef(want))`
   plus the reverse.
3. **Do NOT admit `isScalar(actual) && isConcreteInternalRef(want)`.** That
   window contains S3 (i32 into `(ref null $AnyString)` — needs ToString, not a
   box) and S11 (f64 into a private-brand struct — needs a TypeError, not a
   cast). A mechanical box+cast there would turn invalid Wasm into a silent
   runtime `illegal cast`, which is strictly worse. Assert in the PR that
   `coercionPlan` has no scalar → concrete-GC-ref row.

The file header's byte-safety argument carries over unchanged: scalar ⇄ externref
and scalar ⇄ anyref are disjoint in Wasm, so a site this repair rewrites was
already an invalid module and no valid module can be perturbed. Re-run the
header's own canaries (the all-flags-`=0` standalone acorn artifact, 1,157,936 B)
to confirm byte-identity on the legacy path.

**S6** rides the same file. `requiredOperandTypes` (`:96-118`) models `call` /
`return_call` / `local.set` / `local.tee` / `global.set` only, so
`extern.convert_any` — whose operand must be `anyref` — is unmodelled, and the
Promise-capability / `RegExp.prototype.compile` rows feed it a `block (result
externref)`. Two options, pick one and say which in the PR:

- (a) add `extern.convert_any → [anyref]` and `any.convert_extern → [externref]`
  to `requiredOperandTypes`; with (1) above the repair inserts the identity
  round-trip `any.convert_extern` and the module validates; or
- (b) fix the producer so it does not emit `extern.convert_any` over a value
  already in the external hierarchy, and add a peephole that deletes an
  `any.convert_extern; extern.convert_any` pair.

(b) is the cleaner output; (a) is the smaller, more general blast radius. (a)
then (b) as a follow-up is acceptable.

### S3 — `padStart` / `padEnd` fillString ToString (4 rows)

`src/codegen/string-ops.ts:3215-3218` and `:3250-3253`:

```ts
if (expr.arguments.length > 1 && !isStaticUndefinedArg(expr.arguments[1])) {
  compileExpression(ctx, fctx, expr.arguments[1]!);
  emitFlatten();
}
```

`compileExpression` returns whatever the argument's ValType is and
`emitFlatten()` unconditionally calls `__str_flatten`, whose param is
`(ref null $AnyString)`. Confirmed in the emitted WAT for
`padStart/fill-string-non-strings.js`: `'abc'.padStart(10, false)` emits
`global.get $abc; ref.cast; call $__str_flatten; i32.const 10; i32.const 0;
call $__str_flatten` — the `i32.const 0` (the boolean `false`) goes straight into
the flatten call. `null` survives only because it happens to lower through
`any.convert_extern; ref.cast`.

Change both sites to the existing engine:

```ts
emitArgAsNativeString(ctx, fctx, expr.arguments[1]!);   // string-ops.ts:463
emitFlatten();
```

`emitArgAsNativeString` is the #2598/#2599 helper the search/concat arguments
already use (`compileStringValueToLocal` at `:2565-2572`). It routes through
`compileNativeConcatOperand` — the same coercion engine `+`-concat uses, so this
adds no new coercion site and does not move the #2108 drift gate — giving
`false`→`"false"`, `0`→`"0"`, `NaN`→`"NaN"`, `null`→`"null"`, and a §7.1.17
TypeError throw for a Symbol (which is what the two
`exception-fill-string-symbol` rows assert). It diverges from the legacy path
only under `noJsHost(ctx)`, so JS-host output stays byte-identical.

Edge cases: keep the `isStaticUndefinedArg` arm (#2160) exactly as-is — the
single-space default must not go through the engine; a fillString that is an
object with a throwing `toString`; a `""` fillString (spec: return the string
unchanged, no padding loop).

### S4 — for-of vec fast path admits a non-vec struct (4 rows)

`src/codegen/statements/loops.ts:1846-1863` validates that the iterable's type is
a struct and that `getArrTypeIdxFromVec` yields an array — but **never checks
that field 0 is `i32`**. A `$Map` carrier passes both checks (its field 1 is an
array), so `for (const [k,v] of map)` enters the array fast path and emits
`struct.get $Map 0` (a ref) where an `i32` length is required.

Emitted WAT for `for-of/map-expand.js`, showing the asymmetry that makes this
survive to the validator:

```wat
local.get $map  local.tee $__forof_vec  struct.get 130 1  local.set $__forof_data
local.get $__forof_vec  struct.get 130 0
extern.convert_any  call $..to_number  i32.trunc_sat_f64_s   ;; hoisted read: REPAIRED
local.set $__forof_len
loop
  local.get $__forof_i
  local.get $__forof_vec  struct.get 130 0                   ;; live re-read: NOT repaired
  i32.ge_s                                                   ;; ← invalid
```

The hoisted read (`:1925-1930`) gets patched by a late repair; the `reReadLive`
re-read (`:1993-1995`, the #2065 live-length path taken because these tests
mutate the map inside the loop) does not. Repairing the second read would be the
wrong fix — it would make a Map iterate by its hash-table field.

Change: after the `arrDef` check at `:1857-1863`, add

```ts
const lenField = vecDef.fields[0]?.type;
if (!lenField || lenField.kind !== "i32") { /* rollback + fall through */ }
```

using the same `restoreForOfHead` + `rollbackSpeculative(ctx, fctx, snap)`
sequence the two existing guards use. Then route to the generic iterator
protocol (`src/codegen/iterator-native.ts`) rather than `reportError` — a Map is
a legitimate for-of iterable and these four tests should PASS, not refuse. If
the generic path cannot take a `$Map` yet, land the guard with a #1888 loud
refusal first (4 invalid-Wasm rows → 4 honest refusals) and file the Map arm as
a follow-up; do not leave the fast path reachable.

Edge cases: `Set`, `WeakMap`, `WeakSet` (same `$Map` carrier, `M_KIND` brand
differs); a user class whose first field happens to be `i32` and second an
array — the guard admits it, same as today, so no behaviour change; `preVec`
callers (`:1895`) that supply `vecType` from elsewhere.

### S5 — tagged-template call arity (6 rows)

`src/codegen/string-ops.ts:1494-1512`:

```ts
// Push strings array as first argument
fctx.body.push({ op: "local.get", index: stringsLocal });
if (matchedClosureInfo.paramTypes[0] && matchedClosureInfo.paramTypes[0].kind === "externref") { … }
const closureMaxSubs = Math.min(substitutions.length, matchedClosureInfo.paramTypes.length - 1);
```

The strings array is pushed **unconditionally**, but the closure matcher at
`:1449` requires `info.paramTypes.length === sigParamCount` — so a tag declared
`function () { … }` has `paramTypes.length === 0` and no slot for it. The
`closureMaxSubs` expression degrades to `Math.min(n, -1)` and the padding loop
at `:1508` doesn't run, so the extra operand is simply left on the stack and
`call_ref` reads the strings array as the self param. Verified in the WAT for
`call-expression-context-strict.js` (the tag is `fn()`, a 0-param function):
`local.tee $__tt_tag; ref.as_non_null; local.get $__tt_strings; …; call_ref` into
a func type with one fewer param than operands pushed.

Change, in **both** the matched arm (`:1490-1512`) and the
`closureInfoByTypeIdx`-lookup fallback (`:1538-1560`, which has the identical
shape and additionally omits the `ref.as_non_null` on the self push):

- push the strings array only when `paramTypes.length >= 1`;
- clamp `closureMaxSubs` with `Math.max(0, …)`;
- still **evaluate** every substitution the callee cannot accept, then `drop`
  it — `evaluation-order.js` asserts the `i++` side effects run left-to-right
  even when the arity truncates. Do not skip compiling them.

Edge cases: 0-param tag with substitutions; tag with more params than
`1 + substitutions.length` (existing `pushDefaultValue` padding at `:1508`, keep);
arrow tag; a tag that is itself a call result (`fn()` followed by the template);
a tag that is a `var`
(externref) — that goes through the `any.convert_extern` + `emitGuardedRefCast`
arm at `:1478-1484`; and the `__tagged_template` host-import fallback at `:1572`,
which must stay unreachable in standalone.

### S10 + S11 — non-object receivers must throw, not mis-type (5 rows)

Both are the same discipline and belong in one PR.

**S10 (3 rows).** `src/codegen/expressions/new-indexed.ts:226-230`:

```ts
const bufLocalType: ValType = isStructBuf ? resultType! : { kind: "externref" };
const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`, bufLocalType);
```

The local takes the **argument's** type, while every later `struct.get` uses the
fixed ArrayBuffer vec typeIdx. `new DataView(1)` gives `(ref null $AnyString)`
vs `(ref null $ArrayBuffer)`; `new DataView(sab)` gives the SAB struct. Per
§25.3.2 all three tests want a TypeError (`RequireInternalSlot(buffer,
[[ArrayBufferData]])`), so emit the throw when `resultType.typeIdx` is not the
registered ArrayBuffer vec type instead of reading fields off it — that converts
3 invalid-Wasm rows into 3 passes. Keep the externref arm for the dynamic case.

**S11 (2 rows).** `privatefieldget-primitive-receiver` /
`privatefieldput-primitive-receiver`: `call[0] expected (ref null 75), found
f64.const of f64` inside `__cb_0` — a primitive receiver reaches the private-brand
helper with no `PrivateElementFind` guard. Spec wants a TypeError. Find the
brand-check emitter (`src/codegen/`, `emitReceiverBrandCheck` and the
private-name access path) and emit the throw on a non-ref receiver. Note this is
deliberately NOT covered by the S2 repair widening — see S2 step (3).

### S7, S8, S9, S12 — triage first, then fix

Root cause not established; each needs one WAT dump before it is dispatchable.
Each is still one PR's worth of work.

- **S7 (6 rows)** — `__async_resume_ffn`: `not enough arguments on the stack for
  local.set (need 1, got 0)`. The six files are exactly
  `{var,let,const} × {sync,async}` of `ary-ptrn-elem-ary-empty-init`, i.e. an
  **empty** nested array pattern `for await (var [[]] of …)`. Start at the
  resume-body emitter `src/codegen/async-frame.ts:1597` (`__async_resume_f<stem>`)
  and the array-destructuring emitter it calls: an empty sub-pattern almost
  certainly emits the binding `local.set` while pushing nothing.
- **S8 (4 rows)** — `__closure_48`: `fallthru[0] expected (ref null 43), got i32`
  for `Array.prototype.{find,findIndex,findLast,findLastIndex}` /
  `array-altered-during-loop`. The predicate returns a boolean (i32) into a
  block whose declared result is the element ref. Start at
  `src/codegen/hof-native.ts` / `src/codegen/array-methods.ts` and the
  `array-altered-during-loop` re-read path — the four methods share one lowering,
  so one fix covers all four.
- **S9 (3 rows)** — `__call_fn_0/1`: `not enough arguments on the stack for
  call_ref`. `emitClosureCallExportN` (`src/codegen/closure-exports.ts:535+`)
  builds a `rest` entry at `:598-612` from `closureHostArity(info)`; the two
  `generators/scope-param-rest-elem-var-*` rows and the `Promise.any` row are all
  rest-param callees, so the rest arm under-pushes by one (likely the rest vec
  itself, or the generator frame param).
- **S12 (5 rows)** — five unrelated singletons, listed above. Batch them into one
  PR only if two or more turn out to share a cause; otherwise take the two
  cheapest (`optional-chaining/optional-expression`'s `ref.test` on an externref
  looks like a missing `any.convert_extern` before the test) and leave the rest.

### Latent defect found while tracing S1 — fix it regardless

`resultsMatchCaller` (`src/codegen/ir-tail-call.ts:66-84`) and its two legacy
twins `canTailCall` / `canTailCallRef`
(`src/codegen/statements/control-flow.ts:79-116` and `:122-142`) all end with:

```ts
if ((calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")) return true;
```

They compare the ref **kind** and ignore `typeIdx` entirely, so any two unrelated
struct types are treated as tail-call compatible — which Wasm's subtyping rule
does not permit. `canTailCall` additionally checks only `params.length`, never
the param **types**. No row in the current 53 is provably caused by this (S1's
`Parent_new` is the name collision, and both gates would have rejected that
callee on `calleeResults.length !== 1` had the funcIdx been correct at decision
time — which is itself worth logging: instrument the funcIdx at conversion vs.
in the final binary while doing S1). Close the hole anyway: require
`calleeRet.typeIdx === callerRet.typeIdx`, forbid `ref_null` callee → `ref`
caller, and compare param types pairwise. Keep the three copies in sync — the
comment at `ir-tail-call.ts:76` already says so and has drifted once.

### Slice order and dependencies

Independent except where noted; `[n]` = rows closed.

1. **S0** (infra) — no rows, but nothing else is measurable without it. Land first.
2. **S1** [5] — `class-member-keys.ts` + `class-bodies.ts`. Isolated.
3. **S2 + S6** [11] — both in `cross-hierarchy-operands.ts`; one PR, one dev.
4. **S3** [4] and **S5** [6] — both in `string-ops.ts`. Same dev back-to-back or
   serialize; do not run two devs in that file concurrently.
5. **S4** [4] — `statements/loops.ts`. Isolated. May need an iterator-native
   follow-up (see slice).
6. **S10 + S11** [5] — one PR, "non-object receiver throws".
7. **S7** [6], **S8** [4], **S9** [3] — triage each first; independent of everything above.
8. **S12** [5] — last, opportunistic.
9. **Tail-call type check** — anytime; touches `ir-tail-call.ts` +
   `statements/control-flow.ts`, no overlap with the above.

Nothing here needs the `#3394–#3398` children as gating artifacts. Recommend the
PO: close #3396 out of the umbrella (already `done`), re-scope #3394 to the 2
remaining bigint rows (S12), and either re-point #3395/#3397/#3398 at S2+S6 /
S4 / S7+S8+S9 or close them and track the slices under #2039 directly. Leaving
their stale counts (59/34/27/13) live is how a dev spends a day looking for 59
rows that no longer exist.

### Test plan

**Existing coverage.** `tests/issue-2039-strflatten.test.ts` is the model — its
`compilesValidWasm(source, target)` helper (compile → `WebAssembly.compile`,
throw = fail) is exactly the assertion every slice needs, and it already covers
the standalone / wasi / host-mode triple. `tests/issue-1853.test.ts` covers the
hard-error tagging (extend it for S0). `tests/test262.test.ts` is a
non-asserting dashboard and gates nothing.

**No test in the tree asserts that any of the 53 rows produces valid Wasm.**

**New tests**, one file per slice, `tests/issue-2039-<slug>.test.ts`, each with:

1. the distilled source, compiled at `target: "standalone"`, asserting
   `WebAssembly.compile` does not throw;
2. a host-mode guard on the same source (must stay valid — several slices claim
   byte-identity on the JS-host path);
3. a behavioural assertion wherever the fix also makes the upstream test pass
   (S3 `'abc'.padStart(10, false) === 'falsefaabc'`; S4 the Map iteration count;
   S5 the `evaluation-order` side-effect order; S10 the `TypeError`).

Two distilled sources reproduce standalone on `0e65e238` with **no** harness at
all — start here, they are the cheapest red tests in the set:

- S1 (the `_new` stem): a class expression with a method named `new` written as
  the escaped identifier `new`, then `new C().new()` →
  `local.set[0] expected (ref null 44), found block of type f64`.
- S3: `"a".padStart(5, Symbol())` →
  `call[0] expected (ref null 3), found global.get of type i32`.

Everything else — including S1's `static init()` variant and S5's 0-param tag —
needs the real harness assembly; hand-distilled equivalents came out VALID in
probing, which is exactly the trap this note exists to prevent. Use
`runTest262File(<path>, <category>, timeout, "standalone")`
(`tests/test262-runner.ts:4431`) in the test, or fetch the upstream file at the
pinned submodule SHA — `wrapTest` alone under-reproduces 6 of 19 representatives
and will make a slice look already-fixed.

**Gate.** After S0 lands, every slice PR must show its rows leaving the
standalone `malformed_wasm` count, and the post-merge
`check:test262-hard-errors --update-on-decrease` banks it. Do not rely on the
PR-level `check for test262 regressions` — it is a designed green no-op at PR
level (CLAUDE.md § Agent work dispatch); the real signal is the `merge_group`
re-validation and the refreshed standalone summary.

### Acceptance criteria (2026-08-26)

- `error_categories.wasm_compile` in `benchmarks/results/test262-standalone-current.json`
  reaches **0**, and the host lane's 40 are triaged into their own issue.
- `hard_errors.malformed_wasm` is non-empty and *accurate* in both lane summaries
  before any slice lands, and `scripts/test262-hard-error-baseline.json` ratchets
  down with each slice — the gate must be able to fail again.
- Every remaining `invalid Wasm binary` row is either fixed or converted to a
  #1888 loud refusal. A validation failure is never an acceptable end state.
- No host-mode regression: `pnpm test -- tests/equivalence.test.ts` green, and
  the `cross-hierarchy-operands.ts` byte-identity canaries unchanged for S2/S6.
- The `#3394–#3398` children are re-scoped or closed; no child carries a count
  it cannot substantiate against the current baseline.
