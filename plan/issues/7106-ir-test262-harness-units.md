---
id: 7106
title: "IR: ship the six test262 harness units (assert.js + sta.js) so a fallback-free pass is possible"
status: in-progress
sprint: current
created: 2026-10-20
updated: 2026-10-25
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
  - ir->codegen: 83 # 2026-10-29 (revive, restated on main's 81 + #7119's wrapper module + this borrow wrapper); 2026-10-21 (#7106 S3a/S1c/S1e): integration.ts pre-registers the dynamic-construct, string-carrier and arguments-length wrappers; 2026-10-22 (module-init lever A): the bridge reads legacy's Math/Number constant table (`codegen/builtin-value-read.ts`); 2026-10-22 (lever B): …and pre-registers the Number(v) provider (`codegen/helpers/ir-number-from-value.ts`); 2026-10-22 (compareArray.format): …and the Array.prototype borrow wrapper
  - codegen->ir: 301 # 2026-10-22 (#7106 lever B): the Number(v) provider names its symbol from the IR runtime contract (`ir/runtime/number-conversion-callable.ts`), where the provider definition lives
  - ir->frontend: 8 # 2026-10-22 (#7106 lever B): the bridge builds the source-bound Number-conversion plan (`frontend/builtins/prepare-number-conversion.ts`) for the selector, as program-source.ts does for its resolver
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
  - src/ir/builder.ts
  - src/ir/core/nodes.ts
  - src/ir/core/dialect/js.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/runtime/verify.ts
  - src/ir/select.ts
  - src/ir/backend/handles.ts
  - src/ir/backend/legality.ts
  - src/ir/ambient-typeof.ts
  - src/ir/prepared-component-dependencies.ts
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

