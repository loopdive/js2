---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-10-06
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: conformance
trap-growth-allow:
  count: 1
  reason: "2026-10-06 — host lane, not caused by this change: language/computed-property-names/object/method/number.js is baseline `fail` and already traps with `RuntimeError: dereferencing a null pointer in __module_init_chunk_0() at source L20` on origin/main 499d16a1c1 without any #6651 slice (reproduced locally with TEST262_ORACLE_MODE=linked --isolate). The baseline records it as a non-trapping fail, so every merge group re-counts it as null_deref growth (37 -> 38); it parked #6512 (run 37402183200) and #6519 (run 37417917245). Failure-flavour reclassification of one baseline-fail row only."
  tests:
    - test/language/computed-property-names/object/method/number.js
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
  # 2026-10-06 — slice V10d (record under "2026-10-06 — Slice V10d"). index.ts
  # +3: one import line and the two finalize calls (`generateModule` /
  # `generateMultiModule`) that unshift the ToPropertyKey arm onto
  # `__extern_get`; the arm itself lives in the NEW leaf
  # `object-model/extern-get-object-key.ts` and `symbol-to-primitive-arms.ts`.
  - src/codegen/index.ts
  # 2026-10-06 — slice V6 (module namespace internals; record under "2026-10-06
  # — Slice V6"). The §10.4.6 arms live in the NEW leaf
  # `object-model/module-namespace-exotic.ts`. What stays in god-files (paths
  # already listed below, restated here per the stranded-grant rule):
  #   - `literals.ts` +14: `[...strings, Symbol.toStringTag]` widens the element
  #     kind to externref instead of null-derefing the symbol into a string vec
  #     (the define-own-property row);
  #   - `expressions/new-super.ts` +4: the super receiver in a derived ctor is
  #     the parent's override object (BindThisValue), not the struct;
  #   - `declarations.ts` +2: allocate a self-importing module's TDZ flags
  #     before class bodies compile (a class body may build `ns` first).
  # 2026-10-06 — slice V9 (parser compatibility, adopts #6836; record under
  # "2026-10-06 — Slice V9"). `src/compiler.ts` +6: the import, a one-line
  # comment, the 3-line call of `normalizeForHeadParserCompat` in
  # `compileSourceSync` and its `.compose(...)` in the pre-parse PositionMap
  # chain. The recognizer itself is the NEW leaf
  # `src/compiler/for-head-parser-compat.ts`; the call site cannot move — it is
  # the single-source pre-parse pipeline that owns every rewrite stage and map.
  - src/compiler.ts
  # 2026-10-06 — slice V10a (primitive ToObject prototype reads; record under
  # "2026-10-06 — Slice V10a"). `array-object-proto.ts` +9: the
  # `Promise.prototype.catch` body's IsCallable guard skips the resolve-path
  # thenable predicate for a primitive `this` (the carrier test lives in the
  # NEW leaf `object-model/primitive-carrier-test.ts`; this is the call site
  # plus the `ensureSymbolCarrier` reservation it needs before any index is
  # baked). `property-access-dispatch.ts` +4: the #5269 B-d symbol-read fold
  # declines when the module writes `Symbol.prototype` / `Object.prototype`.
  - src/codegen/array-object-proto.ts
  - src/codegen/property-access-dispatch.ts
  # 2026-10-06 — slice V5 (captured-binding TDZ; record under "2026-10-06 —
  # Slice V5"). `index.ts` +3: `preallocateBlockScopedSlots` stops skipping a
  # block that hoists a function declaration when the frame is `__module_init`
  # (no function-entry pre-hoist exists there) and re-installs the pre-hoisted
  # slots otherwise. `expressions/assignment.ts` +2: the SetMutableBinding TDZ
  # guard on the boxed-capture write arm. Both paths already listed below.
  # 2026-10-06 — slice V4: `object-runtime-proxy.ts` +16 (path already listed
  # below): the deps hand-off to `registerProxyConstructChainNatives` for
  # `__proxy_construct_newtarget_proto`; the native lives in
  # `object-runtime-proxy-construct-chain.ts`.
  # 2026-10-06 — slice V7 (keyed destructuring order + deleted Array @@iterator;
  # record `### 2026-10-06 — Slice V7`). Hand-off lines only, mechanism in
  # `dstr-assign-iterator-drive.ts` / `with-var-decl.ts` / `proto-override.ts`:
  # `expressions/assignment.ts` +3 (import + the `tryEmitSpecOrderedObjectAssign`
  # call in `compileDestructuringAssignment`), `statements/loops.ts` +2 (import +
  # the for-of delete guard call), `statements/variables.ts` +1 (the with-scoped
  # var-pattern hook). All three paths already listed below; restated here.
  # 2026-10-06 — slice V1 (trapless Proxy forwarding; record under
  # "2026-10-06 — Slice V1"). `object-runtime-proxy.ts` +2: the import and the
  # one-line call of `installProxyForwardArms`; the arms themselves live in the
  # NEW leaf `object-model/proxy-forward-carriers.ts` (path already listed below).
  # 2026-10-06 — slice V3 (TypedArray residue; record `### 2026-10-06 — Slice
  # V3`). The iterator mechanism lives in the NEW leaf
  # `array/ta-iter-detach.ts` (type-only imports). What stays in god-files:
  #   - `dataview-native.ts` +112: `emitExternTaViewReceiverAsVec` /
  #     `emitExternTaViewSetWriteBack` (the runtime view arm of an externref
  #     `ta.set` receiver — they compose `emitTaViewValidate` / `emitTaViewToVec`
  #     / `emitTaViewWriteBack`, which live here) and
  #     `ensureStandaloneTaSubclassParentCtor` (static TA-subclass `super()`
  #     through the private `ensureTaDynCtorConstructHelper`);
  #   - `iterator-native.ts` +30: `prependTaIterDetachArm`, the finalize hook
  #     that splices the leaf's prologue into `__iterator_next`;
  #   - `array-methods.ts` +14: the receiver arm + write-back call in
  #     `compileTypedArraySet`, where the externref cast was;
  #   - `object-runtime.ts` +4: the import and the delegation at the top of
  #     `emitStandaloneVecBuiltinConstructor`.
  - src/codegen/iterator-native.ts
  - src/codegen/object-runtime.ts
  # 2026-10-06 — slice V0 (record `### 2026-10-06 — Slice V0`): one guard call
  # per `bfnid` compare site. `object-runtime.ts` +1 (the import widens, and
  # one line in `fillBuiltinFnMeta`'s shared `exactMetaArm`); `ta-dyn-mop.ts`
  # +2 (one call in the refusal-closure ladder plus its `self` thunk). The
  # guard itself lives in the leaf `builtin-fn-meta.ts`, moved there from
  # `closures/transferred-native-proto.ts` so the non-SCC callers can reach it
  # without joining the import-cycle SCC. Both paths are already listed below;
  # restated here per the stranded-grant rule.
  - src/codegen/object-runtime.ts
  - src/codegen/ta-dyn-mop.ts
  # 2026-10-05 — uncovered slice U2 (TypedArray residue; record under
  # "2026-10-05 — Uncovered slice U2"). Every mechanism is a few lines at the
  # site that owns the decision; the shared helper `taDynJoinLengthInstrs` is in
  # the leaf `ta-dyn-method-call.ts`. `dataview-native.ts` +36: the exported
  # `emitRefElemArraySnapshot` (drain-before-ToNumber, §23.2.2.1 step 5 /
  # §23.2.5.1.1 step 6.a) and its two call lines in the dyn ctor's `$ObjVec` and
  # plain-vec arms — it sits with the TypedArray construction it serves.
  # `identifiers.ts` +28: `hoistedScriptVarRead`, the #2176 ambient-shadow read
  # for a script `var` nested in a statement (`harness/testTypedArray.js` reads
  # `name` after a `for` loop and got `globalThis.name`); `index.ts` +27:
  # `findHoistedVarDecl`, the VarScopedDeclarations walk the #2176 finder lacked —
  # both have to live beside the two functions they complete.
  # `call-builtin-static.ts` +3 (import + one call in the static `TA.from` copy),
  # `array-methods.ts` +1 (join's length read routed through the helper).
  # 2026-10-06 — uncovered slice U5 (record `### 2026-10-06 — Uncovered slice
  # U5`): `array-methods.ts` +4 more, in `compileArraySplice`'s zero-argument
  # branch, which now hands an `externref` receiver to the existing species
  # prologue instead of dropping it. The decision belongs to that branch.
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/index.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/array-methods.ts
  # 2026-10-05 — uncovered slice U4 (record `### 2026-10-05 — Uncovered slice
  # U4`). The mechanisms live in leaves: `statements/finally-ran-guard.ts`
  # (NEW — the per-try `finallyRan` flag), `dstr-assign-iterator-drive.ts`
  # (computed-key evaluation for for-of object patterns) and
  # `declarations/array-rebind-element-widening.ts` (alias groups, the widened
  # initializer, the aliasing struct-field carrier). What stays in the god-files
  # is the call where each decision is taken:
  #   - `ir/lower-generic.ts` +35: the IR twin of the finally guard — the
  #     `try` arm and `resolveBrLabel` own the inlined finally copies, and the
  #     flag has to be raised beside each copy and tested inside each handler
  #     buffer they build (the IR lowering has no codegen-side helper to share);
  #   - `statements/for-of-destructuring.ts` +24: the import, the struct arm's
  #     hand-off to the extern-get arm for a runtime-only key, and the key
  #     evaluation + runtime-key read in the extern-get arm;
  #   - `statements/variables.ts` +3: the import and the widened-initializer
  #     branch in the module-global initializer arm;
  #   - `index.ts` +2: the import and the one-line field-type hook in
  #     `ensureStructForType`, beside the #5376 accessor-value widening.
  - src/ir/lower-generic.ts
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/statements/variables.ts
  - src/codegen/index.ts
  # 2026-10-05 — uncovered slice U3 (Proxy MOP residue, G4). Call sites only;
  # the mechanisms live in leaves (`object-model/proxy-get-iterator.ts` NEW,
  # `object-model/object-literal-reflective-escape.ts`). `object-ops.ts` +25:
  # the evolving-`var` decline of the `Object.keys` nullish fold and its
  # ToObject guard helper. `new-super.ts` +12: the realm-member `new
  # other.Proxy(...)` admission predicate and its two call sites.
  # `object-runtime-proxy.ts` +9: the `__object_keys_forin` proxy guard and the
  # GetIterator arm hook. `statements/loops.ts` +8: the for-in proxy-receiver
  # route around the vec index loop.
  - src/codegen/object-ops.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/statements/loops.ts
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
  # 2026-10-06 — slice V10d (see the loc-budget note): `generateModule` +1 and
  # `generateMultiModule` +1 (the finalize call each), `planClosureCaptures` +4
  # (the read-only-closure skip over a module-init shadow local; it has to sit in
  # the capture loop beside the sibling `isDirectRuntimeModuleVariableBinding`
  # skip, where `localIdx` and `writtenInClosure` are known).
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  # 2026-10-06 — slice V6 (see the loc-budget note): `compileArrayLiteral` +14
  # (the externref widening for a non-string fixed element after a string
  # spread) and `compileDeclarations` +1 (the early TDZ-flag call).
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/declarations.ts::compileDeclarations
  # 2026-10-06 — slice V5 (see the loc-budget note): `compileAssignment` +2 (the
  # TDZ guard on the boxed-capture write) and `planClosureCaptures` +2 (skip the
  # #1177 by-name slot rescan for a name no reference binds).
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  # 2026-10-06 — slice V4: `ensureProxyRuntime` +16 (key already listed below):
  # handing `registerProxyConstructChainNatives` the deps of the new
  # `__proxy_construct_newtarget_proto` native (get dispatch, "prototype" key,
  # objectTest, throwRevoked, the revoked field). The native body itself lives
  # in `object-runtime-proxy-construct-chain.ts`.
  # 2026-10-06 — slice V7: `compileDestructuringAssignment` +3 (the
  # `tryEmitSpecOrderedObjectAssign` hand-off), `compileForOfArray` +1 (the
  # delete-guard call), `compileVariableStatement` +1 (the with-scoped
  # var-pattern hook). The last two keys are already listed below.
  - src/codegen/expressions/assignment.ts::compileDestructuringAssignment
  # 2026-10-06 — slice V1: `ensureProxyRuntime` +1, the one-line call of
  # `installProxyForwardArms` next to `installProxyKeyBagGuards` (key already listed below).
  # 2026-10-06 — slice V0 (see the loc-budget note): the refusal-closure ladder
  # is a closure inside `fillTaDynViewMopArms`, emitted through
  # `buildStringKeyArm`, so its +2 (guard call + `self` thunk) counts in both.
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/ta-dyn-mop.ts::buildStringKeyArm
  # 2026-10-05 — uncovered slice U2 (see the loc-budget note): one-line calls
  # of `emitRefElemArraySnapshot` — `emitTaDynCtorConstructInline` +2 (the
  # `$ObjVec` and plain-vec arms) and `compileBuiltinStaticCall` +1 (the static
  # `TA.from` element copy).
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructInline
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  # 2026-10-05 — uncovered slice U4 (see the loc-budget note): the finally
  # guard's call sites in `compileTryStatement` +12, `lowerIrFunctionBody` +35
  # and `emitInstrTree` +24 (IR twin); the computed-key evaluation in
  # `compileForOfIteratorAssignDestructuring` +11 and its hand-off in
  # `compileForOfAssignDestructuring` +9; `compileVariableStatement` +2;
  # `ensureStructForType` +1.
  - src/codegen/statements/exceptions.ts::compileTryStatement
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/codegen/statements/for-of-destructuring.ts::compileForOfIteratorAssignDestructuring
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/index.ts::ensureStructForType
  # 2026-10-05 — uncovered slice U3 (see the loc-budget note): the four
  # dispatch functions that have to name the new routes. `compileObjectKeysOrValues`
  # +9, `ensureProxyRuntime` +7, `compileForInStatement` +7,
  # `compileNewExpression` +1.
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/statements/loops.ts::compileForInStatement
  - src/codegen/expressions/new-super.ts::compileNewExpression
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
# 2026-10-06 — slice V1: `object-model/proxy-forward-carriers.ts` is a NEW file
# (baseline 0); its one `__is_truthy` is §20.1.3.4 step 4's ToBoolean of the
# descriptor's `enumerable` field — a CALL to the engine's existing helper, the
# same one every proxy front guard in `object-runtime-proxy.ts` uses.
  - src/codegen/object-model/proxy-forward-carriers.ts
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

### 2026-10-05 — Uncovered residue census and slice plan

Measurement-and-plan only; no source change. Fable lane, worktree branch
`issue-6651-uncovered-census` off `origin/main` @ `00ce95f075`.

**Input.** The fresh standalone baseline (`.test262-cache/test262-standalone-current.jsonl`,
fetched 2026-10-05, editions from `website/public/benchmarks/results/test262-file-editions.json`)
has **227** ES2015 rows that are not `pass`. The lead's grep matched 77 of them by name to the
in-flight ES2015 issues (#6766, #6767, #6770–#6775, #6835, #6836, #4759, #4760, #5197, #5318,
#5350); the other **150** are the census population here.

**Measurement lane.** Every one of the 150 was re-run on `00ce95f075` with
`JS2WASM_EVAL_ENGINE=quickjs npx tsx scripts/run-test262-paths.mts <chunk> --standalone --isolate`,
seven 24-row chunks, one runner at a time (13:49–14:09 UTC, ~3.3 min per chunk, 4-core box at
load ≈2.4). Bundles rebuilt first (`build:compiler-bundle`, `build:runtime-bundle`); the
QuickJS provider rebuilt from the prebuilt artifact (`node scripts/build-quickjs-eval-provider.mjs`,
artifact `95333826e7c8`, adapter key `6a3c1f0aafe3e4c4`) because the cached adapter
`d4799bda84cfed0d` keyed a different bundle. Zero `error` rows. Probes (`.tmp/probes/p01`–`p15`,
gitignored) ran through the REAL runner (`runTest262File`, standalone, QuickJS) via a 20-line
driver `.tmp/probe.mts`, not the snippet lane P1 warned about.

**Result on current main: 1 of the 150 passes now** (`language/module-code/instn-uniq-env-rec.js`,
nominally #5157 F / #5199 — drop it from every list below); **141 fail, 8 compile_error.**

#### Coverage — who owns what

"Owned-active" = an in-flight issue (`status: ready|in-progress|in-review`) names the row (path,
brace or family notation) as in-scope work AND holds a live `origin/issue-assignments` claim or
has an open PR. "Owned-nominal" = named as in-scope by an in-flight issue file that has **no**
live claim and **no** open PR (checked 2026-10-05: `claim-issue.mjs --check` answers
`RESERVED — nobody working` for #5140/#5157/#5271, blank/unassigned for #5151/#5154/#5176/#5198).
None of the 17 open PRs on loopdive/js2 (`gh api repos/loopdive/js2/pulls?state=open`) names any
of the 150 rows; the only PRs near this population are #6246 (`eval-spread*`, which are in the
77 covered rows) and #5883 (#5197 Promise, likewise covered). A mention in an exclusion table
("blocked, not implementable", "NO — excluded by dispatch", `trap-growth-allow:` frontmatter) is
**not** ownership and is listed as unowned.

| class | rows | owner → rows |
| --- | ---: | --- |
| owned-active | **15** | #3371 (claimed `fable-es6`): `Function/prototype/bind/{get-fn-realm,get-fn-realm-recursive,instance-construct-newtarget-boundtarget,-boundtarget-bound,-self-new,-self-reflect}` (6, rows 30–33 + the two `self-*` rows #5269 X1 hands to its bound-carrier slice), `Proxy/construct/trap-is-{missing,null,undefined}-target-is-proxy` (3 CE, rows 25/27/28), `Proxy/construct/trap-is-undefined-proto-from-cross-realm-newtarget` (row 26), `Proxy/get-fn-realm{,-recursive}` (rows 21/24) · #2200 (claimed `dev-1769`): `annexB/language/function-code/function-redeclaration-switch` (family) and `annexB/language/statements/labeled/function-declaration` (by #5158 L265 / #5271 L141 attribution; #2200 itself names only the `function-code/*` and `global-code/*` families) · #6834 (claimed `module_self_import_sol`, in-review): `module-code/instn-named-bndng-gen` |
| owned-nominal | **47** | #5271 (statements r2, no claim): `arguments-object/{mapped,unmapped}/Symbol.iterator` (F1), `block-scope/leave/outermost-binding-…` (J3), `statements/{const,let}/block-local-closure-{get,set}-before-initialization` (B2, 3), `statements/with/{get-binding-value-call-with-proxy-env,has-binding-call-with-proxy-env,set-mutable-binding-binding-deleted-with-typed-array-in-proto-chain}` + `statements/variable/binding-resolution` + `destructuring/binding/keyed-destructuring-…-with-bindings` (D, 5), `statements/with/unscopables-inc-dec` (D5, deferred to #4206), `types/reference/{get,put}-value-prop-base-primitive` (I, 2) — 14 · #5157 (modules-eval-with wave 1, in-review, no claim, no PR): `global-code/{decl-lex,script-decl-func,-func-err-non-configurable,-lex,-lex-restricted-global,-var,-var-collision}` (E, 7), `statementList/eval-class-array-literal{,-with-item}` (G, 2), `module-code/{instn-iee-bndng-gen,instn-uniq-env-rec}` (F, 2 — the latter now passes) — 11; **#5271 X4/X5 re-scope E and G to Lane A (#4242, the QuickJS eval-engine bridge)**, so these 9 are nominal twice over · #5140 (proxy wave 1, in-review, no claim): `Proxy/{apply,defineProperty,getOwnPropertyDescriptor,set,setPrototypeOf}/trap-is-*-target-is-proxy` (cluster 3, 10) + `Proxy/getOwnPropertyDescriptor/trap-is-undefined` (cluster 5) — 11 · #5151 H: `{Map,Set,WeakMap,WeakSet}/proto-from-ctor-realm` — 4 · #5154 A(a): `for-of/dstr/{const,let,var}-ary-init-iter-get-err-array-prototype` — 3 · #5198 Slice-A pin list: `RegExp/prototype/exec/{failure,success}-lastindex-access` — 2 · #5176: `Proxy/ownKeys/call-parameters-object-getownpropertysymbols` — 1 · #5157 F / #5199: `instn-uniq-env-rec` (passes) — 1 |
| unowned | **88** | listed by cause below |

Row-level table: `owners.tsv` in the lane scratchpad (ephemeral); the classification is
reproducible from the issue files under `plan/issues/` with the full-path, `dir/{` and `dir/*`
grep described above.

#### The 88 unowned rows by root cause (probe evidence per group)

| # | group | class | rows | evidence |
| --- | --- | --- | ---: | --- |
| G1 | **`Object.getPrototypeOf` over a DYNAMICALLY-typed native carrier answers `null`** (R1's array defect generalised) + realm-global name forwards | (a) | **30** | p02, no realm anywhere: `Object.getPrototypeOf(id(new Error()))`, `…(id(new RangeError()))`, `…(Reflect.construct(Error\|RangeError\|Map\|String\|Date, [], NT))` with `NT.prototype = null` — **all seven answer false** (the NativeErrors rows print `SameValue(«null», «[object Object]»)`). R1 added `arrayGetPrototypeArm` in `object-runtime-prototype.ts:230` for `__vec_*` carriers only; Error/Map/Set/wrapper/Date/RegExp/Promise/DataView/function carriers still fall through to the null answer. Second half, p01: `$262.createRealm().global[name]` resolves only `Array Error RangeError TypeError` (+ the four X1 seeds); `Object Function Boolean Number String Date RegExp Map Set WeakMap WeakSet Promise DataView` answer `undefined` through a computed read, and `new other.Function('…')` returns `undefined` (p11) even though the static read `other.Function` is a function. Rows: `Array/{from,of}/proto-from-ctor-realm`, `{Boolean,DataView,Error,Number,Object,Promise,RegExp,String,WeakMap}/proto-from-ctor-realm`, `Date/proto-from-ctor-realm-{one,two,zero}`, `NativeErrors/{EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError}/proto-from-ctor-realm`, `Function/proto-from-ctor-realm{,-prototype}`, `Function/prototype/bind/proto-from-ctor-realm`, `GeneratorFunction/proto-from-ctor-realm{,-prototype}`, `RegExp/prototype/Symbol.split/splitter-proto-from-ctor-realm`, `Function/internals/Construct/base-ctor-revoked-proxy-realm` (p11: `new <revoked proxy>` throws nothing), `Function/call-bind-this-realm-value`, `Proxy/construct/trap-is-undefined-proto-from-newtarget-realm` (S1 measured it flips on the forwards alone), `language/expressions/super/realm` |
| G2 | **ArraySpeciesCreate ignores `@@species` on a non-Array constructor** | (a) | 5 | p03, no realm: `C = function(){}; C[Symbol.species] = CustomCtor; array.constructor = C; array.map(f)` → prototype is `Array.prototype`, spec says `CustomCtor.prototype`; `array-subclass-receiver.ts:23` records "@@species not in scope". Rows: `Array/prototype/{concat,filter,map,slice,splice}/create-proto-from-ctor-realm-non-array` — they reach their assertion today (`SameValue(«[object Array]», «[object Object]»)`), the realm part is incidental |
| G3 | **TypedArray residue** | (a) | 11 | p07/p15: `ArrayBuffer.isView(new (class extends Int8Array{})(0))` → false; `new Int8Array(<any-typed primitive>)` → length 0 for `"1"`, `true`, `1.9` (the object-arg path is taken for a non-object); `new Int8Array(arr)` ignores an `Array.prototype[Symbol.iterator]` override (2 vs 4); `Reflect.set(ta, 0, v, receiver)` with a foreign receiver never writes `receiver[0]`; `sample.join()` honours an own `length` accessor (`getCalls` 1 vs 0, same for `toLocaleString`); `TypedArray.from` into itself traps `illegal cast`; `harness/testTypedArray.js` reads `callCounts[name]` as `undefined`. Rows: `ArrayBuffer/isView/arg-is-typedarray-subclass-instance`, `TypedArray/from/{from-typedarray-into-itself-mapper-detaches-result,iterated-array-changed-by-tonumber}`, `TypedArray/prototype/{join,toLocaleString}/get-length-uses-internal-arraylength`, `TypedArrayConstructors/ctors/length-arg/toindex-length`, `TypedArrayConstructors/ctors/object-arg/{iterated-array-changed-by-tonumber,iterated-array-with-modified-array-iterator}`, `TypedArrayConstructors/internals/Set/{key-is-in-bounds-receiver-is-not-typed-array,key-is-out-of-bounds-receiver-is-proto}`, `harness/testTypedArray` |
| G4 | **Proxy MOP residue (non-realm)** | (a) | 7 | p08/p12/p13/p14: a trapless `delete p.attr` answers `true` but the target still has `attr` (strict and sloppy); `Reflect.deleteProperty(p, nonConfigurable)` answers `true`; `for (k in new Proxy([1,2,3], …))` yields nothing and `for (v of p)` / `p[Symbol.iterator]()` throw "value is not iterable"; the `desc` argument handed to a `defineProperty` trap is not an ordinary object (`Object.keys(_desc)` → "Cannot convert undefined to object"); `"length" in Object.create(Array.prototype)` is false (`"push" in` is true) so `with (target) { length }` throws ReferenceError — P1's finding, no proxy involved; `Object.setPrototypeOf(t, p)` inside a `setPrototypeOf` trap is invisible to a later `Object.getPrototypeOf(outro)` (the F2 fold on a `var outro = {}` carrier). Rows: `Proxy/deleteProperty/trap-is-undefined-{strict,not-strict}`, `Proxy/enumerate/removed-does-not-trigger`, `Proxy/defineProperty/call-parameters`, `Proxy/has/trap-is-undefined-using-with`, `Proxy/setPrototypeOf/not-extensible-target-same-target-prototype`; plus `Proxy/ownKeys/return-not-list-object-throws-realm` (1, the member-callee admission already specified in "Remaining Proxy realm control" above) |
| G5 | **for-of residue** | (a) | 3 | p05/p06: `for (var x of map)` over `{0:'a', true:false, null:undefined, NaN:obj}` — the probe reads all four pairs, but the original row fails `x[0]` = `null` where `false`… the entry pair's boolean/`null` slot comes back `null` through the `[k, v]` pair array (`SameValue(«null», «false»)` at L27); `throw` from a `finally` inside a for-of body runs that `finally` **twice** (`i === 2`): the iterator-close `finallyStack` entry (`loops.ts:3217`) and the `catch_all` close-on-throw wrapper (`:3362`) each re-enter the user block; `for ({[a.b]: x} of [{}])` with `a` undefined throws nothing. Rows: `for-of/map`, `for-of/throw-from-finally`, `for-of/dstr/obj-prop-name-evaluation-error` |
| G6 | **Map/WeakMap constructor: module-scope array identity through an iterator `value`** | (a), deeper | 4 | p04: `Object.defineProperty(item, 0, {get(){throw}})` then `new Map({[Symbol.iterator]: () => ({next: () => ({value: item, done:false}), return(){count++}})})` → `TypeError: Iterable did not terminate`, `return` never called — exactly the hazard `new-super.ts:5570–5595` documents: the accessor install is keyed by vec identity and the iterator hands back a COPY, so the drive never sees the throw and hits the 4M-step cap. The non-object-item twin (`value: 1`) closes correctly (TypeError, `return` called once). Rows: `{Map,WeakMap}/iterator-item-{first,second}-entry-returns-abrupt` |
| G7 | **needs a genuinely DISTINCT realm** — unsatisfiable with the forwarding shim | (b) | **19** | X1's 16 (`RegExp/prototype/{global,ignoreCase,multiline,source,sticky,unicode}/cross-realm`, `Error/prototype/stack/{getter,setter}-cross-realm`, `ThrowTypeError/distinct-cross-realm`, `Symbol/{for,keyFor}/cross-realm` — measured today: `notSameValue(Symbol.for, OSymbol.for)` fails because they ARE the same function —, `String/prototype/{toString,valueOf}/non-generic-realm`, `Function/prototype/apply/{argarray-not-object,this-not-callable}-realm`; `tagged-template/cache-realm` is ES2015 but in the covered 77) + `Proxy/revocable/tco-fn-realm` (`assert.throws(other.global.TypeError, …)` got the current realm's TypeError — the shim mints DISTINCT error ctors per #4634, so no compiled throw can ever match) + 3 the X1 scan did not flag: `Function/call-bind-this-realm-undef` (`func()` must `===` the realm global `other`, a plain object here), `Function/internals/Call/class-ctor-realm` (same `other.TypeError` identity), `language/eval-code/indirect/realm` (`other.eval('var x = 1')` must NOT create `x` in this global) and `language/expressions/call/eval-realm-indirect` (a local binding named `eval` holding `other.eval` must be an INDIRECT eval — with a forwarded `%eval%` the §13.3.6.1 direct-eval test is TRUE by construction) |
| G8 | **values minted inside the QuickJS eval tier carry the provider's intrinsics** | (c) | 7 | `Proxy/{apply,construct}/arguments-realm`: `f().constructor === Array` prints two native functions that are not the same — the args array was created in the QuickJS heap. Same boundary for `Function/internals/Construct/derived-{return-val,this-uninitialized}-realm` (`other.eval('class extends Object { constructor(){ return null } }')`, `new C()` must throw THIS realm's TypeError/ReferenceError), `language/expressions/generators/eval-body-proto-realm`, `language/types/reference/{get,put}-value-prop-base-primitive-realm` (`other.eval('value.test262')` after `other.Number.prototype.test262 = …`). Reachable only if the adapter re-brands crossing values (arrays, errors, generator instances) onto the module's carriers — #4245's membrane, not a compiler slice |
| G9 | other lane's mechanism | (e) | 2 | `Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined-realm` — F2: the trap returns `null` and `isAbsent` reads it as `undefined`; needs a null/undefined-distinct value representation (#2106), not a guard. `Proxy/getPrototypeOf/not-extensible-same-proto` — #2917 "Not fixed (documented limits)": `Array.prototype` has two representations (alias vec vs `$NativeProto`), so the invariant compare fails; needs a single representation or a vec→externref canonicalisation |

Sum: 30 + 5 + 11 + 7 + 3 + 4 + 19 + 7 + 2 = 88. **(a) fixable in the standalone compiler: 60**
(G1–G6 = 30+5+11+7+3+4 = 60; G4's 7 = five Proxy rows + the inherited-`length` `with` row + the
ownKeys-realm row). **(b) realm: 19. (c) eval
boundary: 7. (d) `with`: 0** — the one `with/` row in the unowned set (`Proxy/has/trap-is-
undefined-using-with`) is an inherited-`length` HasProperty defect, not a `with` mechanism; the
five `with/` rows that ARE `with`-mechanism are #5271 D/D5 (nominal). **(e): 2.**

**Are (b), (c), (d) achievable in standalone at all?** The earlier verdicts stand and are
consistent with today's measurements:

- *Realm.* The F2 "realm verdict" (`plan/agent-context/6651-log.md` §"2026-09-22 … slice F2: the
  realm verdict"): the `*-realm*` rows are **measurable** (QuickJS provider present) and are
  ordinary defects, NOT environment. X1 (§"2026-09-26 — lane X1") then split the bucket: `$262`
  is ordinary JS compiled into the module (`scripts/test262-fyi-runtime.js`), `createRealm().global`
  **forwards** intrinsics, so every row that is *satisfiable when `other === current`* is reachable
  — and exactly the rows that assert a realm *difference* are not: "real realm isolation … XL —
  recommend wont-fix-with-reason … five subsystems for 16 rows". G7's 19 are those rows (16 + 3
  the mechanical scan missed because the difference is asserted through `this`, `eval` scoping or
  error identity rather than `notSameValue`). They become reachable only via #4274 (true realm
  identity — `ready`, claim released 2026-09-03, nobody working), so for this goal they are
  **out of reach without #4274**. S1's receipt adds the quantitative floor for G1: shim forwards
  alone are worth +3 and the widened seed list unblocks 23 more rows to reach their real
  assertion, which is the `GetPrototypeFromConstructor`/`getPrototypeOf` defect R1 then localised.
- *Eval.* The I6 receipt (log §"Phase 1 — per-row host verdict", rows `global-code/{decl-lex,
  script-decl-*}` and `statementList/eval-class-*`): "**eval capability gap** — NO, excluded by
  dispatch"; #5271 X4/X5 re-scoped them to Lane A (#4242) because `src/interp` is not on this
  path — the rows run through the QuickJS adapter's global-object bridge. They are achievable in
  standalone (the provider IS standalone wasm, no host import) but only by the eval-engine lane.
  G8 is the same boundary seen from the value side; it needs #4245's membrane (`in-progress`,
  unassigned). Neither is a compiler-slice here.
- *`with`.* W1's receipt (log §"2026-09-24 — lane W1") landed the Object Environment Record steps
  on both lanes; the standalone Tier-2 remainder is #5271 D (`withHasBindingImport` = plain
  `__extern_has`, no `@@unscopables` filter, static callees, `var` inside `with`). Achievable in
  standalone (the host lane already passes them), owned nominally by #5271, blocked only on
  nobody holding that claim.

#### Implementation slices — ordered, largest unowned fixable group first

Common constraints for every slice: no new host import without a standalone fallback (#2961 — the
`instn-*-gen` CEs above are exactly that leak: `standalone target emitted host imports: env::B`);
`src/runtime.ts` is at its line cap (20,194 lines) — new helpers go in a `src/codegen/*-native.ts`
module and are registered through the existing `registerNative`/`funcMap` path, never appended to
`runtime.ts`; the QuickJS adapter key hashes the compiler bundle, so after every `src/` edit run
`npm run -s build:compiler-bundle && npm run -s build:runtime-bundle && node scripts/build-quickjs-eval-provider.mjs`
before measuring, or every row reports a non-verdict; `scripts/test262-fyi-runtime.js` compiles
into every test262 module on every lane, so a change there is validated with a full host +
standalone sweep (S1), never a neighbourhood; per-PATH joins against this section's row lists,
never count deltas.

**Slice U1 — dynamic `__getPrototypeOf` arms for every native carrier + realm-global seeds (G1, 30 rows; also unblocks #5151 H's 4).**
- Files/functions: `src/codegen/object-runtime-prototype.ts` — add sibling arms to
  `arrayGetPrototypeArm` (L230) for the Error family (`$Error` brand → `%<NativeError>.prototype%`
  by the instance's brand id), Map/Set/WeakMap/WeakSet carriers, the Boolean/Number/String
  wrappers, Date, RegExp, Promise, DataView and ArrayBuffer, and callable carriers
  (closure/fnctor/bound → `%Function.prototype%`, native generator functions →
  `%GeneratorFunction.prototype%`); each arm follows R1's contract — "widens a MISSING answer,
  never replaces a present one", singleton reserved with a `ref.null.extern` body and filled at
  finalize, `ref.test` before any cast. `src/codegen/expressions/object-get-prototype-of.ts`
  (`tryCompileEs5GetPrototypeOfValue` L445, `tryEmitDynamicCallableGetPrototypeOf` L647) keeps
  the static folds; the new arms only matter for `any`-typed receivers (`Reflect.construct`
  results). `src/codegen/standalone-global-object-carriers.ts:45/90` — move
  `String Boolean Number Date RegExp Map Set WeakMap WeakSet` (+ `Object`) into
  `STANDALONE_GLOBAL_EVAL_SAFE_CONSTRUCTOR_NAMES` (S1's reverted experiment: all nine then resolve,
  zero status changes); keep `Function` behind the gate but make `new other.Function(src)` reach
  the existing dynamic-function path instead of answering `undefined` (p11) — that is the
  `%Function%` parity hazard X1 names, so it is the last sub-step and may be split out.
  `scripts/test262-fyi-runtime.js` — forward the eleven names S1 listed; land the `Object`
  forward together with the `Error/prototype/stack/*-cross-realm` host-import check S1 recorded
  (`env::Object_new`), those two rows are G7 and stay failing either way.
- Spec steps: §10.1.14 GetPrototypeFromConstructor step 4 (already right per R1 — the construction
  installs the intrinsic default); §20.1.3.… `Object.getPrototypeOf` / §28.1.… `Reflect.getPrototypeOf`
  → `O.[[GetPrototypeOf]]()` on every exotic/native carrier.
- Acceptance: p02 answers `true` ×7; the 30 G1 rows + `{Map,Set,WeakMap,WeakSet}/proto-from-ctor-realm`
  flip, per-PATH; `built-ins/{Object,Reflect}/getPrototypeOf/**`, `Reflect/setPrototypeOf/return-false-*`
  (the F2 fold) and X1's 1,680-row `built-ins/{Symbol,ArrayBuffer,DataView,Promise,global}/** +
  language/global-code/**` neighbourhood show 0 lost; the F1 `Function/prototype/toString/proxy-*`
  rows stay green if `Function` moves.

**Slice U2 — TypedArray residue (G3, 11 rows).**
- `src/codegen/expressions/new-super.ts` TypedArray constructor arm: a runtime `Type(firstArg)`
  check for an `any`-typed argument — not-object → §23.2.5.1 step 3 `ToIndex(length)` (p15: every
  primitive gives length 0 today); object → §23.2.5.1 step 6 `GetMethod(@@iterator)` through the
  real iterator protocol so an `Array.prototype[Symbol.iterator]` override is honoured, and
  `%TypedArray%.from` (§23.2.2.1 step 7–9) snapshots `values` into a List before any `ToNumber`
  (`iterated-array-changed-by-tonumber`, 0 vs 3 on the original row; the probe's `var` form
  already passes, bisect the `let`/`Int32Array` difference first). `src/codegen/builtin-value-read.ts:1248`
  + `dataview-native.ts::isViewRefTestInstrs`: `ArrayBuffer.isView` must test the
  `[[ViewedArrayBuffer]]` brand that a `class TA extends Int8Array` instance carries (today only
  the direct carriers). `src/codegen/ta-dyn-proto-methods.ts` (`join`, `toLocaleString`): read
  `[[ArrayLength]]`, never `Get(O,"length")` (§23.2.3.18 / .31). `src/codegen/expressions/call-namespace-static.ts:1382/1436`
  `Reflect.set` arm + the #2046 receiver path: §10.4.5.5 step 1.b.i — when `SameValue(O, Receiver)`
  is false, fall to `OrdinarySet(O, P, V, Receiver)` (creates `receiver[0]` as a data property,
  no `ToNumber`); when the receiver IS a typed array reached through a prototype chain, call
  `TypedArraySetElement` exactly once. `TypedArray.from.call(ctor-returning-target, target, mapfn)`
  with detachment: the `illegal cast` is a carrier mismatch in the mapped-write loop — find the
  `ref.cast` without a preceding `ref.test` and route through the existing detached-ordering lane
  (#6769 record, 2026-09-30). `harness/testTypedArray.js`: `callCounts[name]` on a `{}` keyed by
  constructor name through `testWithTypedArrayConstructors` — a dynamic-key read on a closed
  literal; smallest fix is to admit the harness's `callCounts` shape in the `with`-free dynamic
  object path (check `.tmp` probe first: the same code outside the harness).
- Acceptance: the 11 rows flip; `built-ins/TypedArray/**` + `TypedArrayConstructors/**` (2,000+
  ES2015-passing rows) and `#6769`'s pins show 0 lost; `harness/testTypedArray*` self-tests green.

**Slice U3 — Proxy MOP residue (G4, 7 rows) and, if #5140/#5176 stay unclaimed, their 12 nominal rows.**
- `src/codegen/object-runtime-proxy.ts` ~L1250 (`[[Delete]]` dispatch): when the trap is absent,
  FORWARD to `target.[[Delete]](P)` (§10.5.10 step 7) and return its boolean — today the dispatch
  answers `true` and leaves the target untouched (p12), and `Reflect.deleteProperty` on a
  non-configurable own property must answer `false`. Same file, `defineProperty` driver
  (~L747–975): the third trap argument must be `FromPropertyDescriptor(Desc)` as an ORDINARY
  `$Object` with exactly the present fields (p13: `Object.keys(desc)` fails). Iteration over a
  Proxy: `src/codegen/iterator-native.ts` GetIterator ladder (~L441–530) must `GetMethod(p, @@iterator)`
  through the proxy `get` dispatch (so a trapless proxy over an array iterates its target), and
  the for-in key walk must go through `ownKeys`/`getOwnPropertyDescriptor` dispatch (§14.7.5.6
  EnumerateObjectProperties) — the `enumerate` row asserts only that no `enumerate` trap fires.
  `src/codegen/object-runtime.ts:4644 __extern_has`: the proto walk must see `%Array.prototype%`'s
  own `length` (a data property, value 0) — p14 shows `"push" in` works and `"length" in` does not,
  so it is the `length` special-casing on the `$NativeProto` arm, not the walk; this one line also
  fixes the `with` row (#5271 D's HasBinding reuses `__extern_has`). `Proxy/setPrototypeOf/
  not-extensible-target-same-target-prototype`: the F2 fold in
  `expressions/object-get-prototype-of.ts:138 bindingHasExplicitPrototype` keeps folding a `var o = {}`
  whose prototype a later `Object.setPrototypeOf(o, …)` STATEMENT changed; widen the exclusion to
  "any `setPrototypeOf` call site whose first argument is this binding anywhere in the module",
  then re-run `Reflect/setPrototypeOf/return-false-*` which F2 names as the reason it was kept.
  `Proxy/ownKeys/return-not-list-object-throws-realm`: the member-callee admission specified in
  §"Remaining Proxy realm control — constructor admission, not list validation" above.
- Acceptance: G4's 7 flip; `built-ins/Proxy/**` (431 rows) and `built-ins/Reflect/**` 0 lost;
  #6766's pins (`$Object.$proto` proxy link) untouched — do NOT touch `buildProtoDispatch`.

**Slice U4 — for-of residue + collection-ctor identity (G5 + G6, 7 rows).**
- `src/codegen/statements/loops.ts:3217–3363`: the user `finally` must run once — when the body
  throws out of a `try/finally`, the `finallyStack` inlining and the `catch_all` close-on-throw
  wrapper both re-enter the user finally; make the iterator-close entry carry ONLY IteratorClose
  (§14.7.5.7 / §7.4.8) and leave the user finally to the normal exception lowering. `for-of/map`:
  the `[k, v]` entry pair for a `true` key reads `null` — `src/codegen/map-runtime.ts`
  `emitCollectionIteratorVec`/`$MapIter` pair array must box boolean/null keys as externref
  (`__box_*`), the #5151 B stepper is the right place. `for-of/dstr/obj-prop-name-evaluation-error`:
  evaluate the computed key `a.b` (ReferenceError/TypeError) BEFORE `GetIterator` consumes the
  element per §13.15.5.6 step order — `src/codegen/dstr-assign-iterator-drive.ts`. G6:
  `src/codegen/expressions/new-super.ts:5570–5595` — the fix the comment itself names: give a
  module-scope array literal that is returned from a closure (`value: item`) the SAME carrier
  identity the accessor install was keyed on (the `vecAccessorDescriptorDirty` side table),
  so `Get(item, "0")` runs the throwing getter and §24.1.1.1 step 8.h IteratorClose runs; then
  delete the 4M `stepCap` guard — it exists only to mask this.
- Acceptance: the 7 rows flip; `language/statements/for-of/**` (1,500+), `built-ins/{Map,Set,WeakMap,WeakSet}/**`
  0 lost; `Map/iterable-calls-set.js` and the other #5151 A rows unchanged.

**Slice U5 — ArraySpeciesCreate for non-Array constructors (G2, 5 rows).**
- `src/codegen/array-subclass-receiver.ts` (and the `speciesMap` note at L23): implement §10.4.2.3
  ArraySpeciesCreate steps 5–8 for `map/filter/slice/splice/concat` when `O.constructor` is a
  user constructor carrying `@@species`: `C = Get(O,"constructor")`; if `IsConstructor(C)` and
  `C[@@species]` is a constructor → `Construct(C, «length»)`; if it is `null`/`undefined` →
  `ArrayCreate`; a non-object `C` (`{}` with `@@species`) → TypeError. The realm clause (step 6.c)
  is a no-op under the forwarding shim and must not be special-cased. Reuse H6's proxy-aware
  species path (2026-09-29 record) so `create-proxy.js` stays green.
- Acceptance: 5 rows flip; `built-ins/Array/prototype/{concat,filter,map,slice,splice}/**` species
  rows (`create-species-*`, `create-ctor-*`) 0 lost.

**Slice U6 — adopt-or-release the nominal owners.** 47 rows are "owned" by issue files nobody
holds. Before any lane re-derives them: `claim-issue.mjs <id>` on #5271 (14 rows, root causes
already measured to file:line in its cluster table — D/B/F1/I/J3 are each a contained slice),
#5154 A(a) (3 rows — `maybeCaptureArrayProtoOverride` must capture `delete Array.prototype[Symbol.iterator]`),
#5140 clusters 3/5 (11 rows — `__proxy_create requireObject` misfires on a `$Proxy` target; P1
says the rows are composites with `Object.create(proxy)`, so pair with #6766's landed link
carrier), #5176 (1), #5198 (2). The 9 eval-engine rows (#5157 E/G) and `instn-iee-bndng-gen`
(#2961 host-import leak through a module-binding generator, #6834's family) go to Lane A /
#6834 — they are **not** compiler slices and are not counted below.

#### How many of the 227 are reachable for 100 %

Of the 227 non-pass ES2015 rows: 77 are named by the in-flight ES2015 issues (their plans carry
their reachability); of the 150 here, **1 passes already**, **15** are owned-active (#3371 12,
#2200 2, #6834 1), **47** owned-nominal, **88** unowned. Blocked on something no compiler slice
can deliver: **G7, 19 rows** (need #4274 true realms — "XL, wont-fix-with-reason" per X1) and
**G8, 7 rows** (need the eval-tier membrane, #4245), plus **G9, 2 rows** behind value-representation
work (#2106 null/undefined; #2917 `Array.prototype` dual representation) and the **9** #5157 E/G
rows behind the eval-engine lane (#4242). Everything else — **60 unowned fixable (U1–U5) + 37
nominal compiler rows (U6; 47 nominal − 9 eval-engine − 1 passing) + 15 owned-active** — is
reachable by the slices above.
**Reachable: 227 − 19 − 7 = 201 (one of them already passing); with G9 and the 9 eval-engine rows
also assigned to their lanes, the remaining 26 are the honest ceiling gap until #4274 (true realm
identity) and #4245 (membrane) land.** That is 88.5 % of the residue reachable without new
architecture, and 100 % only with both of those.

### 2026-10-05 — Uncovered slice U1

Slice U1 of the uncovered-residue census (G1, plus #5151 H's four
`{Map,Set,WeakMap,WeakSet}/proto-from-ctor-realm` rows). Senior-dev lane, branch
`issue-6651-u1-getproto` off `origin/main` @ `f7ab45d2fe`. Standalone measurements
use `JS2WASM_EVAL_ENGINE=quickjs npx tsx scripts/run-test262-paths.mts <list> --standalone --isolate`
with one runner at a time; base and branch were both measured locally, never against
the CI artifact alone.

**What changed (three parts):**

1. `src/codegen/native-carrier-get-prototype.ts` (new) adds `__getPrototypeOf` arms for
   every native carrier R1 did not cover. Covered: `$Error_struct` (exact builtin tag,
   `$userClassId == -1` only); `$Map` (Map/Set/WeakMap/WeakSet by the `kind` field);
   `__Date`; `$Promise`; `__StandaloneRegExp`; and the boxed-primitive wrapper `$Object`
   (null `$proto`, no `OBJ_FLAG_NULL_PROTO`, `FLAG_INTERNAL` `[[PrimitiveValue]]` slot).
   The wrapper case answered `%Object.prototype%` before, where §10.4.3 says
   String/Number/Boolean.prototype.
   - The arms are prepended at finalize from `fillArrayProtoSingleton`.
   - They answer only a brand whose `$NativeProto` global the module already
     materialised, so the module's own `X.prototype` read stays the same `ref.eq`
     identity. A module that never names the intrinsic is byte-identical.
   - Spec: §20.1.2.12 / §28.1.8 → `O.[[GetPrototypeOf]]()` on an ordinary object
     created by §10.1.13 with §10.1.14 step 4's intrinsic default.
2. `src/codegen/standalone-global-object-carriers.ts`: in a runtime-eval module, the
   realm-global seeds now also install `String Boolean Number Date RegExp Map Set WeakMap
   WeakSet`. Every test262 module is a runtime-eval module.
   - These names are appended after the existing four eval-safe names, so a non-eval
     module's seed order and bytes are unchanged.
   - `Function` stays behind the gate.
3. `scripts/test262-fyi-runtime.js`: `createRealm().global` now also forwards `Boolean
   DataView Map Number Object Promise RegExp Set String WeakMap WeakSet`.
   - The 2026-08-23 `Object` landmine note is replaced. The row it named
     (`dynamic-import/assignment-expression/import-meta.js`) is in the gc control
     below.

**Before → after (standalone, per path, local base vs local branch):**

| set | base pass | branch pass |
| --- | ---: | ---: |
| G1 (30) + #5151 H (4), 33 unique rows | 0 | **14** |
| collateral: G2 `Array/prototype/{concat,filter,map,slice}/create-proto-from-ctor-realm-non-array` | 0 | **4** |
| probe p02 (7 checks) | 0/7 | 7/7 |

Rows that flipped: `{Boolean,DataView,Map,Number,Object,Promise,RegExp,Set,String,WeakMap,WeakSet}/proto-from-ctor-realm`
and `Date/proto-from-ctor-realm-{one,two,zero}`. These 14 plus G2's four are +18.

**Controls:**

- Standalone status control over 493 rows. The rows: a seeded random 300 from the
  2026-10-05 standalone baseline, every non-staging `createRealm` file (193), and G1.
  Branch vs the CI artifact showed 28 pass→non-pass rows.
  - 27 are `built-ins/Temporal/**` (Temporal provider absent locally).
  - 1 is `RegExp/regexp-modifiers/remove-ignoreCase-affects-characterEscapes.js`
    (local Node rejects the regex).
  - All 28 fail identically on the local base. **Local base vs local branch: 0
    pass→non-pass, 18 fail→pass, 2 fail→compile_error** (see residuals).
- gc control: see the receipt line appended below.
- Compile-only byte differential: playground examples, `examples/`, and
  `benchmarks/suites` × {gc, wasi, standalone} are byte-identical. The one exception is
  `examples/native-messaging/nm_js2wasm_node_process.ts` standalone, which gains the
  Error arm. Its tests (`issue-2834`, `issue-2735`, `issue-2807`) pass.
  - A test262 byte differential is not selective for this change. The shim and the
    eval-module seeds change every test262 module on both targets, so status controls
    stand in for it.
- Pin: `tests/issue-6651-u1-native-carrier-getproto.test.ts`, with no eval. Five
  RED-on-base witnesses and two guards (green on both): ordinary / explicit-null /
  re-parented wrapper answers unchanged, and a `class E extends Error` instance is not
  claimed.

**Residuals (19 of the 33 still fail):**

- **Unreachable without a distinct realm: 7 rows.**
  `Error/proto-from-ctor-realm` and `NativeErrors/*/proto-from-ctor-realm` (6) now
  answer the right intrinsic (`«Error»` vs `«[object Object]»`). They compare against
  `other.<Err>.prototype`, and the shim deliberately mints DISTINCT error constructors
  (`mkerr`, #4634), so `other.Error.prototype !== Error.prototype` by construction.
  These are G7, not G1.
- **`%Function%` sub-step, split out: 4 rows.** `new other.Function(src)` still answers
  `undefined` (p11).
  - Affected: `Function/proto-from-ctor-realm{,-prototype}`,
    `Function/call-bind-this-realm-value`, and
    `RegExp/prototype/Symbol.split/splitter-proto-from-ctor-realm`.
  - `Function` stays behind the eval gate (X1's parity hazard).
- **`other.eval` / QuickJS boundary: 2 rows.** `GeneratorFunction/proto-from-ctor-realm{,-prototype}`
  read `other.eval('(0, function* () {})')`, which is G8.
- **GetPrototypeFromConstructor in the construct ROUTES, not the reader: 5 rows.**
  - Affected: `Function/prototype/bind/proto-from-ctor-realm`,
    `language/expressions/super/realm`,
    `Proxy/construct/trap-is-undefined-proto-from-newtarget-realm`, and
    `Array/{from,of}/proto-from-ctor-realm`. The last two (`Array.from.call(C, …)`) build
    an Array instead of constructing `C`.
  - Measured without any realm, `Reflect.construct(<bound|derived class|empty fn>, [], NT)`
    with `NT.prototype = null` answers `null` instead of `%Object.prototype%`.
  - The empty-function shortcut in `call-namespace-static.ts` (`isEmptyOrdinaryFunction`
    → `__object_create(null)`) and the native construct driver (a null supplied proto
    means "use `callee.prototype`") are the two sites.
- **`Function/internals/Construct/base-ctor-revoked-proxy-realm`: 1 row.** `new` of a
  revoked `other.Proxy` throws nothing. Unchanged.
- **New host-import leak, already recorded by S1: `env::Object_new`.**
  `new realmB.Object()` lowers through the extern-class path. Two G7 rows,
  `Error/prototype/stack/{getter,setter}-cross-realm`, move fail → compile_error.
  This is not a pass loss, but it is a #2961 leak a follow-up should close: route a
  non-identifier `ObjectConstructor`-typed callee to the dynamic construct path in
  standalone.
- **Arm residual.** A native carrier has no prototype slot, so these keep the intrinsic
  default where they answered `null` before:
  - a `class M extends Map/Date/RegExp/Promise` instance;
  - `Object.setPrototypeOf(<native carrier>, p)`;
  - `Reflect.construct(Map, [], NT)` with an object `NT.prototype`.

#### U1 amendment — 2026-10-05, after the merge-queue park of PR #6504

The merge group parked #6504: **158 standalone `built-ins/Temporal/**` rows went
pass → `illegal_cast`** (trap in `__call_fn_method_1` via the linked Temporal
provider's `__js2wasm_link_local_method_call`). U1's own controls could not see
it: locally every Temporal row fails on base too unless the standalone Temporal
provider is built and linked (`JS2WASM_TEMPORAL_CACHE=.test262-cache/temporal
node scripts/prewarm-temporal-provider.mjs --target standalone`), and the rows
only trap in-process, not under `--isolate`.

Bisection, 60 `Temporal/Duration/prototype/round/*` rows, in-process, provider
linked: main + #6505 → 57 pass / 0 casts; + U2 alone → 57 / 0; + U1 → 48 / 10
casts; U1 with the `getPrototypeOf` arms OFF → still 48 / 10; U1 with only the
`standalone-global-object-carriers.ts` seed list reverted → **57 / 0**. So the
cause is the nine names U1 added to `STANDALONE_GLOBAL_EVAL_SAFE_CONSTRUCTOR_NAMES`
(`String Boolean Number Date RegExp Map Set WeakMap WeakSet`), not the arms.

Taken: the seed-list change is **reverted** (the file equals main again). The arms
stay, restructured as a FALLBACK — the original `__getPrototypeOf` body moves to
`__getPrototypeOf_base`, the new function calls it first and consults the
Error/collection/Date/Promise/RegExp arms only on a null answer, so they can no
longer replace a present answer (e.g. a user `class X extends Map` instance's
own prototype). The boxed-wrapper arm stays in front (its test only matches a
null-`$proto` `$Object` with the internal primitive slot). Re-measured: arms on,
seeds reverted → 57 / 0 on the 60 rows.

Cost: U1's gains drop from 18 to **7** (`{DataView,Object,Promise}/proto-from-ctor-realm`
+ the four `Array/prototype/*/create-proto-from-ctor-realm-non-array`). The 11
`{Boolean,Map,Number,RegExp,Set,String,WeakMap,WeakSet}/proto-from-ctor-realm` and
`Date/proto-from-ctor-realm-{one,two,zero}` rows need the seeds; re-landing them
needs the in-process + linked-Temporal control above and a fix for whatever
the seeded globals do to method dispatch in eval-using modules. **Lesson for
every slice: run the Temporal family in-process with the linked provider before
handing back** — `--isolate` and an unlinked tree both hide this class.

### 2026-10-05 — Uncovered slice U2

TypedArray residue (census G3, 11 rows). Opus lane, branch
`issue-6651-u2-typedarray` off `origin/main` @ `f7ab45d2fe`. Base copy of `src/`
taken before the first edit (`.tmp/base/src`); every "base" number below was run
by this lane on that copy or on the fork point, not read from an artifact,
except where it says so.

**Rows** (`JS2WASM_EVAL_ENGINE=quickjs … run-test262-paths.mts --standalone
--isolate`, QuickJS provider rebuilt for each tree): **base 0 pass / 11 fail →
branch 5 pass / 6 fail.**

| row | base | branch | mechanism |
| --- | --- | --- | --- |
| `harness/testTypedArray.js` | fail | **pass** | the final loop's `var name = …` is NESTED in a `for`; a later read of `name` resolved to lib.dom's ambient `name` and became `globalThis.name` (undefined). The #2176 finder (`findUserBindingDecl`) only searched a scope's top-level statements; it now also walks VarScopedDeclarations (`findHoistedVarDecl`, `index.ts`), and `hoistedScriptVarRead` (`identifiers.ts`) reads the script-level global such a `var` is registered under. Not the plan's "dynamic-key read on a closed literal" — the key was `undefined`. |
| `TypedArray/prototype/join/get-length-uses-internal-arraylength` | fail | **pass** | §23.2.3.18 step 3 reads TypedArrayLength. The extern join lane read `__extern_length` (LengthOfArrayLike, which honours an own `length` accessor since #6771 S2c). `taDynJoinLengthInstrs` (`ta-dyn-method-call.ts`) reads a `$__ta_dyn_view`'s internal length; used by `compileArrayJoinExternNative`. |
| `TypedArray/prototype/toLocaleString/get-length-uses-internal-arraylength` | fail | **pass** | same rule (§23.2.3.32 step 3) on the two lanes a dyn-view `toLocaleString()` takes: `__array_to_primitive_string` (the `__extern_toString` join) and `__ta_to_locale_string`. Both append locals only when the module has a dyn view, so other modules keep their bytes. |
| `TypedArray/from/iterated-array-changed-by-tonumber` | fail | **pass** | §23.2.2.1 step 5 drains the iterable BEFORE any ToNumber; the static `TA.from(array)` copy read the source's backing array live, and `values.length = 0` clears it in place. `emitRefElemArraySnapshot` (`dataview-native.ts`) copies a reference-element source first; primitive-element sources are untouched. |
| `TypedArrayConstructors/ctors/object-arg/iterated-array-changed-by-tonumber` | fail | **pass** | same snapshot in the dyn ctor's `$ObjVec` and externref-vec arms (§23.2.5.1.1 step 6.a). |

**Residuals (6)** — first failing assertion on the branch, mechanism:

| row | first failure | why not here |
| --- | --- | --- |
| `ArrayBuffer/isView/arg-is-typedarray-subclass-instance` | `assert(ArrayBuffer.isView(sample))` | not an `isView` brand gap: `class TA extends ctor {}` over a RUNTIME heritage compiles to a closed struct whose `T_new` takes no parameters — the parent is never constructed (`len` undefined, `instanceof ctor` false). Even a static `class S extends Int8Array` is the #3239 identity-only empty vec (`new S(3).length === 0`). Needs faithful TypedArray subclass construction. |
| `TypedArray/from/from-typedarray-into-itself-mapper-detaches-result` | `RuntimeError: illegal cast` | not the mapped-write loop: `target.set([0, 1, 2])` traps first. With `detachArrayBuffer.js` included every top-level binding is an externref proxy global, so `compileTypedArraySet` (`array-methods.ts`) `ref.cast`s a buffer-backed `$__ta_view_Int8Array` to the element vec `$__vec_i8_byte`. Needs a runtime `$__ta_view` arm in that lowering (the #5150 module-global spill only covers ref-typed globals). |
| `TypedArrayConstructors/ctors/length-arg/toindex-length` | `-0 length`, expected reads `[object Object]` | value representation: `item[1]` over the nested heterogeneous literal is re-boxed through `__any_box_extern_s1` as a tag-5 box (the #1888 lie), and `__extern_get_idx` leaks a raw `$AnyValue` when `__any_to_extern` is not registered. Separately `new TA(true)` gives length 0 (`"1"` already gives 1). #5185 / #2141 family. |
| `…/object-arg/iterated-array-with-modified-array-iterator` | `ta.length` 1 vs 4 | a patched `Array.prototype[Symbol.iterator]` is not consulted (#6484). |
| `…/internals/Set/key-is-in-bounds-receiver-is-not-typed-array` | `receiver[0] === value` false | function-membered literal identity across an externref round trip (#2773 / #3037), unchanged since #6769. |
| `…/internals/Set/key-is-out-of-bounds-receiver-is-proto` | `valueOf` called 0× | `Object.create(<TA>)` — no TA arm in the prototype walkers (#6769 residual). |

**Side finding, not fixed (pre-existing on base):** two sibling closures that
each declare a `values` captured by an object-literal METHOD share one
name-keyed `__captured_values` global (`closures.ts` promotion,
`ctx.capturedGlobals`), so the second closure reads the first one's value
(`.tmp/u2/c10.js`: 27 on base and branch, 31 expected). A first attempt to
observe nested `var` declarations in the Program-ABI registry for the
`testTypedArray` fix made that collision fire inside the
`testWithTypedArrayConstructors` callback and was withdrawn.

**Controls.**
- Pins `tests/issue-6651-u2-typedarray-residue.test.ts`: 5 exact rows + 3
  inline mechanisms + 1 guard; inline programs on base 0 / 3 / 3 (expected
  7 / 7 / 7), guard 3 on both; the 5 rows fail on base (table above). Branch:
  9/9 pass. No eval dependency.
- Runtime control, `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView}/**`
  (2,966 rows; base verdicts from the 2026-10-05 standalone baseline JSONL,
  2,324 pass): screened IN-PROCESS on the branch (`.tmp/u2/ctl.mts`, one verdict
  per row). See the U2 hand-off for the coverage reached; 0 base-pass rows lost
  in the screened prefix, +1 gained (`from/iterated-array-changed-by-tonumber`).
- Playground (`website/playground/examples`) + `benchmarks/suites`, gc and
  standalone, base vs branch compiled in separate processes: 34/34 binaries
  byte-identical.
- `node scripts/equivalence-gate.mjs`: 22 failing = the 22 known failures, no
  new regression.
- Byte differential over the TA control set was started and stopped after 57
  rows (9 differ — every harness module with a dyn-view constructor gains the
  snapshot / internal-length arms), so the runtime screen is the control.

### 2026-10-05 — Uncovered slice U4

Slice U4 of the uncovered-residue census (G5 for-of residue + G6 collection-ctor
identity, 7 rows). Senior-dev lane, branch `issue-6651-u4-forof-collections` off
`origin/main` @ `4d42eec28e`. Every number below is a local run on this box:
`JS2WASM_EVAL_ENGINE=quickjs npx tsx scripts/run-test262-paths.mts <list> --standalone --isolate`,
one runner at a time, QuickJS provider rebuilt after every `src/` change. The
base side ran the same runner against a copy of base `src/` (the provider
binary was the branch build; none of the base-checked rows evaluates code).

**Three of the census root causes were wrong; the rows still flip.**

| row(s) | census said | measured cause | fix |
| --- | --- | --- | --- |
| `for-of/map.js` | Map pair array boxes a boolean/null key as `null` | the Map iteration is right (probe p05 reads all four pairs). The fixture's `first = second; second = third; …` chain is the defect: `second` is a `boolean[]` slot, so `second = third` COPIED `[null, undefined]` into an i32 vec as `[false, false]` and the array identity was lost | `declarations/array-rebind-element-widening.ts`: module bindings assigned to one another (`x = y`) form an alias group; a group that holds both object-domain and primitive-domain arrays gets the externref-element vec for every member. A widened `[…]` initializer is built straight into that vec (a converted `true` came back as the number 1) |
| `for-of/throw-from-finally.js` | for-of iterator-close entry + close-on-throw wrapper both re-enter the user finally | not for-of at all. ANY `try { } finally { i++; throw e }` ran its finally twice, on both lanes: the inlined normal-exit finally sits inside the statement's own catch_all. The same placement let a catch clause catch its own finally's throw | `statements/finally-ran-guard.ts` (new): one i32 flag per try-with-finally, raised before every inlined finally copy (normal exit, break/continue/return sites, catch-body wrapper); every handler of the statement propagates untouched while it is set. IR twin in `ir/lower-generic.ts` (`try` arm + `resolveBrLabel`) |
| `for-of/dstr/obj-prop-name-evaluation-error.js` | evaluate the key before GetIterator (`dstr-assign-iterator-drive.ts`) | both for-of object-pattern arms SKIPPED a computed key they could not resolve statically, so `[a.b]` was never evaluated | `dstr-assign-iterator-drive.ts::evaluateForOfPatternKey` evaluates it in source order and the extern-get arm reads the runtime key; the struct arm hands a runtime-key pattern to the extern-get arm |
| `{Map,WeakMap}/iterator-item-{first,second}-entry-returns-abrupt.js` (4) | as named (`new-super.ts:5570`) | confirmed: `{ value: item }` typed its field from the checker (`string[]` vec) while `item` lives in the descriptor-carrier externref vec, so the store copied it and the accessor overlay (keyed by vec identity) never fired | `propertyValueWidenedArrayCarrier`: an object-literal property whose value is a widened module array binding takes that binding's carrier, so the store aliases |

Spec: §14.15.3 (a finally's abrupt completion replaces the try's completion;
it is not re-handled by the same statement); §13.15.5.3 PropertyDefinition
evaluation order; §24.1.1.1 step 8.h / §24.3.1.1 (`Get(item, "0")` abrupt →
IteratorClose).

**Before → after (standalone, per path):**

| set | base | branch |
| --- | ---: | ---: |
| the 7 U4 rows | 0 / 7 | **7 / 7** |
| collateral `language/statements/try/completion-values-fn-finally-abrupt.js` | fail | **pass** |
| pin suite `tests/issue-6651-u4-forof-collections.test.ts` (12, eval-free) | 3 / 12 (the 3 GUARDs) | 12 / 12 |

**Not done, deliberately.**

- The 4M-entry `stepCap` in `emitNativeCollectionCtorIterableDrive` stays. The
  plan says to delete it once identity is fixed, but only the object-literal
  store aliases now: `var it2 = f().value` (a checker-typed module `string[]`
  slot) and `[item][0]` still copy. The test262 runner has no wall-clock guard
  around execution, so a remaining copy shape would wedge a CI shard.
- The finally guard is OFF inside `async` functions. Measured on base and
  branch alike: `try { await rejected } catch { … }` in standalone resumes
  NORMALLY instead of throwing (`.tmp` probes q13/q15). Nine
  `harness/asyncHelpers-throwsAsync-*.js` rows pass on base only because their
  `finally { assert(caught) }` throws, the statement's own catch clause catches
  that throw (setting `caught`) and the finally runs again. With the guard on,
  those nine fail honestly. They belong with the await-rejection defect; the
  guard should extend to async bodies when that lands.
- Host lane: `for-of/dstr/obj-prop-name-evaluation-error.js` still fails on
  gc (`a.b` with `a` undefined reads `undefined` there; the key IS evaluated now).

**Controls.**

- Reach, by static scan of the 1,908 rows of `language/statements/for-of/**`,
  `built-ins/{Map,Set,WeakMap,WeakSet}/**`, `language/statements/try/**` and
  every test262 file containing `finally {`: 393 rows can reach a U4
  mechanism (202 `finally`, 14 for-of computed key, 40 `defineProperty`, 137
  identifier-to-identifier assignment). All 393 were status-checked on the
  branch; every branch non-pass row (41) and the collateral gain were then
  re-run on base. Result: **0 pass → non-pass**; all 41 fail on base with the
  same status and the same first error line. Against the CI artifact
  (2026-10-05 13:34) the branch shows 6 "pass → fail" rows, all
  `built-ins/Temporal/**/string-shorthand-no-object-prototype-pollution.js`:
  they fail identically on the local base (no Temporal provider locally, as
  U1 recorded).
- The other 1,515 rows: compile-only byte differential, base vs branch — a
  seeded 150-row sample on standalone AND gc (0 binaries differ), plus every
  remaining `for-of/**` / `{Map,Set,WeakMap,WeakSet}/**` row on standalone
  (1,285 rows). Those differ in 4 binaries, the
  `for-of/head-{,await-}using-*` rows, whose disposal lowering builds its own
  try/finally the static scan could not see; all 4 have the same status and
  message on base and branch (1 pass, 3 fail).
- Playground (`website/playground/examples/**`), `benchmarks/suites/**` and
  `examples/**`: 30 files × {gc, wasi, standalone} byte-identical.
- `node scripts/equivalence-gate.mjs`: 1,748 passing, the 22 known failures,
  no new failures (run on the final tree).

**Residuals for a later slice.** The copy shapes above (`var x = f().value`,
`[item]`); the standalone await-rejection defect; and the 13
`language/statements/for-of/dstr/obj-rest-*` rows in the reach set, which fail
on base and branch with the same message (not investigated here).

### 2026-10-05 — Uncovered slice U3

Slice U3 of the uncovered-residue census (G4, the seven Proxy MOP rows).
Senior-dev lane, branch `issue-6651-u3-proxy-mop` off `origin/main` @ `4d42eec28e`.
Base and branch were both measured locally (base = a copy of the fork-point
`src/` in a side tree), standalone, QuickJS eval engine. The #5140/#5176
nominal rows were NOT taken.

**Root causes (several differ from the census guesses):**

| Row | Census guess | Measured cause | Fix |
|---|---|---|---|
| `deleteProperty/trap-is-undefined-{strict,not-strict}` | dispatch does not forward | it does forward; the literal TARGET was a closed struct, so delete-then-`defineProperty(non-configurable)` left the delete marker and `Reflect.deleteProperty` answered `true` | a `new Proxy(o, …)` / `Proxy.revocable(o, …)` target joins #6770 S2's reflective-write reasons → open `$Object` (`object-literal-reflective-escape.ts`) |
| `defineProperty/call-parameters` | desc arg not ordinary | `Object.keys(_desc)` where `var _desc;` is assigned in the trap: the checker's control-flow type is `undefined`, so the #2746 nullish fold threw at compile time | `compileObjectKeysOrValues` declines the fold for an evolving nullish-narrowed `var` (the #5197 predicate) and guards ToObject at run time |
| `has/trap-is-undefined-using-with` | `__extern_has` length special case | `%Array.prototype%` had no `length` entry at all on the dynamic paths (has AND get) | seed own `length` 0 `{w:T,e:F,c:F}` into the Array companion (`native-proto.ts`); listed as a seeded own member |
| `enumerate/removed-does-not-trigger` | GetIterator / for-in through traps | TS types `new Proxy(arr, h)` as `number[]`: for-in took the vec index loop (0 iterations); GetIterator read no `@@iterator` closure off the vec target | for-in over a direct Proxy binding goes dynamic, `__object_keys_forin` gets the `$Proxy` guard; NEW `object-model/proxy-get-iterator.ts`: a trapless-`get` proxy over an array re-enters `__iterator` with its target |
| `setPrototypeOf/not-extensible-target-same-target-prototype` | F2 fold, widen to any `setPrototypeOf(binding)` | the write is on the trap's `t` parameter, not the binding | a Proxy TARGET is a dynamic-prototype receiver (`dynamicProtoReceiverNames`) |
| `ownKeys/return-not-list-object-throws-realm` | member-callee admission | as specified | `new <realm global>.Proxy(…)` admitted in both construct gates via `tracesToProxyConstructorValue` |

Both `__object_keys_forin` guard and GetIterator arm are gated on `ctx.proxyDirty`
(the source names `Proxy`): ungated they changed the bytes of ~30 % of
unrelated standalone rows.

**Rows (standalone, `--isolate`):** the 7 G4 rows 0 → 7, plus
`Array/prototype/length.js` and `Proxy/has/trap-is-undefined.js` (2 bonus).

**Controls:**
- 1,658-row in-process neighbourhood (every test262 file naming `Proxy`, every
  `Object.{keys,values,entries}` row, `language/statements/for-in/**`,
  `built-ins/{Reflect,Proxy}/**`, `Object/{get,set}PrototypeOf/**`, 36
  `Array.prototype` own-`length` rows, a 1-in-20 `Array.prototype` sample):
  base 477 non-pass, branch 468; **0 pass → non-pass**, 9 gained, 0 status
  changes among non-pass rows.
- standalone byte differential, 157-row random sample outside that set: 34
  differ (the Array `length` seed in harness modules); all 34 re-run
  `--isolate` on both trees: 0 lost.
- gc lane byte differential, 150-row sample of the set: identical.
- playground + examples (32 files, gc and standalone): byte-identical.
- `node scripts/equivalence-gate.mjs`: no new failures.
- Temporal, in-process with a linked standalone provider built FRESH per tree
  (the shared cache key does not hash the compiler; the two providers differ by
  76 B): `Duration/prototype/round/**` + every Temporal row naming `Proxy`,
  134 rows — base 127 pass / 7 fail, branch identical, 0 `illegal cast`.
- pins: `tests/issue-6651-u3-proxy-mop.test.ts`, 7 tests — 6 red on base, 1 guard.

**Residuals:** for-in over a Proxy does not walk keys inherited through its
`[[GetPrototypeOf]]`; `Array.prototype.values.call(p)` (static call path) and a
dynamic `arr[Symbol.iterator]` read still do not yield
`%Array.prototype.values%`; `String.prototype` / `Function.prototype` own
`length`/`name` are still missing on the dynamic paths.

### 2026-10-06 — Uncovered slice U5

Slice U5 of the uncovered-residue census (G2, ArraySpeciesCreate for non-Array
constructors). Senior-dev lane, branch `issue-6651-u5-species-v2` off
`origin/main` @ `47f186384c`. Base = a copy of the fork-point `src/` taken
before the first edit; every number below was run by this lane on both trees,
standalone, QuickJS eval engine, provider rebuilt per tree.

**Which rows were still open.** U1 flipped four of the five G2 rows
(`{concat,filter,map,slice}/create-proto-from-ctor-realm-non-array`, see the U1
amendment). Re-measured on the fork point: those four pass, only
`splice/create-proto-from-ctor-realm-non-array.js` fails
(`SameValue(«[object Array]», «[object Object]»)` at L43). #6771's rows
(`create-proxy`, `create-species-undef-invalid-len`,
`property-traps-order-with-species`) were not touched.

**Root cause — not the census guess.** The species prologue already exists
(`array-species.ts`, #5145) and runs for every producer, user constructors
included. The splice row differs from the slice row only in calling
`array.splice()` with NO arguments. `compileArraySplice`'s zero-argument
shortcut ran `emitArraySpeciesCreate` only when the receiver compiled to a vec
ref and **dropped** an `externref` receiver. Every test262 module is a
runtime-eval module, and there the module-global `var array = []` compiles as
`externref`. So `@@species` was never read for `a.splice()`, while `a.splice(0, 0)`
on the same receiver ran it (measured: that variant of the row passes on base).

**Fix (`array-methods.ts::compileArraySplice`, +4 lines).** The zero-argument
branch also admits an `externref` receiver and hands it to the prologue as-is,
without `extern.convert_any`. The gate is unchanged: `prepareArraySpeciesDeps`
returns `undefined` unless the target is standalone/wasi AND the module is
species-dirty, so every other module is byte-identical.

**Before → after (standalone, `--isolate`):**

| set | base pass | branch pass |
| --- | ---: | ---: |
| G2, 5 rows | 4 | **5** |
| control, 144 rows | 129 | 130 |

The 144 control rows are all of `built-ins/Array/prototype/splice/**`, every
`{concat,filter,map,slice}/create-*` file (species, ctor and proto rows), and
every non-staging test262 file that calls `.splice()` with no arguments.
Result: **0 pass → non-pass**, 1 fail → pass (the G2 row), and no other status
change.

**Controls:**
- Compile-only byte differential: 32 files under `website/playground/examples`,
  `benchmarks/suites` and `examples`, × {gc, standalone, wasi}. Byte-identical,
  and the 23 compile errors are the same on both trees.
- Temporal: all 126 `built-ins/Temporal/Duration/prototype/round/*.js` rows,
  run in-process (no `--isolate`). Each tree got its own bundles, a freshly
  prewarmed standalone Temporal provider (`JS2WASM_TEMPORAL_CACHE`) and a
  rebuilt QuickJS provider. Base and branch both give 119 pass / 7 fail, with
  the same rows, the same messages and 0 `illegal cast`.
- `node scripts/equivalence-gate.mjs`: 1,748 passing, the 22 known failures, no
  new regressions.
- Pin: `tests/issue-6651-u5-splice-zero-arg-species.test.ts`, no eval, 3 tests.
  Two fail on base and pass on the branch: species construction for a
  literal-backed and a call-returned receiver, and the step-9 TypeError for a
  non-constructor `@@species`. One guard is green on both: without species the
  result stays an empty Array and the receiver is not mutated.

**Residual, not taken.** It sits in #6771's territory, and no ES2015 row
depends on it. Inside a FUNCTION body, `var r; r = a.slice()` with a user
`@@species` constructor still answers an Array (`Array.isArray(r)` is true).
`r instanceof Ctor` holds and the constructor ran, so the species object is
built. The likely cause is that the evolving-`var` local slot is typed as a vec
and coerces the species result back into one. That is the class of #6771's S7
follow-up (`transferredArrayLikeResultNeedsExternref`). Not verified: whether
that hook sees this assignment shape. The same code at top level passes. Separately,
`Reflect.construct(F, [])` on a function whose `.prototype` was never read
before the construct answers a prototype that is not `F.prototype`. That is the
U1-recorded GetPrototypeFromConstructor construct-route residual, and U5 did not
widen it.

### 2026-10-06 — Uncovered slice U1b (seed re-land)

Re-lands U1's nine realm-global seeds (`String Boolean Number Date RegExp Map
Set WeakMap WeakSet` in runtime-eval modules), which were reverted after PR
#6504 parked on 158 standalone Temporal `illegal cast` rows (see the U1
amendment above). Opus lane, branch `issue-6651-u1b-seeds-v2` off `origin/main`
@ `47f186384c`. `src/` was copied to `.tmp/base/src` before the first edit.
Every "base" number below was run by this lane, except where it names the CI
baseline.

**Root cause.** The seeds were not wrong. They only changed type-index
numbering, and that exposed a latent cross-module dispatch bug. Measured on
`Temporal/Duration/prototype/round/balance-subseconds.js` (standalone, linked
provider, in-process), using a raw wasm stack and the bytes at the trap offset:

- The polyfill's `n.toPrecision(o)` (`de()`) misses in the provider. It takes
  the #6605 reverse method-call hop into the consumer, which resolves it to
  the **provider's** `Number.prototype.toPrecision` closure.
- The consumer then dispatches that closure with its own `__call_fn_method_1`.
- Native-prototype closures are claimed by `ref.test` on the per-(brand,
  member) meta struct, then an exact `bfnid` compare. `bfnid` is a
  **module-local type index**.
- Meta structs are structurally equal in every module, so a peer's closure
  passes the family test. The provider's `toPrecision` carries bfnid **719**.
- With `Set` seeded, the consumer's own `Set.prototype.values` meta type is
  also index 719.
- The arm casts the `(self, this, arg)` funcref to `values`' `(self, this)`
  signature and traps.

Unseeded, nothing local was 719. The foreign closure fell through to the
funcref-type ladder, which dispatches it correctly. This is not specific to one
of the nine names: any seed that materialises more native-prototype closures
shifts the local indices, so bisecting the names would only pick a lucky
numbering. #6643's note that bfnid "is a MODULE-LOCAL type index and is
therefore … an ownership answer" holds only while no peer closure can reach the
module.

**Fix.** `closures/transferred-native-proto.ts::linkedSignatureGuard`:

- In a canonically linked module (`ctx.mod.canonicalRuntimeRecGroup` set: the
  Temporal provider and its consumer, linked harness, package graphs), the
  bfnid claim additionally requires `ref.test` of the closure's funcref against
  the entry's exact signature.
- It applies at three sites: the `__call_fn_method_N` arm, the variadic
  `__apply_closure` arm, and the #6643 owned bit.
- A same-signature collision is harmless, because every arm calls through
  field 0, i.e. the peer's own function.
- Unlinked modules emit no guard and keep their bytes.

With the guard in place, the seed list change is exactly U1's
(`STANDALONE_GLOBAL_EVAL_MODULE_EXTRA_NAMES`, all nine names).

**Rows.**

| set | base | seeds only | seeds + guard |
| --- | --- | --- | --- |
| `Temporal/Duration/prototype/round/**` (126, in-process, linked) | 119 / 7, 0 casts | 95 / 31, **26 casts** | 119 / 7, 0 casts, same 7 rows |
| rest of `Temporal/Duration/**` + `PlainDateTime/prototype/{since,until}/**` (607, in-process, linked) | not run locally (time box); CI standalone baseline cache of 2026-10-05 13:34 used as the reference | — | 587 / 20, 0 casts; vs that baseline 0 pass→non-pass, 2 gained (`PlainDateTime/prototype/{since,until}/roundingmode-half-boundary.js`) |
| 11 targets (`--isolate`) | 0 / 11 per the CI standalone baseline (not re-run locally) | — | **11 / 11** |

**Controls.**

- playground + `benchmarks/{suites,cross-engine}`: 18 files × gc/standalone/wasi
  (54 compiles), byte-identical.
- The Temporal provider changes: 3,891,130 → 3,928,602 B, from the guard.
- `node scripts/equivalence-gate.mjs`: no new regressions (22 known failures,
  1748 passing).
- Every fast `quality` gate exits 0. Loc and func budgets also pass with
  `LOC_GATE_BASE=origin/main`, and the `check:compiler-boundaries` inventory is
  valid.
- Pins: `tests/issue-6651-u1b-seeds-linked-bfnid.test.ts`, 6 tests, 4 red on
  base. The 2 that pass on base are invariants: an unlinked module stays
  unguarded, and a linked module still dispatches.

**Not verified.**

- The full no-loss status check over
  `built-ins/{String,Boolean,Number,Date,RegExp,Map,Set,WeakMap,WeakSet}/**`
  (4,900 rows) was **not run** — it did not fit the time box on one runner.
  Run instead, on the branch only, in-process, against the CI standalone
  baseline: 136 rows, i.e. the 53 family rows that read `globalThis` /
  `createRealm` / `this.<Name>` / `eval(` plus the 83 eval-using rows elsewhere
  that name these globals. Result: 112 pass, **0 pass→non-pass**, 11 gained —
  exactly the 11 targets.
- No host linked-harness lane was run, and that lane's modules also carry
  `canonicalRuntimeRecGroup`, so they get the guard.

**Residuals.**

- Other bfnid exact-identity sites carry the same latent cross-module collision
  and are left unguarded: `char-at-transfer.ts` (calls the LOCAL function on a
  match), `apply-closure-variadic-builtin.ts`, `object-runtime.ts` builtin-fn
  get_meta/delete, and `ta-dyn-mop.ts`.
- A durable fix is a link-unique bfnid, or a guard at every site.
- Transferred `Number.prototype.toFixed` (`o.p = Number.prototype.toFixed;
  o.p.call(2.5, 1)`) throws on base and branch alike, linked or not.

### 2026-10-06 — Re-census after U1–U5 and the next slice plan

Measurement-and-plan only; no source change. Fable lane, branch
`issue-6651-recensus-2` off `origin/main` @ `42d289a96f` (U1–U5 merged; U1b open as
PR #6525).

**Input.** `node scripts/fetch-baseline-jsonl.mjs --standalone` refetched the CI
artifact (48,735 entries, timestamps `6.10.2026 01:08`). Joined per path against
`website/public/benchmarks/results/test262-file-editions.json`: **11,704 ES2015 rows,
11,477 pass, 227 not pass** (213 fail, 14 compile_error). The artifact predates U3/U5
and the U1 amendment, so every one of the 227 was re-run on `42d289a96f`:
`JS2WASM_EVAL_ENGINE=quickjs npx tsx scripts/run-test262-paths.mts <chunk> --standalone --isolate`,
ten 24-row chunks, one runner at a time (06:59–07:31 UTC, ~3.4 min per chunk).
QuickJS provider built from source (`npx tsx scripts/build-quickjs-eval-provider.mjs`,
artifact `95333826e7c8`, adapter key `1a5baed7a2da8086`); zero `error` rows and zero
"provider is not built" artifacts. Probes (`.tmp/probes/p01*`–`p07`, gitignored) ran
through the REAL runner (`runTest262File`, standalone, QuickJS) via `.tmp/probe.mts`.

**Result on current main: 29 of the 227 pass now** (U1 7, U3 9 incl. the two bonus
rows, U4 7, U5 1, `instn-uniq-env-rec`, `Object/proto-from-ctor-realm`,
`DataView/proto-from-ctor-realm`, `Promise/proto-from-ctor-realm`) — **ES2015 standalone
is 11,506 / 11,704 = 98.31 %**; **198 still fail (180 fail, 18 compile_error).**

#### Ownership of the 198

Rule: a row is **owned-active** when an issue that names it (full path, brace or
`dir/*` family notation, or basename + directory context) holds a live
`origin/issue-assignments` claim or has an open PR; **owned-nominal** when it is named
only by in-flight issue files with no claim and no PR; **unowned** otherwise. Open PRs
checked: all 21 (`gh api repos/loopdive/js2/pulls?state=open`); PR #6525 (U1b) names 11,
PR #6246 (draft, #5157 `eval-spread*`) 2, no other PR names a row. Claims checked with
`claim-issue.mjs --check` for every issue that names a row (read
`origin/issue-assignments`).

| class | rows | owner → rows |
| --- | ---: | --- |
| owned-active, live claim < 30 d or open PR | **51** | PR #6525 (U1b): `{Boolean,Map,Number,RegExp,Set,String,WeakMap,WeakSet}/proto-from-ctor-realm` + `Date/proto-from-ctor-realm-{one,two,zero}` (11) · #3371 `fable-es6` (09-04): `ArrayBuffer/prototype-from-newtarget`, `Date/subclassing`, `Object/subclass-object-arg` (CE), `bind/get-fn-realm{,-recursive}`, `bind/instance-construct-newtarget-boundtarget{,-bound}`, `Proxy/get-fn-realm{,-recursive}`, `new.target/value-via-reflect-construct` (CE), `super/call-construct-invocation` (CE), plus — shared with the stale #3031/#5181 claims — `Proxy/construct/trap-is-{missing,null,undefined}-target-is-proxy` (3 CE), `Proxy/construct/trap-is-undefined-proto-from-cross-realm-newtarget`, `Error/prototype/stack/getter-foreign-new-target` — 16 · #5197 `opus-5197` (09-30): `Function/proto-from-ctor-realm` (also #4648/#4649) · #5318 `fable-es6`: the 12 `language/statements/class/**` rows · #6766 `opus-6766`: `Proxy/defineProperty/trap-is-null-target-is-proxy`, `Proxy/has/call-in-prototype-index`, `Proxy/set/{call-parameters-prototype-index,trap-is-null-receiver}`, `Proxy/setPrototypeOf/trap-is-null-target-is-proxy`, `TypedArrayConstructors/internals/Set/key-is-{canonical-invalid,valid}-index-prototype-chain-set` — 7 · #6771 `opus-6771`: `splice/property-traps-order-with-species` · #6834 `module_self_import_sol`: `Proxy/preventExtensions/trap-is-undefined-target-is-proxy` (`ns is not defined`) · PR #6246 + #5157: `call/eval-spread{,-empty-leading}` |
| owned-active, **stale live claim** (> 30 d, no PR) | **31** | #3031 `fable-3031` (2026-07-09): `Proxy/apply/trap-is-{missing,null}-target-is-proxy`, `Proxy/construct/trap-is-undefined-proto-from-newtarget-realm` — 3 (its other six rows are #3371's or #4648's above/below) · #4648/#4649 `opus-4648/-4649` (08-23, js-host asyncHelpers / descriptor issues that name these rows in their error tables): `Function/internals/Call/class-ctor-realm`, `Construct/derived-{return-val,this-uninitialized}-realm`, `Function/proto-from-ctor-realm-prototype`, `GeneratorFunction/proto-from-ctor-realm{,-prototype}`, `Proxy/{apply,construct}/arguments-realm`, `eval-code/indirect/realm`, `generators/eval-body-proto-realm`, `types/reference/{get,put}-value-prop-base-primitive-realm` — 12 · #5181 `opus-5181-ab` (08-29): `Error/prototype/stack/{getter,setter}-cross-realm` (CE), `getter-subclass`, `Function/is-a-constructor` — 4 · #2515 `sd-6` (06-21): `Object/prototype/toString/symbol-tag-{generators-builtin,non-str-builtin,override-primitives}`, `Reflect/construct/arguments-list-is-not-array-like` (CE) — 4 · #4491 `dev-4491` (08-23, ES5): `annexB/function-code/function-redeclaration-switch` (CE), `arguments-object/mapped/Symbol.iterator`, `statementList/eval-class-array-literal` — 3 · #3024 (07-24): `Function/prototype/toString/{not-a-constructor,proxy-class}` · #3481 `opus-3481` (08-27): `Proxy/ownKeys/call-parameters-object-getownpropertysymbols`, `Symbol.toPrimitive/redefined-symbol-wrapper-ordinary-toprimitive` · #2917 (09-23): `Proxy/getPrototypeOf/not-extensible-same-proto` · #2200 `dev-1769` (06-20) shares the Annex B row with #4491 |
| owned-nominal | **68** | #5140 (in-review, reserved `claude/fable-es2015` 08-28, 09-28 entry is an audit HOLD that "owns no production files"): `Proxy/{defineProperty,get,getOwnPropertyDescriptor,has,set,setPrototypeOf}/trap-is-*-target-is-proxy` + `getOwnPropertyDescriptor/trap-is-undefined` — 13 · #5157 (in-review): `global-code/{decl-lex,script-decl-func,-lex-restricted-global,-var}`, `instn-named-bndng-gen` (CE), `with/unscopables-inc-dec` (CE), `types/reference/{get,put}-value-prop-base-primitive` — 8 (the last two also #5271) · #4759 (in-progress, claim released 09-03): `module-code/namespace/internals/{define-own-property,delete-exported-uninit,get-own-property-str-found-uninit,get-str-found-uninit,own-property-keys-binding-types,own-property-keys-sort,super-access-to-tdz-binding}` — 7 · #5154 (in-review): `for-of/dstr/{const,let,var}-ary-init-iter-get-err-array-prototype`, `{const,let}/block-local-closure-get-before-initialization`, `call/{eval-realm-indirect,tco-non-eval-function,tco-non-eval-with}` — 8 · #5156 (in-review): `Function/prototype/name`, `NativeErrors/{EvalError,TypeError}/proto-from-ctor-realm`, `Construct/{base-ctor-revoked-proxy,derived-return-val}`, `bind/proto-from-ctor-realm`, `Symbol/for/cross-realm` — 7 · #5158 (in-review): `AsyncFunction/{AsyncFunctionPrototype-to-string,is-a-constructor}`, `AsyncGeneratorFunction/is-a-constructor`, `ThrowTypeError/distinct-cross-realm`, `block-scope/leave/outermost-binding-…`, `annexB/statements/labeled/function-declaration` (CE), `for/head-lhs-let` (CE) — 7 · #4444 (umbrella, reserved): `Array/{from,of}/proto-from-ctor-realm`, `Error/proto-from-ctor-realm`, `GeneratorFunction/is-a-constructor`, `Promise/all/resolve-element-function-prototype`, `Promise/prototype/catch/this-value-obj-coercible`, `splitter-proto-from-ctor-realm` — 6 (not an owner; counted here because the rule says "named by an in-flight issue") · #5271 (in-progress, reserved): shares 4 rows above · #5153: `super/{call-proto-not-ctor,realm}` · #4274: `Proxy/revocable/tco-fn-realm`, `Symbol/keyFor/cross-realm` · #5141 `GeneratorFunction/has-instance` · #5147 `ArrayIteratorPrototype/next/detach-typedarray-in-progress` · #5151 `Map/prototype/set/append-new-values` · #2671 `exec/success-lastindex-access` · #3524 `String/prototype/toString/non-generic-realm` · #6836 `for-of/dstr/array-elem-init-in` (CE) · #680/#6753 `yield/from-with` (CE) |
| unowned | **48** | listed by cause below |

**U6 verdicts (adopt-or-release).** Every nominal owner except #5157 is **unclaimed
and stale**: #5271, #5154, #5158, #5156, #5153, #5151, #5150, #5147, #5141 are the
2026-08-28 wave-1/r2 files reserved by `claude/fable-es2015` (`RESERVED — nobody
working`), untouched since the 2026-09-18 bulk merge; #5140's only later entry (09-28)
is a HOLD audit; #5176's one row is held by #3481; #5198 (`RESERVED`, last touched by
the 09-24 #5350 re-land) and #4759 (claim `released` 09-03) likewise. **Recommendation:
release #5271, #5154, #5140, #5176, #5198, #4759, #5158, #5156, #5153, #5151, #5147,
#5141** (set `status: ready`, no claim) and let the slices below adopt their rows; their
rows are counted as unowned for slicing. **Keep #5157**: the Codex QuickJS lane landed
its Script-declaration plan P1 (PR #6476, merged 2026-10-04) and the file was updated
2026-10-04; its E/G rows are (e) below. The stale live claims (#3031, #4648/#4649,
#5181, #2515, #4491, #3024, #3481, #2917, #2200) should be re-checked by the lead; the
rows they hold are counted in the slices only where marked.

#### The 116 non-active rows by root cause (probe evidence per group)

Classes: (a) fixable in the standalone compiler · (b) needs true cross-realm identity
(#4274) · (c) needs the eval-tier membrane (#4245) · (d) `with` · (e) another lane's
mechanism. Row totals over all 198: **(a) 132, (b) 27, (c) 18, (d) 8, (e) 13**; over the
116 nominal + unowned: (a) 69, (b) 23, (c) 5, (d) 8, (e) 11.

| # | group | class | rows | evidence |
| --- | --- | --- | ---: | --- |
| H1 | **GetPrototypeFromConstructor through the construct ROUTES** (U1's residual) + bound-function `[[Construct]]` | (a) | 7 (6 + `Proxy/construct/trap-is-undefined-proto-from-newtarget-realm` under stale #3031; #3371's `…-cross-realm-newtarget`, `getter-foreign-new-target` and `Date/subclassing` flip with it) | p01b/p01c: `Reflect.construct(function(){}, [], NT)` and `Reflect.construct(<derived class>, [], NT)` with `NT.prototype = null` answer `null` — `emitRuntimeNewTargetPrototype` (`reflect-construct-newtarget.ts:136`) hands the raw `Get(NT,"prototype")` to `__native_construct_N`, whose `proto == null` arm means "use `callee.prototype`" (`native-construct.ts:724–735`), so a null NT.prototype is indistinguishable from "no proto supplied" and §10.1.14 step 4's `%Object.prototype%` never applies. p01d: `Array.from.call(C, [])` / `Array.of.call(C, …)` → `[object Object]` not `Object.prototype` (`array-from-native.ts:609` calls `__native_construct_0(C, null)`). p01a/p02b: `Reflect.construct(fn.bind(), [], NT)` throws "is not a constructor" — the TARGET guard (`call-namespace-static.ts:2451`) admits no `$__bound_fn`. p02: `new (A.bind().bind())()` leaves `new.target` undefined — `construct-bound.ts` calls `__apply_closure(cur, self, extra)` (the [[Call]] body), so §10.4.1.2 step 5 (`newTarget = target` when `SameValue(F, newTarget)`) never reaches `A`. Rows: `bind/proto-from-ctor-realm`, `super/realm`, `Array/{from,of}/proto-from-ctor-realm`, `bind/instance-construct-newtarget-self-{new,reflect}`, `Proxy/construct/trap-is-undefined-proto-from-{newtarget-realm,cross-realm-newtarget}` (#3031), `Error/prototype/stack/getter-foreign-new-target` (#5181; p01e shows `Reflect.construct(Date,[64],Ctor)` ignores an OBJECT `Ctor.prototype` too — the native-carrier NT route, #3371's `Date/subclassing`) |
| H2 | **trapless Proxy forwarding over a Proxy / native-carrier target** (#5140 clusters 3/5) | (a) | 16 (13 nominal + 1 unowned + 2 `apply/*` under stale #3031; #3371's three `construct/trap-is-*-target-is-proxy` CEs flip with it) | p05: `p = new Proxy(new Proxy({}, {}), {}); p.attr = 1` traps `dereferencing a null pointer in __module_init` — the trapless `[[Set]]` forward casts `[[ProxyTarget]]` to `$Object` without `ref.test $Proxy`; the rows' targets are a `$Proxy`, a String wrapper, an array vec, a closure, `Object.prototype.hasOwnProperty` (`apply/trap-is-missing-target-is-proxy` → `illegal cast`), a RegExp. `getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined-realm`: the trap returns `null` and no TypeError follows (§10.5.5 step 9) — #2106 (null/undefined observability) is `done`, so this is now a one-line guard, not G9. Rows: `Proxy/{defineProperty,get,getOwnPropertyDescriptor,has,set,setPrototypeOf,apply,construct}/trap-is-{missing,null,undefined}-target-is-proxy` (the `-null` defineProperty/setPrototypeOf rows are #6766's), `getOwnPropertyDescriptor/trap-is-undefined`, `…/result-type-is-not-object-nor-undefined-realm` |
| H3 | **TypedArray residue** (U2's six + two) | (a) | 8 | p04: `class S extends Int8Array {}; new S(3).length` → 0 (#3239 identity-only empty vec; U2 residual), so `ArrayBuffer.isView(s)` is false. U2's measured causes stand for the rest: `target.set([0,1,2])` with every binding an externref proxy global `ref.cast`s a `$__ta_view` to the element vec (`array-methods.ts compileTypedArraySet`); `new TA(true)` → length 0 and `-0` re-boxed as a tag-5 `$AnyValue`; a patched `Array.prototype[Symbol.iterator]` is not consulted (#6484); `Reflect.set(ta, 0, v, receiver)` never does §10.4.5.5 step 1.b.i `OrdinarySet(O, P, V, Receiver)`; `Object.create(<TA>)` has no TA arm in the prototype walkers; `ArrayIteratorPrototype/next/detach-typedarray-in-progress`: `%ArrayIteratorPrototype%.next` step 11.b (detached buffer → TypeError) is not checked. Rows: `ArrayBuffer/isView/arg-is-typedarray-subclass-instance`, `TypedArray/from/from-typedarray-into-itself-mapper-detaches-result`, `ctors/length-arg/toindex-length`, `ctors/object-arg/iterated-array-with-modified-array-iterator`, `internals/Set/{key-is-in-bounds-receiver-is-not-typed-array,key-is-out-of-bounds-receiver-is-proto,key-is-valid-index-reflect-set}`, `ArrayIteratorPrototype/next/detach-typedarray-in-progress` |
| H4 | **derived-constructor completion + revoked-proxy construct** | (a) | 3 | p06: `class C extends Object { constructor(){ return null } }; new C()` throws ReferenceError, spec says TypeError (§10.2.2 step 10.b: a non-undefined non-object return → TypeError; step 12 `this` uninitialized → ReferenceError only when the return IS undefined); `new <revoked proxy>` throws nothing (§10.5.13 step 2). Rows: `Construct/derived-return-val`, `Construct/base-ctor-revoked-proxy{,-realm}` (the `-realm` twin is satisfiable: `other.Proxy === Proxy` under the shim) |
| H5 | **TDZ for closure-captured `let`/`const`** | (a) | 4 | rows: `{ function f(){ x = 1 } assert.throws(ReferenceError, f); let x; }` and the `get` twins throw nothing — the capture cell is created initialised (§9.1.1.1.4/.5 need an uninitialised state). `block-scope/leave/outermost-binding-updated-in-catch-block-…` is the same cell lifetime defect seen from a catch block. Rows: `{let,const}/block-local-closure-get-before-initialization`, `let/block-local-closure-set-before-initialization`, `block-scope/leave/outermost-binding-updated-in-catch-block-nested-block-let-declaration-unseen-outside-of-block` |
| H6 | **module namespace exotic object internals** (§10.4.6) | (a) | 7 | first failures: `[[Get]]`/`[[GetOwnProperty]]` of an uninitialised export throw no ReferenceError; `delete ns.local1` throws no TypeError; `[[OwnPropertyKeys]]` answers 7 of 10 string keys and traps `illegal cast` on the sort row; `[[DefineOwnProperty]]` null-derefs in `__module_init`. Rows: the seven `module-code/namespace/internals/*` rows above. #4759's territory (claim released) |
| H7 | **destructuring evaluation order + for-of `delete Array.prototype[@@iterator]`** | (a) | 5 | `keyed-destructuring-…-evaluation-order-with-bindings` (binding + assignment): actual `[binding::source, binding::sourceKey]` then stops — the target reference (`binding::varTarget` / `binding::target` + `targetKey`) must be evaluated BEFORE `GetV(source, key)` (§13.15.5.6 step 1, §14.3.3.3). `for-of/dstr/{const,let,var}-ary-init-iter-get-err-array-prototype`: after `delete Array.prototype[Symbol.iterator]`, `for ([x] of [[]])` must throw TypeError — #5154 A(a): `maybeCaptureArrayProtoOverride` captures assignments, not `delete` |
| H8 | **`%Function%` / `%GeneratorFunction%` / `%AsyncFunction%` intrinsic carriers** | (a) | 8 | p07: `isConstructor(Function)` false — in a module that reads bare `Function` the value is the provider-side `%Function%` (`function-intrinsic-carrier.ts:172` → `emitStandaloneIntrinsicFunctionValue`), and `__reflect_is_constructor`'s last arm (`reflect-construct-native.ts:322–333`, `__boundary_object_callable_kind` bit 1) answers 0 for it; `GeneratorFunction = Object.getPrototypeOf(function*(){}).constructor` is `undefined`-ish (`has-instance`, `is-a-constructor`); `AsyncFunction.prototype[@@toStringTag]` undefined; `Object.getPrototypeOf(<Promise.all resolve-element fn>)` is `null` — the built-in closure carrier has no `%Function.prototype%` link (U1's callable arm covers user closures only). Rows: `{Function,GeneratorFunction,AsyncFunction,AsyncGeneratorFunction}/is-a-constructor`, `GeneratorFunction/has-instance`, `AsyncFunction/AsyncFunctionPrototype-to-string`, `Promise/all/resolve-element-function-prototype`, `Function/prototype/name` (harness L96 null deref on a `name` read) |
| H9 | **parser: sloppy `let` as identifier in a `for` head; `in` inside a for-of pattern default** | (a) | 2 | CE "Variable declaration expected" / "',' expected" — #6836 (released). Rows: `for/head-lhs-let`, `for-of/dstr/array-elem-init-in` |
| H10 | singles | (a) | 12 | `Array/from/source-array-boundary` (`Array.from(array, mapFn, this)`: `this.arrayIndex` inside `mapFn` is not the module `this`) · `Array/length/define-own-prop-length-coercion-order` (§10.4.2.4 ArraySetLength: `ToUint32`/`ToNumber` twice, TypeError when `length` became non-writable between them) · `DataView/instance-extensibility` (`Object.defineProperty(dataview, 'baz', {})` not stored) · `RegExp/prototype/Symbol.split/coerce-flags-err` (SyntaxError where `ToString(Symbol)` must TypeError, step 7 of §22.2.6.14) · `RegExp/prototype/exec/{success,failure}-lastindex-access` (`exec` on a `lastIndex`-accessor receiver answers an object where `null` / non-null is expected) · `Symbol.toPrimitive/removed-symbol-wrapper-ordinary-toprimitive` (`delete Symbol.prototype[@@toPrimitive]` then `Object(Symbol()) == 123` must run OrdinaryToPrimitive via the accessor-defined `valueOf`) · `arguments-object/unmapped/Symbol.iterator` (own `@@iterator` data property on `arguments`) · `Map/prototype/set/append-new-values` (`map.size` is `NaN` after `set(null, 42)` on a Map seeded with a Symbol key) · `Promise/prototype/catch/this-value-obj-coercible` (`catch.call(true)` must `Invoke(true, "then")` through `Boolean.prototype.then`) · `types/reference/{get,put}-value-prop-base-primitive` (`Symbol().test262` after `Symbol.prototype.test262 = …`; `Number.prototype` setter count) |
| H11 | **needs a genuinely DISTINCT realm** | (b) | 23 (+4 under stale claims) | unchanged from the 10-05 census (G7) plus the Error family now that U1 answers the right intrinsic: `RegExp/prototype/{global,ignoreCase,multiline,source,sticky,unicode}/cross-realm` (`other.RegExp.prototype` getter must throw TypeError on THIS realm's `RegExp.prototype`), `String/prototype/{toString,valueOf}/non-generic-realm`, `Function/prototype/apply/{argarray-not-object,this-not-callable}-realm`, `Function/call-bind-this-realm-undef`, `Symbol/{for,keyFor}/cross-realm` (measured: `Symbol.for === OSymbol.for`), `ThrowTypeError/distinct-cross-realm`, `Proxy/revocable/tco-fn-realm`, `call/eval-realm-indirect`, `Error/proto-from-ctor-realm` + `NativeErrors/{EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError}/proto-from-ctor-realm` (the shim mints DISTINCT error constructors, #4634, so `other.<Err>.prototype !== <Err>.prototype` by construction — U1's "unreachable without a distinct realm: 7") · stale-claim: `Error/prototype/stack/{getter,setter}-cross-realm` (CE `env::Object_new`, the #2961 leak U1 recorded), `Function/internals/Call/class-ctor-realm`, `eval-code/indirect/realm` |
| H12 | **values minted inside the QuickJS eval tier** | (c) | 5 (+11 under stale #4648/#4649, +2 in PR #6246) | `new other.Function('return this;')` / `new other.Function('shared = this; …')` compile source at runtime, so the function and the wrappers it returns are provider-heap values (`call-bind-this-realm-value`, `splitter-proto-from-ctor-realm`); `tco-non-eval-{function,function-dynamic,global}` need `eval("var eval = f")` global-code bridging AND a 100,000-deep tail call through `__dyn_call_1` (`tco-non-eval-function` dies with "Maximum call stack size exceeded"); #4648/#4649's rows are the 10-05 G8 list (`Proxy/{apply,construct}/arguments-realm`, `Construct/derived-*-realm`, `Function/proto-from-ctor-realm{,-prototype}`, `GeneratorFunction/proto-from-ctor-realm{,-prototype}`, `generators/eval-body-proto-realm`, `types/reference/*-realm`). Reachable only through #4245's membrane |
| H13 | **`with`** | (d) | 8 | `statements/with/{get-binding-value-call-with-proxy-env,has-binding-call-with-proxy-env,set-mutable-binding-binding-deleted-with-typed-array-in-proto-chain}` (the proxy-env log is empty — Object Environment Record steps run against the closed-shape Tier-1 lowering, `with-scope.ts`), `with/unscopables-inc-dec` (CE #1387 "class or method capture"), `arrow/capturing-closure-variables-2` (CE #1387 "arrow-function capture"), `variable/binding-resolution` (`var` inside `with` + `delete`), `yield/from-with` (CE #680 + `with`), `tco-non-eval-with`. Achievable in standalone — the host lane passes them — via the Tier-2 lowering #5271 D / #4206 specify; not a slice here |
| H14 | other lane's mechanism | (e) | 11 (+2 stale #4491) | #5157 E/G → Lane A's Script-declaration plan (PR #6476 P1 merged 2026-10-04, P2 open): `global-code/{decl-lex,script-decl-func,script-decl-func-err-non-configurable,script-decl-lex,script-decl-lex-restricted-global,script-decl-var,script-decl-var-collision}`, `statementList/eval-class-array-literal{,-with-item}` — 9 · `module-code/instn-{iee,named}-bndng-gen` (CE: `standalone target emitted host imports: env::B` / `env::g2` — a module-binding generator leaks a host import, #2961 / #6834's family) — 2 · `annexB/statements/labeled/function-declaration` (CE, #2200 Annex B family) |

Sums: H1–H10 (a) = 7+16+8+3+4+7+5+8+2+12 = **72 sliceable rows** — 68 nominal/unowned
plus the 4 stale-claim rows named inside H1/H2/H8 (`trap-is-undefined-proto-from-newtarget-realm`,
`apply/trap-is-{missing,null}-target-is-proxy`, `Function/is-a-constructor`); (b) 23;
(c) 5; (d) 8; (e) 11. 68 + 23 + 5 + 8 + 11 = 115, plus `super/call-proto-not-ctor`
(#5153 nominal, an (a) row that is #3371's construct work, not sliced here) = 116.

#### Implementation slices — ordered, largest fixable group first

Common constraints (every slice): no new host import without a standalone fallback
(#2961 — the H14 `env::B`/`env::g2` CEs are exactly that leak; `scripts/check-leak-scan`
/ the `standalone target emitted host imports` runner check must stay at 0 new); `src/runtime.ts`
is at its line cap (20,219 lines) — new helpers go in `src/codegen/<subdir>/*.ts` and are
registered through `registerNative`/`funcMap`, never appended to `runtime.ts`; **new files
go in subdirectories** (U1 was moved under `codegen/object-model/` for the flat-dir
budget); **new leaves must not value-import a module in the import-cycle SCC** (U1 and
U4 both needed a follow-up commit to inject their helpers instead — run
`pnpm run check:import-cycles` and `check:dead-exports` before the PR); loc/func budgets
run against `LOC_GATE_BASE=$(git rev-parse origin/main)`; after every `src/` edit rebuild
the provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`) or every row reports a
non-verdict; per-PATH joins against the row lists above, never count deltas.

**Mandatory control for every slice — in-process linked Temporal (U1's park, #6504).**
Build the standalone Temporal provider into a worktree-local cache for EACH tree
(`JS2WASM_TEMPORAL_CACHE=.tmp-temporal node scripts/prewarm-temporal-provider.mjs --target standalone`
after the bundles; the shared cache key does not hash the compiler, U3 measured a 76 B
provider difference), then run all 126 `built-ins/Temporal/Duration/prototype/round/*.js`
**in-process, without `--isolate`** (`npx tsx scripts/run-test262-paths.mts <list> --standalone`)
on base and on branch. Acceptance: identical verdicts per path (currently 119 pass / 7
fail) and **0 `illegal cast`** on both. `--isolate` and an unlinked tree both hide this
class; a slice without this receipt is not done.

**Slice V1 — trapless Proxy forwarding over Proxy and native-carrier targets (H2, 16 rows incl. #3031's 2 `apply/*`; adopt #5140 clusters 3/5; #3371's three `construct/trap-is-*-target-is-proxy` CEs come with it).**
- `src/codegen/object-runtime-proxy.ts` — every trapless arm (`get`, `set`, `has`,
  `getOwnPropertyDescriptor`, `defineProperty`, `deleteProperty`, `setPrototypeOf`,
  `preventExtensions`, `apply`, `construct`): replace the `ref.cast $Object` of
  `[[ProxyTarget]]` with a `ref.test $Proxy` → re-enter the proxy dispatch on the target
  (the shape `object-model/proxy-get-iterator.ts` already uses for `@@iterator`), else
  the carrier-generic entry (`__extern_get` / `__extern_set_strict` / `__extern_has` /
  `__object_gopd` / `__defineProperty_value` / `__apply_closure` / `__native_construct_N`)
  so a String wrapper, array vec, closure, builtin function or RegExp target works.
  §10.5.8 step 7 / §10.5.9 step 7 / §10.5.7 step 7 / §10.5.5 step 7 / §10.5.6 step 8 /
  §10.5.12 step 7 / §10.5.13 step 7.
- `getOwnPropertyDescriptor` result validation: `null` is neither Object nor undefined →
  TypeError (§10.5.5 step 9) — a `ref.is_null` branch BEFORE the undefined test; #2106
  made the two distinguishable.
- Keep `buildProtoDispatch` untouched (#6766 owns the `$Object.$proto` proxy link; its
  `-null`-trap rows are excluded from this slice's acceptance).
- Acceptance: p05 passes all eight checks; the 16 rows flip (the 2 #3031 rows only if
  the lead releases #3031, else they are a bonus); `built-ins/Proxy/**` (431 rows) and
  `built-ins/Reflect/**` 0 lost; U3's 1,658-row in-process Proxy neighbourhood re-run
  with 0 lost; Temporal control.

**Slice V2 — GetPrototypeFromConstructor in the construct routes + bound-function `[[Construct]]` (H1, 7 rows; also flips #3371's `Date/subclassing`, `trap-is-undefined-proto-from-cross-realm-newtarget` and `getter-foreign-new-target`).**
- `src/codegen/expressions/reflect-construct-newtarget.ts:136 emitRuntimeNewTargetPrototype`:
  after `Get(NT, "prototype")`, apply §10.1.14 step 4 — if the value is not an object
  (`ref.is_null` OR the boxed-primitive test the U1 wrapper arm uses), replace it with
  `%Object.prototype%` read through `buildLazyNativeProtoGetInstrs` (`object-model/native-carrier-get-prototype.ts:44`,
  `ctx.nativeProtoGlobals`). Every caller (the ordinary driver L661, the proxy-chain arm
  L803 whose fallback at L886 reads NT.prototype the same way, the ArrayBuffer pre-read
  L162) then hands the driver a never-null proto, so `native-construct.ts:724–735`'s
  `proto == null → callee.prototype` arm is reached only by the no-NewTarget sites —
  keep that arm, do not change its meaning.
- `src/codegen/array-from-native.ts:609` (iterator branch) and the array-like branch's
  `Construct(C, «len»)`: pass `GetPrototypeFromConstructor(C, %Object.prototype%)` instead
  of `ref.null.extern` — same helper, C is NewTarget here (§23.1.2.1 step 7.a / 11.a).
- `src/codegen/expressions/call-namespace-static.ts:2451` TARGET admission: accept a
  `$__bound_fn` (`ctx.boundFnTypeIdx`, the `ref.test` arm `reflect-construct-native.ts:264–272`
  already uses for NEWTARGET) and route it to `construct-bound.ts` with the NewTarget
  threaded: §10.4.1.2 step 5 — if `SameValue(F, newTarget)` set `newTarget = target`,
  per unwrapped layer. `fillConstructBoundDriver` (L252) must then invoke the target's
  CONSTRUCT body, not `__apply_closure`: for an `isFnctorConstructor` target the
  synthesized `new F()` body already answers `new.target` through `newTargetValueNode`
  (`new-target-value.ts`), so add a `__construct_bound_nt(callee, args, newTarget)` twin
  that reaches `__native_construct_N(target, GetPrototypeFromConstructor(newTarget), …)`
  and stores `newTarget` where `compileNewTargetValue` reads it (the
  `NEW_TARGET_LEXICAL_LOCAL` path is the smallest hook: thread an externref parameter
  into the fnctor construct body the same way #6774 S4 threads it into arrows).
- Spec: §10.1.14 GetPrototypeFromConstructor; §10.4.1.2 BoundFunction [[Construct]];
  §23.1.2.1/§23.1.2.3 `Array.from`/`Array.of` step "Construct(C, « len »)".
- Edge cases: `NT.prototype` an accessor that throws (read exactly once — the #6775 S6
  ordering); a never-assigned fnctor `.prototype` (the driver's own fallback stays);
  `Reflect.construct(bound, [], bound)` (self newTarget → innermost target, p02b);
  bound-of-bound arguments prepend outermost-last (unchanged).
- Acceptance: p01b/c/d, p02, p02b flip; the 9 H1 rows flip per path; `built-ins/Reflect/construct/**`,
  `built-ins/Function/prototype/bind/**` (the #4196 `15.3.4.5.2-4-*` block), `Array/{from,of}/**`
  and `language/expressions/new.target/**` show 0 lost; Temporal control as above.

**Slice V3 — TypedArray residue (H3, 8 rows).** U2's residual table is the spec:
faithful `class S extends <TA>` construction (the #3239 identity-only vec must become a
real `$__ta_view` built by the parent's [[Construct]] with the subclass prototype —
`class-heritage-check.ts` + the TA ctor arm in `expressions/new-super.ts`); a runtime
`$__ta_view` arm in `array-methods.ts::compileTypedArraySet` (ref.test before the
element-vec cast); `ToIndex(length)` for every primitive first argument and the
`-0`/tag-5 box (`__any_to_extern` registered on the `__extern_get_idx` path); consult a
patched `Array.prototype[@@iterator]` (#6484's capture); `ta-dyn-mop.ts` `[[Set]]`:
§10.4.5.5 step 1.b.i `OrdinarySet(O, P, V, Receiver)` when `SameValue(O, Receiver)` is
false, and a TA arm in `__object_create`'s prototype walkers so `Object.create(ta)[0] = v`
calls `TypedArraySetElement` once; `%ArrayIteratorPrototype%.next` step 11.b detached
check in `iterator-native.ts`. Acceptance: p04; the 8 rows; `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView}/**`
(2,966 rows) 0 lost against a local base run; #6769's pins; Temporal control.

**Slice V4 — derived-constructor completion and revoked-proxy construct (H4, 3 rows).**
`expressions/new-super.ts` derived-class [[Construct]] epilogue: implement §10.2.2 steps
10–13 in order — result is Object → return it; result not undefined → TypeError;
`this` uninitialised → ReferenceError — today `return null` falls into the
"this-uninitialised" ReferenceError. `native-construct.ts::constructIsConstructorGuard`
and `object-runtime-proxy-construct-chain.ts`: a `$Proxy` whose handler is null throws
TypeError before any target read (§10.5.13 step 2). Acceptance: p06 three checks; the 3
rows; `language/statements/class/subclass/**` + `built-ins/Proxy/revocable/**` 0 lost;
Temporal control.

**Slice V5 — TDZ for closure-captured `let`/`const` (H5, 4 rows).** The ref cell
(`struct (field $value (mut T))`) a captured block binding lives in is created
initialised. Add an uninitialised state: for externref cells a reserved sentinel
(`ref.null` is a VALUE — use a dedicated `$__tdz` singleton struct, `ref.eq`-tested),
for f64 the sNaN sentinel already used for missing defaults, for i32 a side flag;
`closures/capture-source-slot.ts` + the block-scoped declaration lowering in
`src/codegen/declarations/` initialise the cell to the sentinel at block entry and
store the real value at the declaration; every captured read/write emits the check
(§9.1.1.1.4 GetBindingValue step 2, §9.1.1.1.5 SetMutableBinding step 2 → ReferenceError
"Cannot access 'x' before initialization"). Non-captured bindings keep the existing
static TDZ analysis. Acceptance: the 4 rows; `language/statements/{let,const}/**` and
`language/block-scope/**` (≈1,000 rows) 0 lost; the equivalence gate; Temporal control.

**Slice V6 — module namespace exotic object internals (H6, 7 rows; adopt #4759).**
`declarations/import-collector.ts` + the namespace object builder: implement §10.4.6
[[GetOwnProperty]]/[[Get]] (uninitialised binding → ReferenceError, not undefined),
[[Delete]] (exported name → false, so `delete ns.x` throws TypeError in strict module
code), [[DefineOwnProperty]] (no null deref — return false unless the descriptor matches
the exported binding), [[OwnPropertyKeys]] (every export incl. re-exports and `*`
re-exports, sorted by code unit, then `@@toStringTag`). Acceptance: the 7 rows;
`language/module-code/namespace/**` (≈120 rows) and `language/module-code/instn-*` 0
lost; Temporal control.

**Slice V7 — destructuring evaluation order + for-of `delete Array.prototype[@@iterator]` (H7, 5 rows; adopt #5154 A(a)).**
`dstr-assign-iterator-drive.ts` / the binding-pattern lowering: for a keyed element
with an initialiser and a member target, evaluate the target reference (and its computed
key) BEFORE `GetV(source, key)` (§13.15.5.6 KeyedDestructuringAssignmentEvaluation step
1; §14.3.3.3 for bindings — the `varTarget` reference). `maybeCaptureArrayProtoOverride`
(`for-of` GetIterator ladder): treat `delete Array.prototype[Symbol.iterator]` as an
override that removes the static fast path so GetIterator throws TypeError (§7.4.3 step
3). Acceptance: the 5 rows; `language/statements/for-of/dstr/**` (1,000+) and
`language/expressions/assignment/destructuring/**` 0 lost; Temporal control.

**Slice V8 — the `%Function%`/`%GeneratorFunction%`/`%AsyncFunction%` carriers (H8, 8 rows).**
`reflect-construct-native.ts:322` — admit the provider-side `%Function%` (the
`__boundary_object_callable_kind` adapter must publish bit 1 for the intrinsic; if the
adapter cannot, test identity against `emitStandaloneIntrinsicFunctionValue`'s cached
global); give `Object.getPrototypeOf(function*(){})` a `%GeneratorFunction.prototype%`
whose `.constructor` is a brand-marked `%GeneratorFunction%` carrier (same
`BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` machinery as `Function`, #4442), likewise
`%AsyncFunction%`/`%AsyncGeneratorFunction%` with `@@toStringTag`; U1's callable arm in
`object-model/native-carrier-get-prototype.ts` must also claim the BUILT-IN closure
carriers (Promise resolve-element functions, bound natives) → `%Function.prototype%`.
Acceptance: p07; the 8 rows; `built-ins/{Function,GeneratorFunction,AsyncFunction,AsyncGeneratorFunction}/**`
0 lost; the F1 `Function/prototype/toString/proxy-*` rows unchanged; Temporal control.

**Slice V9 — parser compatibility (H9, 2 rows; adopt #6836).** `for (let; ;)` /
`for (let = 3; ;)` / `for ([let][0]; ;)` in sloppy code and `[x = 'x' in {}]` inside a
for-of head pattern: TypeScript's parser rejects both; the pre-parse rewrite #6836
specifies (rename the sloppy `let` identifier, parenthesise the `in` default) is the
smallest fix. Acceptance: the 2 rows; `language/statements/for/**` 0 lost.

**Slice V10 — singles (H10, 12 rows).** One PR per 3–4 rows, each with its own probe;
the root-cause pointers are in the H10 row. Order by neighbourhood risk: the two
`types/reference/*-prop-base-primitive` + `Promise/prototype/catch/this-value-obj-coercible`
(primitive ToObject prototype reads), then `Array/length/define-own-prop-length-coercion-order`
+ `DataView/instance-extensibility` + `arguments-object/unmapped/Symbol.iterator`, then
the RegExp trio, then `Symbol.toPrimitive/removed-*`, `Map/prototype/set/append-new-values`,
`Array/from/source-array-boundary`.

**After U1b.** PR #6525's 11 rows flip when it merges; its residual list is below. The
four `bfnid` sites it left unguarded carry the same linked-module collision risk:

- `src/codegen/char-at-transfer.ts:322–328` — exact `bfnid` compare against
  `metaTypeIdx` after `ref.cast`;
- `src/codegen/apply-closure-variadic-builtin.ts:29–50` (`variadicBuiltinIdentity`:
  `struct.get BFN_ID_FIELD_IDX` + `i32.eq`, the #6701 `__apply_closure` arm);
- `src/codegen/object-runtime.ts:11526–11612` — the shared `__builtinfn_get_meta` /
  `__builtinfn_delete` preamble (`ref.cast` at ~L11579 and ~L11595);
- `src/codegen/ta-dyn-mop.ts:629–700` — the `__tam_bfnid` local and the `refusalFilter`
  family-`ref.test` + `bfnid` ladder.

Each should take U1b's `linkedSignatureGuard` (`closures/transferred-native-proto.ts`,
effective only when `ctx.mod.canonicalRuntimeRecGroup` is set) in a follow-up slice
**V0** that lands right after #6525, with the Temporal control as its only acceptance
criterion (0 casts, identical verdicts) plus a byte-identical check on unlinked
modules.

#### How many rows are reachable for 100 %

ES2015 standalone today: **11,506 / 11,704 (98.31 %)**, 198 open. Of those: **132 are (a)**
— 72 in V1–V10 above, 48 held by live claims (#3371 16, #5318 12, #6766 7, PR #6525 11,
#6771 1, #6834 1) and 12 held outside the slices (stale #2515 4, #3024 2, #3481 2,
#2917 1, #4491 1, #5181 1, plus #5153's `super/call-proto-not-ctor`); **8 are (d) `with`**, achievable through the Tier-2
lowering (#5271 D / #4206) the host lane already passes; **13 are (e)** and belong to
Lane A's Script plan (9), the #2961 generator host-import leak (2) and Annex B (2).
**Blocked on architecture: (b) 27 need #4274 (true realm identity — `ready`, claim
released 2026-09-03, nobody working) and (c) 16 need #4245 (the eval-tier membrane —
`in-progress`, unassigned; the other 2 (c) rows are in PR #6246).** So
**227 − 43 = 184 of the 227 (81 %) are reachable without new architecture**, which is
**11,661 / 11,704 = 99.63 %**; the last 43 rows (0.37 %) are reachable only with #4274
and #4245, and 100 % needs both. No row in the 198 is a measurement artifact.

### 2026-10-06 — Slice V1

Trapless Proxy forwarding over a Proxy / native-carrier target (H2 of the
2026-10-06 re-census on `bdf3056722`). Branch `issue-6651-v1-proxy-forward` off
`origin/main` @ `d1f1fbdebc`. Claims read 2026-10-06 (`claim-issue.mjs --check`,
`origin/issue-assignments`): #5140 RESERVED, nobody working (rows adopted);
#3031 CLAIMED by `fable-3031` (not flagged stale by the tool, so its two
`apply/*` rows are excluded); #3371 CLAIMED (its three `construct/*` CEs are
untouched — no NewTarget code was edited); #6766 CLAIMED (its rows are not
targets).

**The census diagnosis did not hold on current main.** p05 passes on `d1f1fbdebc`:
a trapless forward already re-enters the dispatch through the `ref.test $Proxy`
front guards of `__extern_get/_set/_has/…`. The 16 rows fail on things the
forward reaches *after* the hop, and most of those are not Proxy defects (see
Residuals). Four mechanisms were Proxy-specific and are fixed:

1. **HasOwnProperty / propertyIsEnumerable had no `$Proxy` arm** (§20.1.3.2,
   §20.1.2.13, §20.1.3.4). `Object.prototype.hasOwnProperty.call(p, k)` walked
   the carrier's empty table and answered false; every `verifyProperty` on a
   proxy failed at "should be an own property". Both now run
   `__proxy_gopd_dispatch` and test the descriptor (absent → false;
   `propertyIsEnumerable` reads its `enumerable`).
2. **Trap keys were not ToPropertyKey'd.** `p[10]` handed the boxed number to the
   dispatch, so a `get` trap saw `typeof key === "number"` and a trapless forward
   to a String wrapper missed the String-exotic index arm (string keys only).
   Every keyed dispatch (`get/set/set_receiver/has/delete/gopd/define`) now
   canonicalizes param 1 with the runtime's own `__to_property_key`.
3. **String-wrapper `length` through `__extern_get`** — C5's demand-gated arm is
   now also demanded by a module that names `Proxy` (the forwarded `[[Get]]`
   lands there).
4. **`Object.defineProperty(proxy, k, {get/set…})`** took the inline accessor
   store and wrote the getter onto the `$Proxy` carrier: neither the trap nor
   the target's `[[DefineOwnProperty]]` ran. A provable-proxy receiver now takes
   the descriptor runtime route for accessor literals too (object-ops.ts).

Arms 1–3 live in the new leaf `object-model/proxy-forward-carriers.ts`
(injected deps; string helpers via `ports.ts`, no SCC value import) and are
gated on `ctx.standalone && ctx.proxyDirty`; arm 4 is inside the existing
`ctx.standalone` provable-proxy branch.

**Rows (standalone, `--isolate`, QuickJS, 41 `trap-is-*-target-is-proxy` +
gOPD rows):** base 19 pass / 22 non-pass, branch 24 / 17, **0 lost**.

| row | base | branch |
| --- | --- | --- |
| `get/trap-is-null-target-is-proxy` | fail | **pass** |
| `getOwnPropertyDescriptor/trap-is-undefined` | fail | **pass** |
| `getOwnPropertyDescriptor/trap-is-undefined-target-is-proxy` | fail | **pass** |
| `defineProperty/trap-is-undefined-target-is-proxy` | fail | **pass** |
| `defineProperty/trap-is-null-target-is-proxy` (#6766's row, side effect) | fail | **pass** |

**Controls.**
- In-process neighbourhood, 830 rows (every test262 file naming `Proxy` outside
  intl402/staging, every non-Temporal row including `proxyTrapsHelper` /
  `testAtomics` / `wellKnownIntrinsicObjects`, all of `built-ins/{Proxy,Reflect}/**`,
  and an 80-row non-Proxy control sample): every branch row run; base run on
  every row that is non-pass on branch (plus 500 rows run on both). **0
  pass → non-pass**, 0 status changes among non-pass rows. The control sample:
  77 byte-identical, 3 differ only through the per-tree QuickJS adapter that an
  `eval` row links (adapter key hashes the compiler source); all 3 pass on both.
  20 rows first read "provider is not built" after a bundle rebuild; rebuilt
  and re-run on both trees.
- `website/playground/examples` + `benchmarks/suites`, gc and standalone (34
  compiles): byte-identical.
- `node scripts/equivalence-gate.mjs`: 1748 pass, 22 failing = the 22 known; no
  new failures.
- Temporal (`Duration/prototype/round`, 126 rows, in-process, linked standalone
  provider built fresh per tree — the two providers are byte-identical):
  119 pass / 7 fail on both trees, the same 7 paths, 0 `illegal cast` on
  either. (`temporalHelpers.js` names `Proxy`, so these consumer modules DO get
  the V1 arms.)
- Pin suite `tests/issue-6651-v1-proxy-forward.test.ts`: 3 RED-on-base probes
  fail on a base-source tree (20/63, 16/31, 0/3) and pass on the branch; the
  guard probe passes on both.

**Residuals (not Proxy defects — each fails without any Proxy).**
- gOPD `trap-is-null-target-is-proxy`, `result-type-is-not-object-nor-undefined-realm`:
  a function EXPRESSION that falls off the end after a ref-typed `return` answers
  `ref.null`, not `undefined` (#4641's residual list), so the trap result
  `null` cannot be told from "no descriptor". A §10.5.5 step-9 null guard was
  written and withdrawn: it turned `function(t,k){ if (k === "foo") return d; }`
  into a TypeError.
- String-wrapper expandos: `s = new String("str"); s[4] = 1; s[4]` reads
  `undefined` with no proxy (static String-object index lowering), and
  `Reflect.set(s, "0" | "length", v)` answers true → `set/trap-is-null`,
  `defineProperty/trap-is-missing`.
- RegExp carrier through the dynamic MOP: `Reflect.get(/x/, Symbol.match)`,
  `Reflect.has(/x/, "ignoreCase")`, `Symbol.replace in /x/` all miss
  `%RegExp.prototype%` (B10's demand list covers four methods only) →
  `get/trap-is-missing`, `has/trap-is-missing`, `set/trap-is-missing` (plus a
  strict write to a getter-only property through a trapless proxy does not
  throw — `__extern_set_strict` intercepts only the trap-PRESENT arm).
- Function carriers: `hasOwnProperty.call(function(){}, "prototype")` is false,
  `Reflect.set(fn, "prototype", null)` does not store → `gOPD/trap-is-missing`,
  `set/trap-is-undefined`.
- `Object.setPrototypeOf([], Number.prototype)` is a no-op on the vec carrier
  → `setPrototypeOf/trap-is-undefined`.
- #3031's `apply/*` (illegal cast / null deref in the apply forward) and #3371's
  `construct/*` CEs are untouched.

### 2026-10-06 — Slice V3

TypedArray residue (re-census H3, 8 rows). Opus lane, branch
`issue-6651-v3-typedarray` off `origin/main` @ `d1f1fbdebc`. `src/` was copied to
`.tmp/base/src` before the first edit; every "base" number below was run by this
lane (on that copy, as a separate `.tmp/basetree`), except where it names the CI
baseline.

**Rows** (`JS2WASM_EVAL_ENGINE=quickjs … run-test262-paths.mts --standalone
--isolate`, QuickJS provider rebuilt for each tree): **base 0 pass / 8 fail →
branch 2 pass / 6 fail.**

| row | base | branch | mechanism |
| --- | --- | --- | --- |
| `ArrayIteratorPrototype/next/detach-typedarray-in-progress` | fail | **pass** | `__ta_dyn_{keys,values,entries}` build a SNAPSHOT `$__IterRec`, so `__iterator_next` never saw the view again and stepped all 5 slots after `$DETACHBUFFER`. The snapshot vec is now a `$__ta_iter_vec` (subtype of the canonical externref vec, one appended `view` field — the `$__arguments_vec` precedent), and a finalize prologue on `__iterator_next` throws a TypeError for a non-latched record whose view's buffer has `length < 0` (§23.1.5.2.1 step 6.b). Leaf `array/ta-iter-detach.ts`; hook `prependTaIterDetachArm` (`iterator-native.ts`). |
| `TypedArray/from/from-typedarray-into-itself-mapper-detaches-result` | fail | **pass** | U2's diagnosis held, with the trigger pinned down: the harness `$262.evalScript` makes every script binding an EXTERNREF global (`$__mod_target`), so `compileTypedArraySet` took its externref lane and `ref.cast` a buffer-backed `$__ta_view_Int8Array` to `$__vec_i8_byte`. Minimal repro: `function ev(s){return eval(s)}; let t = new Int8Array(new ArrayBuffer(3)); t.set([0,1,2])` traps on base. The lane now `ref.test`s the receiver's TS-named view type at runtime: a view is validated, de-viewed into the native vec, and written back after the copy (`emitExternTaViewReceiverAsVec` / `emitExternTaViewSetWriteBack`, `dataview-native.ts`) — the #3054 B1/B3 identifier-local arm, chosen at runtime. With the cast gone the rest of the row (custom-`this` `from.call` returning `target`, mapper detaching mid-loop) already passed. |

**p04 (`class S extends <TA>`), half done.** A STATIC `class S extends Int8Array`
now constructs for real: `__new_<TA>@N` (the #3239 identity-only empty vec) runs
§23.2.5.1 through the shared `__ta_dyn_ctor_construct_a<k>` with the per-kind
`$__ta_ctor` singleton (`ensureStandaloneTaSubclassParentCtor`), and
`ArrayBuffer.isView` gives a TA-subclass instance a runtime test instead of a
static `false` (`arraybuffer-isview-static-decision.ts`). p04 static half: base
`length 0 / isView false` → branch `3 / true`; `.tmp/v3/s2.js` (no-arg, array,
buffer+offset+length, explicit `super(4)`, Uint8Clamped clamp) base 33 → branch
63/63; BigInt parents keep the #3239 carrier. The RUNTIME-heritage half — the
row's `class TA extends ctor {}` with `ctor` a parameter — is unchanged (below).

**Residuals (6)** — first failing assertion on the branch, mechanism:

| row | first failure | why not here |
| --- | --- | --- |
| `ArrayBuffer/isView/arg-is-typedarray-subclass-instance` | `assert(ArrayBuffer.isView(sample))` | runtime heritage: `class TA extends ctor {}` with `ctor` a parameter compiles to a closed base struct whose `TA_new` takes no parameters (WAT: `struct.new` + `return_call TA_init`) — the heritage value is never captured, so no parent [[Construct]] can run. Needs a per-class captured heritage + a construct route for a `$__ta_ctor` parent (class-bodies / `class-heritage-check.ts` "DECLINED" lane); a class-representation change for every runtime-heritage class (mixins), not a TA arm. |
| `ctors/length-arg/toindex-length` | `-0 length`, expected reads `[object Object]` | value representation, #5185 family: inside `items.forEach(function (item) {…})` over the nested heterogeneous literal, `item[0]`/`item[1]` read a leaked `$AnyValue` (`typeof expected` is `"string"`, 0 of 4 elements typed right in `.tmp/v3/t2.js`, while `items[3][1] === 1` outside the callback is right); `new Float64Array(items[3][0])` (1.9) also gives length 0. `new Float64Array(true)` is length 1 on base and branch, so it is not the cause. |
| `ctors/object-arg/iterated-array-with-modified-array-iterator` | `ta.length` 1 vs 4 | a patched `%ArrayIteratorPrototype%.next` is not consulted by the native iterator ladder (#6484). |
| `internals/Set/key-is-in-bounds-receiver-is-not-typed-array`, `internals/Set/key-is-valid-index-reflect-set` | `receiver[0] === value` false | identity, not the walk: `let v = { valueOf(){…} }; function id(x){return x}; id(v) === v` is FALSE on main (`.tmp/probes/q1.js`: also `holder.p === v`, `o[0] === v`, `Reflect.set(o,0,v)`), because a ToPrimitive-bearing literal crosses to externref through `materializeStructAsDynamicObject` (`literals.ts`), documented as a value COPY per conversion. `{a:1}` keeps identity. #3037 / #2773. |
| `internals/Set/key-is-out-of-bounds-receiver-is-proto` | `valueOf` called 0× | `Object.create(<Int32Array>)` does not even link the prototype (`Object.getPrototypeOf(obj) === ta` is false, `.tmp/v3/o1.js`). The #6766 `protoLink` regime is Proxy-only (`protoLinkActive` = standalone ∧ `proxyDirty`); a TA link needs the writer plus a TA [[Set]] arm in every walker — its own substrate slice. |

**Side findings (pre-existing, not fixed).** `for (v of t)` over a dynamic view
`t = new TA([1, 2])` throws in a plain module on base and branch alike
(`.tmp/v3/s6.js`, 1026 on both); a static-`Int8Array` iterator does not observe a
detach (d1 bit 16). After this slice a static TA-subclass instance is a dyn view,
so it shares that `for-of` behaviour (it yielded nothing on base); `e.fill(3)` on
a subclass instance does not land (it did not on base either).

**Controls.**
- **Bonus row:** `language/statements/class/subclass/builtins.js` (ES2015,
  `class ExtendedUint8Array extends Uint8Array { constructor(){ super(10); … } }`)
  base fail (`eua.length` 2 vs 10) → branch **pass** (`--isolate`), from the
  static-subclass construction above.
- Pins `tests/issue-6651-v3-typedarray-residue.test.ts`: 3 mechanisms + 1
  guard, no eval engine (the `eval` case only compiles `eval` in a never-called
  function and stubs its imports). Base: the 3 mechanisms fail (0 / trap / 4),
  the guard passes; branch 4/4.
- Runtime control: `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView,ArrayIteratorPrototype}/**`
  (2,992 rows) + the 22 static `extends <TA>` rows = 3,014. Branch measured
  IN-PROCESS (200-row chunks, one runner at a time), rows whose source names
  `keys`/`values`/`entries`/`set`/`@@iterator`/`extends`/for-of/spread/
  `Array.from`/`$DETACHBUFFER` first. **2,500 rows measured: 0 base-pass →
  branch non-pass.** "Base" for that screen is the CI standalone baseline JSONL
  (`6.10.2026 01:08`); every one of the 9 rows that differ was re-run on the base
  tree with `--isolate`: 6 already pass on base (U1/U2 landed after that
  artifact), 3 are this slice's (the two rows above + `subclass/builtins.js`).
  92 rows first ran against a stale QuickJS adapter ("provider is not built" —
  a bundle rebuild changed the key) and were re-run after rebuilding.
  **NOT measured (514 rows):** a 100-row half of one chunk (`TypedArray/prototype/{subarray,sort,toLocaleString}`
  region, list in `.tmp/v3/chunks2/c09b`) OOMs the in-process runner at 4 GB on
  this branch, twice; and the 414-row tail of rows naming none of the tokens
  above.
- Temporal (mandatory, in-process, linked standalone provider built per tree
  into a worktree-local cache): `built-ins/Temporal/Duration/prototype/round/*.js`
  (126) base **119 pass / 7 fail**, branch **119 / 7**, same 7 paths, **0
  `illegal cast`** on both. The two providers differ by 946 B (3,928,602 →
  3,929,548): the provider contains the changed TypedArray lowering.
- Playground + `benchmarks/suites`, gc and standalone, base vs branch in separate
  processes: 34/34 binaries byte-identical.
- `node scripts/equivalence-gate.mjs`: 22 failing = the 22 known failures, no
  new regression.
- Fast quality gates (the brief's 30-gate loop) exit 0; loc/func also with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `check:compiler-boundaries:inventory`
  valid after classifying the new leaf (complete mode exits 1 on base too).

### 2026-10-06 — Slice V0

Routes U1b's four residual `bfnid` sites through its linked-module signature
guard. Opus lane, harness branch off `origin/main` @ `bba74cfa80`. `src/` was
copied to `.tmp/base/src` before the first edit, and every "base" number below
was run by this lane.

**Why.** A `bfnid` is a module-local type index, so in a canonically linked
module (`canonicalRuntimeRecGroup`) a peer's builtin closure passes the family
`ref.test` and can carry one of our ids (see U1b). U1b guarded the three
`transferred-native-proto.ts` arms; four other compare sites stayed exposed.

**Where the guard lives.** `closures/transferred-native-proto.ts` is in the
import-cycle SCC (697 files) and `apply-closure-variadic-builtin.ts` is not, so
importing the guard from there would have grown the SCC. It moved to the leaf
`builtin-fn-meta.ts`, which every site already imports (`BFN_ID_FIELD_IDX`).
That adds no import edge; `check:import-cycles` stays at 697. Its signature now
takes `{ typeIdx, funcTypeIdx }` instead of a receiver entry, and a wrapper,
`linkedMetaSignatureGuard`, looks the signature up from the meta type's closure
info (`ensureBuiltinFnMetaType` always records it).

**Per site** (all emit nothing unless linked):

| site | what a colliding peer closure did | now (linked) |
| --- | --- | --- |
| `char-at-transfer.ts`, transferred `String.prototype.<m>` arm of `__apply_closure` | different signature: `illegal cast` on the self cast. Same signature: ran OUR member body (`call $__proto_method_…`) on the peer closure | guarded, and the arm calls through field 0 (the peer's own function), as U1b's arms do |
| `apply-closure-variadic-builtin.ts`, `Math.max`/`min`/`String.fromCharCode` identity | already safe: the arm re-tests field 0 against the variadic type and calls through it | guarded (defence in depth: the identity predicate now holds the invariant by itself) |
| `object-runtime.ts`, `exactMetaArm` (shared by `__builtinfn_get_meta`/`_gopd`/`_delete`/`_push_ownnames`) | answered OUR `name`/`length` for the peer function, and gOPD/delete/own-keys treated it as ours | a different-signature peer declines to the default tail, which is what a non-colliding peer already got |
| `ta-dyn-mop.ts`, dyn-view [[Get]] refusal-closure filter | a working peer method read back as `undefined` | each id compare is guarded; the cast is to the family type the ladder already tested |

**Rows and controls.**

| control | base | branch |
| --- | --- | --- |
| `Temporal/Duration/prototype/round/*.js` (126, standalone, linked provider, in-process, `JS2WASM_TEMPORAL_CACHE`) | 119 / 7, 0 `illegal cast` | 119 / 7, 0 `illegal cast`; same 7 rows, same messages |
| byte identity, unlinked: playground examples + `benchmarks/suites` + `examples` (32 files) and a seeded 150-row random test262 sample (wrapped with `wrapTest`), each on gc / standalone / wasi | 546 rows (432 binaries, 114 compile errors) | identical JSONL, every sha and every error message |
| Temporal provider (linked, standalone) | 3,928,602 B | 3,949,153 B (the guards). Re-built after the final refactor: same sha |
| QuickJS eval adapter (unlinked) | 617,752 B | 617,752 B |

- Pins: `tests/issue-6651-v0-linked-bfnid-sites.test.ts`, 8 tests. The 4
  linked tests are red on base; the 4 unlinked tests pass on base (invariants:
  no guard, direct call). U1b's 6 pins still pass.
- `node scripts/equivalence-gate.mjs`: no new regressions (22 known failures,
  1748 passing).
- Every fast `quality` gate exits 0. Loc and func budgets also pass with
  `LOC_GATE_BASE=origin/main`, given the dated grants in the frontmatter
  (`object-runtime.ts` +1, `ta-dyn-mop.ts` +2).

**Not verified.**

- No row that reaches a real cross-module collision at sites 1–4 was found;
  the Temporal control did not trap at these sites on base either. The pins
  prove the guard is emitted, not that a collision is now answered correctly.
- `__builtinfn_gopd`/`_delete`/`_push_ownnames` are dead-code-eliminated in
  every probe tried. They share `exactMetaArm` with `get_meta`, which is pinned.
- No host linked-harness lane was run. Those modules also carry
  `canonicalRuntimeRecGroup`, so they get the guards.

**Residuals.**

- A same-signature collision is still wrong at the two metadata-style sites,
  which read local data, not the peer's function: `exactMetaArm` answers our
  `name`/`length`, and the dyn-view filter hides a same-signature peer method.
  A link-unique `bfnid` (or the realm/singleton identity test that
  `runtime/wasmgc/values/builtin-function-bodies.ts` already uses) is the
  durable fix.
- A peer STATIC builtin whose lifted signature equals a local method's
  `(self, this, args…)` would still be dispatched with a receiver. This also
  applies to U1b's arms.
- `runtime/wasmgc/values/builtin-function-bodies.ts` also compares a bfnid,
  but it already requires realm and singleton `ref.eq` plus the lifted
  signature, so it is identity-safe and was left alone.

### 2026-10-06 — Slice V5

TDZ for closure-captured block `let`/`const` (H5 of the 2026-10-06 re-census),
on `10f601e26e`. **4/4 target rows flip** (`{let,const}/block-local-closure-get-
before-initialization`, `let/block-local-closure-set-before-initialization`,
`block-scope/leave/outermost-binding-updated-in-catch-block-nested-block-let-
declaration-unseen-outside-of-block`), measured base vs branch with
`JS2WASM_EVAL_ENGINE=quickjs … run-test262-paths.mts --standalone`.

**The spec's mechanism (a `$__tdz` sentinel inside the value cell) was not
needed — the codebase already has a captured-TDZ mechanism**: an i32 flag per
binding, boxed in a `__ref_cell_i32` when captured (#1177/#1205), checked by
`emitLocalTdzCheck` in the callee. The rows failed because four places
bypassed it, none of them a missing state:

1. **Script-scope blocks never allocated their bindings when the block also
   hoists a function** (`preallocateBlockScopedSlots`, #5271 step 5). In a
   function that skip is covered by the function-entry pre-hoist; `__module_init`
   has none, so the block function captured nothing and read its OWN fresh
   `undefined` local (`{ function k(){ return w } let w = 5; k() }` returned 0,
   wrong even outside the TDZ). `__module_init` now allocates as for any block;
   function frames re-install the pre-hoisted slots + flags at block entry.
2. **The Annex B B.3.3.2 module-scope evaluation stored a capture-less cached
   closure** (`tryCompileAnnexBModuleBlockFnEvaluation`) — once 1. gave the
   function captures, its trampoline received null cells. It now uses
   `emitFuncRefAsClosure` when the function has captures, as the function-scope
   twin (`emitAnnexBFunctionClosure`) already did.
3. **A boxed-capture write had no TDZ guard** (`compileAssignment`): §9.1.1.1.5
   step 2. The guard is `emitPutValueTargetGuard`, gated on a TDZ flag and on
   `analyzeTdzAccess` ("skip" when provably initialised — no code in the common
   case). `emitLocalTdzInit` null-guards the flag box: a call the static TDZ
   analysis turned into an unconditional throw never reaches the box's tee.
4. **The #1177 by-name `fctx.locals` rescan resurrected a LEFT block's slot**
   for a closure whose reference to that name binds nothing (`xx` in the
   catch-block IIFE read the dead `18`; typeof said "undefined"). The rescan now
   skips a name no reference in the closure binds (`closureReferencesOnlyUnboundName`).

Not fixed (base fails identically, outside the 4 rows): a block function inside
a **loop** body at script scope (`for (…) { function m(){ return q } …; let q }`)
— the per-iteration flag reset at block re-entry is still missing.

**Receipts.** Family `language/statements/{let,const}/**` + `language/block-
scope/**` (426 rows): base 419 → branch 423, **0 lost** (base matches the
standalone baseline jsonl exactly). Wide net (annexB/language, eval-code/direct,
statements/block, function-code; 1,369 rows): the first 400 rows (sorted
`annexB/language/comments` … `annexB/language/eval-code/indirect`) all pass on the branch; the rest was
still running at commit time (box contention) — see the hand-back. Pin
`tests/issue-6651-v5-captured-tdz.test.ts` (6 cases; each shape was
reproduced failing on base with `.tmp` probes before the fix).
Equivalence gate green (1748 pass, 22 known). Temporal control
(`Duration/prototype/round/*`, standalone, prewarmed cache): **119 pass / 7 fail of
126, 0 `illegal cast`** — unchanged.

### 2026-10-06 — Slice V4

Derived-constructor completion and revoked-proxy construct (H4, 3 rows). Base
`adbf109200` (harness worktree branch; the lead merges by sha).

**The census location was off for row 1.** The `return null` ReferenceError
does not come from `expressions/new-super.ts`: a derived constructor with NO
lexical `super()` takes `class-bodies.ts`'s missing-super lowering, which threw
the uninitialised-`this` ReferenceError at entry unless the body was a single
`return <checker-proven primitive>`. `null` is not a primitive by those flags
(it is typeof "object"), so §10.2.1.3 step 13.c's TypeError was lost. The
decision moved to the new leaf `classes/missing-super-return.ts`, which reads
`ctx.oracle.typeFactOf` (primitive or `null` ⇒ TypeError) — one raw-checker
call fewer. Constructors that DO call `super()` already classify `null`
correctly in `statements/control-flow.ts` (#5195 Step 11 E); unchanged.

**Row 2/3 are not "handler already null before the read".** `new f()` on a
trapless proxy forwards to `Construct(target, args, proxy)`, and the target's
OrdinaryCreateFromConstructor performs `Get(proxy, "prototype")` — the `get`
trap in these rows revokes the proxy and answers undefined, so
GetFunctionRealm(proxy) throws (§7.3.22 step 4.a). The driver never performed
that read: it passed a null prototype and let the target read its own
`prototype`. New native `__proxy_construct_newtarget_proto` (in
`object-runtime-proxy-construct-chain.ts`) does `Get(proxy, "prototype")`
through `__proxy_get_dispatch`; an Object answers itself, a non-Object on a
now-revoked proxy throws the revoked TypeError, a live proxy answers null
(the caller keeps its target-prototype fallback). The trapless-forward arm of
`native-construct.ts` reads `[[ProxyTarget]]` FIRST (the trap may revoke and
null it) and only consults the native when no prototype was supplied.

**Rows (standalone, QuickJS eval, in-process):** the 3 target rows 0/3 → 3/3.

| family | base pass | branch pass |
| --- | --- | --- |
| `language/statements/class/subclass/**` (109) | 93 | 93 (identical non-pass set) |
| `built-ins/Proxy/revocable/**` (18) | 17 | 17 (identical) |
| `built-ins/{Proxy,Reflect,Function/internals}/**` minus revocable (454) | 419 | 422 (only the 3 targets moved) |

**Residuals.**
- A live proxy whose trap answers a non-Object prototype still gets the
  target's `prototype`, not the realm's %Object.prototype% (§10.1.14 step 4.b).
- A prototype the trap returns as a CLOSED struct object literal reaches the
  instance, but the instance does not see that struct's methods (`b.m()` throws
  where node answers 9; base answered the target's 5). `__object_create` on a
  closed struct; pinned as a residual comment in the test.
- A missing-`super()` body returning an Object (`return {}`) still throws the
  entry ReferenceError instead of returning the object (step 13.a).

Pin: `tests/issue-6651-v4-derived-ctor-completion.test.ts` (5 cases).
Controls: `node scripts/equivalence-gate.mjs` green; Temporal
`Duration/prototype/round/*` standalone 119 pass / 7 fail of 126, 0
`illegal cast`.

### 2026-10-06 — Slice V6

Module namespace exotic object internals (H6), on `77f00492c7`. **7/7 target
rows flip** (`namespace/internals/{define-own-property, delete-exported-uninit,
get-own-property-str-found-uninit, get-str-found-uninit,
own-property-keys-binding-types, own-property-keys-sort,
super-access-to-tdz-binding}`), plus `get-own-property-str-found-init`.
Measured base vs branch with `JS2WASM_EVAL_ENGINE=quickjs … run-test262-paths.mts
--standalone`, both sides with the runner fix below.

What each row actually needed (several were not §10.4.6 at all):

1. **[[Get]]/[[GetOwnProperty]] TDZ.** Every live export slot (`var`/`let`, a
   TDZ-tracked `const`, `export default <expr>`) is a non-configurable accessor
   over a minted getter that runs the binding's TDZ check first
   (`ensureLiveBindingGetters`, in its own phase before the object's helpers are
   reserved so index shifts settle first). A module that imports its OWN
   namespace keeps every top-level TDZ flag (`ns.x` is invisible to the elision
   walk), and allocates them before class bodies compile — a class body can
   build `ns` first, which baked a getter with no flag
   (`prepareSelfImportingModuleTdzGlobals`).
2. **The data-property view.** The NEW leaf `object-model/module-namespace-exotic.ts`
   brands each binding entry and prepends arms to the generic natives:
   `__getOwnPropertyDescriptor` answers `{value, writable: true, enumerable:
   true, configurable: false}` by reading the binding; `hasOwnProperty`/`hasOwn`/
   `propertyIsEnumerable` read it (TDZ) then answer true; `__defineProperty_value`
   implements §10.4.6.6 through the #6770 rejection channel; accessor defines
   and `Object.freeze` reject; `isFrozen` answers false.
3. **`[...exported, Symbol.toStringTag]`** (define-own-property) null-derefed:
   the string spread picked a native-string vec and the symbol was coerced into
   it. The literal now widens to externref when a fixed element is not a string.
4. **own-property-keys-sort was an `illegal cast`, not a sort bug**: the harness
   prelude has a direct `eval`, which keeps `var allKeys = Reflect.ownKeys(ns)`
   as an externref global holding the runtime `$ObjVec`; `allKeys.indexOf(…)`
   then `ref.cast` it to the string vec. #6770 S5's materialize-the-receiver arm
   now also admits `Reflect.ownKeys` / `getOwnPropertySymbols` calls and a
   binding initialised from any own-key-list call (read-only methods only — the
   receiver is a copy).
5. **super-access-to-tdz-binding**: the super receiver in a derived constructor
   was the struct `this`, not the object the parent constructor returned
   (§9.1.1.3.1 BindThisValue). `emitTypedThisSuperReceiver` now uses
   `tryEmitDerivedEffectiveThis`; the §10.1.9.2 receiver step then reaches the
   descriptor arm and throws the ReferenceError. A dedicated
   `__reflect_set_receiver` arm in the saved WIP was removed: it fired before the
   target chain's setter (`super-set-to-tdz-binding-with-accessor` regressed).
6. **own-property-keys-binding-types** was a local-runner gap: the in-process
   self-import branch of `tests/test262-runner.ts` compiled the entry alone, so
   `export * from './…_FIXTURE.js'` resolved nothing (7 of 10 keys). It now links
   the static fixture graph exactly as the sharded path in `test262-shared.ts`
   already does; the CI verdict for this row was never subject to this gap.

Not fixed: `super.x = v` where the namespace binding is INITIALISED and `v`
differs still answers true (the receiver write goes through `__extern_set`,
which skips an accessor without a setter instead of applying §10.4.6.6).

**Receipts.** Family `language/module-code/namespace/**` + `instn-*` (114 rows):
base 36 → branch 44, **0 lost**. Pin `tests/issue-6651-v6-module-namespace.test.ts`
(3 cases, all RED on base). Equivalence gate green (1748 pass, 22 known).
Temporal control (`Duration/prototype/round/*`, standalone, prewarmed cache):
**119 pass / 7 fail of 126, 0 `illegal cast`** — unchanged.

### 2026-10-06 — Slice V7

Keyed destructuring evaluation order + for-of after `delete
Array.prototype[Symbol.iterator]` (H7; adopts #5154 A(a)), on `77f00492c7`.
**6/6 target rows flip** (the spec said 5; the for-of `*-ary-init-iter-get-err-
array-prototype` row exists for `var`, `let` and `const`): the three
`keyed-destructuring-property-reference-target-evaluation-order*` rows and the
three for-of rows, measured base vs branch with `JS2WASM_EVAL_ENGINE=quickjs …
run-test262-paths.mts --standalone`.

Root causes (none was an ordering bug in an existing lowering — the elements
were not evaluated at all):

1. **An object assignment pattern with a key only the runtime can name**
   (`{ [k]: t } = s`, `k` an object with `toString`) was SKIPPED by the struct
   lowering — no ToPropertyKey, no GetV, no PutValue. Standalone/WASI now route
   such a pattern to `tryEmitSpecOrderedObjectAssign`
   (`dstr-assign-iterator-drive.ts`): PropertyName + ToPropertyKey once → the
   target Reference (base, raw key) → GetV → Initializer on undefined → PutValue
   (the target key's ToPropertyKey runs inside the [[Set]]), per §13.15.5.6.
   Strict/sloppy [[Set]] chosen from the pattern's context. Host lane unchanged.
2. **`with (o) { var { [k]: x = d } = s; }`** never consulted the with object for
   `x`. `tryCompileWithScopedVarDeclaration` now takes object binding patterns
   whose names resolve through a dynamic `with` scope and emits §14.3.3.3 order
   (key → ResolveBinding/HasBinding → GetV → Initializer → write through the
   chosen scope) via `tryEmitSpecOrderedBindingPattern`.
3. **The for-of array fast path never read the #5139 delete flag.**
   `emitForOfArrayIteratorDeletedGuard` (`proto-override.ts`, moved
   `emitArrayIteratorDeletedGuard` out of `destructuring-params.ts`) throws
   TypeError after the iterable is evaluated when the flag is set, for an
   Array/tuple-typed iterable only (oracle `typeFactOf`; TypedArrays keep their
   own `@@iterator`). Zero emitted bytes when no delete exists in the program.

**Receipts.** Family `for-of/dstr/**` + `expressions/assignment/{destructuring,
dstr}/**` + `destructuring/binding/**` + `statements/with/**` (1,145 rows):
base 1,096 → branch 1,102, **0 lost**. Pin
`tests/issue-6651-v7-dstr-order.test.ts` (4 shape cases + the 6 rows, 10/10).
Equivalence gate green (1748 pass, 22 known). Temporal control
(`Duration/prototype/round/*`, standalone, prewarmed cache): **119 pass / 7 fail
of 126, 0 `illegal cast`** — unchanged.

Not fixed (base fails identically): the `obj-rest-*` rows in for-of/dstr and
assignment/dstr (object rest over runtime sources), `array-elem-init-in.js`
(parse), and three `with` Proxy-env rows.

### 2026-10-06 — Slice V9

Parser compatibility (H9, 2 rows; adopts #6836). Base `559c18a93f` (harness
worktree branch; the lead merges by sha).

**Root cause.** Both failures are in TypeScript's parser, before any js2wasm code
runs. `parseForOrForInOrForOfStatement` treats every leading `let` as a
declaration. So `for (let; ;)` silently becomes an empty `let` list and
`for (let = 3; ;)` fails with "Variable declaration expected". It also keeps
the head's NoIn context inside array literals, so `[x = 'x' in {}]` in a
`for` head gets "',' expected". Neither can be fixed downstream: by the time
codegen sees them, the AST is already wrong.

**Fix.** A new pre-parse leaf `src/compiler/for-head-parser-compat.ts` makes
insertion-only edits. `compileSourceSync` calls it after define substitution
and composes its edits into the #1928 PositionMap chain:

- `for (let …` becomes `for (0, let …`. This needs an explicit Script goal,
  non-strict code (no `"use strict"` prologue on the script or any enclosing
  function, not inside a class) and an unescaped `let`, and the next token
  must not be able to start a binding. It does not use `(let)`, because a
  parenthesised target loses NamedEvaluation (#6836 hazard 4).
- `[x = <rhs with in>]` becomes `[x = (<rhs>)]`. The parse must have a TS1005
  at that `in`, and the element must be exactly `Identifier = RHS`.

Every other program comes back byte-identical. The full admission boundary and
the residuals are in #6836's "Implementation" section.

**Rows (standalone, QuickJS eval, in-process, chunks ≤200):** both targets went
from compile_error to pass. Family controls:

| family | base pass | branch pass |
| --- | --- | --- |
| `language/statements/for/**` (385) | 384 | 385 (+`head-lhs-let`, 0 lost) |
| `language/statements/for-in/**` (119) | 116 | 116 (identical non-pass set) |
| `language/statements/for-of/**` (751) | 715 | 716 (+`dstr/array-elem-init-in`, 0 lost) |
| `language/statements/let/**` (145) | 143 | 143 (identical) |
| host (gc) lane, first 200 rows of `statements/for/**` | 194 | 194 (identical) |

Measurement note: creating the new src file made the QuickJS provider key stale,
so the first base pass got "provider is not built" on 34 eval-dependent rows.
Those 34 were re-measured on the restored base tree (file-copy swap, provider
cache HIT at key `320718af46eaa03c`). The table uses those re-measured results.

**Residuals.** Not wired into the multi-source, disk-project or object-output
entry points. Emitted source maps and function source text show the inserted
characters, a gap every pre-parse rewriter shares. The inserted `0,` produces
one downgraded TS2695 warning. Not handled: `for await` heads, A targets that
are not identifiers, and L followers `++`/`--`/`=>`/template.

Pin: `tests/issue-6651-v9-sloppy-let-parse.test.ts` (35 cases: leaf admission
both ways, a position-map check, and 4 standalone runtime cases including the
unresolvable-`let` ReferenceError and `let = function(){}` naming).
Controls: `node scripts/equivalence-gate.mjs` green (22 known failures, 1748
passing); Temporal `Duration/prototype/round/*` standalone 119 pass / 7 fail of 126, 0
`illegal cast`.

### 2026-10-06 — Slice V10a

Primitive ToObject prototype reads (H10, first group; 3 rows). Base
`58d36ecb0a` (harness worktree branch; the lead merges by sha). **2 of 3 rows
flip; `put-value-prop-base-primitive` is NOT fixable at this layer — see
residuals.**

**Row 1 — `types/reference/get-value-prop-base-primitive` (`Symbol().x`).** Two
stacked causes, both measured with probes. (a) The #5269 B-d arm in
`property-access-dispatch.ts` folded every non-own read off a symbol to
`undefined` unconditionally. It now declines when the module writes
`Symbol.prototype` / `Object.prototype` (`moduleExtendsSymbolProto`, the symbol
twin of #4483's `moduleExtendsPrimitiveProtos` — the scan is shared,
parameterised by constructor set), and the read takes a new symbol arm of
`tryEmitPrimitiveProtoMemberGet` (#4668): box via `__box_symbol`, and in sloppy
code ToObject via `__new_Symbol` + `linkSymbolWrapperPrototype` (the same
§10.4.3 strictness split as the number/boolean arm), then `__extern_get`.
(b) Even boxed, the read answered `undefined`: `__protoidx_brand_off`
classified a bare `$Symbol` carrier as Object (only the `Object(sym)` wrapper
was classified Symbol, #6651 H5), so the Symbol companion that the prototype
write populated was never consulted. One `ref.test $Symbol → SYMBOL_OFF` arm
beside the bare string/number/boolean arms (#4207) — the site that owns
"which implicit prototype does this receiver have". A first cut gated B-d on
`protoNamedDirty` instead (any builtin-proto write disabled the fold); a family
chunk that happened to run with that cut in place read 187 vs the clean 191, so
the gate is the narrow Symbol/Object scan (that 4-row figure is from a mixed-
state run, not a controlled A/B).

**Row 3 — `Promise/prototype/catch/this-value-obj-coercible`.** Not a lookup
failure: the reflective `catch` body's IsCallable guard reused
`__promise_has_callable_then`, the RESOLVE-path thenable predicate, which
answers 0 for every primitive by design (§27.2.1.3.2 step 8 — a primitive
is never a thenable; widening the predicate would make `resolve(true)` call
`Boolean.prototype.then`). Invoke(V, "then") ToObjects instead (§7.3.2), so a
primitive `this` now skips that predicate (new leaf
`object-model/primitive-carrier-test.ts`: i31 / boxed number / boxed boolean /
native string / `$Symbol`) and reaches the vararg dispatcher's
`__extern_method_call` fallback, which walks the wrapper prototype and already
throws the TypeError for an absent or non-callable `then` (pinned as controls).
`ensureSymbolCarrier` is reserved at the head of the body, before any index is
baked, so the `$Symbol` test exists when the harness has not yet minted one.

**Rows (standalone, QuickJS eval, in-process):** targets 0/3 → 2/3.

| family | base pass | branch pass |
| --- | --- | --- |
| `types/reference/**` + `Promise/prototype/{catch,then}/**` + `Symbol/prototype/**` + `Number/prototype/**` (321, 2 chunks) | 301 | 303 (only the 2 targets moved; 0 lost) |
| `built-ins/Symbol/**` minus prototype + `Boolean/prototype/**` + `Promise/prototype/finally/**` + `Object/prototype/toString/**` (159) | 139 | 139 (identical non-pass set) |

**Residuals.**
- `put-value-prop-base-primitive` needs **mutable [[Prototype]] on builtin
  prototypes**: `Object.setPrototypeOf(Number.prototype, proxy)` is a silent
  no-op on a `$NativeProto` today (`getPrototypeOf` still answers
  `Object.prototype`, measured), and the companion consult chain is hard-wired
  `brand → Object.prototype` (proto-index-store.ts "Chain depth is 2"). The
  PutValue side already works for an accessor on the companion (a
  `Number.prototype` setter fires once with `(0).acc = 5`), and a Proxy in an
  ordinary `$Object` chain already receives `set` traps — so the missing piece
  is (1) `__object_setPrototypeOf` on a `$NativeProto` storing the parent on its
  companion, (2) `getPrototypeOf` reading it back, (3) `__protoidx_get_k` /
  `__protoidx_set_r` / has walking the companion's parent instead of jumping to
  the Object companion. Its own slice; not attempted here.
- A sloppy accessor reached from strict code (or the reverse) gets the wrong
  `this` on a symbol read — the same read-site strictness proxy #4668 records.

Pin: `tests/issue-6651-v10a-primitive-base.test.ts` (first describe fails on the
base tree with `undefined|undefined` / `!TypeError`; the controls pass on both).

### 2026-10-06 — Slice V10d

H10 last group (3 rows). Base `410cc7da1d` (harness worktree branch; the lead
merges by sha). **1 of 3 rows flips
(`Symbol/prototype/Symbol.toPrimitive/removed-symbol-wrapper-ordinary-toprimitive`);
`Map/prototype/set/append-new-values` and `Array/from/source-array-boundary`
are root-caused below but NOT fixed — both need a design decision.**

**Row 1 — `removed-symbol-wrapper-ordinary-toprimitive`.** Three independent
causes, each found with a probe that recorded every failing assert of the test
(the first failure masked the rest: 20 failing lines on base).
(a) *Closure capture forks a module binding.* A closure-valued top-level `let`
(`let valueOfFunction = () => …`) keeps a `__module_init` shadow local beside its
module global (#3546). A READ-ONLY closure over it (the `valueOf` getter arrow)
boxed that shadow into a fresh ref cell; later top-level writes go to the global
— and, once the init body is split into chunks, ONLY to the global, because a
chunk helper cannot see another chunk's locals — so the getter kept returning
the first function after `valueOfFunction = null`. Unchunked it still diverged
for every other function (`function h() { return vf; }` read the stale global
while the cell held the write). `planClosureCaptures` now skips a capture whose
slot is the recorded shadow of a module global when the closure does not write
the name; the lifted body reads the live global, exactly like the sibling
`isDirectRuntimeModuleVariableBinding` skip. A closure that WRITES such a
binding is unchanged (and still diverges — residual).
(b) *ToString of a Symbol wrapper.* `__extern_to_string_spec`'s #6651 H1 arm
threw "Cannot convert a Symbol value to a string" for every wrapper with no
user-visible `@@toPrimitive`, assuming the intrinsic. It now also requires the
intrinsic to stand: the Symbol brand's prototype companion is absent, unseeded
(no `constructor` entry — a bare named write such as `Symbol.prototype.foo = 1`
creates an empty companion), or still carries `@@3`. After
`delete Symbol.prototype[Symbol.toPrimitive]` the conversion reaches
OrdinaryToPrimitive (`"".concat(Object(Symbol()))` → `"Symbol()"`).
(c) *ToPropertyKey of an object key.* `{ "123": 1, foo: 3 }[o]` returned
`undefined` for ANY object key with a `toString` — not Symbol-specific: only
`__obj_hash`/`__obj_find` coerced their key, and the closed-struct field ladder
(and the other finalize prologue arms) answer before the `$Object` walk. A new
leaf `object-model/extern-get-object-key.ts` unshifts, LAST, a ToPropertyKey arm
onto standalone `__extern_get`: a `$Object` key goes through
`__to_property_key` once (the result is a fixed point, so the user `toString`
runs exactly once); a Symbol wrapper decided by the intrinsic `@@toPrimitive`
keys by its Symbol (`symbolWrapperIntrinsicArm`, factored out of the H1 arm),
because `__to_primitive` cannot see the intrinsic on a wrapper (H5) and would
have keyed `o[Object(sym)]` by `"Symbol(…)"`. Non-object keys pay one
`ref.test`.

**Row 2 — `Map/prototype/set/append-new-values` (not fixed).** Not a size bug:
the failing assert is `map.get(1)` (`NaN` vs `"valid"`; the runner's line
attribution points at the preceding statement). TypeScript infers
`Map<string | number | symbol, number>` from `new Map([[4, 4], ['foo3', 3], [s, 2]])`
in the JS file; the native `__map_get` returns the stored `anyref` correctly,
but every consumer that trusts the inferred `V = number` — a `var` initialised
from `map.get(1)`, a call argument specialised to `f64`, and later the
`forEach` callback's `value` parameter — coerces the string to `NaN`. Probe:
`new Map()` (no initializer) answers correctly; `[1, 2]` + `push("x")` shows the
same class for arrays. A fix needs JS-file generic-inference soundness (treat
inferred collection type arguments as untrusted when the file writes a
non-assignable value), which touches every Map/Set/Array consumer — out of a
singles slice. #3585 / PR #6234 (direct `Map.get` equality) is adjacent, not
the cause.

**Row 3 — `Array/from/source-array-boundary` (not fixed).** Confirms the
2026-10-02 audit: `this.arrayIndex++` through ANY dynamic global-object
receiver misses the `var arrayIndex` binding (`function m() { return
this.arrayIndex; } m()` and `f.call(this)` both fail standalone; only the
lexical top-level `this.x` / `globalThis.x` folds work). Needs the canonical
global-object ↔ var-binding identity (#2727), not an `Array.from` change.

**Rows (standalone, QuickJS eval, in-process):** targets 0/3 → 1/3.

| family | base pass | branch pass |
| --- | --- | --- |
| `Symbol/toPrimitive/**` + `Symbol/prototype/**` + `Map/**` + `Array/from/**` + `expressions/{equals,does-not-equals}/**` (373, 2 chunks) | 341 | 342 (only the target moved; 0 lost) |

The first branch run of chunk 2 reported 3 extra failures
(`Symbol/toPrimitive/cross-realm`, `equals/S11.9.1_A6.1`,
`does-not-equals/S11.9.2_A6.1`), all "quickjs provider is not built" — a source
edit mid-run changed the adapter key. Rebuilt and re-run: all 3 pass.

Pin: `tests/issue-6651-v10d-toprimitive-map-from.test.ts` (7 cases, 2 GUARDs:
an unseeded Symbol companion keeps the intrinsic TypeError; an intact wrapper
keys by its Symbol). Controls: `node scripts/equivalence-gate.mjs` green (22
known failures, 1748 passing); Temporal `Duration/prototype/round/*` standalone
119 pass / 7 fail of 126, 0 `illegal cast`.

**Residuals.** A closure that WRITES a closure-valued top-level binding still
boxes the shadow (writes reach the cell, not the global); the ToPropertyKey arm
covers `__extern_get` only (`__extern_set`/`__extern_has` keep their
`__obj_*`-level coercion); `redefined-symbol-wrapper-ordinary-toprimitive`
(sibling row, not in scope) still fails.

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

### 2026-10-02 — current-main frozen-scope census plan (Codex)

Measurement checkout: isolated `es6-frozen-recipe-analysis/js2`, production
HEAD `ce6631272c1fdd999bc7b55a3cc6bfa77b3e48f8`. The historical 11,030/11,778
receipt remains historical and is not a current-main result.

1. Preserve the committed 11,778-path manifest, SHA-256
   `632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
2. Verify the selected corpus bytes against gitlink
   `b363f29d3c43c626dc852744ad64a0b48a003693`, not merely corpus HEAD.
   Preflight compared all 11,778 selected file blob hashes: zero mismatches.
   Primary corpus has unrelated untracked probes; they are not selected.
   Tracked harness and src diffs against HEAD are empty.
3. Use Node 24.19.0 / pnpm 10.30.2, standalone/auto semantics, QuickJS,
   fresh worktree-local adapter cache and rebuilt compiler/runtime bundles.
   Existing immutable QuickJS core artifact may be reused only after builder
   verification; current-source adapter canaries must run on a cache miss.
4. First run three original controls through the same authoritative wrapper:
   Math.sign length plus restored Intl DisplayNames/Segmenter prototype-poison
   cases. Require three registered and settled, no skips/exclusions; report
   actual outcomes instead of assuming they pass.
5. Then run all 16 maintained local shards using the complete exact manifest.
   Independently audit 11,778 unique verdicts, registered/started/settled identity
   equality, all 16 receipts, zero skips/exclusions, and intact manifest hash.
   A green completeness validator alone permits skips and is insufficient.
6. Keep logs/results/cache local to this checkout; do not overwrite historical
   census artifacts. Keep the execution session alive across chat continuations;
   the maintained runner has no interrupted-run resume support.

This is an unfinished measurement plan, not a 100% claim or a source fix.

Positive controls completed under authoritative runner run
`20261002-142604`: **3 pass / 3 original tests**, zero failures, compile errors,
skips, or exclusions. The one durable v2 shard receipt independently records
3 registered/started/settled/verdict identities and all callbacks settled.
This proves only these controls, not the full census.

- Compiler bundle SHA-256:
  `5b4ac5614e65f5387e709f6ff20959e835a5834f378ee026b4a6c553069af2fb`.
- Runtime bundle SHA-256:
  `1ff325299a2274e5816bbb93cd3779e486f101baa5f9c845bd6aae039e8849af`.
- QuickJS adapter cache MISS key `7a96df4a220b20a1`, bundle key
  `288d238990a24b57`, built and canary-verified, 585,565 bytes; binary SHA-256
  `8b1bd936968e87484d56a3f3c1f407bbebc8e48b926ca82eed00858e4fcdea07`.
- Verified immutable QuickJS core SHA prefix `e9f8d30bc347dbc5`.
- Worktree-local launch log `.tmp/es2015-census-controls-run.log` SHA-256
  `22057fd2027f205d8bc4a6a787b21b20bbc7789436e16c6723f6194dd82e2653`.
- Worktree-local JSONL
  `benchmarks/results/test262-standalone-results-20261002-142604.jsonl`
  SHA-256 `3358977487485f6880304059405cd30bde4d54070036c69a886b9cebe919c3bf`.

Next: run full original manifest with the same source/provider pair after the
Intl shepherd's bounded publication releases the team-wide heavy lease.

Full frozen census is now **running**, not complete: run ID
`20261002-144520`, unified execution session `74723`, wrapper PID `32646`.
The authoritative wrapper validated and snapshotted all 11,778 paths with the
same frozen SHA-256, rebuilt unchanged current-source bundles, and verified
the linked QuickJS pair under adapter key `7a96df4a220b20a1`. Its earlier fresh
cache-MISS canaries are the `20261002-142604` control receipt above; do not
mislabel the full run's cache HIT as a new canary execution.

- Durable full launch log: `.tmp/es2015-frozen-full-current-main-run.log`.
- JSONL: `benchmarks/results/test262-standalone-results-20261002-144520.jsonl`.
- Expected receipts: matching `.shard-<1..16>-of-16.complete.json` files.
- Exactly 16 maintained shard entries selected; first actual registration is
  shard 9/16 with 736 originals and one unified fork worker, realm recycle.
- Keep this same live session across continuations; do not restart from a
  partial row count or merge this attempt with another timestamp.
- No root compiler/source or HEAD changes while this census is active.
  Other lanes may investigate or edit their own isolated sources, but the root
  census holds the team-wide heavy lease until the process is truly terminal.

The independent current-main eval-spread diagnostic baseline is **5 pass /
15 controls**, 10 semantic failures, at the same `ce6631272` compiler/runtime
bytes. This is not 15 original Test262 paths and not a census pass rate. Its
current-source routing fix is tracked separately in local #6827; the initial
missing-bundle attempt was infrastructure-only and is not a regression count.

First completed shard receipt, **9/16**, independently audited while the full
run remains live: **717 pass / 736 originals**, 17 runtime failures and 2
compile errors. All 736 registered callbacks started and settled; 736 unique
canonical verdicts match that shard's registered identity set; zero skips and
zero official/proposal exclusions. This is one completed weighted shard, not
a representative sample or the full ES2015 pass rate.

The source audit of `object/method-definition/name-property-desc.js` also
corrected an attribution trap: this file checks the object's `method` property,
not the function's `name`. `verifyProperty` can emit its configurable message
because deletion/absence fails even when the reported descriptor flag is true.
Current leaf sources suggest anonymous closed-object deletion/tombstone coverage;
changing descriptor flags alone would not repair actual deletability. The exact
emitted arm and all deletion/presence/read consumers still require focused proof.

Continuation checkpoint: session `74723` is confirmed live. Four completed
receipts were independently matched to their registered original identities:

- Shard 5: 715 pass, 19 fail, 2 compile errors / 736 originals.
- Shard 7: 708 pass, 29 fail / 737 originals.
- Shard 8: 717 pass, 16 fail, 2 compile errors / 735 originals.
- Shard 9: 717 pass, 17 fail, 2 compile errors / 736 originals.

Each receipt has equal registered/started/settled/canonical counts, all callbacks
settled, no duplicate verdict identities, and zero official/proposal exclusions
or skips. These four completed shards total **2,857 pass and 87 nonpasses /
2,944 originals**. Do not extrapolate these weighted shards to the full scope.
The live JSONL observation separately contained 3,547 unique originals, 3,441
pass, 99 fail, and 7 compile errors; additional rows are still arriving.

Upstream main subsequently advanced to
`3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8`. The clean native-eval CI branch
integrated it as `437636697fc20c8616d3e3b79b5eba4b67e51f90`; this census
deliberately remains pinned to `ce6631272` and must not be described as measuring
the newer head. New Object/Reflect changes require re-grounding pending Proxy
work before implementation; no test results from this run prove those changes.

Scope-fidelity audit while session `74723` remains live: both the original
11,778-path manifest and the runner snapshot still hash to
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
At this observation, all 4,172 JSONL identities were unique and inside that
original scope; all used oracle version 14, honest lane, semantic providers auto,
and none were skipped. The five completed receipts registered 3,680 disjoint
original identities. This is an interim identity audit, not full completion.

Latest-main source re-grounding found the two observed Object.names/symbols
invariant failures already addressed by #6770 S7, commit `172c0dac29` (verified
ancestor of `3c6fcfc6`): shared full-key target inventory, raw Proxy dispatch,
and filtering only at the public Object boundary. #6828 records supersession
rather than duplicating that patch. Re-run both originals on the newer source
before claiming actual passes. The RegExp split Symbol-flags original is already
tracked in #6775's residuals as reassigned closed-literal shape widening; do not
replace its TypeError with a protocol-specific workaround or silently edit the
other machine's held literal/inference implementation.

### Front-end follow-up: `in` inside a for-of assignment default

The original `test/language/statements/for-of/dstr/array-elem-init-in.js` is an
actual compile-error row in this run. Its `for ([x = 'x' in {}] of [[]])` is valid
JavaScript. A small parser-only control at worktree head `437636697` (compiler
source integrated from `3c6fcfc6`) reproduced TypeScript 5.9.3 diagnostic 1005,
comma expected at zero-based line 30, character 15; V8 `vm.Script` parses it.
Crucially, the recovered TypeScript initializer has **two** elements (`x = 'x'`
and `{}`), not the required single default whose RHS is the `in` expression.
Ignoring the diagnostic would compile the wrong program.

The parenthesized equivalent has one correct initializer and no diagnostics;
the binding form `for (var [x = 0 in {}] of [[]])` also parses. The invalid
control `for ([x = ] of [[]])` is rejected by both parsers (TS 1109). These are
four parser controls, not four original Test262 passes. The original bytes have
SHA-256 `ca1f9739c987c76c5a1f76603306298eebabb09ce2746a0f16a792d5e270ae16`.
Durable output lives in the root CI worktree at
`.tmp/for-of-in-parser-current-main-proof.log`, SHA-256
`7c5b9f9b18914efa3fd1fe20b33f8ade125524f85b49c08b2686efb48a45ff6d`.
The first attempted `tee` failed because that worktree's `.tmp` did not yet
exist; only the successful rerun is the durable receipt.

Implementation plan before dispatch:

1. Coordinate the parser/checker entry seam with the other-machine IR owner;
   no compiler/IR-entry source edit is authorized by this finding alone.
2. Repair JavaScript assignment-pattern parsing before checker binding, using
   a narrow grammar-aware front-end owner. Preserve original source positions,
   parent links, pattern/default AST shape, and evaluation order; do not alter
   the original corpus or add TS1005 to diagnostic tolerances.
3. Cover nested array/object defaults, `in` operators and parentheses, ordinary
   for-in/for-of disambiguation, strings/comments/templates, and invalid syntax.
   Verify both Script and Module front-end consumers and mapped diagnostics.
4. After the census lease ends, run the unchanged original plus matching
   for-of/destructuring neighbors under the authoritative standalone runner;
   capture fresh current-head baseline/candidate identity-matched receipts.
5. Keep this residual open until actual compile/run semantics, invalid-input
   rejection, source-position preservation, and normal repository gates pass.

Source-only implementation has been dispatched separately for the genuinely
unlanded AsyncFunction intrinsic and Proxy missing-set-trap receiver contracts;
each lane must record its own MD plan, use its own latest-main worktree, and
wait for the heavy lease before any validation/publication. Neither is a measured
gain yet, and the still-live census is not interrupted for those branches.

Follow-up source review corrected the AsyncFunction dispatch premise. #6829
now records a genuine coordination dependency, not an implementation: a
descriptor-only branded object would be a fake constructor. The frozen scope
contains both `AsyncFunctionPrototype-to-string.js` and `is-a-constructor.js`;
the latter actually constructs it. The existing generic provider publishes
only an incomplete callback carrier, while correct construction needs planned
provider/IR/call/construct integration. No source changed in that lane. The
broader 18-file AsyncFunction directory is a neighbor set, not the literal goal
manifest; the 23 GeneratorFunction originals are all in the frozen manifest.

#6828 has an unvalidated current-`3c6fcfc6` Proxy missing-set-trap receiver
checkpoint in its own fresh worktree. Review requires preserving the existing
boolean result channel and strict false behavior, one observable trap lookup,
late-import index correctness, and the reserved receiver-aware helper contract.
Its added instruction builders should be extracted narrowly rather than
silently regrowing the already-over-budget Proxy module. No pass gain is claimed.

Another independently grounded leaf candidate is the actual compile-error
original `annexB/language/statements/labeled/function-declaration.js` (`noStrict`).
The current early-error rule at `compiler/early-errors/node-checks.ts:488`
mistakes the inner label in `label1: label2: function f(){}` for an iteration/if
body, because the shared `isStatementPosition` predicate also admits labeled
parents. A scoped Terra Max writer has been dispatched to exclude label parents
only from this rule, preserving the separate strict/generator/async/class checks
and outer-label iteration/if/with exclusions. It must write its own atomic-ID
MD plan before production source, retain the exact original, and validate
positive binding semantics plus negative grammar neighbors after the lease.

### Source review and live census checkpoint

Session `74723` was re-polled and returned a live session handle. An independent
JSONL observation contained 8,247 rows: 7,992 pass, 241 fail, and 14 compile
errors, with eleven completion receipts present. These are partial counts, not
a final population rate or a measurement of the newer `3c6fcfc6` source.

#6828 extracted its instruction builders into a type-only object-model leaf
and banked standalone Set target/handler before observable trap lookup. Root
review nevertheless found a non-standalone regression: the explicit receiver
trap-absent arm used the saved target local even though host/WASI did not
initialize it. The worker must restore that lane's original target read before
runtime validation; source checks alone did not establish behavioral safety.
No build, test, commit, push, or pass gain is attributed to this checkpoint.

The labelled-function lane reserved #6830 in its own latest-main worktree.
Its source audit found that `collectDeclarations` and top-level body compilation
scan direct source statements, missing a function beneath nested labels. A
one-condition early-error exemption is therefore not a completed semantic fix.
Keep before/after calls to the actual binding in acceptance tests, and retain
the hoisting prerequisite rather than relying on folded `typeof` or syntax-only
success. Coordination of the `src/codegen/declarations.ts` seam with the other
machine's IR owner has been requested; no source edits in that seam are yet
authorized. The issue remains unfinished and its acceptance boxes unchecked.

A subsequent independent scope audit found 8,477 JSONL rows and 8,477 unique
identities, all inside the original 11,778-path manifest. Both original and
runner snapshot retain SHA-256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
All rows retained oracle 14 / honest / auto provenance, with no skip or unknown
status. Eleven completed receipts covered 8,098 disjoint registered identities;
each had equal registered/recorded/canonical/started/settled counts, true
all-callbacks-settled, standalone/auto provenance, and zero official or proposal
exclusions. No audited receipt identity was missing from the live JSONL. This
is still an interim audit, not completion of the remaining five shards.

Root inspected the #6828 source correction: its explicit receiver absent arm
now retains the old host/WASI target-field read when standalone target banking
is disabled. This removes the identified uninitialized-local source regression;
it is not runtime validation or proof that all neighboring behavior is preserved.
A separate read-only shepherd audit is examining the actual Reflect.setPrototypeOf
non-extensible failure against current main, accounting for the already-landed
#5148 status helper and #6651 conjunction rather than repeating their old fix.

### Additional grounded front-end residuals

The live census now records `language/statements/for/head-lhs-let.js` as a
compile error. Its actual source uses `for (let; ; )` and `for (let = 3; ; )`,
not `for (let in {})` as an older #5158 note describes. A parser-only comparison
at root CI head `437636697` used TypeScript 5.9.3 ScriptKind.JS and V8
`vm.Script`; it is not a compiler run or a Test262 verdict. V8 parses the
unchanged original (SHA-256
`8b86eddac198ea57fff2829f34d2ded2a772fb81aa1210794fd4e73f85e8e5cf`).
TypeScript recovers both relevant initializers as empty VariableDeclarationLists:
`let` and `let =`, with 1134/1109/1128 diagnostics on the assignment form.
The identifier-only form has no parse diagnostic despite its wrong AST shape.
The indexed `[let][0]` initializer and real lexical `let x = 0` control retain
their correct shapes; V8 rejects the strict `var let` and incomplete-assignment
negative controls. Diagnostic suppression alone is therefore insufficient.
Retain #143/#5271's parser residual in the full goal; do not adopt an old
"wont-fix" carve-out. A grammar repair must preserve sloppy IdentifierReference
versus LexicalDeclaration disambiguation and strict/module rejection, source
positions, checker binding, and the real assigned value after the loop.

The actual `annexB/language/function-code/function-redeclaration-switch.js`
compile-error row also has newer source evidence than #3047's historical
residual attribution. Current `checkSwitchCaseLexicalDuplicates` rejects a
second FunctionDeclaration unconditionally, while `import-manifest.ts` already
filters TypeScript diagnostic 2393. The normal block duplicate rule already
models sloppy plain-function-only eligibility. A source-only Annex B audit is
checking the switch rule and real duplicate-binding hoisting/storage before
dispatching a fix; preserve strict/module, generator/async/class, lexical-var
conflicts, and before/after callable semantics. Neither observation is a pass
gain, and neither authorizes edits to the other machine's IR seams.

The #6830 reader audit additionally found that correct top-level labelled
function registration needs `index.ts`'s early name inventory and
`ir/identity.ts`'s exact top-level-function identity, not just the four direct
registration/body loops in `declarations.ts`. `pushProgramAbiTopLevelCallable`
requires that identity. Preserve this coordinated prerequisite rather than
creating a callable outside the prepared planning contract.

The switch duplicate rule has been separately dispatched to the same Terra
writer for a fresh atomic issue and managed current-main worktree, owned only
within the narrow `duplicates.ts` rule plus its own plan and controls. Existing
Annex B live-binding machinery is a source-audit lead, not measured semantic
proof. In particular, require last-wins CaseBlock lexical instantiation before
any clause executes: calling `a()` before the first declaration in an executed
case must observe the later duplicate even if its case is never executed.
Preserve the resulting outer Annex B binding and all negative syntax controls;
if that reveals a lowering gap, keep the checker checkpoint unfinished.

#6828 source review found another observable trap lookup in the result-aware
`__extern_set` front guard: `noSetTrap()` reads `handler.set` before dispatch
reads it again. A revoking getter can therefore revoke before the authoritative
dispatch, despite its saved target. The writer is auditing that standalone
branch and adding unannotated controls that actually activate the inherited-Set
gate, preserving boolean/result-channel behavior and non-standalone paths.
Saved target alone must not bypass a revoked Receiver's subsequent MOP checks.

The shepherd's Reflect.setPrototypeOf audit rejected a non-$Object receiver
explanation: direct preventExtensions markers already reify the original
receivers on `ce6631272`. The surviving seam is the empty **prototype operand**:
that head's `compileProtoArg` requires a nonempty literal; native canonicalizing
the unreified `{}` to null aliases the receiver's implicit Object.prototype
encoding and answers SameValue true before testing non-extensibility. The later
#6770 S4 commit `9173486` removes the nonempty condition and is present in
integrated `437636697` / upstream `3c6fcfc6`. Do not duplicate its source patch
or claim a current pass: rerun the unchanged original and neighbors on that
newer source when the census lease ends.

The switch lane reserved #6831 in
`/Users/thomas/.codex/worktrees/6831-annexb-switch-duplicates/js2`, branch
`codex/6831-annexb-switch-duplicates`, with its own pre-source plan. Its narrow
checker patch is explicitly unfinished. Deeper source review superseded the
optimistic assumption about existing lowering: CaseBlock name collection omits
functions, module-init Annex B globals start undefined and are assigned at
textual evaluation, and function-body hoisting visits each clause separately.
Neither path establishes cross-clause lexical last-wins before evaluation.
The own issue records `statements/shared.ts`, `declarations.ts`,
`annexb-global-live-binding.ts`, and `statements/nested-declarations.ts` seams.
Do not publish this checkpoint as a completed semantic fix or weaken the
before-declaration call / skipped-case controls.

#6828's attempted binary result-aware guard is also explicitly not accepted.
Root and worker source review found that `object-runtime-ordinary-set.ts`'s
ordinary receiver fallback invokes `__extern_set` and unconditionally returns
`i32.const 1`. An unadmitted foreign/closed store can therefore appear successful
without a real write. Converting that boolean to channel SUCCESS would hide
the old UNADMITTED state; resetting the channel cannot distinguish it from a
successful accessor whose call leaves the channel untouched. The writer is
removing that unsafe conversion and recording the dependency on a truthful
ordinary-set outcome contract. Keep real stored-value, accessor, unsupported
carrier, nested write, refusal, and revocation controls. Coordination of this
runtime file with the IR migration has been requested; no cross-owner edit or
runtime gain is claimed. Parser-entry coordination for `src/checker/index.ts`
has separately been requested for both grounded grammar residuals.

Latest live observation: session `74723` returned its live handle with 9,294
JSONL rows (9,003 pass, 274 fail, 17 compile errors) and twelve completed shards
3 through 14. Each observed completed receipt reported all callbacks settled.
The remaining shards and report are still running at pinned `ce6631272`; these
partial counts are not a final suite result or a measurement of current main.

Subsequent #6828 handoff: the worker withdrew **all** production/inventory
changes, including the new instruction leaf. Root observed no tracked source
diff; the fresh branch remains at exact `3c6fcfc6` with only its own untracked
blocked MD plan and future fixture. No completed fix or runtime improvement
exists in that lane yet. The handoff requires a truthful tri-state companion
to the ordinary-set receiver walk, single observable trap lookup, saved target
and handler ordering, and honest unsupported-carrier behavior; no boolean-to-
SUCCESS workaround is accepted. Preserve the new unannotated controls and
separate actual foreign-boundary verification from native closed-carrier probes.

#6831's unrun controls were corrected after source review: explicit standalone
target, zero imports, validated Wasm, `{}` instantiation, direct module-init
invocation, and genuine sloppy Script source. The intentional-init control now
uses maintained `extractWasmExceptionMessage(error, instance)` and requires the
exact `Error: issue-6831-init-observed` payload rather than String on an opaque
Wasm exception or an arbitrary throw. `hostBridge: "always"` is documented
only for native renderer exports, not a host provider. This is a designed
positive-control assertion, not an observed receipt. The checker source and
semantic controls remain unfinished pending coordinated lexical instantiation.

Session `74723` remains confirmed live. A later observation records 10,430
results: 10,095 pass, 314 fail, 21 compile errors, with shards 3 through 16
complete. Shards 1 and 2 remain uncompleted; no final report or full pass rate
is claimed. The census compiler/source head is still pinned to `ce6631272`.

The shepherd's distinct TypedArray `some` audit found a surviving source seam
at integrated `437636697` / `3c6fcfc6`, not merely an error-text bucket. In the
original `TypedArray/prototype/some/get-length-uses-internal-arraylength.js`,
the own length accessor is installed before the method call. Dynamic `new TA`
produces the native dynamic view; `some` is not in its materialization set and
routes through the generic HOF length path. That helper calls `__extern_length`,
whose dynamic-view arm consults the expando's OWN length accessor before the
internal bounds length. The descriptor MOP stores that accessor in the expando.
The existing `__hof_ta_some` distinction only bypasses HasProperty; it does
not supply internal ArrayLength. No later source delta examined repairs this
seam, but current-main runtime failure is still unmeasured. Require a distinct
TypedArray-method internal-length path while preserving observable
LengthOfArrayLike for `Array.prototype.some.call(view, callback)` and callback
receiver identity. Do not globally bypass own getters in `__extern_length`
or generic `__hof_some` based only on receiver representation. The final
selection/primitive owner map is being audited; existing coordination of
array-methods/object-runtime remains pending, and no source edit is dispatched.

Latest observation remains live at 10,909 results (10,564 pass, 323 fail,
22 compile errors), fourteen completion receipts. Rechecking both manifest
hashes and the worktree head confirmed the exact original scope and pinned
`ce6631272` source remain unchanged. This is not full completion or a current-
main pass rate.

### Completed frozen census and next implementation handoff — 2026-10-02

Session `74723` reached actual terminal exit 0. Run `20261002-144520` records
**11,392 pass, 361 fail, 25 compile errors / 11,778 original paths (96.7227%)**.
All sixteen v2 completion receipts pass the maintained completeness validator
against the original exact manifest: 11,778 registered callbacks, physical
rows and unique identities; zero missing, unexpected or duplicate identities;
zero proposal/official exclusions; all callbacks started and settled. There
are zero skip or compile-timeout verdicts. Every row has oracle version 14,
honest lane, semantic providers auto. This is not 100%: 386 nonpasses remain.

Measured source remains `ce6631272c1fdd999bc7b55a3cc6bfa77b3e48f8`, not latest
upstream. Original and runner snapshot manifest SHA-256 both remain
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
Compiler/runtime bundle and QuickJS adapter hashes remain exactly those pinned
for this run; no compiler or provider mutation occurred during the census.

Durable artifacts relative to this census worktree:

- `benchmarks/results/test262-standalone-results-20261002-144520.jsonl`, SHA-256
  `a97cbc114aee0c8743701e276e1894f4c09b975065a53a10935bfc6507f0b224`.
- `.tmp/es2015-frozen-full-current-main-run.log`, SHA-256
  `965f07107b25225224820359471046311a0dba4085e3cf1b18e60b7897cc56b6`.
- `benchmarks/results/test262-standalone-report-20261002-144520.json` and all
  sixteen matching `shard-<n>-of-16.complete.json` receipts.

Root independently checked the receipts, original identity set, row statuses,
snake-case provenance fields and report summary. The wrapper's rounded 96.7%
is consistent with the exact count; its successful exit proves completion of
measurement, not conformance success. No historical index was published.

The typed-HOF source audit is now complete and #6832 has been atomically claimed.
Its isolated worktree is `/Users/thomas/.codex/worktrees/typedarray-some-internal-length/js2`,
branch `codex/6832-typedarray-some-internal-length`, at `3c6fcfc6`. Its required
plan is the [published #6832 record carried by PR #6447](https://github.com/loopdive/js2/pull/6447)
in PR #6447, not a file already landed on this branch. Ownership is
`hof-native.ts`, the narrowly necessary typed-array finalizer, and a pure
instruction leaf if needed. The correct existing primitive is
`pushTaDynViewInBoundsLen`, not the byteLength-oriented effective-length emitter.
Mint a typed-only `some` clone even without a presence gate and rewire only
direct dispatch; preserve generic Array borrowed-method observable length,
detached checks and original callback receiver. No array-methods/object-runtime
or held IR changes are needed. The prior paragraph's pending owner-map/no-
dispatch statement is superseded. Source implementation is underway; build,
baseline/candidate verification and publication remain unperformed.

Root's separate CI branch now includes fresh upstream main
`ff310447e51b6443c5a3c34c62bd80f38c64269e` in merge commit
`deff58b34a8d47d3d69d52e9794eefe65343e73a`. Normal fast hooks passed, worktree is
clean, and this merge is not pushed. The upstream delta is npm compatibility
reports only. It does not change or retroactively upgrade the census source.
The single heavy-test lease is released from the completed census; #6832 must
submit its precise validation recipe before receiving the next serialized lease.

### Fresh targeted baseline and attribution corrections

#6832's source-only reader map proves that five direct TypedArray consumers
share the same generic-length prologue: `forEach`, `every`, `some`, `reduce`,
and `reduceRight`. The implementation plan was widened before source edits to
repair those five typed-only clones, retaining generic Array borrowed-call
LengthOfArrayLike and HasProperty semantics. `find`/`findIndex`, `join`, and
`toLocaleString` have separate owners and are not attributed to this HOF seam.

The granted serialized baseline lease produced run `20261002-173012` at clean
production source `3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8` in the #6832
worktree. The maintained Vitest wrapper measured **3 pass / 8 registered**:
all five unchanged original HOF internal-length rows fail; Math.sign.length
and both original Intl poison-constructor controls pass. Root independently
validated all eight JSONL identities against the timestamped exact manifest
and one v2 completion receipt: no missing/duplicate/unexpected identities,
zero exclusions/skips, oracle 14 / honest / auto. Log confirms a freshly
built, executable-canary-verified QuickJS adapter `87f1918eeaa0cdd5`.
This is a current-main targeted baseline, not a new full-suite pass rate.
Production source remains unmodified. Next is the complete frozen-manifest
intersection of these five method families, matched candidate identities,
and host-free borrowed-method/short-circuit/detach controls before publication.

A separate read-only audit of `Array/from/source-array-boundary.js` confirms
the mapper receives the boundary number correctly: the missing expected value
is `array[this.arrayIndex]`. The canonical script global object and the module
global `var arrayIndex` are not synchronized through dynamically supplied
callback receivers; its increment reaches generic property operations instead
of the same live module binding. #6771 already attributes this row to #2727,
whose recorded scope is stale. Do not change Array.from numeric boxing or
iterator retrieval for it. A coherent future fix needs a runtime canonical-
global identity guard and coordinated read/write/RMW consumers, including
`helpers/sloppy-this-global.ts` and `expressions/unary-updates.ts`; the held
IR/property/global-binding owners remain untouched. This is source evidence,
not a newly measured pass or an implemented fix.

PR #6436's fresh head is `c5aaa8ca0b4959c11a2b4e8f2d333edca8429c82`, a bot
merge of main into `2d425bb8`, not a separate implementation change. Its
top-level Intl kernel still triggers the concrete flat-directory budget
failure. The dedicated shepherd stopped before mutation because #6809's
authoritative claim remains owned by `ttraenkler/codex-intl-locale-parser`.
The user has been asked whether to retain or transfer that claim. Preserve
the clean newly created detached repair worktree; do not steal the claim,
alter the allowance, or report the PR merge-ready before fixing the gate.

### Complete five-family baseline — source attribution is not a verdict

Run `20261002-173315` reached actual terminal exit 0 at unchanged `3c6fcfc6`.
Root independently validated all **128 registered/verdict identities**, one
settled v2 receipt, oracle 14/honest/auto, zero exclusions/skips/timeouts,
and the original-manifest intersection: all 120 original rows in the five
TypedArray HOF families are present, no family row is missing, and no selected
identity is outside the frozen 11,778 scope. Result: **121 pass / 7 fail**.
The HOF-family subtotal is **115 pass / 5 fail**; all three instrument canaries
pass. The candidate must retain these exact 128 identities and preserve the
115 passing HOF neighbours, rather than measuring only the five known failures.
Both required baseline batches are complete; #6832 may now implement its
owned HOF change under the existing serialized validation lease.

Three separately attributed later-main control rows now pass:
`Proxy/ownKeys/trap-is-missing-target-is-proxy.js`,
`Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js`, and
`Array/length/define-own-prop-length-no-value-order.js`. These are actual
targeted current-main results, not #6832 gains or a projected suite total.

Two Proxy controls still fail. `return-not-list-object-throws-realm.js` still
does not throw the required TypeError. Critically,
`call-parameters-object-getownpropertysymbols.js` now fails with
`TypeError: Proxy ownKeys trap result must be an object`, whereas the pinned
`ce663` census stopped at a Symbol SameValue assertion. The original valid trap
returns `Object.getOwnPropertySymbols(target)`. Thus the earlier source-only
assertion that the landed raw-ownKeys work repaired this entire row is not
runtime proof and is superseded by this fresh failure. Do not chase the stale
Symbol signature, weaken the valid-list guard, or edit already-correct public
key filtering blindly. A separate source audit is tracing the current trap
return/admission boundary; no Proxy fix or pass gain is claimed yet.

Likewise, #6771 attributes the remaining Array length coercion-order row to
the script-global `var length` binding merging with lib.dom's Window.length
type, not to its already-implemented two-conversion ArraySetLength emitter.
The global/checker ownership remains coordinated separately; do not patch
the ArraySetLength leaf based only on the census error text.

### First matched candidate evidence — five original failures repaired

#6832's matched eight-row candidate `20261002-174748` reached terminal exit 0.
Root independently validated its v2 completion receipt, exact same eight
baseline identities, oracle 14/honest/auto, and zero exclusions, skips, compile
errors, duplicates, missing or unexpected verdicts. **8/8 pass**: the five
original direct TypedArray HOF internal-length failures change fail → pass;
all three instrument controls remain pass. This is a measured five-row gain,
not a projection of the full suite and not yet a completed publication.

Candidate provenance at this measurement:

- `src/codegen/hof-native.ts` SHA-256:
  `6108ee834a5a0e81a84cad0d79a69a58f904024864db5a321753fd3191ab76a5`.
- Compiler bundle SHA-256:
  `09f24694ab0492755aeb12d8ea201c3457a306f9de0282c13222575de2b8c8f0`.
- Runtime bundle SHA-256:
  `6a14426ff68d512c7e5b115c52f0f07160e6b43f1ecd069576b22408bd765c69`.
- Executable-canary-verified QuickJS adapter `0da63c362a8b7a3a` SHA-256:
  `89819371db428c4b757d55eaad1815f79a1e51eeae894806289581a656d33c1f`.
- Candidate JSONL SHA-256:
  `d22d62915f3bdf89b87e3331328bfca5aafb9ed187e2d8666c959db2e8a21293`.

The worker reports 19/19 focused host-free fixture cases passing after two
harness-only construction errors were corrected (statement-body interpolation
and the WebAssembly Instance overload). Those earlier harness failures are
not conformance verdicts. A durable combined fixture/regression-gate receipt
is still required. Matched 128-row candidate `20261002-174850` is confirmed
live in the worker's session `71398`; keep that exact process until terminal.
Root cannot observe agent-owned PTYs directly and does not treat that namespace
limitation as termination. Final acceptance requires all 121 baseline-passing
rows preserved, the five intended gains, both unrelated Proxy failures honestly
retained, normal source/push gates, and an upstream ready PR for the finished
fix. Do not publish a completed-fix claim or extrapolate a 100% suite result
from the eight-row instrument set.

### Completed matched family validation and published fix — #6832

The preceding live-process handoff is superseded: candidate run
`20261002-174850` completed. Root independently checked all 128 identities
against baseline `20261002-173315`, the frozen manifest, and the settled v2
receipt. Result: **126 pass / 2 fail**, versus **121 pass / 7 fail**.
Exactly five intended TypedArray HOF failures changed fail → pass; all 121
baseline passes were preserved, with zero pass → fail changes, compile errors,
skips, exclusions, missing identities, or duplicate verdicts. All 120 original
five-family rows pass. Both unrelated Proxy failures retain their baseline
error strings. Oracle 14/honest/auto and the original denominator are unchanged.

The source hash recorded above remained identical through publication.
Candidate 128-row JSONL SHA-256 is
`ca32fff58d10cb7b6e124963bd535c9ea33d0852097953ae760d20bf91970509`;
selected manifest SHA-256 is
`068d33154affd2d050b8bd4909da25f62587699e16646991a137e82ed1b1bcaf`.
Artifacts remain in the isolated `typedarray-some-internal-length/js2`
worktree under `benchmarks/results` and `.tmp/6832`; do not delete them.
The durable scoped regression log proves **4 files / 39 tests passed**,
including all 19 new host-free cases and the existing detach, dynamic reducer,
and borrowed Array-method controls. Source gates and normal commit/push hooks
passed. The heavy validation lease was explicitly returned to root.

Published completed fix: [upstream PR #6447](https://github.com/loopdive/js2/pull/6447),
non-draft, commit `94d8361a6b2ab0a2ea769ce8c3971367048c9b03` on
`codex/6832-typedarray-some-internal-length`. Owned files are only
`src/codegen/hof-native.ts`, the #6832 Markdown issue, and its regression test.
The dedicated shepherd's fresh audit verified matching fork/PR heads,
mergeability, no queue entry, no review threads, no failed checks, and two
still-running checks. Pending CI is not a completed readiness claim.

This proves a scoped five-row gain, **not** an updated full-suite percentage
or completion of this goal. The last complete 11,778-row census remains the
pinned `ce663127` measurement above. A later complete authoritative run is
required to establish the current whole-suite count and eventually zero
failures. Preserve all original paths, including Intl and dynamic-code rows.
## 2026-10-02 — #6770: `built-ins/Object/**` + `built-ins/Reflect/**` residue (pointer)

The 49 standalone non-pass rows of `built-ins/Object/**` + `built-ins/Reflect/**`
(2026-09-30 census) are #6770's. Measured on `issue-6770-object-reflect-residue`
with `origin/main` merged: **0 → 44 pass** across eight mechanisms —
`Object.assign` ToObject on primitive operands, literals written through a
reflective builtin becoming open `$Object`s, own-key order (index domain,
String/RegExp/function intrinsics), the Reflect residue, `Object.prototype`
members (`__proto__` own-ness, `toLocaleString` Invoke), `Object.prototype.toString`
tag order, Proxy `[[OwnPropertyKeys]]` surfaces, and per-operation trap lookup
(`GetMethod` on every §10.5 internal method; the eager 13-trap snapshot at
`new Proxy` is gone). Remaining: three `Object.prototype.toString` tag rows
(Symbol carrier consult, symbol-keyed writes on wrapper prototypes,
`%GeneratorFunction%` tag) and the two #3371 `Reflect.construct` CEs —
mechanisms in #6770's record.

### Remaining Proxy realm control — constructor admission, not list validation

Read-only audit at `ff310447` (relevant source unchanged since `3c6fcfc6`)
attributes `Proxy/ownKeys/return-not-list-object-throws-realm.js` to direct
`new other.Proxy(...)` admission. The original uses
`other = $262.createRealm().global`, an undefined-returning ownKeys trap, and
expects the current realm's TypeError from `Object.keys(p)`. Existing
`tracesToProxyConstructorValue` already recognizes this direct member shape,
but `expressions/new-super.ts` restricts the proven constructor-value path to
identifier callees. No actual Proxy reaches the correct list validator.

Future implementation plan: reuse the existing proven Proxy-constructor
predicate for member callees in both outer construction admission and inner
`tryCompileNativeConstructFromValue` flag/admission logic, retaining the
existing target/handler open-literal conversion and native driver. Do not
widen arbitrary member constructors or alter the validator, realm harness,
native driver, provenance storage, IR, or public key filters. Add host-free
direct-member construction/trap controls and the exact original realm-error
case; measure matched baseline/candidate original rows before claiming gains.
The older #5196 repair covers identifier aliases only; completed #4685
explicitly excludes this cross-realm constructor row. No fix or new pass is
claimed. Source-owner clearance and explicit registry-allocation approval
remain pending before assigning a new issue and implementing this slice.

### 2026-10-02 — full frozen-scope verification after landed #6832

Implementation/measurement plan before execution: use the isolated managed
`6651-current-main-full-verification/js2` checkout on
`codex/6651-current-main-full-verification`, pinned production source
`cd123eca318c12a8480e8a69383ddfd50d6e4db4`. This is verified upstream main
after the completed five-HOF fix PR #6447 merged. The previously published
handoff PR #6449 is queued; its branch must remain unchanged. This dedicated
measurement branch does not replace, rewrite, or push that queued head.

1. Retain exactly the original 11,778 paths and manifest SHA-256
   `632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
   Revalidate selected corpus blob bytes against its pinned Git revision.
2. Rebuild current compiler/runtime bundles; verify the immutable QuickJS
   artifact and a current-source adapter with actual executable canaries.
   Measure Math.sign.length and the two original Intl constructor-poison
   controls first, requiring three registered and settled verdicts with no
   exclusions/skips before proceeding to the complete population.
3. Run the maintained `scripts/run-test262-vitest.sh`, standalone/auto,
   QuickJS, oracle honest, one compiler-pool worker and one bounded 4 GiB
   Vitest fork, using all 16 maintained local shards and only the exact frozen
   manifest. No path filters, scope exclusions, corpus rewrites, refusal
   substitutes, or partial historical-index publication are permitted.
4. Keep durable worktree-local launch log, timestamped JSONL/report, exact
   manifest snapshot, and all 16 v2 completion receipts. Freeze production
   source and HEAD while the run is live; retain the same process across chat
   continuations and do not restart because an observation times out.
5. Independently verify 11,778 unique original identities, all callback and
   receipt counts, no missing/unexpected/duplicate rows, zero skips/exclusions,
   manifest integrity, and actual fail/compile-error counts. Compare rows with
   the completed `ce663127` census only after both complete scopes are proven.
   A wrapper exit zero establishes measurement completion, not 100% conformance.

The latest complete count is still the older pinned 11,392 pass / 361 fail /
25 compile errors measurement, not a current-main forecast. A fresh separate
seven-original diagnostic at published fix source `94d8361` confirmed four
remaining find/findIndex/join/toLocaleString failures and three passing controls;
they must not be credited to the landed five-HOF fix. The next source slices
and their owner clearances remain separate from this full-scope measurement.

Current-source preflight completed: all 11,778 selected corpus blob hashes
match revision `b363f29d3c43c626dc852744ad64a0b48a003693`, with no mismatches.
Control run `20261002-184739` is terminal exit zero: **3 pass / 3 originals**,
with independently checked exact identity equality, v2 receipt counts,
all callbacks settled, oracle 14/honest/auto, and zero exclusions/skips.
JSONL SHA-256:
`48ade486aedfe9ec9f61057f6c429e51e7d4d4854f3441f05d07536d34a2718d`.
Compiler SHA-256:
`09f24694ab0492755aeb12d8ea201c3457a306f9de0282c13222575de2b8c8f0`;
runtime SHA-256:
`6a14426ff68d512c7e5b115c52f0f07160e6b43f1ecd069576b22408bd765c69`.
Fresh QuickJS adapter `79ee37c474567749` was built and executable-canary-
verified, 587,273 bytes, SHA-256
`89819371db428c4b757d55eaad1815f79a1e51eeae894806289581a656d33c1f`.
These controls validate the instrument only; the full measurement is next.

Full original-scope run is now live: **`20261002-184918`**, root-owned
execution session **33800**, wrapper PID **39572**. The maintained wrapper
validated and snapshotted all 11,778 original identities with the same frozen
SHA-256, rebuilt the pinned `cd123eca31` source bundles, and verified the
linked QuickJS artifact/adapter pair. Its cache HIT is not a new canary run;
actual fresh executable canaries are recorded in control run `184739` above.
Exactly 16 maintained shard entries are selected; first registered shard is
5/16 with 736 originals and one compiler-pool worker.

- Durable launch log: `.tmp/es2015-current-main-full-run.log`.
- JSONL: `benchmarks/results/test262-standalone-results-20261002-184918.jsonl`.
- Snapshot: `benchmarks/results/test262-standalone-exact-manifest-20261002-184918.txt`.
- Completion requires all 16 matching `.shard-<1..16>-of-16.complete.json`
  receipts and the independent original-identity audit, not partial row totals.

Keep this same process through actual terminal completion; observation expiry
does not authorize a restart. Root retains the heavy build/test lease. No
source or HEAD changes, merges, pushes, cleanup, dependency installs, or other
heavy runs in this measurement checkout while live. Other isolated agents may
perform read-only source audits; required new-issue allocation and exact
IR-migration source-area permissions remain pending. Do not modify queued
PR #6449's branch or project a completed suite count from arriving rows.

### Read-only next-slice plan — direct TypedArray find/findIndex

Terra's source audit at `cd123eca` identifies a bounded prospective repair:
add exactly `find` and `findIndex` to `TA_INTERNAL_LENGTH_HOF_METHODS` in
`src/codegen/hof-native.ts`. Both already belong to `NATIVE_HOF_METHODS`,
use `(recv, cb, thisArg)` with loop length local 3, and have the one guarded
`local.get 0 → __extern_length → local.set 3` template recognized by the
landed finalizer. They are not presence-sensitive, so the existing length-only
clone path is necessary and already admits zero HasProperty sites.

The existing finalizer runs after direct method dispatch is materialized,
deep-copies body and locals, rebuilds the three-parameter context, appends
fresh dynamic-view scratch locals, and emits `pushTaDynViewInBoundsLen`.
It rewires only matching direct `__call_m_find_*`/`findIndex_*` calls. The
non-dynamic-view branch, generic Array-prototype borrowed helpers, entry
detachment guard, and all generic `__extern_length` behavior remain unchanged.
No dispatcher, IR, import, registration, or Array-method edit is indicated.
Do not silently include the separate reflective TypedArray-prototype `.call`
path. The guarded clone can still decline a different emitted shape; only
runtime measurements can establish gains.

Required implementation sequence after explicit assignment-registry approval:
allocate/claim a separate Markdown issue and isolated implementation worktree;
copy this plan before source edits; measure all **40 original family paths**
(20 find + 20 findIndex) through the maintained runner before and after the
two-name change, with instrument controls identified separately. Do not add
findLast/findLastIndex or other later-edition paths to the denominator.
Fixtures must prove direct dynamic own/prototype getters are ignored, borrowed
Array calls still observe the getter, generic arrays unchanged, callback
receiver/short-circuit order, mutation/live reads, detachment, and resizable/
out-of-bounds length behavior. Run scoped gates and publish one completed-fix
upstream PR only after matched gains and preservation are actually verified.

This is a read-only plan, not an allocation, source edit, or measured repair.
Do not change the finished #6832 scope or borrow another owner's claim to
bypass the pending registry approval. The full census retains the heavy lease.

### First completed current-main shard — no whole-suite extrapolation

While session 33800 remains live, shard **5/16** has a durable v2 receipt:
**721 pass / 13 fail / 2 compile errors / 736 originals**. Root independently
checked 736 unique registered/verdict identities within the frozen manifest,
equal registered/started/settled/recorded/canonical counts, all callbacks
settled, oracle 14/honest/auto, and zero skips or exclusions.

The old complete `20261002-144520` JSONL still has verified SHA-256
`a97cbc114aee0c8743701e276e1894f4c09b975065a53a10935bfc6507f0b224`.
Comparing these **same 736 original identities** gives old 715 pass / 19 fail /
2 compile errors versus current 721 pass / 13 fail / 2 compile errors:
six fail → pass changes and zero pass → nonpass changes. The changed rows are
TypedArrayConstructors `ctors/no-species.js`, Object.prototype.isPrototypeOf
`arg-is-proxy.js`, Object.keys `proxy-non-enumerable-prop-invariant-3.js`,
Object.entries `symbols-omitted.js`, Object.assign `Override-notstringtarget.js`,
and Object.getOwnPropertySymbols
`proxy-invariant-not-extensible-absent-string-key.js`.

These are measured later-main gains, not all attributed to #6832 and not a
prediction of the total gain across 11,778. The remaining 15 shards and final
whole-population completeness and row audit are still required. Do not restart
the live process or merge a partial subset with another run timestamp.

### Fresh dynamic-call attribution — eval shadowing precedes tail-call proof

The current run observes `language/expressions/call/tco-non-eval-function-dynamic.js`
failing with Expected SameValue(0, 1). Read-only attribution at `cd123eca`
shows a pre-tail-call dispatch defect: outer sloppy direct eval creates an
activation-local `eval = f` binding, but the inner strict function's bare
`eval(n - 1)` is classified as the intrinsic through ambient checker resolution.
Intrinsic eval of a number returns it unchanged instead of recursively calling
the shadowing function, leaving the expected call counter at zero.

This is **not a calls-only repair**. Hoisting compiles the nested function
before the later outer eval statement; syntactic direct-eval detection marks
the child as owning direct eval. `nested-declarations.ts` then excludes it
from enclosing-state capture through its `!reachesDirectEval` policy. A fresh
child-local pool cannot see the outer eval-created binding. The existing
identifier value-cell present/miss protocol is useful machinery, but it does
not by itself supply the missing enclosing/layered activation lookup.

Future coordinated plan: preserve true outer direct eval on a state miss;
establish correct enclosing/own environment lookup for potentially shadowed
direct-eval callees; route a present binding as an ordinary bare dynamic call
and retain intrinsic direct-eval behavior on a miss. Enumerate nested capture,
own-state mutation, closure, identifier, and call readers before changing the
environment policy. Static rejection of every potentially shadowed eval would
break the original outer direct eval and is not a substitute.

Existing #6774 S14 records this row and separately the real dynamic tail chain.
After shadowing/capture is correct, deep proper-tail behavior still requires
its own proof; do not promise this original passes from a dispatch fix alone.
Held calls/identifier/declaration/closure and IR ownership must be coordinated.
No source mutation, new issue/claim, runtime emission probe, or pass gain is
claimed by this attribution; the full census continues unchanged.

### Second settled shard — matched original-row evidence

Shard **3/16** independently audited: **715 pass / 21 fail / 1 compile error /
737 originals**, settled v2 receipt, exact registered/verdict identity equality,
all callbacks settled, oracle 14/honest/auto, zero skips/exclusions. Against the
same 737 originals in the old complete hashed census: **712 pass / 24 fail /
1 compile error**. Three fail → pass changes, zero pass → nonpass changes:
Object.getOwnPropertyNames `proxy-invariant-not-extensible-absent-symbol-key.js`,
Object.prototype.toString `symbol-tag-weakmap-builtin.js`, and
Reflect.setPrototypeOf `return-false-if-target-is-not-extensible.js`.

The two completed receipt identity sets (shards 5 and 3) are disjoint.
Combined measured subtotal: **1,436 pass / 34 fail / 3 compile errors /
1,473 originals**, versus old same-row **1,427 pass / 43 fail / 3 compile errors**.
Nine total fail → pass changes and no pass → nonpass changes in this completed
subset. This is not the whole-suite total or a projection; the same live
session 33800 must finish all remaining 14 shards and the final population
audit before an updated 11,778-row count can be reported.

Final source audit refines the #6774 S14 handoff above: that existing record
is in progress and still marks all three S14 rows failing. Preserve separate
child-own and enclosing eval activation pools; the single current
`FunctionContext.directEvalActivationStatePoolLocal` cannot represent both
without changing VarEnv semantics. Propagate and snapshot layered state
through `context/types.ts`, `context/locals.ts`, `nested-declarations.ts`, and
`closures.ts`; audit `inline-iife-scope.ts` rollback if that new state crosses
its boundary. `eval-inline.ts` must expose the late outer static-eval binding;
`direct-eval-environment.ts`, `global-environment.ts`, and `expressions/calls.ts`
are the lookup/dispatch seams. This is coordinated shared state, not a
one-site checker bypass or reuse of the child's own pool.

Tail stage is also concrete: outlined `__dyn_call_N` plus its `call_ref`
retains frames. Caller-to-helper tail lowering alone is insufficient, and
the current void-caller/externref-helper result mismatch must be respected.
Any compatible tail-specialized helper must preserve #822 parameter/stack,
#839 result, and #1972 try-handler guards. Prove short-depth eval-binding
liveness, true direct eval on cell miss, shadowed ordinary call on presence,
strict/sloppy scoping, arguments/receiver and order first; then prove the
original 100,000-depth case and dynamic-alias neighbours.

The exact nested function is on the legacy AST route (the IR selector admits
top-level FunctionDeclarations, not this nested FunctionExpression shape).
IR edits are not required for this exact row, but the shared context/capture
areas remain reserved alongside the other machine's migration until cleared.
The existing #6774 fixture has no S14 probe and uses a strict module harness;
future acceptance needs a dedicated sloppy Script/standalone fixture, not
module-vacuous success. No runtime gain or completion is inferred from these
source findings, and no active owner has been displaced.

### Third settled shard and requested upstream merge

The same live full run `20261002-184918`, session 33800, has completed shard
12/16: **717 pass / 19 fail / 1 compile error / 737 originals**. Its v2
receipt has 737 registered, started, settled, recorded, and canonical rows.
Against the immutable ce663127 baseline, two rows changed fail to pass:
`Object/getOwnPropertySymbols/proxy-invariant-not-extensible-extra-string-key.js`
and `Object/seal/proxy-with-defineProperty-handler.js`. No prior pass changed
to nonpass in this shard. Together with shards 3 and 5, the settled subset is
**2,153 pass / 53 fail / 4 compile errors / 2,210 originals**, with 11
fail-to-pass changes and zero pass-to-nonpass changes. These are subset
observations, not a projection of the complete suite.

The live-row inspection found 2,344 unique original-scope rows, all using
oracle 14, honest lane, automatic semantic providers, and no skip verdicts.
The frozen manifest and previous JSONL hashes were revalidated unchanged.
The run remains active; do not restart it or treat partial receipts as final.

At the user's request, upstream main was fetched to
`489d0aacd45b5eb7b11cb06ef4c613a719c20f18`. This includes compiler and shared
context changes, not only documentation. Merge it into this branch after
the current measurement terminates and its cd123eca source provenance is
audited. Do not change the source or HEAD mid-run. Preserve the unrelated
dirty primary checkout and this worktree's pending issue handoff edits.

Read-only revalidation against fetched `489d0aacd4` found that the new class
changes do not resolve the #6774 S14 dynamic-call defect. `calls.ts` changes
class constructor/super handling only; eval classification (line 3739),
intrinsic selection (7881), and the outlined dynamic helper (4567/5129)
retain the diagnosed behavior. `nested-declarations.ts` still rejects
capturing the enclosing eval state when the child reaches direct eval
(1331/1339), and `closures.ts` retains its equivalent gate (3569/3578).
The single-pool allocation in `direct-eval-environment.ts` (457-464),
`eval-inline.ts`, and the context snapshot locals are unchanged. Class
return-override and method-key changes do not repair the tail chain.
These are source findings, not an execution result on the new main; the
layered capture, present/miss call dispatch, and proper-tail-call stages
remain required and subject to shared-source coordination.

### Fourth settled shard: same pinned full run

Shard 8/16 completed in run `20261002-184918`: **718 pass / 15 fail / 2
compile errors / 735 originals**, versus the old matched **717 / 16 / 2**.
Only `test/built-ins/Object/keys/property-traps-order-with-proxied-array.js`
changed verdict (fail to pass). No old pass changed to nonpass in this shard.

The maintained completeness validator now accepts the exact four-receipt
subset (shards 3, 5, 8, 12): **2,945 registered / started / settled /
canonical unique verdicts**, no missing or unexpected identities, duplicates,
or exclusions. Aggregate **2,871 pass / 68 fail / 6 compile errors**, versus
matched old **2,859 / 80 / 6**: 12 fail-to-pass changes, zero pass-to-nonpass.
All observed rows retain oracle 14 / honest / auto and no skips; frozen
manifest and immutable old JSONL hashes were checked again. HEAD remains
`cd123eca318c12a8480e8a69383ddfd50d6e4db4` and session 33800 remains live.
No whole-suite result is available; complete all 16 receipts before final
audit, upstream merge, publication, or test-lease release.

### Module self-import host-leak source investigation (not a fix)

Current exact rows `language/module-code/eval-export-dflt-expr-gen-named.js`,
`instn-named-bndng-dflt-gen-named.js`, and
`instn-named-bndng-dflt-gen-anon.js` remain compile errors with `env::g`.
Each original module statically imports its own default binding as `g`.
The source audit identifies a shared graph-activation gap: the maintained
fixture collector recognizes `_FIXTURE.js` dependencies, attaches no graph
for these self-import entries, and the worker selects `compileMulti` only
when `fixtureFiles` is nonempty. The single-source import preprocessor then
creates an unresolved `declare function g` stub, producing the host import.
The standalone #2961 rejection is correct and must not be suppressed.

Prospective plan: represent a resolved self-import dependency as a module
graph even when it has no separate fixture file, preserve the entry module's
identity, and route it through existing multi-source relative resolution
and default-binding alias registration. Do not rewrite originals or fake
the imported function. The resolver/alias behavior is source evidence only;
named and anonymous default-generator execution, same-instance identity,
cycle initialization, and existing fixture controls require real acceptance
tests after the heavy run ends. The relevant fixture graph, worker, import
preprocessor, and alias registration are unchanged in fetched 489d; no
runtime gain is established. The auditor is finishing exact ownership and
activation-boundary checks. No source edits, fresh issue allocation, claims,
or validation runs were authorized or performed for this new slice.

### Fifth settled shard: original-row matched comparison

The same pinned full run completed shard 7/16: **713 pass / 24 fail / 0
compile errors / 737 originals**, versus old **708 / 29 / 0**. Five original
rows changed fail to pass: Object/entries/observable-operations.js,
Object/assign/Target-Boolean.js,
Object/getOwnPropertySymbols/proxy-invariant-duplicate-string-entry.js,
Object/prototype/toString/get-symbol-tag-err.js, and
Object/entries/order-after-define-property-with-function.js (all under
`test/built-ins/`). No old pass became nonpass in this shard.

The maintained validator accepts the five settled receipts (3, 5, 7, 8, 12)
with **3,682 registered / canonical unique verdicts**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **3,584 pass /
92 fail / 6 compile errors**, versus matched old **3,567 / 109 / 6**:
17 fail-to-pass changes and zero pass-to-nonpass changes. Oracle 14 / honest /
auto, no skip rows, frozen manifest hash, and immutable old JSONL hash were
revalidated. Session 33800 continues on cd123eca; this remains a completed
subset rather than the final 11,778-row result.

Final module audit bounds the future graph-activation slice: add an explicit
`requiresEntrySelfImportGraph` flag for static top-level default/named value
imports canonically resolving to the original entry, with no unrepresented
non-fixture relative edge. Namespace self-imports, dynamic imports,
side-effect-only imports, and export-from require their own module semantics;
do not accidentally admit them with a text regex. Keep `fixtureFiles` empty
for entry-only graphs: adding the entry as a fixture trips the existing
worker collision guard and changes module identity.

Route that flag through fixture discovery, maintained original selection
in `tests/test262-shared.ts`, the FYI reader/launcher transport, and worker
compile selection. Reuse literal `compileMulti` with the existing original
harness and defer/init options; validate entry path and entry absence from
the fixture map. No compiler/codegen/IR edits are indicated for this immediate
host-leak cause. Existing #2864 is in progress and #5157 in review for the
distinct generator layer; resolving the import is not evidence those
semantics pass. Coordinate with those owners rather than editing their
generator lowering.

Acceptance must include the three unmodified original rows plus #3491
fixture/circular/literal-assembly controls, #2930 default/anonymous aliases,
and #2900 deferred-init/single-module-init controls. Discovery must reject
lookalike comments/templates, dynamic/namespace forms, and unresolved
nonself edges rather than silently routing them to an incorrect graph.
New-issue allocation approval and actual execution are still pending. No
new runtime gain, completed fix, or dedicated repair PR is claimed.

### Sixth settled shard: full run remains live

Shard 2/16 of `20261002-184918` completed with **716 pass / 18 fail / 2
compile errors / 736 originals**, versus matched old **713 / 21 / 2**.
Three fail-to-pass changes: the RegExp subclass `lastIndex.js` original,
`Reflect/ownKeys/order-after-define-property.js`, and
`Object/assign/ObjectOverride-sameproperty.js`. No prior pass changed to
nonpass. These are measured source-cd123eca changes, not attributed to any
unmerged upstream repair.

The maintained completeness validator proves the six settled receipts
(2, 3, 5, 7, 8, 12) account for **4,418 original identities**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **4,300 pass /
110 fail / 8 compile errors**, versus matched old **4,280 / 130 / 8**:
20 gains and zero pass-to-nonpass regressions in this subset. Oracle 14 /
honest / auto, no skip verdicts, frozen manifest hash and old JSONL hash
were revalidated. HEAD cd123eca is unchanged; session 33800 continues.
The final full-suite result and requested upstream merge remain pending.

### Seventh settled shard: no verdict changes

Shard 16/16 completed in the same pinned run: **712 pass / 23 fail / 1
compile error / 736 originals**, identical by every original row to the old
ce663127 census. No changes or gains are assigned to this shard.

The maintained completeness validator accepts the seven completed receipts
(2, 3, 5, 7, 8, 12, 16): **5,154 registered / canonical unique verdicts**,
zero missing, unexpected, duplicate, or excluded identities. Aggregate
**5,012 pass / 133 fail / 9 compile errors**, versus matched old
**4,992 / 153 / 9**: 20 gains and zero pass-to-nonpass changes. All observed
rows remain oracle 14 / honest / auto with no skips; frozen manifest and
old JSONL hashes revalidated. HEAD cd123eca and live session 33800 are
unchanged. This is still a subset, not the final 11,778-original result.

### Eighth settled shard: halfway by receipts, not complete evidence

Shard 14/16 of the same run completed with **719 pass / 17 fail / 0 compile
errors / 736 originals**, versus old **717 / 19 / 0**. Two fail-to-pass
changes: `Object/keys/order-after-define-property-with-function.js` and
`Object/prototype/toString/proxy-revoked-during-get-call.js` under
`test/built-ins/`. No previous pass changed to nonpass.

The maintained validator proves all eight settled receipts (2, 3, 5, 7, 8,
12, 14, 16) account for **5,890 registered / canonical unique identities**,
with no missing, unexpected, duplicate, or excluded identities. Aggregate
**5,731 pass / 150 fail / 9 compile errors**, versus matched old
**5,709 / 172 / 9**: 22 gains and zero pass-to-nonpass changes. Frozen scope
and old JSONL hashes revalidated; all observed rows remain oracle 14 /
honest / auto without skips. HEAD cd123eca is unchanged, session 33800 is
still live, and none of this subset is projected onto the remaining scope.

### Ninth settled shard: five more original verdict gains

Shard 9/16 completed in the same run: **722 pass / 12 fail / 2 compile
errors / 736 originals**, versus matched old **717 / 17 / 2**. Fail-to-pass
rows under `test/built-ins/`: Object/keys/proxy-keys.js,
Object/prototype/toString/symbol-tag-promise-builtin.js,
Object/getOwnPropertySymbols/proxy-invariant-absent-not-configurable-string-key.js,
Object/getOwnPropertyNames/proxy-invariant-absent-not-configurable-symbol-key.js,
and Reflect/set/set-value-on-data-descriptor.js. No old pass changed to nonpass.

The maintained completeness validator accepts all nine settled receipts
(2, 3, 5, 7, 8, 9, 12, 14, 16): **6,626 registered / canonical unique
identities**, zero missing, unexpected, duplicate, or excluded identities.
Aggregate **6,453 pass / 162 fail / 11 compile errors**, versus matched old
**6,426 / 189 / 11**: 27 gains and zero pass-to-nonpass changes. Oracle 14 /
honest / auto and no skips are preserved; frozen manifest and immutable old
JSONL hashes checked again. Source HEAD cd123eca and live session 33800 are
unchanged. Seven remaining receipts and the final full-scope audit are still
required before treating this run as a complete measurement.

### Tenth settled shard and refreshed upstream merge target

Shard 6/16 completed in run 20261002-184918: **712 pass / 22 fail /
2 compile errors / 736 originals**, versus matched old **705 / 29 / 2**.
The seven fail-to-pass originals under `test/built-ins/` are:
TypedArray/prototype/reduceRight/get-length-uses-internal-arraylength.js,
Proxy/ownKeys/trap-is-missing-target-is-proxy.js,
Reflect/defineProperty/return-boolean.js,
Object/freeze/proxy-with-defineProperty-handler.js,
Object/values/observable-operations.js, Object/assign/Target-String.js,
and Object/prototype/toString/symbol-tag-weakset-builtin.js.

The maintained completeness validator accepts all ten completed receipts
and their **7,362 original identities**. Aggregate **7,165 pass / 184 fail /
13 compile errors**, versus matched old **7,131 / 218 / 13**: 34 gains,
zero old-pass-to-nonpass changes. Oracle 14 / honest / auto and no skips
are verified; the old JSONL SHA256 remains unchanged. These are partial
results, not a completed census or a 100% acceptance claim.

The user's renewed upstream synchronization request fetched main to
25578a33bf79d37d94dadc4559b99d1635a30ba7. Measurement HEAD remains
cd123eca318c12a8480e8a69383ddfd50d6e4db4; session 33800 was directly
polled and is still live. Preserve source until its six remaining receipts
and terminal full-scope audit, then commit these handoffs and merge freshly
fetched upstream main. Do not claim the running measurement covers the
newer upstream revision.

### Eleventh settled shard: three further gains, no regressions

Shard 10/16 completed in run 20261002-184918: **711 pass / 23 fail /
2 compile errors / 736 originals**, versus matched old **708 / 26 / 2**.
The three fail-to-pass originals under `test/built-ins/` are
TypedArray/prototype/some/get-length-uses-internal-arraylength.js,
Object/prototype/__proto__/prop-desc.js, and
Object/prototype/__proto__/set-ordinary-obj.js.

The maintained completeness validator accepts eleven receipts and exactly
**8,098 registered / canonical / unique identities**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **7,876 pass /
207 fail / 15 compile errors**, versus matched old **7,839 / 244 / 15**:
37 gains, zero old-pass-to-nonpass changes. All rows retain oracle 14 /
honest / auto with no skips. Immutable old JSONL hash is verified again.
Session 33800 is directly confirmed live and HEAD remains cd123eca;
the frozen manifest hash remains 632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360.
Five receipts and the terminal full-scope audit remain outstanding.
This is partial evidence, not full-scope acceptance or newer-main coverage.

### Twelfth settled shard: two TypedArray gains and one Reflect gain

Shard 15/16 completed in run 20261002-184918: **709 pass / 23 fail /
4 compile errors / 736 originals**, versus matched old **706 / 26 / 4**.
Fail-to-pass originals under `test/built-ins/`:
TypedArray/prototype/reduce/get-length-uses-internal-arraylength.js,
TypedArray/prototype/forEach/arraylength-internal.js, and
Reflect/deleteProperty/delete-properties.js.

The maintained validator accepts twelve receipts covering exactly
**8,834 registered / canonical / unique identities**, with zero missing,
unexpected, duplicate, or excluded identities. Aggregate **8,585 pass /
230 fail / 19 compile errors**, versus matched old **8,545 / 270 / 19**:
40 gains and zero old-pass-to-nonpass changes. Oracle 14 / honest / auto,
no skips, and the immutable old JSONL SHA256 are independently verified.
Session 33800 remains directly confirmed live at source HEAD cd123eca.
Four remaining receipts and terminal full-scope validation are still
required; the run does not measure fetched newer upstream main.

### Thirteenth settled shard: four further original gains

Shard 11/16 completed in run 20261002-184918: **713 pass / 22 fail /
1 compile error / 736 originals**, versus matched old **709 / 26 / 1**.
Fail-to-pass originals under `test/built-ins/`:
Array/length/define-own-prop-length-no-value-order.js,
Object/assign/target-is-frozen-data-property-set-throws.js,
Object/getOwnPropertyDescriptors/order-after-define-property.js, and
Object/getOwnPropertyDescriptors/proxy-undefined-descriptor.js.

The maintained completeness validator accepts thirteen receipts with exactly
**9,570 registered / canonical / unique identities**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **9,298 pass /
252 fail / 20 compile errors**, versus matched old **9,254 / 296 / 20**:
44 gains, zero old-pass-to-nonpass changes. Oracle 14 / honest / auto,
no skips, and the immutable old JSONL SHA256 are verified again.
Session 33800 is directly confirmed live at source HEAD cd123eca.
Three receipts and terminal full-scope validation remain; partial results
do not establish 100% acceptance or coverage of newer upstream main.

### Fourteenth settled shard: two further original gains

Shard 13/16 completed in run 20261002-184918: **711 pass / 23 fail /
2 compile errors / 736 originals**, versus matched old **709 / 25 / 2**.
Fail-to-pass originals under `test/built-ins/`:
TypedArray/prototype/every/get-length-uses-internal-arraylength.js and
Object/defineProperties/proxy-no-ownkeys-returned-keys-order.js.

The maintained completeness validator accepts fourteen receipts with exactly
**10,306 registered / canonical / unique identities**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **10,009 pass /
275 fail / 22 compile errors**, versus matched old **9,963 / 321 / 22**:
46 gains, zero old-pass-to-nonpass changes. Oracle 14 / honest / auto,
no skips, and the immutable old JSONL SHA256 are independently verified.
Session 33800 remains directly confirmed live at source HEAD cd123eca.
Two receipts and terminal full-scope validation remain outstanding.
These partial results do not establish 100% acceptance or newer-main coverage.

### Fifteenth settled shard: four failure gains and one compile-error gain

Shard 1/16 completed in run 20261002-184918: **713 pass / 22 fail /
1 compile error / 736 originals**, versus matched old **708 / 26 / 2**.
New passes under `test/built-ins/`: Object/assign/Target-Number.js,
Object/getOwnPropertyDescriptors/proxy-no-ownkeys-returned-keys-order.js,
Proxy/setPrototypeOf/return-abrupt-from-get-trap.js,
Reflect/ownKeys/return-on-corresponding-order-large-index.js (all old fail),
and Reflect/enumerate/undefined.js (old compile error).

The maintained completeness validator accepts fifteen receipts covering
exactly **11,042 registered / canonical / unique identities**, zero missing,
unexpected, duplicate, or excluded identities. Aggregate **10,722 pass /
297 fail / 23 compile errors**, versus matched old **10,671 / 347 / 24**:
51 new passes and zero old-pass-to-nonpass changes. Oracle 14 / honest /
auto, no skips, and immutable old JSONL SHA256 are independently verified.
Session 33800 is directly confirmed live; final shard 4/16 has started.
HEAD remains cd123eca. Final receipt and terminal full-scope validation
are still required; this is not 100% acceptance or newer-main coverage.

### Completed full census at cd123eca: 97.1557%, 335 nonpassing originals

Run 20261002-184918 and root execution session 33800 are now terminal
(wrapper exit zero). The wrapper's zero exit means completed measurement,
not conformance success: all sixteen test files reported nonpassing rows.
Independent maintained-validator audit accepts **16 v2 receipts / 11,778
registered / 11,778 canonical / 11,778 unique original identities**, with
zero missing, unexpected, duplicate, excluded, skipped, or timed-out rows.
Original frozen manifest SHA256 is unchanged. Every row retains standalone
oracle 14 / honest / auto. Compiler and runtime bundle hashes match the
preflight hashes above; source and runner diff remained empty through terminal.

Final result: **11,443 pass / 311 fail / 24 compile errors / 11,778 originals
(97.1557140431%)**. Matched immutable old ce663127 census was **11,392 /
361 / 25**. Exact row comparison finds **51 newly passing originals**
(50 old failures and one old compile error), **zero old-pass-to-nonpass
changes**. Final shard 4/16 is **721 pass / 14 fail / 1 compile error /
736**, unchanged from matched old results. No partial projection is used.

New JSONL SHA256:
`79c584590f4f70d586065c730b3bde383089d2522a6871c718975889cbdb6029`.
Artifacts remain in this measurement worktree at
`benchmarks/results/test262-standalone-results-20261002-184918.jsonl`,
the corresponding sixteen `.complete.json` files, report JSON, and
`.tmp/es2015-current-main-full-run.log`. Historical index was not published.
The temporary three-control wrapper is removed only after terminal;
control manifest, log, and result artifacts are retained for reconstruction.
The heavy-test lease is released now, not before process completion.

The 100% goal is **not achieved**: 335 nonpassing originals remain.
This measurement covers cd123eca, not newer upstream main. Next integrate
the user's requested freshly fetched upstream main after committing these
handoffs, preserve both sides of issue documentation conflicts, and publish
a correctly formatted upstream handoff PR. Future implementation still
requires the recorded ownership/allocation clearances; keep the frozen
11,778 scope and do not weaken the oracle, exclusions, or host-import guard.

### 2026-10-02 — #6772 class statements/expressions residue — pointer

Branch `issue-6772-class-residue` (record: "2026-09-30 — #6772
implementation (Opus)" in `plan/issues/6772-es2015-standalone-class-residue.md`).
The 34-row ES2015 standalone `language/{statements,expressions}/class/**`
bucket goes **1 → 22 pass** on a tree merged with `origin/main` @
`ce6631272c` (`--isolate`, base re-measured: 1 pass / 32 fail / 1
compile_error; `name-binding/const.js` already passed on main). Mechanisms:
`this`/`super` before `super()` and a second `super()` (S1b), `super(...)`
extras (S1a), constructor return-override (S2), class constructors through
`call`/`apply` (S3), `new`/`init`-named members (S4), folded computed-key
assignments (S5), comma heritage + `Object.getPrototypeOf(derived)` (S6), one
binding holding two class expressions (S7), static `constructor` accessors
(S9), RegExp `lastIndex` gOPD/delete (S10), the runtime heritage `prototype`
read (S11), and distinct slots for a static/instance accessor pair (S12).
Still red (12): the 9 deferred rows (GeneratorFunction ×5, TypedArray /
ArrayBuffer / `subclass/builtins.js` behind #6769, `strict-mode/arguments-callee.js`),
`methods-restricted-properties.js` (S13, not attempted), and
`fn-name-accessor-{get,set}.js` (#6767 R3: a class with a symbol-keyed static
accessor hides its literal static accessors from gOPD).

### 2026-10-02 — fresh full-goal verification at upstream 7cd84317

Root assigned the isolated `6834-module-residual-attribution` checkout on
`codex/6834-module-residual-attribution`, production HEAD frozen at
`7cd84317ac9f5ad1b48a138e33113b98c8392b8e` after landed TypedArray
find/findIndex internal-length fix PR #6457. This is a new source measurement,
not an attributed implementation gain. Preserve the older b8c9a12a attribution artifacts under `.tmp/6834-residual`
as older evidence; do not reinterpret them as current results.

Preflight/launch artifacts belong under `.tmp/6651-current-main-verification`.
Retain the exact frozen 11,778-original manifest and SHA256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`;
verify every original body blob against Test262
`b363f29d3c43c626dc852744ad64a0b48a003693` before building. Rebuild owned
compiler/runtime bundles and current-source QuickJS adapter; verify the supplied
immutable artifact and actual executable canaries. Then require three passing
original positive controls (Math.sign.length and the DisplayNames/Segmenter
constructor-prototype-poison cases), complete exact receipts, and no exclusions.
Control membership is separately recorded; never add controls to the goal.

Only after preflight/control success, launch one maintained
`scripts/run-test262-vitest.sh` census: standalone/auto/QuickJS/honest oracle 14,
one compiler worker, one 4 GiB Vitest fork, all 16 maintained weighted shards,
exact manifest only. This documentation edit deliberately makes the wrapper
select this owned working tree. No source, runner, test, HEAD, registry, queued
PR, or shared configuration mutation while measurement is live. No installs,
exclusions, cap, weakening, or historical-index publication. Require independent
validation of all 16 v2 receipts and exactly 11,778 settled unique original
identities before comparing with completed cd123eca run `20261002-184918`.
Wrapper exit zero means completion only; the 100% goal remains unachieved unless
the actual final original verdicts establish it.

Preflight session `18925` is terminal exit zero: **11,778/11,778** selected
Git blobs match the pinned donor, zero mismatches. Actual frozen production,
test, and runner fingerprint is
`71c4188238ec2ce00609d410628c6c2471895c271cd5f36033c8e466b1cd1cef`.
All three controls are confirmed members of this exact goal manifest; they
remain a separate instrument-validation run, not extra population or gains.

Control run `20261002-234314`, wrapper PID `19397`, session `26794`, is
terminal exit zero: **3 pass / 3 originals**, oracle 14/honest/auto. Independent
maintained validator confirms exact identities, three registered/recorded/
started/settled callbacks, no exclusions/skips. All 7,562 captured tracked
source/test/runner file hashes remained unchanged. Control JSONL SHA256:
`465581bf98efe9889e07f18990975172149ef10a5a1aa0e4532a4ce7b02fedb9`.

The wrapper rebuilt owned compiler/runtime bundles from 7cd84317. SHA256s:
compiler `1d2c0b376fc912a7f1187ca9a69b60e3d2ab1ec3a3f111c6cfc870500b878781`;
runtime `221f4acea7e995d4f0240fbd6a81cc380020d7cdf7da8e8d74c06251953581c0`.
Immutable QuickJS artifact SHA256:
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
Fresh adapter key `37d2326e33b94d57` (compiler-input hash `c67df3bb89bcbd6f`)
was built and executable-canary-verified, 587,319 bytes, SHA256
`fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`.
The control log and full per-original preflight/hash receipts are in
`.tmp/6651-current-main-verification`. The following full run reuses this
verified pair; a later cache HIT is linked-pair verification, not a fresh
canary claim. Source and HEAD stay fixed through actual terminal completion.

The one full census is live: run **`20261002-234453`**, execution session
**`26208`**, wrapper PID **`19748`**. Actual wrapper checkout is this owned
7cd84317 worktree, with the exact unchanged manifest snapshot and **16**
maintained shard entries. Same verified adapter/library pair is reused with
linked-pair validation. Durable log:
`.tmp/6651-current-main-verification/full-run.log`; canonical JSONL:
`benchmarks/results/test262-standalone-results-20261002-234453.jsonl`.
Completion still requires all sixteen matching v2 `.complete.json` receipts
and an independent exact-identity audit. Do not infer a total from partial rows
or restart after an observation timeout. No implementation changes authorized.

Completed parallel task (2026-10-03): root assigned the Sol shepherd a read-only
matched-row transition review of the already settled groups **2, 3, 8, 10**
against the completed cd123eca JSONL. Notes belong only in that teammate's
ignored 6836-review artifacts; no source, test, issue-document, or measurement
mutation and no heavy build/test are authorized there. Any observed transition
compares different source/compiler/runtime/adapter bytes: it is neither a
causal implementation gain/regression nor a whole-goal result. Only this
read-only review task is complete; the same full census remains live.

The independently hash-checked review joins **2,944/2,944** exact originals,
with zero missing/duplicate rows and zero old-PASS losses. Six differing-source
nonPASS-to-PASS transitions are observed (five FAIL, one compile error), with
zero other status/error-text changes. This uses a 3,092-row live JSONL snapshot,
not a terminal whole-run total. Review artifact:
`/Users/thomas/Code/js2/.codex-worktrees/6836-parser-plan-review-sol/.tmp/6651-completed-group-review/report.json`,
SHA256 `e06b5d594cba83f25d3079e4c5e1b900e83f89a947bed467194e8a172112a348`;
companion `notes.md` SHA256
`e165a42a6f68d93cd33fb2bc518848dad9569aaeb3ab41a3e3d5ff64466d3a2e`.

Root independently checked these **4/16 partial** receipts against their exact
registered originals: shard 2, 736 rows = 719 pass / 16 fail / 1 compile error;
shard 3, 737 rows = 716 / 20 / 1; shard 8, 735 rows = 719 / 14 / 2; shard 10,
736 rows = 712 / 22 / 2. Each has equal registered/canonical/unique/started/
settled counts, all callbacks settled, no exclusions, oracle 14/honest/auto.
Weighted groups need not have equal sizes. These are partial cross-checks only.
Root also recomputed all 7,562 source hashes mid-run with zero changed/missing
files and independently verified the run snapshot's 11,778 unique identities,
exact frozen-set equality, and unchanged manifest SHA256. Selection and
mid-run integrity checks do not replace terminal execution/identity validation.

Subsequent independent parent review, separate from the frozen four-group
report: shard **15/16** settled 736 registered/recorded/canonical/unique/started/
settled originals, all callbacks settled, zero exclusions, oracle 14/honest/auto;
**715 pass / 18 fail / 3 compile errors**. A hash-verified 736-row historical join
found zero PASS losses and six nonPASS-to-PASS observations (including one
compile-error-to-PASS). This is differing-source partial evidence, not causal
attribution, and does not amend that earlier report. Five of sixteen groups are
now settled; the full terminal audit is still required.

Next separate parent cross-check: shard **14/16**, 736 exact unique originals,
equal registered/recorded/canonical/started/settled counts, all callbacks
settled, zero exclusions, oracle 14/honest/auto; **720 pass / 16 fail / 0 compile
errors**. The hash-verified historical join found zero PASS losses and one
FAIL-to-PASS observation,
`test/language/expressions/super/prop-expr-cls-ref-this.js`. This read-only
comparison is complete, but remains differing-source **6/16 partial** evidence,
separate from the frozen four-group report and without causal attribution.

Separate parent shard **13/16** cross-check: 736 exact unique registered/
recorded/canonical/started/settled originals, all settled, zero exclusions,
oracle 14/honest/auto; **713 pass / 21 fail / 2 compile errors**. Its hash-verified
historical join finds zero PASS losses and two FAIL-to-PASS observations:
`test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-assignment.js`
and `test/language/statements/class/arguments/default-constructor.js`.
This completed read-only review is **7/16 partial** differing-source evidence,
not causal attribution or a whole-suite total.

Completed bounded read-only task: assess whether normal documentation
publication hooks in the isolated 6836 review checkout could interfere with
this census. Hook/package/Vitest bytes match; normal pre-push includes parallel
TS7 typecheck/lint and 18 numeric-local direct/IR tests in one fork, so it is
not test-free. At assessment time the 16 GiB host reported 42% free/reclaimable
memory and this census's process family used about 0.84 GiB RSS; recorded
compile/execute maxima were 4,245/731 ms, partial observations only. No hook
path targets this census's owned compiler/runtime/QuickJS artifacts; the
remaining risk is transient CPU contention against wall-clock budgets. The
assessment supports one bounded serialized exception, but does not itself
grant it or guarantee zero contention. No hook/build/test was run by this
assessment, and no census source/configuration/HEAD/process was changed.

Root explicitly granted one serialized exception for the isolated issue 6836
Markdown publication's normal pre-commit/pre-push hooks, including the mandatory
18 numeric-local direct/IR cases. The publisher has reported starting this
exception; actual UTC hook intervals/terminal gates are still awaited and must
be retained as overlap provenance. No extra build/test/prewarm/install or
census/source/provider/configuration mutation is authorized. This run retains
priority, and all source-sensitive implementation ownership holds remain open.

The publisher reports actual exception intervals, both normal/unskipped and
terminal success: pre-commit session `92823`, **2026-10-02 23:10:07–23:10:11 UTC**;
pre-push session `79518`, **23:10:52–23:12:42 UTC**. Typecheck/lint, changed-file
format, oracle/coercion ratchets, all **18** numeric-local cases, and issue
integrity passed. Numeric Vitest began 23:11:23 UTC and took 22.64 s (actual
test time 4.604 s). Only the frozen issue 6836 Markdown was published; no extra
local heavy work followed. This records a real concurrent-load interval, not
unchanged-resource equivalence or a causal inference. Terminal census validation
must still check timeout/worker-failure/retry markers and all final receipts.

Further parent v2/JSONL cross-checks retain oracle 14/honest/auto, equal exact
registered/recorded/canonical/unique/started/settled counts, all settled and zero
exclusions: shard 5, 736 rows = **721 pass / 13 fail / 2 compile errors** (its
historical join has zero PASS losses and zero newly passing rows); shard 12,
737 = **718 / 18 / 1**; shard 16, 736 = **715 / 20 / 1**; shard 7, 737 =
**716 / 21 / 0**. These establish **11/16 partial** completion, not a final
score or causal gain. The scheduled verifier audit confirms all eleven receipts.

Completed source-only Astra dispatch screen, separately from this measurement:
`/Users/thomas/Code/js2/.codex-worktrees/6836-valid-for-heads-plan-astra/.tmp/6836/settled-census-dispatch-screen.md`,
SHA256 `be531f1a59118d266bc2a63d7fa0f46cb806b5a0a4a61c4b638b375691d7036d`.
No safe implementation candidate was established. The Map/WeakMap quartet
belongs to actively claimed #6775 (`ttraenkler/opus-6775`, S13/#5267G9); the
Proxy-prototype candidate crosses the held type-coercion producer. Other
screened plans are not proven claimed/free/ready. The local IR handoff also
reserves generator `new-super.ts`, iterator `iterator-native.ts` strict-next
capture and Promise checkpoint work; it does not establish another machine's
current edit set or release neighboring ownership boundaries. No implementation
permission, new duplicate issue, exclusion or conformance gain is inferred.

Publication overlap receipt was independently read and hash-checked:
`/Users/thomas/Code/js2/.codex-worktrees/6836-parser-plan-review-sol/.tmp/6836-publication-receipt.json`,
SHA256 `85430116ca81e3be40742e2d3b82c80ea32b2a7a9b9d7e1f1f81bf0109aae6a5`.
At the post-overlap log scan there were zero observed pool timeout/fatal/retry/
heap/IPC failure markers and zero skipped/timed-out recorded verdicts. This is
observed instrumentation evidence, not a claim of zero performance effects;
repeat the check after terminal completion.

Root's independent aggregate review of the eleven settled groups joins exactly
**8,098** unique originals to the hash-verified completed cd123eca JSONL, with
zero missing/duplicate/cross-shard identities and zero old-PASS losses. It
observes **22** nonPASS-to-PASS transitions (20 FAIL, 2 compile errors), solely
partial differing-source/provider evidence. Two FAIL-to-FAIL error-text changes
remain material: `class/definition/fn-name-accessor-get.js` has a TypeError
location change from 855:10 to 879:10; `Proxy/deleteProperty/trap-is-undefined-strict.js`
changes the failing assertion from expected `[object Object]` versus undefined
to true versus false. Do not flatten these into "no regressions" or full success,
and do not amend the frozen earlier four-group report. Full sixteen-group
comparison and original-identity validation are still required.

Parent's next independent receipt cross-check: shard **1/16**, 736 exact unique
registered/recorded/canonical/started/settled originals, all settled, zero
exclusions, oracle 14/honest/auto; **715 pass / 20 fail / 1 compile error**.
The scheduled own audit confirms twelve settled receipts. Post-documentation-
hook parent integrity rehash also finds zero changed/missing files among all
11,778 original bodies, 7,562 captured source files and three QuickJS artifact
files. These remain **12/16 partial** and live integrity evidence; repeat after
actual terminal exit, without inferring a full rate or claiming gain.

Parent and scheduled own audit next confirm shard **11/16**: 736 exact unique
registered/recorded/canonical/started/settled originals, all settled, zero
exclusions, oracle 14/honest/auto; **714 pass / 21 fail / 1 compile error**.
This is **13/16 partial** receipt completion only; the same session continues.

Next parent and scheduled own cross-check: shard **6/16**, 736 exact unique
registered/recorded/canonical/started/settled originals, all settled, zero
exclusions, oracle 14/honest/auto; **715 pass / 19 fail / 2 compile errors**.
Fourteen receipts are settled; groups 4 and 9 remain. The separate Sol publisher
may prepare a new isolated latest-upstream Markdown handoff worktree, preserving
upstream documentation, but no commit/hooks/build/test/push there is authorized
until actual terminal receipts, root's independent audit and explicit readiness.
Transfer only this owned handoff delta, never the stale whole document or source.

Next independently parent-checked and own-audited receipt is shard **4/16**:
736 exact unique registered/recorded/canonical/started/settled originals, all
settled, zero exclusions, oracle 14/honest/auto; **722 pass / 14 fail / 0 compile
errors**. Fifteen of sixteen are settled; only shard 9 remains. The parent also
rehashes all five recorded control/compiler/runtime/adapter receipt entries
after the documentation overlap with zero changed files. These are stronger
live integrity checks, not substitutes for the final after-exit rehash/audit.

### 2026-10-03 — terminal whole-population receipt at frozen 7cd84317

The original execution session **26208** is actually terminal, wrapper exit
**0**, without restart; terminal state was observed by 00:06:30 UTC. This means
the measurement completed, not that conformance succeeded. Final shard 9/16 is
736 registered/started/settled originals, **724 pass / 10 fail / 2 compile errors**.
All sixteen matching v2 receipts are now present and all callbacks settled.

Own independent maintained CLI is terminal exit zero, using `--expected-shards
16`, the frozen exact `--expected-paths-file`, the canonical `--input` and all
sixteen explicit `--manifest` entries. Own full audit session `23388` is also
terminal exit zero. Both it and root's separate maintained-validator audit
establish **11,778 registered / canonical / physical / unique / started / settled
originals**, zero missing/unexpected/duplicate/excluded/skipped/timed-out rows,
and oracle **14 / honest / auto** throughout. All three positive originals also
remain PASS with `reached_test=true` in this complete run.

Actual result: **11,474 pass / 283 fail / 21 compile errors / 11,778 originals
(97.41891662421463%)**. There are **304 nonpassing originals**; the 100% goal
is **not achieved**. Canonical JSONL SHA256:
`040290bc0f701aa247b4016a13ec20259ea89e5e05880ee2ca5e90816eba5e6b`.
Own receipt `.tmp/6651-current-main-verification/terminal-audit.json` SHA256:
`cf4a893cd9df8e15bea68254940b7cde83cd03a1e74c016e48ac9bcc4d2e1369`.
Independent CLI and audit logs are in that same owned ignored directory.

After actual exit, own and root checks confirm HEAD still
`7cd84317ac9f5ad1b48a138e33113b98c8392b8e`, all **11,778** original body hashes,
all **7,562** tracked production/test/runner hashes, frozen manifest/snapshot,
the three immutable QuickJS files and owned artifact copy, plus all five
compiler/runtime/adapter/control hashes unchanged. Source fingerprint remains
`71c4188238ec2ce00609d410628c6c2471895c271cd5f36033c8e466b1cd1cef`.
Normal Git status shows only this authorized issue document modified. No
source/runner/test/HEAD/configuration or historical-index publication changed.
The terminal durable-log scan finds **zero observed** pool timeout/fatal/retry/
heap/IPC failure markers. The authorized documentation-hook overlap above is
retained as an actual concurrent-load difference, not proof of performance
equivalence; no causal timeout/resource effect is inferred from absent markers.

Full exact-row comparison to completed cd123eca run `20261002-184918` (old
JSONL SHA256 `79c584590f4f70d586065c730b3bde383089d2522a6871c718975889cbdb6029`)
joins **11,778/11,778** originals with zero missing/duplicate identities:
11,443 PASS-to-PASS; 283 FAIL-to-FAIL; 28 FAIL-to-PASS; 21 compile-error-to-
compile-error; three compile-error-to-PASS. Thus zero previously passing rows
become nonpassing and **31** nonPASS-to-PASS observations occur. These compare
different source/compiler/runtime/adapter bytes, not a removal-controlled
implementation A/B: the frozen corpus, Node 24, standalone/auto/QuickJS/honest
14, one compiler worker and bounded 4 GiB Vitest fork match; compiler/runtime
bundles and adapter change (old key `79ee37c474567749`, new `37d2326e33b94d57`),
and the **QuickJS library artifact also differs**. The authoritative old launch
log reports SHA256 prefix **`e9f8d30bc347dbc5`** (worker prefix `e9f8d30bc347`),
whereas the new launch log reports **`073742801ba76347`** (worker prefix
`073742801ba7`), matching the full new artifact hash recorded above. Sources:
`/Users/thomas/.codex/worktrees/6651-current-main-full-verification/js2/.tmp/es2015-current-main-full-run.log`
and `.tmp/6651-current-main-verification/full-run.log`, provider records at
lines 16–17 and subsequent worker announcements. The shared cache key
`2e2d7736713beeda` does not establish identical library bytes. Thus compiler,
runtime, adapter **and library** differ between the complete runs. Do not
attribute the 31 observations to one fix or claim absence of silent wrong answers.

Four FAIL-to-FAIL error changes are preserved: class
`definition/fn-name-accessor-get.js` TypeError location **855:10 → 879:10**;
`definition/fn-name-accessor-set.js` **856:10 → 880:10**; both Proxy/deleteProperty
`trap-is-undefined-strict.js` and `trap-is-undefined-not-strict.js` change the
failing SameValue assertion from **[object Object] versus undefined** to
**true versus false**. The complete own receipt retains exact paths, errors,
categories, signatures and reached-test changes. Root independently agrees
with all totals/transitions. Earlier partial reports remain immutable evidence.

This verification task is complete and its heavy measurement lease can be
released to root. The separate publisher still requires root's explicit audited
readiness before normal hooks/publication. All implementation ownership holds
and the prohibition on corpus/oracle/guard weakening remain in force.

### 2026-10-04 — PR #6449 documentation shepherd handoff

An isolated shepherd checkout normally merged the published PR head
`1a27ada9780193081bd40e255d34768f558b1eda` with upstream main
`7c8edb29224f7497bc2be8544dfabc166f4dd63d`. Its sole conflict was this
document's append boundary. Both original histories and their exact census
counts, hashes and provider provenance were preserved; no source, test,
workflow, oracle or original-population change was made relative to that main.

The `ce663127` census above remains historical, not a current-main claim.
Root's latest independently audited complete census at `247f` records
**11,476 pass / 286 fail / 16 compile errors / 11,778 originals**, oracle
**14 / honest / auto**. Later diagnostics must not be projected into that
complete count. PR #6449 is documentation-only and claims no conformance gain
or completion of the 100% goal.

Actual cheap checks completed successfully: document Prettier check, staged
issue-ID check (13 issue files), issue integrity (4,742 indexed issues), and
explicit diff checks. Normal pre-commit gates also actually completed exit zero:
lint-staged, LOC/function budgets and oracle ratchet passed. The maintained
changed-root selector reported 41 changed root files from the uncommitted main
merge and skipped execution under its existing >20 mass-edit rule; this is
not a 41-test pass claim. Commit/push outcomes and required live CI still need
their own actual receipts; old green PR-event Test262 stubs are not a census.
