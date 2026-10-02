---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-28
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, runtime, conformance
es_edition: ES2015
goal: standalone-mode
parent: 4444
related: [4444, 5199, 5198, 5152, 5269, 5318, 5350, 6484, 6485, 6494, 1665, 2867, 4119]
assignee: "ttraenkler/fable-es2015-plan"
# 2026-09-20 (cluster D, #5197 R3-3): the `Promise.{all,race}.call(C, iterable)`
# arm in `compileNamespaceStaticCall` grows by 10 lines — the admission check plus
# the delegation to `tryEmitCustomCombinatorCall`. The protocol itself (≈700 LOC)
# lives in the NEW module `src/codegen/promise-custom-combinator.ts`, not in the
# god-file; this grant covers only the dispatch site that has to name it.
# 2026-09-20 (cluster H, arguments ordinary `length`) — +4 lines in
# `src/codegen/vec-overlay.ts`: two comment lines stating §10.4.4's rule, the
# one-line call that splices the arguments arm into `__vec_dp_value`'s
# `"length"` body, and the two `...argumentsLengthDefineArm` spreads at its two
# entry points. The arm BODY (and the descriptor-value reader beside it) lives
# in the length subsystem module `src/codegen/vec-length-descriptor.ts`, which
# exists for exactly this — "keep the brand-sensitive seed and descriptor reads
# out of the overlay emitter so the length implementation remains within its
# subsystem budget". Inlined in the overlay the same change was +77. What
# cannot move is the call site: the decision "an arguments receiver does not
# run ArraySetLength" has to be readable at the point ArraySetLength starts.
# 2026-09-20 — cluster A (native generator lowering, standalone). Two gate
# widenings in `generators-native.ts` (`this` in a generator function
# EXPRESSION; a generator-valued destructuring-param default in a zero-suspend
# method lane). +61 manifest rows pass, 0 regressions across a 617-row
# generator neighbourhood on BOTH targets. The growth is ~80 % comment: each
# widening reverses a bail whose prior rationale is recorded in place, so the
# measurement that overturns it is recorded next to it rather than in a commit
# message nobody reads at the bail site.
# 2026-09-20 — cluster B (String.prototype @@match/@@replace/@@search/@@split
# dispatch, standalone). The protocol itself (~290 LOC) lives in the NEW module
# `src/codegen/string-symbol-protocol.ts`; the only god-file growth is the
# dispatch site in `call-receiver-method.ts::compileReceiverMethodCall` that has
# to NAME it. The call site cannot move: §22.1.3 step 2 runs BEFORE the string
# lane, so the decision "this search value may carry a protocol method" has to
# be readable at the point the native string lane is entered, and the probe's
# fall-through arm IS that same lane re-entered through a closure.
# 2026-09-21 — cluster C (standalone Error `message`, §20.5.1.1 step 3).
# `src/codegen/context/types.ts` +7 and `src/codegen/index.ts` +3 (one +1 in
# each of `generateModule` / `generateMultiModule`). The MECHANISM is in two
# leaf modules that did not exist before (`error-subclass-proto-chain.ts`) or
# already own it (`registry/error-types.ts`); what cannot move is (a) the
# context field that carries the `__new_<Error>` bodies from emit time to
# finalize — `$AnyValue`, the carrier the `undefined` test reads, is not
# reserved when those constructors are emitted, WAT-verified — and (b) the two
# finalize call sites that drain it, which have to sit with the other
# `fill*ErrorProps` phases so the ordering is readable where it matters. The
# first cut built the test at emit time instead and silently degraded to the
# bare `local.get 0` it was meant to replace.
# 2026-09-21 — cluster F (Proxy/Reflect, standalone). All three edits are inside
# the ONE standalone `Reflect.*` arm of `compileNamespaceStaticCall`
# (`nativeReflectProvider`), which is where each method's own answer is built;
# there is no seam to move them behind without splitting a god-function this
# slice does not otherwise touch. The growth is ~60 % comment: two of the three
# reverse a written-down claim that has gone STALE (the `setPrototypeOf` "KNOWN
# LIMITATION: the native has no failure channel" — #5148 built one; the
# `ownKeys` "the native runtime does not retain symbol-keyed properties yet" —
# it does), so the measurement that overturns each claim is recorded next to
# it rather than in a commit message nobody reads at the site.
# 2026-09-21 (cluster E, slice E1): three of the four seams are single arms
# spliced into an EXISTING ladder in a god-file, so the growth cannot be moved
# to a subsystem module without splitting the ladder itself:
#   - array-methods.ts (+15): the §7.1.4 Symbol-index gate at the top of
#     `emitDynViewSpeciesMethodTwoArm`, which is where slice/subarray on a
#     dynamic view compile their window arguments;
#   - dataview-native.ts (+14): the `ArrayBuffer.isView` carrier-set
#     correction, inside the one shared `isViewRefTestInstrs` chain;
#   - closed-method-dispatch.ts (+3): admitting arity 0 to the native array
#     HOF arm (its reserve gate plus the `undefined` callback operand).
# The `sort` comparefn gate went into `dyn-array-producers.ts`, a subsystem
# module already under budget, so it needs no grant.
# 2026-09-21 — cluster G (spec-ordered ArrayAssignmentPattern + IteratorClose,
# standalone). The MECHANISM (~350 LOC) is the NEW module
# `src/codegen/dstr-assign-iterator-drive.ts`; the god-file growth is two
# dispatch sites only — `expressions/assignment.ts` +14 and
# `statements/for-of-destructuring.ts` +9, both ~70 % comment. Neither can move
# behind a seam: each sits at the exact point where its caller is about to
# perform the eager `__array_from_iter_n` materialisation, and the decision
# being recorded is "this pattern's target references are observable, so the
# drain below is the wrong shape". Written anywhere else it would be a fact
# about a lowering the reader cannot see. The `for-of` function grows by the
# same 8 lines (`compileForOfAssignDestructuringExternref`), for the same
# reason and at the same point.
# 2026-09-21 (cluster E, slice E2) — `src/codegen/index.ts` +6 (the import plus
# one finalize call site in each of `generateModule` / `generateMultiModule`,
# with the ordering note that makes the placement readable). The MECHANISM
# (~330 LOC) is the NEW module `src/codegen/ta-dyn-own-keys.ts`, and
# `src/codegen/ta-dyn-mop.ts` SHRINKS by 53 lines in the same change-set — its
# narrower `__object_keys` arm is retired INTO that module rather than
# duplicated beside it. What cannot move is the call site: these arms prepend
# at body[0] of natives that several earlier passes also prepend to, so "after
# `fillVecLengthDynamicArms`, after `fillTaDynViewMopArms`" is an ORDERING
# fact that is only checkable where the order is written.
# 2026-09-21 (cluster E, slice E2): three god-file call sites, each ~70 %
# comment; every MECHANISM lives in a leaf module.
#   - index.ts (+8, split across `generateModule` and `generateMultiModule`):
#     the two finalize call sites for the §10.4.5.6 `[[OwnPropertyKeys]]` arm.
#     They cannot move behind a seam — the arm must be spliced at body index 0
#     of `__getOwnPropertyNames` AFTER `fillTaDynViewMopArms` and AFTER the
#     generic `$__vec_base` arm that `fillObjVecReflectionHelpers` installs,
#     because the vec arm is written for an ordinary Array and appends
#     `"length"`. "Last fill wins the front slot" is a fact about this exact
#     phase list, so the ordering has to be readable here. The arm body
#     (~250 LOC) was the new module `ta-dyn-own-property-names.ts`. At the
#     2026-09-21 merge of PR #6026 into this branch that module was superseded
#     by this branch's superset `ta-dyn-own-keys.ts`, which carries the same
#     `__getOwnPropertyNames` arm plus the four own-ness predicates; two arms
#     spliced at body[0] of the same native cannot coexist.
#   - expressions/call-receiver-method.ts (+13): admitting the `%TypedArray%`
#     intrinsic carrier to `tryEmitTaStaticOfFrom`, and the §23.2.2.1 step-3
#     `IsCallable(mapfn)` gate. The gate has to be emitted BEFORE both drain
#     arms — step 3 precedes step 4's `GetMethod(source, @@iterator)` — and it
#     cannot be folded into the existing nullish test, which cannot tell `null`
#     (a TypeError) from `undefined` (no mapping). Both predicates live in the
#     new module `ta-static-from-of-spec.ts`.
#   - dataview-native.ts (+13): the abstract-`%TypedArray%` TypeError inside
#     `__ta_from_arraylike`. Its PLACEMENT is the whole point and is measured:
#     in front of the `__extern_length` read the source's `length` getter ran
#     0 times; behind it, 1 — §23.2.2.1 performs the array-like length read
#     before TypedArrayCreate, so a throwing getter must win.
# 2026-09-22 (cluster F, slice F2) — `call-namespace-static.ts` +107, all of it
# inside the Reflect block: the §28.1.2 step-1 `IsConstructor(target)` predicate
# and its throw arm, plus a comment block recording why the STATIC half is the
# only sound one here (a runtime `__reflect_is_constructor` probe would have to
# spill the target into a local, and `compileNewExpression` then evaluates the
# same expression a SECOND time — a real break for `Reflect.construct(f(), [])`).
# The predicate cannot move to a leaf module without also moving
# `targetIsStaticallyNullish` and the `fctx` shadowing checks it shares with the
# neighbouring §28.1.x guards, which is the opposite of keeping one spec section
# readable in one place. ~60 % of the growth is that comment.
# 2026-09-23 — cluster I slice I3: `src/codegen/array-object-proto.ts` +4.
# `substr` (Annex B B.2.2.1) gains a reflective closure body by joining the
# `substring`/`slice` family; the BODY is the existing
# `string-proto-substring.ts` leaf, which already emits this exact shape for its
# two siblings and grows by the one ternary arm that names `__str_substr`. What
# cannot move is the god-file's `emitStringProtoMemberBody` DISPATCH line plus
# the three comment lines stating why a LENGTH second bound still takes the
# family's shared absent-bound sentinel — that is the one non-obvious fact about
# the join, and it has to be readable where the member is routed.
# 2026-09-22 (cluster E, slice E4) — `%TypedArray%.{from,of}` as inherited
# first-class values. Two god-files, and both grants are call SITES rather than
# mechanism: the §23.2.2.1/§23.2.2.2 bodies and the `__extern_get` inheritance
# arm (~470 LOC together) live in the NEW module
# `src/codegen/ta-static-from-of-body.ts`.
#   - `array-object-proto.ts` +21: the `%TypedArray%` glue descriptor is the one
#     place that can say these two members are STATICS of the intrinsic — their
#     §17 `length` (1 and 0) is not in the prototype table, both need the packed
#     variadic ABI (`from` must see whether `mapfn` was SUPPLIED), and the
#     `emitMemberBody` hook is what routes them to a real body instead of the
#     `refusalBodyFallback` degrade. Moving any of it would split one member's
#     ABI across two files.
#   - `ta-dyn-mop.ts` +8 (and `fillTaDynViewMopArms` +6): a single
#     `getFn.body.unshift(...buildTaCtorInheritedFromOfGetArm(...))` plus the
#     four comment lines that say why the arm is not folded into the existing
#     `$__ta_ctor` arm a few lines above it (that one casts the receiver to
#     `$__ta_ctor`, which the Int8Array `$Object` carrier is not). The first cut
#     inlined the arm here and cost +68 / +65; extracting it left these 8.
loc-budget-allow:
  # 2026-09-29 — cluster H, slice H6 (record under the H6 claim).
  # `src/codegen/object-runtime-enumeration.ts` +4: one import and three
  # one-line `$Proxy` widenings of the array-like `$Object` arms of
  # `__extern_length` / `__extern_get_idx` / `__extern_has_idx`. The predicate
  # and its rationale live in the NEW leaf `proxy-array-like.ts`, the
  # slice/splice routing in the NEW leaf `array-proxy-receiver.ts`.
  # `array-methods.ts` +9, `context/types.ts` +7, `object-runtime.ts` +9
  # (paths already listed below): the concat gate's fourth disjunct, the
  # `proxyDirty` pre-scan flag, and the `$Proxy` test in the shared
  # `__extern_get_idx` body builder.
  - src/codegen/object-runtime-enumeration.ts
  # 2026-09-29 — cluster C, slice C5 (record at the end of this file). The
  # mechanisms live in leaves: `builtin-subclass-receiver.ts` (NEW — inherited
  # builtin member routing), `builtin-subclass-new-site.ts` (NEW — a
  # member-less Date/RegExp/DataView/Function subclass `new` site),
  # `bound-class-construct-args.ts` (NEW — bound arguments of a bound class),
  # `string-wrapper-dynamic-length.ts` (NEW — String-exotic `length` through
  # `__extern_get`), `standalone-subclass-ctors.ts` (wrapper/String carriers),
  # `class-heritage-check.ts` (Proxy prototype, Symbol heritage),
  # `promise-executor.ts` (IsCallable). What stays in the god-files is the one
  # call where each decision is taken:
  #   - `import-collector.ts` +1: the import; the receiver-type line is
  #     replaced in place by `collectorReceiverType`.
  #   - `call-receiver-method.ts` +4 / `property-access.ts` +1: the import and
  #     the one-line routed `receiverType` / `objType`.
  #   - `class-bodies.ts` +18: the import, the two `classHeritageIsIntrinsicSymbol`
  #     throws, and the implicit-derived-ctor `funcUsesArguments` marking (the
  #     decision has to sit beside the explicit-ctor marking it mirrors).
  #   - `new-super.ts` +27: the bound-args override of the class-construct
  #     argument list, the `__extras_argv` publication for a ctor reading
  #     `arguments` (the arm it replaces is inline there), and the new-site
  #     dispatch (it must run after the class name is resolved and before
  #     `C_new` is called — both only exist in `compileNewExpression`).
  #   - `object-runtime.ts` +2: the import and the `length` arm splice inside
  #     the String-exotic `__extern_get` arm.
  #   - `new-builtin-globals.ts` +3: the Date and Function arms honour the
  #     `builtinNameOverride` the new-site dispatch passes.
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/new-builtin-globals.ts
  # 2026-09-29 — cluster A, slice A13. Wiring only; each mechanism's logic sits
  # in a leaf (`object-literal-super-base.ts`, `generators-native-protocol.ts::
  # orNativeGeneratorCarrierInstrs`):
  # - `dataview-native.ts` +3: an import and one spread (+ comment) in the
  #   §23.2.5.1 step 6 object-arm gate (a native generator object);
  # - `expressions/new-super.ts` +7: the object-literal super reader takes the
  #   AST anchor (threaded through its four callers) and its home-object step
  #   may push the base itself (closed-struct literal → %Object.prototype%);
  # - `context/types.ts` +2 and `declarations/import-collector.ts` +3: the
  #   `usesSourceGenerator` prescan flag, which keeps the new TypedArray arm out
  #   of every module that declares no generator (byte-identical there).
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  # 2026-09-29 — cluster A, slice A14 (record under the A14 claim).
  # `src/codegen/generators-native-consumer.ts` +3: after
  # `ensureNativeDelegatedResultHelpers` in `reserveOpaqueNativeGeneratorDispatch`,
  # re-read the dispatcher map — those helpers build the %GeneratorPrototype%
  # next/return/throw closures, whose bodies reserve the SAME dispatcher, so
  # minting again orphaned theirs as the `unreachable` placeholder (every
  # `.next()` in a module that reified %GeneratorFunction.prototype% trapped).
  # The check must sit at the re-entry point; there is no leaf to move it to.
  - src/codegen/generators-native-consumer.ts
  # 2026-09-28 — cluster A, slice A10 (record under the A10 claim). Four
  # god-files, every path already listed below and restated per the
  # stranded-grant rule; about half of each is the comment recording why a bail
  # was lifted. The delegation-slot cast lives in the NEW leaf
  # `generator-delegation-slot.ts`, the new predicates in
  # `generators-native-ast-scan.ts` / `generator-yield-nested.ts`.
  #   - `src/codegen/generators-native.ts` +44: the candidate gate's four A10
  #     admissions (standalone literal-method `super`, runtime-keyed class
  #     members, static-vs-instance uniqueness, rest params without a JS host)
  #     and the returning-`finally` routing — each is a clause inside a gate
  #     that already exists here, so it cannot move.
  #   - `src/codegen/expressions/new-super.ts` +12: `objectLiteralSuperReceiver`
  #     and its three call sites — the §12.3.5.3 receiver inside a generator
  #     resume function is the frame's `this`, not `__current_this`.
  #   - `src/codegen/closures.ts` +4: `computeClosureWrapperSig` no longer asks
  #     the checker for a yield-keyed generator method's signature (TypeScript
  #     recursed without bound).
  #   - `src/codegen/declarations.ts` +2: the top-level generator branches
  #     register the rest vec (`registerResolvedRestParam`) in no-host lanes.
  # 2026-09-29 — cluster A, slice A11 groups 3/4. `src/codegen/literals.ts` +2:
  # one import and the `argumentsBeforeDefaults` call in the object-literal
  # method path (the `arguments` object must exist before a parameter default
  # that reads it runs). The mechanism is the NEW leaf
  # `object-method-arguments-first.ts`; the static-setter twin is the NEW leaf
  # `class-proto-set-arm.ts`.
  - src/codegen/literals.ts
  # 2026-09-28 — cluster H, slice H1 (receipt under `## Cluster status`). Both
  # paths already listed below; restated per the stranded-grant rule. The
  # mechanism lives in the NEW leaves `spec-arg-coercion.ts` (the object-literal
  # hand-off and the argument's spec ToString provider) and
  # `symbol-to-primitive-arms.ts` (the Symbol-wrapper arm); the walk and the
  # branded-result box decision are `ordinary-to-primitive-probe.ts` /
  # `class-to-primitive.ts`, neither a god-file.
  #   - `src/codegen/string-ops.ts` +19: one import, the `specToString`
  #     parameter of `compileNativeConcatOperand` (and prettier's wrap of its
  #     signature), the spec-provider choice in its externref arm, the 5-line
  #     object-literal arm beside it, and the 2-line hand-off in
  #     `compileStringIntegerArg`. Both arms have to sit where the operand is
  #     already compiled and typed.
  #   - `src/codegen/index.ts` +2: the two-line branded-i32 arm in
  #     `emitToPrimitiveMethodExports`'s `boxResult` (where every dispatcher
  #     result is boxed); the import joins the existing class-to-primitive one.
  # 2026-09-28 — cluster I, slice I7 (receipt under `## Cluster status`). All
  # four paths already listed below, restated per the stranded-grant rule. The
  # mechanism (rest vec → arguments extras, argc clamp) lives in the leaf
  # `arguments-vector-tail.ts`; what stays is wiring:
  #   - `src/codegen/statements/nested-declarations.ts` +8: the `formals`
  #     parameter of `emitArgumentsVecBody`/`emitArgumentsObject`, the
  #     `prepareRestArgs` call (it must run before the first emitted instruction,
  #     a late `__box_number` import shifts indices) and the `emitRestArgs` call
  #     between the extras read and the length sum, which only this body sees.
  #   - `src/codegen/class-bodies.ts` +3: `ctor.parameters` / `member.parameters`
  #     passed at three `emitArgumentsObject` sites (constructor, hoisted method,
  #     host-ctor arm).
  #   - `src/codegen/expressions/call-tail-dispatch.ts` +3: rest-parameter IIFEs
  #     join the "cannot inline" list (a two-line comment and one `||` arm).
  #   - `src/codegen/expressions/call-identifier.ts` +2: `__argc` published at
  #     the end of the direct-call rest-packing arm (one call, one comment).
  # 2026-09-28 — cluster A, slice A8. `src/codegen/declarations.ts` +1 (path
  # already listed below, restated per the stranded-grant rule): the import of
  # `isGeneratorDeclarationPrototypeWrite`. The keep itself rides the existing
  # #2660 S2 `F.prototype = …` keep line (one `||`); the predicate lives in
  # `generators-factory-prototype.ts`, beside the initializer whose own
  # `prototype` the kept write reaches.
  # 2026-09-28 — cluster A, slice A6 (receipt under the A6 claim).
  # `src/codegen/generators-native.ts` +86 against `origin/main` @ `8273bc388e` (A5 + A7)
  # (path already listed below, restated per the stranded-grant rule). The walker
  # (yield-in-yield-operand, owner tracking, the return case) lives in the leaf
  # `generator-yield-nested.ts`. What has to stay in the god-file writes
  # `buildNativeGeneratorPlan`'s own closure state: the refuse-or-lower router the
  # return arm and arms 1/2 call (it needs `nestedYields`, `fail`, `nestedHost`),
  # the host's operand-replacement attach + return terminator (`curId`,
  # `finishState`), the G3b sent-spill helper (`linearHost`,
  # `continuationSpillName`), and the G3a carrier rule inside
  # `generatorElemValType`. About half of the growth is the comment recording
  # why each arm refuses instead of compiling a plain terminator.
  # 2026-09-28 — cluster D, slice D7 (receipt under `## Cluster status`).
  #   - `src/codegen/async-scheduler.ts` +5 (NEW entry): the import, the two
  #     comment lines and the one-line hand-off at the top of
  #     `emitStandalonePromiseFinally` (it re-enters itself for the native arm,
  #     so no function split), and the `intrinsic` parameter of
  #     `emitStandalonePromiseThen` that keeps %Promise.prototype.then% itself
  #     from re-dispatching to an own `then` (it recursed without bound on
  #     `p.then = function () { return Promise.prototype.then.apply(this, arguments) }`).
  #     The `Get(promise, "then")` + generic Invoke, thenFinally / catchFinally
  #     and the value thunks live in the NEW leaf `promise-finally-invoke.ts`.
  #   - `src/codegen/array-object-proto.ts` +1 (path already listed below,
  #     restated per the stranded-grant rule): the comment naming the
  #     `intrinsic` argument at the reflective `then` member body.
  #   - `src/codegen/expressions/calls.ts` +1 (path already listed below): the
  #     import of `isReflectivePromiseMember`, which admits the DIRECT spelling
  #     `Promise.prototype.finally.call(x, …)` to the member closure.
  - src/codegen/async-scheduler.ts
  # 2026-09-28 — cluster A, slice A7 (receipt under `## Cluster status`). Both
  # paths already listed below; restated per the stranded-grant rule. The write
  # semantics live in `expressions/identifier-assignment.ts`
  # (`tryFunctionExpressionOwnNameWrite`), the shadow scan in
  # `generators-native-ast-scan.ts`, the computed-key fold in
  # `single-assignment-binding.ts`; `literals.ts` and `assignment.ts` do not grow.
  #   - `src/codegen/closures.ts` +12: the import, the parameter-shadow check on
  #     the named-fn-expr self registration, and the 5-line unregister before
  #     `hoistVarDeclarations` — it has to sit exactly there, after the
  #     parameter prologue (which must still see the self binding) and before
  #     the var/function hoist (which must allocate the body's own slot).
  #   - `src/codegen/generators-native.ts` +18: the import, the dropped
  #     `bodyReferencesOwnName` bail (and its doc bullet), the one-line call in
  #     the resume prelude, and `bindNamedExpressionOwnName` (13 lines) beside
  #     `ensureNativeGeneratorResumeFunction` — it writes that function's
  #     `resumeFctx.localMap`, whose `__self` local exists only there.
  # 2026-09-28 — cluster A, slice A5 (receipt under the A5 record).
  # `src/codegen/generators-native.ts` +85 against `origin/main` (path already
  # listed below, restated per the stranded-grant rule). The target-1 planner
  # (~690 LOC) lives in the NEW leaf `generator-yield-nested.ts` and the
  # close-transparency predicate in `generators-native-ast-scan.ts`; what stays
  # in the god-file is what reads/writes `buildNativeGeneratorPlan`'s own cursor
  # locals (the `nestedHost` adapter, the arm-2a call, the for-of chain
  # admission in `emitYield`, the inner-body map) plus two emit seams that have
  # to sit where the abrupt body / throw route is built. The D2 delegate-close
  # forwarding moved OUT of `compileState` into `emitDelegateCloseForward`
  # (net-neutral lines, now called from both abrupt branches).
  # 2026-09-27 — cluster B, slice B8 (receipt under `## Cluster status`). Two
  # god-files, both paths already listed below and restated per the
  # stranded-grant rule. Both mechanisms live in NEW leaves
  # (`regexp-symbol-any-receiver.ts`, `regexp-compile-binding.ts`).
  #   - `src/codegen/regexp-standalone.ts` +7: two imports, the one-line
  #     `compiledRegExpBinding` decline at the top of `staticRegExpFlags`, and the
  #     hand-off in `tryCompileStandaloneRegExpSymbolCall`'s untyped-receiver
  #     branch (it passes the two regexp-standalone helpers the leaf needs as
  #     callbacks, so the leaf does not import its own importer).
  #   - `src/codegen/index.ts` +3: `resolveWasmTypeForClosureReturn` loops over
  #     union members instead of reading the whole type's symbol — the check it
  #     already made, applied to `null | { get 0() {…} }`.
  # 2026-09-26 — lane SC1 (a generator body could not see a `var` a
  # PARAMETER-LIST direct eval introduced; receipt at the end of this file).
  # `src/codegen/generators-native.ts` +20 (path already listed below, restated
  # here because a grant is only honoured when the PR modifies the issue file that
  # carries it — the stranded-grant rule). Both mechanisms live in
  # `src/codegen/direct-eval-environment.ts`, which is under budget and already
  # owns the direct-eval reification this reuses: the name collector
  # (`collectParamScopeEvalVarNames`, with its own narrow constant-string resolver
  # rather than an import cycle back into `eval-inline.ts`) and the boxed-local
  # reader (`readPossiblyBoxedLocal`). What is left in the god-file is two call
  # sites that cannot move: the spill registration has to sit in
  # `buildNativeGeneratorPlan` beside the destructuring-param registration it
  # copies (it writes that function's local `patternParamSpillTypes` /
  # `undefWidenedPatternBindings` / `addSpill`), and the pack-site read has to sit
  # inside the `struct.new` operand sequence, where the value is pushed. The first
  # cut inlined both and cost +41.
  # 2026-09-27 — lane SN1 (three unrelated one-row ES2015 standalone causes under
  # one control run; receipt at the end of this file). Two god-files, +41 and
  # +15, both paths already listed below and restated here per the
  # stranded-grant rule.
  #   - `src/codegen/expressions/call-namespace-static.ts` +41: ONE token in the
  #     `Symbol.keyFor` gate (`|| isProvablyToObjectResult(...)`) plus the
  #     module-level helper it names. 33 of the 41 lines are that helper, and
  #     ~20 of those are its doc comment — because the whole content of this fix
  #     is WHY acting on a `"mixed"` static type is sound here: §7.1.18 ToObject
  #     always answers an Object, so `Object(v)` is provably not a Symbol for
  #     every `v`. That is a fact about the CALLEE, and a reader who cannot see
  #     it will read the arm as the operand-type guess the surrounding gate
  #     explicitly refuses to make. The helper is deliberately module-level
  #     rather than inline: inline it cost `compileNamespaceStaticCall` +34
  #     against a +0 func-budget headroom, and the call site's own growth is
  #     now net 0 lines.
  #   - `src/codegen/expressions/calls.ts` +15: one `else if` arm in
  #     `tryEmitNativeProtoReflectiveCall`'s brand resolver plus one import name.
  #     The arm cannot move: the resolver is a flat one-member-at-a-time ladder
  #     (`Number`/`Boolean` for #4582/#4619, `Promise` for #5197 Slice C) whose
  #     ORDER is the semantics — each `else if` runs only when the preceding
  #     `nativeProtoBrandForInterface` lookup declined — and the rationale for
  #     admitting a member has to sit beside the members already admitted or the
  #     next lane cannot tell an enumerated ladder from an open family.
  # 2026-09-27 — lane B18 (`.name` folded from the `PropertyDescriptor` slot a
  # function was read out of; receipt at the end of this file).
  # `src/codegen/property-access-dispatch.ts` +57 (path already listed below,
  # restated here per the stranded-grant rule), of which 45 are comment and the
  # function that carries the §20.2.4.2 `.name` peephole — `tryLengthAndNameReads`,
  # which has ZERO func-budget headroom — is net **+0**. Both new functions are
  # module-level: `symbolIsPropertyDescriptorAccessorSlot` (the predicate) and
  # `nameFoldTypeSymbolIsDeclarationArtefact` (which now names the ENUMERATED set
  # of type symbols whose name is a declaration artefact rather than the
  # function's — TypeScript's `__computed` placeholder from #5149 cluster B, which
  # the peephole already declined inline, plus this descriptor slot). Folding the
  # pre-existing `__computed` test into that helper is what makes the call site a
  # 1-for-1 line replacement instead of a prettier-split four-line condition, and
  # it is also where the set belongs: two decline conditions for one reason read
  # as a rule, two inline `||`s read as an accident.
  # Most of the comment is the DISPROOF, and it is the deliverable as much as the
  # fix: the recorded diagnosis for this row blamed a runtime gOPD synthesising an
  # anonymous getter, split by static vs parameter RECEIVER. Measured 2026-09-27,
  # both halves are wrong — a STATIC receiver under the same guard was equally
  # wrong, a PARAMETER receiver without a guard was already right, and the two
  # descriptor reads answer the identical function object. Written anywhere but
  # beside the predicate, the next lane re-derives it.
  # 2026-09-26 — lane GEN1 (a rest binding inside a nested pattern was given TWO
  # local slots; see the receipt at the end of this file).
  # `src/codegen/destructuring-params.ts` +25 (path already listed below,
  # restated here because a grant is only honoured when the PR modifies the issue
  # file carrying it). The MECHANISM plus all of its rationale (~34 lines) went
  # into the subsystem module `src/codegen/tuple-rest.ts`, which carries no
  # budget. What is left in the god-file is the irreducible call site: the
  # decision "this sub-pattern's rest binding must agree with the SIBLING arm's
  # representation, because `allocLocal` remaps the NAME and the last arm wins"
  # has to be readable at the point the tuple arm picks the type it recurses
  # with — written anywhere else it is a fact about a slot the reader cannot see.
  # 4 of the 25 lines are the import statement prettier splits once it names a
  # fourth symbol from `tuple-rest.js`. Inlined, the same change was +56.
  # 2026-09-26 — lane SG1 (generator singletons: §27.5.3 `executing` guard,
  # §27.5.1.5 iteration-result prototype, §19.2.1.3 eval var/lex conflict in a
  # generator body). Two god-files, +13 and +3. The two new MECHANISMS live in
  # subsystem modules, not here: the `%Object.prototype%` arm for the iteration
  # result is ~90 lines in `generators-native-protocol.ts`, and the syntactic
  # scope walk is ~63 lines in `direct-eval-environment.ts` (the module that
  # already owns `currentDirectEvalLexicalBindingNames`, the function whose empty
  # answer the walk disambiguates). `generators-native.ts` is net **+0** — the
  # gate decoupling was rewritten to occupy the same two lines and its rationale
  # folded into the adjacent comment block.
  #   - `src/codegen/expressions/eval-inline.ts` +13: an import that prettier
  #     splits across 5 lines once it names a third symbol, one optional
  #     parameter on `foldedEvalLowerLexicalCollision` with the 3 comment lines
  #     saying what its absence means, the 2-line fallback expression, and the
  #     2 call sites that now pass the eval call node. What cannot move is the
  #     call: `varNames` and `fctx` are built inside `tryStaticEvalInline` and
  #     the §EvalDeclarationInstantiation decision is read a few lines later, so
  #     the "which lexical names are intervening" question has to be answerable
  #     at that point. Inlined here the same change was +73.
  #   - `src/codegen/index.ts` +3: the import plus the ONE finalize call, at each
  #     of the two finalize entry points (`generateModule` /
  #     `generateMultiModule`). Two entry points is this file's established
  #     pattern for a prepend-an-arm phase — the neighbouring
  #     `prependIterRecPrototypeArm` (#6484 S3) is wired identically — and the
  #     arm must run at both or a multi-module compile silently keeps the old
  #     `null` answer.
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/index.ts
  # 2026-09-26 — lane C1 (§15.7 own `constructor`). Two god-files, +12 and +10.
  #   - `src/codegen/object-ops.ts` +12: 6 comment lines and one 4-line `if` that
  #     adds `"constructor"` to the two own-key sets. The RULE and all of its
  #     evidence live in the NEW leaf module `src/codegen/class-ctor-own-key.ts`;
  #     what cannot move is the call site, because the fold it corrects builds
  #     `tsProps` / `nonEnumerableTsProps` as locals inside
  #     `compilePropertyIntrospection` and answers from them a few lines later.
  #     Inlined, the same change was +51 in the file and +51 in the function.
  #   - `src/compiler/early-errors/node-checks.ts` +10: 6 comment lines and 2
  #     code lines exempting a `static` ConstructorDeclaration from the
  #     async-constructor refusal. There is no seam here at all — the check is
  #     one `on([ClassDeclaration, ClassExpression])` rule body, and the
  #     exemption has to be readable at the refusal it narrows. The comment
  #     records WHY the `isStaticMember` exemption six lines above cannot cover
  #     this spelling (`getMemberName` reports no name for a
  #     ConstructorDeclaration), which is the trap that made the rule wrong.
  - src/codegen/object-ops.ts
  - src/compiler/early-errors/node-checks.ts
  # 2026-09-26 — lane TA1 (`toLocaleString`'s number ELEMENT, §23.1.3.32 step
  # 6.c.i, which §23.2.3.29 reuses). All ~420 lines of mechanism live in the NEW
  # leaf `src/codegen/to-locale-string-element.ts`; the god-files keep only the
  # four sites that cannot move:
  #   - `context/types.ts` +16: the two reserve flags, each with the note saying
  #     why its body is filled at FINALIZE and not at its call site. The ordering
  #     fact those comments carry (a `Number`-brand companion hit is only known
  #     to be a USER value once the native-proto seeder registry is final) is the
  #     single thing that made the first cut a measured no-op, so it belongs on
  #     the flag rather than in a commit message.
  #   - `array-methods.ts` +11: the reserve call plus the comment naming which
  #     receiver shape this arm serves, spliced into `compileArrayJoinNative`'s
  #     numeric `numToStrChain`. It cannot move to the leaf: the chain is built
  #     inline in that function from `elemType`, and the decision "this element
  #     may carry an override" has to be readable where the numeric rendering is
  #     chosen.
  #   - `expressions/call-receiver-method.ts` +12: the second, DISJOINT call site
  #     — a dynamically-typed receiver never reaches the join lowering at all
  #     (measured; it is the shape test262's `testWithTypedArrayConstructors`
  #     produces). Mirrors E7's `taToStringApplies`/`ensureTaToStringHelper`
  #     three-liner two arms below it, plus the by-name re-resolve of `toLSIdx`
  #     that the reserve's own late imports make necessary (#2043).
  #   - `index.ts` +10: the two finalize fill calls in each of `generateModule` /
  #     `generateMultiModule`, beside the `fillArrayToPrimitive` /
  #     `fillClassToPrimitive` calls they twin. Finalize ordering lives in the
  #     driver, which is the whole reason the fill exists there.
  # 2026-09-29 — cluster A, slice A12 (a parameter write survives a
  # suspension). `generators-native.ts` +11 and `context/types.ts` +4 (both
  # paths already listed, restated per the stranded-grant rule). The MECHANISM
  # — which parameters the body can write, and the post-body reconcile for a
  # re-typed parameter local — is the NEW leaf `generator-param-writeback.ts`;
  # the store-back itself is 5 lines in `frame-core.ts::storeSpills`, the one
  # helper every suspension already calls. What stays in the god-file is
  # irreducible: the field's `mutable:` flag where the frame struct is built,
  # the local-index record in the resume prelude's parameter copy (the only
  # point that knows the index), and the reconcile call beside the spill
  # reconcile it mirrors. The two `NativeGeneratorInfo` fields carry that
  # record from the prelude to `storeSpills`.
  - src/codegen/context/types.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-receiver-method.ts
  # 2026-09-26 — lane R1 (`__getPrototypeOf`'s array arm). +2 lines in
  # `src/codegen/index.ts`: ONE `fillArrayProtoSingleton(ctx)` call in each of
  # the two finalize paths (`generateModule`, `generateMultiModule`), placed
  # beside the `fillObjectProtoSingleton(ctx)` call it twins. That call cannot
  # move: the reserve-then-fill discipline REQUIRES the fill to run at finalize,
  # after the brand's lazy `$NativeProto` global exists, and finalize ordering
  # lives in the driver. Every line of mechanism (the reservation, the arm, the
  # fill body) is in `src/codegen/object-runtime-prototype.ts`.
  # 2026-09-26 — lane RF1 (Reflect bucket): `Reflect.construct(proxy, args,
  # NewTarget)` must deliver the caller's NewTarget to the `construct` trap.
  # The two new runtime natives (~130 LOC) live in the NEW subsystem module
  # `src/codegen/object-runtime-proxy-construct-chain.ts`, exactly as the gate
  # advises — the god-files keep only the wiring that cannot move:
  #   - object-runtime-proxy.ts +3: the import, capturing
  #     `__proxy_construct_dispatch`'s funcIdx (the chain walker needs it and it
  #     is only knowable at that registration), and the one call.
  #   - call-namespace-static.ts +10: the dispatch arm itself. The decision
  #     "this Reflect.construct target is a proxy, so construct-then-patch
  #     cannot serve it" has to be readable where the ordinary lowering starts,
  #     and it must run BEFORE `compileNewExpression` evaluates the callee.
  #     The whole emitter (~190 LOC) is in
  #     `src/codegen/expressions/reflect-construct-newtarget.ts`, which is not a
  #     god-file. Inlined at the call site the same change was +20.
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/expressions/call-namespace-static.ts
  # 2026-09-24 — cluster B1 slice N1 (module namespace: live bindings, null
  # prototype, non-extensible). `src/codegen/module-namespace-value.ts`
  # 769 → 1008 (+239). The growth is in ONE emitter and cannot move out of it:
  # the three new export kinds (`live`, `default`, and the accessor install)
  # all have to be woven into `emitNamespaceObject`'s single
  # reserve-imports → flush → emit → re-resolve-global-indices pass, which is
  # the one place that knows which late imports were minted and therefore which
  # baked indices have shifted. A leaf module would have to be handed that
  # bookkeeping to hand it straight back. Roughly half the added lines are the
  # spec citations (§10.4.6.1/.4/.7, §16.2.1.6.4) and the measured
  # before-states the arms reverse, kept at the arm rather than in a commit
  # message. Measured: +11 rows on each lane across
  # `language/module-code/namespace/internals/**`, 0 regressions across
  # `language/module-code/**` (597 rows, both lanes).
  # 2026-09-26 — cluster B1 slice N4 (`export class C {}` inside a module whose
  # namespace is taken). `src/codegen/module-namespace-value.ts` +229/−7 on top
  # of N3. Three parts, none of which can leave the emitter: the `class` export
  # kind and its by-IDENTITY resolution through `ctx.classDeclarationMap` (the
  # codegen key is not always the source name); `ensureClassObjectGetters`,
  # which must run in the same pre-reservation slot as N3's nested-namespace
  # getters because `emitLazyClassObjectGet` interns string constants and
  # flushes late imports MID-BUILD, which the single-batch index discipline
  # forbids; and the split of the (then 301-LOC) `ensureNamespaceObjectGetter`
  # into `reserveNamespaceObjectHelpers` + `buildNamespaceObjectGetterBody`,
  # taken instead of a `func-budget-allow` grant. That split is most of the
  # line count — the reservation phase's resolved indices now travel as a named
  # record rather than as locals in one scope. Comment-dominated otherwise: the
  # two new doc blocks record the measured before-state (one `export class`
  # line declined the WHOLE namespace) and the index-discipline reason the
  # getter is minted rather than inlined. Measured: +1 row in the
  # CI-equivalent lane (`get-nested-namespace-props-nrml.js` fail → pass), 0
  # regressions across `language/module-code/**` (599 rows, both lanes,
  # per-ROW set diff).
  - src/codegen/module-namespace-value.ts
  # 2026-09-24 — lane W1 (`with` / Object Environment Record, §9.1.1.2).
  # `src/runtime.ts` +24, and ~19 of those are comment. Three edits, all inside
  # HOST IMPORT BODIES, which is the one thing that cannot move out of this
  # file: `__extern_get` (both the by-name binding and the `extern_get` intent)
  # stops probing presence with `in` before reading a tracked user Proxy, and
  # `__with_has_binding` stops swallowing a throwing @@unscopables getter. Each
  # is a one-line condition change plus the measurement that forced it — the
  # trap SEQUENCE a `with`-over-Proxy row compares, which is invisible from the
  # value alone, so the rationale has to sit at the condition or the next
  # reader re-adds the probe. There is no mechanism here to extract.
  - src/runtime.ts
  # 2026-09-24 — lane A1 (arguments object created BEFORE parameter defaults,
  # §10.2.11 step 22). `nested-declarations.ts` +86 and `closures.ts` +54, both
  # already listed below. The growth is the SEAM, not the mechanism: the
  # emission had to become callable at two points instead of one, so each file
  # gains a small begin/end pair (`beginNestedArgumentsObject` /
  # `endNestedArgumentsObject`; `emitLiftedClosureArgumentsObject`) around code
  # that already lived there — the extraction SHRANK both host functions
  # (`compileLiftedClosureBody` −36, `compileNestedFunctionDeclarationInScope`
  # below its ceiling), so no func-budget grant is needed. It cannot move to a
  # leaf module: the two call points straddle `emitDefaultParamInit` and the
  # destructuring loop inside those functions, and the whole fact being encoded
  # is WHERE in that sequence the object is created. ~60 % of the added lines
  # are the comments recording that ordering and the two effects it forced
  # (`__argc` is consumed by the vec body; a body `let arguments` is a separate
  # binding) — both of which were live bugs found by measurement, not theory.
  # 2026-09-23 — cluster F slice F4 (a proxy is read and written as a proxy,
  # not as its TARGET's static shape). `property-access.ts` +13 — three lines
  # at the dot-property arm in `compilePropertyAccess`, three at its computed
  # twin in `compileElementAccess`, and the import; `assignment.ts` +28 for the
  # write arm; `object-ops.ts` +15 and `new-super.ts` +12 for the
  # helper-returned-proxy hop. The lowering itself and all of its rationale
  # live in the NEW leaf `src/codegen/proxy-receiver-generic-read.ts` — the
  # first cut inlined them and cost +78 here. Comment-dominated in every case:
  # the executable part of each arm is the same six-line "compile the receiver,
  # push the key, call `__extern_get`" the foreign-eval lane a few hundred
  # lines above already uses, and the rest records the measurement that
  # overturns the fast path —
  # `new Proxy([1,2,3],{}).length` answered **0** and
  # `new Proxy(new String("str"),{}).length` **trapped with a null-pointer
  # dereference** on this branch's base, while `p["length"]` on the SAME tree
  # answered 3. The mechanism (the provenance predicate and the new
  # return-expression hop) lives in the leaf
  # `src/codegen/proxy-value-provenance.ts`. What cannot move is the admission
  # itself: it has to be readable at the point the target-shaped lowering is
  # chosen, which is the top of each of these four dispatchers.
  - src/codegen/property-access.ts
  # 2026-09-23 — cluster D slice D2b (driven `Promise.all`/`race` over a dynamic
  # iterable). The mechanism — the spec-ordered GetIterator/IteratorStep drive,
  # the growable `$CombinatorDriveState` and its three reaction bodies — is the
  # NEW module `src/codegen/promise-combinator-drive.ts`. What is left in the
  # god-files: `promise-combinators.ts` +19, the `ObservableElementCarrier`
  # parameter that lets the existing observable element pipeline (#5197 R3-2)
  # write a drive state instead of `$CombinatorState` — re-implementing that
  # 230-line Get/Call/Invoke pipeline in the new module would fork it — plus
  # `export` on the six internals the drive composes; `call-namespace-static.ts`
  # +5, the one dispatch line (and its comment) at the dynamic-argument exit,
  # which has to sit where `__combinator_to_vec` would otherwise be chosen.
  # Both paths are already listed below (D2 / F2).
  # 2026-09-23 — cluster G slice G2: `statements/for-of-destructuring.ts` +22 —
  # the `emitHoleBoundaryBeforeDefault` helper (a 1-line body under a comment
  # naming the #2001 invariant it enforces) and its four call sites, each placed
  # on the vec-element read that feeds a default test. Those reads live only in
  # this file, so the call sites cannot move; the helper is kept beside them
  # because it guards exactly these reads. The drive widening itself grows
  # `dstr-assign-iterator-drive.ts`, the leaf module that owns it.
  - src/codegen/statements/for-of-destructuring.ts
  # 2026-09-23 — cluster F slice F3 (proxy dispatch follows the value, not the
  # spelling). +14 in `object-ops.ts` and +8 in `expressions/new-super.ts`, and
  # in both files the executable change is ONE line: a hardcoded
  # `e.expression.text === "Proxy"` becomes
  # `tracesToProxyConstructorValue(ctx, e.expression)`. Everything else is the
  # comment recording WHY the narrower test was wrong and why the widening is a
  # proof rather than a guess — the probe (`trapruns[A]` for four proxies, only
  # the literal spelling), and the reason the §19.1.2.4 null hazard the
  # surrounding comment guards against cannot reach it. The predicate itself
  # lives in the leaf `src/codegen/proxy-value-provenance.ts`; what cannot move
  # is the admission test, which has to be readable at the point the dispatch
  # route is chosen.
  - src/codegen/expressions/new-super.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/generators-native.ts
  - src/codegen/dataview-native.ts
  - src/codegen/closed-method-dispatch.ts
# 2026-09-21 — cluster C, slice C2 (top-level `C.prototype.x = v`).
# `declarations.ts` +10 / `collectDeclarations` +9, `assignment.ts` +5 /
# `compilePropertyAssignment` +4, `property-access-dispatch.ts` +9. All three
# MECHANISMS moved into two new leaf modules (`class-proto-toplevel-write.ts`,
# `error-message-proto-read.ts`); what is left is irreducible call sites. A
# module-init KEEP has to be at the point the statement would otherwise be
# dropped; the decline that stops a `.prototype` receiver from being cast to
# `$Error_struct` has to be on the arm that would do the casting; the
# absent-`message` read has to be inside the arm that owns the
# statically-typed Error read. Inlined, the same change was +114.
  - src/codegen/declarations.ts
  - src/codegen/property-access-dispatch.ts
# 2026-09-21 — cluster A, slice A2 (a suspension inside a `for-of` BODY).
# `generators-native.ts` +344, `generators-delegation-runtime.ts` +73. The
# growth is one new plan arm (`lowerForOf`), one new state terminator with its
# emitter arm, and one new unwind-chain entry — all three of which HAVE to live
# where the state graph is built and emitted. `lowerStatements`' statement
# dispatch, the `compileState` terminator switch and `emitUnwindWalk`'s chain
# walk are single closed switches over closed unions; a for-of arm cannot be
# spliced in from a leaf module without first splitting the state machine
# itself, which is a refactor this slice deliberately does not mix in. Roughly
# half the added lines are comment: each records the MEASUREMENT that set a
# bail (arrays/strings/Sets trap at the first step; binding the raw result
# object made `x * 2` NaN while `typeof x` still said "number"), so the next
# owner inherits the probe result rather than the conclusion.
  - src/codegen/generators-delegation-runtime.ts
# 2026-09-21 — cluster C, slice C3 (see the rationale below, under the function
# keys this same change-set needs).
  - src/codegen/class-bodies.ts
  - src/codegen/destructuring-params.ts
# 2026-09-23 — cluster I, slice I2 (`instanceof` consults `@@hasInstance`).
# `expressions/identifiers.ts` +12, of which 7 are comment. The MECHANISM — the
# whole §13.10.2 step 2-4 handler dispatch — is in `native-dynamic-instanceof.ts`
# as a new wrapper native (`__instanceof_operator`), and the module-scope
# predicate stays in `native-ordinary-instanceof.ts`. What cannot move is the
# one-line DECLINE on the #2998 primitive-LHS fold: that fold sits inside
# `emitDynamicInstanceOf` and answers `false` before any lowering below it runs,
# so "a primitive left operand does not end this operator" has to be readable at
# the fold itself. Measured: with the fold first, `0 instanceof F` called the
# installed handler 0 times (`symbol-hasinstance-invocation.js`, callCount 0 vs
# 1). The comment records that measurement in place, next to the bail it
# reverses.
  - src/codegen/expressions/identifiers.ts
# 2026-09-21 — cluster B, slice B2 (observable RegExpExec substrate).
# `regexp-standalone.ts` +47, all of it in `emitRegExpProtoMemberBody`'s new
# `@@7`/`@@9` arm. The MECHANISM (~330 LOC — §22.2.7.1 RegExpExec plus the
# generic §22.2.6.12 `@@search` and §22.2.6.8 `@@match` bodies) is the NEW
# module `src/codegen/regexp-exec-protocol.ts`, which deliberately knows
# nothing about the `$NativeRegExp` struct so it stays usable from any receiver
# shape. What cannot move is the arm itself, for two reasons that are both
# ordering facts: (a) the arm has to sit BEFORE the brand-recovery prologue —
# the whole defect being fixed is that the prologue ran first, and "this member
# does not brand-check here" is only readable at the point the brand check
# would otherwise happen; and (b) the builtin-exec callback it passes down IS
# the moved prologue plus `emitRegexExecArrayCall`, both `$NativeRegExp`
# operations that live in this file.
  - src/codegen/regexp-standalone.ts
# 2026-09-21 — cluster D, slice D2 (#5197 R3-2, integrating held PR #5883).
# The observable §27.2.4.1.1/§27.2.4.3.1 Get/Call/Invoke pipeline (+913) lives
# in `promise-combinators.ts`, the module that already owns every native
# combinator emitter; the intrinsic-`Promise.resolve`-write proof (+99) lives
# beside the existing builtin-write keeps it is an exception to, and only the
# two dispatch decisions travel to the god-files (+39 admission gate in
# call-namespace-static, +19 module-init keep in declarations). Both dispatch
# sites are irreducible: "can source observe this constructor's `resolve` or
# this element's `then`?" has to be readable at the point the fast native arm
# would otherwise be taken, and "is this write the unshadowed intrinsic?" at
# the point module-init collection would otherwise drop it. Restated here so
# the grant is not stranded in #5197 alone.
  - src/codegen/promise-combinators.ts
  - src/codegen/builtin-write-keeps.ts
# 2026-09-21 — cluster B, slice B3 (the DIRECT `re[Symbol.search](s)` /
# `re[Symbol.match](s)` spelling, plus §22.2.6.8 step 6 in full).
# `regexp-standalone.ts` +24: the ROUTING DECISION inside
# `tryCompileStandaloneRegExpSymbolCall`, plus the comment stating why a
# whole-file predicate is the gate. It cannot move: the decision is "take the
# observable protocol or the static native core", and both alternatives are
# resolved in this function — the gate has to be readable at the point the
# static core is entered, exactly as B2's arm had to be readable at the point
# the brand check was. The route's MECHANISM is the new module
# `src/codegen/regexp-symbol-protocol-call.ts` (~170 LOC: the whole-file
# predicate and the `__apply_closure` call on the reified
# `RegExp.prototype[@@x]` singleton), and step 6's collect loop (~240 LOC) is
# in `regexp-exec-protocol.ts`, where the rest of the §22.2.6.8 body already
# lives.
# 2026-09-21 — cluster C, slice C3b (C3's two residual mechanisms). Both grants
# are CALL-SITE decisions that cannot move behind a seam, and both are ~80 %
# comment recording the measurement that set them.
#   * `call-tail-dispatch.ts` +13: the IIFE-inline arms park the enclosing
#     function's `return` protocol. The MECHANISM (and its rationale) lives in
#     the 139-line leaf `expressions/iife-return-patch.ts`, the module that
#     already owns "an inlined IIFE's `return` is not the enclosing function's";
#     what is left here is the two save/restore pairs, one per arm, which have
#     to sit exactly where `fctx.returnType` is already saved and restored.
#   * `call-identifier.ts` +23: the third widening this site must MIRROR when it
#     rebuilds a callee's wrapper signature from the DECLARED types. The site
#     already carries the binding-pattern and `parameterMayBeOmitted` cases for
#     the identical reason (a scalar the compiled callee never declared makes
#     the dispatch chain miss every arm); the JS-inferred-default case was
#     simply missing, and that miss is what forced C3's async-method exclusion.
#     A widening cannot be applied anywhere but where the signature is built.
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/call-identifier.ts
# 2026-09-21 (cluster E, slice E3) — the MECHANISM (~370 LOC, §7.1.1 step 2 plus
# the §7.1.1.1 own-method cascade over a `$__vec_base` carrier) is the NEW
# module `src/codegen/vec-own-to-primitive.ts`. Three god-file call sites is all
# that travels, and none of them can move behind a seam:
#   - `object-runtime.ts` +12: the reserve beside `reserveArrayToPrimitiveString`
#     and the two-instruction prefix inside `__to_primitive`'s vec arm. The
#     reserve HAS to sit with its sibling — a fill-time native cannot mint its
#     own funcIdx after `__to_primitive`'s body has baked its `call` — and the
#     prefix has to sit at the exact instruction the join was previously the
#     WHOLE answer at.
#   - `index.ts` +5: the import plus one finalize call site in each of
#     `generateModule` / `generateMultiModule`. The placement ("immediately
#     after `fillArrayToPrimitive`") is an ORDERING fact — the filled body tails
#     into that native — and an ordering fact is only checkable where the order
#     is written.
#   - `expressions/assignment.ts` +15 (~70 % comment): the §10.4.5.5 statement
#     that a Symbol key on a TypedArray view is an ORDINARY named set, recorded
#     at the one gate that had been excluding view receivers from the
#     named-key route. Written anywhere else it would be a fact about a lane
#     the reader cannot see. The comment carries the measurement it reverses
#     (the write was DROPPED, not misdirected to index 0), so the next owner
#     inherits the probe rather than the conclusion.
# `object-runtime.ts` is restated here — not left to #5197's file alone — so the
# grant is not stranded in an issue this change-set might later stop touching.
  - src/codegen/object-runtime.ts
# 2026-09-21 — cluster A, round 2 (slice A2-gates). +14 lines in
# `generators-native.ts`, all inside `buildNativeGeneratorPlan`'s
# binding-element-default admission predicate, and ~80 % of them comment. The
# growth cannot move to a subsystem module: what changed is the PREDICATE
# itself — the admission test stops being lane identity
# (`ts.isMethodDeclaration(decl)` + a class/object-literal parent) and becomes
# the property that actually carries #4769's argument, "the default never
# crosses a suspension". That decision has to be readable at the point the
# element is admitted, beside the three paragraphs of prior rationale it
# overturns. Two of those paragraphs assert a control that was RE-RUN here and
# does not reproduce (the generator function-expression lane "already traps on
# an element default with a plain NUMERIC value"; it passes, all four cells),
# so the correction is recorded in place rather than in a commit message nobody
# reads at the bail site. The mechanism's other half went into the subsystem
# module `generators-native-ast-scan.ts`, which is under budget.
# 2026-09-21 — cluster C, slice C3 (a JS defaulted parameter's slot). +26 LOC
# across 14 files, and TWELVE of those are exactly +1: the import of the one
# leaf module (`js-default-param-type-guess.ts`, new, ~100 LOC of which ~75 is
# the rationale) plus the single call that wraps an existing
# `resolveWasmType(ctx, paramType)`. That spread is the change, not an
# accident of it. There is no single place where a parameter's Wasm type is
# decided: the callee has ~a dozen lanes (constructor ×4, class method ×2,
# function declaration ×3, closure ×2, object-literal method ×3) and a CALL
# SITE independently rebuilds a candidate signature from the checker to match
# a stored closure. Measured: with only the four callee lanes the manifest
# rows needed, `function outer(f = function (q = 2) { return q; }) { return
# f(7); }` went from a CORRECT answer on the base to an uncaught Wasm
# exception, because the candidate asked for an `f64` the compiled closure no
# longer declared. #5221 recorded the same failure mode for its own widening
# and left it unfixed for exactly this reason. The three files above +1 carry
# the argument at the point it is decided: `class-bodies.ts` +9 / `identifiers.ts`
# +5 / `declarations.ts` +5 (already granted above for C2).
# `calls.ts` is +24, not +1, and the extra 23 are ONE thing the corpus control
# found: a PRE-EXISTING `compileIIFE` defect this slice's widening routes rows
# into. Its missing-argument pad was `ref.null.extern` — JS `null` under the
# standalone value model (#2864) — so `emitDefaultParamInit`'s
# `__extern_is_undefined` test answered false and the default never fired.
# Latent on the base tree, where `(function (f: any = 123) { init = f; }())`
# already left `init` null; nine annexB `*-func-skip-dft-param.js` rows would
# have regressed. The pad decision is a named module-level function with its
# measurement in the doc rather than a branch inlined into `compileIIFE`,
# which keeps that function's own count flat.
  - src/codegen/closures.ts
  - src/codegen/string-ops.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
# 2026-09-21 — cluster B, slice B4 (§22.2.6 accessor READS on a native RegExp
# carrier; #5198 Slice F). The MECHANISM is the new module
# `src/codegen/regexp-accessor-get-arm.ts` (~350 LOC: the generic §22.2.6.4
# getter, the accessor ladder, the `__extern_get` prologue). Only two
# irreducible sites travel out of it. `regexp-standalone.ts` +12: the one arm in
# `emitRegExpProtoMemberBody` that says "`flags` does NOT brand-check" — the
# defect is that brand recovery ran first, and like B2's arm before it, that
# fact is only readable at the point the brand check would otherwise happen.
# `index.ts` +8 (+4 in each of `generateModule`/`generateMultiModule`): the
# finalize call site, which must sit after `fillClosedStructExternGetArms` (the
# ladder it pre-empts) and before `unshiftExternGetProtoCacheArm` (which has to
# stay the body's prefix or `inlineExternGetCallSites` declines wholesale) —
# an ORDERING constraint that is only statable in the ordered pass list.
# 2026-09-23 — cluster H, slice H2 (symbol property keys on an array carrier).
# `src/codegen/vec-overlay.ts` +153 (already listed above; restated here so the
# grant is not stranded in a file this change-set does not touch). Four arms,
# all inside `fillVecOverlayHelpers`: the symbol lanes of `__vec_dp_value`,
# `__vec_dp_accessor` and `__vec_gopd`, plus the symbol-safe variant of the
# `"length"` wrapper used by the `__extern_get` / `__vec_prop_get` read
# prologue. Roughly two thirds is comment, and the comments are the measured
# before-state at each bail — the four answers the base tree gave
# (`gOPD(arr, sym) === undefined` while `arr[sym]` read 9 from the other table)
# are what justify reversing a guard whose own rationale sits at the same line.
# Honest about the shape of the grant: unlike H1's, this growth is NOT reducible
# to a call site. Each arm is an alternative CONTINUATION of a guard whose bail
# instruction list is built from the enclosing closure (`core.ensureIdx`,
# `bailMiss`, `bailReturnVec`, the per-native local-index map), so extracting it
# means first parameterising that closure. That extraction — a
# `vec-symbol-key-overlay.ts` leaf taking the four dependencies explicitly — is
# the right follow-up and is recorded as such in this slice's receipt; it is not
# mixed into a change whose whole value is a measured behaviour fix.
# 2026-09-23 — cluster H slice H3 (`__extern_get`'s missing NUMERIC-key arm on
# a vec receiver). `object-runtime.ts` +11, of which 5 are comment. The whole
# MECHANISM lives in the leaf `vec-numeric-key-presence.ts`, which already owned
# the `__extern_has` twin this slice mirrors (#6485) — the classifier is now
# shared by both builders rather than duplicated, so that file grew by the GET
# wrapper and its rationale only. What cannot move is the six-line splice: the
# arm has to sit immediately after the `$AnyString` key test inside the
# `fillDynamicForinVecArms` vec block and BEFORE the fall-through to the named
# property tail, and `fillDynamicForinVecArms` is one finalize pass whose arms
# are built from its own closure (`getMiss`, `gN`, `externGetIdxIdx`). Putting
# the call anywhere else changes which answer wins. The comment records the
# measurement that justifies it — `readIt([10,20], 0)` answered `undefined`
# where `readIt([10,20], "0")` answered `10` — next to the `$AnyString` gate
# that caused it.
  - src/codegen/ta-dyn-mop.ts
# 2026-09-23 — cluster B, slice B5 (`RegExp.prototype[@@split]`, §22.2.6.14).
# The MECHANISM is the new module `src/codegen/regexp-split-protocol.ts` (the
# whole generic body: SpeciesConstructor, the default-lane splitter clone, the
# sticky walk, ToUint32(limit), and the own-`constructor` read). Three
# irreducible call sites travel, restated here so the grants are not stranded
# in the earlier slices' rationales:
#   - `regexp-standalone.ts` +54: the `@@10` arm in `emitRegExpProtoMemberBody`
#     (same placement fact as B2's `@@7`/`@@9` arm — it must sit BEFORE the
#     brand-recovery prologue), the builtin-exec callback those arms now share
#     lifted to one named function (it recovers the struct from a LOCAL, which
#     `@@split` needs for its splitter), and the direct-spelling ROUTING
#     decision in `tryCompileStandaloneRegExpSymbolCall` (B3's argument: the
#     gate has to be readable where the static core is entered).
#   - `property-access-dispatch.ts` +4: one call in the #3006 standalone
#     `.constructor` fold, which must consult an OWN `constructor` before
#     answering the `%RegExp%` carrier — the decline can only live where the
#     fold is taken.
#   - `expressions/assignment.ts` +5: the no-JS-host decline on an inherited
#     `Object` member write (`re.constructor = f`), which otherwise binds the
#     `Object_set_constructor` HOST import — a compile error in standalone. It
#     has to sit in `compileExternPropertySet`, the function that binds it.
# 2026-09-23 — cluster B, slice B5b (`RegExp.prototype[@@replace]`, §22.2.6.11).
# `regexp-standalone.ts` +23 more (+77 over the slice): the `@@8` arm joins the
# `@@10` one in `emitRegExpProtoMemberBody` and the direct `re[Symbol.replace]`
# spelling gets the same ROUTING decision as `@@split` in
# `tryCompileStandaloneRegExpSymbolCall` — both the B2/B3 placement facts
# restated above. The mechanism (the collect loop, the per-result reads and an
# inline GetSubstitution over captured strings) is the new module
# `src/codegen/regexp-replace-protocol.ts`.
# 2026-09-23 — cluster C, slice C4 (array patterns over a tuple-struct source).
# `destructuring-params.ts` +12 (path listed just above, restated here so the
# grant is dated for this change-set). The MECHANISM — the exhausted-element
# binding and the sentinel-aware field box — lives in the 90-line leaf
# `tuple-rest.ts`, which already owned the exhausted REST element. What stays in
# the god-file is the 5-line call arm inside the tuple loop (the only place that
# knows the tuple's width) and a 7-line module-level adapter that hands the leaf
# the recursion (`destructureParamObject`/`destructureParamArray`), so the leaf
# does not import its own importer.
# 2026-09-23 — cluster E, slice E5 (`%TypedArray%.from` mapping fidelity + the
# static `<TA>.from`/`.of` value). `expressions/call-builtin-static.ts` +8: the
# static `Int32Array.from(src)` element loop ToNumber's an externref element to
# f64 BEFORE the store coercion (externref→i32 was `__unbox_number`, which reads
# an object as 0 without calling valueOf — `iterated-array-changed-by-tonumber`).
# It has to sit inside that loop, the only place that knows the element's
# source and store ValTypes. The other E5 edits land in paths already granted
# above (`dataview-native.ts` +10: an optional per-element hook on the shared
# `__ta_from_arraylike` builder; `call-receiver-method.ts`; `property-access-
# dispatch.ts` +6; `statements/variables.ts` +2), restated here so the grant is
# dated for this change-set; the mechanisms live in `ta-static-from-of-body.ts`
# / `ta-static-from-of-spec.ts`.
  - src/codegen/expressions/call-builtin-static.ts
# 2026-09-23 — cluster B, slice B6 (the runtime `lastIndex` carrier). Both paths
# are listed above; restated so the grant is dated for this change-set.
# `regexp-standalone.ts` +41: the carrier's ONE new field
# (`$lastIndexNonWritable`, the runtime [[Writable]] bit) plus its constant, one
# `i32.const 0` in each of the five `struct.new $NativeRegExp` sites (a struct
# field cannot be added anywhere else), and the two `Set(R,"lastIndex",…,true)`
# guards that must sit exactly where the carrier's slot is written —
# RegExpBuiltinExec's update on the protocol route and RegExpInitialize in
# `compile`. `index.ts` +4: the import and the two finalize calls, which must sit
# between the B4 accessor arm and the proto-cache arm (the cache arm has to stay
# `__extern_get`'s prefix). The mechanism is the new module
# `src/codegen/regexp-lastindex-carrier.ts`.
# `property-access.ts` +2: `findAlternateStructsForField` skips the
# (`__StandaloneRegExp`, `lastIndex`) pair — a bare struct-field arm reads and
# writes only the carrier's f64 slot, so an `any`-typed `d.lastIndex` answered a
# stale number after a deferred object write. The skip has to sit in the one
# function every inline field ladder asks for its candidates; with it the access
# falls to `__extern_get`/`__extern_set`, whose carrier arms own the property.
  # 2026-09-23 — cluster G, slice G3. `expressions/assignment.ts` +39: the
  # 9-line `isTupleShapedStruct` predicate, one early route in each of the two
  # array-assignment readers (top-level and nested) that treated EVERY non-vec
  # struct as a tuple, and the `structIterable` parameter of
  # `compileExternrefArrayDestructuringAssignment` that picks the host's strict
  # GetIterator twin for that route. The predicate and both routes sit next to
  # the two tuple readers they gate; the readers live only in this file.
  # `property-access.ts` +6: one import and a two-line hand-off at each of the
  # two reference-element OOB-widen sites to `tryEmitAnyValueArrayUndefinedOobGet`
  # (the mechanism is the new leaf `src/codegen/any-value-element-read.ts`).
  # `object-runtime.ts` +6: the `$AnyValue` arm of `boxVecElementToExternref`,
  # the one recipe every vec-family reader (`__iterator`, `__extern_get_idx`)
  # uses to lift an element to externref; the arm must sit in that recipe.
  # 2026-09-23 — cluster A slice A3. The `%GeneratorFunction%` intrinsic lives in
  # the NEW leaf `src/codegen/generator-function-intrinsic.ts` (its predecessor
  # left `array-object-proto.ts`, which shrinks by ~70). God-file growth is the
  # dispatch sites that must name it or the gates that must widen in place:
  # `expressions/call-builtin-static.ts` +13 (the `getPrototypeOf(<generator
  # value>)` arm, beside the declaration arm it generalizes), `closures.ts` +36
  # (`isNativeGeneratorMethodClosure`, ~75 % comment, and its three call sites
  # at the generator tests that used to read only `ts.isFunctionExpression`),
  # `generators-native.ts` +58 (`foldedMethodKey` and
  # `isAnonymousDefaultExportDeclaration`, each with the measured reason at the
  # gate it relaxes — the candidate gate is the single source of truth three
  # emit sites and the host-import scan consult, so it cannot move).
# 2026-09-23 — cluster H slice H5 (the SYMBOL brand on a wrapper's
# `[[PrimitiveValue]]` slot). `proto-index-store.ts` +22 inside
# `fillBrandOffBody`'s wrapper-classification arm: one `SYMBOL_OFF` constant and
# a six-instruction `ref.test $Symbol → ret(SYMBOL_OFF)` row, the rest comment.
# The row cannot move to a subsystem module: it is one more rung of an EXISTING
# in-place `ref.test` ladder over the box type in the slot (`$AnyString` →
# String, `$__box_number`/i31 → Number, `$__box_boolean` → Boolean), and the
# whole point of the change is that a reader of those three rows sees the fourth
# beside them. Extracting it would put the Symbol answer somewhere the other
# three are not, which is exactly the split that made the Symbol wrapper answer
# the Object brand in the first place.
#
# What the growth buys, measured and stated plainly: it makes
# `Object(Symbol.toPrimitive)[Symbol.toPrimitive]()` and
# `Object(sym).toString === Symbol.prototype.toString` correct on standalone
# (4 of 11 cases in `tests/issue-6651-h5-symbol-brand.test.ts` are RED on the
# base tree), and it moves ZERO test262 rows — an 865-row per-row set diff over
# manifests H and I plus a 561-row wrapper control found no gain and no loss.
# The reason is recorded in the H5 receipt below: every corpus row that would
# exercise it fails the #2175 proto-member-dirty gate. Arming that gate from
# `Object(sym)` was measured at +57,125 bytes on the smallest program that shows
# the defect, which is why this slice does not do it.
  - src/codegen/proto-index-store.ts
  # 2026-09-23 — cluster A slice A4. The pattern planner and every op emitter
  # live in the NEW leaf `src/codegen/generator-yield-linearize.ts`.
  # `generators-native.ts` +141 is what has to sit inside the plan builder and
  # the state emitter: the `LinearizeHost` adapter over the builder's private
  # state cursor (spill / suspend / reserve / branch / jump — it closes over
  # `emitYield`, `finishState`, `lowerStatements`), the statement arm that calls
  # the planner, the `branch-flag` terminator and `dstr-close` unwind arms in
  # `compileState` / `emitUnwindWalk`, the carrier override in
  # `generatorElemValType`, and the binary / template roots of the #680
  # continuation (`lowerSequencedContinuation`, which the comma arm now shares).
  # 2026-09-24 — cluster B, slice B7. `regexp-standalone.ts` +9: the two-line
  # hand-off in `compileStandaloneRegExpConstructor` to the new leaf
  # `src/codegen/regexp-ctor-regexp-like.ts` (§22.2.4.1 over an object pattern),
  # its imports, and the spec-ToString provider in `emitRegExpCompileInPlace`
  # (Annex B compile's ToString must reject a Symbol; the call sits where the
  # recompile resolves its ToString). `declarations/object-shape-widening.ts`
  # +18: `sentinelSlotTakesPrimitive` and its use at the ONE place the empty-
  # object widening pre-pass decides a later write's slot type (#3669's arm) —
  # a slot seeded by `o.p = undefined` kept its i32 sentinel under a later
  # string write.
  - src/codegen/declarations/object-shape-widening.ts
  # 2026-09-24 — cluster E, slice E7. The mechanisms live in two NEW leaves
  # (`ta-static-view-mop.ts`, `ta-to-string.ts`); god-file growth is the
  # sites that must name them. `index.ts` +4 (import + the one finalize call,
  # which has to follow `fillTaDynViewMopArms`/`fillTaDynViewOwnKeyArms` because
  # it prepends in front of their arms), `closures.ts` +2 (the static-view
  # clause of `closureReturnsExternrefBinding`, the one predicate that decides a
  # closure keeps its value on the externref carrier), `call-receiver-method.ts`
  # +3 (the helper call at the `any`-receiver `toString()` site that otherwise
  # calls `__extern_toString` directly) and
  # `dataview-native.ts` +17 (the callable disjunct of the §23.2.5.1 object-arm
  # guard; that guard exists only inside `emitTaDynCtorConstructFromLocals`).
  # 2026-09-27 — lane VR1 (`instanceof` must not fold on the evolving-`any` start
  # state of a binding assigned across a function boundary; see the receipt at the
  # end of this file). ONE god-file, `expressions/identifiers.ts` +7. The whole
  # mechanism — the predicate, the cached per-declaration scan, and the ~25 lines
  # of rationale for why TypeScript's own narrowing is not a sound upper bound
  # here — lives in the existing leaf `src/codegen/strict-eq-stale-type.ts`, which
  # carries no budget and already owns the three sibling stale-carrier guards this
  # is a fourth member of. What is left in the god-file is irreducible: 3 lines are
  # the import statement biome re-wraps the moment it names a second symbol from
  # that module (the one-symbol form is 78 chars, one under the 80 limit), 1 is the
  # `const foldLeft` that stops the type being queried twice, 1 is the new
  # conjunct, and 2 are the comment naming the predicate at the fold it narrows —
  # which has to be readable there, because the #2998 / #4484 A / #6651 I2 comment
  # block directly above it is a record of the PRECEDENCE decisions at this one
  # `if`, and a fourth decline condition that is not listed with them is the next
  # lane's trap. Inlined at the call site the same change was +34.
  # 2026-09-27 — cluster G, slice G4 (for-of step protocol, non-iterable array
  # assignment; receipt under `## Cluster status`). Four god-files, all CALL
  # SITES — every mechanism lives in three new leaves
  # (`forof-iterator-step.ts`, `forof-array-overlay-read.ts`,
  # `dstr-non-iterable-guard.ts`):
  #   - `src/codegen/statements/loops.ts` +22: the for-of iterator loop's
  #     prime-once call + the step swap (the cached `next` has to be a LOCAL of
  #     the loop that owns it — §7.4.1 stores it in the Iterator Record, and the
  #     record type is shared by every internal drain), plus the overlay-read
  #     arm in the array loop and two imports.
  #   - `src/codegen/expressions/assignment.ts` +8: the provably-non-iterable
  #     struct throw sits inside the G3 struct branch it narrows.
  #   - `src/codegen/iterator-native.ts` +3: the fill hook, placed where the OBJ
  #     carrier deps are resolved (they exist only there, at finalize).
  #   - `src/codegen/statements/for-of-destructuring.ts` +2: the Symbol guard
  #     before the `__array_from_iter_n` materialisation it must precede.
  - src/codegen/statements/loops.ts
  - src/codegen/iterator-native.ts
  # 2026-09-28 — cluster D slice D3 (compiled-CLASS receiver for
  # `Promise.{all,race,allSettled,any}.call(C, iterable)`). The mechanism —
  # Construct(C, «executor») through the native construct driver, the step-wise
  # drive with IteratorClose, and the four element/finish bodies — is the NEW
  # leaf `src/codegen/promise-class-receiver-drive.ts`. `call-namespace-static.ts`
  # +4: one import and the one dispatch line (plus its comment) in the `.call`
  # aggregator arm, which has to sit after D1's function-constructor arm and
  # before the `env::Promise_<method>` host-import fall-through it replaces.
  # `promise-combinators.ts` +0 (an `export` on `ensureSettledAnyCombinators`,
  # whose AggregateError builder the `any` finish reuses). Path already listed.
  # 2026-09-28 — cluster B, slice B9 (receipt under `## Cluster status`). ONE
  # god-file, `src/codegen/builtin-value-read.ts` +3: the import and the one-line
  # decline (plus its comment) at the top of
  # `tryCompileStandaloneBuiltinProtoIteratorRead` — the static fold of
  # `RegExp.prototype[Symbol.<m>]` to the builtin singleton has to stop being
  # taken when the file replaces that member, and that fold only exists there.
  # The whole-file write scan and the Invoke lowering live in NEW leaves
  # (`regexp-proto-symbol-writes.ts`, `regexp-proto-symbol-invoke.ts`).
  # Also `src/codegen/property-access.ts` +1 (path already listed below,
  # restated per the stranded-grant rule): one comment line on B6's
  # `__StandaloneRegExp` skip in `findAlternateStructsForField`, whose condition
  # now names `flags` beside `lastIndex` (the i32 bitfield is not §22.2.6.4's
  # string).
  - src/codegen/builtin-value-read.ts
  # 2026-09-28 — cluster D slice D4 (`class X extends Promise` in standalone,
  # #5197 G9; receipt under `## Cluster status`). The mechanisms live in two NEW
  # leaves: `promise-subclass-proto-link.ts` (the `$bag.$proto` link, the
  # `instanceof` walk, the inherited-`resolve` fallback) and
  # `promise-class-receiver-settle.ts` (`Promise.{resolve,reject}.call(C)` for a
  # class `C`). What cannot move is where each decision is taken:
  #   - `class-bodies.ts` +18: one import, one link call after the explicit
  #     `super(executor)` Promise arm, and the implicit-constructor Promise arm
  #     (a `} else if` between the linked-provider arm and the builtin ladder it
  #     precedes — the ladder would otherwise commit to the identity-only object);
  #   - `call-namespace-static.ts` +4: one import and the class-receiver settle
  #     dispatch (plus its comment) at the end of the `Promise.{resolve,reject}
  #     .call` arm, after D1's function-constructor arm it complements;
  #   - `identifiers.ts` +3: one import and the two-line standalone `instanceof`
  #     arm, ahead of the host-only Promise-subclass arm it is the twin of.
  # All three paths are already listed below (restated per the stranded-grant rule).
  # 2026-09-28 — cluster B, slice B10 (receipt under `## Cluster status`). Three
  # god-files, call sites only (paths already listed below, restated per the
  # stranded-grant rule); both mechanisms live in NEW leaves
  # (`regexp-untyped-receiver.ts`, `regexp-proto-to-string.ts`):
  #   - `src/codegen/index.ts` +5: the import, the pre-scan demand note in both
  #     pipelines (it must run before ANY closure is minted, so the RegExp
  #     `toString` member body is chosen before the companion seeder mints it),
  #     and the finalize arm call in both pipelines (next to the #6678 Date twin,
  #     ahead of the proto-cache arm that has to stay `__extern_get`'s prefix).
  #   - `src/codegen/declarations.ts` +2: the import and one mint call at
  #     module-init start — the one codegen point every source file reaches
  #     with a `FunctionContext` (an eval-produced RegExp has no creation site
  #     in the test module to hook instead).
  #   - `src/codegen/regexp-standalone.ts` +4: the import and the §22.2.6.17
  #     hand-off ahead of brand recovery in `emitRegExpProtoMemberBody` (the
  #     member body is chosen there and nowhere else).
  # 2026-09-28 — cluster C, class-object expando cells (receipt under
  # `## Cluster status`). `src/codegen/index.ts` +4 (path already listed below,
  # restated per the stranded-grant rule): one import, one
  # `recordClassObjectExpandoCell` line in `registerModuleClassStaticAssignments`
  # (the ONLY place that knows a `__static_C_p` global came from a module-scope
  # assignment rather than a declared static field), and one finalize call at
  # each entry point (`generateModule` / `generateMultiModule`), directly after
  # `fillClassObjectNameArms` — the arms must be prepended after every competing
  # `__extern_get` prefix, and must run at both entry points or a multi-module
  # compile keeps the old answer. The mechanism is the NEW leaf
  # `src/codegen/class-object-expando.ts`.
  # 2026-09-28 — cluster D slice D5 (#5197 R3-7, a native promise has no
  # readable `then`; receipt under `## Cluster status`). The mechanism lives in
  # the NEW leaf `promise-dynamic-member-read.ts` (the `__extern_get` `$Promise`
  # arm, the demand gate, the `p.then.length` spec length). What cannot move is
  # where each read is decided:
  #   - `expressions.ts` +2: one import and the one-line source hook in the
  #     property/element-access arm of `compileExpression` — the single point
  #     both `p.then` and `p["then"]` pass through in VALUE position;
  #   - `index.ts` +3: one import and the finalize call in each of
  #     `generateModule` / `generateMultiModule`, beside the #6678 Date twin (the
  #     arm must be unshifted before the proto-cache arm that stays the prefix);
  #   - `promise-combinators.ts` +4: one import and the D2 observable element's
  #     "a replaceable `%Promise.prototype%.then` must be Got" branch;
  #   - `property-access-dispatch.ts` +2: one import and the `?? promiseProto…`
  #     spec-length fallback beside the `%Function.prototype%` one (the
  #     statement wraps onto a second line).
  # The last three paths are already listed below (restated per the
  # stranded-grant rule); `expressions.ts` is new to this list.
  - src/codegen/expressions.ts
  # 2026-09-28 — call-rooted assignment targets at module scope.
  # `declarations.ts` +2: one import line and one `||` term inside
  # `shouldCollectTopLevelAssignment` — the keep has to sit where the statement
  # would otherwise be dropped. The predicate (and its measured rationale) is
  # the new leaf `declarations/expression-rooted-assignment-target.ts`.
  # `src/runtime.ts` +1: the call that snapshots the test262 sandbox's realm
  # intrinsics at `buildImports` — the only point that sees the sandbox before
  # compiled code can rebind its globals. The mechanism lives in
  # `runtime/wasm-struct-host-semantics.ts` beside `normalizeSandboxValue`.
  # (`declarations.ts` is already listed below; `src/runtime.ts` just after.)
  # 2026-09-28 — cluster D, slice D6 (receipt under `## Cluster status`).
  # `src/codegen/property-access-dispatch.ts` +3 (path already listed below,
  # restated per the stranded-grant rule): one import and the two-line hand-off
  # at the top of `emitClassStaticMemberRead`'s cell arm. The mechanism (the
  # `cell ?? Get(%Promise%, p)` read) lives in the NEW leaf
  # `promise-subclass-cell-read.ts`; the hand-off cannot move, because it is the
  # arm that would otherwise emit the bare `global.get` of the cell.
func-budget-allow:
  # 2026-09-29 — cluster H, slice H6. `buildObjectEnumerationHelpers` +2: the
  # `$Proxy` widening of the `__extern_get_idx` / `__extern_has_idx`
  # array-like arms (one line each; the predicate is `proxy-array-like.ts`).
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  # 2026-09-29 — cluster C, slice C5 (see the loc-budget note). Restated per the
  # stranded-grant rule where already listed: `compileClassBodiesInner` +4 and
  # `compileSuperCall` +4 (the two `classHeritageIsIntrinsicSymbol` throws),
  # `collectClassDeclaration` +9 (implicit-ctor `arguments` marking),
  # `compileReceiverMethodCall` +3 (receiver routing), `compileNewExpression`
  # +25 (bound args, `__extras_argv`, new-site dispatch). New:
  # `tryCompileBuiltinGlobalNew` +3 (Date/Function honour the name override)
  # and `tryCompileIndexedBuiltinNew` +1 (the zero-argument DataView TypeError).
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  # 2026-09-29 — cluster A, slice A13. `emitTaDynCtorConstructInline` +2: one
  # spread (and its comment) in the §23.2.5.1 step 6 object-arm gate, which now
  # also admits a native generator object. The test itself is the NEW export
  # `generators-native-protocol.ts::orNativeGeneratorCarrierInstrs`.
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructInline
  # 2026-09-29 — cluster A, slice A13. `unifiedVisitNode` +3: the
  # `usesSourceGenerator` prescan flag (see the loc grant above) — one `if`
  # beside the `usesSourceThrowStatement` flag it mirrors.
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  # 2026-09-28 — cluster A, slice A10 (paths already listed below, restated per
  # the stranded-grant rule). `buildNativeGeneratorPlan` +5: the one clause that
  # routes a `finally` holding a `return` to `lowerTryRegion` (its comment is 4
  # of the 5 lines). `registerNativeGenerator` +1: `capturesDynamicThis` also
  # snapshots the receiver for a `super`-using literal method.
  # `collectDeclarations` +1: the rest-vec registration in the generator branch.
  # 2026-09-29 — cluster A, slice A11 groups 3/4. `compileObjectLiteralForStruct`
  # +1: the `argumentsBeforeDefaults` call (same wiring as the literals.ts line
  # grant above); the gate on the arguments-object setup changes in place.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  # 2026-09-28 — cluster H, slice H1. `emitToPrimitiveMethodExports` +2 and its
  # nested `emitDispatchForMethod` +2 (the same two lines, counted once per
  # enclosing function): `boxResult`'s branded-i32 arm, which boxes a
  # `toString`/`valueOf` returning a Symbol / boolean as that type instead of
  # the number its i32 is carried as. The decision itself is
  # `class-to-primitive.ts::brandedI32ResultBoxIdx`.
  - src/codegen/index.ts::emitToPrimitiveMethodExports
  - src/codegen/index.ts::emitDispatchForMethod
  # 2026-09-28 — cluster I, slice I7: `compileTailDispatch` +3 and
  # `compileClassBodiesInner` +2 (both already listed below, restated per the
  # stranded-grant rule), `compileBoundIdentifierCall` +2 (NEW entry). Same
  # wiring as the slice's `loc-budget-allow` grant: the IIFE admission arm, two
  # multi-line `emitArgumentsObject` calls gaining their `formals` operand, and
  # the `__argc` publication in the rest-packing arm, which has to follow the
  # operand evaluation it sits in.
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
  # 2026-09-28 — cluster A, slice A6: `buildNativeGeneratorPlan` +67 as the gate
  # measures it against `origin/main` @ `8273bc388e` (path already listed below,
  # restated per the stranded-grant rule). Every piece reads or writes this
  # function's closure state, so none can move behind a seam: `lowerNestedOrRefuse`
  # and `yieldOperandHoldsYield` (called from the return arm and arms 1/2; they
  # use `nestedYields`, `fail`, `nestedHost`, `stateFinallyDepth`), the widened
  # `nestedHost` (`attachContinuationReplacements(curId, …)`, a `return`
  # terminator via `finishState` / `startState`), the three arm hooks, and
  # `continuationSentSpill` (`linearHost.spill` / `continuationSpillName`) with
  # the relaxed carrier check it serves. The walker changes are in
  # `generator-yield-nested.ts`.
  # 2026-09-28 — cluster A, slice A7. `ensureNativeGeneratorResumeFunction` +2:
  # one call line (`bindNamedExpressionOwnName`) and its spacing, placed after
  # the param copy / capture rehydration (so the `__self` local exists) and
  # before the body compiles; the binder itself is a separate 13-line function.
  # `closures.ts::compileLiftedClosureBody` +11 (path already listed below,
  # restated per the stranded-grant rule): the parameter-shadow check on the
  # self registration and the unregister before `hoistVarDeclarations` — the
  # only point between the parameter prologue and the body hoist.
  # 2026-09-29 — cluster A, slice A12: `ensureNativeGeneratorResumeFunction`
  # +6 (the parameter-copy loop records each writable parameter's local index
  # for the store-back, plus the reconcile call) and
  # `registerNativeGenerator` +4 (the writable-parameter scan and the field's
  # `mutable:` flag). Both functions own the data they write — the frame
  # struct and the resume prelude; the scan and the reconcile are the leaf
  # `generator-param-writeback.ts`. (`registerNativeGenerator` is already
  # listed further down.)
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
  # 2026-09-28 — cluster A, slice A5: `buildNativeGeneratorPlan` +40 as the gate
  # measures it (path already listed below, restated per the stranded-grant
  # rule). Four pieces, each writing this function's own closure state and so
  # unable to move behind a seam: the `nestedHost` adapter (it wraps
  # `linearHost.suspend`, `captureContinuationOperand` and pushes onto
  # `curStatements`), the arm-2a call in `lowerStatements`, the for-of chain
  # admission in `emitYield` (it sets `curAbrupt` / `curUnwind`), and the
  # inner-body map `nativeGeneratorDelegationName` fills for the gate. The
  # planner itself lives in `generator-yield-nested.ts`, the gate predicate in
  # `generators-native-ast-scan.ts`. `compileState` SHRINKS (the D2 block moved
  # into `emitDelegateCloseForward`).
  # 2026-09-26 — lane SC1: `buildNativeGeneratorPlan` +15 as the gate measures it
  # (path already listed below, restated per the stranded-grant rule), of which 9
  # are the comment
  # stating §10.2.11's step 20 → step 28 `varEnv` rule and why the spill is typed
  # `externref` and undef-widened. The code is a 5-line `for` that registers the
  # eval-introduced names exactly as the destructuring-param loop 80 lines above
  # registers pattern bindings, and it cannot move behind a seam for the same
  # reason that loop cannot: it writes three collections that are locals of this
  # function and are read by its own spill-typing pass further down. The collector
  # it calls, and the whole argument, live in `direct-eval-environment.ts`.
  # 2026-09-26 — lane SP1, STRANDED-GRANT RESTATEMENT ONLY, not new growth.
  # `src/codegen/object-runtime.ts::fillClosedStructExternGetArms` is 539 > 519
  # (+20) on `origin/main` as of this branch's base; the growth landed with
  # another lane's PR and its rationale lives in that lane's issue file, which
  # this change-set does not modify. SP1 does not touch `object-runtime.ts` at
  # all (its diff is `closure-prototype-edge.ts` + one new test file), and the
  # merge-base run of `check-func-budget` is clean — the breach appears ONLY
  # under `LOC_GATE_BASE=origin/main`, i.e. CI's merge-preview base. Restated
  # here per the stranded-grant rule so the gate can see the allowance from a
  # file this change-set does touch. Remove once main's post-merge baseline
  # refresh absorbs it.
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
  # 2026-09-26 — lane GEN1: `destructureParamArray` +20 (path already listed
  # below, restated per the stranded-grant rule). The growth is the one arm of
  # this function's tuple-struct lane that chooses the recursion's element type,
  # and it cannot move behind a seam: the arm READS `fieldType` and `element`
  # from the loop it sits in, and the correction is precisely which of the two
  # types the recursion is given. The predicate it consults
  # (`patternBindsRestAtAnyDepth`) and the whole WAT-verified rationale live in
  # `src/codegen/tuple-rest.ts`. Splitting the function is out of this slice's
  # scope and would move code the slice does not otherwise touch.
  # 2026-09-26 — lane SG1. Three functions, +1 line each — the minimum a
  # prepend-an-arm phase and one extra argument can cost.
  #   - `tryStaticEvalInline` +1: the reflowed
  #     `foldedEvalLowerLexicalCollision(..., expr)` call. The predicate itself
  #     moved OUT of this file into `direct-eval-environment.ts`; this is the
  #     argument that reaches it.
  #   - `generateModule` / `generateMultiModule` +1 each: the single
  #     `prependNativeGeneratorResultPrototypeArm(ctx)` finalize call, beside the
  #     `prependIterRecPrototypeArm` it mirrors. It has to be in both, or a
  #     multi-module compile keeps answering `null` for an iteration result.
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # 2026-09-26 — lane C1 (§15.7 own `constructor`). One function, +12 lines, of
  # which 6 are comment: `compilePropertyIntrospection` gains the single `if`
  # that admits `"constructor"` into its own-key sets. The predicate itself is a
  # new leaf module (`class-ctor-own-key.ts`, ~75 lines, mostly the spec citation
  # and the measurement that overturned the old answer), so what is left here is
  # the call. It cannot move further out: `tsProps` and `nonEnumerableTsProps`
  # are function-local, built by the walk immediately above and read by the fold
  # immediately below, so the decision "this receiver also owns `constructor`"
  # has to sit between them. The first cut inlined the rule and cost +51.
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  # 2026-09-26 — lane TA1 (`toLocaleString`'s number element). Three functions,
  # +20 lines, every one of them a call site of mechanism that lives in the new
  # leaf `to-locale-string-element.ts`:
  #   - `compileReceiverMethodCall` +11: the reserve at the zero-argument
  #     `toLocaleString` arm, the by-name re-resolve of `toLSIdx` the reserve's
  #     late imports force (#2043), and the six comment lines recording that this
  #     receiver shape is DISJOINT from the join lowering — the fact whose
  #     absence made the first cut of this slice a measured no-op on all 10 rows.
  #   - `generateModule` +6 / `generateMultiModule` +3: the two finalize fill
  #     calls each, beside `fillArrayToPrimitive`/`fillClassToPrimitive`. A fill
  #     must run at finalize (the seeder registry is not final before then) and
  #     finalize ordering is the driver's.
  # `compileArrayJoinNative` also grew (+11) and is within its own ceiling.
  # 2026-09-26 — lane R1 (`__getPrototypeOf`'s array arm). Three functions, +4
  # lines total, all of them call sites of mechanism that lives elsewhere:
  #   - `buildObjectPrototypeHelpers` +2: one line reserving the
  #     `%Array.prototype%` singleton (`reserveArrayProtoSingleton`) and one
  #     `...arrayGetPrototypeArm(...)` spread inside `__getPrototypeOf`'s
  #     non-`$Object` else-arm. Both helpers are module-level functions in the
  #     same file; the first cut inlined them and cost +9. What cannot move is
  #     the spread itself — the arm has to be ordered relative to the fnctor arm
  #     and the boundary fallback, and that ordering IS the body being built.
  #   - `generateModule` +1 / `generateMultiModule` +1: the finalize-time
  #     `fillArrayProtoSingleton(ctx)` call, one line each, beside its
  #     `fillObjectProtoSingleton` twin (see the loc grant above).
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  # 2026-09-26 — lane RF1: the same two wiring sites as the `loc-budget-allow`
  # grant above, and the same reason. `ensureProxyRuntime` +2 (one call, one
  # blank line) and `compileNamespaceStaticCall` +9 (the proxy dispatch arm).
  # Both host functions are ALREADY far past the 300-line rule (2588 and 3740)
  # — splitting them is a pre-existing consolidation task (#3399), not
  # something a 4-row conformance slice can carry. The extraction that WAS
  # available was taken: the 130-LOC native body moved to a new module, cutting
  # `ensureProxyRuntime`'s growth from +114 to +2.
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  # 2026-09-24 — lane W1: +24 inside `src/runtime.ts::resolveImport`, which is
  # the same 24 lines as the `loc-budget-allow` grant above (the three edited
  # host-import bodies are all closures built inside `resolveImport`'s by-name
  # switch). Splitting is not available here: each `if (name === "…")` arm
  # closes over `deps`/`callbackState`/`globalSandbox`, and moving one out
  # means threading that whole environment through a new signature — far more
  # than 24 lines, for arms that shrank to a single changed condition.
  - src/runtime.ts::resolveImport
  # 2026-09-23 — cluster F slice F4: +27 inside `compilePropertyAssignment` —
  # the WRITE arm plus the `__proto__` exclusion and the measurement that
  # forced it (see the LOC rationale above; the exclusion is the one thing
  # this slice regressed and then closed, so it is recorded at the clause).
  # And +4 inside `compileElementAccess`, which is
  # the WHOLE arm — a three-line call to `tryProxyReceiverElementRead` plus its
  # pointer comment. The mechanism, the measurements and every line of
  # rationale live in the NEW leaf `src/codegen/proxy-receiver-generic-read.ts`
  # (the first cut inlined them here and cost +28 / +44, and pushed the dot
  # twin `compilePropertyAccess` over the 300-line threshold for the first
  # time; extracting brought that one back under budget entirely). What cannot
  # move is the call itself: the decision "this receiver is a proxy, so do not
  # read the target's native representation" has to be taken BEFORE the
  # vec/index arms below, and those arms are what it overrides. The extraction
  # was verified byte-neutral — all 30 binaries of the 15-program dual-target
  # corpus are identical before and after it.
  - src/codegen/property-access.ts::compileElementAccess
  # 2026-09-24 — cluster I slice T1 (tagged templates, §13.2.8): +17 inside
  # `compileTaggedTemplateExpression`. Two module-scope extractions were taken
  # FIRST rather than grant the first number the gate reported (+37): the
  # receiver admission moved to `planTaggedTemplateReceiverBind` in
  # `object-literal-method-receiver.ts`, beside the `obj.m()` / `obj["m"]()` /
  # `obj[k]()` twins whose refusals it inherits, and the two publish arms
  # collapsed onto one `publishTagCallArguments` entry point in
  # `tagged-template-arguments.ts`. What cannot move is one line per arm: the
  # tagged-template lowering has THREE call sites (signature-matched closure,
  # dynamic closure, `__tagged_template` host bridge) and §10.2.1.2's receiver
  # must be installed after that arm's own arguments and restored after its own
  # call, so the install/restore pair is per-arm by construction. The rest is
  # the plan + capture at the head of the fallback block and the three
  # `finishObjectLiteralMethodCall` returns. Measured: +2 rows on BOTH targets
  # (`member-expression-context.js`, `member-expression-argument-list-
  # evaluation.js`), 0 lost over a 273-row two-lane sweep; 5 of 190 corpus
  # programs move, all under `tagged-template/`.
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  # 2026-09-23 — cluster D slice D2b: `compileNamespaceStaticCall` +4, the
  # dispatch line described under the LOC grant (dynamic-iterable all/race →
  # `emitStandalonePromiseCombinatorDrive`, with the legacy drain as fallback).
  # The key is already listed below.
  # 2026-09-23 — cluster G, slice G2: `compileForOfAssignDestructuring` +4, the
  # four one-line `emitHoleBoundaryBeforeDefault` calls. Each has to follow the
  # specific `array.get` whose value the next line's default test reads; the
  # reads are inline in this function's vec arm, so the calls are too.
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
  # 2026-09-23 — cluster E, slice E5: `compileBuiltinStaticCall` +8 (the
  # externref-element ToNumber in the static `<TA>.from(src)` loop, see the LOC
  # grant) and `tryIdentifierNamespaceAndStaticReceiverRead` +6 (the one arm
  # that answers `Int32Array.from` / `.of` with the inherited `%TypedArray%`
  # singleton before the generic static-closure ladder, which would otherwise
  # fall to the expando read and answer `undefined`).
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  # 2026-09-23 — cluster F slice F3: +13 inside `compileObjectDefineProperty`,
  # the same comment-dominated one-line change as the LOC grant above. The
  # function is already 1.5k lines of §19.1.2.4 arms in a fixed spec order, and
  # the admission this slice widens (`isProxyReceiver`) is the FIRST of them —
  # splitting it out would move the proxy decision away from the null/array/
  # accessor arms it is ordered against, which is precisely what the
  # surrounding comment warns about. A split of this function is a refactor of
  # its own, not part of a measured behaviour fix.
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  # 2026-09-23 — cluster I slice I3: `emitStringProtoMemberBody` +4 (3 comment,
  # 1 dispatch line) for the `substr` member — same grant, same reason as the
  # LOC entry above. The function is a flat routing ladder, one arm per String
  # prototype member; splitting it to absorb a fourth line of an existing family
  # would scatter the routing this gate exists to keep in one readable place.
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  # 2026-09-23 — cluster H slice H3: the same +11 as the LOC grant above, all of
  # it inside this one finalize pass. See that rationale — the splice position
  # is the behaviour, so the arm cannot be hoisted out of the pass without
  # first parameterising its closure.
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  # 2026-09-23 — cluster H slice H2: the same +153 as the LOC grant above, in
  # the same four arms. `fillVecOverlayHelpers` is one long FINALIZE pass that
  # fills each reserved native's body in turn; every arm this slice adds is a
  # continuation of a guard built from that pass's own closure, so the split
  # that would satisfy this gate is the `vec-symbol-key-overlay.ts` extraction
  # named in the LOC rationale — a refactor, not part of a behaviour fix.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  # 2026-09-24 — cluster I slice I5: `compileIIFE` +2 (315 > 313). The whole
  # mechanism — the `super`-in-body test, the enclosing-class resolution and the
  # synthetic `this` capture — was extracted VERBATIM into the module-scope
  # `adoptLiftedIifeSuperContext` (the inline first cut cost +33), and the
  # extraction is proven byte-neutral: all 50 host-lane binaries of the
  # `website/playground/examples` + `tests/fixtures` corpus hash identically
  # pre- and post-extraction (`.tmp/6651/hash-{after,postextract}.json`), and the
  # six-row standalone measurement is unchanged across it. What cannot move is
  # the call itself: it must MUTATE `captures` before `captureParamTypes` /
  # `allParamTypes` / `addFuncType` read that array — one line — and its result
  # must land on the lifted `FunctionContext` literal — the second line.
  - src/codegen/expressions/calls.ts::compileIIFE
  # (see coercion-sites-allow below for slice B2's other gate grant)
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
# 2026-09-21 — cluster A, slice A2. `compileState` +5: the whole emitter for the
# new `for-of-step` terminator lives in its OWN top-level `emitForOfStepState`
# (the shape `emitGenericDelegationState` already established); what is left in
# the god-function is the four-line dispatch arm that names it. A terminator
# kind cannot be dispatched from anywhere but the terminator switch.
  - src/codegen/generators-native.ts::compileState
# 2026-09-21 — cluster C, slice C3 (the f64-typed defaulted parameter).
# The MECHANISM is three functions in `src/checker/type-mapper.ts`, the module
# that already owns every other parameter widening, plus the read guard in the
# 99-line leaf `strict-eq-stale-type.ts` — neither is a god-file. What is left
# is four irreducible LOWERING SITES: `class-bodies.ts` +10 (the signature and
# fctx-build phases, which MUST agree or the module is invalid Wasm, not merely
# wrong), `declarations.ts` +7, `destructuring-params.ts` +5 (one delegation
# that carries the closure and all three object-literal-method twins with it)
# and `identifiers.ts` +1 (the guard's call). A parameter widening cannot move
# behind a seam by construction: `isUndefinedDefaultOnlyParam`'s own doc
# requires every site that lowers a parameter list to apply it identically, so
# the decision has to be readable at each list. The growth is ~80 % comment for
# the same reason the neighbouring #5221/#5360 widenings are — each site is
# where a future reader will ask why this parameter is not a scalar.
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
# 2026-09-21 (cluster F) — the three new `__is_truthy` calls are not a
# hand-rolled coercion matrix. Each is literally the spec's ToBoolean on a
# [[SetPrototypeOf]] / [[PreventExtensions]] success bit (§28.1.14 step 4,
# §28.1.11 step 2), and each calls the SAME shared `__is_truthy` native that
# the neighbouring `Reflect.defineProperty` arm and the six #6494/#5316 proxy
# front guards already use to read exactly this kind of booleanish trap result.
# This makes the `Reflect` arms agree with one another rather than introducing
# a second rule — the same argument #6494 recorded for its own three.
# 2026-09-21 (cluster E, slice E2) — the two coercion-vocabulary growths are a
# MOVE and a spec correction, not a fresh matrix.
#   - `ta-dyn-own-keys.ts` (+`number_toString`, +`__str_to_number`): the
#     §7.1.21 CanonicalNumericIndexString round-trip and the index→key
#     ToString. Both are verbatim the pair `ta-dyn-mop.ts` already uses for the
#     same question on the same receiver; the count appears in a new file only
#     because the own-key emitter lives there instead of in a god-file at its
#     ceiling. `ta-dyn-mop.ts`'s narrower `__object_keys` arm — which used the
#     same pair — is DELETED in this change-set.
#   - `ta-dyn-mop.ts` (+`__to_primitive` ×2): this one REMOVES a hand-rolled
#     shortcut. `__ta_dyn_set_elem` called `__unbox_number` directly, which
#     answers NaN for an ordinary object without ever running its `valueOf` —
#     so §10.4.5.16 step 1's observable ToNumber never happened. Routing
#     through the shared `__to_primitive` native (hint "number") before the
#     unbox is the coercion ENGINE doing the work, which is what this gate is
#     protecting; the two sites are the value operand and its hint string.
# 2026-09-21 (cluster B, slice B2) — four sites in the new
# `regexp-exec-protocol.ts`, and the gate is counting two different things.
#   - `__extern_toString` ×2 — §22.2.6.12 step 3 and §22.2.6.8 steps 3-4,
#     literally "S = ? ToString(string)" and "flags = ? ToString(? Get(rx,
#     "flags"))". They are the SAME shared native that `array-tolocalestring.ts`
#     and `array-like-native.ts` already use for §7.1.17 on an arbitrary value,
#     so this is the existing spelling rather than a new matrix. It is also the
#     only spelling that keeps the operation ONCE: the result is a String VALUE
#     that is then handed unchanged to a user-supplied `exec`, and routing it
#     through `coerceType` to a native-string GC ref would force a re-box on the
#     way out — a second coercion opportunity, which `coerce-string-err` and
#     `flags-tostring-error` exist precisely to catch.
#   - `__unbox_number` ×2 — NOT a coercion. Both operands are already proven to
#     be numeric zeros by the preceding `__same_value_zero`; the unbox only
#     reads the sign so §7.2.10 SameValue can separate `-0` from `+0`, which
#     `set-lastindex-init-samevalue` and `set-lastindex-restore-samevalue`
#     measure. No value is converted from one type to another.
# 2026-09-21 — cluster D, slice D2: `emitStandalonePromiseCombinatorRuntime`
# gains the observable branch (+28) — the admission test plus the delegation to
# the observable runtime emitter. The pipeline itself is in new module-level
# helpers, not in this function.
  - src/codegen/promise-combinators.ts::emitStandalonePromiseCombinatorRuntime
# 2026-09-21 — cluster C, slice C3b. The two host functions of the grants above:
# `compileTailDispatch` +9 (two save/restore pairs, one per IIFE-inline arm) and
# `compileIdentifierCall` +17 (the mirrored parameter widening at the point the
# wrapper signature is built). See the loc-budget rationale for why neither can
# move.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
# 2026-09-21 (cluster E, slice E3). `compileElementAssignment` +15 and
# `ensureObjectRuntime` +12 (the latter restated from #5197's file so the grant
# is not stranded). Both are the same irreducible-call-site argument as the LOC
# grants above: an element-assignment routing decision has to be made inside the
# element-assignment dispatcher, and a reserved native's funcIdx has to be
# minted inside the function that bakes the `call` to it.
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/object-runtime.ts::ensureObjectRuntime
# 2026-09-21 (cluster C, slice C3) — three functions, +11 lines total, all of
# them the same one-line call plus the comment that says why the lane it sits
# in must agree with the other eleven. `collectClassDeclaration` (+5) and
# `compileClassBodiesInner` (+2) are the constructor/method SIGNATURE and
# fctx-build twins: a disagreement between those two is invalid Wasm, not a
# wrong value, so the pairing note has to be readable in both.
# `compileIdentifierCore` (+4) is the READ half — the narrowing gate is one
# boolean chain and the new refusal cannot be expressed anywhere else.
# The other two (+2 each) are the two derivations a MEASURED regression forced
# in after the first sweep: `ensureStructForType` holds the object-literal
# method pre-registration #5221 names as a twin of `literals.ts`, and
# `compileFunctionBody`'s fallback resolve is the body half of a signature it
# would otherwise contradict. Both are one call plus the reflow prettier
# requires; the marked@18 UMD bundle went from compiling to an "ABI changed
# after reservation" internal error without the second one.
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/index.ts::ensureStructForType
# 2026-09-21 (cluster E, slice E2) — the one new `number_toString` is not a
# hand-rolled ToString. It is §10.4.5.6 step 4's `! ToString(𝔽(i))` over an
# integer index the arm has just produced itself, and it is the SAME call the
# two sibling own-key producers already make for the same purpose: the
# `__object_keys` dyn-view arm (`ta-dyn-mop.ts`) and the generic `$__vec_base`
# arm (`vec-overlay-keys.ts::fillGopnVecArm`). Routing it anywhere else would
# make the three key producers disagree about how an index becomes a key.
  # (#6651 E4, 2026-09-22) +6 over the 1300 ceiling — see the E4 note above the
  # `loc-budget-allow` list: the arm BODY is in `ta-static-from-of-body.ts`, and
  # what is left here is one `unshift` call plus the four lines explaining why
  # it is a separate arm from the `$__ta_ctor` one directly above it.
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
# 2026-09-23 — cluster B, slice B5: `tryConstructorPrototypeIdentity` +3 — the
# one call (plus its comment) described under the LOC grant above. The
# mechanism, its gate and its receiver compile are all inside
# `regexp-split-protocol.ts::tryEmitRegExpOwnConstructorRead`.
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
  # 2026-09-23 — cluster C slice C4: `destructureParamArray` +4, the call arm
  # for a non-rest element past the tuple's width (see the loc rationale). It
  # has to sit inside the tuple-struct loop: that loop is the only code that
  # holds `tupleDef.fields.length`, and the old `break` it replaces was there.
  - src/codegen/destructuring-params.ts::destructureParamArray
  # 2026-09-23 — cluster B slice B6: `ensureDynamicStandaloneRegExpCompiler` +2,
  # one `i32.const 0` in each of its two `struct.new $NativeRegExp` sites for
  # the carrier's new `$lastIndexNonWritable` field. A struct.new must list every
  # field, so the growth cannot live elsewhere. `generateModule` +2 /
  # `generateMultiModule` +1 (both listed above) are the one finalize call each
  # to `installRegExpLastIndexCarrierArms`, placed between the B4 accessor arm and
  # the proto-cache arm.
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  # 2026-09-23 — cluster G, slice G3: `compileArrayDestructuringAssignment` +9
  # (the non-tuple-struct route to the externref GetIterator path; it has to
  # precede the tuple field reader in this function) and
  # `compileElementAccessBody` +5 (the `$AnyValue`-element hand-off at the vec
  # OOB-widen site, see the loc rationale above).
  - src/codegen/expressions/assignment.ts::compileArrayDestructuringAssignment
  - src/codegen/property-access.ts::compileElementAccessBody
  # 2026-09-23 — cluster A slice A3: `compileLiftedClosureBody` +5 and
  # `compileArrowAsClosure` +2 — the generator tests in both now also accept an
  # object-literal generator METHOD admitted by `isNativeGeneratorMethodClosure`
  # (the open-`$Object` literal lane), in place, because those tests are what
  # decide native-factory vs plain closure. `compileBuiltinStaticCall` +10 is the
  # `getPrototypeOf(<generator value>)` arm and `registerNativeGenerator` +7 the
  # closure-lane method's `this` snapshot (see the LOC grant).
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/closures.ts::compileArrowAsClosure
# 2026-09-23 — cluster A slice A4: `compileState` +14 (the `branch-flag`
# terminator arm and the one-line op-marker dispatch in the prelude loop) and
# `buildNativeGeneratorPlan` +102 (the `LinearizeHost` adapter, the statement
# arm, the linearised-spill typing and the any-array spill fallback, plus the
# binary / template continuation roots). The adapter must close over the
# builder's private cursor, so it cannot leave the function; the planner itself
# is in `generator-yield-linearize.ts`.
  # 2026-09-24 — cluster E slice E7: `emitTaDynCtorConstructFromLocals` +17 —
  # the callable disjunct of the object-arm guard (see the loc rationale). The
  # guard is built from locals only this function holds (the peeled candidate
  # and the iterable prelude that owns `__typeof_function`). `generateModule` +3
  # and `compileReceiverMethodCall` +4 are listed above.
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructFromLocals
  # 2026-09-27 — cluster G, slice G4: five functions, call sites only (the
  # mechanisms are in the three new G4 leaves; see the loc grant above).
  # `compileForOfIterator` +15 (prime the cached `next` into a loop local, swap
  # the step call — both must be in the function that owns the loop's locals and
  # its try/close structure), `compileArrayDestructuringAssignment` +7 (the
  # non-iterable throw inside the G3 struct branch), `compileForOfArray` +5 (the
  # overlay-routed `Get(array, i)` arm, resolved before the body swap),
  # `fillNativeIteratorLateArms` +2 (the fill hook beside the OBJ deps it
  # consumes), `compileForOfAssignDestructuringExternref` +1 (the Symbol guard).
  - src/codegen/statements/loops.ts::compileForOfIterator
  - src/codegen/statements/loops.ts::compileForOfArray
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  # 2026-09-28 — cluster D slice D3: `compileNamespaceStaticCall` +3, the one
  # class-receiver dispatch line described under the LOC grant
  # (`tryEmitClassReceiverCombinatorCall`). Key already listed below.
  # 2026-09-28 — cluster D slice D4: `compileHostInstanceOf` +2 (the standalone
  # Promise-subclass `instanceof` arm — its body is `tryEmitPromiseSubclassInstanceOf`
  # in the new leaf), `compileSuperCall` +1 (the bag-link call after the explicit
  # `super(executor)` Promise arm), `compileClassBodiesInner` +16 (the implicit
  # Promise-constructor arm, see the LOC grant) and `compileNamespaceStaticCall`
  # +3 (the settle dispatch). The last two keys are already listed below.
  - src/codegen/expressions/identifiers.ts::compileHostInstanceOf
  - src/codegen/class-bodies.ts::compileSuperCall
  # 2026-09-28 — cluster B, slice B10: `compileDeclarations` +1 — the single
  # `mintUntypedRegExpReceiverMembers(...)` call at the top of its nested
  # `compileModuleInitBody`, the one codegen point every source file reaches with
  # a `FunctionContext` (mechanism in the new leaf `regexp-untyped-receiver.ts`).
  - src/codegen/declarations.ts::compileDeclarations
  # 2026-09-28 — cluster C, class-object expando cells: `generateModule` +1 and
  # `generateMultiModule` +1 — the one `fillClassObjectExpandoArms(ctx)` finalize
  # call at each entry point, beside `fillClassObjectNameArms` (both entries
  # already listed below). Mechanism: `src/codegen/class-object-expando.ts`.
  # 2026-09-28 — cluster D slice D5: `compileExpressionInner` +1 (the one-line
  # `notePromiseDynamicMemberRead` source hook — see the LOC grant) and
  # `tryLengthAndNameReads` +1 (the `?? promiseProtoMemberSpecLength(…)` spec-length
  # fallback; the statement only wraps onto a second line). Bodies are in the new leaf.
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  # 2026-09-28 — cluster A, slice A9 (`%GeneratorFunction%` in standalone;
  # record under the A9 claim). `compileCallExpression` +1: the
  # `?? tryEmitDynamicGeneratorFunction(…)` hand-off beside the runtime-eval
  # boundary intrinsic it sits with. `compileNewExpression` +4: the same
  # hand-off for `new %GeneratorFunction%(…)`, and the `new g()` TypeError arm
  # learning that a binding initialised by such a call holds a generator
  # (§27.3.4). The lowering, the claim and its run-time guard live in the new
  # leaf `src/codegen/generator-function-dynamic.ts`.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
  # 2026-09-28 — cluster A, slice A9: `buildIteratorNextBody` +14, all of it the
  # `...decode()` splice after the four `done`/`value` reads of the OBJ and
  # strict-OBJ steps (and the one-line `locals` parameter it needs). The four
  # reads are inline instruction arrays that already exist; the decoder itself
  # is `readDecoder`, beside `ObjCarrierDeps`. `fillNativeIteratorLateArms` +6
  # (path already listed below, restated): the `decodeRead` field of the OBJ
  # deps it builds, and passing each rebuilt function's own `locals`.
  - src/codegen/iterator-native.ts::buildIteratorNextBody
coercion-sites-allow:
# 2026-09-26 — lane TA1: `to-locale-string-element.ts` is a NEW file, so its
# baseline is 0 and every textual mention of a native name counts as growth
# (the gate is a name scan, and most of these 8 occurrences are in the module
# header's prose). The module hand-rolls no conversion matrix at all: it CALLS
# the engine's existing providers — `number_toString` for §23.1.3.32's
# unpatched numeric element (the very native `compileArrayJoinNative`'s numeric
# arm already emits, reused verbatim so the `(f64) -> externref` ABI matches)
# and `__extern_toString` for §7.1.17 ToString of the `Invoke(element,
# "toLocaleString")` RESULT plus the non-dyn-view receiver fallthrough. Both
# helpers are minted at FINALIZE (the seeder registry is only final once
# `ensureObjectRuntime` has flushed), where there is no `FunctionContext` to
# route through `coerceType`. Net effect on total coercion vocabulary is
# reuse, not a second matrix.
  - src/codegen/to-locale-string-element.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/ta-dyn-own-keys.ts
  - src/codegen/regexp-exec-protocol.ts
  - src/codegen/ta-dyn-own-property-names.ts
# 2026-09-21 — cluster B, slice B4: `regexp-accessor-get-arm.ts` gains
# `__is_truthy` ×2 (`+2` net). Both are §22.2.6.4's ToBoolean, and `__is_truthy`
# IS the engine's ToBoolean for an arbitrary externref — the same call
# `new Boolean(x)` and every array HOF predicate make (#2915). One is inside the
# eight-step generic getter, one is its resolution guard. Routing through
# `coerceType` is not available here: the value is a `[[Get]]` RESULT that must
# be tested without being converted, and the native is emitted at FINALIZE where
# no `FunctionContext` exists to coerce into.
  - src/codegen/regexp-accessor-get-arm.ts
# 2026-09-23 — cluster I, slice I2: `native-dynamic-instanceof.ts` gains
# `__is_truthy` ×1 (`+1` net). It is §13.10.2 step 4.a's ToBoolean, written in
# the spec as `ToBoolean(Call(instOfHandler, C, «O»))`, and `__is_truthy` IS the
# engine's ToBoolean for an arbitrary externref — the same call every array HOF
# predicate makes (#2915). `coerceType` is not available here: the value is the
# handler's RETURN value, which must be tested without being converted, and the
# `__instanceof_operator` native is built with no `FunctionContext` to coerce
# into. Measured coverage: `symbol-hasinstance-to-boolean.js` exercises nine
# return values (undefined / null / true / NaN / 1 / "" / "string" / a symbol /
# an object) through this one call.
  - src/codegen/native-dynamic-instanceof.ts
# 2026-09-23 — cluster B, slice B5: `regexp-split-protocol.ts` names
# `__to_primitive` ×1 and `__unbox_number` ×1. Neither is a new matrix: it is
# the canonical standalone ToNumber provider set, obtained from
# `prepareStandaloneExternrefToNumberProviders` (the fused `__to_number` when
# fusion is enabled; the `[__to_primitive(v, "number"), __unbox_number]` pair is
# only the fallback when it is not) — the identical chain B3's §22.2.6.8 loop
# uses in `regexp-exec-protocol.ts`. The three sites it feeds are the spec's
# ToUint32(limit), ToLength(Get(splitter, "lastIndex")) and
# LengthOfArrayLike(z), each on a value a user object supplied, and each must
# run `valueOf`/`@@toPrimitive` with hint "number"
# (`str-coerce-lastindex`, `str-result-coerce-length`, `coerce-limit-err`).
  - src/codegen/regexp-split-protocol.ts
# 2026-09-23 — cluster B, slice B5b: `regexp-replace-protocol.ts` names the same
# `__to_primitive` ×1 / `__unbox_number` ×1 fallback pair as
# `regexp-split-protocol.ts` above, for the same reason (the canonical provider
# set from `prepareStandaloneExternrefToNumberProviders`; the fused
# `__to_number` when fusion is on). Its sites are §22.2.6.11's
# ToLength(Get(rx, "lastIndex")), LengthOfArrayLike(result) and
# ToIntegerOrInfinity(Get(result, "index")) — each on a user value whose
# `valueOf` / `@@toPrimitive` must run with hint "number"
# (`result-coerce-index-undefined` asserts the hint).
  - src/codegen/regexp-replace-protocol.ts
# 2026-09-23 — cluster E, slice E6: `object-runtime-ordinary-set.ts` names
# `__str_to_number` / `number_toString` ×1 each and `__to_primitive` /
# `__unbox_number` ×1 each (+4 net). The first pair IS §7.1.21
# CanonicalNumericIndexString (`ToString(ToNumber(P)) === P`), the same
# round-trip `ta-dyn-mop.ts`'s `keyIsCanonical` spells — duplicated rather than
# shared because the static-carrier arm must also install in a module with no
# dyn view, where that builder never runs. The second pair is §10.4.5.16 step 2
# ToNumber(value) for a static `Int32Array` receiver, the pair
# `__ta_dyn_set_elem` already uses. All four run in a finalize-time native with
# no `FunctionContext` to coerce into. Same slice: `ta-dyn-mop.ts` +8 /
# `fillTaDynViewMopArms` +6 (the two fill calls and their comments),
# `dataview-native.ts` +38 (the post-coercion detach check and its two call
# sites inside the `fill`/`copyWithin` helpers it guards) and
# `call-namespace-static.ts` +2 / `compileNamespaceStaticCall` +1 (the one
# `noteReflectSetReceiverCall` line at the 4-argument `Reflect.set` site) and
# `array-methods.ts` +9 (the detached-view guard spliced into the native
# externref `join`, which has to sit between the separator's evaluation and its
# coercion) — all five paths/functions already listed above.
  - src/codegen/object-runtime-ordinary-set.ts
# 2026-09-24 — cluster E, slice E7: `ta-to-string.ts` names `__extern_toString`
# ×1 (one module constant, +1 net). It is not a new ToString: the helper FALLS
# BACK to exactly the call the `any`-receiver `x.toString()` site made before,
# after the detached-buffer check. It is a defined native with its own
# `FunctionContext`, so the fallback has to name the native it delegates to.
  - src/codegen/ta-to-string.ts
---

# #6651 — ES2015 standalone → 100%: cluster execution plan

**Why a new file.** #4444 is the umbrella and its 2,800-line log is the
history. This file is the *dispatchable* plan: one census, nine clusters with
frozen row manifests, one owner/model/effort per cluster, and a uniform
acceptance recipe. Progress notes go under "Cluster status" below; narrative
stays in #4444.

## Census (authoritative, 2026-09-20)

Source: `loopdive/js2wasm-baselines` `test262-standalone-current.jsonl`,
fetched `--force` 2026-09-20 19:28 UTC, internal timestamp 2026-09-20 17:39,
`oracle_version: 14`, `oracle_lane: honest`, 48,735 rows, baseline_sha
`9dc2fa2e`. Edition classification:
`website/public/benchmarks/results/test262-file-editions.json` (index of
`ES2015` in its `editions` array).

| ES2015 standalone | rows |
| --- | ---: |
| total | 11,704 |
| pass | **10,384** (88.7 %) |
| fail | 1,034 |
| compile_error | 286 |
| **gap to 100 %** | **1,320** |

Edition-ratchet floor (`scripts/test262-edition-ratchet-baseline.json`,
2026-09-04): 10,131 — the baseline above is +253 over the floor.

### Top error signatures across the 1,320

| rows | status | signature |
| ---: | --- | --- |
| 129 | CE | `standalone target emitted host imports: env::__create_generator, env::__gen_create_buffer, …` |
| 53 | CE | `native generator lowering currently supports only sequential numeric yields in standalone/WASI (#680)` |
| 79 | fail | `TypeError: Cannot access property on null or undefined` |
| 76 | fail | `Expected a TypeError to be thrown but no exception was thrown` |
| 47 | fail | `Expected a Test262Error to be thrown but no exception was thrown` |
| 42 | fail | `Expected a Test262Error but got a TypeError` |
| 48 | CE | `host imports: env::Promise_all / Promise_race / allSettled / any …` |
| 18 | fail | `Method called on incompatible receiver (RegExp brand check failed)` |
| 17 | fail | `Object.prototype.toString is not yet implemented in --target standalone` |
| 7 | CE | `host imports: env::Object_set_constructor` |
| 6 | CE | `standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget` |

## Clusters — manifests, owners, models

Every cluster has a frozen path manifest under `plan/agent-context/6651/`
(one `test/`-relative path per line, derived mechanically from the census
above — see the partition rule in the manifest generator note at the bottom).
A cluster is done when **every** row in its manifest passes on the isolated
standalone runner and the acceptance recipe below is met.

| # | cluster | manifest | rows | CE / fail | owner lane | model / effort | blocking dependency |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| A | Native generator lowering: non-numeric yields, `yield` in destructuring/class/object bodies, `yield*`, try/catch | `A-generators-standalone.txt` | 197 | 197 / 0 | senior-developer | Opus, **max** | none — this is the largest single lever; unblocks ~60 more rows in C/G that currently hit the same gate |
| B | RegExp `Symbol.{match,replace,search,split}` protocol, `flags`, `exec` override, Annex B RegExp, `String.prototype.{match,search,split,replace}` dispatch | `B-regexp-protocol.txt` | 147 | 11 / 136 | senior-developer | Opus, high | coordinate with #5198 (in-progress, drafts #5393/#6014, held #5996) — read its handoff first, do not duplicate the `lastIndex` reader work |
| C | Class / object-literal / `super` semantics: class-call TypeError, `new.target`, method descriptors, subclass constructor return, computed keys | `C-class-object-super.txt` | 177 | 6 / 171 | senior-developer | Opus, high | #5318 / #5350 in-progress; draft #5839 documents the object-literal `super` blocker #6420 |
| D | Native Promise combinators: `Promise.all/race/allSettled/any` for non-literal/iterable args, `then` residuals, subclass ctor | `D-promise-combinators.txt` | 101 | 48 / 53 | developer | Opus, high | held PR #5883 (observable combinator protocol) — read, do not re-implement |
| E | TypedArray / ArrayBuffer / DataView: species, detached checks, `object-arg` ctors, `toLocaleString`, internals `[[Set]]`/`[[DefineOwnProperty]]`/`[[OwnPropertyKeys]]` | `E-typedarray-buffers.txt` | 144 | 1 / 143 | developer | Opus, high | none (#5317 done) |
| F | Proxy / Reflect: invariant must-throw, `Reflect.construct` distinct NewTarget, trap receiver/realm args | `F-proxy-reflect.txt` | 89 | 5 / 84 | senior-developer | Opus, high | #6494 in-review; drafts #5400 (NewTarget design) / #5397 (Reflect.set receiver) |
| G | for-of / destructuring runtime residuals, generator prototype objects, `Iterator.prototype.{chunks,windows}` (ES2015-tagged via `generators`) | `G-forof-destructuring-iterators.txt` | 134 | 2 / 132 | developer | Opus, high | after A lands (≈20 rows here are generator-shaped fails) |
| H | Builtins misc: `Array.prototype.concat` (isConcatSpreadable, #6485), `slice/splice/map` species, `Object.prototype.toString` runtime tag (#4119 gap), `Function.prototype.{toString,bind,@@hasInstance}`, `Error.prototype.stack`, `Symbol.prototype.@@toPrimitive`, `__proto__` | `H-builtins-misc.txt` | 217 | 6 / 211 | developer | Opus, high | #6485 in-progress (concat) |
| I | Language misc: module namespace internals (12), `with` + unscopables, `eval` spread, TCO rows, global-code var collision | `I-language-misc.txt` | 114 | 10 / 104 | developer | Opus, medium | several rows are eval/with (see #1066); triage first, file wont-fix with reason where standalone cannot honour |

Rows: 197+147+177+101+144+89+134+217+114 = 1,320. The manifests partition the
gap exactly; no row is in two clusters.

### Dispatch order and concurrency

The container that produced this plan has 4 cores, so at most 3 clusters run
concurrently. Order by rows-unlocked-per-effort:

1. **Wave 1 (now):** A (generators), D (promise combinators), H (builtins misc).
2. **Wave 2:** E (typed arrays), C (class/object/super), B (RegExp).
3. **Wave 3:** F (proxy/reflect), G (for-of, after A), I (language misc).

Every owner first re-runs its manifest on its branch base to get a **measured**
before-state (never quote this file's counts as the before-state — a base
moved under you is the #2916/#4433 defect).

## Acceptance recipe (every cluster, no exceptions)

```bash
# 1. before-state on the branch base, isolated standalone runner
npx tsx scripts/run-test262-paths.mts plan/agent-context/6651/<cluster>.txt \
  --standalone --isolate > .tmp/6651/<cluster>-before.log 2>&1; echo $?
# 2. implement; keep .tmp/base copies of every edited file at first edit
# 3. after-state, same command → <cluster>-after.log; both logs are the receipt
# 4. neighbourhood regression control: the sibling directories of every row
#    you changed behaviour for (e.g. all of built-ins/Promise/** for D), host
#    (default target) AND standalone, before vs after — zero pass→non-pass
# 5. gates, chained, before the commit (never --no-verify)
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports && npx vitest run tests/equivalence.test.ts
```

- **No new host imports without a standalone fallback** (dual-mode rule).
  A cluster fix that converts a CE into a fail is progress only if the fail
  is a narrower, documented residual — record it.
- Growth allowances (LOC / func budget) go in this file's frontmatter, dated.
- Commits carry `Model:` and `Co-authored-by:` trailers per `AGENTS.md`.
- The owner writes its receipts (before/after counts, log paths, SHA of the
  manifest) under **Cluster status** below, not in #4444.

## Definition of done for #6651

- ES2015 standalone `pass == total` (11,704 / 11,704) on a full authoritative
  standalone run, or every remaining row has a `wont-fix` issue naming the
  spec-level reason (e.g. direct `eval` of dynamic text in a no-host target).
- `scripts/test262-edition-ratchet-baseline.json` ES2015 floor banked to the
  new number via `check:edition-ratchet:update` from a **full** run.
- #4444 gets a one-paragraph closing note pointing here.
- **Out of scope, 2026-09-23 (slice G2): 21 Iterator-helper-family rows.** The
  cluster-G manifest carries `built-ins/Iterator/prototype/chunks/**` (10),
  `built-ins/Iterator/prototype/windows/**` (10) and
  `built-ins/Iterator/prototype/join/not-a-constructor.js` (1), listed in
  `plan/agent-context/6651/G2-iterator-helpers-out-of-scope.txt` (sha256
  `4e2632f5…aa06e`). Their `features:` are `iterator-chunking` and
  `Iterator.prototype.join` — the first is post-ES2025 (it builds on the ES2025
  `Iterator` global and `iterator-helpers`), the second is still listed under
  the proposals in test262's own `features.txt`. None of it exists in ES2015;
  the edition index tags them ES2015 only because each also names `class` or
  `generators` in `features:`. They leave the gap arithmetic: the ES2015 target
  is `11,704 − 21 = 11,683` measurable rows plus these 21 recorded here. The
  frozen G manifest keeps them (measured 21/21 non-pass on 2026-09-23 under
  `quickjs`, standalone). Implementing them would be proposal work in a later
  edition's lane, not an ES2015 gap.

## Front-end feature ownership — claimed 2026-09-24

The standalone-reachable rows in clusters F, H and I are nearly exhausted. What
remains in cluster I is dominated by four SHARED front-end features, which block
the standalone and JS-host lanes alike. Measured from the cluster-I manifest
sweep on the round-6 integrated branch:

| family | rows remaining | owner |
| --- | ---: | --- |
| `language/expressions/tagged-template/` | 8 → **6** (slice T1, 2026-09-24: 2 closed on both lanes; the other 6 are named with their exact site in the T1 receipt at the end of this file) | **this thread (`claude/project-thread-yhj9pp`)** |
| `language/module-code/namespace/internals/` | 12 | **this thread (`claude/project-thread-yhj9pp`)** |
| `language/statements/with/` | 11 | **this thread (`claude/project-thread-yhj9pp`)** |
| `eval` capability rows (`language/expressions/call/`, `language/eval-code/`, `language/statementList/`) | ~10 | **this thread (`claude/project-thread-yhj9pp`)** |

**If you are an outside lane reading this: do not start any of these four.**
As of 2026-09-24 all four families are claimed by this thread, and #6651 carries
a live claim on `origin/issue-assignments` for
`ttraenkler/project-thread-yhj9pp`.

`with` and `eval` were held open for a JS-host lane until 2026-09-24. No such
lane was ever started in this project, so holding them open only stranded the
two largest remaining families. They are now this thread's, and the split
question is closed: there is one lane, and it takes all four.

Why the table exists: on 2026-09-21 three cluster slices (A2, C3, E2) were
implemented twice because two sessions worked this issue in parallel without
knowing about each other. A lane that has started but not yet pushed is
invisible to both the claim ref and the open-PR scan, so the only thing that
prevents a repeat is claiming a family *before* starting it.

Method note that applies to whoever takes which: **host-probe every candidate
row on the DEFAULT target before touching lowering.** A row that fails on host
cannot be fixed by standalone lowering. That check has now redirected five
separate lanes away from unreachable buckets, and it is how these four families
were identified as shared rather than standalone-only in the first place.

## Cluster status, handoffs and lane receipts 2026-09-20 → 2026-09-28 — moved to the log (2026-10-02, #6796)

These 47 sections were moved verbatim to
[`plan/agent-context/6651-log.md`](../agent-context/6651-log.md) to keep this issue file
readable (repo hygiene, #6796). Headings, in order:

- Cluster status
- Handoff — 2026-09-21 (round 1 closed, round 2 ready to dispatch)
- Handoff — 2026-09-21 (round 1 closed, round 2 ready to dispatch)
- Handoff — 2026-09-22, the project-thread lane (PR #6026) signs off
- Handoff — 2026-09-24, round 3 closed (this lane: B/C/D/E/G + claimed A)
- Handoff — 2026-09-24, session wrap-up (round 4 state: E8 + A5 suspended)
- Manifest generator note
- 2026-09-24 — lane A1: arguments object created BEFORE parameter defaults (§10.2.11 step 22)
- Handoff — 2026-09-24, lane-I6 (cluster I residual triage; measurement only, no source change)
- 2026-09-24 — lane H2 (`@@hasInstance` in `instanceof`): the slice was ALREADY LANDED; what I added instead
- 2026-09-24 — cluster I slice T1: tagged templates (§13.2.8), the first SHARED front-end family
- 2026-09-24 — cluster B1 slice N2: the six `namespace/internals` residuals N1 left, and which THREE of N1's root causes were wrong
- 2026-09-24 — lane W1: `with` / Object Environment Record (§9.1.1.2)
- Handoff — 2026-09-24, rounds 6–9 closed (the project-thread lane signs off)
- 2026-09-25 — lane N2 (namespace MOP residuals): THREE N1 attributions corrected, no fix landed
- Lane N3 receipt — nested module namespaces (`export * as ns from …`)
- Lane P1 receipt — `Proxy` bucket triage (2026-09-26)
- Lane N4 receipt — `export class` in a namespaced module; and why the
- `own-property-keys-binding-types` 7-vs-10 gap was never a compiler defect
- (2026-09-26)
- 2026-09-26 — lane X1: the ES2015 `cross-realm` bucket, triaged end to end
- Receipt — lane F1: `%Function.prototype%` members unreadable as VALUES in standalone (2026-09-26)
- Lane R1 receipt — the ES2015 cross-realm `proto-from-ctor-realm` rows are
- NOT a GetPrototypeFromConstructor defect. `Object.getPrototypeOf` over a
- DYNAMICALLY-typed array answered `null`. (2026-09-26)
- Lane S1 receipt — `$262.createRealm().global` intrinsic forwards (2026-09-26)
- Lane RF1 receipt — the ES2015 `Reflect` bucket, triaged end to end; and why
- it is not a `Reflect` bucket (2026-09-26)
- 2026-09-26 — lane C1 receipt: the `class` feature-tag bucket (66 rows)
- 2026-09-26 — lane TA1 receipt: the TypedArray feature-tag bucket, and `toLocaleString`'s element Invoke
- TA2 receipt — 2026-09-26 (TypedArray-tagged ES2015, standalone-only residual)
- Implementation Plan — standalone `$__IterRec.next()` substrate (2026-09-26)
- Lane SY1 receipt — the ES2015 `Symbol` feature-tag bucket, triaged end to end;
- the bucket has NO cause worth more than one row (2026-09-26)
- 2026-09-26 — iterator substrate, slices 3a + 3b (lane IT3)
- Lane GEN1 receipt — the ES2015 × `generators` feature-tag bucket, triaged end
- to end. One cause is worth 3 rows in the bucket (and 29 corpus-wide); the
- other 120 are near-singletons. (2026-09-26)
- Lane RS1 receipt — cross-bucket residuals, batched (2026-09-26)
- Lane SG1 receipt — generator singletons (2026-09-26)
- Lane SC1 receipt — the `scope-*param-*elem-var-close` family (2026-09-26)
- Lane SP1 receipt — species-constructor `this`, and the wrapper-prototype family (2026-09-26)
- Lane VR1 receipt — the value-representation half of the species-constructor cause (2026-09-27)
- Lane SN1 receipt — 2026-09-27 (three unrelated one-row causes, one control run)
- 2026-09-27 — the merge queue's `class/elements` cluster is PR #6175, not baseline drift
- Lane B18 receipt — three residuals: one fixed, two disproved (2026-09-27)
- 2026-09-28 — Dynamic TypedArray `subarray` detached-ordering lane

Owners still append new cluster records at the end of this file. The
2026-09-28 session wrap-up handoff and everything after it stay below.

## Handoff — 2026-09-28, session wrap-up (D6, D7, H1 landed; I7 in this PR)

Written at the user's "wrap up, handoff, open pr" (about 22:10 UTC). The goal
loop was cleared by the user at the same time. No slice is running; no
worktree holds unmerged work.

| slice | PR | result (standalone, QuickJS eval) |
| --- | --- | --- |
| D6 — Promise-subclass static read before its write inherits `%Promise%` | #6259, merged `38f959a0b3` | see D6 entry |
| D7 — `Promise.prototype.finally` invokes the receiver's `then` | #6272, merged `5f8b0b4529` | +8 in `Promise/prototype/finally/`, 0 lost |
| H1 — spec ToPrimitive/ToString for object arguments to `String.prototype.*` | #6278, merged `b52efdc91d` | reach set 1,420 → 1,427, 0 lost |
| I7 — `arguments` and rest parameters agree on the argument count | this PR | +2 (`rest-parameters/{arrow-function,with-new-target}`), 0 lost; 5 of the 7 dispatched rows were already fixed by lane A1 |
| QuickJS adapter cache keyed on compiler inputs | #6252, merged | harness fix |

I7 caveat: its final refactor was byte-checked on a 71-row subset, not the
full 374-row reach list (the earlier version was checked on all 374).

### Next levers (from the slice entries' residuals)

- **H2** — the H1 ToPrimitive walk through `+`, template literals, unary `+`
  and `String()`; non-literal object arguments; `{toString: null}` without an
  own `valueOf`.
- **D8** — the species step of `finally` (species/subclass-count rows,
  `-PromiseResolve` rows); `rejected-observable-then-calls` (4 of 5 entries).
- **I8** — rest arguments through `emitVirtualMethodDispatchByTag` (null rest
  when the class has a subclass); same-named rest-method mis-dispatch (Wasm
  validation failure); rest destructuring patterns on the closure path.
- Language-misc table (lane I6): block-local closure TDZ (#5271 B2), loose
  `==` with `@@toPrimitive` vs string, `instanceof` prototype getter,
  primitive-base prototype reads/writes.
- **E8** still waits on the user's unblock choice (see the 2026-09-24 wrap-up).

Dispatch brief used for every slice this session: own worktree off
`origin/main`, `src/` base copy before the first edit, QuickJS one runner at a
time (the adapter cache key hashes `src/` — never add `src/` files mid-run),
byte differential on both targets in separate processes, zero pass→non-pass,
full gate chain incl. host-import-policy (`src/runtime.ts` is at its cap),
eval-free pin suite red on base, commit with ✓ and trailers, no push.

### 2026-09-29 — Cluster H, slice H6: Array methods over a proxy — IsArray, ArraySpeciesCreate, revocation (claim)

Claimed by the lead session (lane H6). Target: the 15 ES2015 standalone
non-pass rows under `built-ins/Array/prototype/**` whose names match
`proxy`, `species` or `invalid-len`, excluding the `*-realm*` rows. Measured
on main `ee50a5a7a` (standalone baseline promoted 2026-09-29 13:43):
`{map,filter,slice,splice,concat}/create-proxy.js`,
`{map,filter,slice,splice}/create-revoked-proxy.js`,
`concat/is-concat-spreadable-proxy-revoked.js`, the three
`*-invalid-len.js` RangeError rows, `splice/property-traps-order-with-species.js`
and `copyWithin/return-abrupt-from-delete-proxy-target.js`. The 2026-09-26
root-cause table lists `*/create-proxy.js` as "shared front-end, 5 rows, 0
standalone-only" and revoked-proxy reachability as "not root-caused". The
record follows when the lane reports.

### H6 record — 2026-09-29

Lane H6 (Array methods over a Proxy receiver, standalone). Branch
`claude/es6-6651-h6-array-species-proxy`, base `885a45051` (main `ee50a5a7a`
plus the claim). Wrapped up on the lead's order before every measurement
finished; what was and was not run is stated per item.

**Rows (the 15 claimed rows, `--isolate`, runner `run-test262-paths.mts`).**

| lane | base `885a45051` (own run) | after (own run) | moved |
| --- | ---: | ---: | --- |
| standalone | 0 / 15 | **5 / 15** | +5, 0 lost |
| host (default target) | 5 / 15 | not re-run | — |

The five: `{map,filter,slice,splice}/create-revoked-proxy.js` and
`concat/is-concat-spreadable-proxy-revoked.js`. The "after" run is of the
working tree that became commit `854b5d2ab`; the commit only moved the
`$Proxy` predicate into the leaf `proxy-array-like.ts` (same instructions).
The host lane was not re-run: every change is gated on `ctx.standalone` /
`native-first` / the `objArrayLikeArms` standalone trio, so the host
binaries should be unchanged, but that is a construction argument, not a
measurement.

#### Root causes that landed

1. **The array-like trio had no `$Proxy` arm.** `__extern_length`,
   `__extern_get_idx` and `__extern_has_idx` (§7.3.18 LengthOfArrayLike and
   the `Get` / `HasProperty` of every §23.1.3 generic) answered `0` /
   `undefined` / `false` for EVERY proxy, because a `$Proxy` is not an
   `$Object`. Measured on base: `Array.prototype.map.call(<revoked proxy>, f)`
   returned an empty array (no TypeError), `[1].concat(new Proxy([7, 8], {}))`
   had length 1. A `$Proxy` now takes the `$Object` arm — `__extern_get` /
   `__extern_has` already own the §10.5 dispatch — gated on a new pre-scan
   flag `proxyDirty` (the identifier `Proxy` occurs), so Proxy-free modules
   keep their bytes. Moves map/filter revoked.
2. **Typed lowerings `ref.cast` a Proxy VALUE to its target's vec.**
   TypeScript types a proxy as its target, so `Array.prototype.slice.call(p)`
   trapped with `illegal cast`, `splice.call(p)` ran on a copy, and
   `[].concat(handle.proxy)` trapped. A receiver/operand that traces to a
   Proxy value (`tracesToProxyValue`, the F-cluster predicate) now takes the
   array-like `__arrprod_slice` / `__arrprod_splice` (#6683/#6701) through
   the new leaf `array-proxy-receiver.ts`, and a fourth concat routing gate
   (`concatOperandMayBeProxy`) sends such a concat to the §23.1.3.1 spec loop.
   Moves slice/splice revoked and the concat IsConcatSpreadable row.

Pins: `tests/issue-6651-h6-array-proxy-receiver.test.ts`, 9 tests — 6 RED on
the base sources (file-copy A/B), 3 guards green on both.

#### Built, measured only by pins, and REVERTED from this branch

Commits `e7cd6a20a` / `501bcd9b0` carried a second change set, reverted
forward here because its row runs and controls did not finish before the
wrap-up (queued behind the shared test262 lock). It stays in the branch
history for the next lane; its pins were 13/13 on the branch and 9 RED on
base:

- the #2615/#4754 escape gate treats `Array.prototype.{map,filter,slice,
  splice,concat,copyWithin}.call(p, …)` receivers (and concat operands) as
  non-escaping in standalone, so the binding keeps its proxy instead of being
  materialized into a copy of the target at the declaration;
- the map/filter species prologue reads the ORIGINAL receiver, not the
  materialized vec; the slice/splice proxy route applies ArraySpeciesCreate
  after the helper (an ordering under-approximation);
- ArrayCreate's RangeError for a trapped length above 2^32 − 1 in the
  externref→vec materializer and the array-like `map` loop;
- `Object.getPrototypeOf(<Array-typed>)` read at run time in a module that
  can observe ArraySpeciesCreate or hold a Proxy;
- a §23.1.3.4 `__arrprod_copyWithin` array-like body for a Proxy receiver.

That set targets the remaining 9 non-design rows (create-proxy ×5,
invalid-len ×3, copyWithin delete-proxy-target) plus the unclaimed ES2015 row
`copyWithin/return-abrupt-from-has-start.js`. None of those rows was measured
on it. **(2026-10-01: re-applied and measured as #6771 S1 — all of them pass
on `issue-6771-array-residue`, see the #6771 pointer at the end of this file.)**

#### Residuals (10 rows)

- `{map,filter,slice,splice,concat}/create-proxy.js`,
  `{map,splice}/create-species-undef-invalid-len.js`,
  `slice/create-proxied-array-invalid-len.js`: the proxy binding is
  materialized into a copy of its target at the declaration (the escape gate
  above), the species prologue reads that copy, and `Object.getPrototypeOf`
  of the result is folded to `%Array.prototype%` from the checker's array
  type. Fix built in `e7cd6a20a`, unmeasured.
- `copyWithin/return-abrupt-from-delete-proxy-target.js`: standalone has no
  array-like `copyWithin` (the `.call` form throws "not yet callable"); body
  built in `e7cd6a20a`, unmeasured.
- `splice/property-traps-order-with-species.js` — **design question, not
  built.** ProxyCreate (`__proxy_create`, `object-runtime-proxy.ts` ~L1540)
  snapshots all 13 traps off the handler into `$ProxyTraps`, so a handler
  that is itself a proxy logs every trap name at creation; §10.5 requires
  `GetMethod(handler, name)` at each operation. Independently, the species
  result swap (`emitArraySpeciesResultSwap`) does a define AND a `Set` per
  element, which adds `set` entries to the expected
  `defineProperty, defineProperty, set, getOwnPropertyDescriptor,
  defineProperty` log. Both are runtime-wide changes.

#### Newly root-caused, not taken

- **Proxy traps receive NUMBER keys.** Measured on this branch (and the
  behaviour predates it): compiled `p[0]`, `delete p[1]` and `0 in p` hand the
  `get` / `deleteProperty` / `has` traps the number, and `__arrprod_splice`'s
  boxed index keys do the same; §10.5 traps must see `ToPropertyKey` strings.
  The fix belongs in the proxy dispatch front-guards and reaches every proxy
  row with a numeric key.

#### Controls

- Gates, run bare on the reverted tree before the last commit: loc, func,
  coercion-sites, oracle-ratchet, dead-exports, loc/func with
  `LOC_GATE_BASE=origin/main`, host-import-policy, compiler-boundaries
  `--mode inventory`, typecheck — all green.
- Related suites (one vitest process each, QuickJS provider): `issue-2615`
  (1 fail), `issue-4754-module-global-proxy-escape` (6 fail),
  `issue-5122-es2015-proxy-symbol-targets` (2 fail),
  `issue-5268-es2015-array-object-r2` (4 fail) fail on this tree with exactly
  the same test names on the BASE sources (file-copy A/B, same session) — a
  pre-existing state, not this lane's. `issue-2984-species`,
  `issue-3420-species-result-store`, `issue-4449-species-{controls,producers}`
  and `issue-5196-es2015-proxy-r2` passed on the second change set; they were
  not re-run on the reverted tree.
- NOT run: the compile-only differential's new side (the base side over the
  783 Proxy-mentioning files × 2 targets and the 558-file species/Temporal
  set is in `.tmp/h6-bytes{,2}-base.tsv` of the lane tree), ES5 control rows,
  `equivalence-gate`, `check:ir-fallbacks`, the guard suite and
  playground/benchmark byte identity.

### 2026-09-29 — Cluster C, slice C5: subclassing built-in constructors (claim)

Claimed by the lead session (lane C5). Target: the 22 ES2015 standalone
non-pass rows under `language/statements/class/subclass/**`, excluding
`builtin-objects/GeneratorFunction/*` (lane A14). Measured on main `9ec7a78b0`
(standalone baseline promoted 2026-09-29 11:55): `class X extends
Number/String/Boolean/Date/RegExp/ArrayBuffer/DataView/TypedArray/Function/Proxy/Symbol/Promise`,
the instance `length` / `name` own properties of a `Function` subclass
instance, and the return-override / binding / default-constructor rows. The
record follows when the lane reports.
### C5 record — 2026-09-29 (cluster C: subclassing built-in constructors)

**Branch** `claude/es6-6651-c5-builtin-subclass` (WIP PR #6321). Fix commits
`e2a54df4c` and `a38c8db1b`, merged onto `origin/main` @ `8c727c39c` (after A14
landed) as `c95e32dd1`, then onto `046f1eaa9`. Engine `JS2WASM_EVAL_ENGINE=quickjs`, `--isolate`, one
runner at a time under the shared lock. "Base" rows below are my own runs:
the 22-row base is main `3473dfed` (this branch before the first edit); the
differential and the verdicts use a separate base TREE (`git archive
origin/main src` + the runner's own `tests/test262-*.ts`), so the branch
never had to be swapped under a running measurement.

#### Rows (22 targets)

| lane | base | branch |
| --- | ---: | ---: |
| standalone | 0 / 22 | 15 / 22 |
| host (honest lane) | 10 / 22 | 13 / 22 |

| row (`class/subclass/…`) | standalone base → branch | host base → branch |
| --- | --- | --- |
| `binding.js` | fail → **pass** | fail → fail |
| `builtin-objects/ArrayBuffer/regular-subclassing.js` | fail → **fail** | pass → pass |
| `builtin-objects/Boolean/regular-subclassing.js` | fail → **pass** | fail → fail |
| `builtin-objects/DataView/regular-subclassing.js` | fail → **pass** | fail → fail |
| `builtin-objects/Date/regular-subclassing.js` | fail → **pass** | pass → pass |
| `builtin-objects/Function/instance-length.js` | fail → **pass** | pass → pass |
| `builtin-objects/Function/instance-name.js` | fail → **pass** | pass → pass |
| `builtin-objects/Function/regular-subclassing.js` | fail → **pass** | fail → fail |
| `builtin-objects/Number/regular-subclassing.js` | fail → **pass** | pass → pass |
| `builtin-objects/Promise/regular-subclassing.js` | fail → **pass** | pass → pass |
| `builtin-objects/Proxy/no-prototype-throws.js` | fail → **pass** | fail → pass |
| `builtin-objects/RegExp/lastIndex.js` | fail → **fail** | pass → pass |
| `builtin-objects/RegExp/regular-subclassing.js` | fail → **pass** | pass → pass |
| `builtin-objects/String/length.js` | fail → **pass** | fail → fail |
| `builtin-objects/String/regular-subclassing.js` | fail → **pass** | pass → pass |
| `builtin-objects/Symbol/new-symbol-with-super-throws.js` | fail → **pass** | fail → pass |
| `builtin-objects/TypedArray/regular-subclassing.js` | fail → **fail** | fail → fail |
| `builtins.js` | fail → **fail** | pass → pass |
| `class-definition-evaluation-empty-constructor-heritage-present.js` | fail → **pass** | fail → pass |
| `class-definition-null-proto-contains-return-override.js` | fail → **fail** | fail → fail |
| `default-constructor-2.js` | fail → **fail** | fail → fail |
| `derived-class-return-override-with-object.js` | fail → **fail** | fail → fail |

Host "branch" is this code before the A14 merge (`a38c8db1b`); the
standalone branch column is the merged tree (`c95e32dd1`), re-run after the
merge with the QuickJS adapter rebuilt. No target row went pass → non-pass on
either lane.

#### Root causes and what landed, mechanism by mechanism

1. **Promise — §27.2.3.1 step 2 was skipped** (1 row). The implicit
   `constructor(...args) { super(...args) }` of `class P extends Promise {}`
   builds the carrier through `emitStandalonePromiseFromExecutorValue`, whose
   header recorded the gap as a deliberate "no-throw discipline": a
   non-callable executor went to `__apply_closure` (a no-op) and the promise
   stayed pending. It now throws the TypeError before the promise exists; the
   test is `__typeof_function` (§13.5.3 — exactly IsCallable), not
   `__is_callable`, which excludes classes. Cluster D ruled this row
   out-of-scope as a realm / `@@toStringTag` issue — re-verified from the
   source: the row checks only `new Prom()` throwing and the executor's two
   function arguments; it was this missing check.
2. **Proxy — §15.7.14 step 5.g.ii** (1 row, both lanes). `%Proxy%` has no
   `prototype`, so `class P extends Proxy {}` throws at definition. Added to
   `class-heritage-check.ts` as a compile-time proof (ambient `Proxy` only);
   it is the one arm of that module that also runs on the host lane (which
   resolves an identifier heritage statically too and never read
   `Proxy.prototype`).
3. **Symbol — §20.4.1.1 step 1** (1 row, both lanes). `class S extends
   Symbol {}` is legal, but `super()` constructs `%Symbol%` with a NewTarget,
   which throws. `Symbol` is not a host-constructible parent, so the class was
   a root struct and both the implicit and the explicit `super()` completed.
   Both now throw (`classHeritageIsIntrinsicSymbol`, class-bodies.ts).
4. **Number / Boolean / String — the carrier was right, the dispatch was not**
   (4 rows). The #3972 wrapper rung ignored its argument (`new N(42)` wrapped
   `+0`), and every native Number/String/Boolean method lowering is gated on a
   symbol-NAME test of the receiver type (`isNumberWrapperType` …), which a
   subclass-typed receiver fails — so `n.toFixed(2)` fell to
   `__extern_method_call`, whose `$Object` arm has no builtin prototype
   methods ("called value is not a function"), and `b.valueOf()` took the
   ordinary-class identity fold. Now: the wrapper carrier takes
   `ToBoolean`/`ToNumber` of its argument through the coercion engine; a
   String subclass wraps `""` for a missing argument (it wrapped `undefined`,
   so there was no `length` at all); and `builtin-subclass-receiver.ts` routes
   a subclass-typed receiver to the parent's instance type when the member
   resolves to the parent's OWN lib declaration (a user override, or any
   `Object.prototype` member, is declined) — in the method-call path, the
   property-read path and the import collector (which registers
   `number_toFixed` & co. by receiver type). `String/length.js` also needed
   `o["length"]` through `__extern_get` on a String wrapper: gOPD and the
   index keys answered, `"length"` read `undefined`. A `length` arm in the
   String-exotic `__extern_get` arm (`string-wrapper-dynamic-length.ts`) is
   emitted only in a module that constructs a String subclass.
5. **Date / RegExp / DataView / Function — identity carriers** (6 rows). The
   #3972 identity rung returns a plain object for these parents. Faithful
   construction needs each parent's AST-driven lowering (Date's MakeDay/parse,
   RegExp's pattern compile, DataView's buffer brand, Function's static body
   compile), which the super-constructor forwarder — holding evaluated
   externrefs — cannot reach. `builtin-subclass-new-site.ts`: for a class
   whose constructor would do nothing but construct the parent (no own
   constructor, no instance member, heritage naming the builtin), `new D(…)`
   compiles as `new Parent(…)` on the same argument nodes, plus `D_new`'s
   standalone `constructor` install. Inherited members route to the parent only
   for such a class, so an instance built another way (a subclass of `D`,
   `Reflect.construct`) keeps its previous behaviour. `new DataView()` with no
   argument now throws (§25.3.2.1 step 2; it returned an empty buffer).
6. **Bound class — §10.4.1.2 step 5** (1 row standalone). TypeScript types
   `new (C.bind(o, 1))(8)` as `C`, so the static class path called `C_new(8)`
   and dropped the bound arguments. `bound-class-construct-args.ts` prepends
   them when both bindings are unique and never written and every bound
   argument is a literal (re-evaluation is then unobservable).
7. **Constructor `arguments`** (1 row, both lanes). The static `new C(…)`
   site evaluated-and-dropped surplus arguments even when `C`'s constructor
   reads `arguments` (the `__extras_argv` contract functions already honour),
   and an implicit derived constructor was never marked as needing them. Both
   fixed (new-super.ts, class-bodies.ts).

#### Differential (compile-only, both targets, primary + strict variants)

Bounded reach set (448 files): every test262 file with `extends
<Number|Boolean|String|Symbol|Proxy|Promise|Date|RegExp|DataView|Function>`
(119), every file with `new Promise(` (259 — the executor-value path), every
file whose class constructor body reads `arguments` (15, TypeScript-AST scan of
the 4,737 files mentioning both `class` and `arguments`), every file with
`class` and `.bind(` (62), and `new DataView()` (1). Compiled on both targets,
primary and strict variants, in a separate base tree (`origin/main`
`51a70eb2c`) and a snapshot of this branch on the same base, fresh process per
tree: **75 binaries changed** (68 standalone, 7 host) in 69 files; no compile
status flipped (101 FAIL/THROW entries on each side, identical rows).
Playground examples + benchmark suites (17 files × 2 targets): byte-identical.

Verdicts for the changed rows (finished after the wrap-up report; base tree
`origin/main` `8c727c39c` vs this branch, `--isolate`): standalone 68 rows,
base 35 pass → branch 45 pass, **0 pass → non-pass**; host 7 rows, base 2 pass
→ branch 6 pass, 0 pass → non-pass (the extra host flip is
`language/statements/class/arguments/default-constructor.js`). The branch run
first showed `subclass-builtins/subclass-Function.js` (both spellings) failing
with "the quickjs provider is not built": the final `origin/main` merge changed
`src/` mid-run, and the QuickJS adapter cache key hashes `src/`. With the
adapter rebuilt, both rows pass.

#### Controls

- Pins `tests/issue-6651-c5-builtin-subclass.test.ts`: 28/28 on the branch
  (also after the final `origin/main` merge); on the base tree 16 red, the 12
  GUARD pins green.
- `scripts/equivalence-gate.mjs`: 22 failing / 1,720 passing / 22 known — no new.
- `scripts/run-guard-suite.mjs`: 20 files, 255/255.
- `check:ir-fallbacks`: OK.
- Gates, bare, on the final merge: loc, func, coercion-sites, oracle-ratchet
  (`ctx.checker` −1), dead-exports, loc/func with `LOC_GATE_BASE=origin/main`,
  host-import-policy, `check-compiler-boundaries --mode inventory` (four new
  leaves registered), typecheck — all pass.
- vitest controls (one file per process, `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`):
  72 of the 198 planned suites ran before the wrap-up — the 66 reach suites
  (subclass / bind / arguments / Promise executor / heritage) plus the first
  `issue-6651-*` files; 58 pass. The 14 that fail were re-run on the base tree
  (`origin/main` `8c727c39c`): identical failures (test names compared for
  `issue-2710`, `4025`, `4491`, `4556`, `5195-es2015-class-r2`,
  `5195-r3-review`, `5373-array-subclass-tostring`; counts for `2856`,
  `2903-iter-helpers`, `2903-r3`, `3599`, `3633`, `3719`). `issue-3518-native-
  prototype-seeder-bindings` (10 failing on the branch) timed out on the base
  tree under load — parity NOT established. The remaining `issue-6651-*`,
  `*generator*` and `issue-2864-*` suites were not run.
- Final `origin/main` merge (`046f1eaa9`, #6323 compiler performance) came in
  after the row measurements: pins, typecheck and gates re-run there; the 22
  rows were not.

#### Residuals and design questions

- **Constructor return override with an object — design question** (3 rows:
  `derived-class-return-override-with-object`,
  `class-definition-null-proto-contains-return-override`, and the last assert
  of `default-constructor-2`; both lanes). `C_new` / `C_init` return
  `(ref $C)`, and the site types `new C()` as that struct, so a constructor
  (or a parent reached through `super()`) returning a DIFFERENT object has
  nowhere to put it: `new Base3() === obj` is false on both lanes even for a
  base class. The fix is a value-representation decision — widen the
  construct result (and every `C`-typed binding fed by it) to an open carrier
  for the classes whose constructor chain can return an Object — not a local
  patch. Evidence: probes `d-ro.js` (5 shapes, 0/5 both lanes on base and
  branch).
- **ArrayBuffer species — design question** (`ArrayBuffer/regular-subclassing`,
  standalone only — the host passes with a real host object):
  `ab.slice(0, 1)` must run SpeciesConstructor on the instance and build an
  `AB`, and `sliced instanceof AB` must be answered at run time for a native
  carrier (today `instanceof <subclass>` is folded statically). Both need a
  subclass identity ON the native carrier — the `[[Prototype]]` slot question
  A14 recorded for the runtime-eval carrier, here for the vec carriers.
- **TypedArray — design question** (2 rows). `TypedArray/regular-subclassing`
  (both lanes) extends a runtime VALUE (`testWithTypedArrayConstructors`' parameter), so
  there is no builtin name to construct from; `builtins.js`' `class E extends
  Uint8Array { constructor() { super(10); this[0] = 255; … } }` needs a
  faithful TypedArray super-constructor (standalone only; the #3239 rung is an
  empty vec),
  element writes through the externref-backed `this`, `getPrototypeOf(eua) ===
  E.prototype` and the `Uint8Array` tag. The new-site substitution does not
  apply (explicit constructor with statements after `super`).
- **RegExp/lastIndex** — the subclass part is fixed (the carrier is a real
  RegExp, `exec` dispatches); the row now fails where the plain
  `built-ins/RegExp/lastIndex.js` fails on main (`verifyProperty(re,
  "lastIndex", …)` on a native RegExp: "Cannot access property on null or
  undefined"). A RegExp-lane residual, not this cluster's.
- **GeneratorFunction subclass rows (A14's 5)**: not covered. Their heritage is
  a runtime value (`var GeneratorFunction = Object.getPrototypeOf(function*
  () {}).constructor`), so the new-site substitution (which needs the builtin
  NAME as heritage) cannot apply; they need the carrier-prototype slot A14
  proposed.
- **Host lane**: `binding.js` / `default-constructor-2` stay red on host — the
  host harness source contains `eval`, and `bindingIsUniqueAndNeverWritten`
  (shared with the heritage check) declines any file that does, so the
  bound-args fold does not apply there. `Boolean`, `String/length`,
  `DataView`, `Function/regular-subclassing` and the TypedArray/return-override
  rows are host-lane gaps outside this standalone slice.
- Observed, not investigated: `function make(ex) { return new Promise(ex); }
  make(undefined)` still completes on standalone on this branch, so a plain
  `new Promise(<param>)` does not reach the guarded executor-VALUE lowering in
  that probe's module.

### 2026-09-30 — #6766 a Proxy as [[Prototype]] (Opus implementation lane)

A `$Proxy` in prototype position is now stored as a LINK `$Object` (appended
`$Object.protoLink`, field 6) instead of being unwrapped or dropped, and every
prototype walker (`__extern_get` / `__extern_has` / the #4504 decide walk / a
reserved set walk without #4504 / the terminal predicate / `__isPrototypeOf` /
`__getPrototypeOf`) hands the Proxy the operation with the original receiver
(`src/codegen/object-runtime-proxy-chain.ts`). Core rows 6/10 (base 0/10),
measure rows 4/11 (base 1/11). The 4 core rows still red fail BEFORE any link
on base: two are vec receivers (a plain array's prototype lives only in its
#3537 bag, and the typed lane's `in`/element store never consult it) and two
are the proxy binding materialized into the target's struct slot because it
escapes into `assert.sameValue` (#6637's escape predicate exempts only
bare-identifier callees). Control (643 passing Proxy/Reflect/Object and
Proxy-mentioning rows): 0 pass → non-pass attributable to the branch. Record,
walker audit and residual mechanisms:
`plan/issues/6766-es2015-standalone-proxy-as-prototype-link.md`.

### 2026-09-30 — #6769 TypedArray residue: plan (Fable lane)

The 38 remaining ES2015 standalone rows under `built-ins/TypedArray/**` and
`built-ins/TypedArrayConstructors/**` (realm rows excluded) were measured on
`d4e15d90f9` (38 fail) and bucketed with 13 harness-shaped probes into ten
mechanisms; the plan in
`plan/issues/6769-es2015-standalone-typedarray-residue.md` takes seven of them
in ten steps ordered by yield: the `__any_unbox_bool(null)` trap, a
function-valued `[Symbol.species]` literal member invisible to the dynamic MOP
(the literal stays on the struct path with an `@@N` field), `instanceof` for a
`$__ta_ctor` RHS, native live-receiver `map`/`filter`/`slice` for dyn views
(today the call-site two-arm rebinds the identifier to an f64 copy, so the
callback's third argument and `Reflect.set(sample, …)` see the copy), species
results that are STATIC carriers, a TypedArray `sort` compare with comparator
ToNumber, the `%TypedArray%`/`%TypedArray%.prototype` receivers, a RangeError
cap and static-vec source arm in the dyn constructor, the `toLocaleString`
detached guard, and the ArrayBuffer carrier's `[[Prototype]]`. Expected yield
27 of 38.

Eleven rows are recorded as out of reach with their mechanism named: two
`internals/Set` rows fail on VALUE IDENTITY (`{ valueOf(){} }` literals are
re-boxed on every externref round trip — #2773/#3037, not the receiver walk);
three need a TypedArray in `[[Prototype]]` position (+ array/String exotic
receivers and a Proxy `defineProperty` trap — #6766's F cluster);
`toindex-length` reads the wrong union lane of a nested literal (#5185's
family); the modified-array-iterator row needs the native iterator ladder to
honour a patched `%ArrayIteratorPrototype%.next` (#6484's lane); the two
`iterated-array-changed-by-tonumber` rows need drain-before-coerce AND the
same literal-identity fix; `no-species` needs `class extends ArrayBuffer`
(#3240); `from-typedarray-into-itself-mapper-detaches-result` is E5's
custom-`this` `%TypedArray%.from.call` residual. The leads "ToIndex(-0)" and
"detached-buffer checks missing" were refuted or narrowed by the probes
(`new TA(-0).length === 0` already; only `toLocaleString` lacks the guard).

### 2026-09-30 — #6769 TypedArray residue: implementation (Opus lane)

Measured on `issue-6769-typedarray-residue` with `origin/main` merged:
**0 → 27 of the 38 rows** (`--isolate`, standalone) — every row the plan put
in reach. Eleven steps landed, one commit each: `__any_unbox_bool(null)`;
`[Symbol.species]` literal members on the open-`$Object` path; `instanceof`
for a `$__ta_ctor` RHS; native live-receiver `map`/`filter`/`slice` producers
for dyn views; species results that are static carriers; a TypedArray `sort`
(SortCompare, comparator ToNumber, detach-safe write-back); the `%TypedArray%`
/ `%TypedArray%.prototype` receivers; the constructor RangeError cap and
static-vec / array-like source arms; the `toLocaleString` detached guard; the
ArrayBuffer carrier's `[[Prototype]]`; and (S7c) a direct call of a binding
initialised from `getOwnPropertyDescriptor(…).get`, which now reaches the
accessor through `__apply_closure` instead of the typed ladder's TypeError
(also fixes the BigInt `Symbol.toStringTag/invoked-as-func` twin). The eleven
out-of-reach rows keep the mechanisms the plan named. Controls: 0 pass →
non-pass over 2,607 currently-passing TypedArray / ArrayBuffer / DataView /
per-step rows (962 with `--isolate`, the rest screened in-process after the
background run hit its time limit), and 0 lost in S7c's 23-file targeted
control.
Record, probes, pins and side findings:
`plan/issues/6769-es2015-standalone-typedarray-residue.md`.

### 2026-09-30 — #5197 r3: the 19 residual ES2015 standalone `built-ins/Promise/**` rows (plan, Fable lane)

Plan written to `plan/issues/5197-es2015-standalone-promise-r2.md` §
"Implementation Plan — r3 (2026-09-30)". Measured on `origin/main` @
`d4e15d90f9`: all 19 non-pass; 23 probes (`.tmp/5197r3/`) pin the
mechanisms. Buckets: **B1** `then` never performs §27.2.5.4 steps 3-4
(`SpeciesConstructor` + `NewPromiseCapability(C)`) and a Promise-rooted class
object has no inherited `@@species`, `P.resolve(x)` bypasses `P`, the
anonymous `new class extends Promise{…}(fn)` site is an invalid binary — 9
rows; **B2** LIFO reactions — 1; **B3** `Resolve(p, <$Vec>)` skips
`Get(array,"then")` — 2; **B4** no `[[AlreadyResolved]]` — 2; **B5** a
function `C` in `Promise.<m>.call(C, …)` is bypassed once the module reads
`Function.prototype` (runtime-eval regime; the D1 arm's executor is absent
from the WAT) and D1 drains a dynamic iterable — 3; **B6** `catch` on a
primitive receiver — 1; **B7** `Promise.all(<string>)` result typing — 1.
Steps 1-7 in that order; 13 firm rows, 6 conditional on one named probe
each. D3/D4/D5/D7 made B1 reachable (the 09-03 "G9 deferred" entries are
superseded); nothing is judged unreachable by construction.

**Implementation (2026-09-30, Opus lane, branch `issue-5197-r3-promise`):
0 → 17/19** — 12 of the 13 firm rows and 5 of the 6 conditional ones. Two
remain: `all/resolve-element-function-prototype.js` (firm, Step 5: in the
assembled module the resolve-element function never reaches `thenable.then`;
mechanism not reduced below that) and `prototype/catch/this-value-obj-coercible.js`
(Step 6 measured and reverted — its Symbol sub-case needs a
`%Symbol.prototype%` read from a symbol value). Control: 1,188/1,189
currently-passing rows (ES5 226/226); the one failure is pre-existing on
`origin/main`. Record, deviations and residual mechanisms:
`plan/issues/5197-es2015-standalone-promise-r2.md` §
"2026-09-30 — r3 implementation (Opus)".

## 2026-09-30 — #6767: class definition reflective residue (pointer)

`language/statements/class/definition/**` (19 standalone rows, 18 non-pass on
the 2026-09-29 baseline) is #6767's. Measured on `issue-6767-class-definition-
reflective` with `origin/main` merged: **1 → 10 pass** — the five static
descriptor rows, `basics.js`, and the three heritage rows
(`constructable-but-no-prototype`, `prototype-setter`, `invalid-extends`).
Remaining, with mechanisms in #6767's record: `getters-restricted-ids` and
`fn-name-accessor-{get,set}` (a static accessor shares the function slot of a
same-name INSTANCE accessor, #5195 cluster B item 5), `methods-restricted-
properties` (no %ThrowTypeError% `caller`/`arguments` on method values), and
the five #5350 `this`-before-`super()` rows. Two shared fixes landed with it
that reach beyond the cluster: call-site parameter inference no longer narrows
a parameter to `$C` from a `C.prototype` argument, and `C[k]()` on a class
identifier no longer pushes a stray receiver (an invalid module when used as a
call argument).

## 2026-09-30 — #5350 r2 (super property WRITES) — pointer

`super.x = v` / `super[k] = v` now lower onto `__reflect_set_receiver` in
standalone (branch `issue-5350-r2-super-property-write`; full record under
"2026-09-30 r2 implementation (Opus)" in
`plan/issues/5350-es2015-standalone-super-property-r1.md`). Cluster C gains 4
rows (`super/prop-{dot,expr}-obj-ref-non-strict.js`,
`super/prop-{dot,expr}-cls-ref-strict.js`); p10 37 → 63 (node 127). Two
findings for this plan's other lanes: (1) the receiver walk now refuses to
create a key on a NON-EXTENSIBLE receiver, so `Reflect.set`'s 4-argument form
answers `false` there (it answered `true`); (2) the remaining `super/*-cls-ref-this.js`
pair is blocked by a class-member `this` that cannot hold a non-instance
receiver (`P.prototype.getThis() === P.prototype` traps "illegal cast" on main,
no `super` involved), and `super/call-proto-not-ctor.js` by class objects having
no runtime [[Prototype]] (`Object.setPrototypeOf(C, f)` is a silent no-op;
`super()` is inlined from the compile-time parent) — both representation
questions, neither built.

### 2026-10-01 — #6771 `built-ins/Array/**` residue — pointer

Branch `issue-6771-array-residue` (record: "2026-10-01 — implementation
record (Opus)" in `plan/issues/6771-es2015-standalone-array-residue.md`).
The 34-row ES2015 standalone Array bucket goes **0 → 30** on a tree merged
with `origin/main` @ `a895598841` (`--isolate`, base re-measured 0/34). S1 is
the H6 second set above, re-applied and now measured: all 11 of its rows pass
(create-proxy ×5, invalid-len ×3, concat length limit, copyWithin ×2), with
two additions the rows needed (copyWithin on plain array-likes; a Proxy
trap's fall-off `undefined` no longer returns `0`). The other 19 rows come
from the array-like trio's exotic arms, `Array(n)` holes, flat/flatMap
species, `@@unscopables`, the Boolean `toString` override, `Array.from.call`
constructor identity, and ArraySetLength's double conversion. Residuals:
the `Reflect.defineProperty` false channel and lazy trap lookup are #6770
S4/S8 (with #6770's branch merged one more row passes), `source-array-
boundary` is #2727, and `define-own-prop-length-coercion-order.js` turned out
to be a checker defect — in a script, a top-level `var length` merges with
lib.dom's `declare var length: number` and is typed `number` (10 test262
files declare such a var).
