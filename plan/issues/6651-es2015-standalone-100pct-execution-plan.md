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
# 2026-09-21 — cluster G (spec-ordered ArrayAssignmentPattern + IteratorClose,
# standalone). The MECHANISM (~350 LOC) is the NEW module
# `src/codegen/dstr-assign-iterator-drive.ts`; the god-file growth is two
# dispatch sites only — `expressions/assignment.ts` +14 and
# `statements/for-of-destructuring.ts` +9, both ~70 % comment. Neither can move
# behind a seam: each sits at the exact point where its caller is about to
# perform the eager `__array_from_iter_n` materialisation, and the decision
# being recorded is "this pattern's target references are observable, so the
# drain below is the wrong shape". Written anywhere else it would be a fact
# about a lowering the reader cannot see. The `for-of` function grows by the
# same 8 lines (`compileForOfAssignDestructuringExternref`), for the same
# reason and at the same point.
# 2026-09-21 (cluster E, slice E2) — `src/codegen/index.ts` +6 (the import plus
# one finalize call site in each of `generateModule` / `generateMultiModule`,
# with the ordering note that makes the placement readable). The MECHANISM
# (~330 LOC) is the NEW module `src/codegen/ta-dyn-own-keys.ts`, and
# `src/codegen/ta-dyn-mop.ts` SHRINKS by 53 lines in the same change-set — its
# narrower `__object_keys` arm is retired INTO that module rather than
# duplicated beside it. What cannot move is the call site: these arms prepend
# at body[0] of natives that several earlier passes also prepend to, so "after
# `fillVecLengthDynamicArms`, after `fillTaDynViewMopArms`" is an ORDERING
# fact that is only checkable where the order is written.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/statements/for-of-destructuring.ts
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
  - src/codegen/property-access-dispatch.ts
# 2026-09-21 — cluster A, slice A2 (a suspension inside a `for-of` BODY).
# `generators-native.ts` +344, `generators-delegation-runtime.ts` +73. The
# growth is one new plan arm (`lowerForOf`), one new state terminator with its
# emitter arm, and one new unwind-chain entry — all three of which HAVE to live
# where the state graph is built and emitted. `lowerStatements`' statement
# dispatch, the `compileState` terminator switch and `emitUnwindWalk`'s chain
# walk are single closed switches over closed unions; a for-of arm cannot be
# spliced in from a leaf module without first splitting the state machine
# itself, which is a refactor this slice deliberately does not mix in. Roughly
# half the added lines are comment: each records the MEASUREMENT that set a
# bail (arrays/strings/Sets trap at the first step; binding the raw result
# object made `x * 2` NaN while `typeof x` still said "number"), so the next
# owner inherits the probe result rather than the conclusion.
  - src/codegen/generators-delegation-runtime.ts
# 2026-09-21 — cluster C, slice C3 (see the rationale below, under the function
# keys this same change-set needs).
  - src/codegen/class-bodies.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/expressions/identifiers.ts
# 2026-09-21 — cluster B, slice B2 (observable RegExpExec substrate).
# `regexp-standalone.ts` +47, all of it in `emitRegExpProtoMemberBody`'s new
# `@@7`/`@@9` arm. The MECHANISM (~330 LOC — §22.2.7.1 RegExpExec plus the
# generic §22.2.6.12 `@@search` and §22.2.6.8 `@@match` bodies) is the NEW
# module `src/codegen/regexp-exec-protocol.ts`, which deliberately knows
# nothing about the `$NativeRegExp` struct so it stays usable from any receiver
# shape. What cannot move is the arm itself, for two reasons that are both
# ordering facts: (a) the arm has to sit BEFORE the brand-recovery prologue —
# the whole defect being fixed is that the prologue ran first, and "this member
# does not brand-check here" is only readable at the point the brand check
# would otherwise happen; and (b) the builtin-exec callback it passes down IS
# the moved prologue plus `emitRegexExecArrayCall`, both `$NativeRegExp`
# operations that live in this file.
  - src/codegen/regexp-standalone.ts
# 2026-09-21 — cluster D, slice D2 (#5197 R3-2, integrating held PR #5883).
# The observable §27.2.4.1.1/§27.2.4.3.1 Get/Call/Invoke pipeline (+913) lives
# in `promise-combinators.ts`, the module that already owns every native
# combinator emitter; the intrinsic-`Promise.resolve`-write proof (+99) lives
# beside the existing builtin-write keeps it is an exception to, and only the
# two dispatch decisions travel to the god-files (+39 admission gate in
# call-namespace-static, +19 module-init keep in declarations). Both dispatch
# sites are irreducible: "can source observe this constructor's `resolve` or
# this element's `then`?" has to be readable at the point the fast native arm
# would otherwise be taken, and "is this write the unshadowed intrinsic?" at
# the point module-init collection would otherwise drop it. Restated here so
# the grant is not stranded in #5197 alone.
  - src/codegen/promise-combinators.ts
  - src/codegen/builtin-write-keeps.ts
func-budget-allow:
  # (see coercion-sites-allow below for slice B2's other gate grant)
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
# 2026-09-21 — cluster A, slice A2. `compileState` +5: the whole emitter for the
# new `for-of-step` terminator lives in its OWN top-level `emitForOfStepState`
# (the shape `emitGenericDelegationState` already established); what is left in
# the god-function is the four-line dispatch arm that names it. A terminator
# kind cannot be dispatched from anywhere but the terminator switch.
  - src/codegen/generators-native.ts::compileState
# 2026-09-21 — cluster C, slice C3 (the f64-typed defaulted parameter).
# The MECHANISM is three functions in `src/checker/type-mapper.ts`, the module
# that already owns every other parameter widening, plus the read guard in the
# 99-line leaf `strict-eq-stale-type.ts` — neither is a god-file. What is left
# is four irreducible LOWERING SITES: `class-bodies.ts` +10 (the signature and
# fctx-build phases, which MUST agree or the module is invalid Wasm, not merely
# wrong), `declarations.ts` +7, `destructuring-params.ts` +5 (one delegation
# that carries the closure and all three object-literal-method twins with it)
# and `identifiers.ts` +1 (the guard's call). A parameter widening cannot move
# behind a seam by construction: `isUndefinedDefaultOnlyParam`'s own doc
# requires every site that lowers a parameter list to apply it identically, so
# the decision has to be readable at each list. The growth is ~80 % comment for
# the same reason the neighbouring #5221/#5360 widenings are — each site is
# where a future reader will ask why this parameter is not a scalar.
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
# 2026-09-21 (cluster F) — the three new `__is_truthy` calls are not a
# hand-rolled coercion matrix. Each is literally the spec's ToBoolean on a
# [[SetPrototypeOf]] / [[PreventExtensions]] success bit (§28.1.14 step 4,
# §28.1.11 step 2), and each calls the SAME shared `__is_truthy` native that
# the neighbouring `Reflect.defineProperty` arm and the six #6494/#5316 proxy
# front guards already use to read exactly this kind of booleanish trap result.
# This makes the `Reflect` arms agree with one another rather than introducing
# a second rule — the same argument #6494 recorded for its own three.
# 2026-09-21 (cluster E, slice E2) — the two coercion-vocabulary growths are a
# MOVE and a spec correction, not a fresh matrix.
#   - `ta-dyn-own-keys.ts` (+`number_toString`, +`__str_to_number`): the
#     §7.1.21 CanonicalNumericIndexString round-trip and the index→key
#     ToString. Both are verbatim the pair `ta-dyn-mop.ts` already uses for the
#     same question on the same receiver; the count appears in a new file only
#     because the own-key emitter lives there instead of in a god-file at its
#     ceiling. `ta-dyn-mop.ts`'s narrower `__object_keys` arm — which used the
#     same pair — is DELETED in this change-set.
#   - `ta-dyn-mop.ts` (+`__to_primitive` ×2): this one REMOVES a hand-rolled
#     shortcut. `__ta_dyn_set_elem` called `__unbox_number` directly, which
#     answers NaN for an ordinary object without ever running its `valueOf` —
#     so §10.4.5.16 step 1's observable ToNumber never happened. Routing
#     through the shared `__to_primitive` native (hint "number") before the
#     unbox is the coercion ENGINE doing the work, which is what this gate is
#     protecting; the two sites are the value operand and its hint string.
# 2026-09-21 (cluster B, slice B2) — four sites in the new
# `regexp-exec-protocol.ts`, and the gate is counting two different things.
#   - `__extern_toString` ×2 — §22.2.6.12 step 3 and §22.2.6.8 steps 3-4,
#     literally "S = ? ToString(string)" and "flags = ? ToString(? Get(rx,
#     "flags"))". They are the SAME shared native that `array-tolocalestring.ts`
#     and `array-like-native.ts` already use for §7.1.17 on an arbitrary value,
#     so this is the existing spelling rather than a new matrix. It is also the
#     only spelling that keeps the operation ONCE: the result is a String VALUE
#     that is then handed unchanged to a user-supplied `exec`, and routing it
#     through `coerceType` to a native-string GC ref would force a re-box on the
#     way out — a second coercion opportunity, which `coerce-string-err` and
#     `flags-tostring-error` exist precisely to catch.
#   - `__unbox_number` ×2 — NOT a coercion. Both operands are already proven to
#     be numeric zeros by the preceding `__same_value_zero`; the unbox only
#     reads the sign so §7.2.10 SameValue can separate `-0` from `+0`, which
#     `set-lastindex-init-samevalue` and `set-lastindex-restore-samevalue`
#     measure. No value is converted from one type to another.
# 2026-09-21 — cluster D, slice D2: `emitStandalonePromiseCombinatorRuntime`
# gains the observable branch (+28) — the admission test plus the delegation to
# the observable runtime emitter. The pipeline itself is in new module-level
# helpers, not in this function.
  - src/codegen/promise-combinators.ts::emitStandalonePromiseCombinatorRuntime
coercion-sites-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/ta-dyn-own-keys.ts
  - src/codegen/regexp-exec-protocol.ts
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


### 2026-09-21 — Cluster G (for-of / destructuring residuals / iterators, standalone), slice G1: spec-ordered ArrayAssignmentPattern + IteratorClose

- **Branch** `worktree-agent-a3b8356df530ad9e4`, based on
  `claude/es2015-test262-plan-54tooh` @ `64801f10` (carries A, B, C1, D, F, H).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a3b8356df530ad9e4`.
- **Manifest** `plan/agent-context/6651/G-forof-destructuring-iterators.txt`,
  134 rows, sha256
  `e68a764ab55ce04936572717bdf96f724fb337af6a9af3a758f3525851ff1dec`.
- **Engine note:** every log below was measured with the runner's DEFAULT eval
  engine (the QuickJS provider was not built in this container when the
  before-state was taken), so the 7 `quickjs provider is not built` rows are
  environment-blocked on BOTH sides and the delta is comparable.

| standalone, `--isolate`, 134 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/G-before.log`) | **0** | 132 | 2 |
| after (`.tmp/6651/G-after.log`) | **21** | 111 | 2 |

**+21 rows pass; 0 lost; no other status changed** (the two logs were joined
per path, not compared by count). One further row moved to a LATER assertion:
`assignment/destructuring/iterator-destructuring-property-reference-target-evaluation-order.js`
now reports `[source, iterator, target, target-key, …]` where it reported
`[source, iterator, iterator-step, …]` — i.e. the ordering this slice fixes is
now observable in its trace, and it fails on a later step.

#### What landed — the answer was MIS-ORDERED, not missing

§13.15.5.2 ArrayAssignmentPattern is three-phase: GetIterator, then **per
element** evaluate the DestructuringAssignmentTarget's *Reference*
(§13.15.5.5 step 1) and only then IteratorStep (step 2); an abrupt completion
with `[[done]]` still false runs §7.4.9 IteratorClose. Both destructuring
entry points normalise the source through `__array_from_iter_n(src, n)` FIRST
— a complete drain of `n` steps before any target reference is touched. So for

```js
0, [ {}[thrower()] ] = iterable;     // array-elem-iter-thrw-close.js
```

the compiler reported `nextCount 1 / returnCount 0` where the spec requires
`0 / 1`. Hoisting the reference in front of the materialisation fixes
`nextCount` and **cannot** fix `returnCount`: the throw would then precede
GetIterator, so there would be no iterator to close. Hence a lazy drive, not a
re-ordering.

New module `src/codegen/dstr-assign-iterator-drive.ts`
(`tryEmitSpecOrderedArrayAssignDrive`) plus two dispatch sites
(`expressions/assignment.ts::compileExternrefArrayDestructuringAssignment` +14,
`statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref`
+9). It emits GetIterator once, then per element: member-target reference into
`(obj, key)` locals → `__iterator_next` → `__extern_set_strict`; a rest element
drains via `__iterator_rest`; the whole element loop is wrapped so any throw
runs IteratorClose with the close's own abrupt completion suppressed
(§7.4.9 step 6 — the original throw wins, which is what every `*-thrw-close-err`
row asserts). **No new host import** — all six natives already route to the
standalone object/iterator runtime.

Three details are load-bearing and were measured, not assumed:

1. **`doneLocal` is raised to 1 BEFORE each step and lowered after.** §7.4.6
   sets `[[done]]` true when `next()` throws, and `[[done]]` true is exactly
   what suppresses the close. Without the pre-raise a throwing `next()` would
   be followed by a `return()` call the spec forbids.
2. **A rest element reached with `[[done]]` already true must not step again**
   — it still receives an array, an EMPTY one. `__array_from_iter_n(null, -1)`
   answers that, so no second empty-vec shape is introduced.
3. **A `never`-typed operand is not a refusal.** `compileExpression` answers
   `null` for `{}[thrower()]`'s call (the declared return type IS `never`)
   while still emitting the throw; the slot is padded with `ref.null.extern`
   exactly as `emitDynamicMemberSet` pads it. Refusing there rejected the
   entire family — the first cut did, and silently fell through to the old
   path after having already emitted a GetIterator, which is why the drive now
   builds into a DETACHED buffer and splices only on success.

#### The drive is STANDALONE/WASI-gated, and that gate is a measurement

Ungated, the 1,207-row **host** sweep gained 10 rows and **LOST 3**
(`for-of/dstr/array-rest-{lref,nested-array-iter-thrw-close-skip,
put-prop-ref-user-err-iter-close-skip}.js`, `nextCount 0` where 1 is required).
Cause, probed directly: the host `__iterator_rest` (`src/runtime.ts:17999`)
drains via `iter.next` / the string sidecar, and the iterator in this whole
family is a compiled OBJECT LITERAL — a WasmGC struct neither lookup finds — so
it answers `[]` without stepping, where the eager `__array_from_iter_n` it
replaces goes through the host's own iteration bridge. Gating costs nothing
measurable: every row in this bucket already fails on host, for the same
ordering reason plus a host-only close-receiver defect (`return()` does not see
the iterator as its `this`, measured 1010 vs the required 1011). Lifting the
gate means first giving the host lane a rest drain that can step a struct
iterator.

#### Controls — zero pass → non-pass

Neighbourhood: all 1,207 rows of `language/statements/for-of/**`,
`language/expressions/assignment/dstr/**`, `built-ins/ArrayIteratorPrototype/**`,
`built-ins/GeneratorPrototype/**`. Run in 128-row chunks, one fresh process per
chunk; the 6 `*array-prototype*` rows ran `--isolate` (they replace
`Array.prototype[@@iterator]` and poison the runner's own realm). Base measured
with the file-copy A/B revert.

| lane | rows | before non-pass | after non-pass | flips |
| --- | ---: | ---: | ---: | --- |
| standalone (`.tmp/6651/nb-{before,after}-*.log`) | 1,207 | 164 | **143** | **+21, 0 lost, 0 other status changes** |
| host, ungated draft (`.tmp/6651/nbh-{before,after}-*.log`) | 1,207 | 214 | 207 | +10, **−3** ⇒ the gate above |

**Host control on the shipped change is a byte-identity proof.** A 9-program
corpus — the three admitted shapes, a for-of over a plain array literal, an
all-identifier assignment, an identifier default, a for-of identifier head, an
object pattern and a destructuring-free control — compiles **9/9
byte-identically on gc** before vs after (`.tmp/6651/sha-{before,after}.txt`),
while on standalone exactly the 3 admitted shapes move and the other 6 are
byte-identical. That is the intended delta, stated as bytes.

Pin file `tests/issue-6651-dstr-iterator-close.test.ts`, 7/7 — 5 verified RED
on the base tree, 2 are guards green on both sides, including the two negative
directions (an all-identifier pattern keeps the old lowering on BOTH targets; a
rest element after an exhausted slot must not step again).

Gates, run bare: coercion-sites, oracle-ratchet (`getTypeAtLocation +0`,
`ctx.checker +0`), dead-exports and typecheck pass untouched; loc-budget and
func-budget pass with the grants added to this file's frontmatter above, dated.

#### Residual sub-buckets (113 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 21 | `built-ins/Iterator/prototype/{chunks,windows}/**` + `Iterator/prototype/join/not-a-constructor.js` | **OUT OF SCOPE, not a gap.** These are the `iterator-chunking` / `Iterator.prototype.join` PROPOSALS; the edition index tags them ES2015 only because their `features` list also names `class`/`generators`. Building them would be implementing a proposal surface, not finishing ES2015. Recommend a `wont-fix`-with-reason on the #6651 definition of done rather than a lane. |
| 20 | `built-ins/GeneratorFunction/**` | ~13 need `GeneratorFunction(…)` — CreateDynamicFunction, i.e. compiling source at runtime, which standalone cannot do without the eval provider; the other ~7 (`name`, `is-a-constructor`, `has-instance`, `prototype/*`) need the **intrinsic object itself** reified so `Object.getPrototypeOf(function*(){}).constructor` answers a real function with the right descriptors. |
| 14 | `Expected a TypeError … no exception` | scattered: `iterator-next-result-type`, non-callable `return`, `GeneratorPrototype/*/from-state-executing`, `restricted-properties`. |
| 7 | `quickjs provider is not built` | environment only at measurement time; the provider now exists in the shared cache (coordinator note, 2026-09-21) and these are re-measurable with `JS2WASM_EVAL_ENGINE=quickjs`. |
| 7 | `Expected a Test262Error … no exception` | mostly `scope-param-elem-var-{open,close}` / `params-dflt-ref-arguments` — generator parameter-scope shapes. |
| 6 | `Cannot access property on null or undefined` | `yield`-in-operand rows (`yield-as-yield-operand`, `rhs-yield`, `in-rltn-expr`). |
| 6 | `called value is not a function` | `*-spread-arr-*` / `named-yield-*` — a generator result spread through a call. |
| 6 | `Expected a Test262Error but got a TypeError` | `*/dstr/ary-ptrn-elem-ary-*` — cluster A's generator-destructuring lane. |
| 4 | `Cannot destructure 'null' or 'undefined'` | `*/dstr/*-ary-empty-init.js`, same lane. |
| 4 | `SameValue(«"outside"», «"inside"»)` | `scope-body-lex-distinct` / `scope-param-elem-var-*` — a generator body's lexical environment is shared with the params'. |
| 2 | `SameValue(«NaN», «undefined»)` — `dflt-obj-ptrn-prop-ary` | the f64-typed-parameter-slot defect cluster **C2** owns; deliberately not touched here. |
| ~16 | assorted singletons | `default-proto`, `prototype-relation-to-function`, `iterator-next-reference`, `map-expand`, `throw-from-finally`, `head-lhs-let`, `detach-typedarray-in-progress`, … |

#### Next steps for this cluster, in rows-per-fix order

1. **Widen the drive's admission scan to DEFAULTS** (`[a = init]`) and to
   object/nested array patterns in non-rest slots. The refusal is one function
   (`planElements`) and the per-element emitter already has the value in a
   local; that reaches the `*-init-*` and `obj-prop-elem-target-*` rows.
2. **Classify the 21 Iterator-helpers rows** as out-of-scope in the #6651
   definition of done (above), which removes them from the gap arithmetic.
3. **Reify the `GeneratorFunction` intrinsic** (7 rows) separately from
   CreateDynamicFunction (13 rows, eval-dependent).
4. **Give the host lane a struct-capable rest drain** if the drive is ever to
   be ungated — see the gate rationale above.

### 2026-09-21 — Cluster A (native generator lowering, standalone), slice A2: a suspension inside a `for-of`

- **Branch** `worktree-agent-ab77b42be7e8077f0`, based on
  `claude/es2015-test262-plan-54tooh` @ `3769840f` (== `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-ab77b42be7e8077f0`.
- **Manifest** `plan/agent-context/6651/A2-forof-pattern-suspension.txt`, 278
  rows, sha256
  `2c2e807946cf393a7f0d7dc6882a0c9df421e07f40c532748d18059f604d5d7d` — A1's
  197-row cluster-A manifest ∪ the 5 `module-code/*-gen-*` rows cluster I
  routed here ∪ the generator / `dstr` rows clusters C and G routed here.
- **Engine:** every runner command carried `JS2WASM_EVAL_ENGINE=quickjs`
  (artifact `073742801ba7`, adapter key `d4799bda84cfed0d`); the compile-only
  probe does not run code and is engine-independent.

#### The finding that reframed the family: it is not all pattern work

A1 handed over ~90 rows described as "`yield` inside a destructuring pattern".
Instrumenting every `return false` / `fail()` in the candidate and plan gates
and running the 278-row manifest through a **compile-only** probe (A1's method;
`plan/agent-context/6651/A2-bail-attribution.tsv` is the per-row result) says
the residual is in fact **two** mechanisms, not one:

| rows | first bail | what it is |
| ---: | --- | --- |
| 65 | none — candidate gate | A1's enumerated small gates (own-name fn-expr, computed method names, rest params, …) |
| 37 | `lowerStatements` · `ExpressionStatement` | `result = <pattern> = vals` and friends — the pattern family proper |
| 32 | `lowerStatements` · `ForOfStatement` | **`lowerStatements` had no ForOfStatement arm at all** |
| 6 | `ClassDeclaration` / `FirstStatement` / `WithStatement` | unrelated shapes swept in by the partition |

Every plan bail in the whole 278-row manifest came from ONE line — the generic
"unmodeled statement" `return fail()` at the end of `lowerStatements`
(`A2BAIL plan gn:843:14`, 185/185 hits). So the gate to widen is the statement
dispatch, and **for-of was the arm that was simply missing**: 8 of those 32 rows
(`language/statements/for-of/yield*.js`) are plain body-yield loops with no
destructuring anywhere, and the other 24 are the for-of/`dstr` head-pattern
rows, which need the for-of arm **before** any pattern modelling can apply.

The host lane is not a reference here and A1's 8/8 figure holds — but the two
halves fail for DIFFERENT reasons, and only one of them is a feature gap:

| family | host verdict | first failing assertion |
| --- | --- | --- |
| for-of body-yield (8 rows) | 8/8 fail | `First iteration: pre-yield Expected SameValue(«2», «1»)` — the eager buffer ran the WHOLE loop before the first `.next()` |
| pattern-default (8 probed) | 8/8 fail | `Expected SameValue(«null», «undefined»)` — the yielded value's representation |

The first is an artefact of the host lane's eager lowering, which the native
state machine does not share. That is a positive prediction, and it held: all 4
reachable rows of that family now pass in standalone while still failing on the
host. Log: `.tmp/6651/probe-host16.log` (host, 16 rows, all fail).

#### A2 design

Model the for-of as a **non-suspending loop header state**. `lowerForOf`
reserves a header, a body entry and an exit; the header's new `for-of-step`
terminator performs exactly one IteratorStep per entry and transfers to the body
(a value was produced) or the exit (exhausted) without returning to the caller.
The suspension stays where it already worked — in the body's own states — so
nothing about the yield model changes.

The one genuinely new requirement is that the **iterator has to survive a resume
boundary**. It rides the per-site `externref` frame slot family that
`yield* <generic iterable>` already allocates (`iterableDelegationSites`), driven
by `__gen_delegate_start` / `__gen_delegate_step`: that is the one carrier in the
state struct already proven to hold a live iterator record across `.next()`
calls, so the slice adds a terminator and an emitter arm rather than a second
frame mechanism. GetIterator happens once (the slot's null-guard); the slot is
cleared on exhaustion, which is what lets an enclosing loop re-enter with a fresh
iterator and what makes the close a no-op after normal completion.

§14.7.5.7 step 6 is the second requirement, and the reason for a new **unwind
chain entry** rather than folding the close into the terminator: a `.return(v)` /
`.throw(e)` delivered at a yield INSIDE the body has to run IteratorClose, but
only if no closer handler intercepts first. `{ kind: "iter-close" }` sits in the
innermost-first chain, closes the record and keeps walking — so an inner `catch`
that intercepts a throw still wins (its arm `br`s out before the close is
reached), while a return completion passes through the close on its way out. Both
results of the close call are discarded: §7.4.9 step 5 ignores its value, and
step 6 lets the ORIGINAL completion win when the close itself throws.

Four bails are deliberate, and three of them are measurements rather than
caution:

1. **JS-host lane** — `lowerForOf` refuses outright unless `noJsHostTarget`.
   The rule every #680/#2864 widening follows: the host has a working fallback,
   so admitting shapes there is pure regression risk for no conformance gain.
2. **Subject must be an ITERATOR object** (`[Symbol.iterator]` **and** `next`).
   Measured on this branch: a `number[]`, a `string` and a `Set` each compile
   host-free through `__gen_delegate_start` and then **trap at the first step**,
   while a native generator and a `{ next(){}, [@@iterator](){} }` object both
   run correctly (`.tmp/6651/p3.mts`). Admitting arrays would trade the loud #680
   refusal for a runtime trap — strictly worse than the leak it replaces. Arrays
   have their own vec drive, the split `yield*` already makes.
3. **`return` in the body** — the plain `return` terminator completes without
   walking the unwind chain, so the iterator would never be closed.
4. **`yield*` in the body** — the native-gen / vec delegation terminators rebuild
   their abrupt context from `replay` entries ONLY, which would silently DROP
   this loop's `iter-close` entry. This is what keeps the four
   `for-of/yield-star-*.js` rows red; closing it means giving those two
   delegation kinds the full unwind chain the `iterable` kind already has.

Two defects were found by probing rather than by reading, and both were silent:

- **`__gen_result_unwrap` could only see through ONE result-struct type**, the
  first delegating generator's. A `for (x of gen)` loop is the first shape that
  makes an **f64**-carrier generator set `nativeDelegates`, and reading `value`
  out of an f64 struct in an `externref -> externref` helper made the MODULE
  invalid (`type error in fallthru[0] (expected externref, got f64)`). It now
  enumerates every result-struct type in the module and boxes a non-externref
  carrier (`undefSentinel`, so `yield;` comes back out as `undefined`).
  **Keep the enumeration scoped to DELEGATING generators.** The first cut
  enumerated every native generator, which sounds strictly more correct and
  quietly changed the bytes of **every generator module in the corpus** — a
  module with no delegating generator used to get the identity body and now got
  a real unwrap chain. A 10-row SHA spot-check caught it; a verdict-only control
  would not have, because none of those modules' verdicts moved. Scoping it back
  restores byte-identity and keeps the blast radius at the shapes this slice
  actually reaches.
- **`__gen_delegate_step` status 0 returns the RAW result object**, not its value
  — that is what `yield*` re-yields under the `done: -1` sentinel for its
  consumer to unwrap. The first cut bound that raw object as the loop variable,
  which left `typeof x === "number"` TRUE while `x * 2` and `yield x` both
  answered **NaN**. All four target rows passed anyway, because none of them
  reads `x`. `tests/issue-6651-generator-forof-suspension.test.ts` case 2 is the
  pin for it.

#### Measurements

| 278-row manifest, compile-only probe | ok (host-free) | host_import | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/probe-base.tsv`) | 138 | 79 | 61 |
| after (`.tmp/6651/probe-after-final.tsv`) | 142 | 75 | 61 |

Exactly 4 rows moved, all `host_import → ok`, none backwards. Through the real
runner (`--standalone --isolate`, QuickJS):

| `language/statements/for-of/yield*.js`, 8 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/forof-before-final.log`) | 0 | 0 | 8 |
| after (`.tmp/6651/forof-after-final.log`) | **4** | 0 | 4 |

**+4 rows pass, 0 pass → non-pass.** The 4 still red are the `yield-star-*`
sub-family held by bail (4) above.

Corpus-wide reach, to size the widening beyond the manifest: every test262 file
containing both `yield` and a `for (… of …)` (182 files) was probed before and
after. 13 modules changed, none backwards; 4 are the rows above and 9 are
`staging/sm/**` rows the runner SKIPS, so they do not move conformance
(`.tmp/6651/corpus-{before,after}.tsv`, `.tmp/6651/changed13-after.log`).

#### Neighbourhood regression control — binary identity, not verdict sampling

The control is stronger than a before/after verdict run: a module whose wasm SHA
is unchanged cannot have changed verdict, so the sweep compares **compile bucket
+ wasm SHA-256** for every generator-bearing row in the neighbourhood — all of
`language/expressions/generators`, `language/statements/generators`,
`built-ins/GeneratorPrototype`, `language/statements/for-of` and
`language/expressions/assignment/dstr` that mention `yield` or `function*`
(854 of 1,736 rows; the other 882 contain no generator at all, so there is no
native plan and no `nativeDelegates` for this change to perturb).

| lane | rows | modules whose bytes changed |
| --- | ---: | --- |
| standalone (`.tmp/6651/nb-sa-{before,after3}.tsv`) | 854 | **4** — the four target rows, `host_import → ok` |
| host / default (`.tmp/6651/nb-host-{before,after3}.tsv`) | 854 | **0 — byte-identical** |

The host result is structural as well as measured: `lowerForOf` fails
immediately unless `noJsHostTarget`, and `nativeDelegates` — the only other
reachable change — already required `ctx.standalone || ctx.wasi`.

Also green: `npm run -s typecheck`; `npx biome lint src tests scripts
--diagnostic-level=error`; `check-loc-budget` / `check-func-budget` /
`check-coercion-sites` / `check:oracle-ratchet` / `check:dead-exports`;
`check-compiler-boundaries --mode inventory`; `node scripts/equivalence-gate.mjs`
(22 failing / 1,720 passing, all 22 already in the baseline — no new regressions);
and the new 3-case unit suite `tests/issue-6651-generator-forof-suspension.test.ts`.

#### What is NOT done, and the map for the next owner

**The pattern half of A2 is untouched.** `[ x = yield ] = vals`,
`({ x = yield } = obj)` and the for-of head twins still take the #680 refusal.
The design question is settled and written down; the code is not.

§13.15.5 makes the pattern's element evaluation a **conditional** suspension —
the Initializer runs only when the element is `undefined` — while the whole #680
continuation model is built on an UNCONDITIONAL one (suspend, then recompile the
statement with the yield read from a spill). Re-running the statement in the
successor is what makes that model order-preserving, and a pattern cannot be
re-run: its `GetIterator` / `next()` / `Get` are observable, and the
`*-iter-rtrn-close*` rows assert `nextCount === 1` explicitly. The shape that
does work is the one this slice built for for-of — an explicit state graph:

```
S0   evaluate the rval; step the pattern's iterator once  → element spill
     branch: element is undefined ?
S1     yield          → sent spill                (the conditional suspension)
S2   PutValue the target from whichever spill is live
S3   IteratorClose if the record is still live; statement value = the rval
```

Every primitive for that now exists: the record slot, the step terminator, the
`iter-close` entry, a canonical-undefined test, and the synthesized
`<original target node> = <spill identifier>` statement idiom the `yield*`
assignment arm already relies on. Two open risks: (a) the sent-value carrier — a
resume binding is typed at the generator's carrier (f64 for a bare `yield;`) and
these rows assert `value === undefined` AND `x === 86` on the same binding, so
the value-representation work round 2's C3 row is about lands in the middle of
it; (b) `{}` and nested patterns as destructuring targets.

Residual buckets in the 278-row manifest after this slice, by first bail
(`plan/agent-context/6651/A2-bail-attribution.tsv` has the per-row detail):

| rows | bail / signature | note |
| ---: | --- | --- |
| 33 | `ExpressionStatement` — `result = <pattern> = vals` | the pattern family above; ~14 are the flat `x = yield` / `{ x = yield }` defaults, ~12 the `*-iter-rtrn-close*` family, which additionally needs a close at a mid-pattern suspension — the `iter-close` entry this slice adds IS that mechanism |
| 28 | `ForOfStatement` — head is a PATTERN | blocked on the same modelling; the loop half is now done |
| 4 | `ForOfStatement` — `yield*` in the body | bail (4) above; needs the full unwind chain on the native-gen / vec delegation terminators |
| 4 | `ExpressionStatement` — `({ get yield() { return 1 } })` | NOT a yield at all — a getter NAMED `yield` trips the structural-lowering scan. Cheapest remaining row in the family |
| 3 | `ExpressionStatement` — `(yield 3) + (yield 4)` | an arithmetic binary with two yields; `lowerCommaExpressionContinuation` already does the left-to-right two-suspension shape for `,` |
| 2 | `ExpressionStatement` — `c[yield 9]()` | a yield in call arguments; needs a call root in `lowerContinuationRoot` |
| 1 | `ExpressionStatement` — `` str = `1${ yield }3${4}5` `` | a TemplateExpression root |
| 1 | `ExpressionStatement` — `obj.foo = yield` | the member-target exclusion #2864 documents; capturing the receiver as a prefix operand is order-preserving and would admit it |
| 65 | candidate gate (no plan bail) | A1's enumerated list, unchanged |

### 2026-09-21 — Cluster C, slice C3 (the f64-typed defaulted parameter)

- **Branch** `worktree-agent-af2a369315ce9f6a7`, base
  `claude/es2015-test262-plan-54tooh` @ `3769840fe0` (== `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-af2a369315ce9f6a7`.
- **Manifest** `.tmp/6651/C3-manifest.txt`, 42 rows, sha256
  `b59c95b8c08e1e52ebd780d46d94d1eb133dc9e2d67d6ae6a6699b1d104d687b` — the 26
  `dflt` rows of C's manifest + the 7 of G's + cluster I's 9-row "parameter
  defaults / destructuring params" bucket (B11). The three
  `module-code/*-dflt-*-gen-*` rows in I match `dflt` only because it spells
  "default"; they are generator leaks and belong to A.
- **Eval engine `quickjs`** on every run below (adapter rebuilt after each
  `src/` edit; its key did not move, the artifact was copied from the main
  checkout's `.test262-cache/`).

#### What C2 left, and why the one-line widening was not the fix

C2-c above diagnosed this exactly and stopped in the right place. Its
one-line widening of `isUndefinedDefaultOnlyParam` moves the SLOT
(WAT-verified) and nothing else, because the parameter's checker TYPE is still
`number`: the identifier read path re-narrows it (`local.get 1; call
$__unbox_number`) one instruction after the prologue correctly declined to use
the default. **Both halves are needed, and neither is sufficient alone** — with
the slot widened but the read guard reverted, the probe still fails
(`.tmp/w6651C3/p13-ng.out`).

#### The change

| file | role |
| --- | --- |
| `src/checker/type-mapper.ts` | `isJsUntypedDefaultParam` (syntax-only predicate), `widenJsUntypedDefaultParamSlot` (scalar slot → `externref`, memoising which nodes it moved), `isJsUntypedDefaultWidenedParam` |
| `src/codegen/strict-eq-stale-type.ts` | `readsJsUntypedDefaultWidenedParam` — the READ guard, in the module that already owns "the checker type of this expression is stale, keep the carrier" |
| `src/codegen/destructuring-params.ts` | one delegation inside `widenUndefinedDefaultParamSlot`, which carries the closure lane and all three object-literal-method derivations with it |
| `src/codegen/declarations.ts`, `src/codegen/class-bodies.ts` ×2 | the remaining parameter-lowering sites, signature and fctx-build phases |
| `src/codegen/expressions/identifiers.ts` | one clause in the unbox-narrowing guard |

Three design points worth keeping:

1. **JavaScript sources only.** In a `.js` file a parameter has no declared
   type, so `m(a = (count += 1))` typing `a` as `number` is a guess about the
   DEFAULT; in a `.ts` file the same text genuinely declares the parameter and
   `m(false)` is a type error. This is also what makes the numeric fast path
   safe: the whole `.ts` corpus is untouched **by construction**, and measured
   — all **32** files under `website/playground/examples/` + `benchmarks/`
   compile to **byte-identical binaries** (`.tmp/6651/corpus-base.txt` vs
   `corpus-new.txt`, sha256 of each `result.binary`, zero-line diff).
2. **Scalar slots only** (`f64`/`i32`/`i64`). A string default is already
   `externref`; an object-valued default has its own nullable widening in the
   closure lane whose reads legitimately narrow back to the struct, and
   widening the read guard over it would change unrelated npm-shaped code.
3. **No call-site carve-out was attempted, deliberately.** "All callers pass
   numbers, keep the f64" is unsound for this shape: a JS function's callers
   are not statically enumerable (exported, invoked dynamically, or — as in
   every row of this manifest — a class method reached through the prototype).

#### Results

| standalone, `--isolate`, engine quickjs | pass | fail |
| --- | ---: | ---: |
| before (`.tmp/6651/C3-before.log`) | **0** | 42 |
| after (`.tmp/6651/C3-after.log`) | **14** | 28 |

All 14 are `dflt-params-arg-val-not-undefined.js` — class methods (static and
not), generator methods, object-literal methods, function declarations and
expressions, generators, arrows. Zero rows moved the other way.

#### Control — the whole `language/**` parameter surface, BOTH targets

The change moves the slot and type of every defaulted parameter in every JS
input, so the control is not a neighbourhood. `.tmp/6651/C3-control.txt`, **2,370
rows**, sha256 `3e8d80a0ae76e6a98b1f0c5885499c06a058ac46cc582c6e50077500d20ce808`:
every test262 file under `language/{expressions,statements}/{function,
arrow-function,class,object,generators,async-function,async-arrow-function,
async-generator}/**` and `language/default-parameters/**` whose body (frontmatter
stripped) contains a parameter-list default. Run in 12 chunks of ≤200 rows, one
runner at a time, all 12 chunk exits `0` on all four passes.

| target | before non-pass | after non-pass | pass→non-pass | non-pass→pass |
| --- | ---: | ---: | ---: | ---: |
| standalone (`ctl-{before,after}-standalone.log`) | 210 | 189 | **0** | **21** |
| host (`ctl-{before,after}-host.log`) | 202 | 180 | **0** | **22** |

Other gates, all on the final tree: `node scripts/equivalence-gate.mjs` — 22
failing / 1,720 passing / 22 known-failures, **no new regressions**;
`pnpm run check:ir-fallbacks` — OK, no unintended/post-claim/module-level
increase; loc/func/coercion/oracle-ratchet/dead-exports/biome/typecheck green.

#### The measured exclusion: `async` METHODS are not widened

**The first cut of this slice regressed 16 rows (standalone) / 20 (host)** —
`dflt-params-arg-val-undefined.js` and `dflt-params-trailing-comma.js` in
exactly four lanes: class `async-method`, `async-method-static`,
`async-gen-method`(`-static`), and the object-literal `async-meth`. Only the
2,370-row control saw it; the 42-row manifest did not contain a single one of
those rows, and the probe shapes all passed.

Root cause, as far as it was bisected: an async method's callable value is a
cached singleton trampoline (`closures/method-trampolines.ts`) whose wrapper
signature is derived from the method signature at the first `C.prototype.m`
access and rebuilt at finalize by the #1669 `pendingMethodTrampolines`
enrolment. With the slot widened, invoking the method **through the extracted
reference** stops applying the parameter defaults —
`new C().m(undefined)` is correct, `var ref = C.prototype.m; ref()` is not
(`.tmp/w6651C3/p13.src.js`; base OK, widened THROWS). Reverting only the read
guard does not change it, so it is the widening reaching that lane, not the
narrowing guard.

That is a defect in the trampoline's signature rebuild, not in the widening —
async FUNCTIONS, async ARROWS, sync methods and generator methods all take the
widening and gain. `isAsyncMethodParam` in `type-mapper.ts` excludes the one
lane; it keeps every measured gain and costs the four async-method
`*-arg-val-not-undefined` rows, which stay on their pre-existing failure.
**Remove that clause together with a fix to `finalizeMethodTrampolines`, and
re-run this same control** — it is the only thing that catches the class.

#### Residuals in the manifest (28)

| rows | signature | owner |
| ---: | --- | --- |
| 10 | `SameValue(«NaN», «undefined»)` — `dstr/*dflt-obj-ptrn-prop-ary` | the NESTED-pattern default, one level inside the parameter: the binding element's slot, not the parameter's. `resolveBindingElementType` widens only elements WITHOUT a default; the `{ x: [y = 7] = [] }` shape needs the same absence-of-information argument applied to a defaulted element. |
| 9 | `Cannot access property on null or undefined` — `params-dflt-ref-arguments`, `dstr/ary-ptrn-elem-ary-rest-init` | `arguments` bound in the PARAMETER scope (cluster I's B11 finding), and a rest-with-init element reading null. Unrelated to the slot. |
| 7 | `Cannot destructure 'null' or 'undefined'` — `dflt-ary-ptrn-elem-ary-empty-init` | same nested-default family as the 10 above. |
| 2 | `Cannot read properties of undefined (reading 'next')` — object-literal GENERATOR methods | pre-existing and independent: the reduced shape (`.tmp/w6651C3/p6.src.js`, an object-literal `*m()` with six defaulted params, `var ref = obj.m`) **fails on base too**. One of the two changed its SIGNATURE from `«0» vs «false»` to this, which is the slot fix landing on top of a different defect, not a new one. |

#### Two process notes

- The A/B swap script started out covering five of the six changed files; the
  "base" tree then imported an export that did not exist and a 45-minute
  control pass came back as 12 identical `SyntaxError`s. An all-error log is
  broken infrastructure, not a measurement — but it is only obvious if you
  look at the log rather than the counts line.
- The `--isolate` runner costs ~2–4 s/row; the in-process runner does 200 rows
  in ~216 s. For a DIFFERENTIAL control (same rows, same order, both passes)
  the in-process mode is sound and is what made a 2,370-row × 2-target ×
  before/after control affordable at all (~3 h).

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E2

- **Branch** `worktree-agent-a1920dd19b9b71c1e`, base
  `claude/es2015-test262-plan-54tooh` (`3769840fe0`, identical to `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a1920dd19b9b71c1e`.
  Engine for every run below: **QuickJS** (`JS2WASM_EVAL_ENGINE=quickjs`,
  artifact `073742801ba7`, adapter `d4799bda84cfed0d`) — so the 22
  detached-buffer rows E1 could not measure at all WERE scored this time.

- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt` (144 rows,
  E1's 13 included), `--standalone`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/before/`, base tree) | 13 | 130 | 1 |
  | after (`.tmp/6651/after2/`) | **19** | 124 | 1 |

  Per-row set diff (`.tmp/6651/manifest-diff.txt`): **6 non-pass → pass, 0 pass
  → non-pass.** The before side reproduces E1's isolated result exactly
  (13 pass), which is what licenses the cheaper chunked lane used here.

#### What landed — ONE mechanism: the own-property SURFACE of a dynamic view

`ta-dyn-mop.ts` (#3177) gave `$__ta_dyn_view` its §10.4.5 arms for
`[[Get]]/[[Set]]/[[HasProperty]]/[[Delete]]/[[DefineOwnProperty]]/
[[GetOwnProperty]]/[[PreventExtensions]]`. It did **not** touch the natives
that answer the *reflective* own-key questions, and a `$__ta_dyn_view` is a
`$__vec_base` subtype (#3057) — so each of them answered **as if the view were
an Array**. Measured on this branch's base (`.tmp/6651/p2.js`, `.tmp/6651/p4.js`,
Float64Array, one string expando + one symbol expando):

```
Reflect.ownKeys(sample)                     0,1,2,length      spec: 0,1,2,test262,@@s
Object.getOwnPropertySymbols(sample).length 0                 spec: 1
hasOwnProperty.call(sample, 0)              false             spec: true
hasOwnProperty.call(sample, "foo")          false             spec: true
```

Two independent errors in one answer: `"length"` reported as an OWN key (it is
an accessor on `%TypedArray%.prototype`, §23.2.3.19, never own), and the view's
own expandos invisible because the generic vec arm does not know the side-table
exists. The predicates were worse — a uniform `false`, including for a valid
integer index.

The blast radius was **not** key listings. `propertyHelper.js`'s
`verifyNotConfigurable` deletes the key and then asks `hasOwnProperty` whether
it survived; a blanket `false` reads as "it was configurable after all". That
is how `internals/DefineOwnProperty/key-is-symbol.js` failed with *"Expected
obj[102] NOT to be configurable, but was"* while the descriptor it had just
defined round-tripped `w=false e=false c=false` correctly (`.tmp/6651/p3.js`).
The same helper's `verifyEnumerable` runs a `for…in`, which is a THIRD native
(`__object_keys_forin`) that #3177 never touched at all.

New module `src/codegen/ta-dyn-own-keys.ts` (`fillTaDynViewOwnKeyArms`), one
emitter per shape, spliced at finalize AFTER `fillVecLengthDynamicArms` (whose
vec own-`"length"` arm sits in the same natives) and after
`fillTaDynViewMopArms`:

1. **Own-ness predicates** — `__hasOwnProperty`, `__object_hasOwn`,
   `__propertyIsEnumerable`: canonical index → §10.4.5.14 IsValidIntegerIndex
   (`__ta_dyn_has_idx`); any other key → the expando side-table by recursive
   self-call. One body serves all three: an existing integer-indexed element is
   always enumerable (§10.4.5.1 builds its descriptor with
   `[[Enumerable]]: true`), and a non-index key's enumerability IS the
   expando's answer.
2. **`__getOwnPropertyNames`** — a FRESH vec of the indices, then the expando's
   own string keys in creation order. Building fresh instead of falling through
   is what removes the spurious `"length"`.
3. **`__object_keys` / `__object_keys_forin`** — same emitter, with
   `__object_keys(expando)` as the delegate because that delegate carries the
   enumerability filter. #3177's narrower indices-only `__object_keys` arm is
   **deleted** from `ta-dyn-mop.ts` in the same change-set rather than shadowed;
   two arms racing for the front slot of one native is worse than one.
4. **`__getOwnPropertySymbols`** — the expando's symbols, or a fresh empty vec.

Plus one seam in `ta-dyn-mop.ts` that the same tests exposed:

5. **Observable ToNumber on an element write** (`__ta_dyn_set_elem`). It called
   `__unbox_number` directly, which answers NaN for an ordinary object without
   ever running its `valueOf` — so §10.4.5.16 step 1 was not observable and
   `Object.defineProperty(view, 0, {value: {valueOf(){throw}}})` completed
   silently. Now `__to_primitive(v, "number")` runs first. That is the shared
   coercion native doing the work, i.e. one hand-rolled shortcut REMOVED.

**Why a new module rather than the obvious place:** `ta-dyn-mop.ts` is a
tracked god-file at its LOC ceiling and `fillTaDynViewMopArms` is already a
966-line unit. Net effect of the split: `ta-dyn-mop.ts` **shrinks by 53 lines**,
`src/codegen/index.ts` grows by 6 (import + one call site per entry point).

#### Receipts

- **Neighbourhood control** — 1,213 rows (`.tmp/6651/control-targeted.txt`),
  `--standalone`, before vs after, identical 24-row chunking on both sides
  (`.tmp/6651/ctl24-{before,after}/`). Selection: every row under
  `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView}/**` whose
  SOURCE can reach a changed native (own-key / own-ness / enumeration
  vocabulary, or an element write whose value is not a bare numeric literal),
  plus the whole E manifest. pass **824 → 846**. Per-row set diff
  (`.tmp/6651/ctl24-diff.txt`): **0 pass → non-pass**, 22 non-pass → pass — the
  6 manifest rows, their BigInt twins, and six rows outside the ES2015 manifest
  (`internals/Set/{tonumber-value-throws,tonumber-value-detached-buffer,
  detached-buffer}`, `OwnPropertyKeys/integer-indexes-resizable-array-buffer-*`).
  - **Chunk size is load-bearing for THIS family, and the first control run
    proved it the hard way.** A 60-row in-process chunk reported 16 `pass →
    non-pass` rows and ZERO gains; every one was realm poisoning, not a
    regression — `internals/OwnPropertyKeys/not-enumerable-keys.js` read `fail`
    inside a 60-row chunk on BOTH sides while passing when probed alone. These
    tests install accessors on `TA.prototype` and `%TypedArray%.prototype` by
    design. Re-running both sides at 24 rows (the size the manifest runs use,
    and the size whose before-side reproduces E1's isolated numbers) turned the
    same comparison into 22/0. Treat a chunked verdict in this directory as
    provisional until the chunk size is pinned to a known-good one.
- **Byte-level blast radius** (`.tmp/6651/sha-{before,after}.txt`, 9 programs ×
  2 targets): the 4 standalone programs that dynamically construct a view
  differ; the 5 standalone programs that do not (plain object keys, plain array
  keys, plain `hasOwnProperty`, plain `for…in`, a STATIC `Int8Array`) are
  **byte-identical**, and **all 9 host-lane binaries are byte-identical**. The
  arms are `ref.test $__ta_dyn_view`-gated and only exist where the dyn-view
  type is registered, so this is the whole reachable set, not a sample.
- **Unit tests**: new `tests/issue-6651-e2-ta-own-keys.test.ts`, 8 cases. Each
  asserts a FULL key list or an exact predicate answer (both halves of the
  defect were answers of the right SHAPE), and the comparison runs INSIDE the
  module returning a number — a standalone module's strings are WasmGC arrays
  with no host-readable form, so returning one and comparing on the host reads
  `{}` for every case, pass or fail. Verified to FAIL on the base tree: 5 of the
  6 positive cases fail there, both negative controls pass on both trees
  (`.tmp/6651/unit-base.log`).
- **Gates**: loc-budget, func-budget, coercion-sites, oracle-ratchet,
  dead-exports, `check-compiler-boundaries --mode inventory`, `typecheck`,
  `biome lint`, and `scripts/equivalence-gate.mjs` (22 failing / 1,720 passing,
  no new) all pass. Grants added to this file's frontmatter: `index.ts` +6 LOC
  (+4 / +1 in the two generators), and coercion-sites for `ta-dyn-mop.ts`
  (the `__to_primitive` routing) and `ta-dyn-own-keys.ts` (the
  CanonicalNumericIndexString pair, MOVED from the deleted arm).

#### Residual buckets in the 144-row manifest (125 non-pass), re-measured

| rows | sub-bucket | why it is still open |
| ---: | --- | --- |
| 7 | `internals/Set/*` — receiver-aware `[[Set]]` | `__reflect_set` is a THREE-argument native `(obj, key, value)`; §10.4.5.5 / `Reflect.set(target, key, v, receiver)` needs the Receiver and the §10.1.9.2 OrdinarySetWithOwnDescriptor cascade over it. Not an arm — a fourth parameter plus a protocol |
| 3 | `internals/OwnPropertyKeys/{integer-indexes,integer-indexes-and-string-keys,integer-indexes-and-string-and-symbol-keys-}` | **the own-key answer is now correct** for all three; each then dies on an UNRELATED defect one line later: `new TA(makeCtorArg(4)).subarray(2)` — a method call whose receiver is a `new` EXPRESSION — evaluates to `null`. `emitDynViewSpeciesMethodTwoArm` / `emitDynViewMethodTwoArm` both open with `if (!ts.isIdentifier(receiverExpr)) return undefined`, and the else-arm recompiles the whole call (so a side-effecting receiver would be evaluated twice) — that restriction is load-bearing and lifting it is its own slice. Measured: two-step `var a = new TA(4); a.subarray(2)` works and answers `0,1` |
| 9 | `TypedArray/from/*` error propagation + 11 `TypedArrayConstructors/{from,of}/*` | needs `%TypedArray%.from` / `.of` as first-class inherited function VALUES (`TA.of === TypedArray.of`, `TA.of.call(ctor, 42)` → `Construct(ctor)`). Today `TA.of` reads `undefined` and `of/custom-ctor-returns-other-instance` reaches a refusal closure. An intrinsic-static-method mechanism, not an arm |
| 5 | `ctors/object-arg/throws-setting-obj-*` | **E1's root cause is superseded — the static carrier's expando table is NOT the blocker.** Measured (`.tmp/6651/p10.js`): `var s = new Int8Array(1); s.foo = 7; s.valueOf = fn` reads back `7` and `"function"` on a STATIC carrier, so the side-table exists and works. The single remaining gap is `__to_primitive`: `Number(s)` answers `0` and `s + 0` answers `"00"` for BOTH static and dynamic views, i.e. it still reduces through `Array.prototype.toString` and never runs OrdinaryToPrimitive. One arm in the `carrier-to-primitive.ts` style (§7.1.1.1 cascade for the view carriers) should take all five; it was left out here because `__to_primitive` is a hot shared native and the honest control for it is corpus-wide, not TypedArray-shaped |
| 5 | `ctors/object-arg/iterator-*` | unchanged from E1: the ctor argument is a CALLABLE (`function(){}`), neither `$Object` nor a vec, so dispatch falls to the count form and never consults `@@iterator` |
| 22 | detached-buffer cohort | now MEASURED under QuickJS rather than unmeasurable — and still failing; they are real gaps, not environment |
| 9 | `prototype/toLocaleString/*` | needs per-element `Invoke(element, "toLocaleString")`; a user `Number.prototype.toLocaleString` override is not honoured even on a direct call |
| rest | `Object.prototype.toString` (#4119, cluster H), species-ctor `this`, `{filter,map}` callback receiver IDENTITY, DataView proto identity, `%ArrayIteratorPrototype%` results | each its own mechanism, unchanged from E1's table |

**Not attempted in this slice, deliberately:** the four buckets above that need
a mechanism each (receiver-aware `[[Set]]`, the `from`/`of` intrinsics, the
`__to_primitive` carrier arm, the non-identifier receiver). The brief's rule was
to land one mechanism FULLY with receipts before starting the next; the own-key
surface is that mechanism, and each of the four is comparable in size to it.

### 2026-09-21 — Cluster B (RegExp `@@` protocol, standalone), slice B2: the observable `RegExpExec` substrate

- **Branch** `issue-6651-cluster-B2-regexp-exec`, based on
  `claude/es2015-test262-plan-54tooh` @ `16ae7ce977` (origin/main + A2 + C3 + E2).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a3fef6f654cd4d90a`.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt` **minus B1's 7
  landed rows** = 140 rows, sha256
  `c75f3f64b702b062778703d26ba3e71d08f7aa86fa7822c954ebc7b2cb3e33c1`. The
  subtraction was not taken on trust: the full 147-row file was re-measured on
  this source-clean base and came back **7 pass / 129 fail / 11 compile_error**,
  exactly B1's published after-state, and the 140 non-pass rows ARE the manifest.
- **Engine**: `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`, adapter
  key `d4799bda84cfed0d`), `--standalone --isolate`, 64-row chunks, one runner
  at a time. B1's 7 `cross-realm` / `proto-from-ctor-realm` rows are measured
  here rather than reported unmeasurable.

#### What of draft PR #5393 was carried

#5393 (`codex/5198-regexp-exec-slice-b-checkpoint-20260901`) was fetched and
read. Its delta against the `main` it last merged is **two files and no
production source**: `plan/issues/5198-…md` (+232) and
`tests/issue-5198-es2015-regexp-r2.test.ts` (+35). So there was no
implementation to integrate — the branch is a *contract* checkpoint, and
deliberately so: its own audit records that it would make "no production-source
edit" until an unmerged result-carrier candidate was reconciled, and the
reconciliation that followed concluded **"do not reapply b85"** because the
bundle was already an upstream ancestor.

What it does own, and what this slice takes from it:

1. **The pre-loop contract**, stated as a boundary: one helper performing
   `Get(rx, "exec")`, calling a callable override with `rx` and the coerced
   string, propagating getter and call abrupt completions, rejecting only
   non-object non-null results — and explicitly NOT reading `index`, `length`,
   captures, flags or replacement data, because those are C1-C4. The module
   header of `src/codegen/regexp-exec-protocol.ts` implements exactly that
   boundary.
2. **Its 11-row census** (1 pass / 10 fail on `7fff`), which named the `@@match`
   / `@@replace` / `@@search` custom-`exec` rows. Every one of those 11 is in
   this slice's manifest and its recorded status matches what was measured here
   three weeks later, which is a useful independent confirmation that the
   failure is structural rather than drifting.
3. Its warning that `built-ins/RegExp/prototype/Symbol.search/
   cstm-exec-return-invalid.js` **passes for the wrong reason** — its expected
   TypeError was being produced by the incompatible-receiver path, not by a
   verified custom-exec result check. That row is still `pass` after this slice,
   now for the right reason, and it is a control rather than a claim.

#### The defect, and why the two biggest buckets are one bucket

`recoverRegExpStructFromExternref` is the standalone RegExp brand check, and it
ran as the **first instruction of every reflective `RegExp.prototype.*` body**.
That is correct for `.test`, `.exec` and the flag getters, and wrong for the
four `@@` methods: §22.2.6.8/.11/.12/.14 step 2 requires only `Type(rx) is
Object`, and the brand requirement appears later — in §22.2.7.1 **RegExpExec
step 5**, reached only when `exec` is *not* callable.

So `RegExp.prototype[Symbol.search].call({exec: f}, s)` is spec-legal and the
compiler answered `TypeError: Method called on incompatible receiver` before
`f` could ever run. That is why the residual table's 18 `brand check failed`
rows and its 19 `Expected a Test262Error but got a TypeError` rows are not two
buckets: they are the same ordering defect, observed one step apart. The brand
check is not deleted by this slice — it is **moved to where the spec puts it**,
with the identical message, so a genuinely wrong `this` with no `exec` still
reports exactly what it reported before (pinned by a control).

#### What changed

One new module, `src/codegen/regexp-exec-protocol.ts` (~330 LOC), plus a 47-line
arm in `emitRegExpProtoMemberBody`. **No new host import** — the emitted code is
built from natives the standalone object runtime already exports
(`__extern_get`, `__extern_set`, `__extern_toString`, `__is_callable`,
`__typeof_object`, `__same_value_zero`, `__box_number`, `__unbox_number`,
`__objvec_new/push`, `__apply_closure`, `__str_indexOf`).

The module is the substrate plus the two method bodies whose spec text consumes
the exec result trivially:

- **`buildRegExpExecInstrs`** — §22.2.7.1, emitted once and inlined at each call
  site. Its builtin arm (steps 5-6) is passed in as a callback, so the module
  knows nothing about the `$NativeRegExp` struct and stays usable from any
  receiver shape.
- **`emitRegExpSymbolSearchBody`** — §22.2.6.12 in full: the two `lastIndex`
  `Get`s, the two conditional `Set`s, the exec, and `Get(result, "index")`.
- **`emitRegExpSymbolMatchBody`** — §22.2.6.8 steps 1-5 in full (step 5's
  non-global arm *is* `return RegExpExec(rx, S)`), plus a deliberately PARTIAL
  global arm: it performs step 6's observable prefix — `Set(rx, "lastIndex",
  +0)` and the first `RegExpExec` — and then answers `null`, which is what this
  closure answered before the change (its body was a `ref.null.extern`
  placeholder). The collect loop needs a runtime Array and AdvanceStringIndex;
  that is a second mechanism and it is recorded as a residual below rather than
  approximated.

Three things the implementation had to get right, each measured rather than
assumed:

1. **`SameValue`, not `SameValueZero`.** `__same_value_zero` is the only
   ready-made comparator, and it differs from §7.2.10 on exactly one input:
   `±0`. §22.2.6.12 steps 5 and 8 compare `lastIndex` against `+0` and against
   its own previous value, and two rows hinge on the difference
   (`set-lastindex-init-samevalue` writes `-0` and requires the `Set` to happen
   anyway; `set-lastindex-restore-samevalue` requires the restore). The
   correction is `1 / x < 0` on the already-proven-numeric operands — no
   `i64.reinterpret_f64`, no extra local.
2. **`Type(x) is Object` needs two natives, not one.** `__typeof_object`
   implements `typeof`, and `typeof null === "object"` — under the #2106
   singleton regime it answers 1 for a null externref. A receiver test that
   trusted it alone would admit `.call(null)`, which `this-val-non-obj` requires
   to be a TypeError. The null test comes first and separately, and the same
   ordering makes RegExpExec step 4.b correct for `undefined` (a tagged
   singleton, not null, so it lands in the throw arm).
3. **The builtin arm must be emitted and spliced out BEFORE any further index is
   read.** The builtin lowering registers late imports, and a late import shifts
   every defined-function index at or above it. `flushLateImportShifts` rewrites
   what is still in `fctx.body` — it cannot rewrite indices already captured in
   a JS object. So the resolved-natives record is **re-resolved after** the arm
   is captured (the #2043 late-shift class, in its easiest-to-miss form).

#### Receipt — manifest

| 140 rows, `--standalone --isolate`, QuickJS | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/B2-before.log`) | **0** | 129 | 11 |
| after (`.tmp/6651/B2-after.log`) | **10** | 119 | 11 |

**+10 rows pass; every one of the other 130 rows keeps its EXACT status.** The
two logs were joined row-by-row, not compared by count: no `fail` became a
`compile_error` and none the other way, and the compile_error total is
unchanged at 11. The ten:

| row | what it pins |
| --- | --- |
| `@@search/cstm-exec-return-index` | a custom `exec` runs on a non-RegExp receiver and its result's `index` is returned |
| `@@search/match-err` | the custom `exec`'s abrupt completion propagates, and `lastIndex` is NOT restored after it |
| `@@search/get-lastindex-err` | step 4's `Get` is real and its getter can throw |
| `@@search/lastindex-no-restore` | exactly TWO `lastIndex` reads, and the restoring `Set` is conditional |
| `@@search/set-lastindex-init` | step 5's `Set` actually runs, before `exec` |
| `@@search/set-lastindex-restore` | step 8's `Set` actually runs |
| `@@search/success-get-index-err` | step 10's `Get(result, "index")` is real |
| `@@match/this-val-non-regexp` | the brand-check widening, both halves in one row |
| `@@match/get-flags-err` | step 4's `flags` Get precedes everything; `global`/`unicode` are not read |
| `@@match/g-get-exec-err` | the partial global arm still performs its `Set` and its first RegExpExec |

The bucket movement in the residual signatures corroborates the diagnosis
rather than just the count: `Method called on incompatible receiver (RegExp
brand check failed)` went **18 → 13** and `Expected a Test262Error but got a
TypeError` went **19 → 13**, i.e. both halves of the same ordering defect
shrank together.

#### Controls — zero pass → non-pass

The blast radius is bounded by construction: the changed code is the body of
the `RegExp.prototype[@@match]` / `[@@search]` reflective closures, reachable
only from a program that READS one of those members. The 2,280-row universe
(`built-ins/RegExp/**` + `annexB/built-ins/RegExp/**` +
`built-ins/String/prototype/{match,matchAll,replace,replaceAll,search,split}/**`)
was therefore filtered to rows whose source mentions `Symbol.match` /
`Symbol.search` / `@@match` / `@@search` (157) — sound because **no row in the
2,280 includes `wellKnownIntrinsicObjects.js`**, the only harness file that
mentions those symbols, checked rather than assumed — plus a module-VALIDITY
canary of every third `prototype/{exec,test,flags,source,lastIndex,toString,
global,sticky,unicode}` row, because the closure bodies are emitted whenever
the RegExp proto glue is registered even if never called. Minus this slice's
own manifest rows, that is **167 control rows** (sha256
`2aa9d2bdbc76a1e7da1966b0e6a64d0cd889f81cff002c1d1f8fc9406469c2b1`).

| lane | rows | result |
| --- | ---: | --- |
| standalone, after (`.tmp/6651/ctrl-after.log`) | 167 | 114 pass / 35 fail / 18 compile_error |
| standalone, before — the **53 non-pass-after rows**, re-run on a `cp`-reverted `regexp-standalone.ts` (`.tmp/6651/ctrl-before.log`) | 53 | 35 fail / 18 compile_error, **0 pass**, and every row's status IDENTICAL to its after status |
| host — compiled-binary sha256 of 9 representative programs | 9 | **all 9 byte-identical** (`.tmp/6651/hostsha-{before,after}.txt`) |
| standalone — the same 9 programs | 9 | **7 byte-identical**; only `reflective-search` and `reflective-match` differ — the two admitted shapes (`.tmp/6651/sasha-{before,after}.txt`) |

The 53-row before-side is a **complete** check, not a sample: a pass→non-pass
regression is by definition a row that is non-pass AFTER, so running only those
53 on the base covers every candidate while costing a third of a full A/B.

Also green: `npm run -s typecheck`; `npx biome lint src tests scripts`; the five
ratchet gates (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); the boundaries inventory
(`check-compiler-boundaries --mode inventory`, with the new module classified);
`scripts/equivalence-gate.mjs` (22 failing / 1720 passing, all 22 in the
committed baseline); B1's `tests/issue-6651-string-symbol-protocol.test.ts`
(9/9); and the new pin suite `tests/issue-6651-regexp-exec-protocol.test.ts`
(13/13 — the 10 rows plus 3 controls).

One late correctness fix landed AFTER the measurement and is proved not to
invalidate it: `emitRegExpSymbolMatchBody`'s `__str_indexOf` availability check
was moved ahead of its first `fctx.body.push`, because a body that declines
half-emitted leaves the operand stack unbalanced and makes the whole module
fail to validate. The guard is unreachable in practice (the helper is
registered by `prepareRegExpExecProtocol` itself), and the binary-sha control
confirms it: all 18 programs compile byte-identically before and after the
move.

#### Residual buckets (130 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 31 | `@@split` | §22.2.6.14 generically: **SpeciesConstructor** (9 rows are `species-ctor-*`, 6 of them the `Object_set_constructor` compile error — a `constructor` write on a plain object), the sticky splitter walk, and generic result reads. 21 of the 31 are the `RegExp.prototype[@@split].call(…)` shape, so they sit directly on this slice's substrate. #5198 Slice C4/E. |
| 30 | `@@replace` | §22.2.6.11's result loop: `Get(result, "0"/"index"/"length"/n)` with their coercions (14 rows are exactly `result-{coerce,get}-*`) plus **GetSubstitution**. #5198 Slice C3. |
| 20 | `@@match` | the GLOBAL collect loop this slice deliberately left partial — a runtime Array plus AdvanceStringIndex — and the 4 `exec-*` rows, which use the DIRECT `r[Symbol.match](s)` spelling (see below). |
| 13 | RegExp constructor / statics | observable `IsRegExp`, the called-as-function short-circuit, ordered `source`/`flags` Gets. #5198 Slice E. |
| 7 | `prototype/compile` | Annex B `compile` ordering and its SyntaxError/TypeError shapes — untouched by this slice. |
| 6 | `@@search` | 4 are the DIRECT spelling (below); 2 are `set-lastindex-{init,restore}-err`, which need a strict-mode `[[Set]]` on an accessor with **no setter** to throw a TypeError. `__extern_set` silently no-ops there — an object-runtime gap, not a RegExp one. |
| 5 | `prototype/flags` | the **generic** `flags` getter (accept any Object, ordered `ToBoolean(Get(R, …))`). #5198 Slice F; fails on host too. It also blocks `@@match/get-global-err`, which poisons `global` on a real RegExp and needs the flags GETTER to read it. |
| 18 | assorted: `String.prototype.{search,split,match,indexOf,replace}` (10), the individual flag getters `global`/`ignoreCase`/`multiline`/`sticky`/`unicode`/`source` (6), `prototype/exec` (2) | each its own mechanism, unchanged from B1's table. |

**The single largest lever left, and it is one mechanism:** the DIRECT spelling
`re[Symbol.search](s)` / `r[Symbol.match](s)` does NOT reach the reflective
closure — `tryCompileStandaloneRegExpSymbolCall` answers it from the static
native core, which never consults `exec`. That is why
`@@match/exec-{err,invocation,return-type-invalid,return-type-valid}` and
`@@search/{coerce-string,coerce-string-err,set-lastindex-init-samevalue,
set-lastindex-restore-samevalue}` are still red **even though the substrate
that would answer all eight now exists**. Routing that spelling through the
reified `RegExp.prototype[@@x]` method value (`__apply_closure`) is the next
slice, and it is the same change B1's residual table wanted for its 3
`invoke-builtin-*` rows. It needs a gate — the call's result type becomes
externref — so the gate should be a whole-file predicate ("this program writes
`exec`/observes the protocol"), which keeps `"abc".search(/b/)` byte-identical.

**Not attempted in this slice, deliberately:** the `@@replace` and `@@split`
bodies. The brief asked for the substrate as ONE mechanism used by all four
methods; it is one module, and it is wired into the two methods whose spec text
consumes the exec result trivially (`@@search` reads one property, `@@match`
non-global returns it by identity). `@@replace` and `@@split` consume the
result through loops that are each comparable in size to this whole slice, and
wiring them to the substrate *without* their loops would replace a wrong answer
with a differently wrong answer — so the substrate is published with its two
honest consumers and the loops are named above with their row counts.

### 2026-09-21 — Cluster D (native Promise combinators), slice D2: the observable intrinsic protocol

- **Branch** `worktree-agent-a0aff283c2b48c5f9`, **base** `claude/es2015-test262-plan-54tooh`
  at `a61c2d41b4` (= `origin/main` + slices A2 + C3). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a0aff283c2b48c5f9`. Engine for every
  measurement below: `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`,
  adapter `d4799bda84cfed0d`), runner `--standalone --isolate`.

- **What of PR #5883 was carried.** The held upstream PR
  ([#5883](https://github.com/loopdive/js2/pull/5883), commit `6e684e2950`
  "fix(promise): preserve observable resolve combinator protocol", Codex lane,
  #5197 R3-2) was fetched and **integrated, not re-derived** —
  `git cherry-pick -n 6e684e2950`. Four of its five files applied clean:
  `builtin-write-keeps.ts` (+99: `isStandaloneIntrinsicPromiseResolveWriteTarget`,
  the declaration-level proof that the `Promise.resolve = …` receiver is the
  unshadowed intrinsic), `declarations.ts` (+16: keep that write as a
  source-ordered module-init statement), `call-namespace-static.ts` (+53: the
  `sourceHasMethodOverride`-gated `observableResolve` admission plus the
  observable-only f64-vec arm), `promise-combinators.ts` (+931: the whole
  §27.2.4.1.1/§27.2.4.3.1 Get/Call/Invoke pipeline, the
  `$__combinator_all_resolve_cap` element-function carrier, and the
  literal/direct-vector emitters). Its 450-line control file
  `tests/issue-5197-promise-observable-combinator-r3-2.test.ts` came with it.
  ONE conflict, in `emitStandalonePromiseCombinatorRuntime`: main has since
  refactored that function's locals onto `buildNativeAllProviderLocals` +
  `buildNativePromiseCombinatorVectorBody` (the #5883 branch predates it).
  Resolved in favour of **main's** shape, keeping #5883's widening of `opts`
  (`notIterLocal`/`rejectReason` became optional so the observable flags can
  share the bag) and narrowing the pair back at the legacy vector body's call
  site — that body only ever understood the (#2922) not-iterable rejection
  pair, and widening its contract would have been the wrong direction.
  Nothing D1 already superseded was reapplied: the custom-constructor
  `.call(C, …)` protocol stays entirely in `promise-custom-combinator.ts`, and
  the observable gate explicitly excludes a Promise-subclass receiver.
  The port also flipped #5197's frontmatter to `in-progress`; that is reverted
  here — #5197 is `done` on `main` and its LOC/func grants (which this
  change-set relies on, and which live in a file this change-set touches, so
  they are not stranded) are unaffected by the status field.

- **Manifest** `plan/agent-context/6651/D-promise-combinators.txt` (101 rows),
  re-measured on this branch's own source-clean base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/D2-before.log`) | 26 | 57 | 18 |
  | after (`.tmp/6651/D2-after-s1.log`) | **47** | 40 | 14 |

  **+21, zero regressions** (per-row set diff: 21 non-pass → pass, 0 pass →
  non-pass). The 21: `{all,race}/invoke-resolve{,-get-error-reject,-get-once-multiple-calls,-get-once-no-calls,-on-promises-every-iteration-of-promise,-on-values-every-iteration-of-promise}`,
  `{all,race}/invoke-then{,-error-reject,-get-error-reject}`,
  `all/invoke-resolve-error-reject`, `all/resolve-not-callable-reject-with-typeerror`,
  `race/resolve-prms-cstm-then`. One fail→fail row changed its message
  (`race/resolve-self.js`: "called value is not a function" → "async completion
  marker not observed"); every other shared failure reports byte-identical text
  before and after.

- **Neighbourhood control** — all 729 `built-ins/Promise/**` rows, `--standalone
  --isolate`, 183-row chunks (`.tmp/6651/neigh-after-0{0,1,2,3}.log`):
  **pass 421, fail 174, compile_error 134**. The before lane was then run on the
  **308 rows that are non-pass AFTER** (`.tmp/6651/neigh-before-0{0,1}.log`,
  154-row chunks, base restored by file-copy A/B) — that is exactly the set in
  which a regression could hide. It scored **0 pass / 174 fail / 134 CE**:
  every row that does not pass now did not pass before either, so
  **pass → non-pass is 0 across the full 729**. (Stated precisely rather than as
  a headline delta: a full before lane over all 729 was not run, because a row
  that passes after cannot be a regression.)

- **Host (gc) lane — byte identity, not a run.** D1's finding stands: the
  non-isolated host run of `built-ins/Promise/**` poisons the runner's own realm
  and cannot be used as a control. Substituted an 8-program sha256 corpus
  (`.tmp/6651/bytes-{before,after}.txt`, `.tmp/6651/bytes.mts`): intrinsic
  `all` literal / `race` over a vec / `allSettled` / `any`, a `.then` chain, the
  D1 custom-constructor `.call` shape, and the two OBSERVABLE shapes
  (`Promise.resolve = fn` + `Promise.all([1,2])`; an own-`then` element +
  `Promise.race`). Result: **8/8 gc binaries byte-identical**; on standalone
  **exactly the 2 observable programs move** and the other 6 are byte-identical.
  That is the intended delta, stated as bytes: a module that cannot observe
  `resolve`/`then` compiles to the same wasm it did before.

- **Unit controls.** `tests/issue-5197-promise-observable-combinator-r3-2.test.ts`
  13/13 and `tests/issue-6651-promise-custom-combinator.test.ts` 8/8 and
  `tests/issue-4682.test.ts` 3/3 pass. The 3 failures in
  `tests/promise-combinators.test.ts` (2 × 35 s timeout) and
  `tests/issue-2671-promise-capability.test.ts` are **pre-existing**: the same
  three test names fail on the base tree with the source files reverted
  (`.tmp/6651/unit-{before,after}.log`).

- **Gates**: `check-loc-budget` (+913 promise-combinators, +99
  builtin-write-keeps, +39 call-namespace-static, +19 declarations — all
  granted by #5197's frontmatter, which this change-set modifies),
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`
  (getTypeAtLocation +0, ctx.checker +0), `check:dead-exports`,
  `check-compiler-boundaries --mode inventory --base origin/main` (no new
  module; `inventoryValid: true`), `npm run -s typecheck`,
  `biome lint src tests scripts --diagnostic-level=error`, and
  `scripts/equivalence-gate.mjs` (22 failing / 1,720 passing / 22 known — no new
  regressions) all pass.

**Residual buckets after D2 (54 non-pass of the 101 manifest rows):**

| rows | status | bucket | why it is still open |
| ---: | --- | --- | --- |
| 6 | fail | `{all,race}/invoke-{resolve,then}-{error,get-error}-close` | R3-4 interleaved iterator drive + IteratorClose — see the H1 finding below |
| 2 | fail | `{all,race}/invoke-resolve-get-error` | same drive: `Get(C,"resolve")` must throw BEFORE `GetIterator` is reached; today the argument is normalised first and the row rejects "argument is not iterable" |
| 4 | fail | `{all,race}/iter-step-err-reject`, `{all,race}/iter-next-val-err-reject` | same root cause (H1) — these do NOT trip the observable gate, so they stay on the legacy `__combinator_to_vec` drain |
| 2 | fail | `all/S25.4.4.1_A5.1_T1`, `race/S25.4.4.3_A4.1_T1` | same |
| 1 | fail | `all/capability-resolve-throws-no-close` | H1 on the custom-`C` `.call` path (D1's module) |
| 8 | CE | `{all,race,allSettled,any}/resolve-throws-iterator-return-*` | `class BadPromise {}` receiver — standalone has no `Construct(C, «executor»)` for a compiled class (#5197 G10) |
| 6 | CE | `{all,race,resolve,reject}/ctx-ctor`, `{all,race}/invoke-resolve-on-promises-every-iteration-of-custom` | `class X extends Promise` receiver (#5197 G9) |
| ~10 | fail | `prototype/then/{ctor-*,capability-executor-*,ctor-access-count,deferred-is-resolved-value}`, `prototype/catch/*` | #5197 R3-6 / R3-9 — SpeciesConstructor reads and GetCapabilitiesExecutor; untouched by this slice |
| rest | fail | `resolve-poisoned-then`, `resolve-thenable`, `race/resolve-self`, `resolve/arg-uniq-ctor`, `Object.prototype.toString` tag, `proto-from-ctor-realm` | #5197 R3-5 / R3-7 and #4119 |

**H1 is confirmed, and its mechanism is NOT what the hypothesis assumed
(this is the finding the next slice needs).** The hypothesis was that
`__call_@@iterator` is *blind* to a symbol-keyed `@@iterator` expando on an
`$Object`. Measured with two probes (`.tmp/6651/probe-h1.mts`,
`.tmp/6651/probe-h1b.mts`, both standalone, zero imports):

1. `iter[Symbol.iterator] = fn; Promise.all(iter)` rejects with
   "argument is not iterable" and calls `next()` **zero** times.
2. In the *same* module, `const f = iter[Symbol.iterator]; f.call(iter)` returns
   a working iterator and `typeof f === "function"`. A `for…of` over the same
   object also drives it correctly.
3. The compiled module exports **no `__call_@@iterator` at all**.

So the dispatcher is not blind — it is **not emitted**: `emitMethodDispatch`
only mints `__call_@@iterator` when some registered *struct* carries an
`@@iterator` member, and a plain `$Object` expando carrier registers none. With
the dispatcher absent, `fillCombinatorToVec` bails and leaves the eager
vec-only body, which answers null ⇒ "not iterable". The fix is therefore NOT in
the dispatcher: `[Symbol.iterator]` lowers to the reserved key string
`"@@iterator"` (literals.ts ~L3107), so `__extern_get(x, "@@iterator")` +
`__apply_closure` already sees the expando — or, better, the whole
`__iterator_strict` / `__iterator_next_strict` runtime
(`iterator-native.ts` L1515-L1606) already implements strict GetIterator with
getter/step/value abrupt propagation and is the substrate the drive should use.

**Two hard constraints the R3-4 drive must plan around (both measured here,
both absent from the R3-4 plan):**

- **Fixing H1 inside the LEGACY `__combinator_to_vec` would hang the six
  `*-close` rows**, whose `next()` never reports `done` — today they fail fast
  precisely because the iterator is never acquired. H1 must be fixed *inside
  the observable/interleaved drive only*, leaving the legacy drain untouched;
  that also keeps every non-observable module byte-identical.
- **`p.then` read as a VALUE off a native `$Promise` is not a function**
  (`.tmp/6651/probe-then.mts`: `typeof p.then === "function"` is **false**, and
  `t.call(p, …)` traps). That is #5197 R3-7, and it is why #5883's
  `buildNativeInvoke` keeps a `__combinator_subscribe` fallback for a native
  `$Promise` without an own `then`. A drive-mode `all` therefore cannot route
  every element through the generic Invoke, and `__combinator_subscribe` casts
  its `state` argument to the *immutable-field* `$CombinatorState`
  (`resultsArr` and `length` are `mutable: false` —
  `delay-combinator-layouts.ts::createNativeCombinatorStateShape`). An
  interleaved drive has no element count up front, so `all` drive mode needs a
  **new, additively-registered** mutable state struct plus its own
  resolve-element and subscribe bodies — roughly 300–400 lines of hand-built
  wasm. `race` drive mode needs none of that (its handlers are the capability's
  own resolve/reject), so **`race` is the cheap half and should be sliced
  first**. That sizing is why D2 stops here rather than half-landing it.

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
| G for-of / destructuring (follow-up PR) | 134 | 0 → 21 | +21 |
| I language misc (triage only, follow-up PR) | 114 | 0 → 0 | 0 |
| **sum** | | | **+150** |

These are manifest-row gains measured by each owner on their own base, not a
fresh full-suite census. The next authoritative number comes from the
`promote-baseline` run on `main` after #6023 (baseline
`test262-standalone-current.jsonl`); until then the honest statement is
"10,384 + ≤150 of 11,704".

G (for-of / destructuring / iterators, +21) and I (language misc, triage
only) landed after #6023 and ship in the follow-up PR together with this
handoff; their receipts are the two Cluster-status entries just above.

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
