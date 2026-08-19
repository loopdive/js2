---
id: 4124
title: "IR final async terminal migration: sequential loop and main"
status: done
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: critical
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, runtime, codegen
language_feature: async, for-loop, multi-await
goal: ir-full-coverage
sprint: 78
parent: 3527
depends_on: [4110]
horizon: m
lane: ir-retirement-r7
related: [1042, 1373b, 2710, 2766, 2867, 2906, 2918, 3518, 3587, 3741, 4106, 4109, 4113]
files:
  - src/ir/nodes.ts
  - src/ir/builder.ts
  - src/ir/effects.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/ir/string-runtime.ts
  - src/ir/string-support.ts
  - src/ir/async-runtime-providers.ts
  - src/ir/async-plan.ts
  - src/ir/async-from-ast.ts
  - src/ir/async-prepare.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/async-ir-planning.ts
  - src/codegen/ir-async-frame.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/string-ops.ts
  - src/ir/integration.ts
  - scripts/check-ir-only.ts
  - scripts/check-ir-fallbacks.ts
  - scripts/ir-fallback-baseline.json
  - scripts/ir-only-baseline.json
  - plan/log/ir-optimization-retirement-ledger.md
  - tests/ir/issue-1373b-async-plan.test.ts
  - tests/issue-3520-fallback-gate-identity.test.ts
  - tests/issue-2710-late-bind.test.ts
  - tests/issue-4124-ir-final-async.test.ts
  - plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
  - plan/issues/4124-ir-final-async-terminal-migration.md
---
# #4124 — IR final async terminal migration: sequential loop and main

## Problem

After #4110, 35 of 37 reachable production functions emit through IR. The
only typed terminal blockers are the exact playground `fetchAllSequential`
and exported async `main` owners.

`fetchAllSequential` awaits inside a counted loop and carries a vector,
numeric accumulator, and integer counter through suspension:

```ts
let total = 0;
for (let i = 0; i < ids.length; i++) {
  total = total + (await fetchUser(ids[i]));
}
return total;
```

`main` has two real suspensions. It carries `ids` and the first timestamp
through the first await, then carries `ids` and the second timestamp through
the second await while preserving logging and timing order.

The current direct execution is not a semantic oracle: the unchanged fixture
currently logs `sequential sum = NaN` and fulfills `Promise<void>` with
`null`. The IR replacement must implement the source semantics instead:
sequential and parallel sums are `150`, and `await main()` produces
`undefined`. Optimization parity preserves useful representation and call
shape, not these two direct-path defects.

The canonical async plan already represents branches, suspension, and typed
spills, but it has no target-neutral relation for committing updated
loop-carried values on an edge. Its current producer and frame consumer also
accept only one suspension. Keeping either owner direct would preserve a
backend-specific AST path for semantics already representable by the shared
state-machine contract.

## Combined scope

This is one production PR and the only active overlapping async migration PR
after #4110 lands. It migrates both remaining terminal owners, banks their
measured fallback and legacy-body reductions, and adds an async-family
IR-only shadow gate. It does not split the two owners into stacked production
PRs.

The branch may be prepared locally from the immutable #4110 head, but no
production PR is published until #4110 is verified on `main` and this branch
is rebased onto that exact landed result.

## `fetchAllSequential` state graph

Admit only the exact checker- and IR-certified counted-loop shape and produce
five target-neutral states:

1. Initialize `total: f64` and `i: i32`.
2. Test `i < ids.length`; branch to the await state or exit state.
3. Read the proven in-bounds `ids[i]`, call the prepared `fetchUser`, and
   suspend.
4. Add the delivered `f64` to `total`, increment `i`, commit both updated
   spills, and jump to the test state.
5. Resolve the outer Promise with `total`.

The suspension live set is exactly `ids`, `total`, and `i`. The immutable
`ids` parameter may reuse its physical frame field. `total` and `i` remain
typed frame fields and may not be widened to a dynamic carrier.

## Async `main` state graph

Admit only the exact checker- and IR-certified exported playground body and
produce three target-neutral suspension states:

1. Emit the initial log, construct the numeric `ids` vector, snapshot `t0`,
   call prepared `fetchAllSequential(ids)`, and suspend. The live set is
   `ids` and `t0`.
2. Bind `seq: f64`, snapshot `t1`, emit the sequential result/timing log,
   snapshot `t2`, call prepared `fetchAllParallel(ids)`, and suspend. The live
   set is exactly `t2`; `ids` is consumed by the call before suspension.
3. Bind `par: f64`, snapshot `t3`, emit the parallel result/timing log and
   final `done` log, then resolve the canonical `Promise<void>`.

No timestamp or numeric result may be boxed merely to survive suspension.
The union frame layout is exactly `ids: vec<f64>`, `t0: f64`, and `t2: f64`;
state 1 restores `{ids, t0}` and state 2 restores `{t2}`. Observable log,
timer, call, fulfillment, and settlement order must match the direct path.
`seq` and `par` are resume-edge `f64` values; `t1` and `t3` are state-local.
Main needs no loop-style spill updates beyond the initial definitions.

## Plan-contract extension

- Add an explicit spill-update relation to the canonical async state or edge
  contract. Each update identifies a declared spill and the ordinary IR value
  committed before the successor transition.
- Verify exact spill ownership, unique targets, type equality, value
  dominance, and liveness. An unknown, duplicate, stale, or type-mismatched
  update fails preparation.
- Include update values in dependency and allocation-provenance verification.
- Include updates in canonical serialization and hashing. Plan-verifier
  negatives cover unknown, duplicate, stale, undeclared, type-mismatched, and
  non-dominating update sources plus missing predecessor updates.
- Generalize preparation and the frame adapter from the two-state/no-spill
  slice to the exact five-state counted loop and three-state two-await graph.
- Widen prepared callable allocation and preparation for the exact
  `Promise<void>` owner: semantic ABI `canonicalPromiseAbi(null)`, ordinary IR
  result list `[]`, and frozen Wasm callable ABI `[] -> [externref]`.
- Have the prepared frame adapter commit updates to typed locals before a
  `goto`, conditional branch, or suspension. Backend lowering consumes only
  the verified plan and may not rediscover loop or logging syntax from
  TypeScript nodes.
- Reuse the existing async frame engine, runtime manifest, canonical Promise
  ABIs, symbolic callees, vector layouts, Date/console/string intents, and host
  adapters. Do not introduce a heap cell, per-iteration object, second CPS
  engine, or separate scheduler.
- Add a target-neutral zero-argument clock-snapshot operation/runtime intent
  for the four checker-certified ambient `Date.now()` calls. Backend lowering
  selects `env::__date_now`, WASI clock lowering, or a future linear provider;
  AST-to-IR may not embed the host import name as a source-specific escape.
- Preserve the direct backend's batched five-part logging concatenations with
  a target-neutral n-ary string-concat operation or equivalent IR-owned pass.
  Host/WasmGC lowering emits one `__concat_5` call per five-part expression;
  other backends choose their own representation without changing semantics.
- Run async fixed-point ownership through
  `delay -> fetchUser -> {fetchAllSequential, fetchAllParallel} -> main`.
  Main is claimable only after both callee Promise ABIs and prepared components
  freeze. Missing, unresolved, or cyclic dependencies demote before claim.
- Seal main's callable, three state helpers, both callee callables, async host
  adapters, vector layout, clock provider, string/concat providers,
  number-to-string provider, and console provider as one dependency-complete
  component.

## Semantic and optimization parity

### Sequential owner

- Execution is strictly sequential: iteration `n + 1` cannot start before
  iteration `n` fulfills.
- A rejection bypasses the update state, rejects the outer Promise exactly
  once, and starts no later iteration.
- Empty input resolves to numeric zero without calling `fetchUser`.
- Preserve the numeric-vector carrier and existing proven unchecked indexed
  read; add no redundant bounds branch.
- Preserve `i` as native `i32` across suspension and the back-edge, and
  `total` as native `f64`.
- Use native `i32` compare/increment in the IR state graph; do not preserve the
  direct path's redundant counter/length conversion to `f64`.
- Add no dynamic carrier, ref cell, per-iteration boxing, counter conversion,
  or numeric box/unbox pair around `fetchUser` fulfillment.
- The host callback necessarily delivers `externref`: require exactly one
  externref-to-`f64` conversion at each fulfillment boundary and exactly one
  final `f64`-to-externref conversion when settling the outer Promise. There
  is no intermediate `f64`-to-externref-to-`f64` round trip in the loop.

### Main owner

- Preserve exactly one numeric-vector allocation and reuse its typed carrier
  across both awaits.
- Preserve native numeric timestamp/result locals and direct numeric
  subtraction/string conversion paths; do not route them through generic
  dynamic arithmetic.
- Preserve exactly four clock snapshots and exactly two batched five-part
  string concatenations. Four binary concatenations per log are a performance
  regression and do not satisfy parity merely because the resulting text is
  equal.
- Preserve one `f64` `array.new_fixed` vector, four specialized
  `number_toString` calls, four `console_log_string` calls, and stable named
  callee targets. These measured direct-WAT counts are explicit parity locks,
  not implementation suggestions.
- Preserve direct symbolic calls to both prepared async callees and stable
  Program ABI targets after late imports.
- Convert each of the two host-delivered numeric fulfillments to `f64` exactly
  once at its resume boundary; timestamps and resumed results stay native
  thereafter.
- Preserve the original log sequence and the canonical always-async
  `Promise<void>` settlement ABI.
- Correct the existing direct-path results: the sequential timing log contains
  sum `150`, not `NaN`, and final `Promise<void>` fulfillment is `undefined`,
  not `null`.
- Settle `Promise<void>` through the typed undefined/void settlement path; do
  not synthesize a numeric, null, or dynamic result value in the plan.
- A rejection from the sequential call skips the parallel call and every later
  timing/final log; a rejection from the parallel call skips its timing and
  final log. Each path settles the outer Promise exactly once.

### Retirement evidence

- Extend evidence on `IR-OPT-NUMERIC-PROMISE-CARRIER-ROUNDTRIP`,
  `IR-OPT-PROVEN-VECTOR-BOUNDS`, and `IR-OPT-FIXED-VECTOR-LITERAL`. Do not mark
  the generic mutable-numeric-loop coercion row complete from this exact typed
  loop.
- Add `IR-OPT-TYPED-ASYNC-FRAME-SPILLS`, owned by `IrAsyncSpill` verification
  and the prepared frame adapter, with exact frame/live-set output evidence.
- Add explicit rows for concat-chain fusion, ambient direct clock snapshots,
  specialized numeric-to-string calls, and typed string logging unless an
  existing row demonstrably owns the same decision. Each row records its
  direct owner, IR owner, runtime evidence, output-shape evidence, and any
  still-pending performance attribution.
- Delete an async direct implementation in this PR only if reachability and
  tests prove it has no remaining consumer. Retained frame-core, scheduler,
  Promise, Date, console, string, and vector substrate stays behind semantic
  IR intents.
- If the generalized plan consumer fully subsumes the current exact-two-state
  `ExactSingleAwaitCalls`/`exactSingleAwaitCalls`/`preparedCfg` scaffolding,
  delete that obsolete adapter code in this PR and keep #4106/#4110 green.
  Generic AST async planning remains until its broader consumers migrate.

## Fail-closed boundary

- A changed loop initializer, condition, increment, body ordering, extra
  capture, nested executable, handler crossing an await, nullable/non-numeric
  vector, generic owner, or non-prepared callee remains typed Unsupported.
- A changed `main` await count/order, logging/timestamp structure, callee,
  capture set, return type, or host-free target remains Unsupported until a
  general plan proves it.
- Shadowed/aliased/optional/spread/type-argument forms of `Date.now`, either
  prepared callee, or console logging remain Unsupported. The clock operation
  is effectful and must never be constant-folded or classified as pure math.
- Host-free, WASI, and linear targets retain their established route until
  their prepared-program consumers exist.
- Unresolved or cyclic async dependencies are demoted as a whole component
  before ownership.
- Any verifier, dependency, Program ABI, frame-layout, or lowering failure
  after the owner is sealed is terminal and cannot retry the direct body.

## Acceptance criteria

- Both unchanged owners have `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and non-empty prepared component identities.
- Their source callables and all derived state helpers are emitted once
  through IR and resolve only through stable Program ABI identities.
- Sequential runtime coverage proves strict start/finish ordering, sum `60`,
  empty-input zero, and rejection on iteration two preventing iteration
  three.
- Main runtime coverage proves exact logs, callee ordering, timestamp snapshot
  ordering, two genuine suspensions, sequential and parallel sums of `150`,
  and `Promise<void>` fulfillment with `undefined`.
- Plan coverage proves the exact five-state and three-state graphs, live sets,
  typed spill updates, and loop back-edge.
- Plan negatives reject every malformed spill-update class, and serialized
  plan/hash evidence changes when an update relation changes.
- WAT coverage proves native vector, `f64` accumulators/timestamps/results,
  `i32` counter, unchecked indexed read, direct calls, exact boundary
  conversions, and absence of intermediate dynamic/boxing carrier traffic.
- WAT coverage proves exactly four resolved clock-provider calls and one
  `__concat_5`-equivalent n-ary lowering for each of the two timing logs, with
  no four-call binary-concat chain.
- WAT coverage also proves one numeric vector construction, four specialized
  number-to-string calls, four string log calls, and the exact union/state
  spill sets without redundant second-suspension vector storage.
- Near-miss and injected post-claim failure controls remain direct or fail
  terminally as specified.
- Production readiness moves from 35/37 to 37/37 IR-emitted, from 32 to 30
  legacy bodies, from two to zero unsupported owners, and remains at zero
  invariants.
- The committed legacy-body ceiling is exactly the freshly measured 30, and
  normal fallback counts do not increase.
- An async-family IR-only shadow lane poisons direct async body emission and
  proves both migrated owners execute only through their prepared plans. The
  global strict IR-only verdict remains red until the other 30 legacy bodies
  are retired and must not be reported as ready early.
- Any exact-two-state adapter scaffolding made unreachable by the generalized
  consumer is deleted in the same PR; otherwise the issue records the concrete
  remaining consumer that prevents deletion.
- Focused runtime/plan tests, the async regression selection, typecheck,
  formatting, issue integrity, source/function budgets, TypeOracle ratchet,
  fallback and shape diagnostics, hybrid readiness, IR-only shadow,
  allocation provenance, and optimization-retirement gates pass.

## Validation plan

- Add `tests/issue-4124-ir-final-async.test.ts` for both owners: exact
  ownership, graph structure, live spills, runtime traces, empty input,
  rejection, WAT shape, stable late-import targets, and fail-closed controls.
- Keep #4110 and #4106 focused suites green so the wider graph does not regress
  parallel fan-out or the single-await identity producer.
- Retain #1042 host-drive, #2710 late-binding, #2766 bounds, #2906 loop-await,
  #2918 function-index shifting, #3587 rejection, #3741 integer-slot, #4113
  allocation-provenance, and #1373b async-plan coverage.
- Run IR-only shadow with a positive control proving the poison hook fires on
  an intentionally direct async near miss; an empty/no-op shadow is a failed
  instrument, not a pass.
- Record the unchanged direct control (`sequential sum = NaN`, fulfillment
  `null`) and assert the migrated source-correct result (`150`, `undefined`)
  so the test cannot accidentally preserve legacy defects under a parity
  label.
- Measure the readiness census and bank only the observed result.

## Focused acceptance matrix

- Sequential controlled input `[3, 1, 2]` has the exact trace
  `start:3, fire:3, start:1, fire:1, start:2, fire:2, resolve:60`; the outer
  Promise remains pending before every release. Empty input records only
  `resolve:0`. Rejection on iteration two records no third start and settles
  the outer Promise once.
- Main uses deterministic clock snapshots `[1000, 1150, 2000, 2030]` and logs
  exactly `async/await demo`, `sequential sum = 150 (took ~150ms)`,
  `parallel  sum = 150 (took ~30ms)`, and `done`. Sequential starts/fire pairs
  alternate; all five parallel starts precede any parallel fire; the returned
  Promise remains pending until the last parallel fulfillment and then
  fulfills once with `undefined`.
- A first-await rejection in main produces no later clock snapshots, result
  logs, parallel starts, or final log, and rejects the outer Promise once.
- The unchanged async entry reports every terminal unit IR-emitted. Both final
  owners are compile-once with prepared component IDs, and the entry passes
  the async-family IR-only shadow policy with no post-claim/fatal/skipped-slot
  errors.
- A late direct function introduces import churn without changing any
  prepared source/state/materializer/clock/concat/callee target. An injected
  post-seal defect in either owner is terminal with both body flags false.
- Pure-plan negatives cover unknown/duplicate/stale/non-dominating spill
  updates, undeclared/non-live targets, type mismatch, missing predecessor
  updates, liveness mismatch, and dangling allocation provenance.

## Remaining-body retirement checklist

The exact unit list and counts are updated from production telemetry in every
retirement PR. A family is checked only when its direct bodies are unreachable
and deleted with parity evidence; IR emission alone is insufficient.

- [x] **Final async terminal owners (#4124):** remove two legacy bodies and
      reach 37/37 terminal IR, 30 legacy bodies, zero Unsupported, zero
      Invariant.
- [ ] **Classes and methods:** prepare constructors, instance/static/object
      methods, accessors, fields, receiver/home-object/super state, and delete
      each obsolete direct class/member body path with semantic and WAT parity.
- [ ] **Closures and cross-owner calls:** prepare captured/mutable environments,
      nested declarations, arrows/function expressions, cross-source identity,
      and delete obsolete direct closure/call routing with ABI and allocation
      parity.
- [ ] **Module initialization:** replace compile-first/patch-later
      `__module_init` ownership with one ordered prepared unit, preserve
      binding/TDZ/export effects, and delete the direct initializer route.
- [ ] **Runtime and linear-memory helpers:** route retained runtime behavior
      through frozen semantic intents and make linear consume the same prepared
      program; delete AST-reading WasmGC/linear helpers only when all consumers
      use backend lowering.
- [ ] **Default flip and final deletion:** strict global IR-only passes with
      zero legacy bodies/fallbacks, every optimization-ledger row has IR
      ownership/evidence, hybrid escape hatches are removed, and the direct
      AST-to-Wasm handler graph is deleted.

## Integration order

#4110 lands and is verified first. #4124 then lands as the only overlapping
production IR PR. The remaining-body families follow serially in checklist
order unless telemetry proves a safer dependency order. Every family PR
updates this Markdown record (or a linked child record), the exact body census,
fallback census, optimization evidence, deleted implementation, and next
resumable boundary. No GitHub Issues are used for sprint tracking.

## Measured implementation outcome (2026-08-03)

- The bounded host lane is now 37/37 IR-emitted with 30 legacy bodies, zero
  Unsupported, and zero Invariant outcomes. The remaining bodies are 20 free
  functions, eight class members, and two module initializers.
- `fetchAllSequential` and `main` both skip direct body emission and own their
  complete prepared state families. The async-family shadow poisons direct
  async body compilation; the unchanged migrated source remains green and the
  deliberately direct near-miss proves the poison fires.
- Fallback telemetry now reconciles preliminary selector labels with the
  source-qualified terminal production outcome. The stale
  `async-function: 4` bucket is retired to zero; the two unrelated
  `string-builder-candidate` labels remain informational.
- The generalized frame restores exact incoming live sets: main restores
  `{ids, t0}` after its first await and only `{t2}` after its second. Plan
  verification rejects ordinary edges into resume states, mutable parameter
  update targets, and cross-dependent updates whose sequential application
  would violate phi semantics.
- Runtime and WAT parity covers strict sequential ordering, empty input, both
  rejection boundaries, exact logs/timestamps, Promise<void> `undefined`,
  typed spills, fixed vectors, unchecked proven reads, fused five-part concat,
  specialized number formatting, and typed logging.
- The earlier exact-two-state adapter scaffolding has no remaining named
  implementation; #4106 and #4110 now consume the same generalized prepared
  CFG/frame adapter. Shared AST async planners remain because methods,
  closures, `for await`, async generators, and other hybrid owners still use
  them.
- Strict global IR-only remains red solely because the 30 measured bodies
  above still emit legacy implementations. The next serial production family
  is classes and methods.

## Landed checkpoint and suspended handover (2026-08-03)

- Ready PR [#4065](https://github.com/loopdive/js2/pull/4065) merged through
  the queue as `df21c88095aba80d9628cd3a03328bd62787610d`. Its immutable source
  head was `04b4ddb57c6afe3e82859adbc21651dba4c2fd3a`.
- All 28 source-head checks passed. The exact merge-group SHA then passed the
  CI/equivalence suite, differential gate, and the full Test262 matrix: 66
  JS-host shards plus 36 standalone shards, aggregation, and the final
  regression comparison, with no failed job.
- The checkpoint is **37/37 targeted terminal units IR-emitted**, **30 legacy
  bodies**, **0 Unsupported**, and **0 Invariant**. The remaining bodies are
  exactly 20 free functions, eight class members, and two module initializers.
  Strict IR-only remains intentionally disabled until those bodies and their
  consumers are retired.
- Production migration work is suspended at this boundary. No classes/methods
  implementation branch or production PR was started after #4065. The next
  owner must resume serially with the unchecked **Classes and methods** family
  above, keep only one overlapping production PR active, and delete each
  obsolete direct implementation in the same PR that proves its IR replacement
  and optimization parity.
- Resume from a fresh isolated worktree based on the then-current
  `origin/main`; do not work in or clean the dirty root checkout. The landed
  source worktree `/private/tmp/ts2wasm-4118-ir-fetch-all-sequential` is clean
  and retained only as checkpoint evidence. Re-run the fallback, shape,
  hybrid-readiness, strict IR-only, optimization-retirement, issue-integrity,
  and focused regression gates before changing the next family.
- The first resumed implementation step is an exact census of the eight class
  member bodies and their remaining direct consumers against #3522. Migrate
  constructors/methods/accessors/field work in dependency order, preserve the
  receiver/home-object/super/layout and direct-call optimizations with explicit
  parity tests, and bank only freshly measured body/fallback reductions.
