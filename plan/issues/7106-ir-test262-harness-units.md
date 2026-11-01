---
id: 7106
title: "IR: ship the six test262 harness units (assert.js + sta.js) so a fallback-free pass is possible"
status: in-progress
sprint: current
created: 2026-10-20
updated: 2026-11-01
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 6920
assignee: "ttraenkler/claude-c"
# 2026-10-20 (S1, dyn.to_string): one new IR instruction threaded through its
# node, verifier, builder, lowering (both dynamic strategies), pre-registration
# and the from-ast/selector arms that use it — the same shape as #7104's
# dyn.typeof; each growth is that one arm.
# 2026-10-20 (S1b): `dyn.json_stringify` pre-registers the native JSON codec
# from the bridge (`src/ir/integration.ts` → `codegen/json-codec-native.ts`),
# the same shape as the object-runtime and any-helpers edges already there;
# one more two-way ir→codegen edge, no new SCC member.
# 2026-10-21 (S3a): `dyn.construct` pre-registers the per-arity construct
# wrapper (`src/ir/integration.ts` → `codegen/ir-dynamic-construct.ts`) and the
# selector option reads legacy's callee predicates from the same module, which
# joins the SCC (it imports the construct-driver modules).
# 2026-10-21 (S3c, self-guarded Test262Error): two dialect kinds
# (`dyn.current_this`, `dyn.instanceof_fn`) and a `sloppy` bit on
# `dyn.member_set`, threaded through the same files as S1e; the legacy seam is
# one predicate each in `compileNewExpression` (route `new F` to the native
# construct driver) and `analyzeFnctorEscapeGate` (refuse the fnctor struct);
# `dyn-read.ts` gains the sloppy twin of `__dyn_member_set` beside its strict
# sibling. No new import edge: the wrappers live in ir-dynamic-construct.ts.
# 2026-10-22 (compareArray.format): `Array.prototype.<m>.call(recv, …)` lowers
# as one call to the `__ir_arr_borrow_<m>_<n>` wrapper; integration.ts
# pre-registers it from `codegen/array/ir-array-prototype-borrow.ts` (one more
# two-way ir→codegen edge, that module joins the SCC — it imports legacy's
# borrow compiler and the shared template-wrapper pieces).
flat-dir-budget-allow:
  - src/codegen/ir-string-carrier.ts # 2026-10-21 (#7106 S1c): the dyn.string_carrier wrapper beside ir-dynamic-construct.ts
  - src/codegen/ir-arguments-length.ts # 2026-10-21 (#7106 S1e): the dyn.arguments_length wrapper beside its two siblings
  - src/codegen/function-member-closure-planning.ts # 2026-10-21 (#7106 Stage 2, #6816 successor): the bounded function-member closure planner beside ir-prepared-free-functions.ts
  - src/codegen/ir-dynamic-construct.ts # 2026-10-21 (#7106 S3a): the dyn.construct wrapper beside its peers (object-proto-tostring.ts, native-construct.ts); the construct-driver split owns its future home
  - src/codegen/ir-dynamic-delete.ts # 2026-10-22 (#7106 propertyHelper arm 3): the dynamic delete wrapper beside ir-dynamic-construct.ts
  - src/codegen/ir-dynamic-instanceof.ts # 2026-10-22 (#7106 dyn.instanceof): the generic dynamic instanceof wrapper beside ir-dynamic-delete.ts
import-cycles-allow:
  - ir->codegen: 84 # 2026-10-29 (merge-group fix, restated on main's 83 after #6977/#6979 + this borrow wrapper); 2026-10-29 (revive, restated on main's 81 + #7119's wrapper module + this borrow wrapper); 2026-10-21 (#7106 S3a/S1c/S1e): integration.ts pre-registers the dynamic-construct, string-carrier and arguments-length wrappers; 2026-10-22 (module-init lever A): the bridge reads legacy's Math/Number constant table (`codegen/builtin-value-read.ts`); 2026-10-22 (lever B): …and pre-registers the Number(v) provider (`codegen/helpers/ir-number-from-value.ts`); 2026-10-22 (compareArray.format): …and the Array.prototype borrow wrapper
  - codegen->ir: 301 # 2026-10-22 (#7106 lever B): the Number(v) provider names its symbol from the IR runtime contract (`ir/runtime/number-conversion-callable.ts`), where the provider definition lives
  - ir->frontend: 8 # 2026-10-22 (#7106 lever B): the bridge builds the source-bound Number-conversion plan (`frontend/builtins/prepare-number-conversion.ts`) for the selector, as program-source.ts does for its resolver
  - ir->runtime: 10 # 2026-10-29 (#7106 function-object realm members): `ir/select-expression-structure.ts` reads %Function.prototype%'s and %Object.prototype%'s keys from the native realm catalog (`runtime/contracts/native-realm-catalog.ts`, pure data), as `ir/program/native-realm-requirements.ts` already does; a hand copy of those 19 names would duplicate the catalog
  - largestSccSize: 728 # 2026-10-21 (#7106 S3a/S1c/S1e): codegen/ir-dynamic-construct.ts, ir-string-carrier.ts and ir-arguments-length.ts join the SCC; 2026-10-22 (GDI prologue): codegen/declarations/module-init-prologue.ts, split out of declarations.ts (already in the SCC), joins it; 2026-10-22 (propertyHelper arm 3): codegen/ir-dynamic-delete.ts (reached from the codegen/index.ts facade) joins it; 2026-10-22 (dyn.instanceof): codegen/ir-dynamic-instanceof.ts joins it the same way; 2026-10-22 (lever B): codegen/helpers/ir-number-from-value.ts joins it; 2026-10-22 (compareArray.format): codegen/array/ir-array-prototype-borrow.ts joins it
# 2026-10-24 (dyn.instanceof Error intrinsic, #6858 quality fix): ambient-intrinsics.ts moved from src/ir/values/ to src/shared/ — it imports only `typescript`, and codegen/ir-dynamic-instanceof.ts now reads it too; keeping it under src/ir/ would have grown the codegen->ir two-way edge count (300 → 301).
# 2026-10-22 (propertyHelper arm 3): makeFromAstResolver gains the
# dynamicDeleteSymbol method; isPhase1StatementListInScope gains the dropped
# dynamic-delete statement arm.
# 2026-10-22 (S3c merge-queue fix): both escape-gate call sites pass the
# self-guarded refusal predicate (`selfGuardedConstructorsLeaveFnctor`), so S3c
# stands down when runtime eval may share the realm.
func-budget-allow:
  # 2026-10-22 (module-init lever A): one resolver entry for the namespace-constant fold
  # 2026-10-22 (propertyHelper arm 3): the dynamicDeleteSymbol method
  - src/ir/integration.ts::makeFromAstResolver
  # 2026-10-22 (lever B): one intrinsic→provider branch
  - src/ir/integration.ts::resolveAndObserveCallableProvider
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/from-ast.ts::lowerPropertyAccess
  - src/ir/select.ts::scanExprInner
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/from-ast.ts::lowerExprUnchecked
  - src/ir/from-ast.ts::lowerCall
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerConditional
  - src/ir/from-ast.ts::lowerTypeOf
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExpr
  # 2026-10-31 (boolean statics, round 4): the 3-line adapter call beside the Math arms (+3)
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::collectCallGraph
  - src/ir/select.ts::whyNotIrClaimable
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/fnctor-escape-gate.ts::analyzeFnctorEscapeGate
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
loc-budget-allow:
  # 2026-10-22 (module-init lever A): the table accessor beside legacy's fold
  - src/codegen/builtin-value-read.ts
  # 2026-10-22 (lever B): one provider-id set spread in the manifest registry
  - src/ir/runtime/manifest.ts
  # 2026-10-29 (#6972 merge-queue root cause C): `activeBufferBranched`, the
  # buffer-end query the shared body-statement lister stops on (from-ast.ts
  # nets -1: two inline guards folded into it)
  - src/ir/builder.ts
  - src/ir/core/nodes.ts
  - src/ir/core/dialect/js.ts
  # 2026-10-31 (boolean statics, round 4): the static-predicate arm, its host, the shared ambient-receiver helper and the name-parameterised unshadowed-global test (+25); the lowering lives in src/ir/static-predicates/
  # 2026-11-01 (#7106 S5): the module-init `var` leaf binder and the slot write shared with the identifier arm, `storeModuleBinding` (+53); the list predicate, leaf walker and binding ordinals live in src/ir/module-init-vars.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/runtime/verify.ts
  # 2026-10-31 (boolean statics, round 5): the selection adapter, the IR-representation family proof and the argument / declared-type slot families it needs from select.ts's private resolvers, mapped by one resolvedKindFamily (+89); the rule lives in src/ir/static-predicates/
  # 2026-11-01 (#7106 S5): `moduleVarLeavesStorable`, the per-leaf slot fit of a module-init `var` pattern (+35)
  - src/ir/select.ts
  - src/ir/backend/handles.ts
  - src/ir/backend/legality.ts
  - src/ir/ambient-typeof.ts
  - src/ir/prepared-component-dependencies.ts
  # 2026-11-01 (#7106 S5): `scriptVarHome` takes a leaf too, one type import (+1)
  - src/codegen/index.ts
  - src/ir/propagate.ts
  - src/codegen/dyn-read.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/expressions/new-super.ts
---

## Problem

The fallback-free test262 metric (#6806, `ir_only_pass`) counts a pass only
when the compile emitted **zero** legacy bodies. Every test262 test links
`assert.js` + `sta.js`, and on the stacked state of #6806 + #6807 + #6809
(standalone, 2026-10-20 21:13Z) **every** test still carries exactly the same
six legacy units:

| unit | file | reject | what it needs |
|---|---|---|---|
| `assert` | assert.js | `expr-ident-not-in-scope` on `assert` | the function read **as a value** (`assert._toString(...)`, `assert.sameValue = …`) — a function object |
| `compareArray` | compareArray.js (included by most) | same, on `assert` | same |
| `formatIdentityFreeValue` | assert.js | `expr-ident-not-in-scope` on `JSON` | `typeof JSON !== "undefined"`, `JSON.stringify(v)`, `String(v)`, `isNegativeZero(v)` |
| `formatSimpleValue` | assert.js | `expr-ident-not-in-scope` on `Object` | `Object.prototype.toString.call(v)`, `String(v)`, `try/catch` with `err.name === 'TypeError'` |
| `Test262Error` | sta.js | `return-type-not-resolvable` | a **constructor function** (`this instanceof F`, `this.message = …`, `return new F(m)`, `F.prototype.toString = …`, `F.thrower = …`) |
| `<module-init>` | (test) | `body-shape-rejected` | script top-level: `assert.sameValue(...)` calls, `var` initialisers, `Test262Error` prototype/static writes |

Until all six ship IR bodies the metric is 0 by construction, whatever the
test's own code does (addition slice: 45/48 pass, 3 of 9 units IR, 0
fallback-free). Items 2–5 of the #6583 plan are these six units.

## Measured legacy facts (standalone, probes 2026-10-20)

- `assert` as a value: legacy builds a **lazy `$FnObject` global** on first
  use (`global.get N; ref.is_null; if … struct.new $FnObject(ref.func, arity,
  …); global.set N`) plus a property table for `assert.sameValue` etc.; a
  call `assert.sameValue(a, b)` becomes `__extern_method_call(fnObject,
  __new_String("sameValue"), argv)`.
- `Test262Error`: legacy lowers it as a **fnctor** — `$Test262Error (param
  externref) (result (ref null $Inst))` reads `__current_this`, `ref.test
  (ref $Inst)` for `this instanceof Test262Error`, and the caller's `new
  Test262Error(m)` materialises the fnctor's `$FnObject` lazily and calls the
  ctor value. The IR has only planning seams: `IrFnctorAdmission` is pinned to
  the single Acorn shape `fields: [{ input: string }]` (`src/ir/propagate.ts`),
  `phase1FnctorNewExpression` admits exactly that, `src/ir/core/fnctor-abi.ts`
  carries `IrFnctorShape`/`IrFnctorResolution`, and `new F()` on any other
  user function is `constructor-resolution-unsupported` (`expr-new-ctor-unknown`).
- `String(v)`, `JSON.stringify(v)`, `typeof`, `Object.prototype.toString.call(v)`
  are **already host-free** on standalone: legacy calls `__any_to_string`,
  `__json_stringify_root`, `__any_typeof`, `__extern_toString`,
  `__wrap_ctor_String`, `__builtin_static_JSON_parse`… (no imports in the
  compiled assert.js). The IR needs a way to *name* those helpers, not new
  runtime.

## Implementation Plan

Order is by payoff per unit of work; each stage is its own PR, held and
released in order, each measured with `TEST262_PATH_FILTER=language/expressions/addition/`
(48 tests, `ir_only_pass` is the acceptance number).

### Stage 1 — builtin-global reads and calls (items 2; `formatIdentityFreeValue`, `formatSimpleValue`)

1. `src/ir/select.ts` identifier arm (`expr-ident-not-in-scope`): admit an
   unshadowed ambient `JSON` / `Object` / `String` **only** as the receiver of
   the call shapes below (never as a bare value). Reuse the
   `namesHostFreeConsoleSurface` pattern (#4462) — a per-name predicate over
   the parent node.
2. `src/ir/from-ast.ts`: lower `String(v)` → `dyn.to_string` (new dialect
   kind, lowered to `__any_to_string`); `JSON.stringify(v)` (one argument) →
   intrinsic call `json.stringify` → `__json_stringify_root`;
   `Object.prototype.toString.call(v)` → intrinsic `object.to_string_tag` →
   `__extern_toString`; `typeof JSON !== "undefined"` → constant `true`
   (the global exists on every lane; fold at selection like the
   `Infinity`/`NaN` arm of #7104).
3. `switch (typeof v)` with string cases: already Phase-1 shapes
   (`isPhase1SwitchStatement`) once `typeof` is `dyn.typeof` (#7104) — verify
   on the probe, no new work expected.
4. `try { … } catch (err) { if (err.name === 'TypeError') … throw err; }`:
   `isPhase1TryStatement` + `dyn.member_get` on the catch binding; expected to
   pass once `err` is a dynamic binding — verify.
5. Register every new kind in `scripts/check-ir-kind-neutrality.mjs`
   (verdict `js`) and `scripts/lib/check-canonical-ir-dialect.mjs`
   (count + tests `tests/issue-3518-core-nodes-dialect.test.ts`) — #6807 hit
   both gates.

Acceptance: `formatIdentityFreeValue` and `formatSimpleValue` are
IR-emitted in the addition slice (currently 48/48 legacy each).

### Stage 2 — function objects (item 4; `assert`, `compareArray`, `<module-init>` calls)

**Composition note (C, 2026-10-21 07:50Z, #6816 successor):** a top-level
function that is BOTH a function-object subject (`subject.equal = …`) AND
IR-claimed with an implicit-support kind the prepared path has no symbolic
ref for (`dyn.arguments_length`, measured; `dyn.construct` /
`dyn.string_carrier` are the same class) fails hard at
`program-abi-source-callable-planning` (`duplicate-slot-locator: retained
source callable … is not the exact allocator owned by …`) instead of
declining. #6816's "unprepared physical function target" test used
`arguments.length` as its unprepared shape and now reads `arguments[0]`;
the planner case itself is open for Stage 2's owner: either declare prepared
support for the three #7106 wrappers in `prepared-dynamic-support.ts` or
decline the function-object preparation when the subject's component has
incomplete dependencies. No harness unit hits it today (`assert` /
`compareArray` are not IR-claimed).

1. New dialect kind `fn.object{funcRef}` — "the function object for this
   declared function", lowered to legacy's lazy `$FnObject` global (reuse the
   allocator: `ensureFnObjectGlobal`-style helper extracted from the legacy
   materialisation site so both frontends share ONE global per function).
2. `assert.sameValue(a, b)` where `assert` is a top-level function:
   `dyn.member_call(fn.object(assert), "sameValue", args)` → the same
   `__extern_method_call` legacy emits. Property writes
   `assert.sameValue = function (…) {…}` at top level are `<module-init>`
   work: `dyn.member_set(fn.object(assert), "sameValue", closure)`.
3. `assert._toString(x)` inside `assert` is the same read.
4. Selector: an identifier naming a top-level `function` declaration is
   admitted as a VALUE when the enclosing expression is a member call or a
   member write on it (not when passed as an argument — that stays item 4b,
   callback bridging).

Acceptance: `assert`, `compareArray`, `assert._isSameValue`,
`assert.sameValue`, `assert.throws` IR-emitted; `<module-init>` of a test
that only calls `assert.sameValue` IR-emitted.

### Stage 3 — constructor functions (item 3; `Test262Error`)

**Re-planned 2026-10-20 23:50Z after measuring the #3521 fnctor seam
(C).** The original plan ("generalise `IrFnctorAdmission.shape`") cannot
reach a fallback-free pass: on standalone `requireExactStandaloneParserLayout`
(`src/codegen/program-abi-fnctor-planning.ts`) pins the observation to the
exact `input/$constructor/$__fnctorProto/$bag` layout and to
`supportsConstruction === false` ("nullable/get-only"), and the whole seam
observes a constructor **after legacy built it** — `fnctor.new` lowers to a
call of legacy's `__fnctor_<F>_new`. The constructor body is legacy by
construction, so the unit always counts as `ir_legacy_units`. Widening that
contract is a #3521-owner change and still leaves the body legacy.

What legacy actually emits on standalone for the harness shape (measured,
`function E(m) { this.message = m || ""; }` + `new E(...)`):

| site | legacy lowering |
|---|---|
| `new K(args)` with a dynamic callee value | callee → externref, proto = `ref.null.extern` (driver falls back to `__extern_get(callee, "prototype")`), args → externref, `call __native_construct_<N>` (`reserveNativeConstructDriver`, N ≤ 8; a `$__ta_ctor` arm is added when `ctx.moduleUsesDynTaView`) — `tryCompileNativeConstructFromValue`, `src/codegen/expressions/new-super.ts` |
| `this` inside a function reachable as a value | `global.get $__current_this` (`ensureCurrentThisGlobal`), null → globalThis |
| `m \|\| ""` on externref | truthiness test + select, result externref |
| `this.message = v` | dynamic member set |
| `E` itself as a value (`throw new Test262Error`, `E.prototype.toString = …`) | the canonical function object (Stage 2 `fn.object`) |

So Stage 3 decomposes into IR arms that compose with Stages 1/2 and A's
item 1, none of which touches the #3521 seam:

1. **S3a `dyn.construct`** (C, this worktree): `new <dynamic callee>(args)`
   with every argument dynamic, arity ≤ 8. Host-strategy lowering = exactly
   the legacy sequence above, calling the same `__native_construct_<N>`
   driver through a thin `ensureIrDynamicConstructHelper(ctx, N)` wrapper so
   the `$__ta_ctor` arm stays legacy-built; pre-registered in
   `preregisterDynamicSupport`. Backend capability
   `native-dynamic-construct` (standalone|wasi). The selector admits only a
   callee that is a dynamic scope name (parameter / dynamic local); the
   legacy special arms (`%Function%` intrinsic, Proxy value, bound value,
   runtime-eval callable result, `funcConstructorForCallee`) are refused
   through one selection-option predicate so legacy keeps those sites.
2. **S3b dynamic `||` / `&&` value** (C): `dyn.truthy` + conditional with a
   dynamic result (the `logical-value-unsupported` bucket, 6,530 tests on
   main).
3. **S3c `this` as a dynamic value** (C, after S3a): a function whose `this`
   is used dynamically reads `$__current_this` at entry (null → globalThis
   on the sloppy harness) — one `dyn.this` kind; `this.message = v` is then
   A's `dyn.member_set` on an externref receiver (item 1), and `this
   instanceof E` is Stage 2's function-object identity.
4. **Composition** (after Stage 2 lands): `throw new Test262Error(m)` =
   `dyn.construct` with the `fn.object` callee; `Test262Error.prototype
   .toString = function () {…}` = Stage 2 `dyn.member_set` on the function
   object's `.prototype`.

**S3c measured 2026-10-21 00:45Z (C), before implementation.** Legacy does
NOT compile the harness's `Test262Error` as a `this`-reading function: the
fnctor escape gate (`analyzeFnctorEscapeGate`, `codegen/index.ts` ~5475,
before IR planning at ~6046) approves it, so its body IS the allocator —
`(func $Test262Error (param externref) (result (ref null 17))`, `this` is the
reserved `__fnctor_Test262Error` struct and every `new Test262Error(…)` is a
`struct.new`. `__current_this` is read only by lifted closure bodies
(`fctx.readsCurrentThis`, `expressions/this-keyword.ts`); a direct-call-only
named function reads `emitUnboundThis` (undefined / global object) without
touching the global. Consequences:

- A `dyn.this` unit for `Test262Error` cannot match legacy's registered ABI
  (`abi-signature-parity` would withdraw it). The IR body for a constructor
  the gate approves needs the reserved-struct ABI — the #3521 seam's
  standalone construction pin, a #3521-owner change, not a #7106 stage.
- The bounded alternative: an IR claim of a constructor function on the
  host-free lane makes legacy REFUSE the fnctor for that name
  (`fnctorEscapeGate.approvedNames` / `refusedNames`, mutated after IR
  planning and before declaration emission — ordering and the struct
  reservation consumers between ~5475 and ~6046 still to be verified), so
  legacy routes `new Test262Error(…)` through the dynamic construct driver
  (= S3a's lowering) and the body through the lifted-closure `this` read.
  Then S3c = `dyn.this` whose lowering is legacy's `this-keyword.ts` ladder
  (`global.get __current_this`; null → `emitUnboundThis`, non-null →
  `buildCurrentThisNonNullArm`) behind a wrapper like `__ir_dyn_construct_N`,
  admitted only for functions legacy lifts (value uses exist, so
  `readsCurrentThis` holds). Standalone bytes move for every test (the
  harness constructor changes lowering); host-assisted gc must not.
  **Measured 00:55Z:** legacy consumes the gate BEFORE IR planning
  (`fnctorReceivers` ~5502, `reserveFnctorStructTypes` ~5633, the #2773
  keystone), so the refusal cannot be a post-planning mutation of
  `approvedNames`; it has to be a predicate handed to
  `analyzeFnctorEscapeGate` — i.e. a pre-gate decision of which constructors
  the IR will own, which changes legacy's lowering of those constructors in
  every host-free program. That is a project-lead call, not a slice.
  **Measured 02:40Z (temporary, uncommitted env refusal in
  `analyzeFnctorEscapeGate`):** refusing `Test262Error` in the escape gate
  alone changes NOTHING in legacy's lowering — `__fnctor_Test262Error` is
  still reserved and `assert`'s `throw new Test262Error(m)` still lowers to
  `struct.new` (`call; struct.new 82; struct.new 99; call`), because the
  keep-typed path (`fnctor-ctor-decl.ts` `funcConstructorForCallee` /
  `fnctor-typed-instances.ts`) keys on the declaration, not on the gate's
  approval. All 78 `test/harness/*` self-tests behave identically with and
  without the refusal (77 pass, `assert-throws-same-realm.js` fails on both).
  Route 2 therefore has to switch BOTH mechanisms off for an IR-owned
  constructor; the gate predicate is necessary but not sufficient.
- Either way the constructor body also needs A's `dyn.member_set` on an
  externref receiver (`this.message = …`) and Stage 2's function-object
  identity for `this instanceof Test262Error`.

Acceptance unchanged: `Test262Error` and `$DONOTEVALUATE` IR-emitted; first
**non-zero `ir_only_pass`** on the addition slice (needs 1–4, Stage 2 and
item 1 together).

### S3c slice — 2026-10-21 (D, acting as C's lead; measured)

**Lead decision (route 2):** on the host-free lanes a top-level function of
the exact self-guarded shape `function F(…) { if (!(this instanceof F))
return new F(…); … }` (`isSelfGuardedConstructor`,
`src/codegen/helpers/self-guarded-constructor.ts`) is kept out of the fnctor
machinery by BOTH mechanisms the 02:40Z measurement named: the escape gate
refuses it (`analyzeFnctorEscapeGate`) and `compileNewExpression` sends its
`new F(…)` sites to the native construct driver (`tryCompileNativeConstructFromValue`
with the ordinary-function flag), so no `__fnctor_F` struct or `__fnctor_F_new`
ever exists and F's registered signature is plain externref. The shape occurs
once in the corpus (`test262/harness/sta.js`; zero hits in `benchmarks/`,
the playground examples and `tests/equivalence/`), so no Octane fnctor
changes lowering. Since #6708 S6 the default gc lane runs the same native
regime, so both CI lanes move.

IR arms (all behind capability `native-current-this`, non-fast,
standalone|wasi, and codegen's `functionThisStrictness` /
`selfGuardedConstructorValue` selection callbacks):

- `dyn.current_this{strict}` — legacy's `__current_this` ladder
  (`compileThisKeyword`'s `readsCurrentThis` rung, which `function-body.ts`
  sets for every declaration that references its own `this`), wrapped as
  `__ir_current_this_{sloppy,strict}`; read once at entry (OrdinaryCallBindThis).
- `dyn.instanceof_fn{value, target}` — `tryEmitNativeUserCtorInstanceOf`'s
  chain walk `__isPrototypeOf(F.prototype, value)` against the same
  per-function prototype global, wrapped as `__ir_instanceof_fn_<F>`.
- `new F(…)` → `dyn.construct` with F's function-object value (the planner's
  existing `topLevelFunctionValues` plan, now also emitted for the `new`
  callee and the `instanceof` operand of a self-guarded constructor).
- `this.name = v` → `dyn.member_set` with a new `sloppy` bit: sloppy code
  ignores a failed `[[Set]]` through legacy's `__extern_set`
  (`__dyn_member_set_sloppy`), strict throws as before.
- A dynamic-return function may fall out of a trailing expression statement
  into its implicit `return undefined` (checked/lowered as a mid-body
  statement plus a bare `return;`).

Measured (standalone, real harness, `language/expressions/addition/S11.6.1_A2.1_T1.js`):
legacy units 4 → 3 — `Test262Error` ships an IR body; `assert` now passes
selection and withdraws post-claim at `assert._toString(mustBeTrue)` ("function
member operand has no canonical carrier" — the #6823 evidence class);
`compareArray` and `<module-init>` unchanged. Probe program (sloppy and
strict): every check of `new F`, plain-call `F(…)`, `instanceof`, `String(e)`,
`e.constructor`, numeric/absent messages answers the spec value (511/511).
A non-writable `F.prototype.message` now answers per spec (sloppy keeps the
prototype value, strict throws TypeError); legacy's struct ignored the
prototype and answered neither.

### Stage 4 — script top-level residue (item 5; `<module-init>`)

**Pre-measured 2026-10-21 11:45Z (C, `language/expressions/addition`, 48
script tests, sta+assert+compareArray+propertyHelper prefix, standalone):**
`<module-init>` emits for 0/48. First blocker on all 48:
`expr-ident-not-in-scope «Test262Error»` — sta.js's own
`Test262Error.prototype.toString = …` / `Test262Error.thrower = …` (Stage 3c:
the constructor is not an IR unit, so its function object has no value).
With those two statements masked, 47/48 stop at `closure-return-type` on
`assert.sameValue = function (actual, expected, message) {…}` — a
function-object member WRITE whose untyped function-expression RHS has no
resolvable return type (the same type-evidence gap as the member-call
planner, see S1h); the remaining 1 at `expr-ident-not-in-scope «assert»`.
So Stage 4's first two items are Stage 3c and the Stage 2 member-write
evidence rule, before any of the expected `var`-initialiser residue is even
reachable.

Whatever `<module-init>` still rejects after Stages 1–3 (probe with
`JS2WASM_IR_SHAPE_DIAG=1` on the slice); expected: `var` initialisers with
object literals (`var obj = {5: kValue, length: 100}`), `Math.length = 1`
style builtin writes, and non-scalar script `var`s (extend
`scriptVarSlotIsSoleHome` from #7105 to `externref` slots on the
compatibility lane, where legacy's widened carrier equals the IR dynamic
carrier).

## Harness census — 2026-10-21 02:05Z (C, `sta+assert+compareArray+propertyHelper+deepEqual`, standalone, #6815 head)

| outcome | units |
|---|---|
| IR body | `$DONOTEVALUATE`, `isNegativeZero`, `isPrimitive`, `formatIdentityFreeValue`, `isSameValue` |
| `body-shape-rejected [expr-ident-not-in-scope]` (function objects: `assert.x = …`, `Test262Error` as a value) | `assert`, `compareArray`, `verifyPrimordialCallableProperty`, `verifyPrimordialAccessorProperty`, `<module-init>` — **Stage 2 (Shepherd)** |
| `constructor-resolution-unsupported` (`new Test262Error(…)` on the module binding) | `verifyEqualTo`, `verifyWritable`, `verifyEnumerable`, `verifyNotEnumerable`, `verifyConfigurable`, `verifyNotConfigurable` — **Stage 2 `fn.object` + S3a `dyn.construct`** |
| `param-type-not-resolvable` (dynamic member read / `err.name`) | `formatSimpleValue`, `verifyProperty`, `verifyCallableProperty`, `verifyAccessorProperty` — **A, item 1** |
| `return-type-not-resolvable` (fnctor ABI) | `Test262Error` — **S3c decision** |
| one-off propertyHelper arms | `isConfigurable` (`delete obj[name];` + `e instanceof TypeError`), `isEnumerable` (`for (x in obj)` value head), `isWritable` (module-alias ternary), `verifyNotWritable` (call arity) — each also needs Stage 2 + S3a for its `throw new Test262Error` |

Every remaining unit is gated on Stage 2, item 1 or the S3c decision; no further
C-only slice moves the fallback-free count until those land.

**`formatSimpleValue`, measured 03:10Z:** its own blocker is NOT the member
read (`err.name === 'TypeError'` already lowers through `dyn.member_get` on a
caught binding) but `return basic` — legacy registers the function as
`(result (ref null 6))` (string) and coerces the dynamic `basic` through
`__wrapper_string_value` + cast, while the IR has no dynamic→string return
coercion. The lattice half is fixed here (a fall-out callee now propagates
the dynamic carrier, so `basic` reads the same way in the lattice and the
selector); the coercion arm is a new IR lowering (`dyn.to_string_carrier`
or a `coerce` form over the same legacy engine) and is the next S1c step.

### Item 1, S1d slice — 2026-10-21 03:30Z (C, measured; shipped on #6815)

The three `verify*` units were NOT blocked on the member read at all but on
**JSDoc**: `@param {object} obj`, `{string|symbol} name`,
`{PropertyDescriptor|undefined} desc`, `[options]` resolve to type nodes the
IR could not express, and `resolveParamType` rejected the whole function
(`param-type-not-resolvable`) before any body scan ran. Legacy types these
from the checker, and the answer is **not syntactic** (legacy-only WAT,
standalone):

| JSDoc | legacy slot |
|---|---|
| `{object}`, `{Object}`, `{*}`, `{?}`, `{any}`, `{unknown}`, `{null}`, `{Function}`, `{typeof f}` | externref |
| `{string|symbol}`, `{string|null}`, `{object|undefined}`, `{PropertyDescriptor|undefined}`, `{Function|undefined}` | externref |
| every bracketed tag `[p]`, `{number=}`, `{string=}` | externref |
| `{string|number}`, `{boolean|number}` | `(ref null $AnyValue)` |
| `{string|undefined}` | `(ref null $AnyString)`; `{number|undefined}` → f64 |
| `{symbol}` | i32; `{Array}` → vec struct |

So the rule reads the **registered legacy signature** (`ctx.funcMap` →
`ctx.mod.types`, the artifact the parity guard compares against):
`jsDocParamIsExternrefCandidate` (any JSDoc type outside number/string/boolean,
or a bracketed tag) + `legacyParamSlotIsExternref` ⇒ the position is
`dynamic` in the selector, the implicit projection and the caller-ABI proof,
and from-ast lets that override win over the JSDoc node. The propagator seeds
a JSDoc-declared object type `dynamic` (not `unknown`), so call sites no
longer join `{label: 3}` and `undefined` into a union return. Also in the
slice: `options && options.label || String(name)` as a VALUE (nested
logicals and member reads on dynamic parameters are logical carriers; a
nested left keeps its value form outside a boolean position), and
`return undefined;` on a dynamic result in the move-only scan.

Selector diagnostics (`JS2WASM_IR_SHAPE_DIAG=1`) now attribute EVERY
rejection, not only `body-shape-rejected`: the move-only scan names the
innermost failing expression (`move-only[dyn|concrete|stmt]:<kind> «text»`),
the param/return resolvers name the position and lattice kind, and the
parity withdrawal prints both signatures.

After the slice (`verifyProperty` legacy: `(externref ×4) -> i32`):

| unit | now blocked on |
|---|---|
| `verifyProperty` | `arguments.length` (`expr-ident-not-in-scope «arguments»`), then Stage 2 (`assert(...)` direct call to the fnctor) |
| `verifyCallableProperty` | `options && options.verifyProperty || verifyProperty` — a function-object operand: **Stage 2** |
| `verifyAccessorProperty` | `checkGet || checkSet` over `__hasOwnProperty(...)` (bound-builtin alias results), then Stage 2 |

### Item 1, S1e slice — 2026-10-21 04:20Z (C, measured; shipped on #6815)

`verifyProperty`'s next blocker was `arguments.length` (`assert(arguments.length
> 2, …)`). Legacy lowers `arguments` through a call-site count protocol, not
the formal count: every direct caller of an arguments-reading function
publishes `__argc = min(actual, formals)` (`emitSetArgc`) and over-arity
extras in `__extras_argv`; the callee's ENTRY prologue reads both, clears
them to the `-1`/null sentinels so nested calls never see stale data, and
`arguments.length = argc + extras.length` (`emitArgumentsVecBody`). An
unknown caller (`-1`) reads the formal count. Measured: `vp(1,2,3)` → 3,
`vp(1,2)` → 2, `vq(1,2,3)` on two formals → 3.

The IR mirrors exactly the count half: `dyn.arguments_length{formals}` (35th
kind, result f64; capability `native-arguments-length`) → one wrapper
`__ir_arguments_length(i32) -> f64` (`src/codegen/ir-arguments-length.ts`)
with that prologue verbatim, emitted at the claimed function's entry before
any statement. The selector admits `arguments.length` only in the claimed
top-level function's own body (arrows inherit it; a nested `function` has
its own), unshadowed; every other `arguments` use stays legacy. The
propagator types it `f64`.

**Caller side needs no slot:** the IR direct-call plan is exact-arity
(from-ast demotes any other count), and the callee's prologue maps the
untouched `-1` sentinel to its formal count — the same value an exact-arity
legacy caller publishes (`min(actual, formals)`, no extras). So an IR caller
of an arguments-reading local callee is claimable as-is (measured: `outer(7)`
→ `arguments.length * 10 + inner(1, 2, 3)` = 13 with both bodies IR). The
imported-call plan keeps its explicit `__argc` publication (it admits
missing arguments).

Pre-existing gap met while testing, NOT this slice's: an unannotated
`function g(a,b,c,d) { if (a > 2) return 1; return 0; }` is withdrawn at
parity on base too (IR result externref vs legacy f64; the early-return
numeric-literal shape). The S1e tests use the boolean-return and
`return n + a` shapes instead.

After the slice `verifyProperty` stops on `assert` (a function object:
**Stage 2**).

### Item 1, S1f slice — 2026-10-21 09:50Z (C, measured; after Stage 2 landed)

With Stage 2 on main `verifyProperty` was no longer blocked on `assert`
(function-object member calls lower) but on the bare global `undefined` as a
VALUE — `assert.sameValue(originalDesc, undefined, …)`
(`expr-ident-not-in-scope «undefined»`): the selector admitted `undefined`
only in equality and return positions. S1f admits the unshadowed global
`undefined` as a Phase-1 value where the dynamic runtime is buildable
(call argument, local initializer, logical-value operand); from-ast lowers
it to #7104's `dyn.undefined` next to the `NaN`/`Infinity` arm, and the
move-only scan treats it as a dynamic carrier. Measured: `same(o,
undefined)`, `var v = undefined`, `d || undefined` all claim and run; a
shadowed `undefined` stays an ordinary binding. gc bytes identical.

After the slice `verifyProperty` stops on
`__hasOwnProperty(desc, 'enumerable') && desc.enumerable !== undefined` —
the uncurried-alias tail below. Census unchanged at 6 IR units.

**CI finding on the S1f PR (#6821, 10:16Z): a claim-then-demote channel the
`undefined` arm opened.** `quality` failed `check:host-import-policy`
(native-first imports 458 > 452). Bisected per probe: `functionCall` and
`functionApply` (`add.call(undefined, 6)` / `add.apply(undefined, [8])` in a
`(): number` body) went 0 → 3 imports each. With `undefined` Phase-1, Stage
2's function-object member arm (`functionObjectMemberCallIsBuildable`)
admitted the whole call — it accepts ANY member call on a stable top-level
function value and lowers it through the dynamic closed dispatch with a
DYNAMIC result — so `run` was claimed, failed at verify (`return[0] type
dynamic not assignable to declared result f64`) and demoted with the
dynamic runtime already prepared into the module (3 `__str_*` imports,
~50 helpers, `__fn_value_add`; module 2.2× larger). On main the same shape
with `null` is also claimed and demotes at build, earlier, leaving nothing
behind. Fix (one selector arm): `fn.call(...)`/`fn.apply(...)` on a direct
callable (`knownCallableArity` known) now reaches the existing
`function-invocation-method-unsupported` refusal BEFORE the function-object
member arm. Probe back to 452; gc/standalone bytes identical to the S1e
reference. Remaining Stage 2 gap, recorded not fixed: the function-object
member arm still admits a dynamic-result call in a concrete-result function
(`add.foo(x)` with `(): number`) — the move-only scan does not run for such
bodies, so the result position is only checked at verify.

**Measured 04:10Z, the next item-1 tail (NOT started — Stage-2-adjacent):**
propertyHelper's uncurried aliases `__hasOwnProperty`, `__propertyIsEnumerable`,
`__push`, `__join` (`var __x = Function.prototype.call.bind(Builtin.prototype.m)`)
and the plain aliases `__getOwnPropertyNames`, `__getOwnPropertyDescriptor`
(`var __x = Object.m`) are module-level callable bindings. Legacy certifies
the exact uncurried set in `resolveUncurriedBuiltinPrototypeMethod`
(`codegen/object-builtin-effects.ts`: Array `join`/`push`, Object
`hasOwnProperty`/`propertyIsEnumerable`/`valueOf`) and lowers each call
through the builtin's native direct-call lowering. The IR today rejects
`__hasOwnProperty(desc, "get")` in the move-only scan (`move-only[concrete]
«desc»`: a call to a module binding with no plan expects concrete
arguments), so `checkGet || checkSet` never gets boolean operands. How IR
bodies call module-level callable bindings is exactly Stage 2/4's
function-object/`<module-init>` contract (Shepherd, #6816); the alias
lowerings (`dyn.has_own_property`, array push/join over the dynamic
carrier, `Object.getOwnPropertyNames/Descriptor` into the carrier) should
be designed against that contract rather than ahead of it. `verifyProperty`
also needs `assert(...)`/`assert.sameValue(...)` (Stage 2) on every path.

### Item 1, S1g slice — 2026-10-21 10:50Z (C, measured)

The uncurried aliases `__hasOwnProperty` / `__propertyIsEnumerable` (a
top-level `var` initialised to `Function.prototype.call.bind(Object.prototype.M)`
with no writes, certified by `src/ir/uncurried-object-alias.ts`) called with
two arguments lower to the 36th dialect kind `dyn.own_property{receiver, key,
test}` — an i32 bool over the dynamic carrier, reaching legacy's own
`__hasOwnProperty` / `__propertyIsEnumerable` natives (the same
`ensureLateImport` helpers `call-object-builtins.ts` uses, so the answer is
legacy's by construction). Capability `native-own-property-test` (wasmgc,
non-fast, standalone|wasi). The call is exactly boolean for the selector's
family check, which now also recurses through `&&`/`||` of two exact booleans
(`stringCheck && __hasOwnProperty(o, n) && __propertyIsEnumerable(o, n)`);
`var hadValue = __hasOwnProperty(o, n)` keeps its i32 slot because the
unboxed-local proof accepts the certified alias call as a boolean
initializer (the checker types it `any`). A shadowed or reassigned alias
and a one-argument call stay on legacy before claim. gc/standalone bytes
identical to the S1e reference.

Measured on the harness: `both`/`absent`/`had`/`enumerable` shapes claim and
run; the census stays at 6 IR units because every alias-using harness unit
has a second blocker — `verifyProperty` → `isWritable(obj, name)`
(under-arity direct call, 4 formals), `isWritable` → a module-binding alias
in a conditional (`__isArray(obj) && … ? nonIndexNumericPropertyName : …`),
`isEnumerable` → `for (var x in obj)` with a value-used head, `isConfigurable`
→ `delete obj[name]`, the `verify*` family → `new Test262Error` (Stage 3c).
`var g = __hasOwnProperty(o, n); return g;` in a DYNAMIC-return function is
not admitted (the scan's return arm wants a dynamic carrier, `g` is i32); not
a harness shape, recorded only.

### Item 1, S1h slice — 2026-10-21 11:40Z (C, measured): `compareArray`'s three selector blockers

assert.js's `compareArray(a, b)` stopped on `b.length !== a.length`
(`move-only[concrete]`). Three selector gaps, all pre-claim, all opened:

1. **Member host ≠ value use.** `collectDirectOnlyFunctionDeclarations`
   counted `compareArray.format = …` as a value use, so the dynamic member
   equality refusal (the callback-boundary carrier concern: legacy array HOFs
   pass `obj` in the raw array carrier) applied. A function that is only the
   HOST of a member access is never handed to a callback trampoline; it now
   stays in the direct-only set. `fn.call` / `fn.apply` / `fn.bind` remain
   value uses (a bound invocation can reach the callback ABI).
2. **Proven-number element key.** `b[i]` with a counted-loop `i`: the scan's
   key-shape contract allowed only literals and dynamic indexes; the producer
   (`lowerElementAccess`, dyn arm) lowers any other key f64 and boxes it
   tag-3, so a `expressionIsProvenNumber` key is admitted.
3. **Function-object member call as a dynamic value.** `assert._isSameValue(b[i],
   a[i])` had no scan arm (fell to "no dynamic involvement"); it is now
   dyn-shaped and scanned like the receiver-first method plan (arguments are
   carriers or boxable concretes, `functionObjectDynamicValue` boxes), and its
   result may feed `!`/truthiness/`if`.

**Stage 2 claim-then-demote channel found while opening 3 (recorded for the
Stage 2 owner, gated here):** the selector's `functionObjectMemberCallIsBuildable`
admits any member call on a `resolveTopLevelFunctionValue` receiver, but the
planner (`ir-imported-call-planning.ts`, `objectReceiver: true`) mints the
canonical support only when EVERY parameter and the result have type evidence
(an annotation or the target's IR claim entry); test262's untyped,
legacy-owned `assert` has neither, so the claim demotes at lowering
(`identifier "assert" is not in scope`) — visible today on `<module-init>`
(`assert._isSameValue = …`) and on `compareArray`. The new scan arm mirrors
the planner's annotation route (`function-object-member-evidence` refusal);
the claim-entry route cannot be mirrored in the selector (claims are not
visible there). Consequence for the harness: `compareArray` claims and runs
end to end against a TYPED function object (measured: length mismatch, `-0`
vs `0`, `NaN` vs `NaN` all match legacy), but on the real harness it waits
for `assert` to become an IR claim (Stage 3c) AND for the planner's claim
route to be mirrored (or the Stage 2 isPhase1Expr arm to require the same
evidence). gc/standalone bytes identical to the S1e reference.

Measured again 04:35Z, correcting the note above: a function mixing
`return o + "!"` and `return o` (or `return "x"` / `return String(o)` with a
dynamic return) registers `(result externref)` in BOTH front-ends and ships
an IR body; so does a lone `return o + "!"` (`(ref null $AnyString)` in
both). The earlier `labelOf` withdrawal came from the test program's shape,
not from `+`. The one mismatch measured is `{string, number literal}`
returns (`if (d) return o + "!"; return 1;`: IR and legacy pick different
result slots) — not a harness shape, left as is.

## propertyHelper.js, arm 1 — the stored `Object.getOwnPropertyDescriptor` alias (2026-10-22, measured)

**Blocker.** propertyHelper.js reads descriptors through a stored static
alias, `var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;`.
The seven verify* helpers call it as `__getOwnPropertyDescriptor(obj,
name).<attribute>`. The dynamic move-only scan had no arm for that call, so it
refused it:
- a `.writable` read off the call needs a dynamic receiver;
- `!call.writable` scanned the dynamic `obj` against a concrete parameter slot.

All seven reported `param-type-not-resolvable` with `move-only[dyn|concrete]`.

**Arm.**
- **Alias recognition.** `uncurried-object-alias.ts` now also certifies the
  stored-static form, using the same no-write discipline as S1g: a top-level
  `var`/`let`/`const` initialized with exactly `Object.getOwnPropertyDescriptor`,
  with no other write to the name and no top-level `Object` binding. Legacy
  certifies the same form (`resolveStoredObjectStaticMethod`).
- **Selector.** The call is a dynamic producer in `isDynShaped`. In the
  move-only scan, each operand is a carrier or a boxable concrete. The phase-1
  shape arm checks the new capability `native-own-property-descriptor`
  (host-free lanes, non-fast; the same lane predicate as S1g). The call-graph
  scan treats the call as a provider, not a call edge.
- **from-ast.** Both operands are lowered as carriers (the operand boxing is
  shared with S1g as `lowerAliasCarrierOperands`), then a runtime call to
  `__getOwnPropertyDescriptor` with a `dynamic` result.
- **Integration.** Pre-registers the provider exactly as legacy does
  (`ensureLateImport(…, [externref, externref], [externref])`) before Phase 3.
- No new IR instruction; the call reuses the existing runtime-callable `call`.

**Per-function census.** `built-ins/Array/prototype/map/length.js`, honest
harness, standalone and gc (native-first) agree on every row. Measured on the
#6833 stack; the arm itself is branched from origin/main.

| function | before | after |
| --- | --- | --- |
| verifyWritable | `move-only[dyn]` `__getOwnPropertyDescriptor(obj, name).writable` | `call-graph-closure` (calls legacy `isWritable`) |
| verifyNotWritable | `move-only[concrete]` `obj` | `call-graph-closure` (`isWritable`) |
| verifyEnumerable | `move-only[dyn]` `….enumerable` | `call-graph-closure` (`isEnumerable`) |
| verifyNotEnumerable | `move-only[concrete]` `obj` | `call-graph-closure` (`isEnumerable`) |
| verifyConfigurable | `move-only[dyn]` `….configurable` | `call-graph-closure` (`isConfigurable`) |
| verifyNotConfigurable | `move-only[concrete]` `obj` | `call-graph-closure` (`isConfigurable`) |
| verifyProperty | `move-only[concrete]` `obj` | `move-only[concrete]` on the statement `assert.sameValue(originalDesc, undefined, …)` |

**No IR body ships yet: this arm is necessary, not sufficient.**
- The six deprecated helpers now fail only on their legacy `is*` callee.
  Measured: with the three `is*` helpers replaced by claimable stubs, all six
  ship IR bodies.
- So the next arms are the `is*` helpers, in this order:
  - `isEnumerable` (`forin-head-value-used`): unlocks `verifyEnumerable` and
    `verifyNotEnumerable`;
  - `isConfigurable` (`delete obj[name]`): unlocks the two configurable
    helpers;
  - `isWritable`: unlocks the two writable helpers.
- **`isConfigurable` needs a real dynamic delete.** The IR's current `delete`
  lowering evaluates the operand and returns `true` without deleting anything.
  A claimed `isConfigurable` would therefore report every property as
  configurable.

**Tests.** `tests/issue-7106-prophelper-gopd-alias.test.ts`: descriptor checks
shaped like the verify* helpers, compared with node.
- Standalone, wasi and default gc (native-first, which projects to the
  standalone regime) ship IR bodies.
- The host-assisted gc lane refuses before claim.
- A reassigned alias is not certified.
- 3 of the 5 cases fail on the base.

**Found, not fixed (direct path, identical on the base).**
- On the host-assisted gc lane, the all-legacy probe answers 86 where node
  answers 511: legacy's stored-alias descriptor reads come back falsy there.
- A module-level reassignment of the alias
  (`__getOwnPropertyDescriptor = function…`) is ignored by legacy, which still
  calls the builtin (511 where node answers 86).

## propertyHelper.js, arm 2 — the for-in head as a dynamic carrier (2026-10-22, measured)

**Blocker.**
- `isEnumerable` reads its for-in key (`if (x === name)`). The selector
  admitted head-value reads only when the key is a host string
  (`forInHeadValueIsHostString`).
- So on native-strings lanes it reported `forin-head-value-used`.
- `verifyEnumerable` and `verifyNotEnumerable` then failed with
  `call-graph-closure` on it, which is where arm 1 left them.

**Arm.**
- **Why this is sound.** for-in is admitted only on the non-fast carrier
  (`isDynamicForInReceiver`). There the #2964 key helpers' externref IS the
  dynamic carrier of the key string: `emitBox` of a native string is
  `extern.convert_any`.
- **Selector.** A new option, `forInHeadValueIsDynamicCarrier`
  (`ctx.nativeStrings && !ctx.fast`), admits head reads on that lane. The head
  joins the move-only scan's dynamic names (`dynamicCarrierForInHead`). A body
  holding such a head always runs the scan (`containsDynamicCarrierForInHead`),
  so a read in an unsupported position stays refused before claim. For example,
  `s = s + k` on a concrete string stays `move-only[concrete]`.
- **from-ast.** Tags the head slot `asType: dynamic` on that lane. It is a
  plain `local.get` of the externref slot, so no conversion is emitted.

**Per-function census.** `built-ins/Array/prototype/map/length.js`, honest
harness, #6833 stack plus arm 1. Standalone and gc agree on every row.

| function | before (arm 1) | after |
| --- | --- | --- |
| isEnumerable | `forin-head-value-used` | **IR emitted** |
| verifyEnumerable | `call-graph-closure` | **IR emitted** |
| verifyNotEnumerable | `call-graph-closure` | **IR emitted** |
| the other 12 propertyHelper units | unchanged | unchanged |

**Conformance sample.** Every third of the 89 test262 files that call
`verifyEnumerable`/`verifyNotEnumerable`, 30 files on standalone and on gc.
- The verify helpers are IR-emitted in 24 of the 30 files.
- Pass/fail is identical to the base on both lanes: 26/30 pass. The other 4
  are 1 skip and 3 runtime-import errors from `using` tests, all the same on
  the base.

**Tests.** `tests/issue-7106-prophelper-isenumerable.test.ts`, compared with
node on standalone and gc (wasi: validate).
- propertyHelper's `isEnumerable`, verbatim.
- Four other head-read shapes, with no post-claim demotion.
- One refused shape: concrete string accumulation.
- All 5 cases fail on the base.
- Also fixes the pre-existing #2952 slice 6c dual-run case "head compared to a
  literal" on this stack.

**Switch-gate fix (2026-10-25, measured; #6843).** The arm shipped one
claim-then-demote. `switch (k)` over a dynamic-carrier head was CLAIMED by the
selector and demoted at build on standalone, wasi and gc native-first
(`irPostClaimErrors = [{kind:"build", message:"ir/from-ast: string-tested
switch disc lowered to dynamic, not string, in h"}]`; legacy recompiled it, so
the result was right by accident). The same `switch` over a dynamic PARAM was
refused before the claim. Cause: the switch gate's
`switchDiscHasIrStringCarrier` follows the disc to its declaration and
certifies any binding without an initializer — a `var k` for-in head has none.
Fix (round 2 of review #6843, 2026-10-25): the arm's head classification is
split into its two questions — `dynamicCarrierForInHeadIdentifier(stmt)`, the
lane + head-shape test (`forInHeadValueIsDynamicCarrier`, not host-string,
single `var` identifier head), and the body-reads-head (`.used`) test —
with `dynamicCarrierForInHead` composed from both, so the producer and the
for-in arm behave exactly as before. The switch gate walks up from the disc
identifier to the nearest enclosing for-in (same function) whose head
identifier resolves to the disc's declaration and asks only the lane + shape
test, answering `false`, so the shape is refused pre-claim as
`switch-disc-not-string-carrier` (the `body-shape-rejected` family, like the
dynamic-param case). No second name or shape test; the producer is unchanged.
- Round-2 finding: the round-1 gate followed the disc to its symbol's FIRST
  declaration (`localVariableDeclaration`) and asked that for-in's
  `dynamicCarrierForInHead`, whose `.used` answer is about THAT loop's body.
  All `var k` heads in a function share one symbol, so with two sequential
  loops where only the second switches on `k`, the first loop answered "not
  read", the gate certified `k`, and from-ast demoted the claimed body
  ("string-tested switch disc lowered to dynamic, not string") on standalone,
  wasi and gc native-first — identical to main, i.e. an incomplete fix, not a
  regression. The enclosing-loop walk asks "is this disc a dynamic-carrier
  head on this lane" independent of which loop reads it.
- Before/after on the repros (`{a:1,b:2,c:3}`): the single-loop switch (node
  12) and the two-loop shape (node 15) were claimed then demoted on standalone
  and wasi; now both are refused before the claim, `irPostClaimErrors` empty,
  legacy answers 12 / 15. gc native-first with a JSDoc-typed helper behaves
  the same way.
- Host-assisted gc bytes (`semanticProviders: "host-assisted"`) are identical
  between `origin/main` and the fix for the two-loop repro, the switch repro, a
  plain for-in and a no-shape loop (`88fe65ed…`, `8c1e9e9c…`, `9b85e4dd…`,
  `114efdc5…`; main tree = `git archive origin/main`, same node_modules).
- Tests: the switch repro, both two-loop orders (`twoLoopsFirstUnread`,
  `twoLoopsSecondUnread`, expected 15), a captured head
  (`forin-head-value-captured`) and a written head
  (`forin-head-value-written`) each assert the refusal arm, empty
  `irPostClaimErrors` and the node result, on standalone and gc; wasi pins
  all three switch refusals and validates. The switch rows fail without the
  fix (`twoLoopsFirstUnread` also fails with only the round-1 fix).

## propertyHelper.js, arm 3 — statement-position dynamic delete (2026-10-22, measured)

**Blocker.** `isConfigurable` and `isWritable` delete through their dynamic
`obj` parameter (`delete obj[name];`). #6842 keeps every `delete` off the IR,
because the Slice 11 lowering answered a constant `true`.

**Arm.**
- **Wrapper.** `codegen/ir-dynamic-delete.ts` builds one wrapper per code
  strictness, `__ir_dyn_delete_{strict,sloppy}(externref, externref) -> i32`.
  Its body is exactly legacy's generic externref arm of
  `compileDeleteExpression`:
  - RequireObjectCoercible via `emitExternrefDestructureGuard` (a TypeError for
    a null/undefined receiver);
  - then `__delete_property`;
  - then, in strict code only, a TypeError for a refused delete.

  Strictness is decided per site with legacy's own `isStrictContext`, through
  the resolver (`dynamicDeleteSymbol`).
- **Selector (`dynamicDeleteStatementOperand`).** Admits exactly:
  - statement position (top-level and nested bodies);
  - the receiver is the subject's dynamic-typed parameter;
  - the key is a plain name, a dynamic parameter, or a string/number literal;
  - never `<module-init>`, never the fast carrier.

  The move-only scan sees the receiver (and a parameter key) as carriers.
  Expression-position deletes and concrete receivers stay refused (#6842).
- **from-ast (`lowerDynamicDelete`).** Lowers receiver and key as carriers
  (a literal key is boxed) and calls the wrapper. Integration builds the
  wrappers before Phase 3 and observes them as runtime providers.

**Per-function census.** `map/length.js`, standalone. `isConfigurable` moves
from `body-exprstmt-other:DeleteExpression` to the next blocker,
`expr-binary-op-instanceof` on `e instanceof TypeError` in its catch clause.
No other unit changes. `isWritable` still stops first on its
`__isArray(obj) && …` alias conditional.

**Conformance sample.** Every fourth of the 335 test262 files with an indented
`delete <ident>[…]`/`.…` statement: 60 files, standalone. Pass/fail and IR unit
counts are identical to the base (36/60 pass both). The test262 deletes sit
in `<module-init>` or on non-parameter receivers, which this arm leaves alone.

**Tests.** `tests/issue-7106-prophelper-dyn-delete.test.ts`, compared with
node:
- strict module deletes (computed key, named key, literal keys; frozen key →
  TypeError; null receiver → TypeError) on standalone and gc, plus a wasi
  validate;
- deletes nested in a `try` body and in `if`/`else` arms (the
  `isConfigurable`/`isWritable` shapes), including a non-configurable key
  caught in strict code;
- a sloppy script, where a frozen key reports `false`;
- the #6842 refusals (concrete receiver, expression position) still hold.

**Nested-body fix (follow-up commit).** The first cut gave only the
statement-list dispatcher (`lowerStatementListPrefix`) a delete arm. The
selector also admits the delete in nested bodies, so a delete inside a `try`
body was claimed and then demoted at build ("unsupported body
ExpressionStatement shape"), a post-claim error. Both dispatchers now share
`lowerDroppedDelete`. A bare `{ … }` block holding a delete is still refused
before the claim (a pre-existing block refusal, so the selector and from-ast agree).

**Review follow-up (2026-10-25).** The arm's PR branch also carried a selector
widening, `isCertifiedObjectAliasValue` (a second "this alias call is boolean"
arm in `trackedModuleInfluenceIsBoolean`, beside the
`declaredExpressionHasExactFamily(…, "boolean")` certification main already
reuses at the `!` site). Measured on a sloppy script with unannotated
`function hasK(obj, k) { if (__hasOwnProperty(obj, k)) … }` and
`function notEnum(obj, k) { return !__gopd(obj, k).enumerable; }`: the
widening made the selector claim both, and the build demoted both with
"function typeIdx parity mismatch" — 3 claim-then-demote cases on the branch
head against 1 (`negHas`, pre-existing) on the base. **Removed**; the exact-family
certification stays the single predicate, and
`tests/issue-7106-prophelper-dyn-delete.test.ts` pins that both shapes stay
legacy with `irPostClaimErrors` empty and node's result. The refactor of
`ir-dynamic-delete.ts` onto the shared helper builders stands — since #6858
those are `helperFunctionContext` / `publishHelperFunction` in
`helpers/ir-helper-function.ts`, which main's `ir-dynamic-delete.ts` already
uses; host-assisted gc bytes are identical to main.

## `dyn.instanceof` — generic dynamic instanceof at legacy parity (2026-10-22, measured)

**Why not the intrinsic RHS yet.** propertyHelper's `isConfigurable` and
`isWritable` stop on `e instanceof TypeError`. Lowering that through legacy's
generic runtime operator (`__instanceof_dynamic`), with `TypeError` read off
the realm (#7118), changes answers relative to what legacy does today. Legacy
compiles a literal `instanceof TypeError` to its name-based tag test instead.
Measured on standalone and default gc, with the generic operator as `v
instanceof C` (C a dynamic parameter):

| left operand | `instanceof` | generic (legacy) | static name (legacy) | node |
| --- | --- | --- | --- | --- |
| `new TypeError()`, `RangeError`, `SyntaxError`, a caught TypeError | `Error` | false | true | true |
| `class MyTE extends TypeError` instance | `TypeError` | false | true | true |
| `Object.create(TypeError.prototype)` | `TypeError` | true | false | true |
| `{}` | `{}` (not callable) | false, no throw | n/a | throws TypeError |
| error vs its own type, plain object, primitive, `[]` vs `Array`/`Object` | | agree | agree | agree |

Root cause: in standalone, `Object.getPrototypeOf(TypeError.prototype) ===
Error.prototype` is false, so the chain walk never reaches `Error.prototype`.
The coordinator chose (2026-10-22):
- (c) now: this arm, a dynamic-PARAMETER right operand only, at exact legacy
  parity;
- (a) next: a legacy wrong-answer fix in `__instanceof_dynamic` for
  Error-family targets, as its own issue and PR, measured;
- the intrinsic right operand only after (a) lands. Not a second, name-based
  `instanceof` path.

**Arm.**
- **Instruction.** `dyn.instanceof{value, target}` (JS dialect, 40 on this
  base, 41 with #7118's `dyn.global_object`). Both operands dynamic, result
  a boolean `i32`. Effects are call-like: a `prototype` accessor may run, and
  a not-callable target throws.
- **Wrapper.** `codegen/ir-dynamic-instanceof.ts` builds
  `__ir_dyn_instanceof(externref, externref) -> i32`. It is exactly the tail
  of legacy's `emitDynamicInstanceOf` on the host-free lanes:
  `__instanceof_dynamic`, then `emitInstanceofThrowGuard`.
- **Admission (`dynamicInstanceOfUse`).**
  - The left operand is a dynamic parameter or `this`.
  - The right operand is a bare dynamic parameter.
  - Codegen's `irDynamicInstanceOfRoutesGeneric` must certify that legacy
    reaches that same tail. Legacy dispatches the right operand on its NAME
    first (class, fnctor, builtin and alias arms), and the selector runs
    before those registries fill. So the predicate checks the names
    themselves: no non-parameter declaration in the file binds the name, it
    is not a builtin constructor name, it is never written, it is typed
    `any`/`unknown`, and the module installs no callable `@@hasInstance`
    (that module takes legacy's operator entry instead).
  - Host-free lanes only, never the fast carrier.
- **from-ast (`lowerDynamicInstanceOf`).** Lowers both carriers and emits the
  instruction. The resolver asks the same predicate.

**Diverges from node by design (#2916).** The IR answers exactly as legacy on
every row, including the three where legacy's generic operator differs from
node: an error-subclass instance against `Error`, a user `TypeError` subclass
against `TypeError`, and a runtime non-callable target (false instead of a
TypeError, the "no wrong throws" rule). The first two change with (a). The
third stays until the runtime can tell a non-callable `$Object` from a class
value.

**Per-function census.** `map/length.js`, standalone: 12 of 25 units IR before
and after, no unit changes. Every propertyHelper `instanceof` has an intrinsic
right operand.

**Tests.** `tests/issue-7106-ir-dyn-instanceof.test.ts`, 9 cases. Each row is
compared with a legacy-only compile (`experimentalIR: false`) and with node:
- on standalone and default gc: errors vs their own type, vs another type,
  vs `Error` (residual row); a user subclass (residual row); a plain object;
  primitives; `[]` vs `Array`/`Object`;
- a callable target with a non-object `prototype`, which throws the
  TypeError on both and in node;
- the non-callable target (residual row);
- a wasi validate;
- refusals: a builtin-named parameter, a parameter name another declaration
  binds, a written parameter, an `@@hasInstance` module, the host-assisted gc
  lane.

**Pre-existing, not this arm.** On the #6847 base, `function F() {}` plus
`function probe(v, F) { return v instanceof F; }` fails the compile with
"ABI draft … function-value-trampoline … would mutate sealed prepared scope".
It is measured identical without this change.

## `instanceof` an Error-family builtin (2026-10-22, measured)

Stacks on #6848 (`dyn.instanceof`), #6846 (#7118, `dyn.global_object`) and
#6850 (#7120). Merged, the JS dialect has 41 interfaces.

**Arm.** `<any> instanceof TypeError` (any of `Error`, `TypeError`,
`RangeError`, `ReferenceError`, `SyntaxError`, `EvalError`, `URIError`) ships
as `dyn.instanceof`:
- **Right-hand side.** #7118's ambient-intrinsic read. There is no new name
  path.
- **Left-hand side.** A dynamic parameter, `this`, or a catch binding.
- **Admission (codegen `irDynamicInstanceOfAtLegacyParity`).** Exactly where
  legacy takes its name-based tag path:
  - the name binds only the lib declaration, and nothing declares or writes
    it;
  - the lane is native-first;
  - the left operand is typed `any`/`unknown`;
  - the module installs no callable `@@hasInstance`.

With #7120, the operator answers the Error-family carrier from the value's
`$tag` before any prototype read. The value is legacy's own
`__builtin_<Name>` carrier: the subclass row answers true, which only that
tag probe can produce. It is never member-read in the IR, so this is not
#7123's path.

**Pinned rows (IR / legacy / node).** All other rows are equal on all three,
on standalone and default gc.

| left-hand side | bits TE=1, RE=2, E=4 | IR | legacy | node |
| --- | --- | --- | --- | --- |
| `Object.create(TypeError.prototype)` | | 1 | 0 | 5 |
| `Object.create(Error.prototype)` | | 4 | 0 | 4 |

Both are equal to or closer to node than legacy, never worse.
`Object.create(TypeError.prototype) instanceof Error` stays FALSE in the IR,
the same as legacy and unlike node: the native error prototypes do not chain
to `Error.prototype` (#7120).

**Fixes the arm needed.**
- **Catch bindings.** Now read as dynamic on the non-fast lanes, as the for-in
  head is. `"…" + e` had been claimed and then demoted at build (a selector and
  from-ast mismatch that predates this arm).
- **Merge interactions.** Two came from combining #7118 with the stack. Each
  stack passed alone.
  - The move-only scan's identifier arm now accepts an ambient intrinsic where
    a dynamic value is expected (`typeof Object`), consistent with
    `isDynShaped`.
  - `isDynShaped` now classifies the ambient special forms
    `JSON.stringify(…)` and `Object.prototype.toString.call(…)` as concrete.
    The member-call arm had walked down to their now-dynamic intrinsic root.

**Census.** `map/length.js`, standalone: 11 of 25 units IR before, 14 after.
isConfigurable, verifyConfigurable and verifyNotConfigurable ship IR.

**Tests.** `tests/issue-7106-ir-instanceof-error-intrinsic.test.ts`. In #6848's
test, the two error rows #7120 fixed leave the "diverges from node" set.

## Ownership

Per the #6583 plan: Stage 1 and 3 → B (items 2/3), Stage 2 and 4 → Shepherd
(items 4/5). C takes any stage whose owner has not replied by the next
check-in after this file lands, starting with Stage 3 (announced 21:30Z).

## Non-goals

- No JS-host IR paths (standalone + Linear only, per CLAUDE.md 2026-10-10).
- No new runtime helpers: every lowering targets a helper legacy already
  emits on standalone.


## Stage 2 receiving implementation checkpoint

The paragraphs below record the historical core receiving checkpoint, before the bounded RHS and receiver work described in the current qualification update. Their counts, remaining gaps and provider status are historical observations.

Status: core slice passes 94 local controls and current-base quality checks; original harness acceptance remains incomplete.

This slice reuses the exact checker-backed same-source function-binding resolver and its whole-source write census. It admits a stable top-level function identifier only as a property-call or property-write receiver. Local shadowing and reassigned bindings do not authorize a named singleton substitution; general function-identifier arguments remain outside the slice.

A prepared, unit-owned accessor runs the existing canonical lazy singleton allocation kernel, including constructibility, rest and function metadata. IR and direct callers share the same cache and trampoline. The accessor has a distinct Program ABI role; no generic closure allocation or fabricated function-object instruction stands in for this contract.

Calls emit one effectful property Get before the argument list, construct the existing native ObjVec left to right, perform the real IsCallable check after the arguments, then call the existing closure dispatcher with the captured callee and original receiver. Projection adapters change the carrier representation only and do not repeat Get or dispatch a call. The compatibility host path is unchanged.

## Planned validation

- Normal formatting, type checking, inventory, cycle/layer, LOC/function, coercion/oracle checks.
- Whole `tests/issue-7106-stage2-function-objects.test.ts`, existing callable ABI and dynamic member controls.
- The plan's exact 48-file addition sample using `TEST262_TARGET=standalone TEST262_PATH_FILTER=language/expressions/addition/ COMPILER_POOL_SIZE=2 TEST262_WORKERS=2 pnpm run test:262`, after current-main census integration and normal provider readiness. Compare actual per-unit `irBodyEmitted` outcomes for the six harness units and relevant module init; a selector claim or IR label is not a completed body.
- Preserve current protected Test262 population, floors, expected failures and normal CI/queue requirements.

The core slice passes normal type checking, all seven focused cases with genuine prepared-component ownership and no legacy bodies or R2 withdrawals, and 64 additional controls across component dependencies, function metadata, source identity and singleton behavior. Another 23 unchanged controls cover the extracted type-erased-wrapper and super-method operations, for 94 local passes across seven whole test files, without skips or an unhandled-error waiver. These are local controls, not Test262 conformance counts.

Before the structural extractions, a compile-only probe of the unchanged original assert.js, sta.js, compareArray.js and one addition test found nine units, of which only $DONOTEVALUATE was genuinely prepared. The module-init refusal exposes a remaining Stage 2 gap: an untyped FunctionExpression on a certified function-object property assignment needs an exact source-bound canonical closure-signature plan. Stage 1, constructor and parameter-signature dependencies remain separately recorded. The 48-file maintained addition measurement has not run; no 9/6-to-9/4 histogram improvement or fallback-free pass is claimed.

Formatting, lint, type checking, current-base file/function budgets, import cycles and IR layering pass after cohesive extraction into subsystem modules. Dialect, kind-neutrality, oracle, coercion, issue and compiler-boundary inventory checks also passed during qualification; the repository architecture remains incomplete. Normal commit/push hooks remain required. No LOC/function exemption or baseline change is part of this slice. The maintained original-test diagnostic has not run: normal provider preflight rejects the missing QuickJS artifact (37c98432bd22e81a); no substitute provider is selected. No complete IR coverage, Linear backend implementation or full conformance result is claimed.


### Current bounded receiving qualification

The bounded receiving work now includes exact same-source Boolean FunctionExpression RHS plans for stable function-object members, canonical physical signatures and wrapper metadata, prepared dependency evidence, and a narrowly certified member-only initializer. Property writes reuse the existing strict setter only at an authenticated function-object receiver with the genuine non-fast externref carrier. Missing parameter or result evidence declines receiver planning before allocating support; it does not invent a dynamic signature or change generic callback admission. Unsupported, stale, shadowed, reassigned and FAST cases retain their refusal boundaries.

Current focused qualification records 193 passes across 18 whole test files, with nine separate canonical ToNumber controls passing. All 12 scoped quality gates pass. The seven-case HOF/metadata file passed, including the real opposite-body filter/map results, primitive Boolean boundary checks and the independent direct-initializer marker. Its same-module output uses the public compiler's canonical defaultability finalization, retaining the actual source-unit/session allocator lineage, shared wrapper types and final ABI indices. These are bounded local controls, not Test262 conformance or protected-floor counts.

The unchanged four-input original compile-only probe still exposes nine units: only `$DONOTEVALUATE` is genuinely prepared. `isNegativeZero` and `isPrimitive` remain dual with `param-signature-unstable`; six units remain legacy: `formatIdentityFreeValue`, `formatSimpleValue`, `assert` (constructor resolution), `compareArray` (parameter type), `Test262Error` (return type), and module initialization (`closure-return-type`). This does not establish whole-harness ownership, Stage 2 completion, or a 9/6-to-9/4 coverage gain.

The latest maintained addition slice registered all 48 distinct original cases and produced 48 verdicts: 45 pass and the same three BigInt failures, with no compile errors, timeouts, skips or explicit exclusions. All 48 verdicts and unit censuses match the earlier public-core measurement; 44 programs retain the dominant nine-unit/six-legacy/two-dual census. Host-free passes are 45 and IR-only passes remain zero. The scoped run did not promote the historical baseline.

A transparent exact-input selector observation records the original `assert._isSameValue` closure accepted with its real source plan, followed by `assert.sameValue` rejected without one. The observer forwards both original calls and restores the export; its consumer binary and full outcome report match the unobserved probe. This is subexpression-selection evidence; module initialization remains unsupported.

Three unchanged initializer/timer suites produce 53 passes and six failures on both the final candidate and the clean main-based apply-repair control. Those failures and all assertions are retained for CI and owner disposition.

The receiving PR remains held for lead C's dependency and admission order, including the separately qualified apply-preparation prerequisite in #6814. Normal hooks, protected CI and existing floors remain required. No full Stage 2, Linear backend or full conformance qualification is claimed, and no baseline, allowance or architectural exemption is part of this work.

## GDI prologue for an IR-claimed `<module-init>` (2026-10-22)

**Bug.** The IR patch replaced the whole `__module_init` body, and the direct
emitter's GlobalDeclarationInstantiation prologue went with it. On standalone,
`function f() { return 1; } let k = 2; if (k !== 2) { throw "#1"; }` claimed
`<module-init>` and never called `__defineProperty_value` for `f`: a claimed
script stopped publishing its top-level functions on the global object. The
same drop hit module `var` undefined seeds (#4489) and the #2931 live-binding
seeds. The integration refused the claim outright when live-binding seeds
existed, and had no guard for the other parts.

**Fix.**
- `compileModuleInitBody`'s prologue moved verbatim into
  `src/codegen/declarations/module-init-prologue.ts`
  (`emitModuleInitPrologue`). The direct body still inlines it. A binary-hash
  A/B over 18 lane×shape compiles (standalone/gc/wasi; with and without
  functions/vars; script and module) is identical.
- For a claimed initializer, `buildModuleInitPrologueCall` (re-exported by the
  `codegen/index.ts` facade, which the bridge already imports, so the IR
  layering count is unchanged) runs the same
  emitter into a fresh `__module_init` context, installs the result as a
  private `[] -> []` helper `__module_init_prologue`, and the patch prepends
  `call` to the IR body, inside the WASI guard. An empty prologue mints
  nothing, so an initializer with no instantiation work stays byte-identical.
  The inliner usually folds the helper back into `__module_init`.
- **Why a separate helper rather than a splice.** The prologue keeps its own
  locals, so no local remapping against the IR body is needed.
- **Why it is built during preparation.** The helper is built in
  `compileIrPathFunctions` before the callable-provider pre-registration flush,
  which is before the resolver exists and before any IR body is lowered. The
  emitters can register late helpers or imports, and a late-import shift
  reaches only installed functions and `ctx.currentFunc`. It never reaches a
  lowered body waiting in the patch queue, or a funcIdx the resolver has
  already captured.
- One code path covers both single-source routes: the post-direct overlay (the
  direct body is emitted, then replaced) and the prepared component (the direct
  body is never compiled).
- An emitter failure withdraws only that initializer, as a soft
  `module-init-legacy-coupling` Unsupported. The direct body carries its own
  prologue, so it is a correct fallback.
- A helper whose initializer was not installed is emptied
  (`retireUninstalledModuleInitPrologues`).
- **Live-binding refusal retired** for those routes, because the helper now
  seeds them. Measured: a module whose function swaps `g` after init returns
  `412` (same as node) with the claimed initializer. With the prologue call
  removed, the same build traps on the unseeded binding.
- **The allocator-sealed multi-source routes** (`preparedModuleInitBatch`,
  `deferPreparedPublication`) cannot mint the helper. There the refusal is
  widened to the whole prologue via `moduleInitPrologueMayEmit`, a conservative
  predicate that is never false when an emitter has work.
- **Static class initializers keep their refusal.** They are body content,
  not prologue.

**Tests.** `tests/issue-7106-module-init-gdi-prologue.test.ts`. 8 of the 11
cases fail on the base (file-copy A/B). The other 3 are run-like-node smoke
cases and the no-helper control.

**Not verified.** The coordinator's script `var` repro
(`if (y !== undefined) { throw "#5"; } var y = 1;`) needs the separate
script-var gate. A local approximation of that gate still rejected the source
with `expr-ident-not-in-scope «y»`, so this repro was not run. The module
analog, which goes through the same `emitModuleVarUndefinedSeeds`, is covered.

## `delete` reached a wrong IR lowering — selector refusal (2026-10-22, measured)

Found while planning the propertyHelper `isConfigurable` arm.
- **Old lowering.** Slice 11 (#1169n) admitted `delete <expr>` in
  `isPhase1Expr` and lowered it to the operand's side effects plus a constant
  `true`. The IR has no delete operation, so a claimed `delete` removed nothing
  and never threw.
- **Reachable on origin/main.** In a module (strict code),
  `function f(): number { const a = [1, 2]; return delete (a as any).length ? 1 : 0; }`
  is IR-claimed and returns `1` on standalone and gc, where node and the
  direct path throw a TypeError.
- Statement-position `delete` (`body-exprstmt-other`) and deletes on dynamic
  parameters (`move-only[concrete]`) were already refused.

**Fix.**
- The selector refuses every `delete` with `expr-delete-no-ir-lowering`. This
  subsumes the #2726 module-global `delete this.x` refusal.
- from-ast's arm now demotes instead of answering a constant.
- The #1169n case that asserted the claim now asserts the refusal.
- The playground corpus has no `delete`, so `check:ir-fallbacks` is unchanged.
- **The `isConfigurable` arm carries the real dynamic delete later.**

**Still wrong on the direct path (not changed here).** Legacy's
`delete (o as any).x` on a typed struct parameter (`o: Point`) leaves `o.x`
readable. That is the same on the base and on legacy-only compiles.

## Function-object realm members — selector refusal (2026-10-29, measured)

Found in the #6972 merge group: three ES5 rows failed there and pass on main
`8de8a22511`.
- `language/statements/function/13.2-22-s.js` and `13.2-19-b-3gs.js` failed
  with "Expected a TypeError to be thrown but no exception was thrown at all".
- `built-ins/Function/prototype/bind/15.3.4.5-2-16.js` failed with
  "TypeError: Value is not callable".

**Root cause (one, not two).** A receiver-only use of a top-level function
`F` (`F.x(…)`, `F.x = v`, `var v = F.x`, Stage 2 and census arms 3/4) lowers
to the boxed function object plus a dynamic member operation. That
operation resolves only `F`'s own expandos. It does not model the members
the realm defines for every function:
- on %Function.prototype%: `bind`, `call`, `apply`, `toString`,
  `constructor`, and the %ThrowTypeError% `caller`/`arguments` accessors;
- the non-writable own `length`/`name`;
- on %Object.prototype%: `valueOf`, `hasOwnProperty`, and the rest.

Measured on standalone, PR head `0e95c58ef3`:
- `F.bind()`, `F.valueOf()`, `F.constructor()` and `F.toString()` threw
  "not callable".
- `var v = F.valueOf` (and `hasOwnProperty`, `isPrototypeOf`,
  `propertyIsEnumerable`, `toLocaleString`, `constructor`) read undefined.
- On a strict `F`, `F.caller = v` stored instead of throwing, and
  `var v = F.caller` read instead of throwing.

**Latent on main.** The arms predate #6972. #6972 only made the harness
`<module-init>` claimable, so test bodies reach them.
- The harness-free `function testFunc() {}\ntestFunc.bind();` is
  IR-claimed on main and throws "Value is not callable".
- So is a plain IR function `export function test() { F.bind(); … }`, and
  `F.caller = 1` on a strict `F` there does not throw.

**Fix.** `isFunctionObjectReceiverUse` (`select-expression-structure.ts`) now
also requires `namesFunctionObjectExpando(access)`.
- That is a literal member name (`literalFieldName`, exported from
  `fnctor-field-writes.ts` rather than copied) that is not in
  `FUNCTION_REALM_MEMBER_NAMES`.
- `FUNCTION_REALM_MEMBER_NAMES` is the string keys of %Function.prototype%
  and %Object.prototype% in `NATIVE_REALM_CATALOG`, the single source of
  those names. Hence the `ir->runtime: 10` grant above.
- The selector, the planner and the prepared revalidation all ask this one
  predicate. Calls, writes, reads and chained writes therefore refuse
  together, at select, with no claim-then-demote.
- A dynamic key (`F[k](…)`) is refused too: it may name any realm member.
- `F.prototype` (an own property, not a realm key) and ordinary expandos
  (`F.helper = function…; F.helper(2)`, the harness's `assert.*`,
  `compareArray.format`, `Test262Error.prototype.toString = …`) still claim.

**Rejected alternative.** Adding `bind` to the `call`/`apply`
invocation-method refusal in `select.ts` fixes only the call of 15.3.4.5-2-16.
The reads, the other realm methods and the poisoned writes stay wrong.

**Validation.**
- All three rows pass through `runTest262File(…, "standalone")`.
- Over the 320 test262 files where a top-level `function X` is the receiver
  of a realm member or a computed access, standalone goes from 297 to 300 and
  nothing flips to fail.
- The arm also runs on gc (`ctx.standalone` is the native regime there), so
  gc output changes for exactly these units. On the same 320 files the host
  lane goes from 254 to 255 (15.3.4.5-2-16) and nothing flips to fail.
- `tests/issue-7106-function-object-realm-members.test.ts` checks every
  verdict against node. It fails 7 of 8 cases on `0e95c58ef3`.

**Still wrong on legacy (not changed here; legacy-owned units, standalone).**
- `typeof F.valueOf()` does not answer `"function"`.
- A sloppy `F.caller` reads undefined, not null (also on main).
- `F["helper"] = fn` followed by `F["helper"](…)` throws a TypeError (the
  element store is refused at `body-elemstore-recv` on `0e95c58ef3` too).

## Harness unit blocker census (2026-10-21)

Measured by session D on main `2ea607da3f` merged locally with #6821
(`claude/7106-item1-tail` @ `049471b350`) and #6825. #6821 is included because
it is already in the queue. Lanes: standalone and gc. Harness: the honest
original-harness assembly (`assembleOriginalHarness`), compiled the way the CI
lane compiles it (`allowJs`, `scriptGoal`, `deferTopLevelInit`,
`hostBridge: "always"`, `trackIrOutcomes`, `JS2WASM_IR_SHAPE_DIAG=1`). Corpus:
all 48 tests in `language/expressions/addition/`. None of them has `includes:`,
so the harness is the js2wasm prelude, assert.js (which carries `compareArray`)
and sta.js. propertyHelper does not appear in this directory.

Out of scope as instructed: `Test262Error`, `assert`, `compareArray`.

### Terminal units

- **Already IR on both lanes:** `isNegativeZero`, `isPrimitive`,
  `formatIdentityFreeValue`, `formatSimpleValue`, `$DONOTEVALUATE`
  (47/48 tests).
- **The one in-scope legacy harness unit is `<module-init>`.** Every
  `assert.* = function …` closure sits inside it as a non-terminal
  function-expression unit.
- **Exception: S11.6.1_A1.** Its body makes direct `eval` calls, so every
  harness unit falls back with `resolve:late-preparation-unsupported` ("the
  linked runtime-eval callable carrier is still owned by the direct
  frontend"), and `assert` reads as `expr-ident-not-in-scope`. That is a
  separate arm for eval tests.

### `<module-init>` harness statements

Each harness statement's own first blocker was collected with every statement
evaluated independently. This is a local census-only patch that keeps walking
past the first failing statement; it is not committed. Standalone and gc agree
on every row.

- **Pass in place:** `var print = function …`, `var $262 = {…}` and
  `assert._isSameValue = function …`. The last one has the Stage 2 boolean
  member-closure plan.
- **"Twin" column:** the closure body re-measured as a top-level
  `function __fx_<path>(…) { … }` copy. Its parameters are dynamic and it has
  no callers, which is what a general member-closure plan would hand the body
  walk. Arms are listed in walk order. Each later entry is the first blocker of
  the next failing statement, or the dynamic move-only scan (`move-only`).

| statement | first blocker in `<module-init>` (48 tests) | what comes next (twin) |
| --- | --- | --- |
| `assert.sameValue = function …` | `closure-return-type` (no member-closure plan: return is not boolean, body not closed-scalar) | `new Test262Error` ×2 (`constructor-resolution-unsupported`) → `function-object-member-evidence` on `assert._isSameValue(actual, expected)` (and `assert._toString(…)`) |
| `assert.notSameValue = function …` | `closure-return-type` | `new Test262Error` → `function-object-member-evidence` (`assert._isSameValue`) |
| `assert.throws = function …` | `closure-return-type` | `vardecl-var-kind` (`var expectedName, actualName;`, a function-local `var` list without initialisers) → `new Test262Error` ×2 → `call-resolution-unsupported` `expr-local-call-target «func»` (calling a dynamic param) → move-only `message` (`message += …` on a dynamic) |
| `assert.compareArray = function …` | `closure-return-type` | `operand-coercion-unsupported` `expr-mixed-conditional-proof` (`message === undefined ? '' : message`) → `expr-ident-not-in-scope «compareArray»` (`var format = compareArray.format`, a function-object member read as a value) → `call-resolution-unsupported` `expr-local-call-target «format»` → move-only `message` |
| `compareArray.format = function …` | `closure-return-type` | `array-method-unsupported` (`….join(", ")` on the `any[]` result of `Array.prototype.map.call`; outside #7108's number/string domain) → `expr-ident-not-in-scope «Array»` (ambient `Array.prototype.map.call` as a value, measured on a separate probe) → move-only `arrayLike` |
| `Test262Error.thrower = function …` | `closure-return-type` | `new Test262Error(message)` (`constructor-resolution-unsupported`; move-only flags the same `new` with a dynamic argument) |
| `Test262Error.prototype.toString = function …` | `expr-ident-not-in-scope «Test262Error»` (S3c-a, function value as a receiver chain) | `closure-return-type` (no plan) → `this.message` in a prototype-method closure (the twin cannot model `this`; it reports `unattributed-arm:helper-internal`) |
| `assert._formatIdentityFreeValue = formatIdentityFreeValue;` | `expr-ident-not-in-scope «formatIdentityFreeValue»` (top-level function as a bare value, the RHS of a member write) | none visible. The RHS is an IR-claimed function and the receiver write is the existing function-object write arm. |
| `assert._toString = formatSimpleValue;` | `expr-ident-not-in-scope «formatSimpleValue»` (same arm) | none visible (same reasoning) |

Prelude closures, which are not part of the module-init failure set (twins only):

- **`print`:** move-only `value` (`console.log` of a dynamic) on standalone;
  `host-surface-unavailable «console»` on gc.
- **`$262.IsHTMLDDA` and `$262.gc`:** IR.
- **`$262.detachArrayBuffer`:** `expr-ident-not-in-scope «structuredClone»`
  → move-only `buffer.__detached__` (a member write on a dynamic).
- **`$262.createRealm`:** `vardecl-let-closure` (`var mkerr = function () {…}`)
  → `expr-ident-not-in-scope «globalThis»` → `«$262»` → move-only
  `return realm`.
- **`$262.evalScript`:** `expr-binary-op-instanceof` (`error instanceof
  ReferenceError`) → move-only on the `__js2wasm_global_script_eval` return.

### Ranked arms (harness `<module-init>` statements)

| rank | arm | first blocker for | on the path of | owner / note |
| ---: | --- | --- | --- | --- |
| 1 | **General member-closure plan.** An untyped `F.x = function (…) {…}` RHS on a function-object receiver gets dynamic params and a void/dynamic return, and the ordinary body walk runs. Today `planMemberClosure` admits only boolean-returning closed-scalar bodies, and only on standalone/WASI. | 6 | 7 (adds `prototype.toString`) | Stage 2 owner. It unblocks nothing on its own: every closure has a body blocker behind it. |
| 2 | `new Test262Error(…)` from a closure body (S3c-b) | 0 | 4 (`sameValue`, `notSameValue`, `throws`, `thrower`), plus the first test-body blocker in 17/48 tests | D (S3c-b) |
| 3 | Top-level function as a bare value (S3c-a): RHS of a member write, receiver chain `F.prototype.x =` | 3 | 3 | D (S3c-a). On its own it should clear `_formatIdentityFreeValue` and `_toString`. |
| 4 | Member call on the legacy, untyped `assert` (`function-object-member-evidence`). Needs `assert` as an IR claim, or the planner's claim route mirrored in the selector (#6821 S1h note, #6823). | 0 | 2 (`sameValue`, `notSameValue`) | Stage 2 / #6823 |
| 5 | Calling a dynamic value (`func()`, `format(…)`) | 0 | 2 (`throws`, `compareArray`) | open |
| 6 | Dynamic string accumulation (`message += ' '`, `m === undefined ? '' : m`) | 0 | 2 (`throws`, `compareArray`) | open; item 1 family |
| 7 | Function-object member READ as a value (`compareArray.format`) | 0 | 1 | Stage 2 |
| 8 | Function-local `var a, b;` without initialisers | 0 | 1 (`throws`) | #7105 family |
| 9 | `this` in a prototype-method closure | 0 | 1 (`prototype.toString`) | after S3c |
| 10 | `Array.prototype.map.call(x, String)` plus `join` over `any[]` | 0 | 1 (`compareArray.format`) | array-methods follow-up to #7108 |
| — | Runtime-eval linked callable carrier (eval tests) | whole harness in 1/48 tests | — | separate |

**Minimum sets to finish a closure.** These are inferred from the twin order;
the later arms in each set were not verified by patching. All of `<module-init>`
also needs the test-body arms below.

- `thrower`: arms 1 + 2.
- `sameValue` and `notSameValue`: arms 1 + 2 + 4.
- `throws`: arms 1 + 2 + 5 + 6 + 8.
- `compareArray`: arms 1 + 5 + 6 + 7, plus the call to the legacy `assert`.
- `format`: arms 1 + 10 + the `Array` ambient value.
- `prototype.toString`: arms 3 + 1 + 9.
- `_formatIdentityFreeValue` and `_toString`: arm 3.

### Test-body statements in `<module-init>` (for completeness, standalone)

First failing test-body statement per test (48 tests):

| tests | arm |
| ---: | --- |
| 17 | `constructor-resolution-unsupported` `new Test262Error` |
| 11 | `vardecl-var-kind` (script `var x = 1`) |
| 7 | `expr-ident-not-in-scope «Number»` (ambient `Number.*` value) |
| 3 | `body-exprstmt-other` |
| 3 | BigInt literal (`expr-unhandled`) |
| 2 | `objectlit-ordinary-to-primitive-method` |
| 2 | `expr-ident-not-in-scope «TypeError»` |
| 1 each | `«f1»`, `expr-binary-op-=`, `objectlit-empty` |

Arms touching the most tests anywhere in the body: `new Test262Error` 19,
`vardecl-var-kind` 12, `Number` 8, `TypeError` 7, `new Boolean/Number/String` 5
each.

### Row 2 after the method-call wrapper (2026-10-22, D, measured on #6851)

With #6851 (`__ir_dyn_mcall_<m>_<n>`, [#7119](7119-ir-dynamic-method-call-brand-dispatch-wrapper.md)),
`message = message.toString();` lowers in the IR. That leaves `compareArray.format`'s body
(row 2, `return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";`) as the
only blocker on the unstubbed default-include `<module-init>`.

Measured on standalone (default harness, `assert.sameValue(1, 1)` body; `.tmp/probe-row2.mts`):

| row 2 replaced by | `<module-init>` verdict |
| --- | --- |
| unchanged | `array-method-unsupported` |
| `String(Array.prototype.map.call(arrayLike, String))` (no `.join`) | `expr-ident-not-in-scope «Array»` |
| `var A = Array; …` | `expr-ident-not-in-scope «Array»` |
| `var S = String; … S(arrayLike)` | `expr-ident-not-in-scope «String»` |
| everything stubbed (`String(arrayLike)`) | IR, agrees with node (pinned by `tests/issue-7106-harness-member-rows.test.ts`) |

**The three layers, in walk order:**

1. **`.join(", ")` is routed to the typed-vec arm.** The checker types the
   `map.call(…)` result as an array, so the selector sends `.join` to
   `isPhase1ArraySearchOrJoin` (#7108). That arm serves number/string vecs only
   and refuses an unknown element family. The IR value of that receiver is
   DYNAMIC (it comes out of a dynamic method call), so the dynamic-method arm,
   now the wrapper `join_1`, is the exact route. The fix is a selector
   precedence: a receiver the IR lowers as dynamic (a dynamic call's result)
   takes the dynamic-method arm before the checker-typed array arms.
2. **`Array` and `String` as values.** This is #7118 (`dyn.global_object`, PR
   #6846, held).
3. **`Array.prototype.map.call(arrayLike, String)` itself.** After 2, this is a
   dynamic member chain plus `__ir_dyn_mcall_call_2`, which reads `call` and
   then runs legacy's reflective `.call`. Not yet measured: whether that `.call`
   invokes a native intrinsic function value (`%Array.prototype.map%`) with a
   host-free `String` function value as the callback.

**Plan.** This is not an exact arm without #7118, so nothing was built here.
Once #7118 lands:
- measure layer 3 on its own, comparing against node (`[1, 2]`, a typed array,
  `{ length: 2, 0: "a", 1: "b" }`, an `arguments` object);
- if layer 3 is exact, land layer 1 as one selector slice with those tests;
- if not, the residue is legacy's reflective `.call` on an intrinsic value.
  Report that rather than porting `array-prototype-borrow.ts`.

### Method notes

- **The "next" arm is approximate.** The census tool skips the whole failing
  top-level statement, so a second blocker inside the same statement is only
  visible when the move-only scan reports it.
- **The twins model a general member-closure plan.** They give the body
  dynamic params; they do not model `this`, captured outer bindings, or a
  closure's return-type authority.
- **Nothing was implemented.** The instrumentation lived only in the local
  probe build.

## Integrated-stack census, 2026-10-22

**Answer:** on the whole in-flight stack, 0 of the 266 sampled tests that compile
have zero legacy units, so `ir_only_pass` stays near 2. One harness statement
gates everything: `compareArray.format`'s
`Array.prototype.map.call(arrayLike, String).join(", ")` (assert.js:179) is
refused in 238/266 tests. In 10 tests it is the only blocker, and 9 of those 10
already pass. Fixing that statement alone should therefore give about +9 per
300 tests, roughly **+1,450 `ir_only_pass`** on the 48,232-row corpus. No other
single fix moves the number on its own.

### Setup

- **Integration branch.** Local only, never pushed. Built from `origin/main`
  `55d7490c` by merging the heads of #6829, #6831, #6833, #6835, #6846, #6843,
  #6847, #6845, #6830, #6832, #6834, #6839, #6851, #6848, #6850 and #6852.
  All 16 merged.
- **Conflicts.** All were additive and resolved by keeping both sides:
  - capability unions in `src/ir/backend/legality.ts` and `select.ts`;
  - resolver methods in `from-ast.ts` and `integration.ts`;
  - `scripts/ir-kind-neutrality-baseline.json` entries (`dyn.global_object` and `dyn.instanceof`);
  - this file's `largestSccSize` grant (taken at 727, both comment blocks kept).

  One resolution was semantic. In `select.ts` `isPhase1VarDecl`, #6835's
  script-`var` redeclaration/no-op arms run first, then #6830's
  `uninitializedVarIsDynamicUndefined` arm for the remaining initializer-less
  `var`s.
- **Not included:** #6853 (#7123 refinement) and #6854 (#7125 string `var`
  slots). Both were opened while this census ran.
- **Sanity check.** `typecheck` is clean. The stack's own tests pass (64/65)
  across 8 files: 7106-assert-member-calls, 7106-script-var, 7118,
  7106-s3c-test262error, 7120, 7117, 7106-prophelper-isenumerable and 7124.
  The one failure is
  `issue-7124-module-init-all-rejects › records every rejected top-level statement`.
  Its expected labels predate #6835: `var obj = {}` now reports
  `vardecl-module-storage-unrepresentable` instead of `vardecl-var-kind`, and
  `var g = function…` reports `vardecl-let-closure`. This is an interaction
  between the two PRs, not a merge error. Whichever of #6852 and #6835 lands
  second has to update that expectation.
- **Census.** Standalone, with `N=300 SEED=11`, `JS2WASM_IR_SHAPE_DIAG=1` and
  `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.
  - The sample is a mulberry32 shuffle of `test262/test/**/*.js` (52,092
    files; `staging/` and `_FIXTURE` files excluded), taking the first 300
    files `shouldSkip` keeps (302 scanned).
  - Each file is compiled the way the honest standalone lane compiles it:
    `assembleOriginalHarness().primary`, `allowJs`, `target: "standalone"`,
    `scriptGoal: isScriptGoal(…)`, `deferTopLevelInit`,
    `hostBridge: "always"`, `validate: false` and `trackIrOutcomes`.
  - A legacy unit counts the way `scripts/test262-worker.mjs`
    `summarizeIrRoute` counts it: executable, with no IR body emitted.
  - The census script is pasted at the end of this section. It is an
    ungated, one-off probe, so it is not under `scripts/`.

### Shape of the sample

| | tests |
| --- | ---: |
| sampled | 300 |
| compile error / no executable units (21 are negative syntax tests) | 34 |
| compiled, IR ledger present | 266 |
| … 0 legacy units | **0** |
| … 1 blocker | 10 |
| … 2 blockers | 32 |
| … ≥3 blockers | 224 |
| `<module-init>` claimed by IR | 0 |
| only `<module-init>` legacy (every function unit is IR) | 128 |
| at least one harness function unit legacy | 110 |
| at least one test-defined function unit legacy | 62 |

- **No real zero-legacy rows.** Every zero-legacy row in the raw output (23)
  is a compile error with no executable units, so `runTest262File` had no
  zero-legacy row to run. Such rows are not `ir_measured`, so they cannot
  count toward `ir_only_pass` either.
- **Volume.** There are 1,142 legacy units across the 266 compiled tests,
  4.3 per test. `<module-init>` rejects 7.7 top-level statements per test
  (median 4).
- **What a blocker is.** Each legacy function unit counts as one blocker,
  keyed by its owner file, reason and arm. Each rejected `<module-init>`
  statement counts as one blocker, keyed by reason, arm, and whether its
  text sits in the harness or in the test body. `expr-ident-not-in-scope` is
  keyed by the identifier.

### Shortest path: 1- and 2-blocker tests

| tests | blocker (reason @ arm) | example |
| ---: | --- | --- |
| **10 (1-blocker)** | harness `<module-init>` `array-method-unsupported@expr-array-search-element-family` | `compareArray.format = function (arrayLike) { return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]"; }` |
| 32 (2-blocker) | the same statement, plus one of the rows below | |
| 9 + 1 | test `closure-return-type` | `assert.throws(RangeError, function() { new SharedArrayBuffer(0, { maxByteLength: -1 }); })` |
| 3 | test `vardecl-module-storage-unrepresentable` | `var obj = { *method({ arrow = () => {} } = {}) { … } }` |
| 2 | harness `array-method-unsupported` (`unattributed-arm`) | same statement, other arm |
| 2 | test fn `destructuring-param-complex` | `function f([…] = …)` |
| 1 each | `body-exprstmt-other` `() => 42`; ident `Number` / `Array` / `Object` / `Test262Error`; `expr-delete-no-ir-lowering` `delete x`; `expr-new-error-constructor` `new Error("hello")`; `expr-new-callee-nonident` `new Temporal.ZonedDateTime`; `expr-new-date-target` `new Date(0)`; BigInt literal; `new Boolean`; `throw-module-scalar-unboxed`; `for-init-var-kind`; `vardecl-init-expr`; `nontail-module-compound` `first += 1` | |

**Conformance of the 1-blocker tests.** `runTest262File(…, "standalone")` was
run on the integration branch, with the QuickJS provider built. 9/10 pass:
- S9.3.1_A7
- endsWith_Fail_2
- 15.5.4.20-4-10
- S11.8.4_A4.12_T2
- S11.9.4_A3
- `_implements`
- `char`
- S7.8.4_A4.1_T2
- between-horizontal-tab

`module-code/instn-resolve-empty-import.js` fails ("This statement should not
be evaluated."), independent of the IR. So the IR-only gain from fixing this
one statement is **9/300**, provided the IR body of `<module-init>` then runs
correctly.

### Most common blockers overall (tests carrying them, of 266)

| tests | blocker | example |
| ---: | --- | --- |
| 238 | harness `<module-init>`: `compareArray.format`'s `.join` on the `any[]` result of `Array.prototype.map.call` | assert.js:179 |
| 103 | test `vardecl-module-storage-unrepresentable` (script `var` whose `__mod_` slot is neither scalar nor the externref home: objects, arrays, class instances, closures) | `var executed = false` in an eval test, `var obj = {…}` |
| 59 | test `closure-return-type` (function expression passed as an argument, e.g. to `assert.throws`) | `function() { f; }` |
| 49 / 36 | harness prelude `var $262 = {…}` (`vardecl-module-storage-unrepresentable`) / `var print = function…` (`vardecl-let-closure`) | |
| 46 | test `expr-module-scalar-method` | `jan31.subtract({ seconds: -30 })`, `f().next().then(…)` |
| 42 / 40 / 30 / 20 | identifiers out of scope in `<module-init>`: `Object`, `Test262Error`, `Array`, `Function` (as receivers, refused by #7123, or `Test262Error` as a value) | |
| 37 | doneprintHandle.js `$DONE` (`expr-binary-op-in` `'name' in error`) and `__consolePrintHandle__` (move-only `msg`) | every `flags: [async]` test |
| 28 | the whole assert.js + sta.js harness, `late-preparation-unsupported` ("the linked runtime-eval callable carrier is still owned by the direct frontend") | tests with direct `eval` / `$262.evalScript` |

### Which harness units are still legacy

| file | tests (of 266) | units and arms |
| --- | ---: | --- |
| assert.js | 38 | In 28 tests (eval) every unit is legacy: `late-preparation-unsupported`, then `assert`/`compareArray` read `assert` out of scope. In 8 tests `assert` fails with `unknown class "Test262Error" in assert` (from-ast). In 6 tests `assert` fails with `call-graph-closure`. Outside these, assert.js's function units ship IR. |
| sta.js | 36 | `Test262Error` `return-type-unresolved(lattice=dynamic)` in the 28 eval tests, `logical-value-family` (`message \|\| ""`) in 8; `$DONOTEVALUATE` eval carrier (28). |
| doneprintHandle.js | 35 | `$DONE` (`'name' in error`) and `__consolePrintHandle__` (move-only `msg`). Blocks every async test. |
| propertyHelper.js | 22 | about 14 units per test. Blockers: `isConfigurable` (`e instanceof TypeError`, ambient ctor RHS); `verifyAccessorProperty`/`verifyCallableProperty` (`logical-value-family`, `param-type-unresolved(desc)`); `verifyProperty`/`isWritable`/`verifyPrimordial*` (`vardecl-module-binding-alias`); `isEnumerable` (`expr-module-value-logical`); `verifyNot*` (`expr-module-value-not`); `verify{Writable,Enumerable,Configurable}` (`call-graph-closure`); `verifyEqualTo` (`abi-signature-parity`, IR typeIdx 182 ≠ legacy 97). |
| temporalHelpers.js | 18 | `formatPropertyName` `param-shape-rejected` (plus most `<module-init>` Temporal statements). |
| isConstructor.js | 6 | `Reflect` out of scope. |
| testTypedArray.js | 5 | `Array`, `Int32Array`, `nonAtomicsFriendlyTypedArrayConstructors` out of scope; `\|\|` defaults; `++i`; function-local `var`. |
| regExpUtils.js, asyncHelpers.js, detachArrayBuffer.js, resizableArrayBufferUtils.js, fnGlobalObject.js, promiseHelper.js | 1–5 each | not broken down |

### Forecast

The forecast greedily fixes the blocker class that most increases the number
of zero-legacy tests, breaking ties by frequency. The corpus figure scales by
48,232 / 300.

| k | blocker class fixed | zero-legacy (of 266) | ≈ corpus |
| ---: | --- | ---: | ---: |
| 1 | harness `compareArray.format` statement | 10 (9 pass) | ~1,450 |
| 2 | + test `closure-return-type` | 19 | ~3,050 |
| 3 | + test `vardecl-module-storage-unrepresentable` | 23 | ~3,700 |
| 4 | + `expr-new-callee-nonident` (`new Temporal.X`) | 27 | ~4,350 |
| 5 | + `expr-module-scalar-method` | 30 | ~4,800 |
| 6 | + ident `Temporal` | 35 | ~5,600 |
| 7 | + `expr-new-ctor-unknown` | 39 | ~6,250 |
| 8 | + test `vardecl-let-closure` | 43 | ~6,900 |
| 9 | + ident `Object` | 46 | ~7,400 |
| 10 | + ident `Test262Error` | 49 | ~7,900 |
| 12 | + `vardecl-class-expression-unprepared`, `expr-module-storage-unrepresentable` | 57 | ~9,150 |

**Why these are upper bounds.** A key from k ≥ 2 is an arm class, not one
fix, and `closure-return-type` covers many distinct closure bodies. A
`<module-init>` statement also reports only its first rejection, so a fixed
arm can expose the next one inside the same statement. The "≈ corpus" column
counts zero-legacy rows, not passes: `ir_only_pass` additionally needs
PASS, which was 9/10 at k=1. Measure k ≥ 2 again after each step instead of
trusting this table.

### Next steps

1. **`compareArray.format` (assert.js:179).** It is the sole blocker in 10/266
   tests and present in 238/266. Size M. **Expected Δ: about +9/300, about
   +1,450 `ir_only_pass`.** Three refusals sit inside the one statement,
   probably in this order (only the first was observed directly):
   - `.join(", ")` on the dynamic `any[]` result. Route it through #6851's
     `__ir_dyn_mcall_join_1` wrapper instead of refusing on the element
     family.
   - `Array.prototype.map` as a member read off an ambient intrinsic. #7123
     refuses this until the brand companion is seeded for
     `<Builtin>.prototype` reads.
   - `String` as a call argument value.

   Before claiming the statement, verify that the IR body matches legacy on
   `compareArray.format([1, "a", undefined])` output.
2. **Test-body closures as call arguments (`closure-return-type`).** A general
   closure plan with dynamic parameters and a dynamic/void return, the
   Stage 2 "rank 1" arm, applied to argument position. 59/266 tests. Size L.
   Expected Δ: +9/300 more once step 1 lands (k=2, about +1,450).
3. **Script `var` storage beyond scalars.** Object, array, class-instance and
   closure slots for `__mod_` (#7125 / #6854 covers strings; arrays and
   `new C()` are listed there as left). This also unblocks the harness prelude
   `$262`/`print`. 103 + 49 tests. Size L. Expected Δ: +4/300 after steps 1–2
   (about +650), and it is a prerequisite for most of the ≥3-blocker tail.
4. **Ambient identifiers as values and receivers** (`Object` 42,
   `Test262Error` 40, `Array` 30, `Function` 20, `Temporal` 13). This means
   lifting #7123's member-read refusal by seeding the companion and fixing
   inherited `Function.prototype` reads in `__extern_get`, and admitting
   `Test262Error` as a value. Size M. Expected Δ: +3 to +5/300 combined with
   steps 1–3.
5. **doneprintHandle.js** (`'name' in error`, move-only `msg`). Size S–M. On
   its own Δ is 0, but it is the gate for all `flags: [async]` tests (35/266).
6. **The runtime-eval linked callable carrier** (28/266 tests have the whole
   harness legacy). Size L. Δ is 0 until steps 1–4 land: these tests also
   need `eval` lowering.
7. **propertyHelper.js** (22/266). The 14 units per test fall into 7 arm
   families, listed in the harness table. Size L. Δ is 0 on its own: these
   tests also carry the step 1–4 blockers.

<details><summary>Census script (<code>.tmp/ir-census.mts</code>, run with <code>N=300 SEED=11 npx tsx .tmp/ir-census.mts &gt; census.json</code>)</summary>

```ts
// Unmasked IR legacy-unit census over a seeded standalone test262 sample.
// N=300 SEED=11 npx tsx .tmp/ir-census.mts > .tmp/census.json
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

process.env.JS2WASM_IR_SHAPE_DIAG = "1";
process.env.JS2WASM_IR_MODULE_INIT_ALL_REJECTS = "1";

const { compile } = await import("../src/index.ts");
const { parseMeta, shouldSkip } = await import("../tests/test262-runner.ts");
const { assembleOriginalHarness } = await import("../tests/test262-original-harness.ts");
const { test262CompileSemanticProviders } = await import("../scripts/test262-lane.mjs");
const { isScriptGoal } = await import("../scripts/test262-module-goal.mjs");

const ROOT = join(process.cwd(), "test262");
const N = Number(process.env.N ?? 300);
const SEED = Number(process.env.SEED ?? 11);

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "staging") continue;
      walk(p, out);
    } else if (name.endsWith(".js") && !name.includes("_FIXTURE")) out.push(p);
  }
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const all: string[] = [];
walk(join(ROOT, "test"), all);
const rnd = mulberry32(SEED);
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}

// harness file -> declared function names (top-level `function f` and `x.f = function`)
const harnessDecls = new Map<string, string>();
for (const f of readdirSync(join(ROOT, "harness"))) {
  if (!f.endsWith(".js")) continue;
  const src = readFileSync(join(ROOT, "harness", f), "utf8");
  for (const m of src.matchAll(/^\s*function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) if (!harnessDecls.has(m[1])) harnessDecls.set(m[1], f);
  for (const m of src.matchAll(/([A-Za-z_$][\w$.]*)\s*=\s*function\b/g)) {
    const leaf = m[1].split(".").pop()!;
    if (!harnessDecls.has(leaf)) harnessDecls.set(leaf, f);
  }
}

const rows: unknown[] = [];
let scanned = 0;
for (const file of all) {
  if (rows.length >= N) break;
  scanned++;
  const source = readFileSync(file, "utf8");
  const meta = parseMeta(source);
  if (!meta.negative && shouldSkip(source, meta, file).skip) continue;
  const rel = relative(ROOT, file);
  const asm = assembleOriginalHarness(source, meta);
  let result: any;
  const t0 = Date.now();
  try {
    result = await compile(asm.primary.source, {
      allowJs: true,
      fileName: "test.js",
      emitWat: false,
      skipSemanticDiagnostics: true,
      validate: false,
      inferModuleStrictArguments: meta.flags?.includes("module") === true,
      target: "standalone",
      semanticProviders: test262CompileSemanticProviders(process.env.TEST262_SEMANTIC_PROVIDERS),
      deferTopLevelInit: true,
      scriptGoal: isScriptGoal(rel.replace(/^test\//, ""), meta),
      hostBridge: "always",
      trackIrOutcomes: true,
    } as never);
  } catch (e) {
    rows.push({ file: rel, negative: !!meta.negative, compileThrew: String(e).slice(0, 200) });
    continue;
  }
  const outcomes = (result.irOutcomes ?? []) as any[];
  const legacy = outcomes
    .filter((o) => o && o.kind !== "non-executable" && !o.irBodyEmitted)
    .map((o) => {
      const name = String(o.displayName ?? o.name ?? "?");
      const leaf = name.split(".").pop()!;
      const owner = name === "<module-init>" ? "module-init" : (harnessDecls.get(leaf) ?? "test");
      const rejects =
        name === "<module-init>" && typeof o.detail === "string"
          ? o.detail.split(" | ").map((d: string) => {
              const m = /^([^@:]+)@([^:]+):(\w+)\s*«([\s\S]*)»?$/.exec(d);
              const text = m ? m[4].replace(/»$/, "") : d;
              return {
                reason: m?.[1] ?? o.code,
                arm: m?.[2] ?? "?",
                node: m?.[3] ?? "?",
                text: text.slice(0, 160),
                inTestBody: text.length > 0 && source.includes(text.slice(0, 60)),
              };
            })
          : undefined;
      return { name, owner, kind: o.kind, stage: o.stage, code: o.code, detail: rejects ? undefined : o.detail, rejects };
    });
  rows.push({
    file: rel,
    negative: !!meta.negative,
    success: !!result.success,
    units: outcomes.filter((o) => o && o.kind !== "non-executable").length,
    legacy,
    ms: Date.now() - t0,
  });
  if (rows.length % 25 === 0) process.stderr.write(`${rows.length}/${N} (scanned ${scanned})\n`);
}
process.stdout.write(JSON.stringify({ N, SEED, corpus: all.length, scanned, rows }, null, 1));
```

Analysis (`node .tmp/ir-census-analyze.mjs census.json`):

```js
// node .tmp/ir-census-analyze.mjs .tmp/census.json
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const norm = (t) => t.replace(/\s+/g, "");
const ce = d.rows.filter((r) => !r.compileThrew && (!r.success || r.units === 0));
const rows = d.rows.filter((r) => !r.compileThrew && r.success && r.units > 0);
for (const r of rows) {
  const src = norm(readFileSync(`test262/${r.file}`, "utf8"));
  for (const u of r.legacy) for (const x of u.rejects ?? []) x.inTestBody = norm(x.text).length > 0 && src.includes(norm(x.text).slice(0, 50));
}
const threw = d.rows.filter((r) => r.compileThrew);

// A blocker key: a legacy non-module-init unit is keyed by owner+code+arm(detail head);
// each rejected module-init statement is keyed reason@arm, plus whether it is harness or test text.
function unitArm(u) {
  const m = /^([^:«]+)(?::\w+)?\s*(?:«([^»]*)»?)?/.exec(u.detail ?? "");
  if (!m) return "";
  return m[1].trim() === "expr-ident-not-in-scope" ? `${m[1].trim()}(${m[2]})` : m[1].trim();
}
function blockersOf(r) {
  const keys = new Map();
  for (const u of r.legacy) {
    if (u.name === "<module-init>") {
      if (!u.rejects) {
        keys.set(`MI ${u.code}@${unitArm(u)}`, { ex: u.detail });
        continue;
      }
      for (const x of u.rejects) {
        if (x.arm === "expr-ident-not-in-scope") {
          keys.set(`MI ${x.reason}@${x.arm}(${x.text})`, { ex: x.text });
          continue;
        }
        const where = x.inTestBody ? "test" : "harness";
        keys.set(`MI[${where}] ${x.reason}@${x.arm}`, { ex: x.text });
      }
    } else {
      keys.set(`FN[${u.owner}] ${u.code}@${unitArm(u)}`, { ex: `${u.name}: ${u.detail ?? ""}`.slice(0, 140) });
    }
  }
  return keys;
}
const hist = { 0: 0, 1: 0, 2: 0, "3+": 0 };
const by = { 1: new Map(), 2: new Map() };
const all = new Map();
const perTest = [];
for (const r of rows) {
  const b = blockersOf(r);
  perTest.push({ file: r.file, keys: [...b.keys()] });
  const n = b.size;
  hist[n >= 3 ? "3+" : n]++;
  for (const [k, v] of b) {
    const e = all.get(k) ?? { tests: 0, ex: v.ex };
    e.tests++;
    all.set(k, e);
    if (n === 1 || n === 2) {
      const m = by[n].get(k) ?? { tests: 0, ex: v.ex };
      m.tests++;
      by[n].set(k, m);
    }
  }
}
const top = (m, k = 25) => [...m].sort((a, b) => b[1].tests - a[1].tests).slice(0, k);
console.log(`compiled rows=${rows.length} CE/no-units=${ce.length} (negative ${ce.filter((r) => r.negative).length}) compileThrew=${threw.length} corpus=${d.corpus} scanned=${d.scanned}`);
console.log("legacy-units histogram:", JSON.stringify(hist));
const zero = rows.filter((r) => r.legacy.length === 0).map((r) => r.file);
console.log("zero-legacy:", JSON.stringify(zero));
for (const n of [1, 2]) {
  console.log(`\n== ${n}-blocker tests: ranked blockers`);
  for (const [k, v] of top(by[n])) console.log(`${String(v.tests).padStart(4)}  ${k}  «${String(v.ex).slice(0, 100)}»`);
}
console.log("\n== all blockers, by tests carrying them");
for (const [k, v] of top(all, 40)) console.log(`${String(v.tests).padStart(4)}  ${k}  «${String(v.ex).slice(0, 100)}»`);

// harness units still legacy
const hu = new Map();
for (const r of rows)
  for (const u of r.legacy)
    if (u.owner !== "module-init" && u.owner !== "test") {
      const k = `${u.owner}::${u.name} ${u.code}@${unitArm(u)}`;
      const e = hu.get(k) ?? { tests: 0, ex: u.detail };
      e.tests++;
      hu.set(k, e);
    }
console.log("\n== harness units legacy");
for (const [k, v] of top(hu, 40)) console.log(`${String(v.tests).padStart(4)}  ${k}  «${String(v.ex ?? "").slice(0, 90)}»`);

// greedy forecast: fix top-k blockers (by tests unlocked) -> tests reaching zero
const sets = perTest.map((t) => new Set(t.keys));
const fixed = new Set();
console.log("\n== greedy forecast (fix blocker -> cumulative zero-legacy tests)");
const zero0 = sets.filter((s) => s.size === 0).length;
console.log(`k=0  zero=${zero0}`);
for (let k = 1; k <= 12; k++) {
  let best = null;
  let bestGain = -1;
  const cands = new Map();
  for (const s of sets) {
    const rest = [...s].filter((x) => !fixed.has(x));
    if (rest.length === 0) continue;
    for (const x of rest) cands.set(x, (cands.get(x) ?? 0) + 0);
  }
  for (const x of cands.keys()) {
    const f2 = new Set(fixed).add(x);
    const gain = sets.filter((s) => s.size > 0 && [...s].every((y) => f2.has(y))).length;
    const freq = sets.filter((s) => s.has(x)).length;
    const score = gain * 1000 + freq;
    if (score > bestGain) {
      bestGain = score;
      best = x;
    }
  }
  if (!best) break;
  fixed.add(best);
  const z = sets.filter((s) => [...s].every((y) => fixed.has(y))).length;
  console.log(`k=${k}  +${best}  zero=${z}  (~${Math.round((z / d.rows.length) * 48232)} of 48,232)`);
}
```

</details>

## `compareArray.format` — the `Array.prototype.<m>.call(recv, …)` arm (built 2026-10-22)

The integrated census above names one blocker in 238 of 266 compiled tests:
assert.js:179, `Array.prototype.map.call(arrayLike, String).join(", ")`. The
layer-by-layer measurement reduced it to a single question — the IR has no
exact value for `Array.prototype.map` (#7123) — and the plan's second candidate
is what is built: the whole borrow is ONE reflective call, and the method value
is never materialized.

**Modules (one concern each, no duplicated AST walk).**

| piece | module | reuse |
| --- | --- | --- |
| shape + naming contract (`matchArrayPrototypeBorrowCall`, `__ir_arr_borrow_<m>_<n>`) | `src/ir/array-prototype-borrow-call.ts` | the per-(method, arity) symbol helpers now shared with the #7119 wrapper (`irWrapperSymbol` / `parseIrWrapperSymbol`, lifted out of `dynamic-method-call-names.ts`) |
| wrapper builder | `src/codegen/array/ir-array-prototype-borrow.ts` | the helper context and its publication are main's `helperFunctionContext` / `publishHelperFunction` (`codegen/helpers/ir-helper-function.ts`, revive 2026-10-29); the template mechanics `parseDetachedTemplate` / `compileTemplateExpressionAs` are one module, `codegen/helpers/template-wrapper.ts`, which the #7119 wrapper (`object-model/ir-dynamic-method-call.ts`) imports too (its inline parse removed) |
| admission | `irArrayPrototypeBorrowAdmitted(ctx, call, method, resultReachesTypedSlot)` answers the selector option `arrayPrototypeBorrow` (the lane is the `dynamic-method-call-wrapper` capability; the nameable pair is the IR's own shape match in `matchArrayPrototypeBorrowCall`, so codegen does not re-check it): legacy's `arrayPrototypeBorrowCompilesHostFree` (its `ARRAY_METHODS` minus its standalone refusals) and, where the selector says the value reaches a typed slot (anything but a member receiver or a discarded statement value), legacy's own typing of the borrow — `resolveWasmType` of the call's checker type through the shared `carrierOf` (`struct-carrier-inhabits.ts`), plus the oracle's `void` fact — must be one the IR's dynamic carrier reaches (externref, f64, i32, the lane's string carrier). The from-ast resolver re-reads only the lane (`irArrayPrototypeBorrowWrapperLane`); finalize's `ensureIrArrayPrototypeBorrowHelper` re-reads it again and builds — a method the lane excludes is legacy's loud refusal, never a template error, so the builder keeps no error-truncating branch | no second method list, no second typing: the ABI question is asked of the same `resolveWasmType` legacy's signature derivation uses |
| selector | `ambientArrayPrototypeBorrowCall` beside `ambientObjectToStringTagCall`; the same three sites (move-only scan, Phase-1, external-call walk) plus `isDynShaped` (the result is the carrier) and one Phase-1 arm so a method call ON the result is a dynamic-receiver call, whatever the checker types the borrow | the #7119 wrapper carries `.join` on the result |
| from-ast | `lowerArrayPrototypeBorrowCall`, intercepted before receiver lowering like the `Object.prototype.toString.call` arm; argument boxing shared with the dynamic method call through the new `lowerDynamicOperands` (one loop, was two) | — |

**Semantics.** The wrapper is legacy's `compileArrayPrototypeCall` over the
template `Array.prototype.<m>.call(recv, a0, …)` with externref parameters, so
the receiver takes the `any`-receiver arm — the array-like loop a legacy site
with an untyped receiver takes. A shadowed `Array` (parameter, local, module
binding) never reaches the arm: the identifier must be the unshadowed ambient
binding (`selectorSeesAmbientBinding` + scope, as the toString-tag arm).

**Measured (standalone, `tests/issue-7106-ir-array-prototype-borrow.test.ts`,
compared with node):** `map`+`String`-shaped callback then `.join`, `join`,
`reduce` with an initial value, `filter` then `.join`, `some` through `String(…)`
— IR bodies calling `__ir_arr_borrow_{map_1,join_1,reduce_2,filter_1,some_1}`,
answers equal to node for an array-like, a real array, `[]` and the harness's
own row shape `[1, "a", undefined]` → `"[1, a, undefined]"` (with the callback
as a parameter; the harness's `String`-as-value callback is item 3 below).

**gc delta (byte-identity).** A gc/web/node build of a program WITHOUT the
admitted shape is byte-identical to #6851; one WITH it is not — under the
native-regime projection (#5385) the function becomes an IR body there too,
as every IR admission on that lane does.

**Left out, on purpose.** (1) `push` and the standalone-refused borrows (legacy
refuses them loudly; the wrapper would turn that diagnostic into an integration
error). (2) A member READ off the result (`….length`) keeps the checker's typing
of the borrow (`any[]`), so from-ast's `+` demotes it (`string/number`) — a
safe demote, measured, not a miscompile; the harness unit only calls `.join`.
(3) The real `compareArray.format` also needs `String` as a value (#7118,
#6846) — this branch carries the arm and its test; the harness measurement is
on the integrated stack. (4) **A borrow whose value reaches a typed slot while
legacy types it past the carrier** (review round 2). Legacy types the enclosing
function's ABI from the checker's type of the borrow; the IR returns the
carrier. In return position that is `any[]` → `ref_null __vec_externref` for
slice / splice / reverse / sort / fill / flat / with / copyWithin / map /
filter / concat / flatMap / toReversed / toSorted / toSpliced, and `void` → no
result slot for forEach: each claimed, built, and demoted at finalize
(`abi-signature-parity`, 16 of the admitted methods, measured standalone), with
the unit's `__ir_arr_borrow_<m>_<n>` wrapper left in the module unreferenced
(the #6768 reachability sweep stubs it to one `unreachable` on standalone;
physical removal is deliberately not done, see that pass). The selector now
refuses these before any claim (`tests/issue-7106-ir-array-prototype-borrow.test.ts`
asserts the post-claim ledger stays empty and no `__ir_arr_borrow_` symbol is
published); as a member receiver (`….join(", ")`, `…[0]`) or a discarded
statement value the same methods stay admitted — the harness's own
`Array.prototype.map.call(arrayLike, String).join(", ")` shape. Methods whose
result legacy types as `any` (pop / shift / at / find / findLast / reduce /
reduceRight), `string` (join), `boolean` / `number`, or a host iterator
(keys / entries / values → externref) stay admitted in every position. Still
open, pre-existing and not the borrow's: a function whose *parameter* legacy
infers from such a call site (`g(Array.prototype.slice.call(a))` types `g`'s
`x` as `any[]`) demotes `g` through the same parity guard (#3536 class), as it
does for any `any[]`-typed argument.

## `<module-init>` lever A — ambient `Number.<CONST>` / `Math.<CONST>` fold (built 2026-10-22)

Arm A of the plan in #6876 (the 80-file census on the integrated stack:
`expr-ident-not-in-scope «Number»` first among the `<module-init>` blockers,
37 of 71). The read folds, in the IR, to the SAME constant legacy's dot read
emits.

| piece | where | reuse |
| --- | --- | --- |
| the table | `builtinNamespaceConstantValue` in `codegen/builtin-value-read.ts` — `MATH_CONSTANT_VALUES` / `NUMBER_CONSTANT_VALUES`, own keys only; legacy's `tryEmitBuiltinNamespaceConstantValue` now reads through it | no second list anywhere |

**Legacy gc output changes for one shape (disclosed, 2026-10-24 review).** The
table lookup went from `propName in table` to `Object.hasOwn`, and that is
legacy's reflective read too: on main `Math["constructor"]` /
`Number["toString"]` emitted `f64.const` of the prototype function's text (NaN
at runtime; `Math["constructor"] === Object` answered 0, node 1). Now those
keys take the generic element read on every lane (`Math["constructor"] ===
Object` → 1, measured default / host-assisted / standalone). Dot reads of the
same names already took the method path and are byte-identical. Covered by the
prototype-key case in `tests/issue-7106-ir-ambient-namespace-constants.test.ts`.
| bridge | `irAmbientNamespaceConstant(expr)` in `ir/integration.ts`, the one answer behind the selection option and the from-ast resolver, supplied at both planning sites | — |
| selector | `ambientNamespaceConstantRead` (ambient predicate; the caller's `scope` / `dynNames` settles a local shadow) at the Phase-1 property-access arm and the move-only scan (a concrete f64) | — |
| from-ast | the first arm of `lowerPropertyAccess`: `emitConst f64` | — |

**Measured** (`tests/issue-7106-ir-ambient-namespace-constants.test.ts`,
standalone and default, compared with node): `MAX_VALUE`, `MIN_VALUE`,
`EPSILON`, `NaN`, `±Infinity`, `MAX/MIN_SAFE_INTEGER`, `Math.PI/LN2/SQRT2/
SQRT1_2` in functions ship IR bodies; a `<module-init>` of
`var eps = Number.EPSILON; var big = Number.MAX_VALUE; …` ships an IR body
(was `expr-ident-not-in-scope «Number»`). A module-level `var Number = {…}`
is never folded by the IR (the function is declined, not miscompiled).

**Found on the way (legacy, not IR) — to file.** Legacy's dot-read fold
ignores a shadowing binding: with `var Number = { MAX_VALUE: 7 }` (module
level) or a parameter named `Number`, legacy still emits `1.7976931348623157e+308`
(node answers the shadow's value). Measured on both lanes; the IR declines
both shapes. `claim-issue.mjs --allocate` was refused here (open-PR scan
degraded, no `gh` GraphQL from this session), so the id is left for a lane
with `gh`.

## `<module-init>` lever B — `Number(v)` through its host-free provider (built 2026-10-22)

The 37 «Number» module-init blockers of the census are `Number(…)` calls.
from-ast already lowered a source-bound `Number(v)` (`lowerPreparedNumberCall`
→ intrinsic `js.number.from-value`, the full ToNumeric contract), but nothing
reached it: no selector admission, a plan invalidated by any `Number.X` /
`new Number` in the file, no plan on the integration from-ast resolver, and —
decisive — **no provider for the intrinsic on any lane**.

| piece | where | reuse |
| --- | --- | --- |
| provider | `native.js.number.from-value` (`ir/runtime/number-conversion-callable.ts`, in `SEMANTIC_CALLABLE_RUNTIME_PROVIDERS`), symbol `__ir_number_from_value` | the manifest's `runtime-callable` shape, like `REFERENCE_ERROR_RUNTIME_PROVIDERS` |
| the function | `codegen/helpers/ir-number-from-value.ts`: legacy's own `Number(v)` emission (`call-identifier.ts`) over a detached template with one externref parameter — the symbol guard, StringToNumber, the array/object ToPrimitive arms, the ToNumber cascade, byte for byte | `receiverHelperContext` / `publishReceiverHelper` from `codegen/ir-dynamic-construct.ts` (exported, one copy) and the detached parse in `codegen/helpers/template-wrapper.ts` |
| resolution | `resolveAndObserveCallableProvider` maps the intrinsic to the helper; pre-registered at finalize from the IR scan (`usesNumberFromValue`) so no Phase-3 body drives a late-import shift | the dyn.object_tag pattern |
| admission | capability `native-number-conversion` (host-free, non-fast, wasmgc) + the plan's own answer (`preparedNumberCall`, built once per compile in `planIrOverlay` and carried to integration on `IrIntegrationLoweringPlans`); `preparedNumberConversionCall` at the three selector sites beside `String(v)`, without a name check at any of them | the plan is the single authority on shadowing (checker-symbol identity of the callee) |
| order | the #5092 mixed-conditional arm (`Number(c ? 7 : true)`, each concrete arm converted inside the lazy `if`) comes FIRST in both `lowerCall` and `preparedNumberConversionCall` (which refuses that shape); lever B sees only what #5092 declined. `tests/issue-5092-ir-mixed-primitive-conditional.test.ts` 21/21, and that program's binary is byte-identical to main on default, host-assisted and standalone | — |
| plan | `prepare-number-conversion.ts`: a member-access receiver (`Number.MAX_VALUE`) or a `new Number(…)` callee keeps the plan — neither reads the binding as a value that could be rebound | — |

**Measured** (`tests/issue-7106-ir-number-conversion.test.ts`, standalone vs
node): a dynamic operand answers node on `{valueOf}`, `[5]`, `"0x10"`,
`null`, `undefined`, `true`, `"abc"`, `new Number(9)`, `{toString}`,
`Symbol()` → TypeError, `[]`, `[1,2]` (2047/2047); legacy's SITE arm for the
same program answers 6143 (it does not throw for a dynamic Symbol) — the
template takes legacy's `any` arm, which does. A module-init of six literal
conversions beside `Number.MAX_VALUE` / `Number.NaN` / `Number.NEGATIVE_INFINITY`
reads ships an IR body. Standalone's caller-closure rule still drops a
parameterless claimed callee of an unclaimed caller (`zero()` called from a
legacy `run`), pre-existing.

**Left out.** Host lanes (no `host.js.number.from-value` provider; the
selector capability excludes them). **Found on the way (legacy, to file with
the constants-shadow defect):** with `var Number = function (x) { return 7; }`
at module level, legacy's by-name `Number(x)` arm still converts (node: 7).

## Follow-ups from the #6970 / #6972 reviews (2026-10-29)

Filed here because a new issue id could not be allocated from the revive
session (`claim-issue --allocate` needs `gh` for its open-PR scan). Move to
an issue of its own when one is allocated.

1. **One lane fact, two definitions** (#6970 finding 4). The selector asks
   the `dynamic-method-call-wrapper` capability (`legality.ts`); lowering asks
   `irTemplateWrapperLane` (`helpers/template-wrapper.ts`). They agree today
   (wasmgc, non-fast, standalone/wasi); derive the resolver answer from the
   capability predicate so they cannot drift.
2. **A failing template throws after the claim** (#6970 finding 5).
   `buildTemplateWrapperFamily` throws a plain `Error` when a wrapper's
   template does not compile. No repro (#6851's sweep over the built-in
   names × arity 0–3 compiled all but legacy's own `replace`/`replaceAll`
   refusal); make it a pre-claim refusal or pin the sweep as a test. The
   borrow family reaches the same throw (#6972 delta review, nit 2):
   `ensureIrArrayPrototypeBorrowHelper` answers `undefined` when
   `resolveSliceDeps` misses an object-runtime helper, which the
   standalone/wasi lanes that admit the wrapper always define.
3. **`nativeStrTypeIdx` slot under `--utf8-storage`.** The
   `dynamicCarrierDivergesFromLegacy` string-slot exception compares against
   `ctx.anyStrTypeIdx`; add a test for the `--utf8-storage` native-string
   slot.
4. **Wrapper naming lives in a family module** (#6972 finding 4).
   `irWrapperSymbolIsNameable` / `irWrapperSymbol` / `parseIrWrapperSymbol`
   serve both wrapper families from `ir/dynamic-method-call-names.ts`; move
   them to `ir/template-wrapper-names.ts`.
5. **Three sibling borrow arms** (#6972 finding 6) in `select.ts` (move-only
   scan, `isPhase1Expr` call, method call on a borrow result): fold into one
   `borrowOperandsAdmitted` beside `ambientArrayPrototypeBorrowCall`.
6. **A post-claim `<module-init>` failure is a compile error, not a demote**
   (#6972 + #6973 integration census, 2026-10-29). When the claimed
   initializer failed (`unknown exact function import env.RegExp_new`), the
   retained `<module-init>__closure_0` still referenced a type that was never
   emitted ("references non-function or missing type 0", `success: false`)
   instead of falling back to legacy. The RegExp literal is now refused at
   select, so this path is latent; any other post-claim module-init failure
   that lifts closures still reaches it.
   **Fixed 2026-10-29** (#6972 merge group, run 40856238364: one unclassified
   standalone row). main + #6977 made the harness initializer claimable, and a
   body calling a declaration whose claim withdraws on a typeIdx parity
   mismatch (`function foo(await) { return await; }`,
   `language/expressions/await/await-in-function.js`) cascade-withdrew it,
   leaving eight untyped closure slots. `stubIfOrphanedEmpty` now types an
   orphaned placeholder slot with its lowered signature, or `() -> ()`
   (`tests/issue-7106-module-init-orphaned-closure-slots.test.ts`).
7. **Legacy-only borrows answer on a nullish parameter receiver** (#6972
   delta review, nit 3; pre-existing on main). The IR borrow wrapper throws
   the step-1 TypeError, but a legacy-only function such as
   `function h(x) { return Array.prototype.indexOf.call(x, 1); }` still
   answers for `h(undefined)`: legacy refuses only a *literal* nullish
   receiver at the call site. Affects `indexOf`, `lastIndexOf`, `includes`
   and `concat`; `tests/issue-7106-borrow-nullish-receiver.test.ts` pins the
   gap as the IR-vs-legacy exception.

## Dead code after break/continue in a nested statement list (2026-10-29, #6972 merge-queue root cause C)

**Symptom.** ES5 rows `S12.14_A9_T5` / `S12.14_A10_T5`
(`catch (e) { c -= 1; continue; throw new Test262Error(…); } finally { … }`
in a loop) failed to compile on standalone with `br.label must be the last
instruction in its buffer`, once #6972 put their `<module-init>` on IR.

**Root cause: a latent producer bug, not module-init specific.** The verifier
requires `br.label` to end its buffer, and `lowerStmt` honoured that only for
a direct `break`/`continue` in a block or switch clause, by statement kind.
Two gaps on main, both reachable from ordinary IR-claimed function bodies
(compile error on gc and standalone alike, measured on `8de8a22511`):

- try / catch / finally bodies had no guard at all;
- a break/continue inside a plain block is lowered inline into the enclosing
  buffer, so the enclosing list kept emitting after it
  (`{ f += 1; continue; } i += 100;`, a `case 1: { …; break; } …` clause).

**Fix.** `lowerBodyStatements` (from-ast.ts) is the one nested-list lowerer
for blocks, `with` bodies, switch clauses and try/catch/finally bodies. It
stops when `builder.activeBufferBranched()` reports that the buffer already
ends in `br.label`. Reading the emitted instruction instead of the statement
kind covers the inline-block case, and it folds the two inline guards into the
one helper. Only programs that previously failed verification change output.
`tests/issue-7106-break-continue-dead-code.test.ts` covers both test262 shapes
(IR `<module-init>`, counters matched against node) and seven function-body
shapes on standalone and host.

## #6972 merge group: ES5 rows lost to a claimed `<module-init>` (2026-10-29)

Each row passes on main `8de8a22511` and failed to compile at the #6972 head
`0e95c58ef3`, once the harness initializer became claimable on standalone.

- **String position arguments** (`String/prototype/{charAt,slice,substring}`
  `S15.5.4.{4,13,15}_A1_T7.js`). The string-method arm lowers a position
  (`charAt(pos)`, `slice(start, end)`) under the f64 hint and truncates it. It
  has no ToNumber and no "an undefined end is the length" rule, so
  `charAt(undefined)` handed `i32.trunc_sat_f64_s` the dynamic carrier (a
  verifier failure) and `slice("e")` a string (invalid Wasm the verifier does
  not see). The selector now requires `expressionIsProvenNumber` for every
  argument of a `positional` method in `IR_STRING_METHOD_SURFACE`, the
  proof Math.* and `String.fromCharCode` arguments already need. The unit stays
  legacy, which owns ToIntegerOrInfinity. The same refusal fixes the
  function-body form, which failed to compile on gc and standalone on main
  too, and a silent miscompile on both lanes: `void 0` lowered to NaN and
  truncated to 0, so `slice(1, void 0)` answered `""` and
  `substring(1, void 0)` `"l"`. On the gc lane 6 of the 470 harness-assembled
  files measured (`String.prototype` position methods, `statements/for`,
  `expressions/assignment`) change bytes: five were claimed and then demoted
  post-claim, one (`charAt(void 0)`) moves from IR to legacy.
  `tests/issue-7106-module-init-string-position-args.test.ts`.
- **A value-position write to a dynamic module binding**
  (`language/statements/for/head-init-expr-check-empty-inc-empty-syntax.js`,
  `for (count = 0; ; )`). `isPhase1Expr` admitted `x = v` as a value whenever
  `x` is a dynamic module binding (added with #4259), but no builder arm
  lowers a value-position assignment: `lowerBinary`'s capability table defers
  `=`, so the claim ended in "internal capability violation". Statement, tail,
  chained and for-update writes are admitted and lowered by their own arms, so
  the admission had no consumer that could lower it. It is removed: the
  for-head initializer, a call argument and every other value position now
  refuse at select. `tests/issue-7106-module-init-value-assignment.test.ts`.

### Review of the #6972 merge-group fixes (2026-10-29)

Fresh-context adversarial review of `e6f6408c64`, `700ba4bcc4`, `323e679e61`
and `e021b56210`: REQUEST CHANGES, no blockers. It probed each fix for
remaining claim-then-fail shapes and for over-refusal (14 ordinary TS
string-position shapes, `F.helper()` / `F.prototype`, runtime-added
`Function.prototype` members, statement and for-update module writes all stay
IR) and found the fixes correct and narrow.

**Code-quality acceptance criterion:** each fix is either a correct lowering
in the one shared lowerer (`lowerBodyStatements`) or a select-time refusal
through one predicate shared by every arm that needs it
(`namesFunctionObjectExpando`, `unprovenStringMethodPosition`); no new
post-claim demote, no copied table.

Fixed in the PR:
1. `IR_STRING_METHOD_SURFACE` admitted calls no backend's `stringMethodPlan`
   lowers (`startsWith` / `endsWith`, two-argument `indexOf` / `includes`), so
   `"abc".endsWith("c")` claimed and demoted after the claim. The table is now
   the planned surface, and its third column is a `positional` flag.
2. `functionObjectMemberCallIsBuildable` audited an element-access key that
   `namesFunctionObjectExpando` now guarantees is a string literal (dead
   check, removed); its comments still documented `F[k] = G`.

Left, as follow-ups of this issue:
3. **Search-argument proof.** `"a1b".includes(1)` / `"undefined".indexOf(undefined)`
   still claim and reach #7014's post-claim demote in `from-ast.ts`
   (`needs ToString`). Refuse a search argument without a checker-proven string
   at select; `expressionIsProvenHostEvalString` is the predicate to generalise.
4. **Two numeric proofs for one position.** `from-ast`'s `charAt` /
   `charCodeAt` `proveAdditiveOperand` demote duplicates the selector's
   `expressionIsProvenNumber` with a different predicate; unify them, then make
   the lowering check a #4502 producer-promise invariant.
5. **`literalFieldName` placement.** `select-expression-structure.ts` imports it
   from the fnctor field-write analysis; it has a duplicate in
   `fnctor-string-producers.ts` (`literalKeyText` / `propertyWriteName`) and a
   near-duplicate in `shared/ambient-intrinsics.ts` (`staticMemberName`). Move it
   to a structural module and fold the duplicates.
6. **`ir->runtime` edge.** `FUNCTION_REALM_MEMBER_NAMES` could be derived beside
   `ir/program/native-realm-requirements.ts`, which already imports the catalog,
   instead of adding the 10th `ir->runtime` edge.
7. **Active-buffer encodings in `builder.ts`.** `activeBufferBranched`,
   `pushInstr` and the block-close path each name the active buffer; one private
   `activeInstrs()` would serve all three.
8. **`lowerBodyStatements` adoption.** Its doc comment lists callers; the
   module-init top-level loop still has its own loop and a "no guard needed"
   comment and could call it.
9. **Test helpers.** `compileHarnessBody` / `moduleInit` / `runModuleInit` are
   copied between the string-position and value-assignment tests; move them to
   `tests/helpers/`.
10. **Legacy, out of scope:** a typed `var` declared after `continue` in a loop is
    not `undefined` after the loop on the selector-rejected path; sloppy `F.caller`
    reads `undefined` instead of `null`; `F["helper"] = fn; F["helper"]()`
    throws.

## Script `var` reference homes (2026-10-29)

An independent implementation of the "script `var` reference homes" lever.
Another session holds an unpushed, unreachable commit for the same lever
(`ba959239`, "ir-script-var-ref-homes"); this one was written without it, and
the lead reconciles the two if that commit surfaces.

### Outcome

PR #6985 ships only the behaviour-neutral half:

- One codegen classifier, `scriptVarHome`, replaces the three
  `scriptVarSlotIs*` predicates and their three resolver options.

The first commit (`4de4ee80ce`) also bound number-array script `var`s as a new
`f64-vec` module-binding kind. That admission is withdrawn, for the reasons
below. A number array, like every other reference-shaped slot, stays refused
at selection as `vardecl-module-storage-unrepresentable`.

### Measured: legacy slot per shape

Standalone, `emitWat`, on `dd6a239d3b`. "IR producer" is what the selector or
builder does with the initializer today. Every shape stays refused.

| shape | legacy `__mod_` slot | IR producer for the initializer |
| --- | --- | --- |
| `var a = [1, 2, 3]` | `(ref null $__vec_f64)` | array literal → `vec<f64>`, the same registered struct; withdrawn, see below |
| `var a = ["x", "y"]` | `(ref null $__vec_ref_<AnyString>)` | `vec<string>`; agreement not measured |
| `var a = [Float64Array, Float32Array]` (testTypedArray.js) | `(ref null $__vec_externref)` holding legacy's `$__ta_ctor_singleton_*` structs | none: `Float64Array` as a value is `expr-ident-not-in-scope` |
| `var e = []` | `(ref null $__vec_externref)` | empty-array inference |
| `var o = { x: 1, y: 2 }` | `(ref null $__anon_N)`: source field order plus `$$shape` / `$$shapeBrand` fields | IR object shape: name-sorted fields, no shape fields |
| `var obj = {}` | `externref` (dynamic home); legacy builds a closed expando struct or a `__new_plain_object` | zero-field struct, claimed only unreferenced (`objectlit-empty`); needs #7128 |
| `var c = new C()` (untyped JS class) | `(ref null $C)` | `class-projection-unsupported` |
| `var d = new Date(0)` | `(ref null $__Date)` | `expr-new-date-target` |
| `var m = new Map()` | `(ref null $Map)` | the `native-map` producer, whose selector arm is not number-keyed (follow-up c) |
| `new WeakMap()`, `new Set()`, `new WeakSet()` | `(ref null $Map)` | none |
| `var s = Symbol("1")` | `i32` | none |
| `var re = /x/u` | `externref` (dynamic home) | `regexp-constructor-unsupported` on standalone |

### Census

On a deterministic 1/60 sample (893 files, 775 compiled; every
`<module-init>` refusal recorded with `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`),
a storage refusal appears in 385 files and is the only refusal in 23. Grouped
by initializer (files carrying the family):

| family | files |
| --- | --- |
| harness statements (temporalHelpers.js ×3, the runner's `$262`, `print`, testTypedArray.js, regExpUtils.js) | 135 |
| object literals (data and method) | 96 |
| call results (`a = [1].map(f)`, `Object.keys(o)`) | 75 |
| user class / constructor instances | 56 |
| other arrays (constructors, objects, mixed) | 40 |
| string arrays | 27 |
| builtin constructions (Date, WeakMap, Set, Proxy, TypedArray) | 25 |
| empty objects / empty arrays | 24 / 23 |
| number-array literals | 23 |

None of the harness statements has an IR producer for its initializer. In the
whole corpus, a top-level `var x = [<numbers>]` appears in 1129 files (385 of
them `built-ins/Array/prototype`), `var x = {}` in 3364 (#7128), `var x = []`
in 956, `var x = [<strings>]` in 328 and `new Map()` in 72.

For the record, the withdrawn `f64-vec` admission measured as follows.

- On the 1129 number-array files it moved the first-wins `<module-init>`
  refusal off storage in 522 of 811. It put 3 `<module-init>`s on the IR and
  gave 1 zero-legacy compile.
- On a 189-file run sample: one more zero-legacy pass, no flips.
- The lever is narrow. The `<module-init>`s it reached mostly stop at the next
  blocker (`vardecl-let-closure`, computed array writes, class expressions,
  array methods), and their callbacks are usually legacy units anyway.

### Why `f64-vec` was withdrawn

A fresh-context adversarial review of `4de4ee80ce` returned REQUEST CHANGES
with two blockers.

1. **Claimed, then demoted after the claim.** `isModuleVectorBinding` was a
   deny-list of positions, and nothing enforced that a vector binding enters
   only through the array arms. With `var a = [1, 2];` in a harness
   `<module-init>`:
   - `assert.sameValue(a, a)`, `assert.notSameValue(a, b)` and
     `assert.compareArray(a, [1, 2])` fail with "function member operand has
     no canonical carrier";
   - `assert(a)` fails with "arg 0 … is vec<f64>?, expected dynamic";
   - `String(a)`, `Object.prototype.toString.call(a)`, `a.constructor`,
     `console.log(a)`, `a.push("s")`, `a["foo"] = 3` and `a[0] += "x"` fail at
     build.
2. **Claimed miscompiles.** Out-of-bounds, fractional, negative and hole reads,
   and huge or negative index writes, are wrong under the IR. These are
   existing IR local-vector gaps (follow-up a); the binding routed script
   arrays into them. The rule applied to `new Map()` applies here too: the
   selector gap comes first.

The review also flagged these; the change below fixes them or they are moot:

- a parallel, module-only vector predicate family next to `isArrayExpression`
  / `classifyArrayElementFamily`;
- the element-value check pasted into three statement arms;
- the home computed twice;
- `hasNumberElements` duplicating `makeIrArrayElementFamilyClassifier`'s
  number-array test;
- `typed` returned for the JS-host vector slot;
- the home list documented twice;
- the claim "every new refusal fires at selection", which was false as
  written.

### Implementation Plan (as shipped)

- **Where.**
  - Codegen's `scriptVarHome` (`src/codegen/index.ts`).
  - `scriptVarHomeOf` and `scriptVarReferenceKind`
    (`src/ir/module-bindings.ts`).
  - `IrScriptVarHome` (`module-binding-value-kinds.ts`), the one documented
    list of homes.
- **Homes.**
  - `dynamic`: `externref` off fast mode.
  - `string`: `(ref null $AnyString)`.
  - `typed`: an `f64` or `i32` slot.
  - Every other slot is `undefined`. Before, any non-`externref` slot was
    admitted and the checker-type and #4208 update-retype gates refused it. So
    `++` on a script var whose slot is fixed before widening (a generator, a
    standalone typed-array view) is now not direct: binaries are unchanged
    (legacy owns the unit either way), but the refusal reason moves from
    `vardecl-module-value-flow` to `vardecl-module-storage-unrepresentable`.
- **Removes.**
  - Three predicates and three options become one classifier and one option.
  - `isScriptStringHome`, `moduleStringStorageAdmitted` and
    `isScriptDynamicHome` fold into two helpers.
  - Every consumer reads the home through one guarded helper
    (`scriptVarHomeOf`). `writeValueMatches` used the raw option and skipped
    the lexical guard, so a script `let o; … o = { a: 1 }` claimed and then
    demoted (`got object{a:f64}`); it now refuses at select. The home is still
    looked up per consumer, not threaded through.
  - The `ctx.nativeStrings` guard goes. `anyStrTypeIdx` is `≥ 0` only after
    `registerNativeStringTypes`, which `createCodegenContext` runs only under
    `nativeStrings`, and nothing resets `nativeStrings`.
  - The harness compile helpers copied between two #7106 tests move to
    `tests/helpers/harness-module-init.ts` (follow-up 9 of the #6972 review).
- **Code-quality acceptance criterion.** `src/` shrinks by 39 LOC with no
  budget grant. One classifier, and one doc copy of the home list.
- **Correctness acceptance criterion.**
  - Byte-identical on gc and standalone (below).
  - A number-array script `var` stays legacy: refused at select, with no
    post-claim error (`tests/issue-7106-script-var-reference-homes.test.ts`).

### Byte identity (2026-10-30)

Each binary was compiled before (`dd6a239d3b`) and after this change by
`.tmp/census.mts`, which uses the conformance runner's harness assembly and
options, and by `.tmp/playground.mts`. The sha256 of each was compared.

| population | lane | identical |
| --- | --- | --- |
| the 1129 files with a top-level `var x = [<numbers>]` (1104 compile; the other 25 fail to compile on both sides) | standalone | 1129 / 1129 |
| same | gc | 1129 / 1129 |
| deterministic 1/60 corpus sample (893 files, 775 compile) | standalone | 893 / 893 |
| `website/playground/examples` (13 files) | gc | 13 / 13 |
| same | standalone | 13 / 13 |

### Follow-ups

**(a) IR local-vector index semantics: a correctness bug on main.** Repro,
standalone, harness, a function-local array in an IR-claimed function:

```js
function f() { var a = [1]; assert.sameValue(a[5], undefined); }
f();
```

| body of `f` | node | legacy | IR (`f` claimed) |
| --- | --- | --- | --- |
| `assert.sameValue(a[5], undefined)` | passes | passes | throws Test262Error: the read is `NaN` |
| `assert.sameValue(a[0.5], undefined)` | passes | passes | throws: it reads index 0, so `1` |
| `a[3] = 9; assert.sameValue(a[2], undefined)` | passes | throws | throws: the hole reads `NaN` |
| `var a = [0, 1, 2]; a[4294967295] = 5; assert.sameValue(a.length, 3)` | passes | passes | uncatchable trap: `RuntimeError: array element access out of bounds` |
| `var a = [0, 1, 2]; a[-1] = 5; assert.sameValue(a.length, 3)` | passes | passes | uncatchable trap, as above |

`a[a.length]` and `a[-1]` read like `a[5]`. With a number return ABI
(`export function oob() { var a = [1]; return a[5]; }`), IR and legacy both
answer `NaN`. The bug shows where the value reaches a dynamic consumer. The
fix:

- an out-of-range or hole read must produce `undefined`;
- a non-integer or negative key must take the property path, not truncate;
- a store with a key that is not an array index (≥ 2³²−1, negative,
  fractional) must take the generic property path instead of trapping.

The hole read is wrong on legacy as well.

**(b) An allow-list design for a vector module binding**, once (a) is fixed.

- Admit a vector binding only in positions with a proven lowering:
  - a `.length` read;
  - an element read, under (a)'s semantics;
  - a store of a proven number at a proven array index;
  - `push` of proven numbers;
  - the array HOF and search arms already planned for local vectors.
- Refuse every other position by construction, through one consumer
  predicate in the shape of `moduleExternConsumerIsProven`. Local and module
  vectors share it, so they have one discipline instead of a module-only
  deny-list.
- Harness call arguments (`assert.sameValue(a, a)`, `assert(a)`) need a
  conversion to the dynamic carrier first.

**(c) Native Map script `var`s.**

- `tryLowerNativeMapMethodCall` is number-keyed, but `exactModuleMapMethod`'s
  arm admits any key. So `let m = new Map(); m.set("k", 1)` claims and then
  demotes after the claim on main.
- Fix the selector first. Then `native-map` is one more `scriptVarHome` arm
  and one more `scriptVarReferenceKind` case.

**(d) String vectors.** `var a = ["x"]` (328 corpus files) sits in
`$__vec_ref_<AnyString>`. Measure `vec<string>` agreement before any kind.

**(e) Local-vector consumers that claim and then demote on main.** These
fail on both lanes for a function-local `[1, 2, 3]`:

- `a.length = n`;
- `a === undefined`;
- `function same(p, q) { return p === q; } same(a, a)`.

**(f) `++` on a script `var` with a reference initializer.** `var a = [1]; a++`,
`var o = {x: 1}; o++` and `var m = new Map(); m++`: the #4208 update-retype
widens the slot to `externref` (the `dynamic` home), and the build demotes
after the claim on main because the initializer has no dynamic carrier
("proven dynamic binding … initializer has no supported carrier"). Refuse at
select until an object-to-dynamic producer exists.

**(g) testTypedArray.js.** `floatArrayConstructors` needs two things:

- TypedArray constructors as IR values, keeping identity with legacy's
  `$__ta_ctor_singleton_*` structs;
- an externref-vector kind.

Even then the harness `<module-init>` has 18 more refusals
(`Float16Array`/`BigInt64Array` guards, `Object.getPrototypeOf`, a logical
value, `ArrayBuffer`, function-valued vars).

**(h) Object literals and user class instances** (96 and 56 census files)
need struct agreement:

- legacy keeps source field order and adds `$$shape` / `$$shapeBrand`;
- the IR sorts fields by name;
- untyped JS constructors are `class-projection-unsupported`.

## Ambient boolean statics, lowered by operand family (built 2026-10-31)

Planned as the `<module-init>` static-call lever. "Problem" and "Measurements"
are the plan's, measured on main `6434436564`, standalone unless stated,
harness assembled by `assembleOriginalHarness` with the worker's compile
options. "Exact" means IR = legacy (IR off) = node, on standalone and on gc.
The first build followed the plan's route and was rejected in review; the
rebuilt design was reviewed four more times. The five reviews, the design as
built and its measurements follow.

### Problem (measured)

In the 1/60 census (`.tmp/census-1030.json`: 792 files, 698 compile, 12
zero-legacy), `expr-ident-not-in-scope` is the only legacy code in 37 files.
In every one, the unit is `<module-init>`. With every module-init refusal
recorded (`JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`), the first refused use
splits them like this:

| first refused use | files | pass on main | static calls are the only refusal |
| --- | ---: | ---: | ---: |
| receiver of `<NS>.<m>(…)`: `Object` 11, and `String`, `Number`, `JSON`, `Proxy`, `Temporal` 1 each | 16 | 12 | 4 |
| `<R>.prototype.<m>` as a value or `.call` (#7127's family): `String` 3, `Set` 2, `Symbol`, `Map`, `Date`, `Number`, `Array`, `Object`, `DisposableStack`, `ArrayBuffer`, `ShadowRealm` | 14 | 10 | — |
| another value: `Test262Error` 2, `DummyError`, `C[…]`, `Math`, module `ns`, `globalThis` | 7 | 3 | — |

The four files whose only refusals are static calls all pass on main:

- `Number/isSafeInteger/safe-integers.js`;
- `String/fromCodePoint/return-string-value.js`;
- `Object/isExtensible/15.2.3.13-1-2.js` (`Object.isExtensible(null)`);
- `Object/hasOwn/hasown_inherited_exists.js` (`Object.create(base)`,
  `Object.hasOwn(o, "foo")`).

**A broad admission buys one file.** As a scratch experiment (reverted), every
`Object|String|Number|Array|JSON.<m>(…)` receiver was admitted through the
dynamic route. That moved the first refusal in 51 sample files, made exactly
one of them zero-legacy (`safe-integers.js`), and flipped none from pass to
fail. The other three static-call-only files did not clear:

- `fromCodePoint` hit the module-init chunk budget: more than 16 top-level
  entries take direct chunked emission (`late-preparation-unsupported`);
- `isExtensible(null)` was claimed, then demoted (`nullish-value-unsupported`);
- `hasOwn` was claimed, then demoted (`operand-coercion-unsupported`: the
  object-literal binding `base` has no carrier).

The broad admission also claimed methods that answer wrongly (table A). So
this plan admits only the exact subset, in measured positions, with measured
operands.

### Measurements

Each probe is a module-init script that throws unless the call answers as node
does. The tables report the result on both lanes, which agreed on every row.

**A. Per call: dynamic route vs legacy's typed site.**

| call | operands measured | legacy | IR dynamic route |
| --- | --- | --- | --- |
| `Number.isSafeInteger` / `isInteger` / `isFinite` / `isNaN` | 1, 1.5, 2⁵³, 1e300, NaN, -Infinity, "1", "x", true, undefined; 0–3 arguments; a module number `var`, `n + 0.5`, `-(3)`, `0/0`, `Number.MAX_SAFE_INTEGER`, `Math.pow(2, 53)`, `typeof 1`; plus the operands of the 20 test262 files in E (-0, ±Infinity, …) | exact | exact |
| `Object.is` | (NaN, NaN), (0, -0), (-0, -0), ("a", "a"), (true, 1), ("", false), `"a" + "b"`, `1 < 2`, a nested `Object.is`; 0–3 arguments | exact | exact |
| `Array.isArray` | 1, "a", true, undefined | exact | exact |
| `Object.keys` / `getOwnPropertyNames` | "ab", then `.length` / `[1]` | exact | exact, but only as a member receiver |
| `Object.create` | undefined → TypeError | exact | exact |
| `String.fromCodePoint` | 65; (65, 90); astral; 0; "66"; none; -1 / 1.5 → RangeError | exact | wrong value, and no RangeError |
| `Object.isExtensible` / `isFrozen` / `isSealed` | 1, "a", undefined | exact | wrong |
| `Array.of` / `Array.from` | (1, 2); "ab" | exact | wrong |
| `JSON.parse` | "1", true, "\"a\"", "[1]"; "x" / undefined → SyntaxError | exact | wrong value, wrong error |
| `Object.getPrototypeOf` | 1, "a" | exact | wrong (#7189) |
| `Object.hasOwn` | ("abc", "length"); (undefined, "x") → TypeError | **wrong** (both lanes) | wrong |

`Array.isArray()` with no argument is a compile error on both lanes today
(`__get_builtin`), with or without the IR.

**B. Legacy's untyped-operand arm.** Each operand goes through
`function id(x) { return x; }`, IR off. This is what a wrapper compiled from
legacy's static emitter over `any` parameters would answer.

- **Exact:**
  - `Number.isSafeInteger` on 1, "1", null and {};
  - `String.fromCodePoint` on 65, (65, 90), -1, "66", null and undefined;
  - `Object.isExtensible` on 1, null, {}, a function and a non-extensible
    object; `Object.isFrozen` on "a" and {};
  - `Object.hasOwn`, `getPrototypeOf` and `getOwnPropertyDescriptor` on
    objects; `Object.create` on null and `{a: 1}`;
  - `JSON.parse` on strings;
  - `Array.of`, `Array.from` and `Array.isArray`.
- **Wrong:**
  - `Object.hasOwn("abc", "length")`, and `Object.hasOwn(null, k)`, which does
    not throw;
  - `Object.getPrototypeOf(1 | "a")`;
  - `Object.create(1)`, which does not throw;
  - `JSON.parse(null | true)`, and `JSON.parse(undefined)`, which does not
    throw.

**C. Result position** of an admitted call (`c` = `Number.isSafeInteger(1)`).

- **Claims and runs:**
  - `if (c)`, `!c`, `c ? a : b`;
  - a `while` / `do` / `for` condition;
  - `c;`, `typeof c`;
  - `c === x`, `!==`, `==`;
  - the left operand of `,`;
  - an argument of a member callee (`assert.sameValue(c, true)`).
- **Claims, then demotes:**
  - `var r = c`: the checker types the module global `i32`, and the build
    fails with "initializer is dynamic but its global is i32";
  - `return c`: "dynamic not assignable to declared result i32";
  - `[c]`;
  - `"" + c`.
- **Refused elsewhere already:** `r = c`, `c && 7`, a same-file callee `h(c)`,
  an IIFE argument, `o.a = c`.

The first list is exactly the `opaque` class of #7118's `usePosition`; every
other position falls in its `alias` / `member` / `other` classes.

**D. Operands**, with the call in an opaque position.

- **Box and run:**
  - number, string and boolean literals;
  - numeric and string expressions, comparisons, `typeof`;
  - a module number `var`;
  - `Number.<CONST>` (lever A) and `Math.<m>(…)`;
  - the global `undefined`;
  - a nested admitted call.
- **Claim, then demote:**
  - `null` (`nullish-value-unsupported`);
  - `void 0` ("dynamic method argument cannot be boxed");
  - an array literal;
  - an object-literal binding (no carrier).
- **Refused already:** a function expression, `new Object()`, `Symbol()`, and
  a module `var` holding an array or an object.

**E. Lever size, measured on the corpus, not the sample.** The exact calls
cluster in four directories, so the sample's single hit does not scale ×60.
The population is every corpus file whose source calls
`Number.is{SafeInteger,Integer,Finite,NaN}`, `Object.is` or `Array.isArray`:
817 files, of which 792 are non-negative scripts that compile. It was run on
main and with a scratch implementation of the planned admission.

| | main | planned |
| --- | ---: | ---: |
| zero-legacy compiles | 0 | 20 |
| files whose legacy codes changed | — | 37 |
| standalone passes among those 37 | 35 | 35 (0 flips) |
| gc passes among those 37 | 35 | 35 (0 flips) |
| newly zero-legacy files that pass on standalone | — | 20 of 20 |

The 20 files:

- `Number/isSafeInteger/{safe-integers, not-safe-integer, not-integer, nan, infinity}`;
- `Number/isInteger/{non-integers, nan, infinity}`;
- `Number/isFinite/{nan, infinity}`;
- `Number/isNaN/nan`;
- `Object/is/same-value-x-y-{boolean, empty, number, string, undefined}`;
- `Object/is/not-same-value-x-y-number`;
- `Array/isArray/15.4.3.2-1-{1, 3, 5}`.

Still legacy:

- `arg-is-not-number` ×4 and 7 `Object/is` files: their operands are null,
  objects, symbols or arrays (D);
- `isFinite/finite-numbers`, `isInteger/integers` and `isNaN/not-nan`: the
  module-init chunk budget.

**Expected `ir_only_pass`: +20 (680 → about 700).** The sample's one hit,
scaled ×60, would have predicted +60.

### Review of the first build (2026-10-31)

The first build (`d00c78fcca`) followed the plan: the predicate admitted the
receiver of a measured call in an opaque position, and the selector arm sent
the call through the realm read and the generic dynamic method call. A
fresh-context review of PR #6995 requested changes, with two blockers:

1. **A type mismatch became a hard compile error where main compiles.** The
   checker types the call `boolean`; the route lowered it `dynamic`. The
   equality arm claimed `b === Number.isNaN(NaN)` (`b` a module or local
   boolean, both lanes, JS and TS) and from-ast's invariant
   ("Phase 1 requires matching operand types for '==='") threw a plain
   `Error`, so nothing fell back. The same root cause demoted ternary branches
   after the claim (`c ? Number.isNaN(NaN) : false`).
2. **It was not scoped to `<module-init>`.** The arm fired in every function
   body and displaced legacy's typed arm (`call-builtin-static.ts`) with the
   realm read and a dynamic call. For
   `if (Number.isInteger(i / 2)) s++` in a loop: 2.3 ms → 534 ms for 10⁶
   iterations on standalone (2.4 → 613 on gc), 11 KB → 305 KB, and gc host
   imports 0 → 21 (`env.__boundary_object_*`).

Further findings: the extracted operand helper duplicated #7144's rule (4);
refusals used `body-shape-rejected` rather than a capability reason (5); the
grants lacked dated rationales (6); `isAmbientIntrinsicValue` asked the
binding resolver before the name, and `isStaticMethodUse` took an identifier
(7); test gaps (8); and `Object.is("a" + 1, "a1")` claimed and then demoted on
the `+` selector gap.

**The design changed: these calls are lowered, not routed.** They are typed by
operand family, as the #1371 Math whitelist lowers `Math.*`. The answer is an
IR boolean, which the checker's `boolean` agrees with, so blocker 1 cannot
arise. Typed operands take legacy's own f64 ops, so blocker 2 cannot either.
The plan's "no new lowering" is superseded.

### Review of the second build (2026-10-31)

A second fresh-context review of `47943b65a7` found the core semantics exact
and requested changes. Each finding and what changed:

1. **Blocker: `Object.is(<number read>, undefined)` folded to `false`.** An
   f64 can hold `undefined`. Legacy stores it as the marker bits
   `UNDEF_F64_BITS` / `HOLE_F64_BITS`, and the IR's out-of-bounds element read
   yields NaN on the GC lanes and 0 on linear. Two changes:
   - **`Object.is` reads the marker.** `isF64Hole` moved out of
     `array-methods/vec-search-join.ts` into `src/ir/f64-undefined-marker.ts`
     as `emitF64IsUndefined`, the one copy both modules call. from-ast's own
     copy of the bits (`LEGACY_EXPRESSION_DEFAULT_F64_SENTINEL_BITS`) now reads
     the shared constant. A marker answers `Object.is(x, undefined)` true, and
     against another number it is the same only as another marker, so
     `Object.is(x, NaN)` is false. The marker is a NaN, so the bit tests sat
     in an `if` on "both operands are NaN". (The third review measured that
     `if` slower than main; it is gone, and only `Object.is(x, undefined)`
     still tested the marker: finding 1 below. The fourth review showed that
     test unsound, and `Object.is` no longer reads the marker at all; the
     shared module still serves vec-search-join and from-ast's constant.)
   - **`Number.isNaN` keeps legacy's `f64.ne`**, so a marker answers `true`
     there, as on main. Excluding it is exact but not cheap: as a
     branch-free test it took the `Number.isNaN(i / 0 - 1)` loop from 1.2 to
     2.7–4.0 ms per 10⁶ iterations, and behind an `if` to 1.5–3.2 ms. Per
     the review, that is a follow-up. `isFinite` / `isInteger` /
     `isSafeInteger` answer a marker `false`, as for `undefined`.
   - **An element read is refused as an operand.** An out-of-bounds read is
     not a marker in the IR (NaN on the GC lanes, 0 on linear), so no number
     test can answer it; the family is `unknown`. Legacy answers
     `Object.is(a[5], NaN)` and `Number.isNaN(a[5])` wrongly on main too
     (`bool.mjs` / `twin.mjs` `blockArrOOBIsNaN`), and they stay legacy here.
     On linear, where main cannot compile these calls, the IR would have
     answered `isFinite(a[5])` true.
2. **The family proof is the IR representation's, not the checker's.**
   `provenIrFamily` (select.ts, `staticPredicateFamily` before) now names what
   from-ast lowers:
   - a module binding is its slot: an f64 is a number, a boolean slot is
     `int32` (it reads as an i32 without the brand), anything else unknown;
   - `isNativeI32SlotRead` (#7136) is `int32`;
   - an unannotated local takes its initializer's family
     (`IrStaticPredicateSelection.untypedLocal`), so `let x = undefined || 1`
     is unknown however the checker types `x`. A local written after its
     declaration (`localIsRewritten`, now beside
     `collectWrittenNamesIncludingNested` in `lattice-param-facts.ts`) is
     unknown too: from-ast keeps the
     initializer's slot and withdraws a write of another family after the
     claim (`x = 1; x = undefined`, main's twin), so the selector cannot
     prove the unit.
   `int32` and `unknown` are refused. Tests: `moduleBooleanOperand`,
   `moduleBooleanFromPredicate`, `moduleBooleanArray`, `logicalLocal`,
   `rewrittenLocal`, and the TypeScript `nativeI32Field` and `moduleBoolean`.

   The one operand proof that leaned on another arm, an ambient `String(v)`,
   exposed that arm's own gap: `String(<module boolean>)` was admitted, then
   demoted with "String() of i32 operand is deferred", on main as well (the
   reviewer's `strOfModBoolTwin`). The generic `String(v)` selector arm was
   made to refuse an `int32` operand with the same proof. (The third review
   had that generic edit reverted; the rule now lives in this lever's own
   operand proof: finding 3 below.)
3. **The consumer rule is an allow-list on #7144's predicates.**
   `booleanAnswerConsumed` admits only the positions the lowering takes; every
   other parent refuses. `=` is judged with `slotWriteVerdict` against the
   target's family. `as`, `satisfies`, `!`, `void`, a member read, an element
   read, `??`, `in`, `instanceof` and the compound assignments refuse.
   `+` and `&&` / `||` result families come from two new shared rules in
   `operand-admissibility.ts`, `additiveResultFamily` and `logicalResultFamily`.
   `select-planned-closure-operands.ts`'s `binaryProof` now calls them instead
   of its own copies, so the `+` rule exists once
   (`plannedClosureOperandRefusal` nets −3 lines). Tests: `numberSlotWrite`,
   `voidOperand`, `elementRead`, `memberRead`, the three template / `String`
   cases over a module boolean, and the TypeScript `asAny`, `asUnknown`,
   `satisfies`, `nonNull` and `numberSlot`.
4. **One ambient-receiver helper.** `isAmbientReceiver` in from-ast replaces
   the inline checks of the `Function.prototype`, `Object.defineProperty`,
   `JSON.stringify` and `Math` arms and serves the predicate arm.
   `lowerMethodCall` nets −12 lines instead of +9. The selector's
   `isAmbientNamespace` is the Math arm's test (`!scope.has(name)` and
   `selectorSeesAmbientBinding`). Left alone: `console` (no ambient test),
   `String.fromCharCode` (`isAmbientStringBinding`) and class statics (not
   ambient).
5. **`emitStringEq` stays unbranded at the producer.** Branding it there is
   not byte-neutral: every brand-reading consumer of a string equality (a
   template span, `includes`) would take another path than it takes today.
   The predicate re-brands its own answer (`i32.ne … false`).
6. **Reverted:** the `isAmbientIntrinsicName(expr.text) &&` conjunct in
   `isAmbientIntrinsicValue`; select.ts imports only
   `isAmbientIntrinsicValueUse` again.
7. **`LOWERED_FAMILIES`** is the three families the lowering takes, defined
   once in `lowering.ts` and read by `selection.ts`.
8. **Growth note.** See "Newly claimed units can grow" under Risks.

### Review of the third build (2026-10-31)

A third fresh-context review of `ba111d6885` found no blocker (no new compile
error, no answer newly wrong against node) and requested changes:

1. **`Object.is` of two numbers was 15–35 % slower than main.** The `if` on
   "both NaN" ran on every evaluation, and the marker tests ran even against a
   literal. SameValue over numbers is now branch-free, and the marker is
   tested only where it is the whole answer:
   - a number operand's source is read from its syntax (`numberSource` in
     `lowering.ts`): a numeric literal, the global `NaN` or `Infinity` is a
     constant; a `+ - * /` or bitwise result is arithmetic and never the
     marker, because Wasm quiets every NaN those ops produce and the marker
     is a signalling NaN; anything else is a read. A sign (`-x`, `+x`) keeps
     its operand's source;
   - against `undefined`, a read took the marker test, and a constant or an
     arithmetic result answered `false` (the fourth review showed the test
     wrong for any operand whose op carries a NaN payload through: it is
     gone, finding 1 below);
   - against `NaN`, the answer is `x ≠ x`; against any other constant, equal
     bits;
   - otherwise `sameValueNumberOps`.

   Testing a read for the marker against `NaN` or another number was measured
   and dropped. Branch-free, it took `Object.is(a, b)` over two parameters
   from 0.90 to 1.20 ms, `Object.is(i / 2, k)` from 1.8 to 2.5 ms, two
   locals from 1.8 to 3.9 ms and `Object.is(a, NaN)` from 1.95 to 2.57 ms.
   So there, as in `Number.isNaN`, a marker counts as NaN, as on main
   (follow-up 7). To tell the global `NaN` from a shadowed one, the lowering
   host's `isGlobalUndefined` became `isUnshadowedGlobal(operand, name)`, and
   from-ast's `isUnshadowedUndefinedExpression` became
   `isUnshadowedGlobalExpression(expr, name, cx)` for all five callers.
   Every measured shape is now at main or faster (Result).
2. **Four consumer positions withdrew after the claim** in units main
   refuses cleanly. Each is now judged, and stays legacy with no post-claim
   error:
   - (a) a destructuring declaration (`const { toString } = Object.is(1, 1)`):
     the declaration must bind an identifier;
   - (b) a rewritten local (`let r = Number.isNaN(NaN); r = 5`, also `"s"`,
     `undefined`): the declaration must pass `localIsRewritten`, as an
     operand must. A module `var` refuses, because a module boolean reads
     back as an unbranded i32 (`int32`, as an operand); an annotated local
     is judged by its declared type (fourth review, finding 2). Without that,
     reverting the
     generic `String(v)` edit (finding 3) brought back a withdrawal in
     `var t = Number.isNaN(NaN); String(t)` (`n2.mjs` `strModPred`);
   - (c) a `return` into a declared result (`@returns {number}`):
     `slotWriteVerdict` against the declared result's family
     (`resolveReturnTypeNode` of `fn.type ?? @returns`), as `=` is; an
     undeclared result is still inferred from the returns;
   - (d) an argument into a JSDoc-typed parameter (`@param {number}`,
     `{string}`): `slotWriteVerdict` against the parameter's family from
     `calleeParamResolvedKind`, the verdict the callee's own claim resolves
     its signature with. A callee bound in the function's scope is not
     resolved there, so its argument refuses; a member or ambient callee's
     argument is admitted, as before (`assert.sameValue(…)`).

   Tests: `destructuringDeclaration` and `moduleBooleanDeclaration` in
   `REFUSED`, a local declaration among the claiming TypeScript functions
   (`valueSinks` moved its declaration into a function), and a new `LEGACY_PARITY`
   group (the three rewrites, the `@returns` result, the `{number}` and
   `{string}` parameters) that asserts the IR run equals the IR-off run with
   no post-claim error, because legacy's own answer is wrong for most of them.
3. **The generic `String(v)` selector edit is reverted.** It refused
   `String(<int32>)` in every unit, which spread to callers and changed bytes
   in programs with no boolean static, and it missed `String((0, t))`. This
   lever's own operand proof now carries the rule: an ambient `String(v)` is
   a string operand only when `v` is a proven number or string, so
   `Object.is(String(t), "true")` and `Object.is(String((0, t)), "true")`
   refuse at select. The generic gap is follow-up 12.
4. **Plan accuracy:** the Result now names the other pre-existing
   withdrawals the lever newly reaches, qualifies "0 post-claim errors" as
   measured on the probe set, and records the hoisted `var` read.
5. **`localIsRewritten` moved** beside `collectWrittenNamesIncludingNested`
   in `lattice-param-facts.ts`, with its per-function cache; the collector is
   private again, as on main. `selection.ts` calls it for operands and
   declarations alike. The `select.ts` grant did not shrink: it is +87 lines,
   because the two new options for finding 2 (`argumentSlotFamily`,
   `returnSlotFamily`) and their kind table outweigh the 12 lines moved.
6. **The family walk uses `conditionalJoinFamily`** for a conditional operand
   and for a conditional consumer's partner. Its untyped-local tracing is not
   shared with the planned-closure walker: that tracing lives inside
   `plannedClosureOperandRefusal`, keyed by name over one planned closure and
   seeded with the plan's dynamic and numeric parameters, while this walk
   resolves bindings through the selector's resolver in module inits and
   function bodies alike. Sharing it means lifting `slotProof` out of that
   function first (follow-up 13).
7. **`isAmbientReceiver(receiver, isDirectModuleBinding, cx)`** takes a
   narrowed identifier and the caller's `receiverIsDirectModuleBinding`.
8. **The `untypedLocal` option's doc** says it returns rewritten locals too,
   and that this module trusts only one `localIsRewritten` clears.

### Review of the fourth build (2026-10-31)

A fourth fresh-context review of `a119134ff5` found one blocker and requested
changes:

1. **Blocker: `Object.is(<number>, undefined)` answered `true` where node
   and main answer `false`.** Repro: `function g(): number { return undefined
   as any; }` and `Object.is(+g(), undefined)`; likewise
   `Math.abs(g())`, `Number(g())`, `Math.min(g(), Infinity)`, `c ? +g() :
   1`, `(0, +g())`. The third build decided "can this be `undefined`" from
   the bit pattern, but IR f64 ops carry a NaN's payload through: unary `+`
   and `Number(x)` lower to the value itself, `f64.abs` keeps the payload,
   and so does the `Math.min` lowering. The reviewer proposed classifying
   operator results as never `undefined` and testing only value-carrying
   reads. That still answers wrongly: a call is a value-carrying read, and
   `function h(): number { return +g(); }` returns the marker's bits from an
   IR-claimed body, so `Object.is(h(), undefined)` would answer `true`
   (`.tmp/review4/r4-marker.mts` `plusCallee`: node 0, main 0, the third
   build 1). A local or a field assigned from `+g()` would hold the same bits.
   The marker test cannot be sound while IR producers do not canonicalise
   the payload, so it is gone: a number is never `undefined` to
   `Object.is`, exactly as legacy's typed arm answers on main. Against a
   constant, `Object.is` still needs only `x ≠ x` (`NaN`) or the bits
   (`numberConstant`, which replaced `numberSource`; the private operator
   set went with it). `Object.is(x, undefined)` for a number is now the
   constant `false`. The marker test is follow-up 7. The test "a number is
   never undefined to Object.is" checks ten shapes, `g()` included, against
   the IR-off compile and against node.

   One shape then answered unlike main: `Object.is(g())`, with the second
   argument missing. Main answers it through its boxing path, which reads
   the marker as `undefined` (node and main 1), unlike its explicit
   `Object.is(g(), undefined)` (main 0). `Object.is` with one number
   argument is therefore lowered only when that argument is a literal
   (`Object.is(0)`, in `not-same-value-x-y-number.js`); anything else stays
   legacy (`expr-static-predicate-operand`). The literal test is
   `unsignedOperand`, which `numberConstant` shares.

   The third build's Result said "no row newly wrong against node"; that
   was wrong for these shapes, which no probe then had.
2. **Two consumer branches were dead.** `booleanWritable(options.family(…))`
   for a declaration and `booleanWritable(expressionFamily(target))` for `=`
   never admitted anything: `provenIrFamily` never names an identifier
   `boolean` or `dynamic`, and an unannotated `=` target is rewritten by the
   write itself. Both now judge the slot by its declared type through one
   `declaredSlotFamily(typeNode)` (`resolveReturnTypeNode` →
   `RESOLVED_KIND_FAMILIES`), which the `return` arm shares, and the
   `localDeclaration` option (annotated or not) replaced `untypedLocal`:
   - a declaration: annotated, `declaredSlotFamily` of its type; unannotated,
     a local `localIsRewritten` clears; a module `var` refuses;
   - `=`: into a local whose declared type takes a boolean (`boolean`,
     `any`); an unannotated local, a module binding and a member target
     (class fields included) refuse.

   `let b: boolean = Number.isNaN(x)` and `let b: boolean = false; b =
   Number.isFinite(x)` now claim with no post-claim error (tests
   `booleanLocal`, `booleanLocalWrite`); `any` slots stay refused by other
   selector arms (`b === true` over the carrier).
3. **`returnSlotFamily` copied `effectiveIrReturnTypeNode`.** The helper's
   parameter is now `ts.SignatureDeclaration`, and `selection.ts` calls it
   on the `return`'s function, with no guard (a `return` always has one).
4. **The two slot arms disagreed on an unresolved kind.** Both now go
   through `resolvedKindFamily`: a slot that is declared but does not
   resolve (a destructured or unsupported parameter, an unsupported result
   type) is `unknown` and refuses. `undefined` (admit) means only "no slot
   of the program's own": a member, ambient or imported callee, or an
   undeclared result. Test `destructuredParameter`.
5. **`a.push(Number.isNaN(NaN))` claims, then withdraws** ("push value i32
   into f64 vec"); main's twin `a.push(1 > 0)` withdraws the same way. It is
   follow-up 11's, not refused in the allow-list: refusing every member
   call's argument would refuse `assert.sameValue(…)` too.

### Review of the fifth build (2026-10-31)

A fifth fresh-context review of `2163e7cd22` approved with nits: nothing
newly failing to compile, no answer newly wrong against node on standalone,
gc or linear, perf within noise, bytes identical. What changed:

1. **Follow-up 11 lists four more generic withdrawals**, each with main's
   twin: a closure capturing a local the unit writes, `throw` of a number in
   a claimed `<module-init>`, a closure returning `undefined as any` into its
   declared `number` result, and a newly claimed `f` withdrawing `C_new`, a
   unit main claims. The Result's "units that became legacy: 0" now says it
   holds for the test262 population, with that case as the counter-example.
2. **`argumentSlotFamily` admitted any identifier callee that is neither
   scope-local nor a top-level function declaration**, including a module
   `const h = (b: boolean) => …` or `var h = function …`, which have a
   parameter slot of the program's own. It now returns `unknown` for any
   callee the source declares (`localValueDeclaration`) other than a
   top-level function; `undefined` stays for a member callee or one declared
   outside the source (lib, imported). Those shapes are refused earlier
   today, on main and here, so the change moves no outcome (census below);
   tests `moduleArrowCallee` and `moduleFunctionExpressionCallee` hold them
   at legacy with no post-claim error.
3. **Comments.** A number is never `undefined` "as main's boxed `Object.is`
   path answers", not "as in legacy's typed arm": main boxes the marker as a
   number and calls its boxed SameValue. `f64-undefined-marker.ts` no
   longer says every value reader must test the bits; it names the readers
   that do and points at follow-up 7 for the ones that do not.
4. **The single-argument check reuses the loop's family** instead of
   recomputing `expressionFamily`.
5. **The Result's "0 grew" is the six-directory corpus's**; a newly claimed
   micro-shape can be 1–4 B larger than main through generic IR lowering.

### Implementation (as built, 2026-10-31, after five reviews)

**`src/ir/static-predicates/`**, in the shape of `src/ir/array-methods/`:

- **`lowering.ts`** owns the one table, `IR_STATIC_PREDICATE_TABLE`
  (`"<Namespace>.<method>"` → `{ arity, test }`), and its matcher
  `staticPredicatePlan` (a direct, non-optional call on the ambient
  namespace). The lowering is matched before receiver lowering, beside the
  Math arm, so no realm read is made. It answers legacy's typed arms op for op:
  - `Number.isNaN` / `isFinite` / `isInteger` / `isSafeInteger` of a number:
    `numberIsPredicateOps` (`f64.ne`, `f64.sub`, `f64.trunc`, `f64.abs`
    against `MAX_SAFE_INTEGER`); of any other primitive: `false`, after the
    operand is evaluated (§21.1.2.x: no ToNumber);
  - `Object.is`: two numbers take `sameValueNumberOps` (the i64 bit compare,
    or both NaN); two strings `string.eq`, re-branded as a boolean; two
    booleans `i32.eq`; two `undefined` or two `null` `true`; two different
    families `false`;
  - `Array.isArray` of a primitive: `false`;
  - a missing argument is `undefined`; `null`, the global `undefined` and
    `void 0` are never lowered (`staticPredicateLiteralFamily`, on #7144's
    `isUndefinedCompareOperand`);
  - a number is never `undefined`, as main's boxed `Object.is` path answers,
    so `Object.is(number, undefined)` is `false`; against `NaN` the answer is
    `x ≠ x`, against another constant equal bits, and otherwise
    `sameValueNumberOps`, all branch-free (`numberConstant` reads the
    constant from the operand's syntax).
- **`selection.ts`** holds the admission, the exact domain of that lowering:
  - at most the plan's arity of arguments, none spread
    (`call-arity-unsupported`); `Object.is` with one number argument only
    when it is a literal;
  - each operand is a literal of the line above, or is proved to lower to a
    number, a string or a boolean (`expressionFamily`,
    `operand-coercion-unsupported`): an unannotated local takes its
    initializer's family, `+` and `&&` / `||` the shared
    `additiveResultFamily` / `logicalResultFamily`, a conditional its arms'
    `conditionalJoinFamily`, a nested static predicate a boolean, an element
    read none, and anything else the selector's proof;
  - the answer is consumed where an IR boolean lowers
    (`booleanAnswerConsumed`, `operand-coercion-unsupported`), an allow-list
    judged with the predicates from-ast withdraws on: conditions, `!`,
    `typeof`, a statement, a template span; the identifier initializer of an
    unannotated local `localIsRewritten` clears; a write `slotWriteVerdict`
    admits a boolean into, judged by the slot's declared type through
    `declaredSlotFamily` (a declaration of or `=` into a local annotated
    `boolean` or `any`, a `return` into a declared result, an argument into a
    top-level function's parameter; a module `var`, a member target and the
    argument of any other callee the source declares refuse; a member, lib or
    imported callee's argument is admitted unless it is a string method's);
    `binaryOperandsAdmissible` against the partner's family,
    `nullComparisonFolds`, a strict `undefined` compare. Through a comma's
    right side, `&&` / `||` with a boolean partner and a conditional branch
    with a boolean partner, the forwarded value's own position decides. Every
    other parent refuses.
  - A dynamic operand is refused. Legacy answers it with its runtime typeof
    test, which this lowering does not make, and the dynamic route is what
    blocker 2 measured.
- **`src/ir/select.ts`** has the adapter: `isPhase1StaticPredicateCall`,
  beside `isPhase1ArraySearchOrJoin` and in its shape, is called after the
  Math arms in `isPhase1Expr`'s member-call branch. Its family proof,
  `provenIrFamily`, is the IR representation's: a module binding's
  slot kind (an f64 is a number, a boolean slot `int32`, a hoisted read of
  `var x = 1` unknown), a native-i32 slot read `int32`, a rewritten
  unannotated local unknown, then `expressionIsProvenNumber`,
  `expressionIsProvenString`, an ambient `String(x)`, and
  `obviousSelectorValueFamily`. An ambient `String(v)` is a string only when
  `v` is a proven number or string. Refusals use `capabilityNo` with the
  verdict's reason (first review, finding 5). The adapter also resolves the
  slots a boolean answer is written into: `declaredSlotFamily` (a type
  node, through `resolveReturnTypeNode`) and `argumentSlotFamily` (through
  `calleeParamResolvedKind`), both mapped by one `resolvedKindFamily`, and
  hands the selection its `localDeclaration` resolver.
  `effectiveIrReturnTypeNode` now takes any signature declaration.
- **`src/ir/from-ast.ts`** gains one arm after the Math arm in
  `lowerMethodCall`, `staticPredicateHost`, and `isAmbientReceiver`, the
  ambient test the Function, Object, JSON, Math and predicate arms now share.
  The host lowers an operand under an f64 hint and names its family with the
  existing `irOperandFamily`. `isUnshadowedUndefinedExpression` became
  `isUnshadowedGlobalExpression(expr, name, cx)`, so the host can also tell
  the global `NaN` from a shadowed one.
- **Reverted from the first build:** the `"call"` use in
  `src/shared/ambient-intrinsics.ts` (the namespace is never read as a value
  now; `isStaticMethodUse` went with it), `dynamicMethodOperandBoxes` with
  the move-only scan edit (finding 4), and the name-first conjunct in
  `isAmbientIntrinsicValue` (second review, finding 6).
- **Size:** `select.ts` +89 lines net (`isPhase1Expr` +3), `from-ast.ts` +25
  (`lowerMethodCall` −10), `lattice-param-facts.ts` +18 (`localIsRewritten`),
  `operand-admissibility.ts` +15 (the two result rules), and three new
  modules: `static-predicates/lowering.ts`, `static-predicates/selection.ts`
  and `f64-undefined-marker.ts` (now shared by `vec-search-join.ts` and
  from-ast's sentinel constant only).

**Tests.**

- `tests/issue-7106-ambient-static-calls.test.ts`, 277 tests, on standalone
  and gc:
  - every method over 28 operand shapes claims `<module-init>` with no
    post-claim error, and answers as node and as legacy. The shapes are
    numbers incl. `-0`, ±Infinity, NaN, 2⁵³, `1 << 31`, `n >>> 0`,
    `Number.MAX_SAFE_INTEGER`, `Math.*`; strings, `typeof`, `String(1)`;
    booleans, comparisons, nested calls; `undefined`, `void 0`, `null`; and
    0–2 arguments.
  - every consumer claims: conditions, `!`, `typeof`, a statement, a comma, an
    equality against a module boolean, `== null`, a ternary branch, `&&`, a
    template, a local `const` initializer, a same-file function's argument and a
    `return` value;
  - refused and still answering as node: the unlisted calls, an array, object,
    hoisted or `"a" + 1` operand, a fourth argument, a spread, `??`, a `+`
    operand, a relational against a number, a loose equality against a
    string, a string method's argument and `throw`; and from the second
    review, a module boolean operand, a logically joined or rewritten local,
    an out-of-bounds or hole element read, a write into a number slot,
    `void`, a member or element read of the answer, and a module boolean
    reached through `||`, a conditional or `String`; and from the third, a
    destructuring declaration and a module `var` initialised by a predicate;
    and from the fifth, a predicate passed to a module arrow or function
    expression callee;
  - from the third review, `LEGACY_PARITY`: a rewritten local declaration
    (`r = 5`, `"s"`, `undefined`), a `@returns {number}` result and a
    `{number}` / `{string}` JSDoc parameter stay legacy with no post-claim
    error and answer as the IR-off run does (legacy's answer is wrong for
    most of them, on main too); from the fourth, a destructured parameter;
  - TypeScript functions with typed operands, including the hot loop:
    IR-claimed, answering as node, with no host import and no
    `__dyn_member_get` / `__ir_dyn_method_call` / `__extern_method_call` in
    the module;
  - TypeScript functions the selector refuses, with no post-claim error and
    node's answers: out-of-bounds reads, a native-i32 field, a module
    boolean, `as any`, `as unknown`, `satisfies`, `!`, a write into an `any`
    slot, and `Object.is(String(<module boolean>), …)`;
  - `Object.is` against constants (`NaN`, `-0`, `0`) and of an arithmetic
    result against `undefined`, a predicate in a local declaration, and in a
    `boolean` local's declaration and later write, IR-claimed and answering
    as node;
  - a number is never `undefined` to `Object.is`: ten shapes over a callee's
    `undefined as any` (`g()`, `+g()`, `Math.abs(g())`, `Number(g())`,
    `Math.min(g(), Infinity)`, a callee returning `+g()`, a conditional, a
    comma, `-g()`, `g() % 2`) answer as the IR-off compile, and as node for
    all but `g()`; `Object.is(g())` stays legacy and `Object.is(-0)` claims.
- `tests/issue-7189-intrinsic-namespace-member-values.test.ts`: `isArrayCall`
  moves to `CLAIMING`, deliberately. The predicate case "refuses a call" is
  back to main's, because the namespace of a call is not a value read. The
  `getPrototypeOf` refusal lives only in this suite's `primitiveCall`.

### Result (measured 2026-10-31, after the fourth review)

Main `89b160ca8d` vs this branch; same scripts as E (`probe-blockers.mts`,
standalone; pass status through `runTest262File`). The three earlier builds'
figures were the same in every row of this table. After the fifth review's
changes the census output is byte-identical, and so are the playground and
shared-piece binaries (26/26, 80/80, 30/30).

| over the 817 files (792 compile) | main | as built |
| --- | ---: | ---: |
| zero-legacy compiles | 0 | 23 |
| files whose legacy codes changed | — | 53 |
| standalone passes among those 53 | 51 | 51 (0 flips) |
| gc passes among those 53 | 51 | 51 (0 flips) |
| newly zero-legacy files passing, standalone / gc | — | 23 / 23 |
| post-claim errors among the 53, standalone + gc | — | 0 |
| units that became legacy, in this population | — | 0 |

- **The 23** are E's 20 plus `Object/is/{same-value-x-y-null,
  not-same-value-x-y-null, not-same-value-x-y-undefined}`: `null` and
  `undefined` are literal operands now. No later review's refusal cost any
  of them.
- The other 30 changed files keep a legacy `<module-init>` or function:
  - 24 move from `expr-ident-not-in-scope` to `operand-coercion-unsupported`
    (an object, symbol, array or dynamic operand, or a consumer refusal);
  - 3 hit the module-init chunk budget (`late-preparation-unsupported`, a
    pre-build refusal);
  - 3 have a function whose first refusal moved past the call.
- The 2 failures among the 53 fail identically on main (Temporal
  `Duration/prototype/total/precision-exact-mathematical-values-{1,2}`).
- **"Units that became legacy: 0" holds for this population only.** A
  newly claimed unit can take a neighbour that main claims down with it:
  the fifth review's `Object.is(g(), c.v)` withdraws `C_new` (follow-up 11).
- **Outside the population,** 95 files that include harness files calling
  these methods in functions are unchanged: same units, codes and details.
- **Probes, all four reviews** (`.tmp/review4/`, which reruns the earlier
  reviews' files against this main): no new compile error and no row newly
  wrong against node. The first review's 530 rows: none worse than main;
  282 module inits newly claimed, all answering as node. The fourth
  review's TypeScript and JS files (`sem1`–`sem4`, `cons-ts`, `cons-js`,
  `member-*`, `jsdocdecl`, `i32`, `twin1`, `t1*`) have no wrong answer main
  does not share, and `r4-marker.mts` answers as main on all 21 shapes. Of
  the 114 module-init post-claim error rows audited against main
  (`pce-audit.mts`), 92 are main's in the same shape; the other 22 are
  follow-up 11's classes, each with a twin on main: an untyped callee's
  typeIdx parity (`userFn*`, `boolParam*`), a generator's `.next()`
  (`retGen`, `genReturn`), `undefined` written into an f64 slot
  (`jsdocParam`). The TypeScript and JS probes add the same classes
  (`anyUndef*`, `isFieldUndef`, `destructArr`, `i32Param`,
  `paramWrittenUndef`, `vecPush`) and follow-up 5's `"ab" + x` (`strLen`).
  Every withdrawn unit answers through legacy.
- **The hot loop** (`.tmp/review4/hot.mts`: one module per shape, base and
  branch instances alternated 31 times, 10⁶ iterations, best time in ms; 0
  host imports on both lanes; `f` IR-claimed unless marked legacy, where
  main is legacy too):

  | shape | standalone main → branch | gc main → branch |
  | --- | --- | --- |
  | `Object.is(i / 2, k)`, `k` a local | 1.81 → 1.80 | 1.80 → 1.79 |
  | `g(a, b) = Object.is(a, b)` over `(i / 2, 3.5)` | 0.89 → 0.90 | 0.89 → 0.89 |
  | `g(a, b)` over `(i / 2, i / 3)` | 2.21 → 2.21 | 2.20 → 2.20 |
  | `g(a, b)` over two locals | 1.79 → 1.80 | 1.80 → 1.79 |
  | `Object.is(i / 2, 3.5)` | 0.89 → 0.89 | 0.89 → 0.89 |
  | `g(a) = Object.is(a, 3.5)` | 0.91 → 0.91 | 0.89 → 0.90 |
  | `Object.is(i * -1, -0)` | 0.81 → 0.81 | 0.81 → 0.83 |
  | `Object.is(i % 3, 0)` | 7.60 → 5.31 | 7.54 → 5.33 |
  | `Object.is(i / (i - 7), NaN)` | 1.93 → 1.28 | 1.94 → 1.28 |
  | `g(a) = Object.is(a, NaN)` | 1.93 → 1.28 | 1.94 → 1.28 |
  | `g(a) = Object.is(a, undefined)` | 24.65 → 0.56 | 23.51 → 0.56 |
  | `Object.is(i / 2, undefined)` | 12.87 → 0.56 | 25.70 → 0.56 |
  | `Object.is(h, undefined)`, `h` a local | 12.72 → 0.56 | 12.82 → 0.56 |
  | `Object.is(i > 5, true)` | 1.82 → 1.75 | 0.86 → 0.86 |
  | `Number.isNaN(i / 0 - 1)` | 1.20 → 1.20 | 1.21 → 1.20 |
  | `Number.isInteger(i / 2)` | 1.86 → 1.88 | 1.88 → 1.88 |
  | `Number.isFinite(i / (i - 7))` | 1.37 → 1.35 | 1.35 → 1.35 |
  | `Number.isSafeInteger(i * 1.5)` | 2.51 → 2.50 | 2.52 → 2.53 |
  | `Object.is(a, "ab1000000")` (legacy) | 13.14 → 13.08 | 13.13 → 13.17 |
  | `!Array.isArray(i)` (legacy) | 0.65 → 0.65 | 0.65 → 0.65 |

  Where the branch emits `sameValueNumberOps` or `numberIsPredicateOps`,
  the ops are main's and the two differ by at most 0.02 ms, the spread of
  repeated runs on this shared box.
- **Other targets:** on `linear`, TypeScript functions over these calls now
  compile and answer correctly; main fails them with "Unsupported method
  call". On `wasi` they are IR-claimed.
- **Bytes** (sha-256, main vs this branch, gc and standalone): all 26
  playground binaries; 345 of 345 from a quarter of the 1/60 test262 sample;
  159 of 159 from the second review's 80 files; the fourth review's random
  100 files, 200 of 200, and its 33 static-using files, 66 of 66 (code
  sections, custom sections stripped); and the shared-piece programs, 80 of
  80 and 30 of 30 (`b3.mts`, `b4.mts`). A name-section-only difference the
  third round saw in `AsyncFromSyncIteratorPrototype/next/absent-value-not-
  passed.js` came from the probe's compile order: a generated name carries a
  checker symbol id that depends on which compiler copy runs first.
- **Sizes** over the six directories (`sizes.mts`): of 168 binary pairs, 0
  grew, 46 shrank, and no host import was added. That holds for this corpus
  only: a newly claimed micro-shape can be 1–4 B larger than main through
  generic IR lowering (a dead `local.tee`, a copy before `+=`), with the
  predicate ops identical and the time equal (fifth review, `wat.mts`).
- **Neighbour suites** (`tests/issue-7118-*`, `tests/issue-7189-*`,
  `tests/issue-7106-*`; main's 51 files against main's sources, this
  branch's 52 against its own): 5 failures on main (702 of 707 pass) and the
  same 5 here (977 of 982), 0 new. All 5 are pre-existing: three
  `semanticProviders: "host-assisted"` tests (removed by #6979), and
  `script-var` "heterogeneous" on both lanes.
- **Equivalence** (`equivalence-gate.mjs`, three shards): 3 028 tests pass;
  the 20 that fail are all in the baseline's known failures, so no new
  regression. Two known failures pass (`delete-sentinel`, `reflect-api`
  `Reflect.construct`), as in the earlier rounds; the baseline is main's to
  ratchet.

**Risks.**

- **gc output changes** where a unit is newly claimed: gc is the native-first
  lane. It adds no host import (measured above).
- **Newly claimed units can grow** through other IR lowerings (second review,
  note 8): `Number("1.5")` in a newly claimed module init takes gc's host
  imports from 3 to 18 and the binary from 38 to 103 KB, and standalone's
  binary from 37 to 92 KB with no import (`dyn.mjs` `numberCallLocal`,
  `.tmp/r2/growth.mts`). Over the six directories none grew (above).
- **A newly claimed unit can reach a generic withdrawal** that main never
  reached because it refused the unit for the boolean static (follow-up 11).
  It then answers through legacy, as main does.
- **A live write to a static** (`Number.isNaN = f`) is not observed, exactly
  as legacy's typed arm does not observe it. The reviewer's `monkey*` probes
  compile-error identically on main and here.

### Follow-ups (not this lever)

1. **Static calls through legacy's untyped arm.** These are exact there (B):
   - `String.fromCodePoint`;
   - `Object.isExtensible` / `isFrozen` / `isSealed`;
   - `Array.of` / `from`;
   - `JSON.parse` with a string operand.

   The route would be a per-(namespace, method, arity) wrapper compiled from
   `compileBuiltinStaticCall` over a detached template, which is the
   `__ir_arr_borrow_<m>_<n>` mechanism. `String.fromCodePoint` could instead
   join #3787's IR `String.fromCharCode` arm. Their test262 files are masked
   until the module-init chunk budget is lifted
   (`fromCodePoint/return-string-value`, `isFinite/finite-numbers`,
   `isInteger/integers`, `isNaN/not-nan`).
2. **`<R>.prototype.<m>` values and `.call`:** 14 of the 37 sole-blocker
   files. This is #7127's family.
3. **Dynamic operands.** `Number.is*(x)` on the carrier is legacy's
   `__typeof_number` test then the f64 op, and `Object.is` on the carrier is
   its SameValue. A native lowering through `dyn.typeof` / `tag.test` would
   admit the harness calls (`typeCoercion.js`'s
   `Number.isInteger(nominalIndex)`, `promiseHelper.js`'s
   `Array.isArray(settleds)`) without the realm read. It needs its own parity
   and import measurement first.
4. **Every boolean producer has the consumer gaps `booleanAnswerConsumed`
   closes for this one.** On main, `!x ?? y`, `!x < 1`, `!x + 1`, `!x != 0`,
   `!x == "s"`, `throw !x` and `"s".indexOf(!x)` claim and then demote
   (`c10`). The consumer rule belongs in the generic binary, `??`, `throw` and
   string-method arms, over every boolean producer.
5. **The `+` selector gap.** `("a" + 1) !== "a1"` claims and then demotes on
   main: the selector admits a `+` that `additiveOperandsProvable` refuses.
   This lever refuses such an operand itself; the generic arm should too.
6. **Legacy bugs found on the way:**
   - `Object.hasOwn("abc", "length")` answers false;
   - `Object.hasOwn(null, k)` does not throw;
   - `Object.create(1)` and `JSON.parse(undefined)` do not throw when the
     operand is untyped;
   - `JSON.parse(null | true)` answers wrongly when the operand is untyped;
   - `Array.isArray()` is a compile error (`__get_builtin`), with or without
     the IR;
   - `throw Number.isNaN(1)` caught as `e` gives `e !== false`;
   - `(c ? Number.isNaN(NaN) : 0) !== true` and
     `typeof (c ? Number.isNaN(1) : 0)` answer wrongly (`c4`, `c6`);
   - `Number.isNaN(x).constructor === Boolean` answers false, and
     `(Number.isNaN(x) as unknown) === true` answers false for NaN, both
     lanes (refused here, so legacy keeps them);
   - legacy answers `Object.is(a[5], NaN)` and `Number.isNaN(a[5])` wrongly
     for an out-of-bounds read (`bool.mjs` / `twin.mjs` `blockArrOOBIsNaN`).
7. **A number is never `undefined` to these predicates**, on main and here:
   legacy's f64 `undefined` marker counts as NaN in `Number.isNaN`, and
   `Object.is(number, undefined)` is `false`. A sound marker test needs IR
   producers that canonicalise a NaN's payload (`+x`, `Number(x)`,
   `Math.abs` and the `Math.min` lowering carry it through, so a callee
   returning `+g()` hands back the marker's bits) or an `undefined` that is
   not a NaN. Testing reads cost 30–100 % on the measured loops (third
   review) and misread `+g()` (fourth review).
8. **An out-of-bounds f64 read in IR is not `undefined`.** It reads NaN on
   the GC lanes and 0 on linear (`emitSafeVecGet`), never legacy's marker.
   This lever refuses an element read as an operand; reading the marker
   there would let every consumer (`=== undefined`, `typeof`, these
   predicates) answer it.
9. **A module boolean reads as an unbranded i32.** These predicates refuse
   it (`int32`); a branded read would admit it here and in every
   brand-reading consumer.
10. **A definite-assignment or `declare` field that is never assigned reads
    0.** With `class C { v!: number }`, `Object.is(c.v, undefined)` answers
    false on main and here; node answers true (`.tmp/marker-ts.mts`). The
    unit is newly claimed here, with main's answer. The fix is the field's
    initial value (the marker), not this lowering.
11. **Generic post-claim withdrawals the lever newly reaches**, each on main
    too in a twin without a boolean static, each answering through legacy:
    - an untyped JS callee (`function id(v) { return v; }`) called from a
      claimed `<module-init>` withdraws on a typeIdx parity mismatch, with
      any argument (`id(1)` on main);
    - a parameter typed with the `i32` alias (`f(x: i32)`) withdraws with
      "object TypeNode TypeReference could not be lowered", whatever the
      body (`i32NativeTwin`);
    - a write of `undefined as any` (or `undefined` in JS) into an f64 slot
      withdraws on the assignment (`twinAssignUndef`);
    - its closure-return form: a closure that returns `undefined as any`
      into its declared `number` result
      (`const h = (): number => undefined as any;` and
      `Number.isNaN(h())`) withdraws with "closure body type
      dynamic<tag:1> != declared return f64" (main's twin `h() === 1`);
    - a closure that captures a local the unit writes
      (`let b: boolean = false; const g = (): number => (b ? 1 : 0);
      b = Number.isNaN(x); return g();`, or the predicate in the
      initializer and `b = false` later) withdraws with "closure inside f
      captures non-local binding "b" — not in slice 3" (main's twin
      `b = x > 1`);
    - `throw` of a number in a claimed `<module-init>` withdraws with
      "throw val not in slice 9": `{ const b: boolean = Number.isNaN(NaN);
      if (!b) throw 1; }`, or a predicate local beside
      `try { throw 1; } catch (e) {}` (main's twins with `1 > 0`; 18 rows in
      the fifth review's `mi-ts-twin.mjs`);
    - a newly claimed unit can withdraw a neighbour main claims. With
      `function g(): number { return undefined as any; }` and
      `class C { v: number = 0; }`, `f` returning
      `Object.is(g(), new C().v)` (or reading a field written from `g()`,
      `fieldFromCall`) is claimed here, and `C_new`, which shares a prepared
      component with `f`, withdraws with "prepared component … has
      incomplete dependencies" because `g` fails verification. Main refuses
      `f` and claims `C_new`; its twin `g() === c.v` claims `f` and
      withdraws `C_new` the same way;
    - `const [a] = [x]` withdraws (the third review's list);
    - a generator called from a claimed unit withdraws on `.next()` over an
      externref, and the generator itself on host-free targets
      (`genTwin`);
    - `a.push(Number.isNaN(NaN))` on a number array withdraws with "push
      value i32 into f64 vec" (main's twin `a.push(1 > 0)`); a member
      call's argument stays admitted, because refusing it would refuse
      `assert.sameValue(…)`;
    - `"ab" + x` that `additiveOperandsProvable` refuses is follow-up 5.

    A hoisted module `var` read before its initializer
    (`function f() { return Object.is(b, undefined); } f(); var b = 1`)
    claims and gives main's wrong answer (`r3-ops.mjs` `hoistedVar`).
12. **The generic `String(v)` selector arm admits an operand from-ast cannot
    render** (an unbranded i32: a module boolean, a native-i32 slot) and
    withdraws on "String() of i32 operand is deferred", on main
    (`String(t) === "true"`). The second build refused it there; the third
    review had that reverted from this lever because it spread: with it, `var
    t = true; function f() { return String(t); } f();` kept `<module-init>`
    legacy where main claims it, a test262 binary with no boolean static
    changed (297 829 → 297 775 B, gc and standalone,
    `AsyncFromSyncIteratorPrototype/next/absent-value-not-passed.js`), and
    `String((0, t))` still withdrew. Its own change needs the operand's IR
    representation, not a second syntactic proof.
13. **One untyped-local tracer.** This lever's `expressionFamily` and the
    planned-closure walker (`plannedClosureOperandRefusal`'s `slotProof`)
    both trace an unannotated local to its initializer's family. The walker's
    copy is keyed by name over one planned closure and seeded with the plan's
    parameters; lifting it into a shared resolver-based tracer would serve
    both.

None of these is filed. `claim-issue.mjs --allocate` needs its open-PR scan,
and `gh` has had no valid token in these sessions (`gh auth status`: "The
token in GH_TOKEN is invalid", rechecked 2026-10-31 after the third review).
Reserving without the scan (`--no-pr-scan --allow-unscanned`) risks a
duplicate id, so I did not.

## `<module-init>` lever: destructuring binding patterns (plan, 2026-11-01)

Plan only; nothing here is implemented. Measured on `a7f413918c` (origin/main,
2026-11-01), standalone unless a row says gc. Every census compiles the
conformance runner's harness assembly (`assembleOriginalHarness`) with
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`, so each refused
`<module-init>` statement reports its refusal, not only the first one.
Pass/fail is `runTest262File` (sloppy run plus strict rerun). The scripts live
in the planning worktree's `.tmp/dstr/` (`census.mts`, `shapes.mts`,
`ceiling.mts`, `run.mts`, `compare.mjs`). The prototype is
`.tmp/proto/proto.diff` plus `.tmp/proto/proto-literal-pattern.ts`, gated by
`PROTO_DSTR`, `PROTO_DSTR_LET`, `PROTO_LIT` and `PROTO_THROW`.

### Population

- 288 test262 files have a binding pattern in a `for (;;)` head: 285 in
  `language/statements/for/dstr/`, 2 in `staging/sm/lexical-environment/`,
  1 in `language/statements/for/`. 18 are negative, so 270 compile.
- `for-init-name` (`select.ts:5458`) is refused in 150 of them: in
  `<module-init>` in 146, in a function unit in 4.
- It is the **only** refusal of any unit in **94**: the 47 generated
  `for/dstr` cases, each once as `let` and once as `const`. All 94 pass on
  main on both lanes, through legacy.
- The request's 70 / 214 came from a first-wins census on `ecf6d64de5`.
  With every refusal unmasked on `a7f413918c` the figures are 94 / 150.
- The 95 `var` heads never reach `for-init-name`. A script-level
  `for (var …)` is refused first as `for-init-var-kind` (72 files), because
  `collectIrSafeModuleVarDeclarationLists` (`function-local-var.ts:171`)
  admits only `VariableStatement` lists. A `var` leaf is a hoisted script
  var with a `__mod_` slot, so it belongs with S5 below.

### Shapes

The 47 cases (each counts twice, `let` and `const`):

| group | cases | example | what it needs |
| --- | --- | --- | --- |
| A in-range reads | 5: `ary-name-iter-val`, `ary-ptrn-elem-id-iter-val`, `obj-ptrn-id-trailing-comma`, `obj-ptrn-prop-id`, `obj-ptrn-prop-id-trailing-comma` | `[x, y, z] = [1, 2, 3]` | one read per leaf |
| B `undefined` leaf | 6: `ary-ptrn-elem-id-iter-complete`, `-iter-done`, `-init-exhausted`, `-init-hole`, `-init-undef`, `obj-ptrn-prop-id-init` | `[x = 23] = [,]` | past-the-end, hole and `undefined` read as `undefined`; the default runs only then |
| C nested | 12: `ary-ptrn-elem-ary-elem-init`, `-elem-iter`, `-ary-empty-iter`, `ary-ptrn-elem-obj-id(-init)`, `ary-ptrn-elem-obj-prop-id(-init)`, `obj-ptrn-prop-ary(-init, -trailing-comma)`, `obj-ptrn-prop-obj(-init)` | `[{ x, y, z } = { x: 44, y: 55, z: 66 }] = []` | recursion; a nested pattern's default is its source |
| D rest | 5: `ary-ptrn-rest-ary-elem`, `-id-direct`, `-id-exhausted`, `-obj-id`, `-obj-prop-id` | `[...{ length }] = [1, 2, 3]` | the remaining elements as a list; `length` and index keys on it |
| E TypeError | 8: `ary-ptrn-elem-ary-val-null`, `ary-ptrn-elem-obj-val-null`, `-obj-val-undef`, `obj-init-null`, `obj-init-undefined`, `obj-ptrn-prop-ary-value-null`, `obj-ptrn-prop-obj-value-null`, `-obj-value-undef` | `{} = null` | throw TypeError when `null`/`undefined` is destructured |
| F function-name defaults | 8: ary/obj × arrow, cover, fn, gen | `[fn = function () {}] = []` | an anonymous function as a value, named by its leaf |
| G unresolvable default | 3: `*-id-init-unresolvable`, `obj-ptrn-prop-id-init-unresolvable` | `[x = unresolvableReference] = []` | ReferenceError for an undeclared global |

Feature counts (files):

| feature | 94 sole | 146 module-init carriers | 288 for-head files |
| --- | --- | --- | --- |
| array pattern / object pattern | 54 / 40 | 93 / 53 | 188 / 100 |
| any default | 58 | 78 | 141 |
| nested pattern | 42 | 58 | 99 |
| elision in the pattern / hole in the source literal | 2 / 2 | 14 / 2 | 30 / 3 |
| array rest / object rest | 10 / 0 | 24 / 4 | 66 / 9 |
| anonymous function default (name inference) | 12 | 16 | 24 |
| source: array literal / object literal / `null`,`undefined` | 54 / 36 / 4 | 74 / 46 / 4 | 132 / 81 / 6 |
| source: identifier / call (iterable, generator) | 0 / 0 | 18 / 4 | 63 / 6 |
| head inside a function (`assert.throws(…, function () { for … })`) | 22 | 24 | 84 |

- **Iterator protocol.** None of the 94 destructures a non-literal source.
  Generators appear in 4 of them only as `function* () {}` defaults (group
  F). Custom iterables, generator sources and `return()` closing
  (`ary-init-iter-close`, `-iter-no-close`, `ary-ptrn-elision`,
  `-iter-step-err`, …) are in the 52 non-sole carriers, which also carry
  `Symbol`, `objectlit-empty` or generator-unit refusals.
- **TDZ.** No file in the 288 reads a pattern's own leaf from a default or
  from the source. The 24 ReferenceError files among the 94 test
  unresolvable references instead: group G, and
  `assert.throws(ReferenceError, () => x)` where `x` is a property key that
  is not bound.

### Existing IR support

The IR already lowers destructuring for locals, so this lever extends that
lowering. It must not add a second one.

- **Selector.** `isPhase1BindingPattern` (`select.ts:7068`) admits flat
  identifier leaves, elisions and renames. It refuses defaults, rest,
  nesting and computed keys. Four consumers call it:
  - `VariableStatement` (`isPhase1VarDecl`, `:6830`): `const` only
    (`vardecl-dstr-let`), and every pattern at module init
    (`vardecl-module-destructuring`, `:6846`);
  - parameters (`:2141`): typed only. An untyped pattern parameter is
    `param-type-not-resolvable`, and a reassigned leaf is
    `param-pattern-mutation`;
  - for-of heads (`:5037`): array patterns only;
  - closure parameters (`select-closure-literal.ts:66`).
- **Builder.** `lowerBindingPattern` (`from-ast.ts:4199`) dispatches to:
  - `lowerObjectPattern` (`:4565`): `object.get` / `class.get` on a closed
    shape; a key outside the shape demotes after the claim;
  - `lowerArrayPattern` (`:4649`): an **unchecked** `vec.get`, which traps
    when the source is shorter than the pattern.
  Leaves bind as SSA locals.
- **A second array walker** exists for for-of heads:
  `declareForOfPatternLeafSlots` / `bindForOfArrayPatternLeaves`
  (`:12702` / `:12741`). It binds slots and reads through the bounds-checked
  `emitSafeVecGet`, with the element's zero as the out-of-range value
  (legacy parity).
- **The for-head already lowers.** `lowerForStatement` (`:12316`) hands the
  init to `lowerVarDecl` → `lowerVariableDeclaration` (`:4238`), which
  reaches `lowerBindingPattern`. Only the selector arm refuses.
- **Leaf names are collected four ways:**
  - `collectPatternNames` (`select.ts:7115`, flat only);
  - `collectBindingNames` (`analysis/loop-shape.ts:627`);
  - `collectBindingPatternNames` (`analysis/ast-scope.ts:52`);
  - the inline `leafIsModuleBinding` in `lowerVariableDeclaration`.
- **No dynamic reader.** `dyn.member_get` and `iter.new/next/done/value/return`
  exist, with native `__dyn_member_get` / `__iterator*` on standalone, but no
  pattern reads through them.
- **Defect on main.** In a `.js` file,
  `function f() { const [x, y, z] = [1, 2, 3]; … }` is claimed at select and
  demoted at build on both lanes ("array literal flows into a
  widening/heterogeneous sink"): the checker types the literal as a tuple of
  `any`. Under S1 below, the for-head `[x] = []` and `[_, x] = []` fail the
  same way ("empty array literal needs a vec-typed hint").

### Measured with an uncommitted prototype

Each slice includes the ones above it. "Demoted after claim" counts
`<module-init>`s that selection admitted and the build then demoted.

| slice | change | legacy-free, 94 sole (standalone / gc) | legacy-free, 288 | demoted after claim | lost |
| --- | --- | --- | --- | --- | --- |
| base | — | 0 / 0 | 0 | 0 | — |
| S1 | the for-init arm calls the `VariableStatement` pattern check; `let` admitted | 2 / 2 | 2 | **8** (`[x, y, z] = [1, 2, 3]`, `[x] = []`, `[_, x] = []`) | 0 |
| S1+S2 | plus a literal-source reader | 32 / 32 | 32 | 0 | 0 |
| S1–S3 | plus TypeError for a `null`/`undefined` (sub)source | **48 / 48** | **48** | 0 | 0 |

S2 frees 16 cases: 3 of group A, 5 of B, 5 of C and 3 of D. The rest of
A–D are blocked by the arms in the residual table below. S3 adds all 8 cases
of group E. All 48 S1–S3 files pass on both lanes (`runTest262File`, 48/48
standalone, 48/48 gc), so there are 0 pass→fail flips.

The remaining 46 of the 94 are blocked outside this lever:

| blocker | files | what unblocks it |
| --- | --- | --- |
| a read of an undeclared global must throw ReferenceError (`expr-ident-not-in-scope` on `unresolvableReference` ×6, or on the unbound key `x` ×6, `w` ×8, `u` ×4) | 24 | an unresolvable-reference arm |
| an anonymous function or generator as a value (`closure-return-type` ×12, `closure-generator` ×4) | 16 | function objects as values, then named evaluation |
| rest bound to an identifier (`[...x]`, `[, , ...x]`); the tests then call `Array.isArray` | 4 | a fresh vec from the remaining values, and `Array` as a value |
| `ary-ptrn-elem-ary-empty-iter`: the never-evaluated IIFE default still reaches the call-graph scan (`external-call`) | 2 | the scan skips defaults the plan does not run |

**Byte identity (S1–S3 prototype vs `a7f413918c`, sha256 of each binary).**
The population is 516 files: the 288 for-head files plus 228 other files
with a lexical pattern over a literal source (`let/dstr`, `const/dstr`,
`for-of/dstr`, `for-await-of`, …). 409 compile on both sides, 47 fail to
compile on both, and 60 are skipped (negative, raw or module).

| lane | binaries changed | of which a newly claimed `<module-init>` | other changes |
| --- | --- | --- | --- |
| standalone | 48 / 409 | 48 | 0 |
| gc | 48 / 409 | 48 | 0 |

No file outside the 288 changed. The 1/60 corpus sample and the playground
examples were not measured.

### Target structure

**Modules.**

- `src/ir/binding-pattern-plan.ts` (new, pure AST, no builder). It holds
  `planBindingPattern(pattern, source, facts)`, which returns either a refusal
  code or a plan:
  - the source expressions to evaluate, in source order;
  - one read per leaf, in pattern order;
  - each default, and whether it runs;
  - nested sub-plans;
  - a TypeError step.
  The selector checks every expression in the plan with `isPhase1Expr` and
  every leaf name against the scope. The builder lowers exactly the same plan.
  Select and build cannot disagree, because both consume one function's
  output; that fixes the claim-then-demote defect above. The module replaces
  `isPhase1BindingPattern` and `collectPatternNames`.
- `src/ir/binding-pattern-lowering.ts` (new, AST→IR, beside
  `array-element-lowering.ts`, no import of `from-ast.ts`). It receives the
  builder and two callbacks: lower an expression, bind a leaf. It is one
  walker over the plan, with one reader per source kind:
  - `literal` (S2): a fresh array or object literal. Reads are compile-time,
    and no aggregate is built.
  - `vec`: a typed array value. Reads go through `emitSafeVecGet`, never the
    unchecked `vec.get`.
  - `object` / `class`: a closed shape. A key outside the shape is refused
    at select.
  - `dynamic` (S4): `dyn.member_get` per key after RequireObjectCoercible;
    `iter.new` / `iter.next` / `iter.done` / `iter.value` per element, and
    `iter.return` when the pattern ends before `done` (IteratorClose).
  `lowerBindingPattern`, `lowerObjectPattern`, `lowerArrayPattern`,
  `declareForOfPatternLeafSlots` and `bindForOfArrayPatternLeaves` move here
  and become this walker.
- **Leaf binding.** Extract the identifier tail of `lowerVariableDeclaration`
  into one `bindDeclaredName(name, value, isConst, cx)`:
  - a module binding writes its `__mod_` global;
  - a reassigned `let` gets a slot through
    `resolveMutableLocalRepresentation`;
  - anything else is an SSA local.
  Identifier declarations, pattern leaves and parameter leaves call it. The
  for-of head passes its pre-declared slots as the sink. That retires
  `vardecl-dstr-let` and `param-pattern-mutation`.
- **Selector.**
  - The pattern branch of `isPhase1VarDecl` becomes
    `isPhase1DeclarationPattern(d, isConst, scope)`, called by the
    `VariableStatement` arm and the for-init arm (`:5458`).
  - The two copies of the for-init "leak" loop (`:4763`, `:6021`) become one
    `recordForInitLeaks`, which also leaks pattern leaves.
  - `nullConsumerFamily` (`select-planned-closure-operands.ts:159`) asks the
    plan whether a `null` inside a pattern source is evaluated. A `null`
    that is only destructured is never a value; without this, every group-E
    `null` case is refused as `closure-null-value`.
  - The call-graph scan skips defaults the plan does not run.
- **Realm keys.** The literal reader may answer `undefined` for a key the
  literal lacks only if `%Object.prototype%` (for an object literal) or
  `%Array.prototype%` + `%Object.prototype%` (for an array literal) do not
  own it. One exported `realmStringKeys(...ids)` over `NATIVE_REALM_CATALOG`
  replaces `OBJECT_PROTOTYPE_KEYS` (`empty-object-literal.ts:113`) and
  `FUNCTION_REALM_MEMBER_NAMES` (`select-expression-structure.ts:114`).
- **TypeError.** The TypeError step reuses `emitThrowTypeErrorIf`
  (`throw-type-error.ts:8`) through the native `__new_TypeError`; it adds no
  import.

**Duplicates removed.**

- One leaf-name collector, `collectBindingPatternNames`, instead of four.
- One array walker instead of two.
- One leaf binder instead of three mutation policies (`const` only, the
  `param-pattern-mutation` refusal, for-of slots).
- One realm-key helper instead of two copies.
- One for-init leak loop instead of two.

**Code-quality acceptance criterion.**

- `src/ir/select.ts` and `src/ir/from-ast.ts` do not grow; the moved pattern
  code makes both net negative.
- Each new module stays under 400 lines, and no function exceeds 80 lines.
- No `func-budget-allow:` or `loc-budget-allow:` grant.
- No pattern-shape predicate outside `binding-pattern-plan.ts`.
- The pattern lowering contains no `demoteToLegacy`; a selector/builder
  disagreement there is an `IrInvariantError`.
- No host import on standalone. The runner rejects one there, and the
  prototype's 48 newly claimed files pass on standalone.
- gc and standalone binaries are byte-identical for every program in which
  no unit changes owner. Measure with the census sha on the 516 files above,
  the 1/60 corpus sample and `website/playground/examples`.
- The fresh-context adversarial review asks specifically for a second walker,
  a second shape predicate, or an arm that differs from its sibling only by
  source kind.

**Correctness acceptance criterion.**

- 0 pass→fail on the 288 for-head files and the 228 other literal-pattern
  files, on both lanes. Every newly claimed file passes on both lanes.
- A unit test per rule:
  - every literal element is evaluated before any default, in source order;
  - a default runs on `undefined` (missing, elision, hole, literal
    `undefined`) and not on `null`, `0` or `""`;
  - `{ toString } = {}` and `[...{ map }] = [1]` stay legacy (realm keys);
  - a reassigned `let` leaf reads its slot after the write;
  - a nested pattern takes its default literal as its source;
  - `[...{ length, 0: a, 9: b }] = [1, 2]` binds `2`, `1`, `undefined`;
  - `{} = null` throws TypeError inside `assert.throws`;
  - `function f() { const [x, y, z] = [1, 2, 3]; … }` in a `.js` file is
    claimed and not demoted.

### Slices

| slice | scope | measured gain (94 sole, both lanes) |
| --- | --- | --- |
| S1 | Structure only: the two new modules, the shared predicate, binder and name collector, for-head routing, `let` leaves. Today's flat shapes keep today's readers, but a shape the builder cannot type (an `any`-typed or empty array literal) is refused at select. | +2, and the 8 claim-then-demote files go back to a select refusal |
| S2 | The literal reader: defaults, elisions, holes, nesting, rest into a nested pattern, `length` and index keys on an array literal. | +30 (32 total) |
| S3 | The TypeError step, and the `nullConsumerFamily` question to the plan. | +16 (48 total) |
| S4 | The dynamic reader for untyped sources (identifiers, calls, generators), with IteratorClose. Unblocks untyped pattern parameters (`param-type-not-resolvable`) and for-of object heads (`forof-head-object-pattern`). Coordinate with #3522 R3 (closure-parameter destructuring reuses `lowerBindingPattern`) and #7126 item 3 (class shape for destructured method parameters). | not measured; the 22 non-sole carriers with identifier or call sources also need `Symbol` / generator units |
| S5 | Script-level patterns: `var` for-heads and `vardecl-module-destructuring`. `buildModuleBindingsMap` maps each leaf (it throws today, `integration.ts:6307`), and `bindDeclaredName`'s module-binding arm writes the slot. | not measured |

Recommendation: ship S1 and S2 as one PR, because S1 alone frees 2 files.
Then S3. Together they make 48 of the 94 files legacy-free, with no new
runtime helper and no host import on standalone. The other 46 wait on the three non-destructuring
arms in the residual table.

### Risks

- **Realm integrity.** The literal reader assumes the array iterator and
  `Object.prototype` are unpatched. The IR's vec for-of path and
  `lowerArrayPattern` already assume this. Programs that patch
  `Array.prototype[Symbol.iterator]`, `%ArrayIteratorPrototype%.next` or
  `Object.prototype` must stay legacy through one program-level fact
  (`*-array-prototype` for/dstr files exist). In this measurement they
  already carry other refusals, so the guard is untested by the 288.
- **Out-of-range parity.** The for-of reader binds the element's zero past
  the end, for legacy parity (`emitSafeVecGet`'s `oobOverride`). JavaScript
  binds `undefined`. When the two walkers merge, keep the override only on
  the for-of `vec` reader. Fixing it is a separate behaviour change with its
  own A/B.
- **Per-iteration `let`.** A closure that captures a for-head `let` leaf sees
  a fresh binding per iteration. Keep whatever rule identifier for-heads use
  today (no such capture occurs in the 94).
- **Conflicts.** `select.ts` and `from-ast.ts` are the busiest IR files.
  Move the pattern code in one short-lived PR, and rebase nothing onto it.
- **Overlap.** #3522's closure-parameter destructuring and #7126 item 3 call
  `lowerBindingPattern` / `isPhase1BindingPattern`; their call sites move.
  Announce the move on both issues before S1 lands.

### Implementation (S1–S3, 2026-11-01)

Built on `claude/7106-for-head-destructuring`, one commit per slice, measured
against `21b452861d`:

- S1 `30beb731d1`
- S2 `a89e71f76a`
- S3 `e590431daf`

Each census uses `.tmp/dstr/census.mts` on both trees: the 858 files are the
288 for-head files, 228 other literal-pattern files and a seeded random
sample of 345 test262 files.

| measure | standalone | gc |
| --- | --- | --- |
| legacy-free, the 94 sole-blocker files (base → head) | 0 → **48** | 0 → **48** |
| legacy-free, the 288 for-head files | 0 → 48 | 0 → 48 |
| legacy-free, 228 literal-pattern files / 345-file sample | 0 → 0 / 7 → 10 (3 sample files are for/dstr) | same |
| binaries changed, of 712 compiled | 48, each with a newly claimed `<module-init>` | 48, the same files |
| pass→fail on the 48 changed files (`runTest262File`) | 0 (48/48 pass before and after) | 0 (48/48) |
| post-claim errors | none new: the same 49 files carry the same pre-existing errors on both trees | same |
| host imports added | 0 | 0 |
| playground examples (13) | byte-identical | byte-identical |

Unchanged binaries keep their verdicts, so there are no flips outside the 48.

`src/ir` line delta: +601 / −277.
- `select.ts`: −44.
- `from-ast.ts`: −22.
- New modules: `binding-pattern-plan.ts` 347 lines, `binding-pattern-lowering.ts` 46, `realm-keys.ts` 19.
- No budget grant was added.
- Gates, each run bare, all exit 0: loc, func, coercion-sites, oracle-ratchet, dead-exports, typecheck, lint,
  ir-fallbacks, test:changed-root, import-cycles, compiler-boundaries (`--mode inventory`, as CI runs it).

**Deviations from the plan.**

- **Two walkers still exist.** `src/ir/binding-pattern-lowering.ts` holds
  only the literal reader. The typed readers (`lowerObjectPattern` /
  `lowerArrayPattern`) and the for-of walker stay in `from-ast.ts`. Merging
  them changes behaviour (the for-of reader binds zero past the end, the
  VariableStatement reader traps), so they are follow-ups (a) and (b).
- **One leaf binder.** Literal leaves and typed leaves both bind through
  `bindLocalName`. Parameter leaves keep the `param-pattern-mutation`
  refusal (S4).
- **`let` is admitted for literal sources only.** A typed (non-literal)
  source keeps `vardecl-dstr-let`, because its leaves are not proven to have
  a slot representation.
- **Pattern leaves do not leak out of a for-head.** `recordForInitLeaks` (the
  folded leak loop) leaks identifier names only. A pattern leaf stays inside
  its loop, which is stricter and needs no sibling-redeclaration exemption.
- **A `null` leaf is refused.** A bare `null` value has no carrier in that
  position (`[x = 1] = [null]` demoted after the claim in the first build),
  so the plan only ever skips or destructures a `null`.
- **Already-claimed literal sources lower differently.** A function-local
  `const { a } = { a: 1 }` that the object reader already claimed now goes
  through the literal plan, with no allocation. None of the 858 files or the
  playground examples has one.

**Follow-ups.**

- **(a)** Fold `declareForOfPatternLeafSlots` / `bindForOfArrayPatternLeaves`
  into `binding-pattern-lowering.ts` as the `vec` reader. Keep the for-of
  zero-past-the-end override, which needs its own A/B.
- **(b)** Move the typed readers out of `from-ast.ts`. Replace their
  unchecked `vec.get` with `emitSafeVecGet`. Admit `let` for typed sources.
- **(c)** The call-graph scan still sees a default that the plan never runs
  (`ary-ptrn-elem-ary-empty-iter`, 2 files: `external-call`).
- **(d)** Legacy answers these wrongly (measured while writing the tests):
  - `var u; const [x = 5] = [u]` (default on an undefined variable);
  - `const { toString: t } = {}` (`t !== Object.prototype.toString`);
  - `const [a = 1, b = a] = []`.

  The IR refuses all three, so they stay legacy bugs.
- **(e)** Pre-existing on main, unrelated: `tests/issue-1372-ir-destructuring-params.test.ts`
  AC#1 and 22 cases of `tests/issue-2001-s1-hole-literal.test.ts` fail on
  `21b452861d` too.


### Review round 1 (2026-11-01)

The #7024 review asked for changes: one blocker, four majors, two groups of
nits. Each is fixed or rebutted below, measured on a base tree of `6c732c42ea`
(the `origin/main` this branch merged). The reviewer's probes (`c1`–`c3`,
`t1`) were re-run on that base and on the new head. Every repro they flagged
either runs correctly now or behaves exactly as on main, where it fails the
same way without any destructuring.

**1. Blocker: a write to a `const` leaf failed the compile. Fixed.**

- The selector now refuses a declaration with any written leaf, through
  `declarationBindingWritten` (`const-binding-writes.ts`). A write is an
  assignment, update, destructuring or for-in/of target, or a later `var`
  re-declaration, nested functions included. The scope is the leaf's block,
  `switch` case block or `for` statement (`let`/`const`), or its function
  (`var`).
- This applies to both readers. Main also failed the compile on
  `const { a } = { a: 1 }; a += 1` and `const { a } = o; a = 2`; both now
  throw the TypeError through legacy.
- `isWriteToConstDeclaration` stays identifier-only. No claimed pattern leaf
  can reach it now: written declaration leaves are refused, and for-of head
  leaves are slots. Follow-up (h) covers the for-of case.

**2. New claim-then-demote shapes. Fixed; three rebutted with measurements.**

Fixed:

| shape | fix |
| --- | --- |
| reassigned `let` leaf (all four repros) | refused by the written-leaf rule from finding 1 |
| `const [a] = [[1, 2, 3]]`, `const { a } = { a: { b: null } }` | in a `for (;;)` head, refused: the plan no longer binds a literal whole. In a function body (corrected in round 2): the typed reader still claims, then demotes, unchanged from main; follow-up (g) |
| `const { 3: a } = [1]` | an index past the end of an array literal is refused: it reads `Array.prototype` |
| `for (const { x } = { __proto__: … };;)`, `for (const [a, b] = 'xy';;)` | a `for (;;)` head takes the literal plan only (`for-init-dstr-source`); main refused every head pattern |

Rebutted:

- **The `f()` call inside an `assert.throws` closure.** This gap is older
  than destructuring. On main,
  `assert.throws(TypeError, function () { f(); return; })` produces the same
  `direct call to "f" has no exact AST-site plan` post-claim error. Follow-up
  (f).
- **`const [a, b] = [1, 'x']; return a + b`. Withdrawn in round 2.** The
  identifier twin fails the same way on main, but main refused this
  declaration, so this PR created the new claims. Round 2 refuses them at
  selection.
- **A function-body `VariableStatement` the plan refuses still goes to the
  typed reader.** That reader produces the same post-claim errors as on main,
  for example `const [a] = [[1, 2, 3]]`, `const { a } = { a: { b: null } }`
  and `const { a } = null as any` (`tsNestedWhole`, `jsNullInWhole_js` and
  `tsTypeErrNull` in `t1`, unchanged from main). Follow-up (b) owns the typed
  reader.

**3. No realm guard. Fixed.**

- `programPatchesDestructuringRealm` (`realm-keys.ts`) refuses both readers
  in a program that patches `Array.prototype` or `Object.prototype`: a member
  assignment, a `delete`, or `Object.defineProperty`/`defineProperties`.
- It reads `sourcePatchesPrototype`, the #1719 scan moved to
  `src/shared/intrinsic-prototype-writes.ts`. That scan now answers for both
  intrinsics.
- The #1719 brand (`sourceOverridesArrayIterator`) delegates to the same
  scan, so the two cannot disagree. Its exact-statement seam
  `directArrayProtoIteratorAssignment` was subsumed by the general assignment
  match, so it is removed along with its two unit tests.
- Results: `fC3` and `fC4` now run correctly through legacy. The first build
  claimed them and answered wrongly; main claimed them through the typed
  reader, then demoted.
- Limit: the scan misses a patch made through an alias or
  `%ArrayIteratorPrototype%` (`fC5`). Legacy gets that case wrong too: it
  threw on main.

**4. A third walker. Fixed.**

- `lowerPatternPlan` (`binding-pattern-lowering.ts`) now lowers every
  declaration and parameter pattern. The source is a strategy of the host:
  - a typed source answers `read`, with `fieldReader` / `elementReader` in
    `from-ast.ts`;
  - a literal plan reads nothing (`readsNoSource`).
- The typed plans are `planPropertyReads` / `planElementReads`, and
  `isPhase1BindingPattern` is defined by them. `lowerObjectPattern` /
  `lowerArrayPattern` are gone.
- The for-of head keeps its own binder, for a structural reason. Its leaves
  are slots declared once outside the body, and each iteration writes them
  through a bounds-checked read with legacy's zero override. A single-pass
  walker does not model that.
- Its leaf enumeration does come from `planElementReads` now.

**5. A duplicated `undefined`-shadow guard. Fixed.**

- Superseded in round 2 (finding 4): one program-wide fact replaces the
  per-caller predicate, because a flat scope misses a later block's
  `let undefined`.

**6. Nits. Fixed; one claim rebutted.**

- `skipParentheses` → `stripParens` (`src/shared/binding-writes.ts`).
- `isUndefinedLiteral` → `isUndefinedCompareOperand`.
- `isAnonymousFunctionDefinition` moved verbatim to
  `src/shared/named-evaluation.ts`. Codegen imports it from there too; an
  `ir/analysis` home would have added two codegen→ir edges to the
  import-cycle ratchet.
- `propertyKey` and the three private `phase1PropertyName` copies
  (`select.ts`, `from-ast.ts`, `propagate.ts`) are now one exported
  `phase1PropertyName` in `property-key-fold.ts`.
  - **Rebutted:** the review said that copy lacks numeric canonicalisation.
    It does not: TypeScript's scanner already stores the canonical form in
    `NumericLiteral.text`. `property-key-fold.ts` records 16 spellings, and
    re-checked here: `1.0`→`1`, `0x2`→`2`, `1e21`→`1e+21`, `0b11`→`3`,
    `.5`→`0.5`. `String(Number(text))` was a no-op.
- `BindingLeaf` replaces the inline type at both `select.ts` sites.

**7. Nits. Fixed.**

- The impossible leaf-shape demotes are gone. A typed plan holds identifier
  leaves only, and a pattern the selector should not have admitted is one
  `IrInvariantError` (`admittedReads`).
- `!d.initializer` in `lowerDeclarationPattern` is an `IrInvariantError` now.
- A leaf already in scope demotes as `redeclaration of …`, the same way an
  identifier declaration does. Literal and typed leaves share that binder.
- The two `leafValue` functions are now `planLeafValue` (planner) and
  `lowerLeafValue` (walker).
- Leaf-name collectors: `loop-shape.ts`'s array copy `collectBindingNames`
  is deleted, and its two codegen callers use the generator
  `collectPatternBindingNames`. `collectBindingPatternNames` stays: it is the
  set-adding form, and over 20 legacy codegen sites use it.
- `binding-pattern-plan.ts` is split by concern:
  - plan types and typed reads: `binding-pattern-plan.ts`, 94 lines;
  - the literal planner: `literal-pattern-plan.ts`, 254 lines;
  - the closure-null predicate: moved into its only consumer
    (`select-planned-closure-operands.ts`) and folded with
    `nullIsComparedOperand` as `nullIsValue`.

**Re-measured** (base `6c732c42ea`, same 858-file census and scripts as the
S1–S3 table):

| measure | standalone | gc |
| --- | --- | --- |
| legacy-free, the 94 sole-blocker files (base → head) | 0 → **46** | 0 → **46** |
| legacy-free, the 288 for-head files | 0 → 46 | 0 → 46 |
| legacy-free, 231 literal-pattern files / 345-file sample | 0 → 0 / 7 → 10 (3 sample files are for/dstr) | same |
| binaries changed, of 712 compiled | 46, each with a newly claimed `<module-init>` | the same 46 |
| pass→fail on the 46 changed files (`runTest262File`) | 0 (46/46 pass before and after) | 0 (46/46) |
| post-claim errors | none new: 0 files on the 94; the same pre-existing errors elsewhere | same |
| host imports added, status (CE/skip) changes | 0, 0 | 0, 0 |
| playground examples (13) | byte-identical | byte-identical |

- **48 → 46.** The two `{const,let}-ary-ptrn-rest-obj-prop-id.js` files read
  `3: y` past the end of the rest array `[7, 8, 9]`. TypeScript types that
  read as an element (`number`), but the plan binds `undefined`, so the
  index-past-the-end refusal from finding 2 now covers them. Both stay legacy
  and pass, with binaries identical to main.
- **Line counts.** This round's `src/ir` change is +586 / −569, and `src`
  overall +720 / −707. The PR against main is now `src/ir` +815 / −478.
  - `binding-pattern-plan.ts`: 347 → 94 lines;
    `literal-pattern-plan.ts`: 254 new.
  - `from-ast.ts`: −76.
  - The codegen scan and seam lose 115 lines, net of the delegate.
- **Grants.** None added.
- **Gates.** Each run bare, all exit 0: loc and func (against the merge base
  and against `origin/main` `4fe61ff7f2`), coercion-sites, oracle-ratchet,
  dead-exports, typecheck, lint, ir-fallbacks, test:changed-root (88 + 4),
  import-cycles, and compiler-boundaries (`--mode inventory --base
  6c732c42ea`).
- **Pre-existing test failures.** Two cases of
  `tests/issue-3522-ir-closure-destructuring-ownership.test.ts` (gc
  `__unwrap_for_wasm`) and `issue-1372` AC#1 fail on the base tree too.

**New follow-ups.**

- **(f)** A direct call to a top-level function from a planned
  `<module-init>` closure claims and then demotes. This is on main, without
  destructuring.
- **(g)** The typed reader over an array literal demotes after the claim,
  because the pattern's contextual element type is `any`. This is on main,
  and belongs to (b).
- **(h)** A write to a `const` for-of head pattern leaf
  (`for (const [a] of rows) a = 2`) silently succeeds in the IR. This is on
  main, and belongs to (a).


### Review round 2 (2026-11-01)

The verdict was approve with nits. The reviewer's probes (`cases*.json`, base
`6c732c42ea`) were re-run on the new head; each finding below is fixed.

1. **A new claim-then-demote for a mixed `+` over leaves. Fixed.**
   - A literal-pattern leaf now has its source value's family.
     `provenIrFamily` reads it through `literalLeafSource`
     (`literal-pattern-plan.ts`): a leaf bound `undefined` is the carrier
     (`dynamic`), and a `length` leaf is a number.
   - The generic binary tail judges an operator over such a leaf with the
     shared `binaryOperandsAdmissible`, as `lowerBinary` would at build.
   - `const [a, b] = [1, 'x']; return a + b` (`.js` and `.ts`), the function
     for-head and the harness for-head are now refused at selection
     (`expr-binary-operand-families`), and run correctly through legacy.
   - The round-1 rebuttal is withdrawn: main refused these declarations, so
     this PR created the claims.
   - The wrapper lever's S0 (#7034) generalises the same judge to every
     typed operator. The leaf family then reaches it through
     `provenIrFamily` with no further change.
2. **The plan table overstated a fix. Corrected.** In a function body,
   `const [a] = [[1, 2, 3]]` and `const { a } = { a: { b: null } }` still
   claim and then demote through the typed reader, unchanged from main
   (follow-up (g)). The table now says so.
3. **The realm guard missed patches. Fixed; the guard is now conservative.**
   - `sourceMayPatchPrototype` counts any mention of `Array.prototype` or
     `Object.prototype` that is not the object of a plain member read. A
     `globalThis.` receiver counts too. That covers:
     - stored-into members, including compound, logical and destructuring
       targets, through the new shared `isStoreTarget` in `binding-writes.ts`;
     - deleted members;
     - a call with the prototype as `this` (`__defineGetter__`);
     - every escape: `Reflect.*`, `Object.assign` / `defineProperty` /
       `setPrototypeOf`, aliases, operands.
   - The #1719 brand keeps its exact narrower set (`sourceWritesPrototype`),
     computed in the same walk, so legacy output is unchanged.
   - Every reviewer probe is now refused, and legacy answers each the way
     main did.
   - `%ArrayIteratorPrototype%` reached through `Object.getPrototypeOf` stays
     unseen. That is documented; legacy also gets it wrong.
4. **The TDZ `undefined` case. Fixed.**
   - A program that binds the name `undefined` anywhere is not trusted: no
     `undefined` identifier is proven global there (`programBindsUndefined`).
   - This replaces round 1's per-caller `isShadowed` predicate, so the
     selector, builder and closure-null check now ask one fact.
5. **A duplicate unwrap helper. Fixed.** `skipOuterExpressions` is exported
   from `binding-writes.ts` and reused.
6. **A misleading flag and a dead parameter. Fixed.**
   - `lowerBindingPattern` takes the declaration's real `isConst`;
     parameter leaves pass `false`.
   - `isPhase1DeclarationPattern` and `lowerDeclarationPattern` take a
     `PatternDeclaration` (`binding-pattern-plan.ts`) instead of a separate
     `pattern` argument.

**Re-measured** against the round-1 base census (`6c732c42ea`):

| measure | standalone | gc |
| --- | --- | --- |
| legacy-free, the 94 / the 288 for-head files | 0 → **46** / 0 → 46 | same |
| binaries changed, of 712 compiled (all 858 files) | 46, the round-1 set, each with a newly claimed `<module-init>`; 0 of the other 570 files | same |
| pass→fail on the 46 | 0 (46/46 before and after) | 0 |
| new post-claim errors, imports, status changes | 0, 0, 0 | 0, 0, 0 |
| playground examples | byte-identical | byte-identical |

All of the following gates were run bare and exit 0:

- loc and func, against the merge base and against `origin/main` `4fe61ff7f2`;
- coercion-sites, oracle-ratchet, dead-exports;
- typecheck and lint;
- ir-fallbacks;
- test:changed-root (94 + 4);
- import-cycles and compiler-boundaries (`--mode inventory`).


### S5 of the destructuring lever: script `var` patterns and pattern `for` heads (plan, 2026-11-01)

S5 stacks on the destructuring lever (`claude/7106-for-head-destructuring`,
9df6bcaef0) and lives on `claude/7106-var-pattern-heads`. It is the
`<module-init>` half of that lever.

#### Problem (measured)

The base is the destructuring head at 42c09a6cb8, standalone, one worker. The
population is the 174 candidate files with a script-level `var` pattern: 95
`for (var <pattern> = …;;)` heads (`for/dstr/var-*`) and 79
`var <pattern> = …;` statements.

- 12 files are skipped by the runner.
- 146 files carry a var-pattern refusal: `for-init-var-kind` on the head, or
  `vardecl-module-destructuring` on the statement.
- In 79 of them (47 for-head, 32 script), every refusal is either that one or a
  read of one of its own leaves (`expr-ident-not-in-scope`). That is the upper
  bound.
- 59 of the 79 (36 for-head, 23 script) have a pattern the literal plan admits.
  The other 20 have:
  - an anonymous-function default (16), which needs NamedEvaluation;
  - a rest element (3);
  - a computed key (1).

**Why the statement is refused.** Each leaf is its own script `var`: legacy
gives it a `__mod_<leaf>` slot (`registerBindingNames`). That slot has no IR
identity:

- the module-binding resolver only knows a `VariableDeclaration` with an
  identifier name in a direct `VariableStatement`;
- `buildModuleBindingsMap` throws on a pattern;
- legacy never hands the leaf to the Program ABI. `registerBindingNames` calls
  `registerModuleGlobal` without the declaration, so there is no
  `observeModuleValue`, and `resolveModuleBindingGlobal` would find no
  observation.

**Why the head is refused.** On top of the same missing identity, three twin
checks treat a nested `var` as hoisting the IR does not model:

- `collectIrSafeModuleVarDeclarationLists` (selection);
- `isDirectSourceVarStatement` + `moduleInitContainsNestedVar` (the builder's
  claim-then-demote backstop).

#### Implementation Plan

One idea runs through every layer. A **module-init `var` list** is the `var`
list of a top-level `var` statement, or the `var` head of a top-level
`for (;;)` whose declarations are all patterns. In a script, each leaf of a
pattern in such a list is a module binding: it owns its `__mod_<name>` slot,
just as a top-level identifier declaration does.

1. **One module for the module-init `var` vocabulary**
   (`src/ir/module-init-vars.ts`, new, 92 lines).
   - `moduleInitVarList(statement)` and `isModuleInitVarList(node)` are the
     single answer to "which `var` list does `<module-init>` model".
   - `collectIrSafeModuleVarDeclarationLists` moves here from
     `function-local-var.ts`, which keeps the function-local subset only, and
     maps it.
   - from-ast's `moduleInitContainsNestedVar` skips exactly that list. That
     folds `isDirectSourceVarStatement`, the duplicate.
   - `moduleInitBindings(statement)` lists what a statement binds: identifier
     declarations, then the leaves of a modelled list. A lexical top-level
     pattern is unmapped.
   - `moduleBindingDeclarationOrder(sourceFile)` is the ordinal enumerator
     (item 5).
2. **One leaf walker** (`src/ir/binding-pattern-plan.ts`).
   - `patternLeaves(pattern)` yields `BindingLeaf`s.
   - The `isBindingLeaf` guard replaces `planFlatReads`' cast.
   - `patternRootDeclaration(leaf)` is the walk out of the patterns. It
     replaces the copy inside `literalLeafSource`.
   - `bindingDeclarationList(declaration)` is a declaration's list, through
     its pattern for a leaf.
3. **Legacy hands the slot to the Program ABI** (`src/codegen/declarations.ts`).
   - `registerBindingNames` passes the leaf to `registerModuleGlobal`, as the
     top-level identifier path passes its declaration.
   - Observation is a map entry, not an allocation, so legacy bytes do not
     change.
   - The two behaviours that key on the declaration's presence:
     - `shadowsConversionHook`: a leaf named `toString`/`valueOf`, which no
       test262 file declares at script level;
     - `functionIsFromAnotherSource`: multi-source.
4. **The resolver knows a leaf** (`src/ir/module-bindings.ts`).
   - `IrModuleBindingDeclaration = ts.VariableDeclaration | ts.BindingElement`
     is the identity's declaration type, the type Program ABI already uses.
   - `isModuleBindingDeclaration` (was `isDirectTopLevelVariableDeclaration`)
     admits the direct-statement identifier declaration exactly as before,
     and, in a SCRIPT, a leaf of a module-init `var` list. ES modules and
     lexical patterns are unchanged, so the playground cannot move.
   - `exactTopLevelVariableDeclaration` reuses that predicate instead of its
     own copy of the direct-statement filter.
   - `bindingDeclarationList` replaces the
     `declaration.parent as ts.VariableDeclarationList` casts.
   - The lexical-only arms read a `lexical` declaration, which is always an
     identifier declaration because a leaf binds only in a `var` list.
5. **Ordinals.** `moduleBindingDeclarationOrder(sourceFile)` numbers every
   top-level statement declaration first, exactly as before and as
   `module-init-plan.ts` does. It then numbers the module-init `var` leaves in
   source order. No existing binding id moves. `bindingLocation` reads it
   instead of its own loop.
6. **`buildModuleBindingsMap`** (`src/ir/integration.ts`) maps each name
   `moduleInitBindings(statement)` lists, and throws on an unmapped pattern
   as before. The diagnostic twin `surveyModuleBindingRefusals` walks the same
   list, and its private pattern-label walker folds into
   `collectPatternBindingNames`.
7. **Selection** (`src/ir/select.ts`).
   - `isPhase1DeclarationPattern` owns the `<module-init>` rule.
     `vardecl-module-destructuring` now refuses only a pattern outside a
     module-init `var` list.
   - On the literal path, `moduleVarLeavesStorable` requires each leaf to
     resolve (`vardecl-module-storage-unrepresentable`) and its literal source
     to fit the slot (`vardecl-module-value-flow`). The fit is:
     - `undefined`, or a `boxableIntoDynamic` family, in the dynamic carrier;
     - the resolver's own `bindingValueMatches` in a typed or string slot.

     An array-length source has no expression and stays refused.
   - `literalPatternLeaf` excludes a module binding: a script `var` leaf's
     family is its slot's, not its literal's.
8. **The builder** (`src/ir/from-ast.ts`).
   - `patternLoweringHost` takes its `bind` strategy as a parameter:
     - `localLeafBinder` binds a local, as before;
     - `moduleLeafBinder` writes a module-init `var` leaf's slot. A dynamic
       slot is boxed first, through `boxConcreteToDynamic` over the leaf's
       `literalLeafSource`.
   - `storeModuleBinding` is the slot write: compatibility check,
     `global.set`, TDZ flag, `moduleGlobal` scope entry. It is the tail of
     `lowerVariableDeclaration`'s module arm, extracted so the identifier and
     the leaf share it.

#### Not in S5

- **Identifier `for` heads** (`for (var i = 0;;)` at script level, about 1,434
  test262 files). The list predicate admits them once its pattern-only clause
  is dropped. They change about ten times as many binaries, so they get their
  own census as S6.
- **NamedEvaluation defaults, rest elements and computed keys.** These are
  the literal plan's existing refusals.
- **Array-length leaf sources.**

#### Acceptance

- **Gain.** The legacy-free gain is measured on the 611 files with a `var`
  pattern, both lanes, against 9df6bcaef0. The upper bound is 59.
- **No flips.** Pass/fail does not flip on any changed binary, in either lane.
- **No claim-then-demote.** No new post-claim error.
- **Legacy bytes identical.** No binary changes without a newly claimed unit.
  The playground is identical.
- **Tests.** A unit test runs, on both lanes:
  - claimed statements and heads;
  - leaf reads after the loop, from a function and before the declaration;
  - the refused shapes.
- **Code quality.** These must hold:
  - one list predicate, one leaf walker and one ordinal enumerator;
  - the module slot write is shared by the identifier and the leaf;
  - no `VariableDeclarationList` cast survives on the binding path;
  - no new budget grant;
  - net `src/ir` growth is stated.

## Historical #6876 measurement appendix (reconciled 2026-10-30)

The following 115 lines are preserved verbatim from the completed #6876 plan
(head `caa478da932045929c20d068f93151f0d31dd9fb`). Its measurements describe the
2026-10-22 integrated-stack, standalone, 80-file sample stated below; they are
not measurements of the current main branch. All preceding current plan
content and dated dispositions remain intact.

This appendix records historical observations and proposed follow-up work, not
a delivered implementation, a current pass-rate claim, or a grant to restore
retired APIs or semantic-provider profiles. Any future implementation must be
reconciled with current source and policy. Landing this completed plan does not
claim completion of those implementation levers.

## `<module-init>` next lever — ambient `Number` constants and `Number(v)` (plan, 2026-10-22)

**Measured (integrated stack #6858 + #6851 + #6862 + #6874, standalone, 80
ES5-style files, 2026-10-22 15:05Z).** 9 tests are legacy-free and pass; of
the 71 others, `<module-init>` stops at `expr-ident-not-in-scope «Number»` in
37, «Array» 11, «Math» 4, «Boolean» 3. The harness is no longer the blocker:
the test bodies read ambient namespaces. Corpus greps over the nine sampled
directories: `Number(` 684, `Number.POSITIVE_INFINITY` 133,
`Number.NEGATIVE_INFINITY` 130, `Number.MAX_VALUE` 123, `Number.NaN` 113,
`Number.MIN_VALUE` 70, `Number.prototype` 114 (the last is a different lever).

### Arm A — `Number.<CONST>` / `Math.<CONST>` fold

- **Legacy.** `compilePropertyAccess` folds the read to `f64.const` from
  `NUMBER_CONSTANT_VALUES` / `MATH_CONSTANT_VALUES`
  (`codegen/builtin-value-read.ts`, the single source of truth shared with the
  reflective element-access fold). The IR must read the SAME tables — no second
  list, and no `Number.*` text match in the IR.
- **IR.** One selection option, `ambientNamespaceConstant(expr:
  ts.PropertyAccessExpression): number | undefined`, implemented in the bridge
  (`ir/integration.ts` and the production site in `codegen/index.ts`, like
  `selfGuardedConstructorValue`) from those tables; the identifier must be the
  unshadowed ambient `Number` / `Math` (`selectorSeesAmbientBinding` + the
  caller's `scope`, as the toString-tag arm). Selector: one predicate
  `ambientNamespaceConstantRead(expr)` used at the three sites (Phase-1
  property-access arm — before the generic receiver walk that refuses the
  identifier; the move-only scan — a concrete f64, never dyn-shaped; the
  external-call walk — not a call). from-ast: `lowerPropertyAccess` asks the
  resolver first and emits the f64 constant.
- **Acceptance.** `Number.MAX_VALUE`, `Number.NaN`, `Number.POSITIVE_INFINITY`,
  `Math.PI` in `<module-init>` and in functions ship IR bodies, byte-identical
  constants to legacy; a shadowed `Number` (parameter, `var Number`, module
  binding) stays on the generic path; node parity on a probe that compares
  each constant.

### Arm B — `Number(v)` on the ambient `Number`

- **Legacy** (`codegen/expressions/call-identifier.ts`): zero args → `0`;
  a symbol operand throws `TypeError`; a string → `__str_to_number`; an array →
  ToPrimitive then StringToNumber; otherwise the generic ToNumber protocol.
- **IR.** Mirror `tryLowerAmbientStringToStringCall` (`String(v)`, S1): a
  dynamic operand → `dyn.to_number` (exists since S5.3; standalone lowers it to
  `__any_to_f64`); `f64` → identity; boolean → `f64.convert_i32_u`; string →
  the `emitUnaryToNumber` unary `+` already uses (no new coercion vocabulary —
  the #2108 drift gate counts helper lookups); zero args → `f64.const 0`.
  Selector: `ambientNumberToNumberCall` beside `ambientStringToStringCall`;
  **fold both into one `ambientCoercionCall(expr, "String" | "Number")`** so
  the one-argument-ambient-constructor-call walk exists once; the scan treats
  the result as concrete f64 (`expectDyn` false; a dynamic operand needs
  `currentDynamicRuntimeBuildable`).
- **Measured 2026-10-22 16:00Z — the lowering exists, its provider does not.**
  from-ast already lowers a source-bound `Number(v)` (`lowerPreparedNumberCall`
  → intrinsic `js.number.from-value`, gated by
  `frontend/builtins/prepare-number-conversion.ts`), but (1) the selector never
  admits the call — the three sites above are missing, so `Number(1)` is an
  `external-call` for `<module-init>` and a `move-only[concrete]` refusal for a
  dynamic operand; (2) the plan is invalidated by ANY non-call use of `Number`
  in the file (`Number.MAX_VALUE`, `new Number(x)`), which every sampled test
  body has — relax to "a member-access receiver or a `new` callee keeps the
  plan"; (3) the integration from-ast resolver (`makeFromAstResolver`) does not
  carry `preparedNumberCall` (only the IR program-source resolver does); and
  (4) **`js.number.from-value` has no `RuntimeProviderDefinition` on any lane**
  — with (1)–(3) wired, every admitted call died at `runtime feature
  js.number.from-value has no provider` (`ir/runtime/manifest.ts`). So the
  arm is: a `native.js.number.from-value` provider (`runtime-callable` over a
  template wrapper built from legacy's `Number(v)` emitter — the #7119 /
  #6874 wrapper mechanics, `coercion-engine.ts#emitToNumber` for the
  externref arm, Symbol → TypeError, BigInt → Number) plus the host provider,
  registered like `REFERENCE_ERROR_RUNTIME_PROVIDERS`; then (1)–(3). The
  wired-and-reverted (1)–(3) diff is in #6583's 16:00Z note. The old
  `dyn.to_number` idea is withdrawn: `Number(v)` is ToNumeric with the full
  ToPrimitive protocol, which the intrinsic's contract states and
  `dyn.to_number` does not.
- **Parity to measure once the provider exists — `Number(obj)`.**
  Legacy runs the full ToPrimitive protocol on an object carrier
  (`Number({ valueOf() { return 7; } })`, `Number([5])`, `Number("0x10")`,
  `Number(null)`, `Number(undefined)`, `Number(true)`, `Number(Symbol())` must
  throw). Probe `function f(x) { return Number(x); }` legacy vs IR on each
  before admitting a dynamic operand; where `__any_to_f64` differs, the arm
  admits only operands the scan proves primitive, and the difference is filed.
- **Acceptance.** The sampled `Number(…)` sites in module-init claim; the
  probe above answers like node on both lanes; `check:ir-fallbacks` flat.

### Also measured, smaller

- `expr-math-call-shape` ×4: variadic / zero-arg `Math.max()` / `Math.max({})`
  — `IR_MATH_METHOD_TABLE` is arity-exact; a separate arm.
- propertyHelper.js units ×11 (`verifyProperty`, `isWritable`, …): the
  standing propertyHelper lever.
- `vardecl-var-kind` ×4 (`var n = Number.prototype.toString(1)`): the
  `Number.prototype` member-call family, not this lever.

**Size.** Horizon S–M for an Opus lane: `select.ts` (+~60 LOC in three
existing arms), `from-ast.ts` (+~40), one option in the two bridge sites, a
node-compared test per arm. No new IR kind, no new runtime symbol.

### Lever C — `new Number(x)` and `(new Number(x)).toString(radix)` (measured 2026-10-22, not a pass-rate lever yet)

The 37 «Number» module-init blockers of the ES5 sample are
`test/built-ins/Number/prototype/toString/*`: `new Number(…)` ×574 and
`Number.prototype.toString(2)` ×112, every test `pass` on legacy standalone.
The selector refuses `new Number(x)` (`expr-new-ctor-unknown`); from-ast's
`lowerPrimitiveWrapperConstruction` (#4208 S4) builds it as `extern:Object`,
whose method calls resolve through the extern-class registry (no `Object`
entry → demote). The dynamic route is closed too: `function f(x) { return
x.toString(2); }` answers wrong for `f(5)` and throws for `f(new Number(5))`,
`f(new Boolean(true))`, `f(new String("ab"))` — on BOTH lanes (legacy's
`any`-receiver brand dispatch; the #7119 wrapper reproduces it, except that it
throws where legacy answers wrong for the Number wrapper). Legacy passes these
tests only because the SITE knows the receiver's checker type. So lever C is a
typed wrapper-object carrier in the IR (or a native `any`-receiver fix for
`toString(radix)` and wrapper objects in legacy's runtime first) — a slice of
its own, not an admission arm.

