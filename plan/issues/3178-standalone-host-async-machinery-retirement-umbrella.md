---
id: 3178
title: "UMBRELLA: retire the generator/async/Promise HOST machinery in standalone — the 4,456-leaky-pass family, measured slice map + shared-substrate design"
status: ready
# decomposition delivered 2026-07-17 (fable-3178, children #3386-#3391);
# umbrella stays open as tracking — #3391 owns the acceptance closeout.
sprint: current
created: 2026-07-12
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: planning
area: codegen, standalone
es_edition: multi
language_feature: generators, async-generators, promises, async-functions
goal: standalone-mode
related:
  [
    1781,
    2860,
    3164,
    3132,
    3032,
    2903,
    2906,
    2865,
    2895,
    1326,
    2959,
    2040,
    3386,
    3387,
    3388,
    3389,
    3390,
    3391,
    3538,
    3542,
    3443,
  ]
children: [3386, 3387, 3388, 3389, 3390, 3391, 3443, 3538, 3542]
origin: "2026-07-12 architect (arch-standalone-family-plans): plan/log/standalone-gap-map.md finding — 4,456 leaky passes ride host-import shims, ~90% the generator/async-gen/Promise host machinery. This umbrella is the substrate spec + measured slice ranking the family builds on."
---

# #3178 — UMBRELLA: standalone host async-machinery retirement

## 2026-08-09 exact ES2015 residual — Promise reaction callback ABI

A fresh exact-edition census replaces the earlier ~30-test stride-sample
estimate for the Promise-reaction residual with **40 standalone-only
failures**: 20 under `built-ins/Promise/all` and 20 under
`built-ins/Promise/race`. It does not replace the umbrella's 4,456-family
measurement. All 40 pass in the host lane and fail standalone with
`illegal cast [in __then_fulfill_*() ← __drain_microtasks]`. Four nearby
`iter-{next-val,step}-err-reject.js` files also show a then-reaction cast but
fail in both lanes, so they are controls rather than part of this attribution.

The shared root cause is a pre-ABI escape fact, not one Promise combinator.
Test262 calls `$DONE` directly with a native string on some paths, which narrows
its ordinary parameter inference to `$AnyString`; the same function also
escapes as a Promise reaction, whose protocol ABI may deliver any JavaScript
value. The frozen reaction wrapper then casts values such as `undefined`, null,
booleans, numbers, strings, and symbols to `$AnyString` before the callback can
run.

The repair must mark reaction-visible parameters before Program-ABI
publication, widen both the prepared-IR and transitional direct views to the
same dynamic JavaScript carrier, and keep wrapper and callee signatures equal.
A `$DONE` name check, one guarded cast, or a wrapper-only signature override is
not sound. #3443 records the exact 40-file acceptance cohort; this umbrella
owns the shared Promise reaction escape/ABI substrate.

## 2026-07-23 (fable-3417) — post-F2 honest-FAIL head fixed: #3538

With the F2 async-completion channel landed (#3469) the standalone async
corpus scores honestly; the single biggest newly-scored FAIL bucket was the
**280-test** `yield-star-{getiter,next}-*` error-semantics template family
(one error string, 35 templates × 8 contexts). Measure-first collapsed it to
THREE coupled root causes — uncaught-throw did not complete the generator
frame; no leads-free completion target existed (also a latent #3389 bug);
`{done, value}` destructure off a native IteratorResult read
undefined/undefined — fixed in child **#3538** (done): synthetic COMPLETED
dispatch arm + catch/driver retarget + done/value destructure routed through
the #2674 `__get_member_<name>` dispatcher + canonical-undefined done-result
value. Probed 70/70 PASS on a stride-4 cohort sample. Residuals noted in
#3538: untyped member reads `r.done` still leak legacy `__gen_result_*` host
imports (separate pre-existing cohort), sync-gen STATIC typed reads surface
0/1 / NaN.

Second head, same day: the ~130-row `Cannot destructure/access/convert`
cluster (98 for-await-dstr) was a DECOY message — the real defect is that
every synchronously-unwinding standalone async-fn throw rejected with a
**NULL reason** (`wrapAsyncCallInTryCatch`'s standalone arm never wired the
#1326 Phase-1C catch-payload; the handler's own destructure-of-null
manufactured the corpus message). Fixed in child **#3542** (done): a
`catch $exn` arm uses the tag payload as the rejection reason. Probed 30/33
PASS on a stride-4 cluster sample; 3 residuals =
`language/arguments-object/*async-gen*` (`Cannot access property on null or
undefined`) — distinct root cause, still open here.

Fourth slice, same day: the ~193-row `async continuation threw` null-deref
cluster collapsed to an ARITY-FILL soundness bug (nothing async about it —
the canonical `$DONE('msg')`/`$DONE()` template shape is just where the
corpus exercises under-applied+string-applied functions). Fixed in child
**#3548** (done): under-applied call sites make a non-nullable ref param
inference NULLABLE + a null-guarded `__str_truthy` ToBoolean for nullable
strings. Measured stride-4: 0 → 19 of 49 PASS (baseline: all cluster rows
FAIL on the 2026-07-23 promote; ≈75 of 193 extrapolated). **Residual 30
all now fail as `illegal cast [in __then_fulfill_*]`** — the
then-reaction-wrapper sub-family (only 9 showed it originally; 21 were
masked behind the arity trap) — a distinct marshalling defect, the next
open head here (also #3443).

## Decomposition 2026-07-17 (fable-3178) — child issues #3386–#3391

State change since this umbrella was written (2026-07-12): **S1 (#3164), S2
(#3132), S3 (#3302), S4 (#3228), S5/S6 (#2903) have all landed/closed** — but
#3132 closed after its own S1+S2 only, banking its S3 (general `yield*`) and
S4 (`return` completion) unspun. Also the ACCOUNTING changed: since #2961 a
standalone compile that emits host imports is a hard `compile_error`
(`error_category: host_import_leak`) — there are no "leaky passes" anymore.
Every pass is host-free (24,949 on the 2026-07-17 promoted baseline — the
host_free_pass ≥ 24,500 acceptance bar is MET); the residual family scope is
now the **4,410 official-scope `host_import_leak` CE rows**, i.e. potential
NEW passes, re-measured 2026-07-17 and decomposed into six children:

| Child     | Scope (one line)                                                                                                                    |   Rows |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- | -----: |
| **#3386** | sync-gen destructuring-pattern params: fn-expr gate, element defaults, untyped array patterns via native iterator protocol, methods | ~1,860 |
| **#3387** | NESTED async-gens with for-await bodies — close the nested-vs-module-scope drivability seam (owns the seam root-cause)              |   ~577 |
| **#3388** | async-gen general `yield*` runtime delegation (nested + method lanes, §27.6.3.7 GetIterator error semantics) — #3132 S3 re-grounded |   ~600 |
| **#3389** | async-gen `return`/`throw` completion — settleReturn terminator + driven `.return()`/`.throw()` — #3132 S4 re-grounded              |   ~300 |
| **#3390** | Promise combinators with non-Promise receivers (`.call(nonCtor)` TypeError, custom-ctor admission)                                  |   ~119 |
| **#3391** | S7 mechanical closeout: registration assert, dead-arm audit, umbrella acceptance measurement (depends on the rest)                  |      0 |

**The load-bearing new finding (probe matrix 2026-07-17)**: for-await bodies,
general `yield*` (ident AND custom async-iterable), and `return` completion in
async gens all compile HOST-FREE at module scope on current main, but LEAK
when the generator is nested inside a function — and the test262 runner wraps
every file in `export function test(){}`, so the whole async-gen residual
rides that one seam (`nested-declarations.ts:678/:1104` →
`isAsyncGenDriveCandidate` → `analyzeAsyncGen`'s bounded shape). #3387 owns
root-causing which module-scope arm admits these (and validating its runtime
correctness — it is corpus-under-tested precisely because everything is
wrapped); #3388/#3389 build on the documented finding. `__make_callback` is
fully retired (0 rows). Dynamic-import chains (288 rows) stay deferred
(#1089/#1512). Remaining non-family leak cohorts (SharedArrayBuffer 344,
BigInt64Array, `__array_from_async` 76, …) are OUTSIDE this umbrella.

## The one-paragraph thesis

The standalone lane's single largest lever (~10.3 pts host-free) is retiring
the `env::__create_generator` / `__gen_*` / `__create_async_generator` /
`Promise_*` / `__make_callback` / `__get_caught_exception` host-import family.
**The native substrate already exists and is NOT the gap**: the microtask
ring, the `$Promise` carrier, native `.then/.catch/.finally`, the combinators,
thenable assimilation, `new Promise(inline executor)`, and the N-state
generator resume machine are all live on current main (inventory below,
grounded file:line). The gap is **admission coverage**: shapes that bail the
native gates fall to the legacy eager-buffer / host-CPS lowerings, and THOSE
drag the whole import bundle in. This umbrella is (a) the measured
decomposition of the 4,467 leaky passes into slices, (b) the substrate design
answers each slice depends on, and (c) the classification/ranking so the
family can be staffed without re-deriving any of this.

## Measured decomposition (fresh standalone baseline 2026-07-12, official scope)

Aggregated from `.test262-cache/test262-standalone-current.jsonl`
(official-scope subset; rows with `status=pass && imports.length>0`):

| Cohort (by import combo)                                                                                                      | leaky passes | Rides on                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | -----------: | --------------------------------------------------------------------------------------------- |
| carries ANY `__gen_*`/`__create_*` generator machinery                                                                        |    **4,034** | #3164 (sync fn-exprs), #3132 (async gens), residual below                                     |
| — sync-only bundles (`__create_generator` = 1,739 total)                                                                      |       ~1,741 | **#3164** (fn expressions ≈ ALL of it — the dstr harness IIFE `var iter = function*(){…}();`) |
| — async-gen bundles (`__create_async_generator` = 2,408)                                                                      |       ~2,408 | **#3132** S2–S4 (methods 1,725 files, yield\*, return)                                        |
| Promise/callback-only, NO gen machinery                                                                                       |      **182** | this umbrella S4–S6                                                                           |
| — for-await-of dstr via legacy async lowering (`Promise_resolve/reject/then2` + `__make_callback` + `__get_caught_exception`) |           90 | S4                                                                                            |
| — dynamic-import chains (`__dynamic_import` + then-arms)                                                                      |           47 | deferred (#1089/#1512)                                                                        |
| — `__make_callback`-only (lazy Iterator helpers, TypedArray callbacks, DisposableStack, Function.prototype)                   |          ~30 | S6 (#2903 sub-fronts 2b/4)                                                                    |
| — `Promise_new` non-inline executor / misc                                                                                    |          ~15 | S5                                                                                            |

**Key correction to the gap map's Promise row**: the `Promise_then2/resolve/
reject` ~1,500 column is NOT an independent Promise gap — probe-verified on
current main, `Promise.resolve(1).then(v=>v).catch(e=>e)`,
`Promise.all([...])`, `.allSettled`, `.finally` all compile with **zero env
imports** under `--target standalone`. The Promise imports in the baseline
co-occur with `__create_async_generator` in >90% of rows: they are the
async-gen HOST fallback minting host promises. Retiring #3132 retires them.
#2903's independent remainder is the 182-row cohort (re-grounded in #2903).

`__get_caught_exception` (4,106 rows) is registered together with the eager
generator bundle (`registerGeneratorHostImports`, `src/codegen/index.ts:11798`)
and per-site by the HOST-lane async wrap (`src/codegen/expressions.ts:543`,
`wrapAsyncCallInTryCatch` — the standalone arm at expressions.ts:516 already
avoids it). It has **no independent existence**: it disappears exactly when
the eager/host-CPS paths stop being emitted. Do not fix it directly.

## Substrate inventory — what is ALREADY native (verified on main @ 6dcdf30135)

Devs picking up any slice: these are the primitives you compose. Do NOT build
parallel machinery.

1. **Microtask/job queue** — `src/codegen/async-scheduler.ts` (#1326 1C-A):
   funcref+externref ring (`__microtask_enqueue` / `__drain_microtasks` /
   `__microtask_grow`), uniform job signature `$__mt_func_type
(externref, externref) -> externref`, WASI `_start` auto-drain, plus the
   #2632 timer-heap/run-loop reactor. This IS the spec HostEnqueuePromiseJob.
2. **`$Promise` carrier** — `getOrRegisterPromiseType` (async-scheduler.ts):
   `{state i32 mut, value externref mut, callbacks (ref null $PromiseCallback) mut}`;
   settle primitives `__promise_fulfill` / `__promise_reject` /
   `__promise_resolve_value` (recursive thenable adoption, #2867 Gap 1);
   executor settle-closures `ensurePromiseExecutorClosures` (#2959/#3125).
3. **Native `.then/.catch/.finally`** — then-wrappers + `$PromiseCallback`
   reaction list (async-scheduler.ts 1C-B), `.finally` per §27.2.5.3
   (`ensurePromiseFinallyRuntime`, #2903). Bridge arms in
   `src/codegen/expressions/calls.ts` (`emitStandaloneThenWithNativeFallback`).
4. **Combinators** — `src/codegen/promise-combinators.ts`: native
   `all/race/allSettled/any` over array-literal, array-typed, Set/Map, and
   dynamic args (`__combinator_to_vec`), native `AggregateError` (#2867 Gap 4,
   #2919, #2922, #3137).
5. **Sync generator N-state resume machine** — `src/codegen/generators-native.ts`:
   `buildNativeGeneratorPlan` (line 482) lowers loops/ifs, try/catch/finally
   ACROSS yields (#3050 throw-routes + pending-completion), `yield*`
   delegation (generator / vec / general-iterable, #2170/#2173), pattern
   params (#2920), string/any yield carriers (#2171/#2864). Admission gate:
   `isNativeGeneratorCandidate` (line 1850); host-import registration mirror:
   `sourceNeedsGeneratorHostImports` (line 2066) — these two MUST stay in
   lockstep (the single-source-of-truth discipline every slice must keep).
6. **Async drive + async-gen frame** — `src/codegen/async-cps.ts`
   (`analyzeAsyncGen`), `src/codegen/async-frame.ts`, #2906 multi-state CFG
   resume + #2865 `$AsyncFrame` carrier + per-gen `__async_gen_next_<stem>`
   drivers; #3132 S1 landed the `yield*`-array-literal unroll + the
   ITER_KIND_ASYNCGEN consumer arm in `src/codegen/iterator-native.ts`.
7. **Exception payload capture, host-free** — the native `__exn` tag
   (`ensureExnTag`, `src/codegen/registry/imports.ts`) carries the thrown
   value as an externref payload through `try`/`catch_all`; standalone catch
   arms read it directly (the standalone arm of `wrapAsyncCallInTryCatch`,
   expressions.ts:516–541, and the #3050 catch-param spill model,
   generators-native.ts:759–781). This is the `__get_caught_exception`
   replacement — already built.

**Design answer to "can standalone reuse the #2906 N-state machine?": it
already does.** The native sync-gen and async-gen paths ARE the #2906 machine;
there is no second machine to build. Every slice below is an admission-gate
widening or a consumer-arm fill on machines 5/6, or a producer-proof on
machines 2/3.

## Slice map (ranked by leaky-passes-retired; every slice = its own issue/PR)

| #   | Slice                                                                              |                                                        Retires (leaky) | Owner issue                                                                                                                                                                | Class                             |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| S1  | sync generator FUNCTION EXPRESSIONS native                                         |                                                                 ~1,741 | **#3164 — done**                                                                                                                                                           | fable-executable-now              |
| S2  | async-gen methods / yield\* / return native                                        |                           ~2,408 (subsumes most of the Promise column) | **#3132** S2–S4 (in-progress, live dev — coordinate, don't fork)                                                                                                           | in-flight (XL)                    |
| S3  | capturing nested generators → capture slots in the state struct                    | small leaky (≤ ~60) but large FAIL/CE value + unblocks #3032 semantics | **#3302 — done** (2026-07-16; declarations landed via #3032 W3's TDZ-native-threading, fn-expressions + the latent #3164 sgDeps-only fill hole via #3302's own PR)         | landed                            |
| S4  | for-await-of dstr legacy async lowering → native drive                             |                                                                     90 | **#3228 — done** (banked the 24 array-source files); residual 96 `asyncIter`-var-source files fold into **#3132**'s lane per #3228's own scope note — not a separate child | mostly done, residual rides #3132 |
| S5  | `new Promise(NON-inline executor)` + `class X extends Promise` producer            |                                                ~15 leaky + fail-bucket | #2903 (re-grounded plan there)                                                                                                                                             | fable-executable-now              |
| S6  | lazy Iterator helpers (map/filter/take/drop/flatMap) + TypedArray callback methods |                                                                    ~30 | #2903 sub-fronts 2b/4 (plan there)                                                                                                                                         | fable-executable-now              |
| S7  | `__get_caught_exception` zero-registration assert + eager-buffer code deletion     |                                      0 direct (accounting rides S1/S2) | fold into the LAST of S1/S2 to land                                                                                                                                        | mechanical                        |

Sequencing: S1 ∥ S2 ∥ S5/S6 are independent. S3 after S1 (same
`isNativeGeneratorCandidate` seam; S1's fn-expr registration is the pattern S3
extends). S7 last. S1+S2 alone retire ~4,000 of 4,467 — **the family's 90%.**

### Measured 2026-07-31 — the `class/dstr` bucket is PRIVATE generator methods

The 768 `class/dstr` rows are `private-gen-meth-*` (`*#m()`), and the bail is
localised by a **one-token** diff. Same tree, same commit, bare standalone
compile, import-set probe:

| arm       | env imports | arm        | env imports |
| --------- | ----------: | ---------- | ----------: |
| `*m()`    |       **0** | `*#m()`    |       **4** |
| `*m([a])` |       **0** | `*#m([a])` |       **8** |

`-dflt`, `-rest` and `-static` variants are all env=8 with an identical set;
the real test262 files emit 7 of the same `__gen_*` family, so the synthetic
arm is a faithful minimal reproduction rather than a separate phenomenon.

**The discriminator is narrower than "private generator method"** — four
negative arms bound it: `#m()` → 0, `#m([a])` → 0, `#v = 1` → 0, and
**`async *#m()` → 0**. So it is **sync private generator methods specifically**.
The private ASYNC generator is already host-free, which makes it the useful
upper bound: whatever admits that path is what the sync path is missing.

**Root cause — HYPOTHESIS, not verified.** The class generator-method admission
gate is `src/codegen/class-bodies.ts:1176`
(`noJsHost && !isAsyncMethod && isNativeGeneratorCandidate(ctx, member)`).
Neither that site nor `generators-native.ts` filters private names at all, so
the likely mechanism is that private methods are collected on a different path
and never reach the gate (note the `__priv_` mangling at
`class-bodies.ts:583`) — which would also explain the async exemption, since
that takes the async-frame route. **Next probe: does a private generator method
reach `:1176` at all?** Do not treat this paragraph as a diagnosis.

Public class generator members are host-free in all six probed shapes (plain,
`this`-using, array-destructuring param, default param, `async *`, class-field
generator expression) — recorded as the _contrast_ that localises this, not as
a separate result.

### S3 design notes (capturing generators — the opus-review part)

`generatorCapturesOuterScope` (generators-native.ts:2001) bails any generator
nested in a function that reads an enclosing binding — and the test262 module
wrapper puts tests inside `export function test(){}`, so wrapped tests with
named generators touching test-scope vars are ALL eager (this is also #3032's
root observation: the eager body runs at CREATION, violating §27.5.3.1
EvaluateBody — a generator must suspend before any body statement runs).
Design direction (needs opus review before staffing):

- The compiler already has the mutable-capture representation: **ref cells**
  (`struct (field $value (mut T))`) threaded by `src/codegen/closures.ts`.
  Extend the native generator state struct with N extra immutable fields
  holding the captured ref cells (captured-by-reference, so writes inside the
  generator stay visible outside — the eager path got this via the host
  buffer's by-value snapshot, which is itself subtly WRONG for post-creation
  mutation; native cells fix that too). The factory
  (`registerNativeGenerator` / the #3164 fn-expr variant) receives the cells
  as extra args exactly like `compileArrowAsClosure` captures do.
- Gate relaxation must move `generatorCapturesOuterScope` from "bail" to
  "collect capture list" in BOTH `isNativeGeneratorCandidate` and
  `sourceNeedsGeneratorHostImports` in the same commit (lockstep rule).
- Read-only uses of module globals already work (not captures). The risk
  surface is captured-binding read/write ordering across suspends — the
  ref-cell indirection makes each access go through the cell, so suspends are
  transparent.
- Coordinate with **#3032** (`ready`, unassigned — the "in-progress fable-tag5"
  label above was stale as of the 2026-07-16 PO groom): #3032 makes the eager
  path LAZY (semantics fix keeping the host path); S3 makes captures NATIVE
  (leak fix). If S3 lands first, #3032's remaining scope shrinks to the
  shapes S1+S3 still exclude. Whoever lands second re-measures.

**Groomed 2026-07-16 (PO pass): spun off as #3302** — full design notes above
carried into that issue file verbatim, with line numbers re-verified against
current `main` (the `generators-native.ts:2001` citation above pre-dates the
#3271 god-file split; #3302 cites the current locations).

### S4 design notes (for-await-of dstr legacy async lowering)

The 90 leaky files (`language/statements/for-await-of/async-func-dstr-*`) are
async FUNCTIONS whose body shape (for-await + destructuring binding) bails the
#2906 native drive and falls to a legacy lowering that emits `__make_callback`
continuations + `Promise_resolve/reject/then2` + `__get_caught_exception`.
Probe-verified on current main 2026-07-12: `for await (const x of [1,2,3])`,
over a sync generator, and over `[Promise.resolve(1)]` are ALL already
host-free — the bail is specifically the dstr BINDING form inside for-await
(see also #2602: for-await assignment-rest write unimplemented). Fix
direction: widen the async-drive admission the way #3132's consumer arm did —
the dstr binding lowers through the existing sync `__iterator` +
IteratorBindingInitialization path once the awaited step value is settled; no
new machinery. Ground in `src/codegen/async-cps.ts` (the async-fn drive gate)
before writing the child issue.

**Groomed 2026-07-16 (PO pass): #3228 (done) banked the 24 array-source
files of this 90-file bucket.** #3228's own scope note punts the remaining
~96 `asyncIter`-var-source files to #3132's lane (same admission-widening
mechanism, already in flight there) rather than a standalone child issue —
re-measure this residual once #3132 lands before deciding whether a separate
issue is still warranted.

## Validation (applies to every slice)

> **THE IMPORT SET IS NECESSARY BUT NOT SUFFICIENT — ASSERT VALUES TOO
> (#3945, 2026-07-31).** The acceptance criterion below is correct as far as it
> goes, and it has a blind spot that a slice in this family walked into. On the
> rest-in-binding-pattern slice, lifting the selection bail *without* also
> making the plan builder's `walk` descend into rest elements produced a module
> with **zero host imports**, that **validates**, and that **instantiates with
> no import object** — while silently reading the inert default for the rest
> binding and every name bound under a nested rest. **The import-set gate greens
> it.** Only a value assertion catches it.
>
> So every slice here needs, in addition to the import probe: run the module and
> assert a VALUE, including at least one read **after a suspension** (which is
> what proves the state-struct round-trip rather than just the initial load).
> This is `reference_valid_wasm_is_not_correct_verify_by_value` landing inside
> the import-retirement programme. The unowned objlit parameter-default cluster
> (~102 rows, recorded on #3896) is the next slice someone will pick up under
> exactly the criterion that misses this.
>
> **Do NOT validate a slice with `runTest262File` status — it can read `pass`
> both before and after the fix.** Measured 2026-07-31 on the
> `private-gen-meth-*` rows: a **bare** `compile(src, { target: "standalone" })`
> of the real test262 file emits **7 `env::__gen_*` imports**
> (`result.imports = 7`), which `standaloneHostImportError`
> (`tests/test262-runner.ts:3622`) turns into `compile_error` by construction —
> yet `runTest262File(file, …, "standalone")` on the **same three files**
> reported `pass`. The two paths disagree about the same input, so the runner's
> status is not a usable before/after signal for an import-retirement slice.
>
> **Acceptance is the IMPORT SET from a bare standalone compile**, per the leak
> probe below. This is the #2916 framing ("imports are the deliverable, rows are
> secondary") arriving for a second, independent reason — a slice can retire the
> whole family and still show a zero row-delta locally.
>
> The divergence itself is **unexplained**. The strict guard rejects any
> non-empty `result.imports`, so the harness-_assembled_ compile must emit zero
> where the bare compile emits seven; that could not be verified directly
> because `assembleOriginalHarness` is not exported from the runner. Recorded as
> an open oddity, not a diagnosis — do not build on it.

- Leak probe: affected construct compiles standalone with ZERO family
  `env::` imports AND `WebAssembly.instantiate(binary, {})` succeeds.
- Construct-sampled corpus flip (leaky-pass → host-free pass), never
  directory-sampled (the #2938 lesson).
- `prove-emit-identity`: gc/host lane byte-identical; wasi lane unchanged
  unless the slice targets it.
- Full standalone lane runs ONLY in `merge_group` (standalone-highwater floor
  #2097) — scoped-green is provisional; the floor is the decider.
- Modules without the construct: byte-identical (carrier-gate discipline).

## Acceptance (umbrella closes when)

- `__create_generator`, `__create_async_generator`, `__make_callback`,
  `__get_caught_exception` each appear in <100 official-scope leaky passes
  (from 1,739 / 2,408 / 2,262 / 4,106).
- host_free_pass ≥ 24,500 (from 20,885) — i.e. the family's ~90% banked.
- `registerGeneratorHostImports` (the index.ts:11798 registration) is dead in
  standalone compiles of the test262 corpus (S7 assert).

## 2026-08-01 harvest note — acceptance is NOT measurable from the published baseline

`/harvest-errors` against `loopdive/js2wasm-baselines` run `20260801-090441`
(gitHash `c601e89b`) turned up a **blocker for closing this umbrella**: the
acceptance criteria above are all phrased in terms of **leaky passes**
(`host_free_pass`, "appear in <100 official-scope leaky passes"), but the
published `test262-standalone-current.jsonl` **cannot express that measurement**:

| Lane | records | carry `imports` | **passing** records carrying `imports` |
| --- | --- | --- | --- |
| default (JS-host) | 47,834 | 41,276 | 26,553 |
| **standalone** | 48,088 | 2,679 | **0** |

No passing standalone record carries an `imports` field, so leaky-pass counts
per import name are unobtainable from the artifact. Whoever closes this
umbrella needs the standalone promotion to emit `imports` on **passing**
records first (or a purpose-built S7 assert per the third bullet), otherwise
the first two acceptance bullets can be neither verified nor refuted.

### What the published artifact *can* show (different population — do not compare)

The #2961 leak guard names the leaking imports when it **refuses**. Across
**2,125 official failing** standalone records:

| Import | Records |
| --- | --- |
| `env::__gen_next` | 753 |
| `env::__gen_result_value` | 672 |
| `env::__gen_create_buffer` | 637 |
| `env::__get_caught_exception` | 637 |
| `env::__gen_result_done` | 630 |
| `env::Promise_then2` | 378 |
| `env::__create_generator` | 371 |
| `env::__js_array_new` | 348 |
| `env::__js_array_push` | 320 |
| `env::SharedArrayBuffer_new` | 313 |
| `env::__create_async_generator` | 266 |
| `env::__gen_return` | 257 |
| `env::__gen_yield_star` | 205 |

**These are refusals among FAILING tests, not leaky passes.** They are a
different population from the 1,739 / 2,408 / 2,262 / 4,106 baselines above and
must not be read as progress against them. `__make_callback` does not appear in
the top 25 refusal names. Non-generator families also show up in the same guard
output and belong elsewhere: `__js_array_*` / `__array_concat_any` → #3531,
`SharedArrayBuffer_new` → #674 / #1354.
