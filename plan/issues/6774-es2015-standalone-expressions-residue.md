---
id: 6774
title: "ES2015 standalone expressions residue: new.target as a value, super() in arrows / value / fnctor override, computed symbol & numeric keys, tagged-template freeze/this/new/dynamic tag, eval-in-parameter var scope + rest-element params, destructuring member targets, with-routed calls, method-slot delete, loose-eq @@toPrimitive, instanceof chain for native carriers, dynamic-call tail calls"
status: in-progress
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6772, 6770, 6771, 6773, 3371, 5350, 5153, 5154, 5149, 5270, 4769, 4673, 2765, 1472, 680, 2864, 4238, 5271, 4444]
loc-budget-allow:
  # 2026-09-30 (#6774 plan): 23 mechanisms; every body longer than ~40 lines
  # goes in one of the NEW leaves below, existing over-threshold files grow by
  # hooks / one-arm edits only (S1 +1 arg, S2 +6, S3 +2, S4 hooks +10..+16,
  # S5 +8, S6 +30 split over two files, S8 +12, S9 +10, S10 +14, S11 +10,
  # S12 +12, S13 +10, S14 +14, S15 +8, S16 +6, S17 +16, S18 +14, S19 +18,
  # S21 +12, S22 +16, S23 +12).
  - src/codegen/literals.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/class-bodies.ts
  - src/codegen/closures.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/string-ops.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  # 2026-09-30 (#6774 impl, Opus): S2's own-"__proto__" read arm lives in
  # tryOpenObjectDynamicGet (+10); S4 adds two FunctionContext fields (+4).
  - src/codegen/property-access.ts
  - src/codegen/context/types.ts
  # 2026-09-30 (#6774 impl, Opus): S6 hooks (symbol-arg inference opt-out,
  # open-literal element call, class gOPS → static sidecar), S7 generator
  # rest-pattern vec lowering, S19 explicit "default" hint at loose `==`.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/binary-ops-typed-dispatch.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/param-return-inference.ts
  # 2026-10-01 (#6774 S7 impl, Opus): one import + one wrapped push in the
  # object-literal method pre-registration (rest pattern → rest vec slot).
  - src/codegen/index.ts
  # 2026-10-02 (#6774 queue fix): S13 marks a standalone tagged template as an
  # inherited-[[Set]] dirty trigger in scanForArrayHoles (+3). #6771's merge
  # reset this file's ceiling to its own size, stranding the +3.
  - src/codegen/array-holes.ts
  # NEW leaves (register each in scripts/compiler-boundaries.json, see Lane protocol)
  # 2026-10-02 (#6774 cycle cut, Opus): the five leaves moved into
  # src/codegen/expressions/ (flat-dir budget, #6797) and import their SCC-side
  # helpers through the new late-bound sink registry/expression-helper-delegates.ts;
  # each owning module (late-imports, eval-inline, object-runtime, with-scope,
  # iterator-native) grows by one import + one module-scope registration.
  - src/codegen/expressions/new-target-value.ts
  - src/codegen/expressions/eval-param-scope-hoist.ts
  - src/codegen/dyn-call-tail.ts
  - src/codegen/expressions/with-call-binding.ts
  - src/codegen/expressions/tagged-template-standalone.ts
  - src/codegen/computed-key-members.ts
  - src/codegen/expressions/eval-spread-args.ts
  - src/codegen/registry/expression-helper-delegates.ts
  - src/codegen/expressions/late-imports.ts
  - src/codegen/with-scope.ts
  - src/codegen/iterator-native.ts
  - scripts/compiler-boundaries.json
func-budget-allow:
  # 2026-09-30 (#6774 plan): one-to-six-line call sites inside functions already
  # far over the 300-line threshold; each mechanism lives in a leaf.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/codegen/typeof-delete.ts::compileDeleteExpression
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/expressions/assignment.ts::compileArrayDestructuringAssignment
  - src/codegen/binary-ops.ts::compileBinaryExpression
  # 2026-09-30 (#6774 S4 impl, Opus): one-line `new.target` hooks; the logic
  # lives in the new leaf src/codegen/new-target-value.ts.
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/calls.ts::compileIIFE
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  # 2026-09-30 (#6774 S5/S6/S7/S19 impl, Opus): one-arm hooks at the existing
  # dispatch sites (foreign `super.x` → compileSuperPropertyAccess; symbol-arg
  # inference opt-out; open-literal element call; class gOPS sidecar; generator
  # rest-pattern vec; explicit "default" loose-eq hint + its native literal).
  - src/codegen/property-access.ts::compilePropertyAccess
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  # 2026-10-01 (#6774 S7 impl, Opus): one-line hoistParameterEvalVars hooks
  # before the parameter initializers (body in src/codegen/eval-param-scope-hoist.ts).
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/function-body.ts::compileFunctionBody
  # 2026-09-30 (#6774 S11, Opus): the member-target default split + one call to
  # the new emitMemberTargetDefault helper.
  - src/codegen/expressions/assignment.ts::compileDestructuringAssignment
  # 2026-10-01 (#6774 S18, Opus): a spread EXTRA argument of a folded eval is
  # stepped (emitDiscardedSpreadArgument in the new leaf eval-spread-args.ts).
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  # 2026-10-01 (#6774 S21, Opus): accessor object-literal types lower to
  # externref (they are always open `$Object`s at run time).
  - src/codegen/index.ts::resolveWasmType
---

## Problem

60 rows under `language/expressions/**` and `language/computed-property-names/**`
are non-pass in the ES2015 standalone baseline. Measured on `origin/main`
@ `08e61b26` (2026-09-30) twice — `flock /tmp/claude-0/t262.lock npx tsx
scripts/run-test262-paths.mts .tmp/6774/rows.txt --isolate --standalone`
(`.tmp/6774/base-sweep.log`, ~70 s/row) and the same list in-process
(`.tmp/6774/base-sweep-inproc.log`): **55 fail + 5 compile_error, 0 pass**,
and the two runs' per-row verdicts are byte-identical
(`.tmp/6774/iso-verdicts.txt` vs `inproc-verdicts.txt`). Row list:
`.tmp/6774/rows.txt` (paths relative to `test262/test/`). QuickJS eval
provider built for this tree (`node --import tsx
scripts/build-quickjs-eval-provider.mjs`, adapter key `ffe661541d8dc5a0`).

They are **23 mechanisms**, not 60 defects. Each was isolated with a
standalone probe: module probes `.tmp/6774/p*.js`, `.tmp/6774/q/*.js`
(`gen.mjs`), `.tmp/6774/q3/*.js` (`gen3.mjs`), runner `.tmp/6774/probe.mts`
(compile options mirror `tests/test262-runner.ts:4457-4478`; results in
`probes-base.log`, `probes-split-base.log`, `probes-r3-base.log`), and —
because a module probe is STRICT and its `export` makes sloppy shapes
unmeasurable — test262-format scratch rows `.tmp/6774/rows/*.js` run through
the real runner via relative paths (`../../.tmp/6774/rows/<x>.js` in
`scratch-rows*.txt`). Probe values are bit masks; "main" is the measured
answer, the expected value is every bit set unless stated. Values that flow
through an untyped call argument (`sv(a, b)`) were used wherever a plain
`===` could be folded (the #6770 "===-form lies" lesson — it bit here too:
`p4` said symbol keys work, the row-faithful `d_*` probes trap).

### Row → mechanism map

| step | mechanism | rows |
| --- | --- | --- |
| S1 | a computed ACCESSOR with a runtime key (`get [ID('b')]()`) is compiled without its [[HomeObject]] — `emitDynamicObjectLiteralAccessorHalf` calls `emitObjectLiteralAccessorFn` without `objLocal` (literals.ts:1476-1492) while the folded pair path passes it (:1518/:1528); `super.m()` in it answers null | `computed-property-names/object/accessor/getter-super.js`, `…/accessor/setter-super.js` |
| S2 | a computed key that FOLDS to `"__proto__"` takes the `__extern_set` route (the `__proto__` SETTER — non-object values are dropped, then the typed read yields `0`) instead of a define (`storeMember`, literals.ts:1192-1199, `isAnnexBProtoKey` only exempts the non-computed spelling from the define route, it does not FORCE the define route for the computed one) | `expressions/object/computed-__proto__.js` |
| S3 | `new tag\`x\`` — a TaggedTemplateExpression callee is declined by `tryCompileNativeConstructFromValue` (new-super.ts:4102: `!isIdentifier && !runtimeEvalCallableResult && !dynamicCtorValue → undefined`) and falls to the terminal "is not a constructor" throw | `tagged-template/constructor-invocation.js` |
| S4 | `new.target` is an i32 class-id (new-target.ts), `undefined` in every non-class function (expressions.ts:1629-1646), and only `new.target === C` literally compares (binary-ops.ts:3510-3535) — it is never a VALUE: `nt = new.target; nt === f` is false even for a class | `new.target/value-via-new.js`, `new.target/asi.js`, `new.target/value-via-super-call.js`, `arrow-function/lexical-new.target.js`, `arrow-function/lexical-new.target-closure-returned.js` (+ sibling `new.target/unary-expr.js`, not in this list, same defect) |
| S5 | `eval('super.fromA;')` IS spliced (no `js2wasm:runtime-eval` import in the probe binary) but the foreign `super.x` node compiles to the typed default (`ref.null.extern`): `compileSuperPropertyAccess` (new-super.ts:2141) asks `ctx.checker.getTypeAtLocation` on a checker-less foreign node and the standalone dynamic read declines | `super/prop-expr-obj-val-from-eval.js`, `super/prop-dot-obj-val-from-eval.js`, `super/prop-dot-cls-val-from-eval.js` |
| S6 | object literals / classes with a runtime symbol key (`[ID(sym)]`) or a folded non-string key MIXED with a runtime key: the data/method under the runtime symbol key is unreachable by `o[sym]` (`mix_data_sym_id` 0/15), a literal with `{a(){}, [1](){}, [ID(2)](){}}` traps `illegal cast` at `o.a()` and `{[s1](){}, [ID(s2)](){}}` throws "Cannot access property on null" (`compileObjectLiteralWithAccessors` method arm literals.ts:1420-1470 + the tagged-receiver dispatch call-receiver-method.ts:905-913); static symbol-keyed class methods are not own symbols (`Object.getOwnPropertySymbols(C)` → `[]`) | `computed-property-names/basics/symbol.js`, `…/object/method/symbol.js`, `…/object/method/number.js`, `…/class/method/symbol.js`, `…/class/static/method-symbol-order.js`, `…/object/method/super.js` (the `['a']/[ID('b')]/[0]/[ID(1)]` mix; its `super.m()` half already works: `c1_id_str`/`c1_num_id` = 1) |
| S7 | (ii) a rest-element ARRAY-PATTERN parameter `(...[a])` traps `dereferencing a null pointer` when the rest is non-empty (function) and always in a generator / generator method (`g3a`, `g3c` trap; `g3b` — function, no args — passes); (i) a `var` declared by a constant-string sloppy direct eval inside a PARAMETER INITIALIZER is spliced as a frame local in statement order (eval-inline.ts:1102-1117 admits it; :1173-1180 only sends `__module_init` to the provider), so a closure created in an EARLIER parameter captured the OUTER `x` ("outside") | `generators/scope-param-elem-var-open.js`, `generators/scope-param-rest-elem-var-open.js`, `generators/scope-param-rest-elem-var-close.js`, `object/scope-gen-meth-param-elem-var-open.js`, `object/scope-gen-meth-param-rest-elem-var-open.js`, `object/scope-gen-meth-param-rest-elem-var-close.js` (+ 10 measured siblings under `expressions/function`, `expressions/object/scope-meth-*`, `arrow-function`, `statements/function`, `statements/generators` — `.tmp/6774/siblings-base.log`) |
| S8 | `super()` inside an ARROW in a derived constructor emits NOTHING: the nested-`super()` arm is gated `fctx.isConstructor === true` (calls.ts:8097) and an arrow's fctx is not a constructor — the parent never runs (`b_arrow_iife` count 0) and a later call does not throw | `arrow-function/lexical-supercall-from-immediately-invoked-arrow.js`, `arrow-function/lexical-super-call-from-within-constructor.js` |
| S9 | `super.getThis()` / `super.This` / `super['getThis']()` with `C.prototype` as the receiver (`C.prototype.method()`) pass a null receiver — the instance-typed `this` local is not a `$C` struct there (`c2_call` bit 1, `c2_member`, `c2_elem` = 0; instance receivers pass) | `super/prop-dot-cls-ref-this.js`, `super/prop-expr-cls-ref-this.js` |
| S10 | `delete obj.method` on a closed-struct literal's METHOD slot answers `true` but the property survives (`hasOwnProperty` true, value intact); a function-valued DATA property deletes fine (`j_delete_method` 19, `j_delete_data` 15, `j_delete_method_dyn` 53): the struct arm requires `fields[fieldIdx].mutable` (typeof-delete.ts:642) and a method field is immutable, so the generic `__delete_property` (tombstone on a `$Object` entry that does not exist) runs and reports true | `object/method-definition/name-property-desc.js`, `object/method-definition/generator-property-desc.js` (`verifyProperty` deletes to prove `configurable`) |
| S11 | an object-pattern property whose target is a MEMBER expression WITH an initializer (`{ x: holder.y = 42 } = vals`) never writes the member (`h1_member_init` bit 1, `h1_plain_member_init` 0) while the no-initializer form works (`h1_member_noinit` 1) — `writeResolved(fromDefault)` in the externref object-pattern emitter (assignment.ts:3131-3160) and its typed twin `bindDefaulted` (:3681) | `assignment/dstr/obj-prop-elem-target-obj-literal-prop-ref-init.js`, `…-init-active.js` |
| S12 | a CHAINED destructuring assignment `result = [arguments, eval] = vals` in a sloppy script throws `ReferenceError: arguments is not defined`; the unchained `[arguments, eval] = vals` passes (`h2c` pass, `h2b` fail) — the inner pattern compiled as the RHS of another assignment takes a path that treats `arguments` as the arguments-object read instead of an unresolvable-reference target (script goal: implicit global; `collectSloppyImplicitGlobalNames`, source-scan-predicates.ts:167-190, only sees `name = v`) | `assignment/dstr/array-elem-init-simple-no-strict.js`, `assignment/dstr/array-elem-target-simple-no-strict.js` |
| S13 | the template object (a `$TemplateVec` struct, `Array.isArray` true) and its `raw` are NOT frozen: expando and index writes stick in sloppy code and do not throw in strict (`e2_sloppy_index` 0, `rows/e2.js`); `Object.freeze` on a native array already gives the full semantics (`rows/e2b.js` PASSES: ignore / strict TypeError / `isFrozen`) | `tagged-template/template-object-frozen-non-strict.js`, `…-strict.js` |
| S14 | a tail-position call THROUGH a closure-typed callee (`return h(n-1)` with `var h = g`) is not a tail call — `__dyn_call_1` (calls.ts:4544-4577, results `[externref]`) is `call`ed from a caller whose `fctx.returnType` is void, so `canTailCall`'s `tailCallResultsMatch` (control-flow.ts:104-135) declines and the stack overflows at 10 000 frames (`f_dyn_alias_10k`); the three `eval`-alias shapes additionally need the alias resolved (a spliced `var eval = f`, a global `eval = f`) | `call/tco-non-eval-function.js`, `call/tco-non-eval-function-dynamic.js`, `call/tco-non-eval-global.js` |
| S15 | (I1) a with-routed bare CALL `method()` is `ReferenceError: method is not defined` on BOTH tiers (`i1_with_meth_call`, `i1_with_fn_prop_call`; the bare READ `attribute` works): `compileIdentifier` consults `resolveWithBinding` (identifiers.ts:839-846) but `compileCallExpression` never does; (I2) a literal target with `get [Symbol.unscopables]()` — HasBinding must run the getter (throw) for the shorthand `({ attr })` and for a bare `attr`; neither throws (`i2_with_ident` 0), and an OUTER-var write inside the body (`with (o3) { r3 = attr }`) says `r3 is not defined` (`i2_outer_var`) | `call/with-base-obj.js`, `object/prop-def-id-eval-error.js` |
| S16 | in STRICT code an arrow returned by a value-called function (`fn = function(){ return () => { context = this } }; fn()()`) snapshots `[object Object]` (the sloppy global substitute) instead of `undefined` (`rows/e1b.js`; the plain inner FUNCTION case passes, so this is the arrow's lexical-`this` snapshot, closures.ts:3696-3707 → `compileThisKeyword` → `__current_this` rung, not the tagged-template call) | `tagged-template/call-expression-context-strict.js` |
| S17 | a tag whose closure the compiler cannot type — an IIFE `(function(){ return function(){…} })()\`…\`` — falls to the HOST arm (string-ops.ts:1761-1809: `__tagged_template`, `__js_array_new`, `__js_array_push`) → `standalone target emitted host imports` | `tagged-template/call-expression-argument-list-evaluation.js` |
| S18 | `eval(...iter)` — the direct-eval arm (calls.ts:3712) ignores spread arguments entirely: the iterator is never stepped (`k4b` nextCount 0) and the result is the argv object; `eval()` / `eval(7)` already answer per spec (`k4a` passes) | `call/eval-spread-empty.js` |
| S19 | `"str" == y` (string LEFT, object RIGHT, `y[Symbol.toPrimitive]` returns `"str"`) is false while `y == "str"` is true (`k2_str_left` 12: bits 1,2 missing; the `valueOf` variant passes); `@@toPrimitive` returning a SYMBOL throws "Cannot convert object to primitive value" (`k2_sym_result` 0) instead of comparing by identity | `equals/coerce-symbol-to-prim-return-prim.js` |
| S20 | `[] instanceof F` with `F.prototype = Array.prototype` (or a getter returning it) is false although the getter runs exactly once (`k1_instanceof` 18, `k1_instanceof_fp` 2): `__instanceof_dynamic`'s chain walk is `__isPrototypeOf` over `$Object.$proto` only, and `[]` is a native `$Array` carrier — the hop-by-hop `__getPrototypeOf` walk exists for the TypedArray family only (native-dynamic-instanceof.ts:305-420) | `instanceof/prototype-getter-with-object.js` (#2765 records this row; no live claim) |
| S21 | an element-assignment target whose OBJECT is a call expression: inside an array pattern `[t()[key()]] = [1]` the write is silently dropped (`h3_dstr_call_obj_strkey` log = `t` only), and in a plain assignment `t()[key()] = 1` ToPropertyKey runs but the SETTER is never invoked (`h3_plain_call_obj` log `t,key,ts`); an identifier object works (`h3_order_simple` 1) | `assignment/destructuring/iterator-destructuring-property-reference-target-evaluation-order.js` |
| S22 | `value = super()` yields `undefined` for every parent (`b_cls_value`, `b_super_value_stmt` 0: the nested arm returns `VOID_RESULT`, calls.ts:8103); a FUNCTION parent that returns an object neither becomes the derived `this` nor the `super()` value (`b_fnctor_override` 0; the fnctor arm class-bodies.ts:4478-4503 drops the result and its own comment records exactly these two rows) | `super/call-expr-value.js`, `super/call-bind-this-value.js` |
| S23 (optional) | `Object.setPrototypeOf(C, parseInt)` on a class object is not observable (`Object.getPrototypeOf(C4) === parseInt` false) and `super(…)` never re-reads GetSuperConstructor: no TypeError (`b_proto_not_ctor` 2 — the argument IS evaluated) | `super/call-proto-not-ctor.js` |
| — | **cross-reference, owned by #6772 S1b** (in-progress, `emitSuperCallBindThis` is parent-kind-agnostic): a SECOND `super()` must throw ReferenceError after running the parent — `b_twice` 0 here with a FUNCTION parent; re-measure after #6772 lands before touching anything | `super/call-bind-this-value-twice.js` |
| — | **cross-reference, owned by #3371** (in-progress, "standalone Reflect.construct arbitrary distinct NewTarget"): both rows are its COMPILE_ERROR refusal verbatim | `new.target/value-via-reflect-construct.js`, `super/call-construct-invocation.js` |
| — | **deferred — provider capability** (a non-constant direct eval does NOT write the caller's locals: `rows/k4.js` `r1` is `null`, expected `1`): after S18 these three still need `PerformEval` through the QuickJS provider with reified caller activation cells (#4238 / #5271 family) | `call/eval-spread.js`, `call/eval-spread-empty-leading.js`, `call/eval-spread-empty-trailing.js` |
| — | **deferred — dynamic with-environment capture (#1472)**: a closure created INSIDE `with` capturing a with-bound name (`#1387: … arrow-function capture is not in the with-environment IR slice`, CE), a function created inside `with` whose `eval` alias is added to the scope object LATER (`scope.eval = f`), and a `with` over a `Proxy` environment driving a destructuring assignment (log stops after `binding::sourceKey`) | `arrow-function/arrow/capturing-closure-variables-2.js`, `call/tco-non-eval-with.js`, `assignment/destructuring/keyed-destructuring-property-reference-target-evaluation-order-with-bindings.js` |
| — | **deferred — native generator lowering (#680 / #2864)**: `with` inside a generator body → `Codegen error: native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680)` | `yield/from-with.js` |

2 + 1 + 1 + 5 + 3 + 6 + 6 + 2 + 2 + 2 + 2 + 2 + 2 + 3 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 1 = 50 planned;
1 + 2 cross-referenced; 3 + 3 + 1 = 7 deferred. 50 + 3 + 7 = 60.

### Measurements that pin each mechanism (main @ `08e61b26`, standalone)

| probe | main | expected | what the gap proves |
| --- | --- | --- | --- |
| p1 / `a_fn_value` / `a_cls_direct` / `a_cls_chain_value` / `a_arrow_in_fn` | 2 / 6 / 0 / 0 / 0 | 255 / 7 / 7 / 15 / 3 | `new f()` → `new.target` undefined; `nt = new.target` inside a CLASS ctor never equals the class (only the literal `new.target === K` arm works); arrows see undefined |
| `c1_*` (9 files) | plain / lit-str / id-str / num / num-id / getter-lit = 1; **getter-id 0, setter-id 0, row_mixed TRAP** | 1 each; row 15 | runtime-key ACCESSORS lose the home object; the four-member mixed literal traps `illegal cast` (S6's D2 shape) |
| `c2_call` / `c2_member` / `c2_elem` | 2 / 0 / 0 | 3 / 1 / 1 | receiver `C.prototype` → null `this`; instance receiver fine |
| `c3_obj_eval_dot` / `c3_obj_eval_elem` / `c3_cls_eval` vs `c3_*_plain` | 0 / 0 / 0 vs 1 / 1 / 1 | 1 | only the eval'd spelling fails; no `runtime-eval` import ⇒ the splice ran |
| `d_basics_sym` / `d_obj_meth_sym` / `d_obj_meth_num` / `d_cls_meth_sym` / `d_cls_static_sym` / `mix_data_sym_id` / `mix_plain_num_id` / `mix_sym_id` / `mix_cls_id_only` / `mix_static_sym` | 7 / TRAP / TRAP / TRAP / 5 / 0 / TRAP / TRAP / 1 / 6 | 63 / 63 / 31 / 127 / 7 / 15 / 7 / 3 / 5 / 7 | runtime symbol keys unreachable; folded-non-string + runtime key ⇒ trap; static symbol methods not own symbols. Controls that PASS: `mix_str_id` 3, `mix_num_id` 3, `mix_plain_id_num` 5, `d_obj_meth_sym3` 7, `mix_cls_sym_only` 27 |
| `b_arrow_iife` / `b_arrow_later` / `b_cls_value` / `b_fnctor_override` / `b_twice` / `b_proto_not_ctor` | 0 / 0 / 0 / 0 / 0 / 2 | 1 / 3 / 1 / 3 / 1 / 7 | S8, S22, #6772-S1b, S23 |
| `rows/e1.js`, `rows/e1b.js` (onlyStrict, runner) | fail at "arrow tag" / fail at "plain call" | pass | the plain-function tag from a call expression PASSES; the ARROW's lexical `this` is `[object Object]` even for `fn()()` |
| `e2_sloppy_index` / `rows/e2.js` / `rows/e2b.js` | 0 / fail L9 / **pass** | 15 / pass / pass | template + raw not frozen; the freeze machinery for native arrays is complete |
| `e3_iife_tag`, `e3_iife_tag_subs` | host imports `__tagged_template`, `__js_array_new`(, `__js_array_push`) | 3 | S17 |
| `e4_new_tag`, `e4_new_tag_ident` | THROW "is not a constructor" | 15 / 7 | S3 |
| `f_direct` / `f_dyn_alias` / `f_dyn_alias_10k` / `f_dyn_eval_alias` | 1 / OVERFLOW / OVERFLOW / OVERFLOW | 1 | self tail call fine; closure-typed callee never a tail call |
| `rows/g2.js`, `g3a` / `g3b` / `g3c` | TRAP at `f1()` ; TRAP / pass / TRAP | pass | `(...[a])` traps for a non-empty rest (function) and always in generators; the eval-var half is masked behind it |
| `h1_member_init` / `h1_member_noinit` / `h1_plain_member_init` / `h1_arr_member_init` | 2 / 1 / 0 / 1 | 3 / 1 / 1 / 3 | initializer + member target never writes |
| `rows/h2.js` / `rows/h2c.js` / `rows/h2b.js` (noStrict, runner) | pass / pass / **fail** "arguments is not defined" | pass | only the CHAINED form fails |
| `h3_order_simple` / `h3_order_call_obj` / `h3_plain_call_obj` / `h3_dstr_call_obj_strkey` / `h3_row_target_reassign` / `h3_order_row` | 1 / 101 / 103 / 101 / 101 / 108 | 1 | call-expression object ⇒ dropped write / setter skipped (`100 + log.length` encodes the log) |
| `i1_with_base_obj` / `i1_with_meth_call` / `i1_with_fn_prop_call` / `i1_with_getter` / `i2_with_ident` / `i2_outer_var` / `rows/i1.js` | THROW / THROW / THROW / 1 / 0 / THROW `r3 is not defined` / fail L8 | 3 / 1 / 3 / 1 / 1 / 7 / pass | S15 |
| `j_delete_method` / `j_delete_data` / `j_delete_method_dyn` | 19 / 15 / 53 | 63 / 15 / 63 | method slots survive `delete` / `Reflect.deleteProperty`; data and expando slots delete |
| `k1_instanceof` / `k1_instanceof_fp` | 18 / 2 | 127 / 3 | getter runs once; every `[] instanceof <F with Array/Object.prototype>` is false |
| `k2_num` / `k2_str` / `k2_str_left` / `k2_sym_result` / `k2_valueof_str` | 3 / 5 / 12 / 0 / 3 | 3 / 7 / 15 / 3 / 3 | S19 |
| `k3_split` / `rows/k3.js` | 46 / fail "value (undefined) «0»" | 63 / pass | `o.__proto__` dot read of the computed own key answers `0` for `undefined`, wrong for a symbol |
| `rows/k4.js` / `k4a` / `k4b` | fail `r1` null / pass / fail nextCount 0 | pass | S18 vs the deferred provider capability |

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order: S1 → S2 → S3 (cheap, independent) → S4 … S21 in any order
(independent unless noted) → S22 after #6772 S2 lands → S23 optional last.
Everything new is gated on `ctx.standalone` unless a step says otherwise; the
host lane stays byte-identical (verify with a `compile()` sha256 A/B of the
step's probes for `target: undefined`). Type queries go through `ctx.oracle`,
never `ctx.checker` (the oracle-ratchet gate). Every step: probe on base
FIRST (`.tmp/6774/base-src` = `git archive origin/main src`), then on the
branch, then its rows. **Module probes are strict**: measure every sloppy
shape through `rows/*.js` and the runner, never through `probe.mts`.

### Step 0 — base copies and the before-state

`mkdir -p .tmp/6774/base-src && git archive origin/main src | tar -x -C .tmp/6774/base-src`;
re-run `.tmp/6774/rows.txt` and every probe (`node .tmp/6774/gen.mjs && node
.tmp/6774/gen3.mjs && npx tsx .tmp/6774/probe.mts .tmp/6774/q/*.js
.tmp/6774/q3/*.js`; `npx tsx scripts/run-test262-paths.mts
.tmp/6774/scratch-rows.txt --standalone`, same for `scratch-rows2..4.txt`)
on the unmodified tree and keep the logs next to the ones cited above. The
QuickJS provider must be built for your src tree (`node --import tsx
scripts/build-quickjs-eval-provider.mjs`; seed with
`JS2WASM_QUICKJS_ARTIFACT_DIR=<a sibling worktree's .test262-cache/quickjs-artifact-*>`
to skip the ~40 s artifact build) — the `from-eval`, `tco-*`, `eval-spread*`
and `scope-*` rows need it.

### S1 — a runtime-keyed accessor carries the literal as its [[HomeObject]]

(a) Rows: `computed-property-names/object/accessor/getter-super.js`,
`…/accessor/setter-super.js`.

(b) `src/codegen/literals.ts::compileObjectLiteralWithAccessors`, the
`propName === undefined` arm at `:1476-1492`.

(c) Pass `objLocal` as the 5th argument of `emitObjectLiteralAccessorFn`
inside the `(half, isGetter) =>` callback — exactly what the paired path does
at `:1518` / `:1528` (the parameter is documented at `:1563-1567` as the
[[HomeObject]] capture; `closures.ts:3714-3724` turns it into the
`SUPER_HOME_OBJECT_CAPTURE_NAME` capture the `super` read consumes at
new-super.ts:1961). Both getter and setter halves.

(d) Order: none changed (the key is still evaluated before the half is
built). ES5 risk: none — ES5 has no computed keys; the paired path is
untouched. Pins: `tests/issue-5350-super-property-r1.test.ts`,
`issue-5318-r5*` (dynamic accessor keys), `issue-4688*` (object-literal
super).

(e) Acceptance: `c1_getter_id` = 1, `c1_setter_id` = 1; both rows pass;
`c1_getter_lit` stays 1.

### S2 — a computed key that folds to `"__proto__"` is an ordinary own data property

(a) Rows: `expressions/object/computed-__proto__.js`.

(b) `src/codegen/literals.ts` `storeMember` (`:1192-1199`) and the fold at
`:1350-1352` (`propName = resolveComputedKeyExpression(...)`).

(c) §B.3.1 is SYNTACTIC: `['__proto__']: v` defines. Today the folded name
"__proto__" is stored through `__extern_set(obj, "__proto__", v)` (the define
helper is only selected after the first evaluated-key accessor) — i.e. the
inherited `__proto__` SETTER, which ignores `undefined`/`42`/`""`/`false`/
symbols and links the prototype for objects. Add `isComputedProtoKey(i)`
(PropertyAssignment with a ComputedPropertyName whose fold is
`"__proto__"`) and make `storeMember` take the `__defineProperty_value`
route whenever it is true (mint `dpValueIdx` on demand for this member; it is
already resolved for the accessor case). The dot read `o.__proto__` then
finds the own entry through the ordinary `$Object` lookup — verify the
`«0»` symptom disappears; if the typed read still folds, the read side is
`property-access-dispatch.ts`' `__proto__` arm (the literal is an OPEN object
here, so route the read dynamically when the receiver is
`externrefAccessorVars`-tagged).

(d) ES5 pins: `language/expressions/object/11.1.5-*` (every currently-passing
row), `built-ins/Object/getPrototypeOf/15.2.3.2-*`; ES2015 controls
`language/expressions/object/__proto__-*` and `language/expressions/object/
prop-def-*`. Host lane: byte-identical (gate on `ctx.standalone`).

(e) Acceptance: `k3_split` = 63; `rows/k3.js` passes; the row passes.

### S3 — `new tag\`…\`` constructs the tag call's result

(a) Rows: `tagged-template/constructor-invocation.js`.

(b) `src/codegen/expressions/new-super.ts::tryCompileNativeConstructFromValue`
(`:4080-4130`; the decline at `:4102`).

(c) Admit `ts.isTaggedTemplateExpression(calleeExpr)` (and, since it is the
same value shape, `ts.isCallExpression(calleeExpr)` — measure `new (mk())()`
on base first; if it already works elsewhere, leave it) as a
`dynamicCtorValue`: the callee compiles to an externref function value (the
tag runs exactly once, §13.3.5.1 step 2 before ArgumentListEvaluation — the
tagged call IS the MemberExpression evaluation), then the existing
`__native_construct_<N>` driver constructs it (`:4235-4290`). No arguments
(`new tag\`a\``) → the zero-arity driver.

(d) ES5 pins: `language/expressions/new/S11.2.2_A*` (every currently-passing
row), `built-ins/Function/15.3.*` construct rows. Class pins
`tests/issue-3981*`, `issue-5383*`.

(e) Acceptance: `e4_new_tag` = 15, `e4_new_tag_ident` = 7; the row passes.

### S4 — `new.target` is a first-class VALUE (the constructor object), in functions, arrows and class chains

(a) Rows: `new.target/value-via-new.js`, `new.target/asi.js`,
`new.target/value-via-super-call.js`, `arrow-function/lexical-new.target.js`,
`arrow-function/lexical-new.target-closure-returned.js` (+ sibling
`new.target/unary-expr.js`).

(b) NEW leaf `src/codegen/new-target-value.ts`; hooks in
`src/codegen/expressions.ts` (`:1629-1646`, the MetaProperty arm),
`src/codegen/new-target.ts` (keep the id machinery; add the value global),
`src/codegen/expressions/new-super.ts` user-class `new` site (`:8398-8420`,
next to `emitSetNewTargetBeforeCall`) and the fnctor `new` site (`:2905-2930`
region, before `call __fnctor_<F>_new` / the `compileFnctorNewAsObject`
route), `src/codegen/standalone-class-construct.ts:315`,
`src/codegen/closures.ts` (`:3696-3707`, the arrow lexical-`this` snapshot —
add the twin for `new.target`).

(c) Design — one mutable module global `$__new_target_value: externref`
(null), minted when `ctx.usesNewTarget` and `ctx.standalone`:
- every construct site that sets the class-id also sets the VALUE right
  before the ctor `call` and restores the saved value after it (same
  save/restore discipline as `emitSetNewTargetBeforeCall`, new-target.ts
  :86-100): user classes → the class object via `emitLazyClassObjectGet`
  (`extern.ts:449`, `extern.convert_any` if a ref); fnctors → the function's
  closure value (the same value a bare `f` read yields — reuse the identifier
  lowering for the fnctor symbol); `super()` does NOT touch it (derived-most
  wins — the row's `parentNewTarget === Child`).
- a PLAIN `[[Call]]` of a function that mentions `new.target` must observe
  `undefined`: at entry of every non-constructor function body whose source
  reads `new.target` (pre-scan in `scanForNewTarget`, per function), when the
  function is NOT being constructed — the fnctor `new` site sets the value
  BEFORE the call and the plain-call path does not, so the body reads the
  global as-is; to keep a nested plain call from seeing an OUTER construction's
  value, every plain call of such a function saves/nulls/restores the global
  around the call (only functions in the pre-scan set; cheap and rare).
- `new.target` expression: `fctx.isConstructor || fnctor-body` →
  `global.get $__new_target_value` (externref); arrows → the lexical
  snapshot: an arrow whose body references `new.target` captures the global
  at creation into `__arrow_lexical_new_target` (closures.ts, twin of the
  `this` snapshot at `:3696-3707`) and reads the capture; a class-less
  ordinary function called plainly reads `undefined` by construction above.
- `new.target === C` keeps the i32 fast path (binary-ops.ts:3510-3535) when
  BOTH sides are statically the class-id shape; otherwise (a variable holding
  the value, `typeof new.target`, `sameValue(nt, f)`) the value flows.
  Truthiness `if (new.target)` on the externref works through the ordinary
  ToBoolean.

(d) Order: the value set/restore sits exactly where the id set/restore sits
(after argument evaluation, before the call). ES5 risk: the fnctor `new`
site and plain-call save/null/restore are gated on the per-function pre-scan
(`new.target` is ES2015 syntax) — no ES5 program is affected; pin anyway
`language/expressions/new/S11.2.2_A*`, `language/statements/function/13.2-*`,
`built-ins/Function/prototype/{call,apply}/15.3.4.*` (currently-passing).
Class pins: `tests/issue-2023*` (new.target ids), `issue-2026*`,
`issue-2138*`.

(e) Acceptance: `a_fn_value` = 7, `a_cls_direct` = 7, `a_cls_chain_value` =
15, `a_arrow_in_fn` = 3, `a_asi` = 3; `rows/a1.js` passes; the 5 rows pass;
`new.target/unary-expr.js` flips too (record).

### S5 — a spliced `super.x` resolves against the caller frame's home object

(a) Rows: `super/prop-expr-obj-val-from-eval.js`,
`super/prop-dot-obj-val-from-eval.js`, `super/prop-dot-cls-val-from-eval.js`.

(b) `src/codegen/expressions/new-super.ts::compileSuperPropertyAccess`
(`:2141-2180`) and the element twin reached from
`compileStandaloneObjectLiteralSuperPropertyRead` (`:1987-1995`) /
`objectLiteralSuperRefEmitters(ctx, fctx, anchor)`; `isForeignEvalNode`
(already exported — literals.ts:2245 uses it).

(c) When `isForeignEvalNode(expr)`: skip `ctx.checker.getTypeAtLocation`
(a foreign node has no binding — the answer is the error type, which
`resolveWasmType` turns into the null default you see) and pass
`accessType = "externref"` (the `SuperReadKey` API already accepts it);
resolve the enclosing member from `fctx` (`resolveEnclosingClassName(fctx)`
for classes already is fctx-based; for object literals the `anchor` must be
the eval CALL node — the frame's own node — not the foreign node, because
`objectLiteralSuperRefEmitters` reads `fctx.localMap` for the home-object
capture and `__gen_self`, which are frame facts). Bisect with
`c3_cls_eval` vs `c3_cls_plain` (a one-token difference): dump both WATs and
diff the `super` read. The `super["fromA"]` spelling takes the element twin;
cover both.

(d) ES5 pins: `language/eval-code/direct/**` (every currently-passing row —
the splice path is shared), `language/expressions/call/S11.2.4_A*`. Class
pins: `tests/issue-5350-super-property-r1.test.ts`, `issue-5157*` (eval
SuperProperty admissibility — do not loosen `foldedEvalEarlyError`).

(e) Acceptance: `c3_obj_eval_dot`, `c3_obj_eval_elem`, `c3_cls_eval` = 1; the
3 rows pass.

### S6 — runtime symbol keys, folded-non-string + runtime key mixes, static symbol methods

(a) Rows: `computed-property-names/basics/symbol.js`,
`…/object/method/symbol.js`, `…/object/method/number.js`,
`…/class/method/symbol.js`, `…/class/static/method-symbol-order.js`,
`…/object/method/super.js`.

(b) NEW leaf `src/codegen/computed-key-members.ts` (the shared "how is this
member keyed" classifier + the class static/instance symbol-key registration
helper); `src/codegen/literals.ts::compileObjectLiteralWithAccessors`
(PropertyAssignment arm `:1341-1400`, MethodDeclaration arm `:1420-1470`),
`src/codegen/expressions/call-receiver-method.ts:905-913`
(`receiverIsExternrefTagged`), `src/codegen/class-bodies.ts` member
registration (the `classMemberFuncKey` sites around `:1685/:1800/:3218`) and
`src/codegen/object-runtime-enumeration.ts` (`__getOwnPropertySymbols` for a
class object).

(c) Three sub-defects, bisected on base with the `mix_*` probes:
1. **Runtime symbol key, data or method** (`mix_data_sym_id` 0 for ALL four
   shapes, including `{a:"A", [ID(s2)]:"D"}`): the define uses
   `compileRuntimeComputedPropertyKey` (`:914-950`) whose `keyTag` for a
   symbol-valued expression is not `object` → the key is compiled with
   `expected externref` — and the read `o[s2]` goes through `__extern_get`
   with the symbol boxed differently (i32 handle vs carrier). Establish the
   ONE canonical symbol key representation (`__to_property_key` already
   canonicalises objects; route every symbol-typed / `any`-typed key through
   it on BOTH the define and the `__extern_get`/`__extern_set` dynamic-key
   sites — check `symbol-native.ts::ensureSymbolCarrier`). Verify with
   `Object.getOwnPropertySymbols(o)` identity (`d_basics_sym` bit 32).
2. **Folded non-string key + runtime key in one literal** (`mix_plain_num_id`
   TRAP `illegal cast`, `mix_sym_id` TypeError null): the literal takes the
   open-object path (`_hasRuntimeComputedKey` true) and its receiver is
   tagged (`tagAccessorObjectLiteralReceiver`), yet `o.a()` still reaches a
   typed struct-cast arm. Bisect: `mix_plain_id_num` (`{a(){}, [ID(2)](){}}`)
   PASSES, `mix_plain_num_id` (`{a(){}, [1](){}, [ID(2)](){}}`) traps — the
   folded `[1]` (or `[s1]`, a single-assignment `Symbol()` binding folded by
   `foldedComputedMethodKey`) changes the method-key set the closed-struct
   shape planner records for the literal, so a LATER consumer
   (`call-receiver-method.ts` before `:905`, or `object-shape-widening.ts`)
   believes the binding is a struct. Dump the WAT of both probes, find the
   `ref.cast $<shape>`, and make that consumer honour `externrefAccessorVars`
   (the tag is set at `:1014` BEFORE any member compiles — confirm the
   consumer runs after; if it runs in a pre-pass, tag from the pre-pass).
   `d_obj_meth_num` also needs the own-name ORDER `"1,2,a,c"` — that is the
   open `$Object`'s integer-first ordering (`__obj_index_of_key`), which
   #6770 S3 owns for the index BOUND only; if the order is wrong after (2),
   the fix is the `$Object` key-table enumeration (coordinate, do not
   duplicate).
3. **Static symbol-keyed class methods** (`mix_static_sym` bit 1,
   `d_cls_static_sym` bit 2): `C[s1]()` works, so the method exists; it is
   registered under a synthetic string key and never as a SYMBOL own key of
   the class object. Register runtime-symbol static (and instance:
   `d_cls_meth_sym` bit 64) members in the class object's / prototype's own
   symbol table at ClassDefinitionEvaluation (the `__cmkey_` global + a
   `__define_symbol_member(obj, sym, fn)` native call), and make
   `__getOwnPropertySymbols` for a class object read that table in
   definition order (`[sym1, sym2]`).

(d) Order-preservation: member evaluation order is unchanged (keys still
evaluate in source order before values). ES5 pins: `language/expressions/
object/11.1.5-*`, `built-ins/Object/keys/15.2.3.14-*`,
`built-ins/Object/getOwnPropertyNames/15.2.3.4-*`,
`built-ins/Object/defineProperty/15.2.3.6-4-*` (currently-passing). Class /
symbol pins: `tests/issue-5318-r4-computed-accessor-keys.test.ts`,
`issue-5195*` (Step 1 computed keys), `issue-3368*` (symbol values in open
objects), `issue-1433*`, `issue-6651*` A7.

(e) Acceptance: `mix_data_sym_id` = 15, `mix_plain_num_id` = 7,
`mix_sym_id` = 3, `mix_cls_id_only` = 5, `mix_static_sym` = 7,
`d_basics_sym` = 63, `d_obj_meth_sym` = 63, `d_obj_meth_num` = 31,
`d_cls_meth_sym` = 127, `d_cls_static_sym` = 7, `c1_row_mixed` = 15; the
6 rows pass; controls `mix_str_id`, `mix_num_id`, `mix_plain_id_num`,
`d_obj_meth_sym3`, `mix_cls_sym_only` unchanged.

### S7 — rest-element array-pattern parameters, and eval-declared vars in the parameter scope

(a) Rows: the 6 `scope-*` rows (4 `rest-elem` + 2 `elem-var-open`), plus 10
siblings (bonus, record).

(b) (ii) `src/codegen/function-body.ts` (parameter lowering, `:597` region
compiles initializers; find the rest-parameter arm and its ArrayBindingPattern
handling) and `src/codegen/expressions/destructuring-params.ts`; the native
generator parameter path (`closures.ts` / `async-frame.ts` generator prologue
— #4769 records `scope-gen-meth-param-rest-elem-var-open.js` under "the
parameter closure observes outside", so its frame work is the neighbour).
(i) NEW leaf `src/codegen/eval-param-scope-hoist.ts`; hook in
`function-body.ts` before the first parameter initializer compiles; consumer
`src/codegen/expressions/eval-inline.ts` (`:1102-1117`, the splice's var
handling).

(c) Design.
- (ii) first, no eval involved: `function f(...[a]) {}; f(5)` traps
  (`g3a`), `function* g(...[a=1]){}; g()` traps (`g3c`), `function f(...[a=1]){}; f()`
  passes (`g3b`). So the rest ARRAY is built (or not) inconsistently: with
  arguments present the pattern destructures a null carrier; in generators
  always. Bisect on the three probes' WAT: find the `ref.as_non_null`/
  `array.get` on the rest local; the rest parameter must be materialised as
  a real `$Array` of the extras (the `__extras_argv` protocol — see #6772
  S1a's `emitSetExtrasArgv`) BEFORE the array pattern runs, for every
  function kind, and the generator prologue must do the same in the resume
  frame it destructures in.
- (i) then the eval var: pre-scan each function's PARAMETER INITIALIZERS for
  a direct `eval(<constant string>)` (reuse `resolveConstantString` +
  `foldedEvalDeclarationNames` from eval-inline.ts; only sloppy, only when
  `directEvalParameterOwner` answers this function); hoist every declared
  var name as a frame local (a ref cell when any closure in the parameter
  list or body captures it — `planClosureCaptures` must see it in `localMap`
  before the FIRST parameter initializer compiles) initialised to
  `undefined`; the splice then ASSIGNS the existing local instead of
  declaring a new one (its `var x = "inside"` becomes `x = "inside"` on the
  hoisted slot). ES2015 semantics (the rows' expectation): one parameter-
  scope environment shared by all initializers and visible to the body
  (`probeBody()` → "inside" in the `-close` rows), so the hoisted local is
  simply the function's frame local. The existing
  `foldedEvalParameterCollision` (`:617-629`) still throws for a name that
  collides with a parameter.

(d) ES5 pins: (ii) `language/arguments-object/10.6-*`,
`language/statements/function/13.2-*`, `language/function-code/**`
(currently-passing); (i) `language/eval-code/direct/**` in full — in
particular the 192-file `declare-arguments` matrix eval-inline.ts:1193
names as the splice canary — and `language/statements/variable/12.2.1-*`.
Class/generator pins: `tests/issue-4769*`, `issue-4689*`, `issue-2864*`,
`issue-1832*` (a closure capturing an outer var shadowed by a destructured
param — the exact inverse hazard of (i)).

(e) Acceptance: `g3a`, `g3c` pass; `rows/g2.js` passes (all 6 asserts); the
6 rows pass; the 10 siblings in `.tmp/6774/siblings-base.log` re-measured
(expected: all flip; record any that do not with its first failing
assertion).

### S8 — `super()` inside an arrow in a derived constructor

(a) Rows: `arrow-function/lexical-supercall-from-immediately-invoked-arrow.js`,
`arrow-function/lexical-super-call-from-within-constructor.js`.

(b) `src/codegen/expressions/calls.ts` nested-`super()` arm (`:8090-8104`);
`src/codegen/closures.ts::compileArrowAsClosure` (`:3696-3720`, the
lexical-`this` snapshot + the home-object capture); `src/codegen/class-bodies.ts::compileSuperCall`
(`:4400-4620`, the callee it must reach).

(c) An arrow's `super()` is the ENCLOSING constructor's `super()`
(§13.3.7.1 GetThisEnvironment walks past arrows). Design: when an arrow's
body contains a `SuperKeyword` CALL and the nearest non-arrow function is a
derived constructor, the arrow captures (i) the constructor's `this` struct
local (already: `__arrow_lexical_this`), (ii) the enclosing class name (a
compile-time fact — record it on the arrow's fctx as
`lexicalSuperCallClass`), and (iii) the #6772 S1b `__js2_super_done` flag
as a MUTABLE capture (ref cell) so the arrow can both TEST and SET it. The
nested arm's gate becomes `fctx.isConstructor === true ||
fctx.lexicalSuperCallClass !== undefined`; in the arrow case it calls
`compileSuperCall(ctx, fctx, lexicalSuperCallClass, capturedThisLocal, expr,
[])` — the parent runs on the captured instance (`count` 1 / 2 in the rows)
— then the S1b bind-this step: if the flag was already set → ReferenceError
(the second row: `b.af()` after construction throws AFTER the parent ran,
`count === 2`), else set it. If #6772 S1b has not landed when you get
here, implement the flag capture against `emitSuperInitializedFlagStore`
(new-super.ts:1860) and let S1b generalise it.

(d) Order: the arrow's `super()` evaluates its arguments, runs the parent,
then binds — unchanged from the statement form. ES5 risk: none (arrows +
classes). Pins: `tests/issue-5153*` (nested super, F), `issue-5350-*`,
`issue-4673-*` (arrow lexical this), `issue-2709`.

(e) Acceptance: `b_arrow_iife` = 1, `b_arrow_later` = 3; both rows pass.

### S9 — `super.m()` / `super.x` forward the LIVE receiver when `this` is not an instance struct

(a) Rows: `super/prop-dot-cls-ref-this.js`, `super/prop-expr-cls-ref-this.js`.

(b) `src/codegen/expressions/new-super.ts::compileSuperMethodCallCore`
(`:1287-1345`, the `selfLocal = fctx.localMap.get("this")` receiver push)
and `compileStandaloneSuperPropertyRead`'s `emitReceiver` (`:1966-1985`,
`emitTypedThisSuperReceiver`).

(c) `C.prototype.method()` calls the method with `this = C.prototype` (an
`$Object`), not a `$C` instance; the typed receiver push (`local.get
$this` typed `(ref null $C)`) is null there, so the parent method's `this`
is null (`viaCall` null) and the getter receives null. Design: in a class
method whose `this` may be non-instance — every method reachable through
`C.prototype.m()` / `.call` — push the receiver as the §12.3.5.3
`actualThis`: when the typed local is null, fall back to `__current_this`
(the same fallback `objectLiteralSuperReceiver` uses for literal methods,
`:1985`). Concretely: `local.get $this; ref.is_null; if → global.get
$__current_this else local.get $this; extern.convert_any`, and route the
call through the externref-receiver variant of the parent method (the
`__call_fn_method_N` / closure-apply path the accessor arm already uses,
`:1490-1500` comment). Gate: standalone, class methods only, and only when
the typed local is nullable (a `(ref $C)` local cannot be null — keep the
fast path).

(d) ES5 risk: none. Pins: `tests/issue-5350-super-property-r1.test.ts`
(18), `issue-3522-super-accessor`, `issue-3024-static-super-arity`,
`issue-5153*` B.

(e) Acceptance: `c2_call` = 3, `c2_member` = 1, `c2_elem` = 1; both rows pass.

### S10 — `delete` of a closed-struct literal's METHOD slot

(a) Rows: `object/method-definition/name-property-desc.js`,
`object/method-definition/generator-property-desc.js`.

(b) `src/codegen/typeof-delete.ts::compileDeleteExpression` struct arm
(`:628-720`; the `fields[fieldIdx]!.mutable` gate at `:642`);
`src/codegen/literals.ts::compileObjectLiteralForStruct` (method fields'
`mutable` flag at registration — grep `structFields.set` in that function);
the `hasOwnProperty` / `in` / `Object.keys` struct arms that must observe
the cleared slot (`object-runtime-descriptors.ts`, `__hasOwnProperty`'s
struct-field arm).

(c) A method field is registered immutable, so the struct arm is skipped
and the generic `__delete_property` answers `true` against a `$Object`
entry that does not exist. Design: register method (and generator-method)
fields of a closed literal as MUTABLE nullable closure refs (`ref_null
$closure`; the `struct.new` still pushes the closure), so the existing
`:642-720` arm applies: `__delete_property` sidecar (configurable: yes for
a literal method — `verifyProperty` checks `writable/enumerable/
configurable` all true, which S10 keeps) then `clearField` (`ref.null`).
Then `hasOwnProperty`/`in`/`Object.keys`/`gOPD` on a struct receiver must
treat a null METHOD field as ABSENT (data fields use an `undefined`
sentinel today; methods need the null test) — extend the struct-field
own-ness helpers with `field.kind === "method" && ref.is_null → absent`.
A method call on a deleted slot must throw TypeError "not a function" (the
existing null-callee guard). Alternative if the mutable-field change moves
too many bytes: keep immutability and add a per-object `deletedMethods`
bitmask field (append-only, the #6766 `$Object` field-append precedent).
Coordinate with #6770 S2 (it flips ESCAPING literals to open objects — an
object passed to the harness's `verifyProperty` is NOT in its predicate
list, so these rows stay on the struct path).

(d) ES5 pins: `language/expressions/delete/11.4.1-*` (every currently-
passing row), `built-ins/Object/prototype/hasOwnProperty/15.2.4.5-*`,
`built-ins/Object/keys/15.2.3.14-*`, `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-*`;
`tests/issue-2703*`, `issue-1334*`, `issue-2726*`, `issue-3099*` (method
shorthand as a real own property).

(e) Acceptance: `j_delete_method` = 63, `j_delete_method_dyn` = 63,
`j_delete_data` stays 15; both rows pass.

### S11 — object-pattern member target with an initializer writes the member

(a) Rows: `assignment/dstr/obj-prop-elem-target-obj-literal-prop-ref-init.js`,
`…-init-active.js`.

(b) `src/codegen/expressions/assignment.ts`: `writeResolved(fromDefault)`
in the externref object-pattern emitter (`:3131-3160`) and the typed twin
`bindDefaulted` (`:3681-3745`); `emitAssignToTarget` (`:2936`).

(c) With `fromDefault`, the member-target branch compiles the initializer,
coerces, `local.set resolved`, then `emitAssignToTarget` — the value is
right; but `h1_plain_member_init` (`holder.y` stays undefined) shows the
write never lands, and `h1_member_noinit` works through the same
`emitAssignToTarget`. So the `fromDefault` decision itself is wrong: the
default must apply only when the READ value is `undefined`
(§13.15.5.6 step 3), and the non-default branch must ALSO write the member —
today the `fromDefault === false` branch returns after
`emitAssignToTarget` only for identifiers? Bisect with the three `h1_*`
probes' WAT; expected shape:
```wasm
local.get $tmpVal            ;; the read value
call $__typeof_undefined
if
  <compile initializer> → local.set $resolved
else
  local.get $tmpVal → local.set $resolved
end
<emitAssignToTarget holder.y ← $resolved>   ;; ONE write, after the if
```
The `-init-active` row (`vals = {x: undefined}`) needs the default arm; the
plain row needs the value arm; the getter on the target object must never
run (only [[Set]]).

(d) ES5 pins: `language/expressions/assignment/S11.13.1_A*` (every
currently-passing row), `language/expressions/object/11.1.5-*` (setter
invocation). Pins: `tests/issue-5146*` (destructuring PutValue order),
`issue-2202*`.

(e) Acceptance: `h1_member_init` = 3, `h1_plain_member_init` = 1,
`h1_arr_member_init` = 3; both rows pass.

### S12 — chained destructuring assignment in a sloppy script; `arguments` / `eval` as pattern targets

(a) Rows: `assignment/dstr/array-elem-init-simple-no-strict.js`,
`assignment/dstr/array-elem-target-simple-no-strict.js`.

(b) `src/codegen/expressions/assignment.ts` — the arm that compiles
`result = (<ArrayLiteral> = vals)` (an assignment whose RHS is itself a
destructuring assignment; grep `compileArrayDestructuringAssignment(` /
`compileExternrefArrayDestructuringAssignment(` callers that pass a
"value needed" flag) and `writeResolved`'s identifier branch;
`src/codegen/source-scan-predicates.ts::collectSloppyImplicitGlobalNames`
(`:167-190`).

(c) `rows/h2c.js` (unchained) passes and `rows/h2b.js` (chained) throws
`arguments is not defined` — the CHAINED form routes the inner pattern
through a value-producing path whose identifier write for the name
`arguments` resolves the arguments OBJECT (read) instead of an assignment
target. Design: (1) in that path, an identifier target named `arguments` /
`eval` in SLOPPY code is an ordinary reference: declared → the local
(`var eval` in the rows), else unresolvable → the script-goal implicit
global (`ctx.sloppyImplicitGlobals` + `emitGlobalEnvironmentObject`,
assignment.ts:1048 — the same write the plain `x = 1` form takes); (2)
extend `collectSloppyImplicitGlobalNames` to walk assignment PATTERNS
(array/object, with initializers, nested) so the pre-scan registers
`arguments` before any read compiles — the pre-scan is what makes the later
`assert.sameValue(arguments, 4)` READ resolve globally instead of to the
frame's arguments object. Strict code keeps the SyntaxError/ReferenceError
paths (`array-elem-target-simple-strict.js` passes today and must stay).

(d) ES5 pins: `language/expressions/assignment/S11.13.1_A*`,
`language/arguments-object/10.6-*`, `language/identifier-resolution/**`,
`language/global-code/**` (currently-passing). Pins: `tests/issue-2726*`
(implicit globals), `issue-3956*`, `issue-5146*`.

(e) Acceptance: `rows/h2b.js` passes; `rows/h2.js`, `rows/h2c.js` stay
green; both rows pass.

### S13 — the template object and its `raw` are frozen

(a) Rows: `tagged-template/template-object-frozen-non-strict.js`,
`…-strict.js`.

(b) NEW leaf `src/codegen/tagged-template-standalone.ts` (S13 + S17);
`src/codegen/string-ops.ts::compileTaggedTemplateExpression` cache-miss
body (`:1240-1300`, after the vec + raw are built and before the global
store).

(c) `rows/e2b.js` proves `Object.freeze` on a native array already yields
sloppy-ignore / strict-TypeError / `isFrozen` — so: after building `raw`
and the template vec, call `__object_freeze` on each (standalone; the
native takes externref — `extern.convert_any` the structs) IF the freeze
native honours the `$TemplateVec` carrier. Probe first: if
`Object.isFrozen(t)` stays false after an explicit `Object.freeze(t)` in a
probe, the carrier is not in `__object_freeze`'s ladder — the smaller fix
is then to build the template object as a REAL `$Array` (it already
answers `Array.isArray` true, and the `raw` own property becomes an
expando of that array) so every integrity path applies unchanged. The
strict row needs the write site to know strictness — the ordinary
`__extern_set` strict variant already throws for frozen arrays (`e2b`),
so nothing new there.

(d) ES5 pins: `built-ins/Object/freeze/15.2.3.9-*`,
`built-ins/Object/isFrozen/15.2.3.12-*`, `built-ins/Array/**` (write
paths, currently-passing). Pins: `tests/issue-5154*` (tagged template
cache identity — the frozen object must still be the SAME object per call
site), `issue-5338*`.

(e) Acceptance: `e2_sloppy_index` = 15, `e2_strict` = 31; `rows/e2.js`
passes; both rows pass.

### S14 — tail calls through the dynamic-call ladder; `eval` aliases

(a) Rows: `call/tco-non-eval-function.js`, `call/tco-non-eval-function-dynamic.js`,
`call/tco-non-eval-global.js`.

(b) NEW leaf `src/codegen/dyn-call-tail.ts`; `src/codegen/statements/control-flow.ts`
(`:606-660` promotion, `:104-135` `tailCallResultsMatch`),
`src/codegen/expressions/calls.ts` (`outlinedDynamicCallHelper` `:4537-4577`;
`buildInlineDynamicDispatch` `:5108+`, the `call_ref` at `:5200`; the
direct-eval arm `:3712-3725`), `src/codegen/expressions/eval-inline.ts`
(`containsEvalValueReference` bail, `:1208`), `src/codegen/expressions/assignment.ts`
(global `eval = f` write).

(c) Three parts, in this order:
1. **Tail position through `__dyn_call_N`** (all three rows): a caller
   returning the result of a closure-typed call. The caller `f` is
   `void`-typed (its `return eval(n - 1)` returns `any`, and the frame
   lowers `any` returns to no result) while `__dyn_call_N` returns
   `externref` → `tailCallResultsMatch` declines. Fix: when the return
   expression is a dynamic call and the caller has no result, lower the
   frame WITH an externref result for functions whose body has a
   `return <call>` in tail position with a dynamic callee (the checker
   type is `any`, i.e. externref is the honest lowering) — or, if changing
   the frame signature is too broad, emit `return_call $__dyn_call_N_void`,
   a void twin of the ladder whose LAST instruction is `return_call_ref`
   into the closure (the twin needs the closure's result dropped — not
   expressible as a tail call; so the frame-signature route is the one
   that gives constant stack). Then the ladder's own arm must end in
   `return_call_ref` (calls.ts:5200 `call_ref` → `return_call_ref` when
   the arm is the helper's tail and the helper's result type equals the
   closure's result type; otherwise unchanged) — without this the chain is
   `f → (return_call) dyn → (call_ref) f'` and still grows by one `dyn`
   frame per iteration. Keep the #822 param-count, #839 result and #1972
   try-with-handler guards. Verify with `f_dyn_alias_10k` then
   `f_dyn_alias` (100 000).
2. **`eval("var eval = f;")` then `eval(n - 1)`** (`-function-dynamic`):
   the splice declares `var eval` in the IIFE frame (S7-(i)'s hoisting
   makes it a frame local visible to the nested `f`); the direct-eval arm
   at calls.ts:3712 must FIRST ask whether `eval` resolves to a local /
   captured / module binding (including a spliced one) and, if so, compile
   an ordinary dynamic call of that binding — today the arm keys on the
   identifier text alone when no checker binding exists for the spliced
   declaration.
3. **Global `eval = f`** (`-global`): a sloppy script assignment to the
   global `eval` binding (assignment.ts) sets a module global
   `$__eval_rebound: externref` (null); every DIRECT-eval site in the module
   (compile-time set, `scanForDirectEval`-style) emits
   `global.get $__eval_rebound; ref.is_null; if … <today's direct eval>
   else <dynamic call of the rebound value with the evaluated args>`; the
   `else` arm is the S14-1 tail-callable ladder call. Only minted when the
   source assigns `eval` (pre-scan), so ordinary programs are byte-identical.

(d) ES5 pins: `language/expressions/call/S11.2.3_A*`,
`language/statements/return/S12.9_A*`, `built-ins/Function/prototype/{call,apply}/15.3.4.*`,
`language/function-code/**`, `language/eval-code/direct/**` and
`language/eval-code/indirect/**` (currently-passing). Tail-call pins:
`tests/issue-602*`, `issue-822*`, `issue-839*`, `issue-1972*`,
`issue-2707*`, `ir-tail-call*`; `pnpm run check:ir-fallbacks` (no bucket
may grow).

(e) Acceptance: `f_dyn_alias` = 1, `f_dyn_eval_alias` = 1 (both at
100 000); the 3 rows pass; `tco-non-eval-with.js` re-measured and recorded
(still deferred: #1472).

### S15 — with-routed CALLS bind `this`; `@@unscopables` accessor keys are consulted

(a) Rows: `call/with-base-obj.js` (I1), `object/prop-def-id-eval-error.js` (I2).

(b) NEW leaf `src/codegen/with-call-binding.ts`; hook in
`src/codegen/expressions/calls.ts::compileCallExpression` (bare-identifier
callee arms — before the funcMap / closure lookups; mirror where
`compileIdentifier` calls `resolveWithBinding`, identifiers.ts:839-846);
`src/codegen/with-scope.ts` (`proveObjectLiteralWithTarget` `:1005-1035`,
`compileDynamicWithStatement`, the Tier-2 HasBinding native
`with-has-binding-native.ts`); `src/codegen/literals.ts` (well-known symbol
ACCESSOR keys: `get [Symbol.unscopables]()` must define under the real
symbol, not the `"@@unscopables"` string — probe
`Object.getOwnPropertySymbols({ get [Symbol.unscopables]() {} })` first).

(c) I1: for a bare-identifier callee inside a `with` body, consult
`resolveWithBinding(fctx, name)`: `static` → `struct.get` the field (a
closure value) and call it through the closure-apply path with the with
object as receiver (`__current_this` install, the `.call` idiom at
calls.ts:8808-8860); `dynamic` → `__with_has_binding(env, "name")` → if
true `__extern_get(env, "name")` and call with receiver `env`, else the
ordinary outer resolution. Both tiers fail today (`i1_with_meth_call` is
Tier-1 struct-typed; `rows/i1.js` L8 is Tier-2). I2: (1) the with target
literal declares a `@@unscopables` ACCESSOR — `proveObjectLiteralWithTarget`
already rejects accessors (`:1006`), so the target is Tier-2; make sure the
accessor is defined under the REAL well-known symbol on the open object
(literals.ts accessor arm + `getWellKnownSymbolId`), then
`__with_has_binding`'s `Get(env, @@unscopables)` runs the getter and the
throw propagates — for the SHORTHAND `({ attr })` the identifier read inside
the literal must go through `compileIdentifier` (it does not today:
`i2_with_shorthand` never consulted the with scope; route
ShorthandPropertyAssignment name reads through the same `resolveWithBinding`
rung). (2) `i2_outer_var` (`with (o3) { r3 = attr }` → `r3 is not defined`)
is an assignment to an OUTER var inside a Tier-1 struct-typed with body —
`identifier-assignment.ts`' with rung answers "unresolvable" for a name not
in the struct; it must fall through to the ordinary outer write. Fix it in
the same step (the row `with-base-obj.js` assigns `viaCall`/`viaMember`
from INSIDE the with-bound method, not the body, but `prop-def-id-eval-error`
and every real program need it).

(d) ES5 pins: `language/statements/with/S12.10_A*` and `12.10-*` (every
currently-passing row), `language/expressions/call/S11.2.3_A*`,
`language/identifier-resolution/**`. Pins: `tests/issue-1387*`,
`issue-2663*`, `issue-3025*`, `issue-5271*` (D1 native HasBinding).

(e) Acceptance: `i1_with_base_obj` = 3, `i1_with_meth_call` = 1,
`i1_with_fn_prop_call` = 3, `i2_with_ident` = 1, `i2_with_shorthand` = 3,
`i2_outer_var` = 7; `rows/i1.js` passes; both rows pass.

### S16 — an arrow's lexical `this` inside a strict function called as a value is `undefined`

(a) Rows: `tagged-template/call-expression-context-strict.js`.

(b) `src/codegen/closures.ts::compileArrowAsClosure` (`:3696-3707`, the
snapshot compiles `findOwnThisReference(body)` through `compileThisKeyword`);
`src/codegen/expressions/this-keyword.ts::compileThisKeyword` (the
`__current_this` rung and the sloppy-global substitution from
`helpers/sloppy-this-global.ts`).

(c) `rows/e1b.js`: `fn()()` where `fn` is strict (script `"use strict"`)
returns an arrow whose `this` snapshot is `[object Object]` — the sloppy
substitution (undefined → global object) is applied although the OWNING
function (the arrow's nearest non-arrow ancestor, `fn`) is strict. The
plain-function control passes, so the value-call receiver reset
(`emitBareCallReceiverReset`, calls.ts:207-231) is fine; the substitution
consults the strictness of the WRONG node (the arrow's own `this` node /
the arrow) — make it consult `isStrictContext(<owning function>)`, i.e.
walk arrows up to the first non-arrow function (or the script) before
asking. The tagged form then follows (`e1.js` L20).

(d) ES5 pins: `language/expressions/this/S11.1.1_A*`,
`language/function-code/10.4.3-*` (strict/sloppy `this` — every currently-
passing row), `language/statements/function/13.2-*-s`. Pins:
`tests/issue-4673*` (arrow lexical this standalone), `issue-3365*`.

(e) Acceptance: `rows/e1b.js` and `rows/e1.js` pass; the row passes;
`tagged-template/call-expression-context-no-strict.js` stays green.

### S17 — an untyped tag goes through the standalone dynamic-call ladder

(a) Rows: `tagged-template/call-expression-argument-list-evaluation.js`.

(b) `src/codegen/string-ops.ts::compileTaggedTemplateExpression` host arm
(`:1761-1809`) → body in the S13 leaf `tagged-template-standalone.ts`.

(c) When `tagResult` is an externref the compiler cannot map to a closure
type and `ctx.standalone`: instead of `__tagged_template` + `__js_array_*`,
push `[tag, templateObject(extern.convert_any), ...substitutions]` and call
the `(N+1)`-arity outlined dynamic helper (`outlinedDynamicCallHelper` /
`buildInlineDynamicDispatch` — the same ladder a value call `f(a, b)` of an
`any` callee uses; it already publishes `__argc` for `arguments.length`,
which the row asserts as 1 and 6). Receiver: a bare value call
(`emitBareCallReceiverReset`); a member tag keeps its `ttRecvBind`
receiver. Host lane untouched.

(d) ES5 pins: `language/expressions/call/S11.2.3_A*`,
`language/arguments-object/10.6-*` (`arguments.length` through the ladder).
Pins: `tests/issue-5154*`, `issue-5338*` (surplus substitutions are
arguments).

(e) Acceptance: `e3_iife_tag` = 3, `e3_iife_tag_subs` = 3, no `env::`
imports; the row passes.

### S18 — direct `eval(...spread)` performs ArgumentListEvaluation

(a) Rows: `call/eval-spread-empty.js`.

(b) `src/codegen/expressions/calls.ts` direct-eval arm (`:3712-3725`) +
the existing spread-argument materialiser (`emitSetExtrasArgv` /
`compileSpreadArgsToArray` — grep `isSpreadElement` in calls.ts).

(c) When any argument of a direct `eval(...)` is a SpreadElement: evaluate
the full argument list into an argv `$Array` (iterator protocol, every
`next()` observed — the row asserts `nextCount === 1`), then `x = argv.length
> 0 ? argv[0] : undefined` and continue with today's runtime direct-eval
lowering on `x` (non-string → returned as-is, `k4a`; string → the
provider). `eval()`/`eval(7)` already pass, so only the spread arm is new.

(d) ES5 pins: `language/eval-code/direct/**`, `language/expressions/call/
S11.2.4_A*` (currently-passing). Pins: `tests/issue-4238*`, `issue-5271*`.

(e) Acceptance: `k4b` first two asserts pass (`r3` undefined, nextCount 1;
`r4`/`r5` pass too if the provider evaluates a runtime string — record);
the row passes; the three sibling `eval-spread*` rows re-measured and
recorded against the provider gap (`rows/k4.js` `r1`).

### S19 — `==` with a string on the LEFT and an `@@toPrimitive` object on the RIGHT; a Symbol `@@toPrimitive` result

(a) Rows: `equals/coerce-symbol-to-prim-return-prim.js`.

(b) `src/codegen/binary-ops.ts` (`:1700-1712` `rightIsObjectOperand` /
`rightIsAbstractNonString`, and the string-left ladder just below),
`src/codegen/any-eq-helpers.ts::registerAnyLooseEqHelper` (`:150-200`, the
tag-5 numeric arm), the native `__to_primitive` (`object-runtime.ts`,
registered next to `__extern_toString`).

(c) Two arms: (1) `"str" == y` / `s == y` with `y` a plain `{}` that gained
`@@toPrimitive` by expando — `typeFactOf(expr.right).kind === "object"` is
the gate and it holds, so the reduction reaches a ToPrimitive that does NOT
consult `@@toPrimitive` on this operand order (the `valueOf` variant passes:
`k2_valueof_str` 3) — make the string-left reduction call the same
`__to_primitive(hint "default")` the object-left path uses (§7.2.15 step
9 is symmetric with step 8); (2) a `@@toPrimitive` result that is a SYMBOL:
`__any_eq`'s object arm feeds the primitive into ToNumber → throws. Per
§7.2.15 step 8/9 the comparison recurses with the PRIMITIVE: a Symbol vs a
Number is `false` (step 14), Symbol vs Symbol is identity (step 1 →
IsStrictlyEqual). Add the symbol test before the numeric fallback in the
helper (tag/`ref.test $Symbol` → identity compare or false).

(d) ES5 pins: `language/expressions/equals/S11.9.1_A*` and
`does-not-equals/S11.9.2_A*` (every currently-passing row),
`built-ins/Object/prototype/valueOf/**`, `built-ins/Date/prototype/valueOf/**`
(wrapper equality routes — deliberately left on their existing path per the
`:1694-1699` comment). Pins: `tests/issue-1380*` (symbol equality),
`issue-2073*`, `issue-2081*`, `issue-5269*` (@@toPrimitive open path).

(e) Acceptance: `k2_str_left` = 15, `k2_sym_result` = 3, `k2_str` = 7,
`k2_num`/`k2_valueof_str` unchanged; the row passes.

### S20 — `OrdinaryHasInstance` walks the chain of a native carrier

(a) Rows: `instanceof/prototype-getter-with-object.js` (#2765 records it;
the claim ledger shows no live claim — plan it here, cross-reference #2765
in the record).

(b) `src/codegen/native-dynamic-instanceof.ts` (`:305-420` the
TypedArray-family `__getPrototypeOf` hop walk; `:640-700` the main chain
decision).

(c) The generic step-6/7 walk is `__isPrototypeOf` over `$Object.$proto`,
which never enters a native `$Array` (`[]`), `$NativeString` wrapper, or
closure value: `[] instanceof G` with `G.prototype = Array.prototype` is
false even though `Object.getPrototypeOf([]) === Array.prototype` holds.
Generalise the TA-family hop walk (`__getPrototypeOf` per hop, `ref.eq` /
carrier-identity per level, bounded by the chain) to ANY value whose
`ref.test $Object` fails; keep the `$Object` fast path. The getter fires
once already (`k1_instanceof` bit 2) — do not move the `Get(C,"prototype")`.

(d) ES5 pins: `language/expressions/instanceof/S11.8.6_A*` (every
currently-passing row), `built-ins/Object/prototype/isPrototypeOf/**`,
`built-ins/Function/prototype/**` `hasInstance`-adjacent rows. Pins:
`tests/issue-2916*` (Slice B), `issue-2998*`, `issue-3962*`, `issue-2702*`,
`issue-2740*`, `issue-6651*` I3.

(e) Acceptance: `k1_instanceof` = 127, `k1_instanceof_fp` = 3; the row
passes; `instanceof/prototype-getter-with-object-throws.js` and
`…-with-primitive.js` stay green.

### S21 — element-assignment target with a call-expression object

(a) Rows: `assignment/destructuring/iterator-destructuring-property-reference-target-evaluation-order.js`.

(b) `src/codegen/expressions/assignment.ts::emitAssignToTarget` (`:2936-2990`;
the ElementAccess arm compiles `target.expression` at `:2967`) and the
array-pattern element writer that calls it; `receiver-cse.ts` (call-
expression receivers).

(c) Two defects with one root — a call-expression object is compiled as a
"receiver" that the element write then mis-handles: in a pattern the write
is dropped entirely (`h3_dstr_call_obj_strkey`), in a plain assignment the
setter is bypassed (`h3_plain_call_obj`: `t,key,ts`, no `set`). Design:
evaluate `object` (once, into a local) and `key` (once, into a local,
NOT yet ToPropertyKey'd) at reference-evaluation time, BEFORE the
IteratorStep (the row's `target`, `target-key` precede `iterator-step`);
at PutValue, `__to_property_key(key)` then `__extern_set(obj, key, v)` —
the generic dynamic set, which invokes accessors. The `t()[key()] = 1`
plain form must take the same path (the receiver-CSE arm is fine for
member GETS; for a SET with a non-identifier object route to the generic
set). ToPropertyKey exactly once (the row: one `target-key-tostring`, after
`iterator-done`).

(d) ES5 pins: `language/expressions/assignment/S11.13.1_A*`,
`language/expressions/object/11.1.5-*` (setter invocation),
`language/expressions/property-accessors/S11.2.1_A*` (currently-passing).
Pins: `tests/issue-5146*` (cluster D key evaluation), `issue-4564*`.

(e) Acceptance: `h3_order_call_obj` = 1, `h3_plain_call_obj` = 1,
`h3_dstr_call_obj_strkey` = 1, `h3_row_target_reassign` = 1, `h3_order_row`
= 1; the row passes;
`keyed-destructuring-property-reference-target-evaluation-order.js`
(sibling, fails today: `[source, source-key]`) re-measured and recorded.

### S22 — `super()` as an expression yields the bound `this`; a function parent's returned object rebinds it (after #6772 S2)

(a) Rows: `super/call-expr-value.js`, `super/call-bind-this-value.js`.

(b) `src/codegen/expressions/calls.ts` nested arm (`:8097-8104`, returns
`VOID_RESULT`), `src/codegen/class-bodies.ts::compileSuperCall` fnctor arm
(`:4478-4503`, drops the fnctor's result), #6772's leaf
`src/codegen/ctor-return-override.ts` (`$__ctor_override`,
`classReturnOverrideSet`, the externref-typed class representation).

(c) Depends on #6772 S2 having landed (its channel + the externref-backed
class representation for override-capable classes). Then: (1) the nested
`super()` arm returns `{ kind: "externref" }` = the bound `this` (the
instance struct `extern.convert_any`'d, or — override-capable — the
`$__ctor_override` value when non-null); (2) the fnctor arm, when the
parent function is in `ctorMayReturnObject` (extend #6772's pre-scan to
FUNCTION parents: a `return <object-ish>` in the fnctor body), keeps the
call's result: `__typeof_object|function → global.set $__ctor_override`
and, in the DERIVED frame, re-points `this`: the derived class is in
`classReturnOverrideSet` (its binding type is externref), so the ctor's
`this` reads after `super()` go through a `$__ctor_this: externref` local
set right after the call (this is the "derived frame not re-bound" residual
#6772 S2 records — S22 closes it for the fnctor-parent case; do it for the
class-parent case in the same edit if the S2 shape allows).

(d) ES5 pins: `language/expressions/new/S11.2.2_A*`,
`language/statements/function/13.2-*`, `built-ins/Function/**`
(construct-return semantics; `#2018`/`#4464` fnctor return-override must
stay). Class pins: #6772's S2 pins + `tests/issue-5153*` F.

(e) Acceptance: `b_cls_value` = 1, `b_super_value_stmt` = 3,
`b_fnctor_override` = 3, `b_fnctor_value_only` = 1; both rows pass.

### S23 (optional, last) — a class object whose [[Prototype]] was reassigned to a non-constructor makes `super()` throw

Rows: `super/call-proto-not-ctor.js`. `Object.setPrototypeOf(<local class>,
v)` (standalone) stores `v` into a per-class global `$__super_ctor_<C>`
(minted only when the source contains `Object.setPrototypeOf(C, …)` /
`Reflect.setPrototypeOf(C, …)` / `C.__proto__ = …` for a class name — a
pre-scan); `compileSuperCall` for such a class, AFTER ArgumentListEvaluation,
emits `global.get; ref.is_null; if-not → __typeof_function(v) ∧ IsConstructor
approximation (a `$Object` with the callable brand, or a class object) else
throw TypeError "Super constructor is not a constructor"`; when it IS a
constructor, record the residual (constructing through a runtime-selected
parent needs the #6640 dynamic construct driver). `Object.getPrototypeOf(C)`
then answers the global when set (extend #6772 S6's fold). ES5 pins if
attempted: `built-ins/Object/getPrototypeOf/15.2.3.2-*`,
`built-ins/Object/setPrototypeOf/**` currently-passing rows. Do this only
if S1–S21 controls are green with budget left; otherwise record it as its
own issue.

### Rows owned by other lanes (cross-reference, do not re-plan)

| row | lane | mechanism there |
| --- | --- | --- |
| `super/call-bind-this-value-twice.js` | **#6772 S1b** (in-progress, branch `issue-6772-class-residue`) | `emitSuperCallBindThis` — a second `super()` throws ReferenceError after running the parent; its design is parent-kind-agnostic, so the FUNCTION parent here should flip with it. Re-measure after #6772 lands; if it stays red, the `b_twice` probe pins the gap and it becomes an S8-adjacent one-liner (the flag store after the fnctor arm) |
| `new.target/value-via-reflect-construct.js`, `super/call-construct-invocation.js` | **#3371** (in-progress) | "standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget" — the CE text is #3371's deliberate refusal; S4's value global is the substrate #3371's NewTarget operand can set (coordinate: `$__new_target_value` should be the ONE place both write) |

Also touching the same files: **#6770** (Object/Reflect residue) — its S2
flips escaping literals to open `$Object`s and its S3 owns own-key ORDER
(index bound, closed-struct order); S6's order assertion and S10's struct
delete must be re-measured against its branch before merging either.
**#5350** (in-progress, super property r1) — S5/S9 touch
`compileStandaloneSuperPropertyRead`'s callers, not its body. **#4769**
(in-progress on paper, no live claim) records the `scope-gen-meth-*` rows
as residual; S7 supersedes that note — cross-reference in the record.
**#2765** (in-progress on paper, id reserved, no live claim) records the
S20 row.

### Deferred — not fixable in this slice (7 rows), with the reason

| row | reason | where it belongs |
| --- | --- | --- |
| `call/eval-spread.js`, `call/eval-spread-empty-leading.js`, `call/eval-spread-empty-trailing.js` | after S18 the code string reaches the provider, but a NON-CONSTANT direct eval does not write the caller's LOCALS (`rows/k4.js`: `var x = "local"; eval(s /* "x = 1;" */); return x` → `null`, expected `1`); the rows assert exactly that write (`x === 1` / `0` inside the IIFE, outer `x` untouched) | runtime-eval provider: reified caller activation cells for writes (#4238 / #5271 family) — file as its own issue with `rows/k4.js` as the pin |
| `arrow-function/arrow/capturing-closure-variables-2.js` | `with (a) { return () => a; }` — `#1387: … arrow-function capture is not in the with-environment IR slice` (CE); the closed-shape Tier-1 could admit an arrow that captures the with-object LOCAL (a struct ref) and rewrites the with-bound name to a field read inside the arrow — a narrow extension of `selectWithEnvironmentClosures`, but it is the dynamic-environment design #1472 owns | #1472 (ready) — note the Tier-1 arrow-capture extension as a cheap first cut |
| `call/tco-non-eval-with.js` | a FUNCTION created inside `with (scope)` whose free `eval` must resolve through `scope` at CALL time, after `scope.eval = f` was added — a runtime with-environment capture (`i3_with_fnexpr` 0), plus S14-1 | #1472 |
| `assignment/destructuring/keyed-destructuring-property-reference-target-evaluation-order-with-bindings.js` | `with (new Proxy({}, { has() {…} }))` driving a keyed destructuring assignment: every identifier in the pattern must go through the Proxy's `has` trap in §13.15.5.6 order; the Tier-2 path stops after `binding::source, binding::sourceKey` | #1472 (dynamic with) + #6770 S8 (per-operation Proxy traps) |
| `yield/from-with.js` | `with` inside a generator body: `native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680)` | #680 / #2864 (generator carrier) |

Expected after S1–S21: **47 rows flip** (S1 2, S2 1, S3 1, S4 5, S5 3,
S6 6, S7 6, S8 2, S9 2, S10 2, S11 2, S12 2, S13 2, S14 3, S15 2, S16 1,
S17 1, S18 1, S19 1, S20 1, S21 1) plus ~11 siblings outside this list
(S7 ×10, S4 ×1); S22 adds 2 once #6772 S2 is in; S23 1 optional; 3 rows
are other lanes'; 7 stay red by construction of this slice.

### Gate hazards (LOC / func budgets)

- Files already over the 1500-LOC threshold that this plan touches (sizes
  on main, `wc -l`): `calls.ts` 10 926, `new-super.ts` 8 709, `literals.ts`
  6 883, `assignment.ts` 6 587, `closures.ts` 4 887, `class-bodies.ts`
  4 616, `string-ops.ts` 4 400, `binary-ops.ts` 3 535, `identifiers.ts`
  3 371, `typeof-delete.ts` 2 568, `eval-inline.ts` 2 532, `control-flow.ts`
  2 046, `expressions.ts` 1 713, `object-runtime.ts` 11 897. Every one of
  them is in `loc-budget-allow` above; keep each step's growth in these to
  hooks (the per-step numbers in the frontmatter comment) and put bodies in
  the six NEW leaves — a leaf must stay under 1500 (a new giant fails the
  gate outright).
- Files UNDER the threshold that may grow freely: `with-scope.ts` 1 265,
  `native-dynamic-instanceof.ts` 1 169, `function-body.ts` 953,
  `source-scan-predicates.ts` 822, `any-eq-helpers.ts` 587,
  `this-keyword.ts` 218, `new-target.ts` 97, `accessor-object-literal.ts`
  29 — but `with-scope.ts` + S15 and `native-dynamic-instanceof.ts` + S20
  are within ~300 lines of the ceiling: prefer the leaf.
- Functions already over the 300-line threshold (func-budget baseline):
  `compileCallExpression` 1 729, `compileBinaryExpression` 1 452,
  `compileNewExpression` 1 394, `compileObjectLiteralForStruct` 1 086,
  `compileArrowAsClosure` 676, `compileArrayDestructuringAssignment` 534,
  `compileDeleteExpression` 525, `compileTaggedTemplateExpression` 481,
  `compileObjectLiteralWithAccessors` 460 — all granted above; a one-line
  call into a leaf each.
- `check:dead-exports`: every leaf export must have a consumer in the same
  PR; `check:oracle-ratchet`: S5 REMOVES a raw checker query on the foreign
  path (good) — do not add `ctx.checker` reads anywhere else (S6's key-tag
  classification goes through `ctx.oracle.staticJsTypeOf`, which
  `compileRuntimeComputedPropertyKey` already uses).
- `LOC_GATE_BASE=$(git rev-parse origin/main)` for every gate run — the
  grants live in THIS file, which the PR touches, so they are not stranded.

## Acceptance criteria

- The 47 rows named per step pass on standalone, `--isolate`, on the branch
  with `origin/main` merged in; S22's 2 rows pass once #6772 S2 is merged
  into the branch; the 7 deferred rows and the 3 other-lane rows are
  re-measured and listed with their first failing assertion.
- Every probe in `.tmp/6774/` answers its acceptance value on the branch
  (the (e) lines above); the pin file
  `tests/issue-6774-expressions-residue.test.ts` carries each mechanism as a
  "RED on base" case (base verdict recorded) — sloppy shapes as
  `flags: [noStrict]` scratch rows compiled through the runner's options, not
  as modules — plus guards: a literal with only string computed keys (bytes
  identical to base), a class with no `new.target` (bytes identical), a
  `return f(x)` with a statically-known callee (still `return_call`), a
  tagged template with an identifier tag (bytes identical except the freeze
  calls).
- Controls, 0 pass → non-pass (per-path set diff, run once on the merged
  tree under the lock): (1) every currently-passing ES2015 standalone row
  under `language/expressions/**` and `language/computed-property-names/**`
  (rebuild the list from `.test262-cache/test262-standalone-current.jsonl`
  with `scripts/generate-editions.ts::classifyEdition`); (2) **ES5 is a
  completed edition — ZERO regressions**: the union of the per-step ES5 pin
  sets (`language/expressions/{new,call,this,delete,instanceof,equals,
  does-not-equals,assignment,object,property-accessors}/**`,
  `language/statements/{with,function,return,variable}/**`,
  `language/{eval-code,arguments-object,function-code,identifier-resolution,
  global-code}/**`, `built-ins/Function/**`, `built-ins/Object/{keys,
  getOwnPropertyNames,getOwnPropertyDescriptor,getPrototypeOf,freeze,
  isFrozen,defineProperty}/**`, `built-ins/Object/prototype/**`), currently-
  passing rows only, run in full.
- Host lane byte-identical for every module probe (`sha256` of `.binary`,
  `target: undefined`).
- All gates green bare and with `LOC_GATE_BASE=$(git rev-parse origin/main)`;
  growth grants only in this file; `pnpm run check:ir-fallbacks` unchanged
  (S14 touches the return path the IR pass mirrors — if `ir-tail-call.ts`
  needs the same result-type widening, do it in the same step and pin
  `tests/ir-tail-call*.test.ts`).
- Record appended to THIS file (`### 2026-09-30 — #6774 implementation
  (Opus)`): rows before/after, per-step probe table, pins' base verdicts,
  control diffs, gates, residuals with mechanisms; one-paragraph pointers in
  `plan/issues/4769-es2015-generator-c02-non-arguments-residual.md` (S7 supersedes its scope-gen note),
  `plan/issues/2765-instanceof-hard-residuals-proto-getter-and-undeclared-ref.md` (S20), `plan/issues/5153-es2015-standalone-super-wave1.md` (S22 closes its F
  bucket) and `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Lane protocol

- Worktree under `/home/user/js2/.claude/worktrees/` (branch
  `issue-6774-es2015-expressions-residue`, already claimed by
  `ttraenkler/opus-6774`); symlink `node_modules` and `test262` from
  `/home/user/js2` if the hook does not provision them (`rmdir test262 &&
  ln -s /home/user/js2/test262 test262 && ln -s /home/user/js2/node_modules
  node_modules`); never edit `/home/user/js2`.
- Every `run-test262-paths.mts` invocation through
  `flock /tmp/claude-0/t262.lock …` (4 shared cores). The isolated run costs
  ~70 s/row on this box; the in-process run gave identical verdicts for this
  list — use in-process for iteration, `--isolate` for the final table.
  Rebuild the QuickJS adapter after a `src/` change when a row reports
  "provider is not built".
- NEW `src/` files must be registered in `scripts/compiler-boundaries.json`
  (textual insert next to their siblings; entry shape `{ "path": …,
  "state": "unmigrated", "layer": "mixed-needs-split", "destination":
  "backend-wasmgc", "owner": "3518-coordinator", "nextBoundary": … }`), then
  `node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main`.
- Gate chain, bare, exit codes read directly:
  `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs && LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports && node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main && npm run -s typecheck`
  (also `pnpm run check:ir-fallbacks` for S14). `check:dead-exports`
  leaves ~80 MB in `.tmp/core-node-execution-*` — delete it after.
- Vitest pins: `VITEST_FORK_MAX_OLD_SPACE_SIZE=1024` (CI's value) for the
  pin file and the named neighbour suites, ≤3 files per batch. Pushes:
  `NODE_OPTIONS=--max-old-space-size=4096 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 git push -u origin <branch>`.
- Commits: `GIT_AUTHOR_NAME="Thomas Tränkler" GIT_AUTHOR_EMAIL="git@thomas.traenkler.com"`
  (the commit-msg hook blocks a Claude author), committer Claude, subject
  ending in ` ✓` (pre-commit checklist sign-off hook), trailers
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  `Claude-Session: <the implementing session>`, `Model: Claude Opus 5.5 High`;
  one commit per step with its measurement in the body; never
  `--no-verify`; no `git stash` (A/B by file copy from
  `.tmp/6774/base-src`). Push early; do NOT open a PR — the lead verifies
  the pushed head and opens it.

### 2026-10-02 — interim landing record (Opus, partial)

Landed partially at the project lead's request; the issue stays
`in-progress`. Measured on the branch merged with `origin/main` @ `2bfe3edd`
(`scripts/run-test262-paths.mts .tmp/6774/rows.txt --standalone`, in-process):
**40 / 60 pass** (base `08e61b26`: 0 / 60).

- Steps landed: S1–S8, S11–S13, S15–S19, S21 (two sessions worked this lane
  in parallel; duplicate S11/S12/S16 implementations were resolved in favour
  of the first-pushed ones).
- Still failing, in scope: S9 (`super/prop-{dot,expr}-cls-ref-this.js`),
  S10 (`object/method-definition/{name,generator}-property-desc.js`), S14
  (`call/tco-non-eval-{function,function-dynamic,global}.js`), S20
  (`instanceof/prototype-getter-with-object.js`), S22
  (`super/call-expr-value.js`, `super/call-bind-this-value.js`), S23
  (`super/call-proto-not-ctor.js`).
- Other lanes / deferred (unchanged): `super/call-bind-this-value-twice.js`
  (#6772 S1b), `new.target/value-via-reflect-construct.js`,
  `super/call-construct-invocation.js` (#3371), `call/eval-spread.js`,
  `call/eval-spread-empty-leading.js` (provider capability),
  `arrow-function/arrow/capturing-closure-variables-2.js`,
  `call/tco-non-eval-with.js`, `keyed-destructuring-…-with-bindings.js`
  (#1472), `yield/from-with.js` (#680).
- S7 sibling matrix (69 `scope-*param*var*` rows): 18 → 4 non-pass, no new
  failures; residual = IIFE with a rest pattern whose element default is
  skipped.
- Pins: `tests/issue-6774-expressions-residue.test.ts` 21/21.
- Gates: all green bare against `origin/main`.
- Controls: the S7 ES5/ES2015 control (2,225 rows: eval-code/direct,
  arguments-object, function-code, rest-parameters,
  object/method-definition, dstr rest patterns) did not finish before
  landing (container restarts killed two runs); the merge-queue test262
  gates (per-edition ES5 ratchet) are the authoritative check.

#### 2026-10-02 — S7 control and merge-queue park (PR #6414)

- **S7 control (measured):** 2,225 rows (eval-code/direct, arguments-object,
  function-code, rest-parameters, object/method-definition, the dstr
  rest-pattern rows, the `scope-*param*` matrix), in-process standalone, base
  `4bd388bf` vs branch `e454227b`: **0 regressions, 14 gains** (153 → 139
  non-pass; every gain is a `scope-*param*-var-*` row).
- **merge_group park (run 36962286472)**, two causes, both from earlier steps:
  - host trap ratchet — S6's open-literal element-call arm was not gated to
    standalone; `computed-property-names/object/method/number.js` (host:
    already failing) moved `illegal cast` → `null deref`. Gated (`e33714c8`).
  - standalone guard (181 pass→other, net −97) — bisected to S15
    (`4bd388bf`): every well-known-symbol accessor got the symbol-carrier key,
    breaking iterator-protocol lookups (`yield*` not-callable family). Narrowed
    to `@@unscopables` (`dfce7588`); all 208 main-passing rows with a
    well-known-symbol accessor pass locally.

#### 2026-10-02 — wide control F1 (measured, after the S15 narrowing)

- **5,128 rows** = the expressions/statements control set (C2) + the S7
  set + the eval-in-function hoist set, standalone, at `4e090d06` (the
  parallel twin of `dfce7588`, same `@@unscopables`-only predicate). Run
  in-process, then every non-pass row re-run with `--isolate`.
- **181 non-pass, all 181 also non-pass on the merge-base `a8955988`** →
  **0 regressions.** (Before the narrowing, the same set showed 79 extra
  failures — the async-generator `yield*` throw family and annexB
  `for-await-of/iterator-close-return-emulates-undefined-throws-when-called.js`;
  all 79 pass after it.)
- Branch head after merging the parallel fixes and `origin/main`:
  `d7a29bf8`; gates green bare, pins 21/21.

#### 2026-10-02 — import-cycle cut after the #6797 park (Opus)

- **Park cause:** the new required gate `check-import-cycles` (#6797) failed
  on the merged state, `largestSccSize 697 → 702`: the five new leaves
  (`new-target-value`, `eval-param-scope-hoist`, `eval-spread-args`,
  `tagged-template-standalone`, `with-call-binding`) are value-imported by
  SCC modules (`calls.ts`, `closures.ts`, `string-ops.ts`, …) and each
  value-imported an SCC module back (`late-imports` for `emitUndefined`,
  `object-runtime`, `eval-inline`, `iterator-native`, `with-scope`,
  `type-coercion`). The new `check-flat-dir-budget` gate also failed
  (`src/codegen/*.ts 829 → 834`).
- **Cut (no baseline edit, behaviour unchanged):** the leaves no longer
  value-import any SCC module. `coerceType` / `ensureLateImport` /
  `flushLateImportShifts` come from the existing `shared.ts` delegates; the
  other nine helpers come from a new type-only sink,
  `src/codegen/registry/expression-helper-delegates.ts`, which each owning
  module fills at module scope (`registerExpressionHelpers({...})`, the
  `shared.ts` pattern). The sink imports types only, so it cannot join a
  cycle; the owners are SCC members, so they are always loaded before any
  leaf runs. The five leaves moved into `src/codegen/expressions/`.
- **Measured on the tree merged with `origin/main` @ `9c6d0b1e`:**
  `check-import-cycles` OK (largest SCC 697, `codegen->ir` 295 — both equal
  to main); `check-flat-dir-budget` OK (829/829). The 60 expressions rows
  (`--isolate --standalone`): before 40 pass, after 40 pass, identical
  non-pass set (20). Pins 21/21.
