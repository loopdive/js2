---
id: 1373b
title: "IR async Phase C: CPS lowering for await + async-return + async-throw"
status: in-progress
created: 2026-05-09
updated: 2026-08-03
priority: top
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: async
goal: ir-full-coverage
sprint: Backlog
depends_on: [1326c]
required_by: [2570]
assignee: ttraenkler/fable-4
model: fable
note: "Verified 2026-05-21: src/codegen/async-scheduler.ts exists; src/codegen/async-cps.ts does NOT exist yet (still pending #1042 introducing it). async-cluster-architect-spec.md exists. Unblocked 2026-06-16 (se1): sole dependency #1326c flipped done — Phase 1C microtask queue + chained .then landed on main."
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): DEFERRED EPIC, NOT dev-claimable this sprint. Commit 79dad304f ('docs(#55/#1373b): re-ground verdict — genuine EPIC, deferral correct') + 3897722bf de-prioritised CPS off top. The CPS gate-flip is blocked on the synchronous-consumption-contract architecture wall (larger than one sprint). Same epic as #1042. → backlog (was ready, but no landable slice)."
loc-budget-allow:
  # #1373b Phase C-1: IR claims the sync-pass-through async population.
  # Growth is the core feature work (IR selection/build/lowering + the
  # engine-consistency wiring in the codegen driver). Intended.
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/builder.ts
  - src/ir/async-plan.ts
  - src/ir/index.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - tests/ir/issue-1373b-async-plan.test.ts
---
# #1373b — IR async Phase C: CPS lowering

## Update — playground free async family complete (2026-08-03)

#4102, #4104, #4106, #4110, and #4124 now prepare the complete playground
free-function chain `delay -> fetchUser -> {fetchAllSequential,
fetchAllParallel} -> main`. The bounded host census is 37/37 IR bodies, 30
legacy bodies, zero Unsupported, and zero Invariant outcomes. The reconciled
fallback gate retires its preliminary `async-function` count from four to
zero, and an active direct-body poison shadow proves the migrated family does
not execute the legacy async body compiler.

#4124 generalizes the AST-free plan/frame consumer to five-state counted-loop
and three-state/two-suspension graphs with typed spill updates, exact
per-suspension restores, semantic clock/concat/number-format/log providers,
and canonical Promise<void> settlement. Runtime and WAT parity cover both
rejection edges and every retained optimization.

This does not close the broader async epic. Async methods, closures, function
expressions/arrows, `for await`, async generators, `yield*`, standalone/WASI
prepared consumers, and final deletion of AST planners/activation hooks remain
owned by #3527 and the remaining-body checklist in #4124.

## Update — AST-free plan/Promise ABI foundation (2026-08-02)

The strict R0 production ledger was re-measured on `origin/main` at
`b310b3b3c5e`: 5/5 playground entries produced 37 terminal units, 33 IR
bodies, 35 legacy bodies, and exactly four typed async blockers in
`website/playground/examples/js/async.ts`:

- `fetchAllParallel` — `select/body-shape-rejected`;
- `fetchAllSequential` — `select/call-graph-closure`;
- `fetchUser` and `main` — `select/async-function`.

These are three distinct production populations, so widening or relabeling a
selector cannot safely close them. This bounded foundation adds
`src/ir/async-plan.ts`: one immutable, target-neutral `IrAsyncPlan` contract
with canonical Promise-only ABI, semantic Promise/scheduler intents, explicit
suspend/resume/rejection-handler edges, typed frame spills, deterministic
serialization/content hashing, and a fail-closed graph/liveness/purity
verifier. It rejects AST/checker/codegen callbacks, raw Wasm, target/backend
selection, concrete Wasm indices, raw-value-or-Promise ABI, bad edges, and
under/over-reported suspension liveness.

This slice intentionally changes no selector, async activation, planner,
frame, scheduler, import manifest, or production route. Anti-vacuity tests pin
the exact four typed outcomes and execute the existing two-suspension frame
engine, while hand-built plan tests cover two suspends, a branch/back-edge,
handler routing, exact liveness, target-independent hashes, and malformed-plan
negative controls. The next critical-path slice is to produce this plan from a
Prepared async free-function unit and adapt the existing frame engine to
consume it; it must not build a second suspension engine or revive C-1's
consumer-sensitive raw-`T` ABI.

## Implementation Plan (AUTHORITATIVE — re-grounded 2026-07-18, fable-4, fable-final sprint)

**This section supersedes every plan below it for execution purposes.** The S53
joint spec (N+1 lifted continuation functions, `splitAsyncIntoStates`,
per-state funcs) and the June re-measurements were written before the async
engine convergence landed. Building the S53 design today would FORK the engine
— exactly the #2367 graveyard anti-pattern. Read this section; treat everything
below as history.

### What changed on main since the S53 spec (the re-grounding)

1. **ONE async engine exists and owns activation.** `src/codegen/async-cps.ts`
   (planners: `planAsyncCfg` / `planLinearAwaits` / `planWhileLoopCfg` /
   `planForAwaitCfg` / `planForAwaitAsyncCfg` / `planAsyncGenCfg`) +
   `src/codegen/async-frame.ts` (the #2906 N-state CFG `$AsyncFrame` resume
   machine) + `src/codegen/async-scheduler.ts` (native `$Promise`, microtask
   ring, drain). #2967 slice 2c DELETED the old CPS engine (−582 LoC): one
   machine, two settle backends (`drive` = native/wasi, `host-drive` = JS-host).
   Entry point: `src/codegen/async-activation.ts` `decideAsyncActivation` →
   `maybeActivateAsync` (declarations) / `planAsyncClosureActivation`+
   `emitAsyncClosureBody` (arrows/fn-exprs).
2. **Two coexisting async models on the legacy path**, per function:
   - **Engine-activated** (`decideAsyncActivation ≠ null`): body = frame state
     machine; the fn's wasm result type is REWRITTEN to externref (a real
     Promise); call sites detect drive-lowered callees and skip wrapping.
   - **Legacy synchronous pass-through** (`decideAsyncActivation === null`):
     the fn compiles as a NORMAL synchronous function returning **raw T**
     (declarations.ts `unwrapPromiseType` unwraps `Promise<T>` in the
     registered signature); `await` is per-lane: native-carrier one-level
     unwrap (`emitStandaloneAwaitUnwrap`) on wasi, identity + the #3227
     `await Promise.resolve(x)` → `x` static substitution on the JS-host lane.
     The #1796/#1727 CONSUMPTION CONTRACT lives at the call site:
     `ctx.asyncFunctions` + `classifyAsyncConsumer` decide raw-T passthrough
     (value/await consumers) vs `wrapAsyncReturn` (thenable consumers).
3. **The July audit's sequencing rule** (plan/log/analysis-2026-07/00, §"Track
   B"): "#1042 convergence before #1373b (one engine)" — SATISFIED (#2967 done
   2026-07-11). #1373b is now: **"IR emits await nodes → ONE engine."** The IR
   must never build a second suspension machine.
4. **IR control flow is hybrid** (#2952): if/loop/try are *instructions with
   nested Instr buffers*, not CFG blocks; no br_table, no multi-level labeled
   exit. A general IR-level state split is therefore NOT buildable today — it
   needs #2952 (multi-exit CF) + #2949 (dynamic IrType) first. This bounds what
   Phase C can honestly ship this window.
5. `scripts/ir-fallback-baseline.json` `async-function` bucket = 4 (ratchet
   corpus). Slice-1 lowering arms exist in `src/ir/lower.ts` (`case "await"` /
   `"async.return"` / `"async.throw"` at ~L2887–3060) but are WRONG for the
   converged world (see C-1.3 below): unconditional `ref.cast $Promise` (traps
   on non-Promise operands), `unreachable` PENDING arm, and `async.return`
   mints a `$Promise` — which double-wraps against the #1796 call-site
   contract. From-ast constructs none of these nodes yet; `isAsyncIrReady`
   (select.ts:307) is hardcoded `false`.

### The Phase C shape (three sub-phases; C-1 is this PR)

The population of async functions splits cleanly by who owns them:

| population | owner today | Phase C disposition |
|---|---|---|
| engine-activated (genuinely suspending, engine-drivable shape) | `$AsyncFrame` machine | **stays on the engine — IR must DECLINE these** (C-2 re-buckets them as intended routing; C-3 eventually lowers them from IR onto the same engine) |
| legacy sync pass-through (await-elidable / non-drivable shapes) | legacy synchronous body compile | **C-1: IR claims these** with parity semantics (raw-T return, per-lane await unwrap) |

#### C-1 (THIS PR): IR claims the sync-pass-through population, engine-consistency gated

The invariant that makes this safe: **IR claims an async fn iff the engine
declines it** (`decideAsyncActivation === null`). Engine-activated functions
keep byte-identical routing; claimed functions get IR-lowered bodies with
semantics equal to the legacy sync pass-through they replace.

1. **`src/ir/select.ts`**
   - `IrSelectionOptions`: add
     `asyncEngineClaims?: (fn: ts.FunctionLikeDeclaration) => boolean`
     (bound by the real-compile call site to the engine's activation decision;
     `undefined` ⇒ treat as "engine claims" ⇒ never IR-claim — the safe
     default for bare `planIrCompilation` calls without codegen context).
   - `isAsyncIrReady(options, fn)`: return `true` iff
     `options.supportsAsyncIr === true` AND `ts.isFunctionDeclaration(fn)`
     (C-1 scope: declarations only — async methods/arrows have separate
     activation paths, #2957) AND fn has no asterisk AND
     `options.asyncEngineClaims?.(fn) === false` AND the body contains no
     `for await` (async iteration owned by the engine's 3b/3d lanes) and no
     nested async function-like (async arrow/fn-expr inside the body — their
     closure-lifted lowering is out of C-1 scope).
   - At the two `"async-function"` bucketing sites (~L873 declaration
     modifiers, ~L886 method modifiers): consult `isAsyncIrReady` — when ready,
     fall through to the NORMAL body-shape pipeline instead of returning the
     bucket (the body checks then see `await` expressions — extend the
     expression-shape whitelist to accept `ts.AwaitExpression` recursively on
     its operand). Methods keep returning the bucket in C-1.
2. **`src/ir/from-ast.ts`**
   - `funcKind: "async"` when the declaration has the AsyncKeyword (no
     asterisk).
   - Return type resolution: unwrap `Promise<T>` → `T` for the IR result type,
     matching declarations.ts's `unwrapPromiseType` so the IR-registered wasm
     signature equals the legacy-registered one (raw-T contract). Use the
     typeMap/annotation path — NO raw checker calls (oracle ratchet #1930).
   - `ts.AwaitExpression` lowering in the expression builder:
     - `await Promise.resolve(x)` / zero-arg form → lower `x` (resp.
       `undefined`) directly — parity with the #3227 static substitution
       (mirror `staticPromiseResolveSettledExpr`'s syntactic test).
     - operand whose IR type is non-externref (f64/i32 — e.g. awaiting a call
       to another sync-pass-through async fn) → passthrough, NO await node
       (parity: legacy identity await on a raw-T value).
     - otherwise → `IrInstrAwait { operand }`, result type externref.
   - `return e` in an async body → plain `IrTerminatorReturn` (raw-T
     contract). **`IrInstrAsyncReturn`/`IrInstrAsyncThrow` are NOT emitted in
     C-1** — they are reserved for C-3 (engine-targeted lowering, where the
     settle goes through the frame's result promise).
3. **`src/ir/lower.ts` — rewrite the `case "await"` arm** (the Slice-1 arm is
   wrong for the converged world):
   - New resolver capability
     `nativePromiseCarrierActive?: () => boolean` (bound to
     `isStandalonePromiseActive(ctx)` in integration.ts `makeResolver`).
   - Carrier ON (wasi lane): mirror `emitStandaloneAwaitUnwrap` semantics —
     **`ref.test $Promise` guard first** (non-`$Promise` externref passes
     through unchanged; the current unconditional `ref.cast` would trap on
     `await <plain object>`), then state branch: FULFILLED → value field;
     REJECTED → throw via exn tag; PENDING → match `emitStandaloneAwaitUnwrap`
     exactly (read what it does for pending — parity, NOT `unreachable`).
     Before writing this arm, diff it against
     `async-scheduler.ts emitStandaloneAwaitUnwrap` and keep the instruction
     sequence semantically identical; note in-code where they must stay in
     sync.
   - Carrier OFF (JS-host lane): identity — `emitValue(operand)` only, no
     Promise struct inspection (host promises are host objects; the sync model
     treats `await` as identity there).
   - `case "async.return"` / `case "async.throw"`: keep, but update the
     comment — unreachable from C-1 from-ast; C-3 consumers.
4. **Threading + integration**
   - `src/codegen/index.ts` `planIrCompilation` call (~L1733): pass
     `supportsAsyncIr: ctx.supportsAsyncIr` and `asyncEngineClaims` bound to a
     new exported pure helper in `async-activation.ts`:
     `asyncEngineWouldActivate(ctx, decl): boolean` (=
     `decideAsyncActivation(ctx, decl, /*isAsync*/ true,
     /*allowNonDeclaration*/ false) !== null`). Decision-only — no emission,
     no type rewrite.
   - `src/ir/integration.ts`: same options threading at its own
     `planIrCompilation` fallback (L157) — default absent (bare callers never
     claim async); `makeResolver`: bind `nativePromiseCarrierActive`.
   - Verify (do not assume): declarations.ts pre-pass registration
     (`ctx.asyncFunctions.add(name)`, unwrapped result type) runs for
     IR-claimed fns unchanged, so the #1796 call-site contract at LEGACY call
     sites of an IR-claimed async fn is untouched. Also verify the export-glue
     path (`function-body.ts:662` isAsync handling) for exported claimed fns.
   - `src/codegen/context/create-context.ts` `supportsAsyncIr` default: flip
     to `true` ONLY after local parity evidence (step 6); otherwise land
     default-false + follow-up flip PR. Decide on measurement, not optimism.
5. **What C-1 must NOT do**: no new suspension machinery, no frame structs, no
   microtask calls from IR, no changes to async-frame/async-cps planners, no
   claiming of engine-activated fns, no async methods/arrows, no async
   generators (stay in `async-generator` bucket).
5b. **The await-only consumption rule (discovered during implementation —
   load-bearing for parity).** Legacy's #1796 call-site contract classifies a
   call to an async fn per consumer (`classifyAsyncConsumer`, async-cps.ts):
   `await`/non-Promise-cast consumers get the raw `T`; **everything else is a
   THENABLE consumer and gets `wrapAsyncReturn` (`Promise.resolve` mint) at
   the call site**. The IR emits no such wrap, so a claimed caller using
   `return f();` / `const p = f();` would observably diverge from legacy
   (legacy: wrapped Promise → NaN under numeric coercion; IR: raw 42).
   Parity therefore requires: **a claimed body may reference a local async
   declaration ONLY as the immediate operand of an `await`** — enforced by
   the new `expr-async-callee-not-awaited` rejection in `isPhase1Expr`'s
   identifier-callee call arm (the await arm handles the direct
   `await f(...)` shape inline). Combined with the call-graph closure, the
   practical C-1 population is: **exported async declarations + the async
   fns they (transitively) await, plus fully-claimable sync callers that
   only `await` them.** Casts (`f() as any as number`) are not IR-claimable
   expressions anyway, so the cast-consumer population stays legacy
   automatically.
6. **Tests / verification**
   - `tests/ir/issue-1373b.test.ts`: extend — (a) selector: engine-activated
     shape (single tail await of a genuinely-pending call, wasi) is NOT
     claimed; sync-pass-through shape IS claimed when the flag is on;
     (b) lowering parity on both lanes: `async function f() { return await
     Promise.resolve(41) + 1 }` (host + wasi), `await <non-promise>`,
     `await <call to sync-async fn>` consumed as value, rejected settled
     promise → throw (wasi), exported async fn.
   - Byte-inertness probe (the −16/−29 discipline): for a program set covering
     engine-activated asyncs (multi-await wasi, host single-tail-await) hash
     gc/standalone/wasi binaries with the gate ON vs base — engine-activated
     routing must be byte-identical; only claimed sync-pass-through programs'
     bytes may change.
   - `pnpm run check:ir-fallbacks -- --update` refresh: `async-function` 4 →
     expected ≤ engine-activated residue.
   - Scoped suites: `tests/ir/*`, `tests/equivalence/async-function.test.ts`,
     `tests/equivalence/promise-chains.test.ts`, issue-1042*/2895/2906*
     async files, `tsc --noEmit`. ONE heavy run at a time (box discipline).
7. **Regression risks + rollback**: single-line rollback = default-false
   `supportsAsyncIr`. Risks: (a) signature drift between IR-registered and
   declaration-registered result types (unwrap mismatch) → covered by the
   exported-fn + call-site tests; (b) claimed body contains a shape whose IR
   lowering diverges from legacy sync semantics — bounded by the normal
   selector body checks (anything IR can't build stays legacy); (c) engine
   activation predicate drift (a future engine widening makes
   `asyncEngineClaims` true for a previously-claimed fn) — safe direction:
   IR declines more, engine claims more.

#### C-2 (follow-up, S): honest bucketing of the engine-activated residue

Split the fallback reason: `"async-function"` (unintended, ratchet to 0) vs a
new `"async-engine"` DEFERRED reason for fns the engine activates. After C-1 +
C-2 the unintended async bucket is 0 and the ratchet becomes meaningful; the
`async-engine` rows are *correct routing*, not a gap — they retire only via
C-3. Update `plan/log/ir-adoption.md` accordingly.

#### C-3 (next window, XL — blocked on #2952 + #2949): IR-CFG suspension onto the ONE engine

The durable end-state, spec'd here for a future window (Opus-buildable once
the blockers land):

- **Blockers**: #2952 (IR multi-exit control flow — loops/try as real CFG with
  back-edges, br_table) and #2949 (dynamic IrType). Without CFG-normalized
  control flow, block-splitting at awaits cannot represent an await inside a
  loop/try instr buffer — the same wall the AST planners hit, re-derived.
- **Design**: (1) new IR terminator `suspend { awaited: IrValueId, resume:
  IrBlockId, handler?: IrHandlerId }` — from-ast/normalization splits any
  block at each `IrInstrAwait`, the await's result becoming the resume block's
  blockArg; (2) lower.ts, for `funcKind: "async"` with suspend terminators,
  emits an ENTRY fn (allocate `$AsyncFrame` via the frame-core ABI —
  `buildAsyncFrameInfo`, `STATE`/`SENT`/`MODE`/`ABRUPT`/`ERROR` +
  `result_promise` — REUSED via resolver bindings, never forked) + ONE resume
  fn with the engine's dispatch shape (`try { block { loop { if-chain }}}`,
  states = resume blocks, spills = blockArgs + values live across a suspend —
  IR liveness is exact here, better than the AST planners' textual-remainder
  approximation); (3) settle backends: the SAME two (`__promise_fulfill`/
  `__promise_reject` native; `Promise_then2` host) bound through the resolver;
  step adapters reuse `async-frame.ts`'s per-fn adapter emission via an
  integration-side hook taking (resumeFuncIdx, frameTypeIdx). (4)
  `IrInstrAsyncReturn`/`IrInstrAsyncThrow` become the settle terminators.
- **Payoff**: awaits in arbitrary IR control flow (the shapes
  `planLinearAwaits` rejects), one engine, IR-exact liveness, and the
  `async-engine` bucket retires. Async generators follow as `settleYield` on
  the same machine (#2570/#2865 convergence), which is what finally retires
  the eager host generator buffer (#2662).

### Sync/coordination notes

- #2895 / #2570 / #2865 / #2662 (Track I siblings) build on the ENGINE, not on
  IR — C-1 touches none of their files except the pure
  `asyncEngineWouldActivate` export in async-activation.ts (additive).
- Do not touch `async-frame.ts` / `async-cps.ts` planner logic in this PR.

## Resume State (update as work proceeds)

- **Branch**: `issue-1373-ir-async-cps` (fork `ttraenkler/js2`, pushed).
  Working tree: the fable-4 agent worktree
  (`/workspace/.claude/worktrees/agent-a09a1f88a93af0c16`).
- **Claim**: `claim-issue.mjs 1373b ttraenkler/fable-4` taken 2026-07-18.
- **Done**: re-grounding vs main @667d162225; this plan; C-1 implementation —
  `src/codegen/async-static.ts` (leaf extraction of
  `awaitIsStaticallyResolved`/`staticPromiseResolveSettledExpr` +
  `unwrapPromiseTypeNode`; async-cps.ts re-exports), `asyncEngineWouldActivate`
  (async-activation.ts), select.ts (real `isAsyncIrReady`, async fall-through
  in `whyNotIrClaimable`, Promise<T> return unwrap, `isPhase1Expr` await arm,
  await-only consumption rule `expr-async-callee-not-awaited`), from-ast.ts
  (funcKind async, return unwrap, await lowering w/ settled substitution +
  passthrough), builder.ts (`valueType` accessor, `emitAwait`), lower.ts
  (await arm rewritten: host identity / native-carrier guarded unwrap
  mirroring `emitStandaloneAwaitUnwrap`; resolver
  `nativePromiseCarrierActive`), integration.ts (resolver binding), index.ts
  (`planIrOverlay` options + overrideMap async unwrap), create-context.ts
  (default ON, `JS2WASM_IR_ASYNC=0` rollback lever), tests extended in
  `tests/ir/issue-1373b.test.ts`.
- **Validation so far**: tsc clean (pre + post upstream-merge);
  tests/ir/issue-1373b.test.ts 26/26 (pre + post-merge); tests/ir +
  async-function/promise-chains equivalence batch → failure set IDENTICAL to
  a clean-base control worktree (7 pre-existing: 4× ir/passes end-to-end +
  3× ir/inline-small end-to-end LinkError __unbox_number — NOT this change;
  probe-verified plain fns byte-identical gate on/off). Empirical claim
  split (probe): `base` (statically-resolved await) → engine declines → IR
  claims; `twice` (`await base()` call operand) → HOST-DRIVE engine claims →
  IR declines. Merged upstream/main 852c40a9f cleanly.
- **Pending**: `pnpm run check:ir-fallbacks` (expect baseline unchanged —
  the gate script passes no engine binding, so asyncs stay bucketed),
  async engine blast radius (issue-1042*/2895*/2906* files) post-merge,
  PR, CI, self-merge.

## Joint architect spec (S53)

This issue is **Phase 2B** of the S53 async cluster. The joint spec at
`plan/issues/sprints/53/async-cluster-architect-spec.md` defines the shared
CPS module (`src/codegen/async-cps.ts`) that both this issue and #1042 must
consume — **do not duplicate the transform**. Phase 2B blocks on #1326c
Phase 1C-B (`emitStandalonePromiseThen`) AND on #1042 introducing
`async-cps.ts`. Read the joint spec before starting Phase C work.

## Background

#1373 Phase A (PR #328) shipped:
- New `IrFallbackReason: "async-function"` distinct from
  `"async-generator"`, `"non-export-modifier"`, `"deferred-feature"`.
- Selector buckets async functions / async methods correctly.
- New IR node types: `IrInstrAwait`, `IrInstrAsyncReturn`, `IrInstrAsyncThrow`
  (type-only — switch arms exist but lowering throws "not yet
  implemented").

Phase A is purely additive: async functions remain rejected (fall back
to legacy codegen). This issue tracks Phase C — the actual lowering
that flips the gate from deferred → claimed.

## Dependency

**BLOCKED on #1326c** (microtask queue + `Promise.then` standalone).
Phase C's CPS transform schedules continuations via
`__microtask_enqueue` and resolves chained promises via
`__promise_then`; both are still throwing stubs in
`src/codegen/async-scheduler.ts`. Until #1326c lands real bodies for
those helpers, Phase C cannot complete.

## Strategy (architect to re-spec after #1326c lands)

The original Phase 1 spec at `1326-async-microtask-queue-wasm-scheduler.md`
estimated Phase C at ~250 LoC. After Phase 1B implementation experience,
the closure-funcref interaction is harder than estimated — see
`1326c-microtask-queue-and-promise-then-standalone.md` "Constraint
discovered during 1B implementation" section.

### High-level transform

`async function f() { const x = await g(); return x + 1; }` becomes a
state machine:

- **State 0** (entry): call `g()`, register continuation as microtask.
  Return a pending `$Promise`.
- **State 1** (resume): receive resolved value; bind `x`; compute
  `x + 1`; settle the outer Promise (via `Promise_resolve`-equivalent
  in standalone mode).

The CPS transform splits the function at each `await` point. Each split
lifts the post-await tail into a synthetic continuation closure. The
continuation captures the outer's locals (whichever ones the tail
references).

### IR-level shape

After Phase C, an `await <expr>` node lowers to:

```
%promise = lowerExpression(<expr>)
%continuation = closure.new $continuation_N (captures...)
__microtask_then(%promise, %continuation)
return %outer_pending_promise
```

The `$continuation_N` lifted function takes the resolved value,
restores the captured state, and continues.

### Acceptance criteria

1. `async function f() { return await g(42); }` is IR-claimed and
   produces correct results.
2. `.then` chaining via `await` works — `async function () { return
   await g().then(x => x + 1); }` yields the chained value.
3. Rejection: `async function f() { throw new Error("x"); }` produces
   a rejected `$Promise`.
4. Existing legacy async equivalence tests (the ones that pass on
   today's main) all continue to pass with IR claim active.
5. WASI standalone mode: `async function main() { return await
   Promise.resolve(42); }` returns 42 after `__drain_microtasks()`.

## Files

- `src/ir/from-ast.ts` — emit `IrInstrAwait` / `IrInstrAsyncReturn` /
  `IrInstrAsyncThrow` from `ts.AwaitExpression` / async-function
  `return` / `throw` nodes.
- `src/ir/lower.ts` — replace the throwing stubs with the CPS transform
  emission (microtask queue calls + continuation-closure synthesis).
- `src/ir/select.ts` — flip the `"async-function"` bucket from
  deferred → claimed when a `supportsAsyncIr` flag is set (default
  off in #1373b's first slice; flipped to on once tests confirm
  parity).
- `src/ir/integration.ts` — thread the `supportsAsyncIr` flag from the
  codegen context.
- `tests/ir/issue-1373b.test.ts` — comprehensive test coverage.

## Risk and split

This is the hardest IR slice in flight. Recommend splitting further:

- **1373b-prep**: thread `supportsAsyncIr` flag, wire `from-ast.ts` to
  emit the new IR nodes. No lowering yet (still throws).
- **1373b-lower**: replace the throws with real CPS transform.
  Requires #1326c to be done.
- **1373b-claim**: flip the selector to actually claim async functions
  (default-on). Requires both above.

Each sub-slice is independently shippable.

## Notes for the next architect to read this

- The closure-funcref constraint identified in #1326c also applies
  here. The continuation closure must be call_ref-able from the
  microtask drain loop, which requires either uniform-arity
  `(externref) → externref` continuations (recommended) or per-site
  function-table dispatch (more complex).
- Async generators (`async function*`) are NOT in scope. They get the
  separate `"async-generator"` bucket and are tracked under the
  long-deferred `async-generator` category.
- `try/catch` inside async function bodies has additional CPS
  complexity (catch handlers are continuations). Consider splitting
  out as a separate sub-slice if it becomes the long pole.

---

## Refresh (arch1, 2026-06-16 — against upstream/main 319d43460): UNBLOCKED, line numbers re-anchored

**Dependency #1326c is DONE** (se1, completed 2026-06-16). The Phase 1C-B
substrate the S53 plan below blocks on is now live in
`src/codegen/async-scheduler.ts`:
- `emitStandalonePromiseThen` — **line 1132** (the gating helper; no longer a
  throwing stub).
- `emitStandalonePromiseResolve` (1089) / `emitStandalonePromiseReject` (1103).
- `__microtask_enqueue` registration (~326), `__drain_microtasks` (~341),
  `getOrRegisterPromiseType` (144).

So **Slice 2 and Slice 1b can begin now.** Slice 3 (gate flip) follows.

**Line-number corrections (the S53 plan below cites pre-drift values — use these):**

| S53 plan says | Current (319d43460) | Symbol |
|---|---|---|
| `select.ts:163` / `:190` / `:194` | `select.ts:190-200` | `isAsyncIrReady` (body is 6 lines; the `return false;` to flip in Slice 3 is **line 200**, after the `if (!options?.supportsAsyncIr) return false;` short-circuit at 191) |
| `lower.ts:1819` | `lower.ts:2107` | `case "async.return"` |
| (—) | `lower.ts:2125` | `case "async.throw"` |
| `lower.ts:1850` | `lower.ts:2143` | `case "await"` |
| `create-context.ts:130` | `create-context.ts:198` | `supportsAsyncIr: false` default |
| `types.ts:588` | `types.ts:1202` | `CodegenContext.supportsAsyncIr` |
| `integration.ts:582` | `integration.ts:577` | `readyForLower.some(... funcKind === "generator")` — the analogous async-state split hook goes adjacent to this generator check |
| `integration.ts:92` | `integration.ts:109` | `planIrCompilation(... { experimentalIR: true })` — add `supportsAsyncIr: ctx.supportsAsyncIr` here for Slice 3 |
| `integration.ts:178` | `compileIrPathFunctions` body (start `integration.ts:102`) | Phase-1 build loop where `splitAsyncIntoStates` is invoked |

Everything else in the S53 plan (the frame-struct strategy, uniform-arity
`(externref, externref) -> void` continuations, liveness sweep, per-state
emission, entry rewrite, slice sequencing) is **still correct** — re-read it as
written below; only the line anchors above have moved. The `select.ts`
`isAsyncIrReady` body currently has the Slice-2 TODO marker inline (lines
192-199) and still `return false`s — confirming Slice 1b/2/3 are all still open.

---

## Implementation Plan (S53 architect — joint spec for #1042 / #1373 / #1373b)

This plan covers the remaining slices (2, 1b, 3) on top of the Slice 1
scaffolding that landed in PR #441 (commit `3ea48c20c`). It is the
single source of truth for the async-model cluster — see #1042 and
#1373 for the upstream framing; this file is where devs read the IR
patterns and file:line targets. **NOTE: file:line targets below are
pre-drift — see the Refresh table above for current anchors.**

### Slice 1 recap (already on main as of `3ea48c20c`)

To avoid duplication, here is what is **already done** and MUST NOT be
rewritten:

- `CodegenContext.supportsAsyncIr: boolean` (default `false`) in
  `src/codegen/context/types.ts:588` + `src/codegen/context/create-context.ts:130`.
- `IrSelectionOptions.supportsAsyncIr` + `isAsyncIrReady(options, fn)`
  hardcoded `false` gate in `src/ir/select.ts:163` (TODO marker at
  line 194 for the Slice 2 body-shape check).
- `IrLowerResolver.resolvePromiseType?(): number` in `src/ir/lower.ts:303`
  bound to `getOrRegisterPromiseType(ctx)` from
  `src/codegen/async-scheduler.ts:84` via `makeResolver` in
  `src/ir/integration.ts:1009`.
- `lower.ts` `case "async.return"` / `case "async.throw"` (lines
  ~1819–1849): emit `i32.const FULFILLED|REJECTED` + value +
  `ref.null.extern` + `struct.new $Promise` + `extern.convert_any`.
  Result on stack: externref-wrapped Promise.
- `lower.ts` `case "await"` (lines ~1850–1934): casts operand to
  `(ref $Promise)`, tees into `awaitScratchPromiseIdx` local, branches
  on `$Promise.state`:
  - FULFILLED → `struct.get $value` (externref).
  - REJECTED → `struct.get $value` + `throw $exn`.
  - PENDING → `unreachable` (this slice fills it in).

### Strategy: state-machine via heap frame + uniform-arity continuations

WasmGC has neither stack switching nor coroutines, so the only viable
encoding for "suspend at await, resume on settle" is a **state machine
with a heap-allocated frame**. We deliberately reject the
trampoline-only approach (where every async fn returns a thunk JS
unwraps) because it requires a host loop and breaks WASI standalone
mode (#1042 acceptance criterion 5).

The transform mirrors TypeScript's own `--target es5` async lowering
but emits everything as wasm:

1. **Split** the async fn body at each `await` point into states
   `0..N`. State 0 is the entry; state `i` resumes after the `i`-th
   await. State `N` is the tail (no more awaits — settles the outer
   promise).
2. **Synthesise a frame struct** `$<fnName>__frame` carrying:
   - `state: i32` (next state index, for resume dispatch)
   - `outer: ref $Promise` (the Promise this async fn returned to its caller)
   - one field per source param (typed to the param's lowered IR type)
   - one field per local that crosses an await boundary (mutable;
     non-crossing locals stay as Wasm locals inside the state body)
3. **Synthesise N+1 continuation funcs** `$<fnName>__state_<i>` of
   **uniform signature** `(externref capsAsExtern, externref resolvedOrRejected) -> void`.
   Each func:
   - `any.convert_extern` + `ref.cast $<fnName>__frame` to recover the frame.
   - Reads frame fields into Wasm locals.
   - Runs the state-`i` body. On hitting the next await:
     - Lower the awaited expression (a Promise as externref).
     - Compute the next-state funcref via `ref.func $<fnName>__state_<i+1>`.
     - Call `emitStandalonePromiseThen(awaited, continuationClosure)` —
       where the "closure" is the frame itself, treated as the
       `caps: externref` arg. The drain loop will then call
       `$state_<i+1>(frameAsExtern, resolvedValue)`.
     - Write `state := i+1` into the frame, return.
   - On reaching the tail (no more awaits) → settle the outer promise
     by writing `state := FULFILLED`, `value := result` to
     `frame.outer`, fire any pending `.then` callbacks via
     `__promise_settle` (Phase 1C-B helper), and return.
4. **Entry function `f(p1, p2, ...)`** (the original async fn name —
   keeps the same Wasm funcIdx so callers stay valid):
   - `struct.new $<fnName>__frame` with `state := 0`, params copied
     in, locals zero-initialised, `outer := new pending $Promise`.
   - `ref.func $<fnName>__state_0` + `extern.convert_any frame` +
     `i32.const 0` (state-arg sentinel, ignored on initial entry) →
     pushed onto the microtask queue via `__microtask_enqueue` so the
     state-0 body runs in the next microtask tick (matches JS spec
     §27.7.5.1 step 4: AsyncFunctionStart creates a new execution
     context and resumes it). Then return `frame.outer` (externref).
   - The result is a fresh pending Promise the caller can `.then` or
     `await` exactly like a host-Promise.

### Why uniform `(externref, externref) -> void` continuation arity

The microtask queue (#1326c §1d) stores `(funcref, caps: externref,
arg: externref)` triples and drains via `call_ref` with no per-site
signature knowledge. Every continuation MUST therefore share one
typeIdx. We pick `(externref, externref) -> void`:
- `caps`: the frame (`extern.convert_any` lifted).
- `arg`: the resolved value (for FULFILLED) or rejection reason (for
  REJECTED). The continuation dispatches on the frame's `state` field,
  not on which signal it received — REJECTED routing is encoded by
  setting the frame to a designated "reject" state before enqueueing
  (see Slice 2.4 below).

### Frame as struct (not vec)

A per-fn struct is cheaper than a generic `externref` vec because:
- `struct.get` / `struct.set` are O(1) typed reads — no boxing of
  numeric locals back through `__box_number`.
- The verifier already accepts struct types up the WasmGC chain.
- Each frame is freed by the GC when no live continuation refs it.

The cost is N+1 synthesised funcs and one struct type per async fn.
Both are accepted in the existing IR pipeline (lifted closures go
through the same path — `result.lifted` in
`compileIrPathFunctions`).

---

### Slice 2 — PENDING-path CPS continuation synthesis

**Goal**: replace the `unreachable` PENDING branch in `lower.ts` with
real state-machine emission. Gate stays closed
(`isAsyncIrReady` still hardcoded `false`); Slice 2 is reachable only
via direct IR construction in tests.

**Blocked on**: #1326c Phase 1C-B (`emitStandalonePromiseThen` no
longer throws; microtask queue is drainable). Do NOT begin Slice 2
implementation until #1326c lands `__microtask_enqueue` +
`__drain_microtasks` + `emitStandalonePromiseThen` with non-throw
bodies. The selector gate prevents users from hitting the unfinished
path, but the dev's smoke tests rely on those helpers working.

#### 2.1 Frame-type registry

**File: `src/codegen/async-scheduler.ts`** (new helper near
`getOrRegisterPromiseType` at line ~84)

```ts
export interface AsyncFrameDescriptor {
  readonly frameTypeIdx: number;
  readonly stateFieldIdx: 0;      // always 0 by convention
  readonly outerFieldIdx: 1;      // ref $Promise
  /** Map from param/local name → field index (≥ 2) and ValType. */
  readonly slots: ReadonlyMap<string, { fieldIdx: number; type: ValType }>;
}

export function getOrRegisterAsyncFrameType(
  ctx: CodegenContext,
  fnName: string,
  slotSpec: ReadonlyArray<{ name: string; type: ValType }>,
): AsyncFrameDescriptor;
```

The slot spec is keyed by IR local name; lower.ts builds it from
`func.params` + the "live across await" subset of `func.locals`
(computed via a liveness sweep — see 2.2).

The promise field uses `ref $Promise` (typed, not externref) because
the frame is internal and the cast cost can be avoided. The `state`
field is `i32` matching the Slice 1 sentinel space, with two new
sentinels reserved:
```ts
export const ASYNC_STATE_REJECTING = 0x7FFF_FFFE;  // route to reject in next resume
export const ASYNC_STATE_DONE      = 0x7FFF_FFFF;  // outer promise settled — no more states
```

#### 2.2 Liveness sweep (which locals cross awaits?)

**File: `src/ir/lower.ts`** — new helper near `collectIrUses` at line
~1889.

```ts
function collectAsyncFrameSlots(func: IrFunction): {
  crossingValues: ReadonlySet<IrValueId>;
  awaitSites: ReadonlyArray<{ blockIdx: number; instrIdx: number; operand: IrValueId; result: IrValueId }>;
}
```

Algorithm: walk every block; for each `await`-kind instr, record the
site; for each value used in a block strictly later in CFG order than
its defining await, mark it as "live across await". Use the existing
`crossBlock` machinery from `lowerIrFunctionToWasm` as a starting
point — a value is await-crossing iff (a) defined before some await
and (b) used after that same await in the dominator order. A
conservative implementation that promotes every cross-block value to
the frame is OK for Slice 2 (extra frame fields, no correctness
issue). Pure intra-state values stay as Wasm locals.

#### 2.3 State splitter

**File: `src/ir/lower.ts`** — new top-level pass `splitAsyncIntoStates`
running BEFORE `lowerIrFunctionToWasm` (called from
`compileIrPathFunctions` in `src/ir/integration.ts:582` immediately
before the per-fn `lowerIrFunctionToWasm` call when
`func.funcKind === "async"`).

Output: an array of `IrFunction`s — one entry fn + N+1 state fns,
each a normal IrFunction (so they flow through the rest of the
lowering / hygiene / inline pipeline unchanged after split). State
fns have:
- `funcKind: "async-state"` (new variant added to `IrFunction.funcKind`
  in `src/ir/nodes.ts:1900`).
- Params: `[capsAsExtern: externref, resolvedOrRejected: externref]`.
- Result type: `[]` (void — they enqueue continuations or settle the
  outer promise; they never return a value to a wasm caller).
- A synthesised prologue that:
  1. `local.get $capsAsExtern; any.convert_extern; ref.cast $<fn>__frame; local.set $frame`.
  2. For each frame slot used in this state: `local.get $frame; struct.get $<fn>__frame.$slot; local.set $local_<n>`.

#### 2.4 Per-state body emission

For state `i` (where i < N):

```wasm
;; ... state i body (regular IR instrs translated as usual,
;;     with frame slot loads at top and stores before suspend) ...

;; AT THE AWAIT POINT:
;; 1. Evaluate awaited expr → externref Promise on stack.
emitValue(await.operand, out);

;; 2. Save locals that cross THIS await back into the frame.
for slot in liveAcrossThisAwait:
  out.push({ op: "local.get", index: frameLocalIdx });
  out.push({ op: "local.get", index: slot.localIdx });
  out.push({ op: "struct.set", typeIdx: frameTypeIdx, fieldIdx: slot.fieldIdx });

;; 3. Set state = i+1.
out.push({ op: "local.get", index: frameLocalIdx });
out.push({ op: "i32.const", value: i + 1 });
out.push({ op: "struct.set", typeIdx: frameTypeIdx, fieldIdx: 0 });

;; 4. Push the next-state funcref + frame-as-extern + call __promise_then
;;    which enqueues a microtask of (funcref, frameAsExtern, awaitedValue).
;;    awaitedValue is consumed by .then's internal subscribe path.
out.push({ op: "ref.func", funcIdx: state_i_plus_1_funcIdx });
out.push({ op: "local.get", index: frameLocalIdx });
out.push({ op: "extern.convert_any" });
;; Stack: [awaitedPromise, contFuncref, frameAsExtern]
emitStandalonePromiseThen(ctx, fctx, /* promise on stack */ [], /* fn on stack */ []);
;; emitStandalonePromiseThen consumes 3 values and pushes a NEW pending
;; promise representing the chained result. We DROP it — the caller of
;; this async fn already has the outer promise; the chained Promise
;; from .then is the chained-resolution machinery's internal book-
;; keeping that doesn't escape.
out.push({ op: "drop" });

;; 5. Return from the state func (void).
out.push({ op: "return" });
```

For the final state N (no more awaits — just a tail):

```wasm
;; ... tail computation, result on stack as externref ...

;; Settle the outer promise: state := FULFILLED, value := result.
out.push({ op: "local.get", index: frameLocalIdx });
out.push({ op: "struct.get", typeIdx: frameTypeIdx, fieldIdx: 1 }); ;; outer: ref $Promise
out.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
out.push({ op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 0 });
out.push({ op: "local.get", index: frameLocalIdx });
out.push({ op: "struct.get", typeIdx: frameTypeIdx, fieldIdx: 1 });
;; <result> already on stack — swap pattern not needed; result was
;; computed first. Reorder: stash result in a local before reading outer.
;;   (out: local.tee resultLocal; pop outer onto stack; local.get resultLocal)
out.push({ op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 1 });

;; Fire any pending callbacks attached to outer.callbacks (Phase 1C-B
;; helper `__promise_settle_callbacks` — see #1326c §1j).
out.push({ op: "local.get", index: frameLocalIdx });
out.push({ op: "struct.get", typeIdx: frameTypeIdx, fieldIdx: 1 });
out.push({ op: "call", funcIdx: settleCallbacksFuncIdx });

out.push({ op: "return" });
```

#### 2.5 Async-throw and rejection routing

When the body executes a synchronous `throw` (an `async.throw` IR
instr, or any IR instr that triggers `__exn`), the surrounding state
function catches via Wasm `try…catch_all` synthesised at the top of
each state body:

```wasm
(func $<fn>__state_i (param $caps externref) (param $value externref)
  (local $frame (ref $<fn>__frame))
  (local $result externref)
  ;; ... prologue: cast caps → $frame, hoist slots into locals ...
  (try
    (do
      ;; ... state body — may push to $result ...
      ;; (normal flow: continues to next state or settles outer)
    )
    (catch $__exn
      ;; Pop the exception payload (externref) — reject the outer Promise.
      local.get $frame
      struct.get $<fn>__frame $outer
      i32.const 2                      ;; REJECTED
      struct.set $Promise $state
      local.get $frame
      struct.get $<fn>__frame $outer
      ;; rotate exception payload above the outer ref, then struct.set $value
      ;; (use a scratch local — same pattern as Slice 1 awaitScratchPromise)
      struct.set $Promise $value
      ;; fire pending callbacks
      local.get $frame
      struct.get $<fn>__frame $outer
      call $__promise_settle_callbacks
    )
  )
)
```

This means every Slice 2 state function is wrapped in `try/catch_all`,
and an async function's "sync throw" semantics fall out for free:
`throw new Error("x")` inside the async body → caught by the state
function's catch_all → reject the outer Promise. No special handling
of `async.throw` IR instrs is needed beyond Slice 1's wrap (which is
still used in the *non-state-machine* case — synchronous-only async
fns with no awaits at all, where Slice 1's FULFILLED/REJECTED fast
paths emit directly).

Catch handlers that wrap an await (`try { await p } catch (e) { … }`)
are out of scope for Slice 2 — Slice 1b explicitly defers them via the
`whyNotIrClaimable` body-shape check below.

#### 2.6 Entry-function rewrite

The original `async function f(p1, p2)` keeps its Wasm funcIdx and
typeIdx (callers already emitted `call $f` with that signature). The
entry's body is replaced with:

```wasm
(func $f (param $p1 ...) (param $p2 ...) (result externref)
  (local $frame (ref $f__frame))
  ;; Allocate frame.
  struct.new $f__frame    ;; (state=0, outer=ref.null + initialised below, params, locals)
  local.set $frame

  ;; Init state = 0, outer = new pending $Promise.
  local.get $frame
  i32.const 0
  struct.set $f__frame $state

  local.get $frame
  i32.const 0                  ;; PENDING
  ref.null extern              ;; value
  ref.null extern              ;; callbacks
  struct.new $Promise
  struct.set $f__frame $outer

  ;; Copy params into frame.
  local.get $frame; local.get $p1; struct.set $f__frame $p1
  local.get $frame; local.get $p2; struct.set $f__frame $p2

  ;; Schedule state 0 to run in the next microtask.
  ;; Stack: [funcref, capsAsExtern, valueArg]
  ref.func $f__state_0
  local.get $frame; extern.convert_any
  ref.null extern              ;; no resolved value yet — state 0 ignores it
  call $__microtask_enqueue

  ;; Return the outer promise as externref.
  local.get $frame
  struct.get $f__frame $outer
  extern.convert_any
)
```

This is the **only** Wasm body that survives at `$f`'s funcIdx; the
state functions are appended after `$f` in `ctx.mod.functions` and
have synthesised names `$f__state_0`, `$f__state_1`, …

#### 2.7 Liveness across awaits — implementation budget

A complete liveness analysis is ~150 LoC and uses standard SSA
dominator-tree machinery. For Slice 2 v1 a **conservative**
approximation is sufficient: any IR local that's read in any block
strictly later than its defining block AND that block contains an
`await` between def and use → promote to frame. Use
`crossBlock: Set<IrValueId>` already computed by `lowerIrFunctionToWasm`
as the starting set, then walk the CFG to filter.

Conservative wins extra frame fields (a few words per async fn) at
zero correctness cost.

#### 2.8 Slice 2 file:line targets

| File | Function | Line | Change |
|------|----------|------|--------|
| `src/codegen/async-scheduler.ts` | (new) `getOrRegisterAsyncFrameType` | end of file | +60 LoC — frame struct registry. Mirror `getOrRegisterPromiseType` pattern. |
| `src/codegen/async-scheduler.ts` | (new) `__promise_settle_callbacks` | end of file | +40 LoC — drain a Promise's pending `.then` callbacks. Calls `__microtask_enqueue` per entry. (May already exist as part of #1326c §1j.) |
| `src/ir/nodes.ts` | `IrFunction.funcKind` | line 1900 | Add `"async-state"` variant. |
| `src/ir/select.ts` | `isAsyncIrReady` | line 190 | Slice 2 keeps gate closed. Slice 3 flips. |
| `src/ir/lower.ts` | `lowerIrFunctionToWasm` `case "await"` | line ~1850 | Detect when `funcKind === "async-state"` — emit the state-emission pattern above. The non-state-machine `funcKind === "async"` path keeps Slice 1's FULFILLED/REJECTED inline branches as the fast path for await-on-already-settled promises; the new PENDING branch now calls `emitStandalonePromiseThen` + returns. |
| `src/ir/lower.ts` | (new) `splitAsyncIntoStates` | new section | +200 LoC — pre-lowering pass producing N+1 IrFunctions. Runs only when `func.funcKind === "async"`. |
| `src/ir/lower.ts` | (new) `collectAsyncFrameSlots` | new section | +80 LoC — liveness sweep. |
| `src/ir/integration.ts` | `compileIrPathFunctions` Phase 1 build | line ~178 | When the built IrFunction has `funcKind === "async"`, call `splitAsyncIntoStates(fn)` and push every output IrFunction to `built` (entry as the original, state fns as `synthesized: true`). |
| `tests/ir/issue-1373b.test.ts` | Slice 2 cases | append | Add direct-IR tests: (a) `async function f() { return await Promise.resolve(42); }` produces 42 after drain; (b) `async function f() { return await p1; await p2; return 1; }` chains correctly; (c) `async function f() { throw new Error("x"); }` rejects (already covered by Slice 1 — keep). |

Estimate: **~600 LoC** in `src/ir/lower.ts` + helpers, ~200 LoC tests.

#### 2.9 Regression gate (test262 dirs to check)

Slice 2 keeps the gate closed, so test262 regression risk is **zero**.
Smoke validation via `tests/ir/issue-1373b.test.ts` only.

When Slice 3 flips the gate, watch these directories:
- `test/language/expressions/await/`
- `test/language/statements/async-function/`
- `test/built-ins/Promise/resolve/`
- `test/built-ins/Promise/then/`
- `test/built-ins/Promise/reject/`
- `test/language/expressions/async-arrow-function/`

CI bucket-by-path analysis will surface any cluster ≥5 — escalate
those before Slice 3 self-merges.

---

### Slice 1b — from-ast wiring (no gate flip)

**Goal**: make the IR builder actually emit `IrInstrAwait` /
`IrInstrAsyncReturn` / `IrInstrAsyncThrow` from AST nodes, so the
Slice 2 lowering is reachable end-to-end through compile (not just
synthesised in tests). Gate STILL hardcoded `false`, so this is dead
code at runtime — but it eliminates the integration risk for Slice 3.

**Why this is a separate slice**: it touches a different file
(`src/ir/from-ast.ts`) and a different reviewer mental-model (AST
shape recognition vs Wasm IR emission). Easier to review separately.

#### 1b.1 from-ast emission

**File: `src/ir/from-ast.ts`**

- `lowerFunctionAstToIr` (line ~366): when the decl has the
  `AsyncKeyword` modifier, set `funcKind: "async"` (currently always
  `"regular"` or `"generator"`).
- `lowerExpression` for `ts.AwaitExpression`: emit `IrInstrAwait`
  carrying the lowered operand IrValueId. Result IrType = the operand
  type unwrapped from `Promise<T>` (use TS checker's
  `getAwaitedType` — same as legacy `unwrapPromiseType` at
  `function-body.ts:569`).
- `lowerTail` for `ts.ReturnStatement` inside an async fn: emit
  `IrInstrAsyncReturn` (NOT the regular `IrTerminatorReturn`).
- `lowerStatement` for `ts.ThrowStatement` inside an async fn: emit
  `IrInstrAsyncThrow` (NOT `IrInstrThrow`).

#### 1b.2 selector body-shape check

**File: `src/ir/select.ts`**

- `isAsyncIrReady` (line 190): replace the inline `return false;` with
  a real body-shape check. Reject when:
  - The body contains a `try` statement that wraps an `await` in its
    `tryBlock`. (Catch-on-await is Slice 4 — out of scope.)
  - The body contains a `for await` loop. (Async iteration is also out
    of scope; routes to `async-generator` bucket.)
- Once the check passes, still return `false` (gate flip is Slice 3).
- Keep the `if (!options?.supportsAsyncIr) return false;` short-circuit
  at the top — every gate decision flows through one switch.

#### 1b.3 file:line targets

| File | Function | Line | Change |
|------|----------|------|--------|
| `src/ir/from-ast.ts` | `lowerFunctionAstToIr` | 366 | Set `funcKind: "async"` when the decl has `AsyncKeyword`. |
| `src/ir/from-ast.ts` | `lowerExpression` | new arm | Recognise `ts.AwaitExpression` → `IrInstrAwait`. |
| `src/ir/from-ast.ts` | `lowerTail` | existing return arm | Branch on `cx.funcKind === "async"` → emit `IrInstrAsyncReturn`. |
| `src/ir/from-ast.ts` | `lowerStatement` | existing throw arm | Branch on `cx.funcKind === "async"` → emit `IrInstrAsyncThrow`. |
| `src/ir/select.ts` | `isAsyncIrReady` | 190 | Real body-shape gate (still returns `false` at the end). |
| `tests/ir/issue-1373b.test.ts` | append | append | Test that the selector still rejects (`supportsAsyncIr: false`), and that with `supportsAsyncIr: true` an `async function f() { return await p; }` produces an IR with `kind: "await"` + `kind: "async.return"` instrs visible via the verifier. |

Estimate: **~150 LoC** + ~80 LoC tests.

#### 1b.4 Regression gate

Gate still closed → zero test262 risk. Verify the IR fallback budget
in `scripts/ir-fallback-baseline.json` (#1376) stays unchanged: the
`async-function` bucket count must not move, since the selector still
rejects every async fn.

---

### Slice 3 — Gate flip

**Goal**: flip `isAsyncIrReady`'s final return from `false` to `true`.
Async functions whose body shape is accepted now flow through the IR's
CPS lowering.

**Pre-conditions**:
- Slice 1, 1b, 2 all on main.
- #1326c Phase 1C-B / 1D fully landed (microtask drain works in WASI
  smoke test).
- Local smoke test passes: `async function main() { return await Promise.resolve(42); }`
  returns 42 in standalone mode after `__drain_microtasks()`.

**Change**: one line in `src/ir/select.ts:194`:

```diff
-  return false;
+  return true;
```

Plus: thread `supportsAsyncIr: ctx.supportsAsyncIr` through
`compileIrPathFunctions`'s `planIrCompilation` call in
`src/ir/integration.ts:92` (currently `{ experimentalIR: true }` — add
`supportsAsyncIr: ctx.supportsAsyncIr`).

Plus: flip the context default in
`src/codegen/context/create-context.ts:130` from `false` to `true`
**after** local smoke tests pass — this is the actual "ship it" line.

#### 3.1 Regression gate

This is the slice that exposes the IR async path to test262. Watch
the dirs listed in §2.9. Expectation:
- `await/`: ~50–100 tests flip pass→pass (no change — these test
  semantic surface that doesn't depend on the lowering strategy).
- `async-function/`: a few may flip pass→fail if liveness sweep
  misses a corner case. The CI bucket cap (50/bucket) catches this
  cleanly; revert by setting the gate back to `false` in select.ts —
  no other code paths change, so the revert is one-line.
- Net regressions must be ≤ +10 for self-merge per the standing PR
  protocol. Otherwise escalate to tech lead.

Estimate: **~10 LoC** code, **~40 LoC** tests (covering the gate-on
path end-to-end).

---

### Cross-slice sequencing

```
                  #1326c Phase 1C-B    (microtask + Promise.then real bodies)
                          │
                          ▼
   ┌──────────────────────┴──────────────────────┐
   │                                             │
Slice 2 (PENDING-path CPS)              Slice 1b (from-ast wiring)
   │                                             │
   └──────────────────────┬──────────────────────┘
                          ▼
                  Slice 3 (gate flip)
                          │
                          ▼
                #1042 acceptance criteria
```

Slice 1b and Slice 2 are mutually independent and can ship in either
order or in parallel. Slice 3 requires both. Doing Slice 1b first
gives a fully wired but dormant path, which is the safer review
posture; doing Slice 2 first lets devs write direct-IR unit tests
without touching `from-ast.ts`. The dispatcher can take either path.

### Acceptance criteria (joint with #1042 and #1373)

After Slice 3 lands and the gate is flipped:

1. **#1042 AC #2**: `async function f() { return await Promise.resolve(42); }`
   returns 42 after a real microtask yield. Verified via WASI smoke
   test invoking `__drain_microtasks()` between fn-call and result
   inspection.
2. **#1042 AC #3**: try/catch around await propagates host rejections
   correctly. Verified by Slice 4 (separate issue — file as #1373c
   when Slice 3 lands).
3. **#1042 AC #4**: `Promise.all([p1, p2])` serializes through two
   real microtask boundaries. Verified by counting `__drain_microtasks`
   iterations needed.
4. **#1042 AC #5**: axios Tier 4 smoke test passes (real GET from
   httpbin.org). This requires JS host mode (microtask queue is empty
   between host I/O ticks); validated by the existing #1032 fixture.
5. **#1373b AC #1–5**: all 5 acceptance criteria above pass.
6. **#1373** is already done — Slice 3 is the final piece that retires
   the `async-function` fallback bucket from `ir-fallback-baseline.json`.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Liveness sweep miscompiles a value that crosses an await | Conservative over-promotion to frame fields. Cost: extra struct slots. Correctness: guaranteed. |
| `try/catch_all` wrapper around every state body adds overhead even for fns that never throw | Acceptable — Wasm engines fast-path the no-exception path. Optional Slice 5: skip the wrapper when liveness proves the body can't throw (e.g. only awaits + arithmetic). |
| Funcref typeIdx mismatch between continuation and microtask queue | All continuations share one signature `(externref, externref) -> void` — drained via single typeIdx. Verified at IR build by the existing IR verifier (`verify.ts`). |
| `addFuncType` interning shifts funcIdx mid-emission | All state fns added in Phase 1 of `compileIrPathFunctions` before Phase 3 lowering — same pattern as monomorphize clones (line 434–452). |
| Async fn called from a non-IR (legacy) caller has signature mismatch | The entry fn's signature is unchanged: `(params...) -> externref` (the Promise). Callers' `call $f` ops keep working. |
| Slice 2 breaks `tests/ir/issue-1373b.test.ts` Slice 1 tests | Slice 2 must NOT modify Slice 1's FULFILLED/REJECTED inline branches — those remain the fast path for `await` on an already-settled Promise. The new PENDING branch is additive. |

---

## RE-MEASUREMENT + VERDICT (arch, 2026-06-22 — ASYNC lane, sprint 65)

Re-measured the async test262 gap against the current baseline JSONL
(`.test262-cache/test262-current.jsonl`, promoted off main 2026-06-20).
**Following the sprint-65 pattern where every umbrella re-grounded far
smaller, the CPS epic's actual addressable residual is tiny.**

### Re-measured async cluster (host gc mode, current main)

| Directory | total | pass | pass% |
|---|---|---|---|
| `language/expressions/await` | 22 | 10 | 45% |
| `language/expressions/async-function` | 93 | 68 | 73% |
| `language/statements/async-function` | 74 | 68 | 92% |
| `language/expressions/async-arrow-function` | 60 | 45 | 75% |
| `language/expressions/async-generator` | 623 | 507 | 81% |
| `language/statements/async-generator` | 301 | 253 | 84% |
| `language/statements/for-await-of` | 1234 | 921 | 75% |
| `built-ins/AsyncFunction` | 18 | 9 | 50% |
| `built-ins/AsyncGeneratorFunction` | 23 | 6 | 26% |
| `built-ins/AsyncGeneratorPrototype` | 48 | 46 | 96% |
| `built-ins/Promise` | 652 | 487 | 75% |
| **async cluster TOTAL** | **3199** | **2449** | **76.6%** |

### Verdict: do NOT prioritise the CPS epic this sprint. Slice the bounded bugs.

The async cluster is **already 76.6% passing via the legacy
synchronous-async path** (the no-op `await` + call-site `wrapAsyncReturn`).
The CPS state machine in `async-cps.ts` is **fully implemented and verified
correct when run** (senior-dev, 2026-06-03 — see #1042) but ships **gated OFF**
because flipping `ASYNC_CPS_ENABLED` globally hits a confirmed **design wall**:
the synchronous-consumption contract. A `def` is per-definition but
consumption is per-call-site — the same async fn is consumed both as a raw
value (`asyncFn() as any as number`, pervasive in test262 and the equivalence
suite) and as a Promise (`asyncFn().then(...)`). A global return-type flip to
`externref`-Promise satisfies the second and **breaks the first** (`Promise as
any as number` → NaN). Turning CPS on for real needs either (a) whole-program
consumption analysis to only rewrite fns consumed exclusively as Promises, or
(b) teaching the value-consumption call sites to synchronously drive the
returned Promise to its settled value. **Both are architect-level and neither
is a sprint-65-sized win.** The epic remains correct and staged (Slices 1/1b/2
landed inert; Slice 3 is the gate flip behind the consumption-contract work) —
but it is the **wrong lever for this sprint's conformance budget**.

### What the residual actually is (and where it's owned)

The ~750 async-cluster failures decompose into buckets that are **mostly
NOT CPS-shaped** and mostly belong to other lanes:

- **for-await-of: 313 fails → 311 are `dstr-*` destructuring-pattern tests.**
  Shared root cause with the destructuring lane (#2400/#2503/#2545/#2001/
  #2169/#2602 — #2602 *for-await rest element* just landed). Only **2**
  non-dstr for-await failures exist. The async-iteration mechanism itself
  works. **Not this lane — destructuring lane.**
- **Promise combinators: 125 fails** (all/allSettled/any/race). Split:
  `resolve/reject not callable` (45) → **#2614** (new, this lane);
  `[object Object] is not a constructor` (~8) → **#1528** (already ready,
  sprint 65); `illegal_cast Constructor()` subclass-capability (~19) → #2614
  secondary / follow-up.
- **async-function expr `.then` on a var-bound async fn: ~18 fails** →
  **#2612** (new, this lane) — a bounded `isAsyncCallExpression` detection
  gap, not CPS.
- **`await <thenable>`/`<non-Promise>` assimilation: ~15 fails** → **#2613**
  (new, this lane) — the ONLY genuinely-suspension-shaped bucket, and it is
  fixable in **JS-host mode via host `PromiseResolve` assimilation WITHOUT the
  CPS gate**. Standalone thenable-await is the only piece that truly needs the
  CPS epic, and it is a handful of tests.
- **async-generator / AsyncGeneratorFunction residual** (~125 + 17) →
  async-generator bucket (long-deferred, `async-generator` category — out of
  this lane's scope, see #1344 for the receiver-check slice).

### This lane's sliced output (sprint 65, ready)

| id | title | est pass | role |
|---|---|---|---|
| **#2612** | async fn via var/expr binding consumed as thenable not wrapped | ~18 | dev |
| **#2613** | `await` thenable/non-Promise assimilation (JS-host, no gate flip) | ~15 | dev |
| **#2614** | Promise combinators read constructor `resolve` + callable element fns | ~45 | senior-dev |

**~78 test262 pass from 3 bounded slices, zero dependence on the CPS gate.**

### #1373b status after this re-measurement

**Stays `ready` but DE-PRIORITISED from `priority: top` for sprint 65** — it is
not a conformance win this sprint; its addressable residual (standalone
thenable-await + the IR-fallback-budget `async-function` bucket retirement) is
gated behind the consumption-contract architecture decision, which is itself a
larger separate effort than a single sprint slice. When the team chooses to
take the consumption contract on, the staged plan above (Slices 1b/2/3) is
correct and ready — re-read the S53 joint spec as written. Until then, the
bounded slices (#2612/#2613/#2614) harvest the async conformance that does
**not** require flipping the model.

## Async-failure bucket scope (2026-06-22, sd-1838) — settlement-timing hypothesis tested

Per lead directive: bucketed the failing async rows on current main and tested
whether the "synchronous-settlement / microtask-drain" gap is a BOUNDED arm.

**Bucket counts** (language/{expressions,statements}/{await,async-function,
async-arrow-function}, 210 pass / 39 fail / 249):
| n  | bucket | note |
|----|--------|------|
| 21 | assertion/return | DOMINANT — headed by `await <custom-thenable>` (`await-awaits-thenables*.js`) |
| 6  | `with`-statement #1387 | unrelated (with-stmt closed-shape gate), not async |
| 4  | null-deref in trigger/pushAwait/countdown | monkey-patched-promise / interleaved-await |
| 2  | illegal_cast | await-in-nested-function/generator |
| ~6 | parse/ident/misc | `await` as identifier, async-arrow name parse, etc. |

**Settlement-timing hypothesis: NOT the mechanism, and NOT independently bounded.**
- `await Promise.resolve(42)` PASSES; `await <custom thenable {then(res){res(42)}}>`
  FAILS with `dereferencing a null pointer in __closure_N`. So it is NOT a
  microtask-drain/ordering issue (the harness uses `asyncTest`/`asyncHelpers.js`
  and real-Promise await settles correctly).
- Root cause: `await V` lowers (async-cps.ts ~L421-433) to `Promise_resolve(V)` +
  `Promise_then2(p, __make_callback(continuation))`. For a CUSTOM thenable, V8's
  `p.then(resolve, reject)` calls the wasm continuation BACK as a host→wasm
  callback, and that inbound callback null-derefs — the SAME multi-hop
  host→wasm-callback substrate as #2614/#86's residual (a wasm closure handed to
  host code and invoked back). The await resolve-continuation is the inbound
  callback that fails.

**Verdict: the dominant async-fail bucket (await-thenable, ~21 rows) is COUPLED
to the multi-hop host→wasm callback cast/null-deref**, not a standalone
settlement-timing fix. It should be folded into the same substrate slice that
#2614's headline cluster needs (capturing inner closure passed to host executor,
called back). Both are "a wasm continuation/closure invoked by host code"; fixing
one likely fixes both. NOT a separate bounded arm — recommend a single
multi-hop-callback substrate slice covering await-thenable + #2614 combinator
residual. (The full IR Phase C #1373b epic verdict above is unchanged.)
## Re-ground verdict (2026-06-22, sd-1838) — genuine EPIC, deferral is correct

Re-grounded against current main (the task subject's "ASYNC_CPS already enabled
on main; residual may be a narrow settlement-timing gap" is INACCURATE):

- `CodegenContext.supportsAsyncIr` is `false` by default (`create-context.ts:232`)
  and nothing flips it true — the IR async CPS path is OFF on main.
- `isAsyncIrReady` (`src/ir/select.ts:190`) is HARDCODED `return false` with
  `TODO(#1373b Slice 2): body-shape check … For now the gate is closed
  regardless of body shape.` The gate has never been opened.
- The `src/codegen/async-cps.ts` substrate now EXISTS (36KB, landed via #1042),
  so the lowering module is present — but #1042 (async state-machine) is still
  `in-progress`, and the IR-path Phase C wiring (Slice 2: CPS continuation
  synthesis + body-shape acceptance + parity test vs the legacy direct-codegen
  async path) is NOT implemented.

**Verdict: this is the full Phase C feature (feasibility:hard, reasoning_effort:max),
NOT a collapsed narrow fix.** It needs an architect spec first (the
`async-cluster-architect-spec.md` exists but predates the landed async-cps.ts —
re-spec the Slice 2 gate-open + parity plan against the current substrate), then
senior-dev implementation, coordinated with #1042's in-progress state-machine,
validated via merge_group. Correctly tagged `[DEFERRED EPIC — next-sprint]`.
Recommend: route through /architect-spec, keep #55 `ready`/deferred, do NOT sink
sprint-65 forcing it. The async row payoff this sprint already came via
#2612/#2613 (landed) and the #2614 combinator cluster (gated behind #86, now
landed — re-measure #2614 next).
