---
id: 5197
title: "ES2015 standalone promise — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-03
loc-budget-allow:
  # 2026-09-01 (Slice B): the §27.2.1.3 settle closures gain the builtin-function
  # metadata carrier. Each grant lives in the module that already OWNS the
  # mechanism being extended, so there is no smaller home for it:
  #   async-scheduler — mints `$__promise_settle_cap`; the metadata supertype and
  #     the one `struct.new` factory the three mint sites share belong beside it.
  #   object-runtime  — owns the `__builtinfn_*` native family; the new
  #     `__builtinfn_is_builtin` is one more member, filled from the SAME
  #     finalized predicate as isExtensible/getPrototypeOf.
  #   new-super       — owns every `new`-site arm; §7.2.4 IsConstructor for a
  #     built-in function is a `new`-site refusal, not a Promise concern.
  - src/codegen/async-scheduler.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/new-super.ts
  # 2026-09-01 (Slice C): `Promise.prototype.catch`'s two-arm body and the
  # §27.2.5.4 IsPromise guard belong next to `emitPromiseProtoMemberBody`, the
  # only place that owns Promise-prototype member bodies; the calls.ts entry is
  # one enumerated brand arm beside the existing Number/Boolean twins.
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
  # 2026-09-02 (Slice D): the NewPromiseCapability protocol is generalized in
  # place rather than forked. `promise-combinators.ts` already owns the #4682
  # capability record, its GetCapabilitiesExecutor and the construct-then-
  # validate sequence; selecting `[[Resolve]]` vs `[[Reject]]` is one field
  # index inside that same emitter. `call-namespace-static.ts` already owns the
  # `Promise.METHOD.call(C, …)` admission gate; `reject`, the one-argument
  # spelling and a zero-parameter `C` are three widenings of that one gate, and
  # splitting them into a new module would leave the gate reading half its own
  # conditions from elsewhere.
  - src/codegen/promise-combinators.ts
  - src/codegen/expressions/call-namespace-static.ts
  # 2026-09-03 (r3 plan, steps R3-1..R3-10): every r3 step extends a mechanism
  # that already lives in one of these files, and the plan forbids forking a
  # second protocol beside it. Expected growth per step is stated in the step
  # itself; the totals are roughly:
  #   promise-combinators   ~+420 (R3-2 generic element pipeline + resolve-element
  #                          builtin-fn closures, R3-3 `.call(C, iter)` widening,
  #                          R3-4 interleaved iterator drive, R3-1/R3-9 executor)
  #   async-scheduler        ~+150 (R3-5 own-`then` capture in Resolve, R3-6
  #                          SpeciesConstructor read in `then`, R3-8 boolean box)
  #   call-namespace-static  ~+120 (R3-2 observable Get(C,"resolve") gate,
  #                          R3-3 admission widening — the gate IS the dispatch)
  #   closed-method-dispatch ~+60  (R3-5 bag-`then` arms in the two fills)
  #   calls.ts               ~+30  (R3-2 f64-vec boxing arm in the dynamic path)
  #   array-object-proto     ~+40  (R3-7 `p.then` value read → proto closure)
  #   property-access-dispatch ~+30 (R3-7, if the read site is there instead)
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  # 2026-09-01 (Slice B): one extra `registerNative` call in the object-runtime
  # reservation block, and two three-line guard call sites on the `new` path.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  # 2026-09-02 (Slice D): the widened `Promise.resolve/reject.call(C, …)`
  # admission is three extra conditions plus a missing-argument default inside
  # the ONE dispatcher that decides every `Namespace.static(...)` lowering.
  # The conditions ARE the dispatch decision, so extracting them would move the
  # gate's own predicate out of the gate.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  # 2026-09-03 (r3 plan): the four functions below are UNDER the 300-line
  # threshold today (measured at bee5ddd535: emitStandalonePromiseThen 250,
  # buildPromiseResolveValueBody 213, fillPromiseThenableHelpers 209,
  # emitStandalonePromiseCombinatorRuntime 166) and the r3 steps that extend
  # them (R3-6, R3-5, R3-5, R3-2/R3-4) may push each past it. The growth is one
  # more arm inside the SAME decision ladder (an own-`then` / own-`constructor`
  # bag consult before the native arm); pulling that arm out would split the
  # ladder's predicate from the ladder. Prefer a helper for any new body >40
  # lines (the plan names them: buildCombinatorElementStep,
  # buildCombinatorElemFnClosureInstrs, emitPromiseSpeciesConstructorRead); the
  # grant is for the residual in-place growth only.
  - src/codegen/async-scheduler.ts::emitStandalonePromiseThen
  - src/codegen/async-scheduler.ts::buildPromiseResolveValueBody
  - src/codegen/closed-method-dispatch.ts::fillPromiseThenableHelpers
  - src/codegen/promise-combinators.ts::emitStandalonePromiseCombinatorRuntime
priority: high
horizon: m
feasibility: hard
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
pr: 5292
---

# #5197 — promise r2: cluster and fix the residual promise-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5143, part of PR #5179) plus a
second pass that yielded only +5 (PR #5213, added
`src/codegen/promise-newtarget.ts`). The stopped r2 planning pass has now been
completed against exact upstream `main`
`b6adee3156e9642ed221174a69e6f6f1a381484f`.

The implementation branch was rebased onto upstream `main`
`02b7a33b58362ef16c703f29d687842066beaae1` on 2026-08-30 before fanout.
The intervening upstream changes are host-init marshalling, issue metadata, and
npm-compat artifacts; they do not replace the isolated evidence below. The
implementer must rerun Slice A on the rebased head before claiming a fix.

The force-refreshed maintained artifacts supplied 152 ES2015
`built-ins/Promise/**` rows whose standalone status was not pass. Every row was
rerun in a fresh child process through `runTest262File`, with two workers and
the QuickJS eval adapter present. Fresh standalone is **12 pass / 138 fail / 2
compile_error / 0 timeout / 0 skip**. Fresh host is **75 pass / 77 fail**.

Cross-lane classification is 64 standalone-fail/host-pass, one standalone-
compile-error/host-pass, 74 fail/fail, one compile-error/host-fail, ten
pass/pass, and two standalone-pass/host-fail. The last two host regressions are
`promise.js` and `undefined-newtarget.js`; they remain explicit controls even
though the authoritative completion target is standalone.

## Implementation Plan

### Fresh residual table

| Provider surface | Rows | Fresh standalone | Fresh host | Primary invariant |
| --- | ---: | --- | --- | --- |
| `Promise.all` | 46 | 1 pass / 45 fail | 10 pass / 36 fail | observable element pipeline and resolve-element closures |
| `Promise.race` | 35 | 1 pass / 34 fail | 11 pass / 24 fail | same element pipeline with shared capability functions |
| `Promise.prototype.then` | 16 | 1 pass / 15 fail | 11 pass / 5 fail | SpeciesConstructor and NewPromiseCapability |
| executor/resolve/reject function metadata | 15 | 0 pass / 15 fail | 13 pass / 2 fail | escaped synthesized closures must be real callable objects |
| `Promise.resolve` / `Promise.reject` | 14 | 2 pass / 12 fail | 13 pass / 1 fail | generic constructor capability and settlement identity |
| `Promise.prototype.catch` | 7 | 2 pass / 5 fail | 6 pass / 1 fail | generic `Invoke(this, "then", ...)` |
| constructor / settlement core | 6 | 2 pass / 4 fail | 5 pass / 1 fail | already-resolved guards and thenable job timing |
| `allSettled` / `any` iterator-close tail | 4 | 0 pass / 4 fail | 0 pass / 4 fail | shared abrupt-combinator iterator closing |
| arbitrary NewTarget/prototype | 3 | 1 pass / 2 CE | 1 pass / 2 fail | #3371 Reflect.construct NewTarget substrate |
| Promise prototype misc | 3 | 2 pass / 1 fail | 3 pass | canonical `@@toStringTag` |
| `Promise[Symbol.species]` | 2 | 0 pass / 2 fail | 2 pass | canonical species accessor value/descriptor |
| cross-realm prototype | 1 | 0 pass / 1 fail | 0 pass / 1 fail | realm-correct Promise prototype identity |

The two remaining compile errors are
`get-prototype-abrupt-executor-not-callable.js` (host passes) and
`get-prototype-abrupt.js` (host fails), both still refused by the documented
#3371 arbitrary-NewTarget boundary. The twelve fresh standalone passes remain
in the 152-row regression corpus; do not count them as new r2 yield.

### Implementation slices

Each completed slice is one separate mergeable upstream PR. A checkpoint that
only changes a compile error into a runtime failure is not a completed fix.

1. **Slice A — Promise symbol object model (3 rows).** Add the two
   `Promise/Symbol.species` rows and `prototype/Symbol.toStringTag.js` to
   `tests/issue-5197-es2015-promise-r2.test.ts`. Reuse the canonical builtin
   species accessor and native-prototype symbol-tag machinery; direct value
   reads and property descriptors must agree, with no Promise-specific fake
   object. Acceptance is standalone 3/3 and host 3/3.
2. **Slice B — synthesized promise callables (15-row metadata corpus).** Make
   executor, resolve, and reject functions escape as the repository's standard
   non-constructible callable carrier. They need `typeof === "function"`,
   `Function.prototype`, extensibility, own `length` then `name` descriptors,
   correct invocation arguments, and `new fn()` TypeError behavior. Apply the
   same substrate to combinator resolve-element functions rather than creating
   another representation.
3. **Slice C — generic catch/then capability.** Implement `catch` as observable
   `Invoke(this, "then", «undefined, onRejected»)` for arbitrary objects, then
   route native `$Promise.prototype.then` through ordered constructor/species
   Gets and NewPromiseCapability when those properties are observable. Keep the
   intrinsic unpatched fast path. Re-run the exact 23-row then/catch corpus,
   including its three already-passing controls.
4. **Slice D — generic Promise resolve/reject and settlement.** Generalize
   NewPromiseCapability for `Promise.resolve/reject.call(C, value)`, preserve
   constructor identity and already-resolved guards, and schedule custom
   thenables in the established microtask ring. Close the 12 static-method and
   four settlement-core failures without regressing the two host-only controls.
5. **Slice E — common observable combinator pipeline.** Build one shared
   provider for `Get(C, "resolve")` once, per-element Call, observable Get/Call
   of `then`, per-element interleaving, and IteratorClose on abrupt completion.
   It must compose the existing native thenable scheduler and the Slice-B
   callable carrier, not add host imports or drain the iterable before
   subscription.
6. **Slices F1-F3 — completed combinators separately.** Wire the common
   provider into `all`, `race`, then `allSettled`/`any`. A PR is complete only
   when its exact method corpus passes; preserve aggregate identity,
   remaining-element/once semantics, result ordering, and the method's shared
   resolve/reject function identity. Combine methods only when the same changed
   helper closes their full claimed corpora.
7. **Slice G — arbitrary NewTarget (2 rows), delegated to #3371.** Keep both
   rows in acceptance, but do not weaken Reflect.construct semantics or the
   diagnostic locally. Re-measure after #3371 supplies distinct-NewTarget
   prototype lookup and abrupt propagation.
8. **Slice H — cross-realm tail (1 row).** Close `proto-from-ctor-realm.js`
   through the canonical eval-realm Promise provider; never special-case the
   Test262 harness or treat the primary realm prototype as universal.

For every completed slice, run isolated exact host and standalone rows, the
other 152 rows as a regression sweep, already-green Promise/async controls,
TS5/TS7, zero-host-import assertions, formatting/lint, LOC/function budgets,
oracle/coercion ratchets, numeric-local parity, issue integrity, and the full
commit/pre-push hooks with at most two workers.

### Handoff

Planning/implementation worktree:
`/private/tmp/js2-es2015-promise-symbol-object-model-20260830`.
Planning/implementation branch: `codex/5197-promise-symbol-object-model`.
Exact candidate list: `/private/tmp/js2-promise-r2-baseline152.txt`.
Exact owned Slice-A list:
`/private/tmp/js2-promise-symbol-object-model3.txt`.
Fresh isolated results:
`/private/tmp/js2-promise-r2-fresh-main-{standalone,host}.jsonl`.

The implementation owner must use a separately provisioned worktree, update
this markdown issue with exact before/after evidence and remaining rows, push
checkpoints to `ttraenkler/js2` without force, and open a completed fix as a
non-draft PR on `loopdive/js2`. A semantically incomplete/non-mergeable
checkpoint may remain draft with explicit blockers. No GitHub issue is to be
created.

#### Slice A implementation checkpoint (validated in the dedicated worktree)

This worker owns exactly these three rows, as recorded in
`/private/tmp/js2-promise-symbol-object-model3.txt`:

- `test/built-ins/Promise/Symbol.species/prop-desc.js`
- `test/built-ins/Promise/Symbol.species/symbol-species.js`
- `test/built-ins/Promise/prototype/Symbol.toStringTag.js`

The provider invariant is one object model in standalone: the identity-stable
`Promise` constructor `$Object` carrier owns the `Symbol.species` accessor
entry, and both runtime reflection and the compile-time gOPD arm use the same
canonical `get [Symbol.species]` singleton (receiver-preserving, setter
`undefined`, enumerable `false`, configurable `true`). `Promise.prototype`
uses the existing native-prototype companion seeder with `symbolTag: "Promise"`
and the standard non-writable, non-enumerable, configurable descriptor. No
Promise-specific fake object or host fallback is introduced. Exact-row host
invocations are wrapped in `restoreHostBuiltins()` because the Test262
descriptor helpers destructively probe configurable properties. The shared
species closure now lives in `src/codegen/builtin-fn-meta.ts`, the neutral
metadata seam consumed by both the ctor carrier and static gOPD synthesis; this
keeps `builtin-ctor-own-props.ts` from importing `builtin-static-gopd.ts` and
avoids the `builtin-static-globals -> builtin-ctor-own-props ->
builtin-static-gopd -> property-access -> builtin-static-globals` ESM cycle.

Validation was run after integrating the exact fetched
`upstream/main` head `c243892c7f3a757bdecf6215626b08586ce72c58` in the
implementation worktree. Root transplanted the planning and implementation
commits onto a fresh publication branch and then integrated current upstream
head `3e89b5f95318b45fd69c9cf8209da84a7a06351a` without conflict.

Focused exact matrix (one Vitest fork; 8/8):

```text
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
node node_modules/vitest/dist/cli.js run tests/issue-5197-es2015-promise-r2.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
```

`3/3` exact host rows passed, `3/3` exact standalone rows passed, and the
host/standalone descriptor controls passed `2/2`. The standalone control
asserted `result.imports?.length === 0`.

The standalone 152-row regression sweep used the provisioned QuickJS artifact:

```text
JS2WASM_QUICKJS_ARTIFACT_DIR=/Users/thomas/Code/js2/.test262-cache/quickjs-artifact-2e2d7736713beeda \
node --import tsx scripts/harness-flip-probe.ts \
  --files /private/tmp/js2-promise-r2-baseline152.txt --target standalone \
  --timeout 120000 --out /private/tmp/js2-promise-r2-sliceA-after-standalone-quickjs.jsonl
```

The run completed with `15 pass / 135 fail / 2 compile_error` (`152` total;
controls `must-pass -> pass`, `must-fail -> fail`). Against
`/private/tmp/js2-promise-r2-fresh-main-standalone.jsonl` (`12 pass / 138 fail /
2 compile_error`), the partition is `149 unchanged`, exactly three
fail-to-pass rows (the three owned rows above), `0 pass-to-fail`, and `0 other
status changes`.

The ordinary host sweep initially aborted after row 9 because
`harness-flip-probe.ts` does not install an unhandled-rejection handler; the
row itself returned `fail`, then the process exited on `TypeError: undefined is
not a function`. The same authentic 152-row run was completed with a
process-level observer that only swallowed those existing unhandled rejections
(no repository file change): `75 pass / 77 fail`, `152` total. Compared with
`/private/tmp/js2-promise-r2-fresh-main-host.jsonl` (`75 pass / 77 fail`), all
`152` statuses were unchanged (`0` flips in either direction). This runner
limitation is the only corpus measurement blocker.

Additional one-worker controls:

- `tests/issue-4167-test262.test.ts tests/reflected-symbol-promise-statics.test.ts tests/promise-expando-standalone.test.ts`: `12/12` passed.
- `tests/issue-3765-numeric-locals.test.ts`: `18/18` passed.
- `tests/issue-2984-species.test.ts tests/issue-2984-ctor-carrier-own-props.test.ts tests/issue-4746.test.ts tests/issue-3319.test.ts tests/issue-5116-map-set-prototype-tostringtag.test.ts`: `51/52` passed. The sole failure is the test's explicitly labeled pre-existing `KNOWN GAP (pre-existing): a dynamic write bypasses the non-writable flag`; all 51 other controls, including both #4746 Promise-order rows and all #5116 Map/Set tag rows, passed.

Quality evidence (all completed without history mutation): TS5 and TS7 direct
typechecks passed; full Prettier check passed; full Biome lint exited 0;
host-import policy reported `legacySemanticImports=0` and `unknownImports=0`;
oracle/coercion ratchets reported no net growth; stack-balance buckets had
zero deltas; codegen-fallback, any-box, speculative-rollback, IR dialect,
IR-kind-neutrality, IR-layering, and issue-integrity/ID checks passed. The
issue checker reports only its existing ready-issue probe warnings and no
changed done-status violation.

Slice-A completion: the three owned rows are green in both lanes, with no
standalone regression in the 152-row comparison. The host runner limitation
and unrelated #2984 known-gap failure remain explicit follow-up notes. No
GitHub issue was created.

#### Slice A publication handoff (2026-08-30)

The single completed-fix PR is
<https://github.com/loopdive/js2/pull/5292>. It is a non-draft PR from
`ttraenkler:codex/5197-promise-symbol-object-model-final` to
`loopdive/js2:main`; no GitHub issue was created. Its description uses the
repository's exact Description and CLA sections and links this markdown issue.
A dedicated Luna Max PR shepherd owns exact-head, body, readiness, conflict,
review, CI, and queue verification.

The publication branch is
`/private/tmp/js2-promise-symbol-pr-20260830`. Implementation commit
`fd13172095d3773627433bba0d4c0e2648ab6e93` has the same tree as the fully
validated implementation worktree. Integration commit
`d469014322b88d5c01d45d728177086f86fdb498` adds only the newly merged upstream
history; a post-integration focused rerun passed 8/8 and the complete pre-push
hook passed without bypasses. This documentation-only handoff does not alter
the validated Promise behavior.

## Acceptance criteria

- All 152 exact rows pass standalone with zero host imports; interim PRs pass
  every row they claim and do not lose any previously passing row.
- The 75 currently passing host controls remain green. The two host-only
  regressions are restored by the shared provider work that owns their
  invariant, not hidden from the corpus.
- Both compile errors become passes after #3371 lands, never merely runtime
  failures.
- Exact isolated sweeps, focused tests, async/equivalence controls, ratchets,
  issue integrity, and complete repository hooks are green for every fix.

## 2026-09-01 r2 Slices B–D implementation (Opus)

### Corpus and baseline

Exact corpus: the 140 ES2015 `built-ins/Promise/**` rows that were not passing
standalone at sha `d39779cb` (`.tmp/es2015/promise-paths.txt`). Measured on this
branch's base with `npx tsx scripts/run-test262-paths.mts … --standalone`:

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (140 rows) | 0 | 134 | 6 |
| after Slices B + C | **11** | 127 | 2 |

Set-differencing the two non-pass lists: **11 rows flipped fail → pass, 0 rows
regressed**. Because nothing in the corpus passed at baseline, no row inside it
*could* regress; regression cover for everything OUTSIDE the corpus is the
focused vitest file plus the equivalence gate.

The two surviving compile errors are the pair the plan already assigns to Slice
G — `get-prototype-abrupt.js` and `get-prototype-abrupt-executor-not-callable.js`,
both refused by the documented #3371 arbitrary-NewTarget boundary. They are the
only two of the six that were real compiler refusals.

Three environment notes that change how the numbers read:

- The other **four** baseline `compile_error`s were **compilation timeouts**
  (~16 s each) under a 4-core box shared with five other agents, not compiler
  refusals: `{resolve,reject,executor}-function-prototype.js` and
  `then/S25.4.5.3_A1.1_T2.js`. Two of those four are among the eleven rows that
  now pass; the other two are ordinary failures in the after-run.
- `proto-from-ctor-realm.js` and the two `*-function-prototype.js` rows need the
  prebuilt QuickJS runtime-eval provider. Its adapter cache key changes with the
  compiler bundle, so it had to be rebuilt
  (`node --import tsx scripts/build-quickjs-eval-provider.mjs`, ~14 s) before
  those rows could be scored at all.
- **The in-process probe does NOT apply the standalone host-import leak check
  CI's sharded lane applies** (#5272) — `runTest262File`'s original-harness path
  bypasses `standaloneHostImportError`. Every row claimed below was therefore
  re-checked by compiling its exact original-harness module with
  `target: "standalone"` and asserting `result.imports` is empty.

### Slice B — synthesized promise callables (LANDED)

`$__promise_settle_cap` now subtypes the repository's builtin-function metadata
type (`ensureBuiltinFnMetaType`, `{name: "", length: 1}`) instead of the bare
signature wrapper, so the finalize-time arms that already answer
`name`/`length`/gOPD/delete/`getOwnPropertyNames` and
isExtensible/isFrozen/isSealed/`getPrototypeOf` cover the escaped `resolve` /
`reject` for free. One factory (`buildPromiseSettleClosureInstrs`) owns the
`struct.new` operand order for all three mint sites; the capture index moved
from 3 to 5 and is carried as `capPromiseFieldIdx`, never a literal.

§7.2.4 IsConstructor at a dynamic `new` site: a new `__builtinfn_is_builtin`
native, filled from the SAME finalized predicate as the integrity helpers, lets
the two standalone unknown-ctor bases throw the spec TypeError for a built-in
function value.

**+6 rows** (all fail → pass, all host-import clean):
`{resolve,reject}-function-name.js`,
`{resolve,reject}-function-property-order.js`,
`{resolve,reject}-function-prototype.js`.

### Slice C — generic `catch`, brand-checked `then` (LANDED, partial)

`Promise.prototype.catch` is §27.2.5.1 `Invoke(this, "then", «undefined,
onRejected»)` and nothing more. Its body now `ref.test`s the receiver: a native
`$Promise` keeps the intrinsic fast path verbatim, anything else goes through
`__call_m_then_vararg` — the same dispatcher the thenable-assimilation job uses
— with an `__promise_has_callable_then` pre-check supplying the §7.3.14 step-2
TypeError the dispatcher does not raise. `Promise.prototype.then` gained the
§27.2.5.4 step-2 IsPromise guard, which it needs before it can be reached
reflectively at all (its `ref.cast` previously trapped on a foreign `this`).

`nativeProtoBrandForInterface` learned the `Promise` brand. Without it the
DIRECT syntactic spelling `Promise.prototype.catch.call(target, f)` fell to the
legacy `.call` tail, which drops `thisArg` — so the object's own `then` was
never invoked. The value-erased spelling (`var m = Promise.prototype.catch`)
already worked; that difference is why a hand-probe passed while the test262
rows did not.

**+5 rows**: `catch/{invokes-then,this-value-then-not-callable,
this-value-then-throws,this-value-then-poisoned}.js`,
`then/context-check-on-entry.js`.

### Slice D — NOT done, and what it needs

Slice D was not attempted, on evidence rather than time alone: every one of its
rows bottoms out in the same missing mechanism, a generic
**NewPromiseCapability(C)** — mint a GetCapabilitiesExecutor built-in function
(the Slice-B carrier is the right one), `Construct(C, «executor»)` for an
arbitrary runtime `C`, then apply steps 8–9's IsCallable checks to whatever the
executor stored. Two concrete gaps block it:

1. `Promise.resolve` / `Promise.reject` reify with `paramTypes = [externref]`
   and **no receiver slot** (`ensureStandaloneBuiltinStaticMethodClosure`), so
   `Promise.resolve.call(C, v)` cannot see `C` at all.
2. Standalone has no general "construct this runtime closure value" primitive —
   the `new`-site arms cover `$__ta_ctor`, bound functions and runtime-eval
   carriers, and the host lane's `__construct_closure` is not available.

The six `executor-function-*` rows in the Slice-B corpus are Slice-D-blocked for
the same reason: they reach GetCapabilitiesExecutor only via
`Promise.resolve.call(NotPromise)`.

### Rows deliberately not fixed

| row(s) | why |
| --- | --- |
| `exec-args.js`, `{resolve,reject}-function-nonconstructor.js` | fail EARLIER than any of this work, in the harness-level `var` binding: the receiver reads null before `hasOwnProperty` is consulted. Same error text as baseline. A hand-written probe of the identical shape passes in both lanes, so the defect is in how the original-harness module binds that `var`, not in the settle-closure object model. |
| `catch/this-value-obj-coercible.js` | needs §7.3.2 GetV's `ToObject` step for a PRIMITIVE receiver (`Boolean.prototype.then`), a separate mechanism from the generic Invoke. |
| `catch/S25.4.5.1_A2.1_T1.js`, `then/S25.4.5.3_A1.1_T2.js` | `p.then` / `p.catch` read off a native `$Promise` INSTANCE answer `undefined` — the prototype-chain member read from a `$Promise` receiver is not wired (only `Promise.prototype.<m>` is). Independent of Slice C. |
| `then/ctor-*`, `then/*-prms-cstm-then.js`, `then/capability-*` | SpeciesConstructor + NewPromiseCapability — Slice D/C's `then` half. |
| Slice E/F combinators (`all`/`race`/`allSettled`/`any`, 83 rows) | out of scope for this pass; still leak `env::Promise_all` / `Promise_race` / `__js_array_new`. |
| Slice G (#3371 NewTarget), Slice H (realm) | out of scope by the plan. |

## 2026-09-01 resumed implementation (Opus)

Resumes the suspension handoff below (patches applied with `git am --3way` onto
`813b828b6`; the only conflict was this file's own References block, resolved by
keeping both sides). Slice C was committed properly; Slice D was then
implemented and measured. Worktree
`/home/user/js2/.claude/worktrees/agent-adaa0534580f31c70`, branch
`worktree-agent-adaa0534580f31c70`.

### Slice C — committed as landed (no code change)

The suspended snapshot's uncommitted Slice C edits were validated as a commit
rather than re-derived: TS7 typecheck clean; both focused files green
(`issue-5197-es2015-promise-r2.test.ts` 8/8, `issue-5197-promise-generic-catch.test.ts`
4/4, run one file per fork); all five ratchet gates exit 0
(loc, func, coercion, oracle-ratchet "no net checker-usage growth", dead-exports
"25 known entries, 0 new"). Commit `6fe2aad08`.

The pre-existing TS5 failure `src/linked-provider-runtime.ts(41,37) TS2694:
Namespace 'WebAssembly' has no exported member 'Tag'` is **not** from this work —
that file is untouched by every patch in this lane (`git diff 813b828b6 --stat --
src/linked-provider-runtime.ts` is empty). TS7 is clean.

### Slice D — generic NewPromiseCapability(C) (LANDED, partial)

The two gaps the previous implementer named were real but narrower than the
"no receiver slot / no generic Construct" framing suggested. The blocker was
**not** the reified `Promise.resolve` closure's missing receiver: a syntactic
`Promise.resolve.call(C, v)` never reaches that closure at all — it is decided
by `compileNamespaceStaticCall`, which already had a #4682/#4727
NewPromiseCapability arm (`emitStandalonePromiseCustom{CapabilityCheck,Resolve}`
in `promise-combinators.ts`: mint the capability record, mint a
GetCapabilitiesExecutor on the funcref-wrapper carrier, call `C`, apply
§27.2.1.5 steps 8-9, then `Call` the resolve slot). That arm was simply admitted
too narrowly. Three widenings, no second protocol:

1. **`reject` joins `resolve`.** §27.2.4.6 and §27.2.4.7 differ only in which
   capability slot the value is handed to, so the emitter takes a
   `settle: "resolve" | "reject"` argument and picks field 0 or 1 of the same
   record. It is now `emitStandalonePromiseCustomSettle`.
2. **One argument is admitted** (`Promise.resolve.call(C)`), not just two. The
   protocol reads only `C`; the settled value is `undefined`.
3. **A zero-parameter `C` is admitted.** The executor then never reaches a
   formal, both slots stay undefined, and steps 8-9 throw the TypeError the spec
   requires — which is the whole point of `reject/S25.4.4.4_A3.1_T1.js`.

**The undefined-vs-null trap (#2864), caught by the control, not by the corpus.**
The absent second argument was first emitted as `ref.null.extern`. Every exact
row still passed and the host lane passed, because none of them inspects the
settled value — but in standalone a null externref IS JS `null`, not
`undefined`, so `Promise.resolve.call(C)` settled with the wrong value. The fix
is `canonicalUndefinedExternInstrs`, resolved BEFORE the value side-buffer is
detached (it reserves the `$AnyValue` substrate on first use, and doing that with
`fctx.body` swapped away would register under a body already being written).

**Measurement** — the WHOLE 140-row corpus, standalone, in process, base =
Slice C commit `6fe2aad08` (file-copy A/B; both runs executed by this
implementer, ~10 min each):

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (Slices B + C) | 11 | 127 | 2 |
| after Slice D | **19** | 119 | 2 |

Set-differenced: **8 fail → pass, 0 regressions.** The `before` figure
reproduces the previous implementer's 11/127/2 exactly, which also confirms the
two surviving compile errors are still only the #3371 pair. All eight rows were
re-compiled through `wrapTest` + `compile({target:"standalone"})` and checked
with the runner's own `standaloneHostImportError`: every one reports an empty
import list, so no row is claimed on a module that still leaks
`env::Promise_resolve` / `Promise_reject` (#5272 — the in-process probe does not
apply that check itself).

- `built-ins/Promise/resolve/capability-invocation-error.js`
- `built-ins/Promise/resolve/ctx-ctor-throws.js`
- `built-ins/Promise/reject/capability-invocation-error.js`
- `built-ins/Promise/reject/ctx-ctor-throws.js`
- `built-ins/Promise/reject/capability-executor-not-callable.js`
- `built-ins/Promise/reject/S25.4.4.4_A3.1_T1.js`
- `built-ins/Promise/executor-function-extensible.js`
- `built-ins/Promise/executor-function-length.js`

The last two were **not** predicted from the 17-row resolve/reject/settlement
sub-corpus (which moved 0 → 6) and are the reason the full sweep was worth its
ten minutes. They are downstream of the same admission: both observe the
GetCapabilitiesExecutor's own `length` / extensibility, and the only way either
reaches one is `Promise.resolve.call(NotPromise)` — a ONE-argument call on a
custom `C`. Slice B had already made that executor a real built-in function
object; Slice D is what lets the rows reach it. That closes two of the six
`executor-function-*` rows the previous implementer listed as Slice-D-blocked.

**A file-copy A/B pitfall worth naming**, because it silently reverted a fix
that had already been validated. The revert copies were captured at the FIRST
edit (per the CLAUDE.md pattern) and then the `undefined` fix landed on top —
so `.tmp/new.ts` was stale. Restoring from it after the base measurement put a
tree back that was *not* the tree the measurement had been taken on, and the
only thing that caught it was the compiled control returning 5 again. **Refresh
the "new" copy after every edit that follows it, and re-run the focused control
after any restore** — a restore is a code change, not a bookkeeping step.

One measurement artifact worth recording: in the first after-run
`resolve/capability-executor-called-twice.js` scored `compile_error
(compilation timeout, 15445 ms)` at box load ~13 on 4 cores. Re-run alone it is
`fail`, the same status it had at baseline — a load artifact, not a regression.
Any single-row `compile_error` in this corpus should be re-run alone before it
is believed.

### Slice D — what is still open

| row(s) | why |
| --- | --- |
| `{resolve,reject}/capability-executor-called-twice.js` | the arm IS taken, and both throw the capability TypeError: after `executor()` / `executor(undefined, undefined)` the follow-up `executor(fn, fn)` does not leave two callables in the record, so steps 8-9 refuse. The GetCapabilitiesExecutor is reached through the dynamic apply path with a 0-argument call; that padding/store interaction is the next thing to look at. |
| `{resolve,reject}/ctx-ctor.js` | `class SubPromise extends Promise` — needs a real `Construct(C, «executor»)` with subclass prototype and `instance.constructor`, not the plain call this arm performs. |
| `reject/capability-invocation.js`, `resolve/resolve-from-promise-capability.js` | need the settle call's `this` (sloppy-mode global) and a real `arguments` object inside the user-supplied resolve/reject function. |
| `resolve/arg-uniq-ctor.js` | §27.2.4.7 step 3 — `Promise.resolve(x)` must `Get(x, "constructor")` and compare with `C` before the passthrough; today a native `$Promise` is returned unchanged without that read. Self-contained and reachable, just not done here. |
| `exception-after-resolve-in-{executor,thenable-job}.js`, `resolve-prms-cstm-then-{immed,deferred}.js` | settlement-core rows that fail in the async drive, unrelated to the capability protocol. |
| Slices E/F (combinators), G (#3371), H (realm) | untouched by this pass. |

### Validation for both commits

| check | result |
| --- | --- |
| TS7 `pnpm run typecheck` | clean |
| TS5 `pnpm run typecheck:ts5` | one PRE-EXISTING error in `src/linked-provider-runtime.ts` (`WebAssembly.Tag`); that file is untouched by this lane |
| `tests/issue-5197-es2015-promise-r2.test.ts` | 8/8 |
| `tests/issue-5197-promise-generic-catch.test.ts` | 4/4 |
| `tests/issue-5197-promise-generic-capability.test.ts` | 10/10 |
| loc / func / coercion / oracle-ratchet / dead-exports | all exit 0 |
| prettier + biome on every changed file | clean |
| `pnpm run test:equivalence:gate` | **24 failing, 1718 passing, 24 known-failures in baseline — no new regressions** |
| `npm run check:issues`, `check:done-status-integrity` | exit 0 |

**On the equivalence gate's scope.** The green run above was taken on the
Slice C + Slice D tree before the `undefined` fix; a re-run on the exact
committed tree was killed by the harness at ~55 min under box load 12-14 and
produced no verdict. That gap is closed by inspection rather than by a third
run: `grep -rn "resolve\.call\|reject\.call" tests/equivalence/` returns **zero
matches**, so no equivalence test can reach the changed arm at all, in either
version. The suite is byte-identical across the whole of Slice D; the green run
is therefore evidence for the committed tree, and specifically for Slice C.

**Two control failures were checked and are PRE-EXISTING, not this lane's.**
Both were A/B'd by restoring all eight lane-modified `src/codegen` files to
`813b828b6` and re-running:

- `tests/issue-2671-promise-capability.test.ts` — "wasm thenable element's then
  is invoked with the native resolve-element fn": `'C.resolve|'` vs
  `'C.resolve|p1.then:function|'`, identical at base. (The other 30 tests across
  `promise-combinators`, `issue-2671-promise-executor` and
  `issue-28-promise-executor-invocation` pass, including both
  `Promise.reject.call(NotPromise)` executor-metadata rows.)
- `tests/reflected-symbol-promise-statics.test.ts` — BOTH tests fail, including
  the `Symbol.for`/`Symbol.keyFor` one that this lane cannot touch; identical at
  base. Worth a look by whoever owns it: the previous implementer recorded this
  file green on 2026-09-01, so something between then and `813b828b6` (or an
  environment difference) took it out.

`promise-expando-standalone`, `issue-4167-async-rejection-identity`,
`issue-2623-promise-subclass-identity` and `issue-2867-gap4` are all green
(45 passing in that batch).

A pointer for whoever takes Slice E/F: `all/` and `race/` carry the exact twins
of the rows just fixed — `{all,race}/ctx-ctor{,-throws}.js`,
`{all,race}/capability-executor-{called-twice,not-callable}.js`. They fail for a
different reason (the `.call(C, iter)` arm still admits only an EMPTY array via
`emitStandalonePromiseCustomCapabilityCheck`, and a non-empty iterable needs the
per-element pipeline), so the same widening does not simply transfer — but the
capability half of their work is now done and shared.

## References

- #5143 (wave-1 plan), PRs #5179, #5213.
- #5272 (the in-process probe does not apply the host-import leak check).

## Suspended Work (2026-09-01T21:56Z — user-requested 2-hour pause)

- **Branch**: local lane branch `worktree-agent-ac8409dd2ee533f14` at `df3746897`
  (WIP snapshot on top of base `d153a0882`; NOT pushed — durable copy is
  `plan/agent-context/es2015-suspend-2026-09-01/patches/lane-5197.mbox`, 2
  patches: Slice B commit `772cd49e8` + the snapshot carrying the uncommitted
  Slice C edits in `array-object-proto.ts`, `expressions/calls.ts`,
  `tests/issue-5197-es2015-promise-r2.test.ts`, new
  `tests/issue-5197-promise-generic-catch.test.ts`, and the issue-file section
  `## 2026-09-01 r2 Slices B–D implementation (Opus)`).
- **Worktree at suspension**: `/home/user/js2/.claude/worktrees/agent-ac8409dd2ee533f14`
  (treat as gone).
- **State**: Slice B LANDED (committed, validated); Slice C landed PARTIAL
  (uncommitted in the snapshot — validated per the implementer's notes but not
  gate-run as a commit); Slice D NOT attempted (every row needs a generic
  NewPromiseCapability(C): mint a GetCapabilitiesExecutor built-in function
  on the Slice-B carrier, `Construct(C, «executor»)` for an arbitrary runtime
  `C`, then the §27.2.1.5 steps 8–9 IsCallable checks — see the implementer's
  section for the two concrete gaps).
- **Verified so far** (implementer's runs, 140-row corpus, standalone,
  in-process): before 0 pass / 134 fail / 6 CE → after B + C **11 pass / 127
  fail / 2 CE (+11, 0 regressions)**; every claimed row re-checked for an empty
  standalone import list. Slice B +6 (`{resolve,reject}-function-{name,property-order,prototype}.js`),
  Slice C +5 (`catch/{invokes-then,this-value-then-not-callable,this-value-then-throws,this-value-then-poisoned}.js`,
  `then/context-check-on-entry.js`). The two surviving CEs are the #3371 pair.
  Four baseline "CEs" were load-induced compile timeouts; three rows need the
  QuickJS provider rebuilt for the current bundle
  (`node --import tsx scripts/build-quickjs-eval-provider.mjs`, ~14 s).
- **NOT yet verified / next steps**: (1) `pnpm run typecheck` + focused vitest
  files on the applied patch; (2) five ratchet gates + `pnpm run
  test:equivalence:gate` for Slice C; (3) commit Slice C properly; (4) Slice D
  per the gaps above; (5) Slices E/F combinators (the `env::Promise_all`/
  `Promise_race`/`__js_array_new` leaks, 33 rows).
- **Traps**: `nativeProtoBrandForInterface` needed the `Promise` brand — without
  it the direct spelling `Promise.prototype.catch.call(t, f)` fell to the legacy
  `.call` tail that drops `thisArg`; a hand-probe with the value-erased spelling
  passed while test262 did not. Merge, never rebase.

## Implementation Plan — r3 (2026-09-03)

Base for every line number below: upstream `main` `bee5ddd535` (the census
sha; HEAD `9c23347f57` adds only docs commits, `src/` is identical). Census:
118 non-pass ES2015 rows in `.tmp/census0903/promise.tsv` — 50
`compile_error` (all but 4 are `host_import_leak`), 68 `fail`, 0 timeout.
Previous plan slices E–H map onto R3-2/R3-3/R3-4 (E, F1, F2), the deferred
block (G, H); F3 (`allSettled`/`any`) has only the 4 class-`C` rows left and is
deferred with them.

### Root-cause groups (118 rows, by mechanism — not by path)

| # | Root cause (one defect each) | Rows | Step |
| --- | --- | ---: | --- |
| G1 | The native combinators never do the observable `Get(C, "resolve")` / per-element `Call(resolve, C, v)` / `Invoke(next, "then", …)` — `Promise.resolve = f`, `defineProperty(Promise, "resolve", {get})` and an own `then` on a native element are all ignored. Includes the 4 `number[]`-argument rows that still leak `env::Promise_all` (the documented f64-vec gap). | 29 | R3-2 (23), R3-4 (6 `-close` rows) |
| G2 | `Promise.all/race.call(C, iterable)` is admitted ONLY for `function C(){…}` declarations + an EMPTY `[]` (call-namespace-static.ts L2411-L2470); every other shape leaks `env::Promise_all`/`Promise_race` + `__js_array_new`. | 28 | R3-3 (27), R3-4 (1) |
| G3 | Iterator abrupt completion / `IteratorClose` — the argument is drained to a vec BEFORE any element work, so `return()` is never called and a throwing `next()` surfaces as "argument is not iterable". | 6 (+1 in G2) | R3-4 (conditional — see the probe) |
| G4 | `$__promise_custom_capability_executor` treats the canonical `undefined` singleton as "stored" (`ref.is_null` guard, promise-combinators.ts L186-L194), so `executor()` / `executor(undefined, undefined)` followed by `executor(f, g)` throws. | 4 | R3-1 |
| G5 | `__promise_resolve_value` short-circuits on `ref.test $Promise` (async-scheduler.ts L1648-L1650) and never consults an own `then` written onto a native promise; the thenable job also re-reads `then` at job time instead of using the value captured at Resolve time. | 7 | R3-5 |
| G6 | `then` never reads `constructor` / `@@species`; `Promise.resolve(x)` never reads `x.constructor`. | 5 (+2 subclass rows in G9) | R3-6 |
| G7 | `p.then` / `p.catch` read as a VALUE off a `$Promise` instance answers `undefined` (probe C below). | 2 | R3-7 |
| G8 | `.then` handler returning a `boolean` is boxed as a NUMBER (`coerceStackValueToExternref` L1828-L1835 ignores the i32 `boolean` brand). | 2 | R3-8 |
| G9 | `class X extends Promise` used as `C` — standalone has no `Construct(C, «executor»)` for a compiled class and the host `__promise_subclass_ctor` leaks; 2 of these are the invalid-binary CEs. | 10 | DEFERRED |
| G10 | `class C { static resolve(){throw} }` as `C` (needs G9's class construct) — the 8 `resolve-throws-iterator-return-*` rows across all four combinators. | 8 | DEFERRED |
| G11 | GetCapabilitiesExecutor is minted on the bare funcref wrapper (L160-L176), not the builtin-fn metadata carrier Slice B gave the settle closures. | 3 | R3-9 |
| G12 | `provablyNullishReceiver` (builtin-prototype-brand.ts L582-L587) takes TypeScript's control-flow narrowing of an initializer-less `var` as a PROOF of `undefined`, so `hasOwnProperty.call(resolveFunction, …)` compiles to a static TypeError. | 3 | R3-10 (2), 1 deferred |
| G13 | #3371 arbitrary NewTarget (2), cross-realm prototype (1), global-object own `Promise` descriptor (1), `catch` on a primitive receiver / ToObject (1), `Promise.all("")` result-vec type mismatch (1), executor throw after `resolve(thenable)` (2), `Array.prototype.then` on the RESULT array (2), reaction FIFO order (1) | 11 | DEFERRED |

29+28+6+4+7+5+2+2+10+8+3+3+11 = 118.

### Verification on current main (do not skip — the baseline can be a day stale)

15-row sample, one process, box load 1.2:

```
$ npx tsx scripts/run-test262-paths.mts .tmp/p5197r3/sample.txt --standalone
=== counts ===
{ compile_error: 3, fail: 12 }
compile_error  built-ins/Promise/all/call-resolve-element.js
                 standalone target emitted host imports: env::Promise_all, env::__js_array_new, env::__js_array_push (#2961)
compile_error  built-ins/Promise/all/ctx-ctor-throws.js
                 standalone target emitted host imports: env::Promise_all (#2961)
compile_error  built-ins/Promise/all/invoke-resolve-on-promises-every-iteration-of-promise.js
                 standalone target emitted host imports: env::Promise_all (#2961)
fail  all/invoke-resolve.js            `resolve` invoked once for each iterated value Expected SameValue(«0», «3»)
fail  all/invoke-then.js               `then` invoked once for every iterated value Expected SameValue(«0», «3»)
fail  all/invoke-resolve-error-close.js  Expected SameValue(«0», «1»)
fail  race/invoke-resolve-get-error.js   Expected SameValue(«TypeError: Promise.race argument is not iterable», «[object Object]»)
fail  prototype/then/ctor-custom.js    The constructor is invoked exactly once Expected SameValue(«0», «1»)
fail  prototype/then/ctor-null.js      Expected a TypeError to be thrown but no exception was thrown at all
fail  prototype/catch/S25.4.5.1_A2.1_T1.js  The value of !!(p.catch instanceof Function) is expected to be true
fail  resolve/arg-uniq-ctor.js         Expected SameValue(«true», «false»)
fail  resolve/capability-executor-called-twice.js  TypeError | at L33
fail  all/S25.4.4.1_A5.1_T1.js         reason … Expected SameValue(«TypeError: Promise.all argument is not iterable», «Test262Error: »)
fail  race/resolve-self.js             async completion marker not observed
fail  prototype/then/capability-executor-not-callable.js  CompileError: … extern.convert_any[0] expected type anyref, found call of type externref
```

All 15 reproduce the baseline status AND error string; nothing in the sample has
been fixed by the merges since 09:07 UTC. Every group above has at least one
member in the sample except G8/G9/G11/G12 (whose error strings are
distinctive enough to trust).

Mechanism probes (`.tmp/p5197r3/probe-carrier.mts`, three small standalone
programs, `imports=[]` for all three):

| probe | program | result | what it proves |
| --- | --- | --- | --- |
| A | `Promise.resolve = mine; Promise.resolve === mine; Promise.resolve(5) === 42` | `101` | the assignment lands on the `$Object` ctor carrier (`__builtin_ctor_Promise`, builtin-static-globals.ts L172) and a later `Promise.resolve(5)` CALL already dispatches to it — only the combinators ignore it |
| B | `Object.defineProperty(Promise,'resolve',{get(){n++; return f}})`, two reads | `23` (2 gets, both return `f`) | accessor defines on the carrier work; `__extern_get(carrier, "resolve")` runs the getter |
| C | `p.constructor = null; p.constructor === null` / `typeof Promise.resolve(2).then === "function"` | `1` (+0) | the `$Promise` bag round-trips `constructor` (R3-6 can read it); the instance member VALUE read of `then` is not a function (G7) |

### Shared design constraints (apply to every step)

- **Type info via `ctx.oracle` only** (`valueDeclarationOf`, `typeFactOf`,
  `signatureOf`); no `ctx.checker.getTypeAtLocation` — the oracle-ratchet gate
  fails otherwise. The only checker call already present in the touched region
  (call-namespace-static.ts L2095, Set/Map probe) stays as it is.
- **No new host import, anywhere.** Every arm is standalone-native
  (`isStandalonePromiseActive`), and the host/gc lane must stay byte-identical:
  the acceptance for every step includes a host-lane compile of the named
  control programs and a `result.binary` byte comparison against the base tree.
- **Registration-before-bake** (#2918/#2919): every `ensure*`/`reserve*` call
  a step adds runs BEFORE any `ref.func`/`call` operand is pushed into a
  detached buffer; and keep `fctx.savedBodies`/`ctx.liveBodies` discipline
  exactly as the existing arms do (see the comment block at
  call-namespace-static.ts L2056-L2068).
- **`undefined` is not `ref.null.extern`** (#2864): any value that is
  semantically `undefined` is `canonicalUndefinedExternInstrs(ctx)`
  (any-helpers.ts L167), resolved BEFORE the body is swapped to a side buffer.
- **`FunctionContext` literals** carry `labelMap: new Map()` and
  `isGenerator?: boolean`; none of the steps should need a new one, but if a
  helper function is minted through a fresh `FunctionContext`, include both.
- **Every new callable that escapes to user code** (resolve-element functions,
  GetCapabilitiesExecutor) is a subtype of the builtin-fn metadata carrier
  (`ensureBuiltinFnMetaType`, builtin-fn-meta.ts L261) exactly like
  `$__promise_settle_cap` (async-scheduler.ts L1044-L1075), never a second
  representation.
- **Probe command** for every row claim:
  `npx tsx scripts/run-test262-paths.mts <list> --standalone` (≤15 paths per
  batch, `--isolate` on a hang). Any single-row `compile_error (compilation
  timeout …)` is re-run alone before it is believed. The in-process runner now
  applies the host-import leak check (#5461); a row is claimed only when its
  status is `pass`.

### Steps, in execution order

#### R3-1 — capability executor: `undefined` is "not yet stored" (4 rows, S, low risk)

**Root cause.** `__promise_custom_capability_executor` (promise-combinators.ts
L183-L215) decides "a slot was already stored" with `ref.is_null` on fields 0/1
of `$__promise_custom_capability`. `executor(undefined, undefined)` and the
zero-argument `executor()` (padded by `__apply_closure`) store the canonical
`$AnyValue` `undefined` singleton, which is a NON-null externref, so the
spec-legal second call `executor(f, g)` throws the TypeError meant for
`(undefined, function)`.

**Edits.**
1. In `ensureCustomCapabilityRuntime` replace the two `ref.is_null` / `i32.eqz`
   pairs (L186-L194) by "slot is nullish": `ref.is_null` OR the flagged
   is-undefined predicate. Use the existing native the object runtime already
   fills from `buildIsUndefinedExternBody` (any-helpers.ts, callers at
   object-runtime.ts L2709 / L6404 and registry/imports.ts L1823 — read those
   three to pick the registered `(externref) -> i32` name and call it; do NOT
   inline a second copy of the predicate). If that native is not registered in
   the module, fall back to `ref.is_null` (today's behaviour).
2. The post-construction validation in `emitStandalonePromiseCustomCapabilityCheck`
   (L311-L322) and `emitStandalonePromiseCustomSettle` (L410-L426) already
   uses `ref.test wrapperRoot` (a stored `undefined` fails it) — unchanged.

**Rows (4).** `built-ins/Promise/{all,race,resolve,reject}/capability-executor-called-twice.js`.
Growth: promise-combinators.ts +15, no function crosses 300.

**Order constraint.** The executor still stores BOTH arguments on every
admitted call (spec GetCapabilitiesExecutor step 5-6 store, not merge).

**Acceptance.** (a) the 4 rows `pass`; (b) PASSING shapes at risk — the six
`capability-executor-not-callable` subcases (`tests/issue-4682.test.ts` "passes
the six …" and `tests/issue-5197-promise-generic-capability.test.ts` 10/10) must
still throw for `(undefined, function)` / `(function, undefined)` / a
non-callable pair — run both files; (c) `reject/capability-executor-not-callable.js`,
`reject/S25.4.4.4_A3.1_T1.js` (Slice-D rows) re-probed `pass`; (d) host lane:
`tests/issue-4682.test.ts` "keeps the gc/host custom-constructor path unchanged"
green.

#### R3-2 — observable `resolve`/`then` pipeline on the intrinsic receiver over VEC arguments (23 rows, L, medium risk)

**Root cause.** `emitStandalonePromiseCombinator` (L1199) and
`emitStandalonePromiseCombinatorRuntime` (L1345) feed every element straight to
`__combinator_subscribe` (L749), which normalizes through `__promise_resolve_value`
and attaches raw microtask reaction FUNCS. Spec §27.2.4.1.1/§27.2.4.3.1 requires,
per call: (1) `promiseResolve = Get(C, "resolve")` ONCE, before GetIterator,
TypeError if not callable — IfAbruptRejectPromise; (2) per element
`nextPromise = Call(promiseResolve, C, «value»)`; (3)
`Invoke(nextPromise, "then", «resolveElement, capability.[[Reject]]»)` where
`resolveElement` is a real built-in function object (`length` 1, `name` "",
`[[AlreadyCalled]]`). Today `Promise.resolve = f` / a getter on the carrier /
an own `then` on a native element promise are invisible, and an f64-backed
`number[]` argument still falls through to the `env::Promise_all` host import
(`resolveExternrefVecArg` L1297 returns null for f64 vecs; call-namespace-static.ts
L2151-L2169).

**Design — one generic step function, a fast path that stays byte-identical.**

1. **Compile-time gate `promiseResolveObservable(ctx, node)`** (new, in
   promise-combinators.ts, cached per source file like
   `sourceHasMethodReassignment` at calls.ts L3131): true iff the source file
   contains (a) an assignment whose LHS is `<X>.resolve` (reuse
   `sourceHasMethodReassignment(ctx, node, "resolve")`), or (b) a call
   `Object.defineProperty(<X>, "resolve"|…)` / `Object.defineProperties(<X>, …)`
   whose first argument is the identifier `Promise`, or (c) any `.then` /
   `"then"` assignment or defineProperty target (`sourceHasMethodReassignment(…, "then")`
   plus the defineProperty scan). When FALSE the existing emitters run
   unchanged — this is the byte-identity guarantee for every module that never
   touches those properties (all of `tests/promise-combinators.test.ts`,
   `deno-safe-promise-combinators.test.ts`, the async equivalence corpus).
2. **`__combinator_get_resolve(C) -> externref`** (new defined func, registered
   by `ensureCombinatorFunctions` only when the gate is true): `__extern_get(C,
   "resolve")` on the carrier (`emitBuiltinConstructorIdentity(ctx, fctx,
   "Promise")` pushes the carrier; getters run inside `__extern_get`), then
   IsCallable via `buildClosureRefTestArms` (closed-method-dispatch.ts, the
   #2175 classifier) → TypeError (`emitWasiErrorConstructor(ctx,"TypeError",1)`,
   `__new_TypeError`) when not callable. The emit site wraps the call in
   `buildTargetTaggedTry` and on catch rejects the result promise
   (`rt.rejectFuncIdx`) and SKIPS the element loop — this is what
   `invoke-resolve-get-error.js` observes (Get happens BEFORE GetIterator, so
   emit it before the `__combinator_to_vec` call in `emitDynamicCombinatorArg`,
   calls.ts L10480, and before the element buffers are spliced in the literal
   arm).
3. **Intrinsic fast path check.** Compare the fetched value with the intrinsic
   singleton (`ensureStandaloneBuiltinStaticMethodClosure(ctx, "Promise",
   "resolve")` + `pushBuiltinFnSingletonValueInstrs`, `ref.eq` after
   `any.convert_extern`). Identical ⇒ the existing `__combinator_subscribe`
   path (unchanged bytes, unchanged microtask count). Different ⇒ the generic
   element step below.
4. **`__combinator_element_step(next, state, index, C, fulfillFn, rejectFn)`**
   (new, `buildCombinatorElementStep`): `next = __apply_closure(resolveFn, C,
   [value])` is done by the CALLER (so the loop can catch and reject); this
   helper implements `Invoke(next, "then", «resolveElem, rejectElem»)`:
   - mint the two element functions as REAL closures (see 5) into an objvec
     (`ensureObjVecBuilders`), then
   - if `next` is a native `$Promise` AND (`__carrier_bag_has` is registered
     AND `__carrier_bag_has(next, "then")` is 1) → `__apply_closure(
     __extern_get(next, "then"), next, args)` — the same override branch
     `emitStandalonePromiseThen` uses at async-scheduler.ts L4475-L4534;
   - else if `next` is a native `$Promise` → the native subscribe (today's
     `__combinator_subscribe` body) — but with the element closures' inner
     funcs, so `[[AlreadyCalled]]` semantics are shared;
   - else → `__call_m_then_vararg(next, args)` (the vararg dispatcher the
     thenable job already uses, async-scheduler.ts L1205) preceded by
     `__promise_has_callable_then(next)`; a 0 answer throws the §7.3.14 step-2
     TypeError — same pairing Slice C used for `catch`.
   Throws propagate to the caller's try, which rejects the aggregate.
5. **Resolve-element / reject-element closures** (`buildCombinatorElemFnClosureInstrs`,
   new): a struct `$__combinator_elem_fn` subtyping
   `ensureBuiltinFnMetaType(ctx, wrapper.structTypeIdx, wrapper.closureInfo,
   "promise:elem", "", 1)` (the `(externref)->()` wrapper, exactly as
   `$__promise_settle_cap` at async-scheduler.ts L1044-L1075), adding fields
   `caps: externref` (the `$CombinatorElemCaps`) and `called: mut i32`. Its
   lifted trampoline: if `called` → return; set `called`; call the existing
   reaction func (`reaction.fulfillIdx` / `reaction.rejectIdx` — the
   `__combinator_all_fulfill` family, L889) with `(caps, value)`. Field order
   is fixed by `ensureBuiltinFnMetaType`'s layout — copy
   `buildPromiseSettleClosureInstrs` (L999) and NEVER hard-code the capture
   index. `race`'s two functions are the capability's own resolve/reject (spec:
   `Invoke(next, "then", «capability.[[Resolve]], capability.[[Reject]]»)`), so
   for `race` reuse the Slice-B `$__promise_settle_cap` pair minted for the
   RESULT promise (`ensurePromiseExecutorClosures` + `buildPromiseSettleClosureInstrs`)
   — that is what `race/resolve-self.js` and `race/same-resolve-function.js`
   assert (identity across elements).
6. **f64-vec argument admission** (the 4 `every-iteration-of-promise` rows):
   in `emitDynamicCombinatorArg` (calls.ts L10451) or a sibling arm at
   call-namespace-static.ts L2151, when the probed argument type is a
   `$Vec` whose element type is `f64`, loop it into a fresh externref `$Vec`
   boxing each element with `__box_number` (late import registered BEFORE the
   loop is built — `flushLateImportShifts`) and hand that vec to the runtime
   emitter. Keep the `isDynamicCombinatorArgEligible` refusal for native
   generators/strings as is.
7. `emitStandalonePromiseCombinator` / `…Runtime` gain one parameter
   `{ observable: { resolveLocal, ctorLocal } | undefined }`; when set they
   emit the per-element `__apply_closure(resolve, C, [v])` + step-4 call
   inside a `buildTargetTaggedTry` whose catch rejects `resultLocal` and
   breaks the loop. `remaining` accounting stays in `$CombinatorState`
   (the `all` fulfil still fires when the last element resolves; for the
   spec's "resolve before loop exit" shape — elements settling synchronously
   inside `then` — the state's `remaining` starts at n as today, which already
   models step 4.h's +1/−1 bookkeeping for a fixed-length vec).

**Order-preservation constraints (must not break).**
- Element evaluation order: array-literal element expressions are compiled
  into buffers FIRST (L2069-L2085) and only spliced after every `ensure*` —
  keep that; the `Get(C,"resolve")` is emitted AFTER the element buffers are
  evaluated (spec evaluates the argument expression before the call).
- Microtask count for the intrinsic path must not change: a program with
  `Promise.resolve = undefined`-free source must produce byte-identical wasm.
- `Get(C, "resolve")` happens exactly ONCE per combinator call, before the
  iterator is touched (`invoke-resolve-get-once-*`).
- Rejection of the aggregate on a thrown `resolve`/`then` must use the
  one-shot `rt.rejectFuncIdx` on `resultLocal`, never `__promise_reject` on a
  fresh promise.

**Rows (23).**
`built-ins/Promise/all/{invoke-resolve,invoke-then,invoke-resolve-error-reject,invoke-resolve-get-error-reject,invoke-resolve-get-error,invoke-resolve-get-once-multiple-calls,invoke-resolve-get-once-no-calls,resolve-not-callable-reject-with-typeerror,invoke-resolve-on-promises-every-iteration-of-promise,invoke-resolve-on-values-every-iteration-of-promise,invoke-then-error-reject,invoke-then-get-error-reject}.js` (12),
`built-ins/Promise/race/{invoke-resolve,invoke-then,invoke-resolve-get-error-reject,invoke-resolve-get-error,invoke-resolve-get-once-multiple-calls,invoke-resolve-get-once-no-calls,invoke-resolve-on-promises-every-iteration-of-promise,invoke-resolve-on-values-every-iteration-of-promise,invoke-then-error-reject,invoke-then-get-error-reject,resolve-self}.js` (11).

**Growth grant.** promise-combinators.ts +300 (new helpers
`promiseResolveObservable`, `buildCombinatorElementStep`,
`buildCombinatorElemFnClosureInstrs`, `__combinator_get_resolve` body);
call-namespace-static.ts +60 inside `compileNamespaceStaticCall` (granted);
calls.ts +30 (`emitDynamicCombinatorArg` f64 arm); async-scheduler.ts +10
(export `ensurePromiseExecutorClosures` is already exported; add
`COMBINATOR_FUNC_IDX_KEYS` entries for every new funcIdx field — L5222, the
late-import lockstep shift, or a `ref.func` baked from a stale index will
silently target the wrong function).

**Acceptance.**
(a) the 23 rows `pass` with `imports=[]`;
(b) PASSING shapes at risk — byte-identity: compile `tests/promise-combinators.test.ts`'s
four sources and `tests/deno-safe-promise-combinators.test.ts` sources with
`target:"standalone"` on base and on the branch and `Buffer.compare` the
binaries (== 0, gate is false for them); run `tests/promise-combinators.test.ts`,
`deno-safe-promise-combinators.test.ts`, `issue-2671-promise-capability.test.ts`
(its one pre-existing failure stays exactly one), `issue-3125.test.ts`,
`issue-3125-widen.test.ts` on BOTH lanes;
(c) already-passing test262 controls re-probed: build the passing set with
`ls test262/test/built-ins/Promise/{all,race}/*.js | grep -v -f <(cut -f1 .tmp/census0903/promise.tsv)`,
probe 15 of them (all `S25.4.4.*` rows plus every `iter-arg-*` and `resolve-*`
row in that set) and require every one still `pass`;
(d) equivalence gate `pnpm run test:equivalence:gate` — 24 known failures, no
new ones;
(e) a NEW control in `tests/issue-5197-promise-generic-capability.test.ts`
(or a new `tests/issue-5197-promise-observable-resolve.test.ts`, one fork):
`Promise.resolve = spy; Promise.all([1,2])` counts 2 calls and
`Promise.race([p])` on an own-`then` promise invokes that `then` — run on both
lanes; the host lane compiles to the host `Promise` and must give the same
observable counts.

#### R3-3 — `Promise.{all,race}.call(C, iterable)` for ordinary-function `C` (27 rows, M, medium risk)

**Root cause.** The `.call` arm (call-namespace-static.ts L2411-L2470) admits
only `ts.isFunctionDeclaration(ctorDecl)` + `expr.arguments.length === 2` +
an EMPTY array literal + `paramTypes.length === 1`. Slice D already widened the
sibling `resolve/reject.call` arm (L2280-L2409) to function-EXPRESSION
initializers (`ctorInit`), 1-or-2 arguments and a 0-parameter `C`; the
combinator arm was left narrow because it had no per-element pipeline. R3-2
supplies that pipeline.

**Edits.**
1. Lift the ctor-resolution block of the resolve/reject arm (L2299-L2312,
   `unwrapReflectConstructExpr` → `ctx.oracle.valueDeclarationOf` →
   `ctorInit` → `isOrdinaryCtorDecl`) into one helper
   `resolveOrdinaryCapabilityCtor(ctx, arg): {ctorArg, isOrdinary}` and use it
   in BOTH arms (do not duplicate the predicate; the two arms must admit the
   same `C`). Also admit an inline `function(executor){…}` expression argument
   (`race/capability-executor-not-callable.js` passes it directly).
2. Admit `expr.arguments.length === 1` (`Promise.all.call(CustomPromise)`):
   NewPromiseCapability runs first (C throws → propagates, `ctx-ctor-throws`);
   then `GetIterator(undefined)` → TypeError → the result promise is
   REJECTED (`rt.rejectFuncIdx`), not thrown — spec IfAbruptRejectPromise.
   Admit `paramTypes.length === 0` (the `ZeroArgConstructor` rows expect the
   steps 8-9 TypeError, which `emitStandalonePromiseCustomCapabilityCheck`
   already raises once the executor is never invoked).
3. Replace `emitStandalonePromiseCombinator(ctx, fctx, methodName, [])` at
   L2464 by: capability check (unchanged) → `resolveFn = __combinator_get_resolve(C)`
   (R3-2 step 2, with `C` = `ctorLocal` boxed via `extern.convert_any`, and the
   IsCallable TypeError → REJECT via the capability's `[[Reject]]` slot, spec
   step 6 IfAbruptRejectPromise — `all/capability-executor-called-twice.js`
   fn3/fn4 expect a THROWN TypeError for the steps-8-9 failure, which happens
   before the Get, so keep those two orders distinct) → for an array-literal
   iterable, the R3-2 generic element loop with `observable` set and the
   RESULT being the value returned by `C` (`resultLocal` of
   `emitStandalonePromiseCustomSettle`'s pattern, L400-L404), settled through
   the captured `[[Resolve]]`/`[[Reject]]` closures (`__apply_closure(slot,
   undefined, [values])`) instead of `rt.fulfillFuncIdx`. The aggregate state
   (`$CombinatorState`) still carries the results array; only the terminal
   settle changes. Non-literal iterables (`Set`, vec vars, dynamic) reuse the
   same R3-2 arms with `observable` set; custom iterables with `return` wait
   for R3-4.
4. `race` with custom `C`: the two element functions are the capability's
   resolve/reject SLOTS (the closure values C stored), passed through unchanged
   — identity is asserted by `race/same-{resolve,reject}-function.js`.

**Rows (27).**
`all/{call-resolve-element,call-resolve-element-after-return,call-resolve-element-items,capability-resolve-throws-reject,ctx-ctor-throws,invoke-resolve-return,new-resolve-function,resolve-before-loop-exit,resolve-before-loop-exit-from-same,resolve-element-function-extensible,resolve-element-function-length,resolve-element-function-name,resolve-element-function-nonconstructor,resolve-element-function-property-order,resolve-element-function-prototype,resolve-from-same-thenable,same-reject-function,S25.4.4.1_A4.1_T1}.js` (18),
`race/{S25.4.4.3_A3.1_T1,capability-executor-not-callable,ctx-ctor-throws,invoke-resolve-error-reject,invoke-resolve-return,reject-from-same-thenable,resolve-from-same-thenable,same-reject-function,same-resolve-function}.js` (9).
`resolve-element-function-nonconstructor.js` additionally needs `new fn()` on
the element closure to throw — Slice B's `__builtinfn_is_builtin` `new`-site
guard covers any builtin-fn-meta subtype, so it comes free with R3-2 step 5.

**Growth grant.** call-namespace-static.ts +60 in `compileNamespaceStaticCall`
(granted) — the admission conditions ARE the dispatch; promise-combinators.ts
+80 (`emitStandalonePromiseCustomCombinator` terminal-settle variant).

**Order constraints.** Spec order for `Promise.all.call(C, iter)`: (1)
NewPromiseCapability(C) — construct C, steps 8-9 TypeError THROWN; (2)
`Get(C, "resolve")` — abrupt ⇒ REJECT the capability; (3) GetIterator —
abrupt ⇒ REJECT; (4) per element. Today's empty-array arm skips (2) and (3)
entirely; `all/capability-executor-called-twice.js` fn3 (`resolve` getter
throws, expects the steps-8-9 TypeError, i.e. (1) wins) pins that (1) precedes
(2).

**Acceptance.** (a) the 27 rows `pass`, `imports=[]`; (b) PASSING shapes at
risk — the 6 `capability-executor-not-callable` subcases and the empty-array
`.call(fn, [])` rows (`tests/issue-4682.test.ts` all three tests, including
"keeps the non-empty custom-constructor fallback unchanged" which must be
REWRITTEN to assert the native result rather than the host fallback — say so
in the test's comment), `tests/issue-4727.test.ts`, `tests/issue-5197-promise-generic-capability.test.ts`
10/10; `all/{ctx-ctor-throws → already-passing twins} resolve/{ctx-ctor-throws,capability-invocation-error}`,
`reject/{ctx-ctor-throws,capability-executor-not-callable,S25.4.4.4_A3.1_T1}`
re-probed `pass`; (c) host lane: `tests/promise-combinators.test.ts`
"compiled-fn capability constructor (#1694 A.i)" describe block green — those
four tests run the host `Promise.all.call(fn, …)` path and must be
byte-identical (compare binaries on base vs branch).

#### R3-4 — interleaved iterator drive + IteratorClose (7 rows firm, 6 conditional, M, medium-high risk)

**Root cause.** `emitDynamicCombinatorArg` drains the whole iterable into a
`$Vec` via `__combinator_to_vec` (finalize-filled at promise-combinators.ts
L1734-L1908) BEFORE any element work. Spec interleaves `IteratorStep` with
`Call(promiseResolve)` and `Invoke(then)`, and on an abrupt element step
performs `IteratorClose(iteratorRecord)` (calls `return`). The six `*-close`
rows have a `next()` that NEVER reports `done` — the drain loops forever and
the compile lane times out or the row fails on `callCount` — and
`capability-resolve-throws-no-close.js` asserts `return` is NOT called when
the abrupt step is the capability's own `resolve` throwing (spec: IfAbruptRejectPromise
inside the loop only closes on `promiseResolve`/`then` abrupts, not on step
4.h's `Call(capability.[[Resolve]])`).

**Conditional rows — probe FIRST.** `all/{S25.4.4.1_A5.1_T1,iter-step-err-reject,iter-next-val-err-reject}.js`
and the three `race/` twins reject with "argument is not iterable" today, which
means `__combinator_to_vec` returned NULL, not that the throw escaped. Two
hypotheses, different fixes: (H1) `__call_@@iterator` does not see a
SYMBOL-keyed expando written as `obj[Symbol.iterator] = fn` on a `$Object`
(for-of works on the same object only because it takes the compile-time #2162
projection); (H2) the throw inside `__call_next` is caught and mapped to null
somewhere in the `__call_*` dispatcher. Decide with a 3-line standalone probe
that prints `typeof it[Symbol.iterator]` through `__extern_get` vs the
dispatcher; fix H1 in `emitIteratorMethodExport`'s user arm, H2 in the
dispatcher. Claim these 6 only if the fix is inside the combinator/iterator
files named here; otherwise record them as a separate issue and leave them.

**Edits.**
1. Add `__combinator_drive(iterable, state, C, resolveFn, fulfillFn, rejectFn) -> i32`
   (new, reserved at compile time beside `ensureCombinatorToVec`, filled at
   finalize in `fillCombinatorToVec`'s slot right after it — same
   `__call_@@iterator`/`__call_next`/`__sget_done`/`__sget_value` reads, same
   bare-`next` fallback). Body: acquire iterator (null ⇒ return 0 = not
   iterable); loop { `res = __call_next(it)` inside try → abrupt ⇒ reject
   aggregate, return 1 (no close — spec 4.b/4.c set `[[Done]]` true); `done`
   ⇒ break; `value` ⇒ `remaining++`; try { `next = __apply_closure(resolveFn, C,
   [value])`; `__combinator_element_step(next, …)` (R3-2 step 4) } catch ⇒
   `IteratorClose`: `__extern_get(it, "return")` — undefined/null ⇒ skip;
   not callable ⇒ TypeError but the ORIGINAL throw wins (spec IteratorClose
   step 5/6: a throw completion is returned as is); else call it and ignore
   its result — then reject the aggregate with the original reason, return 1 }.
   `$CombinatorState.remaining` becomes the spec's counter: start at 1, +1 per
   element, −1 at loop end; when it reaches 0 at loop end the aggregate
   fulfils with the results vec (which must be GROWABLE here — reuse the
   `TOVEC_*` grow pattern L1781-L1797 on the state's `resultsArr`).
2. `emitDynamicCombinatorArg` (calls.ts L10451): when `promiseResolveObservable`
   OR the call is a custom-`C` `.call` (R3-3), emit `__combinator_drive`
   instead of `__combinator_to_vec` + the runtime loop; otherwise unchanged
   (byte-identity for every module without observable resolve — the six
   `-close` rows all reassign `Promise.resolve` or define `then`, so they take
   the new path).
3. `remaining` starting at 1 changes `buildAllFulfillBody` (L889) only for
   drive-mode states; add an `i32` `mode` field to `$CombinatorState`
   (registerStruct L481) rather than branching on magic counts.

**Rows (7 firm).** `all/{invoke-resolve-error-close,invoke-then-error-close,invoke-then-get-error-close,capability-resolve-throws-no-close}.js`,
`race/{invoke-resolve-error-close,invoke-then-error-close,invoke-then-get-error-close}.js`.
**Conditional (6).** `all/{S25.4.4.1_A5.1_T1,iter-step-err-reject,iter-next-val-err-reject}.js`,
`race/{S25.4.4.3_A4.1_T1,iter-step-err-reject,iter-next-val-err-reject}.js`.

**Growth grant.** promise-combinators.ts +150 (`buildCombinatorDriveBody`, the
state `mode` field, grow helper); calls.ts +10.

**Order constraints.** `Get(C,"resolve")` precedes GetIterator; `next()` is
called at most once per element and NOT again after an abrupt step; `return`
is called exactly once on an abrupt `resolve`/`then` step and never on an
abrupt `next`/`done`/`value` read; the aggregate settles at most once.

**Acceptance.** (a) firm rows `pass`; conditional rows `pass` or recorded as a
separate issue with the probe result; (b) PASSING shapes at risk — every
existing custom-iterable combinator row: `built-ins/Promise/all/iter-arg-is-*`,
`race/iter-arg-is-*` (probe the full glob, ≤15 per batch), the async-generator
`for await` corpus is untouched (no shared code), `tests/issue-2922*.test.ts`
(if present) and `tests/promise-combinators.test.ts` on both lanes; byte-identity
for a module with a custom iterable argument and NO resolve/then reassignment
(compile `Promise.all(customIter)` on base and branch, compare binaries).

#### R3-5 — own `then` on a native `$Promise` inside Resolve, captured at Resolve time (7 rows, S, low-medium risk)

**Root cause.** `buildPromiseResolveValueBody` (async-scheduler.ts L1511)
tests `ref.test $Promise` on the peeled value (L1648-L1650) and adopts the
native state directly, so `thenable.then = f` on a native promise is never
`Get`; spec §27.2.1.3.2 steps 8-13 `Get(resolution, "then")` runs for EVERY
object. Additionally `__promise_thenable_job` (L1246-L1275) re-dispatches
`__call_m_then_vararg(thenable, …)` at job time, whereas the spec captures
`then` at Resolve time (`resolve-prms-cstm-then-immed.js` reassigns `then`
after `resolve()` and asserts the LATE function is never called).

**Edits.**
1. In `buildPromiseResolveValueBody`'s `$Promise` arm (L1648-L1720), after
   `selfCheck`, add: if `__carrier_bag_has` is registered in the module
   (`ctx.funcMap.get(CARRIER_BAG_HAS)`, carrier-bag-visibility.ts L23) AND
   `__carrier_bag_has(peeled, "then")` → `thenVal = __extern_get(peeled,
   "then")`; if `thenVal` passes `buildClosureRefTestArms` → enqueue
   `__promise_thenable_job` with caps `$__then_caps{callback: thenVal,
   chained: promise}` (today `callback` is null for this job — L1274) and
   return; else fall through to direct fulfil with `value` (a non-callable
   own `then` ⇒ step 11). When the bag natives are not registered the arm is
   absent — byte-identical for every module without promise expandos.
2. In `__promise_thenable_job`'s try body (L1246-L1275): if `caps.callback`
   is non-null → `__apply_closure(caps.callback, peeled thenable, argvec)`;
   else the existing `__call_m_then_vararg` call. Nothing else changes.
3. `fillPromiseThenableHelpers` (closed-method-dispatch.ts L1818): add a
   `ref.test $Promise` + `__carrier_bag_has` arm BEFORE the `$Object` arm so a
   `then`-bearing native promise answers 1 to `__promise_has_callable_then`
   when reached through the non-promise path (an `$AnyValue`-boxed promise).
   Gate it on `ctx.funcMap.get(CARRIER_BAG_HAS) !== undefined`.

**Rows (7).** `prototype/then/resolve-{pending,settled}-{fulfilled,rejected}-prms-cstm-then.js` (4),
`resolve-prms-cstm-then-{immed,deferred}.js` (2), `race/resolve-prms-cstm-then.js` (1).

**Growth grant.** async-scheduler.ts +60 (the two functions, both granted
above); closed-method-dispatch.ts +25.

**Order constraints.** `Get(then)` runs synchronously inside Resolve (step 9),
the CALL runs as a job (step 14); a throwing `then` getter on the native
promise rejects synchronously via the existing `poisonedLocal` path — route the
new Get through the same `buildTargetTaggedTry` (L1536-L1554) rather than a
second try.

**Acceptance.** (a) 7 rows `pass`; (b) PASSING shapes at risk — every
native-promise adoption: `tests/issue-3125.test.ts` (all 6), `issue-3125-widen`,
`promise-expando-standalone.test.ts` (which writes expandos onto promises and
must NOT make plain adoption take the job path — assert its binaries only grow
by the new arm, and that `Promise.resolve(p)` for an expando-free `p` still
adopts synchronously), `issue-4167-test262.test.ts`, `issue-2623-promise-subclass-identity`,
`issue-2867-gap4`; test262 controls `prototype/then/resolve-{pending,settled}-{fulfilled,rejected}-prms.js`
(the non-custom twins — must stay `pass`) and `resolve-self`/`resolve-settled-*-self`;
host lane byte-identical (the whole body is standalone/wasi-gated).

#### R3-6 — `SpeciesConstructor` read in `then`; `x.constructor` check in `Promise.resolve` (5 rows, S, medium risk)

**Root cause.** `emitStandalonePromiseThen` (L4286) never performs
§27.2.5.4 step 3 `SpeciesConstructor(promise, %Promise%)`; `emitStandalonePromiseResolve`
(L4164) skips §27.2.4.7.1 step 2.a `Get(x, "constructor")` and returns a
native promise unchanged (`arg-uniq-ctor.js` sets `constructor = null` and
expects a NEW promise).

**Edits.**
1. New `emitPromiseSpeciesConstructorRead(ctx, fctx, promiseLocal) -> {ctorLocal}`
   (async-scheduler.ts, beside `emitStandalonePromiseThen`), emitted only when
   `promiseSpeciesObservable(ctx, node)` — a per-file scan (same cache shape as
   `sourceHasMethodReassignment`) for: an assignment/defineProperty whose key
   is `constructor`, any `Symbol.species` token, or `defineProperty(Promise, …)`.
   Body: `c = bag has "constructor" ? __extern_get(p, "constructor") : <Promise carrier>`
   (`emitBuiltinConstructorIdentity(ctx, fctx, "Promise")`); `undefined` ⇒
   default; not an object (null/primitive — use the object runtime's
   is-object classifier, not `ref.is_null` alone) ⇒ TypeError; `s =
   __extern_get(c, @@species)` (`ensureSymbolCarrier` + `__box_symbol` 5 as in
   builtin-ctor-own-props.ts L307-L322); `s` undefined/null ⇒ default; `s`
   `ref.eq` the Promise carrier ⇒ default (native path); anything else ⇒ if
   IsConstructor fails ⇒ TypeError; if it IS a constructor, this pass has no
   `Construct(S, «executor»)` for it (G9), so fall through to the native path
   AFTER the Get/IsConstructor side effects ran, and say so in a code comment
   naming G9 (`ctor-custom` / `deferred-is-resolved-value` are the rows that
   need the real construct).
2. Call it at the top of the `nativeBody` arm of `emitStandalonePromiseThen`
   (after `promiseLocal` is set, L4363), so the override-`then` branch (an own
   `then`) is unaffected. Throws propagate synchronously out of `then` — that
   is what `ctor-null`/`ctor-poisoned`/`ctor-throws` assert.
3. `emitStandalonePromiseResolve` L4182-L4187: in the `then` (native promise)
   arm, when `__carrier_bag_has` is registered: if `bag has "constructor"` AND
   `__extern_get(v, "constructor")` is not `ref.eq` the Promise carrier ⇒ take
   the ELSE arm (new pending promise adopting `v`). Gate on the same
   `promiseSpeciesObservable` scan for byte-identity.

**Rows (5).** `prototype/then/{ctor-null,ctor-poisoned,ctor-throws,ctor-access-count}.js`,
`resolve/arg-uniq-ctor.js`.

**Growth grant.** async-scheduler.ts +80 (`emitPromiseSpeciesConstructorRead`
new; `emitStandalonePromiseThen` +10, granted).

**Order constraints.** `Get(constructor)` exactly once (`ctor-access-count`);
it precedes the reaction attach; it is NOT performed on the own-`then`
override branch (spec: `p.then` override means `Promise.prototype.then` was
never entered).

**Acceptance.** (a) 5 rows `pass`; (b) PASSING shapes at risk — every
`p.then(...)` in a module that mentions `Symbol.species` or `constructor`:
`tests/issue-2984-species.test.ts`, `issue-2984-ctor-carrier-own-props`,
`issue-5197-es2015-promise-r2.test.ts` 8/8 (Slice A species rows), `issue-2623-promise-subclass-identity`,
`issue-4746.test.ts` (Promise order rows); test262: every currently-passing
`prototype/then/*.js` row (the glob minus the census rows, ≤15 per batch) and
`Symbol.species/*.js`; byte-identity
for a module with `then` but no `constructor`/species mention (compile
`tests/issue-3125.test.ts` source 1 on base vs branch).

#### R3-7 — `p.then` / `p.catch` / `p.finally` as VALUES on a `$Promise` instance (2 rows, S, low risk)

**Root cause.** A member VALUE read of `then` off a `$Promise`-typed receiver
answers `undefined` (probe C). The reflective closure for
`Promise.prototype.then` exists (`ensurePromiseNativeProtoGlue`, brand
registered by Slice C; value read of `Promise.prototype.<m>` goes through
builtin-value-read.ts L616 / native-proto.ts `emitLazyNativeProtoGet`), but the
instance read never consults the prototype.

**Edits.** Find the site by compiling probe C with a breakpoint: the receiver
is `ref $Promise` and the name is `then` — the read resolves in
property-access-dispatch.ts (the struct-receiver member ladder) and falls to
the bag miss ⇒ `undefined`. Add, in the standalone `$Promise` receiver arm:
if the bag has no own `then`/`catch`/`finally` ⇒ push the SAME proto member
closure the `Promise.prototype.<m>` read yields (call the glue's member
closure getter; do not mint a second closure — identity `p.then ===
Promise.prototype.then` is a spec fact and `S25.4.5.3_A1.1_T2` may compare).
Reads of any OTHER member keep today's answer.

**Rows (2).** `prototype/catch/S25.4.5.1_A2.1_T1.js`, `prototype/then/S25.4.5.3_A1.1_T2.js`.

**Growth grant.** property-access-dispatch.ts +30 OR array-object-proto.ts
+40 (whichever owns the site; both granted).

**Acceptance.** (a) 2 rows `pass`; (b) PASSING shapes at risk — the own-`then`
override (`promise-expando-standalone.test.ts`: `p.then = f; p.then` must
read `f`, and `emitStandalonePromiseThen`'s override branch must still fire);
`then/context-check-on-entry.js`, `catch/{invokes-then,this-value-*}.js`
(Slice C rows) re-probed `pass`; a compiled control `typeof p.then ===
"function" && p.then === Promise.prototype.then` on both lanes.

#### R3-8 — boolean results of `.then` handlers (2 rows, S, low risk)

**Root cause.** `coerceStackValueToExternref` (async-scheduler.ts L1810) boxes
every `i32` with `f64.convert_i32_s` + `__box_number` (L1828-L1835). The
canonical i32→externref rule (type-coercion.ts L3396-L3407) honours the i32
`boolean` brand (`from.boolean === true` ⇒ `__box_boolean`). `checkSequence`
returns `boolean`, so `Promise.all([...]).then(r => compareArray(r, [true,true,true]))`
sees `[1,1,1]`.

**Edits.** In the `i32` case, if `from.boolean === true` and `__box_boolean`
is registered (`addUnionImports` registers it in both modes; call
`ensureUnionHelpersForThenWrapper`'s existing pre-registration path to make
sure it is present BEFORE the wrapper body bakes the call), emit
`call __box_boolean`; otherwise today's number box. Symbol-branded i32 is not
reachable here (a handler returning a symbol is `externref` already) — assert
that with a comment, not code.

**Rows (2).** `race/resolved-sequence.js`, `race/resolved-sequence-with-rejections.js`.

**Growth grant.** async-scheduler.ts +8.

**Acceptance.** (a) 2 rows `pass`; (b) PASSING shapes at risk — handlers
returning `number` (`tests/issue-2867*.test.ts`, `promise-combinators.test.ts`
"Promise.all with resolved values"), handlers returning `boolean` consumed
by `===` downstream; equivalence gate unchanged; host lane: the wrapper is
standalone-only (`emitThenWrapperFunction` is reached only under
`isStandaloneThenChainNativeActive`) — verify with a binary compare of
`tests/promise-combinators.test.ts` source 1 on the host lane.

#### R3-9 — GetCapabilitiesExecutor on the builtin-fn metadata carrier (3 rows, S, low risk)

**Root cause.** `$__promise_custom_capability_executor` (promise-combinators.ts
L160-L176) subtypes the bare `(externref, externref)->()` wrapper, so it has
no `name`/`length`/prototype metadata; Slice B moved the settle closures onto
`ensureBuiltinFnMetaType` for exactly this reason (`executor-function-length.js`
passes only because `closureArityField()` happens to answer 2).

**Edits.** Re-parent the struct onto
`ensureBuiltinFnMetaType(ctx, wrapper.structTypeIdx, wrapper.closureInfo,
"promise:capexec", "", 2)`; read the carrier's fields to place `$capability`
AFTER them (`capMetaFields.length`, as L1055-L1058 does); factor the two
`struct.new` mint sites (L262-L269 and L378-L387) into one
`buildCustomCapabilityExecutorInstrs(runtime, stateLocal)` so the operand
order lives in one place; the executor body's `ref.cast executorTypeIdx` +
`struct.get CLOSURE_CAPTURE_FIELD_BASE` (L188-L190) must read the NEW
capture index (`runtime.capabilityFieldIdx`), never the constant.

**Rows (3).** `executor-function-{name,property-order,prototype}.js`.

**Growth grant.** promise-combinators.ts +25 net.

**Acceptance.** (a) 3 rows `pass`; (b) PASSING shapes at risk —
`executor-function-{length,extensible}.js`, all Slice-D rows, `tests/issue-4682.test.ts`,
`issue-4727.test.ts`, `issue-5197-promise-generic-capability.test.ts` (the
executor is called from compiled `C` bodies through the wrapper `ref.test` —
the subtype chain must still pass `getFuncRefWrapperRootTypeIdx`); the
finalize `fillBuiltinFnMeta` arms must not double-register the
`(name:"", length:2)` entry (it is keyed by identity — check the entry count
in a compiled module before/after).

#### R3-10 — an initializer-less `var` is not a proof of `undefined` (2 rows, S, low risk)

**Root cause.** `provablyNullishReceiver` (builtin-prototype-brand.ts L582-L587)
accepts `ctx.oracle.typeFactOf(e).kind === "undefined"`. For `var
resolveFunction;` assigned only inside a nested function, TypeScript's
control-flow analysis narrows the top-level use to `undefined` (an evolving
`any`), which is a narrowing, not a proof; the borrowed-prototype arm then
compiles `Object.prototype.hasOwnProperty.call(resolveFunction, "prototype")`
to a static TypeError.

**Edits.** Before trusting the fact, if `e` is an identifier whose
`ctx.oracle.valueDeclarationOf(e)` is a `VariableDeclaration` with neither an
initializer nor a type annotation (or a parameter), return false. Keep the
`null` keyword and explicit `undefined`-typed declarations as proofs.

**Rows (2).** `resolve-function-nonconstructor.js`, `reject-function-nonconstructor.js`
(`hasOwnProperty.call(settleFn, "prototype")` then answers through the
builtin-fn-meta gOPD arm — `false` — and Slice B's `new fn()` guard supplies the
TypeError). `executor-function-not-a-constructor.js` also passes this gate but
then needs `isConstructor()` = `Reflect.construct(function(){}, [], fn)` →
#3371; record its new failure text, do not claim it.

**Growth grant.** none needed (builtin-prototype-brand.ts is under threshold;
+10 lines).

**Acceptance.** (a) 2 rows `pass`; (b) PASSING shapes at risk — every row that
RELIES on the static nullish throw: probe `built-ins/Object/prototype/hasOwnProperty/*.js`,
`built-ins/Object/prototype/isPrototypeOf/*.js`, `built-ins/Function/prototype/{call,apply}/*` (≤15 per
batch, currently-passing set) and `tests/issue-4623*.test.ts` if present; the
`null` literal and a `let x: undefined` receiver must still take the static
throw (add a compiled control asserting the TypeError text).

### DEFERRED (30 rows) — with the reason

| rows | why not in this pass |
| --- | --- |
| G9 (10): `{all,race,resolve,reject}/ctx-ctor.js`, `then/ctor-custom.js`, `then/deferred-is-resolved-value.js`, `then/capability-executor-{called-twice,not-callable}.js`, `{all,race}/invoke-resolve-on-promises-every-iteration-of-custom.js` | need `Construct(C, «executor»)` for a compiled `class extends Promise` with a wasm-held executor argument — the `new`-site arms are AST-driven (`emitDynamicNewFallback`, new-super.ts L3290) and the host `__promise_subclass_ctor` is unsatisfiable (`class-bodies.ts` L175-L200). The two `then/capability-executor-*` CEs are an invalid-binary bug (`extern.convert_any` on an externref call result in `__module_init_chunk_0`) in the anonymous `new class extends Promise{…}(fn)` lowering — file it as its own issue; it blocks nothing here because the rows need G9 anyway. |
| G10 (8): `{all,allSettled,any,race}/resolve-throws-iterator-return-{is-not-callable,null-or-undefined}.js` | `class BadPromise { static resolve(){throw} }` as `C` — same class-construct gap. |
| #3371 (2): `get-prototype-abrupt{,-executor-not-callable}.js` | arbitrary NewTarget — Slice G, unchanged. |
| `proto-from-ctor-realm.js` | Slice H (cross-realm), unchanged. |
| `promise.js` | `verifyProperty(this, "Promise", …)` — global-object own-property reflection, cross-cutting (#4444's global-object blocker). |
| `catch/this-value-obj-coercible.js` | §7.3.2 GetV ToObject for a primitive receiver (`Boolean.prototype.then`) — a wrapper-prototype expando lookup, separate mechanism. |
| `all/iter-arg-is-string-resolve.js` | the handler's `v.length` is typed `string[]` by TS while the native result is an externref `$Vec` → illegal cast; a type-mapping fix in the combinator's RESULT typing, not a Promise-semantics fix. |
| `exception-after-resolve-in-{executor,thenable-job}.js` | the executor-throw catch (promise-executor.ts L163-L205) rejects on PROMISE state, but `resolve(thenable)` leaves the promise pending; fixing it needs an `[[AlreadyResolved]]` record shared by the settle closures (or a new PENDING_RESOLVED state that the job's settle path is allowed to cross) — touches every settle path for 2 rows; own issue. |
| `all/resolve-thenable.js`, `all/resolve-poisoned-then.js` | Resolve of the RESULT array must `Get(array, "then")` through `Array.prototype`'s expando; `__promise_has_callable_then` has no vec arm and the array-proto expando lookup is a different substrate. |
| `then/S25.4.5.3_A5.1_T1.js` | reaction order: pending callbacks are PREPENDED (`emitStandalonePromiseThen` L4514-L4524, "FIFO append can be added later") so two `then`s on one pending promise fire LIFO. Real semantic bug worth its own issue; too much blast radius to bundle here. |
| `executor-function-not-a-constructor.js` | after R3-10 it still needs the harness `isConstructor` (`Reflect.construct` with a NewTarget) — #3371. |

### Expected yield

Firm claims: R3-1 4 + R3-2 23 + R3-3 27 + R3-4 7 + R3-5 7 + R3-6 5 + R3-7 2 +
R3-8 2 + R3-9 3 + R3-10 2 = **82 rows**; conditional +6 (R3-4 probe);
deferred 30. Measure the WHOLE 118-row list before and after each step
(file-copy A/B, refresh the "new" copy after every edit — see the Slice-D
pitfall above), and re-probe the currently-passing `built-ins/Promise/**`
ES2015 rows (the set `ls test262/test/built-ins/Promise -R` minus the census
list, ~110 rows, ≤15 per batch) once after R3-4 and once at the end — that
sweep, not the row list, is what catches a broken passing shape.
