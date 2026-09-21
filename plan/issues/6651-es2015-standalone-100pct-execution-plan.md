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
# 2026-09-20 (cluster H, arguments ordinary `length`) — +4 lines in
# `src/codegen/vec-overlay.ts`: two comment lines stating §10.4.4's rule, the
# one-line call that splices the arguments arm into `__vec_dp_value`'s
# `"length"` body, and the two `...argumentsLengthDefineArm` spreads at its two
# entry points. The arm BODY (and the descriptor-value reader beside it) lives
# in the length subsystem module `src/codegen/vec-length-descriptor.ts`, which
# exists for exactly this — "keep the brand-sensitive seed and descriptor reads
# out of the overlay emitter so the length implementation remains within its
# subsystem budget". Inlined in the overlay the same change was +77. What
# cannot move is the call site: the decision "an arguments receiver does not
# run ArraySetLength" has to be readable at the point ArraySetLength starts.
# 2026-09-20 — cluster A (native generator lowering, standalone). Two gate
# widenings in `generators-native.ts` (`this` in a generator function
# EXPRESSION; a generator-valued destructuring-param default in a zero-suspend
# method lane). +61 manifest rows pass, 0 regressions across a 617-row
# generator neighbourhood on BOTH targets. The growth is ~80 % comment: each
# widening reverses a bail whose prior rationale is recorded in place, so the
# measurement that overturns it is recorded next to it rather than in a commit
# message nobody reads at the bail site.
# 2026-09-21 — cluster C (standalone Error `message`, §20.5.1.1 step 3).
# `src/codegen/context/types.ts` +7 and `src/codegen/index.ts` +3 (one +1 in
# each of `generateModule` / `generateMultiModule`). The MECHANISM is in two
# leaf modules that did not exist before (`error-subclass-proto-chain.ts`) or
# already own it (`registry/error-types.ts`); what cannot move is (a) the
# context field that carries the `__new_<Error>` bodies from emit time to
# finalize — `$AnyValue`, the carrier the `undefined` test reads, is not
# reserved when those constructors are emitted, WAT-verified — and (b) the two
# finalize call sites that drain it, which have to sit with the other
# `fill*ErrorProps` phases so the ordering is readable where it matters. The
# first cut built the test at emit time instead and silently degraded to the
# bare `local.get 0` it was meant to replace.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/generators-native.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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

### H — builtins misc (2026-09-20, Opus lane)

- Branch `worktree-agent-a5c18a3e8a3d3a0fd`, worktree
  `/home/user/js2/.claude/worktrees/agent-a5c18a3e8a3d3a0fd`, based on
  `claude/es2015-test262-plan-54tooh` (905dca75).
- Manifest `plan/agent-context/6651/H-builtins-misc.txt`, sha256
  `f1eb655415155ac7e7d262ffbaa50a479f8a495bdeb297fad7292169811c104f`, 217 rows.

**Before → after on the manifest** (isolated standalone runner, one row per
child process; logs `.tmp/6651/H-{before,after}.tsv`):

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before | 0 | 211 | 6 |
| after | **3** | 208 | 6 |

Per-row diff: **3 gained, 0 lost, 0 other verdict changes** —
`Array.prototype.concat_{sloppy-arguments,sloppy-arguments-with-dupes,
strict-arguments}.js`.

**What landed: an `arguments` object's `length` is an ORDINARY property
(§10.4.4), on all three surfaces.** The assignment half already modelled this
(`member-set-dispatch.ts`, `vec-length-set.ts` arm 1: store the value in the
`$__arguments_vec` override fields, leave the index domain alone). Three
surfaces disagreed with it, each measured on the base tree:

1. `Object.defineProperty(args, "length", {value: 6})` ran Array ArraySetLength
   (`__vec_dp_value`), which GREW the physical backing; the new tail read back
   as wasm null — JS `null`, not `undefined` — and `4 in args` answered `true`
   for a slot that is not an own property.
2. `__extern_length` (the array-like length every generic spec loop reads) read
   field 0, so `[].concat(args)` after `args.length = 6` produced three
   elements where §23.1.3.1 wants six (three values + three holes).
3. `Object.getOwnPropertyDescriptor(args, "length").value` answered the
   physical count (3) while `args.length` answered 6 — the same property, the
   same module, two answers.

Files: `src/codegen/vec-length-descriptor.ts` (both new builders — the
subsystem module for brand-sensitive length descriptor reads),
`src/codegen/vec-length-set.ts` (`spliceArgumentsExternLengthArm`),
`src/codegen/vec-overlay.ts` (+4 lines: the two call sites). Pin file
`tests/issue-6651-arguments-ordinary-length.test.ts` — 5 cases, **3 verified
RED on the base tree**, 2 are guards (green both sides), including the negative
direction (an untouched arguments object must keep the physical length).

**Neighbourhood control** — `built-ins/Array/prototype/concat` (all 69 rows) +
the 53 `language/arguments-object` rows that write/define/delete `length` or
run `verifyProperty`, standalone, before vs after on the same machine
(`.tmp/6651/ctl-{before,after}.tsv`): `95 pass / 26 fail / 1 CE` →
`98 / 23 / 1`, **0 pass → non-pass**, no other verdict changes.

**Host (default target) control is a byte-identity proof, not a sample.** Both
arms are standalone-gated (`ctx.externGetIdxReserved` / `ctx.standalone`), so
the honest control is that host output cannot move: the 13-file
`website/playground/examples` corpus compiles byte-identically on **gc and
standalone** before vs after (26/26 sha256 equal), and a module that exercises
exactly this construct (`arguments` + `length` write + define + concat +
gOPD) is byte-identical on **gc** (`31006917fced63c6` both sides) while its
standalone output changes (`0d2af224b558c195` → `f04025b3dd538141`).

Gates, bare: loc-budget OK (+4 in `vec-overlay.ts`, granted in this file's
frontmatter above, dated), func-budget OK, coercion-sites OK, oracle-ratchet OK
(`getTypeAtLocation +0`, `ctx.checker +0`), dead-exports OK, typecheck OK,
prettier OK, `biome lint --diagnostic-level=error` OK.
`node scripts/equivalence-gate.mjs`: **22 failing / 1720 passing, all 22 already
in `scripts/equivalence-baseline.json` — no new equivalence regressions.** (The
bare `vitest run tests/equivalence` OOMs in this container, as the project docs
warn; the gate's single-fork run is the supported way to score it.)

#### Residuals — what the other 214 rows are

Two thirds of this cluster is not "builtins misc" at all:

- **63 rows are not measurable in this container**: they need the runtime-eval
  provider (`JS2WASM_EVAL_ENGINE=quickjs`, artifact not built here) — mostly
  the `$262.createRealm` family. Before and after were measured with the SAME
  engine, so the delta is comparable; the absolute cause mix is not
  CI-comparable.
- **53 further rows are realm- or Proxy-dependent by source inspection**
  (`createRealm` / `new Proxy` / `Proxy.revocable` in the test body) —
  `proto-from-ctor-realm*`, `Symbol/*/cross-realm`, `create-proxy`,
  `Function/prototype/toString/proxy-*`. Cross-realm intrinsics have no
  standalone representation today; these belong with cluster F's Proxy work or
  a `wont-fix` with the realm reason, not here.
- **101 rows are core-measurable** and fragment into buckets of ≤5, the largest
  being: `Expected a TypeError … no exception` (5, builtin-method
  not-a-constructor + frozen-target `Object.assign`), `Expected a Test262Error
  but got a TypeError` (5, Map/WeakMap iterable-entry abrupt completions),
  bound-function `new.target` (5), `target-array-with-non-writable-property`
  species rows (4), `Array.prototype.flat` standalone CE (3), the
  `Object.prototype.toString` standalone refusal (3, all needing a runtime
  `@@toStringTag` Get honouring `delete`), and ~25 singletons.

Measured findings worth the next lane's time (each reproduced on the base tree
with a standalone probe, none fixed here):

- **Symbol-keyed ACCESSOR `defineProperty` on a vec carrier is silently
  dropped.** `Object.defineProperty(arr, Symbol.isConcatSpreadable, {get})`
  leaves `arr[Symbol.isConcatSpreadable]` `undefined` and never fires the
  getter, while the same descriptor on a plain object works and a plain
  symbol-keyed assignment on the array works. Cause: the vec overlay's
  `stringKeyGuard` BAILS on a non-string key, and the bail returns from
  `__defineProperty_value`/`_accessor` outright. This is #6485's recorded
  `is-concat-spreadable-get-order` residual, now localised.
- **`__extern_length` answers 0 for non-`$Object` object carriers.** A
  spreadable `new String("yuck")` concats to `[]`; a spreadable function with
  `length = 3` is not spread at all. The `$Object` array-like arm
  (`ToLength(Get(O,"length"))`) has no counterpart for wrapper / closure /
  RegExp carriers — deliberately not widened here, because it changes the
  array-like length of every such receiver and needs its own control set.
- **`Object.assign(Symbol(), …)` does not box**: `typeof` stays `"symbol"` and
  `Object(sym) === sym`. ToObject has no Symbol-wrapper carrier.
- **`Object("hi").length` is 0** while `new String("xy").length` is 2 — the
  ToObject path builds a different carrier from the constructor path.
- **`Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")`** works
  (#5268) but `get.call({})` answers `null` rather than `Object.prototype`, and
  `set.call(o, proto)` does not make `getPrototypeOf(o)` that proto — an
  object-model gap, not an accessor gap.

### 2026-09-20 — Cluster A (native generator lowering, standalone), slice 1

- **Branch** `worktree-agent-ad71a322a90a0a605`, based on
  `claude/es2015-test262-plan-54tooh` @ `905dca75`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-ad71a322a90a0a605`.
  A second, source-clean worktree `/home/user/js2/.claude/worktrees/measure-6651-A`
  (detached at the same commit) held every before-run — the first attempt
  measured the base with the runner reading the *edited* tree underneath it,
  which is not a before-state.
- **Manifest** `plan/agent-context/6651/A-generators-standalone.txt`, 197 rows,
  sha256 `5fc1a7c0c1d5672aba427f347ea225633e0c95cfa6e9547240fcc2cda2d62d77`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/A-before.log`) | **1** | 1 | 195 |
| after (`.tmp/6651/A-after.log`) | **62** | 2 | 133 |

**+61 rows pass, 0 pass → non-pass.** The one other movement is
`language/expressions/yield/star-in-rltn-expr.js`, compile_error → fail — a
narrower, documented residual (it now builds and gets a wrong first `value`).

#### What changed, and why it was bailed before

Both edits are in `src/codegen/generators-native.ts`; both reverse a *bail*, and
neither adds a host import.

1. **A1 — `this` inside a generator function EXPRESSION (41 rows).**
   `isNativeGeneratorExpressionShape` refused any `this` in the body, so
   `Array.prototype[Symbol.iterator] = function*(){ … this.length … }` — the
   shape the whole `dstr/*-array-prototype` fixture family is built on — fell to
   the eager-buffer host path and leaked `env::__gen_*` into a standalone
   binary. #5255 had already solved the same problem for free *declarations*:
   snapshot the receiver into a frame field (`dynamic_this`) in the FACTORY and
   restore it as the resume function's `this` local. The bail's own comment said
   fn-exprs were excluded because "their closure ABI supplies a different
   capture carrier" — but `this` is not a capture (a non-arrow function
   expression rebinds it per call), so the `__self` struct and the receiver
   never compete. The factory here IS the lifted closure, whose `this` resolves
   through the `__current_this` global that `__call_fn_method_N` installs around
   the dispatch, i.e. exactly where §10.2.1 binds it.
   The load-bearing property is the *snapshot*, not "it compiles": a generator
   body runs on a later `.next()`, long after that global is restored. The
   `tests/issue-6651-generator-expression-this.test.ts` case "the receiver
   SURVIVES a suspension" is the one that fails if the receiver is read lazily.
   `super` keeps the bail (no [[HomeObject]] slot in the frame), and the two
   `this`-scans must agree before admitting — `fnExprBodyReferencesThis`
   descends into class bodies while `bodyReferencesOwnThis`, which arms the
   snapshot, stops there.
2. **A2 — a generator-valued destructuring-param default in a zero-suspend
   method lane (20 rows).** `buildNativeGeneratorPlan` bailed on every
   `[g = function*(){}]` param default. #4769 had already admitted a
   *class*-valued default on exactly one precondition — the method must not
   yield, so the value never crosses a suspension — and the #3952 note left the
   generator arm as "a measured, bounded follow-up", declining to admit it on
   lane identity alone. This is that measurement. A **yielding** method still
   takes the host path, and the generator function-expression host keeps its
   blanket bail for the reason recorded there (that lane mishandles element
   defaults with no closure involved at all, so admitting would swap a loud
   leak for a silent wrong value). Both halves are pinned by tests.

#### Neighbourhood regression control — zero pass → non-pass

617 rows: all of `language/expressions/generators`,
`language/statements/generators`, `built-ins/GeneratorPrototype`. The 8
`*array-prototype*` rows poison the realm, so they ran `--isolate`; the other
609 ran in-process, before and after, on both targets.

| lane | before | after | flips |
| --- | --- | --- | --- |
| standalone, 609 in-process | 512 / 56 / 41 | 512 / 56 / 41 | none |
| host (default), 609 in-process | 521 pass / 88 fail | 521 / 88 | none |
| standalone, 8 isolated | 4 pass / 4 CE | **8 pass** | +4, none lost |
| host, 8 isolated | 4 pass / 4 fail | 4 / 4 | none |

Logs: `.tmp/6651/nb-{sa,host}-{before,after}.log`,
`.tmp/6651/nbiso-{sa,host}-{before,after}.log`.

Also green: `npm run -s typecheck`; the 11 generator-adjacent unit suites
(`generators`, `generator-iife`, `generator-method-destructuring`,
`generator-yield-contexts`, `issue-3032`, `issue-3164`, `issue-3302`,
`issue-3386`, `issue-3952`, `issue-4769`, `issue-5255`) — 94/94; and
`tests/equivalence`, 217 of its 218 files (run in small batches — the whole
suite OOMs on this box, and `multi-file-compilation.test.ts` OOMs on its own,
**identically on the base commit**, so it is an environment limit, not a
finding). Equivalence has **22 failing cases, every one of which reproduces on
the base commit** in the clean worktree: `arguments-nested-and-loops` (1),
`array-inline-return` (1), `delete-sentinel` (1), `logical-conditional-identity`
(3), `new-non-constructor` (2), `null-dereference-guards` (5), `reflect-api`
(1), `tdz-reference-error` (6), `yield-as-expression` (1),
`misc-small-patterns` (1). None is attributable here. The last two were
re-checked individually rather than assumed, because both name shapes this
change touches (`yield`; a named function expression's own-name binding).

#### Residual sub-buckets (135 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 74 | `standalone target emitted host imports: env::__gen_*` | see split below |
| 53 | `native generator lowering currently supports only sequential numeric yields … (#680)` | `yield` nested inside an assignment PATTERN |
| 6 | `'yield' is a reserved word …` | decorator-syntax rows; not a generator gap |
| 1 | `fail` — wrong first `value` | `language/expressions/yield/star-in-rltn-expr.js` (was CE) |
| 1 | `fail` — invalid module, `__gen_resume_g` `local.tee` type | `yield-star-before-newline.js`; **pre-existing, byte-identical before and after** |

The 53 `#680` rows plus 37 of the 74 leaks are **one family, 90 rows**:
`[ x = yield ] = vals` / `for ([ {} = yield ] of …)` — a `yield` suspension
*inside* a destructuring-assignment pattern, which `lowerStatements` reaches as
an unmodeled `ExpressionStatement` (17) or `ForOfStatement` (20). **Do not
start here expecting passes:** a host-lane probe of 8 of these rows failed
8/8, so the generator lowering is not their only blocker. (Same probe: 8/8 of
the A1 family and 8/8 of the A2 family passed on the host — which is exactly
why those two were picked first, and it is the cheapest triage available: a
row that fails on the host cannot be made to pass by fixing standalone-only
lowering.)

The other 37 leaks are small, independent gates in
`isNativeGeneratorExpressionShape` / `isNativeGeneratorCandidate`:

| rows | gate |
| ---: | --- |
| 16 | generator function-expression host, ANY closure-valued param default (the `ts.isFunctionExpression(decl)` arm — blocked by that lane's pre-existing plain-numeric-default defect, #3952, which must be fixed first) |
| 9 | named fn-expr whose body references its OWN name (`bodyReferencesOwnName`) — needs the immutable self-name binding, incl. its strict-mode TypeError on reassignment |
| 5 | computed-name generator methods (`{ [k]*(){} }`) — blocked on a stable emitted-name derivation |
| 4 | rest / optional params (2 in the object-method gate, 2 in the fn-expr gate) |
| 2 | `super` or an outer-scope capture in an object-literal method |
| 1 | duplicate method name within one class/object literal |

Method used, for the next owner: `isNativeGeneratorCandidate` /
`buildNativeGeneratorPlan` were temporarily instrumented (every `return
false`/`null` tagged with its line, `fail()` tagged with its caller from the
stack, plus the unmodeled statement's `SyntaxKind` + source text) and the
manifest was run through a **compile-only** probe. That turns "197 compile
errors" into a per-gate histogram in ~8 minutes instead of a 40-minute runner
pass, and it is how the three buckets above were sized before any code changed.
The instrumentation is not committed.

### 2026-09-21 — Cluster C (class / object-literal / `super`, standalone), slice C1

- **Branch** `worktree-agent-a27d2e622e3791fde`, based on
  `claude/es2015-test262-plan-54tooh` @ `9b1ff0dc` (origin/main + plan +
  cluster A merged). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a27d2e622e3791fde`.
- **Manifest** `plan/agent-context/6651/C-class-object-super.txt`, 177 rows,
  sha256 `785dd45d78a609ecefc58377433fd144a142423557001a9b513cf1ae1492ad8d`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/C-before.log`) | 0 | 173 | 4 |
| after (`.tmp/6651/C-after.log`) | 0 | 173 | 4 |

**No row flipped to pass in this slice, and no row regressed.** The plan's own
census said 171 fail / 6 CE; this branch's base measures 173 / 4 — quote the
measured numbers, not the census. Seven rows moved to a LATER assertion and are
recorded below as a narrower residual; nothing else in the log changed except
two byte-offset numbers inside pre-existing `CompileError` texts.

#### What landed — §20.5.1.1 step 3 and the error-subclass prototype edge

Two defects, both reproduced with probes on the base tree before any edit.

1. **`new Err()` on `class Err extends TypeError {}` had an own `message`.**
   A direct `new TypeError()` lowers with `argCount === 0`, so the constructor
   stores `ref.null.extern` in `$Error_struct` field 1 and the own-property
   surfaces correctly report absence. The derived subclass goes through a
   FIXED-ARITY forwarder (`Err_new : (externref) -> externref`), so `new Err()`
   pads slot 0 with the canonical `undefined` singleton (`global.get
   $undefined`, WAT-verified) — a non-null value, so the same field said
   "present". The fix is in the CONSTRUCTOR, not the forwarder: passing
   `undefined` to `super()` is exactly what the default derived constructor
   does (§15.7.14), so the value is right and §20.5.1.1 step 3 is the step that
   must ignore it.
   Load-bearing detail: the test could NOT be built where the constructor body
   is built. `$AnyValue` — the carrier the `undefined` singleton lives in — is
   not reserved yet when the standalone scaffold emits `__new_TypeError`, so
   the first cut silently degraded to the bare `local.get 0` it was meant to
   replace (WAT-verified, and the probe that "passed" did so for an unrelated
   reason). It is now recorded at emit time and woven in at FINALIZE
   (`fillErrorCtorUndefinedMessage`), which is why the change needs a context
   field and two call sites in `index.ts`.
2. **An error-subclass instance inherited NOTHING from its own class
   prototype.** Measured (`.tmp/w6651C/e4.ts`): `Err.prototype["tag"+"x"]`
   answers `"T"`, `new Err()["tag"+"x"]` answers `undefined`, and the same
   shape on a PLAIN class answers `"Y"`. So the carrier, the write and the
   ordinary class rule all worked; the one missing edge was instance →
   subclass prototype for the `$Error_struct` representation.
   `emitStandaloneClassProtoObject` declines for a class with a builtin parent,
   so there is no `$Object` proto link to walk; the instance's identity lives
   in `$userClassId` (fieldIdx 4). The new leaf module
   `src/codegen/error-subclass-proto-chain.ts` turns that brand back into the
   class's prototype global and delegates the lookup — including the rest of
   the chain — to `__extern_get` on the carrier. `message` additionally stops
   answering from a NULL field in both `__extern_get` and the own-property
   arms, so presence and value cannot disagree.

Files: `src/codegen/error-subclass-proto-chain.ts` (new),
`src/codegen/registry/error-types.ts`,
`src/runtime/wasmgc/values/error-bodies.ts`, plus the context field and the two
finalize call sites. Pin `tests/issue-6651-error-undefined-message.test.ts` —
4 cases, **2 verified RED on the base tree** (base 6 → 7, base 4 → 7), 2 are
guards green on both sides (an explicit `undefined` argument; a plain builtin
error's message/name/throw-catch round trip).

#### Controls — zero pass → non-pass

| set | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| manifest, `--isolate` | 177 | 0 / 173 / 4 | 0 / 173 / 4 | none |
| `built-ins/Error/**` + `built-ins/NativeErrors/**`, in-process | 187 | 132 pass / 46 fail / 9 CE | 132 / 46 / 9 | **identical non-pass set** |
| `class/subclass` + `expressions/super` + `statements/try` + `AggregateError`, in-process, 4 chunks | 429 | 316 pass / 111 fail / 2 CE | 316 / 111 / 2 | **identical non-pass set** |

Logs: `.tmp/6651/C-{before,after}.log`, `.tmp/6651/ctlerr-{before,after}.log`,
`.tmp/6651/ctlcls-{before,after}-0*.log`. The 429-row set had to be run in
110-row chunks: the whole list in one in-process run dies with an empty log
(exit 1, zero bytes), which is the realm-contamination hazard the runner header
documents.

**Host (gc) control is a byte-identity proof, not a sample.** Every arm is
gated on `ctx.targetProfile.semanticProviders === "native-first"`, so host
output cannot move: an 11-program corpus (the playground example plus ten
probe modules, several of them error-heavy) compiles **byte-identically on gc,
11/11 sha256 equal**, while 9 of the 11 standalone binaries change — exactly
the intended delta (`.tmp/6651/bytes-{before,after}.txt`). The later extraction
of the ladder into its own module was separately proven byte-neutral (22/22
identical across both targets).

Gates, run bare: loc-budget and func-budget PASS with the grants added to this
file's frontmatter above (`context/types.ts` +7, `index.ts` +3 / +1 / +1 —
everything else moved into leaf modules; extracting the ladder is what took
`fillExternGetErrorProps` back under its 300-LOC ceiling); coercion-sites,
oracle-ratchet (`getTypeAtLocation` +0, `ctx.checker` +0), dead-exports,
typecheck, compiler-boundaries `--mode inventory` (the new module is classified
in `scripts/compiler-boundaries.json`), prettier and
`biome lint --diagnostic-level=error` all 0. `node scripts/equivalence-gate.mjs`:
**22 failing / 1720 passing, all 22 already in the baseline — no new
equivalence regressions.**

#### Residuals — what the other 177 rows are, measured

The seven rows this slice moved are the `NativeError/{Eval,Range,Reference,
Syntax,Type,URI}Error-message.js` family plus
`Error/message-property-assignment.js`. They now fail one assertion LATER:
`err2.hasOwnProperty('message')` passes, and they stop at
`assert.sameValue(err2.message, 'custom-…')`. The remaining blocker is
**MODULE-scope**, and it is a third, independent defect: with the class and the
prototype write at module top level — which is what the honest harness
assembly compiles, since the test body is NOT wrapped in a function there —
`Err.prototype.message = "custom"` does not land where the dynamic read looks
(`.tmp/w6651C/e9.ts`: 1 of 4, where the same program inside a function answers
4 of 4). That is a prototype-WRITE placement bug at module scope, not a read or
a construction bug, and it is the next thing to fix for this family.

Bucketed before-state of the whole manifest, by signature:

| rows | signature | mechanism |
| ---: | --- | --- |
| 10 | `SameValue(«0», «false»)` — `*/dflt-params-arg-val-not-undefined.js` | a method parameter with a numeric default is lowered as `f64`, so an explicitly passed `false` / `''` / `null` arrives as `0`. TS infers the parameter type from its initializer; in JS there is no type. A type-lowering question, not a class one. |
| 10 | `Cannot destructure 'null' or 'undefined'` — `*/gen-meth-ary-ptrn-elem-ary-empty-init.js` | generator-method destructuring; cluster A's lane, deliberately not built here |
| 8 | `SameValue(«NaN», «undefined»)` — `*/dstr/*-dflt-obj-ptrn-prop-ary.js` | same f64-typed-slot defect as the 10 above, one level inside a nested destructuring default |
| 9 | `Cannot access property on null or undefined` | mixed |
| 8 | `Expected a TypeError … no exception` | scattered singletons (`constructable-but-no-prototype`, `invalid-extends`, `methods-restricted-properties`, `prototype-setter`, `name-binding/const`, `arguments-callee`, `Proxy/no-prototype-throws`, `Symbol/new-symbol-with-super-throws`) — no shared lever |
| 6 | `SameValue(«"undefined"», «"object"»)` / `«null», «"a"»` — `expressions/super/prop-{dot,expr}-cls-{val,val-from-arrow,this-uninit}.js` | see the #2818 finding below |
| 5 | `quickjs provider is not built` | environment only; unmeasurable in this container |
| ~20 | `gen-method` / `decorator` shaped | measured, not built — cluster A's base |

#### Two localised findings the next lane should not have to re-derive

Both were reproduced with probes, both are REAL, and **neither moves a single
test262 row** — which is why this slice does not ship either of them. They are
recorded because each cost real measurement to localise and each looks like an
obvious lever until it is measured.

1. **A class declared inside a BLOCK whose method writes a captured
   function-scoped `var` drops the write.** `.tmp/w6651C/q31.ts`, ten lines, no
   `super`: `function test(){ var n=0; if(1){ class C{ m(){ n=5; } } new C().m(); } return n; }`
   answers **0**, node answers 5. The emitted `$C_m` declares `(local $n f64)`
   and stores into it; move the same class to function-body level and the
   method stores into the promoted `__captured_n` global and the answer is 5.
   Root cause: `collectBlockScopedDeclNames` (`src/codegen/declarations.ts`)
   collects only `let`/`const`, on the premise that "a `var` is function-scoped
   and therefore already a module global" — true at module scope, false inside
   a function, which is the only place that function is ever called from.
   Collecting `var` there fixes it (verified), and a `let` in the same shape
   already works.
   **Why it is not shipped: it flips ZERO test262 rows.** The test262 wrapper
   HOISTS every initialised test-body `var` to module scope as a `let`, and —
   more decisively — the standalone lane is scored on the honest
   whole-assembly harness, which does not wrap the body in a function at all.
   The #5350 lane recorded this same defect as "the single largest blocker" for
   the `super/prop-*-cls-val` family; measured against the harness assembly the
   rows those tests actually run, it is not their blocker.
2. **The #2818 standalone carve-out that keeps every DERIVED class eager is no
   longer paying for itself.** `classDeclCapturesNames` returns false for any
   `extends` clause under standalone, citing 6 rows that regressed when derived
   capturers were deferred. Disabling the carve-out and running those 6 named
   rows plus 14 related class/super rows gives an **identical 2 pass / 18 fail**
   on both sides (`.tmp/6651/ctl-{base,fix2}.log`) — the 8 Iterator
   `return-is-forwarded` rows now fail for an unrelated reason
   (`called value is not a function`). So the carve-out can probably be
   retired, but retiring it alone also flips zero rows, for the same
   harness-shape reason as finding 1.

The honest lesson for the next owner of this cluster: **probe against the
ORIGINAL-HARNESS assembly, not against a hand-written `export function test()`.**
`assembleOriginalHarness(source, meta).primary.source` is three lines of driver
(`.tmp/w6651C/harness.mts`) and it puts the test body at MODULE scope, where
several of this cluster's defects live and where a function-scoped probe cannot
see them. Most of this slice's investigation time went into a defect that
only exists in the function-scoped shape.

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
