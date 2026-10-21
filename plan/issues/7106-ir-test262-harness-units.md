---
id: 7106
title: "IR: ship the six test262 harness units (assert.js + sta.js) so a fallback-free pass is possible"
status: in-progress
sprint: current
created: 2026-10-20
updated: 2026-10-20
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
flat-dir-budget-allow:
  - src/codegen/ir-string-carrier.ts # 2026-10-21 (#7106 S1c): the dyn.string_carrier wrapper beside ir-dynamic-construct.ts
  - src/codegen/ir-arguments-length.ts # 2026-10-21 (#7106 S1e): the dyn.arguments_length wrapper beside its two siblings
  - src/codegen/ir-dynamic-construct.ts # 2026-10-21 (#7106 S3a): the dyn.construct wrapper beside its peers (object-proto-tostring.ts, native-construct.ts); the construct-driver split owns its future home
import-cycles-allow:
  - ir->codegen: 79 # 2026-10-21 (#7106 S3a/S1c/S1e): integration.ts pre-registers the dynamic-construct, string-carrier and arguments-length wrappers
  - largestSccSize: 724 # 2026-10-21 (#7106 S3a/S1c/S1e): codegen/ir-dynamic-construct.ts, ir-string-carrier.ts and ir-arguments-length.ts join the SCC
func-budget-allow:
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
loc-budget-allow:
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

### Stage 4 — script top-level residue (item 5; `<module-init>`)

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

Measured again 04:35Z, correcting the note above: a function mixing
`return o + "!"` and `return o` (or `return "x"` / `return String(o)` with a
dynamic return) registers `(result externref)` in BOTH front-ends and ships
an IR body; so does a lone `return o + "!"` (`(ref null $AnyString)` in
both). The earlier `labelOf` withdrawal came from the test program's shape,
not from `+`. The one mismatch measured is `{string, number literal}`
returns (`if (d) return o + "!"; return 1;`: IR and legacy pick different
result slots) — not a harness shape, left as is.

## Ownership

Per the #6583 plan: Stage 1 and 3 → B (items 2/3), Stage 2 and 4 → Shepherd
(items 4/5). C takes any stage whose owner has not replied by the next
check-in after this file lands, starting with Stage 3 (announced 21:30Z).

## Non-goals

- No JS-host IR paths (standalone + Linear only, per CLAUDE.md 2026-10-10).
- No new runtime helpers: every lowering targets a helper legacy already
  emits on standalone.
