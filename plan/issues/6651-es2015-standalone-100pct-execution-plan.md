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
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/vec-overlay.ts
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
