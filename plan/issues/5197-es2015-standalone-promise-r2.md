---
id: 5197
title: "ES2015 standalone promise — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-27
loc-budget-allow:
  # Live iteration prerequisite: keep descriptor admission (+6), validated
  # assignment wiring (+11), and overlay length-deletion wiring (+30) at
  # their existing owners. The fill implementation is shared in the separate
  # vec-length-hole-fill module. No baseline or behavioral gate is changed.
  - src/codegen/object-ops.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/vec-overlay.ts
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
  # 2026-09-03 (round-3 review F1): the evolving-`var` receiver must take the
  # RUNTIME own-property query instead of the struct-field fold, and that fold
  # lives in `compilePropertyIntrospection` (object-ops.ts). The predicate and
  # the runtime TypeError guard live in builtin-prototype-brand.ts beside the
  # static gate they complete; object-ops gains only the route (+~16).
  - src/codegen/object-ops.ts
  # 2026-09-13 (R3-2 prerequisite): source-order retention of the direct,
  # unshadowed intrinsic `Promise.resolve = …` write leaves a small dispatch
  # branch in module-init collection. Its ~100-line semantic proof belongs next
  # to the existing builtin-write keep owner: TypeScript appends a synthetic
  # property-assignment Identifier to ambient symbol declarations, so the proof
  # filters only that exact non-binding node and explicitly rejects the import
  # rewriter's source-file `declare const Promise` stub. This does not broaden
  # generic builtin static patches.
  - src/codegen/declarations.ts
  - src/codegen/builtin-write-keeps.ts
func-budget-allow:
  # Same validated ArraySetLength owner wiring as the LOC allowances above;
  # dynamic-length growth additionally guards null backing before copying.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/vec-length-set.ts::fillVecLengthDynamicArms
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
  # 2026-09-03 (round-3 review F1): `compilePropertyIntrospection` gains the
  # evolving-`var` route into its existing runtime arm (+~15 lines: one
  # predicate, one `local.tee`, one guard call) — the route IS the arm's
  # admission condition, so it cannot live outside the function.
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  # 2026-09-13 (R3-2 prerequisite): the source-order keep remains one branch
  # in the existing module-init collector. Its declaration-proven intrinsic
  # predicate is factored beside builtin-write-keeps to keep this large
  # collector from absorbing the supporting import/shadow proof.
  - src/codegen/declarations.ts::collectDeclarations
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

## 2026-09-13 plan refinement: retain the original resolve assignment

The R3-2 candidate's ten focused controls pass, but the unchanged original
`built-ins/Promise/all/invoke-resolve.js` still fails with zero callback calls.
An instrumented copy retaining the original module scope and assertion
harness measured `entries=0 identity=0 argc=0 this=0 calls=0`; these zero
assertion counters do not mean the assertions ran successfully. Full WAT
shows the observable combinator in `__module_init_chunk_1`, while the user
`Promise.resolve = function (...) { ... }` write is absent. The retained
native resolve therefore bypasses the intended observable callback.

The existing top-level intrinsic Promise property-write retention in
`src/codegen/declarations.ts` is inside a host-only arm. Before any change to
that file, the root reviewed open PR #5871 at head
`1ba798b5ccd17f4af877112b95b47c18de8124fc`: its three declaration-time async
signature hunks (import and function registration) are disjoint from this
module-initialization statement-retention arm. Preserve those changes during
any later normal integration; do not edit their async signature behavior.

Bounded prerequisite implementation:

1. Retain direct, unshadowed intrinsic `Promise.resolve = ...` assignments in
   standalone module initialization, in original source order. Use ordinary
   property-write lowering and the same canonical constructor carrier that
   the combinator reads. Do not enable all builtin property patches at once
   or key the decision to a Test262 filename or assertion shape.
2. Preserve host behavior and shadowed user bindings; keep unrelated builtin
   writes and the existing declaration-time async ABI out of this change.
   Prove the receiver through the TypeOracle declaration set, ignoring only an
   Identifier whose parent proves it is a property-assignment receiver (not a
   binding), and reject actual imports plus the import rewriter's generated
   `declare const Promise` binding. Record the narrow LOC/function budget
   requirement in this issue before exceeding a repository gate.
3. Add a permanent module-scope assignment/callback-observation control, not
   only a function-local analogue. Verify the emitted user write precedes
   the actual combinator call across initialization chunks and the saved
   original resolve remains callable.
4. Rerun the unchanged original and its passing control with the maintained
   isolated runner, then the strengthened protocol suite. A
   passing diagnostic cannot replace the unchanged original's verdict. Keep
   this prerequisite and its measured evidence within the R3-2 PR; do not
   claim the other Promise residual slices complete.

## 2026-09-13 continuation: observable combinator pipeline

Reopened because the documented R3-2/R3-3/R3-4 work below was not implemented;
the prior completed slices do not satisfy this issue's residual scope.
The canonical standalone baseline produced at upstream
`e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3` contains 99 official ES2015
nonpasses under `built-ins/Promise`. Snapshot SHA-256:
`07c89a5c2626f3312ff611f008a69ed6d8826e9802da024df39726ddabc1e9ba`.
These rows include 25 `Promise_all` and 15 `Promise_race` host-import leaks;
import counts are overlapping symptoms, not independent gain claims.

The next implementation owns R3-2 only: verify current call admission, reproduce
original observable `resolve`/`then` rows and intrinsic positive controls, then
implement the documented per-element pipeline in the existing combinator
lowering. Re-derive source locations and carrier assumptions from current main.
Record an exact current path manifest and paired standalone measurements;
retain all previously passing Promise controls and run relevant equivalence
and host controls. R3-3 custom constructors and R3-4 iterator closing remain
separate follow-ups, except shared prerequisites necessary for R3-2.

Before editing, check active claims and upstream PR overlap, particularly the
native async resource and combinator-body refactors. Coordinate shared files;
do not overwrite or duplicate their implementations. Each completed fix gets
its own upstream PR and a measured issue handoff.

### R3-2 implementation decisions (2026-09-13)

The historical R3-2 design steps 2 and 4 below are superseded for this bounded
implementation. `Get(Promise, "resolve")` is emitted inline under the target
exception tag, after JavaScript argument-list evaluation but before a direct
VEC pipeline begins; a getter failure rejects the already-created aggregate.
For literals this means every element expression is first evaluated into a
local, then the one `resolve` Get occurs — compile-time instruction buffers are
not evidence of runtime evaluation order.

Each `Invoke(next, "then", handlers)` performs one `__extern_get(next,
"then")`, classifies the captured value, and calls that exact captured closure
with `next` as receiver. Do not pair a getter-based callability probe with a
second dispatcher Get: an accessor may return a different closure on its second
read. For `race`, the result capability's resolve and reject closure objects
are minted once per aggregate and reused for every element; for `all`, each
resolve-element closure remains per-element while the reject closure is shared.

Admission remains direct VEC only: externref vectors and f64 `number[]`
vectors are consumed in sequence. The latter box each slot at consumption time,
so an earlier `resolve` Call can mutate a later slot. Generic iterables,
Set/Map projection, custom constructors, and iterator closing remain outside
this slice. These boundaries and the source-wide syntactic observable gate are
admission constraints, not a claim that all 23 historical rows are closed.
The direct loop snapshots the vector's initial length. That is a known remaining
R3-2 limitation for ordinary arrays — source admission does not prove a fixed
length — rather than an unmeasured fixed-length proof. Live array-length
mutation remains follow-up ownership alongside the R3-4 generic-iterator work,
even though later-slot replacement is covered. No full R3-2 completion claim
is justified without that work and measured evidence.

For admitted `Promise.all`, the result state's remaining-elements count starts
with the iteration-completion sentinel. Each successful `Call(resolve, …)`
increments it before its `then` Invoke; the sentinel is decremented only after
the literal/direct-VEC iteration returns normally. This preserves an abrupt
`then` completion even when an earlier synchronous resolve-element callback has
already run. Native Node rejects the marker from
`{ then(ok) { ok(1); throw marker; } }`; the focused standalone control covers
that rejection and the corresponding successful one-element result vector.

Current bounded evidence on the e002 baseline is a 10/10 focused standalone
protocol suite (54.62 s, single fork): literal evaluation/Get order, one
captured resolve and call receiver/arity, contrasting and original-order
callback-arity probes, one captured `then`, abrupt Call rejection, the
remaining-elements sentinel, per-slot f64 boxing, and race handler identity.
The unchanged official `all/invoke-resolve.js` previously failed with
`callCount` 0 versus 3 and remains the acceptance row; its exact assembled
harness diagnostic is still required before claiming it fixed. A filtered WAT
compile registered the observable resolve-cap type, which proves route
registration but not the exact callback execution path.

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

## 2026-09-03 r3 implementation (Opus)

Base: `91d4999050de75d8e71e7ec6bc18f49952c9d3bf`. Base tree materialised to
`.tmp/basetree` for file-copy A/B; every delta below is a measured before/after
pair run by this lane, not an inherited figure.

### R3-1 — capability executor: `undefined` is "not yet stored" (LANDED, +4)

`ensureCustomCapabilityRuntime` decided "a slot was already stored" with
`ref.is_null`. Under the #2864 singleton regime the canonical `undefined` is a
NON-null externref, so `executor()` / `executor(undefined, undefined)` looked
"stored" and the spec-legal follow-up `executor(f, g)` threw. The guard now
routes through the object runtime's own `__extern_is_nullish` predicate when it
is registered, and keeps the original `ref.is_null` body byte-for-byte when it
is not (legacy regime, where undefined IS the null bit pattern).

Measured, same 8-row batch, `--standalone`:

| tree | result |
| --- | --- |
| base `.tmp/basetree` | 4 pass / 4 fail (all four `capability-executor-called-twice.js`) |
| branch | 8 pass / 0 fail |

Controls green on both lanes: `tests/issue-4682.test.ts` (3/3, including the
gc/host path), `tests/issue-5197-promise-generic-capability.test.ts` (10/10),
`tests/issue-4727.test.ts`.

### R3-8 — boolean results of `.then` handlers (LANDED, +2)

`coerceStackValueToExternref`'s `i32` arm boxed every i32 with
`f64.convert_i32_s` + `__box_number`, ignoring the i32 `boolean` brand that the
canonical i32→externref rule in `type-coercion.ts` already honours. A handler
returning `boolean` therefore arrived as the number 1. The arm now picks
`__box_boolean` when `from.boolean === true` and `__box_boolean` is registered;
everything else is the previous body unchanged. The decision rides on the
ValType's own brand, so it is taken identically at all three call sites of
`coerceStackValueToExternref`, not per syntactic position.

Measured, same 2-row batch, `--standalone`: base 2 fail (`Actual [1, 1, 1] and
expected [true, true, true]`) -> branch 2 pass.

Controls green: `tests/promise-combinators.test.ts`,
`deno-safe-promise-combinators.test.ts`, `issue-3125.test.ts`,
`issue-3125-widen.test.ts`, `issue-4746.test.ts` (26 tests), plus a 15-row
currently-passing `Promise/{all,race,prototype/then}` standalone control
sample, 15/15 pass.

### R3-10 — an initializer-less `var` is not a proof of `undefined` (LANDED, +2)

`provablyNullishReceiver` accepted `typeFactOf(e).kind === "undefined"` for an
identifier whose declaration is an initializer-less, annotation-less
`var`/`let`. That is an EVOLVING `any`: TypeScript's control-flow analysis
narrows a use no assignment dominates to `undefined`, and a narrowing is not a
proof. `var resolveFunction;` filled only inside the executor therefore compiled
`hasOwnProperty.call(resolveFunction, "prototype")` to a static TypeError. The
gate now declines for that declaration shape (variable declaration or parameter
with neither type nor initializer) and keeps every genuine proof — the `null`
keyword, an explicitly `undefined`-typed binding.

Measured, same 3-row batch, `--standalone`:

| tree | result |
| --- | --- |
| base | 3 fail, all `Object.prototype.hasOwnProperty called on null or undefined` |
| branch | 2 pass; `executor-function-not-a-constructor.js` advances to the predicted #3371 text (`Expected a TypeError to be thrown` from the harness `isConstructor`), NOT claimed |

Controls: a 15-row `Object/prototype/{hasOwnProperty,isPrototypeOf}` +
`Function/prototype/{call,apply}` standalone batch, 14 pass / 1 fail —
`isPrototypeOf/this-value-is-in-prototype-chain-of-arg.js` fails IDENTICALLY on
the base tree (`called value is not a function`), so it is pre-existing, not a
regression. New control `tests/issue-5197-nullish-receiver-proof.test.ts` pins
both directions on both lanes.

Note for the record: `Object.prototype.hasOwnProperty.call(x, k)` where `x` is
declared `const x: undefined = undefined` does NOT throw in the HOST lane, on
base and on this branch alike. That is a separate pre-existing gap in the
borrowed-prototype nullish fold; the control uses the `undefined` keyword
instead so it asserts something both lanes actually agree on.

### R3-9 — GetCapabilitiesExecutor on the builtin-fn metadata carrier (LANDED, +2 of 3)

`$__promise_custom_capability_executor` subtyped the bare
`(externref, externref) -> ()` func-ref wrapper, so it carried no `name`/`length`
metadata. It now subtypes `ensureBuiltinFnMetaType(…, "promise:capexec", "", 2)`
— the SAME carrier Slice B gave the settle closures — with the `$capability`
capture appended AFTER the carrier's fields and read back through the recorded
`capabilityFieldIdx`, never a hard-coded `CLOSURE_CAPTURE_FIELD_BASE`. The two
`struct.new` mint sites are factored into one
`buildCustomCapabilityExecutorInstrs`, so the operand order lives in exactly one
place.

Measured, same 5-row batch, `--standalone`:

| tree | result |
| --- | --- |
| base | 2 pass / 3 fail (`executor-function-{name,property-order,prototype}.js`) |
| branch | 4 pass / 1 fail |

The plan claimed 3 rows; only **2** are claimable.
`executor-function-prototype.js` is blocked behind a DIFFERENT gap —
`Object.getPrototypeOf(executorFunction)` compared against
`Function.prototype` reaches `Function.prototype.call is not yet implemented in
--target standalone`, the same wall Slice B recorded for
`{resolve,reject}-function-prototype.js`. Not claimed.

Controls green: `tests/issue-4682.test.ts`, `issue-4727.test.ts`,
`issue-5197-promise-generic-capability.test.ts`,
`issue-5197-es2015-promise-r2.test.ts` — 27 tests. The R3-1 8-row batch was
re-run after this change (the executor capture index moved) and is still 8/8.

### R3-5 — own `then` on a native `$Promise`, captured at Resolve time (LANDED, +6 of 7)

Two defects, one fix each:

1. `buildPromiseResolveValueBody`'s `$Promise` arm adopted the native state
   directly, so §27.2.1.3.2 steps 8-13 `Get(resolution, "then")` never ran for a
   native promise carrying an own `then`. The arm now consults
   `__carrier_bag_has(peeled, "then")` and, when present, reads the value with
   `__extern_get`: callable -> enqueue `__promise_thenable_job` with the
   function captured NOW; own-but-not-callable -> fulfil with the promise object
   itself (step 11). Absent the carrier-bag natives the arm is not emitted at
   all, so a module with no promise expandos is byte-identical.
2. `__promise_thenable_job` re-dispatched `__call_m_then_vararg` at JOB time.
   `$__then_caps.callback` (previously always null on this job) now carries the
   Resolve-time function, and the job calls it through `__apply_closure` when
   set. The old dispatch is unchanged when it is null.

The decision is keyed on the peeled VALUE's own carrier bag, so it is taken
identically however the promise reaches Resolve.

Measured, same 7-row batch, `--standalone`: base 7 fail -> branch 6 pass / 1
fail. `race/resolve-prms-cstm-then.js` is NOT claimed — it needs the observable
combinator element pipeline (R3-2/R3-3), which this pass did not reach.

Controls: `tests/promise-expando-standalone.test.ts`, `issue-3125.test.ts`,
`issue-3125-widen.test.ts`, `issue-4167-test262.test.ts`,
`issue-2623-promise-subclass-identity.test.ts`, `issue-2867-gap4.test.ts` — 60
tests green. `issue-2623-p7b-observable-resolve.test.ts` has ONE failure
(`Promise.try is not a function` in the host lane) that reproduces IDENTICALLY
on the base tree — a node-version gap, not a regression.

New control `tests/issue-5197-own-then-indirection.test.ts` (13 rows, standalone,
`imports=[]` asserted) walks the value through nine indirections — variable, two
hops, object property, array element, call return, conditional, closure capture,
function parameter — plus three negative controls. base 11 fail / 2 pass ->
branch 13/13.

Two facts the plan did not state, both confirmed against node as the oracle:

- `Promise.resolve(p)` for a native `p` is §27.2.4.7.1 step 2 (return `p`
  itself), NOT Resolve. Routing an own-`then` probe through it passes on the
  base tree and proves nothing; the control therefore enters through
  `new Promise(res => res(x))`. The identity short-circuit is pinned as its own
  negative control so this change cannot quietly "fix" it into Resolve.
- Pre-existing, unrelated, NOT touched here: `Promise.resolve(w).then(cb)` where
  `w.then = 5` runs neither callback in standalone; node throws a TypeError.

### r3 pass summary (2026-09-03, Opus implementer)

Base `91d4999050de75d8e71e7ec6bc18f49952c9d3bf`. Five of the ten r3 steps
landed, each committed separately after its own before/after measurement.

| step | plan claim | verified | not claimed |
| --- | ---: | ---: | --- |
| R3-1 capability executor `undefined` slot | 4 | **4** | — |
| R3-8 boolean `.then` result box | 2 | **2** | — |
| R3-10 evolving `var` is not a nullish proof | 2 | **2** | `executor-function-not-a-constructor.js` (#3371, as the plan predicted) |
| R3-9 GetCapabilitiesExecutor metadata carrier | 3 | **2** | `executor-function-prototype.js` — blocked on `Function.prototype.call` in standalone, a gap the plan did not know about |
| R3-5 own `then` on a native promise | 7 | **6** | `race/resolve-prms-cstm-then.js` — needs the R3-2/R3-3 combinator pipeline |
| **total** | 18 | **16** | 2 |

NOT STARTED: R3-2 (23), R3-3 (27), R3-4 (7+6), R3-6 (5), R3-7 (2). R3-3 and
R3-4 depend on R3-2's element pipeline, which is the large one; R3-6 and R3-7
are independent and still open.

**Ship gate — never worse than base.** Final probe of all 25 rows this pass
touched: 23 pass / 2 fail, and both failures are the two rows named "not
claimed" above.

Regression sweep, `--standalone`, 153 rows sampled 1-in-4 from the 611
`built-ins/Promise/**` rows OUTSIDE the 118-row census (11 batches of ≤15):
90 pass / 63 non-pass. Every non-pass was A/B'd against the base tree:

- 6 rows outside the `allKeyed`/`allSettled`/`any` families
  (`prototype/finally/{is-a-method,subclass-reject-count,this-value-then-throws}.js`,
  `try/{args,promise}.js`, `withResolvers/promise.js`) fail with the IDENTICAL
  error on base — `__get_builtin` unsupported in standalone, and the
  `finally`-glue gap. Pre-existing.
- a 15-row suspect subset of the `allKeyed`/`allSettled` non-passes (every row
  whose name mentions resolve/then/thenable — the ones R3-5 could plausibly
  touch) produces the IDENTICAL non-pass set on base.

The sample was drawn as "all Promise rows minus the ES2015 census", so it
includes post-ES2015 families (`allKeyed` is a proposal) that were never
passing; that is why the raw pass rate looks low and why every non-pass needed
the base run. No pass -> non-pass transition was found.

Unit controls, both lanes: 27 (R3-9 batch) + 60 (R3-5 batch) + 26 (R3-8 batch)
+ 15 (R3-1 batch) tests green, plus the two new control files. One
pre-existing failure appears in `issue-2623-p7b-observable-resolve.test.ts`
(`Promise.try is not a function`, a host node-version gap) and reproduces on
base.

Every gate run bare before every commit: LOC, function, coercion-sites,
oracle-ratchet, dead-exports — plus `LOC_GATE_BASE=origin/main` simulations of
CI's base for the LOC and function budgets. TS7 typecheck clean.

### Round-3 review fixes (2026-09-03)

Two findings from the adversarial review of the r3 pass (both reproduced
independently by a skeptic against a `git archive 91d4999050` base, node as
oracle). The other four steps (R3-1, R3-8, R3-9, R3-5 main path) are untouched.

**F1 (high) — R3-10 landed on a constant-false lowering.** Declining the static
nullish proof for an initializer-less JS `var` did NOT make the receiver
dynamic in standalone: the checker still narrows the use to `undefined`, so
`compilePropertyIntrospection` (object-ops.ts) took its struct-field fold and
answered a constant `false` without reading the receiver. (The producer named
by the review, `call-object-builtins.ts`' refused-import fallback, is not the
path — `__hasOwnProperty` is a native define in standalone; the constant came
from the fold.) Consequences: a genuinely-undefined `var` stopped throwing
(base: TypeError), and the executor-filled `var` answered `false` for
`"length"`/`"name"` (node: true).

Fix:
- `provablyNullishReceiver` now declines the evolving-`var` shape ONLY for
  `Object.prototype.{hasOwnProperty,propertyIsEnumerable}` — the two whose
  borrowed lowering is the runtime own-property query. `isPrototypeOf` and
  `valueOf` go back to base's static fold: their borrowed `.call` lowers through
  the builtin method-value carrier whose native body does not perform
  `ToObject(this)`, so declining there would be a silent non-throw (measured:
  `var w; Object.prototype.isPrototypeOf.call(w, {})` returned `false`).
- `compilePropertyIntrospection` routes an evolving `var` the checker narrowed
  to nullish (`evolvingVarNullishNarrowed`, builtin-prototype-brand.ts) into
  its existing externref runtime arm (`__hasOwnProperty` /
  `__propertyIsEnumerable`) and precedes the call with a runtime nullish guard
  (`emitEvolvingNullishReceiverGuard`: `__extern_is_nullish` under the
  singleton regime, `ref.is_null` otherwise) that throws the same
  `TypeError: Object.prototype.<m> called on null or undefined` the static gate
  compiles. No-host lanes only; host is byte-identical.

Given up: nothing from the two claimed R3-10 rows. `isPrototypeOf`/`valueOf` on
an evolving `var` return to base behaviour (static TypeError) — no test262 row
depended on them.

| probe (standalone, JS input) | node | base | lane before | lane now |
| --- | --- | --- | --- | --- |
| p23 `var u; hasOwnProperty.call(u,"a")` | TypeError | TypeError | `false`, no throw | TypeError |
| p9 nullish-var bitmask (6 borrowed methods + later-filled var) | 0 | 0 | 5381 | 0 |
| p18 (hOP/isPrototypeOf/pIE/valueOf on undefined var) | 0 | 0 | 85 | 0 |
| p24b executor-filled var `[prototype,length,name,pIE,isProtoOf,typeof]` | 111111 | 222221 | 133111 | 111111 |
| synthetic t262 `undef-var-throws.js` | pass | pass | FAIL | pass |
| synthetic t262 `own-length.js` | pass | fail (TypeError) | fail (false≠true) | pass |

wasi: lane == base on p9/p18/p24b before and after (the wasi borrowed arm
never reached the fold). host: identical binaries.

**F2 (medium) — IsCallable(thenAction) missed bound functions.** The R3-5 arm
decided callability with one `ref.test <funcref-wrapper root>`; a bound
function (`$__bound_fn`) and the runtime-eval carrier failed it and the outer
promise was fulfilled with the promise OBJECT. Fix: the arm now calls
`__typeof_function`, the classifier predicate filled at finalize from
`buildClosureRefTestArms` (closures, bound functions, runtime-eval carrier,
boundary callable) — so it also sees carriers minted after the resolve body is
built. The root `ref.test` remains only as the fallback when the predicate
cannot be registered.

| own `then` = | node | base | lane before | lane now (standalone) |
| --- | --- | --- | --- | --- |
| bound function (p_f2) | 77 | 1 (adopted) | promise object | 77 |
| bound / plain / closure / arrow (p_diag `<digit><called>`) | 11/11/11/11 | 20/20/20/20 | 30/11/11/11 | 11/11/11/11 |
| plain, arrow, bound, class method, `Math.max`, `{}`, 42, null | 11110333 | — | — | 11110333 |

Residual on **wasi only** (pre-existing, reproduced on base): a bound `then`
whose body reads `this.k` as a call argument in a function compiled before any
`{k}` shape is registered reads `undefined` on wasi — `var f = (function(r){
r(this.k) }).bind({k:77}); f(cb)` gives `undefined` on BASE wasi too
(p_bt3 row C = 144 base and lane), and seeding a `{k:0}` literal earlier makes
the own-`then` row answer 77 (p_bt5). So on wasi the bound own-`then` is now
CALLED (spec) but may settle with `undefined` where base adopted the native
state (1). Standalone is unaffected (77). Not fixed here: it is the wasi
order-dependent dynamic read on `this`, not the callability decision.

wasi, per kind (base → lane): plain 2→1, arrow 2→1, class method 2→1,
`{}`/42/null 2→3 (step 11, node 3), bound 2→4 (the residual above),
`Math.max` TRAP→TRAP (identical on base — a pre-existing wasi trap on the
`Math.max` value read, not this arm).

Verification (standalone runner, this worktree): the 25 rows the pass touched
are 23 pass / 2 fail, the two failures being the two rows the pass never
claimed (`executor-function-prototype.js`, `race/resolve-prms-cstm-then.js`)
— all 16 claimed rows kept. The 174-row currently-passing `built-ins/Promise`
ES2015 control pool: 171 pass; the 3 non-passes (`all/ctx-non-ctor.js`,
`race/ctx-non-ctor.js`, `prototype/then/S25.4.5.3_A1.1_T1.js`) fail with the
identical "quickjs provider is not built" harness error on the base tree in
this container (eval-dependent rows, no built quickjs artifact) — not a
compiler result.

Controls: `tests/issue-5197-nullish-receiver-proof.test.ts` gains a JS-input
(`.js` fileName) row asserting an EXISTING own key and the nullish throw;
`tests/issue-5197-own-then-indirection.test.ts` gains the eight-kind
callability matrix (node oracle 11110333).

## 2026-09-27: array-length prerequisite for held PR 5883

Reopened: passing earlier slices did not finish observable live iteration.
The independent array-length repair preserves the original six fixtures and
fixes reference and dynamic shrink/regrow, including descriptor refusal.
Implementation routes Array length descriptors away from the ordinary struct
field store, then clears stale backing only after validation (or above a
non-configurable stopping index). A shared compile/finalize fill keeps numeric
and reference holes coherent without minting late runtime types.

Ten focused checks pass on upstream main 2a58b9fe9f plus this patch. The original
baseline had 3/6 mutation cases passing; the identical six now pass 6/6.
The two dependency probes establish zero-import compilation, not execution of
an exported setter. Full history and limitations are in
`plan/agent-context/5883-array-length-repair-20260927.md`.

This prerequisite does not complete Promise iterator acquisition, custom array
prototype storage, IR equivalence, or legacy retirement. No frozen Promise
source, test expectation, CI workflow, or acceptance denominator is changed.

## 2026-10-06: held PR5883 validation and pinned main composition

The published checkpoint is64849f95d2a0482820bafdd90bb0852184baeab1.
Its head CI completed successfully, but it remains held and conflicts with main;
neither those checks nor this issue's earlier passing slices prove completion.

Local8b9e89a5f9009d7a17a8c6410fa2ea2b1d0b3960 integrates d0a13 and is
undergoing the full frozen comparison in execution session65800. Canonical,
compiler-reader176/176, text-reader992/992 and runtime505/505 stages completed;
incoming2403 and the subsequent repair305, successor73 and imported-main117
stages remain unaccepted. The intended total is4571 executions representing
4515 unique identities. Original failures and all input/fixture authorities are
retained. Runtime preservation controls are not an end-to-end IR pass claim.

To avoid changing that run, parent created a separate managed checkout at
/Users/thomas/.codex/worktrees/5883-main4bff-composition/js2, branch
codex/5883-main4bff-composition-20261006, and began a no-commit merge of pinned
4bffef14505f26558556a707931c711105a968af. Ten test-authority/caller conflicts
are unresolved. The automatic inventory union has1849 rows and SHA256
62dac966e6f945ba268a3ad76ee6b1e5215629234ab63e6f8ace744d8ecbfe22;
it retains every D row/field and adds exactly five main rows. No compiler tests
are authorized in the new checkout until the current heavy run terminates.

The parent-authored, staged implementation contract is recorded in the shared
[runtime/landing dependency issue](5399-javascript-runtime-safety-refusals.md),
sections "Incoming-main composition contract", "Pinned incoming acquisition
profiles and baseline preservation", and "Phase one coding release". Native
Sol6.1 Medium agent Laplace owns only a new fixed inventory-view helper, receipt
and control test. Existing callers and C1 are a later, separately reviewed phase.
Pinned main itself has a source-level inventory-profile mismatch; preserve the
unrepaired arm, narrowly repaired baseline and candidate as distinct arms with
exact fixture/assertion/result comparison. No measured main failure count is
claimed before execution. No gate waiver, hold removal or legacy retirement.

### Phase-two release after parent source review

Parent read all201 helper lines, the complete fixed receipt and all682 lines of
the new control test. Receipt SHA256 is
2b11315b63f58739bb17506a16ab6290ff7fc276c85b506ce8c0d73e8cfec136;
helper b11f32e62f3866aa6213b6ec5f0faeaa091d241af2509c49e9bece08abce86fd;
control test fc8016e71bd686e56542a537ec6f61fb4427f02d10357566a0180cdec91b5502.
Parent independently compared all three raw inverses, semantic projections and
raw replays against the exact Git blobs/current union: byte-exact throughout.
Union-to-incoming removes nine file rows and the three PR5883 moves; those are
explicit historical views only, not changes to production inventory.171 controls
are authored but unexecuted. Source review releases caller work, not acceptance.

Laplace owns acquisition-only conflict resolution in the seven previously named
policy callers, plus runtime-program-policy-evolution, well-known-symbol-policy-
evolution and number-prerequisite-policy-evolution. Prefer preserving the incoming
three-helper acquisition chain, with the new explicit union-to-incoming view
immediately around each actual physical inventory read. All downstream policy
fixtures/assertions and D's fairness changes remain. Both historical paths end at
the same588351-byte authority; add independent raw/semantic equivalence controls
between union-to-d followed by the old PR5883 chain and union-to-incoming followed
by the incoming three-helper chain. Retain all original171 new controls.

A separate Sol6.1 Medium writer may own acquisition-only updates to the three
incoming6866 physical-source successor tests and the three PR5883 inventory
successor tests (original, bba74 and d0a13). For every fresh physical read, select
its exact named view before invoking the unchanged historical proof. Preserve
all fixtures, expected profiles, corruption mutations and assertion identities;
physical-source corruption must still be observed on each actual re-read.
Account explicitly for additional receipt reads without dropping earlier trace
entries. Do not route only the positive fixture, cache a projection, change a
negative into an earlier unrelated failure, or weaken error expectations. Report
any control that cannot be preserved through acquisition-only edits before
altering its assertion. Additive controls may verify the new acquisition edge.

Neither writer may edit the fixed helper/receipt, C1's three authority files,
production sources or policy inventory, or stage/commit/complete the merge.
No Vitest/compiler execution until the parent releases the heavy-run slot.
C1 recipe reconciliation follows finalized caller bytes, with all historical
before-fields and D's120000/150000 probe budgets retained.

### Finally physical-control composition decision

Darwin preserved five acquisition files and stopped at the finally successor's
two physical-corruption controls. Parent inspected lines612-663: the current-
policy control requires the historical helper to read its authority four times
while rejecting raw and semantic corruption. Wrapping every mutated union read
in the new fail-closed projection rejects earlier, so it cannot preserve that
historical negative's failure owner/trace. Do not broaden its error expectations
or pretend an earlier rejection proves the historical control.

Preserve that historical control as an explicitly staged physical fixture:
authenticate the actual union freshly, derive the exact589117 witness, stage
those unchanged witness bytes in an owned temporary file, then run the original
healthy/corrupt/raw/semantic/restored sequence through actual reads of that file
with the original four historical-authority calls. Retain the receipt-corruption
sequence on the real historical receipt and keep its four-read assertion. Do
not replace the repository inventory with a historical profile or edit stored
fixtures/expected values. Document that staging preserves the historical reader
contract; it is not a claim about admission of the current union.

Add separate current-union physical controls: read the real union freshly,
verify its exact pinned profile, stage an exact copy in a second owned temporary
file, and check healthy projection plus raw-newline and semantic-row corruption
plus exact restoration through fresh file reads. Assert the new projection is
the rejection owner, authenticate fresh new receipts with explicit read traces,
and confirm no historical helper is called for rejected union inputs. Keep all
preexisting test identities, bodies' mutation semantics and historical assertion
values; add tests rather than replace the original negative population. Both
layers must pass, so no original proof obligation is traded for an easier one.
The same separation must be explicit in the repaired baseline/candidate plan.
Parent must review the actual diff before execution or acceptance.

### C1 reconciliation release after caller review

Parent read the complete ten-caller diff and both additive chain-equivalence
controls. Seventeen physical reads now pass through the named incoming view;
all non-acquisition syntax and226 static registration expressions are retained.
The new control file has173 authored tests, zero executed; its original171-control
body is byte-identical. Final SHA is
aa3e133828d840abf4960cf90658e23e2b4d75abb337d34b7d91d06297bce3ce.
Pre-edit archive895dcf3e097edc2091b3675f2a1f69048a7d5f3d1c3a5ab506e416bad766accc
retains14 files including the ten original conflicts,1173427 decoded bytes.

Release Laplace to exactly the three remaining C1 files: helper authority JSON,
helper authority root and current-source test. Use finalized four instrument
files (boundary, runtime-program, well-known-symbol, number-prerequisite) and
refresh only their current pins/after-side inverse recipes plus the root/test
freeze. Preserve every historical before-pin/text/offset and span count from
the original authority; preserve all other current instrument and recipe fields.
Reconstruct each exact historical source by inverse and replay to final current
bytes, verifying independent old Git/blob/hash identities. Keep343 original C1
test identities/bodies and D's120000/150000 native-probe budgets unchanged; the
current-source test's only source change relative to D is the independent freeze.
No test execution, Git staging/commit/merge completion, policy/source change or
new budget grants. Return exact before/after field diff, all inverse/replay
checks, final hashes and any mismatch. Parent reviews before resolving the index
and publishing; no historical authority is regenerated from current sources.

### Failed-attempt archival release

The frozen run has printed failure markers but is still live; neither exact
failures nor a failed terminal result is inferred from those markers alone.
Darwin may prepare a separate failed-terminal evidence packer in C's .tmp,
leaving the reviewed success-only packer and all test sources unchanged. Actual
invocation requires parent confirmation of process termination.

Require the same explicit run/manifest/runner paths and SHA authorities. Inventory
every regular file under the run; reject symlinks/unsafe paths and unexpected
stage names. A failed-run archive must contain a contiguous prefix of the eight
declared stages, every present stage's invocation and terminal, successful earlier
terminals and one explicitly failed final terminal. Preserve all native/raw and
before/after bytes even when they record failures or input drift; report absent
optional records explicitly instead of inventing them. Record all unstarted
stages as unexecuted, not skipped/passed. Keep accepted=false and raw review
required, with stage outcome metadata subordinate to the retained records.

Retain the manifest, runner and original v2 boundary authority; authenticate their
expected hashes. Gzip/base64 streams carry byte counts, hashes and source paths.
Decode/readback every stream, recheck input inventory and bytes before exclusive
output creation in C's .tmp. Reject partial/live prefixes, unknown final outcome,
wrong authority and reused output. Artificial smoke fixtures only; no actual
run packaging before parent release, no compiler/Vitest/Git work, no changes to
the existing success packer. Parent reviews the complete script before use.

### Frozen run terminal result, not acceptance (15:23 CEST)

Execution65800 terminated exit1 on incoming23. Native report records2397/2403
passed,6 failed,0 pending across23 files; raw output additionally reports one
unhandled onTaskUpdate RPC timeout. All six failures report35000ms test timeouts:
two distinct manifest initializer/body mutations sharing one test name, one
manifest declaration-reordering control, and three runtime-data seam receipts
(contracts/manifest.ts, runtime-manifest.ts, intrinsic-support.ts). Observed
durations range35141 to45589ms. Do not classify these as semantic passes or
waive the RPC failure. Native JSON alone omits that error channel.

Parent independently verified all23 exact identity multisets, including duplicate
names, against the predeclared manifest and both7769-file before/after pin maps.
There was no input drift. Native SHA256
6b01ea76b2fecd805212422a1d172401df5ea674ae06f81395880e4de3da0068;
raw SHA256d2f4ae6b0f879d8d55de9eef091b5e785573c2b3e7efcd14bc58fa96f3c18080.
Runtime/compiler/text/canonical earlier stage results remain scoped to8b9.
Repair-controls305, successor-proof73 and imported-main117 were not executed.

Next diagnostic must retain this entire attempt, preserve all six exact case
identities/multiplicity and run unchanged source. Any longer diagnostic deadline
is observation-only, not a committed timeout repair or acceptance result. Inspect
duplicate reconstruction within these six bodies and event-loop yield behavior
before proposing a bounded implementation fix. No fixture, assertion, denominator
or currentness/freshness check may be removed to reduce elapsed time.

### Exact-six diagnostic dispatch

Parent reviewed the complete failed-terminal packer and executed it only after
65800 terminated. Archive546102854cddc7114428503e74035fd4fc02514bfd05427026e6bb426a5c1c86
in C .tmp/5883-failed-successor-evidence-P9MBh8-20261006.json contains32
lossless streams/14598024 decoded bytes, accepted=false. It explicitly records
the three unexecuted stages. The original attempt remains untouched.

Release Darwin the single compiler-test slot for an observation-only diagnostic
of the exact six failed identities on unchanged D8b9. Derive selection from the
authenticated native report6b01ea76b2fecd805212422a1d172401df5ea674ae06f81395880e4de3da0068;
retain duplicate-name multiplicity. Run the two original files with exact-name
selection, fixed one worker/2048MB controls and an explicit120000ms diagnostic
deadline only. Assert exactly six selected cases and the complete original file
identity populations, with all other cases explicitly reported unselected.
Capture command/environment, original35-second failures, full raw/native output,
exit and before/after full manifest pins. Do not edit source or committed test
timeouts. Missing/extra selections, raw RPC errors or any drift reject diagnosis.
No other compiler run is authorized until this diagnostic terminates.

Parent inspected the failing bodies: the remaining global read/historicalRead
wrappers reconstruct sources again on each requested path, unlike the scoped
currentHistoricalRead used by previously repaired proofs. Timing work may later
reuse one freshly authenticated capture within a single proof, but no cross-case
cache, reduced source population or skipped mutation is authorized. Implement
only after reporting this unchanged diagnostic; parent retains repair release.

### Parent planning and Sol 6.1 dispatch contract

User reconfirmed that the parent writes implementation plans and files or updates
repository issues before dispatch. Bounded implementation and verification work
goes to native Sol 6.1 agents at medium effort; the parent owns acceptance,
integration and protected-queue landing. Do not substitute separate sidebar
sessions or let implementers silently expand their scope.

Darwin retains the exact-six observation-only diagnostic and the sole heavy-test
slot above. Laplace may independently audit the completed C1 refresh without
running compiler tests or editing source: compare all historical recipe fields
against independent Git blobs, recompute inverse/replay and current pins, and
check the 343-case test change is only its independent freeze. Report concrete
differences and evidence paths; passing an audit does not establish test success.

After the diagnostic, the parent will specify any demonstrated timing repair,
its exact writable files, preserved controls and before/after acceptance tests
before releasing implementation. Original failures and the raw RPC error remain
retained evidence. No legacy retirement, timeout waiver, fixture reduction or
additional migration scope is authorized by this dispatch.

### Six-timeout repair release after unchanged diagnostic

Diagnostic job2421 is terminal exit1. The unchanged D run selected exactly six
cases, preserving782 total identities and776 explicitly unselected cases. Six
assertions passed under the diagnostic120000ms deadline, but raw output contains
two onTaskUpdate RPC timeouts. It is rejected, not acceptance. Both7769-pin maps
were unchanged. Preserve directory
`.tmp/5883-six-historical-diagnostic-20261006-mkZqyl` in D; native SHA256
bf6803bfa16fd5fe7777532a2c93ff7775f08f7d8877ecb02e7acae57ec540b9,
raw SHA256e6bec7cff380149ae6fa5d57d8ef5e99c850f6bd52dc024fc17a4231c31aa82d.
Parent read terminal and complete raw output. Durations31.091–49.888seconds
demonstrate that increasing the assertion deadline does not cure the RPC failure.

Release Darwin to the two test files only in E, branch
codex/5883-main4bff-composition-20261006: historical-runtime-reconstruction and
runtime-data-contract-seam. D remains immutable. First archive exact pre-edit
bytes in E's .tmp and verify the seam retains the finalized acquisition changes.
Replace repeated global reconstruction in the failing parameterized proof bodies
with one fresh authenticated complete source capture per proof. Reuse the existing
currentHistoricalRead pattern, validating every runtimeContractCurrentPaths entry;
all non-population reads still delegate to the original composed reader. Scope
captures inside callbacks, never at suite/module level or across cases.

For initializer/body and declaration-reorder proofs, thread that same fresh
reader through positive validation, declaration lookup and mutation construction.
An optional reader parameter may be added to local mutation helpers; unchanged
callers must preserve their existing fresh-capture defaults. Retain the positive
callable validation, valid-syntax mutations, actual changed-text checks, original
failure expectations and all fixture values. For moved/retained seam receipts,
use a fresh local capture for the complete callback, retaining every row/hash/
declaration and mutation assertion. Do not rewrite unrelated global readers.

No production/helper authority changes, committed deadline increases, assertion
deletions, renamed cases or skipped cases. Preserve existing per-case event-loop
yields. Return source diff, before/after hashes, original registration/fixture
equality and a proposal for any additional within-case yield if still necessary;
do not introduce a yield-only timing workaround without parent review. New
freshness controls must prove a second capture observes changed mandatory input
and rejects it, then accepts restoration; no cached-source substitution.

Implementation first, no compiler tests until parent source review and explicit
serial-slot release. Acceptance starts with the same six identities under the
original35000ms deadline, zero raw RPC/unhandled errors, exact complete identity
multisets and stable before/after inputs. Then run both complete files with all
original782 identities plus separately accounted new controls. This does not
replace remaining full-composition or three-arm acceptance. Parent independently
verified C1's10 inverse/replays and12 current pins against Git before this release.

### Reviewed repair and original-deadline execution release

Darwin completed the two-file E repair. Parent read the full diff and Laplace
independently approved the exact final bytes. Historical test SHA256
da9d1e506f1b1bf994bdec3af74bb5151bb02cb2dcd77ad5dfefbb926271b9ce;
seam SHA256106889692b67ee87c3a5cce268985956834302bc3f8aa90ce6743fe1470b8d5f.
The original-byte archive in E `.tmp/5883-six-timeout-before-20261006.json`
has SHA256a49845207b9957e1ce1ea3207cac7a636a3cd5f883a70c36ea2eb6d4c866f252,
two files and238809 decoded bytes. All248 original assertion expressions,
57 registrations/parameter tables and both seam acquisition edges are preserved.
Four additive freshness controls require changed mandatory input rejection and
restoration acceptance. No timeout increase or additional yield was introduced.

Parent reviewed E `.tmp/5883-six-historical-acceptance-20261006.mts`, SHA256
5a256de3347ca32c816e317445618181dd6f2322517527d3284ace1ba84f103e, including
its cwd-relative imported pin helpers. Release one execution at35000ms with
one worker/2048MB. It enforces six selected original occurrences,786 complete
identities and780 explicitly unselected occurrences, preserving original782
plus four new controls. Full E source/test/script/config pin maps, Node identity,
pending4bff merge, original failed-run authorities, raw/native and terminal are
retained. Neither six passing assertions nor this targeted run grants full-suite
acceptance; raw worker errors reject it. No automatic retry or source mutation.

The three A documentation commits through0adac4bed9884c5e2e6a6ce8f0d02bf6df715e0d
were pushed to existing held PR5748 and independently verified on the remote.
Normal push checks passed, including18/18 numeric-local parity tests. No PR was
merged and no hold was removed. External test262 processes were observed during
preparation; their presence is environmental context, never a failure waiver or
authority to interrupt them.

The exact-six run subsequently terminated exit0 (job73628). E evidence directory
`.tmp/5883-six-historical-acceptance-20261006-huPmgk` records6 passed,0 failed,
780 explicitly unselected and786 complete identities. Parent reviewed complete
raw output: no RPC/unhandled errors. Independent comparison confirms identical
7769-input maps (SHA25632aaa62bbc2149477f5759f4b74a9c5159484559931dca85e4d453e565b579f3)
and exact identity multisets including duplicate names. The six durations are
2.725/2.567/3.324seconds historical and1.592/1.319/1.210seconds seam. This
establishes the six-case repair only; four new controls were not yet executed.

Next release preparation is a separate full-two-file runner, preserving this
attempt and enforcing636 historical plus150 seam cases:786 passed with no skips,
failures or todos, including original782 and four new controls. Keep the same
35000ms deadline, Node/control pins, explicit4bff composition and raw-error gate;
freeze input equality to the just-completed six-case map above. Parent reviews
the runner delta before execution. No source changes or automatic retries.

Parent read the complete two-file runner delta and independently syntax-checked
SHA2564f68727c162527d69da14643a2b4fb82b0f82c6ad90baf7f4d52761435436093
at E `.tmp/5883-two-file-historical-acceptance-20261006.mts`. One execution is
released to Darwin with the sole owned heavy-test slot. The runner removes the
name filter, authenticates the completed six-run's7769-input map and enforces all
786 exact identities, zero skipped/failed/todo, clean raw output and stable pins.
Original failures remain recorded separately. No further stages until review.

### Parallel preparation of pinned-main comparison arms

While E's two-file run owns the compiler slot, release Laplace to read-only
scope verification for original main A and narrowly repaired main B, both pinned
to4bffef14505f26558556a707931c711105a968af. Read actual Git blobs, not working
main or summaries. Enumerate every physical inventory acquisition reaching the
589117-byte incoming chain, identify the exact wrapper insertion needed for
main-to-incoming, and distinguish caller repairs from additive candidate proofs.
For each proposed B file, retain all parameter tables, assertion bodies, fixture
values, timeouts, failure ownership and physical-source read traces. Identify
dependent C1 current pins/after-side recipes requiring reconciliation; historical
before-fields must remain unchanged. Flag any site needing more than acquisition
repair rather than silently redesigning it.

Return a concrete path/function/reader inventory and minimal B patch specification
for parent decision. Do not edit E, create baseline worktrees, run tests, change
main, or generate authority from candidate outputs. Test identity populations
must subsequently be collected natively and measured; static registration counts
are not denominators. A's original failures and raw error channel will remain
untouched, and B/C comparison must use exact common identities/results with all
candidate-only controls separately accounted. This preparation does not waive
the full E comparison or authorize an easier acceptance target.

### Additional acquisition sites found before full-composition acceptance

Laplace's pinned4bff audit found24 ordinary physical acquisition sites in17
caller files, plus the three6866 successor acquisition paths. Static counts are
not native test denominators. Parent independently inspected E and confirmed
seven callers outside the earlier ten-file assignment still feed the physical
union directly into the finally predecessor reader, which expects589117 bytes:

- issue-3518-canonical-3c6-inventory-successor, raw;
- issue-3518-canonical-489d-inventory-successor, raw;
- issue-3518-current-main-inventory-successor, raw;
- issue-3518-lowering-analysis-preservation, applicationInput (non-h2 only);
- issue-3518-nested-stackification-policy-evolution, raw;
- issue-3518-semantic-provider-boundary, policy;
- issue-3518-validation-policy-evolution, actual.

Each filename is under tests and ends .test.ts. This is a source-level gap,
not a measured failure count. Release Laplace to prepare an apply_patch artifact
only under E .tmp, plus exact preimage hashes and static preservation evidence.
Do not apply it to the frozen E source tree while786-case validation runs.
For each of these seven files, add the named helper import and wrap only the
actual physical inventory read immediately inside the existing finally call
with capture5883Main4bffInventoryViewSource(value, "union-to-incoming"). Keep
the entire incoming chain, h2 branch, global readers, mutation operands, fixture
values, assertion bodies and budgets unchanged. No other paths or C1 edits.
Require exact preimages and full registration/fixture/assertion preservation;
stop on a failure-owner incompatibility. Parent reviews the artifact and applies
only after the active run is terminal, then revises candidate input authority
explicitly and includes all seven complete files in acceptance.

For future main B, all17 ordinary callers use the distinct main-to-incoming
profile. Its C1 body retains the original30000ms native deadline and no added
150000ms case budget; copying E's body would be an additional unauthorized
baseline repair. Only the four established current pins/after-side recipes and
independent freeze may change. Finally's physical controls need separate fixed
historical-witness and current-main projection controls, preserving original
rejection ownership and four-read trace. Original main A remains unchanged.

Parent read the complete seven-file proposed patch and verification report, then
independently authenticated the patch/archive hashes and all seven unchanged
source preimages. E `.tmp/laplace-4bff-additional-seven-20261006.apply_patch.txt`
SHA2568f06e133c84fe741c73e9cef03eb30f8883e944d61ab45849d159e0deff66c71
contains only seven imports and seven physical-read wrappers. Preimage archive
SHA256e546e12ca62cb8c1b56202843ff6cd52adbe5b1b5bcc832e8508cad9aec7c451
retains7 files/338625 decoded bytes. Static preservation covers152 registrations,
624 assertion expressions and36 parameter tables; these are not executed counts.
The source patch is approved but unapplied pending terminal786-run evidence.
After termination, recheck exact preimages before application; preserve that run's
original7769-pin result and define the seven-file delta for subsequent acceptance.

### Full two-file repair accepted; seven-site patch applied

Job46916 terminated exit0; E evidence directory
`.tmp/5883-two-file-historical-acceptance-20261006-rBuRO1` records786/786 passed
(636 historical,150 seam), zero failed/skipped/todo and clean complete raw output.
Native SHA2568f8e126119ba5408f88a55df34e6695cec2212c6532b2dbeeef7ccfd9fe947d3;
raw SHA256e9127ec708087ad130688b26ecb99bd8aba25ac9e8e5bfb7ff3eb60e25ecfb60.
Parent read the terminal and entire raw log and independently checked every
identity/multiplicity and all7769 before/after pins. This accepts the two-file
repair only, not overall successor or IR acceptance. All original attempts remain.

After that terminal confirmation, parent revalidated and applied only the seven
reviewed acquisition edits. All seven postimage byte counts and SHA256 values
match the approved patch report exactly. Subsequent validation must declare that
seven-file input delta; the successful run above must not be relabeled as covering
the revised candidate. No merge commit, push or hold removal has occurred in E.

Release Darwin the next serial validation slot for the complete new inventory-view
control file, issue-5883-main-4bff-inventory-views.test.ts: all173 declared cases,
original35000ms deadline, one worker/2048MB, zero failures/skips/todos and no raw
RPC/unhandled errors. Retain command/environment, complete raw/native/exit and
full source/script/test/config maps. Before execution, verify exactly the seven
approved postimage changes from the accepted7769 map and no other input delta.
Preserve the prior map and attempts. This focused helper check precedes the
remaining complete caller/C1/successor and full-composition checks; it replaces
none of them. Record collected names, not just aggregate totals.

### Candidate validation inventory after the pinned-main composition

Parent compared actual E test paths with the prior manifest:68 previously
declared files,29 changed tracked test files and one new untracked test file
produce86 distinct required test files. Eighteen are absent from the old manifest:
the seven additional acquisition callers, number-prerequisite/runtime-program/
well-known-symbol policy callers, axios-residual-mechanisms, typedarray-residue,
crypto-regime, the three6866 inventory successor files, source-map-position-
projection and the new173 inventory-view controls. These cannot be omitted merely
because the earlier D manifest did not know them.

The next collection plan must use the union of prior manifest.assertions keys,
actual changed tracked .test.ts paths versus8b9 and untracked .test.ts paths,
requiring exactly these86 files before any native collection. Preserve the
original68 identity multisets (four known additive freshness cases separately
accounted); obtain full native identities for the18 additional files. Do not
treat static registration counts or all-skipped collection as passing execution.
The earlier repeated56-case file across runtime/text stages remains explicit in
the eventual execution schedule rather than silently deduplicating executions.

Release Laplace only to prepare a read-only collection/inventory plan and a
candidate input-delta manifest in E .tmp. Derive the exact seven approved source
changes from the accepted7769 map, verify unchanged C1/helper authorities and
test deadlines, and enumerate native collection commands and expected file set.
No collection execution while Darwin owns the173-test slot, no source edits,
new authorities inferred from candidate results, merge commit or push. Parent
reviews the prepared inventory before authorizing collection and stage execution.

The complete inventory-view check terminated exit0 (job22850),173/173 passed,
zero failed/skipped/todo,7.08seconds. Parent reviewed complete raw output and
independently verified every native status, equal7769-input maps and exactly the
seven approved postimage deltas from the prior two-file epoch. Evidence is in E
`.tmp/5883-inventory-views-acceptance-20261006-eMlflk`; map SHA256
3a81552e88eea59b0f56c6ecd26411ba6c66481fe3c944e1156f2cfa92a5e658,
native443eb2a569775c9101fb920cc7a13ac6860a72c9fe5dcb7a30466120f7719606,
raw109ac53a17b5e5abfec584bd037fc4c7b6533556d592ba17793a4c164adb1bc3.
This proves the helper controls only. No caller/C1/full-composition acceptance
is inferred. The serial test slot is free for the next reviewed collection.

### Native86 collection release

Parent reviewed the prepared commands/requirements and independently verified
the86-file union from actual Git paths plus all7769 physical input hashes.
Plan E `.tmp/laplace-5883-candidate-86-collection-plan-20261006.json` has SHA256
89588f9a09e7c2974911aff71b0c0b4904ea12f91e7f160cc175569244d3d263;
delta `.tmp/laplace-5883-candidate-seven-input-delta-20261006.json` has SHA256
9447b59df00bc18c431e0d46d4bda257b01ce272ead6a5150ce36df6b6444307.
Release Laplace to the two proposed collection commands sequentially, using fresh
exclusive output directories and the impossible a^ name pattern. Require exact
native file sets, all cases unselected and no passed/failed/todo or raw errors.
Old68 must retain4515 original identities plus exactly four freshness controls;
the18 additional files require complete measured native identity multisets.
Preserve invocation, Node identity, command/environment, stdout/stderr, native,
terminal and full before/after maps. No source edits, automatic retries or actual
test execution. This collection result never substitutes for passing execution.

The first collection preflight stopped before launching Vitest because inherited
GIT_PAGER=cat was rejected by its blanket Git-environment check. Preserve E
`.tmp/laplace-5883-native86-old68-identity-preservation-20261006-mX2YJ9`, terminal
SHA25658a85c085a5b73fffa0bc802984c30971fb297060f1461eff8be81a0673cbbe2.
Both retained7769 maps equal the accepted3a81552e input authority; no native
counts were collected. Parent read the terminal and released a fresh launch with
env -u GIT_PAGER, matching earlier controlled runs. Do not weaken the override
check or change Git configuration. All collection/identity/raw checks remain.

### Parallel scoped-evidence packaging for the PR checkpoint

Release Darwin to create an inert lossless evidence archive under E .tmp only,
without compiler/test work or edits to source, existing reports or runners.
Include the previously verified failed full-run archive546102854cddc7114428503e74035fd4fc02514bfd05427026e6bb426a5c1c86
from C, plus every regular file from four terminal run directories: D's unchanged
six-case diagnostic mkZqyl, E's exact-six huPmgk, full-two-file rBuRO1 and173-view
eMlflk. Include their four exact runner sources and the approved seven-file patch,
preimage archive and verification report. Never read an active collection output
into this package or imply the incomplete full successor run passed.

Use explicit logical scope tags and source paths, unique safe row names, byte
counts, SHA256 and gzip/base64 payloads. Authenticate known report/runner/archive
hashes and terminal outcomes before packaging; reject symlinks, missing expected
files, duplicate rows or any source drift. Preserve raw error channels and
accepted=false at the package level: passed scoped checks are not overall
acceptance. Decode every row and compare it to its original source, then return
the exact inventory and package hash for parent independent verification. Keep
all originals untouched. No source checkpoint publication before parent review.

Parent independently decoded all32 rows of E
`.tmp/5883-scoped-checkpoint-evidence-20261006.json` and compared every byte to
its original, verifying15107850 decoded bytes and package SHA256
814d4c427440909a787b1bbed702a844f774e3e62fd8b9931abf10ad3dd012c8.
The package remains accepted=false and is not yet published.

### Next caller/C1 checkpoint validation preparation

After native86 collection, execute a bounded23-file checkpoint stage: the16
ordinary acquisition caller files other than runtime-data-contract-seam, the
C1 current-source file, and all six inventory successors (PR5883 original,
bba74,d0a13 and6866 finally,class-fields,source-map-position). This is the complete
changed acquisition/C1 blast-radius check, not a replacement for the remaining
86-file execution coverage, original repeated56-case execution or three-arm
comparison. The full786 and173 checks remain separately scoped evidence.

Release Darwin to prepare, not execute, a runner and exact23-file list in E .tmp.
Resolve names from the approved86 plan and require the described set exactly.
Expected identity multisets and total counts must come from the completed native
collection, authenticated by parent-approved hashes before execution; never
derive passing counts from static source. Keep original35000ms suite deadline
and unchanged120000/150000 C1 probe budgets, one worker/2048MB, full7769 maps
matching3a81552e, complete command/raw/native/exit, zero skipped/failed/todo and
no unhandled/RPC errors. Preserve all histories and stop on any failed stage.
No source edits, merge completion or execution before collection review/release.

### Three collection blockers: main4bff context successor plan

Parent read the complete native collection stderr and terminal record for
E `.tmp/laplace-5883-native86-old68-identity-preservation-20261006-lKxd9J`.
Exit1;3859 cases unselected, no passing execution, three suites failed before
registration. Missing original identities: earlier-main216, export-main24,
historical-reader420 (660 total). Additional18 were not launched. Native SHA256
a1643c89dc6e935a6fe6e94357fb71611315b49f4e3e7cb66c56cf3fa8f3ca15;
all7769 input pins remain3a81552e. Preserve this failed run without retries or
overwriting any stream; the next23 runner remains preparation-only.

The apparent missing builtin-static-globals and promise-class-receiver-drive
errors come from broad catches around the historical reader, not absent files.
That reader authenticates the entire historical successor dependency set. Its
context/types.ts input no longer matches the main5f epoch: incoming commit
192b3688090824a1c48a87ccbd3d9a0b9bb568aa added the hostBooleanReturn comment and
optional boolean field. Parent verified the candidate-versus8b9 diff contains
exactly those two lines for this path and no changes in either named missing file.
Keep the production addition. Do not repin the original main5f receipt or remove
dependency authentication to make collection succeed.

Implementation lane (Laplace, Sol6.1 medium): prepare a reviewed patch in E .tmp
for an additive, independently authenticated main4bff-to-predecessor context
source view. Record both complete source endpoints, the exact two-line span,
retained regions, Git provenance and reciprocal replay. Read the actual supplied
source, never substitute a stored whole historical operand. Reject source or
receipt mutation, wrong epoch, duplicate/missing span and stale captures. Other
paths must pass through unchanged without extra authority reads. Preserve the
existing main5f API, fixture bytes, assertions, mutation operands and error owners.
Apply the new view at current-source acquisition/composition boundaries before
the old main5f projection, not inside old inverse functions or after mutants are
constructed. Keep physical raw reads available and explicitly named.

Allowed patch scope: one new successor helper/receipt, one new focused test,
historical-promise-successors.ts composition sites, and acquisition-only changes
in issue-5883-main5f-reader-epoch.test.ts if needed to retain its historical
endpoint assertions. Existing tests/fixtures and historical-promise-main5f-epoch.ts
are immutable. Do not edit production, C1, deadlines, existing assertions or
earlier/export authenticators. If preserving a reader trace/error owner requires
a wider change, return the concrete conflict for parent review first.

Acceptance: independently verify Git endpoints and round-trip bytes; add fresh
capture/mutation/restore and foreign-path controls; preserve all old native
identity multisets and fixtures. Run new helper and the four affected existing
files under original budgets after parent source review, then recollect old68
and additional files with the additive test explicitly accounted. Collection is
not execution credit. Update input maps by exact reviewed delta, not blanket
repinning. Preserve original-main failures separately; this candidate repair
does not establish repaired-baseline equality or authorize legacy retirement.

Parallel lane (Darwin, Sol6.1 medium): preserve both terminal collection attempts
in a separate inert lossless archive in E .tmp, with full commands, raw streams,
native results where present, exits and input maps. No active-run capture, source
edits, native test execution, commits or publication. Parent owns issue updates,
patch review, test release, integration and protected-queue landing.

Parent independently decoded and byte-compared all12 rows/5801533 bytes of E
`.tmp/5883-old68-failed-collections-evidence-20261006.json`, SHA256
cd5269ae32003d55d6856f4a7bdc761c116344d95eddbfae7affed3e810717b4.
Both attempts remain failures; absent preflight native/command records are
explicitly absent, never fabricated. Package accepted=false.

Parent reviewed the independent additional18 collection runner E
`.tmp/5883-additional18-collection-20261006.mjs`, SHA256
1b73cf374c6c4c2be831e3cb87dad711283b072a9346aec1bb8a133c6dd15157.
It retains the existing pinned86 plan, exact18-file list,7769-input map3a81552e,
Node identity, impossible a^ selection, complete native/raw/exit evidence and
before/after checks. The old68 failure and missing660 identities are explicitly
retained as the overall result. This stage may collect independent identities
before the context repair, without retrying or waiving the failed old68 stage.
Execution release is conditional on the parent's owned pre-push checks finishing
and a fresh process/resource check. No source patch may be applied during it.

### Parent review: complete the two-path successor before applying

The first proposed context-only patch is preserved unapplied in E
`.tmp/laplace-5883-main4bff-context-successor-20261006.apply_patch.txt`, SHA256
c84cadf855847a37ae14d1eb3705ead2b49a7ca5e5fdccb9c57e1e204e23494a.
Parent read the entire patch and checked the complete historical receipt's
dependency/operand path set against the candidate-versus8b9 source diff. Exactly
TWO of those paths changed: context/types.ts and object-runtime.ts. Therefore a
context-only repair is incomplete; the latter would fail its unchanged main5f
endpoint check after the former is repaired. This is source-proven, not a newly
executed failure, and does not replace the preserved original raw failure.

object-runtime.ts gained an import of ensureStandaloneTaSubclassParentCtor plus
a three-line faithful TypedArray-parent dispatch before the existing fallback.
Producer commit1a1b50cb40bd984850e5f49daf350479ae728ad4, parent
d1f1fbdebcc7ca387fd2ec272e31862d8e92b315. Keep both production changes. Revise the
additive successor helper/receipt to cover these exact two paths, each with
complete predecessor/current pins, exact insertion spans, retained partitions,
producer provenance and reciprocal replay. Do not broaden into all source files
or accept arbitrary historical epochs. Preserve the v1 patch/preimages/report;
produce distinct v2 artifacts and keep source frozen during additional18.

The existing approved composition/acquisition-only edits remain the boundary;
all old fixtures, main5f inverse functions, assertions, explicit mutants and
their failure ownership stay unchanged. Extend new controls to both changed
paths and prove the entire existing historical dependency/operand closure
matches after this new layer and the unchanged existing transformations.
This is necessary source review before native tests, not permission to infer
execution success. The next native acceptance still includes all four affected
old files and the new controls under original deadlines and full identity checks.

Independent additional18 collection completed exit0 in E
`.tmp/5883-independent-additional18-identity-collection-20261006-OCMO17`.
Parent reviewed raw output and independently verified all2173 native identities
are unselected across exactly18 files, no failed suites, and all7769 before/after
input pins equal3a81552e. Native SHA256
c72dd9f0d67ee3b375e3debaf3f4bc4464ef18ce175570fe5611ae251ccdac42;
identities da070687f6848f69558933cda6386cd68c6224ff34c90d7c3602768efefd93f8;
terminal11ba0440bbfe572fffd2522641718d53c0a6278f17ba2707186890e7e3fe1b89.
Zero tests executed; old68 still failed with660 missing identities. No overall
collection or implementation acceptance. Source freeze for this run is released;
the v2 repair still requires parent review before application. The intended86
population is4519+2173=6692 unique cases before additive successor controls,
with the original56 repeated execution separately preserved.

Parent independently counted the pending23-file execution stage from the
original manifest and measured additional18 identities:2972 cases, comprising
2287 ordinary-caller cases,343 C1 and342 successor cases. None has executed in
this stage. The context/object-runtime repair's immediate old-test blast radius
is exactly936 cases:216 earlier-main,24 export-main,420 historical-reader and
276 main5f-reader-epoch. Preserve each original identity multiset and native
duplicate multiplicity; collect the new additive controls independently before
combining their measured count with936. These numbers are scheduling authorities,
not pass counts. Darwin may prepare the bounded runner in E .tmp while Laplace
prepares v2, but execution and changed-source input maps require parent review.
Retain35000ms native timeout, one worker/2048MB, all raw errors and complete
before/after maps; no retries or unselected cases in the actual execution stage.

Parent reviewed and applied the v2 patch554236591618d5ecfd14160d39f53c01165c0fc6bead64f4e0aadc17fa076ad4
after additional18 terminated. Independent source verification reconstructed
both exact Git predecessors, reciprocally replayed current sources, checked
producer/incoming hashes and every27-dependency/7-operand endpoint through the
unchanged main5f layer. Physical postcheck confirms7772 inputs: exactly two
existing test/helper changes plus three new files; all other inputs unchanged.
No production change and no native test execution in this step.

Five-file formatting check reported only the NEW successor JSON receipt needs
formatting. Release Laplace for formatting that new receipt, proving parsed JSON
equality, and updating its SHA literal only in the new helper and new test. All
old fixture bytes and v2 pre-format artifacts remain immutable. Return final
three new-file hashes and format results for parent review before collecting or
executing tests. Never use the obsolete unformatted hash as final run authority.

Parent verified the formatting-only JSON equivalence and exact single hash
substitutions in the two new TypeScript files. Final five-file format check is
clean. Parent independently enumerated and hashed all7772 physical inputs and
derived the final map from3a81552e plus only the reviewed two changes/three adds.
Map E `.tmp/5883-main4bff-v2-parent-map-20261006.json` SHA256
309eacc2b0f9b63d89f4a38a7c82fb2492a6bd296bd968c4732c70b7002c117e;
collection descriptor `.tmp/5883-main4bff-v2-helper-collection-authority-20261006.json`
SHA2565d7b797baab20fedac4cc2ed2492e42fb8b75194a5e328d2a267232b7dd4a41f.

Parent read the complete helper collection runner cdb5060cb07ad9a93b18ae31cdf566dc8c9d7b37c91dd4ea56e179e820c005fc
and reviewed the full acceptance runner's bounded corrections to d96bb95135ab9ccf5fdba907db393837f4bdbf90b9ac0e1417bdc4445720b33f.
Release only helper native collection against this descriptor and exact source
map, one worker/2048MB, original35s, all cases deliberately unselected. No static
47-case inference. Source freezes for collection. Actual936-plus-new execution
requires parent verification of the terminal native result and a separate
descriptor pinning every required collection stream; no blanket acceptance.

Helper collection terminated exit0 (job69790), native47 identities across one
file, all unselected. Parent read complete stdout/stderr and independently
verified native statuses, all artifact hashes and exact7772 before/after map
309eacc2. Evidence E `.tmp/5883-main4bff-v2-helper-identity-collection-20261006-XVNXuN`;
nativecfed462d41b3185e0576d218758c26f9c8a905256da9dd7e72b94df999f5a690,
terminal49b07d2357d9d5d33a45bbd2ff1b64aa8144a81b54dfff8133fb28487f472d17.
Release the reviewed d96 acceptance runner only with the separately pinned
parent descriptor:936 original identities plus47 measured additive controls,
983 total, all selected. Retain original35000ms, one worker/2048MB, full raw
errors, exact identity multisets and7772 input-map checks. Source stays frozen
until terminal outcome. Stop on failure; no automatic retry or blanket success.
This scoped execution does not replace old68 recollection, next23 execution,
complete three-arm comparison, protected-queue checks or legacy-equivalence proof.

While the983 execution owns the test slot, Laplace may prepare only the old68
recollection runner in E .tmp. Reuse the reviewed original native86 collection
logic, selecting the exact original68 files and4515 identities plus the four
previously accepted freshness additions (4519 total). Replace only the source
epoch authority with the exact reviewed7772 map309eacc2 and two-change/three-add
descriptor5d7b797b, leaving the original manifest/identity authority untouched.
No new static denominator, automatic additional18 execution, source edits or
test launch. Preserve the prior failed runner and all attempts. Parent reviews
the new runner and releases it only after983 reaches a terminal outcome.

Parent copied the two independently verified inert archives byte-exact into E
`plan/agent-context/5883-scoped-checkpoint-evidence-20261006.json` (10010915bytes,
SHA814d4c427440909a787b1bbed702a844f774e3e62fd8b9931abf10ad3dd012c8) and
`plan/agent-context/5883-old68-failed-collections-evidence-20261006.json`
(2552552bytes,SHAcd5269ae32003d55d6856f4a7bdc761c116344d95eddbfae7affed3e810717b4).
Both retain accepted=false and every original is preserved. These handoff files
are prepared for the source checkpoint, not yet committed or pushed. They are
outside the declared src/tests/scripts/config input domain; no frozen execution
input was changed while983 ran. No outcome is promoted by packaging evidence.

The983 execution terminated exit0 (job30775), all983 passed, zero failed/skipped/
todo,371.30seconds. Parent read complete raw output and independently compared
every native identity against the original manifest plus the measured47 helper
identities. All7772 input pins remain309eacc2; instrumentation errors are empty.
Evidence E `.tmp/5883-main4bff-successor-v2-acceptance-20261006-kzRWTm`;
native275540825da0e35d1eec196158c2f886370d7dd275afcd5491aa8b9e5b323f13,
raw477e1f549ee596841c65f11dd7d6d3e7e5c1e3cdc138dfcb6b5b953753221595,
terminal649c2733214bcade8ce701fa6051a7f1ae7df2dcc8b69f23ef645f820e91a50d.
This closes the scoped two-path repair acceptance, not broader landing acceptance.
Parent reviewed old68 recollection runner264facf75a29de41a3d06135de140df63ce624ebccb31523212d2f0743fff4a6
against its immutable predecessor and releases that collection now: exact4519
identities, no passing execution credit, unchanged7772 inputs and original
resource controls. Preserve every original failed attempt; no automatic retries.

The prepared23 runner still pins the pre-repair7769 epoch and requires both
collection stages at one common input map. Preserve that property: after old68
terminates, prepare an explicit additional18 recollection against7772/309eacc2,
not a mixed-epoch acceptance exception. Compare all2173 identities to the prior
additional18 collection exactly, with no inferred additions or passing execution
credit. The separately collected47 new controls remain outside those86 files.
This is input-epoch validation for the existing checkpoint, not repeated test
execution or a new migration scope.

Darwin may prepare the distinct additional18 runner and revise the23 runner to
use the reviewed two-change/three-add descriptor and7772 map, preserving original
collection plans/fixtures/identity multisets and2972 expected executions. Remove
obsolete process telemetry and reject raw Error/FAIL/ERR_WORKER signatures as in
the reviewed983 runner. Preserve prior runner bytes. No actual23 execution until
both collection stages have terminal clean results on309eacc2 and parent has
reviewed the runner and exact authority descriptor. Never edit an active runner.

Old68 recollection terminated exit0 in E
`.tmp/laplace-5883-old68-v2-recollection-20261006-l9hajy`:4519 identities across
68 files, all unselected. Parent independently verified every identity multiset
against the immutable4515 manifest plus four recorded freshness additions, every
artifact hash, clean raw channels and unchanged7772 map309eacc2. Native SHA256
dd99b7ab6fda25db2889c8c47549111f0796ee3f8c906e3dc8821454ea4a89c9;
identities e77e729cc2248695b9d7101d500088eeffcde76d483fad01885ebc6b212acdd8.
All660 previously uncollected identities are recovered and already included in
the separate983 passing execution. The original failures remain preserved.
Collection itself adds zero passing execution credit; additional18 recollection
and23-file execution remain pending at this epoch.

Parallel evidence custody: Laplace may package only the terminal OCMO17
additional18 collection, XVNXuN helper collection, kzRWTm983 execution and
l9hajy old68 recollection into a new inert lossless archive under E .tmp.
Include every regular evidence file plus the four exact runner sources, final
parent map/descriptors and v2 patch/preimages/closure/verification/format-delta/
preformat archive. Pin the already recorded hashes, reject drift/duplicates/
symlinks, use explicit scope tags and accepted=false, and decode every payload
against its original. Do not capture the active/new additional18 or23 attempts,
overwrite originals, or change source. Parent verifies before publication.

Parent reviewed additional18 runner and caught a copied68-file guard before
launch. Corrected runner7d5cc478687b0b986b87385d02ee633faf160d0b0123bf11ebe80e4b59850797
requires exactly18 files matching the preserved2173 identity source. Release
that explicit recollection on7772/309eacc2 now; no source mutation or passing
execution credit. The23 runner f1c5549c006fe5a59eef34b9e18e4de724920a736724a3447b07f3bb59fe01f3
is prepared but remains unreleased until final review and both common-epoch
collection receipts are independently verified.

Additional18 recollection completed exit0 in E
`.tmp/5883-additional18-v2-recollection-20261006-dDNbv5`. Parent independently
verified all2173 identities equal the original OCMO17 identities, all unselected,
clean raw channels and exact7772 before/after map309eacc2. Native SHA256
b068f44902dcdf41c4ba9c6044897d3cf7a032835bdc725a67cdbba9fb354b60;
terminal4a8e1fd2239df6aa0ac03b0d0da5a0bac199670d0a030eb4fe8f4c86cf351cd1.
The full86 collection now has6692 identities at one input epoch; separate new
helper47 makes6739 across87 files. None of these collection counts is a pass
count. Parent read the complete23 runner f1c5549c and releases its2972-case
all-selected execution only with the common-epoch parent authority pinning
both complete collection records. Original C1 probe/case budgets120000/150000,
ordinary35000ms deadline and1worker/2048MB stay unchanged. Preserve raw errors,
all identities and full maps; no retry, source changes or overall acceptance.

Parent independently verified the completed four-terminal custody archive
`.tmp/laplace-5883-four-terminal-custody-20261006.json`: SHA256
b1830470ddffb2ea62e62b4f1cfb167347b4d35eae8c0e313a1500cf673fabed,
46 distinct regular files,13531830 decoded bytes and41 recorded pins. Every
decoded payload equals its original source bytes; accepted remains false.
The archive excludes the newer dDNbv5 collection and live N4b2EF execution.
Release Laplace to publish only this exact archive under E plan/agent-context,
using apply_patch and verifying the resulting bytes. No source/index/commit/
push changes, no test launch and no rewriting the earlier evidence archives.
Darwin continues the existing2972-case execution without restart. The parent
owns plan and issue decisions, independent result review and integration;
Sol6.1 medium agents implement bounded assignments. No broad migration scope
or legacy retirement is released by this evidence-packaging step.

### Full candidate execution schedule: preparation-only assignment

The2972 run is confirmed live as runner PID48415 with Vitest child48488.
While it runs, release Laplace to prepare an inert schedule under E .tmp,
not an executable launch or source change. Derive the complete87-file identity
multiset from the same-epoch old68 and additional18 native collections plus
the47 helper identities. Independently reconcile this to the preserved original
4515-identity manifest, four freshness additions and measured added files.
Keep the original56-case repeated stage as a separate execution occurrence;
do not deduplicate it. Report exact file/identity membership per proposed stage,
the unique and execution totals, and every original stage's preserved mapping.
Every identity needs measured native provenance, not a static inferred count.

The schedule must cover the whole candidate at7772/309eacc2, including cases
already passing in scoped runs; those runs are evidence, not permission to
omit cases from the final complete schedule. Preserve all fixtures, assertions,
original deadlines and C1 budgets, one worker/2048MB, full raw error rejection,
zero skipped/failed/todo, before/after input maps and explicit terminal records.
Separate candidate validation from the still-required original-main A and narrow
baseline B comparison: no candidate-only result may establish equivalence.
Return source authority hashes, exact schedule and any uncertainty for parent
review. No tests/builds, new source patches, staging, commits or pushes are
authorized by this preparation. The parent remains integration owner.

Parent independently verified schedule
`.tmp/laplace-5883-full-candidate-87-file-schedule-20261006.json`, SHA256
80cf174fa748f138e5ad233cb7601b22ffcbb7dfe3470c7ef9f153d31d370007.
All28 authority hashes,87 physical source pins and every native identity tuple
match. Original4515 identities are retained with exactly four measured freshness
additions; additional18 supplies2173 and helper47 supplies47, yielding6739
native identities and6795 executions with the original flat-layout56 repeated.
Parent checked original invocation file lists and preserved runner selections.

Approve stage placement: canonical, compiler176, text992, runtime505,
incoming2407, repair305, successor73, imported117, additional2173, helper47.
Release Laplace to prepare a new runner in E .tmp only, not execute it. Reuse
the reviewed scoped runner's source-domain capture, fixed canonical Node and
resource checks, exact HEAD/MERGE_HEAD checks, authority-before-import checks,
full raw Error/FAIL/RPC/worker/unhandled rejection and exact native identity
validation. Authenticate this schedule, all its authorities and7772 input map;
retain original stage ordering, multiplicities, deadlines and no-retry policy.
Create distinct per-stage invocation/before/raw/native/after/terminal records;
canonical has no native test report. Always retain terminal/after evidence on
failure and stop before later stages. Require an explicit parent-supplied runner
hash and free-slot release. No overall acceptance, A/B equality or delivery
claim can be emitted by this candidate runner. Parent reviews its full source
before launch; current2972 execution remains untouched and owns the test slot.

Parent read the complete179-line prepared runner
`.tmp/laplace-5883-full-candidate-20261006.mjs`, SHA256
6ed040be3c97dce0167bdfc44ff1c61cb43d28537585d76d523bd088fe60dbbe.
Independent canonical-Node syntax check passed. Parent verified that all7772
input paths satisfy its regular-file guard and both existing C1 budgets match
its checks; existing native snapshot fields match the strict report validation.
The runner remains unlaunched. Preserve it unchanged pending the2972 terminal
review and explicit free-slot release. Its stage and overall records retain
accepted=false even if every candidate stage finishes cleanly; original-main A,
narrow baseline B, exact common results and protected-queue delivery remain
separate requirements. No candidate-only success authorizes legacy retirement.

### Narrow baseline B: ordinary acquisition patch preparation

Recovered the prior A/B audit from the issue and E's existing phase-two,
additional-seven, views and C1 verification records. These are E implementation
records, not B postimages. Original A remains the exact4bff Git tree, unmodified
and not yet executed. B production source must remain byte-identical to A.

Release Laplace to prepare, under E .tmp only, a patch against the exact4bff
Git blobs for the17 ordinary callers/24 physical inventory reads already
enumerated above. Introduce the explicit main-to-incoming view immediately
around each physical read inside its existing finally predecessor call. Retain
the finally/class-fields/source-map chain, non-h2 condition, all registration
and assertion bodies, tables, fixtures, mutations, error expectations, trace
checks and timeout bytes. Do not copy E caller postimages or timing repairs.
Each changed file must have a full Git preimage and hash plus a reviewable
before/after diff proving that only the import and acquisition wrapper changed.

The existing fixed helper b11f32e62f3866aa6213b6ec5f0faeaa091d241af2509c49e9bece08abce86fd
and receipt2b11315b63f58739bb17506a16ab6290ff7fc276c85b506ce8c0d73e8cfec136
may be proposed as exact additive test support, called only with main-to-incoming
in these B callers. Independently reverify that profile against Git:590770-byte
main b606727c951331096a458b46ef344e8042018089b04e0e1fa587d7045fad3d13 to
589117-byte incoming58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857.
Candidate output is not an authority for either endpoint. No production inventory
replacement, old fixture repinning, dynamic epoch inference or cached projection.

Exclude C1, the three6866 successor tests and additive controls from this first
patch; they require separately reviewed treatment. In particular B must retain
its original30000ms C1 probe and no added150000ms case budget, and finally's
historical physical negative must retain its original rejection owner/four-read
trace. Stop and report any ordinary caller that cannot meet acquisition-only
constraints. Return an unapplied patch, exact scope/preimages and verification
record. No A/B worktree creation, source application, compiler/tests, commit or
push is released. The running E2972 inputs and full-run runner stay frozen.

Parent reviewed ordinary-B patch31e26d1be0017c39b0d9fc4b3fd606f66372ed1977fc44d6adab08f4eae060a0
at E `.tmp/laplace-5883-baseline-b-ordinary-20261006.apply_patch.txt`.
Independent in-memory application against17 exact4bff Git preimages confirms
24 wrappers and one import per file; reversing only those additions restores
every original caller byte. The two added support files equal the reviewed
helper/receipt byte-for-byte. All934570 archived preimage bytes match Git;
archive SHAfa288018604a44daee59af7f4ce8b8aea1e8f1531e897be36fd02e65a04d6a08,
verification72fa5a951e87786990023b658d5d15b0ac0a90c070d792f704637c8b50adf1c4.
Parent independently reconstructed the raw/semantic main-to-incoming inverse
and replay against both Git blobs: exact590770-to589117 transformation.
The patch is still unapplied and unexecuted. Formatting, three successor
acquisition/control paths and B-specific C1 pins remain separate pending work;
do not infer a complete repaired baseline from this ordinary-callers review.

Release the next B preparation to Laplace: an independent unapplied patch for
the three issue-6866 finally/class-fields/source-map-position successor tests,
starting from their exact4bff Git blobs. Use main-to-incoming, never the candidate
union profile, at current physical acquisition boundaries before the unchanged
historical projections. Preserve every original fixture/identity/assertion/
mutation/timeout and explicit read trace. The previously approved finally
separation applies to B as well: authenticate fresh actual main, derive/stage
the exact incoming witness, then retain the historical healthy/corrupt/raw/
semantic/restored sequence and its original four historical authority reads.
Keep historical receipt-corruption controls on their real receipt. Add separate
physical main-profile controls for healthy/raw-newline/semantic corruption and
restoration, fresh receipt reads, correct new rejection owner and no historical
helper calls on rejected inputs. Added controls must be separately identified,
never substituted for original failures or counted as the original population.

Do not copy E postimages or alter the shared fixed support files. Return full
Git preimages, reviewable patch, exact old-versus-added identity declaration
(static only until native collection), and an assertion/trace preservation
account. If a historical obligation cannot be preserved, stop that edit and
report the specific mismatch. No C1 changes yet: its B-specific authority
depends on finalized and formatted acquisition bytes. No source application,
worktree creation, test/compiler execution, commit or push in this assignment.

Parent read the complete three-successor patch
5e67d268d16941ed00f706b5fb830981842fd1563ea4785d7e628da96f7c09de and independently
applied it in memory against57250 bytes of exact4bff Git preimages. Postimage
hashes match; all three parse without diagnostics. All145 original assertion
statements remain in order after accounting only for the approved staged-policy
reader substitution. Historical mutation/recovery and four-read assertions are
retained; two additive main-profile controls retain separate identities and
assert new-boundary rejection without extra historical calls. This is static
review, not native execution or a test count. Preimage archived0232062930fc517fab636e4452d03850416173b7e9b56e2492956572d80c98a;
verificationa354979e07639692abe6d90a605d002ad3ff6e8c5e4f9e2f0b8152ca8c466bf5.

Release formatting preparation only: combine the reviewed ordinary and successor
B patches in memory against4bff and format the20 changed test postimages with
the repository's existing Prettier configuration. Preserve both original patch
artifacts and all preimages. Keep the two fixed support files byte-identical.
Produce a new unapplied combined patch plus before/after hashes and AST-level
equivalence evidence that formatting changed no literals, statements, control
flow, tables, identities or timeouts. Do not copy E postimages, apply source,
change C1 yet, create worktrees, run tests/builds or mutate Git. Parent reviews
the final formatted bytes before authorizing B-specific C1 reconciliation.

Parent independently reconstructed the combined formatted patch from4bff and
both reviewed predecessors. All20 formatted postimages have equivalent parsed
syntax trees to the reviewed unformatted bytes; both support files are exact.
Combined patch600e48de3c3c2f5d245abca3245d2c0e3b2391d761c682e2c23e7f678a0fd05a;
verificationec28cd5beb46e349f6523d81fa227a7170e7a9851e0b262aa8ad8b6955cfe498.
It remains unapplied; no baseline result is claimed.

Release B-specific C1 patch preparation under E .tmp only, from exact4bff
Git originals plus those formatted B postimages. Scope is exactly
tests/helpers/ir-c1-authority.json, tests/helpers/ir-c1-authority-root.ts and
tests/issue-3518-c1-current-source.test.ts. Refresh only currentInstruments
entries3/9/10/11 (boundary/runtime-program/well-known-symbol/number-prerequisite)
and instrumentEdits1/7/8/9 after-side pins, offsets and spans as required by the
final B acquisition bytes. All before-pins, before-offsets and before-span text,
other instruments/recipes, immutable authorities, artifact/population/option
records and historical/current base declarations must remain unchanged.
Independently reconstruct every historical instrument and replay to its exact
B postimage; authenticate historical bytes against existing Git/archived roots,
not candidate output. Stop if the four-record scope is insufficient.

After final manifest formatting, update its anchor hash and the one independent
freeze literal only, retaining declarationPin and all C1 test-body bytes outside
that literal. B keeps the original30000ms probe deadline and no150000ms case
budget. Do not copy E's C1 file or its authority postimages. Include three exact
Git preimages, semantic JSON leaf-diff inventory, whole-file inverse/replay
evidence and proof that the test body/budgets/identities are unchanged. Return
an unapplied patch for parent review. No source application, test/compiler job,
worktree creation, commit, push or full-candidate launch is released here.

Parent independently reconstructed B C1 patch
5b13c101cc4229c3f6cd904c40b00f196383807a345aad1e255c2dbcfc001732.
All three preimages equal4bff Git; all12 current pins match the assembled B
postimages or untouched Git files. All10 recipes invert to their independent
historical Git blobs and replay exactly. Exactly86 semantic leaf changes fall
within the four authorized current pins/after-side recipes. The C1 body outside
its single freeze literal is byte-identical; declarationPin is unchanged, and
the manifest/anchor/freeze pins agree. Preimages454660cc58e0cc59e372ba5804c71977e863e57b231e37e65112a30e1983e2b3;
verificationfa4136c7c1b5b774ec7b6b1537cc4c4c32e69a4b548e5a78f765ef9c5918b1b3.

Prepare separate managed comparison checkouts at exact4bff: original-main A
stays source-clean; repaired B receives only the reviewed formatted22-file
patch and3-file C1 patch after checkout identity verification. No shared source
or hardlinked mutable fixtures, no installs and no changes to existing evidence
trees. Dependencies may reference the existing shared node_modules without
altering it. Authenticate every B postimage and an explicit complete input map;
prove production source and original fixture bytes equal A. Preserve original
A failures when its run is released, then collect measured A/B identities for
the exact common comparison. Creating or preparing these checkouts releases no
test/compiler execution: E2972 still owns the slot, and all results remain
unproven. Parent alone releases execution after reviewing source and evidence.

Comparison checkout paths: original A is
`/Users/thomas/.codex/worktrees/5883-original-main4bff-a/js2` (detached4bff,
clean verified after allowing the ordinary Git-LFS temporary-file operation).
B is `/Users/thomas/.codex/worktrees/5883-repaired-main4bff-b/js2`, branch
codex/5883-repaired-main4bff-b-20261006, clean4bff verified before release.
Laplace may apply only the two reviewed patches there and verify all25 resulting
paths plus the complete original-versus-repaired source domain. A stays read-only.

Parent physical inventory check finds69 of E's87 scheduled test files on A;
18 are absent from pinned main. This is file presence, not a native population
or a pass count. The absent paths are promise-main-reconcile, the two5748 vector
storage tests, and5883 flat-layout, historical-reader-successors, inventory-
source-successor, main-4bff-inventory-views, main-bba74-inventory-source-successor,
main-d0a13-inventory-source-successor, main4bff-reader-successor, main5f-reader-
epoch, observable-cache-unavailable, observable-drive-composition, observable-
service-boundary, pop-storage-regression, preservation-capability-order,
preservation-protocol and vec-terminal-repairs (all under tests with .test.ts).
Keep all18 in the full candidate schedule and disclose them separately in the
comparison. Never fabricate A/B results for absent files or silently omit them
from candidate validation. Native A/B collection must establish exact common
identities, including multiplicities and baseline-added versus candidate-added
controls; physical presence alone is insufficient. Preserve original A's
collection/execution failures and raw channels without relabeling them as B.

Parent independently verified applied B against both physical trees and the
reviewed records. A has7735 inputs, map8af103a477f6805b97021323ce95967df6cf4a913efbdf4215dc53648f5622ea;
B has7737, map4e345c78323ec2362484a766e3fabe6c8150a71efad0807d7a20101027a78fa0.
Exactly23 existing test/support paths changed and two support paths were added;
all25 postimages match, all other inputs equal A, including production/config
and every original fixture. Integration record in B .tmp:
laplace-5883-baseline-b-integration-20261006-verification.json,
SHA6781575ce080daf99dcb4d01d8c36db5281408fbc60cdef7dab7000f2c13ada8.
Neither baseline has executed tests; source preparation is not equivalence.

Release preparation only of native A/B collection runners under B .tmp. Use
the exact69 physical test paths common to pinned A and E's reviewed87 schedule;
retain a complete explicit list of the18 candidate-only paths. Authenticate the
two full maps, source identities, schedule and integration record. Collect each
arm independently with an impossible test-name selector, canonical Node and
original resource limits: zero test executions, every collected identity tuple
and multiplicity retained, native/raw/error/exit/before/after records separate
per arm. No static count may substitute for a native denominator. Missing
native output or collection errors remain visible, not empty success; do not
require A to pass or repair its errors. Stop for source/authority drift. Any
future release must explicitly govern whether the B collection follows a
recorded A collection failure; no automatic retries or inferred acceptance.
Do not modify A/B source, provision dependencies, launch tests/compilers, or
change either candidate runner. Parent reviews full runner source before release.

Serial-slot priority after the existing2972 run: review its actual terminal,
full raw/native identity evidence and7772 map first. If clean, prioritize the
existing source checkpoint's normal checks, pending merge completion and
non-force publication to PR5883, plus the accumulated issue handoff to PR5748,
before starting another long acceptance run. Keep HOLD: publication is not
three-arm acceptance or delivery. No bypass of ordinary hooks or protected
queue checks. If committing changes only Git state while input bytes stay
identical, preserve the old full-run runner and prepare/review a new explicit
commit-bound runner; never silently relax its HEAD/MERGE_HEAD guards. If inputs
change, record a new epoch and reassess affected evidence. A demonstrated failure
requires its own bounded repair plan, not an automatic retry or early merge.

Parent read the complete A/B collection runner2d2dd339ba70412b799eb836c47914157f3e21ec4055d86098cb66094b2b1ba2
and independently syntax-checked it. Before release, add an explicit per-file
native status===passed collection guard alongside the existing all-skipped
case checks. Prior clean native collection l9hajy records that suite status;
it is not passing test execution. Preserve the reviewed runner version before
this one-line change. No launch or dependency provisioning is released by this
review; original A failures must still be retained in raw/native records.

Parent verified updated A/B runner32668aca7ae7df6e9a0191c3dfe9605c79e775e3dd59b6f723ea984236a2589a
differs from the preserved2d2dd339 source by exactly that suite-status guard;
canonical-Node syntax check passed. Parent provisioned only ignored node_modules
symlinks in A and B to `/Users/thomas/Code/js2/node_modules`, after verifying
both destinations absent and existing Vitest/TS7 available. No dependency
installation or shared-module mutation occurred. Source-map domains exclude
these links. Neither arm is released to execute while the candidate owns the
slot; launcher identity is recorded separately when collection is released.

Parallel custody assignment to Laplace: prepare an inert lossless archive under
B .tmp for the reviewed baseline work and completed new-epoch additional18
collection. Include all ordinary/successor/combined/C1 patches, preimage archives
and verification records; B integration record and complete A/B maps; the25
actual reviewed B postimages; current A/B collection runner and preserved prior
version/preparation record; E's full87 schedule and full-candidate runner; the
completed dDNbv5 collection's complete regular evidence files, its exact runner,
and common-epoch86 parent authority. Pin the known hashes, preserve provenance
and scope tags, reject symlinks/duplicates/drift, and decode every payload back
against its original. Package accepted=false and unexecuted A/B status clearly.
Do not capture the live N4b2EF output, repackage old archives, alter source,
commit/push, launch any test or delete originals. Parent independently verifies
before publishing the archive with the existing checkpoint.

Parent independently verified B custody archive
`.tmp/laplace-5883-baseline-and-additional18-custody-20261006.json`, SHA256
36a0fc7a6ebcaafebc6a2535571148537a0262b3bf53360e86f6b8d08e4676b4:
3080162 encoded bytes,55 unique regular files,9208250 decoded bytes. Every
decoded payload matches its current original and recorded pin; no live N4b2EF
output is included. A/B collectionExecuted/testsExecuted remain false and the
package remains accepted=false. Release Laplace to copy these exact bytes via
apply_patch into E plan/agent-context/5883-baseline-and-additional18-custody-20261006.json
and verify equality. No source/index/commit/push changes or test launch.

### Parent-owned dispatch and checkpoint release, 2026-10-06

The parent owns implementation specifications, issue updates, independent
acceptance review and integration. Native implementation agents use Sol 6.1
at medium effort; increase effort only for a demonstrated reasoning bottleneck.
Darwin retains ownership of the existing N4b2EF conformance process: poll the
same run, preserve all terminal evidence and do not retry or launch a successor.
Laplace is assigned a read-only publication preflight: enumerate exact owned
paths for the pending E merge, normal commit/push checks and the existing5883
remote destination. Flag unrelated or ambiguous paths instead of staging them.
Neither assignment permits source changes while the2972-case run is active.

The integration owner reviews the actual terminal result before releasing any
write or heavy check. A clean scoped result releases checkpoint publication,
not equivalence acceptance: keep HOLD and retain the full87 and separate A/B
requirements above. A failure releases only a newly documented bounded repair
after preserving the original failure. No new PR, scope expansion, automatic
test retry, legacy retirement or blanket staging is authorized by this dispatch.

Laplace's read-only publication preflight confirms the7772-input309eacc2 epoch
and identifies39 owned unstaged/untracked paths:29 existing test/support files,
six new test/support files and the four reviewed custody archives. Ten existing
paths retain unmerged index entries despite resolved working-tree content.
Preserve the71 already-staged paths:69 match incoming4bff exactly; the other two
are the reviewed compiler-boundaries inventory and context/types composition.
Before staging, regenerate and inspect the explicit path list; never infer
ownership from a broad directory or stage all. No unexplained paths were found
in this preflight, which is not authority for later unseen edits.

PR5883's checked remote head remains64849f95d2a0482820bafdd90bb0852184baeab1,
an ancestor of E HEAD. Publication targets fork repository ttraenkler/js2,
existing branch codex/5197-promise-observable-r3-2-20260913, by non-force push;
recheck that remote before writing. Normal hooks remain mandatory. In particular,
lint-staged may rewrite test/support or archive JSON with Prettier: compare all
input and archive hashes after hooks, and stop for review if frozen bytes change.
Keep ignored .tmp/dependencies and the separate docs worktree out of staging.

Parent independently verified N4b2EF terminal success:23 files and2972 complete
native identities all passed, with no failed/skipped/todo cases or raw worker,
RPC/unhandled/error signatures. All7772 before/after/current physical input
hashes still equal309eacc2. Native report SHA256
51d676e17c205df82e2d33f1137eb0ec82b8668fde07356263934f5bf68998fc;
raw6740 bytes SHA b0d62f96f6a3c0cfbfa50b9fc2d9a7e4c6e99f434cb5f297990f5167c62856af;
terminal SHA3c51e8124a4bbcd56d0b6de0d9d2c26449650ca0e932be53040faded5e42f11f.
This releases normal checkpoint preparation, not equivalence or HOLD removal.
Darwin may package the six completed run records plus exact runner, file-list
and collection authority in an inert lossless archive, accepted=false, verifying
each decoded payload. Laplace may perform read-only formatting preflight of the
39 owned publication paths. Neither assignment permits test execution or source
rewrites. Parent reviews their results before staging/committing the merge.

Formatting preflight found all35 test/support paths byte-stable and two of the
four custody wrappers needing only single-element array layout changes.
Parent authorizes normal Prettier formatting of those two wrappers after
preserving their original bytes: old68 archive cd5269ae... becomes
3ac02e3dffc9fdfea7ce8e21278d3ae149739861819dad1400cbb6ba392fd056;
scoped archive814d4c42... becomes
87847301195bc33f6665ce1aa7793571cc4f8fee91610d07a4f50977ff302961.
Require exact deep JSON equality, unchanged embedded payloads and unchanged
7772 input map. These wrapper-only changes do not alter tested compiler inputs
or retrospectively replace the authenticated original evidence archives.

Source checkpoint merge committed as112cea8e5a413eee1bec7ed955c14f73fc90bcdc,
parents8b9e89a5f9009d7a17a8c6410fa2ea2b1d0b3960 and
4bffef14505f26558556a707931c711105a968af. Parent verified clean working tree,
all7772 input bytes unchanged after normal fast hooks, and all five archive
hashes intact. Final caller/C1 archive is
plan/agent-context/5883-caller-c1-checkpoint-evidence-20261006.json,
SHA9e6677249434ac1c7bd93abbc9f2d99566bfb1bcc5d82e82217e59e1c7317d8e:
ten byte-exact records,4889888 decoded bytes,accepted=false. Normal non-force
push to the existing5883 branch is in progress, not yet verified published.

Prepare only a separate commit-bound full87 runner under E .tmp. Preserve the
existing6ed040be runner byte-for-byte and authenticate it from the successor.
Bind HEAD exactly112cea8e; replace the pending-merge requirement with exact
two-parent verification plus explicit absent MERGE_HEAD (quiet verification
must exit1 with no signal/spawn error/output, not an arbitrary Git failure).
Record mergeHead:null and the two merge parents in invocation metadata. Use a
distinct runner and output-prefix name. Change nothing in the87-file schedule,
6739 identities/6795 occurrences,7772 map, authorities, controls, deadlines,
raw/native failure rejection or accepted=false semantics. Parent reads the
entire successor and verifies its precise diff before any launch. No execution
is released while source publication checks own the serial slot.

Publication verified: existing PR5883 fork ref now equals
112cea8e5a413eee1bec7ed955c14f73fc90bcdc after normal typecheck, lint, formatting,
oracle/coercion ratchets,18 numeric-local tests and issue checks passed. Working
tree is clean. This is a published checkpoint, not main delivery or acceptance.
The parent read the entire commit-bound runner and verified its exact six-edit
diff from the preserved runner: new SHA256
f3244e0900f3e717570097e9421d7f2b777ba1306573c02a42cd5b54545b4327.
Release one serial full-candidate attempt with that exact runner/hash, canonical
Node and original resource controls, after verifying the slot is free. Preserve
all stage records and stop on the first failure. No automatic retries, baseline
launch, source edits, next-stage scope expansion or HOLD removal. Full candidate
success still requires independent review and separate A/B comparison.

Current full attempt: E .tmp/laplace-5883-full-candidate-committed112-20261006-4Dt9nJ,
runner PID17314, owned by Darwin. Parent independently verified canonical
typecheck, compiler-readers176/176, text-readers992/992 and runtime505/505;
each completed stage has clean raw output, exact native identity multisets and
unchanged7772 before/after pins. Text native SHA
fe0276eb1d0ed97cbc9aa77f7192909ac08ffe269702c182d8115875bb4a4776;
runtime native SHA8596e598ff95fe3a898c82a409de017ad3046ccc2a58d436418dc14c70b1c654.
The incoming23 stage with2407 scheduled cases is active. This is not a terminal
full-run result. Resume the same process/agent; never launch another attempt
because observation timed out. Remaining repair/successor/imported/additional/
helper stages and separate A/B comparison remain required. Source HEAD112cea8e,
all input pins, schedule and runner authorities remain frozen during execution.

Later exact-head CI snapshot for112cea8e: no pending/failed check runs. Quality,
smoke, the issue-tests aggregate with15 changed-file jobs, and equivalence gate
with eight shards completed successfully. Quality evidence:
https://github.com/loopdive/js2/actions/runs/37509282491/job/112425898365;
equivalence evidence:
https://github.com/loopdive/js2/actions/runs/37509282491/job/112431384457.
Test262 stubs and actual Test262 shard jobs were skipped; green report/regression
checks are not full conformance execution. Keep HOLD and the independent local
full-candidate/three-arm obligations. Read-only preflight may verify that the
prepared A/B collection runner still applies after E's commit and custody-wrapper
formatting; no baseline execution or instrument edits are released by this check.

### Parent-owned plan and Sol 6.1 implementation routing (2026-10-06)

The parent owns implementation specifications, issue updates, independent review
and landing decisions. Implementation goes to native Sol 6.1 agents at medium
effort by default; scope and acceptance criteria precede dispatch. Do not start
new migration scope or retire legacy code before full IR equivalence is proved.

Next bounded preparation: implement a final-candidate evidence packager only in
the repaired-baseline worktree's ignored `.tmp/` directory. Preserve the running
candidate, its runner, source inputs, schedule and existing archives unchanged.
The packager must refuse live/incomplete runs: require the root terminal and each
executed stage's records, then preserve exact original bytes using the existing
gzip/base64 custody convention, with safe unique relative paths, byte lengths
and SHA256 for every payload. Include invocation, raw/native results, input
maps, stage/root terminals, exact runner and schedule; explicitly identify any
record absent by design rather than inventing it. Verify round-trip bytes and
record the source commit and input-map authority. Always retain accepted=false:
candidate success alone does not establish equality with the repaired baseline.
Preserve terminal failures too: the executed stages must be a contiguous prefix
of clean stages followed by at most one failed stage, consistent with the root
terminal. List subsequent stages explicitly as unexecuted. A missing native
report for a failed child must be recorded as missing, never an empty result;
canonical typecheck has no native report by design. Reject unexplained holes or
contradictory terminal counts. Never require a failed run to have executed the
remaining schedule, and never manufacture evidence to complete its archive.
No execution against the live run, test launch, Git mutation or publication is
released by this preparation. Return the packager path/hash, complete expected
record list and source-only validation to the parent for review before use.

Read-only baseline-runner applicability review found no mismatch: exact A/B
heads remain4bff, their7735/7737 maps are unchanged, and E's7772 input map remains
309eacc2. The runner binds A/B Git state, not E's former pending merge or custody
wrapper formatting. This is applicability evidence, not baseline execution.

Dispatch is explicit: Avicenna (01a112aa-f27d-78c0-adfc-4faa8482b096) was spawned
with model gpt-6.1-sol and reasoning_effort medium for that packager-only scope.
The prior preparation agent could not verify its own model settings and made no
implementation changes. At19:22 UTC the existing PID17314 remained live, with
additional18 raw output advancing; no restart or competing heavy job was issued.

Avicenna returned the inert B packager
`.tmp/avicenna-5883-final-candidate-custody-20261006-01a03e4f.mjs`, SHA256
59d8d260efc0128fb044bdb35565e33490bfc133fedfe0d2c1f203f3a707cb0e.
Parent read its complete source and checked the native identity tuple against
the runner's imported authority. Its complete-run enumeration is63 payloads:
root terminal, runner/schedule/input-map,50 per-stage records and9 native
reports. Failed terminal prefixes retain explicit missing reports and unexecuted
stages; a live run without its root terminal cannot produce an archive. Source
syntax check passed independently. This is source review only: packaging has
not run and no terminal candidate result or baseline equality is claimed.

### Full candidate terminal and original-baseline collection release

The unchanged committed112 run4Dt9nJ finished at2026-10-06T20:40:37.448Z,
owner session58685 exit0. Parent independently verified all10 stage terminals,
all6795 passing executions/6739 unique identities across87 files, exact native
identity multisets, clean complete raw channels and all7772 before/after maps.
Current physical7772 input hashes and HEAD112cea8e also match the frozen epoch.
Root terminal SHA25610bde4889cdd2202e105ff4dc447b87ce5c74bafc12a346e503ad1a4040da6c9.
Additional18 passed2173/2173; helper47 passed47/47. This is candidate-only success,
not original/repaired baseline equality and not permission to remove HOLD.

Reviewed packager produced B `.tmp/5883-final-candidate-terminal-custody-20261006-reviewed.json`,
SHA256483c0d68fa8d490286daee7cafb2cf52bffff74227a5625de6fe270280febb06:
63 payloads,25747854 decoded bytes,10934029 archive bytes,accepted=false.
Parent independently decoded and compared every payload to its original.

Release exactly one original-main A69 identity collection with the already
reviewed runner32668aca, canonical Node and original1-worker/2048 controls,
after confirming the owned heavy slot is free. Preserve every original failure,
native row, raw channel and input map. This is zero-test-execution collection,
not a test pass or an assumed denominator. No automatic retry, B launch,
baseline edits or candidate changes. Parent reviews A's terminal before the
separately gated B collection. Publication of the new archive remains pending.

Original A69 collection fU4AKt/session93042 exited1 at20:44:55Z. All5166 available
native identities were skipped (zero executions); two suites failed collection:
earlier-main port rejects builtin-static-globals.ts and export-main port rejects
promise-class-receiver-drive.ts. Both failed suites have zero assertion rows,
so5166 is explicitly incomplete, not an accepted denominator. Preserve A intact.
Parent reviewed stderr, all artifact hashes, retained native identity rows and
unchanged A7735/B7737 before/after maps. A terminal SHA256
61a4652613b0a6609afe355915fc044cdb5f759ada95641d40d1e03b3f2b3931.

Release exactly one B69 collection with the same reviewed32668aca runner and
explicit reviewed-A terminal path/hash, unchanged resource controls and no
automatic retry or test execution. Preserve any B collection failures too.
This release does not authorize expanding baseline repairs or changing E/A.

B69 collection mZrzNm/session72820 exited1 at20:48:17.243Z with5168 skipped
identities and the same two zero-assertion collection failures. Parent verified
all recorded artifact hashes, native skipped rows and unchanged A/B before/after
maps. Terminal SHA2561c7f76d0413e4868ee5cab80cb2a2ca425d3a9c88a325e4d601f074ec3056a99.
Both original collection attempts remain immutable; no retry was released.

Next preparation is a bounded source-provenance audit, not baseline mutation.
For the two failing earlier/export suites, enumerate every physical source read,
compare pinned4bff source with the immutable original receipt expectations, and
identify exact producing Git deltas for each mismatch. Assess a standalone
test-only initial-read projection derived from actual baseline bytes, with
authenticated inverse spans and reciprocal replay. Preserve every original
fixture, assertion, registration and explicit mutant operand; never substitute a
historical whole-file read or import candidate-only implementation dependencies.
Do not copy E's broad successor machinery without proving baseline applicability.
Return exact required paths, source hashes, provenance and proposed disjoint
write set so the parent can finish the implementation specification. Meanwhile
preserve both collection attempts in a byte-exact gzip/base64 custody archive
under B .tmp, including their reviewed runner and maps. No source edits, tests,
new collection attempt, dependency installation or Git writes are authorized by
this preparation task. Parent owns final repair spec and release.

### Baseline promise-port reader repair: parent implementation specification

Checkpoint097dbf7880 is published on PR5748; normal push checks passed and the
remote ref was independently verified. Candidate evidence checkpoint446808ce4d
is on PR5883. Neither checkpoint is a merge or acceptance decision.

Parent independently verified the failed A/B collection custody archive
`.tmp/avicenna-5883-ab69-20261006-b7f42c19-custody.json` in B: SHA256
b64ad23508b7db149ba36d3fd34655e2e63e871f8d3d465af508f774ed542a22,
28 exact original payloads,20766102 decoded bytes,accepted=false,complete=false.
The source audit is3f96126d878b3593cda166fcfbb97c97fdec5a12c54eaad28b10a6ff1414da65;
parent independently checked all ten current/historical source endpoint hashes.
Seven differ; three already match. The available5166 original identities are
retained in67 collected suites. B adds two main-profile controls distinct from
E's16 additional controls. The missing two suites contain240 scheduled E cases;
no complete repaired-baseline population or equality has been established.

Implement only in isolated B worktree
`/Users/thomas/.codex/worktrees/5883-repaired-main4bff-b/js2`, branch
`codex/5883-repaired-main4bff-b-20261006`, pinned4bff with its existing25 repairs
preserved. Sole implementer is Avicenna, explicitly gpt-6.1-sol,medium effort.
Parent retains specification, independent review, execution release and landing.
Allowed writes are exactly:

- `tests/helpers/promise-export-main-port.ts`: import plus physical initial-read delegation only.
- New `tests/helpers/baseline-4bff-promise-port-projection.ts`.
- New `tests/helpers/baseline-4bff-promise-port-projection.json`.
- New `tests/issue-5883-baseline-4bff-promise-port-projection.test.ts`.

The new helper projects only builtin-static-globals,builtin-value-read,
carrier-bag-visibility,async-scheduler,promise-custom-combinator,
promise-class-receiver-drive and promise-combinators under src/codegen.
Dependency endpoints must equal the immutable earlier/export receipt pins;
combinators must equal export-after b296ba1c, not an earlier donor. Retain the
existing export inverse, three earlier inverses and B1 inverse unchanged.

Use actual freshly read physical B bytes as the operand. Authenticate whole
input byte length,SHA256 and Git blob before projection. Derive narrowly bounded
inverse spans from verified endpoint Git diffs, recording exact provenance,
coordinate units, ordered nonoverlapping spans and every retained complementary
interval. Producing nonmerge commits are provenance, NOT a presumed linear
chain: where branches diverge, authenticate the endpoint diff independently and
record first-parent integrations. Never reconstruct by returning a historical
whole-file payload. Copy retained intervals from the actual captured input,
check their pins, verify the projected endpoint and replay the forward spans to
the byte-identical captured input. Fail closed on unknown source epochs.

Pin the new receipt bytes independently in the helper; validate exact allowlist,
schema, spans, lengths and hashes without import cycles. No mutable cache may
hide a later physical edit. Unlisted reads pass through byte-exactly. Preserve
all explicit text/custom-reader parameters and mutant operands: no projection
inside existing authenticate/apply/transform functions. No existing fixtures,
assertions, test registration, production source or candidate dependencies change.

Add controls for all seven healthy projections and reciprocal replay, unlisted
pass-through, source drift within spans and retained gaps, receipt corruption,
missing/duplicate/shifted spans, wrong endpoints and forward replay corruption.
Prove fresh acquisition detects physical drift after a healthy read and accepts
restoration using an isolated temporary fixture root, not shared production
files. Exercise existing explicit custom-reader/receipt mutants unchanged.
Do not introduce a bypassable receipt-hash option merely to test deeper checks.

The layout-ownership and native-delay-source-preservation suites also import
the shared transforms. Their explicit source operands remain raw and must NOT
be silently normalized. Include them in the next scoped blast-radius run and
preserve any later failure as evidence requiring its own bounded diagnosis.

This dispatch authorizes source implementation and source-only verification,
not execution of compiler/tests/collections or Git mutations. Return exact diff,
new file hashes, provenance and control inventory for parent review. Parent then
releases focused controls plus the four affected suites in the single heavy
slot, retaining raw/native/terminal results. Only after that review create a new
B input-map epoch and collection runner; never overwrite either failed attempt
or its7737 map. Original A and validated E remain frozen. Acceptance continues
to require original identity preservation and exact repaired-B/E comparison,
with additive controls separately identified; no automatic HOLD removal.

### Baseline promise-port implementation and focused validation release

Avicenna returned the four-file patch and froze it for parent review. Parent
read the complete final helper and controls, confirmed the existing reader's
only change is import/initial-read delegation, and independently verified the
seven source endpoints,46 spans and53 retained intervals against physical B and
historical Git. Final file SHA256 pins are:

- promise-export-main-port.ts:3f240ccfd4da19145993f201e7bf598e23dd2ac9ccf5ea24d9a254ae4b0b179b
- baseline-4bff-promise-port-projection.ts:992583b59997f0cc6420142d927aa20045bec3734f6b6911d76772f8523adbd4
- baseline-4bff-promise-port-projection.json:f82ec8a702e1149900cde8b2d3e351e601d923ecb3ea75232ba3c4fff419e240
- issue-5883-baseline-4bff-promise-port-projection.test.ts:9124a847f84a2d9b739673f875f6d6115ef382b778ba22aa2f2b8893ef7f56cc

Parent released the focused controls followed, only if clean, by earlier/export
and both shared-consumer suites, using canonical Node22.23.2,one worker,2048MiB
and unchanged35000ms test timeout. Runner verifies pinned B head/branch and the
exact four-path delta from the preserved7737 input map, captures all7740 current
inputs before/after, and retains invocation,raw channels,native report and
terminal for each stage. No original collection archive/map is overwritten.

Execution session74325 writes exclusively under new B
`.tmp/5883-baseline-promise-focused-20261006-3bWJ6h`, including a byte-exact copy
of the parent runner. Controls completed102/102,zero failed/skipped/todo,
unchanged7740 inputs,at21:08:41.653Z. The affected four-suite stage is running;
no result is claimed yet. This is scoped baseline validation,not A/B/E equality,
not acceptance,and not permission to clear HOLD. Source and controls remain
frozen during execution; no competing heavy job is released.

Focused session74325 completed exit1 at21:09:46.372Z. The two formerly
uncollectable suites now pass216/216 and24/24. Across all four affected files,
325/416 pass and91 fail,zero skips/todos,unchanged7740 inputs. Layout ownership
fails10/31; native source preservation fails81/145. Parent read native failure
rows and raw traces: every failure stops at promise-export span offset mismatch,
including seven assertions expecting later historical-validator messages.
These are retained failures,not accepted baseline results. The shared consumers'
initial readers still send raw4bff combinator bytes to the unchanged old inverse.

Parent follow-up implementation specification: only the physical acquisition
inside the two shared consumers may now call projectBaselinePromisePortSource
before beforePromiseExportMain. In layout ownership, wrap the existing
readFileSync result; in native source preservation, wrap the existing rawRead
result. Add one helper import per file. Keep root selection,rawRead,all existing
transforms,assertions,registrations,fixtures and explicit mutant construction
byte-identical. Mutants are constructed AFTER this initial boundary; never
normalize explicit arguments inside the old transforms or verifier callbacks.
Do not replace either physical reader with a historical file or candidate reader.

Sole writer remains Avicenna,gpt-6.1-sol/medium. Only these two existing test
files may change; freeze the preceding four-file repair. Source-only verification
must show exactly the two imports and two acquisition wrappers, and unchanged
original assertions. No test/compiler/collection or Git mutation is released
until parent reviews that diff. Preserve3bWJ6h and both original failed native
collections intact. A fresh subsequent run must have new records and a new
six-path input delta; the original7737 map remains immutable. This repair still
does not authorize changing source semantics,fixtures,denominators or HOLD.

Parent reviewed the completed two-site diff: only one import and physical-read
wrapper per file, with original assertions unchanged. Layout postimage is
8cf089c397d26cb8ed9d1c6bb24f859b279eac2282502a767263276c10e94743;
native-preservation postimage is
cac6bbdbc54c06cae86a8e65a734243856dee623a6ec9ba7a25dd4ca1511e71e.
Released focused-v2 session56112 after the prior run terminated. The new runner
pins all six paths,retains all7740 inputs,requires102 controls plus416 affected
cases, and compares exact native identity multisets with the preserved failed
run. It writes a new directory and never overwrites3bWJ6h. No result yet.

While v2 executes, Sol6.1/medium may prepare an inert custody packager under a
new uniquely named B.tmp path only. No source changes or tests. The packager
must refuse a live v2 run without a root terminal. On later parent release,
preserve all files from both focused run directories, the prior28-payload A/B
failure archive, source audit and proposal, and all six reviewed repair
postimages. Include exact runner bytes and maps already in each run directory;
retain each run's terminal result and explicit unexecuted stages/missing native
report if applicable. Never require success to preserve a failed run. Record
safe unique relative paths, exact lengths and SHA256, gzip/base64 originals,
then independently round-trip and compare every decoded payload to its source.
Preserve historical failed source pins through the original runner/map; do not
claim current six postimages were used by3bWJ6h. Always accepted=false; no
equality/landing inference. Return packager source/hash for parent review before
execution or publication. No Git mutation or candidate-tree write is delegated.

Focused-v2 CzL1Nu/session56112 completed exit0 at21:13:52.016Z: controls102/102
and affected416/416 pass,zero failed/skipped/todo,exact identity multisets match
the preserved first run,and7740 input hashes remain unchanged. Both runs report
11 public artifacts/19 executions with the optional historical pair NOT RUN;
this must not become a paired execution or physical acceptance claim.

Custody packager must additionally include every record in the two child
evidence directories named by those raw outputs: B.tmp
`delay-combinator-preservation-MSmWPh` (first run) and
`delay-combinator-preservation-EDZCeL` (v2), each with candidate start/progress/log,
native result,terminal and verdict. Refuse symlinks and unexplained inventory
changes. The scoped pass permits preparation of a new B69 collection epoch,
not a full baseline execution or equality claim. Parent review and publication
of the source/evidence checkpoint remain pending.
