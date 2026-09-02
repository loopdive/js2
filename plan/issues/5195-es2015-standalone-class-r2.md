---
id: 5195
title: "ES2015 standalone class — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-02
priority: medium
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/class-proto-object.ts
  - src/codegen/class-proto-accessors.ts
  - src/codegen/class-static-sidecar.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/new-target.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/registry/error-types.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/compiler/early-errors/node-checks.ts
  - src/compiler/early-errors/module-rules.ts
  - src/codegen/declarations.ts
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
coercion-sites-allow:
  - src/codegen/class-proto-lookup.ts
func-budget-allow:
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/statements/nested-declarations.ts::emitUnresolvedComputedAccessorNameEffects
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/class-proto-object.ts::emitStandaloneClassProtoObject
  - src/codegen/expressions/extern.ts::emitLazyClassObjectGet
  - src/codegen/expressions/new-super.ts::compileSuperPropertyAccess
  - src/codegen/expressions/new-super.ts::compileSuperElementAccess
  - src/codegen/expressions/new-super.ts::compileSuperMethodCallCore
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/statements/control-flow.ts::compileReturnStatement
  - src/codegen/statements/nested-declarations.ts::compileNestedClassDeclaration
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
---

# #5195 — class r2: cluster and fix the residual class-bucket failures

Growth allowance rationale (2026-09-01, this planning pass): the steps below
add (1) a runtime-computed-key install lane to the class prototype `$Object`
and a new per-class static sidecar `$Object` (new file
`class-static-sidecar.ts`, prologue arms in `object-runtime.ts`, context
fields), (2) runtime `super` read/write lanes for class methods in
`new-super.ts`/`assignment.ts`, (3) heritage evaluation + derived-ctor `this`
TDZ arms in `nested-declarations.ts`/`class-bodies.ts`/`control-flow.ts`, and
(4) a `new.target` value carrier in `new-target.ts`. Each is an arm added at
the decision point that already owns the case; the listed functions grow by
those arms.

Growth allowance amendment (2026-09-01, implementation pass):
`property-access-dispatch.ts::finalizeStructAndDynamicMemberGet` (+21) — Step
3.2 turned out to live in that function's `isExternObj` admission test, not in
a separate receiver-classification helper as the plan guessed. The added arm is
one more clause in the same disjunction that already admits externref LOCALS
(#3033 Bug 2b); it admits the module-GLOBAL twin under the same
slot-representation rule, restricted to receivers whose static type is purely
`undefined`/`void` so no resolvable receiver changes lane.

Growth allowance amendment (2026-09-02, resumed implementation pass):
`call-builtin-static.ts::compileBuiltinStaticCall` (+3 now, more in Step 2.3) —
Steps 1.3/1.4 make `<Class>.prototype` a real `$Object` for EVERY standalone
class, so the `getOwnPropertyDescriptor` struct fast paths in that function must
decline that receiver (the predicate itself is hoisted to a module-level helper
`isStandaloneClassProtoObjectReceiver` to keep the growth to the two call sites);
Step 2.3 adds the class-object sidecar redirect at the same two folds.

Growth allowance amendment (2026-09-02, Step 1): `declarations.ts` (+12) —
Step 1.2 needs a top-level class with a runtime-keyed member to reach
`__module_init`, and the one collector that decides that
(`collectPreparedTopLevelClassComputedNameEffects`) lives in that file; the
added arm is one more clause beside the runtime-heritage one it already has.
`create-context.ts::createCodegenContext` (+2) — the two new context maps.
`nested-declarations.ts::emitUnresolvedComputedAccessorNameEffects` — the same
walk now covers methods, stores the key into its module global, and force-inits
the prototype singleton.

Growth allowance amendment (2026-09-02, Step 1.7): `call-tail-dispatch.ts` /
`::compileTailDispatch` (+18) — one clause added to the existing user-class
element-call arm so a runtime-keyed prototype member is INVOKED rather than
folded to `ref.null.extern`; `calls.ts` (+3) for exporting the receiver-class
resolver that clause needs; `index.ts` / `::generateModule` /
`::generateMultiModule` (+7/+4/+2) for the one finalize call that mints
`__class_proto_lookup` (new leaf file `class-proto-lookup.ts`).

Coercion-sites allowance (2026-09-02, Step 2): `class-proto-lookup.ts`
(`number_toString` +1) — `class C { [ID(2)]() {} }` spells its member with a
NUMERIC key, and `C[2]` / `new C()[2]` lower to `__extern_get_idx(recv, f64)`,
whose own `$Object` arm converts the index with `number_toString` before
delegating to `__extern_get` (#2551: the canonical decimal key, not a truncated
one). The class-receiver arm added here delegates the same way and therefore
calls the same helper for the same reason — reuse of the existing engine call,
not a new hand-rolled ToString.

Growth allowance amendment (2026-09-02, verification findings F1-F5):
`object-ops.ts` (+26) / `::compilePropertyIntrospection` (+11) — F5. A class
with a runtime-keyed member has an own-key set the CHECKER cannot enumerate, so
that function's static `hasOwnProperty` / `propertyIsEnumerable` fold answered
`false` for `C.prototype.hasOwnProperty('dyn')` while `gOPD(C.prototype,'dyn')`
found the property: two answers about one object. The added arm is one
predicate plus one clause on the existing "delegate to the runtime" condition
the externref-receiver case already uses — the fold is declined, not
reimplemented, and only for a prototype or constructor receiver of such a class.

## Problem

209 ES2015-bucket test262 rows under `language/{statements,expressions}/class/**`,
`computed-property-names/class/**`, `language/expressions/super/**` and
`language/expressions/new.target/**` fail on the standalone target.

**Re-verified on HEAD `0d9bfedee` (2026-09-01)** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/class-head.txt --standalone`
(in-process, no realm poisoning): **0 pass / 190 fail / 19 compile_error** —
nothing in the 2026-09-01 baseline (compiler `d39779cb`) has healed. Error
texts are identical to the baseline except five rows that now report
`compilation timeout` (they reference `Function.prototype` / `new Function`,
which routes to the QuickJS runtime-eval provider that is not built in this
container — environment, see "Out of scope").

Prior work mined for this pass: #5139 (wave 1, its "Not attempted" list is
the seed of clusters A/B/M/N/R here), #5153 (super wave 1: its B/C/E
residuals are clusters D1–D4), #4450 (static `name`/`length` precedence,
done), #5212 (Map/Set subclass ctor, done), #5213 (instance `prototype`
accessor, done). The handover's "second pass over the plan" lever does not
apply here: every remaining row has a named root cause that the earlier plans
explicitly did not land.

**Lists** (all under `/home/user/js2/.tmp/es2015/`, test262-relative paths):

- `class-head.txt` — the 209 rows; `class-head-run1.txt` the HEAD run;
  `class-head-reasons.tsv` per-row status + reason on HEAD.
- `class-cl-<X>.txt` — one sub-list per cluster below (rows may appear in two
  clusters when a test needs both fixes; the table counts each row once
  under its *primary* cluster).
- `class-controls.txt` — 22 currently-passing siblings (order-preservation
  control).
- `probes5195/*.js` — minimal repros (run one or more with
  `npx tsx .tmp/es2015/probe-one.mts .tmp/es2015/probes5195/<name>.js`; it
  goes through the runner's own standalone lane, so a probe's verdict is the
  runner's verdict).

## Cluster table (HEAD-verified, 2026-09-01)

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | Runtime-computed class element keys dropped (instance AND static halves) | 48 | `src/codegen/class-bodies.ts:resolveClassMemberName` (L697) folds via `literals.ts:resolveComputedKeyExpression` (L2724); a key that does not fold (`[x \|\| 1]`, `[ID('d')]`, `[sym]`, `['x' in empty]`) returns `undefined` and the member is silently skipped at every site (`collectClassDeclaration` method loops L1453/L1462, accessor loops L1632/L1675, emit loop L2850). The key EXPRESSION is never evaluated for methods (`[x = 1]` leaves `x` at 0); only accessors get a side-effect-only evaluation (`nested-declarations.ts:emitUnresolvedComputedAccessorNameEffects` L390). A folding key that duplicates a declared one (`get b(){}` + `get ['b'](){}`) keeps the FIRST body because of the `funcMap.has(getterKey)` guard (L1640/L1683) — spec is last-definition-wins. Static halves additionally need cluster B. Probe: `probes5195/cpn-runtime-method.js`, `getter-dup.js`. | statements/class/cpn-class-decl-computed-property-name-from-expression-logical-or.js · computed-property-names/class/method/symbol.js · computed-property-names/class/accessor/getter-duplicates.js |
| B | Class OBJECT has no own-property surface (static methods/accessors, `static constructor`, `length/name/prototype` through reflection) | 18 | The class object is a `$ClassName` struct singleton (`expressions/extern.ts:emitLazyClassObjectGet` L437); in standalone nothing is installed on it (the `__register_class_static_method` block L570 is host-only). `gOPD(C,'sm')`/`C.hasOwnProperty('sm')` fall to the closed-struct natives and answer `undefined`/`false` (probe `static-gopd.js`, `static-accessor-names.js`). #3976 deferred converting the class object because `new-super.ts:emitDynamicNewFallback` (L3250) `ref.test`s it against `$ClassName` and reads `__tag` (field 0). Also: `static constructor()` is parsed as a ConstructorDeclaration and rejected by `module-rules.ts:checkDuplicateConstructors` (L288, 2 CE); static/instance accessors with the same name share ONE funcMap key (`${C}_get_${p}`, L1640) so the second is dropped (`getters-restricted-ids.js`: `C.eval` reads the instance getter's 1). | statements/class/definition/methods.js · definition/getters-prop-desc.js · elements/syntax/valid/grammar-static-ctor-meth-valid.js · definition/getters-restricted-ids.js |
| C | `C.prototype.constructor` missing for method-less classes; own-key ORDER wrong | 2 (+order asserts inside A) | `class-proto-object.ts:standaloneClassProtoObjectApplies` (L146) requires ≥1 installable method/accessor, so `class C { constructor(){} }` keeps the legacy defaulted struct and `gOPD(C.prototype,'constructor')` is undefined (`constructor.js`: "Cannot access property on null"). `emitStandaloneClassProtoObject` (L161) installs `constructor` LAST, but §15.7.14 creates it before the elements — `Object.getOwnPropertyNames(C.prototype)` answers `[a, constructor]` (probe `proto-gopn-symbol.js`). | statements/class/definition/constructor.js · definition/constructor-property.js |
| D1 | `typeof caught` const-folds to "undefined" for a module `var` written only inside a nested function (the `caught` idiom of every super error test) | 14 | `typeof-delete.ts` P-7 guard (L2026 in `compileTypeofExpression`, L2317 in `compileTypeofComparison`) is gated `ctx.standalone !== true && ctx.wasi !== true` on the STALE ground that standalone's `__typeof` is a null stub; `typeof-natives-finalize.ts:212` materializes it whenever `nativeStrTypeIdx >= 0`. Second half (#5153 C.2): `caught.constructor` on the same binding compiles against the checker's `undefined` type and reads null. Probe `caught-idiom.js`. Each row ALSO needs its underlying super semantics (D2/D3/D4); D1 alone flips the 3 object-literal rows whose semantics #5153 already landed. | expressions/super/prop-dot-obj-null-proto.js · prop-expr-obj-unresolvable.js · call-bind-this-value-twice.js |
| D2 | Class-method `super.x` / `super[k]` / `super.m()` resolve statically and emit a default | 11 | #5153 cluster B, unchanged: `new-super.ts:compileSuperPropertyAccess` (L1273), `compileSuperElementAccess` (L1413), `compileSuperMethodCallCore` (L1055) walk accessor-set/struct-field/funcMap and emit `ref.null`/0 on miss; only object literals have the #4688 runtime lane (`compileStandaloneObjectLiteralSuperPropertyRead` L1208). Prerequisites measured this pass: (i) the typed WRITE `A.prototype.x = 'a'` does not land in the `$Object` prototype (probe `proto-write.js` fails; the same write through an untyped receiver lands and the typed READ `A.prototype.x` then works — probe `proto-write-dynamic.js`), so the defect is the `<Class>.prototype.<name> = v` arm of `assignment.ts:compilePropertyAssignment` (L4069) treating the receiver as an instance; (ii) `D.prototype`'s `$Object` has a null `[[Prototype]]` (class-proto-object.ts header: "left null"), so a chain walk from C.prototype cannot reach A.prototype; (iii) an instance read of an undeclared member (`new A().x`) never consults the prototype `$Object` (probe `proto-write-dynamic.js`, last assert). | expressions/super/prop-dot-cls-val.js · prop-expr-cls-ref-this.js · prop-dot-obj-ref-this.js |
| D3 | Derived-ctor `this` TDZ and double `super()` ReferenceError missing | 5 | `class-bodies.ts` ctor lowering allocates `__self` before the body (L2560ff) so `this.p = 3` / `super.x` before `super()` silently works (probe `this-before-super.js`); `compileSuperCall` (L3770) has no "already initialized" check, so a second `super()` runs the parent again (probe `super-twice.js`). `this-check-ordering.js` asserts args are evaluated BEFORE the throw (`fCalled === 1`) and the parent NOT re-run (`baseCalled === 1`). | statements/class/definition/this-access-restriction.js · definition/this-check-ordering.js · expressions/super/prop-dot-cls-this-uninit.js |
| D4 | `super.x = v` write path absent | 6 | #5153 cluster E, unchanged: zero `SuperKeyword` arms in `assignment.ts`; strict `[[Set]]` failure must TypeError, sloppy `[[Set]]` must define on the RECEIVER and no-op on a frozen receiver. `__reflect_set` (object-runtime.ts:4202) takes `(target,key,value)` — no receiver parameter. | expressions/super/prop-dot-obj-ref-non-strict.js · prop-dot-cls-ref-strict.js |
| E | Derived-constructor `return` semantics | 8 | `control-flow.ts:compileReturnStatement` (L192): the struct-result derived lane has NO return arm — a bare `return;`/`return undefined` pushes `ref.null` and `new Derived()` traps "dereferencing a null pointer" (probe `derived-return-empty.js`); `return null` must TypeError; `return {}` must REPLACE `this` (probe `derived-return-object.js` — `typeof o.prop` is "number", i.e. `this` leaked). Parent-return-override through `super()` (a fnctor parent returning an object) is the #5153 F residual (`compileSuperCall` L4024 comment). | statements/class/subclass/derived-class-return-override-with-undefined.js · -with-object.js · expressions/super/call-expr-value.js |
| F | `extends <expr>` never evaluated for IsConstructor / `prototype` Get at ClassDefinitionEvaluation | 10 | `class-bodies.ts:collectClassDeclaration` (L909-1000) resolves only identifier parents statically; `extern.ts:emitRegisterDynamicClassParent` (L740) is host-only. A non-constructor parent (arrow, generator fn, `42`, `Math.abs`, a bound fn with getter `prototype`) must TypeError, and `Get(parent,'prototype')` must run its getter exactly once (probe `extends-nonctor.js`, `extends-42.js`, `accessor-prototype-bound.js`). `class D extends (calls++, C)` is a COMPILE_ERROR from `ir/planning-identity.ts:412` because the comma heritage has no static owner (probe `comma-heritage.js`); `Object.getPrototypeOf(D) === C` is false (probe `gpo-derived-class.js`). | expressions/class/heritage-arrow-function.js · statements/class/definition/invalid-extends.js · definition/prototype-getter.js · definition/side-effects-in-extends.js |
| G | `new.target` in plain functions / as a value | 6 | `expressions.ts:1623` emits `undefined` unless `fctx.isConstructor`, which only class ctors set (`class-bodies.ts:2302`); a plain `function F(){}` reached via `new F()` (`new-super.ts:compileNewFunctionDeclaration` L1913) reads `undefined` (probe `newtarget-fn.js`). Inside class ctors `new.target` is an i32 class-id (`new-target.ts`), so `baseNewTarget = new.target` compared with `Child` yields 3 vs the class object. `global-code/new.target-arrow.js` needs the early error "new.target outside a non-arrow function". | expressions/new.target/value-via-new.js · arrow-function/lexical-new.target.js · new.target/value-via-super-call.js |
| H | Setter invoked through a `new C()` temp receiver / static setter assignment dropped | 5 | `new C().x = 5` runs nothing (probe `accessor-stmt-effects.js`); `C.staticX = 2` runs nothing (probe `static-setter.js`) — the PropertyAccess-target lowering in `assignment.ts` has the static-setter arm only for ELEMENT targets (L5465-5480 uses raw `funcMap.get(setterName)`, not `classMemberFuncKey`) and the instance-setter arm (L4803) does not fire for a NewExpression receiver. | statements/class/name-binding/expression.js · computed-property-names/class/accessor/setter.js · definition/setters-prop-desc.js |
| I | Assignment to the class's inner name binding must TypeError | 1 | `assignment.ts:emitIdentifierWriteFromLocal` (L928): `isConstIdentifierAssignmentTarget` knows `const` but not the immutable inner class binding (§15.7.14 step 3, `classBinding`), so `C = 42` inside `class C` writes silently (probe `name-binding.js`). | statements/class/name-binding/const.js |
| J | Method named `new` collides with the synthetic ctor name | 2 | `${className}_${methodName}` for `new()` is `C_new` — the constructor's funcMap key (`class-bodies.ts:1281`, `class-member-keys.ts:classMemberFuncKey` L46). `o.new()` calls the ctor: `local.tee expected (ref null N), found f64` (probe `method-named-new2.js`). | statements/class/ident-name-method-def-new-escaped.js |
| K | Computed `['constructor']` treated as the constructor name | 3 CE | `early-errors/node-checks.ts:1277` uses `predicates.ts:getMemberName` (L397), which folds a string-literal computed key; spec PropName of a ComputedPropertyName is empty, so `get ['constructor']()` is legal. | computed-property-names/class/method/constructor-can-be-getter.js |
| M | Falsy argument through an f64-typed defaulted param reads back 0 | 8 | Collection-phase param typing (`class-bodies.ts` L1520-1545) types `aFalse = falseCount += 1` from the initializer (`number`) → f64 slot; `false`/`''`/`null` become 0 (probe `falsy-default.js`). #5139 "Falsy args" residual. The 4 `gen-method*` rows share the cause but the generator emit site packs params into `$GenState` fields (`generators-native.ts` ~L1944 note). | statements/class/method/dflt-params-arg-val-not-undefined.js · gen-method/dflt-params-arg-val-not-undefined.js |
| N | `undefined` element in a nested array pattern reads NaN | 8 | #5139 cluster 2c residual: `{ w: [x, y, z] = [...] } = { w: [7, undefined] }` — the nested-pattern element slot is f64 (`destructuring-params.ts` object-pattern lane; the array-pattern lane already widens via `resolveBindingElementType`/`isUndefWidenedBindingElement`, L1453-1465). Probe `dstr-undef.js`. 4 rows are `gen-meth*` twins. | statements/class/dstr/meth-dflt-obj-ptrn-prop-ary.js |
| O | Class constructor `arguments` / implicit derived ctor forwards only formals | 3 | `new Base(1,2)` on a 0-formal ctor: `arguments.length` is 0 (probe `ctor-arguments.js`) — the `new` site publishes `__argc`/`__extras_argv` only when `funcUsesArguments` has the `_new` name AND the count exceeds formals (`maybeSetArgcForKnownCall`, nested-declarations.ts:3341); the implicit derived ctor (`computeImplicitDerivedCtorPrefix` L451 / `findNearestAncestorCtorParams` L420) forwards the nearest ancestor's FORMALS only, so `new Derived(0,1,2)` reaches Base with `args.length === 0`. | statements/class/arguments/access.js · arguments/default-constructor.js · subclass/class-definition-evaluation-empty-constructor-heritage-present.js |
| P | Bound class constructor: bound args not applied; bound-call must TypeError | 2 | `Subclass2.bind({},3,4); new f()` → `s2prime.x` undefined (probe `dc2-full.js`); `Subclass.bind(obj)(1,2)` must throw (class [[Call]]). The `$__bound_fn` provider (`calls.ts:usesNativeFunctionBindProvider` L621) constructs through the dynamic-new fallback without the bound-args prefix. | statements/class/subclass/default-constructor-2.js · subclass/binding.js |
| Q | Builtin-subclass instances carry no builtin behaviour | 13 | #3972 identity-only carriers (`standalone-subclass-ctors.ts` header): `new Sub(42,'foo')` (Array) has no elements, `Bln.valueOf()`, `S.length`, `Symbol` subclass must TypeError on `new`, DataView/ArrayBuffer/Date/Number "called value is not a function". #5139 Step 4 scope note excluded these; listed for accounting, only the cheap slice is planned (Step 12). | subclass/builtin-objects/Symbol/new-symbol-with-super-throws.js · Array/length.js · Boolean/regular-subclassing.js |
| R | NativeError/Error `message` own-property presence + prototype inheritance | 7 | `registry/error-types.ts` `$Error_struct.$message` is always answered as own (`fieldArm("message",1)` L593); §20.5.6.1.1 makes it own ONLY when the ctor argument is present, and `Err.prototype.message = 'x'` must be inherited by `new Err()`. #5139 Step 4 not landed ("errors have no `hasOwnProperty` arm; `verifyProperty` probes by mutating"). | subclass/builtin-objects/NativeError/TypeError-message.js · Error/message-property-assignment.js |
| T | `caller`/`arguments` restricted properties on class objects and method closures | 4 | `function-poison-pill.ts` poisons strict FUNCTIONS; the class object (`$ClassName` struct) and method/accessor closures answer `BaseClass.caller` without the §10.2.4 AddRestrictedFunctionProperties TypeError, and `hasOwnProperty('caller')` must be false. | statements/class/restricted-properties.js · definition/methods-restricted-properties.js · strict-mode/arguments-callee.js |
| Z | Out of scope (owned elsewhere / environment) | 38 | see "Out of scope" | — |

Counts: A 48 · B 18 · C 2 · D1 14 · D2 11 · D3 5 · D4 6 · E 8 · F 10 · G 6 ·
H 5 · I 1 · J 2 · K 3 · M 8 · N 8 · O 3 · P 2 · Q 13 · R 7 · T 4 · Z 38
= 222 row-memberships over 209 rows (13 rows sit in two clusters: the 14 D1
rows minus the 3 object-literal ones also need D2/D3/D4). **In scope: 171
rows.**

## Implementation Plan

Ordered by yield per unit of risk. Each step is independently shippable and
names the sub-list to re-run afterwards
(`npx tsx scripts/run-test262-paths.mts .tmp/es2015/class-cl-<X>.txt --standalone`;
add `--isolate` only if a run dies of realm poisoning — none of these lists
contains an `Array.prototype[@@iterator]` poisoner). Re-run
`.tmp/es2015/class-controls.txt` after every step (22/22 must stay green).

All type queries via `ctx.oracle` (`src/checker/oracle.ts`); the existing raw
`ctx.checker.*` calls in touched files are grandfathered — do not add new
ones (oracle-ratchet gate).

### Step 1 — Runtime-computed element keys, instance side + key evaluation (A, C; 5 rows alone, 43 more with Step 2)

1. Collection (`class-bodies.ts:collectClassDeclaration`): at each
   `resolveClassMemberName(...) === undefined → continue` site for METHODS
   (L1453, L1462, L2850) and ACCESSORS (L1632, L1675), instead of skipping,
   mint a stable synthetic member name `__cmdyn$<ordinal>` (ordinal = index
   in `decl.members`; the `$` cannot appear in a source identifier, so it
   cannot collide with a declared key — same reasoning as
   `class-member-keys.ts`'s `__cm$` prefix) and register the body exactly as
   a named member is registered (funcMap key via `classMemberFuncKey`,
   `classMethodSet`/`staticMethodSet`/`classAccessorSet` membership,
   `recordFnMetaMemberDeclaration`). Record the member in a NEW per-class
   list `ctx.classDynamicMembers: Map<className, {ordinal, member, kind:
   "method"|"get"|"set", isStatic, syntheticName}[]>` (add to
   `context/types.ts` + `create-context.ts`). Private names and members
   whose key folds are untouched.
2. Key evaluation at ClassDefinitionEvaluation, ONCE, in source order: add a
   per-class externref module global `__cmkey_<C>_<ordinal>` per dynamic
   member (register next to `protoGlobals` at `class-bodies.ts:1249-1276`).
   Extend `nested-declarations.ts:emitUnresolvedComputedAccessorNameEffects`
   (L390; already called at every definition site: L514, L573,
   `new-super.ts:2945` for class expressions, `variables.ts:106`) to cover
   METHODS as well and to `global.set` the ToPropertyKey'd result instead of
   dropping it (keep the existing evaluate→`emitToPropertyKeyOnce`
   (`computed-member-reference.ts:20`)→drop for accessors whose key folds).
   A Symbol key must survive ToPropertyKey as a symbol (the helper already
   preserves symbols — #2666); `compileRuntimeComputedPropertyKey`
   (`literals.ts:884`) is the object-literal twin to mirror for the
   `staticJsTypeOf`-guided boxing.
3. Install: in `class-proto-object.ts:emitStandaloneClassProtoObject`
   (L161) replace the methods-then-accessors-then-constructor sequence with:
   `constructor` FIRST (fixes gOPN order, probe `proto-gopn-symbol.js`), then
   ONE walk over `decl.members` in source order (get the declaration via
   `ctx.classDeclarationMap`) emitting, per non-static, non-private member:
   a data property for a method (`__defineProperty_value`, `METHOD_FLAGS`),
   an accessor property for a get/set pair (`emitClassProtoAccessorInstalls`
   pattern, `class-proto-accessors.ts:128`; merge a getter and setter with
   the same folded key into one define, last definition wins — this is what
   flips `getter-duplicates.js`), and for a DYNAMIC member the key operand is
   `global.get __cmkey_<C>_<ordinal>` instead of a string constant. Defining
   the same runtime key twice is naturally last-wins on the `$Object` store.
   Drop the `installableMethodNames`/`installableClassAccessors` ordering
   split (keep the helpers as predicates for `standaloneClassProtoObjectApplies`).
4. `standaloneClassProtoObjectApplies` (L146): apply whenever
   `ctx.classObjectGlobals.has(className)` — a method-less class still needs
   the own `constructor` (cluster C). Keep the builtin-parent exclusion.
5. Force the prototype singleton to initialize at the definition site so the
   installs (and their key reads) run at ClassDefinitionEvaluation, not at
   first `C.prototype` touch: after the key evaluation in step 1.2, call
   `emitLazyProtoGet(ctx, fctx, className)` (`extern.ts:302`) and `drop`,
   gated on the class having ≥1 dynamic member (byte-identical otherwise).
6. Duplicate-static-key accessors (`get b(){}` + `get ['b'](){}`, folding to
   the same name): make the funcMap guard at L1640/L1683 keep the LAST
   declaration (overwrite the key's funcIdx; the earlier body is compiled
   but unreferenced — acceptable, it is dead).
7. Instance-side dynamic reads already go through the dynamic MOP for
   computed access (`c[x || 1]()` compiles as an externref element call) —
   verify with `probes5195/cpn-runtime-method.js` first assert; the static
   assert needs Step 2.

Re-run: `class-cl-A-computed-keys.txt` (expect the 5 instance-only rows:
`getter-duplicates`, `accessor-name-inst-computed-in` ×2, `method/{number,string,symbol}` — number/string/symbol only if their gOPN order assert passes) and
`class-cl-C-proto-constructor.txt` (2).

### Step 2 — Static sidecar `$Object` for the class object (B; unlocks A's static halves: +43, plus 18)

Do NOT convert the class object itself: `emitDynamicNewFallback`
(`new-super.ts:3250`) and `property-access.ts:tryEmitConstructorViaTag`
(L3260) `ref.test` it as `$ClassName` and read `__tag` — the #3976 blocker.
Instead give each class a parallel real `$Object` that the reflective
natives are REDIRECTED to when the receiver IS the class-object singleton.

1. New file `src/codegen/class-static-sidecar.ts` (template:
   `class-proto-object.ts`). Per class with ≥1 static method/accessor, a
   `static constructor`, or ≥1 static DYNAMIC member: a module global
   `__static_<C>` (externref, registered beside `protoGlobals` at
   `class-bodies.ts:1249`; new map `ctx.classStaticSidecarGlobals`). Lazy
   init body: `__new_plain_object`; then `__defineProperty_value` for
   `length` (ctor arity, flags `{w:0,e:0,c:1}` = `0x04`), `name`
   (`{w:0,e:0,c:1}`), `prototype` (value = `emitLazyProtoGet`, flags 0 —
   non-writable, non-configurable); then static members in source order:
   methods via `emitCachedMethodClosureAccess` with the SAME key the static
   value read uses (`classMemberFuncKey(ctx, fullName, "static")`,
   `property-access-dispatch.ts:2099/2269`) so `gOPD(C,'sm').value === C.sm`;
   accessors via `__defineProperty_accessor` (`ACCESSOR_FLAGS`); dynamic
   members read their `__cmkey_` global. Static FIELDS (`staticProps`
   globals) are NOT mirrored in this wave (their reads/writes keep the global
   lowering; `Object.getOwnPropertyNames(C)` fold already lists them).
   Force-init at the definition site like Step 1.5.
2. Redirect prologue: mint at finalize a native
   `__class_static_sidecar_of(externref) -> externref` with one
   `ref.eq`-against-`global.get __class_<C>` arm per sidecar class
   (precedent for finalize-minted per-class arms and PREPENDING into existing
   natives: `dynamic-proto.ts:fillDynamicProtoHelpers` L376, and
   `object-runtime-proxy.ts:ensureProxyRuntime` L69). Prepend to
   `__hasOwnProperty`, `__getOwnPropertyDescriptor`, `__getOwnPropertyNames`,
   `__getOwnPropertySymbols`, `__propertyIsEnumerable`, `__extern_get`,
   `__extern_set`, `__extern_set_strict`, `__defineProperty_value`,
   `__defineProperty_accessor`, `__delete_property` (names at
   `object-runtime.ts:12295-12382`): `local.get 0; call
   __class_static_sidecar_of; local.tee t; ref.is_null; if-not → replace
   param 0 with t and fall through`. Gate everything on `ctx.standalone &&
   ctx.classStaticSidecarGlobals.size > 0` (byte-identical otherwise).
3. Compile-time folds that currently answer WITHOUT the runtime:
   `call-builtin-static.ts` L2949-3000 (`gOPD(C, <literal>)`): when the
   class has a sidecar, compile the receiver and key and call
   `__getOwnPropertyDescriptor` (the prologue does the rest) instead of
   synthesizing/`emitUndefined`; L3280-3295 (`Object.getOwnPropertyNames(C)`
   fold from `classStaticOwnPropertyNames`): call the native on the class
   object when a sidecar exists (order is preserved because
   `length,name,prototype` are installed first).
4. `static constructor()`: `module-rules.ts:checkDuplicateConstructors`
   (L288) must skip a ConstructorDeclaration carrying `static` (TS parses
   `static constructor(){}` as a ConstructorDeclaration with a StaticKeyword
   modifier); `ast-modifiers.ts:findConstructorImplementation` (L40) must
   likewise skip it; `collectClassDeclaration` treats it as a static METHOD
   named `constructor` (the #3024 read arm at
   `property-access-dispatch.ts:2229` already serves `C.constructor` for that
   shape). `static get/set constructor` already parse as accessors.
5. Static/instance accessor name collision (`getters-restricted-ids.js`):
   give static accessors kind-distinct keys the way methods do —
   `classMemberFuncKey(ctx, getterName, "static")` at registration
   (L1640/L1683) and at every static accessor dispatch (`_get_`/`_set_` sites:
   `property-access-dispatch.ts:1573/2087/2293/2445/3990`,
   `assignment.ts:4315/4808/5478`, `property-access.ts:emitGetterCallWithDummy`
   L1308, `assignment.ts:emitSetterCallWithDummy` L5177). Mirror the
   `staticAccessorSet` membership check at each site so an instance accessor
   never answers a static read.
6. `hasOwnProperty('caller')`/`('arguments')` on the class object is answered
   by the sidecar (false). The TypeError on READ (cluster T) is Step 11.

Re-run: `class-cl-B-static-surface.txt` (18) and `class-cl-A-computed-keys.txt`
(expect all 48 now; `fn-name-method.js` / `fn-name-accessor-*.js` (3) also
need SetFunctionName from a runtime key — a symbol key names the function
`'[' + description + ']'` or `''` — set the `$fnmeta` name slot at install
time from the key global; if that slot is immutable, leave those 3 as a
documented residual).

### Step 3 — `typeof`/member reads on a closure-written module `var` (D1; 3 rows alone, gates 11 more)

1. Remove the `ctx.standalone !== true && ctx.wasi !== true` conjuncts from
   the two P-7 guards (`typeof-delete.ts:2026`, `:2317`) — the `__typeof`
   native exists in standalone (`typeof-natives-finalize.ts:212`). #5153
   tried this and confirmed the fold is fixed by it.
2. Member read on the same binding (`caught.constructor` reads null): the
   identifier's checker type is `undefined`, so the member lowering takes a
   static null path. Find the arm by compiling `probes5195/caught-idiom.js`
   with the Step-3.1 change and inspecting the WAT for the
   `caught.constructor` read (`npx tsx src/cli.ts <file> --standalone --wat`,
   or the `analyze-wat` skill); expected site: `property-access-dispatch.ts`
   receiver classification. Fix: when the receiver is an identifier whose
   flow type is null/undefined AND `sourceHasIdentifierAssignment(sf, name)`
   (`typeof-delete.ts:1540` — export it) is true, compile the receiver as
   externref and take the dynamic `__extern_get` lane. Keep the fold for
   bindings never assigned.

Re-run: `class-cl-D1-typeof-caught-fold.txt` — expect
`prop-dot-obj-null-proto`, `prop-expr-obj-null-proto`,
`prop-expr-obj-unresolvable` (3); the rest flip in Steps 4–6.

### Step 4 — Runtime `super` reads for class methods (D2; 11 rows, of which 8 need only this + Step 3)

Prerequisites first, each with its probe:

1. Typed prototype write: in `assignment.ts:compilePropertyAssignment`
   (L4069), when `target.expression` is `<Class>.prototype` (or `this.prototype`
   in a static context), compile the receiver through `emitLazyProtoGet` and
   store with `__extern_set` (the object-literal externref lane
   `compilePropertyAssignmentExternSet` L5009) — never the instance struct
   lane. Probe `proto-write.js` must pass.
2. Link the prototype chain: in `emitStandaloneClassProtoObject`, after
   `__new_plain_object`, set the `$Object.$proto` of `D.prototype` to the
   parent's prototype singleton (`emitLazyProtoGet(parent)` +
   `__object_setPrototypeOf` — the native the `$Object` lane already uses,
   see `dynamic-proto.ts` header) when `ctx.classParentMap` has a compiled
   parent; leave null for base classes (`%Object.prototype%` rooting is a
   separate slice — `basics.js` is environment-blocked anyway).
3. Instance read fallback: an undeclared member read on a closed-struct
   instance (`new A().x` after `A.prototype.x = 'a'`) must consult the class
   prototype `$Object`. Reuse the Slice-C mechanism in `dynamic-proto.ts`
   (`__struct_proto_get` / `__extern_get` prepended arm, L376): extend the
   marked-root set so every class WITH a `$Object` prototype gets the
   `__extern_get` arm whose never-set fallback is the compile-time proto
   singleton. Gate on standalone; measure the control list after.
4. Then #5153 Step B as written: in `compileSuperPropertyAccess` (L1273),
   `compileSuperElementAccess` (L1413) and `compileSuperMethodCallCore`
   (L1055), BEFORE each default-emitting fallback, add the standalone lane
   `__getPrototypeOf(<own proto singleton>)` → RequireObjectCoercible
   (TypeError via `emitThrowTypeError`, `js-errors.ts:111`) →
   `__reflect_get_receiver(proto, key, receiver)` (`object-runtime.ts:2645`),
   receiver = struct `this` when present and non-null, else
   `__current_this` (`ensureCurrentThisGlobal`, nested-declarations.ts:3364).
   Arrow bodies inside class methods: extend the
   `SUPER_HOME_OBJECT_CAPTURE_NAME` capture (closures.ts:175/3215) to seed the
   class proto singleton (2 `*-val-from-arrow` rows).

Re-run: `class-cl-D2-super-runtime-read.txt` (11; `*-cls-null-proto` ×2 and
`prop-expr-cls-unresolvable` also need Step 3).

### Step 5 — Derived-ctor `this` TDZ + double `super()` (D3; 5 rows)

In `class-bodies.ts` ctor lowering (the derived `_init` body, L2560-2700) and
`compileSuperCall` (L3770): only when the ctor body has (a) a `this`/`super.x`
reference lexically before its first top-level `super()`, or (b) ≥2 lexical
`super()` sites, or (c) a `super()` nested in try/catch/blocks — allocate an
i32 local `__this_init` (0 at entry). At every `this` read/write and
`super.prop` access in the ctor body proper (not nested functions; arrows
included) emit `if (!__this_init) throw ReferenceError` (message as at
`class-bodies.ts:2679`; `emitThrowReferenceError`, js-errors.ts:119). At each
`super()` site: evaluate the arguments, THEN `if (__this_init) throw
ReferenceError` (so `fCalled === 1` and the parent is not re-run), then call
the parent `_init`, then set `__this_init = 1`. Ctors with a single
straight-line `super()` and no early `this` stay byte-identical.
`this-check-ordering.js` additionally needs `super(super(), f())` (inner
`super()` inside the outer's argument list) — the nested-`super(...)` route
#5153 F landed in the call dispatcher covers reaching it.

Re-run: `class-cl-D3-this-tdz-double-super.txt` (5; the 3 super rows also
need Step 3).

### Step 6 — `super.x = v` (D4; 6 rows, 4 also need Step 3)

Add a `SuperKeyword`-base arm to `compilePropertyAssignment` (and the element
twin): base = `__getPrototypeOf(<home object>)` (class proto singleton or
the object-literal home object), receiver = current `this`. Add a native
`__reflect_set_receiver(target, key, value, receiver) -> i32` in
`object-runtime.ts` modeled on `__reflect_get_receiver` (L2645) performing
§10.1.9.2 OrdinarySetWithOwnDescriptor (data property on the chain → define
on the RECEIVER if extensible, else false; accessor → call setter with
receiver). Strict code (class bodies, and `"use strict"` object-literal
tests): `false` → TypeError via the `__extern_set_strict` layering
(`object-runtime-strict-set.ts`); sloppy: silent.

Re-run: `class-cl-D4-super-write.txt` (6).

### Step 7 — Heritage evaluation at ClassDefinitionEvaluation (F; 10 rows)

1. `collectClassDeclaration` (L919): unwrap `ParenthesizedExpression` and, for
   a comma `BinaryExpression`, take the RIGHT operand as the static parent
   (`(calls++, C)` → `C`) and record the LEFT operand(s) in a new
   `ctx.classHeritagePrefixEffects: Map<className, ts.Expression[]>`; emit
   them (compile + drop) at the definition site right before the class-object
   init. This removes the `planning-identity.ts:412` COMPILE_ERROR.
2. Non-identifier / non-class heritage in standalone: at
   `compileNestedClassDeclaration` (nested-declarations.ts:412) and
   `compileClassExpression` (new-super.ts:2915), for a heritage whose parent
   is NOT a compiled class or a known builtin ctor, evaluate the expression
   ONCE to externref and run a new native `__class_heritage_check(parent) ->
   externref`: null → ok (`extends null`); not an object with [[Construct]]
   → TypeError "Class extends value X is not a constructor or null"
   (IsConstructor via `reflect-construct-native.ts:ensureReflectIsConstructor`
   L195, which reads the closure `__constructible` flag —
   `arrow-phases.ts:942`); else `__extern_get(parent, "prototype")` (runs a
   getter exactly once — `prototype-getter.js`) and if the result is neither
   object nor null → TypeError "Class extends value does not have valid
   prototype property". A bound function value (`function(){}.bind()`) is
   constructible; its `prototype` is absent → `constructable-but-no-prototype.js`
   expects TypeError, which the "neither object nor null" branch gives.
   `Proxy` is a builtin without `prototype` → same branch.
3. `Object.getPrototypeOf(D) === C` for class objects (`side-effects-in-extends.js`):
   add a `classParentMap` arm to the `Object.getPrototypeOf(<class ident>)`
   fold in `call-builtin-static.ts` (near L2127) returning the parent's
   class object (`emitLazyClassObjectGet`).

Re-run: `class-cl-F-heritage-eval.txt` (10).

### Step 8 — `new.target` value carrier (G; 5 rows + 1 early error)

1. Early error (1 row): in `early-errors/node-checks.ts` beside the
   MetaProperty rule at L1204, report "new.target expression is not allowed
   here" when the nearest enclosing non-arrow function-like ancestor of a
   `new.target` MetaProperty is none (global code) — arrows inherit.
2. Value carrier (gated on `ctx.usesNewTarget`, `new-target.ts:scanForNewTarget`):
   add an externref global `__new_target_value`. Set it at every `new` site
   that constructs a plain function (`new-super.ts:compileNewFunctionDeclaration`
   L1913 and the dynamic-new fallback's fnctor arms) to the function's
   closure singleton (`method-trampolines.ts:emitCachedFuncClosureAccess`
   L1286 — the same value `f` reads as), and at class `new` sites
   (`emitSetNewTargetBeforeCall` callers, new-super.ts:3721/6587) to the
   class object (`emitLazyClassObjectGet`); ordinary CALL sites of a source
   function reset it to null before the call (the `function-poison-pill.ts`
   `__caller_strict` threading is the exact precedent for a call-site-set,
   callee-snapshot global). In `function-body.ts:compileFunctionBody` (L231)
   and the closure body compile, when the body (or an arrow inside it) reads
   `new.target`, snapshot the global into an activation local at entry; the
   `expressions.ts:1623` read returns that local (undefined when null).
3. Class ctors keep the i32 id for the `new.target === C` compare
   (`binary-ops.ts:3785`); for a VALUE read inside a ctor (`x = new.target`)
   materialize the class object from the id with a small `br_table`/if-chain
   over `ctx.classNewTargetIds` → `emitLazyClassObjectGet`
   (`value-via-super-call.js`).

Re-run: `class-cl-G-new-target.txt` (6; `eval-code/direct/new.target-fn.js`
is environment-blocked and not in this list).

### Step 9 — Accessor assignment gaps + inner binding + small parser/name fixes (H, I, J, K; 11 rows)

- H (5): in `assignment.ts:compilePropertyAssignment` add the static-setter
  arm for PropertyAccess targets whose receiver is a class identifier
  (mirror the element-target arm at L5465-5480, resolving through
  `classMemberFuncKey(..., "static")`), and make the instance-setter arm
  (L4803) fire for a `NewExpression` receiver (compile the receiver to the
  struct ref, then `emitSetterCallWithDummy`-style call). Probes
  `accessor-stmt-effects.js`, `static-setter.js`.
- I (1): `emitIdentifierWriteFromLocal` (L928): treat an identifier that
  resolves (via `ctx.oracle.valueDeclarationOf`) to the enclosing class's own
  name binding, from inside that class body, as a const target → TypeError
  "Assignment to constant variable.". Probe `name-binding.js`.
- J (2): in `classMemberFuncKey` (class-member-keys.ts:46) and the member
  naming in `collectClassDeclaration`, relocate a member whose name is one of
  the synthetic suffixes (`new`, `init`) to `__cm$<C>_<name>` unconditionally
  (same mechanism as the top-level-function collision). Probe
  `method-named-new2.js`.
- K (3 CE): `node-checks.ts:1281` — skip the "constructor" restrictions when
  `member.name` is a `ComputedPropertyName` (spec PropName is empty for
  computed keys). The computed `['constructor']` member is then an ordinary
  prototype method (Step 1 installs it; it must be defined AFTER the
  intrinsic `constructor` so it replaces it — source-order walk handles that).

Re-run: `class-cl-H-temp-receiver-setter.txt` (5),
`class-cl-I-inner-binding-const.txt` (1), `class-cl-J-method-named-new.txt`
(2), `class-cl-K-computed-constructor-name.txt` (3).

### Step 10 — Parameter fidelity (M, N, O; 19 rows; 8 are generator twins)

- M (8): collection-phase param typing (`class-bodies.ts` L1520-1545): when a
  parameter has an initializer and NO type annotation, and the initializer's
  static type is a scalar (number/boolean/string), the slot must be
  `externref` — the call site may pass any falsy value that is not the
  initializer's type. Same rule at the fctx-build phase (both phases must
  agree — see the #5221 `isUndefinedDefaultOnlyParam` note, L1531). The
  default check for externref slots already exists
  (`emitClassParamDefaultCheck`, L241, `__extern_is_undefined`). For the 4
  `gen-method*` rows the widened slot must also flow into the `$GenState`
  param fields (`generators-native.ts` ~L1944 param-default note); if that
  needs a generator-emit change, stop and hand those 4 to the generator lane.
- N (8): object-pattern element with a nested array pattern
  (`destructuring-params.ts` object lane, the sibling of the array-lane
  widening at L1453-1465): route the nested elements' locals through
  `resolveBindingElementType` + `isUndefWidenedBindingElement`
  (`checker/type-mapper.ts:284/330`) so an element whose source can be
  `undefined` gets an externref slot. 4 rows are `gen-meth*` twins with the
  same caveat as M.
- O (3): (i) the `new C(...)` site must publish `__argc`/`__extras_argv`
  whenever the ctor (or any ancestor `_init` it chains to) is in
  `ctx.funcUsesArguments` — extend the registration #5153 A.2 added so that
  a derived class's implicit ctor inherits the parent's membership; (ii) the
  implicit derived ctor (`computeImplicitDerivedCtorPrefix`, L451) must
  forward the real argument count (`__argc` pass-through is documented at
  L2566 — verify it is not clobbered by `maybeSetArgcForKnownCall` on the
  inner `_init` call) and the extras vector, so `args.length === 3` in the
  parent; (iii) `Derived.apply(obj, arr)` → class [[Call]] TypeError via the
  `tryEmitClassConstructorCallWithoutNew` guard (`class-call-without-new.ts`)
  extended to `.apply`/`.call` receivers that are source classes.

Re-run: `class-cl-M-falsy-default-params.txt` (8),
`class-cl-N-dstr-undefined-widen.txt` (8), `class-cl-O-ctor-arguments.txt` (3).

### Step 11 — Derived `return`, bound class ctors, restricted properties, NativeError message (E, P, T, R; 21 rows)

- E cheap half (3): `control-flow.ts:compileReturnStatement` — extend the
  base-class struct arm (L433-500) to `fctx.isDerivedConstructor`: bare
  `return;` / `return undefined` → `local.get __self`; `return null` and
  statically-primitive operands → TypeError (`emitThrowTypeError`, message
  as at L2670). Probe `derived-return-empty.js`.
- E override half (5): a derived ctor whose body contains `return <object
  operand>` (or whose fnctor parent `fnctorBodyMayReturnForeignObject`,
  new-super.ts:32) needs an externref result: register the class in
  `ctx.classExternrefBackedSet` at collection when that predicate holds, so
  `_new`/`_init` take the existing externref-result lane
  (`class-bodies.ts:2270`, `returnType: externref`) and `new` sites box the
  result; the `constructThisExternLocal` return arm (control-flow.ts:410)
  then applies §10.2.1.3 step 13 at runtime. Land only if the control list
  stays green; otherwise file the residual with the probe
  (`derived-return-object.js`).
- P (2): bound class constructor — in the `$__bound_fn` construct path
  (`calls.ts` bind provider, `emitDynamicNewFallback` arms) prepend the bound
  argument vector before the call-site args, and route a plain CALL of a
  bound class ctor to the class [[Call]] TypeError. Probe `dc2-full.js`.
- T (4): apply the `function-poison-pill.ts` strict-function `caller`/
  `arguments` TypeError to (a) class-object receivers (`C.caller` read/write —
  the sidecar from Step 2 answers `hasOwnProperty` false; the READ arm must
  throw) and (b) method/accessor closure receivers (`instance.method.caller`);
  `strict-mode/arguments-callee.js` also needs `arguments.callee` inside a
  strict fnctor parent to throw (`arguments-callee-poison.ts`).
- R (7): `registry/error-types.ts` — give `$message` a presence distinction:
  ctor with `argCount > 0` and a non-undefined arg stores the message in the
  `$props` open `$Object` (fieldIdx 5, the same bag the #2101a R5 own-field
  read uses) so `hasOwnProperty`/gOPD/`verifyProperty` mutation probes work
  through the existing `$Object` arms; a missing own `message` must fall to
  the prototype chain (`Err.prototype.message`), which needs the error
  prototype carrier to be reachable from the `$Error_struct` `__extern_get`
  arm (`fieldArm("message",1)` L593 must test presence first).

Re-run: `class-cl-E-derived-return.txt` (8), `class-cl-P-bound-class-ctor.txt`
(2), `class-cl-T-restricted-caller-arguments.txt` (4),
`class-cl-R-error-message-own.txt` (7).

### Step 12 — Builtin-subclass behaviour, cheap slice only (Q; target 7 of 13)

`standalone-subclass-ctors.ts`: (i) `Symbol` parent — `super()`/implicit ctor
must TypeError ("Symbol is not a constructor"), 1 row; (ii) wrapper parents
Boolean/Number/String already get a real `$Object` wrapper box — make
`valueOf()`/`length` on the subclass instance dispatch as the wrapper does
(3 rows: Boolean, Number, String ×2 — `String/length` also needs the
non-writable/non-configurable `length` own property); (iii) `Array` parent —
seed the real array carrier from the forwarded ctor args exactly like #5212
did for Map/Set (`Array/length.js`, `contructor-calls-super-multiple-arguments.js`,
2 rows). DataView / ArrayBuffer / Date / Promise / TypedArray / `builtins.js`
stay identity-only — file them as one follow-up issue with the row list.

Re-run: `class-cl-Q-builtin-subclass-behaviour.txt` (expect ≥7 of 13).

### What NOT to do

- No new host imports — standalone must stay host-import-free (the runner
  fails any module that emits one, `standaloneHostImportError`). Every new
  helper is a defined native (`ensureObjectRuntime` / `registerNative`
  route), including `__class_static_sidecar_of`, `__reflect_set_receiver`,
  `__class_heritage_check`.
- Do not convert the class object to an `$Object` (Step 2 explains why); do
  not touch `emitDynamicNewFallback`'s tag dispatch or
  `tryEmitConstructorViaTag`.
- No edits to `tests/test262-runner.ts`, skip lists, `HANGING_TESTS`, or any
  `scripts/*baseline*.json`; no `--no-verify`.
- Do not add raw `ctx.checker.*` calls — `ctx.oracle` only (oracle-ratchet).
- Stay out of the owned areas: native generator carrier (#680/#2864 — the
  `yield-spread-arr-*`, `methods-gen-yield-as-yield-operand` and
  `gen-meth-*-elem-ary-empty-init` rows), `Reflect.construct` distinct
  NewTarget (#3371), `Reflect.set` receiver (#2046), RegExp subclassing
  (#5198). Steps 10 M/N touch generator TWINS only through the shared
  collection-phase typing; if the generator emit site needs its own change,
  stop and hand off.
- Keep every currently-static fast path (accessor set, struct fields, funcMap
  dispatch, `staticProps` globals) — add runtime lanes only where the code
  emits a silent default today. The 22 controls are the order-preservation
  check.

## Out of scope (owned elsewhere / environment) — 38 rows, `class-cl-Z-owned-or-env.txt`

| Rows | Reason |
|---|---|
| `gen-method(-static)/yield-spread-arr-{single,multiple}.js` ×8 (statements + expressions), `definition/methods-gen-yield-as-yield-operand.js` | native generator carrier — #680/#2864 (codex lane active) |
| `dstr/gen-meth-*-ary-ptrn-elem-ary-empty-init.js` ×8 | generator-lane param destructuring (the plain-method twin passes — #5139 "not isolated"); same owner |
| `expressions/new.target/value-via-reflect-construct.js`, `expressions/super/call-construct-invocation.js` | deliberate #3371 standalone `Reflect.construct` NewTarget COMPILE_ERROR — must stay one |
| `subclass/builtin-objects/RegExp/{lastIndex,regular-subclassing}.js` | RegExp — #5198 |
| `expressions/super/realm.js` | needs `$262.createRealm` |
| `expressions/super/prop-*-val-from-eval.js` ×4, `eval-code/direct/new.target-fn.js` | direct `eval` — QuickJS runtime-eval tier (artifact not built in this container) |
| `subclass/builtin-objects/Function/{instance-length,instance-name,regular-subclassing}.js`, `definition/basics.js`, `subclass/class-definition-null-proto.js` | `new Function(...)` / `Function.prototype` route to the QuickJS provider → `compilation timeout` / "provider is not built" here (baseline reasons differ only because CI has the artifact); re-verify in CI after Steps 2 and 7 |
| `decorator/syntax/valid/*-identifier-reference-yield.js` ×6 | decorators are not ES2015; the diagnostic is TypeScript's parser (`'yield' is a reserved word`) — not fixable in codegen |

## Acceptance criteria

Expected flips per step (rows from the named sub-list; the baseline for every
list is 0 pass on HEAD `0d9bfedee`):

| Step | Sub-list(s) | Expected pass after the step |
|---|---|---|
| 1 | A, C | A: 5 (instance-only rows) · C: 2 |
| 2 | B, A | B: ≥15 of 18 (the 3 `fn-name-*` rows may remain) · A: 48 |
| 3 | D1 | 3 (`*-obj-null-proto` ×2, `prop-expr-obj-unresolvable`) |
| 4 | D2 | 11 (with Step 3) |
| 5 | D3 | 5 (with Step 3) |
| 6 | D4 | 6 (with Step 3) |
| 7 | F | 10 |
| 8 | G | 6 |
| 9 | H, I, J, K | 5 + 1 + 2 + 3 |
| 10 | M, N, O | 4 + 4 non-generator rows for sure; 8 more if the generator twins take the shared fix · O: 3 |
| 11 | E, P, T, R | E: 3 (cheap half) + up to 5 · P: 2 · T: 4 · R: 7 |
| 12 | Q | ≥7 of 13 |

Total expected yield: **≥150 of the 171 in-scope rows** (the conservative
floor excludes E's override half, the 3 `fn-name-*` rows, the 8 generator
twins in M/N, and 6 Q rows); **171** if every step lands whole.

- After EVERY step: `npx tsx scripts/run-test262-paths.mts .tmp/es2015/class-controls.txt --standalone`
  → 22/22 pass (verified 22/22 on HEAD before any change — see the
  verification line at the end of this section).
- Final: `npx tsx scripts/run-test262-paths.mts .tmp/es2015/class-head.txt --standalone`
  → pass ≥ 150, no row regresses to a WORSE class (a `fail` must not become
  `compile_error`/`timeout`), every remaining non-pass row is either in
  `class-cl-Z-owned-or-env.txt` or listed in this file's Results section
  with a one-line reason.
- Focused permanent tests: add `tests/issue-5195-es2015-class-r2.test.ts`
  pinning, per landed step, 1–2 exact test262 rows in host AND standalone
  (zero standalone imports asserted) plus the corresponding
  `probes5195/*.js` shapes as inline controls (pattern:
  `tests/issue-5213-es2015-class-prototype-accessor.test.ts`).
- Repo gates, chained, before every commit:
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
  (also with `LOC_GATE_BASE=$(git rev-parse origin/main)` to simulate CI's
  merge preview), plus `pnpm run test:equivalence:gate`, plus
  `node scripts/check-issue-spec-coverage.mjs` and
  `node scripts/update-issues.mjs --check` (this file must keep parsing).
- Byte-inertness: a module with no classes, and a module whose classes have
  no static members / dynamic keys / non-class heritage / `new.target`, must
  compile to identical bytes before and after Steps 1, 2, 7 and 8 (compare
  `.wasm` of two `playground/examples/*.ts` files that use plain classes).

Control list verification on HEAD `0d9bfedee` (2026-09-01):
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/class-controls.txt --standalone`
→ `{ pass: 22 }` (`.tmp/es2015/class-controls-run1.txt`).

## References

- #5139 (class wave 1; its Results/"Not attempted" section is the seed of
  clusters A/B/M/N/R), PRs #5173/#5213; #5153 (super wave 1; clusters
  D1–D4/E are its documented residuals); #4450 (static `name`/`length`
  precedence — done, `class-static-metadata.ts`); #5212 (Map/Set subclass
  ctor, the pattern Step 12 reuses for Array); #5213 (instance `prototype`
  accessor).
- #3976 / #4455 — prototype `$Object` sidecar (`class-proto-object.ts`,
  `class-proto-accessors.ts`); the static sidecar in Step 2 is its twin.
- #802 — `dynamic-proto.ts` finalize-time prepended arms (the mechanism Step
  2.2 and Step 4.3 reuse); #1355 — `object-runtime-proxy.ts` prologue arms.
- #4688 — object-literal runtime super reads; #2666 — `emitToPropertyKeyOnce`;
  #2126 — object-literal runtime computed keys.
- #2623 P-7 — the `typeof` unsound-fold guard (Step 3); #2107 — the stale
  "null stub" justification it cites.
- #2023 — `new-target.ts`; #4483 — `class-call-without-new.ts`; #3972 /
  #2917 — `standalone-subclass-ctors.ts`; #1536 / #2101a — `$Error_struct`.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`.

## Suspended Work (2026-09-01T21:56Z — user-requested 2-hour pause)

- **Branch**: local lane branch `worktree-agent-a7080d5c21bf4a49c` at `27ffb1a99`
  (WIP snapshot on top of base `dc29e1f15`; NOT pushed — durable copy is
  `plan/agent-context/es2015-suspend-2026-09-01/patches/lane-5195.mbox`, 2
  patches: `44dcc7d90` "Step 3 + Step 9K — closure-written binding reads,
  computed 'constructor' key ✓" + the snapshot carrying uncommitted edits in
  `src/codegen/class-proto-object.ts` and
  `src/codegen/expressions/call-builtin-static.ts` and the issue-file
  allowance amendment for
  `property-access-dispatch.ts::finalizeStructAndDynamicMemberGet` (+21)).
- **Worktree at suspension**: `/home/user/js2/.claude/worktrees/agent-a7080d5c21bf4a49c`
  (treat as gone).
- **State**: mid-implementation. Step 3 (D1 typeof/member reads on a
  closure-written module `var`) and Step 9-K (computed `['constructor']` early
  error) committed; the uncommitted edits look like Step 1/2 work on the class
  prototype object (`class-proto-object.ts`) — unverified. Steps 1, 2, 4–12
  otherwise not landed.
- **Verified so far**: only what the `44dcc7d90` commit body records (read it
  after `git am`); no whole-list after-run recorded.
- **NOT yet verified / next steps**: (1) `pnpm run typecheck` on the applied
  patch — the uncommitted half may not compile; (2) `class-cl-D1*.txt` +
  `class-cl-K*.txt` + `class-controls.txt` (22/22) re-runs; (3) continue the
  plan in yield order: Step 1 (runtime-computed element keys, 48 rows) → Step 2
  (static sidecar `$Object`) → Step 4 (super reads) → …; (4) gates.
- **Traps**: the plan's out-of-scope table (generator carrier, decorators, eval
  tier, #3371, #5198, realm) — 38 rows — must not be chased. Merge, never
  rebase.

## 2026-09-02 resumed implementation (Opus)

Resumed from the suspension handoff (`git am` of `lane-5195.mbox`, 2 patches,
onto `0f801557a`). Four commits on `worktree-agent-aa423580afa75b4c5`.

**Whole-list, `class-head.txt` (209 rows), `--standalone`, in-process runner:**

| point | pass | fail | compile_error |
|---|---|---|---|
| baseline (HEAD `0d9bfedee`, 2026-09-01) | 0 | 190 | 19 |
| after the resumed patch (Step 3 + 9K) | 9 | 189 | 11 |
| after Step 1 + 1.7 | 24 | 172 | 13 |
| after Steps 1.6 / 9 H / 9 I / 11 E | 24 | 172 | 13 |
| after Step 2 | 28 | 170 | 11 |
| after the fill-order fix | 29 | 167 | 13 |
| **CORRECTED, integrated tree (2026-09-02, post-F1–F5)** | **28** | **169** | **12** |

**The 29/167/13 row was wrong and is superseded.** Independent verification on
the integrated tree (this branch merged onto main, carrying #5224 and the #5272
in-process host-import leak check) measured **28 / 169 / 12**, and this branch
re-measured the same 28/169/12 after merging `origin/main` again. Two corrections
to the earlier claim:

- `computed-property-names/class/method/constructor-can-be-generator.js` is NOT
  a standalone pass. Its generator body leaks `env::__create_generator` /
  `env::__gen_create_buffer` — the native generator carrier, owned by #680 /
  #2864 — and #5272 taught the in-process runner CI's leak check, so it now
  scores as `compile_error`. The class mechanism this issue owns IS fixed there:
  the HOST lane passes the row. `tests/issue-5195-es2015-class-r2.test.ts` pins
  the exact leak string, so the row flips loudly when that lane closes it.
- The earlier 13-CE reading included two `compilation timeout` rows that
  alternate with box load; they are environment-blocked either way.

**Host lane, same 209-row list: 32 pass / 168 fail / 9 compile_error.**

`class-controls.txt`: **22/22 standalone**, unchanged after every step.
**Host controls are 20/22, and the two failures are PRE-EXISTING on main** —
`expressions/class/accessor-name-static/computed-err-to-prop-key.js` and
`statements/class/dstr/meth-ary-init-iter-close.js`. They are not this branch's
and are excluded from the green claim.

### Verification findings F1–F5 (2026-09-02)

An independent skeptic reproduced five defects against base `0f801557ad`;
probes live in `/home/user/js2/.tmp/refute-F1/` and `.../refute-F2/`, and the
branch-local ones in `.tmp/es2015/p3/`.

| # | Severity | State | Evidence |
|---|---|---|---|
| F1 | HIGH | **fixed** | `class D extends C {}` over a runtime-keyed parent was a hard compile error; now compiles AND inherits. `refute-F1`: base 0/4 shapes, now 3/4 |
| F2 | MEDIUM | **fixed** | class object no longer answers instance-prototype members. `refute-F2` probe1/2/3: 0/0/0 → 3/3/15, matching the js lane |
| F3 | MEDIUM | **fixed** | the runtime-keyed call binds its receiver and no longer depends on codegen order |
| F4 | LOW | **half fixed, half documented** | `in` through a dynamic holder: 0 → 3 (A/B against the base tree). Statically-typed `in` and the WRITE side remain open |
| F5 | LOW | **fixed** | `hasOwnProperty` and `gOPD` now agree on a runtime-keyed member |

**F1** — the inheritance loop aliased the parent's synthetic `__cmdyn$<ordinal>`
funcMap entry into the child. That alias is a program-ABI claim, and the planner
resolves it back to the source member and asks for its spec key, which is
`undefined` for an unfoldable computed name — so it threw `no complete exact
canonical class-member authority` and the whole module failed. Base compiled
these (silently dropping the member). Fixed by skipping the alias and making
inheritance a runtime [[Prototype]] walk: `emitStandaloneClassProtoObject` links
the child prototype `$Object` to the parent's (§15.7.14 step 6, previously left
null), `__class_proto_lookup` covers every class in such a hierarchy, and the
static half walks to the nearest ancestor sidecar.

**F2** — `__class_<C>` is itself a `$C` struct, so the lookup's `ref.test`
matched it and returned the INSTANCE prototype whenever no sidecar existed;
`C[ID('m')]` answered an instance method where base (and the spec) says
`undefined`. The class-object identity test is now unconditional and answers the
sidecar or NULL, never the prototype.

**F3** — the call went through `tryEmitInlineDynamicCall`, which invokes with
`this` unbound (so ANY runtime-keyed call into a `this`-using method threw, not
only the `new C()[k]()` shape) and whose `ref.test` candidate set depends on
which closure wrappers codegen has registered so far (so an inherited member's
call folded to null or not depending on source order). Replaced by
`class-dynamic-member-call.ts`:
`__apply_closure(__extern_get(recv, ToPropertyKey(key)), recv, args)`, receiver
compiled exactly once.

**Found while fixing F3:** `ref.test` cannot identify a class at all — WasmGC
canonicalizes struct types structurally, so two unrelated classes with the same
field shape are the same type and the first lookup arm swallowed the other's
instances. Every arm now also tests the class's `__tag`.

### Residuals after F1–F5

- **F4 write side.** `c[ID('s')] = 7` neither runs the runtime-keyed setter nor
  creates an own property. §10.1.9 OrdinarySet needs a receiver-aware chain walk
  (`__reflect_set_receiver`, this plan's Step 6); `__reflect_set` has no receiver
  parameter, and setting on the prototype instead would be a different wrong
  answer. Probes: `.tmp/es2015/p3/f4-write.js`, `f4-write-has.js`.
- **F4 statically-typed `in`.** `ID('m') in c` where `c` has the class's static
  type still folds `false`; the dynamic-holder form is fixed. Probe:
  `.tmp/es2015/p3/f4-write-has.js` (first assert).
- **F1 class-EXPRESSION shape (`q25`).** `var C = class { [ID('dyn')](){} };
  var D = class extends C {};` still answers 0 — unchanged from base. Same
  pre-existing same-name class-expression identity gap listed below; the
  declaration form is fixed.

### Per step

| Step | Sub-list before → after | Notes |
|---|---|---|
| 3 (D1) | 0/14 → 4/14 | one more than the plan's estimate of 3 |
| 9 K | 0/3 → 3/3 | complete |
| 1.3/1.4 (C) | 0/2 → 2/2 | complete |
| 1 + 1.7 + 2 (A) | 0/48 → 12/48 | see residuals |
| 1.6 | — | `getter-duplicates` + `setter-duplicates` (counted in A and H) |
| 9 H | 0/5 → 3/5 | |
| 9 I | 0/1 → 0/1 | mechanism lands, the row needs more (below) |
| 11 E (cheap half) | 0/8 → 3/8 | the override half is not attempted |

### What landed

- **Step 3 / 9 K** (inherited from the suspension patch, re-validated):
  the #2623 P-7 `typeof` unsound-fold guard now applies in every lane, the
  module-GLOBAL twin of the `isExternObj` admission in
  `finalizeStructAndDynamicMemberGet`, and a computed `['constructor']` key is
  no longer treated as the constructor.
- **Step 1.3/1.4**: `C.prototype.constructor` is installed FIRST (spec own-key
  order) and every standalone class with a class object gets the real `$Object`
  prototype, including a member-less one.
- **Step 1**: a class element whose ComputedPropertyName does not fold is
  registered under a synthetic `__cmdyn$<ordinal>` name
  (`class-dynamic-keys.ts`), its key expression is evaluated once in source
  order at ClassDefinitionEvaluation into a `__cmkey_` global (methods included
  — they used to be dropped entirely, and a top-level class evaluated nothing
  at all), and the install reads that global instead of an interned string.
- **Step 1.7**: `class-proto-lookup.ts` — a finalize-minted
  `__class_proto_lookup` maps a class-instance receiver to its prototype
  `$Object`, with one prepended `__extern_get` arm guarded by
  `__hasOwnProperty` so §7.3.2 own-shadowing holds regardless of arm order;
  plus the element-CALL admission so `new C()[2]()` invokes rather than folding
  to `ref.null.extern`.
- **Step 2**: `class-static-sidecar.ts` — a parallel `$Object` holding the
  static METHODS, reached through the same lookup by reference identity against
  the class-object singleton, plus the `__extern_get_idx` arm that makes a
  NUMERIC computed key (`[ID(2)]`) reachable at all.
- **Step 1.6**: two accessors of the same kind and key are last-definition-wins.
- **Step 9 H**: a top-level `new C().x = v` / `C.staticX = v` now reaches
  `__module_init` (it wrote no named global, so the whole statement was
  dropped), and `compilePropertyAssignment` gained the static-setter arm.
- **Step 9 I**: the class body's own name is an immutable binding.
- **Step 11 E**: the struct-result derived-ctor return arm (`return;` /
  `return undefined` → `this`, `return null` → TypeError).

### Residuals (measured, with the reason)

- **A, 36 rows.** Two causes. (i) The ~20 `cpn-class-*-accessors-*` rows need
  STATIC accessors on the sidecar; installing them as written traps (their
  compiled half takes the class struct as `this`, the sidecar invokes with an
  `$Object` receiver → illegal cast), so they need a per-half trampoline that
  supplies the dummy struct receiver `emitGetterCallWithDummy` already builds.
  That trampoline is the next slice of Step 2. (ii) `method/string.js` needs the
  PropertyAccess twin of the Step-1.7 element-call admission (`new C().d()`
  where `d` is a runtime key still folds to null). `accessor-name-*-computed-in`
  and the `cpn-class-expr-*` rows additionally need the class-EXPRESSION
  identity fix: two anonymous class expressions bound to the same name share one
  identity, so the first one's prototype is unreachable after the second is
  evaluated (reproduced standalone with two `for (C = class {…})` loops).
- **9 I, 1 row.** All five source shapes the rule covers pass (pinned in
  `tests/issue-5195-es2015-class-r2.test.ts`); `name-binding/const.js` declares
  eight same-named classes across eight function scopes and one
  `new (class C {…})` shape still does not throw — the same class-expression
  identity gap as above.
- **9 H, 2 rows.** `setter-duplicates.js` passes in isolation and only
  compile-times-out under load; `setters-prop-desc.js` needs `gOPD` on a
  prototype accessor.
- **11 E, 5 rows.** The override half (`return {}` must REPLACE `this`) needs
  the derived ctor to take the externref-result lane; not attempted.
- **Steps 4, 5, 6, 7, 8, 10, 12 not attempted** (D2 11, D3 5, D4 6, F 10, G 6,
  M 8, N 8, O 3, P 2, Q 13, R 7, T 4). Step 10 M was investigated and declined:
  the plan's fix widens every unannotated defaulted parameter with a scalar
  initializer to `externref`, which changes the slot type for typed code as
  well, and the rows additionally need `C.prototype.method(...)` dispatch.

### Gates

Five ratchet gates green at every commit (`check-loc-budget`,
`check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
`check:dead-exports`); allowances recorded in this file's frontmatter with
dated rationales. `pnpm run typecheck` (TS7) clean;
`pnpm run typecheck:ts5` reports only the pre-existing
`linked-provider-runtime.ts` `WebAssembly.Tag` errors, which this branch does
not touch. `tests/issue-5195-es2015-class-r2.test.ts` **66/66** after the
F1–F5 pass (was 38/38), host and standalone lanes, with a zero-host-import
assertion on every standalone case and one pinned owned-leak row.

`pnpm run test:equivalence:gate` run three times on this branch (after the
Steps-1.6/9/11E commit, after Step 2, and once more on the final F1–F5 tree with
`origin/main` merged): **24 failing / 1718 passing / 24 known-failures in
baseline — no new equivalence regressions**, every time.

Final validation of the F1–F5 pass, on this branch with `origin/main` merged
(`f64beb1a03`, carrying #5224 and the PR #5469 follow-up):

| run | result |
|---|---|
| `class-head.txt` standalone | 28 pass / 169 fail / 12 compile_error |
| `class-head.txt` host | 32 pass / 168 fail / 9 compile_error |
| `class-controls.txt` standalone | 22/22 |
| `class-controls.txt` host | 20/22 — the 2 failures are pre-existing on main |
| `tests/issue-5195-es2015-class-r2.test.ts` | 66/66 |
| five ratchet gates | green |
| `pnpm run typecheck` (TS7) | clean |
| `pnpm run test:equivalence:gate` | no new regressions |

Related vitest files, run in batches: `classes`, `class-methods`,
`class-expression(s)`, `class-method-calls`, `class-elements-619`,
`private-class-members`, `abstract-classes`, `class-static-private-this`,
`nested-class-declarations`, `#5212`, `#5213`, `#802`, `#846`, `#1058`,
`#1364a/b`, `#1824`, `#2029`, `#2101a`, `#2158`, `#3024`, `#3520` ×2, `#4584`,
`#4616`, `#4618` ×2, `#4628`, `#4646`, `#4770`, `#5169`, `#5191`, `#5202`,
`#5237`, `#5239`, `#5242`, `es5-standalone-static-eval-class` — **all pass.**
Two runs exited non-zero on a vitest `onTaskUpdate` RPC timeout with every test
green, and one `#5213` row timed out at 35 s in a 3-file batch and passed when
re-run alone; both are box-load artifacts.

**One pre-existing failure found and confirmed NOT ours**:
`tests/issue-1965-super-ctor-body.test.ts` fails 4 of 13 with `illegal cast` in
`B_init` (js-host lane). Verified by an A/B file swap — the same 4 fail at the
branch point `0f801557a` with this branch's sources removed, and the same 4
(no more) with them restored. Worth its own issue; it is not in this issue's
scope and nothing here touches it.
