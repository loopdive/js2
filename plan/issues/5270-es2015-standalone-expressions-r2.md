---
id: 5270
title: "ES2015 standalone: expressions — r2 residual pass (89 rows)"
status: in-progress
sprint: current
created: 2026-09-02
updated: 2026-09-02
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5149, 5146, 4444]
# 2026-09-02 (fable-es6 planning pass): every step below adds a spec arm to an
# existing lowering — two relaxed `return_call` guards, a `%Object.prototype%`
# answer for a null-`$proto` ordinary object, a colon-`__proto__` arm, a
# MethodDeclaration `this` boundary, a super-call arm beside the #4688 read, a
# runtime-keyed accessor pair, an `__apply_closure` tail for tagged templates,
# a `@@hasInstance` GetMethod step, a per-element iterator drive for
# ArrayAssignmentPattern, a NamedEvaluation hint for class expressions. Growth,
# not refactor; granted for this change-set only. New mechanisms go in NEW files
# (named per step) and the listed god-files grow by wiring. `total` covers the
# net delta of the whole wave.
loc-budget-allow:
  - total
  - src/codegen/statements/control-flow.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures.ts
  - src/codegen/literals.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/identifier-assignment.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/this-keyword.ts
  - src/codegen/string-ops.ts
  - src/codegen/vec-props.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/native-dynamic-instanceof.ts
  - src/codegen/native-ordinary-instanceof.ts
  - src/codegen/any-eq-helpers.ts
  - src/codegen/coercion-engine.ts
  - src/codegen/binary-ops.ts
  - src/codegen/binary-ops-in.ts
  - src/codegen/iterator-native.ts
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/declarations/redeclared-var-widening.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/closure-prototype-edge.ts
  - src/codegen/closure-props.ts
  - src/codegen/function-poison-pill-access.ts
  - src/codegen/statements.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/statements/control-flow.ts::canTailCall
  - src/codegen/statements/control-flow.ts::canTailCallRef
  - src/codegen/statements/control-flow.ts::compileReturnStatement
  - src/codegen/literals.ts::objectLiteralForcesHostPath
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
  - src/codegen/literals.ts::compileObjectLiteralAsExternref
  - src/codegen/literals.ts::resolveAccessorPropName
  - src/codegen/expressions/new-super.ts::compileSuperMethodCallCore
  - src/codegen/expressions/new-super.ts::compileStandaloneObjectLiteralSuperPropertyRead
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/codegen/expressions/identifiers.ts::emitDynamicInstanceOf
  - src/codegen/native-dynamic-instanceof.ts::ensureNativeDynamicInstanceOf
  - src/codegen/native-ordinary-instanceof.ts::tryEmitNonCallableRhsThrow
  - src/codegen/expressions/assignment.ts::compileExternrefArrayDestructuringAssignment
  - src/codegen/expressions/assignment.ts::emitAssignToTarget
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/any-eq-helpers.ts::registerAnyLooseEqHelper
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/declarations/object-shape-widening.ts::collectRedeclaredObjectIdentityLiterals
  - src/codegen/function-poison-pill-access.ts::tryCompileFunctionPoisonRead
  # 2026-09-02 (Opus implementation, step 2): the reserve-then-fill
  # `__object_proto_singleton` needs one `fillObjectProtoSingleton(ctx)` call in
  # EACH finalize driver, mirroring the `fillClassObjectNameArms` placement that
  # sits two lines above it in both. Wiring only — the mechanism itself lives in
  # `object-runtime-prototype.ts`.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # 2026-09-02 (Opus implementation, steps 3 and 8): the §7.1.1.1 hint-string
  # normalisation is 13 lines inside `symbolToPrimitive`, which is nested in
  # `ensureObjectRuntime`; the cluster-M collector is a sibling function of
  # `collectRedeclaredWithTargetObjects` plus one call line inside
  # `collectGrowableObjectLiterals`.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  # 2026-09-02 (Opus implementation, step 10 cluster N): the arrow-`prototype`
  # route is one predicate call plus its comment inside the static-key fold —
  # it has to sit beside the other route flags it composes with.
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# #5270 — ES2015 standalone: expressions, r2 residual pass

Growth-allowance rationale (2026-09-02, planning pass): see the frontmatter
comment. The genuinely new pieces are asked to live in new modules —
`src/codegen/tagged-template-apply.ts` (step 7, the `__apply_closure` tail),
`src/codegen/instanceof-has-instance.ts` (step 8, the `@@hasInstance` GetMethod
step) and `src/codegen/assignment-pattern-drive.ts` (step 9, the per-element
ArrayAssignmentPattern drive) — so the listed god-files only grow by wiring.

## Problem

After wave 1 (#5149 object literal, #5146 assignment — both `in-review`, their
landed slices are on HEAD) **117 ES2015-bucket rows in the "expressions"
cluster still fail in `--target standalone`**: `language/expressions/{object,
assignment,call,tagged-template,arrow-function,instanceof,function,equals,
conditional,template-literal,addition}/**`. Baseline: `loopdive/js2wasm-baselines`
standalone lane at compiler sha `d39779cb` (2026-09-01, umbrella #4444
"2026-09-01 evening dispatch census"), an ancestor of HEAD `5f13a35bc6`
(itself 10 commits past the session branch tip `a07f65319f`).

The 18-row `rest` singleton list contributed **11 rows** here, per the split
agreed with the #5271 planner: the 3 `{comma,logical-and,logical-or}/tco-*`
rows (so the TCO theme stays whole) and the 8
`computed-property-names/{object/*,basics/symbol}` rows. The other 7 route
elsewhere: `computed-property-names/to-name-side-effects/{class,numbers-class}`
→ #5195, `expressions/typeof/symbol` → #5268, `expressions/new/non-ctor-err-realm`
→ realm lane, `annexB/language/literals/regexp/identity-escape` → #5198,
`annexB/language/{statements/labeled/function-declaration,function-code/function-redeclaration-switch}`
→ #2200 (live claim `ttraenkler/dev-1769`).

**Re-verified on HEAD 2026-09-02** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/expr-list.txt --standalone`
(in-process, 128 rows, one pass at 1-min load 8–17 on a 4-core box shared with
five other agents; log `lists/expr-head-run1.tsv`): **0 pass · 123 fail · 5
compile_error — nothing to drop.** Per-row signatures match the baseline except:
`call/tco-non-eval-function` (baseline `compile_timeout`) now compiles and fails
with the same `RangeError: Maximum call stack size exceeded` as its siblings;
`instanceof/primitive-prototype-with-object` (baseline assertion fail) timed out
compiling — 23 s in the run and 25 s alone at load 12 — a slow compile of a
`Function.prototype`-valued RHS, not a hang (the 6-line probe `p45` alone takes
15 s+); its baseline verdict is the cluster-C signature and it is counted there.

Root causes were re-derived with 78 minimal probes
(`plan/agent-context/es2015-suspend-2026-09-01/probes/probes5270/`, generators
`make-probes{,2,3}.mjs.txt`, results `probes5270*.out.txt`). The probes that
PASS are the falsified hypotheses and narrowed several clusters:
`p01b` (a function-VALUED property called bare has the right `this`; only
METHOD SHORTHAND is wrong), `p02b` (`86 == y` DOES invoke `@@toPrimitive` —
the two `equals` rows fail elsewhere), `p03` (a 4-param tag closure is invoked
with the right substitutions), `p06/p06b/p42/p42b` (numeric/symbol computed
METHOD keys and static reads on the open literal work in isolation),
`p07b/p07d` (`Object.getPrototypeOf({})` via a DECLARATION folds correctly;
computed `['__proto__']` is a plain own property), `p10` (arrow lexical `this`
through `apply` works in sloppy mode), `p14/p48` (a call-expression tag gets
`this` = undefined/global correctly), `p18` (`[arguments, eval] = vals` at
script top level works — the two `-simple-no-strict` rows fail on their exact
shape), `p21` (identity TCO of a void-returning named IIFE works), `p23b`
(numeric-literal accessor keys work), `p41b` (numeric call-computed data keys
work), `p43` (an identifier computed DATA key works — the METHOD twin does not).

39 rows are owned elsewhere (see "Out of scope"); **89 rows are in scope**,
partitioned into the clusters below. Row lists (all `test/`-stripped):
`plan/agent-context/es2015-suspend-2026-09-01/lists/expr-head.txt` (the 89),
`expr-controls.txt` (20 passing neighbours), one `expr-cl-<X>-<slug>.txt` per
cluster (`expr-cl-A-tco.txt` … `expr-cl-O-arrow-lexical-super.txt`,
`expr-cl-X1-…` … `expr-cl-X5-…`), `expr-clusters.tsv` (row → cluster).

## Clusters (HEAD 2026-09-02; counts partition the 128 exactly)

| # | Cluster | Count | Root cause (file:function) | Sample tests (`language/…`) |
|---|---------|------:|----------------------------|--------------|
| A | TCO in return position: `return_call` refused for closures, externref results, and non-direct tails | 11 | `statements/control-flow.ts:80 canTailCall` / `:123 canTailCallRef` refuse (i) any callee or caller whose result is `externref` under `ctx.standalone \|\| ctx.wasi` (L114/L136 — no comment names the reason; the line predates the 2026-08-30 tree import `c882d1b110`, `git log -S` finds nothing older) and (ii) any callee whose param COUNT differs from the caller's (`typeDef.params.length !== fctx.params.length`, #822 WI1) — `return_call` only needs the callee's operands on the stack, the caller's arity is irrelevant. Measured: `p21` (named IIFE, void, direct self-call) passes; `p21d` (same, `return {}` → externref result) overflows; `p51` (`var f = function…; f(n-1)` through the module var, void) overflows; `p21b` (`return 0, f(n-1)`) and `p58`/`p58b` (the same comma / `?:` tails in a plain `function f` declaration) overflow — WAT of `p21b` (`npx tsx src/cli.ts <probe> --target standalone --wat`) shows the closure body ending in exactly the shape `peelToTailCallIdx` (L640) recognises, `call_ref 261; local.set 5; ref.null; global.set $extras; i32.const -1; global.set $argc; local.get 5; return`, while the passing `p21` ends in `return_call_ref 261` with no materialization — the value-returning closure (type result externref) is refused by guard (i), the void one is promoted; `p50` (`var eval = f; return eval(n-1)`) recurses `f → __fn_tramp_f_N → f`: the value-call goes through the per-function trampoline minted at `closures/funcref-as-closure.ts:591` (`__fn_tramp_<name>_<id>`, body `local.get…; call funcIdx` — a plain `call`, never `return_call`), and the trampoline's own frame is never eliminated. All 11 rows are `RangeError` at `$MAX_ITERATIONS = 100000`. | `expressions/comma/tco-final.js`, `call/tco-call-args.js`, `tagged-template/tco-member.js` |
| B | Tagged templates: template object not frozen, non-static tag has no `this` / no surplus args, host bridge leaks, `new tag\`\`` | 8 | `string-ops.ts:1104 compileTaggedTemplateExpression`: the template vec (`{length,data,raw}`, `getOrRegisterTemplateVecType`) is cached per site (L1140-1160) but never frozen — `p19` writes an expando (`__vec_prop_set`, `vec-props.ts:478`, consults no integrity flag) and `p46` reports `Object.isFrozen(t) === false`; the closure arms push the strings vec ONLY when the callee declares a slot (`paramTypes.length > 0`, L1268/L1522 — the #5154-E fix) and drop surplus substitutions (`closureMaxSubs`), so `arguments.length` reads 0/3 instead of 1/4 (`p16`, `p16b`) — the `__argc`/`__extras_argv` channel every closure CALL uses (`calls-closures.ts:1019 emitClosureCallArgcExtras`, `buildArgcExtrasSetupFromLocals`) is never set; a member tag `obj.fn\`\`` is compiled as a VALUE (L1490 `compileExpression(expr.tag)`) and `call_ref`'d with no receiver (`p15`: `this !== obj`) — the `__current_this` install lives only in `__call_fn_method_N` (`closure-exports.ts:1464-1490`) and `__apply_closure` (`object-runtime.ts:7305`); a tag the signature match (L1452) declines falls to the `env::__tagged_template` + `__js_array_new/push` host bridge (L1607-1612) — the CE row and `p47`; `new tag\`x\`` (`p20`) reaches `compileNewExpression` (`new-super.ts:5332`) whose dynamic fallback (`emitDynamicNewFallback` L3290) tries only CLASS candidates → "is not a constructor", although the native `[[Construct]]` driver for a function VALUE exists (`native-construct.ts:143 reserveNativeConstructDriver`, consumers `new-super.ts:3135`, `array-species.ts:138`). `template-literal/evaluation-order` fails only on its exact two-template shape: `p63` (an UNTAGGED `\`a${i++}b${i++}c${i++}d\`` evaluated first, then `i = 0`, then the tagged form) reports `b === 0` — the second `i++` no longer increments — while `p03` (tagged form alone) passes, so the untagged template's substitution lowering (`compileTemplateExpression`, `string-ops.ts`) leaves `i`'s slot/its later reads inconsistent; dump both to WAT before fixing. The second half of `call-expression-context-strict` (`p55`: an ARROW returned by a bare-called strict function expression reads `this` as the global object; the function's own `this` is right, `p14`) is the arrow's lexical-`this` snapshot (`closures.ts:3553`) being compiled in a callee inlined into `__module_init`, where the #4190 `thisBelongsToTopLevelCode` arm (`this-keyword.ts:~85`) answers `globalThis` — the snapshot must take the enclosing FUNCTION's `this`. | `tagged-template/template-object-frozen-strict.js`, `member-expression-context.js`, `constructor-invocation.js` |
| C | `instanceof`: no `@@hasInstance` GetMethod step, static non-callable throw ahead of it, `Function.prototype` RHS | 6 | `expressions/identifiers.ts:2565-2600 emitDynamicInstanceOf` orders `tryEmitNonCallableRhsThrow` (`native-ordinary-instanceof.ts:96`, throws for a provably non-callable OBJECT RHS) BEFORE anything else, so `F = {}` with a `@@hasInstance` method throws "not callable" (`p52`, `symbol-hasinstance-get-err` gets a TypeError where the getter's Test262Error is due); the native helper `native-dynamic-instanceof.ts:~250 ensureNativeDynamicInstanceOf` implements §7.3.20 OrdinaryHasInstance only — §7.3.19 step 2 `GetMethod(target, @@hasInstance)` (then `ToBoolean(Call(instOfHandler, target, «V»))`) has no arm, so `p13` answers `false` without calling the method; a `Function.prototype` RHS (a `$NativeProto` callable) never reads `prototype` through `__extern_get` — the accessor installed by `Object.defineProperty(Function.prototype, "prototype", {get})` is not invoked (`p12b`), a poisoned non-object `prototype` does not throw (`p12`), and the plain `[] instanceof Function.prototype` compile takes 15–25 s (`p45`, the timeout row). The native `%Function.prototype%[@@hasInstance]` body (`function-proto-has-instance.ts:49`) already wraps the helper, so the operator and the method share one substrate. | `instanceof/symbol-hasinstance-invocation.js`, `symbol-hasinstance-to-boolean.js`, `prototype-getter-with-object.js` |
| D | ToPrimitive via `@@toPrimitive` installed after literal creation: hint is `null`, bare statement elided, string `==` object never coerces | 3 | `object-runtime.ts:5264 symbolToPrimitive` (inside `__to_primitive`) DOES `GetMethod(input, @@toPrimitive)` through `__extern_get` (#5102), but passes local 1 — the raw hint — as the method's argument, and `binary-ops.ts:2905` passes `ref.null.extern` for the default hint, so the user method sees `null` where §7.1.1.1 step 2.b mandates `"default"` (`p02`: log `LnullRnull`); `left + right;` / `0 == y;` as an EXPRESSION STATEMENT never runs ToPrimitive (`p61`/`p62` pin it; the test rows count 0 invocations) while `var r = left + right` does — the statement lowering (`statements.ts:514` → `compileExpressionStatement`) drops a value-typed comparison/addition whose operands are object-typed without emitting it; `'str' == y` answers `false` (`p62b`): `any-eq-helpers.ts:52 registerAnyLooseEqHelper` (`__any_eq`, tag dispatch) has the #2081 string⇄number arm but no §7.2.15 step 11/12 arm (object vs primitive ⇒ `ToPrimitive(object)` then retry), and `coercion-engine.ts:722 emitLooseEq` routes every dynamic `==` there. | `addition/coerce-symbol-to-prim-invocation.js`, `equals/coerce-symbol-to-prim-return-prim.js` |
| E | ArrayAssignmentPattern is materialize-first: no lref-first order, no IteratorClose on abrupt, member rest targets dropped | 15 | `expressions/assignment.ts:2524 compileExternrefArrayDestructuringAssignment` still drains via `__array_from_iter_n(src, stepCount)` (L2562-2580) before any target is evaluated — the #5146 Step 2 rewrite was carried forward, not done. Measured: `[ {}[thrower()] ] = iterable` calls `next()` once and `return()` never (`p24`: next=1, return=0; spec: 0 and 1); `[...obj['a'+'b']] = iterable` drops the write (`p24b`; the rest branch at L2519-area accepts identifier targets only); the `*-thrw-close*` rows need IteratorClose on an abrupt target/PutValue completion with `!done` (return()'s own abrupt suppressed on throw completions), the `*-close-skip` rows need NO close after `next()` itself threw, the two `obj-literal-prop-ref-init` rows need the member lref evaluated once with the getter NOT invoked and the setter called with the final value, and `iterator-destructuring-…-evaluation-order` asserts the full `[source, iterator, target, target-key, iterator-step, iterator-done, target-key-tostring, set]` sequence. The per-element model already exists in the binding form (`destructuring-params.ts:1677 destructureParamArray`, `__iterator_next` stepping at `:1966`) and #5267 F2 builds the same drive for for-of heads (`for-of-destructuring.ts:2239`). | `assignment/dstr/array-elem-iter-thrw-close.js`, `array-rest-lref-err.js`, `destructuring/iterator-destructuring-property-reference-target-evaluation-order.js` |
| F | Script-level `arguments`/`eval` as sloppy destructuring targets with a same-named `var eval` | 2 | `p18` (the bare shape) passes; both rows add `var argument, eval;` and then `[arguments, eval] = vals` / `[arguments = 4, eval = 5] = vals`, and the READ `assert.sameValue(arguments, 2)` throws `ReferenceError: arguments is not defined` — the identifier-write funnel (`identifier-assignment.ts:475-490`, the `name === "arguments"` re-slot arm) creates a fresh local for the write, and the later read of the unresolvable script-level `arguments` never finds it (§6.2.5.6 PutValue in sloppy code must create a GLOBAL property, which the plain-assignment lane already does — `#5146` A's `array-elem-put-unresolvable-no-strict` passes). `p56` pins the exact shape — and shows a second symptom: with `var argument, eval;` present the 6-line probe takes 17.6 s to compile (timeout at load 12; `p56b` without the `var eval` declaration compiles instantly and passes), so a script-level `var eval` declaration also drags the compile through something expensive (the direct-eval classification, `calls.ts:3596`, or the runtime-eval tier's activation-state pool) — measure it before assuming the rows are cheap. | `assignment/dstr/array-elem-target-simple-no-strict.js`, `array-elem-init-simple-no-strict.js` |
| G | NamedEvaluation of anonymous class expressions in assignment / literal positions | 5 | `class-bodies.ts:893 collectClassDeclaration`: `esName = decl.name ? decl.name.text : (syntheticName ?? "")` — an ANONYMOUS class expression publishes its synthetic name, so `cls = class {}` answers `name === "__anonClass_cls_0"` through `fillClassObjectNameArms` (`object-runtime.ts:391`, `displayName = functionNameMap.get(className)`) (`p25`); the `nameHint` that `declarations.ts:2500 registerClassExpression` derives (`__anonClass_${nameHint}_N`) is never stored as the display name. Class expressions in a PROPERTY value (`{ id: class {} }`, `p25b`) or a destructuring DEFAULT (`{ cls = class {} } = {}`, `p49`) have no `name` own property at all (`getOwnPropertyDescriptor` → undefined): those positions are not walked by the collector, and neither carries a hint. #5146 cluster E tried the assignment lane and reverted ("a second, unidentified source publishes that value") — the source is L893's `esName`. `fnInstanceNameOf` (`function-instance-meta.ts:256`) already has the parent-walk for every NamedEvaluation position of FUNCTION expressions (#5146 E, #5149 B). | `assignment/fn-name-class.js`, `object/fn-name-class.js`, `assignment/dstr/obj-id-init-fn-name-class.js` |
| H | `super` in object-literal methods and accessors | 9 | Three seams, all confirmed by probes on HEAD. (H1) A literal whose only special member is a `super`-referencing METHOD takes the CLOSED-struct path — `literals.ts:1690 objectLiteralForcesHostPath` has no "member body contains `super`" predicate — so no `[[HomeObject]]` is captured at all and `super.toString` / `super.method(x)` answer `null` (`p08`, `p08b`; the #4688 read lane `new-super.ts:1210 compileStandaloneObjectLiteralSuperPropertyRead` bails at L1232 when `SUPER_HOME_OBJECT_CAPTURE_NAME` is absent). (H2) On the accessor path the capture IS threaded for methods (`literals.ts:1417 emitObjectLiteralMethodFn` → `compileArrowAsClosure(…, homeObjectLocal)`, `closures.ts:3564`), but super method CALLS still fall to `compileSuperMethodCallCore`'s `evalArgsAndDefault` (`new-super.ts:1086`, "super in object literal") — `p54`/`p64` answer `null`; and accessor bodies never get the capture (`emitObjectLiteralAccessorFn`, `literals.ts:1310-1330`, takes no `homeObjectLocal`) — `p08c`. (H3) Even with the capture, `__getPrototypeOf(home)` for a plain literal is `null` (cluster I), so `super.toString` on `Object.prototype` can never resolve until step 2 lands, and `__reflect_get_receiver(%Object.prototype%, "toString", this)` must read the builtin through the `$NativeProto` brand companion (#2175 seeding, `native-proto.ts:~380`). The param-default form (`name-super-prop-param`, `p08d`) is H1+H2 with the capture visible to the default initializer. | `object/method.js`, `object/getter-super-prop.js`, `object/method-definition/name-super-prop-body.js` |
| I | `[[Prototype]]` of ordinary literals and the colon-form `__proto__` | 5 | (Ia) `__new_plain_object` (`object-runtime.ts:1916`) stores `$proto = null`, and `__getPrototypeOf` (`object-runtime-prototype.ts:346`) returns that raw field, so `o = {a: 1}; Object.getPrototypeOf(o)` answers `null` (`p07`) while `var o = {}` answers `Object.prototype` only because `tryCompileEs5GetPrototypeOfValue` (`expressions/object-get-prototype-of.ts:296`) folds a LITERAL argument statically (`p07b`) — one question, two answers. `OBJ_FLAG_NULL_PROTO` (`object-runtime.ts:311`, set by `__object_create(null)` L2085 and by `__object_setPrototypeOf`'s `updateNullPrototypeFlag`, `object-runtime-prototype.ts:283-331`) already distinguishes an explicit null prototype from the implicit terminal. #5149 cluster E stopped exactly here ("blocked on a prerequisite this issue did not own"). (Ib) the colon form `{ __proto__: proto }` is routed to the open path (`objectLiteralForcesHostPath` L1696-1707) and then written with `__extern_set(obj, "__proto__", v)` (`compileObjectLiteralWithAccessors` L1140-1215, no `__proto__` arm) — in standalone that is an OWN data property, so `Object.getPrototypeOf(object) !== proto` and the descriptor is defined (`p07c`); `{ __proto__: null }` must set the flag, `{ __proto__: 1 }` must be ignored, and `__proto__-duplicate-computed` mixes one colon form with two computed forms. | `object/__proto__-value-obj.js`, `object/__proto__-value-non-object.js`, `object/computed-__proto__.js` |
| J | Method-shorthand `this` when the method is extracted and called bare | 4 | `{ method() { thisValue = this } }.method` then `method()` observes `null` (`p01`, `p32` generator twin) while `{ method: function () {…} }.method` observes `undefined`/global correctly (`p01b`). `literals.ts:1417 emitObjectLiteralMethodFn` hands the `MethodDeclaration` node to `compileArrowAsClosure` (`closures.ts:3460`) cast as a FunctionExpression; every `this`-boundary test there is `ts.isFunctionExpression(arrow)` (`closures.ts:3466`, `arrow-phases.ts:455`, `:489`, `:587`, `:731`, `:1282`, `:1333`) — a MethodDeclaration answers false to all of them, so the lifted body is treated like an ARROW: `this` falls through to the enclosing frame's value (module init → `ref.null.extern`), never to the `__current_this` / unbound ladder (`this-keyword.ts:100-175`, #1702 null-guard). #5149 F(a) measured the same asymmetry and left it. | `object/method-definition/name-invoke-fn-strict.js`, `generator-invoke-fn-no-strict.js` |
| K | Methods on closed-struct literals are invisible to the MOP: `delete`, `hasOwnProperty`, `getOwnPropertyNames` | 4 | `var obj = { method() {} }` compiles to a closed struct whose method field is IMMUTABLE, so `typeof-delete.ts:633` (`fields[fieldIdx].mutable` gate) declines and the generic `__delete_property` (L802-898) answers `false` for a non-`$Object` receiver (`p31`: `delete obj.method === false`); `verifyProperty`'s delete→recheck cycle therefore reports "not configurable". The same closed representation drops an identifier-computed METHOD key entirely from the own-key set (`p43b`: `var k = 'propName'; ({ [k]() {} })` → `Object.getOwnPropertyNames` is empty, `hasOwnProperty` false) while the DATA twin works (`p43`) — the two `*-prop-name-yield-id` rows are this shape with `yield` as the identifier. #5149 B(c) named the delete half. | `object/method-definition/name-property-desc.js`, `name-prop-name-yield-id.js` |
| L | Runtime computed keys: symbol reads on index-signature receivers, a numeric+named method mix, runtime-keyed accessors, accessor `name` | 8 | (L1) `{ a:'A', [sym1]:'B', [ID(sym2)]:'D' }` reads `object[sym2]` as undefined (`p05`, `p41`): the write lands through `compileRuntimeComputedPropertyKey` (`literals.ts:884`) but the READ side folds the element access against the checker type (a string index signature when the key expression is `any`-typed — `p41` `var k = ID(sym2); ({[k]:'D'})[sym2]`) and stringifies/misses; a symbol-typed key must stay a `$Symbol` carrier end to end. (L2) `{ a(){}, [1](){}, c(){}, [ID(2)](){} }` traps `illegal cast` at `object.a()` in `__module_init` — `p06`/`p42` (each half alone) pass, so the trap needs the numeric-literal method key AND the named-method call together; narrow with the exact literal before fixing. (L3) runtime-keyed ACCESSORS are dropped: `resolveAccessorPropName` (`literals.ts:2759`) returns undefined for `get [s]()` (symbol binding, `p23`) and `get ['x' in empty]()` (`p22`), and the pre-pass at `compileObjectLiteralWithAccessors` L960 `continue`s ("arbitrary computed key: out of scope") — the getter is never defined (#5149 "needs a runtime-keyed accessor arm"). (L4) `fn-name-accessor-get/set` crash reading `.get`/`.set` of the (never defined) symbol-keyed accessor — L3 first, then stamp `"get [desc]"` / `"set "` names (§10.2.9 prefix; `bound-fn-meta.ts:212` documents the rule, `symbolComputedKeyFunctionName` in `function-instance-meta.ts` already answers `"[desc]"`). | `computed-property-names/basics/symbol.js`, `object/accessor/getter.js`, `expressions/object/fn-name-accessor-get.js` |
| M | `var` redeclared with a differently-shaped object literal aliases the first struct | 2 | `var obj = {a: 1}; var obj = {b: 2}` reads `obj.a === 2` (`p44` — field-index aliasing) and `var obj = Object.defineProperty({}, …); var obj = { method() {} }` calls a null `method` (`p09`, `p09b` control). `declarations/redeclared-var-widening.ts` (#4491 T4) widens only PRIMITIVE-tag clashes, and `object-shape-widening.ts:959 collectRedeclaredObjectIdentityLiterals` admits a redeclared literal only when it READS a widened binding — two object-literal initializers with different shapes are neither. | `object/dstr/meth-dflt-obj-ptrn-empty.js`, `gen-meth-dflt-obj-ptrn-empty.js` |
| N | Arrow functions: `prototype` reported present, `caller`/`arguments` not poisoned, strict lexical `this` on a fnctor instance | 3 | `'prototype' in (() => {})` folds to `true` at compile time: `binary-ops-in.ts:338-345` consults `checker.getApparentType(rightType).getProperty("prototype")` and TypeScript's `Function` interface declares `prototype: any` (`p11`); `arrowFn.caller` must throw (%ThrowTypeError%) but `function-poison-pill-access.ts:52 tryCompileFunctionPoisonRead` poisons only STRICT source functions and bound functions (`p11b`; the class/method twin is #5195 T); `f.af()` where `this.af = _ => this` was assigned inside a fnctor constructor derefs null ONLY in strict mode (`p40` fails, `p10` sloppy passes) — the strict-mode `this.af = …` write inside `F` never lands on the instance. | `arrow-function/prototype-rules.js`, `ArrowFunction_restricted-properties.js`, `lexical-this.js` |
| O | Arrows inside class methods/constructors using `super` | 4 | `(_ => super.increment())()` inside a class method, `_ => super()` inside a derived constructor: `compileArrowAsClosure` captures lexical `this` (`closures.ts:3553`, `genBodyReferencesSuper`) but not the enclosing method's [[HomeObject]]/constructor state — the arrow's `super.x()` reaches `compileSuperMethodCallCore` with `resolveEnclosingClassName(fctx)` unset → `evalArgsAndDefault` (count stays 0/1), and `_ => super()` is silently accepted after `this` is initialised (spec: ReferenceError, §13.3.7.1 → §10.2.1.2 BindThisValue). Depends on #5195 D2 (class-method `super.m()` runtime lane) and D3 (`this`/double-`super()` ReferenceError): the arrow-capture half — threading `SUPER_HOME_OBJECT_CAPTURE_NAME` and the ctor `this`-status through `planClosureCaptures` — is the expression-lane work nobody else owns. | `arrow-function/lexical-super-property.js`, `lexical-supercall-from-immediately-invoked-arrow.js` |

In-scope total: 89. Sum check: A11 + B8 + C6 + D3 + E15 + F2 + G5 + H9 + I5 +
J4 + K4 + L8 + M2 + N3 + O4 = 89; out of scope 39 (below); 89 + 39 = 128.

### Out of scope (owned elsewhere) — 39 rows, listed so nobody re-derives them

| # | Rows | Owner / reason |
|---|------|----------------|
| X1 (2) | `tagged-template/cache-realm.js`, `call/eval-realm-indirect.js` | `$262.createRealm` rows — realm/eval-engine lane (the runner's `$262` shim has no second realm). |
| X2 (9) | `call/eval-spread{,-empty,-empty-leading,-empty-trailing}.js`, `call/tco-non-eval-function-dynamic.js`, `object/scope-meth-body-lex-distinct.js`, `object/scope-gen-meth-body-lex-distinct.js`, `object/scope-gen-meth-param-elem-var-{open,close}.js` | Direct-`eval` semantics on the QuickJS runtime-eval tier — Lane A (#4242 / #2928, the same routing #5271 gives its X4/X5): `eval(...iter)` must drive the spread iterator and then run the first element as a DIRECT eval in the caller's scope (`calls.ts:3596 classifyEvalCallExpression` → the L7534 `emitStandaloneIndirectEvalRuntime(ctx, fctx, expr.arguments)` route sees a `SpreadElement`); `eval("var eval = f;")` rebinds a local; `let x; eval('var x;')` must raise the SyntaxError from inside the eval; `eval('var x = "inside"')` in a method PARAM must bind in the parameter scope. |
| X3 (4) | `call/with-base-obj.js`, `assignment/destructuring/keyed-destructuring-property-reference-target-evaluation-order-with-bindings.js`, `arrow-function/arrow/capturing-closure-variables-2.js` (CE #1387), `object/prop-def-id-eval-error.js` | `with` Object Environment Record — #5271 cluster D (its D1 @@unscopables lookup: `p33` reproduces the `prop-def-id-eval-error` shape and fails on HEAD; its D3 call-position identifiers own `with-base-obj`'s `method()`/`attribute` resolution; its D4 owns the keyed-destructuring-with-bindings log) and #1387 for the `with`-captured arrow CE (#5271 D5 defers the same selector refusal). `call/tco-non-eval-with.js` stays in cluster A but needs #5271 D3 too. |
| X4 (9) | `object/concise-generator.js` (CE `env::__gen_next`), `method-definition/gen-yield-spread-arr-{single,multiple}.js`, `yield-as-yield-operand.js`, `gen-yield-identifier-non-strict.js`, `generator-prototype-prop.js`, `generator-invoke-ctor.js`, `generator-prop-name-yield-expr.js` (CE stack overflow), `name-prop-name-yield-expr.js` | Native generator machinery — #680 / #2864 (codex lane): resumed-value crossing (`[...yield]` → "value is not iterable"), `yield yield 1`, `yield`-as-identifier in a nested sloppy function, per-generator-function `.prototype` (#3236 / #5141 F1), `new gen()` on an EXTRACTED generator method (the #5141 guard at `new-super.ts:5385` resolves declarations and `var g = function*` only), and a `yield` EXPRESSION inside a computed property name (#5141 A(b) admission; the CE row recurses in the literal computed-name path — #5149 Step 6 asked for a recursion guard so it CEs cleanly, never overflows). |
| X5 (15) | `function/params-dflt-ref-arguments.js`, `method-definition/params-dflt-{meth,gen-meth}-ref-arguments.js`; `function/arguments-with-arguments-{fn,lex}.js`; `{function,arrow-function}/dflt-params-arg-val-not-undefined.js`, `method-definition/{meth,gen-meth}-dflt-params-arg-val-not-undefined.js`; `{function,arrow-function}/dstr/ary-ptrn-elem-ary-rest-init.js`, `object/dstr/{meth,gen-meth}-ary-ptrn-elem-ary-rest-init.js`, `object/dstr/gen-meth{,-dflt}-ary-ptrn-elem-ary-empty-init.js` | The EXPRESSION twins of #5271's clusters F2 (arguments vec built after param defaults, `function-body.ts:611-624` — its Step 6.1 explicitly mirrors the fix into `closures.ts:2984` for lifted expressions), F3 (a body binding named `arguments` with parameter expressions, Step 6.2), and G3 (`destructureParamArray` nested `[[...x] = values]` rest branch null-deref, the empty nested pattern default, and the falsy-argument f64 lane widening — Step 7; #5195 M owns the gen-method variant). One mechanism, one implementer: verify these 15 after #5271 Steps 6–7 land (step 11 below); if the closure mirror was skipped there, do it here and say so in the PR. |

Other owned areas confirmed absent from this list: RegExp (#5198), module code
(#4759), `Reflect.construct` NewTarget (#3371), `Reflect.set` receiver
(#2046), class bodies (#5195 — cluster O depends on its D2/D3; cluster G's
class-object `name` VALUE is the expression-lane half of its cluster B
"static surface"), Proxy internals (#5196), for-of/iterators (#5267 — cluster
E shares its F2 drive, see step 9), Array/Object built-ins (#5268 — step 2
composes with its Step 1 `__proto__` accessor pair), other built-ins (#5269 —
its cluster H is the LITERAL-key `[Symbol.toPrimitive]` shape; cluster D here
is the post-hoc write shape, and both meet in `__to_primitive`).

## Implementation Plan

Ordered by yield per unit of risk; every step is independently shippable (one
PR per step or per pair). After each step re-run that step's sub-list AND
`lists/expr-controls.txt` (20 rows, all pass on HEAD — verified 2026-09-02 in
the same session as the 128; 28 candidates were run, 27 green, 20 kept; the
28th, `assignment/dstr/array-elem-iter-thrw-close-skip.js`, is a baseline PASS
(`d39779cb`, compile 4.2 s, exec 43 ms) that fails its STRICT rerun on HEAD —
**re-run alone, same verdict**: `0, [ x ] = iterable` where `next()` throws
and `x` is undeclared must let the `Test262Error` from `next()` escape first,
but HEAD throws the strict-unresolvable `ReferenceError` BEFORE calling
`next()` — the #5146 cluster-C guard (`emitPutValueTargetGuard` /
`emitStrictPutValueThrow`, `identifier-assignment.ts`) fires when the lref is
resolved, not at PutValue. That is a real HEAD regression introduced by the
landed #5146 slice, in exactly the lane step 9 rewrites: fix it there (the
strict-unresolvable throw belongs at PutValue, after the iterator step) and
say so in the PR; it is not drift.)
Probe: `npx tsx scripts/run-test262-paths.mts <list> --standalone`
(in-process; none of the 128 poisons the realm; under load the ~15 s compile
budget times out `$262`-heavy or `Function.prototype`-valued rows, so re-run a
row alone before calling anything a hang). Copy the lists back with
`cp plan/agent-context/es2015-suspend-2026-09-01/lists/expr-* .tmp/es2015/`
and prefix `test/` when the runner needs it; the probes run with
`npx tsx .tmp/es2015/probe-one.mts <probe.js>` (copy `probe-one.mts.txt` back
without the suffix). Type queries go through `ctx.oracle`
(`src/checker/oracle.ts`); raw `ctx.checker` trips the oracle ratchet.

### Step 1 — TCO: relax the two `return_call` guards, promote the trampoline (cluster A; 11 rows; `expr-cl-A-tco.txt`)

1. **Find the reason for the externref refusal before removing it.** L114/L136
   of `statements/control-flow.ts` carry no comment and no issue id; `git log
   -S` on the file finds only the 2026-08-30 tree import. Check
   `plan/issues/822-wasm-type-mismatch-compile-errors.md` and `plan/issues/1972-tail-call-inside-try-skips-catch.md` (the two guards named in
   the comments above the peel) and the standalone equivalence pins for a
   `return_call` + externref failure. If nothing names a reason, relax it:
   `return_call` type-checks exactly like `call` followed by `return`, so the
   only sound requirement is `calleeResults` deep-equal to the caller's result
   list (`valTypesMatch` — externref = externref is a match). Keep the
   ref/ref_null subtyping arm.
2. **Drop the param-COUNT equality** (`typeDef.params.length !==
   fctx.params.length`, both functions): the operand stack at the call site
   already holds exactly the callee's params or the module would not validate;
   the caller's arity is irrelevant to `return_call`. `p21c` (`getF()(n-1)`,
   a closure whose lifted type has `self + n` vs the caller's `self + n` — same
   count, so it is the externref guard) and `p50` (the trampoline, arity differs
   by the self param) are the two acceptance probes for the pair.
3. **Trampolines** (`closures/funcref-as-closure.ts:591`, also the capture
   variant at L484): emit the inner `call funcIdx` as `return_call` — the
   trampoline is a pure forwarder, its frame must not survive the call. This is
   what breaks the `f → __fn_tramp → f` growth in `p50` /
   `tco-non-eval-function` once step 1.1–1.2 let `f`'s own `return eval(n-1)`
   (a `call_ref` to the trampoline's funcref) promote.
4. Then re-run the list: the comma / `?:` / `&&` / `||` rows are already
   peeled by `peelToTailCallIdx` + `rewriteArmTailCalls` (L640-760) and should
   flip with 1.1 alone — the `p21b` WAT proves the peel reaches the
   `call_ref` and only the externref guard refuses it (if any row stays red,
   dump it: the tail must end in `return_call_ref`, not `call_ref; …; return`). `tagged-template/tco-*`
   flip once step 7 lowers `f\`${n-1}\`` through a promotable `call_ref`
   (`__apply_closure` is NOT promotable — a tagged-template tail must keep the
   static closure arm). `tco-non-eval-global` (`eval = f` at script level, then
   `eval(n-1)` in a strict function) needs the module-level `eval` binding to be
   a writable global that the call site reads back (today the identifier `eval`
   is classified statically by `classifyEvalCallExpression`, `calls.ts:3596`,
   and `isGlobalEvalIdentifier` — a script-level `eval = f` assignment must
   shadow the intrinsic for later call sites); `tco-non-eval-with` needs #5271
   D3 as well — count both as stretch.

Edge cases: never promote inside a try-with-handler (`inTryWithHandler`,
#1972) or ahead of a linear-arena reset (`resetBeforeReturn`); a callee whose
result is `i32 boolean` vs the caller's `i32` stays refused (the #4406
ToBoolean note). Expected yield: 9 (11 minus the two stretch rows).

### Step 2 — `[[Prototype]]` of ordinary literals + colon `__proto__` (cluster I; 5 rows; `expr-cl-I-proto-literal.txt`) — prerequisite for step 4

1. **Native answer (Ia)** in `object-runtime-prototype.ts:346 __getPrototypeOf`:
   when the receiver is a `$Object` whose `$proto` is null AND `flags &
   OBJ_FLAG_NULL_PROTO == 0`, return the canonical `%Object.prototype%`
   carrier instead of null. The carrier is the lazily-minted `$NativeProto`
   singleton (`native-proto.ts:~320 buildLazyNativeProtoGetInstrs(ctx,
   BUILTIN_BRAND_TABLE.Object)`, brand at `builtin-brands.ts:49`); its global is
   minted after `ensureObjectRuntime` registers the native, so RESERVE a
   defined helper `__object_proto_singleton() -> externref` with an
   `unreachable`/null body during registration and FILL it at finalize with
   those instrs — the reserve-then-fill discipline of `fillClassObjectNameArms`
   (`object-runtime.ts:391`) and `reserveNativeConstructDriver`. Do the same in
   `__isPrototypeOf` / the chain walk only where a walk ends at a null
   `$proto` (the #4491 T4 `in` operator already assumes "every ordinary object's
   chain ends at %Object.prototype%", `binary-ops-in.ts:437`).
2. **Static fold** (`expressions/object-get-prototype-of.ts:296`
   `ts.isObjectLiteralExpression(arg0)` → `Object`): decline when the literal
   contains a colon-form `__proto__` (let the native answer) — otherwise
   `__proto__-value-null` keeps folding to `Object.prototype`.
3. **Colon form (Ib)** in `compileObjectLiteralWithAccessors`'s
   PropertyAssignment arm (`literals.ts:1140-1215`): for a NON-computed key
   whose text is `__proto__` (the exact predicate at
   `objectLiteralForcesHostPath` L1699-1707 — extract and share it), do NOT
   `__extern_set`; evaluate the value into a local and call
   `__object_setPrototypeOf(obj, v)` (`object-runtime-prototype.ts:591`,
   lenient, sets/clears `OBJ_FLAG_NULL_PROTO` via `updateNullPrototypeFlag`)
   iff `v` is an Object (`__typeof_object` ∨ `__typeof_function`) or null;
   otherwise drop it silently (§B.3.1 / PropertyDefinitionEvaluation step 2.a:
   no own property, no error — `__proto__-value-non-object` checks undefined /
   number / boolean / string / symbol one by one). Computed `['__proto__']`
   stays an ordinary `__extern_set` (`p07d` passes today; `__proto__-duplicate-computed`
   mixes one colon form with two computed forms and expects the LAST computed
   value as the own property and the colon value as [[Prototype]]).
4. Also seed [[Prototype]] = `%Object.prototype%` semantics for the any-context
   literal carrier (`compileObjectLiteralAsExternref`, L473) — with 2.1 the
   answer is implicit (null `$proto`, flag clear), so no per-literal write is
   needed; verify `p07`, `p07c`, then the list.

Interplay: #5268 Step 1 adds the `Object.prototype.__proto__` ACCESSOR pair
and #5268 Step 1.3 the immutable-prototype refusal; neither touches the literal
form. The `$NativeProto` for `Object` is a `$NativeProto`, not an `$Object`, so
a chain walk must treat it as terminal (`$parent` null) exactly as the
`OBJECT_ROOTED_PROTOTYPE_CTORS` note in `object-get-prototype-of.ts` says.
Expected yield: 5.

### Step 3 — Object-literal representation: method `this`, MOP visibility, var-redeclaration (clusters J + K + M; 10 rows; `expr-cl-J-*.txt` + `-K-*` + `-M-*`)

1. **J — `this` boundary for MethodDeclaration bodies.** Introduce ONE
   predicate `isOwnThisFunction(node)` = FunctionExpression ∨ MethodDeclaration
   ∨ Get/SetAccessorDeclaration (a `ts.isFunctionLike` that excludes arrows)
   and use it at every `ts.isFunctionExpression(arrow)` `this`-boundary site:
   `closures.ts:3466` (`ensureCurrentThisGlobal`), `arrow-phases.ts:455`
   (self-binding), `:489` (the lexical-`this` capture — must NOT fire for a
   method), `:587`, `:731`, `:1282` (`arguments`), `:1333`. A method body then
   reads `this` through the `readsCurrentThis` ladder (`this-keyword.ts:100-175`),
   whose #1702 null-guard yields `undefined` (strict) / global (sloppy) for a
   bare call and the installed receiver for a `__call_fn_method_N` dispatch.
   `p01`, `p32` (generator twin) are the acceptance probes; `p01b` must stay
   green (function-valued property).
2. **K — methods must be real own properties.** Two routes, pick by
   measurement: (a) route a literal whose method is MOP-observed to the open
   path — add to `objectLiteralForcesHostPath` (L1690) a syntactic predicate
   "a `delete <binding>.<method>` / `Object.getOwnPropertyNames(<binding>)` /
   `hasOwnProperty` call / the binding escapes to a call as an argument" on the
   pattern of `hasAddedDefineProp` (`object-ops.ts:4264`,
   `definePropertyReceiverKeys`) — the literal then lands on the `$Object`
   path where `__delete_property` and `__getOwnPropertyNames` already answer
   (`p53` shows the OPEN-path delete ALSO fails: fix that first — the method
   closure stored by `emitObjectLiteralMethodFn` + `__extern_set` at
   `literals.ts:1300-1320` must be a configurable data property, and
   `__delete_property`'s `$Object` arm must remove it; verify `delete obj.method
   === true` and `hasOwnProperty` false); or (b) give the closed-struct arm in
   `typeof-delete.ts:633` a method-field path (mutable=false → clear via a
   sidecar tombstone the readers honour). (a) is the smaller change and is what
   #5149 B(c) recommended. The `[k]() {}` identifier-computed METHOD key
   (`p43b`) must reach the same open path: `_hasRuntimeComputedKey`
   (L1496) currently treats a constant-foldable identifier as static and the
   closed path then drops the method — make a computed METHOD key always route
   open (data keys already work, `p43`).
3. **M — redeclared `var` with two literal shapes.** Extend
   `object-shape-widening.ts:959 collectRedeclaredObjectIdentityLiterals`: when
   a module-scoped `var` has ≥2 declarations whose initializers are object
   literals with different property-name sets (or one is not a literal), add
   every such declaration to `redeclaredObjectIdentityDeclarations` (slot →
   externref, `declarations.ts:3260`) and its literal to
   `redeclaredObjectIdentityLiterals` (compiled via
   `compileObjectLiteralAsExternref`). The #4491 T4 predicate stays narrow for
   primitives; this is its object-vs-object half. `p44` (`obj.a === undefined`,
   `obj.b === 2`) and `p09b` are the acceptance probes; `p09` is the test shape.

Expected yield: 10.

### Step 4 — `super` in object-literal methods and accessors (cluster H; 9 rows; `expr-cl-H-objlit-super.txt`) — after step 2

1. **H1 routing**: add `_hasSuperReferencingMember(expr)` (a
   `genBodyReferencesSuper` walk over every MethodDeclaration / accessor body
   AND its parameter initializers) to `objectLiteralForcesHostPath` so such
   literals take the accessor path, where `objLocal` is threaded as the
   [[HomeObject]] (`emitObjectLiteralMethodFn(ctx, fctx, prop, objLocal)`,
   L1319). Param defaults: `emitObjectLiteralMethodFn` gates the capture on
   `genBodyReferencesSuper(fn.body)` — widen to `fn.parameters` too
   (`name-super-prop-param`, `generator-super-prop-param`).
2. **H2 calls**: in `compileSuperMethodCallCore` (`new-super.ts:1057`), BEFORE
   the `!currentClassName → evalArgsAndDefault` bail (L1086), add the
   standalone object-literal arm mirroring the #4688 read: `home =
   local.get(SUPER_HOME_OBJECT_CAPTURE_NAME)` → `__getPrototypeOf` →
   `emitSuperBaseCoercibleGuard` (L1198) → `__reflect_get_receiver(proto,
   name, __current_this)` → call the closure value with `this` = the call-time
   receiver through `__apply_closure(fn, thisArg, argsVec)` (`object-runtime.ts:7305`,
   the `fn.call(thisArg, …)` lowering `closure-props.ts:1099` documents; build
   the args vec with `ensureObjVecBuilders`) — bail to the old fallback only
   when the capture local is absent. `p08b`, `p54`, `p64`, `method.js`,
   `computed-property-names/object/method/super.js` are the acceptance set.
3. **H2 accessors**: thread `homeObjectLocal` into `emitObjectLiteralAccessorFn`
   (`literals.ts:1310-1330` call sites; `closures.ts:3564` is the capture
   injection) so getter/setter bodies containing `super` carry the capture;
   `setter-super-prop` additionally needs the WRITE half — `super.x = v` →
   `__reflect_set`-style put with receiver `this` (no receiver param exists
   today, `object-runtime.ts:4202` — #5195 D4 owns the class-side write; if it
   has not landed, route the objlit setter through `__extern_set(proto-found
   accessor's setter, this)` via the descriptor read `__getOwnPropertyDescriptor`
   + `__apply_closure(set, this, [v])`, and say so in the PR).
4. **H3 builtins**: `super.toString` must answer the actual
   `Object.prototype.toString` value: with step 2 `__getPrototypeOf(home)` is
   the `$NativeProto`; `__reflect_get_receiver` must consult the brand
   companion (`native-proto.ts` #2175 seeding, `__protoidx_get_r`) — the same
   read `Function.prototype.value` already takes for closures
   (`closure-props.ts:841`). Acceptance: `p08`, `p08d`.

Expected yield: 8 (9 if #5195 D4's write half is available for `setter-super-prop`).

### Step 5 — Runtime computed keys (cluster L; 8 rows; `expr-cl-L-computed-keys.txt`)

1. **L3 runtime-keyed accessors**: in `compileObjectLiteralWithAccessors`
   replace the `resolveAccessorPropName === undefined → continue` at L960/L1299
   with a runtime-key arm: evaluate the key once via
   `compileRuntimeComputedPropertyKey` (L884) into a local (source order —
   before the getter/setter closures are built), pair getter and setter by
   SOURCE POSITION identity of the computed expression only when both spell
   the same identifier/literal, otherwise define each half separately, and call
   `__defineProperty_accessor(obj, keyLocal, get, set, flags)` — the same
   native the static pair uses (L1050). ToPropertyKey of a boolean/number key
   (`'x' in empty` → `"false"`, `1` → `"1"`) happens in the native.
   Acceptance: `p22`, `p23`, `accessor/getter`, `accessor/setter`,
   `accessor-name-computed-in`.
2. **L4 accessor names**: stamp `"get " + key` / `"set " + key` on the closures
   (`function-instance-meta.ts` — `symbolComputedKeyFunctionName` gives
   `"[desc]"`/`""` for symbol keys; the descriptor-read crash in
   `fn-name-accessor-get/set` disappears once L3 defines the accessor).
3. **L1 symbol reads**: reduce `p41` (`var k = ID(sym2); ({[k]:'D'})[sym2]`)
   — dump the element-access read lowering for a string-index-signature
   receiver with a symbol-typed key (`element-access-*.ts` / `dyn-read.ts`): the
   key must reach `__extern_get` as the `$Symbol` carrier (`__obj_hash`'s symbol
   arm, `object-runtime.ts:~1551`), never through ToString. Then `p05` and the
   two `computed-property-names/{basics,object/method}/symbol` rows.
4. **L2 `method/number`**: compile the exact literal `{ a(){}, [1](){}, c(){},
   [ID(2)](){} }` with `object.a()` (`p06`/`p42` each pass alone) to WAT and
   find the `ref.cast` at `__module_init` L20; expected cause: the numeric
   method key makes the literal's checker type carry a NUMBER index signature,
   and the static member-call fold picks the closed struct for `object.a()`
   while the value is the open `$Object` (`tagAccessorObjectLiteralReceiver`,
   L937, must also cover the METHOD-call lowering in
   `expressions/call-receiver-method.ts`). Also `Object.getOwnPropertyNames`
   order `['1','2','a','c']` (integer keys first — `__getOwnPropertyNames`'s
   ordering, `object-runtime-descriptors.ts`).

Expected yield: 8.

### Step 6 — `instanceof` (cluster C; 6 rows; `expr-cl-C-instanceof.txt`)

New module `src/codegen/instanceof-has-instance.ts` holding the §7.3.19
InstanceofOperator prologue as a defined native
`__instanceof_operator(V, target) -> i32` (tri-state 0/1/2, reusing
`emitInstanceofThrowGuard`):
1. `Type(target) is not Object` → 2 (TypeError) — use the positive classifiers
   (`__typeof_object` ∨ `__typeof_function`), never "not classified as object"
   (the header of `native-dynamic-instanceof.ts` explains why a negative test
   mis-fires on builtin carriers).
2. `instOfHandler = GetMethod(target, @@hasInstance)` through `__extern_get`
   with the boxed well-known symbol (`__box_symbol(hasInstance id)`, the way
   `symbolToPrimitive` at `object-runtime.ts:5264` reads `@@toPrimitive`) —
   an accessor's abrupt completion propagates (`symbol-hasinstance-get-err`,
   `p13b`); if callable → `ToBoolean(__apply_closure(handler, target, [V]))`
   (`p13`: `this === F`, one argument; `symbol-hasinstance-to-boolean`:
   undefined/null/NaN/''/0 → false, everything else → true); if present but
   not callable → 2.
3. `IsCallable(target)` false → 2; else fall into the existing
   `__instanceof_dynamic` (OrdinaryHasInstance). Wire: in `emitDynamicInstanceOf`
   (`identifiers.ts:2565`) call the new native FIRST for a non-primitive RHS and
   move `tryEmitNonCallableRhsThrow` (`native-ordinary-instanceof.ts:96`) behind
   it — today the static throw pre-empts step 2 (`p52`). Keep the #2998
   primitive-LHS fold ONLY when the RHS is statically a known function (the
   fold skips step 2 otherwise — `0 instanceof F` with `F = {}` must call the
   handler). The `%Function.prototype%[@@hasInstance]` body
   (`function-proto-has-instance.ts:49`) keeps calling `__instanceof_dynamic`
   directly (it IS the ordinary handler).
4. `Function.prototype` as RHS: in `__instanceof_dynamic`'s callable arm, read
   `prototype` through `__extern_get` for a `$NativeProto` receiver too (the
   `Function` glue's companion — `Object.defineProperty(Function.prototype,
   "prototype", {get})` lands there via `__obj_define_from_desc`), invoke the
   getter exactly once (`p12b`), throw on a non-object result (`p12`), and
   propagate the getter's abrupt (`prototype-getter-with-object-throws`).
   Measure the `[] instanceof Function.prototype` compile time (`p45`: 15–25 s
   on HEAD) before and after — if the `Function.prototype` VALUE lowering is the
   cost, note it in the PR for the perf lane; the row is counted here only if
   it compiles inside the runner's budget.

Expected yield: 6.

### Step 7 — Tagged templates (cluster B; 8 rows; `expr-cl-B-tagged-template.txt`)

New module `src/codegen/tagged-template-apply.ts`: one lowering for every tag
that is not a statically-known declaration/closure —
`__apply_closure(tag, thisValue, argsVec)` with `argsVec = [templateObject,
...substitutions]` (`ensureObjVecBuilders` for the `$ObjVec`). It gives, for
free: the receiver (`p15`: member tag → `thisValue` = the receiver evaluated
ONCE, callee read through `__extern_get`; call-expression / IIFE tag →
`undefined` — `p14`/`p48` already pass and must stay so), the real
`arguments.length` (`__apply_closure` → `__call_fn_method_N` sets `__argc`;
`p16`/`p16b`/`p47`), and the retirement of the `env::__tagged_template` +
`__js_array_new/push` bridge (the CE row — delete that arm at
`string-ops.ts:1607-1612`; the leak check `standaloneHostImportError`,
`tests/test262-runner.ts:3700`, is the gate). Keep the static Case 1/Case 2
arms (L1230, L1330) byte-stable for known tags — they are what step 1's TCO
promotes (`tco-call`, `tco-member`); for them, deliver surplus substitutions
through `buildArgcExtrasSetupFromLocals` / `emitSetArgc`
(`calls-closures.ts:1019-1030`) instead of dropping them, and push the
template object into `__extras_argv` when the callee declares no slot for it
(the #5154-E fix dropped it; `member-expression-argument-list-evaluation`
declares zero params and reads `arguments.length === 1`).

Template object integrity: after `struct.new $TemplateVec` (L1145-1150) call
`__object_freeze` (`object-runtime-integrity.ts:100`, #4032 carrier-bag arm)
on BOTH the template vec and its raw vec, and make `__vec_prop_set`
(`vec-props.ts:478`) consult the bag's `OBJ_FLAG_FROZEN`/`NONEXTENSIBLE`
before storing (refuse → sloppy no-op, strict TypeError via the shared
`setResultGlobalIdx` REFUSED signal the helper already threads). `p19`,
`p19b`, `p46`. `new tag\`x\`` (`p20`): in `compileNewExpression`
(`new-super.ts:5332`), when the unwrapped callee is a TaggedTemplateExpression
(or any non-identifier callee whose value is a closure), compile it to
externref and construct through `reserveNativeConstructDriver(ctx, argc, …)`
(`native-construct.ts:143` — the #3981 driver `new-super.ts:3135` already uses
for first-class function values); `new tag\`second\`('constructor argument')`
passes the argument list to the driver. `template-literal/evaluation-order`:
pin with `p63` (exact two-template shape) before touching anything — `p03`
shows the tagged half alone is fine.

Expected yield: 8.

### Step 8 — ToPrimitive hint, bare statements, `string == object` (cluster D; 3 rows; `expr-cl-D-toprimitive.txt`)

1. In `symbolToPrimitive` (`object-runtime.ts:5264`): pass the hint STRING —
   null hint → the interned `"default"`, otherwise the given `"number"` /
   `"string"` (`stringConstantExternrefInstrs`) — as the method's single
   argument (§7.1.1.1 step 2.b). `p02` log must read `LdefaultRdefault`.
2. Bare expression statements: find where `left + right;` / `0 == y;` is
   dropped (`statements.ts:514` → `compileExpressionStatement`; probes
   `p61`/`p62`) — a value-typed expression whose operands may be objects is
   NOT side-effect-free; compile it and `drop` the result.
3. `__any_eq` (`any-eq-helpers.ts:52`): add the §7.2.15 step 11/12 arm — when
   exactly one side is tag 6 (object) and the other a primitive tag, call
   `__to_primitive(object, null)` and re-enter (bounded: one retry). The
   symbol-vs-object case (`Symbol.toPrimitive == y`) is the same arm. `p62b`.

Expected yield: 3.

### Step 9 — Per-element ArrayAssignmentPattern drive (cluster E; 15 rows; `expr-cl-E-dstr-assign-drive.txt`)

New module `src/codegen/assignment-pattern-drive.ts`, replacing the
materialize-first body of `compileExternrefArrayDestructuringAssignment`
(`assignment.ts:2562-2580`) for the externref/user-iterable lane (keep the
wasm-vec/tuple fast paths at `:1962`ff untouched). §13.15.5.5
IteratorDestructuringAssignmentEvaluation, per element:
1. non-pattern target → evaluate the **lref first** (member target: receiver
   AND key, `{}[thrower()]` throws here — `p24` next=0, return=1);
2. `!done` → `__iterator_next` (`iterator-native.ts:516`); its abrupt sets
   `done = true` and rethrows WITHOUT close (`*-close-skip` rows);
3. `value = done ? undefined : value`; initializer when `value === undefined`
   (`__extern_is_undefined`, NamedEvaluation via `fnInstanceNameOf`);
4. PutValue (`emitAssignToTarget`, L2886; ElementAccess arm through
   `emitDynamicElementSet` since #5146 D) / recurse for a nested pattern;
5. abrupt at 1/3/4 with `!done` → `__iterator_return` with the throw
   completion (its own abrupt suppressed — the `*-close-err` rows), rethrow.
Elision → step 2 only. Rest `[...t]` → lref first (`array-rest-lref-err`: 0
next, 1 return), then drain into a fresh `$Vec` with repeated `next()`, then
PutValue to a MEMBER target too (`p24b`, `array-rest-lref`,
`array-rest-put-prop-ref-user-err-iter-close-skip` — the setter's throw after
`done` must NOT close). After the pattern, `!done` → IteratorClose with a
normal completion (`return` absent/undefined → no-op; non-callable or
non-object result → TypeError — #5146 found the completion KIND must reach
`__iterator_return`; add a second entry point or an i32 completion-kind param
in `iterator-native.ts:1589 buildIteratorReturnBody`). The two
`obj-literal-prop-ref-init` rows are the OBJECT-pattern lref-first ordering
(`compileDestructuringAssignment`, L1137ff): evaluate the member lref once
(getter NOT invoked), then default, then the setter with the final value.
**Reuse, don't triplicate**: factor the step/close emitters out of
`destructureParamArray` (`destructuring-params.ts:1677`, the model since #4447)
into helpers taking an "emit target write" callback, and share them with #5267
F2 (`for-of-destructuring.ts:2239`) — whoever lands first owns the helpers.
Wasm pattern for close-on-abrupt: `try_table` with EMPTY blocktype only
(`promise-executor.ts:192`, `calls.ts:152`; the result-typed form traps V8 —
#5141 B). Before starting, re-run `array-elem-iter-thrw-close-skip.js` alone
(the anomalous control) — it exercises exactly this lane.

Expected yield: 15 (the largest and riskiest step; ship in two PRs: elements +
close first, rest + object-pattern ordering second).

### Step 10 — Small clusters (F + G + N; 10 rows; `expr-cl-F-*.txt`, `-G-*`, `-N-*`)

- **F (2)**: pin with `p56` (exact shape incl. `var argument, eval;`) and
  `p56b`; make the sloppy script-level `arguments` write in
  `identifier-assignment.ts:475-490` (the `name === "arguments"` re-slot arm)
  create/write a GLOBAL binding the later read resolves — the same funnel the
  plain-assignment lane uses for an unresolvable sloppy name (`#5146` C's
  `emitPutValueTargetGuard` ordering stays: TDZ → const → write).
- **G (5)**: (a) `collectClassDeclaration` (`class-bodies.ts:893`): for an
  anonymous class expression set `esName` from the NamedEvaluation hint, never
  the synthetic name — `registerClassExpression(classExpr, nameHint)`
  (`declarations.ts:2497`) already derives it for variable initializers; store
  `functionNameMap.set(syntheticName, hint)`; (b) extend the collector to every
  NamedEvaluation position the FUNCTION lane already knows
  (`function-instance-meta.ts:256 fnInstanceNameOf`'s parent walk: assignment
  RHS, PropertyAssignment initializer, ShorthandPropertyAssignment default,
  array-element default) so `{ id: class {} }` / `{ cls = class {} } = {}` /
  `[cls = class {}] = []` get a registered class object WITH a name (`p25b`,
  `p49` show they have none today); (c) `xId: class x {}` keeps `"x"`, a
  `static name() {}` member suppresses the stamp (`classObjectNameMetadata`
  already checks `staticMethodSet`). Descriptor: `{writable:false,
  enumerable:false, configurable:true}` — `fillClassObjectNameArms` answers
  that shape. Cross-link #5195 B in the PR (class-object own-property surface).
- **N (3)**: `binary-ops-in.ts:338-345` — do not fold `"prototype" in <arrow>`
  from the checker's apparent `Function` type; for a closure RHS answer from
  `constructibleClosureTypeIdxs` (arrow / method / generator / async closures
  are NOT constructible — `callableHasConstructBehavior`,
  `callback-ctor-bridge.ts:30`) and `Object.getPrototypeOf(() => {})` must be
  `Function.prototype` (`fnctorGetPrototypeArm`, `object-runtime-prototype.ts`
  #4643). `tryCompileFunctionPoisonRead` (`function-poison-pill-access.ts:52`):
  treat an ARROW source function like a strict one (§10.2.4
  AddRestrictedFunctionProperties applies to every non-legacy function — arrows,
  methods, generators, classes; #5195 T covers the class/method twin — share the
  predicate). `lexical-this.js`: reduce `p40` (strict-only null deref at
  `f.af()`): the strict fnctor body's `this.af = <arrow>` write must land on the
  `new F()` instance; find the strict/sloppy divergence in the fnctor `this`
  write path (`this-keyword.ts` typed-this rung vs `__current_this`) and fix it
  there — it is a two-line probe.

Expected yield: 10.

### Step 11 — Dependent / verify-only rows (clusters O + X5)

- **O (4)** after #5195 D2/D3 land: extend `planClosureCaptures`
  (`arrow-phases.ts:489`, the `this` capture rule) so an arrow whose body
  `genBodyReferencesSuper` inherits the enclosing method's
  `SUPER_HOME_OBJECT_CAPTURE_NAME` capture and the enclosing constructor's
  `this`-initialised flag; `compileSuperMethodCallCore` then resolves through
  the captured home object exactly as step 4.2; `_ => super()` after
  initialisation throws ReferenceError (`lexical-super-call-from-within-constructor`
  also asserts the parent ctor still RUNS — count 2 — before the throw).
- **X5 (15)** after #5271 Steps 6–7 land: re-run `expr-cl-X5-5271-F2F3G3-twins.txt`;
  any survivor whose fix lives in `closures.ts:2984` (the lifted-expression
  mirror of `function-body.ts:611-624`) or in `destructureParamArray` is this
  issue's to finish — say so in the PR and cross-link.

### What NOT to do

- **No new `env::*` host imports and no allowlist edits** — the runner fails
  any standalone module that emits one (`standaloneHostImportError`,
  `tests/test262-runner.ts:3700`). The `__tagged_template` leak (step 7) is
  closed by the `__apply_closure` tail, never by importing the bridge.
- Never edit `tests/test262-runner.ts`, any skip list, `HANGING_TESTS`, or
  `scripts/*-baseline.json` / `scripts/ir-fallback-baseline.json`.
- Never `--no-verify`; run the five ratchet gates before every commit
  (Acceptance below), chained with `&&`, never piped.
- Do not touch the owned areas in "Out of scope": no realm plumbing, no
  eval-bridge work (X2), no `with` environment work (X3 — #5271 D), no
  generator machinery (X4 — `generators-native*.ts` stays untouched), no
  `function-body.ts` / `destructuring-params.ts` param-default work (X5 —
  #5271) beyond the verify step 11.
- Raw `ctx.checker.getTypeAtLocation` is ratcheted — `ctx.oracle` only; grant
  `oracle-ratchet-allow:` only for a genuine wasm-lowering `ValType` question.
- Mint every `Instr[]` template FRESH per arm (a factory, never a shared
  array — aliased arrays are double-remapped by the finalize walks, #5188
  followUp 4); reserve-then-fill for every funcIdx a native body bakes before
  its callee exists (`__object_proto_singleton`, the construct driver, the
  `__call_fn_method_N` dispatchers); `ensureLateImport` +
  `flushLateImportShifts` before baking a funcIdx into an emitted call.
- Do not use result-typed `try_table` blocktypes (V8 trap, #5141 B).
- Do not "fix" cluster A by widening `canTailCall` to mismatched RESULT types
  — only the externref-equality and param-count refusals are unjustified.
- Do not regress the js-host lane: every change here is a standalone arm or
  shared semantics; run the equivalence suite before every push.
- Do not hand-pick issue ids for follow-ups; `claim-issue.mjs --allocate`.

## Acceptance criteria

Expected flips per step (row counts are the cluster sizes; a step is accepted
when its sub-list is green except rows explicitly deferred in the PR body with
the reason):

| Step | Sub-list | Expected flips |
|------|----------|---------------:|
| 1 | `expr-cl-A-tco.txt` | 9 (11 with the `eval`-rebinding stretch rows) |
| 2 | `expr-cl-I-proto-literal.txt` | 5 |
| 3 | `expr-cl-J-method-this.txt` + `-K-method-mop-visibility` + `-M-var-redecl-shape` | 10 |
| 4 | `expr-cl-H-objlit-super.txt` | 8 (9 with #5195 D4's write half) |
| 5 | `expr-cl-L-computed-keys.txt` | 8 |
| 6 | `expr-cl-C-instanceof.txt` | 6 (the `Function.prototype` row counts only if it compiles inside the runner budget) |
| 7 | `expr-cl-B-tagged-template.txt` (the CE row must go CE → pass in ONE step; CE → fail is not accepted) | 8 |
| 8 | `expr-cl-D-toprimitive.txt` | 3 |
| 9 | `expr-cl-E-dstr-assign-drive.txt` | 15 |
| 10 | `expr-cl-F-*` + `-G-*` + `-N-*` | 10 |
| 11 | `expr-cl-O-*` (after #5195 D2/D3), `expr-cl-X5-*` (after #5271 Steps 6–7) | 4 + up to 15, counted for the sibling |
| **total** | `lists/expr-head.txt` (89) | **wave target ≥ 66 (74 %) = steps 1–8 + 10; floor 45 = steps 1–5 + at least half of 7; every not-done row named with its reason** |

- **Controls**: all 20 rows in `lists/expr-controls.txt` still pass after
  every step (verified 20/20 on HEAD 2026-09-02; a regression here is a
  regression, not drift). Re-run the FULL 128-row `.tmp/es2015/expr-list.txt`
  once at the end; the 39 out-of-scope rows must keep their current signature
  (no CE → wrong-answer demotion, no new CE).
- **Pins**: `tests/issue-5270-<step>.test.ts` per landed step, shaped like
  `tests/issue-4492-builtin-as-value.test.ts` (compile with `{ target:
  "standalone" }`, assert `result.imports` is empty, run through the
  `__stdout_*` channel); each pin verified to FAIL on the pre-change tree
  (file-copy A/B, per CLAUDE.md). The step-7 pin asserts the import list is
  empty for the `obj.fn\`x${1}y\`` shape; the step-1 pin asserts a
  100 000-deep `return 0, f(n - 1)` closure recursion terminates.
- **Gates** (run bare, never piped, before every commit; also with
  `LOC_GATE_BASE=$(git rev-parse upstream/main)` to simulate CI's merge
  preview):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
- **Equivalence**: `pnpm run test:equivalence:gate` green (and
  `npm test -- tests/equivalence.test.ts`).
- Results section appended to this file per landed step (before/after counts
  from the probe, deferred rows with reasons), status → `done` in the last
  implementation PR (self-merge path).

## References

- #5149 (in-review, wave 1 object literal) — its "Not done" list is clusters
  H, I, J, K(delete), L(accessors) here; its Step 4 (`__proto__`) and Step 3
  (`super`) are steps 2 and 4, unblocked by the `[[Prototype]]` answer it
  stopped at.
- #5146 (in-review, wave 1 assignment) — its Step 2 (per-element drive) is
  step 9; its cluster E residual ("a second source publishes
  `__anonClass_cls_1`") is cluster G, located at `class-bodies.ts:893`.
- #5271 (statements r2, sibling planner) — owns X3 (`with`) and X5 (param
  defaults / `arguments` / nested pattern lanes); the agreed rest-row split is
  recorded in both files.
- #5267 (for-of r2) — Step F2 builds the same interleaved drive for for-of
  heads; share the step/close helpers (step 9). #5268 (Array+Object r2) —
  Step 1 `__proto__` accessor pair composes with step 2. #5269 — cluster H
  (`[Symbol.toPrimitive]` literal keys) meets step 8 in `__to_primitive`.
  #5195 (class r2) — D2/D3/D4 gate cluster O and step 4.3; T shares the
  restricted-properties predicate with step 10 N; B owns the class-object
  surface cluster G's `name` value lands on.
- #2707c — the tail-call peel + arm promotion (`control-flow.ts:581-630`);
  #822 / #839 / #1972 — the three `return_call` guards; #3981 — native
  `[[Construct]]` driver (`native-construct.ts`); #1888 S1 — `__apply_closure`;
  #4688 — standalone objlit `super` READ (the pattern step 4 extends);
  #2660 M3 / #4637 — closure→prototype edge and its has-own arm; #2916 /
  #2998 / #4484 — the instanceof dispatch order step 6 reorders; #5102 /
  #2175 — `@@toPrimitive` GetMethod in `__to_primitive`; #4491 T4 —
  redeclared-var widening (cluster M's primitive half); #4032 — integrity bag
  for non-`$Object` carriers (template freeze); #2961 — the standalone
  host-import leak gate.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`
  (§ "Method notes": twin-implementation collisions — run `check:dead-exports`
  after any supersede; second passes over a plan on current main are a cheap
  lever).
- Measurement artifacts (committed under
  `plan/agent-context/es2015-suspend-2026-09-01/`): `lists/expr-head.txt`
  (89), `lists/expr-head-run1.tsv` (the 128-row HEAD run), `lists/expr-cl-*.txt`,
  `lists/expr-clusters.tsv`, `lists/expr-controls.txt`;
  `probes/probes5270/` — 78 probes (`p01`…`p65`), their generators
  (`make-probes{,2,3}.mjs.txt`), results (`probes5270*.out.txt`), the runner
  (`probe-one.mts.txt`), the partition (`cluster.mjs.txt`), the controls
  picker (`pick-controls.mjs.txt`), the load-gated batch scripts, the
  re-runs of the timeout row (`expr-one-timeout-rerun.log.txt`) and of the
  anomalous control (`expr-ctrl-one.log.txt`). The three WAT dumps read for
  cluster A (`p21`, `p21b`, `p51`; 2.4 MB each) are not committed — regenerate
  with `npx tsx src/cli.ts <probe.js> --target standalone --wat -o <dir>`
  (the WAT goes to stdout).

## 2026-09-02 implementation (Opus)

Worktree `.claude/worktrees/agent-a7c46b8b6c522fd0e`, branch
`worktree-agent-a7c46b8b6c522fd0e`, base `77ca8fbaae`.

**Honest base, measured in this worktree** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/expr-head.txt --standalone`
(89 in-scope rows): **0 pass · 88 fail · 1 compile_error**. Controls
(`expr-controls.txt`, 20 rows): **20/20 pass**.

### Step 1 — TCO (cluster A, 11 rows): 0 → 8 pass

`expr-cl-A-tco.txt` before **0 pass / 11 fail**, after **8 pass / 3 fail**.
Flipped: `call/tco-call-args`, `comma/tco-final`, `conditional/tco-cond`,
`conditional/tco-pos`, `logical-and/tco-right`, `logical-or/tco-right`,
`tagged-template/tco-call`, `tagged-template/tco-member`.

1.1 **The externref refusal had no reason and is gone.** `git log -S` on
`calleeRet.kind === "externref"` finds only the 2026-08-30 tree import
`c882d1b110`; #822 (argument types / stack setup), #839 (constructor stack
args) and #1972 (try-with-handler) are all about something else. The only pin
was `tail-call-optimization.test.ts` "keeps only host-free externref
boundaries as ordinary calls", which **restates the guard** with no rationale
of its own. Relaxed, and the pin rewritten to what now matters: both lanes
promote the externref tail, the standalone module still validates, and
`test()` still answers 42. Its practical reach was total — `return undefined`
also lowers to an externref result, so NO value-returning standalone JS
function was ever tail-call optimised.

1.2 **The param-COUNT equality is gone.** Wasm validates
`return_call x : [t1* t3*] → [t2*]`, i.e. the operand stack below the callee's
arguments is polymorphic, so the CALLER's arity is irrelevant. #822 WI1's
"not enough arguments on the stack" is about the operands the call site
pushed (a well-formed `call` always has them), and the equality was only a
proxy for it. Both refusals now live in one shared
`tailCallResultsMatch(fctx, calleeResults)`.

1.3 **`__fn_tramp_*` forwards with `return_call`** (both emitters in
`closures/funcref-as-closure.ts`), guarded on the callee's result list
matching the trampoline's. A pure forwarder's frame must not survive; with a
plain `call` the `f → __fn_tramp_f → f` cycle grew two frames per iteration.

**Not done in step 1 (3 rows), with reasons:**

- `call/tco-non-eval-function` — `var eval = f; return eval(n-1)` inside a
  strict function. Step 1.3 removed the trampoline frame (the trace went from
  `__fn_tramp_f_N ← f ← __fn_tramp_f_N` to `f ← f ← f`), but `f`'s own tail
  call is a BARE call, and `emitBareCallReceiverReset` (`expressions/calls.ts:143`)
  wraps it in `global.get $__current_this; local.set $prev; ref.null.extern;
  global.set $__current_this; <call>; local.get $prev; global.set
  $__current_this`. The restore sits AFTER the call, so `peelToTailCallIdx`
  cannot reach it, and peeling through it is **not** the same free move as the
  #1511 `__argc` reset: the restore is what puts the caller's receiver back for
  code that runs after `f` RETURNS, one frame up. A statically-called
  `function outer() { return f() + this.x; }` would read a clobbered
  `__current_this`. Needs a separate design (e.g. proving the enclosing
  dispatcher restores, which the method dispatcher does at
  `closure-exports.ts:1805` but a direct `call` does not) — not worth
  guessing at inside this step.
- `call/tco-non-eval-global` and `call/tco-non-eval-with` — the two rows the
  plan already named as stretch (a script-level `eval = f` assignment must
  shadow the intrinsic for later call sites; `-with` additionally needs #5271
  D3). Both keep their pre-change signature (`callCount 0`), unchanged by this
  step.

**Pre-existing red, NOT caused by this step:** `tests/issue-839.test.ts >
static async private method via this (sub-pattern 2: type mismatch)` fails on
HEAD `77ca8fbaae` with both touched files reverted to their base content —
`C_getDollar failed: call[0] expected type f64, found block of type externref`.
Verified by A/B file copy.

### Step 2 — `[[Prototype]]` of ordinary literals + colon `__proto__` (cluster I, 5 rows): 0 → 4 pass

`expr-cl-I-proto-literal.txt` before **0 pass / 5 fail**, after **4 pass /
1 fail**. Flipped: `object/__proto__-value-obj`, `__proto__-value-null`,
`__proto__-value-non-object`, `__proto__-duplicate-computed`.

2.1 `__getPrototypeOf` (`object-runtime-prototype.ts`) now resolves a null
`$proto`: with `OBJ_FLAG_NULL_PROTO` set it stays JS `null`, otherwise it
answers the canonical `%Object.prototype%` carrier. The carrier comes from a
reserved helper `__object_proto_singleton`, minted with the pre-change answer
(`ref.null.extern`) during `ensureObjectRuntime` and FILLED at finalize by
`fillObjectProtoSingleton` with `buildLazyNativeProtoGetInstrs(ctx,
BUILTIN_BRAND_TABLE.Object)` — the `Object` brand's lazy `$NativeProto` global
does not exist yet at registration time. Wired into BOTH finalize drivers
(`generateModule`, `generateMultiModule`), beside `fillClassObjectNameArms`.
A module whose `Object` brand glue was never registered keeps the old answer
rather than pulling the glue in.

2.2 The `Object.getPrototypeOf(<object literal>)` static folds (direct and
through a variable initializer, plus `hasProvablyNonNullOrdinaryPrototype`)
decline when the literal carries a colon-form `__proto__`, via a shared
`objectLiteralHasColonProto` extracted from `objectLiteralForcesHostPath`.

2.3 `compileObjectLiteralWithAccessors` routes a NON-computed `__proto__:` key
to `__object_setPrototypeOf(obj, v); drop` instead of `__extern_set`, so
§B.3.1 holds: [[Prototype]] is set for an Object or Null value, a primitive
value is silently ignored, and no own property is created. Gated on that
native's presence, so the JS-host lane keeps its `__extern_set` route
byte-for-byte.

**Not done in step 2 (1 row), with the measured reason:**

- `object/computed-__proto__` — advanced from failing assertion 1 (prototype)
  to assertion 9 (`obj.__proto__` for `{ ['__proto__']: undefined }`). Root
  cause is neither `__proto__` nor the literal representation: the STATIC
  member-read fold answers a property whose only checker type is `undefined`
  with an f64 `0`. Measured with `.tmp/es2015/probes/q06-read-fold.js`:
  `var c = { ['x']: undefined }` gives `String(c.x) === "0"` for the static
  read but `"undefined"` for the dynamic `c[k]` read, and adding ANY second
  property (`y: 1`, or an accessor) makes the static read correct too. The
  broken value still answers `c.x === undefined` and `typeof c.x` correctly —
  it fails test262's `assert._isSameValue`, which falls through to
  `1/a === 1/b` because `a !== 0` is false. Routing `__proto__`-keyed literals
  to the open path was tried and REVERTED: it changes routing without fixing
  the fold, and the fold is a member-access/type-lowering defect outside every
  cluster this issue names.

### Step 3 — object-literal representation (clusters J + K + M, 10 rows): 0 → 1 pass

Only cluster **M** landed. J and K were re-measured and the plan's root cause
is falsified for both; the corrected diagnosis is below so the next pass starts
from it instead of re-deriving it.

**M — redeclared `var` with two literal shapes (2 rows): 0 → 1.**
New `collectRedeclaredShapeDivergentObjects` in
`declarations/object-shape-widening.ts` — the same shape-divergence test
`collectRedeclaredWithTargetObjects` already performs, WITHOUT its `with`-target
requirement (which made it apply to almost nothing). A module-scoped `var` with
≥2 declarations whose object-literal shapes differ (or whose shape is not
comparable — a method, accessor, computed key, spread, or a non-literal
initializer) routes every literal declaration through
`redeclaredObjectIdentityDeclarations` / `…Literals`, i.e. the existing
externref `$Object` carrier. `p44`, `p09`, `p09b` all flip. Flipped row:
`object/dstr/meth-dflt-obj-ptrn-empty`.
Not done: `object/dstr/gen-meth-dflt-obj-ptrn-empty`, whose remaining failure is
generator machinery (`TypeError: Cannot read properties of undefined (reading
'next')`) — X4 / #680 territory, not cluster M.

**J — method-shorthand `this` (4 rows): NOT done, plan diagnosis falsified.**
The plan located this in `emitObjectLiteralMethodFn` →
`compileArrowAsClosure`, where every `this`-boundary test is
`ts.isFunctionExpression(arrow)`. WAT of the exact probe shape
(`.tmp/wat/j01.js`, `--target standalone --wat`) shows the method never reaches
that path: `{ method() {…} }` is a CLOSED struct, so the method compiles to
`(func $__anon_0_method (param (ref null 257)))` — a TYPED-`this` function whose
receiver is the struct — reached through
`__obj_meth_tramp___anon_0_method_12`, which reads `__current_this`,
`ref.test`s it against the struct and passes `ref.null 257` when the test fails
(`closures/method-trampolines.ts:148 buildTrampolineThisSlot`). Hence the
observed JS `null`. Introducing `isOwnThisFunction` at the
`ts.isFunctionExpression` sites would not touch this lowering at all.
The real requirement is that such a method's `this` be an **externref** that can
carry the §10.4.3 answer (`undefined` strict / `globalThis` sloppy), which the
struct-typed param cannot represent. Note also that
`buildTrampolineThisSlot`'s other arm THROWS a TypeError for a genuinely-absent
receiver when `methodBodyReadsThis` is true — also wrong for these rows, which
want `undefined`. This is a receiver-representation change, not a predicate
swap; it needs its own design.

**K — methods invisible to the MOP (4 rows): NOT done, and wider than methods.**
`delete obj.method` now returns `true` (not `false` as the plan recorded) but
does not remove the property — and probe `q07-delete-method.js` shows the same
for a plain DATA property on an open literal: `delete c.data` answers `true`
while `hasOwnProperty("data")` stays `true`, for both the static `delete o.k`
and the dynamic `delete o[k]` forms. So the plan's route (a) — route the literal
to the open path — cannot work as written: the open path's delete is broken too,
for every property kind, and that is the thing to fix first.

### Step 8 — ToPrimitive hint + bare expression statements (cluster D, 3 rows): 0 → 2 pass

Flipped: `addition/coerce-symbol-to-prim-invocation`,
`equals/coerce-symbol-to-prim-invocation`.

8.1 `symbolToPrimitive` (`object-runtime.ts`) passed local 1 — the INTERNAL
hint slot, whose "default" encoding is `null` — straight to the user's
`@@toPrimitive` method. §7.1.1.1 step 1 says an absent PreferredType IS the
string `"default"`, and step 2.b passes that string. Now normalised: null →
the interned `"default"`, otherwise the given `"number"` / `"string"`. Probe
`p02` went from `LnullRnull` to `LdefaultRdefault`.

8.2 A bare `left + right;` / `0 == y;` statement was DROPPED whole at module
top level. `expressionRunsUserCode` (`module-init-collection.ts`) already had
this exact argument for `in` / `instanceof` (#5140 — "METHOD-INVOKING
relational operators, not inert comparisons"); the ToPrimitive-reaching
operators (`+ - * / % **`, `== !=`, `< > <= >=`) belong to the same family,
because any object operand runs `valueOf` / `toString` / `@@toPrimitive`.
Added there, restricted to operands that are not SYNTACTICALLY primitive so
`1 + 2;` keeps its previous drop. `compileExpressionStatement`
(`statements.ts`) additionally compiles such a statement with an `externref`
expectation: with no expected type the binary lowering picks a scalar carrier
that unboxes each operand directly and skips ToPrimitive, which is why
`var r = left + right` invoked both methods while `left + right;` invoked
neither. Probes `p61`, `p62` flip.

**Not done in step 8 (1 row):** `equals/coerce-symbol-to-prim-return-prim`
needs the plan's item 3 — the §7.2.15 step 11/12 arm in `__any_eq`
(`any-eq-helpers.ts`), where exactly one side is tag 6 (object) and the other a
primitive. Probe `p62b` (`'str' == y`) still answers `false`. Deferred rather
than guessed at: `__any_eq` operates on the `$AnyValue` tagged union, so the
arm has to unbox the object side back to an externref, call `__to_primitive`,
re-box the primitive result and re-enter with a bounded single retry — and it
was not established in this pass that standalone `'str' == y` even routes
through `__any_eq` rather than an `__extern_*` equality.

**Separate pre-existing defect found while building the step-8 control, NOT
fixed here:** `"x" + o` for an object with a user `valueOf` (or `toString`)
answers `x[object Object]` in BOTH lanes on HEAD — string-concatenation `+`
does not run OrdinaryToPrimitive on its object operand. It is not part of any
row in this issue's 89, and it is a different seam from the `@@toPrimitive`
GetMethod step 8.1 fixes.

### Step 10 — small clusters (F + G + N, 10 rows): 0 → 2 pass

Only cluster **N** landed, 2 of its 3 rows. F and G were measured and are
recorded below with what actually blocks them.

**N (3 rows): 0 → 2.** Flipped `arrow-function/prototype-rules` and
`arrow-function/ArrowFunction_restricted-properties`.

- `"prototype" in (() => {})` folded TRUE. `tsTypeHasProperty`
  (`binary-ops-in.ts`) reads `checker.getApparentType(…).getProperty(key)`, and
  TypeScript's `Function` interface declares `prototype: any` for EVERY
  callable — including the ones that have no such own property. An arrow is
  never a constructor, so a new `receiverIsArrowFunctionValue` route (the
  literal form, or an identifier whose initializer is one) answers `false`
  syntactically and also suppresses the `__extern_has` re-ask, which would
  otherwise reintroduce the wrong answer for an externref-carried arrow.
- `arrowFn.caller` / `arrowFn.arguments` must throw %ThrowTypeError%
  (§10.2.4 AddRestrictedFunctionProperties applies to every non-legacy
  function). `tryCompileFunctionPoisonRead` poisoned only STRICT source
  functions, bound functions and the `Function("'use strict';")` product; a new
  `hasRestrictedProperties` predicate adds arrows. #5195 T owns the
  method/generator/class twin and should reuse this predicate rather than
  adding a second one.

Not done: `arrow-function/lexical-this`. `function F() { this.af = _ => this; }`
then `new F().af()` traps with "dereferencing a null pointer" — the
constructor's `this.af = <arrow>` write never lands on the fnctor instance, so
the read is null before `this` is ever consulted. That is the fnctor
instance-write path, not the arrow's lexical-`this` capture the cluster name
suggests.

**G (5 rows): NOT done — the descriptor is only half of it.**
Probe `q08-class-name.js` measures HEAD exactly: `xCls = class x {}` and
`cls = class {}` already answer the right `.name` VALUE ("x" and "cls") through
the static fold, and the descriptor flags are already right
(`writable:false, enumerable:false, configurable:true`). Two things are wrong:
(a) `Object.getOwnPropertyDescriptor(cls, "name").value` answers the SYNTHETIC
name `__anonClass_cls_1`, because `collectClassDeclaration`
(`class-bodies.ts`) sets `esName = decl.name ? decl.name.text : (syntheticName ?? "")`
and `registerClassExpression`'s NamedEvaluation `nameHint` is never threaded
into it; and (b) every row in this cluster uses `verifyProperty`, whose
`configurable: true` check does `delete obj.name` and then re-checks
`hasOwnProperty` — and that delete answers `true` while leaving the property
present, because the class-object `name` is the #4770 synthetic MOP VIEW, not a
real own property (the class-object own-property surface is #5195 B). Fixing
(a) alone flips no row. Left untouched rather than shipping a change with no
measured row movement.

**F (2 rows): not attempted** — the budget went to the clusters above. The
plan's `p56` note (a script-level `var eval` declaration drags the compile to
~17.6 s, which is over the runner's 15 s budget) still needs measuring before
the rows can be judged cheap.

### Wave result — 89 in-scope rows: 0 → 17 pass

Measured with the CI-equivalent runner and budget
(`npx tsx scripts/run-test262-paths.mts .tmp/es2015/expr-head.txt --standalone`,
15 s per row) in this worktree, before and after:

| | before | after |
|---|---:|---:|
| pass | 0 | **17** |
| fail | 88 | 71 |
| compile_error | 1 | 1 |

The 17 flipped rows, all real `pass` (the runner applies CI's standalone
host-import leak check, so each is host-import-free):

```
expressions/addition/coerce-symbol-to-prim-invocation.js
expressions/arrow-function/ArrowFunction_restricted-properties.js
expressions/arrow-function/prototype-rules.js
expressions/call/tco-call-args.js
expressions/comma/tco-final.js
expressions/conditional/tco-cond.js
expressions/conditional/tco-pos.js
expressions/equals/coerce-symbol-to-prim-invocation.js
expressions/logical-and/tco-right.js
expressions/logical-or/tco-right.js
expressions/object/__proto__-duplicate-computed.js
expressions/object/__proto__-value-non-object.js
expressions/object/__proto__-value-null.js
expressions/object/__proto__-value-obj.js
expressions/object/dstr/meth-dflt-obj-ptrn-empty.js
expressions/tagged-template/tco-call.js
expressions/tagged-template/tco-member.js
```

No previously-passing row regressed: the base was 0 pass, and the 20-row
control list (`lists/expr-controls.txt`) is **20/20** after every step and at
the end. The 39 out-of-scope rows keep their signature: 36 fail + 3
compile_error, the same three CE paths as the baseline 128-row run
(`capturing-closure-variables-2`, `concise-generator`,
`generator-prop-name-yield-expr`) — no new CE and no CE→wrong-answer demotion.

**This is below the plan's target (≥66) and below its floor (45).** Steps
1, 2, 8, 10-N and the M half of step 3 landed. Steps 4 (H), 5 (L), 6 (C),
7 (B), 9 (E) and 11 (O/X5) were not started; J, K, G and F were measured and
are recorded above with what actually blocks each. Three of those measurements
change what the next pass should do, because the plan's stated root cause is
falsified: **J** (the method never reaches `compileArrowAsClosure`), **K** (the
open-path `delete` is broken for plain data properties too), **G** (the `.name`
VALUE and descriptor FLAGS are already right; the blocker is `verifyProperty`'s
delete of a synthetic MOP view).

Two defects found in passing that are outside every cluster this issue names,
recorded so they are not re-derived:

- A static member read of a property whose only checker type is `undefined`
  answers an f64 `0` (`.tmp/es2015/probes/q06-read-fold.js`). The dynamic read
  of the same property is correct, and adding any second property to the
  literal fixes the static one. This is what still fails
  `object/computed-__proto__`.
- `"x" + o` for an object with a user `valueOf` / `toString` answers
  `x[object Object]` in BOTH lanes — string-concatenation `+` does not run
  OrdinaryToPrimitive on its object operand.

Pre-existing red on `origin/main`, verified by reverting all twelve changed
source files to `origin/main` and re-running: `tests/issue-839.test.ts`
(sub-pattern 2), `tests/issue-1472-es5-getprototypeof.test.ts` (the standalone
intrinsic-identity case), `tests/issue-4429-string-hint-toprimitive-this.test.ts`
(2 of 5), `tests/issue-4492-builtin-as-value.test.ts` (the `$NativeProto`
receiver case), `tests/issue-3017-function-poison-pill.test.ts` (4 of 16),
`tests/issue-2800-toplevel-new-objlit-init-read.test.ts` (the delete-tombstone
case).

One committed pin was UPDATED rather than kept, because this wave makes its
subject correct: `tests/issue-3037-cs1c-getprototypeof-carrier.test.ts` pinned
`Object.getPrototypeOf([1]) === null` and `Object.getPrototypeOf({z:1}) ===
null` as a regression lock on the standalone prototype surface. Both now answer
`Array.prototype` and `Object.prototype`; the lock is re-pointed at those
values, and the identity/carrier findings the rest of that suite records are
untouched.

### 2026-09-02 adversarial review — F1 fixed, N1 fixed, N2/N3/N4 documented

An adversarial review (~50 probes, both lanes, node as the oracle; probes under
`.tmp/rev5270/`) cleared steps 1, 2, 3-M and 8 with no finding — `return_call`
across try/catch still lets the catch run (#1972 guard intact), mutual recursion
does not grow the stack, and programs touching none of the changed paths are
byte-identical. One HIGH finding blocked the branch.

**F1 (HIGH, fixed) — `"prototype" in <arrow-bound identifier>` regressed for an
arrow that HAS a `prototype`.** The cluster-N route folded a hard `false` for
any identifier whose initializer is an arrow, with **no write check at all**,
and additionally suppressed the `__extern_has` runtime fallback. Both the fold
and the fallback were off, so all four write forms answered `false` where node
AND the base compiler answer `true`:

| probe | node | base | lane (before) | lane (after) |
|---|---:|---:|---:|---:|
| `a42` `arrow.prototype = 5` (standalone / host) | 1 | 1 | **0** | 1 |
| `a44` bitmask, standalone (`defineProperty` \| `["prototype"]=` \| `Object.assign`) | 7 | 7 | **0** | 7 |
| `a44` bitmask, host | 7 | 3 | **0** | 3 |

The comment's premise was the bug: an arrow's ABSENCE of `prototype` is a fact
about its CREATION, not its lifetime — it is an ordinary extensible object
afterwards. Two changes, both in `binary-ops-in.ts`:

1. `receiverIsArrowFunctionValue` now admits an identifier only when
   `arrowBindingNeverGainsProperties` holds: no member write through the
   binding (`a.k = …` / `a[k] = …`, any assignment operator, through
   paren/`as`/`!` wrappers), no appearance as a call or `new` ARGUMENT
   (`identifierEscapesToCall`, #4765 — this is what covers
   `Object.defineProperty` and `Object.assign`), and no rebinding of the
   identifier (`identifierIsWrittenTo`, #4484 D). An arrow LITERAL still folds
   unconditionally: there is no binding anyone could have written to.
2. The `!arrowPrototypeRoute` suppression on the runtime route is **removed**,
   so a folded `false` may once again be re-asked through `__extern_has` — the
   belt-and-braces half. Verified this does not cost the cluster-N flip:
   `arrow-function/prototype-rules` still passes.

The `a44` host-lane `Object.assign` bit answers `3` rather than `7` — measured
by file-copy A/B to be **identical on `origin/main`**, so it is pre-existing and
outside this issue. The pin for that form is therefore standalone-only, with the
reason recorded in the test.

Five pins added under `#5270 review F1`; the four regression pins were verified
to FAIL on the pre-fix tree and the fold-survival control to stay green.
`tests/in-operator-edge-cases.test.ts` and
`tests/function-prototype-assignment-descriptor.test.ts` stay green (10/10).

**N1 (low, latent soundness — fixed).** `tailCallResultsMatch`
(`statements/control-flow.ts`) compared ValType KIND only: it matched `ref $A`
against an unrelated `ref $B` and cross-matched `ref` ↔ `ref_null` in BOTH
directions, though `ref null $T` does not satisfy a `ref $T` return. Nothing
reproduced end-to-end — an inserted `ref.cast` makes `peelToTailCallIdx` decline
exactly the shapes that would differ — but step 1 removed the param-count
filter, so strictly more call sites now reach this check and it should not rest
on that accident. Tightened to `valTypesMatch` (which compares `typeIdx`) plus
the one sound widening direction, `ref $T` → `ref null $T`. Cluster A holds at
8/11 and the four TCO suites stay green (24/24).

**N2 (low, documented — measured systemic change).** `ir-inline.ts:603` refuses
to inline any body containing `return_call`. With the standalone externref
refusal gone, nearly every value-returning standalone function with a tail call
is now non-inlinable. No size regression. Two independent
measurements agree: the reviewer's 400-literal synthetic (lane 715,033 B vs
base 716,940 B — the lane SMALLER), and my own re-measurement on
`.tmp/f1/n2-synth.ts` (400 object literals + reads, compiled standalone on this
merged tree against `origin/main` versions of all twelve changed source files,
2026-09-02): lane **525,833 B** vs base **525,696 B** — **+137 B, +0.026 %**,
with both trees answering the same value (79800). The two synthetics disagree
on the SIGN of a fraction of a percent, which is the point: the effect is
noise-level either way. Recorded as a known consequence of step 1, not a
defect: an inliner that understood
`return_call` would recover the cases, and that belongs to the inliner's own
issue rather than here.

**N3 (low, inherited — claim narrowed).** The `%Object.prototype%` answer added
by step 2 lands only inside `__getPrototypeOf`'s `ref.test $Object` arm
(`object-runtime-prototype.ts`), so a literal carried on a NON-`$Object` carrier
still answers `null`, and two ordinary literals in one program can disagree.
Base answered `null` for both, so nothing got worse — but the step-2 claim above
should be read as "an ordinary `$Object` literal now answers
`%Object.prototype%`", not "every ordinary literal does".

**N4 (low, inherited — known gap).** A module-scope `var` redeclared with a
divergent shape PLUS a same-named block `let` in the same function traps at
runtime; `collectRedeclaredShapeDivergentObjects` does not cover that shape.
The base compiler traps identically, so this is a pre-existing gap rather than a
regression — noted because it sits on the exact surface step 3-M claims.

#### Re-validation after the container restart (2026-09-02, merged to `origin/main` `da00bd9569`)

The container restarted mid-validation; the branch was already committed at
`c4a445126c`. Everything below was re-run on the merged tree, so no number here
is inherited from the pre-restart session. The merge with `origin/main` — which
had taken the Array/Object wave (#5494) and the #3521-r2 withdrawal work — was
CLEAN, no conflicts.

| check | result |
|---|---|
| `expr-head.txt` standalone (89 rows) | **17 pass / 71 fail / 1 CE** — byte-identical row set to the pre-restart run |
| host-import leak CEs | **1**, the pre-existing `tagged-template/call-expression-argument-list-evaluation` (cluster B, step 7 not implemented) |
| `expr-controls.txt` standalone (20 rows) | **20/20** |
| `tests/issue-5270-es2015-expressions-r2.test.ts` | **29/29** |
| F1 A/B on the pre-fix tree (`c4a445126c^`) | all **4** regression pins FAIL, fold-survival control stays green |
| `in-operator-edge-cases` + `function-prototype-assignment-descriptor` | **10/10** |
| TCO suites (`tail-call-optimization`, `822`, `1972`, `2554`) | **24/24** — the N1 tightening costs no promotion |
| `pnpm run typecheck` | clean |
| five ratchet gates | all green |
| `pnpm run test:equivalence:gate` | **24 failing / 1718 passing / 24 known-failures in baseline — no new regressions** |

F1 probe parity re-measured on the merged tree, lane vs `origin/main`'s
`binary-ops-in.ts` by file-copy A/B:

| probe | node | base | lane |
|---|---:|---:|---:|
| `a42` standalone / host | 1 | 1 | **1** |
| `a44` standalone | 7 | 7 | **7** |
| `a44` host | 7 | 3 | **3** |

The lane matches base exactly everywhere and matches node on standalone. The
host `a44` bit for `Object.assign(arrow, {prototype: 4})` still answers `3`
rather than `7` on `origin/main` too — re-confirmed AFTER the Array/Object wave
landed, so it is pre-existing and outside this issue. That is why its pin is
standalone-only.
