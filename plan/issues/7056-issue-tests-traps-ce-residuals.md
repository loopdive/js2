---
id: 7056
title: "issue-tests #7014 traps/CE slice — residual red tests too large for the triage wave (each with its bisected culprit or reason)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: multiple
goal: core-semantics
related: [7014, 7040, 7041, 7051, 7055]
requested_by: ttraenkler/wave15-traps-ce
---

# #7056 — residuals of the #7014 traps / compile-error slice

The [#7014](7014-issue-tests-detector-red-since-july.md) traps/CE slice was 44
files / 108 red tests on upstream main 0727e2985b. #7041 (stale pins), #7040
(IR) and #7051 (codegen) take 26 files to green. What is left is listed here,
one row per root cause, with the bisect result where one was run (first-parent
history of main, a `src/` snapshot per candidate, the issue test's own source
as the probe). None of these was weakened or skipped; they stay red.

## Real regressions with a bisected culprit

| Test(s) | Symptom | First bad | Plan |
| --- | --- | --- | --- |
| `issue-3017` "a strict anonymous constructor poisons its sloppy callee" (host + standalone) | trap "dereferencing a null pointer" in `__new_ctor_0` | 71e02fd3e1 (#4459, react-dom real suite) | `function probe(){ (probe as any).caller }` is now a CYCLIC hoisted function value, so `probe`'s local became a ref cell. `new (function(){ "use strict"; probe(); })()` builds its ctor closure as a bare `{func}` struct with NO captures, but `__new_ctor_0` treats param 0 as `probe`'s cell (`ref.cast` to the cell type → null). Give the `new (function…)()` ctor-closure path the same transitive capture planning `emitClosureConstruction` got in #4459 (`materializeHoistedFunctionValueBinding` per capture). |
| `issue-2967` "async fn-expr through a VOID-typed param after an `() => any` wrapper" (host) | "illegal cast" | d32b4dad7b (#3791, `3520-c25-synthetic-reservation-abi`) | The wrapper-order RTT fix of #2873 (cast to the wrapper ROOT) regressed when synthetic reservations changed wrapper struct registration order; re-check which struct `runVoid`'s cast targets vs the one the async closure is allocated under. (5 other tests in this file were the binaryen reader — fixed by the #7041 helper once this one is green.) |
| `issue-2554-ir-tail-call` "return-type-mismatched call in tail position" | IR alloc-provenance check: live `call` references retired AllocSiteId 1 | 19cf9e0392 (#5936, `3518-inline-call-allocation`) | The inliner retires an allocation site that a surviving call still cites; re-run provenance after inlining or keep the site alive. |
| `string-derived-length-fast-path` "applies immutable derived-result proofs to host strings" (host, `nativeStrings:false`, any `-O`) | "illegal cast" | inside 52b61990fe (#4922 `es5-authoritative-upstream`, 116 commits; last good f2ac1030e1) | Bisect inside the branch (`good f2ac1030e1`, `bad 52b61990fe^2`), then fix the host-string derived-length arm. |

## Pre-existing defects that the suite only now catches

| Test(s) | Symptom | Finding | Plan |
| --- | --- | --- | --- |
| `issue-3500` polymorphic / escaping / conflicting cycles (linear) | "emitted WebAssembly failed validation" | First "bad" is b3dd7c75d7 (#6390, validate the emitted module): the legacy linear backend has ALWAYS emitted invalid Wasm here (an untyped param lowered `i32`, compared with `f64.eq`; `runNumber` passes `f64` into it) — validation now reports it. | Linear backend: refuse (Codegen error) or box an untyped polymorphic parameter instead of guessing `i32`. The IR rejection the test pins still happens. |
| `issue-1596` "identifier.apply forwards the live arguments object" | compile error "ABI draft … would mutate sealed prepared scope" (before: wrong value 0) | Never passed: returns 0 at its own introducing commit 58081ee2d9. | `target.apply(null, arguments)` through the function-value trampoline; separate issue-sized work. |

## Not bisected (internal IR contract tests; the HEAD test file imports APIs older `src/` lacks)

| Test(s) | Symptom |
| --- | --- |
| `issue-3520-support-callable-abi` | "planned support resolver probe did not preserve the exact allocator slot" |
| `issue-3520-vec-writeback-abi` | write-back helpers still on the positional fallback (`__vec_has_own_index`, …) |
| `issue-3521-fast-mixed-signature-admission` (4) | "injected direct function-body poison: anyTrue" / "function typeIdx parity mismatch: IR=17, legacy=12" — the IR no longer prepares `anyTrue` |
| `issue-3522-nested-class-static` (6) | "prepared ABI binding … class …" failures; async static: invalid Wasm in `__fn_tramp_Box_k_1` (see also #7055) |
| `issue-4259-class-accessor-outer-writeback-ir` (4) | "injected direct class-body poison: DeclInstance_get_di"; typed-demote expectation mismatch |
| `issue-4588-standalone-timer-shim-cutover` (3) | invalid Wasm in `__async_resume_ffetchAllSequential__ir` (`any.convert_extern` on an f64); patch count 6 vs 5 |
| `issue-2138-multi-module-ir-overlay` | "callable preflight found a non-exact graph edge" (global-script caller → `globals.ts`) |
| `issue-3188-module-namespace-tostringtag` (standalone) | "Codegen error: dynamic ar…" while materializing the namespace callable projection |
| `issue-3791-ir-native-regexp-test` "… only for standalone, not WASI" | the WASI compile now refuses ("standalone RegExp engine does not support RegExp without an enabled standalone engine") where the test expects success |
| `issue-5253` "block-local forward lexical read (#5154) control" | the control now throws (`WebAssembly.Exception`) where it must not enter #5253's TDZ exception |
| `issue-4397-native-semantic-js-host` object-rest CopyDataProperties | "illegal cast" in the native-first JS-host lane |
| `issue-4178` "#5092 IR owner" | "dynamic/externref returned into a native 'string' result needs a checked conversion" (unpatched slot) |
| `issue-2900` "the target test passes — and fails without the defer" | the no-defer CONTROL now passes (`null`), so the defer is no longer load-bearing for the row — owner should confirm, then rewrite the control |

## Environment, not compiler

| Test | Finding |
| --- | --- |
| `issue-5337` "the shipped acorn module authenticates its helpers" | `website/public/acorn/acorn.wasm` is a git-LFS file; the issue-tests checkout has no LFS, so the test reads the pointer text ("expected magic word … found 76 65 72 73" = `vers`). Needs `lfs: true` for that job or a build of acorn in the test. |
