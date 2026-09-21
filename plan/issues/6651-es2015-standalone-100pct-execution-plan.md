---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-21
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
# 2026-09-20 — cluster B (String.prototype @@match/@@replace/@@search/@@split
# dispatch, standalone). The protocol itself (~290 LOC) lives in the NEW module
# `src/codegen/string-symbol-protocol.ts`; the only god-file growth is the
# dispatch site in `call-receiver-method.ts::compileReceiverMethodCall` that has
# to NAME it. The call site cannot move: §22.1.3 step 2 runs BEFORE the string
# lane, so the decision "this search value may carry a protocol method" has to
# be readable at the point the native string lane is entered, and the probe's
# fall-through arm IS that same lane re-entered through a closure.
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
# 2026-09-21 — cluster F (Proxy/Reflect, standalone). All three edits are inside
# the ONE standalone `Reflect.*` arm of `compileNamespaceStaticCall`
# (`nativeReflectProvider`), which is where each method's own answer is built;
# there is no seam to move them behind without splitting a god-function this
# slice does not otherwise touch. The growth is ~60 % comment: two of the three
# reverse a written-down claim that has gone STALE (the `setPrototypeOf` "KNOWN
# LIMITATION: the native has no failure channel" — #5148 built one; the
# `ownKeys` "the native runtime does not retain symbol-keyed properties yet" —
# it does), so the measurement that overturns each claim is recorded next to
# it rather than in a commit message nobody reads at the site.
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
  - src/codegen/vec-overlay.ts
  - src/codegen/generators-native.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/closed-method-dispatch.ts
# 2026-09-21 — cluster C, slice C2 (top-level `C.prototype.x = v`).
# `declarations.ts` +10 / `collectDeclarations` +9, `assignment.ts` +5 /
# `compilePropertyAssignment` +4, `property-access-dispatch.ts` +9. All three
# MECHANISMS moved into two new leaf modules (`class-proto-toplevel-write.ts`,
# `error-message-proto-read.ts`); what is left is irreducible call sites. A
# module-init KEEP has to be at the point the statement would otherwise be
# dropped; the decline that stops a `.prototype` receiver from being cast to
# `$Error_struct` has to be on the arm that would do the casting; the
# absent-`message` read has to be inside the arm that owns the
# statically-typed Error read. Inlined, the same change was +114.
  - src/codegen/declarations.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
# 2026-09-21 (cluster F) — the three new `__is_truthy` calls are not a
# hand-rolled coercion matrix. Each is literally the spec's ToBoolean on a
# [[SetPrototypeOf]] / [[PreventExtensions]] success bit (§28.1.14 step 4,
# §28.1.11 step 2), and each calls the SAME shared `__is_truthy` native that
# the neighbouring `Reflect.defineProperty` arm and the six #6494/#5316 proxy
# front guards already use to read exactly this kind of booleanish trap result.
# This makes the `Reflect` arms agree with one another rather than introducing
# a second rule — the same argument #6494 recorded for its own three.
coercion-sites-allow:
  - src/codegen/expressions/call-namespace-static.ts
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

### 2026-09-21 — Cluster B (RegExp Symbol.\* protocol, standalone), slice B1: `String.prototype` @@-dispatch

- **Branch** `issue-6651-cluster-B-regexp`, based on
  `claude/es2015-test262-plan-54tooh` @ `9b1ff0dc`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a35ed687b8f0ef175`.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt`, 147 rows,
  sha256 `f34bba06f50029156d5fb0cf36bb4f7da0c670b8645cdd35136dec9916a90b61`.
- Coordinated against **#5198** (Codex lane): its Slices A–C (observable
  `RegExpExec`/custom `exec`, `lastIndex`, the `flags` getter) and the Annex B
  compile-syntax work are UNTOUCHED here. This slice is #5198's **Slice D**,
  which had no in-flight branch.

| standalone, `--isolate`, 147 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/B-before.log`) | **0** | 136 | 11 |
| after (`.tmp/6651/B-after.log`) | **7** | 129 | 11 |

**+7 rows pass; every one of the other 140 rows keeps its exact status** (the
two logs were joined row-by-row, not just compared by count). No compile_error
became a fail and no fail became a compile_error.

#### What changed, and why the previous answer was wrong rather than missing

One new module, `src/codegen/string-symbol-protocol.ts`, plus a 10-line
dispatch site in `call-receiver-method.ts`. No new host import — the probe is
built from natives the object runtime already exports (`__extern_get`,
`__box_symbol`, `__typeof_function`, `__objvec_new/push`, `__apply_closure`).

§22.1.3 step 2 of `match`/`replace`/`search`/`split` is
`GetMethod(searchValue, @@<protocol>)`, and `string-search-value.ts` (#4016)
answered it **statically**, with
`ctx.oracle.wellKnownSymbolMemberOf(v, protocol) === false`. That proof is
exact for a primitive and for a builtin RegExp, and **unsound for an ordinary
object** — the idiom the step exists for installs the method *after* the object
is created (`var regexp = {}; regexp[Symbol.search] = f`), where no declared
type can see it. So the old lowering took the step-3 lane instead and ran
`RegExpCreate(ToString(regexp))`, i.e. the pattern `"[object Object]"`. The
four `cstm-*-invocation` rows therefore reported
`TypeError: Unsupported dynamic regular expression pattern`, **which reads like
a missing engine feature and was actually the compiler stringifying a value it
was required to call.** That is the reason this bucket was worth taking before
the much larger `exec`-protocol buckets: it was mis-signposted, not merely
unimplemented.

Two things the implementation had to get right, both measured rather than
assumed:

1. **The gate must admit `{kind:"class"}`, not just `{kind:"object"}.** test262
   rows are **JS**, so TypeScript's expando inference gives `var regexp = {}` an
   anonymous type whose symbol carries the VARIABLE's name — and `factOfType`
   reports `{kind:"class", name:"regexp"}`. The first cut gated on `object`
   alone: it compiled and fired under a hand-written `.ts` probe and **never
   fired under the runner**, so the focused 17-row slice came back
   byte-identical. The `.ts` probe alone would have shipped a no-op.
2. **The probe must not leak its `externref` carrier into a typed consumer.**
   The branch's result type is externref (the protocol method may return
   anything), while the fall-through arm produces the native carrier —
   `const parts: string[] = "a,b".split(sep)` is the shape that catches a leak,
   because it compiles green and fails at `WebAssembly.instantiate`. It is
   pinned as a control. (A first attempt at that control used a dynamic
   symbol-keyed assignment and hit a **pre-existing, unrelated** invalid-module
   bug — `local.set expected (ref null 6), found (ref null 46)` — reproduced
   byte-identically on the base commit by a one-`cp` revert, so it is not
   attributable here and the control was rewritten.)

Both arms are re-emitted from the same AST, so the gate additionally requires
the receiver, search value and extra argument to be **re-evaluable without
observable effect** (identifier / `this` / literal). A computed operand keeps
the previous behaviour rather than risking a doubled side effect.

#### Neighbourhood regression control — zero pass → non-pass

The blast radius is provably bounded: the hook can only fire on a
`String.prototype.{match,replace,search,split}` call. The full 2,280-row
`built-ins/RegExp/**` + `annexB/built-ins/RegExp/**` +
`built-ins/String/prototype/{match,matchAll,replace,replaceAll,search,split}/**`
sweep was therefore filtered to the **512 rows whose source contains such a
call or a `[Symbol.<protocol>]` reference** — sound because none of the 2,280
rows includes one of the three harness files that call those methods
(`iteratorZipUtils`, `temporalHelpers`, `testIntl`), checked rather than
assumed. Run in 128-row chunks, one fresh process each: the single 2,280-row
in-process run **OOMs** at ~8 GB after ~27 min, which is a property of the
runner, not a finding.

| lane | rows | before | after | flips |
| --- | ---: | ---: | ---: | --- |
| standalone (`.tmp/6651/nbr-{before,after}.tsv`) | 512 | 161 non-pass | **154 non-pass** | the 7 target rows only; **0 regressions** |
| host — compiled-binary sha256 of 7 representative programs | 7 | — | — | **all 7 byte-identical** (`.tmp/6651/hostsha-{before,after}.txt`) |
| standalone — same 7 programs | 7 | — | — | **6 byte-identical**; only `split-object` differs, which is the admitted shape |

The host lane is byte-identical by construction too — `noJsHost(ctx)` is the
probe's first condition — but the sha comparison is the evidence, not the
argument.

Also green: `npm run -s typecheck`; the five ratchet gates
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); `scripts/equivalence-gate.mjs`
(22 failing / 1720 passing, all 22 in the committed baseline — no new
regressions); and the new pin suite
`tests/issue-6651-string-symbol-protocol.test.ts`, 9/9.

#### Residual sub-buckets (140 rows), with signatures

| rows | signature | owner / what it needs |
| ---: | --- | --- |
| 44 | `Expected a Test262Error … no exception` / `… but got a TypeError` | the observable **`RegExpExec`** substrate — `Get(R,"exec")`, call a callable override, propagate its abrupt completion. **#5198 Slice B** (draft PR #5393). Do not start here. |
| 18 | `Method called on incompatible receiver (RegExp brand check failed)` | `RegExp.prototype[@@x].call(plainObjWithExec, …)` is spec-legal; widening `recoverRegExpStructFromExternref` only helps once the row can then run a user `exec`, so it is **downstream of Slice B**, not independent. |
| 8 | `Expected a TypeError … no exception` | same family, TypeError-shaped assertions |
| 7 | `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | **environment, not the compiler** — the 7 `*/cross-realm.js` + `proto-from-ctor-realm.js` rows need a built QuickJS provider in this container. Unmeasurable here; #5198 records them failing on host too. |
| 7 | CE `standalone target emitted host imports: env::Object_set_constructor` | 6 of 7 are `Symbol.split/species-ctor*` — `SpeciesConstructor` needs a `constructor` write on a plain object. #5198 Slice C4/E. |
| 5 | `flags` coercion (`built-ins/RegExp/prototype/flags/coercion-*`) | the **generic** `flags` getter: accept any Object, ordered `ToBoolean(Get(R, …))`. #5198 **Slice F**; fails on host too. |
| 4 | `Unsupported dynamic regular expression pattern` | the runtime pattern compiler. 2 are the `cstm-*-is-null` rows, which reach the ToString lane correctly now and then need `\d` from `__regex_compile_dynamic_simple`. |
| 3 | CE `… does not support String.prototype.match with dynamic RegExp flags` | `@@match` must read flags at RUNTIME. #5198 Slice C2. |
| 3 | `Expected true but got false` at `assert.notSameValue(originalSearch, undefined)` | `invoke-builtin-{search,match}*` — needs `RegExp.prototype[@@x]` to be a **reified, replaceable** method object, so the step-3 RegExp lane dispatches through it. Strictly harder than this slice. |
| 1 | CE, `String.prototype.replace/cstm-replace-get-err.js` | reachable and **deliberately left**: `"".replace(poisoned)` has ONE argument, and `tryCompileStandaloneStringValueReplace` requires exactly two, so the fall-through arm cannot lower and the `#1474` refusal is still reported. The fix is to admit an absent `replaceValue` as the literal `"undefined"` (§22.1.3.19 step 3) — a separate behaviour change for one row, which would have invalidated this slice's measured after-state. |
| 40 | assorted `Expected SameValue(…)` | per-method result-shape and cursor residuals across `@@replace` (30 rows), `@@split` (30), `@@match` (23), `@@search` (13) — #5198 Slices C1–C4. |

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

### 2026-09-21 — Cluster F (Proxy / Reflect, standalone), slice F1: the discarded booleans

- **Branch** `issue-6651-cluster-F-proxy-reflect`, based on
  `claude/es2015-test262-plan-54tooh` @ `a68e20f7`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a883e5b95a1723f67`.
- **Manifest** `plan/agent-context/6651/F-proxy-reflect.txt`, 89 rows, sha256
  `3edd7052b503ee48f0022a8bc2f5c041a116228d19ef65d31bf2aeb54cf80dd7`.

| standalone, `--isolate`, 89 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/F-before.log`) | **0** | 84 | 5 |
| after (`.tmp/6651/F-after.log`) | **7** | 77 | 5 |

**+7 rows pass; every other row keeps its exact status** (the two logs were
joined per path, not compared by count). No compile_error became a fail and no
fail became a compile_error.

**23 of the 89 rows are environment-unmeasurable in this container** —
`*-realm*` / `cross-realm`, which need `$262.createRealm` and the QuickJS eval
provider (`JS2WASM_EVAL_ENGINE=quickjs … provider is not built`). They were
measured, not assumed, and they fail identically before and after, so the delta
is comparable; their absolute cause mix is not CI-comparable. The honest
denominator for this slice is therefore **66 rows, of which 7 now pass.**

#### Triage method — the whole 66-row measurable set was probed on the HOST lane first

Cluster A's cheapest-triage rule, applied to every measurable row rather than 8
per bucket (same order of cost, complete answer): **32 of 66 PASS on the default
target**, so those are standalone-only lowering gaps and are reachable; 14 fail
on host too and need work in both lanes; 16 answer `error` on host (the row
kills its own child process). Every row this slice converted is in the host-pass
set. Log: `.tmp/6651/F-host-before.tsv`.

#### What changed — three discarded values and one fold that outranked a write

Each of the first three is a value the runtime had **already computed correctly**
and the call site then threw away. None is a new mechanism; two of them overturn
a comment that had gone stale, which is why they were mis-signposted as "not
implemented" rather than "not read".

1. **`Reflect.setPrototypeOf` always answered `true`** (`call-namespace-static.ts`).
   The arm's own "KNOWN LIMITATION" said `__object_setPrototypeOf` has no failure
   channel. **Stale:** #5148 cluster 2b built one — `__object_setPrototypeOf_status`,
   a pure §10.1.2.1 predicate that performs no write and answers a permissive 1
   for every receiver the writer does not own. The answer is now the conjunction
   of that ordinary bit with `__is_truthy(writer result)`, which for a `$Proxy`
   receiver IS the §10.5.2 trap's boolean (the writer's proxy front guard returns
   it instead of the obj) and for an ordinary receiver is the always-truthy obj.
   Reading a booleanish trap result through `__is_truthy` is the same rule the
   neighbouring `Reflect.defineProperty` arm already applies.
2. **`Reflect.preventExtensions` did `drop; i32.const 1`** over a result whose
   `$Proxy` front guard had already computed the §10.5.4 trap's `false`.
3. **`Reflect.ownKeys` dropped SYMBOL keys.** The arm's comment claimed "the
   native runtime does not retain symbol-keyed properties yet". **Also stale:**
   it retains them, and `Object.getOwnPropertySymbols` already read them back
   with correct identity on base (measured: `ownKeys(o).length === 1` while
   `getOwnPropertySymbols(o).length === 1` on the same object). The two lists
   were simply never joined — §10.1.11.1 step 4. A `$Proxy` receiver is
   **excluded**, and that exclusion is load-bearing: `__getOwnPropertyNames`'s
   proxy front guard returns the `ownKeys` TRAP's own array, which the spec
   requires be returned as-is and which the caller still holds; appending to it
   would both mutate a user array and report keys the trap did not.
4. **`Object.getPrototypeOf` folded from the DECLARATION even when the module
   writes that binding's prototype** (`object-get-prototype-of.ts`). Measured on
   base: `var o = {}; Reflect.setPrototypeOf(o, proto)` made the inherited read
   `o.tag` resolve through `proto` — the write was already correct — while
   `Object.getPrototypeOf(o)` still answered `%Object.prototype%`. One object,
   one link, two answers. Same unsoundness #5270 step 2 recognised for
   `{ __proto__: v }`; the only difference is that the write is a statement.

Two things the fix for (4) had to get right, both measured rather than assumed:

- **It must ROUTE, not decline.** A decline in the two literal folds falls
  through to the CLASS arm, which re-folds to the compile-time prototype
  singleton — measured: the decline alone moved nothing for the JS shape. The
  check therefore claims the expression ahead of every fold and emits the
  generic `__getPrototypeOf`.
- **`ctx.dynamicProtoLiteralNodes` is NOT the fact this reader needs.** That set
  is populated by `markReceiver`, whose first branch is
  `ctx.oracle.typeFactOf(recv).kind === "class"` — and test262 rows are **JS**,
  where expando inference gives `var o = {}` an anonymous type whose symbol
  carries the VARIABLE's name, so the fact reads `{kind:"class", name:"o"}` and
  the function returns before recording the literal. (Cluster B hit the same
  trap from the other side.) A small per-`SourceFile` scan of
  `setPrototypeOf` / `__proto__ =` receiver NAMES supplies it instead, narrowed
  to bindings whose declaration is a plain object literal — the one carrier
  whose runtime answer is verified equivalent to the fold it replaces (an unset
  `$proto` reads back as `%Object.prototype%`, checked with a probe because the
  whole "a REFUSED set leaves Object.prototype" family depends on it).

#### The regression the sweep caught, and no probe did

The first cut regressed `Reflect/setPrototypeOf/return-true-if-proto-is-current.js`
pass → fail. §10.1.2.1 step 2 (SameValue → `true`) runs BEFORE the step-3
extensibility refusal, and the status native compares the two ENCODED `$proto`
references — an ordinary object's `%Object.prototype%` terminal is encoded as a
NULL field. So `Reflect.setPrototypeOf(o, Object.prototype)` on a non-extensible
ordinary `o` looked like "a different prototype" and took the refusal. The fix
asks the reader that already models the implicit terminal (`__getPrototypeOf`),
and **only when the status bit is 0** — so a live `$Proxy` never sees an extra
`getPrototypeOf` trap call, because the status native answers a permissive 1 for
exactly the set of receivers that contains proxies. Twelve probes were green at
the moment that regression existed; only the before/after row run saw it.

#### Neighbourhood regression control — zero pass → non-pass

Run in 128-row chunks, one fresh process per chunk (the runner OOMs on
>~500-row in-process sweeps — a property of the runner, not a finding). Base
measured with the file-copy A/B revert, branch measured with the exact sources
committed here (verified by re-deriving the same compiled shas).

| lane | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| `built-ins/Proxy/**` + `built-ins/Reflect/**`, standalone (`.tmp/6651/nb-pr-{before,after}.tsv`) | 464 | 355 / 104 / 5 | **362** / 97 / 5 | +7, **0 lost** |
| `built-ins/Object/{getPrototypeOf,setPrototypeOf,getOwnPropertyNames,getOwnPropertySymbols,preventExtensions,isExtensible,keys}/**`, standalone (`.tmp/6651/nb-obj-{before,after}.tsv`) | 245 | 220 / 24 / 1 | 220 / 24 / 1 | **none** |

**Host (gc) control is a byte-identity proof.** Both edits are lane-gated (the
Reflect arm on `targetProfile.semanticProviders === "native-first"`, the
getPrototypeOf route on `ctx.standalone || ctx.wasi`), so the honest control is
that host output cannot move: 8 representative programs — a Proxy/Reflect-free
control, the three changed shapes, a `delete`-through-proxy module, a
proxy-in-the-prototype-chain module and two integrity modules — are
**8/8 byte-identical on gc** before vs after (`.tmp/6651/sha-{before,after}.txt`).
On standalone the same corpus shows exactly the intended delta: the 5 programs
that exercise a changed arm move, the other 3 are byte-identical.

Also green, all run bare: `npm run -s typecheck`; the five ratchet gates
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); `node scripts/equivalence-gate.mjs`
(22 failing / 1720 passing, all 22 in the committed baseline — no new
regressions); `biome lint --diagnostic-level=error`; and the new pin file
`tests/issue-6651-cluster-f-proxy-reflect.test.ts`, 9/9 — **5 of the 9 verified
RED on the base commit** and 4 are guards that are green on both sides
(including the two negative directions: a legal `setPrototypeOf` still answers
`true`, and an untouched literal binding keeps the `%Object.prototype%` fold).

#### Residual sub-buckets (82 rows), with signatures

| rows | status | sub-bucket | what it needs |
| ---: | --- | --- | --- |
| 23 | fail | `*-realm*` / `cross-realm` | **environment, not the compiler** — `$262.createRealm` + a built QuickJS provider. Unmeasurable in this container. |
| 24 | fail | `*-target-is-proxy.js` (every trap) | nested-proxy forwarding over EXOTIC targets — an array's `length`, `new String("str")`'s non-configurable `length`, a RegExp's `lastIndex`, a function's `prototype`. Each row asserts across several such targets, so the rows/fix ratio is poor; 6 of the 24 also fail on host. |
| 7 | fail | `has/call-in-prototype*`, `has/call-object-create`, `set/call-parameters-prototype*`, `defineProperty/call-parameters` — "handler is the trap context" | **a proxy reached through the PROTOTYPE CHAIN never runs its trap.** Probed directly: `Object.create(proxy)` resolves the proxy to its TARGET as the prototype, so a trapless proxy gives correct ordinary answers and a trapped one is invisible (`Object.getPrototypeOf(heir) === p` is false; the `get`/`set`/`has` traps run ZERO times). The trap `this` IS the handler on the direct path — that half is correct. The blocker is architectural: `$Object.$proto` is typed `ref null $Object` and `$Proxy` is not a subtype, so the chain cannot hold a proxy at all. |
| 4 | fail | `Proxy/construct/{call-parameters-new-target,trap-is-null,trap-is-undefined,trap-is-undefined-no-property}` | `Reflect.construct(P, args, NT)` on a proxy target passes **the proxy itself** as NewTarget (`native-construct.ts`: "Ordinary `new proxy(...)` uses the proxy itself as NewTarget"), and the trap-absent forward re-enters the driver, which passes the INNER proxy. `__proxy_construct_dispatch` already takes newTarget as its third parameter, so the dispatch is right and the two call sites are wrong. **Deliberately not taken here:** #3371 is in-progress in another lane and owns `Reflect.construct` + NewTarget end-to-end (`reflect-construct-newtarget.ts`); threading a second NewTarget channel through the same arm would duplicate it. All 4 pass on host. |
| 3 | CE | `Proxy/construct/*-target-is-proxy` | the same NewTarget channel plus `class MyArray extends Array` — strictly harder than the 4 above. |
| 4 | fail | `deleteProperty` family + `Reflect/deleteProperty/delete-properties` | `delete` does not actually remove the entry: probed on base, `Reflect.deleteProperty(o,'prop')` returns `true` while `o.hasOwnProperty('prop')` stays `true` and `o.prop` is still 42. A tombstone/closed-struct gap (#4745), not a proxy gap. |
| 4 | fail | `getOwnPropertyDescriptor/*` — "X should be an own property" | the gOPD trap-absent forward over exotic targets; 3 of 4 fail on host too. |
| 1 | fail | `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js` | **localised, not mysterious:** `Object.preventExtensions` records non-extensibility in the integrity BAG for a carrier that is not an `$Object`, and `__object_setPrototypeOf_status` returns a permissive 1 for exactly those carriers, so the refusal is invisible. The TS shape (`const o: any = {}`) already answers `false`; only the JS `var o = {}` carrier does not. Fixing it means teaching the status native to consult `__object_isExtensible` — which would be a no-op, since the same non-`$Object` test makes it return 1 first. The real fix is carrier promotion, in the integrity subsystem. |
| 2 | fail | `Reflect/ownKeys/{order-after-define-property,return-on-corresponding-order-large-index}` | **both moved to a narrower failure in this slice.** The symbol half of `order-after-define-property` now passes; it fails on a `new String("")` wrapper, whose exotic `length` is pushed at the END of `__getOwnPropertyNames` where §10.1.11.1 wants it in creation order (before later string keys). The large-index row needs `4294967294` classified as an array index and `12345678900` as a string key. |
| 10 | fail/CE | singletons | `Reflect.apply(fn, null, null)` must throw (CreateListFromArrayLike), `Reflect.construct(<non-ctor>, [])` must throw (IsConstructor on the TARGET — the newTarget check exists, the target check does not), `Reflect.hasOwnProperty` CE, `Proxy/getPrototypeOf/not-extensible-same-proto` invariant, `Proxy/enumerate`, `Proxy/set/trap-is-null-receiver`, and the `Proxy/apply/*-target-is-proxy` pair. |

**Not started in this slice, and why:** the two largest measurable buckets are
the 24 nested-proxy-over-exotic-target rows (many mechanisms per row) and the
7 prototype-chain rows (blocked on `$Object.$proto` being unable to hold a
`$Proxy` — a type-graph change, not a call-site one). The 4+3 `construct` rows
are a single, clean mechanism but sit inside #3371's active surface.

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

### 2026-09-21 — Cluster C (class / object-literal / `super`, standalone), slice C2

- **Branch** `worktree-agent-a27d2e622e3791fde`, based on
  `claude/es2015-test262-plan-54tooh` @ `252beab1` (origin/main + plan +
  clusters A, B, D, H and C1). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a27d2e622e3791fde`.
- **Manifest** `plan/agent-context/6651/C-class-object-super.txt`, 177 rows,
  sha256 `785dd45d78a609ecefc58377433fd144a142423557001a9b513cf1ae1492ad8d`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/C2-before.log`) | 0 | 173 | 4 |
| after C2-a (`.tmp/6651/C2-after1.log`) | **12** | 161 | 4 |

**+12 rows pass, 0 lost.** Both logs account for all 177 rows (12 + 161 + 4),
so neither was truncated — worth stating because another lane ran a blanket
`pkill -f run-test262-paths` during this slice; every log here was re-validated
for completeness afterwards rather than assumed intact.

#### C2-a — a top-level `C.prototype.<name> = value` was SILENTLY DROPPED

The module-init keep analysis in `declarations.ts` retains a top-level
`C.<name> = …` STATIC write on a compiled class, and the host lane retains
`F.prototype.m = …` for a top-level FUNCTION (#4618). Neither arm matches a
CLASS's prototype chain, so in standalone the statement fell past every keep
and compiled to **nothing**. Established by instrumentation, not inference:
`compileAssignment` is never entered for it, while the identical statement
inside a function body is — and works.

Measured on this branch's base (`.tmp/w6651C/m7.ts`, standalone):

```
class Plain {}
const holder = {}; holder.k = "H";     // lands
Plain.prototype.tagy = "Y";            // DROPPED
let ran = 0; ran = 5;                  // lands
new Plain()["tag"+"y"]                 // undefined    node "Y"
Plain.prototype["tag"+"y"]             // undefined    node "Y"
```

Two other statements in the same module landing is what rules out "module init
did not run". It is not Error-specific — the probe uses a plain class — and it
is not a corner: the honest test262 harness compiles every test body at MODULE
scope, where `A.prototype.fromA = 'a'` is one of the suite's commonest idioms.

Keeping the statement is necessary but **not sufficient**, and the second half
is the part that would have shipped a trap:

1. **The keep** (`class-proto-toplevel-write.ts` →
   `isTopLevelClassPrototypeWrite`, called from `collectDeclarations`).
   Standalone-gated; the root must resolve to a genuine class DECLARATION, the
   same evidence the static-write keep beside it demands.
2. **The decline** (same module → `targetReceiverIsPrototypeAccess`, called
   from `compilePropertyAssignment`). The checker types `C.prototype` as the
   INSTANCE type `C`, so for an externref-backed subclass the own-field-write
   arm claimed a write aimed at the PROTOTYPE object — which is never an
   `$Error_struct`. With the keep alone, `class Err extends TypeError {}` +
   `Err.prototype.tagx = "T"` turned from a silent no-op into **`illegal cast`,
   uncatchably, taking the module with it**. `error-instance-field-write.ts`
   already carries the identical guard for the identical reason; it was
   unreachable only because this statement was being dropped before it could be
   compiled.
3. **The absent-`message` read** (`error-message-proto-read.ts`, called from
   the statically-typed Error arm in `property-access-dispatch.ts`). §20.5.1.1
   step 3 makes `message` the one `$Error_struct` field that can legitimately be
   absent, and the arm read field 1 unconditionally, answered JS `null` and
   stopped the walk. Measured (`.tmp/w6651C/m10.ts`): `err2.message` answers
   `undefined` through a statically-typed `Err` receiver and
   `"custom-type-error"` through `(err2 as { message }).message` — the same
   program, the same value, two answers, selected by the static type. That is
   also why the C1 slice concluded this arm was unreachable: the C1 probe
   carried the cast.

#### Rows gained (12 on the manifest, 15 on the 960-row control)

| rows | family |
| ---: | --- |
| 7 | `class/subclass/builtin-objects/{NativeError/*-message, Error/message-property-assignment}.js` — the C1 residual, now closed |
| 5 | `expressions/super/prop-{dot,expr}-cls-val{,-from-arrow}.js` + `prop-expr-cls-val-from-eval.js` |
| +3 (control only) | `class/scope-setter-paramsbody-var-{close,open}.js`, `class/super/in-constructor.js` |

The five `super/prop-*-cls-val*` rows are the family #5350 recorded as blocked
by "a block-scoped class method's write to a captured `var`". They are not:
they were blocked by this dropped top-level statement, and the `var`-capture
defect (C1's finding 1) is not involved in the harness shape at all. The
coordinator's item (2) — collecting `var` in `collectBlockScopedDeclNames` — is
therefore **not needed for this family**, which is the re-measurement it asked
for; see the C2-b note below.

#### Controls — zero pass → non-pass

| set | rows | before | after |
| --- | ---: | --- | --- |
| manifest, `--isolate` | 177 | 0 / 173 / 4 | **12** / 161 / 4 |
| 960-row combined control, in-process, 10 chunks | 960 | 658 pass / 280 fail / 21 CE / 1 skip | **673** / 265 / 21 / 1 |

The 960-row control is every test262 file containing a top-level
`<ident>.prototype.<name> =` write (363 across `language/**` and
`built-ins/**` — i.e. the idiom this change makes execute), plus all 187
`built-ins/{Error,NativeErrors}` rows and the 429-row
`class/subclass` + `expressions/super` + `statements/try` + `AggregateError`
set. Per-row set diff: **15 gained, 0 lost, no other verdict changes**. Every
chunk was verified to account for exactly its input rows before the diff was
taken. Logs `.tmp/6651/ctl2-{before,after}-0*.log`, list `.tmp/6651/ctl2.txt`.

**Host (gc) control is a byte-identity proof.** The keep is `ctx.standalone`-
gated and the read arm is `native-first`-gated, so host output cannot move:
**11/11 gc binaries sha256-identical**, and on standalone only the 2 corpus
programs that actually contain the construct change
(`.tmp/6651/bytes2-{before,after}.txt`).

Pin `tests/issue-6651-class-prototype-toplevel-write.test.ts` — 4 cases, **3
verified RED on the base** (0→7, 0→15, 1→3), the fourth a guard that the
in-function form is untouched. Case 2 is specifically the one that traps
("illegal cast") if the keep lands without the decline.

Gates, run bare: loc-budget and func-budget PASS with the grants added to this
file's frontmatter (`declarations.ts` +10 / `collectDeclarations` +9,
`assignment.ts` +5 / `compilePropertyAssignment` +4,
`property-access-dispatch.ts` +9 — every mechanism moved into the two new leaf
modules; inlined, the same change was +114); coercion-sites, oracle-ratchet,
dead-exports, compiler-boundaries `--mode inventory`, typecheck, prettier and
`biome lint --diagnostic-level=error` all 0. `node scripts/equivalence-gate.mjs`:
22 failing / 1720 passing, all 22 already in the baseline.

`scripts/compiler-boundaries.json` also classifies
`src/codegen/string-symbol-protocol.ts` — cluster B's new module, which arrived
on the merged base unclassified and fails the inventory gate for every lane
that follows it.

#### C2-b — a block-scoped class capturing a function-scoped `var` (zero rows, shipped anyway)

`collectBlockScopedDeclNames` collected only `let`/`const`, on the premise that
"a `var` is function-scoped and therefore already a module global" — true at
MODULE scope, and this function is only ever called from INSIDE a function
body, which is where it is false. Base (`.tmp/w6651C/q31.ts`, standalone):

```
function test() { var n = 0;
  if (1) { class C { m() { n = 5; } } new C().m(); }
  return n; }                              // base 0, node 5
```

`$C_m` declares `(local $n f64)` and stores into it. The same class at
function-body level answers 5, a `let` in the same block already worked, and a
function expression / object-literal method in the same block already worked —
the class method was the only one of three closure kinds that was broken. The
collector now takes `var` too, moved to the leaf module
`src/codegen/scope-local-decl-names.ts`.

**This is the coordinator's item (2), and the re-measurement it asked for says
the thing it was expected to unblock was already fixed by C2-a.** The
`super/prop-*-cls-val` family passes because the top-level
`A.prototype.fromA = 'a'` statement now runs, not because of any `var` capture:
with C2-b applied the manifest is **byte-for-byte the same verdicts as C2-a**
(12 pass / 161 fail / 4 CE, identical per-row), and #5350's attribution of that
family to a block-scoped `var` capture does not survive contact with the honest
harness shape, where the class and the `var` are both at module scope.

It ships regardless because it is a real wrong answer with no measured cost,
and because #2818's stated reason for excluding `var` — "including `var`
needlessly perturbed the order-sensitive async-generator lowering" — was
re-tested rather than taken on trust:

| control | rows | result |
| --- | ---: | --- |
| cluster-C manifest, `--isolate` | 177 | identical to C2-a (12 / 161 / 4) |
| 960-row combined control, in-process | 960 | **identical non-pass set**, 673 / 265 / 21 / 1 |
| generator sample (`expressions/generators`, `statements/generators`, `expressions/async-generator`, every 4th row) | 295 | **identical non-pass set**, 248 passing |

Logs `.tmp/6651/C2-after2.log`, `.tmp/6651/ctl2b-*.log`,
`.tmp/6651/ctl3-{before,after}-*.log`. Gates all 0 (the collector moving to its
own module is what kept `compileDeclarations` under its ceiling); equivalence
22 failing / 1720 passing, all in baseline. Pin
`tests/issue-6651-block-class-var-capture.test.ts` — 3 cases, 2 RED on the base
(0→5, 5→7), 1 guard.

#### C2-c — the f64-typed parameter slot (18 rows): NOT landed, diagnosed exactly

The coordinator's item (3) — the 10 `dflt-params-arg-val-not-undefined.js` rows
(`Expected SameValue(«0», «false»)`) and the 8
`dstr/…-dflt-obj-ptrn-prop-ary.js` rows (`«NaN»` vs `«undefined»`) — is one
defect: in a JAVASCRIPT source file a parameter's only type evidence is its
default initializer, so `method(aFalse = falseCount += 1)` is inferred `number`
and `C.prototype.method(false)` arrives as `0`. In a `.ts` file that inference
is a genuine declaration and the scalar slot is right; in a `.js` file there
are no parameter types at all, so it is a guess about one call.

**The slot half is a one-line widening and it works.** `isUndefinedDefaultOnlyParam`
(`src/checker/type-mapper.ts`) already states exactly this argument for the
`= undefined` case — *"an ABSENCE of information, not a scalar contract"* — and
its own doc requires every parameter-lowering site to apply it identically, so
all four call sites (class-bodies ×2, declarations, closures) pick a widening
up for free. Adding `|| <the parameter is in a .js/.mjs/.cjs/.jsx file>` to it
produces the right signature, WAT-verified on a JS compile:

```
(func $C_method (param (ref null 60) externref) (result (ref null 6)))   ; was  … f64 …
```

**It is NOT sufficient, and the reason is worth the next owner's time.** The
value is not lost at the boundary — it is lost on first READ. The body prologue
is correct (`__extern_is_undefined(a)` gates the default), and the very next
instructions are `local.get 1; call $__unbox_number`: every USE of the
parameter still coerces through the checker-inferred `number`, so
`typeof a` answers `"number"` for an argument that arrived as a boxed boolean.
Widening the wasm slot without widening the parameter's TYPE in the function's
own type map just moves the coercion one instruction later.

So this is a checker/oracle change — the parameter must be typed `any` for such
a declaration — not a codegen slot change, and it needs its own control: it
would move the slot of **every defaulted parameter in every JS input**, which
is all of test262 and every npm package. The attempted patch is kept at
`.tmp/w6651C/attempt-type-mapper.ts` rather than committed; nothing of it is in
the branch.

### 2026-09-21 — Cluster I (language misc, standalone), triage pass (no source slice)

- **Branch** `worktree-agent-adcaab82a3507f049`, base
  `claude/es2015-test262-plan-54tooh` @ `b104f96e41`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-adcaab82a3507f049`.
- **Manifest** `plan/agent-context/6651/I-language-misc.txt`, 114 rows,
  sha256 `f94fe9f129c0bcc5e5e52ce798cbeedfa6cae99f7506f5547af54717a71cdd68`.
- **This entry is a TRIAGE deliverable. No `src/` change is in it** — every
  bucket below was measured, three root causes were proven with probes, and
  none of the buckets is the small slice the dispatch assumed. Nothing is
  half-applied: the tree this was committed from is source-clean.

| standalone, `--isolate`, eval engine **quickjs** | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/I-before.log`, cleaned copy `I-before-clean.log`) | **0** | 103 | 11 |

#### Read this before measuring cluster I: the engine changes 40 of the 114 rows

The first before-run (`.tmp/6651/I-before-noqjs.log`) reported **40 rows** as
`Error: JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built`.
That is not a verdict — it is the runner refusing to measure. The provider is
**not** present in a fresh worktree and the selector deliberately never builds
one (a silent degrade to the interpreter would invalidate the measurement), so
a cluster-I sweep run without it silently converts a third of the manifest into
noise, including **every** module-namespace row.

Build it once per worktree — the artifact is ~50 s (clang-18 + network), the
adapter ~5 s, and the adapter key folds in the compiler source hash, so it must
be rebuilt after a `src/` edit:

```bash
node scripts/build-quickjs-eval-provider.mjs            # builds the artifact, then
node --import tsx scripts/build-quickjs-eval-provider.mjs   # builds the adapter
```

Both logs in this entry are from the **quickjs** engine. With it present,
**zero** rows are environment-unmeasurable.

#### Triage table — all 114 rows, measured, bucketed by signature

`fix?` is the verdict asked for: **(a)** fixable in standalone · **(b)**
wont-fix-with-reason candidate (needs a second realm, or direct `eval` of
dynamic text that the target has no host for) · **(c)** environment-unmeasurable.
"size" is the honest horizon of the *whole* bucket, not of one row.

| # | bucket | rows | fail/CE | fix? | size | what it actually needs |
| --- | --- | ---: | --- | --- | --- | --- |
| B3 | `with` + `@@unscopables` | 15 | 13 / 2 | a | XL | a **dynamic** `with` environment record. 5 rows put a `Proxy` in the `with` head; 6 need `@@unscopables` on an arbitrary object; 2 are the #1387 CE ("requires a proven closed object-literal shape"). The closed-shape model cannot answer any of them. |
| B15 | singletons | 14 | 14 / 0 | a | — | 14 unrelated one-row defects; see `.tmp/6651/I-buckets.txt` for the list. |
| B1 | `module-code/namespace/internals` | 12 | 12 / 0 | a | XL | **root cause proven, see below** — two independent blockers, runner *and* compiler. |
| B5 | direct `eval` — spread args, caller scope, class-in-eval | 10 | 10 / 0 | a (4) / b (6) | L | `eval-spread*` (4) and `statementList/eval-class-*` (4) are real runtime-eval-lane defects (wrong arg vector; wrong `[[Prototype]]` identity for an `Array`/`RegExp` literal built inside the eval). `eval-code/direct/{new.target-fn,super-prop-method}` need the *caller's* `new.target`/`[[HomeObject]]` inside eval'd text — **wont-fix candidates** (#1066). |
| B11 | parameter defaults / destructuring params | 9 | 9 / 0 | a | M | three tests × three function forms. `params-dflt-ref-arguments` needs `arguments` bound in the **parameter** scope (reads null today); `dstr/ary-ptrn-elem-ary-rest-init` reads null; `dflt-params-arg-val-not-undefined` returns `0` for an explicit `false` argument. |
| B10 | global-object declaration descriptors | 7 | 7 / 0 | a | L | `var`/`function`/`let` at global code must create global-object properties with the spec's `configurable:false` and collide per §9.1.1.4. Two rows escape a bare `WebAssembly.Exception`. |
| B9 | arrow `this` / `new.target` / `super` | 7 | 7 / 0 | a | L | lexical capture of the *enclosing function's* `new.target` and `[[HomeObject]]`. One row (`lexical-this.js`) is a null-pointer trap in `__module_init`, i.e. a miscompile, not a missing feature. |
| B7 | tagged template | 7 | 6 / 1 | a | L | the site object is not frozen, is not passed as argument 0 in the member/call-expression forms, `this` binding is wrong for `obj.fn\`\``, `new tag\`\`` is not constructible, and one row still leaks `env::__tagged_template`. |
| B4 | cross-realm | 6 | 6 / 0 | **b** | — | every row calls `$262.createRealm()`. A standalone binary is one realm by construction; there is no host to make a second one. **The clearest wont-fix-with-reason group in the cluster.** |
| B8 | `instanceof` | 6 | 6 / 0 | a | M | 3 × `@@hasInstance` (**root cause proven, see below**), 3 × an accessor `Function.prototype.prototype` that `Get(C,"prototype")` must call observably. |
| B12 | `arguments` object | 5 | 5 / 0 | a | M | own `@@iterator` (2 rows), and `arguments`-named-`arguments` shadowing, which currently traps with `illegal cast` (2) or reports `typeof "function"` (1). |
| B2 | `module-code` generator exports | 5 | 0 / 5 | a | — | all five are `standalone target emitted host imports: env::g` — a **generator** leak. Same family as cluster A; they landed in I only because the partition rule keyed on the path, not the error. Hand to A. |
| B14 | annexB | 4 | 1 / 3 | a | S | one `\P{…}` RegExp CE (#1539 Phase 2d), one labelled-function-declaration SyntaxError, one block-scope redeclaration, one `substr` coercion order. |
| B13 | TDZ in closures / block scope | 4 | 4 / 0 | a | M | a closure that reads a `let`/`const` before its initializer must throw `ReferenceError`; we return the value. |
| B6 | proper tail calls | 3 | 3 / 0 | a | M | `tco-non-eval-*`; one now blows the stack (`RangeError: Maximum call stack size exceeded`), which is the honest signature — the tail position is not being taken. |
| | **total** | **114** | 103 / 11 | | | |

Counts: **(a) fixable 102 · (b) wont-fix candidates 12** (6 cross-realm + 6
direct-eval-of-dynamic-text) · **(c) environment-unmeasurable 0** once the
quickjs provider is built.

#### Root cause 1 — the module-namespace family is blocked TWICE, not once

The 12 rows do not fail on the §10.4.6 exotic-object MOP. They fail because
`ns` is **null**: `Reflect.defineProperty called on non-object`,
`stringKeys.length === 0`, `Cannot access property on null or undefined`.

- **Blocker A (runner).** These tests SELF-import
  (`import * as ns from './own-property-keys-sort.js'`). `wrapTest` hoists only
  `_FIXTURE` specifiers to module top level — deliberately, per the #2932 note
  in `tests/test262-runner.ts`: the test compiles under the virtual key
  `./test.ts`, so a hoisted self-import cannot resolve, and hoisting it anyway
  flipped 4 of these rows to "ns is not defined" in PR #2471's merge_group. So
  the import stays nested inside `export function test()`, where it is
  leniently ignored and the binding reads null.
- **Blocker B (compiler).** Even given a top-level self-import, the compiler
  does not materialize the namespace. Probed directly
  (`.tmp/6651/selfimport2.mts`, source-clean tree, `--target standalone`, module
  compiled under `fileName: "test.ts"` with `import * as ns from './test.ts'`):

  | probe body | result |
  | --- | --- |
  | `typeof ns === 'object'` | **0** (it is not an object) |
  | `ns !== null` | **throws a bare `WebAssembly.Exception`** |
  | `ns.localA` | throws |
  | `Object.getOwnPropertyNames(ns)` | throws |
  | `Object.keys(ns)` | throws |

  `module-namespace-value.ts` materializes a namespace for an import of
  *another* module in the same compilation; the self-import case is not
  modelled and reaches a trap rather than a decline.

So the slice is: rewrite the self-import specifier to the compilation's own key
and hoist it (runner), teach `module-namespace-value.ts` the self case
(compiler), and only *then* do the MOP details (live-binding TDZ
`ReferenceError`, `[[Set]]`/`[[Delete]]`/`[[DefineOwnProperty]]` refusals,
sorted `[[OwnPropertyKeys]]`, `@@toStringTag`) decide individual rows. That is
an XL, two-component slice — **not** the "likely small one" the dispatch
assumed, which is the single most useful thing this triage establishes.

#### Root cause 2 — `instanceof` never consults `@@hasInstance`, and the fix route is known

§13.10.2 step 2 does `GetMethod(C, @@hasInstance)` **before** the step-5
`IsCallable(C)` throw. `native-ordinary-instanceof.ts` already knows this — its
`moduleInstallsCallableHasInstance` gate (#4484 A) declines the non-callable-RHS
throw when the module installs a handler. But the very next arm in
`emitDynamicInstanceOf` (`isExclusivelyPrimitiveType`, the #2998 primitive-LHS
fold) then answers `false` for `0 instanceof F` **without** consulting the
handler, so the handler is never called. That is exactly
`symbol-hasinstance-{invocation,to-boolean}`; `symbol-hasinstance-get-err`
additionally needs the gate widened to `Object.defineProperty(F,
Symbol.hasInstance, {get})`, which the current syntactic scan does not match.

The reason this is worth writing down: **the primitives to lower it already
work.** Probed on the source-clean tree, `--target standalone`
(`.tmp/6651/hasinst.mts`):

| probe | result |
| --- | --- |
| `F[Symbol.hasInstance](7)` after `F[Symbol.hasInstance] = fn` | **1 (works)** |
| `F[Symbol.hasInstance].call(F, 7)` | **1 (works)** |
| `0 instanceof F` (same module) | **0 (handler never called)** |

So the slice is a lowering change in `emitDynamicInstanceOf` only — read
`@@hasInstance` off the RHS, and when it is callable invoke it through the
generic `__apply_closure(target, thisArg, restVec)` primitive that
`function-proto-invokers.ts` (#6630) already uses for
`Function.prototype.call`, then `ToBoolean`. It needs its own before/after over
`language/expressions/instanceof/**` on both lanes, because the gate is
module-scoped and would change every `instanceof` site in a module that
installs a handler.

#### Root cause 3 — the partition put 5 generator rows in this cluster

B2's five `language/module-code/*-gen-*` rows are `env::g` generator leaks, not
language-misc work. The manifest generator note keys cluster I as "the rest",
and the generator rule only matched errors mentioning `__gen_`/yield. Route
them to A rather than re-deriving the same lowering here.

#### Residuals

All 114 rows. Nothing flipped; this entry buys the next owner a measured,
engine-correct starting point and removes two false assumptions (that the
namespace family is a MOP slice, and that a bare sweep measures this cluster).
Logs: `.tmp/6651/I-before.log` (quickjs), `.tmp/6651/I-before-noqjs.log` (the
unusable no-provider run, kept as the evidence for the engine warning),
`.tmp/6651/I-before-clean.log`, per-bucket row lists in
`.tmp/6651/I-buckets.txt`. Probes: `.tmp/6651/{selfimport,selfimport2,hasinst,probe}.mts`.
None of the probes is committed.


## Handoff — 2026-09-21 (round 1 closed, round 2 ready to dispatch)

### What landed

PR [#6023](https://github.com/loopdive/js2/pull/6023) merged into `main` at
`5ac0df63bd` with slices A1, B1, C1+C2, D1, E1, F1, H1. Per-owner manifest
receipts (isolated `--standalone` runner, before → after, all with **zero
pass→non-pass** in their neighbourhood controls and byte-identical host-lane
binaries for the probed programs):

| cluster | manifest rows | before → after | gain |
| --- | ---: | --- | ---: |
| A generators | 197 | 1 → 62 | +61 |
| D promise combinators | 101 | 0 → 26 | +26 |
| E typed arrays / buffers | 144 | 0 → 13 | +13 |
| C class / object / super (C1+C2) | 177 | 0 → 12 | +12 |
| B RegExp protocol | 147 | 0 → 7 | +7 |
| F Proxy / Reflect | 89 | 0 → 7 | +7 |
| H builtins misc | 217 | 0 → 3 | +3 |
| **sum** | | | **+129** |

These are manifest-row gains measured by each owner on their own base, not a
fresh full-suite census. The next authoritative number comes from the
`promote-baseline` run on `main` after #6023 (baseline
`test262-standalone-current.jsonl`); until then the honest statement is
"10,384 + ≤129 of 11,704".

G (for-of / destructuring / iterators) and I (language misc) were dispatched
last; their receipts, if any, appear as Cluster-status entries below this
handoff or in the follow-up PR.

### Environment facts the next session needs

- **QuickJS eval provider is now built** in `.test262-cache/` (artifact
  `quickjs-artifact-2e2d7736713beeda`, adapter keyed on the compiler source
  hash; rebuild the adapter with
  `node --import tsx scripts/build-quickjs-eval-provider.mjs`, ~10 s when the
  artifact is cached). Every round-1 owner reported 5–63 rows per cluster as
  "unmeasurable: provider not built" (realm / `$262.createRealm` /
  detached-buffer shapes, ~130 rows total). Round 2 measures them with
  `JS2WASM_EVAL_ENGINE=quickjs` before classifying anything as environment.
- Agent worktrees get a `test262/` symlink farm that may not resolve; repair
  with `ln -sfn /home/user/js2/test262/test test262/test` (same for
  `harness`). An all-`error` counts line is a broken farm, not a measurement.
- The in-process runner OOMs / dies with an empty log above ~200–500 rows
  (realm poisoning); chunk neighbourhood sweeps at 128–200 rows per fresh
  process. Never `pkill -f run-test262-paths` (it killed other lanes' runs);
  match `/proc/<pid>/cwd`.
- Probe against the ORIGINAL-HARNESS assembly at module scope
  (`assembleOriginalHarness`), not a hand-written `export function test()`:
  several defects (C2-a, the `{kind:"class"}` expando fact in B1) exist only
  in the module-scope shape.
- A compile-only per-gate histogram (instrument every bail in the candidate
  gates) turns "N compile errors" into a bucket table in minutes; an 8-row
  host-lane probe per bucket then says which buckets can reach `pass`.
- The pre-commit hook greps the COMMAND LINE for the `✓` sign-off; `-F file`
  alone is blocked. New `src/codegen/*` modules must be classified in
  `scripts/compiler-boundaries.json` or `quality` fails on the inventory gate
  (this cost #6023 one CI cycle).
- The per-box spawn load cap was raised to 3 in the gitignored
  `.claude/max-load` for the PR shepherd; 4-core box, three heavy agents max.

### Round 2 — dispatch table (largest measured residuals, with owner shape)

| # | residual family | rows | mechanism (from the owner's receipt) | lane / effort |
| --- | --- | ---: | --- | --- |
| A2 | `yield` inside a destructuring pattern (`[x = yield] = v`, `for ([{} = yield] of …)`) | 90 | `lowerStatements` must model a suspension inside a pattern; **fails on host too** (8/8 probe), so it is new engineering in both lanes, not a port | senior-dev, max |
| C3 | defaulted parameter typed `number` by the checker lowered to an f64 slot (`«0» vs «false»`, `«NaN» vs «undefined»`) | ≥18 in C, more in G | widen the parameter TYPE in the function's type map, not just the slot (`isUndefinedDefaultOnlyParam` doc); needs a control over every defaulted param in the corpus | senior-dev, max |
| D2 | observable intrinsic `Promise.all/race` protocol (`invoke-resolve*`, `invoke-then*`, iterator close) | ~34 | held PR #5883 (#5197 R3-2/R3-4) — integrate, don't re-implement; class-receiver `Construct(C)` (14 CE) is #5197 G9/G10 | senior-dev, high |
| B2 | observable `RegExpExec` substrate + brand-check widening | 62 | #5198 Slice B / draft #5393 owns it; coordinate with that lane first | senior-dev, high |
| E2 | integer-indexed MOP `internals/{Set,DefineOwnProperty,OwnPropertyKeys}`, `TypedArray.from/of` statics, static-carrier expando table | 37 | each is a mechanism, not an arm; the static `new Int8Array(1)` carrier has no expando side-table for `__extern_get` | senior-dev, high |
| F2 | proxy in the prototype chain never runs its trap; `Proxy/construct` NewTarget | 7 + 7 | `$Object.$proto` is `ref null $Object` and `$Proxy` is not a subtype — architectural; NewTarget belongs to the #3371 lane | architect spec first |
| H2 | symbol-keyed accessor `defineProperty` on a vec carrier dropped; `__extern_length` for non-`$Object` carriers; `Object.prototype.toString` runtime tag honouring `delete` | ~15 | localized to lines in H's receipt | developer, high |
| I2 | `instanceof` never consults `@@hasInstance` (primitive-LHS fold in `emitDynamicInstanceOf` answers before the handler) | 3 (+ corpus) | lowering change in one function via the existing `__apply_closure` invoker; both-lane sweep over `language/expressions/instanceof/**` | developer, high |
| I3 | module namespace object: self-import under the runner's virtual `./test.ts` key is left nested (#2932) AND the compiler materializes no namespace for a top-level self-import (`ns` reads null) | 12 | runner + compiler + then the MOP — XL, not the small MOP slice round 1 assumed | architect spec first |
| realm | every `*-realm*` / `cross-realm` / detached row across A–H | ~130 | re-measure under `JS2WASM_EVAL_ENGINE=quickjs`; then split fixable vs `$262.createRealm` wont-fix | developer, medium |

Dispatch order by rows-per-effort: A2, C3, E2 first (three slots), then D2/B2
(coordination-bound), then I2/H2/realm, F2 and I3 after their specs. Cluster I's
triage (above) also found that with the QuickJS provider present ZERO of its 114
rows are environment-unmeasurable, and that 5 `language/module-code/*-gen-*`
compile errors are generator leaks belonging to A2.

### Definition of done reminder

Unchanged: 11,704 / 11,704 on a full authoritative standalone run, or a
`wont-fix` issue with the spec-level reason for every remaining row; bank the
ES2015 floor via `check:edition-ratchet:update` from a FULL run only.

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
