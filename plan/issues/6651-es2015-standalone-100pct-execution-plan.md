---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-20
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, runtime, conformance
es_edition: ES2015
goal: standalone-mode
parent: 4444
related: [4444, 5199, 5198, 5152, 5269, 5318, 5350, 6484, 6485, 6494, 1665, 2867, 4119]
assignee: "ttraenkler/fable-es2015-plan"
# 2026-09-20 (cluster D, #5197 R3-3): the `Promise.{all,race}.call(C, iterable)`
# arm in `compileNamespaceStaticCall` grows by 10 lines — the admission check plus
# the delegation to `tryEmitCustomCombinatorCall`. The protocol itself (≈700 LOC)
# lives in the NEW module `src/codegen/promise-custom-combinator.ts`, not in the
# god-file; this grant covers only the dispatch site that has to name it.
# 2026-09-21 (cluster E, slice E1): three of the four seams are single arms
# spliced into an EXISTING ladder in a god-file, so the growth cannot be moved
# to a subsystem module without splitting the ladder itself:
#   - array-methods.ts (+15): the §7.1.4 Symbol-index gate at the top of
#     `emitDynViewSpeciesMethodTwoArm`, which is where slice/subarray on a
#     dynamic view compile their window arguments;
#   - dataview-native.ts (+14): the `ArrayBuffer.isView` carrier-set
#     correction, inside the one shared `isViewRefTestInstrs` chain;
#   - closed-method-dispatch.ts (+3): admitting arity 0 to the native array
#     HOF arm (its reserve gate plus the `undefined` callback operand).
# The `sort` comparefn gate went into `dyn-array-producers.ts`, a subsystem
# module already under budget, so it needs no grant.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #6651 — ES2015 standalone → 100%: cluster execution plan

**Why a new file.** #4444 is the umbrella and its 2,800-line log is the
history. This file is the *dispatchable* plan: one census, nine clusters with
frozen row manifests, one owner/model/effort per cluster, and a uniform
acceptance recipe. Progress notes go under "Cluster status" below; narrative
stays in #4444.

## Census (authoritative, 2026-09-20)

Source: `loopdive/js2wasm-baselines` `test262-standalone-current.jsonl`,
fetched `--force` 2026-09-20 19:28 UTC, internal timestamp 2026-09-20 17:39,
`oracle_version: 14`, `oracle_lane: honest`, 48,735 rows, baseline_sha
`9dc2fa2e`. Edition classification:
`website/public/benchmarks/results/test262-file-editions.json` (index of
`ES2015` in its `editions` array).

| ES2015 standalone | rows |
| --- | ---: |
| total | 11,704 |
| pass | **10,384** (88.7 %) |
| fail | 1,034 |
| compile_error | 286 |
| **gap to 100 %** | **1,320** |

Edition-ratchet floor (`scripts/test262-edition-ratchet-baseline.json`,
2026-09-04): 10,131 — the baseline above is +253 over the floor.

### Top error signatures across the 1,320

| rows | status | signature |
| ---: | --- | --- |
| 129 | CE | `standalone target emitted host imports: env::__create_generator, env::__gen_create_buffer, …` |
| 53 | CE | `native generator lowering currently supports only sequential numeric yields in standalone/WASI (#680)` |
| 79 | fail | `TypeError: Cannot access property on null or undefined` |
| 76 | fail | `Expected a TypeError to be thrown but no exception was thrown` |
| 47 | fail | `Expected a Test262Error to be thrown but no exception was thrown` |
| 42 | fail | `Expected a Test262Error but got a TypeError` |
| 48 | CE | `host imports: env::Promise_all / Promise_race / allSettled / any …` |
| 18 | fail | `Method called on incompatible receiver (RegExp brand check failed)` |
| 17 | fail | `Object.prototype.toString is not yet implemented in --target standalone` |
| 7 | CE | `host imports: env::Object_set_constructor` |
| 6 | CE | `standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget` |

## Clusters — manifests, owners, models

Every cluster has a frozen path manifest under `plan/agent-context/6651/`
(one `test/`-relative path per line, derived mechanically from the census
above — see the partition rule in the manifest generator note at the bottom).
A cluster is done when **every** row in its manifest passes on the isolated
standalone runner and the acceptance recipe below is met.

| # | cluster | manifest | rows | CE / fail | owner lane | model / effort | blocking dependency |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| A | Native generator lowering: non-numeric yields, `yield` in destructuring/class/object bodies, `yield*`, try/catch | `A-generators-standalone.txt` | 197 | 197 / 0 | senior-developer | Opus, **max** | none — this is the largest single lever; unblocks ~60 more rows in C/G that currently hit the same gate |
| B | RegExp `Symbol.{match,replace,search,split}` protocol, `flags`, `exec` override, Annex B RegExp, `String.prototype.{match,search,split,replace}` dispatch | `B-regexp-protocol.txt` | 147 | 11 / 136 | senior-developer | Opus, high | coordinate with #5198 (in-progress, drafts #5393/#6014, held #5996) — read its handoff first, do not duplicate the `lastIndex` reader work |
| C | Class / object-literal / `super` semantics: class-call TypeError, `new.target`, method descriptors, subclass constructor return, computed keys | `C-class-object-super.txt` | 177 | 6 / 171 | senior-developer | Opus, high | #5318 / #5350 in-progress; draft #5839 documents the object-literal `super` blocker #6420 |
| D | Native Promise combinators: `Promise.all/race/allSettled/any` for non-literal/iterable args, `then` residuals, subclass ctor | `D-promise-combinators.txt` | 101 | 48 / 53 | developer | Opus, high | held PR #5883 (observable combinator protocol) — read, do not re-implement |
| E | TypedArray / ArrayBuffer / DataView: species, detached checks, `object-arg` ctors, `toLocaleString`, internals `[[Set]]`/`[[DefineOwnProperty]]`/`[[OwnPropertyKeys]]` | `E-typedarray-buffers.txt` | 144 | 1 / 143 | developer | Opus, high | none (#5317 done) |
| F | Proxy / Reflect: invariant must-throw, `Reflect.construct` distinct NewTarget, trap receiver/realm args | `F-proxy-reflect.txt` | 89 | 5 / 84 | senior-developer | Opus, high | #6494 in-review; drafts #5400 (NewTarget design) / #5397 (Reflect.set receiver) |
| G | for-of / destructuring runtime residuals, generator prototype objects, `Iterator.prototype.{chunks,windows}` (ES2015-tagged via `generators`) | `G-forof-destructuring-iterators.txt` | 134 | 2 / 132 | developer | Opus, high | after A lands (≈20 rows here are generator-shaped fails) |
| H | Builtins misc: `Array.prototype.concat` (isConcatSpreadable, #6485), `slice/splice/map` species, `Object.prototype.toString` runtime tag (#4119 gap), `Function.prototype.{toString,bind,@@hasInstance}`, `Error.prototype.stack`, `Symbol.prototype.@@toPrimitive`, `__proto__` | `H-builtins-misc.txt` | 217 | 6 / 211 | developer | Opus, high | #6485 in-progress (concat) |
| I | Language misc: module namespace internals (12), `with` + unscopables, `eval` spread, TCO rows, global-code var collision | `I-language-misc.txt` | 114 | 10 / 104 | developer | Opus, medium | several rows are eval/with (see #1066); triage first, file wont-fix with reason where standalone cannot honour |

Rows: 197+147+177+101+144+89+134+217+114 = 1,320. The manifests partition the
gap exactly; no row is in two clusters.

### Dispatch order and concurrency

The container that produced this plan has 4 cores, so at most 3 clusters run
concurrently. Order by rows-unlocked-per-effort:

1. **Wave 1 (now):** A (generators), D (promise combinators), H (builtins misc).
2. **Wave 2:** E (typed arrays), C (class/object/super), B (RegExp).
3. **Wave 3:** F (proxy/reflect), G (for-of, after A), I (language misc).

Every owner first re-runs its manifest on its branch base to get a **measured**
before-state (never quote this file's counts as the before-state — a base
moved under you is the #2916/#4433 defect).

## Acceptance recipe (every cluster, no exceptions)

```bash
# 1. before-state on the branch base, isolated standalone runner
npx tsx scripts/run-test262-paths.mts plan/agent-context/6651/<cluster>.txt \
  --standalone --isolate > .tmp/6651/<cluster>-before.log 2>&1; echo $?
# 2. implement; keep .tmp/base copies of every edited file at first edit
# 3. after-state, same command → <cluster>-after.log; both logs are the receipt
# 4. neighbourhood regression control: the sibling directories of every row
#    you changed behaviour for (e.g. all of built-ins/Promise/** for D), host
#    (default target) AND standalone, before vs after — zero pass→non-pass
# 5. gates, chained, before the commit (never --no-verify)
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports && npx vitest run tests/equivalence.test.ts
```

- **No new host imports without a standalone fallback** (dual-mode rule).
  A cluster fix that converts a CE into a fail is progress only if the fail
  is a narrower, documented residual — record it.
- Growth allowances (LOC / func budget) go in this file's frontmatter, dated.
- Commits carry `Model:` and `Co-authored-by:` trailers per `AGENTS.md`.
- The owner writes its receipts (before/after counts, log paths, SHA of the
  manifest) under **Cluster status** below, not in #4444.

## Definition of done for #6651

- ES2015 standalone `pass == total` (11,704 / 11,704) on a full authoritative
  standalone run, or every remaining row has a `wont-fix` issue naming the
  spec-level reason (e.g. direct `eval` of dynamic text in a no-host target).
- `scripts/test262-edition-ratchet-baseline.json` ES2015 floor banked to the
  new number via `check:edition-ratchet:update` from a **full** run.
- #4444 gets a one-paragraph closing note pointing here.

## Cluster status

_(owners append here: date, branch, before → after, log paths, residuals)_

### 2026-09-20 — Cluster D (native Promise combinators), slice D1: custom-constructor `.call`

- **Branch** `worktree-agent-a6d336193709ec50a`, base `claude/es2015-test262-plan-54tooh`
  (`905dca75`). **Worktree** `/home/user/js2/.claude/worktrees/agent-a6d336193709ec50a`.
- **Manifest** `plan/agent-context/6651/D-promise-combinators.txt` (101 rows),
  `--standalone --isolate`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/D-before.log`) | 0 | 55 | 46 |
  | after (`.tmp/6651/D-after.log`) | **26** | 57 | **18** |

  Every one of the 28 compile errors in the targeted cohort is gone: 26 of them
  now PASS, 2 became documented fails (below). The fail count rises by exactly
  those 2 — no row that executed before stopped executing.

- **What landed.** `Promise.{all,race}.call(C, iterable)` for an ORDINARY
  compiled constructor now runs the §27.2.4.1.1 / §27.2.4.3.1 element protocol
  natively (new `src/codegen/promise-custom-combinator.ts`): NewPromiseCapability
  over `C`, one `Get(C, "resolve")`, per-element `Call(resolve, C, «value»)` and
  `Invoke(next, "then", …)`, with real per-index resolve-element functions
  (builtin-fn-meta carrier, `[[AlreadyCalled]]`, `[[RemainingElements]]`), and
  IfAbruptRejectPromise on any abrupt element step. Before this, that whole
  shape fell through to the unsatisfiable `env::Promise_all`/`env::Promise_race`
  host import, so the rows did not compile at all. The narrow #4682 empty-array
  arm stays as the fallback for `allSettled`/`any` and refused constructors.
  Two sub-fixes were needed and are load-bearing:
  1. `C` is invoked through `__apply_closure`, not a baked `call_ref` — every
     row in the cohort writes a static (`C.resolve = …`), which moves the
     identifier's value onto the `$Object` function carrier; the `call_ref`
     path found a null funcref and threw the capability TypeError before `C`
     ran (measured `checkPoint === 0`).
  2. An array of object literals compiles to a vec of the CLOSED STRUCT type,
     which `__combinator_to_vec` answers null for. Those are re-materialized
     into the canonical externref vec instead of being called "not iterable"
     (that alone was 9 of the 28 rows).

- **Neighbourhood control** — all 729 `built-ins/Promise/**` rows, `--standalone`,
  before vs after (`.tmp/6651/neigh-standalone-{before,after}.log`):
  pass **359 → 385**, fail 204 → 206, compile_error 166 → 138.
  Per-row set diff: **0 pass → non-pass**, 26 non-pass → pass.
- **Host (gc) lane**: the non-isolated host run of that directory cannot be used
  as a control — one row poisons `Promise.all` in the runner's own realm and
  kills the process (`src/runtime.ts:17502 … PROMISE_INTRINSICS.all?.call`).
  Substituted a stronger check where it applies: a sha256 byte comparison of 8
  compiled programs (3 custom-constructor `.call` shapes, 4 intrinsic
  combinator shapes, a `.then` chain) on base vs branch —
  **all 8 host binaries byte-identical** (`.tmp/6651/hostbytes-{before,after}.txt`).
  On standalone the same corpus shows exactly the intended delta: the 3
  custom-constructor programs change (and lose all host imports), the 5
  intrinsic ones are byte-identical (`.tmp/6651/sabytes-{before,after}.txt`).
- **Unit tests**: new `tests/issue-6651-promise-custom-combinator.test.ts`
  (8 cases: values array, deferred `[[RemainingElements]]`, race handler
  identity, zero-arg-ctor TypeError, throwing ctor, both IfAbruptRejectPromise
  arms, host-lane control). `tests/issue-4682.test.ts` — the
  "keeps the non-empty custom-constructor fallback unchanged" case asserted the
  shape still leaked `env.Promise_all`; it is REWRITTEN to assert the native
  lowering. The 3 failures in `tests/promise-combinators.test.ts` (2 timeouts)
  and `tests/issue-2671-promise-capability.test.ts` reproduce IDENTICALLY on the
  base tree (`.tmp/promise-suite-{before,after}.log`) — pre-existing, host-lane.
- **Gates**: loc-budget and func-budget pass with the grants added to this file's
  frontmatter (+12 LOC / +11 func LOC at the dispatch site only); coercion-sites,
  oracle-ratchet, dead-exports, compiler-boundaries `--mode inventory` (the new
  module is classified in `scripts/compiler-boundaries.json`) and
  `scripts/equivalence-gate.mjs` (22 known failures, no new) all pass.

**Residual sub-buckets (18 CE + 57 fail on the manifest), with signatures:**

| rows | status | sub-bucket | why it is still open |
| ---: | --- | --- | --- |
| 8 | CE | `{all,race,allSettled,any}/resolve-throws-iterator-return-*` — `env::Promise_*` | the receiver is a `class BadPromise {…}`; standalone has no `Construct(C, «executor»)` for a compiled class (#5197 G10, DEFERRED there) |
| 6 | CE | `{all,race,resolve,reject}/ctx-ctor.js`, `*/invoke-resolve-on-promises-every-iteration-of-custom` — `env::__promise_subclass_ctor` | `class X extends Promise` receiver (#5197 G9, DEFERRED) |
| 4 | CE | `{all,race}/invoke-resolve-on-{promises,values}-every-iteration-of-promise` — `env::Promise_{all,race}` | INTRINSIC receiver with a reassigned `Promise.resolve` over an f64/promise vec — #5197 R3-2 step 6, the half held PR #5883 implements |
| ~20 | fail | `invoke-resolve*`, `invoke-then*`, `resolve-not-callable-*`, `resolve-poisoned-then` | the observable intrinsic `Get(C,"resolve")`/`Invoke(then)` pipeline (R3-2 / PR #5883) — deliberately NOT duplicated here |
| ~10 | fail | `*-close`, `iter-step-err-reject`, `iter-next-val-err-reject`, `S25.4.4.*_A5.1` | the iterable is drained before the element loop, so `IteratorClose` never runs and a throwing `next()` surfaces as "argument is not iterable" (R3-4) |
| 1 | fail | `all/capability-resolve-throws-no-close.js` — `Expected SameValue(«0», «1»)` | NEW in this slice's scope: the iterable is `iter[Symbol.iterator] = fn` on an `$Object`; `__combinator_to_vec` does not see the symbol-keyed expando, so the aggregate rejects "not iterable" and `nextCount` stays 0 (R3-4 hypothesis H1) |
| 1 | fail | `all/resolve-element-function-prototype.js` — `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | environment only: the quickjs provider is not built in this container, so the row is unverifiable locally (it exercises `Object.getPrototypeOf(resolveElementFunction)`) |
| rest | fail | `then`/species/`constructor` reads, `Object.prototype.toString` tag, boolean handler boxing | #5197 R3-5…R3-10 and #4119 — untouched by this slice |

**Not started in this slice (and why):** the runtime-fail half of cluster D is
the observable-protocol work of held PR #5883 (#5197 R3-2), which the brief
explicitly says not to duplicate; the class-receiver CEs need a standalone
`Construct` for compiled classes, which is a separate mechanism, not a
combinator change.

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E1

- **Branch** `worktree-agent-aa1dfb3d978fd9ede`, base `claude/es2015-test262-plan-54tooh`
  (`16a99c21`, i.e. origin/main + plan + cluster D). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-aa1dfb3d978fd9ede`.
- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt` (144 rows),
  `--standalone --isolate`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/E-before.log`) | 0 | 143 | 1 |
  | after (`.tmp/6651/E-after.log`) | **13** | 130 | 1 |

  Per-row set diff: **13 non-pass → pass, 0 pass → non-pass.**

- **What landed — four seams, each a spec step the standalone lane skipped.**
  1. **Arity-0 array HOFs (6 rows).** `closed-method-dispatch.ts` gated its
     native `__hof_<m>` arm on `arity >= 1`, so `sample.every()` fell to the
     open-`$Object` bottom arm, where `__extern_method_call` answers `undefined`
     for a vec brand — a NORMAL RETURN where §23.1.3.x step 3 requires
     `IsCallable(undefined)` → TypeError. The arm now admits arity 0 and feeds
     the canonical `undefined` as the callback, so the helper's own IsCallable
     gate raises it. Not typed-array specific: `[1,2].every()` on an `any`
     receiver was equally silent.
  2. **`sort` comparefn (1 row).** `__arrprod_sort` treated a non-callable
     comparefn as "no comparator". §23.1.3.30 step 1 makes a PRESENT,
     non-`undefined`, non-callable one a TypeError. Absent vs explicit is told
     apart by the args vec's own length, so `sort()` / `sort(undefined)` keep
     the default order while `sort(null)` throws.
  3. **`ArrayBuffer.isView` carrier set (3 rows).** Two errors in one chain:
     the DYNAMIC view brand `$__ta_dyn_view` was absent (so every
     `testWithTypedArrayConstructors` sample read as NOT a view), and the
     ArrayBuffer's own `$__vec_i32_byte` backing carrier was PRESENT (so a
     buffer read as a view). §25.1.4.1 is `[[ViewedArrayBuffer]]`, which the
     buffer does not have.
  4. **Symbol window arguments on a dynamic view (4 rows).** `slice`/`subarray`
     compile their index args in `{kind:"f64"}` context, where a Symbol (an i32
     id) coerces SILENTLY to 0; §7.1.4 step 3 makes it a TypeError. Reuses the
     existing `emitSymbolIndexArgThrow` gate (`fill`/`copyWithin` precedent),
     positions 0 and 1, `map`/`filter` excluded (their position 0 is a
     callback).

- **Neighbourhood control** — 2,266 rows, `--standalone`, before vs after
  (`.tmp/6651/chunks-{before,after}/`): all of `built-ins/ArrayBuffer/**`,
  `built-ins/DataView/**`, `built-ins/TypedArray/**`, plus the
  callback/comparator rows of `built-ins/Array/prototype/{every,some,forEach,
  reduce,reduceRight,map,filter,find,findIndex,sort}` (the arity-0 arm is not
  typed-array specific). pass **1433 → 1456**, fail 770 → 747, compile_error
  62 → 62. Per-row set diff: **0 pass → non-pass**, 23 non-pass → pass — the
  13 manifest rows plus their 10 `BigInt/` twins, which are outside the ES2015
  manifest.
  - Runner note: the single 2,266-row in-process run DIED at exit 1 with an
    EMPTY log (the realm-poisoning death the runner header documents) and two
    200-row chunks exhausted the V8 heap. Both sides are therefore run in
    identical 200-row chunks, with one 50-row sub-chunk (`c10s2`) run
    `--isolate` on both sides. Chunking is what makes a crash cost its own
    rows instead of the whole measurement.
- **Host (gc) lane**: every seam is standalone-gated, so the control is a
  sha256 byte comparison of 8 compiled programs (zero-arg and callback HOF,
  dyn `sort` with and without a comparator, `isView` direct and as a
  first-class value, TypedArray `slice`/`subarray`) — **all 8 host binaries
  byte-identical** (`.tmp/6651/hostbytes-{before,after}.txt`). On standalone the
  same corpus shows exactly the intended delta: the five programs that touch a
  changed seam differ, the three that do not are byte-identical
  (`.tmp/6651/sabytes-{before,after}.txt`).
- **Unit tests**: new `tests/issue-6651-e-typedarray.test.ts` (9 cases — the
  four seams plus their negative controls: a callable HOF still runs, an
  absent/undefined/callable comparator still sorts, an ordinary numeric
  `slice`/`subarray` window still works).
- **Gates**: loc-budget passes with the three god-file grants added to this
  file's frontmatter (+15 / +14 / +3, each a single arm spliced into an
  existing ladder); func-budget, coercion-sites, oracle-ratchet, dead-exports
  and `scripts/equivalence-gate.mjs` (22 known failures, no new) all pass.

**Residual sub-buckets (130 fail + 1 CE on the manifest), with signatures:**

| rows | status | sub-bucket | why it is still open |
| ---: | --- | --- | --- |
| 22 | fail | every `$DETACHBUFFER` row — `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | ENVIRONMENT ONLY, and it is the whole detached-buffer cohort (`{every,some,forEach,reduce,reduceRight}/callbackfn-detachbuffer`, `fill/coerced-*-detach`, `copyWithin/coerced-values-*`, `{join,toString,toLocaleString,subarray}/detached-buffer`, `from/*-mapper-detaches-result`, `sort/sort-tonumber`, two `proto-from-ctor-realm`). The `$262` shim pulls the runtime-eval seam and the QuickJS artifact is not built in this container, so these rows are **unverifiable locally** — they were never measured either way here |
| 9 | fail | `Object.prototype.toString is not yet implemented in --target standalone` | #4119, owned by cluster H — `ArrayBuffer/newtarget-prototype-is-not-object`, `ArrayBuffer/prototype/slice/species-*`, `ctors/{no-species,length-arg/toindex-length}`, `ctors/typedarray-arg/same-ctor-buffer-ctor-species-*` |
| 9 | fail | `TypedArray.from` iterator/array-like error propagation — `Expected a Test262Error but got a TypeError` | the `from` pipeline turns a user abrupt completion into its own TypeError (`from/{arylk-get-length,arylk-to-length,iter-access,iter-invoke,iter-next,iter-next-value}-error`) |
| 7 | fail | `TypedArrayConstructors/{from,of}` statics | `%TypedArray%.{from,of}` is not inherited by the concrete constructors, and the custom-`this` forms are unimplemented (`inherited.js` reads `undefined`; `custom-ctor*.js` / `new-instance-using-custom-ctor.js` read `undefined.call`) |
| 5 | fail | `ctors/object-arg/throws-setting-obj-*` — ToNumber(element) of a typed array with an own `valueOf`/`toString`/`@@toPrimitive` expando | ROOT-CAUSED, not fixed: `__to_primitive` reduces any `$__vec_base` subtype through `Array.prototype.toString`, so OrdinaryToPrimitive never runs. A dyn-view arm in `__to_primitive` DOES fix it for a dynamically-constructed view (measured: `Number(v)` with a throwing `valueOf` expando propagates), but these rows build the sample as a STATIC `new Int8Array(1)`, whose carrier has no expando side-table for `__extern_get` to find — so the arm gains 0 measured rows and was reverted rather than shipped unmeasured. The blocking gap is the static carrier's expando table, not ToPrimitive |
| 5 | fail | `ctors/object-arg/iterator-*` + `iterating-throws` + `iterator-is-null-as-array-like` | the ctor argument is `var obj = function () {}` — a CALLABLE. It is neither `$Object` nor a vec, so the dispatch falls to the count form (ToIndex → 0) and never consults `@@iterator`; §23.2.5.1 step 6 needs a closure arm |
| 4 | fail | `{filter,map}/callbackfn-arguments-with[out]-thisarg` — `results[0][2] - this` | the dyn-view species two-arm rebinds the receiver identifier to the MATERIALIZED f64 vec before compiling the loop, so the callback's third argument has the right CONTENTS and the wrong IDENTITY |
| 4 | fail | `{filter,map,slice,subarray}/speciesctor-get-species-custom-ctor-invocation` | the `@@species` getter's `this` is not the constructor |
| 16 | fail | `internals/{Set,DefineOwnProperty,OwnPropertyKeys}` | the integer-indexed exotic MOP over Proxy receivers, `preventExtensions`, symbol keys and key ordering — a separate mechanism |
| 9 | fail | `prototype/toLocaleString/*` | needs `Invoke(element, "toLocaleString")` per element; measured precondition missing: a user `Number.prototype.toLocaleString` override is not honoured even for a direct `n.toLocaleString()` in standalone |
| 6 | fail | `DataView/{dataview,defined-*,return-instance,custom-proto-*,instance-extensibility}` | `Object.getPrototypeOf(new DataView(…))` does not answer `DataView.prototype` |
| 6 | fail | `{entries,keys,values}/{iter-prototype,return-itor}` | the iterator result is not an %ArrayIteratorPrototype% object (`Cannot read properties of undefined (reading 'next')`) |
| rest | fail/CE | `isView` subclass instances, `sort` ordering, `ArrayBuffer/{prop-desc,data-allocation-…,prototype-from-newtarget}`, `slice` species residuals, `length-excessive-throws` (a wasm `requested new array is too large` trap), one `from-typedarray-into-itself-mapper-detaches-result` CE (`env::__unwrap_for_wasm`) | each its own mechanism |

**Not started in this slice (and why):** the four largest remaining buckets are
the integer-indexed MOP (16), `toLocaleString` (9) and the two `from`/`of`
families (16). Each needs a mechanism rather than an arm, and the detached
cohort (22) cannot be measured in this container at all — so E1 took the four
seams that are complete, measurable and independently verifiable here.

## Manifest generator note

Partition rule applied to the 1,320 non-pass rows, first match wins:
A = `status == compile_error` and error mentions generator/`__gen_`/yield;
D = path or error mentions Promise; B = `built-ins/RegExp`, `annexB/built-ins/RegExp`,
`String.prototype.{match,search,split,replace}`; E = `TypedArray*`,
`ArrayBuffer`, `DataView`; F = `Proxy`, `Reflect`; C = `statements/class`,
`expressions/class`, `expressions/super`, `new.target`, `expressions/object`,
computed-property-names; G = `for-of`, `expressions/assignment`, `for/`,
generators (runtime), `GeneratorPrototype`, `GeneratorFunction`, `Iterator`,
`ArrayIteratorPrototype`; H = remaining `built-ins/*`; I = the rest.
Manifest SHA-256s are in the commit that added them.
