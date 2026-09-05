---
id: 3527
title: "IR-only R7: AST-free async suspension plans and canonical Promise ABI"
status: blocked
created: 2026-07-21
updated: 2026-09-05
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, async, runtime
language_feature: async-functions, async-generators, for-await
goal: ir-full-coverage
sprint: Backlog
parent: 3518
depends_on: [3522, 3525, 3526]
required_by: [3528]
horizon: xl
complexity: XL
es_edition: multi
lane: ir-retirement-r7
model: gpt-5.6-sol
related: [351, 1042, 1169f, 1326, 1373b, 2865, 2867, 2895, 2906, 2967, 3090, 3387, 3389, 3518, 4573, 4574]
origin: "#3518 R7 — make the existing frame engine consume AST-free prepared suspension plans"
files:
  - src/ir/async-plan.ts
  - src/ir/nodes.ts
  - src/ir/builder.ts
  - src/ir/verify.ts
  - src/ir/effects.ts
  - src/ir/from-ast.ts
  - src/ir/program.ts
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/async-activation.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/function-body.ts
  - src/codegen/closures.ts
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions.ts
  - tests/issue-3527-ir-async-plan.test.ts
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/codegen/ir-prepared-free-functions.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerExpr
oracle-ratchet-allow:
  - src/codegen/async-linear-planning.ts
---
# #3527 — IR-only R7: AST-free async suspension plans and canonical Promise ABI

## Objective

Prepare every supported async function-like as one immutable, AST-free
`IrAsyncPlan` before emission, then lower that exact plan through the existing
frame/resume runtime for JS-host, standalone, and WASI.

The plan owns real suspension states, SSA/ref-cell/slot liveness, resume values,
handler/unwind edges, async-generator operations, and typed runtime intents. It
contains no TypeScript AST/checker objects, legacy `FunctionContext`, Wasm
`ValType`, function/type/import indices, target flags, source binding names, or
codegen callbacks. Declarations, nested declarations, arrows/function
expressions, instance/static/object methods, `for await`, and async generators
all follow the R0 Prepared/Unsupported/Invariant and compile-once contract.

R7 reuses the one production N-state frame engine and its host/native
settlement substrates. It does not create a second CPS engine. R8 later teaches
linear lowering to consume the same `IrAsyncPlan`.

## Current evidence

### One engine, but an AST-bearing plan

- `src/codegen/async-activation.ts:70-129` chooses `drive`, `host-drive`, or
  legacy sync pass-through. `maybeActivateAsync` at `:178-195` rewrites an
  already-registered legacy body; closure planning/emission has a separate ABI
  split at `:206-245` / `:248+`.
- `src/codegen/expressions.ts:1448-1454` confirms the older separate CPS emitter
  is deleted. The frame/resume engine is the one substrate to retain.
- `src/codegen/async-cps.ts:67-108` stores `ts.AwaitExpression`,
  `ts.ForOfStatement`, and AST-keyed liveness/settlement maps.
  `LinearAwaitPlan` at `:488-518` retains statements, expressions, and type
  nodes.
- `src/codegen/async-cps.ts:800-959` puts raw emit callbacks,
  `CodegenContext`, `FunctionContext`, `ValType`, AST operands/statements, and
  AST finalizers into `AsyncCfgPlan`. Producers `planAsyncCfg` (`:1047+`),
  `planWhileLoopCfg` (`:1186+`), `planForAwaitCfg` (`:1521+`),
  `planForAwaitAsyncCfg` (`:1807+`), and `planAsyncGenCfg` (`:2516+`) therefore
  cannot be a backend-neutral IR contract.
- `src/codegen/async-frame.ts:242-455` stores the declaration, source names,
  concrete Wasm types/indices, legacy capture layout, and target-specific host
  state. It rereads AST/checker state to guess spill and derived-parameter
  representation.
- `ensureAsyncResumeFunction` at `src/codegen/async-frame.ts:1020-1058` runs
  the AST planner during backend emission. State emission at `:1402-1874`
  executes callbacks and direct `compileStatement`/`compileExpression`,
  including copied finalizer statements. `emitAsyncFrameStateMachine`
  (`:2004-2045`) still starts from a legacy `FunctionContext`.

### Containers and call ABI remain direct

- `src/codegen/function-body.ts:1195-1219` performs legacy hoisting first, then
  activation; a decline falls into the direct statement loop.
- `src/codegen/closures.ts:1880-1916` fixes the legacy wrapper/capture ABI before
  activation and chooses frame versus direct AST body at `:2454-2469`.
- `src/codegen/class-bodies.ts:2213-2235` gives plain async methods the unwrapped
  direct signature; ordinary methods reach direct statements at `:2489-2505`.
- `src/codegen/literals.ts:2807-2817` and `:2991-3075` repeat the split for
  object methods. `src/codegen/statements/nested-declarations.ts:672-710` and
  `:1098-1172` repeat native-gen/async-gen/eager/direct forks.
- `src/codegen/declarations/import-collector.ts:97-108`, `:805-850`, and
  `:1743-1815` predict async host imports from AST before bodies; methods are
  absent. Its async-generator census at `:1026-1086` also drives module-wide
  representation policy.
- `src/codegen/expressions.ts:165-245`, `:360-445`, and `:1324-1498` detect
  async callees and consumers by checker/name registries, switch between raw T
  and Promise, wrap at call sites, and treat some await forms as identity.

### Current IR does not represent suspension

- `src/ir/nodes.ts:775-829` has await/async return/throw instructions whose
  comments defer true CPS; block terminators at `:2487-2512` contain no
  suspension edge. `IrFunction.funcKind` at `:2537-2588` lacks an
  async-generator plan.
- `src/ir/from-ast.ts:601-633`, `:713-727`, and `:2459-2485` unwrap async
  declarations to raw T and lower await as static substitution, pass-through,
  or a non-suspending instruction.
- `src/ir/lower.ts:2932-3007+` creates settled native Promises for return/throw;
  await is host identity or a native field unwrap, not observable suspension.
- `src/ir/select.ts:434-445` admits only top-level engine-declined declarations.
  Methods, closures, async generators, and `for await` remain rejected at
  `:1061-1079` and `:3060-3068`.
- `src/codegen/async-scheduler.ts:4296-4321` can change the whole standalone
  Promise carrier when one module contains a non-drivable async generator. A
  local Unsupported unit therefore changes unrelated representation.

## Preliminary async-gate reconciliation

`scripts/check-ir-fallbacks.ts:230-268` calls the bare selector without either
`supportsAsyncIr` or the production `asyncEngineClaims` predicate. The selector
therefore reports all four functions in
`website/playground/examples/js/async.ts` as
`deferred.async-function=4`, regardless of their production routes.

Production supplies the missing options during prepared-component discovery,
so the old four-label result was neither one coherent migration population nor
compile-once evidence. #4124 now reconciles the preliminary labels with exact
source-qualified production terminal outcomes: all five playground async free
functions are prepared/compile-once, the gate records
`async-function: 4 -> 0`, and the bounded host ledger records 37/37 IR bodies
with no Unsupported outcome. The production unit ledger remains the authority.

This completes only the free-function terminal family. Async methods,
closures/function expressions/arrows, `for await`, async generators, `yield*`,
standalone/WASI consumers, and deletion of the AST planners/activation census
remain unchecked acceptance work below.

## Standalone continuation (#4573, 2026-08-20)

After #4566, the standalone terminal census was 22 IR bodies and 15
legacy/typed Unsupported bodies. #4573 prepares the exact checker-certified
`new Promise((resolve) => setTimeout(() => resolve(value), ms))` delay owner
through the native `$Promise` substrate and one explicit embedder timer
capability. It removes the executor closure rather than replaying the direct
body, preserves grounded numeric operands and one-shot rejection/settlement,
and authenticates the dedicated timer callback dispatcher without retaining
the generic closure host bridge. The checkpoint is **23 IR / 14 legacy / 14
Unsupported / 0 Invariants**, with `body-shape-rejected` reduced from 3 to 2.

This closes only the standalone delay dependency root. The remaining async
terminals are exactly `fetchUser`, `fetchAllSequential`, `fetchAllParallel`,
and async `main`. The next dependency-complete slice must project their
existing prepared `IrAsyncPlan`s through the native frame/runtime, preserve
numeric Promise carriers and typed spills, eager/order-correct `Promise.all`,
proven vector bounds, fixed vector literals, ambient clock snapshots, fused
five-part concatenation, specialized number formatting, and typed string
logging, and reduce the standalone census from **14 to 10** without reopening
a legacy callee edge. JS-host, WASI, generic Promise constructors, async
methods/generators, and source near misses are not widened by #4573.

## Standalone async-family continuation (#4574, 2026-08-20)

#4574 owns the dependency-complete native projection for `fetchUser`,
`fetchAllSequential`, `fetchAllParallel`, and async `main`. It reuses the
existing immutable host-certified `IrAsyncPlan`s, shared frame engine, native
`$Promise` scheduler, and native Promise combinator; it does not add another
frontend or async engine. The checkpoint is **27 IR / 10 legacy / 10
Unsupported / 0 Invariants**, with all four `select/async-function` outcomes
removed and `delay` remaining compile-once.

The completed slice preserves typed sequential spills and ordering, eager but
input-order-correct Promise.all, the fixed ID vector, four deterministic
standalone clock snapshots, fused five-part string concatenation, specialized
number formatting, typed output, and native undefined settlement. The current
direct standalone family resolves or fans out too early and is not a semantic
runtime oracle; #4574 uses source/spec traces and existing host-plan evidence
for correctness while retaining direct only as an artifact/optimization
reference. Its authoritative result is **27/37 IR, 10 legacy/Unsupported, zero
Invariants**. Focused coverage passes 13/13, related async/provider coverage
39/39, #4124 11/11, and #4573 12/12. The tuned IR artifact is smaller than
direct at **125,889 vs 133,307 raw bytes**, **55,276 vs 57,037 gzip-9 bytes**,
**1,081,058 vs 1,197,082 WAT characters**, and **346 vs 353 functions**; both import exactly one timer
capability. Raw `main` fulfillment proves the canonical native value is
undefined tag 2 rather than null tag 1 before JS boundary normalization.
Calendar six and Builtins four remain separate capability/storage families.

## `IrAsyncPlan` contract

Extend function kind with `async-generator` and attach a verified plan to every
Prepared async unit. Exact type names may follow repository conventions; the
contract is fixed:

- state IDs and IR-only state bodies;
- terminators for `suspend`, `goto`, conditional branch, resolve, reject,
  yield/resume, and completion;
- each suspend edge carries an awaited `IrValueId`, successor-defined resolved
  value, resume state/block, and rejection/unwind target;
- explicit handler/catch/finally regions and completion replay by IDs, never
  copied AST statements;
- cross-suspend live SSA values, locals/slots, receivers, and mutable ref cells
  with `IrType`;
- semantic runtime intents from #3526 for Promise capability/adoption/reaction/
  settle, scheduler/drain, iterator/async-iterator/close, iterator result, and
  async-generator next/return/throw;
- stable source locations only as diagnostics metadata, never as executable
  source objects.

The same serialized plan/hash must be presented to host, standalone, WASI, and
linear. Only lowering selects a host Promise/reaction adapter or native
`$Promise` scheduler. All Prepared async callables expose one canonical Promise
or async-generator carrier ABI in `ProgramAbiMap`; consumers never select raw T
versus thenable ABI. Every await preserves asynchronous ordering, including a
statically settled operand.

`for await` lowers in the front-end to typed iterator intents with async
iterator lookup, sync fallback, `next`, `done`, `value`, and abrupt `return`/
close. Async-generator `yield*` uses the same iterator intents plus suspend/
yield edges. No direct emit hook is permitted.

## Dependency and policy locks

- #3519 owns typed terminal outcomes; a plan/backend mismatch is Invariant,
  never fallback.
- #3520/R1 identity and #3525/R5 whole-program resolution own frame/helper IDs,
  cross-file calls, delegation, and source order. Sanitized-name collision or
  earlier-declaration requirements are not valid IR contracts.
- #3521/R2 and #3522/R3 own preparation, captures, receivers, home object,
  `this`, `super`, `arguments`, and method ABI. R7 never plans from an activating
  legacy `FunctionContext`.
- #3526 owns Promise/scheduler/iterator runtime intents and freezes them before
  resume-body lowering.
- #3528 consumes this exact plan for linear; it may not add another async
  frontend. Top-level await/module async evaluation stays source-located
  Unsupported until an explicit R4 extension defines it.
- Authoritative standalone/WASI evidence is cold-process evidence; warm/batch
  results cannot close R7 because current carrier state has order dependence.

## Bounded A–G landing sequence

### A — define verified async suspension IR

- Add `src/ir/async-plan.ts`; extend nodes, builder, verifier, effects, exports,
  function kind, true suspend/yield/completion edges, liveness, and handlers.
- Test hand-built plans only. No routing change.

### B — prepare free async functions with canonical Promise ABI

- Lower await/return/throw/calls into plans and attach them to
  `PreparedIrProgram` before emission.
- Refactor the WasmGC host/native frame adapter to consume plans without AST or
  legacy contexts. Remove raw-T C1 behavior only for Prepared units.

### C — preserve async closure environments

- Cover arrows, function expressions, nested declarations, captures, mutable
  ref cells, derived/destructured parameters, and lifted async function kind.
- Stop using `planAsyncClosureActivation` for migrated units.

### D — prepare async class and object methods

- After R3, cover instance/static/object receiver, home-object, `super`,
  `arguments`, parameter prologues, and captures. Remove their direct statement
  loop only when compile-once evidence passes.

### E — lower `for await` through iterator intents

- Cover async and sync sources, genuinely pending `next`, done/value,
  destructuring, break/throw, and exactly-once iterator close.
- Delete `emit`/`postDeliverEmit` callbacks for migrated paths.

### F — lower async generators through the same plan

- Cover lazy entry, await/yield, fresh operation Promises, next/return/throw,
  rejection/completion, and `yield*` across host/native carriers.
- Remove the module-wide non-drivable carrier fallback and eager host buffer for
  Prepared units.

### G — remove async AST planners and activation hooks

- Delete `async-activation.ts`; delete AST/callback planning portions of
  `async-cps.ts` and AST/checker planning from `async-frame.ts`.
- Replace async import census with #3526 runtime intents; remove container
  activation/direct routes and Prepared-unit call wrapping/legacy await paths.
- Retain frame-core and scheduler/provider behavior behind semantic plans. The
  R0 ledger must show zero fallback/direct emissions before deletion.

## File ownership and locks

A/B establish the contract and require one owner for `src/ir/async-plan.ts`,
the named IR core files, `src/codegen/async-cps.ts`,
`src/codegen/async-frame.ts`, `src/codegen/async-activation.ts`, and Promise ABI
integration. C–F may be separate sequential sub-slices, but a slice owns its
container file plus frame adapter end-to-end; do not split one activation/body
fork between developers.

Coordinate runtime intent/provider edits with #3526 and linear adapters with
#3528. `src/codegen/async-scheduler.ts` is retained substrate and should change
only where the typed provider adapter requires it.

## Anti-vacuity tests

`tests/issue-3527-ir-async-plan.test.ts` must prove:

1. Plan purity: serialized plan/hash is identical under host, standalone, and
   WASI; dependency/type guards find no AST, codegen context, callback,
   `ValType`, runtime index, or target flag.
2. A manual plan with two suspends, a branch/back-edge, and handler has exact
   SSA/ref-cell/slot liveness and successor result binding; invalid state,
   handler, and liveness edges fail verification.
3. A Prepared async unit records `legacyBodyEmitted:false`, direct=0/IR=1;
   poisoning every legacy async dispatcher leaves execution green.
4. A genuinely pending order trace is
   `[sync-prefix, after-call, resume, finally, settle]`; no suffix runs before
   host settlement or native drain, including `await Promise.resolve(...)`.
5. Two awaits spill scalar/reference/receiver/captured mutable ref-cell and
   derived destructuring values correctly through fulfillment and rejection.
6. Pre-await throw rejects the result Promise; catch/finally and return/throw/
   break completion replay across suspension preserve source order.
7. Top/nested declaration, concise/block arrow, function expression,
   instance/static/object method genuinely suspend and preserve capture,
   `this`, home object, `super`, and `arguments` behavior.
8. `for await` covers zero/multiple elements, pending `next`, async/sync source,
   getter/next counts, pattern heads, and exactly-once close on break/throw.
9. Async generators are lazy; every next/return/throw returns a fresh Promise;
   await/yield/order/done/value/rejection/`yield*` traces match across targets.
10. Same-name async units across files/classes and forward/delegate references
    prove structural identity and source-order independence.
11. A deliberate unsupported form returns a stable code/span and emits no
    body; a missing adapter/runtime intent is fatal Invariant, not Unsupported.
12. The IR-only gate consumes production outcomes and fails if it restores the
    old bare-selector `async-function=4` shortcut or catches a compile error.

Run adjacent suites including `tests/ir/issue-1373b.test.ts`,
`tests/issue-1042-host-drive.test.ts`, `tests/issue-2895-async-frame.test.ts`,
`tests/issue-2967-engine-convergence.test.ts`,
`tests/issue-2906-3b-forawait.test.ts`,
`tests/issue-2906-3dii-asyncgen-consumer.test.ts`,
`tests/issue-3228-forawait-dstr-standalone.test.ts`,
`tests/issue-3387-asyncgen-forawait-dstr.test.ts`, and
`tests/issue-3389-asyncgen-return.test.ts` in isolated host/standalone/WASI
processes where required.

## Acceptance criteria

- [ ] Every supported async container/protocol has one verified AST-free
      `IrAsyncPlan` attached to its Prepared unit before emission.
- [ ] Plans contain real suspension/liveness/handler/runtime-intent semantics
      and no AST/checker/codegen/Wasm-index/callback state.
- [ ] Prepared async callables use one canonical Promise/async-generator ABI;
      consumer-sensitive raw-T wrapping and await identity are absent.
- [ ] The existing frame/resume engine consumes the same plan for host,
      standalone, and WASI with observably asynchronous, equivalent traces.
- [ ] Free functions, closures/nested functions, arrows/expressions,
      class/static/object methods, `for await`, async generators, and `yield*`
      pass compile-once and anti-vacuity coverage.
- [ ] Async-specific AST planners, activation hooks, import census, direct
      container routes, module-wide carrier fallback, and Prepared-unit call
      wrappers are unreachable and removed after zero-direct proof.
- [ ] Unsupported source is stable and source-located; missing planned support
      or backend adapters are fatal Invariants and never demote.
- [ ] IR-only, async regression, cold standalone/WASI, cross-backend, validity,
      typecheck/format, and merge-group Test262 gates are net-non-negative.

## Deletion boundary

R7 may remove async-specific AST planning, activation, and direct routing only
after every named migrated container is Prepared with
`legacyBodyEmitted:false`. It does not delete general shared
`compileStatement`/`compileExpression` handlers still used by hybrid non-async
units. It retains `async-scheduler.ts`, frame-core, Promise, iterator, and
settlement provider behavior behind #3526 intents. General deletion is R10.

## Out of scope

- A parallel CPS/frame engine or a second plan for linear.
- Encoding AST, lexical names, concrete Wasm types/indices, or callbacks in the
  plan as a temporary bridge.
- Treating top-level await as supported without an explicit ordered module-plan
  extension.
- Preserving current raw-T/await-elision behavior when it violates Promise and
  microtask ordering.

## Risks and mitigations

- **Observable timing/ABI correction:** canonical Promise ABI changes current
  sync pass-through behavior. Use event-order tests, not only return values.
- **Abrupt completion:** catch/finally and generator return/throw are easy to
  miscompile. Represent completion/unwind edges explicitly and verify them.
- **Spill representation drift:** current derived-param/ref guesses depend on
  legacy contexts. Use SSA/ref-cell identity and `IrType` before deleting them.
- **Late imports/indices:** current AST census exists to prevent shifts. Require
  #3526's frozen Promise/iterator/scheduler manifest before resume emission.
- **Carrier coupling:** one unsupported async generator may currently change a
  module. Make Unsupported unit-local and test unrelated plan hashes.
- **Protocol/cross-file gaps:** iterator close, `yield*`, laziness, operation
  Promise identity, same-name units, and declaration order need dedicated
  anti-vacuity traces rather than corpus counts.

## Implementation Plan — 2026-09-05 — B2 linear suspension chains and liveness

**Planning source:** `5da655f286fcd569203cd2012b23dc21bf1c626d`; the lead
verified no IR delta in the subsequently fetched `4946cf` main. Re-ground the
implementation against its assigned current-main worktree. Proposed slice
claim: `3527:r7-b2-linear-suspension-liveness`, reserved by the lead before
dispatch. Astra plans and Luna `max` implements, per the user. This phase is
ready independently of the remaining epic dependencies; it does not close R7
or change its acceptance checkboxes.

### Current production boundary

The older “Current IR does not represent suspension” evidence above is
superseded by production source. `IrAsyncPlan` already has a canonical Promise
ABI, typed spills/updates, verifier and full semantic serialization.
`src/codegen/ir-async-frame.ts:388` lowers it through the existing
`emitPreparedAsyncFrameStateMachine`; its adapter restores typed spills
(`:322`) and consumes multiple states. A new frame engine or plan schema is
not required for linear chains.

The producer still constrains the population. `async-prepare.ts:745` handles
one await and rejects a slot used on both sides; its continuation receives
only the resumed value. The separate loop and two-await producers test
`fetchAllSequential`/`fetchUser` and `main` names (`:139`, `:373`). Source
selection independently admits exact forms and rejects pre-await captures
(`async-ir-planning.ts:445`, `:507`); native admission follows another named
family (`:565–650`). None of those names is a semantic suspension proof.

There is also an earlier blocker: the await arm in `from-ast.ts:4044` erases
statically settled `Promise.resolve` and non-reference awaits. A general
splitter cannot recover an erased microtask boundary. Exact prepared-owner
await evidence must reach this arm before source admission widens.

### Bounded structural result

Prepare top-level ordinary async declarations with a linear sequence of
awaits, ordinary intervening computation, and a final return/void completion.
There is no fixed await count, statement count, identifier spelling, constant,
or particular callee required. Use the existing callable/frame carrier and
runtime-provider capabilities; this phase does not widen their representation
vocabulary. At least the existing real-suspension population must be covered,
and every await within an admitted chain survives, including settled operands.

Branches/back-edges that cross suspension, try/catch/finally, nested executable
containers, receivers/captured ref cells, `for await`, async generators, WASI
and cross-source ownership remain separate phases. Existing specialized
loop/main routes remain until the generic producer plus their runtime
capabilities can replace them with measured parity. Their remaining name
guards must be reported as unfinished work, not described as general R7
coverage. Fully settled owners still using the old C-1 route are likewise
outside this phase's completion claim.

### Implementation and exclusive write scope

1. **One exact source eligibility record.** Add
   `src/codegen/async-linear-planning.ts` and consume it from `async-ir-planning.ts` in
   `preparedIrAsyncSourceShape`, `prepareAsyncCallableAbi`, selector options,
   thenable-call resolution and owner collection. Reuse `analyzeAsyncBody`
   and `planLinearAwaits` (`async-cps.ts:659`) only as frontend structural
   preflight; retain every exact await node in source evaluation order and
   prove none is hidden in a nested scope/unsupported control region. Do not
   copy their AST/callback plan into `IrAsyncPlan`. Source eligibility,
   allocated canonical Promise result ABI, and final IR preparation must
   agree; an unproved callable must not be changed to a Promise ABI and then
   fall back to a raw-value emitter.
2. **Preserve suspension at AST lowering.** Extend the prepared resolver in
   `src/ir/async-from-ast.ts` with exact owner/await-site evidence and the
   prepared resume type. Consume it only in `from-ast.ts`'s await arm, before
   C-1 await elision. Evaluate the operand once, retaining an explicit `await`
   even when an existing valid static substitution supplies its value. Use
   the existing typed externref conversion when the operand needs the await
   carrier; provider preparation must see that conversion. Do not add an
   extra reaction or hand-written Promise wrapper: the existing frame engine
   owns PromiseResolve/adoption and suspension. Reconcile the produced await
   population with the exact source record; a missing, duplicate or foreign
   site is an invariant, not a shorter successful plan.
3. **General IR segmentation.** Add `src/ir/async-linear-prepare.ts`, called
   from `prepareSuspendingIrFunction:678`. Consume one linear IR block with
   no suspension hidden in nested buffers; split at every await, in order.
   Retain the existing return-carrier optimization only after this general
   analysis proves it valid. Do not use owner/callee/local names as admission.
   Produce deterministic state IDs and `ir-async-state` derived `UnitId`s
   anchored to the exact source owner and stable helper ordinal.
4. **Compute values crossing boundaries.** Build a complete definition/use
   and type table. Resolve ordinary linear `slot.write`/`slot.read` sequences
   through reaching definitions before splitting; preserve explicit
   conversions and logical types. A read without a proved reaching definition
   or a refinement that cannot be preserved is a typed preparation refusal,
   never an invented default. Compute live-in/live-out backwards over the
   resulting state edges, excluding the successor-defined resume value.
   Retain a value through intermediate states even when they do not use it;
   omit dead values and overwritten slot versions. Populate exact typed
   `spills` and each suspend's `live` set. Reuse the existing analysis
   vocabulary and have `verifyIrAsyncPlan` (`async-plan.ts:1107–1171`)
   independently recompute the result from the completed plan.
5. **Outline computation into ordinary IR helpers.** The current frame
   adapter intentionally accepts `const`/`call` state bodies
   (`ir-async-frame.ts:230`); do not expand it into another instruction
   lowerer. Partition non-suspending computation into deterministic ordinary
   helper calls with explicit free-value parameters and zero/one result,
   as the existing async producers do. A region with several values needed
   later must expose each value through ordered helper boundaries; returning
   only its final Promise loses the others. Never recompute effectful
   prefixes to manufacture extra outputs. Preserve instruction order,
   effects, allocation/site provenance, and exact symbolic call bindings.
   Keep intermediate values inside helpers where their carrier is not a
   valid frame boundary. Every helper and its final allocation provenance
   must pass the ordinary IR verifier before component sealing.
6. **Reuse canonical target preparation.** The semantic chain uses
   `canonicalPromiseAbi`, `createIrAsyncPlan`, the existing runtime intents,
   and rejection edges to the existing rejection sink. Numeric/reference
   spills and helper interfaces must have exact preplanned carrier evidence.
   For standalone, replace named-leaf certification for the new chain with a
   structural call/provider closure: each awaited Promise producer is an
   exact prepared async owner or an already-supported Promise-delay/provider
   plan. Reconcile the whole candidate dependency component before reserving
   ownership, independent of declaration order. Unknown producer/carrier
   provenance remains a refusal. Do not enable the global native Promise
   carrier gate, import host services into standalone, or let one unsupported
   sibling poison unrelated prepared components.

Own the new `src/ir/async-linear-prepare.ts` and `src/codegen/async-linear-planning.ts`,
`src/ir/async-prepare.ts`, `src/codegen/async-ir-planning.ts`,
`src/ir/async-from-ast.ts`, and only the named await arm/import in
`src/ir/from-ast.ts`. A small pure liveness extraction from `async-plan.ts`
is permitted if useful; do not weaken its verifier or change the codec/schema.
Add `tests/issue-3527-linear-suspension-preparation.test.ts` and
`tests/issue-3527-linear-suspension-runtime.test.ts`, updating old near-miss
expectations only after their new route is measured.

R2-B1 owns `lower.ts`, `integration.ts`, source-callable registry, and component
sealing; this slice reuses those seams and does not edit them. R5 M2-P1 owns
`multi-prepared-*`; this slice does not touch those files. Ordinary async
callable allocation stays in `prepareAsyncCallableAbi`; any required shared
boundary change must be coordinated with the R2 owner before editing. No
changes to `async-frame.ts`, scheduler, runtime adapters or new providers are
assumed: a missing capability is a concrete prerequisite to report, not a
reason to bypass preparation or silently widen a backend.

### Validation and landing bar

- First measure baseline/candidate SHAs and explicit target/options. Include
  two and three awaits with a parameter and a computed value live across
  both, a mutable local updated between awaits, dead/overwritten values,
  numeric-vector identity, an unused await result, and final `return await`.
  Vary names, constants, helper declaration order and await count. Compare
  exact attempted units, state/await counts, helpers, spill sets, direct/IR
  body counts and runtime results. No gain is asserted from source inspection.
- Use controlled pending fulfillment and rejection at each suspension. Assert
  the event order before the first call returns, between resolutions, and
  after final settlement; a rejected first await cannot run later effects or
  evaluate the second operand. Test a synchronous throw while evaluating an
  awaited expression and after a resume. Add a mixed pending/settled chain
  containing `await Promise.resolve(value)` and a settled non-thenable; every
  admitted await must still yield a microtask. Compare with native JavaScript
  and the direct engine control, documenting any baseline ordering defect.
- Corruption tests remove/add a live value, use an old slot version, drop or
  duplicate an await, substitute a source owner, and remove a runtime/carrier
  receipt. Missing liveness, invalid provenance or post-claim evidence must
  fail before publication; deliberately unsupported control regions retain
  a source-located refusal and do not emit a partial prepared body. Poison
  the direct body of newly prepared owners and require direct `0` / IR `1`.
  Revert the generic producer and prepared-await retention independently to
  prove both ownership and ordering tests fail for the intended reason.
- Run `pnpm typecheck` and
  `VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run` with the two
  new suites, `tests/ir/issue-1373b-async-plan.test.ts`,
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`,
  `tests/issue-4106-ir-async-fetch-user.test.ts`,
  `tests/issue-4124-ir-final-async.test.ts`,
  `tests/issue-4573-standalone-native-promise-delay.test.ts`,
  `tests/issue-4574-standalone-native-async-family.test.ts`, and
  `tests/issue-2906-async-multiawait.test.ts`. Run native controls in fresh
  processes; also retain host rejection/engine-convergence and existing WASI
  controls as no-regression evidence, not newly prepared WASI coverage.
- Run both `node --import tsx scripts/check-ir-only.ts --json --policy=hybrid`
  and `node --import tsx scripts/check-ir-only.ts --json --policy=ir-only`,
  `node --import tsx scripts/check-ir-fallbacks.ts`,
  async equivalence, normal dialect/layering/format/size gates and full
  merge-group Test262. Report remaining fixture producers, C-1 await elision,
  unsupported containers/handlers and target gaps explicitly. A green
  playground family or the small IR-only corpus cannot close this issue.

### B2 implementation checkpoint — 2026-09-05

The B2 implementation is published in signed merge head
`873e5fa140f65040bab224a1d147582a55a615c9`, whose parents are the signed B2
implementation `a8bc547795f47ec0847466b0bb0ebb5a75cb01f8` and current upstream
`470ceba797a2822ead2a4060fc65fb78c0b52887`. The branch is
`codex/3527-b2-luna-20260905`; PR #5602 is open against `loopdive/js2:main`
from `ttraenkler:codex/3527-b2-luna-20260905`.

The structural source record and AST free producer now admit arbitrary positive
await counts in supported top level straight line async declarations. The
runtime fixture measures five source awaits and five emitted frame state edges:
pending `delay`, settled `Promise.resolve`, an unused settled
`Promise.resolve`, settled non thenable `await 42`, and a second pending
`delay`. The IR and native controls both produce the event sequence
`schedule:0:1`, `fire:0`, `observer:1`, `observer:2`, `schedule:0:1`,
`fire:0`; the independent Promise observer distinguishes retained settled
awaits from static erasure. Controlled first and second rejection cases stop
later state effects, and final void owners resolve `undefined` through the
canonical ABI. The direct engine value comparison remains supplemental.

The pure preparation suite verifies three states/two suspensions, computed
SSA liveness `[[0], [0, 4]]` with SSA spills `{0, 4}`, mutable slot reaching
definitions with slot spill `{3}`, and verifier refusal of missing liveness,
missing spills, duplicate states, and missing runtime intent. The direct body
poison control observes direct `0` / IR `1` for newly prepared owners.

Post merge validation: the two B2 suites passed 10/10 tests and the adjacent
async plan suite passed 12/12. Typecheck, format, fallback, IR only hybrid and
IR only, dialect, neutrality, layering, stack, host import, LOC/function,
oracle/coercion, numeric local parity (18/18), issue integrity, and normal
pre push checks passed. The focused #4106 suite passed 7/8 with its existing
host free invalid `WebAssembly.validate` baseline red; the #4104 suite passed
16/17 with its existing `functionPrototypeCall` policy expectation red.

This checkpoint does not close R7. Loops/back edges, handlers, nested
executable containers, async generators, `for await`, WASI, and fully settled
owners on the historical C 1 route remain separate work. Existing standalone
and WASI invalid opcode validation reds remain unchanged, and no baseline was
weakened.

### B2 settled owner admission repair checkpoint — 2026-09-05

Root's independent settled await controls found a regression at the published
B2 head before this repair. With `experimentalIR: true`,
`nativeStrings: false`, and `trackIrOutcomes: true`, the one await literal
owner and the two await literal owner both failed compilation with
`IR async runtime attachment for test has no valid async plan owner`. One
direct body was emitted before the fatal IR error, and the result had zero IR
bodies. The historical C 1 controls returned 43 and 85. The provider only
`Promise.resolve` control remained a
valid B2 owner and returned native Promise value 6 with matching independent
native observer order.

The narrow fix makes prepared await retention require the existing
potentially suspending owner analysis in addition to the linear source shape.
Fully static owners therefore remain on their established C 1 route until a
separate cutover, while provider only and pending mixed chains retain the B2
producer and canonical await ordering. The regression suite independently
asserts that both static owners' synthetic helpers are absent, then validates
their direct results 43 and 85; the existing mixed, pending, rejection, and
provider controls remain active.

Repair commits `96defcfe84d9753e5352e20b60a0c86236f5dda0` and
`18352307cb7cb6bede526bf496e10ba3846624d7` are signed with the required
Thomas Tränkler author, Codex coauthor, and Luna Max model trailer. PR #5602
is open and unqueued at exact head
`18352307cb7cb6bede526bf496e10ba3846624d7`.

The focused runtime regression suite passed 7/7 and the pure preparation suite
passed 4/4. Typecheck, formatting, fallback, IR policy, dialect, layering,
neutrality, stack, oracle/coercion, numeric local parity (18/18), issue
integrity, and the normal pre push hooks passed. Root independently reran the
three source controls 3/3: static one and two await owners compile and return
43/85 with the baseline route, and the provider only owner remains direct 0 /
IR 1 with native observer parity. The exact upstream merge head still needs to
be integrated before the final R7 publication review; this repair does not
close R7 or broaden its remaining loop, handler, container, generator,
`for await`, WASI, or settled owner limits.

## Implementation Plan — 2026-09-05 — B3 settled non-thenable owners

**Next bounded cutover, conditional on final B2 author handoff.** Canonical
claim `3527:r7-b3-settled-nonthenable-owners` is held by
`ttraenkler/luna-ir-r7-b3-20260905` for branch
`codex/3527-b3-luna-20260905`. Root prepared its isolated worktree at verified
published B2 repair head `76fb2f31258ec90aef96aa81fe287e285a6a7221`.
The preceding B2 implementation and repair records are preserved from that
exact head. The complete ten-open-PR file census and canonical claims read at
`a7a7a28affed7db816f1a645d4e4fc8ad21a207d` found no duplicate B3 slice.
Astra plans; Luna Max implements after root records the author's completed
current-main integration and releases the final source handoff. Worktree
creation alone is not implementation dispatch or proof that B2 has merged.

### B2 repair prerequisite and source cause

Root ran five isolated GC/JS-host rows with `experimentalIR:true`,
`nativeStrings:false`, `trackIrOutcomes:true`: two fully literal one/two-await
sources at each of B2 and planning head
`a5fbaa544046f854daba8881d80c72bc56b87bf9` (source equals main `470ceba`), plus
one B2 `Promise.resolve(parameter expression)` positive control. Main's two
literal sources compiled/validated and returned raw numbers `43`/`85` (2/2).
B2's same two sources failed compilation (0/2), reporting
`IR async runtime attachment for test has no valid async plan owner`. Its
positive control compiled and returned a real Promise fulfilled with `6`, with
native observer ordering. Artifacts: root scratch `r7-settled-*.jsonl` under
`.tmp/ir-completion-20260905` and the corresponding probe script. These results
establish a B2 regression for those two controls, not a complete async census.

The original B2 author owns its narrow repair. Do not repair it again in B3 or
claim the old C-1 population remained unchanged before the repaired head passes.
Root subsequently verified three repair controls (3/3) on local candidate HEAD
`96defcfe84d9753e5352e20b60a0c86236f5dda0` plus final comment edits, with
`async-ir-planning.ts` SHA-256
`d84b1bc8252361afcdd9c5ac3cd67750f0950f220fa954d5e45875296b124ead`
stable across the runs. The literal sources again compiled/validated and returned
raw `43`/`85`; the provider control retained direct `0` / IR `1`, a real Promise
fulfilled with `6`, and native observer ordering. Outputs are
`r7-settled-{one,two,provider}-fix.jsonl`. This verifies the narrow regression
repair locally. The original author subsequently reports 7/7 runtime and 4/4
pure-preparation controls plus normal gates passing. Root's complete PR file
census independently confirms published head `76fb2f3` with the eleven intended
files, including the repair and its record. Current-main integration and the
final B2 author handoff remain prerequisites for B3 implementation.
The source discrepancy is exact: `preparedIrAsyncAwaitSite`
(`async-ir-planning.ts:759`) checks a linear source shape/site, while
`preparedIrAsyncSourceCanSuspend:551` additionally requires a non-static await.
Consequently retention can run for an owner absent from
`collectPreparedIrAsyncOwners:970` and without an `IrAsyncPlan`. B3 must inherit
the repaired ownership guard, not remove it to gain coverage.

Other decisions that must move together:

- `prepareAsyncCallableAbi:869`, called by `declarations.ts:1856/2995`, projects
  `externref` only for the prepared source proof. Otherwise the declaration
  retains the unwrapped fulfillment ABI. `isAsyncIrReady`
  (`ir/async-selection.ts:26`) still admits historical C-1 owners separately.
- `preparedIrAsyncSourceShape:511` prioritizes the old one-await identity source
  shape. A settled `return await ...` must receive exact retained-await evidence
  even when that source-shape priority would otherwise select identity.
- `selectR3PreparedSuspendingAsyncFunctions`
  (`ir-prepared-free-functions.ts:1203`) joins exact owners, allocated Promise
  signatures and outgoing prepared dependencies. It does not by itself prove
  every incoming source consumer compatible with a changed Promise ABI.
- `prepareSuspendingAsyncLowering` (`ir/integration.ts:476`) splits only the
  recorded owner set. `prepareSuspendingIrFunction` (`ir/async-prepare.ts:679`)
  already tries the one-await optimization before B2's generic splitter.
  `lowerPreparedIrAsyncFunction` (`codegen/ir-async-frame.ts:365`) verifies the
  allocated `externref` result and drives the existing frame engine.

### Integrated B3 baseline verification — 2026-09-05

The original B2 author integrated exact main
`e4ef2c3ef01cc04126203551240fe95b3513f92e` in signed merge
`d658f8964b1fd106f28a243e273211db968afaac`, whose other parent is the
published repair `76fb2f3`. The B3 planning worktree contains that merge and
has identical source and test contents; its only additional change is this
Astra plan. The author's post-merge gates, safe publication and final handoff
remain separate dispatch prerequisites.

Root reran the same three controls in separate GC/JS-host processes at exact
`d658f896`, including the merged integration, lowering and R3-routing files
in the seven-file before/after fingerprint check. All three controls passed
(3/3): the one/two literal-await exports compiled and validated, returning
raw `43`/`85` with direct `1` / IR `1`; the prepared provider export returned
a real Promise fulfilled with `6`, direct `0` / IR `1`, and exactly the native
observer event sequence. The two raw-value results preserve the repaired
baseline and still contradict the required canonical Promise ABI; they are
not B3 acceptance evidence. No conformance population is inferred here.
Evidence is in root scratch `r7-settled-{one,two,provider}-postmerge.jsonl`
and `r7-settled-runtime-postmerge-control.mts`.

### Scope and ordered implementation

Own top-level ordinary async free functions on the existing JS-host WasmGC
provider profile, with B2's flat source/control proof, existing supported
parameter carriers, numeric awaited values and numeric/void fulfillment. Every
await operand must have exact non-thenable evidence after transparent wrappers
are removed. This is a semantic proof, independent of spelling, constants,
source-file identity or an await-count limit. A function with no await needs a
separate entry/settlement plan and remains outside this increment. Keep loops,
handlers, nested executables, methods, generators, `for await`, standalone/WASI
and new carrier families on their existing policies.

1. **Prepare one exact owner proof before ABI projection.** Extend the existing
   async source planning with an explicit settled-owner record containing source/
   unit/declaration identity, ordered await sites, their actual operand and
   delivery types, fulfillment signature, and existing number-box/unbox and
   async-runtime capability requirements. Reuse `preparedIrAsyncLinearSource`
   and the ordinary selector's body/signature proof. Unknown evidence is not
   non-thenability; a cast of a Promise/unknown value to `number` is not proof.
   Do not use the old static classifier's scheduling-elision verdict as the
   authority. Parameters, helpers and retained calls must use their existing
   supported ABI, with the existing exact function-value exclusions.
2. **Close the callable boundary before changing it.** Join incoming and outgoing
   source call sites by UnitId and require the selected declaration's canonical
   Promise result to agree with each prepared/direct call contract. Preserve
   numeric fulfillment separately from the physical callable `externref` result.
   External JS callers receive the real Promise; old source raw-value/await
   consumers cannot be assumed compatible. If an existing caller contract cannot
   express this distinction, leave the affected component unadmitted before ABI
   projection and identify the required caller-contract prerequisite. Do not
   broaden the R2 transaction or infer compatibility from a bare function name.
3. **Use that same proof at every handoff.** Declaration ABI projection,
   selection, the repaired `preparedAsyncAwaitSite` guard, collected owner IDs and
   final R3 routing must agree. Unselected owners receive neither the new ABI nor
   retained awaits. Once a Promise ABI has been promised, losing its prepared
   owner must be an Invariant or a proven rollback before any consumer/ABI
   publication; falling back to the old C-1/direct body is invalid because its
   activation predicate still declines settled owners. Do not globally enable
   `asyncFnNeedsHostDrive` or change legacy activation for unrelated functions.
4. **Retain and split the actual operands.** For these non-thenable sites, evaluate
   the source operand once, use B2's existing carrier conversion and emit one
   `await` per site. Reconcile the exact ordered source sites with final IR awaits
   before splitting. Reuse B2 liveness, slot reaching definitions, derived-unit
   provenance and `canonicalPromiseAbi`; do not add a second state builder.
   Preserve `prepareSingleAwaitIrFunction`'s proven carrier optimization before
   the generic splitter. Optimizing carrier conversions must retain the await
   edge and its job boundary.
5. **Prepare providers, seal, then emit.** Use the existing runtime manifest and
   `materializePreparedAsyncHostAdapters` to reserve number boundaries, Promise
   resolve/react/capability/settlement and void-undefined support before component
   seal. Validate final logical/physical signatures, helpers, state/spill/await
   census and exact runtime receipts before the source slot is published once.
   The exported Wasm function itself returns a real Promise. A call-site
   `Promise.resolve` wrapper cannot be used to hide a raw result. Unknown support
   is a pre-ownership refusal; broken promised evidence is an Invariant with no
   partial body publication or direct retry.

**Promise.resolve is an explicit dependent proof.**
`staticPromiseResolveSettledExpr` (`ir/async-static.ts`) recognizes textual
`Promise.resolve` chains without binding or mutation evidence. Both the C-1
selector and B2's prepared-await arm reuse it (`select.ts:9319`,
`from-ast.ts:4058/4073`). A nonempty declaration-file check alone does not prove
an unmodified builtin property or justify erasing a callable evaluation.
Promise-valued operands therefore do not qualify for B3's non-thenable proof.
Their next increment must either evaluate the original call exactly once with
its resolved callable/receiver/effects and Promise carrier, or supply a sound
immutable-builtin substitution proof covering aliases, shadowing, mutation,
getters and nested calls. No new name-only substitution is permitted here.
The current host async normalization itself uses `Promise_resolve`
(`runtime-host-capabilities.ts:589`, `runtime.ts:16250`); distinguish that
intrinsic-await obligation from the source-visible static call when planning the
follow-up. Do not call this separate existing hazard a B2 regression without a
controlled baseline. Existing B2 Promise-valued owners remain on their current
policy; this phase does not certify or broaden them.

### Finite validation and ownership

Use the repaired B2 head as the measured base and record its exact SHA. Add
`tests/issue-3527-settled-owner-runtime.test.ts` and focused owner-proof negatives:

- Real exported functions with one and multiple numeric/non-thenable awaits,
  a parameter/computed value live across both, mutable-local updates, unused
  await results, `return await`, and a void tail. Vary names, constants and
  helper order. Check raw export return is a native Promise, expected fulfillment,
  exact await/state/liveness evidence and direct `0` / IR `1` per admitted owner.
- Native-JS controls with independent `Promise.resolve().then(...)` observers
  and observable effects before the first await, between awaits and after the
  last. Compare the full event sequence, including what happens before the call
  returns. Awaiting a raw number in the test harness is not Promise-ABI proof.
- A supported effectful call that throws before the first await and after a
  resume must return a rejected Promise, never throw out of the exported call,
  and must stop subsequent effects. Use controlled host imports/helpers with
  matching native controls. Retain B2's controlled first/second awaited rejection
  tests as adjacent engine coverage; those Promise-valued inputs are not new B3
  admission evidence. A raw cast consumer is not a compatibility oracle.
- At least one closed prepared caller of a new owner, plus an incompatible
  historical raw-value caller and a same-spelling foreign binding. Verify exact
  Promise call ABI or refusal before projection, never a wrong executable.
- Delete/substitute the owner proof, a source await, spill, helper provenance or
  runtime/ABI receipt; withdraw the owner after Promise projection; poison the
  source direct/C-1 body and the unprepared await arm for admitted owners.
  Corruption must fail before publication. Unselected and kill-switch controls
  keep their existing route and ABI; empty/no-await input cannot satisfy the
  positive denominator. Preserve the existing one-await optimization checks.
- Shadowed/aliased/mutated `Promise.resolve` and cast thenables must not gain the
  new settled-owner proof. Compare main/repaired-B2 controls where practical;
  report any existing failure separately rather than changing a baseline.

One Luna Max worker owns only the relevant owner-proof/ABI/await-site functions
in `codegen/async-ir-planning.ts`, the source-proof helper in
`codegen/async-linear-planning.ts`, the exact proof fields in
`ir/async-from-ast.ts` and their prepared-await consumption in `ir/from-ast.ts`,
plus focused tests and this issue record. Existing declaration call sites,
selector, splitters, runtime providers and frame engine should consume the
shared proof without redesign. If needed, a narrow change to the R3-specific
functions `r3SuspendingAsyncSignatureMatchesAllocatedSlot` /
`selectR3PreparedSuspendingAsyncFunctions` requires the lead to confirm the
R2 worker's file ownership is clear. No changes to R2 sealing/publication,
P2A initializer transactions, R8, broad `codegen/index.ts`/`ir/integration.ts`
lifecycle, or the legacy activation engine are authorized by this slice.

Run `pnpm typecheck`; the new suites; both B2 suites; the adjacent
`tests/ir/issue-1373b-async-plan.test.ts`; the existing #4106 one-await,
#4104 runtime-consumer, #4124 final-async and #2906 multi-await suites; and
standalone/native-async controls as no-regression evidence. Run
`node --import tsx scripts/check-ir-only.ts --json` in both hybrid and IR-only
policies, `node --import tsx scripts/check-ir-fallbacks.ts`, plus the repository's
applicable async-equivalence, layering/dialect/format/size gates. Record exact
baseline/candidate denominators and existing reds; the earlier B2 checkpoint is
not a substitute for fresh validation. No new pass count is asserted here.

This removes C-1 only for owners carrying the new complete proof. Promise-valued
settled operands, no-await async functions, remaining containers/carriers and
caller-contract gaps remain explicit follow-ups. R7 and full #3518 retirement
acceptance remain open.
