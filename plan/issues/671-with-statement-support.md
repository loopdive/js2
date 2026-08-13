---
id: 671
title: "ES5 `with`: complete Object Environment Record semantics on the IR path"
status: in-progress
created: 2026-03-20
updated: 2026-08-13
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen, runtime
es_edition: 5
language_feature: with-statement
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/literals.ts::compileObjectLiteral
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/context/create-context.ts::createCodegenContext
goal: es5
sprint: current
test262_fail: 67
related: [1387, 2663, 3025, 4179, 4206, 4231, 4264, 1472]
---

# #671 — ES5 `with`: complete Object Environment Record semantics on the IR path

## Status

W1 is in progress. This is the live umbrella for finishing `with`; it
supersedes the original “~272 tests / compile-time `if`” stub and the stale
limitations in #1387 and #4206. It does **not** close until every direct
`WithStatement` row passes in both lanes and the unpartitioned ES5 goal reaches
9,029/9,029 in each lane.

This implementation plan was re-grounded by a Sol/max architecture pass on
`origin/main@c26670fdc0d567203d95b68553d9393279608a96`.

### W1 implementation evidence — 2026-08-13

W1 now has one IR-owned direct-`DeleteBinding` target plan, a
declaration-identity pre-claim, and one canonical open-object carrier. The
property selector is also declaration-keyed: all public direct member reads,
writes, and callable-member calls on the selected target consume the raw
open-object MOP value rather than the stale checker-derived field type. A
same-named binding in another scope remains on its existing representation.

The final measured manifest was the exact 21-file slice below, comparing a
fresh detached base at
`origin/main@8a2baecf3bc39d7ac5de16ea0c65361e3b73aca9` with candidate tree
`746fc27287e535cc4e39e8f03c3761639de8ed9a`. The compiler-bearing W1 commit is
`d664215b9256d77ba5772439a751c848c9ef8ccd`; every later W1 commit through the
measured candidate changes only this issue's evidence. This remeasurement
therefore includes both the merged #4447 class-expression ownership changes
and #4443 runtime-eval/compiler-IR changes in both arms instead of extrapolating
from either earlier main. Both arms used
`scripts/harness-flip-probe.ts`, demonstrated its mandatory must-pass and
must-fail controls, and produced all 21 rows with no entered or missing files.
The manifest SHA-256 is
`386db0dde30a647a81965c673ab4f635c70da74e39a49ce6c733499502e0c4be`; the
test262 corpus is `b363f29d3c43c626dc852744ad64a0b48a003693`.

| lane | base | head | gained | lost | net |
| --- | ---: | ---: | ---: | ---: | ---: |
| JS host | 21 fail | 6 pass / 15 fail | 6 | 0 | **+6** |
| standalone | 21 pass | 21 pass | 0 | 0 | **0** |

The host gains are `S12.10_A1.2_T{1,2,4}` and
`S12.10_A1.3_T{1,2,4}`. The focused regression test covers host and standalone
direct readback, post-`with` direct writes, function-valued member identity and
arguments, deferred module initialization, capture refusal, a `for-in`
consumer refusal, and one authentic gained host control.

The 15 unchanged host rows are intentionally not folded into W1's claim:

- twelve stop at assertion #18 (`value === undefined`, observed `null`), which
  is `var` / VariableEnvironment declaration routing rather than target
  representation and belongs to W4;
- `S12.10_A1.5_T{1,2,4}` remains at the old deleted-`p3` observation because
  its `for-in` target consumer fails W1's pre-allocation safety proof. W1 does
  not widen that consumer without an explicit open-object iteration contract.

The standalone pair has no transitions and remains 21/21 passing. Both arms
freshly built their compiler and runtime bundles, then compiled and
canary-verified a matching real-QuickJS adapter before the population ran:

| artifact | base | candidate |
| --- | --- | --- |
| compiler bundle SHA-256 | `c60f2481bbc8e454ea3c6f91c5c1ade1bc111c4d77f42b72e3d162a82ce66875` | `cb7a02b9e00e900e6c6d0a33047fc9857a202ba9f2067f59c3f713de51781720` |
| runtime bundle SHA-256 | `015635d37dcfb16467ff846857a1dab3589838d4232f9eb982d167add120d011` | `e1d1d8bac4917fd5e8584f4404145a48414bb58657ec3d861eda57620087ee2b` |
| QuickJS adapter key | `d9b6dcbecd8aab90` | `3f69394285448486` |

Both adapters have SHA-256
`ce3688616ca764f82990b4792bd7f10b46a7ed4eadc4d4745fc330c908391b08`;
their distinct keys prove each was selected against its arm's bundle. Both use
the immutable QuickJS artifact
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`.
Each runtime banner confirmed the corresponding key before the 21 rows ran.
An earlier candidate-only run that reported 21 failures was discarded because
its worktree lacked that provider. Provider availability must match across
both arms. W2/W4 retain the remaining environment and declaration work outside
this exact W1 family.

Root review caught and fixed one pre-publication carrier leak: the first W1
candidate also inserted the target's bare spelling into the legacy
`growableObjectLiteralVars` / `externrefAccessorVars` sets. A separate
same-named local passed to a concrete struct parameter then trapped instead of
returning `7`. W1 now uses its declaration key for the literal route as well as
member operations and does not populate those name-wide sets. The compiled
dual-lane regression returns `17` (the W1 mutation contributes `10`, the
unrelated closed struct contributes `7`).

## Test Results

- `pnpm exec vitest run tests/issue-671-with-w1.test.ts` — 14/14 passed.
- `pnpm run typecheck` — passed.
- `pnpm run check:issues` — passed.
- `pnpm run check:loc-budget` and `pnpm run check:func-budget` — passed with
  the W1 allowances above.
- `pnpm run check:ir-fallbacks` and `pnpm run check:ir-adoption` — passed.
- Exact same-current-main harness A/B controls passed in both lanes. Host was
  21 fail on base versus 6 pass / 15 fail on W1; standalone was 21 pass in both
  arms. Both partitions verified `21 == 21`, with no other status changes,
  entered rows, or missing rows.

## Exact current population

The population is the intersection of:

1. official test262 rows whose edition label is ES5 or earlier; and
2. files whose parsed source contains a real TypeScript `WithStatement` node.

That produces **201 exact rows per lane**, not the old 272/294 source-shape
estimates. On the pinned current artifacts:

| lane | pass | fail | compile error | timeout / skip | non-pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| JS host | 134 | 57 | 10 | 0 | **67** |
| standalone | 150 | 41 | 10 | 0 | **51** |

Cross-lane matrix: 113 both-pass, 37 host-nonpass/standalone-pass, 21
host-pass/standalone-nonpass, and 30 both-nonpass.

Provenance:

- compiler artifact source: `b9f6277e534340b20199fd3cb8acbb204f84071c`;
  this is an ancestor of the planning base, with no later `src/` or `test/`
  changes;
- test262 corpus: `b363f29d3c43c626dc852744ad64a0b48a003693`;
- baseline repository: `d3c4816e68282d2c3e0e3c95fc11551640ffbf43`;
- oracle: v13;
- host artifact: `.test262-cache/test262-current.jsonl`;
- standalone artifact: `.test262-cache/test262-standalone-current.jsonl`;
- edition denominator: **9,029 rows per lane**, including `eval`, the
  `Function` constructor, and `with`, as fixed in `plan/goals/es5.md`.

A textual `\bwith\s*\(` scan finds 220 rows, but 19 are comments, generated
strings, or eval-source shapes rather than a direct statement. Keep that
overlapping cohort for eval routing; do not use it as this feature's causal
denominator.

### Ranked measured slices

These are measured rows affected by a coherent mechanism, not promised
fail-to-pass conversions. Every slice must prove its own A/B result.

| rank | bounded mechanism | host rows | standalone rows | current evidence |
| ---: | --- | ---: | ---: | --- |
| 1 | runtime `DeleteBinding` over a closed-struct target splits the host sidecar from later direct field reads | **21 non-pass** | **21 pass controls** | all host rows end at `myObj.p3 === undefined`, actual `'c'` |
| 2 | constructible function-expression capture of the object environment | **10 compile errors** | **10 compile errors** | exact diagnostic: `constructible closure capture is not in the with-environment IR slice` |
| 3 | identifier scope-chain precedence | **5 non-pass** | **5 non-pass** | `language/identifier-resolution/S10.2.2_A1_T{5..9}.js` |
| 4 | remaining direct-With residue after 1–3 | remeasure | remeasure | signatures overlap unrelated value-carrier/global/call defects |

The 21-row first slice is exactly:

- `S12.10_A1.1_T{1,2}`;
- `S12.10_A1.2_T{1,2,4}`;
- `S12.10_A1.3_T{1,2,4}`;
- `S12.10_A1.4_T{1,2,4}`;
- `S12.10_A1.5_T{1,2,4}`;
- `S12.10_A1.6_T{1,2}`;
- `S12.10_A1.9_T{1,2}`; and
- `S12.10_A1.10_T{1,2,4}`

under `test/language/statements/with/`.

## ES5 semantic contract

Use the [ECMA-262 5.1 specification](https://262.ecma-international.org/5.1/),
not a later-edition `with` sketch.

### Entering and leaving `with`

[§12.10](https://262.ecma-international.org/5.1/#sec-12.10) requires:

1. evaluate the head expression once and apply `GetValue`;
2. apply `ToObject` once; `null` and `undefined` throw `TypeError`, while
   number/string/boolean primitives get wrapper objects;
3. create an Object Environment Record whose outer environment is the old
   `LexicalEnvironment` and whose `provideThis` flag is true;
4. evaluate the body; and
5. restore the old `LexicalEnvironment` on normal **and every abrupt**
   completion.

The compiler does not need a mutable process-global scope stack when it can
encode the environment chain structurally in IR. A closure that escapes must
capture the environment receiver/chain by reference; it must not snapshot
property values.

### LexicalEnvironment is not VariableEnvironment

The `with` statement changes **LexicalEnvironment only**. The execution
context's **VariableEnvironment never changes**. Consequently:

- `var` and hoisted function bindings are created in the surrounding
  VariableEnvironment; they are not members of the with-object merely because
  their declaration text appears in the body;
- evaluating a `var` initializer still performs ordinary identifier reference
  resolution through the current LexicalEnvironment. Therefore
  `with ({x: 1}) { var x = 2; }` writes the object property while the hoisted
  variable binding remains outside the object record; and
- function expressions created inside the body capture the current
  LexicalEnvironment, while a function created outside and merely called from
  inside does not acquire dynamic access to the with-object.

Do not retain #1387's blanket “body declaration blocks the object” or “var /
function declarations are architectural blockers” rules. Lexical declarations
shadow according to their own environment; VariableEnvironment declarations
need correct instantiation plus reference resolution, not a hard refusal.

### Object Environment Record operations

[§10.2.1.2](https://262.ecma-international.org/5.1/#sec-10.2.1.2) defines the
required operations:

- `HasBinding(N)` calls the binding object's `[[HasProperty]](N)`, including its
  prototype chain;
- `GetBindingValue(N, S)` performs `[[Get]]` after `HasProperty`;
- `SetMutableBinding(N, V, S)` performs `[[Put]]` with the caller's strictness;
- `DeleteBinding(N)` performs `[[Delete]](N, false)` and returns a Boolean; and
- `ImplicitThisValue()` returns the binding object because `provideThis` is
  true.

`Symbol.unscopables` is **not part of ES5**. Existing modern-language support
may preserve it behind an explicit later-edition policy, but it is not an ES5
`HasBinding` step and must not appear in ES5 proofs, diagnostics, or acceptance
criteria. Likewise, `hasOwnProperty` is wrong: inherited properties bind.

### References, not just values

Identifier resolution follows
[§10.2.2.1](https://262.ecma-international.org/5.1/#sec-10.2.2.1). The lowering
must preserve the selected **Reference** until the consuming operation:

- read: `GetValue` from the selected object or outer binding;
- simple assignment: resolve the LHS before evaluating the RHS, then store to
  that same selected base;
- compound assignment and prefix/postfix update: resolve once, get once,
  evaluate RHS/coercions, and put back to the same base; getters/proxies may
  mutate the property between steps;
- `delete name`: if the selected base is the Object Environment Record, call
  its `DeleteBinding`; if it is a declarative binding return false; if it is
  unresolvable return true in sloppy code;
- `typeof name`: an unresolvable reference yields `"undefined"`, but an object
  getter's abrupt completion must propagate; and
- bare `f()` call: when `f` resolved through the Object Environment Record,
  [§11.2.3](https://262.ecma-international.org/5.1/#sec-11.2.3) obtains
  `thisValue` from `ImplicitThisValue`, so the with-object is `this`.

Resolving a name separately for the read and the write, or compiling a bare
call as an ordinary closure call with `undefined`/global `this`, is unsound.

## Root causes on current main

### 1. Only a narrow static closure shape is actually on middle IR

`src/ir/select.ts:isPhase1WithStatement` (line ~3950) requires an inline object
literal, block body, and at least one ordinary synchronous function expression.
`src/ir/from-ast.ts:lowerWithStatement` (line ~8456) then installs one
`withField` binding per known field and emits `object.get`/`object.set`.

That slice has no runtime `HasBinding`, prototype lookup, delete, call-`this`,
or general reference model. Almost all currently passing `with` rows still use
the legacy `FunctionContext.withScopes` path. The completion criterion is not
“legacy handles it”; the semantic path must move into IR.

### 2. The 21-row host delete family is split representation, not a bad delete helper

`src/codegen/with-scope.ts:proveStructTypedWithTarget` (line ~330) deliberately
rejects a body containing `delete <Identifier>`. Those rows therefore use
`compileDynamicWithStatement` and `emitDynamicWithDelete` (line ~767):

```text
HasBinding(externref(myObj), "p3")
  ? __delete_property(externref(myObj), "p3")
  : delete the outer reference
```

In the host lane, `myObj` remains a fixed WasmGC struct. The runtime helper
correctly tombstones the externref/sidecar view, but the later statically typed
`myObj.p3` read is a direct `struct.get` and still sees `'c'`.

Standalone already passes all 21 counterparts because
`src/codegen/declarations/dynamic-with-shape.ts` and
`object-shape-widening.ts` pin this exact target shape to the canonical open
`$Object`. The file explicitly makes that decision standalone-only. Therefore:

- do **not** patch `__delete_property` globally;
- do **not** add a second tombstone engine; and
- make IR planning choose one MOP-capable object identity in both lanes before
  allocation whenever a `with` reference needs runtime HasBinding/DeleteBinding.

### 3. Constructible closures are refused before lowering

`src/ir/with-environment.ts:selectWithEnvironmentClosures` (line ~33) records
ordinary function-expression captures, then rejects `new <capturedFn>()` at
line ~96. Existing IR closure signatures contain only params/result, and
`closure.new` / `closure.call` have no `[[Construct]]` operation or constructible
brand. Legacy already has constructible wrapper and `__construct_closure`
machinery; IR must expose it without snapshotting the with-object.

## Implementation plan

### Slice W1 — IR-owned open-object plan for runtime DeleteBinding (21 host rows)

This is the first implementation handoff. Keep it bounded to the exact
bare-identifier-delete trigger and its representation consequences.

#### LOC budget allowance

`src/codegen/declarations/object-shape-widening.ts` receives a narrowly scoped
allowance for W1's declaration-identity, open-carrier, and
concrete-struct-consumer safety boundary. The matching keyed selector lives in
`property-access.ts`, with one small selection arm each in assignment and call
codegen plus its context registration. Those paths are required to consume the
same carrier for direct reads, writes, and callable members; they do not widen
unrelated objects or add a runtime store.

The corresponding function allowances cover only that atomic selection path:
planner result, declaration identity, consumer-ABI refusal, pre-allocation
carrier choice, and use-site MOP selection. Extracting only a helper would
separate those interdependent decisions without shrinking the proof surface;
broader shape analysis remains explicitly refused.

**File: `src/ir/with-environment.ts` (lines ~18–110)**

- Add a backend-neutral target-representation planner, for example:

  ```ts
  interface IrWithTargetPlan {
    readonly representation: "closed-fields" | "open-object";
    readonly reasons: readonly ("runtime-has-binding" | "runtime-delete-binding")[];
  }
  ```

- Move the function/class-boundary-safe scan for a direct
  `delete <Identifier>` into this IR subsystem. Parentheses are transparent;
  member deletes (`delete o.p`) are not this trigger; nested callable/class
  bodies belong to the environment they execute in and are not attributed to
  the outer statement.
- For W1, return `open-object` only for `with (<identifier>)` whose directly
  executing body contains that delete shape. Do not broaden to all `with`
  targets without a new census and A/B.
- Unit-test the planner with direct, parenthesized, nested-with, member-delete,
  and nested-function controls.

**File: `src/codegen/declarations/dynamic-with-shape.ts` (lines ~76–135)**

- Retire the standalone-specific semantic scan. Keep at most a thin adapter to
  the IR planner while callers migrate; there must be one decision engine.
- Rename documentation away from “standalone pinning”: this is a lane-neutral
  requirement for one object identity whenever runtime environment operations
  and ordinary property reads meet.

**File: `src/codegen/declarations/object-shape-widening.ts` (lines ~735–805)**

- Consult `IrWithTargetPlan` before object-literal representation allocation in
  **both** lanes.
- Put a W1 target into the existing open-object / hash-consumer set and record
  its checker type in the existing representation-refusal set, exactly as the
  current standalone arm does. This keeps declaration storage, aliases,
  with-environment operations, and later dot reads on one representation.
- Preserve the existing concrete-struct-consumer safety gate. If the target
  also flows to a genuinely struct-typed ABI position, refuse the W1 claim
  before allocation rather than inserting an unchecked cast or silently
  splitting identity.
- Do not special-case `p3`, the test names, or host mode.

**Files: `src/codegen/literals.ts` (function
`compileObjectLiteralAsExternref`, line ~383), `src/codegen/statements/variables.ts`,
and `src/codegen/declarations.ts` (function `moduleGlobalWasmType`, line ~1818)**

- Reuse the existing `__new_plain_object` + `__extern_set` builder and existing
  externref local/global typing. Add no new object store.
- Verify function-valued data properties in the measured object literal retain
  callable identity; W1 must not fix delete while breaking `valueOf`, `eval`,
  or the other properties in the same test files.

**Expected lowering shape**

```wasm
;; One canonical open object is allocated and stored in myObj.
global.get $__mod_myObj
global.set $__with_receiver

;; ES5 HasBinding; inherited properties count.
global.get $__with_receiver
<const "p3">
call $__extern_has
if (result i32)
  global.get $__with_receiver
  <const "p3">
  call $__delete_property
else
  ;; outer declarative/unresolvable DeleteBinding result
  i32.const 0
end

;; Later myObj.p3 reads the same open object/tombstone-aware MOP.
global.get $__mod_myObj
<const "p3">
call $__extern_get
```

The exact helper spelling may differ by lane, but both must implement the same
IR plan and operate on the same identity.

**W1 pre-claim refusals**

- target is not a single checker-resolved identifier;
- alias/escape analysis cannot prove every later consumer accepts the open
  representation;
- a concrete struct ABI consumer exists;
- object construction contains an unsupported property form; or
- the planner and allocator disagree about the exact declaration identity.

These are selector/planning refusals, not late `from-ast` throws and not
silent fallback after partially allocating a struct.

### Slice W2 — first-class dynamic environment/reference operations

W1 fixes identity coherence. W2 moves name resolution itself off
`FunctionContext.withScopes` and onto middle IR.

**File: `src/ir/nodes.ts` (dynamic nodes around lines ~1150–1202)**

- Add backend-neutral primitives beside `dyn.member_get` / `dyn.member_set`:
  - `dyn.member_has(recv, key) -> bool`, using `[[HasProperty]]`;
  - `dyn.member_delete(recv, key, strict) -> bool`;
  - make dynamic member set carry `strict`, or add an explicit sloppy variant;
    a `with` statement is forbidden in strict code, so its ES5 store uses
    `[[Put]](..., false)`;
  - `dyn.call_with_this(callee, thisValue, args) -> dynamic` (or an equivalent
    general call node) so a bare with-bound call preserves the object base.
- Do not encode “with” into the object MOP nodes. The with-specific part is
  reference selection; the property operations are reusable dynamic IR.
- Add every node to the instruction union, result-kind tables, operand-use
  collection, cloning/printing, and allocation-site classification where
  applicable.

**File: `src/ir/builder.ts` (dynamic builder methods around lines ~596–652)**

- Add typed constructors for the new nodes. Require canonical `dynamic`
  carriers (or an explicit object carrier accepted by the resolver), Boolean
  brand the has/delete results, and reject mismatched operands immediately.
- Preserve evaluation order in the builder API: receiver, key, then value/args.

**File: `src/ir/verify.ts` (dynamic verification around lines ~833–885)**

- Verify operand/result types, Boolean result branding, call arity, and that a
  reference selector result dominates every get/set/delete/call that consumes
  it.
- Verify a compound/update plan uses one selection result for both read and
  write; two independent HasBinding nodes are an invalid IR shape.

**File: `src/ir/effects.ts` (dynamic effects around lines ~174–180)**

- `has`, `get`, `set`, `delete`, and dynamic call may invoke proxy/accessor/user
  code and may throw. Mark them effectful; never DCE, duplicate, or reorder them
  across RHS evaluation.

**File: `src/ir/from-ast.ts` (`ScopeBinding` around line ~1905,
`lowerCall` ~5265, `lowerWithStatement` ~8456, and identifier assignment
~8707)**

- Replace “one `withField` per known property” as the general model with an
  ordered environment descriptor:

  ```ts
  interface IrWithEnvironmentBinding {
    readonly receiver: IrValueId;
    readonly outer: ScopeBinding | undefined;
    readonly mode: "closed" | "dynamic";
  }
  ```

- Add a reference-planning helper that resolves a bare identifier to an
  ordered list of with candidates plus its checker-resolved outer binding.
- For a dynamic chain, emit HasBinding **once, before the RHS or call args**,
  and materialize a selector SSA value (innermost match, otherwise outer).
  Nested HasBinding checks must short-circuit; do not eagerly probe outer
  objects after an inner match.
- Reads, writes, delete, typeof, calls, compound assignments, and updates must
  consume that saved selector. Use structured `IrInstrIf` arms to keep outer
  bindings in their existing typed representations; box only at the explicit
  dynamic boundary.
- Closed fields may fold HasBinding only when IR proves the complete own and
  prototype shape cannot change. Otherwise demote to the dynamic operations.
- Evaluate/ToObject the with head once. Keep its receiver live through the body
  and capture it in escaping closures.

**File: `src/ir/select.ts` (`isPhase1WithStatement`, line ~3950)**

- Select by supported reference operations, target carrier, and closure
  environment ABI—not by “must contain a closure”. Non-closure with bodies
  belong on IR too.
- Inspect every identifier use by operation kind. Claim only when every
  reachable reference consumer has a W2 lowering.
- Remove blanket refusals for `var` and function declarations. Coordinate
  declaration instantiation with VariableEnvironment; only unsupported
  reference/capture shapes are legitimate refusals.
- Strict-mode `with` must already be rejected by
  `src/compiler/early-errors/node-checks.ts` (line ~400). Hardened mode's
  deliberate all-`with` policy in `src/compiler/validation.ts` remains separate
  from language conformance.

**Files: `src/ir/lower.ts` (dynamic lowering around lines ~1965–2015),
`src/ir/backend/handles.ts` (`IrDynamicLowering`, line ~266), and
`src/ir/integration.ts` (`preregisterDynamicSupport`, lines ~5840–5893)**

- Extend `IrDynamicLowering` with has/delete/sloppy-set/explicit-this-call
  emitters.
- Pre-register every helper/import before Phase 3; resolve function indices by
  name at emission time. No mid-emission late-import shifts.
- Host and standalone must expose identical logical operations despite their
  different carriers (`externref` vs `$AnyValue`).

**Runtime contracts**

- Reuse `__extern_has`, `__extern_get`, `__extern_set`, and
  `__delete_property` as the semantic engines where their strictness matches.
- Add only thin carrier adapters such as `__dyn_member_has` or
  `__dyn_member_delete`; do not duplicate property descriptor, prototype,
  proxy, tombstone, or ToPropertyKey logic.
- Existing `__ir_dyn_method_call_0/1` is the pattern for preserving a receiver,
  but the IR contract must handle the arities selected by the source rather
  than silently dropping arguments.

### Slice W3 — constructible closure environment capture (10 + 10 CEs)

**File: `src/ir/with-environment.ts` (lines ~88–103)**

- Replace the constructible-closure refusal with a positive plan only after the
  IR closure ABI below exists. Keep generator/async/class-method refusals until
  their environment ABIs are independently supported.

**File: `src/ir/nodes.ts` (`IrClosureSignature` ~192 and closure nodes
~1389–1445)**

- Add constructibility to closure identity/allocation metadata; arrows remain
  non-constructible.
- Add `closure.construct` with explicit args and a dynamic/object result. It
  invokes the same lifted body and capture fields as `closure.call`, while
  supplying fresh `this`, prototype linkage, constructor return override, and
  instance→constructor identity.

**Files: `src/ir/builder.ts`, `src/ir/verify.ts`, `src/ir/lower.ts`, and
`src/ir/integration.ts`**

- Wire construction through the existing constructible wrapper family in
  `src/codegen/closures/funcref-wrapper-types.ts` (line ~150) and the existing
  native/host construction engines in `src/codegen/expressions/new-super.ts`.
- Capture the ordered with-environment receiver(s) in `closure.new`; lifted
  bodies rehydrate environment descriptors, not individual property values.
- Extend `lowerNewExpression` to resolve a closure-typed identifier before the
  local-class/extern-class arms.
- Verify ordinary calls still use the call ABI and `new` uses the construct ABI.

Exact acceptance files are `S12.10_A1.8_T{1..5}` and
`S12.10_A3.8_T{1..5}`.

### Slice W4 — declaration environments, direct eval, and remaining forms

- Model declaration instantiation explicitly enough that VariableEnvironment
  bindings remain outside the object environment while initializer references
  traverse it.
- Function declarations/Annex B declarations must follow their own hoisting
  plan; do not treat them like function expressions created at the statement
  position.
- Direct eval must receive the active ordered LexicalEnvironment descriptors;
  indirect eval and the Function constructor must not capture them.
- Add arrow, generator, async, method, and class capture only with their existing
  `this`/`super`/suspension semantics intact.
- Re-run the direct 201-row census after every landed slice, recluster the
  residue by first causal failure, and split unrelated global/value-carrier
  defects to their existing repo issues rather than claiming them here.

## Edge cases and required regression coverage

- `with (null)` and `with (undefined)` throw before the body; primitives other
  than null/undefined are object-coerced.
- target expression and every HasBinding probe execute once in source order.
- inherited properties bind; own-only probing is rejected.
- property added/deleted while the body runs changes later independent
  identifier resolution.
- nested with scopes choose the innermost current match and fall outward.
- lexical `let`/`const`/class/catch bindings shadow as specified; `var` storage
  remains in VariableEnvironment.
- abrupt `throw`, `return`, `break`, and `continue` do not leak an active
  environment into following code.
- closure created inside captures; closure created outside does not.
- bare call through object environment uses the object as `this`; outer-bound
  call uses its ordinary this rule.
- `delete`, `typeof`, simple assignment, compound assignment, and postfix /
  prefix update preserve one resolved reference.
- non-configurable delete returns false in sloppy code; strict `with` is an
  early SyntaxError.
- a successful delete is visible through dot/bracket read, `in`,
  `hasOwnProperty`, descriptor queries, and enumeration in both lanes.
- function-valued properties and accessors retain call identity and abrupt
  behavior when an open-object plan is selected.

## Measurement and acceptance

For every slice:

1. fetch exact current `origin/main` and run in an isolated worktree;
2. derive the ES5-or-earlier direct-With population from parsed AST plus the
   edition index—never error-string grep alone;
3. record compiler SHA, corpus SHA, baseline SHA, oracle version, lane, and
   exact file manifest;
4. run base/head over the **same population in both lanes**;
5. require zero pass→nonpass changes in the 201-row direct-With control and in
   the full 9,029-row lane denominator;
6. separately report compile-error removals, fail→pass conversions, and
   changed-but-still-failing signatures; and
7. run unit/integration tests for IR construction, verification, lowering,
   strict early errors, nested/abrupt scope behavior, and object-store parity.

Final acceptance:

- [ ] 201/201 direct-With rows pass in the JS-host lane.
- [ ] 201/201 direct-With rows pass in standalone.
- [ ] no `#1387` hard refusal remains for a valid ES5 with shape.
- [ ] IR shape diagnostics show the supported bodies on middle IR; legacy
      fallback is not counted as completion.
- [ ] full ES5-or-earlier results are 9,029 pass, zero fail/CE/timeout/skip in
      each lane, including overlapping eval/Function/with rows.

## Risks and active overlap

- [PR #4437](https://github.com/loopdive/js2wasm/pull/4437) also edits
  `src/ir/from-ast.ts`, `src/ir/select.ts`, `src/ir/integration.ts`, and IR
  legality around dynamic equality.
- [PR #4438](https://github.com/loopdive/js2wasm/pull/4438) also edits
  `src/ir/nodes.ts`, `src/ir/integration.ts`, legality, and class/codegen files.

Rebase after those heads move or merge, then re-ground line numbers and dynamic
carrier APIs before W2/W3. The semantic topics do not overlap, but the IR hot
files will conflict mechanically. W1 is intentionally centered in
`ir/with-environment.ts` and representation planning so it can land with less
collision risk.

Do not revive a second legacy-only implementation while resolving conflicts.
`FunctionContext.withScopes` remains a compatibility adapter until its last
consumer migrates, then should be deleted.
