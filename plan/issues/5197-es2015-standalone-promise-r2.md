---
id: 5197
title: "ES2015 standalone promise — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-01
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
func-budget-allow:
  # 2026-09-01 (Slice B): one extra `registerNative` call in the object-runtime
  # reservation block, and two three-line guard call sites on the `new` path.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
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
