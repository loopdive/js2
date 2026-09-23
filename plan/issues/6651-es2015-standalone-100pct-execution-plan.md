---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-22
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
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/generators-native.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
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
  - src/codegen/expressions/new-super.ts
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
func-budget-allow:
  # 2026-09-23 — cluster H slice H2: the same +153 as the LOC grant above, in
  # the same four arms. `fillVecOverlayHelpers` is one long FINALIZE pass that
  # fills each reserved native's body in turn; every arm this slice adds is a
  # continuation of a guard built from that pass's own closure, so the split
  # that would satisfy this gate is the `vec-symbol-key-overlay.ts` extraction
  # named in the LOC rationale — a refactor, not part of a behaviour fix.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  # (see coercion-sites-allow below for slice B2's other gate grant)
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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
coercion-sites-allow:
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

## Cluster status

_(owners append here: date, branch, before → after, log paths, residuals)_

### 2026-09-20 — Cluster D (native Promise combinators), slice D1: custom-constructor `.call`

- **Branch** `worktree-agent-a6d336193709ec50a`, base `claude/es2015-test262-plan-54tooh`
  (`905dca75`). **Worktree** `/home/user/js2/.claude/worktrees/agent-a6d336193709ec50a`.
- **Manifest** `plan/agent-context/6651/D-promise-combinators.txt` (101 rows),
  `--standalone --isolate`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/D-before.log`) | 0 | 55 | 46 |
  | after (`.tmp/6651/D-after.log`) | **26** | 57 | **18** |

  Every one of the 28 compile errors in the targeted cohort is gone: 26 of them
  now PASS, 2 became documented fails (below). The fail count rises by exactly
  those 2 — no row that executed before stopped executing.

- **What landed.** `Promise.{all,race}.call(C, iterable)` for an ORDINARY
  compiled constructor now runs the §27.2.4.1.1 / §27.2.4.3.1 element protocol
  natively (new `src/codegen/promise-custom-combinator.ts`): NewPromiseCapability
  over `C`, one `Get(C, "resolve")`, per-element `Call(resolve, C, «value»)` and
  `Invoke(next, "then", …)`, with real per-index resolve-element functions
  (builtin-fn-meta carrier, `[[AlreadyCalled]]`, `[[RemainingElements]]`), and
  IfAbruptRejectPromise on any abrupt element step. Before this, that whole
  shape fell through to the unsatisfiable `env::Promise_all`/`env::Promise_race`
  host import, so the rows did not compile at all. The narrow #4682 empty-array
  arm stays as the fallback for `allSettled`/`any` and refused constructors.
  Two sub-fixes were needed and are load-bearing:
  1. `C` is invoked through `__apply_closure`, not a baked `call_ref` — every
     row in the cohort writes a static (`C.resolve = …`), which moves the
     identifier's value onto the `$Object` function carrier; the `call_ref`
     path found a null funcref and threw the capability TypeError before `C`
     ran (measured `checkPoint === 0`).
  2. An array of object literals compiles to a vec of the CLOSED STRUCT type,
     which `__combinator_to_vec` answers null for. Those are re-materialized
     into the canonical externref vec instead of being called "not iterable"
     (that alone was 9 of the 28 rows).

- **Neighbourhood control** — all 729 `built-ins/Promise/**` rows, `--standalone`,
  before vs after (`.tmp/6651/neigh-standalone-{before,after}.log`):
  pass **359 → 385**, fail 204 → 206, compile_error 166 → 138.
  Per-row set diff: **0 pass → non-pass**, 26 non-pass → pass.
- **Host (gc) lane**: the non-isolated host run of that directory cannot be used
  as a control — one row poisons `Promise.all` in the runner's own realm and
  kills the process (`src/runtime.ts:17502 … PROMISE_INTRINSICS.all?.call`).
  Substituted a stronger check where it applies: a sha256 byte comparison of 8
  compiled programs (3 custom-constructor `.call` shapes, 4 intrinsic
  combinator shapes, a `.then` chain) on base vs branch —
  **all 8 host binaries byte-identical** (`.tmp/6651/hostbytes-{before,after}.txt`).
  On standalone the same corpus shows exactly the intended delta: the 3
  custom-constructor programs change (and lose all host imports), the 5
  intrinsic ones are byte-identical (`.tmp/6651/sabytes-{before,after}.txt`).
- **Unit tests**: new `tests/issue-6651-promise-custom-combinator.test.ts`
  (8 cases: values array, deferred `[[RemainingElements]]`, race handler
  identity, zero-arg-ctor TypeError, throwing ctor, both IfAbruptRejectPromise
  arms, host-lane control). `tests/issue-4682.test.ts` — the
  "keeps the non-empty custom-constructor fallback unchanged" case asserted the
  shape still leaked `env.Promise_all`; it is REWRITTEN to assert the native
  lowering. The 3 failures in `tests/promise-combinators.test.ts` (2 timeouts)
  and `tests/issue-2671-promise-capability.test.ts` reproduce IDENTICALLY on the
  base tree (`.tmp/promise-suite-{before,after}.log`) — pre-existing, host-lane.
- **Gates**: loc-budget and func-budget pass with the grants added to this file's
  frontmatter (+12 LOC / +11 func LOC at the dispatch site only); coercion-sites,
  oracle-ratchet, dead-exports, compiler-boundaries `--mode inventory` (the new
  module is classified in `scripts/compiler-boundaries.json`) and
  `scripts/equivalence-gate.mjs` (22 known failures, no new) all pass.

**Residual sub-buckets (18 CE + 57 fail on the manifest), with signatures:**

| rows | status | sub-bucket | why it is still open |
| ---: | --- | --- | --- |
| 8 | CE | `{all,race,allSettled,any}/resolve-throws-iterator-return-*` — `env::Promise_*` | the receiver is a `class BadPromise {…}`; standalone has no `Construct(C, «executor»)` for a compiled class (#5197 G10, DEFERRED there) |
| 6 | CE | `{all,race,resolve,reject}/ctx-ctor.js`, `*/invoke-resolve-on-promises-every-iteration-of-custom` — `env::__promise_subclass_ctor` | `class X extends Promise` receiver (#5197 G9, DEFERRED) |
| 4 | CE | `{all,race}/invoke-resolve-on-{promises,values}-every-iteration-of-promise` — `env::Promise_{all,race}` | INTRINSIC receiver with a reassigned `Promise.resolve` over an f64/promise vec — #5197 R3-2 step 6, the half held PR #5883 implements |
| ~20 | fail | `invoke-resolve*`, `invoke-then*`, `resolve-not-callable-*`, `resolve-poisoned-then` | the observable intrinsic `Get(C,"resolve")`/`Invoke(then)` pipeline (R3-2 / PR #5883) — deliberately NOT duplicated here |
| ~10 | fail | `*-close`, `iter-step-err-reject`, `iter-next-val-err-reject`, `S25.4.4.*_A5.1` | the iterable is drained before the element loop, so `IteratorClose` never runs and a throwing `next()` surfaces as "argument is not iterable" (R3-4) |
| 1 | fail | `all/capability-resolve-throws-no-close.js` — `Expected SameValue(«0», «1»)` | NEW in this slice's scope: the iterable is `iter[Symbol.iterator] = fn` on an `$Object`; `__combinator_to_vec` does not see the symbol-keyed expando, so the aggregate rejects "not iterable" and `nextCount` stays 0 (R3-4 hypothesis H1) |
| 1 | fail | `all/resolve-element-function-prototype.js` — `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | environment only: the quickjs provider is not built in this container, so the row is unverifiable locally (it exercises `Object.getPrototypeOf(resolveElementFunction)`) |
| rest | fail | `then`/species/`constructor` reads, `Object.prototype.toString` tag, boolean handler boxing | #5197 R3-5…R3-10 and #4119 — untouched by this slice |

**Not started in this slice (and why):** the runtime-fail half of cluster D is
the observable-protocol work of held PR #5883 (#5197 R3-2), which the brief
explicitly says not to duplicate; the class-receiver CEs need a standalone
`Construct` for compiled classes, which is a separate mechanism, not a
combinator change.

### H — builtins misc (2026-09-20, Opus lane)

- Branch `worktree-agent-a5c18a3e8a3d3a0fd`, worktree
  `/home/user/js2/.claude/worktrees/agent-a5c18a3e8a3d3a0fd`, based on
  `claude/es2015-test262-plan-54tooh` (905dca75).
- Manifest `plan/agent-context/6651/H-builtins-misc.txt`, sha256
  `f1eb655415155ac7e7d262ffbaa50a479f8a495bdeb297fad7292169811c104f`, 217 rows.

**Before → after on the manifest** (isolated standalone runner, one row per
child process; logs `.tmp/6651/H-{before,after}.tsv`):

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before | 0 | 211 | 6 |
| after | **3** | 208 | 6 |

Per-row diff: **3 gained, 0 lost, 0 other verdict changes** —
`Array.prototype.concat_{sloppy-arguments,sloppy-arguments-with-dupes,
strict-arguments}.js`.

**What landed: an `arguments` object's `length` is an ORDINARY property
(§10.4.4), on all three surfaces.** The assignment half already modelled this
(`member-set-dispatch.ts`, `vec-length-set.ts` arm 1: store the value in the
`$__arguments_vec` override fields, leave the index domain alone). Three
surfaces disagreed with it, each measured on the base tree:

1. `Object.defineProperty(args, "length", {value: 6})` ran Array ArraySetLength
   (`__vec_dp_value`), which GREW the physical backing; the new tail read back
   as wasm null — JS `null`, not `undefined` — and `4 in args` answered `true`
   for a slot that is not an own property.
2. `__extern_length` (the array-like length every generic spec loop reads) read
   field 0, so `[].concat(args)` after `args.length = 6` produced three
   elements where §23.1.3.1 wants six (three values + three holes).
3. `Object.getOwnPropertyDescriptor(args, "length").value` answered the
   physical count (3) while `args.length` answered 6 — the same property, the
   same module, two answers.

Files: `src/codegen/vec-length-descriptor.ts` (both new builders — the
subsystem module for brand-sensitive length descriptor reads),
`src/codegen/vec-length-set.ts` (`spliceArgumentsExternLengthArm`),
`src/codegen/vec-overlay.ts` (+4 lines: the two call sites). Pin file
`tests/issue-6651-arguments-ordinary-length.test.ts` — 5 cases, **3 verified
RED on the base tree**, 2 are guards (green both sides), including the negative
direction (an untouched arguments object must keep the physical length).

**Neighbourhood control** — `built-ins/Array/prototype/concat` (all 69 rows) +
the 53 `language/arguments-object` rows that write/define/delete `length` or
run `verifyProperty`, standalone, before vs after on the same machine
(`.tmp/6651/ctl-{before,after}.tsv`): `95 pass / 26 fail / 1 CE` →
`98 / 23 / 1`, **0 pass → non-pass**, no other verdict changes.

**Host (default target) control is a byte-identity proof, not a sample.** Both
arms are standalone-gated (`ctx.externGetIdxReserved` / `ctx.standalone`), so
the honest control is that host output cannot move: the 13-file
`website/playground/examples` corpus compiles byte-identically on **gc and
standalone** before vs after (26/26 sha256 equal), and a module that exercises
exactly this construct (`arguments` + `length` write + define + concat +
gOPD) is byte-identical on **gc** (`31006917fced63c6` both sides) while its
standalone output changes (`0d2af224b558c195` → `f04025b3dd538141`).

Gates, bare: loc-budget OK (+4 in `vec-overlay.ts`, granted in this file's
frontmatter above, dated), func-budget OK, coercion-sites OK, oracle-ratchet OK
(`getTypeAtLocation +0`, `ctx.checker +0`), dead-exports OK, typecheck OK,
prettier OK, `biome lint --diagnostic-level=error` OK.
`node scripts/equivalence-gate.mjs`: **22 failing / 1720 passing, all 22 already
in `scripts/equivalence-baseline.json` — no new equivalence regressions.** (The
bare `vitest run tests/equivalence` OOMs in this container, as the project docs
warn; the gate's single-fork run is the supported way to score it.)

#### Residuals — what the other 214 rows are

Two thirds of this cluster is not "builtins misc" at all:

- **63 rows are not measurable in this container**: they need the runtime-eval
  provider (`JS2WASM_EVAL_ENGINE=quickjs`, artifact not built here) — mostly
  the `$262.createRealm` family. Before and after were measured with the SAME
  engine, so the delta is comparable; the absolute cause mix is not
  CI-comparable.
- **53 further rows are realm- or Proxy-dependent by source inspection**
  (`createRealm` / `new Proxy` / `Proxy.revocable` in the test body) —
  `proto-from-ctor-realm*`, `Symbol/*/cross-realm`, `create-proxy`,
  `Function/prototype/toString/proxy-*`. Cross-realm intrinsics have no
  standalone representation today; these belong with cluster F's Proxy work or
  a `wont-fix` with the realm reason, not here.
- **101 rows are core-measurable** and fragment into buckets of ≤5, the largest
  being: `Expected a TypeError … no exception` (5, builtin-method
  not-a-constructor + frozen-target `Object.assign`), `Expected a Test262Error
  but got a TypeError` (5, Map/WeakMap iterable-entry abrupt completions),
  bound-function `new.target` (5), `target-array-with-non-writable-property`
  species rows (4), `Array.prototype.flat` standalone CE (3), the
  `Object.prototype.toString` standalone refusal (3, all needing a runtime
  `@@toStringTag` Get honouring `delete`), and ~25 singletons.

Measured findings worth the next lane's time (each reproduced on the base tree
with a standalone probe, none fixed here):

- **Symbol-keyed ACCESSOR `defineProperty` on a vec carrier is silently
  dropped.** `Object.defineProperty(arr, Symbol.isConcatSpreadable, {get})`
  leaves `arr[Symbol.isConcatSpreadable]` `undefined` and never fires the
  getter, while the same descriptor on a plain object works and a plain
  symbol-keyed assignment on the array works. Cause: the vec overlay's
  `stringKeyGuard` BAILS on a non-string key, and the bail returns from
  `__defineProperty_value`/`_accessor` outright. This is #6485's recorded
  `is-concat-spreadable-get-order` residual, now localised.
- **`__extern_length` answers 0 for non-`$Object` object carriers.** A
  spreadable `new String("yuck")` concats to `[]`; a spreadable function with
  `length = 3` is not spread at all. The `$Object` array-like arm
  (`ToLength(Get(O,"length"))`) has no counterpart for wrapper / closure /
  RegExp carriers — deliberately not widened here, because it changes the
  array-like length of every such receiver and needs its own control set.
- **`Object.assign(Symbol(), …)` does not box**: `typeof` stays `"symbol"` and
  `Object(sym) === sym`. ToObject has no Symbol-wrapper carrier.
- **`Object("hi").length` is 0** while `new String("xy").length` is 2 — the
  ToObject path builds a different carrier from the constructor path.
- **`Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")`** works
  (#5268) but `get.call({})` answers `null` rather than `Object.prototype`, and
  `set.call(o, proto)` does not make `getPrototypeOf(o)` that proto — an
  object-model gap, not an accessor gap.

### 2026-09-20 — Cluster A (native generator lowering, standalone), slice 1

- **Branch** `worktree-agent-ad71a322a90a0a605`, based on
  `claude/es2015-test262-plan-54tooh` @ `905dca75`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-ad71a322a90a0a605`.
  A second, source-clean worktree `/home/user/js2/.claude/worktrees/measure-6651-A`
  (detached at the same commit) held every before-run — the first attempt
  measured the base with the runner reading the *edited* tree underneath it,
  which is not a before-state.
- **Manifest** `plan/agent-context/6651/A-generators-standalone.txt`, 197 rows,
  sha256 `5fc1a7c0c1d5672aba427f347ea225633e0c95cfa6e9547240fcc2cda2d62d77`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/A-before.log`) | **1** | 1 | 195 |
| after (`.tmp/6651/A-after.log`) | **62** | 2 | 133 |

**+61 rows pass, 0 pass → non-pass.** The one other movement is
`language/expressions/yield/star-in-rltn-expr.js`, compile_error → fail — a
narrower, documented residual (it now builds and gets a wrong first `value`).

#### What changed, and why it was bailed before

Both edits are in `src/codegen/generators-native.ts`; both reverse a *bail*, and
neither adds a host import.

1. **A1 — `this` inside a generator function EXPRESSION (41 rows).**
   `isNativeGeneratorExpressionShape` refused any `this` in the body, so
   `Array.prototype[Symbol.iterator] = function*(){ … this.length … }` — the
   shape the whole `dstr/*-array-prototype` fixture family is built on — fell to
   the eager-buffer host path and leaked `env::__gen_*` into a standalone
   binary. #5255 had already solved the same problem for free *declarations*:
   snapshot the receiver into a frame field (`dynamic_this`) in the FACTORY and
   restore it as the resume function's `this` local. The bail's own comment said
   fn-exprs were excluded because "their closure ABI supplies a different
   capture carrier" — but `this` is not a capture (a non-arrow function
   expression rebinds it per call), so the `__self` struct and the receiver
   never compete. The factory here IS the lifted closure, whose `this` resolves
   through the `__current_this` global that `__call_fn_method_N` installs around
   the dispatch, i.e. exactly where §10.2.1 binds it.
   The load-bearing property is the *snapshot*, not "it compiles": a generator
   body runs on a later `.next()`, long after that global is restored. The
   `tests/issue-6651-generator-expression-this.test.ts` case "the receiver
   SURVIVES a suspension" is the one that fails if the receiver is read lazily.
   `super` keeps the bail (no [[HomeObject]] slot in the frame), and the two
   `this`-scans must agree before admitting — `fnExprBodyReferencesThis`
   descends into class bodies while `bodyReferencesOwnThis`, which arms the
   snapshot, stops there.
2. **A2 — a generator-valued destructuring-param default in a zero-suspend
   method lane (20 rows).** `buildNativeGeneratorPlan` bailed on every
   `[g = function*(){}]` param default. #4769 had already admitted a
   *class*-valued default on exactly one precondition — the method must not
   yield, so the value never crosses a suspension — and the #3952 note left the
   generator arm as "a measured, bounded follow-up", declining to admit it on
   lane identity alone. This is that measurement. A **yielding** method still
   takes the host path, and the generator function-expression host keeps its
   blanket bail for the reason recorded there (that lane mishandles element
   defaults with no closure involved at all, so admitting would swap a loud
   leak for a silent wrong value). Both halves are pinned by tests.

#### Neighbourhood regression control — zero pass → non-pass

617 rows: all of `language/expressions/generators`,
`language/statements/generators`, `built-ins/GeneratorPrototype`. The 8
`*array-prototype*` rows poison the realm, so they ran `--isolate`; the other
609 ran in-process, before and after, on both targets.

| lane | before | after | flips |
| --- | --- | --- | --- |
| standalone, 609 in-process | 512 / 56 / 41 | 512 / 56 / 41 | none |
| host (default), 609 in-process | 521 pass / 88 fail | 521 / 88 | none |
| standalone, 8 isolated | 4 pass / 4 CE | **8 pass** | +4, none lost |
| host, 8 isolated | 4 pass / 4 fail | 4 / 4 | none |

Logs: `.tmp/6651/nb-{sa,host}-{before,after}.log`,
`.tmp/6651/nbiso-{sa,host}-{before,after}.log`.

Also green: `npm run -s typecheck`; the 11 generator-adjacent unit suites
(`generators`, `generator-iife`, `generator-method-destructuring`,
`generator-yield-contexts`, `issue-3032`, `issue-3164`, `issue-3302`,
`issue-3386`, `issue-3952`, `issue-4769`, `issue-5255`) — 94/94; and
`tests/equivalence`, 217 of its 218 files (run in small batches — the whole
suite OOMs on this box, and `multi-file-compilation.test.ts` OOMs on its own,
**identically on the base commit**, so it is an environment limit, not a
finding). Equivalence has **22 failing cases, every one of which reproduces on
the base commit** in the clean worktree: `arguments-nested-and-loops` (1),
`array-inline-return` (1), `delete-sentinel` (1), `logical-conditional-identity`
(3), `new-non-constructor` (2), `null-dereference-guards` (5), `reflect-api`
(1), `tdz-reference-error` (6), `yield-as-expression` (1),
`misc-small-patterns` (1). None is attributable here. The last two were
re-checked individually rather than assumed, because both name shapes this
change touches (`yield`; a named function expression's own-name binding).

#### Residual sub-buckets (135 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 74 | `standalone target emitted host imports: env::__gen_*` | see split below |
| 53 | `native generator lowering currently supports only sequential numeric yields … (#680)` | `yield` nested inside an assignment PATTERN |
| 6 | `'yield' is a reserved word …` | decorator-syntax rows; not a generator gap |
| 1 | `fail` — wrong first `value` | `language/expressions/yield/star-in-rltn-expr.js` (was CE) |
| 1 | `fail` — invalid module, `__gen_resume_g` `local.tee` type | `yield-star-before-newline.js`; **pre-existing, byte-identical before and after** |

The 53 `#680` rows plus 37 of the 74 leaks are **one family, 90 rows**:
`[ x = yield ] = vals` / `for ([ {} = yield ] of …)` — a `yield` suspension
*inside* a destructuring-assignment pattern, which `lowerStatements` reaches as
an unmodeled `ExpressionStatement` (17) or `ForOfStatement` (20). **Do not
start here expecting passes:** a host-lane probe of 8 of these rows failed
8/8, so the generator lowering is not their only blocker. (Same probe: 8/8 of
the A1 family and 8/8 of the A2 family passed on the host — which is exactly
why those two were picked first, and it is the cheapest triage available: a
row that fails on the host cannot be made to pass by fixing standalone-only
lowering.)

The other 37 leaks are small, independent gates in
`isNativeGeneratorExpressionShape` / `isNativeGeneratorCandidate`:

| rows | gate |
| ---: | --- |
| 16 | generator function-expression host, ANY closure-valued param default (the `ts.isFunctionExpression(decl)` arm — blocked by that lane's pre-existing plain-numeric-default defect, #3952, which must be fixed first) |
| 9 | named fn-expr whose body references its OWN name (`bodyReferencesOwnName`) — needs the immutable self-name binding, incl. its strict-mode TypeError on reassignment |
| 5 | computed-name generator methods (`{ [k]*(){} }`) — blocked on a stable emitted-name derivation |
| 4 | rest / optional params (2 in the object-method gate, 2 in the fn-expr gate) |
| 2 | `super` or an outer-scope capture in an object-literal method |
| 1 | duplicate method name within one class/object literal |

Method used, for the next owner: `isNativeGeneratorCandidate` /
`buildNativeGeneratorPlan` were temporarily instrumented (every `return
false`/`null` tagged with its line, `fail()` tagged with its caller from the
stack, plus the unmodeled statement's `SyntaxKind` + source text) and the
manifest was run through a **compile-only** probe. That turns "197 compile
errors" into a per-gate histogram in ~8 minutes instead of a 40-minute runner
pass, and it is how the three buckets above were sized before any code changed.
The instrumentation is not committed.

### 2026-09-21 — Cluster B (RegExp Symbol.\* protocol, standalone), slice B1: `String.prototype` @@-dispatch

- **Branch** `issue-6651-cluster-B-regexp`, based on
  `claude/es2015-test262-plan-54tooh` @ `9b1ff0dc`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a35ed687b8f0ef175`.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt`, 147 rows,
  sha256 `f34bba06f50029156d5fb0cf36bb4f7da0c670b8645cdd35136dec9916a90b61`.
- Coordinated against **#5198** (Codex lane): its Slices A–C (observable
  `RegExpExec`/custom `exec`, `lastIndex`, the `flags` getter) and the Annex B
  compile-syntax work are UNTOUCHED here. This slice is #5198's **Slice D**,
  which had no in-flight branch.

| standalone, `--isolate`, 147 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/B-before.log`) | **0** | 136 | 11 |
| after (`.tmp/6651/B-after.log`) | **7** | 129 | 11 |

**+7 rows pass; every one of the other 140 rows keeps its exact status** (the
two logs were joined row-by-row, not just compared by count). No compile_error
became a fail and no fail became a compile_error.

#### What changed, and why the previous answer was wrong rather than missing

One new module, `src/codegen/string-symbol-protocol.ts`, plus a 10-line
dispatch site in `call-receiver-method.ts`. No new host import — the probe is
built from natives the object runtime already exports (`__extern_get`,
`__box_symbol`, `__typeof_function`, `__objvec_new/push`, `__apply_closure`).

§22.1.3 step 2 of `match`/`replace`/`search`/`split` is
`GetMethod(searchValue, @@<protocol>)`, and `string-search-value.ts` (#4016)
answered it **statically**, with
`ctx.oracle.wellKnownSymbolMemberOf(v, protocol) === false`. That proof is
exact for a primitive and for a builtin RegExp, and **unsound for an ordinary
object** — the idiom the step exists for installs the method *after* the object
is created (`var regexp = {}; regexp[Symbol.search] = f`), where no declared
type can see it. So the old lowering took the step-3 lane instead and ran
`RegExpCreate(ToString(regexp))`, i.e. the pattern `"[object Object]"`. The
four `cstm-*-invocation` rows therefore reported
`TypeError: Unsupported dynamic regular expression pattern`, **which reads like
a missing engine feature and was actually the compiler stringifying a value it
was required to call.** That is the reason this bucket was worth taking before
the much larger `exec`-protocol buckets: it was mis-signposted, not merely
unimplemented.

Two things the implementation had to get right, both measured rather than
assumed:

1. **The gate must admit `{kind:"class"}`, not just `{kind:"object"}.** test262
   rows are **JS**, so TypeScript's expando inference gives `var regexp = {}` an
   anonymous type whose symbol carries the VARIABLE's name — and `factOfType`
   reports `{kind:"class", name:"regexp"}`. The first cut gated on `object`
   alone: it compiled and fired under a hand-written `.ts` probe and **never
   fired under the runner**, so the focused 17-row slice came back
   byte-identical. The `.ts` probe alone would have shipped a no-op.
2. **The probe must not leak its `externref` carrier into a typed consumer.**
   The branch's result type is externref (the protocol method may return
   anything), while the fall-through arm produces the native carrier —
   `const parts: string[] = "a,b".split(sep)` is the shape that catches a leak,
   because it compiles green and fails at `WebAssembly.instantiate`. It is
   pinned as a control. (A first attempt at that control used a dynamic
   symbol-keyed assignment and hit a **pre-existing, unrelated** invalid-module
   bug — `local.set expected (ref null 6), found (ref null 46)` — reproduced
   byte-identically on the base commit by a one-`cp` revert, so it is not
   attributable here and the control was rewritten.)

Both arms are re-emitted from the same AST, so the gate additionally requires
the receiver, search value and extra argument to be **re-evaluable without
observable effect** (identifier / `this` / literal). A computed operand keeps
the previous behaviour rather than risking a doubled side effect.

#### Neighbourhood regression control — zero pass → non-pass

The blast radius is provably bounded: the hook can only fire on a
`String.prototype.{match,replace,search,split}` call. The full 2,280-row
`built-ins/RegExp/**` + `annexB/built-ins/RegExp/**` +
`built-ins/String/prototype/{match,matchAll,replace,replaceAll,search,split}/**`
sweep was therefore filtered to the **512 rows whose source contains such a
call or a `[Symbol.<protocol>]` reference** — sound because none of the 2,280
rows includes one of the three harness files that call those methods
(`iteratorZipUtils`, `temporalHelpers`, `testIntl`), checked rather than
assumed. Run in 128-row chunks, one fresh process each: the single 2,280-row
in-process run **OOMs** at ~8 GB after ~27 min, which is a property of the
runner, not a finding.

| lane | rows | before | after | flips |
| --- | ---: | ---: | ---: | --- |
| standalone (`.tmp/6651/nbr-{before,after}.tsv`) | 512 | 161 non-pass | **154 non-pass** | the 7 target rows only; **0 regressions** |
| host — compiled-binary sha256 of 7 representative programs | 7 | — | — | **all 7 byte-identical** (`.tmp/6651/hostsha-{before,after}.txt`) |
| standalone — same 7 programs | 7 | — | — | **6 byte-identical**; only `split-object` differs, which is the admitted shape |

The host lane is byte-identical by construction too — `noJsHost(ctx)` is the
probe's first condition — but the sha comparison is the evidence, not the
argument.

Also green: `npm run -s typecheck`; the five ratchet gates
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); `scripts/equivalence-gate.mjs`
(22 failing / 1720 passing, all 22 in the committed baseline — no new
regressions); and the new pin suite
`tests/issue-6651-string-symbol-protocol.test.ts`, 9/9.

#### Residual sub-buckets (140 rows), with signatures

| rows | signature | owner / what it needs |
| ---: | --- | --- |
| 44 | `Expected a Test262Error … no exception` / `… but got a TypeError` | the observable **`RegExpExec`** substrate — `Get(R,"exec")`, call a callable override, propagate its abrupt completion. **#5198 Slice B** (draft PR #5393). Do not start here. |
| 18 | `Method called on incompatible receiver (RegExp brand check failed)` | `RegExp.prototype[@@x].call(plainObjWithExec, …)` is spec-legal; widening `recoverRegExpStructFromExternref` only helps once the row can then run a user `exec`, so it is **downstream of Slice B**, not independent. |
| 8 | `Expected a TypeError … no exception` | same family, TypeError-shaped assertions |
| 7 | `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | **environment, not the compiler** — the 7 `*/cross-realm.js` + `proto-from-ctor-realm.js` rows need a built QuickJS provider in this container. Unmeasurable here; #5198 records them failing on host too. |
| 7 | CE `standalone target emitted host imports: env::Object_set_constructor` | 6 of 7 are `Symbol.split/species-ctor*` — `SpeciesConstructor` needs a `constructor` write on a plain object. #5198 Slice C4/E. |
| 5 | `flags` coercion (`built-ins/RegExp/prototype/flags/coercion-*`) | the **generic** `flags` getter: accept any Object, ordered `ToBoolean(Get(R, …))`. #5198 **Slice F**; fails on host too. |
| 4 | `Unsupported dynamic regular expression pattern` | the runtime pattern compiler. 2 are the `cstm-*-is-null` rows, which reach the ToString lane correctly now and then need `\d` from `__regex_compile_dynamic_simple`. |
| 3 | CE `… does not support String.prototype.match with dynamic RegExp flags` | `@@match` must read flags at RUNTIME. #5198 Slice C2. |
| 3 | `Expected true but got false` at `assert.notSameValue(originalSearch, undefined)` | `invoke-builtin-{search,match}*` — needs `RegExp.prototype[@@x]` to be a **reified, replaceable** method object, so the step-3 RegExp lane dispatches through it. Strictly harder than this slice. |
| 1 | CE, `String.prototype.replace/cstm-replace-get-err.js` | reachable and **deliberately left**: `"".replace(poisoned)` has ONE argument, and `tryCompileStandaloneStringValueReplace` requires exactly two, so the fall-through arm cannot lower and the `#1474` refusal is still reported. The fix is to admit an absent `replaceValue` as the literal `"undefined"` (§22.1.3.19 step 3) — a separate behaviour change for one row, which would have invalidated this slice's measured after-state. |
| 40 | assorted `Expected SameValue(…)` | per-method result-shape and cursor residuals across `@@replace` (30 rows), `@@split` (30), `@@match` (23), `@@search` (13) — #5198 Slices C1–C4. |

### 2026-09-21 — Cluster C (class / object-literal / `super`, standalone), slice C1

- **Branch** `worktree-agent-a27d2e622e3791fde`, based on
  `claude/es2015-test262-plan-54tooh` @ `9b1ff0dc` (origin/main + plan +
  cluster A merged). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a27d2e622e3791fde`.
- **Manifest** `plan/agent-context/6651/C-class-object-super.txt`, 177 rows,
  sha256 `785dd45d78a609ecefc58377433fd144a142423557001a9b513cf1ae1492ad8d`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/C-before.log`) | 0 | 173 | 4 |
| after (`.tmp/6651/C-after.log`) | 0 | 173 | 4 |

**No row flipped to pass in this slice, and no row regressed.** The plan's own
census said 171 fail / 6 CE; this branch's base measures 173 / 4 — quote the
measured numbers, not the census. Seven rows moved to a LATER assertion and are
recorded below as a narrower residual; nothing else in the log changed except
two byte-offset numbers inside pre-existing `CompileError` texts.

#### What landed — §20.5.1.1 step 3 and the error-subclass prototype edge

Two defects, both reproduced with probes on the base tree before any edit.

1. **`new Err()` on `class Err extends TypeError {}` had an own `message`.**
   A direct `new TypeError()` lowers with `argCount === 0`, so the constructor
   stores `ref.null.extern` in `$Error_struct` field 1 and the own-property
   surfaces correctly report absence. The derived subclass goes through a
   FIXED-ARITY forwarder (`Err_new : (externref) -> externref`), so `new Err()`
   pads slot 0 with the canonical `undefined` singleton (`global.get
   $undefined`, WAT-verified) — a non-null value, so the same field said
   "present". The fix is in the CONSTRUCTOR, not the forwarder: passing
   `undefined` to `super()` is exactly what the default derived constructor
   does (§15.7.14), so the value is right and §20.5.1.1 step 3 is the step that
   must ignore it.
   Load-bearing detail: the test could NOT be built where the constructor body
   is built. `$AnyValue` — the carrier the `undefined` singleton lives in — is
   not reserved yet when the standalone scaffold emits `__new_TypeError`, so
   the first cut silently degraded to the bare `local.get 0` it was meant to
   replace (WAT-verified, and the probe that "passed" did so for an unrelated
   reason). It is now recorded at emit time and woven in at FINALIZE
   (`fillErrorCtorUndefinedMessage`), which is why the change needs a context
   field and two call sites in `index.ts`.
2. **An error-subclass instance inherited NOTHING from its own class
   prototype.** Measured (`.tmp/w6651C/e4.ts`): `Err.prototype["tag"+"x"]`
   answers `"T"`, `new Err()["tag"+"x"]` answers `undefined`, and the same
   shape on a PLAIN class answers `"Y"`. So the carrier, the write and the
   ordinary class rule all worked; the one missing edge was instance →
   subclass prototype for the `$Error_struct` representation.
   `emitStandaloneClassProtoObject` declines for a class with a builtin parent,
   so there is no `$Object` proto link to walk; the instance's identity lives
   in `$userClassId` (fieldIdx 4). The new leaf module
   `src/codegen/error-subclass-proto-chain.ts` turns that brand back into the
   class's prototype global and delegates the lookup — including the rest of
   the chain — to `__extern_get` on the carrier. `message` additionally stops
   answering from a NULL field in both `__extern_get` and the own-property
   arms, so presence and value cannot disagree.

Files: `src/codegen/error-subclass-proto-chain.ts` (new),
`src/codegen/registry/error-types.ts`,
`src/runtime/wasmgc/values/error-bodies.ts`, plus the context field and the two
finalize call sites. Pin `tests/issue-6651-error-undefined-message.test.ts` —
4 cases, **2 verified RED on the base tree** (base 6 → 7, base 4 → 7), 2 are
guards green on both sides (an explicit `undefined` argument; a plain builtin
error's message/name/throw-catch round trip).

#### Controls — zero pass → non-pass

| set | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| manifest, `--isolate` | 177 | 0 / 173 / 4 | 0 / 173 / 4 | none |
| `built-ins/Error/**` + `built-ins/NativeErrors/**`, in-process | 187 | 132 pass / 46 fail / 9 CE | 132 / 46 / 9 | **identical non-pass set** |
| `class/subclass` + `expressions/super` + `statements/try` + `AggregateError`, in-process, 4 chunks | 429 | 316 pass / 111 fail / 2 CE | 316 / 111 / 2 | **identical non-pass set** |

Logs: `.tmp/6651/C-{before,after}.log`, `.tmp/6651/ctlerr-{before,after}.log`,
`.tmp/6651/ctlcls-{before,after}-0*.log`. The 429-row set had to be run in
110-row chunks: the whole list in one in-process run dies with an empty log
(exit 1, zero bytes), which is the realm-contamination hazard the runner header
documents.

**Host (gc) control is a byte-identity proof, not a sample.** Every arm is
gated on `ctx.targetProfile.semanticProviders === "native-first"`, so host
output cannot move: an 11-program corpus (the playground example plus ten
probe modules, several of them error-heavy) compiles **byte-identically on gc,
11/11 sha256 equal**, while 9 of the 11 standalone binaries change — exactly
the intended delta (`.tmp/6651/bytes-{before,after}.txt`). The later extraction
of the ladder into its own module was separately proven byte-neutral (22/22
identical across both targets).

Gates, run bare: loc-budget and func-budget PASS with the grants added to this
file's frontmatter above (`context/types.ts` +7, `index.ts` +3 / +1 / +1 —
everything else moved into leaf modules; extracting the ladder is what took
`fillExternGetErrorProps` back under its 300-LOC ceiling); coercion-sites,
oracle-ratchet (`getTypeAtLocation` +0, `ctx.checker` +0), dead-exports,
typecheck, compiler-boundaries `--mode inventory` (the new module is classified
in `scripts/compiler-boundaries.json`), prettier and
`biome lint --diagnostic-level=error` all 0. `node scripts/equivalence-gate.mjs`:
**22 failing / 1720 passing, all 22 already in the baseline — no new
equivalence regressions.**

#### Residuals — what the other 177 rows are, measured

The seven rows this slice moved are the `NativeError/{Eval,Range,Reference,
Syntax,Type,URI}Error-message.js` family plus
`Error/message-property-assignment.js`. They now fail one assertion LATER:
`err2.hasOwnProperty('message')` passes, and they stop at
`assert.sameValue(err2.message, 'custom-…')`. The remaining blocker is
**MODULE-scope**, and it is a third, independent defect: with the class and the
prototype write at module top level — which is what the honest harness
assembly compiles, since the test body is NOT wrapped in a function there —
`Err.prototype.message = "custom"` does not land where the dynamic read looks
(`.tmp/w6651C/e9.ts`: 1 of 4, where the same program inside a function answers
4 of 4). That is a prototype-WRITE placement bug at module scope, not a read or
a construction bug, and it is the next thing to fix for this family.

Bucketed before-state of the whole manifest, by signature:

| rows | signature | mechanism |
| ---: | --- | --- |
| 10 | `SameValue(«0», «false»)` — `*/dflt-params-arg-val-not-undefined.js` | a method parameter with a numeric default is lowered as `f64`, so an explicitly passed `false` / `''` / `null` arrives as `0`. TS infers the parameter type from its initializer; in JS there is no type. A type-lowering question, not a class one. |
| 10 | `Cannot destructure 'null' or 'undefined'` — `*/gen-meth-ary-ptrn-elem-ary-empty-init.js` | generator-method destructuring; cluster A's lane, deliberately not built here |
| 8 | `SameValue(«NaN», «undefined»)` — `*/dstr/*-dflt-obj-ptrn-prop-ary.js` | same f64-typed-slot defect as the 10 above, one level inside a nested destructuring default |
| 9 | `Cannot access property on null or undefined` | mixed |
| 8 | `Expected a TypeError … no exception` | scattered singletons (`constructable-but-no-prototype`, `invalid-extends`, `methods-restricted-properties`, `prototype-setter`, `name-binding/const`, `arguments-callee`, `Proxy/no-prototype-throws`, `Symbol/new-symbol-with-super-throws`) — no shared lever |
| 6 | `SameValue(«"undefined"», «"object"»)` / `«null», «"a"»` — `expressions/super/prop-{dot,expr}-cls-{val,val-from-arrow,this-uninit}.js` | see the #2818 finding below |
| 5 | `quickjs provider is not built` | environment only; unmeasurable in this container |
| ~20 | `gen-method` / `decorator` shaped | measured, not built — cluster A's base |

#### Two localised findings the next lane should not have to re-derive

Both were reproduced with probes, both are REAL, and **neither moves a single
test262 row** — which is why this slice does not ship either of them. They are
recorded because each cost real measurement to localise and each looks like an
obvious lever until it is measured.

1. **A class declared inside a BLOCK whose method writes a captured
   function-scoped `var` drops the write.** `.tmp/w6651C/q31.ts`, ten lines, no
   `super`: `function test(){ var n=0; if(1){ class C{ m(){ n=5; } } new C().m(); } return n; }`
   answers **0**, node answers 5. The emitted `$C_m` declares `(local $n f64)`
   and stores into it; move the same class to function-body level and the
   method stores into the promoted `__captured_n` global and the answer is 5.
   Root cause: `collectBlockScopedDeclNames` (`src/codegen/declarations.ts`)
   collects only `let`/`const`, on the premise that "a `var` is function-scoped
   and therefore already a module global" — true at module scope, false inside
   a function, which is the only place that function is ever called from.
   Collecting `var` there fixes it (verified), and a `let` in the same shape
   already works.
   **Why it is not shipped: it flips ZERO test262 rows.** The test262 wrapper
   HOISTS every initialised test-body `var` to module scope as a `let`, and —
   more decisively — the standalone lane is scored on the honest
   whole-assembly harness, which does not wrap the body in a function at all.
   The #5350 lane recorded this same defect as "the single largest blocker" for
   the `super/prop-*-cls-val` family; measured against the harness assembly the
   rows those tests actually run, it is not their blocker.
2. **The #2818 standalone carve-out that keeps every DERIVED class eager is no
   longer paying for itself.** `classDeclCapturesNames` returns false for any
   `extends` clause under standalone, citing 6 rows that regressed when derived
   capturers were deferred. Disabling the carve-out and running those 6 named
   rows plus 14 related class/super rows gives an **identical 2 pass / 18 fail**
   on both sides (`.tmp/6651/ctl-{base,fix2}.log`) — the 8 Iterator
   `return-is-forwarded` rows now fail for an unrelated reason
   (`called value is not a function`). So the carve-out can probably be
   retired, but retiring it alone also flips zero rows, for the same
   harness-shape reason as finding 1.

The honest lesson for the next owner of this cluster: **probe against the
ORIGINAL-HARNESS assembly, not against a hand-written `export function test()`.**
`assembleOriginalHarness(source, meta).primary.source` is three lines of driver
(`.tmp/w6651C/harness.mts`) and it puts the test body at MODULE scope, where
several of this cluster's defects live and where a function-scoped probe cannot
see them. Most of this slice's investigation time went into a defect that
only exists in the function-scoped shape.

### 2026-09-21 — Cluster F (Proxy / Reflect, standalone), slice F1: the discarded booleans

- **Branch** `issue-6651-cluster-F-proxy-reflect`, based on
  `claude/es2015-test262-plan-54tooh` @ `a68e20f7`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a883e5b95a1723f67`.
- **Manifest** `plan/agent-context/6651/F-proxy-reflect.txt`, 89 rows, sha256
  `3edd7052b503ee48f0022a8bc2f5c041a116228d19ef65d31bf2aeb54cf80dd7`.

| standalone, `--isolate`, 89 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/F-before.log`) | **0** | 84 | 5 |
| after (`.tmp/6651/F-after.log`) | **7** | 77 | 5 |

**+7 rows pass; every other row keeps its exact status** (the two logs were
joined per path, not compared by count). No compile_error became a fail and no
fail became a compile_error.

**23 of the 89 rows are environment-unmeasurable in this container** —
`*-realm*` / `cross-realm`, which need `$262.createRealm` and the QuickJS eval
provider (`JS2WASM_EVAL_ENGINE=quickjs … provider is not built`). They were
measured, not assumed, and they fail identically before and after, so the delta
is comparable; their absolute cause mix is not CI-comparable. The honest
denominator for this slice is therefore **66 rows, of which 7 now pass.**

#### Triage method — the whole 66-row measurable set was probed on the HOST lane first

Cluster A's cheapest-triage rule, applied to every measurable row rather than 8
per bucket (same order of cost, complete answer): **32 of 66 PASS on the default
target**, so those are standalone-only lowering gaps and are reachable; 14 fail
on host too and need work in both lanes; 16 answer `error` on host (the row
kills its own child process). Every row this slice converted is in the host-pass
set. Log: `.tmp/6651/F-host-before.tsv`.

#### What changed — three discarded values and one fold that outranked a write

Each of the first three is a value the runtime had **already computed correctly**
and the call site then threw away. None is a new mechanism; two of them overturn
a comment that had gone stale, which is why they were mis-signposted as "not
implemented" rather than "not read".

1. **`Reflect.setPrototypeOf` always answered `true`** (`call-namespace-static.ts`).
   The arm's own "KNOWN LIMITATION" said `__object_setPrototypeOf` has no failure
   channel. **Stale:** #5148 cluster 2b built one — `__object_setPrototypeOf_status`,
   a pure §10.1.2.1 predicate that performs no write and answers a permissive 1
   for every receiver the writer does not own. The answer is now the conjunction
   of that ordinary bit with `__is_truthy(writer result)`, which for a `$Proxy`
   receiver IS the §10.5.2 trap's boolean (the writer's proxy front guard returns
   it instead of the obj) and for an ordinary receiver is the always-truthy obj.
   Reading a booleanish trap result through `__is_truthy` is the same rule the
   neighbouring `Reflect.defineProperty` arm already applies.
2. **`Reflect.preventExtensions` did `drop; i32.const 1`** over a result whose
   `$Proxy` front guard had already computed the §10.5.4 trap's `false`.
3. **`Reflect.ownKeys` dropped SYMBOL keys.** The arm's comment claimed "the
   native runtime does not retain symbol-keyed properties yet". **Also stale:**
   it retains them, and `Object.getOwnPropertySymbols` already read them back
   with correct identity on base (measured: `ownKeys(o).length === 1` while
   `getOwnPropertySymbols(o).length === 1` on the same object). The two lists
   were simply never joined — §10.1.11.1 step 4. A `$Proxy` receiver is
   **excluded**, and that exclusion is load-bearing: `__getOwnPropertyNames`'s
   proxy front guard returns the `ownKeys` TRAP's own array, which the spec
   requires be returned as-is and which the caller still holds; appending to it
   would both mutate a user array and report keys the trap did not.
4. **`Object.getPrototypeOf` folded from the DECLARATION even when the module
   writes that binding's prototype** (`object-get-prototype-of.ts`). Measured on
   base: `var o = {}; Reflect.setPrototypeOf(o, proto)` made the inherited read
   `o.tag` resolve through `proto` — the write was already correct — while
   `Object.getPrototypeOf(o)` still answered `%Object.prototype%`. One object,
   one link, two answers. Same unsoundness #5270 step 2 recognised for
   `{ __proto__: v }`; the only difference is that the write is a statement.

Two things the fix for (4) had to get right, both measured rather than assumed:

- **It must ROUTE, not decline.** A decline in the two literal folds falls
  through to the CLASS arm, which re-folds to the compile-time prototype
  singleton — measured: the decline alone moved nothing for the JS shape. The
  check therefore claims the expression ahead of every fold and emits the
  generic `__getPrototypeOf`.
- **`ctx.dynamicProtoLiteralNodes` is NOT the fact this reader needs.** That set
  is populated by `markReceiver`, whose first branch is
  `ctx.oracle.typeFactOf(recv).kind === "class"` — and test262 rows are **JS**,
  where expando inference gives `var o = {}` an anonymous type whose symbol
  carries the VARIABLE's name, so the fact reads `{kind:"class", name:"o"}` and
  the function returns before recording the literal. (Cluster B hit the same
  trap from the other side.) A small per-`SourceFile` scan of
  `setPrototypeOf` / `__proto__ =` receiver NAMES supplies it instead, narrowed
  to bindings whose declaration is a plain object literal — the one carrier
  whose runtime answer is verified equivalent to the fold it replaces (an unset
  `$proto` reads back as `%Object.prototype%`, checked with a probe because the
  whole "a REFUSED set leaves Object.prototype" family depends on it).

#### The regression the sweep caught, and no probe did

The first cut regressed `Reflect/setPrototypeOf/return-true-if-proto-is-current.js`
pass → fail. §10.1.2.1 step 2 (SameValue → `true`) runs BEFORE the step-3
extensibility refusal, and the status native compares the two ENCODED `$proto`
references — an ordinary object's `%Object.prototype%` terminal is encoded as a
NULL field. So `Reflect.setPrototypeOf(o, Object.prototype)` on a non-extensible
ordinary `o` looked like "a different prototype" and took the refusal. The fix
asks the reader that already models the implicit terminal (`__getPrototypeOf`),
and **only when the status bit is 0** — so a live `$Proxy` never sees an extra
`getPrototypeOf` trap call, because the status native answers a permissive 1 for
exactly the set of receivers that contains proxies. Twelve probes were green at
the moment that regression existed; only the before/after row run saw it.

#### Neighbourhood regression control — zero pass → non-pass

Run in 128-row chunks, one fresh process per chunk (the runner OOMs on
>~500-row in-process sweeps — a property of the runner, not a finding). Base
measured with the file-copy A/B revert, branch measured with the exact sources
committed here (verified by re-deriving the same compiled shas).

| lane | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| `built-ins/Proxy/**` + `built-ins/Reflect/**`, standalone (`.tmp/6651/nb-pr-{before,after}.tsv`) | 464 | 355 / 104 / 5 | **362** / 97 / 5 | +7, **0 lost** |
| `built-ins/Object/{getPrototypeOf,setPrototypeOf,getOwnPropertyNames,getOwnPropertySymbols,preventExtensions,isExtensible,keys}/**`, standalone (`.tmp/6651/nb-obj-{before,after}.tsv`) | 245 | 220 / 24 / 1 | 220 / 24 / 1 | **none** |

**Host (gc) control is a byte-identity proof.** Both edits are lane-gated (the
Reflect arm on `targetProfile.semanticProviders === "native-first"`, the
getPrototypeOf route on `ctx.standalone || ctx.wasi`), so the honest control is
that host output cannot move: 8 representative programs — a Proxy/Reflect-free
control, the three changed shapes, a `delete`-through-proxy module, a
proxy-in-the-prototype-chain module and two integrity modules — are
**8/8 byte-identical on gc** before vs after (`.tmp/6651/sha-{before,after}.txt`).
On standalone the same corpus shows exactly the intended delta: the 5 programs
that exercise a changed arm move, the other 3 are byte-identical.

Also green, all run bare: `npm run -s typecheck`; the five ratchet gates
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); `node scripts/equivalence-gate.mjs`
(22 failing / 1720 passing, all 22 in the committed baseline — no new
regressions); `biome lint --diagnostic-level=error`; and the new pin file
`tests/issue-6651-cluster-f-proxy-reflect.test.ts`, 9/9 — **5 of the 9 verified
RED on the base commit** and 4 are guards that are green on both sides
(including the two negative directions: a legal `setPrototypeOf` still answers
`true`, and an untouched literal binding keeps the `%Object.prototype%` fold).

#### Residual sub-buckets (82 rows), with signatures

| rows | status | sub-bucket | what it needs |
| ---: | --- | --- | --- |
| 23 | fail | `*-realm*` / `cross-realm` | **environment, not the compiler** — `$262.createRealm` + a built QuickJS provider. Unmeasurable in this container. |
| 24 | fail | `*-target-is-proxy.js` (every trap) | nested-proxy forwarding over EXOTIC targets — an array's `length`, `new String("str")`'s non-configurable `length`, a RegExp's `lastIndex`, a function's `prototype`. Each row asserts across several such targets, so the rows/fix ratio is poor; 6 of the 24 also fail on host. |
| 7 | fail | `has/call-in-prototype*`, `has/call-object-create`, `set/call-parameters-prototype*`, `defineProperty/call-parameters` — "handler is the trap context" | **a proxy reached through the PROTOTYPE CHAIN never runs its trap.** Probed directly: `Object.create(proxy)` resolves the proxy to its TARGET as the prototype, so a trapless proxy gives correct ordinary answers and a trapped one is invisible (`Object.getPrototypeOf(heir) === p` is false; the `get`/`set`/`has` traps run ZERO times). The trap `this` IS the handler on the direct path — that half is correct. The blocker is architectural: `$Object.$proto` is typed `ref null $Object` and `$Proxy` is not a subtype, so the chain cannot hold a proxy at all. |
| 4 | fail | `Proxy/construct/{call-parameters-new-target,trap-is-null,trap-is-undefined,trap-is-undefined-no-property}` | `Reflect.construct(P, args, NT)` on a proxy target passes **the proxy itself** as NewTarget (`native-construct.ts`: "Ordinary `new proxy(...)` uses the proxy itself as NewTarget"), and the trap-absent forward re-enters the driver, which passes the INNER proxy. `__proxy_construct_dispatch` already takes newTarget as its third parameter, so the dispatch is right and the two call sites are wrong. **Deliberately not taken here:** #3371 is in-progress in another lane and owns `Reflect.construct` + NewTarget end-to-end (`reflect-construct-newtarget.ts`); threading a second NewTarget channel through the same arm would duplicate it. All 4 pass on host. |
| 3 | CE | `Proxy/construct/*-target-is-proxy` | the same NewTarget channel plus `class MyArray extends Array` — strictly harder than the 4 above. |
| 4 | fail | `deleteProperty` family + `Reflect/deleteProperty/delete-properties` | `delete` does not actually remove the entry: probed on base, `Reflect.deleteProperty(o,'prop')` returns `true` while `o.hasOwnProperty('prop')` stays `true` and `o.prop` is still 42. A tombstone/closed-struct gap (#4745), not a proxy gap. |
| 4 | fail | `getOwnPropertyDescriptor/*` — "X should be an own property" | the gOPD trap-absent forward over exotic targets; 3 of 4 fail on host too. |
| 1 | fail | `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js` | **localised, not mysterious:** `Object.preventExtensions` records non-extensibility in the integrity BAG for a carrier that is not an `$Object`, and `__object_setPrototypeOf_status` returns a permissive 1 for exactly those carriers, so the refusal is invisible. The TS shape (`const o: any = {}`) already answers `false`; only the JS `var o = {}` carrier does not. Fixing it means teaching the status native to consult `__object_isExtensible` — which would be a no-op, since the same non-`$Object` test makes it return 1 first. The real fix is carrier promotion, in the integrity subsystem. |
| 2 | fail | `Reflect/ownKeys/{order-after-define-property,return-on-corresponding-order-large-index}` | **both moved to a narrower failure in this slice.** The symbol half of `order-after-define-property` now passes; it fails on a `new String("")` wrapper, whose exotic `length` is pushed at the END of `__getOwnPropertyNames` where §10.1.11.1 wants it in creation order (before later string keys). The large-index row needs `4294967294` classified as an array index and `12345678900` as a string key. |
| 10 | fail/CE | singletons | `Reflect.apply(fn, null, null)` must throw (CreateListFromArrayLike), `Reflect.construct(<non-ctor>, [])` must throw (IsConstructor on the TARGET — the newTarget check exists, the target check does not), `Reflect.hasOwnProperty` CE, `Proxy/getPrototypeOf/not-extensible-same-proto` invariant, `Proxy/enumerate`, `Proxy/set/trap-is-null-receiver`, and the `Proxy/apply/*-target-is-proxy` pair. |

**Not started in this slice, and why:** the two largest measurable buckets are
the 24 nested-proxy-over-exotic-target rows (many mechanisms per row) and the
7 prototype-chain rows (blocked on `$Object.$proto` being unable to hold a
`$Proxy` — a type-graph change, not a call-site one). The 4+3 `construct` rows
are a single, clean mechanism but sit inside #3371's active surface.

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E1

- **Branch** `worktree-agent-aa1dfb3d978fd9ede`, base `claude/es2015-test262-plan-54tooh`
  (`16a99c21`, i.e. origin/main + plan + cluster D). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-aa1dfb3d978fd9ede`.
- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt` (144 rows),
  `--standalone --isolate`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/E-before.log`) | 0 | 143 | 1 |
  | after (`.tmp/6651/E-after.log`) | **13** | 130 | 1 |

  Per-row set diff: **13 non-pass → pass, 0 pass → non-pass.**

- **What landed — four seams, each a spec step the standalone lane skipped.**
  1. **Arity-0 array HOFs (6 rows).** `closed-method-dispatch.ts` gated its
     native `__hof_<m>` arm on `arity >= 1`, so `sample.every()` fell to the
     open-`$Object` bottom arm, where `__extern_method_call` answers `undefined`
     for a vec brand — a NORMAL RETURN where §23.1.3.x step 3 requires
     `IsCallable(undefined)` → TypeError. The arm now admits arity 0 and feeds
     the canonical `undefined` as the callback, so the helper's own IsCallable
     gate raises it. Not typed-array specific: `[1,2].every()` on an `any`
     receiver was equally silent.
  2. **`sort` comparefn (1 row).** `__arrprod_sort` treated a non-callable
     comparefn as "no comparator". §23.1.3.30 step 1 makes a PRESENT,
     non-`undefined`, non-callable one a TypeError. Absent vs explicit is told
     apart by the args vec's own length, so `sort()` / `sort(undefined)` keep
     the default order while `sort(null)` throws.
  3. **`ArrayBuffer.isView` carrier set (3 rows).** Two errors in one chain:
     the DYNAMIC view brand `$__ta_dyn_view` was absent (so every
     `testWithTypedArrayConstructors` sample read as NOT a view), and the
     ArrayBuffer's own `$__vec_i32_byte` backing carrier was PRESENT (so a
     buffer read as a view). §25.1.4.1 is `[[ViewedArrayBuffer]]`, which the
     buffer does not have.
  4. **Symbol window arguments on a dynamic view (4 rows).** `slice`/`subarray`
     compile their index args in `{kind:"f64"}` context, where a Symbol (an i32
     id) coerces SILENTLY to 0; §7.1.4 step 3 makes it a TypeError. Reuses the
     existing `emitSymbolIndexArgThrow` gate (`fill`/`copyWithin` precedent),
     positions 0 and 1, `map`/`filter` excluded (their position 0 is a
     callback).

- **Neighbourhood control** — 2,266 rows, `--standalone`, before vs after
  (`.tmp/6651/chunks-{before,after}/`): all of `built-ins/ArrayBuffer/**`,
  `built-ins/DataView/**`, `built-ins/TypedArray/**`, plus the
  callback/comparator rows of `built-ins/Array/prototype/{every,some,forEach,
  reduce,reduceRight,map,filter,find,findIndex,sort}` (the arity-0 arm is not
  typed-array specific). pass **1433 → 1456**, fail 770 → 747, compile_error
  62 → 62. Per-row set diff: **0 pass → non-pass**, 23 non-pass → pass — the
  13 manifest rows plus their 10 `BigInt/` twins, which are outside the ES2015
  manifest.
  - Runner note: the single 2,266-row in-process run DIED at exit 1 with an
    EMPTY log (the realm-poisoning death the runner header documents) and two
    200-row chunks exhausted the V8 heap. Both sides are therefore run in
    identical 200-row chunks, with one 50-row sub-chunk (`c10s2`) run
    `--isolate` on both sides. Chunking is what makes a crash cost its own
    rows instead of the whole measurement.
- **Host (gc) lane**: every seam is standalone-gated, so the control is a
  sha256 byte comparison of 8 compiled programs (zero-arg and callback HOF,
  dyn `sort` with and without a comparator, `isView` direct and as a
  first-class value, TypedArray `slice`/`subarray`) — **all 8 host binaries
  byte-identical** (`.tmp/6651/hostbytes-{before,after}.txt`). On standalone the
  same corpus shows exactly the intended delta: the five programs that touch a
  changed seam differ, the three that do not are byte-identical
  (`.tmp/6651/sabytes-{before,after}.txt`).
- **Unit tests**: new `tests/issue-6651-e-typedarray.test.ts` (9 cases — the
  four seams plus their negative controls: a callable HOF still runs, an
  absent/undefined/callable comparator still sorts, an ordinary numeric
  `slice`/`subarray` window still works).
- **Gates**: loc-budget passes with the three god-file grants added to this
  file's frontmatter (+15 / +14 / +3, each a single arm spliced into an
  existing ladder); func-budget, coercion-sites, oracle-ratchet, dead-exports
  and `scripts/equivalence-gate.mjs` (22 known failures, no new) all pass.

**Residual sub-buckets (130 fail + 1 CE on the manifest), with signatures:**

| rows | status | sub-bucket | why it is still open |
| ---: | --- | --- | --- |
| 22 | fail | every `$DETACHBUFFER` row — `JS2WASM_EVAL_ENGINE=quickjs … provider is not built` | ENVIRONMENT ONLY, and it is the whole detached-buffer cohort (`{every,some,forEach,reduce,reduceRight}/callbackfn-detachbuffer`, `fill/coerced-*-detach`, `copyWithin/coerced-values-*`, `{join,toString,toLocaleString,subarray}/detached-buffer`, `from/*-mapper-detaches-result`, `sort/sort-tonumber`, two `proto-from-ctor-realm`). The `$262` shim pulls the runtime-eval seam and the QuickJS artifact is not built in this container, so these rows are **unverifiable locally** — they were never measured either way here |
| 9 | fail | `Object.prototype.toString is not yet implemented in --target standalone` | #4119, owned by cluster H — `ArrayBuffer/newtarget-prototype-is-not-object`, `ArrayBuffer/prototype/slice/species-*`, `ctors/{no-species,length-arg/toindex-length}`, `ctors/typedarray-arg/same-ctor-buffer-ctor-species-*` |
| 9 | fail | `TypedArray.from` iterator/array-like error propagation — `Expected a Test262Error but got a TypeError` | the `from` pipeline turns a user abrupt completion into its own TypeError (`from/{arylk-get-length,arylk-to-length,iter-access,iter-invoke,iter-next,iter-next-value}-error`) |
| 7 | fail | `TypedArrayConstructors/{from,of}` statics | `%TypedArray%.{from,of}` is not inherited by the concrete constructors, and the custom-`this` forms are unimplemented (`inherited.js` reads `undefined`; `custom-ctor*.js` / `new-instance-using-custom-ctor.js` read `undefined.call`) |
| 5 | fail | `ctors/object-arg/throws-setting-obj-*` — ToNumber(element) of a typed array with an own `valueOf`/`toString`/`@@toPrimitive` expando | ROOT-CAUSED, not fixed: `__to_primitive` reduces any `$__vec_base` subtype through `Array.prototype.toString`, so OrdinaryToPrimitive never runs. A dyn-view arm in `__to_primitive` DOES fix it for a dynamically-constructed view (measured: `Number(v)` with a throwing `valueOf` expando propagates), but these rows build the sample as a STATIC `new Int8Array(1)`, whose carrier has no expando side-table for `__extern_get` to find — so the arm gains 0 measured rows and was reverted rather than shipped unmeasured. The blocking gap is the static carrier's expando table, not ToPrimitive |
| 5 | fail | `ctors/object-arg/iterator-*` + `iterating-throws` + `iterator-is-null-as-array-like` | the ctor argument is `var obj = function () {}` — a CALLABLE. It is neither `$Object` nor a vec, so the dispatch falls to the count form (ToIndex → 0) and never consults `@@iterator`; §23.2.5.1 step 6 needs a closure arm |
| 4 | fail | `{filter,map}/callbackfn-arguments-with[out]-thisarg` — `results[0][2] - this` | the dyn-view species two-arm rebinds the receiver identifier to the MATERIALIZED f64 vec before compiling the loop, so the callback's third argument has the right CONTENTS and the wrong IDENTITY |
| 4 | fail | `{filter,map,slice,subarray}/speciesctor-get-species-custom-ctor-invocation` | the `@@species` getter's `this` is not the constructor |
| 16 | fail | `internals/{Set,DefineOwnProperty,OwnPropertyKeys}` | the integer-indexed exotic MOP over Proxy receivers, `preventExtensions`, symbol keys and key ordering — a separate mechanism |
| 9 | fail | `prototype/toLocaleString/*` | needs `Invoke(element, "toLocaleString")` per element; measured precondition missing: a user `Number.prototype.toLocaleString` override is not honoured even for a direct `n.toLocaleString()` in standalone |
| 6 | fail | `DataView/{dataview,defined-*,return-instance,custom-proto-*,instance-extensibility}` | `Object.getPrototypeOf(new DataView(…))` does not answer `DataView.prototype` |
| 6 | fail | `{entries,keys,values}/{iter-prototype,return-itor}` | the iterator result is not an %ArrayIteratorPrototype% object (`Cannot read properties of undefined (reading 'next')`) |
| rest | fail/CE | `isView` subclass instances, `sort` ordering, `ArrayBuffer/{prop-desc,data-allocation-…,prototype-from-newtarget}`, `slice` species residuals, `length-excessive-throws` (a wasm `requested new array is too large` trap), one `from-typedarray-into-itself-mapper-detaches-result` CE (`env::__unwrap_for_wasm`) | each its own mechanism |

**Not started in this slice (and why):** the four largest remaining buckets are
the integer-indexed MOP (16), `toLocaleString` (9) and the two `from`/`of`
families (16). Each needs a mechanism rather than an arm, and the detached
cohort (22) cannot be measured in this container at all — so E1 took the four
seams that are complete, measurable and independently verifiable here.

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E2

- **Branch** `issue-6651-E2-typedarray-mop`, based on `3769840f`
  (== `origin/main` at start of slice). **Worktree**
  `/home/claude/js2/.claude/worktrees/agent-a45f4665e71a5e440`.
- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt`, 144 rows,
  sha256 `61f309fc147d13c3989e47a83ece94a8073b04eae8c1c6a9736cac59e0367a17`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/E2-before.log`) | 13 | 130 | 1 |
| after (`.tmp/6651/E2-after.final.log`) | **20** | 123 | 1 |

**+7 rows pass, 0 lost, 0 other verdict changes.** Gained:
`TypedArray/from/{arylk-get-length,arylk-to-length,iter-access,iter-invoke,iter-next,iter-next-value}-error.js`
and `TypedArrayConstructors/from/mapfn-is-not-callable.js`.

**Measurement note — a sharded `--isolate` run can manufacture 40 fake
regressions.** The un-sharded run measured at ~2 min/row on a box carrying four
other lanes (load ~21 on 8 cores), i.e. ~5 h for 144 rows, so the manifest was
split 6 ways with each ROW still in its own fresh child — identical methodology,
more rows in flight. 40 rows then came back `error / spawnSync … ETIMEDOUT`:
the runner's 135 s per-row child budget is a *serial* number, and under 6-way
self-contention it is not enough. Scored naively that read as **5 pass→non-pass
regressions and 35 verdict changes**, every one of them an artefact. The 40 rows
were re-run at `JS2WASM_ROW_TIMEOUT_MS=420000` across 2 shards and merged; the
table above is the merged result. Anyone sharding this runner should treat an
`error` row as "not measured", never as a verdict.

#### E2-a — `%TypedArray%.from` surfaced its own TypeError instead of the source's

`%TypedArray%` (§23.2.1) is materialized in standalone as a plain `$Object`
singleton by `emitTypedArrayIntrinsicCtorObject` — the object
`harness/testTypedArray.js` binds with
`var TypedArray = Object.getPrototypeOf(Int8Array)`. It is neither a
`$__ta_ctor` struct nor the `ctor:Int8Array` carrier, so both runtime
discriminators in `tryEmitTaStaticOfFrom` declined and `TypedArray.from(src)`
fell through to the **refusal closure** seeded on the carrier's own `from`/`of`
properties. That closure's TypeError was the call's FIRST observable act —
which is the wrong error at the wrong time: §23.2.2.1 runs IterableToList / the
array-like `length` read BEFORE TypedArrayCreate, so a source whose iterator or
`length` getter throws must surface THAT completion.

The identity predicate went into the new module
`src/codegen/ta-static-from-of-spec.ts` (kept out of both `array-object-proto.ts`,
which owns the intrinsic's SEEDING, and `call-receiver-method.ts`, which owns the
CONSUMING arm — the predicate is exactly the contract between them), and the
abstract-constructor TypeError moved to TypedArrayCreate inside
`__ta_from_arraylike`.

**Its placement is load-bearing and was measured, not reasoned.** With the
`kind < 0` check in front of the `__extern_length` read the source's `length`
getter ran **0** times; behind it, **1**. The first cut had it in front and
every one of the six rows still failed, with the identical error message — the
arm was working and the ORDER was wrong.

`array-object-proto.ts` carries a comment claiming the refusal closure "is also
the correct answer for a bare `TypedArray.from([])`". **That claim is wrong**:
`IsConstructor(%TypedArray%)` is true, so `from` runs and the TypeError belongs
at TypedArrayCreate, after the drain. The comment is left for a follow-up that
touches that file.

#### E2-b — §23.2.2.1 step 3, `IsCallable(mapfn)`, before the `@@iterator` GET

Two defects in one decision. The call-site arm decided "is there a mapping?"
with `__nullish_to_null` + `ref.is_null`, which **folds `null` and `undefined`
together** — so `TA.from(src, null)` silently ran the no-mapping path and
returned a typed array instead of throwing — and it did so **after** step 4's
`GetMethod(source, @@iterator)`. `mapfn-is-not-callable.js` asserts exactly that
ordering with a counting `@@iterator` accessor: measured **14** gets where the
spec requires **0**.

The gate is emitted ahead of both drain arms and reuses the two natives the
sibling §23.1.3.30 `sort` comparefn gate already uses
(`__extern_is_undefined` / `__typeof_function`, #6651 E-S1) so the two "a
present non-callable function argument is a TypeError" sites agree rather than
each inventing a predicate.

#### E2-c — §10.4.5.6 `[[OwnPropertyKeys]]` for a dynamic view

`ta-dyn-mop.ts` already gives `__object_keys` a correct dyn-view arm. But
`Object.getOwnPropertyNames` and — the surface the `internals/OwnPropertyKeys`
rows use — `Reflect.ownKeys` do **not** route through `__object_keys`: the
standalone `Reflect.ownKeys` arm calls `__getOwnPropertyNames` and appends
`__getOwnPropertySymbols`. That native had no dyn-view arm, so a typed array was
answered by the generic `$__vec_base` arm, which is written for an ordinary
Array and therefore appends `"length"` — not an own property of an
integer-indexed exotic object at all (§10.4.5 has no `length` slot;
`%TypedArray%.prototype.length` is an inherited accessor) — and never consults
the expando side table.

Measured base → after, through the real harness shape:

| receiver | base | after (= spec) |
| --- | --- | --- |
| `new C([42,42,42])` | `["0","1","2","length"]` | `["0","1","2"]` |
| `new C(4)` | 4 indices + `"length"` | 4 indices |
| `new C()` | `["length"]` | `[]` |
| `new C(2)` then `sample.test262 = 42` | `["0","1","length"]` | `["0","1","test262"]` |
| `new C(2)` then `Object.defineProperty(…,"x",…)` | `["0","1","length"]` | `["0","1","x"]` |

Symbol keys — §10.4.5.6's third group — are deliberately NOT in the arm. The
caller appends `__getOwnPropertySymbols`, and on a dyn view that native has its
own gap (`Reflect.defineProperty(view, sym, …)` returns true and the read back
is `undefined`), so there is nothing correct to append yet; adding a
half-working symbol group would turn a missing key into a wrong one. That is
why `internals/OwnPropertyKeys/not-enumerable-keys.js` is still open.

**⚠ The probe shape decides whether you can see any of this.** A probe that
binds the constructor as `var TA = [Float64Array][0]` does **not** reproduce it:
TypeScript types that expression as `Float64ArrayConstructor`, so `new TA(…)`
takes the STATIC path and yields a plain `__vec_f64` compiler vec — a different
representation, for which `"length"` genuinely IS an own key. Only an
`any`-typed callee reaches `emitTaDynCtorConstructFromLocals` and the
`$__ta_dyn_view`. This module was measured against the static shape first, read
as a complete no-op, and was deleted before a type-classification probe
(`ref.test` against `$__ta_dyn_view` / `$__vec_base` / `__vec_f64` / `$Object`,
reported through the key list) showed the receiver was never a view. Cost:
about an hour. The rule that falls out: **probe through
`testWithTypedArrayConstructors`, never through a locally-bound constructor.**

#### Controls

- **Standalone neighbourhood, before vs after, 372 rows: zero pass→non-pass.**
  48 non-pass before → 38 after. The 10 fixed include **3 rows outside the
  manifest**: `TypedArrayConstructors/from/BigInt/mapfn-is-not-callable.js` and
  `internals/OwnPropertyKeys/integer-indexes-resizable-array-buffer-{auto,fixed}.js`.
  Logs `.tmp/e2/ctl-sa-{before,after}.log`; the before pass ran in a pristine
  `git worktree` of `HEAD` at `.tmp/basetree`, same list, same 60-row chunking,
  same filter, so "row absent from the log" means "pass" in both.
- **Scope of that control, stated plainly.** The relevant neighbourhood is 2,966
  rows (`built-ins/TypedArray*/**` 2,184 + `ArrayBuffer/**` 221 + `DataView/**`
  561). A before/after standalone sweep of all of it was **not** run: measured
  throughput on this box while four other lanes were running was ~10 s/row, i.e.
  >16 h for the four passes. The 372 rows are the subset whose SOURCE (or whose
  harness includes) mentions any surface this change can reach — `ownKeys`,
  `getOwnPropertyNames`, `getOwnPropertyDescriptors`, `.from(`, `.of(`,
  `JSON.stringify`, `propertyHelper.js`, `deepEqual.js`. Rows outside that set
  are argued, not measured.
- **Host lane: byte-identical.** All three seams are behind `ctx.standalone` /
  `noJsHost(ctx)`, and that was verified rather than asserted: a 42-row corpus
  spanning the same neighbourhood was compiled for the host target on the base
  worktree and on the branch and the emitted binaries hashed —
  **42/42 identical, 0 compile errors** (`.tmp/e2/hostbin-{base,new}.txt`).
- **Adversarial probes, run on the branch AND on the base worktree**
  (`.tmp/e2/probe12.mts`): `Object.defineProperty` on a view, `delete` of an
  expando, expando + descriptor together, bound / builtin (`Math.abs`) /
  anonymous mapfns, and non-TypedArray receivers. Plain-array and plain-object
  key lists are unchanged, `"length"` and all. **One difference found and it is
  NOT ours**: a generator function used as a mapfn throws TypeError
  (`__typeof_function` does not classify it as callable) — reproduced
  identically on base.

#### Residual sub-buckets after E2 (123 fail + 1 CE), with signatures

| rows | sub-bucket | why it is still open |
| ---: | --- | --- |
| 22 | the `$DETACHBUFFER` cohort | unchanged from E1 — the `$262` shim pulls the runtime-eval seam; unverifiable in this container |
| 16 | `internals/{Set,DefineOwnProperty,OwnPropertyKeys}` | see the three entries below — E2 closed the `[[OwnPropertyKeys]]` **string-key** half; what is left is three separate mechanisms |
| 7 | `internals/Set` | §10.4.5.5 with a **distinct Receiver** — every row is a 4-argument `Reflect.set(ta, k, v, receiver)` or a prototype-chain set. Standalone's `Reflect.set` has no receiver-override path, so the write lands on the target. A real mechanism, not an arm |
| 5 | `internals/DefineOwnProperty` | §10.4.5.3's descriptor **attribute** checks (`configurable`/`enumerable`/`writable` of an index and of a non-index expando) plus `desc-value-throws`. The expando table stores values, not attributes |
| 2 | `internals/OwnPropertyKeys/integer-indexes{,-and-string-keys}.js` | **ROOT-CAUSED by E2, newly actionable.** Both now get the first two assertions RIGHT and die on the third: `new TA(4).subarray(2)` answers **null**. `shouldWrapDynViewSpeciesTwoArm` requires `ts.isIdentifier(propAccess.expression)`, so a method called directly on a `new` expression never enters the dyn-view species arm and falls through to a null result. `slice` is null the same way. Fixing it means giving that arm a non-identifier receiver without double-evaluating it (its ELSE arm re-compiles the whole `callExpr`) |
| 2 | `internals/OwnPropertyKeys/{not-enumerable-keys,…-and-symbol-keys-}.js` | §10.4.5.6's SYMBOL group, deliberately out of E2 — see E2-c |
| 9 | `prototype/toLocaleString/*` | unchanged from E1 |
| 6 | `DataView` prototype identity | unchanged from E1. **Separately measured in E2 and worth recording**: 5 DataView rows fail with `Expected SameValue(«function () { [native code] }», «function () { [native code] }»)` — `sample.byteLength` reads back the GETTER CLOSURE instead of invoking it |
| 5 | `ctors/object-arg/throws-setting-obj-*` | unchanged from E1 — blocked on the static carrier's expando table |
| 3 | `ctors/object-arg/iterator-*` | **NARROWED.** `iterator-{not-callable-throws,throws}.js` pass `var obj = function () {}` — a CALLABLE. The `$Object` arm in `emitTaDynCtorConstructFromLocals` already implements §23.2.5.1 step 6 correctly (GetMethod, non-callable → TypeError, nullish → array-like); it is simply gated on `ref.test $Object`, which a closure fails. Widening that gate with `__typeof_function` is the fix. `iterator-is-null-as-array-like.js` is a DIFFERENT defect: construction succeeds and `typedArray instanceof TypedArray` is false |
| 2 | `ctors/object-arg/{iterating,as-generator-iterable}-*` | the ctor argument is a **generator object** — a third carrier shape |
| 7 | `TypedArrayConstructors/{from,of}` custom-`this` | `%TypedArray%.{from,of}` is still not INHERITED by the concrete constructors: `C.from` and `TypedArray.from` are distinct closures, and the `%TypedArray%` from/of closures are minted only at brand `-1073741821`, which the concrete-ctor property read does not use |
| rest | species `@@species` `this`, `{filter,map}` callback receiver identity, `isView` subclass, `sort`, `ArrayBuffer` residuals, `length-excessive-throws`, one CE | each its own mechanism, unchanged from E1 |

### 2026-09-21 — Cluster C (class / object-literal / `super`, standalone), slice C2

- **Branch** `worktree-agent-a27d2e622e3791fde`, based on
  `claude/es2015-test262-plan-54tooh` @ `252beab1` (origin/main + plan +
  clusters A, B, D, H and C1). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a27d2e622e3791fde`.
- **Manifest** `plan/agent-context/6651/C-class-object-super.txt`, 177 rows,
  sha256 `785dd45d78a609ecefc58377433fd144a142423557001a9b513cf1ae1492ad8d`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/C2-before.log`) | 0 | 173 | 4 |
| after C2-a (`.tmp/6651/C2-after1.log`) | **12** | 161 | 4 |

**+12 rows pass, 0 lost.** Both logs account for all 177 rows (12 + 161 + 4),
so neither was truncated — worth stating because another lane ran a blanket
`pkill -f run-test262-paths` during this slice; every log here was re-validated
for completeness afterwards rather than assumed intact.

#### C2-a — a top-level `C.prototype.<name> = value` was SILENTLY DROPPED

The module-init keep analysis in `declarations.ts` retains a top-level
`C.<name> = …` STATIC write on a compiled class, and the host lane retains
`F.prototype.m = …` for a top-level FUNCTION (#4618). Neither arm matches a
CLASS's prototype chain, so in standalone the statement fell past every keep
and compiled to **nothing**. Established by instrumentation, not inference:
`compileAssignment` is never entered for it, while the identical statement
inside a function body is — and works.

Measured on this branch's base (`.tmp/w6651C/m7.ts`, standalone):

```
class Plain {}
const holder = {}; holder.k = "H";     // lands
Plain.prototype.tagy = "Y";            // DROPPED
let ran = 0; ran = 5;                  // lands
new Plain()["tag"+"y"]                 // undefined    node "Y"
Plain.prototype["tag"+"y"]             // undefined    node "Y"
```

Two other statements in the same module landing is what rules out "module init
did not run". It is not Error-specific — the probe uses a plain class — and it
is not a corner: the honest test262 harness compiles every test body at MODULE
scope, where `A.prototype.fromA = 'a'` is one of the suite's commonest idioms.

Keeping the statement is necessary but **not sufficient**, and the second half
is the part that would have shipped a trap:

1. **The keep** (`class-proto-toplevel-write.ts` →
   `isTopLevelClassPrototypeWrite`, called from `collectDeclarations`).
   Standalone-gated; the root must resolve to a genuine class DECLARATION, the
   same evidence the static-write keep beside it demands.
2. **The decline** (same module → `targetReceiverIsPrototypeAccess`, called
   from `compilePropertyAssignment`). The checker types `C.prototype` as the
   INSTANCE type `C`, so for an externref-backed subclass the own-field-write
   arm claimed a write aimed at the PROTOTYPE object — which is never an
   `$Error_struct`. With the keep alone, `class Err extends TypeError {}` +
   `Err.prototype.tagx = "T"` turned from a silent no-op into **`illegal cast`,
   uncatchably, taking the module with it**. `error-instance-field-write.ts`
   already carries the identical guard for the identical reason; it was
   unreachable only because this statement was being dropped before it could be
   compiled.
3. **The absent-`message` read** (`error-message-proto-read.ts`, called from
   the statically-typed Error arm in `property-access-dispatch.ts`). §20.5.1.1
   step 3 makes `message` the one `$Error_struct` field that can legitimately be
   absent, and the arm read field 1 unconditionally, answered JS `null` and
   stopped the walk. Measured (`.tmp/w6651C/m10.ts`): `err2.message` answers
   `undefined` through a statically-typed `Err` receiver and
   `"custom-type-error"` through `(err2 as { message }).message` — the same
   program, the same value, two answers, selected by the static type. That is
   also why the C1 slice concluded this arm was unreachable: the C1 probe
   carried the cast.

#### Rows gained (12 on the manifest, 15 on the 960-row control)

| rows | family |
| ---: | --- |
| 7 | `class/subclass/builtin-objects/{NativeError/*-message, Error/message-property-assignment}.js` — the C1 residual, now closed |
| 5 | `expressions/super/prop-{dot,expr}-cls-val{,-from-arrow}.js` + `prop-expr-cls-val-from-eval.js` |
| +3 (control only) | `class/scope-setter-paramsbody-var-{close,open}.js`, `class/super/in-constructor.js` |

The five `super/prop-*-cls-val*` rows are the family #5350 recorded as blocked
by "a block-scoped class method's write to a captured `var`". They are not:
they were blocked by this dropped top-level statement, and the `var`-capture
defect (C1's finding 1) is not involved in the harness shape at all. The
coordinator's item (2) — collecting `var` in `collectBlockScopedDeclNames` — is
therefore **not needed for this family**, which is the re-measurement it asked
for; see the C2-b note below.

#### Controls — zero pass → non-pass

| set | rows | before | after |
| --- | ---: | --- | --- |
| manifest, `--isolate` | 177 | 0 / 173 / 4 | **12** / 161 / 4 |
| 960-row combined control, in-process, 10 chunks | 960 | 658 pass / 280 fail / 21 CE / 1 skip | **673** / 265 / 21 / 1 |

The 960-row control is every test262 file containing a top-level
`<ident>.prototype.<name> =` write (363 across `language/**` and
`built-ins/**` — i.e. the idiom this change makes execute), plus all 187
`built-ins/{Error,NativeErrors}` rows and the 429-row
`class/subclass` + `expressions/super` + `statements/try` + `AggregateError`
set. Per-row set diff: **15 gained, 0 lost, no other verdict changes**. Every
chunk was verified to account for exactly its input rows before the diff was
taken. Logs `.tmp/6651/ctl2-{before,after}-0*.log`, list `.tmp/6651/ctl2.txt`.

**Host (gc) control is a byte-identity proof.** The keep is `ctx.standalone`-
gated and the read arm is `native-first`-gated, so host output cannot move:
**11/11 gc binaries sha256-identical**, and on standalone only the 2 corpus
programs that actually contain the construct change
(`.tmp/6651/bytes2-{before,after}.txt`).

Pin `tests/issue-6651-class-prototype-toplevel-write.test.ts` — 4 cases, **3
verified RED on the base** (0→7, 0→15, 1→3), the fourth a guard that the
in-function form is untouched. Case 2 is specifically the one that traps
("illegal cast") if the keep lands without the decline.

Gates, run bare: loc-budget and func-budget PASS with the grants added to this
file's frontmatter (`declarations.ts` +10 / `collectDeclarations` +9,
`assignment.ts` +5 / `compilePropertyAssignment` +4,
`property-access-dispatch.ts` +9 — every mechanism moved into the two new leaf
modules; inlined, the same change was +114); coercion-sites, oracle-ratchet,
dead-exports, compiler-boundaries `--mode inventory`, typecheck, prettier and
`biome lint --diagnostic-level=error` all 0. `node scripts/equivalence-gate.mjs`:
22 failing / 1720 passing, all 22 already in the baseline.

`scripts/compiler-boundaries.json` also classifies
`src/codegen/string-symbol-protocol.ts` — cluster B's new module, which arrived
on the merged base unclassified and fails the inventory gate for every lane
that follows it.

#### C2-b — a block-scoped class capturing a function-scoped `var` (zero rows, shipped anyway)

`collectBlockScopedDeclNames` collected only `let`/`const`, on the premise that
"a `var` is function-scoped and therefore already a module global" — true at
MODULE scope, and this function is only ever called from INSIDE a function
body, which is where it is false. Base (`.tmp/w6651C/q31.ts`, standalone):

```
function test() { var n = 0;
  if (1) { class C { m() { n = 5; } } new C().m(); }
  return n; }                              // base 0, node 5
```

`$C_m` declares `(local $n f64)` and stores into it. The same class at
function-body level answers 5, a `let` in the same block already worked, and a
function expression / object-literal method in the same block already worked —
the class method was the only one of three closure kinds that was broken. The
collector now takes `var` too, moved to the leaf module
`src/codegen/scope-local-decl-names.ts`.

**This is the coordinator's item (2), and the re-measurement it asked for says
the thing it was expected to unblock was already fixed by C2-a.** The
`super/prop-*-cls-val` family passes because the top-level
`A.prototype.fromA = 'a'` statement now runs, not because of any `var` capture:
with C2-b applied the manifest is **byte-for-byte the same verdicts as C2-a**
(12 pass / 161 fail / 4 CE, identical per-row), and #5350's attribution of that
family to a block-scoped `var` capture does not survive contact with the honest
harness shape, where the class and the `var` are both at module scope.

It ships regardless because it is a real wrong answer with no measured cost,
and because #2818's stated reason for excluding `var` — "including `var`
needlessly perturbed the order-sensitive async-generator lowering" — was
re-tested rather than taken on trust:

| control | rows | result |
| --- | ---: | --- |
| cluster-C manifest, `--isolate` | 177 | identical to C2-a (12 / 161 / 4) |
| 960-row combined control, in-process | 960 | **identical non-pass set**, 673 / 265 / 21 / 1 |
| generator sample (`expressions/generators`, `statements/generators`, `expressions/async-generator`, every 4th row) | 295 | **identical non-pass set**, 248 passing |

Logs `.tmp/6651/C2-after2.log`, `.tmp/6651/ctl2b-*.log`,
`.tmp/6651/ctl3-{before,after}-*.log`. Gates all 0 (the collector moving to its
own module is what kept `compileDeclarations` under its ceiling); equivalence
22 failing / 1720 passing, all in baseline. Pin
`tests/issue-6651-block-class-var-capture.test.ts` — 3 cases, 2 RED on the base
(0→5, 5→7), 1 guard.

#### C2-c — the f64-typed parameter slot (18 rows): NOT landed, diagnosed exactly

The coordinator's item (3) — the 10 `dflt-params-arg-val-not-undefined.js` rows
(`Expected SameValue(«0», «false»)`) and the 8
`dstr/…-dflt-obj-ptrn-prop-ary.js` rows (`«NaN»` vs `«undefined»`) — is one
defect: in a JAVASCRIPT source file a parameter's only type evidence is its
default initializer, so `method(aFalse = falseCount += 1)` is inferred `number`
and `C.prototype.method(false)` arrives as `0`. In a `.ts` file that inference
is a genuine declaration and the scalar slot is right; in a `.js` file there
are no parameter types at all, so it is a guess about one call.

**The slot half is a one-line widening and it works.** `isUndefinedDefaultOnlyParam`
(`src/checker/type-mapper.ts`) already states exactly this argument for the
`= undefined` case — *"an ABSENCE of information, not a scalar contract"* — and
its own doc requires every parameter-lowering site to apply it identically, so
all four call sites (class-bodies ×2, declarations, closures) pick a widening
up for free. Adding `|| <the parameter is in a .js/.mjs/.cjs/.jsx file>` to it
produces the right signature, WAT-verified on a JS compile:

```
(func $C_method (param (ref null 60) externref) (result (ref null 6)))   ; was  … f64 …
```

**It is NOT sufficient, and the reason is worth the next owner's time.** The
value is not lost at the boundary — it is lost on first READ. The body prologue
is correct (`__extern_is_undefined(a)` gates the default), and the very next
instructions are `local.get 1; call $__unbox_number`: every USE of the
parameter still coerces through the checker-inferred `number`, so
`typeof a` answers `"number"` for an argument that arrived as a boxed boolean.
Widening the wasm slot without widening the parameter's TYPE in the function's
own type map just moves the coercion one instruction later.

So this is a checker/oracle change — the parameter must be typed `any` for such
a declaration — not a codegen slot change, and it needs its own control: it
would move the slot of **every defaulted parameter in every JS input**, which
is all of test262 and every npm package. The attempted patch is kept at
`.tmp/w6651C/attempt-type-mapper.ts` rather than committed; nothing of it is in
the branch.

### 2026-09-21 — Cluster I (language misc, standalone), triage pass (no source slice)

- **Branch** `worktree-agent-adcaab82a3507f049`, base
  `claude/es2015-test262-plan-54tooh` @ `b104f96e41`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-adcaab82a3507f049`.
- **Manifest** `plan/agent-context/6651/I-language-misc.txt`, 114 rows,
  sha256 `f94fe9f129c0bcc5e5e52ce798cbeedfa6cae99f7506f5547af54717a71cdd68`.
- **This entry is a TRIAGE deliverable. No `src/` change is in it** — every
  bucket below was measured, three root causes were proven with probes, and
  none of the buckets is the small slice the dispatch assumed. Nothing is
  half-applied: the tree this was committed from is source-clean.

| standalone, `--isolate`, eval engine **quickjs** | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/I-before.log`, cleaned copy `I-before-clean.log`) | **0** | 103 | 11 |

#### Read this before measuring cluster I: the engine changes 40 of the 114 rows

The first before-run (`.tmp/6651/I-before-noqjs.log`) reported **40 rows** as
`Error: JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built`.
That is not a verdict — it is the runner refusing to measure. The provider is
**not** present in a fresh worktree and the selector deliberately never builds
one (a silent degrade to the interpreter would invalidate the measurement), so
a cluster-I sweep run without it silently converts a third of the manifest into
noise, including **every** module-namespace row.

Build it once per worktree — the artifact is ~50 s (clang-18 + network), the
adapter ~5 s, and the adapter key folds in the compiler source hash, so it must
be rebuilt after a `src/` edit:

```bash
node scripts/build-quickjs-eval-provider.mjs            # builds the artifact, then
node --import tsx scripts/build-quickjs-eval-provider.mjs   # builds the adapter
```

Both logs in this entry are from the **quickjs** engine. With it present,
**zero** rows are environment-unmeasurable.

#### Triage table — all 114 rows, measured, bucketed by signature

`fix?` is the verdict asked for: **(a)** fixable in standalone · **(b)**
wont-fix-with-reason candidate (needs a second realm, or direct `eval` of
dynamic text that the target has no host for) · **(c)** environment-unmeasurable.
"size" is the honest horizon of the *whole* bucket, not of one row.

| # | bucket | rows | fail/CE | fix? | size | what it actually needs |
| --- | --- | ---: | --- | --- | --- | --- |
| B3 | `with` + `@@unscopables` | 15 | 13 / 2 | a | XL | a **dynamic** `with` environment record. 5 rows put a `Proxy` in the `with` head; 6 need `@@unscopables` on an arbitrary object; 2 are the #1387 CE ("requires a proven closed object-literal shape"). The closed-shape model cannot answer any of them. |
| B15 | singletons | 14 | 14 / 0 | a | — | 14 unrelated one-row defects; see `.tmp/6651/I-buckets.txt` for the list. |
| B1 | `module-code/namespace/internals` | 12 | 12 / 0 | a | XL | **root cause proven, see below** — two independent blockers, runner *and* compiler. |
| B5 | direct `eval` — spread args, caller scope, class-in-eval | 10 | 10 / 0 | a (4) / b (6) | L | `eval-spread*` (4) and `statementList/eval-class-*` (4) are real runtime-eval-lane defects (wrong arg vector; wrong `[[Prototype]]` identity for an `Array`/`RegExp` literal built inside the eval). `eval-code/direct/{new.target-fn,super-prop-method}` need the *caller's* `new.target`/`[[HomeObject]]` inside eval'd text — **wont-fix candidates** (#1066). |
| B11 | parameter defaults / destructuring params | 9 | 9 / 0 | a | M | three tests × three function forms. `params-dflt-ref-arguments` needs `arguments` bound in the **parameter** scope (reads null today); `dstr/ary-ptrn-elem-ary-rest-init` reads null; `dflt-params-arg-val-not-undefined` returns `0` for an explicit `false` argument. |
| B10 | global-object declaration descriptors | 7 | 7 / 0 | a | L | `var`/`function`/`let` at global code must create global-object properties with the spec's `configurable:false` and collide per §9.1.1.4. Two rows escape a bare `WebAssembly.Exception`. |
| B9 | arrow `this` / `new.target` / `super` | 7 | 7 / 0 | a | L | lexical capture of the *enclosing function's* `new.target` and `[[HomeObject]]`. One row (`lexical-this.js`) is a null-pointer trap in `__module_init`, i.e. a miscompile, not a missing feature. |
| B7 | tagged template | 7 | 6 / 1 | a | L | the site object is not frozen, is not passed as argument 0 in the member/call-expression forms, `this` binding is wrong for `obj.fn\`\``, `new tag\`\`` is not constructible, and one row still leaks `env::__tagged_template`. |
| B4 | cross-realm | 6 | 6 / 0 | **b** | — | every row calls `$262.createRealm()`. A standalone binary is one realm by construction; there is no host to make a second one. **The clearest wont-fix-with-reason group in the cluster.** |
| B8 | `instanceof` | 6 | 6 / 0 | a | M | 3 × `@@hasInstance` (**root cause proven, see below**), 3 × an accessor `Function.prototype.prototype` that `Get(C,"prototype")` must call observably. |
| B12 | `arguments` object | 5 | 5 / 0 | a | M | own `@@iterator` (2 rows), and `arguments`-named-`arguments` shadowing, which currently traps with `illegal cast` (2) or reports `typeof "function"` (1). |
| B2 | `module-code` generator exports | 5 | 0 / 5 | a | — | all five are `standalone target emitted host imports: env::g` — a **generator** leak. Same family as cluster A; they landed in I only because the partition rule keyed on the path, not the error. Hand to A. |
| B14 | annexB | 4 | 1 / 3 | a | S | one `\P{…}` RegExp CE (#1539 Phase 2d), one labelled-function-declaration SyntaxError, one block-scope redeclaration, one `substr` coercion order. |
| B13 | TDZ in closures / block scope | 4 | 4 / 0 | a | M | a closure that reads a `let`/`const` before its initializer must throw `ReferenceError`; we return the value. |
| B6 | proper tail calls | 3 | 3 / 0 | a | M | `tco-non-eval-*`; one now blows the stack (`RangeError: Maximum call stack size exceeded`), which is the honest signature — the tail position is not being taken. |
| | **total** | **114** | 103 / 11 | | | |

Counts: **(a) fixable 102 · (b) wont-fix candidates 12** (6 cross-realm + 6
direct-eval-of-dynamic-text) · **(c) environment-unmeasurable 0** once the
quickjs provider is built.

#### Root cause 1 — the module-namespace family is blocked TWICE, not once

The 12 rows do not fail on the §10.4.6 exotic-object MOP. They fail because
`ns` is **null**: `Reflect.defineProperty called on non-object`,
`stringKeys.length === 0`, `Cannot access property on null or undefined`.

- **Blocker A (runner).** These tests SELF-import
  (`import * as ns from './own-property-keys-sort.js'`). `wrapTest` hoists only
  `_FIXTURE` specifiers to module top level — deliberately, per the #2932 note
  in `tests/test262-runner.ts`: the test compiles under the virtual key
  `./test.ts`, so a hoisted self-import cannot resolve, and hoisting it anyway
  flipped 4 of these rows to "ns is not defined" in PR #2471's merge_group. So
  the import stays nested inside `export function test()`, where it is
  leniently ignored and the binding reads null.
- **Blocker B (compiler).** Even given a top-level self-import, the compiler
  does not materialize the namespace. Probed directly
  (`.tmp/6651/selfimport2.mts`, source-clean tree, `--target standalone`, module
  compiled under `fileName: "test.ts"` with `import * as ns from './test.ts'`):

  | probe body | result |
  | --- | --- |
  | `typeof ns === 'object'` | **0** (it is not an object) |
  | `ns !== null` | **throws a bare `WebAssembly.Exception`** |
  | `ns.localA` | throws |
  | `Object.getOwnPropertyNames(ns)` | throws |
  | `Object.keys(ns)` | throws |

  `module-namespace-value.ts` materializes a namespace for an import of
  *another* module in the same compilation; the self-import case is not
  modelled and reaches a trap rather than a decline.

So the slice is: rewrite the self-import specifier to the compilation's own key
and hoist it (runner), teach `module-namespace-value.ts` the self case
(compiler), and only *then* do the MOP details (live-binding TDZ
`ReferenceError`, `[[Set]]`/`[[Delete]]`/`[[DefineOwnProperty]]` refusals,
sorted `[[OwnPropertyKeys]]`, `@@toStringTag`) decide individual rows. That is
an XL, two-component slice — **not** the "likely small one" the dispatch
assumed, which is the single most useful thing this triage establishes.

#### Root cause 2 — `instanceof` never consults `@@hasInstance`, and the fix route is known

§13.10.2 step 2 does `GetMethod(C, @@hasInstance)` **before** the step-5
`IsCallable(C)` throw. `native-ordinary-instanceof.ts` already knows this — its
`moduleInstallsCallableHasInstance` gate (#4484 A) declines the non-callable-RHS
throw when the module installs a handler. But the very next arm in
`emitDynamicInstanceOf` (`isExclusivelyPrimitiveType`, the #2998 primitive-LHS
fold) then answers `false` for `0 instanceof F` **without** consulting the
handler, so the handler is never called. That is exactly
`symbol-hasinstance-{invocation,to-boolean}`; `symbol-hasinstance-get-err`
additionally needs the gate widened to `Object.defineProperty(F,
Symbol.hasInstance, {get})`, which the current syntactic scan does not match.

The reason this is worth writing down: **the primitives to lower it already
work.** Probed on the source-clean tree, `--target standalone`
(`.tmp/6651/hasinst.mts`):

| probe | result |
| --- | --- |
| `F[Symbol.hasInstance](7)` after `F[Symbol.hasInstance] = fn` | **1 (works)** |
| `F[Symbol.hasInstance].call(F, 7)` | **1 (works)** |
| `0 instanceof F` (same module) | **0 (handler never called)** |

So the slice is a lowering change in `emitDynamicInstanceOf` only — read
`@@hasInstance` off the RHS, and when it is callable invoke it through the
generic `__apply_closure(target, thisArg, restVec)` primitive that
`function-proto-invokers.ts` (#6630) already uses for
`Function.prototype.call`, then `ToBoolean`. It needs its own before/after over
`language/expressions/instanceof/**` on both lanes, because the gate is
module-scoped and would change every `instanceof` site in a module that
installs a handler.

#### Root cause 3 — the partition put 5 generator rows in this cluster

B2's five `language/module-code/*-gen-*` rows are `env::g` generator leaks, not
language-misc work. The manifest generator note keys cluster I as "the rest",
and the generator rule only matched errors mentioning `__gen_`/yield. Route
them to A rather than re-deriving the same lowering here.

#### Residuals

All 114 rows. Nothing flipped; this entry buys the next owner a measured,
engine-correct starting point and removes two false assumptions (that the
namespace family is a MOP slice, and that a bare sweep measures this cluster).
Logs: `.tmp/6651/I-before.log` (quickjs), `.tmp/6651/I-before-noqjs.log` (the
unusable no-provider run, kept as the evidence for the engine warning),
`.tmp/6651/I-before-clean.log`, per-bucket row lists in
`.tmp/6651/I-buckets.txt`. Probes: `.tmp/6651/{selfimport,selfimport2,hasinst,probe}.mts`.
None of the probes is committed.


### 2026-09-23 — Cluster H (builtins misc, standalone), slice H2: the measured bucket table, and symbol property keys on an array carrier

- **Branch** `worktree-agent-a9af718294905d3d7`, base `main` @ `6190e961`.
  **Worktree** `/home/claude/js2/.claude/worktrees/agent-a9af718294905d3d7`.
  A pristine `git archive HEAD` extract at `.tmp/base-tree/` carried every
  before-state measurement, so `src/` in the worktree was never edited under a
  running sweep.
- **Manifest** `plan/agent-context/6651/H-builtins-misc.txt`, sha256
  `f1eb655415155ac7e7d262ffbaa50a479f8a495bdeb297fad7292169811c104f`, 217 rows.

#### The bucket table — the deliverable, ahead of the fix

214 of the 217 rows had no current breakdown, which made cluster H the largest
un-ranked residual in the plan. Measured here, standalone, under
`JS2WASM_EVAL_ENGINE=quickjs`, with a **host-lane probe of every row**:

| class (by test SOURCE, not by symptom) | rows | host pass | host fail |
| --- | ---: | ---: | ---: |
| uses `$262.createRealm` | 58 | 14 | 44 |
| uses `Proxy` (and not `createRealm`) | 53 | 27 | 26 |
| core — neither | 103 | 35 | 68 |
| **total residual** | **214** | **76** | **138** |

**The number that should drive the next dispatch is 35.** A row that fails on
the HOST too cannot be reached by fixing standalone lowering, and a row whose
body calls `$262.createRealm` has no standalone representation at all. So the
set a standalone-lowering slice can actually close is *core ∧ host-pass* — 35
rows, not 214. The other 179 are: realm work (or a `wont-fix` with the realm
reason), cluster F's Proxy lane, or engineering needed in both lanes.

Top signature buckets (`.tmp/6651/H2-buckets.txt` has all of them plus the
per-row table):

| rows | signature | host pass | realm | proxy | what it is |
| ---: | --- | ---: | ---: | ---: | --- |
| 37 | `TypeError: Cannot access property on null or undefined at N:N` | 17 | 31 | 2 | `$262.createRealm()` answers null — the realm family, one symptom |
| 30 | bare `SameValue` mismatch | 4 | 6 | 7 | heterogeneous; no single mechanism |
| 17 | `Expected a TypeError … no exception` | 12 | 1 | 11 | mostly Proxy invariant checks |
| 7 | `Expected a Test262Error but got a TypeError` | 2 | 0 | 2 | |
| 6 | `Conforms to NativeFunction Syntax` | 6 | 0 | 6 | `Function.prototype.toString` over a Proxy |
| 6 | `newTarget.prototype is undefined` | 0 | 6 | 0 | `proto-from-ctor-realm*`, all realm |
| 5 | `Object.prototype.toString is not yet implemented in --target standalone` | 2 | 0 | 2 | see the probe below |
| 4 | `0 value should be N` | 4 | 0 | 0 | `*/target-array-with-non-writable-property.js` — **the best core bucket** |
| 4 | `Cannot access property on null or undefined` (no line) | 2 | 3 | 0 | |
| 4 | `Expected a Test262Error … no exception` | 1 | 0 | 3 | |
| 3 each | `RuntimeError: illegal cast` · `Array.prototype.flat()` CE · `Expected a RangeError …` · `Cannot read properties of undefined` · `Cannot convert undefined or null to object` | | | | |
| 79 | 3 two-row buckets + 73 singleton signatures | | | | the long tail |

Compiler REFUSALS inside the cluster, which are the cleanest targets because
they name themselves: `Array.prototype.flat()` (3 CE), `Array.prototype.{entries,
keys,values}` not callable as a value (3), `Object.prototype.toString` (5),
`Array.prototype.flatMap` non-array-returning callback (1), `Date.prototype.toJSON`
(1), `JSON.stringify` of this value (1), standalone `Reflect.construct` (1).

**Two mechanisms probed and root-caused here, neither fixed** (probes in
`.tmp/probe/`, none committed):

- **`Object.prototype.toString` ignores `@@toStringTag` entirely and refuses
  three receiver kinds.** Measured standalone on base: `{}` → `[object Object]`,
  `[]` → `[object Array]`, Math/JSON → `[object Object]`, but WeakMap, WeakSet
  and a Symbol receiver all THROW the #4119 refusal, and an object carrying
  `o[Symbol.toStringTag] = "Custom"` still answers `[object Object]`. §20.1.3.6
  step 15's `Get(O, @@toStringTag)` is not implemented at all — so this bucket
  needs the runtime Get *and* real deletable builtin tag properties, not just a
  `delete` fix as the round-2 table assumed.
- **`__extern_length` answers 0 for String-wrapper and function carriers.**
  Spreadable `new String("yuck")` concats to `[]` though `.length` is 4; a
  spreadable function with `length` 3 spreads nothing. RegExp and plain-object
  carriers are CORRECT (2 and 3), which narrows the gap from "non-`$Object`
  carriers" to exactly the wrapper and closure carriers, and `Object("hi").length`
  is 0 while `new String("xy").length` is 2 — the ToObject path builds a
  different carrier from the constructor path. Worth 2 manifest rows; it changes
  the array-like length of every such receiver, so it needs its own control set.

#### What landed: §10.4.2.1 step 1 — a SYMBOL key on an Array is an ORDINARY property

The overlay guarded all four of its natives with `stringKeyGuard`, whose bail
RETURNS. Four measured consequences on the base tree, one standalone module:

| question | base | spec |
| --- | --- | --- |
| `Object.defineProperty(arr, sym, {get})` then `arr[sym]` | `undefined`, getter never ran | getter runs |
| `gOPD(arr, sym)` after that define | `undefined` | a descriptor |
| `Object.defineProperty(arr, sym, {value:11})` then `arr[sym]` | `undefined` | `11` |
| `arr[sym] = 9` then `gOPD(arr, sym)` | `undefined` (while `arr[sym]` read **9**) | a descriptor |

The same descriptors on a PLAIN object were always correct, which is what makes
this a carrier bug: the `$Object` natives were right and the array overlay was
refusing to reach them. Fixed by routing a symbol key to the companion
`$Object` in `__vec_dp_value` / `__vec_dp_accessor`, delegating `__vec_gopd`'s
symbol lane to `__getOwnPropertyDescriptor` **and then to the #3537 bag** (the
#4010 two-table seam — an expando written by assignment lands in the bag, not
the companion), and widening the `__extern_get` / `__vec_prop_get` read
prologue's key gate so a symbol key reaches the consult that now has something
to find. All four are inside `fillVecOverlayHelpers`, which returns early
unless `ctx.standalone`.

One trap worth recording: the gOPD symbol arm must end in a `return` on EVERY
path. Falling through reaches the `"length"` guard, which `ref.cast`s the key to
`$AnyString` and TRAPS on a symbol — caught by the pin file's miss case, which
went `THREW` on the first draft.

**Manifest, standalone, before → after** (chunked in-process runner, 3 × ~73
rows, one fresh process per chunk; logs `.tmp/6651/H2-sa-inproc-{before,after}-*.log`,
per-row TSVs `.tmp/6651/sa-{before,after}-rows.tsv`):

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before | 3 | 208 | 6 |
| after | **4** | 207 | 6 |

Per-row set diff: **1 gained, 0 lost, 0 other verdict changes** —
`built-ins/Array/prototype/concat/is-concat-spreadable-get-order.js`, which is
the residual #6485 recorded. **+1 on the manifest is the honest number**; the
capability closed is wider than the row count, and the bucket table above is
why the rest of the cluster did not follow.

**On the runner method.** The `--isolate` sweep the acceptance recipe asks for
was started first and abandoned after ~40 rows in ~40 minutes: three other
lanes were sweeping the same 4-core box (load 14–17), which puts a 217-row
isolate pass at 3–4 hours per side. The chunked in-process runner was used
instead, and it is cross-validated rather than assumed: its before-state
reproduces H1's isolated after-state **exactly** (3 pass / 208 fail / 6 CE, the
same per-row set), which is the strongest available evidence that the two
methods agree on this manifest.

#### Controls

- **Host lane is a byte-identity proof, by construction.** Every edit is inside
  `fillVecOverlayHelpers`, which returns early unless `ctx.standalone`. A
  15-module corpus (the 13 `website/playground/examples` sources plus two
  inline modules — one exercising exactly this construct, one with no symbol at
  all) compiles **15/15 sha256-identical on gc**, before vs after
  (`.tmp/6651/shas-{before,after}.txt`).
- On **standalone** 6 of those 15 move, including the no-symbol control — the
  three define/gOPD arms are unconditional, so this slice is NOT
  standalone-byte-neutral. Stated because the first draft of the code comment
  claimed it was, and the sha corpus is what caught that.
- **Neighbourhood**, 1,655 rows — all of `built-ins/Array/prototype/concat`,
  `Object/{defineProperty,getOwnPropertyDescriptor,getOwnPropertySymbols}`,
  `Array/prototype/Symbol.unscopables`, `Array/length` and `built-ins/Symbol` —
  standalone, before vs after, 11 chunks of 165 in fresh processes
  (`.tmp/6651/nb-sa-{before,after}-*.log`, per-row TSVs
  `.tmp/6651/nb-{before,after}-rows.tsv`): `1,589 pass / 65 fail / 1 CE` →
  `1,590 / 64 / 1`. The per-row set diff is **one line long** — the same
  `is-concat-spreadable-get-order.js`, fail → pass. **Zero pass → non-pass,
  zero other verdict changes.** No separate host sweep was run for this
  neighbourhood: the byte-identity proof above is stronger than a sample, since
  the host lane provably cannot reach any changed code.
- Pin file `tests/issue-6651-vec-symbol-key-overlay.test.ts`, 6 cases —
  **3 verified RED on the base tree** via the file-copy A/B, 3 are guards green
  on both sides (the plain-object control, the gOPD miss, and the negative
  direction: a STRING key keeps its index / `"length"` semantics).

Gates, run bare: loc-budget OK and func-budget OK with the +153 grants added to
this file's frontmatter above, dated; coercion-sites OK; oracle-ratchet OK
(`getTypeAtLocation +0`, `ctx.checker +0`); dead-exports OK; typecheck OK.
`node scripts/equivalence-gate.mjs`: **22 failing / 1,720 passing, all 22 already
in the baseline — no new equivalence regressions.**

#### For the next owner, in rows-per-effort order

1. **`*/target-array-with-non-writable-property.js` (4 rows, all core, all
   host-pass)** — filter/map/slice/splice write into a species-created target
   whose index 0 is non-writable; §23.1.3's `CreateDataPropertyOrThrow` must
   define, not assign. Caveat measured here: a hand-written probe of the same
   shape already answers CORRECTLY (`r[0] === 2`, descriptor all-true), so the
   failure only appears with `propertyHelper.js` included — diagnose against the
   original-harness assembly, not a reduced repro.
2. **`Object.prototype.toString` §20.1.3.6 step 15** (5 rows + ripple) — see the
   probe above; it is a mechanism, not a `delete` fix.
3. **Symbol-keyed own-key visibility** (4 rows) —
   `getOwnPropertyDescriptors/{order-after-define-property,symbols-included}`,
   `getOwnPropertySymbols/order-after-define-property`, `entries/symbols-omitted`:
   `Object.getOwnPropertySymbols` answers `[]` for symbol-keyed defines even on a
   PLAIN object, which this slice did not touch.
4. **Symbol wrapper objects** (4 rows) — `Object(sym)`, `Object.assign(Symbol(),…)`,
   `Symbol.prototype.{toString,@@toPrimitive}` on a wrapper receiver. ToObject has
   no Symbol-wrapper carrier.
5. **Classify the 58 realm rows** against the definition of done rather than
   lane-ing them: `$262.createRealm` has no standalone representation, and 44 of
   them fail on the host too.
6. Extract `vec-symbol-key-overlay.ts` from `fillVecOverlayHelpers` and hand the
   two budget grants back.

### 2026-09-21 — Cluster G (for-of / destructuring residuals / iterators, standalone), slice G1: spec-ordered ArrayAssignmentPattern + IteratorClose

- **Branch** `worktree-agent-a3b8356df530ad9e4`, based on
  `claude/es2015-test262-plan-54tooh` @ `64801f10` (carries A, B, C1, D, F, H).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a3b8356df530ad9e4`.
- **Manifest** `plan/agent-context/6651/G-forof-destructuring-iterators.txt`,
  134 rows, sha256
  `e68a764ab55ce04936572717bdf96f724fb337af6a9af3a758f3525851ff1dec`.
- **Engine note:** every log below was measured with the runner's DEFAULT eval
  engine (the QuickJS provider was not built in this container when the
  before-state was taken), so the 7 `quickjs provider is not built` rows are
  environment-blocked on BOTH sides and the delta is comparable.

| standalone, `--isolate`, 134 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/G-before.log`) | **0** | 132 | 2 |
| after (`.tmp/6651/G-after.log`) | **21** | 111 | 2 |

**+21 rows pass; 0 lost; no other status changed** (the two logs were joined
per path, not compared by count). One further row moved to a LATER assertion:
`assignment/destructuring/iterator-destructuring-property-reference-target-evaluation-order.js`
now reports `[source, iterator, target, target-key, …]` where it reported
`[source, iterator, iterator-step, …]` — i.e. the ordering this slice fixes is
now observable in its trace, and it fails on a later step.

#### What landed — the answer was MIS-ORDERED, not missing

§13.15.5.2 ArrayAssignmentPattern is three-phase: GetIterator, then **per
element** evaluate the DestructuringAssignmentTarget's *Reference*
(§13.15.5.5 step 1) and only then IteratorStep (step 2); an abrupt completion
with `[[done]]` still false runs §7.4.9 IteratorClose. Both destructuring
entry points normalise the source through `__array_from_iter_n(src, n)` FIRST
— a complete drain of `n` steps before any target reference is touched. So for

```js
0, [ {}[thrower()] ] = iterable;     // array-elem-iter-thrw-close.js
```

the compiler reported `nextCount 1 / returnCount 0` where the spec requires
`0 / 1`. Hoisting the reference in front of the materialisation fixes
`nextCount` and **cannot** fix `returnCount`: the throw would then precede
GetIterator, so there would be no iterator to close. Hence a lazy drive, not a
re-ordering.

New module `src/codegen/dstr-assign-iterator-drive.ts`
(`tryEmitSpecOrderedArrayAssignDrive`) plus two dispatch sites
(`expressions/assignment.ts::compileExternrefArrayDestructuringAssignment` +14,
`statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref`
+9). It emits GetIterator once, then per element: member-target reference into
`(obj, key)` locals → `__iterator_next` → `__extern_set_strict`; a rest element
drains via `__iterator_rest`; the whole element loop is wrapped so any throw
runs IteratorClose with the close's own abrupt completion suppressed
(§7.4.9 step 6 — the original throw wins, which is what every `*-thrw-close-err`
row asserts). **No new host import** — all six natives already route to the
standalone object/iterator runtime.

Three details are load-bearing and were measured, not assumed:

1. **`doneLocal` is raised to 1 BEFORE each step and lowered after.** §7.4.6
   sets `[[done]]` true when `next()` throws, and `[[done]]` true is exactly
   what suppresses the close. Without the pre-raise a throwing `next()` would
   be followed by a `return()` call the spec forbids.
2. **A rest element reached with `[[done]]` already true must not step again**
   — it still receives an array, an EMPTY one. `__array_from_iter_n(null, -1)`
   answers that, so no second empty-vec shape is introduced.
3. **A `never`-typed operand is not a refusal.** `compileExpression` answers
   `null` for `{}[thrower()]`'s call (the declared return type IS `never`)
   while still emitting the throw; the slot is padded with `ref.null.extern`
   exactly as `emitDynamicMemberSet` pads it. Refusing there rejected the
   entire family — the first cut did, and silently fell through to the old
   path after having already emitted a GetIterator, which is why the drive now
   builds into a DETACHED buffer and splices only on success.

#### The drive is STANDALONE/WASI-gated, and that gate is a measurement

Ungated, the 1,207-row **host** sweep gained 10 rows and **LOST 3**
(`for-of/dstr/array-rest-{lref,nested-array-iter-thrw-close-skip,
put-prop-ref-user-err-iter-close-skip}.js`, `nextCount 0` where 1 is required).
Cause, probed directly: the host `__iterator_rest` (`src/runtime.ts:17999`)
drains via `iter.next` / the string sidecar, and the iterator in this whole
family is a compiled OBJECT LITERAL — a WasmGC struct neither lookup finds — so
it answers `[]` without stepping, where the eager `__array_from_iter_n` it
replaces goes through the host's own iteration bridge. Gating costs nothing
measurable: every row in this bucket already fails on host, for the same
ordering reason plus a host-only close-receiver defect (`return()` does not see
the iterator as its `this`, measured 1010 vs the required 1011). Lifting the
gate means first giving the host lane a rest drain that can step a struct
iterator.

#### Controls — zero pass → non-pass

Neighbourhood: all 1,207 rows of `language/statements/for-of/**`,
`language/expressions/assignment/dstr/**`, `built-ins/ArrayIteratorPrototype/**`,
`built-ins/GeneratorPrototype/**`. Run in 128-row chunks, one fresh process per
chunk; the 6 `*array-prototype*` rows ran `--isolate` (they replace
`Array.prototype[@@iterator]` and poison the runner's own realm). Base measured
with the file-copy A/B revert.

| lane | rows | before non-pass | after non-pass | flips |
| --- | ---: | ---: | ---: | --- |
| standalone (`.tmp/6651/nb-{before,after}-*.log`) | 1,207 | 164 | **143** | **+21, 0 lost, 0 other status changes** |
| host, ungated draft (`.tmp/6651/nbh-{before,after}-*.log`) | 1,207 | 214 | 207 | +10, **−3** ⇒ the gate above |

**Host control on the shipped change is a byte-identity proof.** A 9-program
corpus — the three admitted shapes, a for-of over a plain array literal, an
all-identifier assignment, an identifier default, a for-of identifier head, an
object pattern and a destructuring-free control — compiles **9/9
byte-identically on gc** before vs after (`.tmp/6651/sha-{before,after}.txt`),
while on standalone exactly the 3 admitted shapes move and the other 6 are
byte-identical. That is the intended delta, stated as bytes.

Pin file `tests/issue-6651-dstr-iterator-close.test.ts`, 7/7 — 5 verified RED
on the base tree, 2 are guards green on both sides, including the two negative
directions (an all-identifier pattern keeps the old lowering on BOTH targets; a
rest element after an exhausted slot must not step again).

Gates, run bare: coercion-sites, oracle-ratchet (`getTypeAtLocation +0`,
`ctx.checker +0`), dead-exports and typecheck pass untouched; loc-budget and
func-budget pass with the grants added to this file's frontmatter above, dated.

#### Residual sub-buckets (113 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 21 | `built-ins/Iterator/prototype/{chunks,windows}/**` + `Iterator/prototype/join/not-a-constructor.js` | **OUT OF SCOPE, not a gap.** These are the `iterator-chunking` / `Iterator.prototype.join` PROPOSALS; the edition index tags them ES2015 only because their `features` list also names `class`/`generators`. Building them would be implementing a proposal surface, not finishing ES2015. Recommend a `wont-fix`-with-reason on the #6651 definition of done rather than a lane. |
| 20 | `built-ins/GeneratorFunction/**` | ~13 need `GeneratorFunction(…)` — CreateDynamicFunction, i.e. compiling source at runtime, which standalone cannot do without the eval provider; the other ~7 (`name`, `is-a-constructor`, `has-instance`, `prototype/*`) need the **intrinsic object itself** reified so `Object.getPrototypeOf(function*(){}).constructor` answers a real function with the right descriptors. |
| 14 | `Expected a TypeError … no exception` | scattered: `iterator-next-result-type`, non-callable `return`, `GeneratorPrototype/*/from-state-executing`, `restricted-properties`. |
| 7 | `quickjs provider is not built` | environment only at measurement time; the provider now exists in the shared cache (coordinator note, 2026-09-21) and these are re-measurable with `JS2WASM_EVAL_ENGINE=quickjs`. |
| 7 | `Expected a Test262Error … no exception` | mostly `scope-param-elem-var-{open,close}` / `params-dflt-ref-arguments` — generator parameter-scope shapes. |
| 6 | `Cannot access property on null or undefined` | `yield`-in-operand rows (`yield-as-yield-operand`, `rhs-yield`, `in-rltn-expr`). |
| 6 | `called value is not a function` | `*-spread-arr-*` / `named-yield-*` — a generator result spread through a call. |
| 6 | `Expected a Test262Error but got a TypeError` | `*/dstr/ary-ptrn-elem-ary-*` — cluster A's generator-destructuring lane. |
| 4 | `Cannot destructure 'null' or 'undefined'` | `*/dstr/*-ary-empty-init.js`, same lane. |
| 4 | `SameValue(«"outside"», «"inside"»)` | `scope-body-lex-distinct` / `scope-param-elem-var-*` — a generator body's lexical environment is shared with the params'. |
| 2 | `SameValue(«NaN», «undefined»)` — `dflt-obj-ptrn-prop-ary` | the f64-typed-parameter-slot defect cluster **C2** owns; deliberately not touched here. |
| ~16 | assorted singletons | `default-proto`, `prototype-relation-to-function`, `iterator-next-reference`, `map-expand`, `throw-from-finally`, `head-lhs-let`, `detach-typedarray-in-progress`, … |

#### Next steps for this cluster, in rows-per-fix order

1. **Widen the drive's admission scan to DEFAULTS** (`[a = init]`) and to
   object/nested array patterns in non-rest slots. The refusal is one function
   (`planElements`) and the per-element emitter already has the value in a
   local; that reaches the `*-init-*` and `obj-prop-elem-target-*` rows.
2. **Classify the 21 Iterator-helpers rows** as out-of-scope in the #6651
   definition of done (above), which removes them from the gap arithmetic.
3. **Reify the `GeneratorFunction` intrinsic** (7 rows) separately from
   CreateDynamicFunction (13 rows, eval-dependent).
4. **Give the host lane a struct-capable rest drain** if the drive is ever to
   be ungated — see the gate rationale above.

### 2026-09-21 — Cluster A (native generator lowering, standalone), slice A2: a suspension inside a `for-of`

- **Branch** `worktree-agent-ab77b42be7e8077f0`, based on
  `claude/es2015-test262-plan-54tooh` @ `3769840f` (== `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-ab77b42be7e8077f0`.
- **Manifest** `plan/agent-context/6651/A2-forof-pattern-suspension.txt`, 278
  rows, sha256
  `2c2e807946cf393a7f0d7dc6882a0c9df421e07f40c532748d18059f604d5d7d` — A1's
  197-row cluster-A manifest ∪ the 5 `module-code/*-gen-*` rows cluster I
  routed here ∪ the generator / `dstr` rows clusters C and G routed here.
- **Engine:** every runner command carried `JS2WASM_EVAL_ENGINE=quickjs`
  (artifact `073742801ba7`, adapter key `d4799bda84cfed0d`); the compile-only
  probe does not run code and is engine-independent.

#### The finding that reframed the family: it is not all pattern work

A1 handed over ~90 rows described as "`yield` inside a destructuring pattern".
Instrumenting every `return false` / `fail()` in the candidate and plan gates
and running the 278-row manifest through a **compile-only** probe (A1's method;
`plan/agent-context/6651/A2-bail-attribution.tsv` is the per-row result) says
the residual is in fact **two** mechanisms, not one:

| rows | first bail | what it is |
| ---: | --- | --- |
| 65 | none — candidate gate | A1's enumerated small gates (own-name fn-expr, computed method names, rest params, …) |
| 37 | `lowerStatements` · `ExpressionStatement` | `result = <pattern> = vals` and friends — the pattern family proper |
| 32 | `lowerStatements` · `ForOfStatement` | **`lowerStatements` had no ForOfStatement arm at all** |
| 6 | `ClassDeclaration` / `FirstStatement` / `WithStatement` | unrelated shapes swept in by the partition |

Every plan bail in the whole 278-row manifest came from ONE line — the generic
"unmodeled statement" `return fail()` at the end of `lowerStatements`
(`A2BAIL plan gn:843:14`, 185/185 hits). So the gate to widen is the statement
dispatch, and **for-of was the arm that was simply missing**: 8 of those 32 rows
(`language/statements/for-of/yield*.js`) are plain body-yield loops with no
destructuring anywhere, and the other 24 are the for-of/`dstr` head-pattern
rows, which need the for-of arm **before** any pattern modelling can apply.

The host lane is not a reference here and A1's 8/8 figure holds — but the two
halves fail for DIFFERENT reasons, and only one of them is a feature gap:

| family | host verdict | first failing assertion |
| --- | --- | --- |
| for-of body-yield (8 rows) | 8/8 fail | `First iteration: pre-yield Expected SameValue(«2», «1»)` — the eager buffer ran the WHOLE loop before the first `.next()` |
| pattern-default (8 probed) | 8/8 fail | `Expected SameValue(«null», «undefined»)` — the yielded value's representation |

The first is an artefact of the host lane's eager lowering, which the native
state machine does not share. That is a positive prediction, and it held: all 4
reachable rows of that family now pass in standalone while still failing on the
host. Log: `.tmp/6651/probe-host16.log` (host, 16 rows, all fail).

#### A2 design

Model the for-of as a **non-suspending loop header state**. `lowerForOf`
reserves a header, a body entry and an exit; the header's new `for-of-step`
terminator performs exactly one IteratorStep per entry and transfers to the body
(a value was produced) or the exit (exhausted) without returning to the caller.
The suspension stays where it already worked — in the body's own states — so
nothing about the yield model changes.

The one genuinely new requirement is that the **iterator has to survive a resume
boundary**. It rides the per-site `externref` frame slot family that
`yield* <generic iterable>` already allocates (`iterableDelegationSites`), driven
by `__gen_delegate_start` / `__gen_delegate_step`: that is the one carrier in the
state struct already proven to hold a live iterator record across `.next()`
calls, so the slice adds a terminator and an emitter arm rather than a second
frame mechanism. GetIterator happens once (the slot's null-guard); the slot is
cleared on exhaustion, which is what lets an enclosing loop re-enter with a fresh
iterator and what makes the close a no-op after normal completion.

§14.7.5.7 step 6 is the second requirement, and the reason for a new **unwind
chain entry** rather than folding the close into the terminator: a `.return(v)` /
`.throw(e)` delivered at a yield INSIDE the body has to run IteratorClose, but
only if no closer handler intercepts first. `{ kind: "iter-close" }` sits in the
innermost-first chain, closes the record and keeps walking — so an inner `catch`
that intercepts a throw still wins (its arm `br`s out before the close is
reached), while a return completion passes through the close on its way out. Both
results of the close call are discarded: §7.4.9 step 5 ignores its value, and
step 6 lets the ORIGINAL completion win when the close itself throws.

Four bails are deliberate, and three of them are measurements rather than
caution:

1. **JS-host lane** — `lowerForOf` refuses outright unless `noJsHostTarget`.
   The rule every #680/#2864 widening follows: the host has a working fallback,
   so admitting shapes there is pure regression risk for no conformance gain.
2. **Subject must be an ITERATOR object** (`[Symbol.iterator]` **and** `next`).
   Measured on this branch: a `number[]`, a `string` and a `Set` each compile
   host-free through `__gen_delegate_start` and then **trap at the first step**,
   while a native generator and a `{ next(){}, [@@iterator](){} }` object both
   run correctly (`.tmp/6651/p3.mts`). Admitting arrays would trade the loud #680
   refusal for a runtime trap — strictly worse than the leak it replaces. Arrays
   have their own vec drive, the split `yield*` already makes.
3. **`return` in the body** — the plain `return` terminator completes without
   walking the unwind chain, so the iterator would never be closed.
4. **`yield*` in the body** — the native-gen / vec delegation terminators rebuild
   their abrupt context from `replay` entries ONLY, which would silently DROP
   this loop's `iter-close` entry. This is what keeps the four
   `for-of/yield-star-*.js` rows red; closing it means giving those two
   delegation kinds the full unwind chain the `iterable` kind already has.

Two defects were found by probing rather than by reading, and both were silent:

- **`__gen_result_unwrap` could only see through ONE result-struct type**, the
  first delegating generator's. A `for (x of gen)` loop is the first shape that
  makes an **f64**-carrier generator set `nativeDelegates`, and reading `value`
  out of an f64 struct in an `externref -> externref` helper made the MODULE
  invalid (`type error in fallthru[0] (expected externref, got f64)`). It now
  enumerates every result-struct type in the module and boxes a non-externref
  carrier (`undefSentinel`, so `yield;` comes back out as `undefined`).
  **Keep the enumeration scoped to DELEGATING generators.** The first cut
  enumerated every native generator, which sounds strictly more correct and
  quietly changed the bytes of **every generator module in the corpus** — a
  module with no delegating generator used to get the identity body and now got
  a real unwrap chain. A 10-row SHA spot-check caught it; a verdict-only control
  would not have, because none of those modules' verdicts moved. Scoping it back
  restores byte-identity and keeps the blast radius at the shapes this slice
  actually reaches.
- **`__gen_delegate_step` status 0 returns the RAW result object**, not its value
  — that is what `yield*` re-yields under the `done: -1` sentinel for its
  consumer to unwrap. The first cut bound that raw object as the loop variable,
  which left `typeof x === "number"` TRUE while `x * 2` and `yield x` both
  answered **NaN**. All four target rows passed anyway, because none of them
  reads `x`. `tests/issue-6651-generator-forof-suspension.test.ts` case 2 is the
  pin for it.

#### Measurements

| 278-row manifest, compile-only probe | ok (host-free) | host_import | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/probe-base.tsv`) | 138 | 79 | 61 |
| after (`.tmp/6651/probe-after-final.tsv`) | 142 | 75 | 61 |

Exactly 4 rows moved, all `host_import → ok`, none backwards. Through the real
runner (`--standalone --isolate`, QuickJS):

| `language/statements/for-of/yield*.js`, 8 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/forof-before-final.log`) | 0 | 0 | 8 |
| after (`.tmp/6651/forof-after-final.log`) | **4** | 0 | 4 |

**+4 rows pass, 0 pass → non-pass.** The 4 still red are the `yield-star-*`
sub-family held by bail (4) above.

Corpus-wide reach, to size the widening beyond the manifest: every test262 file
containing both `yield` and a `for (… of …)` (182 files) was probed before and
after. 13 modules changed, none backwards; 4 are the rows above and 9 are
`staging/sm/**` rows the runner SKIPS, so they do not move conformance
(`.tmp/6651/corpus-{before,after}.tsv`, `.tmp/6651/changed13-after.log`).

#### Neighbourhood regression control — binary identity, not verdict sampling

The control is stronger than a before/after verdict run: a module whose wasm SHA
is unchanged cannot have changed verdict, so the sweep compares **compile bucket
+ wasm SHA-256** for every generator-bearing row in the neighbourhood — all of
`language/expressions/generators`, `language/statements/generators`,
`built-ins/GeneratorPrototype`, `language/statements/for-of` and
`language/expressions/assignment/dstr` that mention `yield` or `function*`
(854 of 1,736 rows; the other 882 contain no generator at all, so there is no
native plan and no `nativeDelegates` for this change to perturb).

| lane | rows | modules whose bytes changed |
| --- | ---: | --- |
| standalone (`.tmp/6651/nb-sa-{before,after3}.tsv`) | 854 | **4** — the four target rows, `host_import → ok` |
| host / default (`.tmp/6651/nb-host-{before,after3}.tsv`) | 854 | **0 — byte-identical** |

The host result is structural as well as measured: `lowerForOf` fails
immediately unless `noJsHostTarget`, and `nativeDelegates` — the only other
reachable change — already required `ctx.standalone || ctx.wasi`.

Also green: `npm run -s typecheck`; `npx biome lint src tests scripts
--diagnostic-level=error`; `check-loc-budget` / `check-func-budget` /
`check-coercion-sites` / `check:oracle-ratchet` / `check:dead-exports`;
`check-compiler-boundaries --mode inventory`; `node scripts/equivalence-gate.mjs`
(22 failing / 1,720 passing, all 22 already in the baseline — no new regressions);
and the new 3-case unit suite `tests/issue-6651-generator-forof-suspension.test.ts`.

#### What is NOT done, and the map for the next owner

**The pattern half of A2 is untouched.** `[ x = yield ] = vals`,
`({ x = yield } = obj)` and the for-of head twins still take the #680 refusal.
The design question is settled and written down; the code is not.

§13.15.5 makes the pattern's element evaluation a **conditional** suspension —
the Initializer runs only when the element is `undefined` — while the whole #680
continuation model is built on an UNCONDITIONAL one (suspend, then recompile the
statement with the yield read from a spill). Re-running the statement in the
successor is what makes that model order-preserving, and a pattern cannot be
re-run: its `GetIterator` / `next()` / `Get` are observable, and the
`*-iter-rtrn-close*` rows assert `nextCount === 1` explicitly. The shape that
does work is the one this slice built for for-of — an explicit state graph:

```
S0   evaluate the rval; step the pattern's iterator once  → element spill
     branch: element is undefined ?
S1     yield          → sent spill                (the conditional suspension)
S2   PutValue the target from whichever spill is live
S3   IteratorClose if the record is still live; statement value = the rval
```

Every primitive for that now exists: the record slot, the step terminator, the
`iter-close` entry, a canonical-undefined test, and the synthesized
`<original target node> = <spill identifier>` statement idiom the `yield*`
assignment arm already relies on. Two open risks: (a) the sent-value carrier — a
resume binding is typed at the generator's carrier (f64 for a bare `yield;`) and
these rows assert `value === undefined` AND `x === 86` on the same binding, so
the value-representation work round 2's C3 row is about lands in the middle of
it; (b) `{}` and nested patterns as destructuring targets.

Residual buckets in the 278-row manifest after this slice, by first bail
(`plan/agent-context/6651/A2-bail-attribution.tsv` has the per-row detail):

| rows | bail / signature | note |
| ---: | --- | --- |
| 33 | `ExpressionStatement` — `result = <pattern> = vals` | the pattern family above; ~14 are the flat `x = yield` / `{ x = yield }` defaults, ~12 the `*-iter-rtrn-close*` family, which additionally needs a close at a mid-pattern suspension — the `iter-close` entry this slice adds IS that mechanism |
| 28 | `ForOfStatement` — head is a PATTERN | blocked on the same modelling; the loop half is now done |
| 4 | `ForOfStatement` — `yield*` in the body | bail (4) above; needs the full unwind chain on the native-gen / vec delegation terminators |
| 4 | `ExpressionStatement` — `({ get yield() { return 1 } })` | NOT a yield at all — a getter NAMED `yield` trips the structural-lowering scan. Cheapest remaining row in the family |
| 3 | `ExpressionStatement` — `(yield 3) + (yield 4)` | an arithmetic binary with two yields; `lowerCommaExpressionContinuation` already does the left-to-right two-suspension shape for `,` |
| 2 | `ExpressionStatement` — `c[yield 9]()` | a yield in call arguments; needs a call root in `lowerContinuationRoot` |
| 1 | `ExpressionStatement` — `` str = `1${ yield }3${4}5` `` | a TemplateExpression root |
| 1 | `ExpressionStatement` — `obj.foo = yield` | the member-target exclusion #2864 documents; capturing the receiver as a prefix operand is order-preserving and would admit it |
| 65 | candidate gate (no plan bail) | A1's enumerated list, unchanged |

### 2026-09-21 — Cluster C, slice C3 (the f64-typed defaulted parameter)

- **Branch** `worktree-agent-af2a369315ce9f6a7`, base
  `claude/es2015-test262-plan-54tooh` @ `3769840fe0` (== `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-af2a369315ce9f6a7`.
- **Manifest** `.tmp/6651/C3-manifest.txt`, 42 rows, sha256
  `b59c95b8c08e1e52ebd780d46d94d1eb133dc9e2d67d6ae6a6699b1d104d687b` — the 26
  `dflt` rows of C's manifest + the 7 of G's + cluster I's 9-row "parameter
  defaults / destructuring params" bucket (B11). The three
  `module-code/*-dflt-*-gen-*` rows in I match `dflt` only because it spells
  "default"; they are generator leaks and belong to A.
- **Eval engine `quickjs`** on every run below (adapter rebuilt after each
  `src/` edit; its key did not move, the artifact was copied from the main
  checkout's `.test262-cache/`).

#### What C2 left, and why the one-line widening was not the fix

C2-c above diagnosed this exactly and stopped in the right place. Its
one-line widening of `isUndefinedDefaultOnlyParam` moves the SLOT
(WAT-verified) and nothing else, because the parameter's checker TYPE is still
`number`: the identifier read path re-narrows it (`local.get 1; call
$__unbox_number`) one instruction after the prologue correctly declined to use
the default. **Both halves are needed, and neither is sufficient alone** — with
the slot widened but the read guard reverted, the probe still fails
(`.tmp/w6651C3/p13-ng.out`).

#### The change

| file | role |
| --- | --- |
| `src/checker/type-mapper.ts` | `isJsUntypedDefaultParam` (syntax-only predicate), `widenJsUntypedDefaultParamSlot` (scalar slot → `externref`, memoising which nodes it moved), `isJsUntypedDefaultWidenedParam` |
| `src/codegen/strict-eq-stale-type.ts` | `readsJsUntypedDefaultWidenedParam` — the READ guard, in the module that already owns "the checker type of this expression is stale, keep the carrier" |
| `src/codegen/destructuring-params.ts` | one delegation inside `widenUndefinedDefaultParamSlot`, which carries the closure lane and all three object-literal-method derivations with it |
| `src/codegen/declarations.ts`, `src/codegen/class-bodies.ts` ×2 | the remaining parameter-lowering sites, signature and fctx-build phases |
| `src/codegen/expressions/identifiers.ts` | one clause in the unbox-narrowing guard |

Three design points worth keeping:

1. **JavaScript sources only.** In a `.js` file a parameter has no declared
   type, so `m(a = (count += 1))` typing `a` as `number` is a guess about the
   DEFAULT; in a `.ts` file the same text genuinely declares the parameter and
   `m(false)` is a type error. This is also what makes the numeric fast path
   safe: the whole `.ts` corpus is untouched **by construction**, and measured
   — all **32** files under `website/playground/examples/` + `benchmarks/`
   compile to **byte-identical binaries** (`.tmp/6651/corpus-base.txt` vs
   `corpus-new.txt`, sha256 of each `result.binary`, zero-line diff).
2. **Scalar slots only** (`f64`/`i32`/`i64`). A string default is already
   `externref`; an object-valued default has its own nullable widening in the
   closure lane whose reads legitimately narrow back to the struct, and
   widening the read guard over it would change unrelated npm-shaped code.
3. **No call-site carve-out was attempted, deliberately.** "All callers pass
   numbers, keep the f64" is unsound for this shape: a JS function's callers
   are not statically enumerable (exported, invoked dynamically, or — as in
   every row of this manifest — a class method reached through the prototype).

#### Results

| standalone, `--isolate`, engine quickjs | pass | fail |
| --- | ---: | ---: |
| before (`.tmp/6651/C3-before.log`) | **0** | 42 |
| after (`.tmp/6651/C3-after.log`) | **14** | 28 |

All 14 are `dflt-params-arg-val-not-undefined.js` — class methods (static and
not), generator methods, object-literal methods, function declarations and
expressions, generators, arrows. Zero rows moved the other way.

#### Control — the whole `language/**` parameter surface, BOTH targets

The change moves the slot and type of every defaulted parameter in every JS
input, so the control is not a neighbourhood. `.tmp/6651/C3-control.txt`, **2,370
rows**, sha256 `3e8d80a0ae76e6a98b1f0c5885499c06a058ac46cc582c6e50077500d20ce808`:
every test262 file under `language/{expressions,statements}/{function,
arrow-function,class,object,generators,async-function,async-arrow-function,
async-generator}/**` and `language/default-parameters/**` whose body (frontmatter
stripped) contains a parameter-list default. Run in 12 chunks of ≤200 rows, one
runner at a time, all 12 chunk exits `0` on all four passes.

| target | before non-pass | after non-pass | pass→non-pass | non-pass→pass |
| --- | ---: | ---: | ---: | ---: |
| standalone (`ctl-{before,after}-standalone.log`) | 210 | 189 | **0** | **21** |
| host (`ctl-{before,after}-host.log`) | 202 | 180 | **0** | **22** |

Other gates, all on the final tree: `node scripts/equivalence-gate.mjs` — 22
failing / 1,720 passing / 22 known-failures, **no new regressions**;
`pnpm run check:ir-fallbacks` — OK, no unintended/post-claim/module-level
increase; loc/func/coercion/oracle-ratchet/dead-exports/biome/typecheck green.

#### The measured exclusion: `async` METHODS are not widened

**The first cut of this slice regressed 16 rows (standalone) / 20 (host)** —
`dflt-params-arg-val-undefined.js` and `dflt-params-trailing-comma.js` in
exactly four lanes: class `async-method`, `async-method-static`,
`async-gen-method`(`-static`), and the object-literal `async-meth`. Only the
2,370-row control saw it; the 42-row manifest did not contain a single one of
those rows, and the probe shapes all passed.

Root cause, as far as it was bisected: an async method's callable value is a
cached singleton trampoline (`closures/method-trampolines.ts`) whose wrapper
signature is derived from the method signature at the first `C.prototype.m`
access and rebuilt at finalize by the #1669 `pendingMethodTrampolines`
enrolment. With the slot widened, invoking the method **through the extracted
reference** stops applying the parameter defaults —
`new C().m(undefined)` is correct, `var ref = C.prototype.m; ref()` is not
(`.tmp/w6651C3/p13.src.js`; base OK, widened THROWS). Reverting only the read
guard does not change it, so it is the widening reaching that lane, not the
narrowing guard.

That is a defect in the trampoline's signature rebuild, not in the widening —
async FUNCTIONS, async ARROWS, sync methods and generator methods all take the
widening and gain. `isAsyncMethodParam` in `type-mapper.ts` excludes the one
lane; it keeps every measured gain and costs the four async-method
`*-arg-val-not-undefined` rows, which stay on their pre-existing failure.
**Remove that clause together with a fix to `finalizeMethodTrampolines`, and
re-run this same control** — it is the only thing that catches the class.

#### Residuals in the manifest (28)

| rows | signature | owner |
| ---: | --- | --- |
| 10 | `SameValue(«NaN», «undefined»)` — `dstr/*dflt-obj-ptrn-prop-ary` | the NESTED-pattern default, one level inside the parameter: the binding element's slot, not the parameter's. `resolveBindingElementType` widens only elements WITHOUT a default; the `{ x: [y = 7] = [] }` shape needs the same absence-of-information argument applied to a defaulted element. |
| 9 | `Cannot access property on null or undefined` — `params-dflt-ref-arguments`, `dstr/ary-ptrn-elem-ary-rest-init` | `arguments` bound in the PARAMETER scope (cluster I's B11 finding), and a rest-with-init element reading null. Unrelated to the slot. |
| 7 | `Cannot destructure 'null' or 'undefined'` — `dflt-ary-ptrn-elem-ary-empty-init` | same nested-default family as the 10 above. |
| 2 | `Cannot read properties of undefined (reading 'next')` — object-literal GENERATOR methods | pre-existing and independent: the reduced shape (`.tmp/w6651C3/p6.src.js`, an object-literal `*m()` with six defaulted params, `var ref = obj.m`) **fails on base too**. One of the two changed its SIGNATURE from `«0» vs «false»` to this, which is the slot fix landing on top of a different defect, not a new one. |

#### Two process notes

- The A/B swap script started out covering five of the six changed files; the
  "base" tree then imported an export that did not exist and a 45-minute
  control pass came back as 12 identical `SyntaxError`s. An all-error log is
  broken infrastructure, not a measurement — but it is only obvious if you
  look at the log rather than the counts line.
- The `--isolate` runner costs ~2–4 s/row; the in-process runner does 200 rows
  in ~216 s. For a DIFFERENTIAL control (same rows, same order, both passes)
  the in-process mode is sound and is what made a 2,370-row × 2-target ×
  before/after control affordable at all (~3 h).

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E2

- **Branch** `worktree-agent-a1920dd19b9b71c1e`, base
  `claude/es2015-test262-plan-54tooh` (`3769840fe0`, identical to `origin/main`).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a1920dd19b9b71c1e`.
  Engine for every run below: **QuickJS** (`JS2WASM_EVAL_ENGINE=quickjs`,
  artifact `073742801ba7`, adapter `d4799bda84cfed0d`) — so the 22
  detached-buffer rows E1 could not measure at all WERE scored this time.

- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt` (144 rows,
  E1's 13 included), `--standalone`, measured on this branch's own base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/before/`, base tree) | 13 | 130 | 1 |
  | after (`.tmp/6651/after2/`) | **19** | 124 | 1 |

  Per-row set diff (`.tmp/6651/manifest-diff.txt`): **6 non-pass → pass, 0 pass
  → non-pass.** The before side reproduces E1's isolated result exactly
  (13 pass), which is what licenses the cheaper chunked lane used here.

#### What landed — ONE mechanism: the own-property SURFACE of a dynamic view

`ta-dyn-mop.ts` (#3177) gave `$__ta_dyn_view` its §10.4.5 arms for
`[[Get]]/[[Set]]/[[HasProperty]]/[[Delete]]/[[DefineOwnProperty]]/
[[GetOwnProperty]]/[[PreventExtensions]]`. It did **not** touch the natives
that answer the *reflective* own-key questions, and a `$__ta_dyn_view` is a
`$__vec_base` subtype (#3057) — so each of them answered **as if the view were
an Array**. Measured on this branch's base (`.tmp/6651/p2.js`, `.tmp/6651/p4.js`,
Float64Array, one string expando + one symbol expando):

```
Reflect.ownKeys(sample)                     0,1,2,length      spec: 0,1,2,test262,@@s
Object.getOwnPropertySymbols(sample).length 0                 spec: 1
hasOwnProperty.call(sample, 0)              false             spec: true
hasOwnProperty.call(sample, "foo")          false             spec: true
```

Two independent errors in one answer: `"length"` reported as an OWN key (it is
an accessor on `%TypedArray%.prototype`, §23.2.3.19, never own), and the view's
own expandos invisible because the generic vec arm does not know the side-table
exists. The predicates were worse — a uniform `false`, including for a valid
integer index.

The blast radius was **not** key listings. `propertyHelper.js`'s
`verifyNotConfigurable` deletes the key and then asks `hasOwnProperty` whether
it survived; a blanket `false` reads as "it was configurable after all". That
is how `internals/DefineOwnProperty/key-is-symbol.js` failed with *"Expected
obj[102] NOT to be configurable, but was"* while the descriptor it had just
defined round-tripped `w=false e=false c=false` correctly (`.tmp/6651/p3.js`).
The same helper's `verifyEnumerable` runs a `for…in`, which is a THIRD native
(`__object_keys_forin`) that #3177 never touched at all.

New module `src/codegen/ta-dyn-own-keys.ts` (`fillTaDynViewOwnKeyArms`), one
emitter per shape, spliced at finalize AFTER `fillVecLengthDynamicArms` (whose
vec own-`"length"` arm sits in the same natives) and after
`fillTaDynViewMopArms`:

1. **Own-ness predicates** — `__hasOwnProperty`, `__object_hasOwn`,
   `__propertyIsEnumerable`: canonical index → §10.4.5.14 IsValidIntegerIndex
   (`__ta_dyn_has_idx`); any other key → the expando side-table by recursive
   self-call. One body serves all three: an existing integer-indexed element is
   always enumerable (§10.4.5.1 builds its descriptor with
   `[[Enumerable]]: true`), and a non-index key's enumerability IS the
   expando's answer.
2. **`__getOwnPropertyNames`** — a FRESH vec of the indices, then the expando's
   own string keys in creation order. Building fresh instead of falling through
   is what removes the spurious `"length"`.
3. **`__object_keys` / `__object_keys_forin`** — same emitter, with
   `__object_keys(expando)` as the delegate because that delegate carries the
   enumerability filter. #3177's narrower indices-only `__object_keys` arm is
   **deleted** from `ta-dyn-mop.ts` in the same change-set rather than shadowed;
   two arms racing for the front slot of one native is worse than one.
4. **`__getOwnPropertySymbols`** — the expando's symbols, or a fresh empty vec.

Plus one seam in `ta-dyn-mop.ts` that the same tests exposed:

5. **Observable ToNumber on an element write** (`__ta_dyn_set_elem`). It called
   `__unbox_number` directly, which answers NaN for an ordinary object without
   ever running its `valueOf` — so §10.4.5.16 step 1 was not observable and
   `Object.defineProperty(view, 0, {value: {valueOf(){throw}}})` completed
   silently. Now `__to_primitive(v, "number")` runs first. That is the shared
   coercion native doing the work, i.e. one hand-rolled shortcut REMOVED.

**Why a new module rather than the obvious place:** `ta-dyn-mop.ts` is a
tracked god-file at its LOC ceiling and `fillTaDynViewMopArms` is already a
966-line unit. Net effect of the split: `ta-dyn-mop.ts` **shrinks by 53 lines**,
`src/codegen/index.ts` grows by 6 (import + one call site per entry point).

#### Receipts

- **Neighbourhood control** — 1,213 rows (`.tmp/6651/control-targeted.txt`),
  `--standalone`, before vs after, identical 24-row chunking on both sides
  (`.tmp/6651/ctl24-{before,after}/`). Selection: every row under
  `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView}/**` whose
  SOURCE can reach a changed native (own-key / own-ness / enumeration
  vocabulary, or an element write whose value is not a bare numeric literal),
  plus the whole E manifest. pass **824 → 846**. Per-row set diff
  (`.tmp/6651/ctl24-diff.txt`): **0 pass → non-pass**, 22 non-pass → pass — the
  6 manifest rows, their BigInt twins, and six rows outside the ES2015 manifest
  (`internals/Set/{tonumber-value-throws,tonumber-value-detached-buffer,
  detached-buffer}`, `OwnPropertyKeys/integer-indexes-resizable-array-buffer-*`).
  - **Chunk size is load-bearing for THIS family, and the first control run
    proved it the hard way.** A 60-row in-process chunk reported 16 `pass →
    non-pass` rows and ZERO gains; every one was realm poisoning, not a
    regression — `internals/OwnPropertyKeys/not-enumerable-keys.js` read `fail`
    inside a 60-row chunk on BOTH sides while passing when probed alone. These
    tests install accessors on `TA.prototype` and `%TypedArray%.prototype` by
    design. Re-running both sides at 24 rows (the size the manifest runs use,
    and the size whose before-side reproduces E1's isolated numbers) turned the
    same comparison into 22/0. Treat a chunked verdict in this directory as
    provisional until the chunk size is pinned to a known-good one.
- **Byte-level blast radius** (`.tmp/6651/sha-{before,after}.txt`, 9 programs ×
  2 targets): the 4 standalone programs that dynamically construct a view
  differ; the 5 standalone programs that do not (plain object keys, plain array
  keys, plain `hasOwnProperty`, plain `for…in`, a STATIC `Int8Array`) are
  **byte-identical**, and **all 9 host-lane binaries are byte-identical**. The
  arms are `ref.test $__ta_dyn_view`-gated and only exist where the dyn-view
  type is registered, so this is the whole reachable set, not a sample.
- **Unit tests**: new `tests/issue-6651-e2-ta-own-keys.test.ts`, 8 cases. Each
  asserts a FULL key list or an exact predicate answer (both halves of the
  defect were answers of the right SHAPE), and the comparison runs INSIDE the
  module returning a number — a standalone module's strings are WasmGC arrays
  with no host-readable form, so returning one and comparing on the host reads
  `{}` for every case, pass or fail. Verified to FAIL on the base tree: 5 of the
  6 positive cases fail there, both negative controls pass on both trees
  (`.tmp/6651/unit-base.log`).
- **Gates**: loc-budget, func-budget, coercion-sites, oracle-ratchet,
  dead-exports, `check-compiler-boundaries --mode inventory`, `typecheck`,
  `biome lint`, and `scripts/equivalence-gate.mjs` (22 failing / 1,720 passing,
  no new) all pass. Grants added to this file's frontmatter: `index.ts` +6 LOC
  (+4 / +1 in the two generators), and coercion-sites for `ta-dyn-mop.ts`
  (the `__to_primitive` routing) and `ta-dyn-own-keys.ts` (the
  CanonicalNumericIndexString pair, MOVED from the deleted arm).

#### Residual buckets in the 144-row manifest (125 non-pass), re-measured

| rows | sub-bucket | why it is still open |
| ---: | --- | --- |
| 7 | `internals/Set/*` — receiver-aware `[[Set]]` | `__reflect_set` is a THREE-argument native `(obj, key, value)`; §10.4.5.5 / `Reflect.set(target, key, v, receiver)` needs the Receiver and the §10.1.9.2 OrdinarySetWithOwnDescriptor cascade over it. Not an arm — a fourth parameter plus a protocol |
| 3 | `internals/OwnPropertyKeys/{integer-indexes,integer-indexes-and-string-keys,integer-indexes-and-string-and-symbol-keys-}` | **the own-key answer is now correct** for all three; each then dies on an UNRELATED defect one line later: `new TA(makeCtorArg(4)).subarray(2)` — a method call whose receiver is a `new` EXPRESSION — evaluates to `null`. `emitDynViewSpeciesMethodTwoArm` / `emitDynViewMethodTwoArm` both open with `if (!ts.isIdentifier(receiverExpr)) return undefined`, and the else-arm recompiles the whole call (so a side-effecting receiver would be evaluated twice) — that restriction is load-bearing and lifting it is its own slice. Measured: two-step `var a = new TA(4); a.subarray(2)` works and answers `0,1` |
| 9 | `TypedArray/from/*` error propagation + 11 `TypedArrayConstructors/{from,of}/*` | needs `%TypedArray%.from` / `.of` as first-class inherited function VALUES (`TA.of === TypedArray.of`, `TA.of.call(ctor, 42)` → `Construct(ctor)`). Today `TA.of` reads `undefined` and `of/custom-ctor-returns-other-instance` reaches a refusal closure. An intrinsic-static-method mechanism, not an arm |
| 5 | `ctors/object-arg/throws-setting-obj-*` | **E1's root cause is superseded — the static carrier's expando table is NOT the blocker.** Measured (`.tmp/6651/p10.js`): `var s = new Int8Array(1); s.foo = 7; s.valueOf = fn` reads back `7` and `"function"` on a STATIC carrier, so the side-table exists and works. The single remaining gap is `__to_primitive`: `Number(s)` answers `0` and `s + 0` answers `"00"` for BOTH static and dynamic views, i.e. it still reduces through `Array.prototype.toString` and never runs OrdinaryToPrimitive. One arm in the `carrier-to-primitive.ts` style (§7.1.1.1 cascade for the view carriers) should take all five; it was left out here because `__to_primitive` is a hot shared native and the honest control for it is corpus-wide, not TypedArray-shaped |
| 5 | `ctors/object-arg/iterator-*` | unchanged from E1: the ctor argument is a CALLABLE (`function(){}`), neither `$Object` nor a vec, so dispatch falls to the count form and never consults `@@iterator` |
| 22 | detached-buffer cohort | now MEASURED under QuickJS rather than unmeasurable — and still failing; they are real gaps, not environment |
| 9 | `prototype/toLocaleString/*` | needs per-element `Invoke(element, "toLocaleString")`; a user `Number.prototype.toLocaleString` override is not honoured even on a direct call |
| rest | `Object.prototype.toString` (#4119, cluster H), species-ctor `this`, `{filter,map}` callback receiver IDENTITY, DataView proto identity, `%ArrayIteratorPrototype%` results | each its own mechanism, unchanged from E1's table |

**Not attempted in this slice, deliberately:** the four buckets above that need
a mechanism each (receiver-aware `[[Set]]`, the `from`/`of` intrinsics, the
`__to_primitive` carrier arm, the non-identifier receiver). The brief's rule was
to land one mechanism FULLY with receipts before starting the next; the own-key
surface is that mechanism, and each of the four is comparable in size to it.

### 2026-09-21 — Cluster B (RegExp `@@` protocol, standalone), slice B2: the observable `RegExpExec` substrate

- **Branch** `issue-6651-cluster-B2-regexp-exec`, based on
  `claude/es2015-test262-plan-54tooh` @ `16ae7ce977` (origin/main + A2 + C3 + E2).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a3fef6f654cd4d90a`.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt` **minus B1's 7
  landed rows** = 140 rows, sha256
  `c75f3f64b702b062778703d26ba3e71d08f7aa86fa7822c954ebc7b2cb3e33c1`. The
  subtraction was not taken on trust: the full 147-row file was re-measured on
  this source-clean base and came back **7 pass / 129 fail / 11 compile_error**,
  exactly B1's published after-state, and the 140 non-pass rows ARE the manifest.
- **Engine**: `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`, adapter
  key `d4799bda84cfed0d`), `--standalone --isolate`, 64-row chunks, one runner
  at a time. B1's 7 `cross-realm` / `proto-from-ctor-realm` rows are measured
  here rather than reported unmeasurable.

#### What of draft PR #5393 was carried

#5393 (`codex/5198-regexp-exec-slice-b-checkpoint-20260901`) was fetched and
read. Its delta against the `main` it last merged is **two files and no
production source**: `plan/issues/5198-…md` (+232) and
`tests/issue-5198-es2015-regexp-r2.test.ts` (+35). So there was no
implementation to integrate — the branch is a *contract* checkpoint, and
deliberately so: its own audit records that it would make "no production-source
edit" until an unmerged result-carrier candidate was reconciled, and the
reconciliation that followed concluded **"do not reapply b85"** because the
bundle was already an upstream ancestor.

What it does own, and what this slice takes from it:

1. **The pre-loop contract**, stated as a boundary: one helper performing
   `Get(rx, "exec")`, calling a callable override with `rx` and the coerced
   string, propagating getter and call abrupt completions, rejecting only
   non-object non-null results — and explicitly NOT reading `index`, `length`,
   captures, flags or replacement data, because those are C1-C4. The module
   header of `src/codegen/regexp-exec-protocol.ts` implements exactly that
   boundary.
2. **Its 11-row census** (1 pass / 10 fail on `7fff`), which named the `@@match`
   / `@@replace` / `@@search` custom-`exec` rows. Every one of those 11 is in
   this slice's manifest and its recorded status matches what was measured here
   three weeks later, which is a useful independent confirmation that the
   failure is structural rather than drifting.
3. Its warning that `built-ins/RegExp/prototype/Symbol.search/
   cstm-exec-return-invalid.js` **passes for the wrong reason** — its expected
   TypeError was being produced by the incompatible-receiver path, not by a
   verified custom-exec result check. That row is still `pass` after this slice,
   now for the right reason, and it is a control rather than a claim.

#### The defect, and why the two biggest buckets are one bucket

`recoverRegExpStructFromExternref` is the standalone RegExp brand check, and it
ran as the **first instruction of every reflective `RegExp.prototype.*` body**.
That is correct for `.test`, `.exec` and the flag getters, and wrong for the
four `@@` methods: §22.2.6.8/.11/.12/.14 step 2 requires only `Type(rx) is
Object`, and the brand requirement appears later — in §22.2.7.1 **RegExpExec
step 5**, reached only when `exec` is *not* callable.

So `RegExp.prototype[Symbol.search].call({exec: f}, s)` is spec-legal and the
compiler answered `TypeError: Method called on incompatible receiver` before
`f` could ever run. That is why the residual table's 18 `brand check failed`
rows and its 19 `Expected a Test262Error but got a TypeError` rows are not two
buckets: they are the same ordering defect, observed one step apart. The brand
check is not deleted by this slice — it is **moved to where the spec puts it**,
with the identical message, so a genuinely wrong `this` with no `exec` still
reports exactly what it reported before (pinned by a control).

#### What changed

One new module, `src/codegen/regexp-exec-protocol.ts` (~330 LOC), plus a 47-line
arm in `emitRegExpProtoMemberBody`. **No new host import** — the emitted code is
built from natives the standalone object runtime already exports
(`__extern_get`, `__extern_set`, `__extern_toString`, `__is_callable`,
`__typeof_object`, `__same_value_zero`, `__box_number`, `__unbox_number`,
`__objvec_new/push`, `__apply_closure`, `__str_indexOf`).

The module is the substrate plus the two method bodies whose spec text consumes
the exec result trivially:

- **`buildRegExpExecInstrs`** — §22.2.7.1, emitted once and inlined at each call
  site. Its builtin arm (steps 5-6) is passed in as a callback, so the module
  knows nothing about the `$NativeRegExp` struct and stays usable from any
  receiver shape.
- **`emitRegExpSymbolSearchBody`** — §22.2.6.12 in full: the two `lastIndex`
  `Get`s, the two conditional `Set`s, the exec, and `Get(result, "index")`.
- **`emitRegExpSymbolMatchBody`** — §22.2.6.8 steps 1-5 in full (step 5's
  non-global arm *is* `return RegExpExec(rx, S)`), plus a deliberately PARTIAL
  global arm: it performs step 6's observable prefix — `Set(rx, "lastIndex",
  +0)` and the first `RegExpExec` — and then answers `null`, which is what this
  closure answered before the change (its body was a `ref.null.extern`
  placeholder). The collect loop needs a runtime Array and AdvanceStringIndex;
  that is a second mechanism and it is recorded as a residual below rather than
  approximated.

Three things the implementation had to get right, each measured rather than
assumed:

1. **`SameValue`, not `SameValueZero`.** `__same_value_zero` is the only
   ready-made comparator, and it differs from §7.2.10 on exactly one input:
   `±0`. §22.2.6.12 steps 5 and 8 compare `lastIndex` against `+0` and against
   its own previous value, and two rows hinge on the difference
   (`set-lastindex-init-samevalue` writes `-0` and requires the `Set` to happen
   anyway; `set-lastindex-restore-samevalue` requires the restore). The
   correction is `1 / x < 0` on the already-proven-numeric operands — no
   `i64.reinterpret_f64`, no extra local.
2. **`Type(x) is Object` needs two natives, not one.** `__typeof_object`
   implements `typeof`, and `typeof null === "object"` — under the #2106
   singleton regime it answers 1 for a null externref. A receiver test that
   trusted it alone would admit `.call(null)`, which `this-val-non-obj` requires
   to be a TypeError. The null test comes first and separately, and the same
   ordering makes RegExpExec step 4.b correct for `undefined` (a tagged
   singleton, not null, so it lands in the throw arm).
3. **The builtin arm must be emitted and spliced out BEFORE any further index is
   read.** The builtin lowering registers late imports, and a late import shifts
   every defined-function index at or above it. `flushLateImportShifts` rewrites
   what is still in `fctx.body` — it cannot rewrite indices already captured in
   a JS object. So the resolved-natives record is **re-resolved after** the arm
   is captured (the #2043 late-shift class, in its easiest-to-miss form).

#### Receipt — manifest

| 140 rows, `--standalone --isolate`, QuickJS | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/B2-before.log`) | **0** | 129 | 11 |
| after (`.tmp/6651/B2-after.log`) | **10** | 119 | 11 |

**+10 rows pass; every one of the other 130 rows keeps its EXACT status.** The
two logs were joined row-by-row, not compared by count: no `fail` became a
`compile_error` and none the other way, and the compile_error total is
unchanged at 11. The ten:

| row | what it pins |
| --- | --- |
| `@@search/cstm-exec-return-index` | a custom `exec` runs on a non-RegExp receiver and its result's `index` is returned |
| `@@search/match-err` | the custom `exec`'s abrupt completion propagates, and `lastIndex` is NOT restored after it |
| `@@search/get-lastindex-err` | step 4's `Get` is real and its getter can throw |
| `@@search/lastindex-no-restore` | exactly TWO `lastIndex` reads, and the restoring `Set` is conditional |
| `@@search/set-lastindex-init` | step 5's `Set` actually runs, before `exec` |
| `@@search/set-lastindex-restore` | step 8's `Set` actually runs |
| `@@search/success-get-index-err` | step 10's `Get(result, "index")` is real |
| `@@match/this-val-non-regexp` | the brand-check widening, both halves in one row |
| `@@match/get-flags-err` | step 4's `flags` Get precedes everything; `global`/`unicode` are not read |
| `@@match/g-get-exec-err` | the partial global arm still performs its `Set` and its first RegExpExec |

The bucket movement in the residual signatures corroborates the diagnosis
rather than just the count: `Method called on incompatible receiver (RegExp
brand check failed)` went **18 → 13** and `Expected a Test262Error but got a
TypeError` went **19 → 13**, i.e. both halves of the same ordering defect
shrank together.

#### Controls — zero pass → non-pass

The blast radius is bounded by construction: the changed code is the body of
the `RegExp.prototype[@@match]` / `[@@search]` reflective closures, reachable
only from a program that READS one of those members. The 2,280-row universe
(`built-ins/RegExp/**` + `annexB/built-ins/RegExp/**` +
`built-ins/String/prototype/{match,matchAll,replace,replaceAll,search,split}/**`)
was therefore filtered to rows whose source mentions `Symbol.match` /
`Symbol.search` / `@@match` / `@@search` (157) — sound because **no row in the
2,280 includes `wellKnownIntrinsicObjects.js`**, the only harness file that
mentions those symbols, checked rather than assumed — plus a module-VALIDITY
canary of every third `prototype/{exec,test,flags,source,lastIndex,toString,
global,sticky,unicode}` row, because the closure bodies are emitted whenever
the RegExp proto glue is registered even if never called. Minus this slice's
own manifest rows, that is **167 control rows** (sha256
`2aa9d2bdbc76a1e7da1966b0e6a64d0cd889f81cff002c1d1f8fc9406469c2b1`).

| lane | rows | result |
| --- | ---: | --- |
| standalone, after (`.tmp/6651/ctrl-after.log`) | 167 | 114 pass / 35 fail / 18 compile_error |
| standalone, before — the **53 non-pass-after rows**, re-run on a `cp`-reverted `regexp-standalone.ts` (`.tmp/6651/ctrl-before.log`) | 53 | 35 fail / 18 compile_error, **0 pass**, and every row's status IDENTICAL to its after status |
| host — compiled-binary sha256 of 9 representative programs | 9 | **all 9 byte-identical** (`.tmp/6651/hostsha-{before,after}.txt`) |
| standalone — the same 9 programs | 9 | **7 byte-identical**; only `reflective-search` and `reflective-match` differ — the two admitted shapes (`.tmp/6651/sasha-{before,after}.txt`) |

The 53-row before-side is a **complete** check, not a sample: a pass→non-pass
regression is by definition a row that is non-pass AFTER, so running only those
53 on the base covers every candidate while costing a third of a full A/B.

Also green: `npm run -s typecheck`; `npx biome lint src tests scripts`; the five
ratchet gates (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`); the boundaries inventory
(`check-compiler-boundaries --mode inventory`, with the new module classified);
`scripts/equivalence-gate.mjs` (22 failing / 1720 passing, all 22 in the
committed baseline); B1's `tests/issue-6651-string-symbol-protocol.test.ts`
(9/9); and the new pin suite `tests/issue-6651-regexp-exec-protocol.test.ts`
(13/13 — the 10 rows plus 3 controls).

One late correctness fix landed AFTER the measurement and is proved not to
invalidate it: `emitRegExpSymbolMatchBody`'s `__str_indexOf` availability check
was moved ahead of its first `fctx.body.push`, because a body that declines
half-emitted leaves the operand stack unbalanced and makes the whole module
fail to validate. The guard is unreachable in practice (the helper is
registered by `prepareRegExpExecProtocol` itself), and the binary-sha control
confirms it: all 18 programs compile byte-identically before and after the
move.

#### Residual buckets (130 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 31 | `@@split` | §22.2.6.14 generically: **SpeciesConstructor** (9 rows are `species-ctor-*`, 6 of them the `Object_set_constructor` compile error — a `constructor` write on a plain object), the sticky splitter walk, and generic result reads. 21 of the 31 are the `RegExp.prototype[@@split].call(…)` shape, so they sit directly on this slice's substrate. #5198 Slice C4/E. |
| 30 | `@@replace` | §22.2.6.11's result loop: `Get(result, "0"/"index"/"length"/n)` with their coercions (14 rows are exactly `result-{coerce,get}-*`) plus **GetSubstitution**. #5198 Slice C3. |
| 20 | `@@match` | the GLOBAL collect loop this slice deliberately left partial — a runtime Array plus AdvanceStringIndex — and the 4 `exec-*` rows, which use the DIRECT `r[Symbol.match](s)` spelling (see below). |
| 13 | RegExp constructor / statics | observable `IsRegExp`, the called-as-function short-circuit, ordered `source`/`flags` Gets. #5198 Slice E. |
| 7 | `prototype/compile` | Annex B `compile` ordering and its SyntaxError/TypeError shapes — untouched by this slice. |
| 6 | `@@search` | 4 are the DIRECT spelling (below); 2 are `set-lastindex-{init,restore}-err`, which need a strict-mode `[[Set]]` on an accessor with **no setter** to throw a TypeError. `__extern_set` silently no-ops there — an object-runtime gap, not a RegExp one. |
| 5 | `prototype/flags` | the **generic** `flags` getter (accept any Object, ordered `ToBoolean(Get(R, …))`). #5198 Slice F; fails on host too. It also blocks `@@match/get-global-err`, which poisons `global` on a real RegExp and needs the flags GETTER to read it. |
| 18 | assorted: `String.prototype.{search,split,match,indexOf,replace}` (10), the individual flag getters `global`/`ignoreCase`/`multiline`/`sticky`/`unicode`/`source` (6), `prototype/exec` (2) | each its own mechanism, unchanged from B1's table. |

**The single largest lever left, and it is one mechanism:** the DIRECT spelling
`re[Symbol.search](s)` / `r[Symbol.match](s)` does NOT reach the reflective
closure — `tryCompileStandaloneRegExpSymbolCall` answers it from the static
native core, which never consults `exec`. That is why
`@@match/exec-{err,invocation,return-type-invalid,return-type-valid}` and
`@@search/{coerce-string,coerce-string-err,set-lastindex-init-samevalue,
set-lastindex-restore-samevalue}` are still red **even though the substrate
that would answer all eight now exists**. Routing that spelling through the
reified `RegExp.prototype[@@x]` method value (`__apply_closure`) is the next
slice, and it is the same change B1's residual table wanted for its 3
`invoke-builtin-*` rows. It needs a gate — the call's result type becomes
externref — so the gate should be a whole-file predicate ("this program writes
`exec`/observes the protocol"), which keeps `"abc".search(/b/)` byte-identical.

**Not attempted in this slice, deliberately:** the `@@replace` and `@@split`
bodies. The brief asked for the substrate as ONE mechanism used by all four
methods; it is one module, and it is wired into the two methods whose spec text
consumes the exec result trivially (`@@search` reads one property, `@@match`
non-global returns it by identity). `@@replace` and `@@split` consume the
result through loops that are each comparable in size to this whole slice, and
wiring them to the substrate *without* their loops would replace a wrong answer
with a differently wrong answer — so the substrate is published with its two
honest consumers and the loops are named above with their row counts.

### 2026-09-21 — Cluster D (native Promise combinators), slice D2: the observable intrinsic protocol

- **Branch** `worktree-agent-a0aff283c2b48c5f9`, **base** `claude/es2015-test262-plan-54tooh`
  at `a61c2d41b4` (= `origin/main` + slices A2 + C3). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a0aff283c2b48c5f9`. Engine for every
  measurement below: `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`,
  adapter `d4799bda84cfed0d`), runner `--standalone --isolate`.

- **What of PR #5883 was carried.** The held upstream PR
  ([#5883](https://github.com/loopdive/js2/pull/5883), commit `6e684e2950`
  "fix(promise): preserve observable resolve combinator protocol", Codex lane,
  #5197 R3-2) was fetched and **integrated, not re-derived** —
  `git cherry-pick -n 6e684e2950`. Four of its five files applied clean:
  `builtin-write-keeps.ts` (+99: `isStandaloneIntrinsicPromiseResolveWriteTarget`,
  the declaration-level proof that the `Promise.resolve = …` receiver is the
  unshadowed intrinsic), `declarations.ts` (+16: keep that write as a
  source-ordered module-init statement), `call-namespace-static.ts` (+53: the
  `sourceHasMethodOverride`-gated `observableResolve` admission plus the
  observable-only f64-vec arm), `promise-combinators.ts` (+931: the whole
  §27.2.4.1.1/§27.2.4.3.1 Get/Call/Invoke pipeline, the
  `$__combinator_all_resolve_cap` element-function carrier, and the
  literal/direct-vector emitters). Its 450-line control file
  `tests/issue-5197-promise-observable-combinator-r3-2.test.ts` came with it.
  ONE conflict, in `emitStandalonePromiseCombinatorRuntime`: main has since
  refactored that function's locals onto `buildNativeAllProviderLocals` +
  `buildNativePromiseCombinatorVectorBody` (the #5883 branch predates it).
  Resolved in favour of **main's** shape, keeping #5883's widening of `opts`
  (`notIterLocal`/`rejectReason` became optional so the observable flags can
  share the bag) and narrowing the pair back at the legacy vector body's call
  site — that body only ever understood the (#2922) not-iterable rejection
  pair, and widening its contract would have been the wrong direction.
  Nothing D1 already superseded was reapplied: the custom-constructor
  `.call(C, …)` protocol stays entirely in `promise-custom-combinator.ts`, and
  the observable gate explicitly excludes a Promise-subclass receiver.
  The port also flipped #5197's frontmatter to `in-progress`; that is reverted
  here — #5197 is `done` on `main` and its LOC/func grants (which this
  change-set relies on, and which live in a file this change-set touches, so
  they are not stranded) are unaffected by the status field.

- **Manifest** `plan/agent-context/6651/D-promise-combinators.txt` (101 rows),
  re-measured on this branch's own source-clean base:

  | | pass | fail | compile_error |
  | --- | ---: | ---: | ---: |
  | before (`.tmp/6651/D2-before.log`) | 26 | 57 | 18 |
  | after (`.tmp/6651/D2-after-s1.log`) | **47** | 40 | 14 |

  **+21, zero regressions** (per-row set diff: 21 non-pass → pass, 0 pass →
  non-pass). The 21: `{all,race}/invoke-resolve{,-get-error-reject,-get-once-multiple-calls,-get-once-no-calls,-on-promises-every-iteration-of-promise,-on-values-every-iteration-of-promise}`,
  `{all,race}/invoke-then{,-error-reject,-get-error-reject}`,
  `all/invoke-resolve-error-reject`, `all/resolve-not-callable-reject-with-typeerror`,
  `race/resolve-prms-cstm-then`. One fail→fail row changed its message
  (`race/resolve-self.js`: "called value is not a function" → "async completion
  marker not observed"); every other shared failure reports byte-identical text
  before and after.

- **Neighbourhood control** — all 729 `built-ins/Promise/**` rows, `--standalone
  --isolate`, 183-row chunks (`.tmp/6651/neigh-after-0{0,1,2,3}.log`):
  **pass 421, fail 174, compile_error 134**. The before lane was then run on the
  **308 rows that are non-pass AFTER** (`.tmp/6651/neigh-before-0{0,1}.log`,
  154-row chunks, base restored by file-copy A/B) — that is exactly the set in
  which a regression could hide. It scored **0 pass / 174 fail / 134 CE**:
  every row that does not pass now did not pass before either, so
  **pass → non-pass is 0 across the full 729**. (Stated precisely rather than as
  a headline delta: a full before lane over all 729 was not run, because a row
  that passes after cannot be a regression.)

- **Host (gc) lane — byte identity, not a run.** D1's finding stands: the
  non-isolated host run of `built-ins/Promise/**` poisons the runner's own realm
  and cannot be used as a control. Substituted an 8-program sha256 corpus
  (`.tmp/6651/bytes-{before,after}.txt`, `.tmp/6651/bytes.mts`): intrinsic
  `all` literal / `race` over a vec / `allSettled` / `any`, a `.then` chain, the
  D1 custom-constructor `.call` shape, and the two OBSERVABLE shapes
  (`Promise.resolve = fn` + `Promise.all([1,2])`; an own-`then` element +
  `Promise.race`). Result: **8/8 gc binaries byte-identical**; on standalone
  **exactly the 2 observable programs move** and the other 6 are byte-identical.
  That is the intended delta, stated as bytes: a module that cannot observe
  `resolve`/`then` compiles to the same wasm it did before.

- **Unit controls.** `tests/issue-5197-promise-observable-combinator-r3-2.test.ts`
  13/13 and `tests/issue-6651-promise-custom-combinator.test.ts` 8/8 and
  `tests/issue-4682.test.ts` 3/3 pass. The 3 failures in
  `tests/promise-combinators.test.ts` (2 × 35 s timeout) and
  `tests/issue-2671-promise-capability.test.ts` are **pre-existing**: the same
  three test names fail on the base tree with the source files reverted
  (`.tmp/6651/unit-{before,after}.log`).

- **Gates**: `check-loc-budget` (+913 promise-combinators, +99
  builtin-write-keeps, +39 call-namespace-static, +19 declarations — all
  granted by #5197's frontmatter, which this change-set modifies),
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`
  (getTypeAtLocation +0, ctx.checker +0), `check:dead-exports`,
  `check-compiler-boundaries --mode inventory --base origin/main` (no new
  module; `inventoryValid: true`), `npm run -s typecheck`,
  `biome lint src tests scripts --diagnostic-level=error`, and
  `scripts/equivalence-gate.mjs` (22 failing / 1,720 passing / 22 known — no new
  regressions) all pass.

**Residual buckets after D2 (54 non-pass of the 101 manifest rows):**

| rows | status | bucket | why it is still open |
| ---: | --- | --- | --- |
| 6 | fail | `{all,race}/invoke-{resolve,then}-{error,get-error}-close` | R3-4 interleaved iterator drive + IteratorClose — see the H1 finding below |
| 2 | fail | `{all,race}/invoke-resolve-get-error` | same drive: `Get(C,"resolve")` must throw BEFORE `GetIterator` is reached; today the argument is normalised first and the row rejects "argument is not iterable" |
| 4 | fail | `{all,race}/iter-step-err-reject`, `{all,race}/iter-next-val-err-reject` | same root cause (H1) — these do NOT trip the observable gate, so they stay on the legacy `__combinator_to_vec` drain |
| 2 | fail | `all/S25.4.4.1_A5.1_T1`, `race/S25.4.4.3_A4.1_T1` | same |
| 1 | fail | `all/capability-resolve-throws-no-close` | H1 on the custom-`C` `.call` path (D1's module) |
| 8 | CE | `{all,race,allSettled,any}/resolve-throws-iterator-return-*` | `class BadPromise {}` receiver — standalone has no `Construct(C, «executor»)` for a compiled class (#5197 G10) |
| 6 | CE | `{all,race,resolve,reject}/ctx-ctor`, `{all,race}/invoke-resolve-on-promises-every-iteration-of-custom` | `class X extends Promise` receiver (#5197 G9) |
| ~10 | fail | `prototype/then/{ctor-*,capability-executor-*,ctor-access-count,deferred-is-resolved-value}`, `prototype/catch/*` | #5197 R3-6 / R3-9 — SpeciesConstructor reads and GetCapabilitiesExecutor; untouched by this slice |
| rest | fail | `resolve-poisoned-then`, `resolve-thenable`, `race/resolve-self`, `resolve/arg-uniq-ctor`, `Object.prototype.toString` tag, `proto-from-ctor-realm` | #5197 R3-5 / R3-7 and #4119 |

**H1 is confirmed, and its mechanism is NOT what the hypothesis assumed
(this is the finding the next slice needs).** The hypothesis was that
`__call_@@iterator` is *blind* to a symbol-keyed `@@iterator` expando on an
`$Object`. Measured with two probes (`.tmp/6651/probe-h1.mts`,
`.tmp/6651/probe-h1b.mts`, both standalone, zero imports):

1. `iter[Symbol.iterator] = fn; Promise.all(iter)` rejects with
   "argument is not iterable" and calls `next()` **zero** times.
2. In the *same* module, `const f = iter[Symbol.iterator]; f.call(iter)` returns
   a working iterator and `typeof f === "function"`. A `for…of` over the same
   object also drives it correctly.
3. The compiled module exports **no `__call_@@iterator` at all**.

So the dispatcher is not blind — it is **not emitted**: `emitMethodDispatch`
only mints `__call_@@iterator` when some registered *struct* carries an
`@@iterator` member, and a plain `$Object` expando carrier registers none. With
the dispatcher absent, `fillCombinatorToVec` bails and leaves the eager
vec-only body, which answers null ⇒ "not iterable". The fix is therefore NOT in
the dispatcher: `[Symbol.iterator]` lowers to the reserved key string
`"@@iterator"` (literals.ts ~L3107), so `__extern_get(x, "@@iterator")` +
`__apply_closure` already sees the expando — or, better, the whole
`__iterator_strict` / `__iterator_next_strict` runtime
(`iterator-native.ts` L1515-L1606) already implements strict GetIterator with
getter/step/value abrupt propagation and is the substrate the drive should use.

**Two hard constraints the R3-4 drive must plan around (both measured here,
both absent from the R3-4 plan):**

- **Fixing H1 inside the LEGACY `__combinator_to_vec` would hang the six
  `*-close` rows**, whose `next()` never reports `done` — today they fail fast
  precisely because the iterator is never acquired. H1 must be fixed *inside
  the observable/interleaved drive only*, leaving the legacy drain untouched;
  that also keeps every non-observable module byte-identical.
- **`p.then` read as a VALUE off a native `$Promise` is not a function**
  (`.tmp/6651/probe-then.mts`: `typeof p.then === "function"` is **false**, and
  `t.call(p, …)` traps). That is #5197 R3-7, and it is why #5883's
  `buildNativeInvoke` keeps a `__combinator_subscribe` fallback for a native
  `$Promise` without an own `then`. A drive-mode `all` therefore cannot route
  every element through the generic Invoke, and `__combinator_subscribe` casts
  its `state` argument to the *immutable-field* `$CombinatorState`
  (`resultsArr` and `length` are `mutable: false` —
  `delay-combinator-layouts.ts::createNativeCombinatorStateShape`). An
  interleaved drive has no element count up front, so `all` drive mode needs a
  **new, additively-registered** mutable state struct plus its own
  resolve-element and subscribe bodies — roughly 300–400 lines of hand-built
  wasm. `race` drive mode needs none of that (its handlers are the capability's
  own resolve/reject), so **`race` is the cheap half and should be sliced
  first**. That sizing is why D2 stops here rather than half-landing it.

### 2026-09-21 — Cluster B (RegExp `@@` protocol, standalone), slice B3: the DIRECT spelling + `@@match`'s global arm

- **Branch** `worktree-agent-a78cc91817f356a89`, based on
  `claude/es2015-test262-plan-54tooh` @ `0f5b3ed8bc` (origin/main + A2 + C3 + E2 + B2).
  **Worktree** `/home/user/js2/.claude/worktrees/agent-a78cc91817f356a89`.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt` **minus the 17
  rows B1+B2 landed** = 130 rows, sha256
  `a0acb88e1450bf4acaee35dccb5a56373f6ddaba217ea24692d57f830b3839ff`. The
  subtraction was re-measured, not taken on trust: the full 147-row file on this
  source-clean base came back **17 pass / 119 fail / 11 compile_error**, exactly
  B1's 7 + B2's 10, and the 130 non-pass rows ARE the manifest.
- **Engine** `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`, adapter key
  `d4799bda84cfed0d`), `--standalone --isolate`, 65-row chunks, one runner at a
  time.

#### Item 1 — the DIRECT spelling, routed through the reified method value

`tryCompileStandaloneRegExpSymbolCall` answered `re[Symbol.search](s)` /
`re[Symbol.match](s)` from the **static native core** — the same engine
`"abc".search(/b/)` uses, which never consults `exec`. B2's substrate could not
be reached from that spelling, so eight rows stayed red with the code that
answers them already in the module.

The new module `src/codegen/regexp-symbol-protocol-call.ts` (~170 LOC) emits
`__apply_closure(m, rx, «arg»)` where `m` is the identity-stable
`RegExp.prototype[@@<id>]` singleton every other reader already sees
(`resolveStandaloneProtoMemberValueClosure`, the #2984 three-tier resolver).
There is therefore exactly ONE §22.2.6.8/.12 body in the compiler and this
spelling now reaches it. That the bridge works on a native-proto closure was
measured BEFORE the module existed:
`Reflect.apply(RegExp.prototype[Symbol.search], /ring/, ["a string"]) === 4`
on `--standalone` (`Reflect.apply` lowers to the same `__apply_closure`).

**The gate is a whole-file predicate** — the file mentions `exec` (a `.exec`
member, an `"exec"` key, an `exec` declaration) or touches `RegExp.prototype`,
OR the call's own argument is not statically string-like (in which case the
static core declines anyway and the previous answer was a compile error). The
coarseness is deliberate and points the safe way: a file that merely CALLS
`re.exec(s)` takes the observable route and gets the same answer through it
(the `[[Get]]` finds no own `exec`, RegExpExec step 5 runs the builtin), while
an `exec`-free file keeps the static core **byte-for-byte** — asserted by
compiled-binary sha256, not by reading the gate.

Two facts this route depends on, each probed rather than assumed:

1. **An `exec` expando on a RegExp INSTANCE is visible to `__extern_get`**
   (`r = /./; r.exec = f` → the generic protocol calls `f`). Without that the
   route would have been dead on arrival for every `exec-*` row.
2. **`lastIndex` Get/Set on a real RegExp receiver round-trips** through the
   same ordinary-property path (probe: init to `0`, restore to `3`).

#### Item 2 — §22.2.6.8 step 6 in full (the global collect loop)

B2 shipped the global arm as an observable PREFIX (`Set(rx,"lastIndex",+0)` +
one `RegExpExec`, then `null`). It is now the whole step: a `$ObjVec` result
array (`__objvec_new`/`__objvec_push` — the same host-import-free,
`[i]`/`.length`-readable builder `Array.prototype.filter`/`map` use in this
target), `matchStr = ToString(Get(result,"0"))` per iteration,
**AdvanceStringIndex** on an empty match (unicode-aware — a lead/trail
surrogate pair advances by 2, read straight out of the flattened subject's
backing array), ToLength via the canonical `__unbox_number(__to_primitive(v,
"number"))` chain, and `null` when n = 0.

It is verified end to end over an object receiver — 2 matches collected in 3
`exec` calls, the empty-match arm advancing `lastIndex` to 2 and terminating,
and `null` for no match at all (the last control in
`tests/issue-6651-regexp-symbol-protocol-b3.test.ts`).

**It gains zero manifest rows, and the reason is a third mechanism, measured:**
on a real `$NativeRegExp` receiver `Get(rx, "flags")` answers the **raw flag
bitfield** — `re["flags"]` reads `1` (a number) for `/a/g`, and `re["global"]`
reads `false` — where the static `re.flags` correctly reads `"g"`. §22.2.6.8
step 4 is `ToString(Get(rx,"flags"))`, so `"1"` contains no `g` and the
**non-global arm** is taken for every real RegExp. The dynamic read is answering
from a struct-field ladder instead of the §22.2.6 accessor. This is B2's
recorded `prototype/flags` residual (#5198 Slice F) seen from the instance side,
and it gates the entire `@@match/g-*` family plus `get-global-err` /
`get-unicode-error` / `builtin-infer-unicode`. Closing it needs an
`unshiftExternGet…Arm`-shaped arm for the `$NativeRegExp` carrier that consults
own properties before the struct (an own `Object.defineProperty(r,'global',…)`
must still shadow), which is a separate slice — not a line in this one.

#### Receipt — manifest

| 130 rows, `--standalone --isolate`, QuickJS | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/B3-full-base-{00,01}.log`) | **0** | 119 | 11 |
| after (`.tmp/6651/B3-after-{00,01}.log`) | **10** | 111 | 9 |

**+10 rows pass, zero regressions.** The two logs were joined row-by-row, not
compared by count: 11 rows changed status, 10 of them non-pass → pass and one
`compile_error → fail` (`coerce-global`, which now compiles and runs — see the
`flags` residual above for why it still fails). Every other row keeps its exact
status.

| row | what it pins |
| --- | --- |
| `@@match/exec-invocation` | the custom `exec` is called with the regexp as `this` and exactly ONE already-`ToString`ed argument |
| `@@match/exec-err` | its abrupt completion propagates out of the direct spelling |
| `@@match/exec-return-type-invalid` | a primitive result is a TypeError |
| `@@match/exec-return-type-valid` | an Object / Null result comes back by IDENTITY |
| `@@match/get-exec-err` | step 3 is a real `[[Get]]` — a poisoned `exec` accessor throws |
| `@@match/coerce-arg-err` | the argument's `toString` runs, inside the method |
| `@@match/g-match-no-set-lastindex` | the global arm's lastIndex discipline (was a compile error) |
| `@@search/coerce-string` | `ToString(string)` on a non-string argument — the static core refused this shape outright |
| `@@search/set-lastindex-init-samevalue` | §22.2.6.12 step 5's SameValue-vs-SameValueZero on `-0`, on the direct spelling |
| `@@search/set-lastindex-restore-samevalue` | the same for step 8's restore |

#### Controls — zero pass → non-pass

The control universe is B2's 2,280 rows (`built-ins/RegExp/**` +
`annexB/built-ins/RegExp/**` +
`built-ins/String/prototype/{match,matchAll,replace,replaceAll,search,split}/**`)
filtered the same way — rows whose source mentions `Symbol.match` /
`Symbol.search` / `@@match` / `@@search` (157, the identical count B2 measured),
plus every third `prototype/{exec,test,flags,source,lastIndex,toString,global,
sticky,unicode}` validity canary (63) — WIDENED for this slice with all of
`built-ins/String/prototype/{match,search}/**` (252 rows, as the brief
requires). Minus the manifest: **252 control rows**, sha256
`a7b5a7c782f116632106d9a0cfd1ae4bdb7846172f5392f725a295a1a3ebe1fd`.

| lane | rows | result |
| --- | ---: | --- |
| standalone, after (`.tmp/6651/ctrl-after-{00,01,02}.log`) | 252 | 196 pass / 35 fail / 21 compile_error |
| standalone, before — the **56 non-pass-after rows**, re-run on `cp`-reverted sources (`.tmp/6651/ctrl-before.log`) | 56 | 35 fail / 21 compile_error, **0 pass**, every row's status IDENTICAL to its after status |
| host — compiled-binary sha256 of 12 representative programs | 12 | **all 12 byte-identical** (`.tmp/6651/hostsha-{before,after}.txt`) |
| standalone — the same 12 programs | 12 | **10 byte-identical**; only `reflective-match` (item 2) and `exec-observing-direct-search` (item 1's gated route) differ (`.tmp/6651/sasha-{before,after}.txt`) |

The 56-row before-side is a COMPLETE check, not a sample: a pass→non-pass
regression is by definition non-pass AFTER. The standalone sha table is the
load-bearing half of the gate claim — `string-search-static`,
`direct-search-exec-free`, `direct-match-exec-free` and `direct-search-global`
are all byte-identical, i.e. the ungated direct spelling really does keep the
static native core.

Also green: `npm run -s typecheck`; `npx biome lint src tests scripts
--diagnostic-level=error`; the five ratchet gates (`check-loc-budget`,
`check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
`check:dead-exports`); the boundaries inventory
(`check-compiler-boundaries --mode inventory --base origin/main`, with
`regexp-symbol-protocol-call.ts` classified); `scripts/equivalence-gate.mjs`
(22 failing / 1720 passing, all 22 in the committed baseline); B1's
`issue-6651-string-symbol-protocol.test.ts` (9/9) and B2's
`issue-6651-regexp-exec-protocol.test.ts` (13/13); and the new
`tests/issue-6651-regexp-symbol-protocol-b3.test.ts` (13/13 — the 10 rows plus
3 controls). The vitest runs exit non-zero on a `[vitest-worker]: Timeout
calling "onTaskUpdate"` RPC flake under a loaded 4-core box; every test in them
reports PASS.

#### One defect found and fixed during the work, worth keeping

The step-6 loop's ToLength chain registers `__to_primitive` as a LATE IMPORT,
and a late import shifts every defined-function index at or above it. Registered
where the loop READ it, the already-resolved `deps` were one import stale and
the emitted loop called the wrong functions — the result array came back empty
and the loop ran once, with a module that still validated and still ran. The
registration is therefore hoisted to the decline block (before the first
`fctx.body.push`) and `deps` is re-resolved immediately after it, exactly like
B2's `post`. This is the #2043 late-shift class in its quietest form: no crash,
no validation error, just wrong answers.

#### Residual buckets (120 rows)

| rows | signature | what it needs |
| ---: | --- | --- |
| 31 | `@@split` | unchanged from B2: SpeciesConstructor, the sticky splitter walk, generic result reads. 21 of the 31 sit directly on this slice's substrate. |
| 30 | `@@replace` | unchanged from B2: §22.2.6.11's result loop + GetSubstitution. |
| 13 | `@@match` global family (`g-*`, `builtin-*`, `coerce-global`, `get-global-err`, `get-unicode-error`, `builtin-infer-unicode`) | the `Get(rx,"flags")` defect above (the loop behind them is implemented and tested), plus — for the four `*-set-lastindex-err` rows — a strict `[[Set]]` on a non-writable property that THROWS. `__extern_set` silently no-ops there; that is the same object-runtime gap B2 recorded for `@@search/set-lastindex-*-err`. |
| 13 | RegExp constructor / statics | observable `IsRegExp`, the called-as-function short-circuit, ordered `source`/`flags` Gets. |
| 7 | `prototype/compile` | Annex B ordering + SyntaxError/TypeError shapes. |
| 5 | `prototype/flags` | the generic `flags` getter (fails on host too) — the PROTOTYPE-side twin of the instance-side defect above. |
| 1 | `@@search/coerce-string-err` | half of it passes (the poisoned `toString` propagates); the other half needs `__extern_toString(symbol)` to throw a TypeError per §7.1.17. A one-line object-runtime fact, not a RegExp one. |
| 20 | assorted `String.prototype.*`, the individual flag getters, `prototype/exec` | unchanged from B1/B2. |

### 2026-09-21 — Cluster C, slice C3b (C3's residuals: the nested default, and the async-method exclusion)

- **Branch** `worktree-agent-a186f0693b98e763a`, base
  `claude/es2015-test262-plan-54tooh` @ `685351f7bd` (= `origin/main` + A2 + C3
  + E2 + B2 + D2). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a186f0693b98e763a`.
- **Manifest** `.tmp/6651/C3b-manifest.txt`, 38 rows, sha256
  `e6a82fb74ab0ccd4d5484a9d46c33f91e79560d3f01f1e135fdcadd9c0e7d90c` — C3's 28
  residual rows plus the 10 `dflt-params-arg-val-not-undefined` rows its
  `isAsyncMethodParam` exclusion was paying for (class
  `async-{method,gen-method}[-static]`, object-literal `async-{meth,gen-meth}`).
- **Eval engine `quickjs`** on every run below (adapter rebuilt after every
  `src/` edit and before every control pass).

#### Results

| standalone, `--isolate`, engine quickjs | pass | fail |
| --- | ---: | ---: |
| before (`.tmp/6651/C3b-before.log`) | **0** | 38 |
| after (`.tmp/6651/C3b-after-final.log`) | **14** | 24 |

Per-row set diff: **14 non-pass → pass, 0 pass → non-pass.** Two mechanisms,
seven rows each.

#### C3's hypothesis for the nested default was WRONG, and the measurement says why

C3 attributed its 17 `dstr/*dflt-*` residuals to `resolveBindingElementType`
widening only elements WITHOUT a default, and asked for the same
absence-of-information argument one level inside the pattern. Probed on this
base (`.tmp/w6651C3/q*.src.js`, original-harness assembly, module scope), that
is not what either family is:

- The 7 `dflt-ary-ptrn-elem-ary-empty-init` rows are **not a slot-typing defect
  at all** — they are all GENERATORS, and the shape reduces to
  `function* g(a = function () { return 5; }())`, where `a` arrived `NaN`. The
  binding pattern is incidental.
- The 10 `dstr/*dflt-obj-ptrn-prop-ary` rows are **two independent defects**,
  neither of them the binding element's slot, and **both are still open** (see
  residuals below).

So only the first was landed here, and its fix is in a different subsystem.

#### Mechanism 1 (7 rows) — an inlined IIFE inherits the GENERATOR's `return`

`compileReturnStatement` dispatches on `fctx.isGenerator` (stash the value on
`__gen_buffer`, `br` to the generator's exit) and `fctx.asyncDriveReturn`
(settle the frame's `$Promise`, then `return`) BEFORE the ordinary path. An
IIFE inlined into such a frame has no Wasm function of its own, so both hooks
fired for a `return` that belongs to the IIFE. Emitted body, from the factory of
`function* g(a = function () { return 5; }())`:

```wat
(block
  f64.const 5
  drop            ;; the generator arm's value-drop
  br 1            ;; ...and its exit branch
)
local.get 1       ;; $__iife_ret_0 — never written
```

`patchInlinedIifeReturns` cannot repair this: the generator arm emits a `br`, so
no `return` op survives for the walker to rewrite. The fix parks both hooks
across the inlined body — `parkOuterReturnProtocol` /
`restoreOuterReturnProtocol`, in the 139-line leaf
`expressions/iife-return-patch.ts` that already owns "an inlined IIFE's `return`
is not the enclosing function's", beside `fctx.returnType`'s existing
save/restore. The generator BODY lane is unaffected by construction (the native
lowering compiles it into a resume function whose `isGenerator` is already
false) — measured: `function* g() { var v = function () { return 7; }(); }` is
correct on base and after.

#### Mechanism 2 (7 standalone / 10 host rows) — the async-method exclusion is REMOVED, and its cause was not the trampoline

C3 recorded the async-method regression as "a defect in the trampoline's
signature rebuild" in `finalizeMethodTrampolines`. Instrumented on the
reproducer, that is not it: at finalize the wrapper params, the method params
and the trampoline's own func type all agree (`externref`), so the rebuild is a
no-op for this shape.

The real site is the CALL. `call-identifier.ts` rebuilds the callee's wrapper
signature from the **declared (checker)** parameter types to choose the dispatch
arms, and the checker still says `number`. Base vs widened WAT for
`class C { async m1(a = 23) {} } … var r1 = C.prototype.m1; r1(undefined)`:

| | trampoline's func type | `ref.test` arms emitted at the call |
| --- | --- | --- |
| base | `273` | `{128, 136, 204, 271, 273, 276, 277, 68}` — contains `273` |
| C3-widened | `132` | `{128, 136, 204, 271, 274, 275, 276, 68}` — **no `132`** |

The call reached no arm, so the body never ran (the observation register stayed
`'none'`; the direct `new C().m1(undefined)` was correct throughout). That site
already carries the SAME mirror-widening twice — for binding-pattern parameters
and for `parameterMayBeOmitted` — each with a comment saying that building the
signature from declared types without the callee's widening "asks for a scalar
the compiled callee never declared". C3's widening is the third case and was
simply missing. Added as `jsUntypedDefaultParamSlotMoves` (deliberately
**non-memoising**: `jsUntypedDefaultWidenedParams` means "this parameter's slot
was widened in the function being compiled", and a caller's view of someone
else's parameter is not that fact), and `isAsyncMethodParam` is deleted.

#### Control — C3's same 2,370 rows, BOTH targets, before/after on this base

`.tmp/6651/C3-control.txt`, sha256
`3e8d80a0ae76e6a98b1f0c5885499c06a058ac46cc582c6e50077500d20ce808`, 12 chunks of
≤200, one runner at a time, **all 12 chunk exits `0` and `counted=2370` on all
four passes** (a crashed chunk cannot masquerade as "everything passed").

| target | before non-pass | after non-pass | pass→non-pass | non-pass→pass |
| --- | ---: | ---: | ---: | ---: |
| standalone (`ctl-{before,after}-standalone.log`) | 189 | 182 | **0** | **7** |
| host (`ctl-{before,after}-host.log`) | 180 | 170 | **0** | **10** |

Every gain is a `*-arg-val-not-undefined` async-method row. **The 16 rows C3's
first cut regressed (`dflt-params-arg-val-undefined` +
`dflt-params-trailing-comma`, `.tmp/6651/C3-regress16.txt`) are all in this
control and none of them moved** — which is what licenses removing the exclusion
rather than keeping it. The 7 mechanism-1 rows are NOT in this control (its
builder required a parameter-list default in the stripped body and did not match
those generated `dstr/` files); they are measured on the manifest.

Other gates, all on the final tree: 32/32 playground+benchmark corpus files
compile to **byte-identical** binaries (`.tmp/6651/corpus-{base,new}.txt`,
zero-line diff, no `THREW`/`NO_BINARY` rows); `node scripts/equivalence-gate.mjs`
— 22 failing / 1,720 passing / 22 known-failures, **no new regressions**;
`pnpm run check:ir-fallbacks` OK; loc/func (local **and**
`LOC_GATE_BASE=origin/main`), coercion-sites, oracle-ratchet, dead-exports,
biome, typecheck all green.

#### Residuals in the manifest (24)

| rows | signature | owner |
| ---: | --- | --- |
| 10 | `SameValue(«NaN», «undefined»)` — `dstr/*dflt-obj-ptrn-prop-ary` | **TWO defects, both re-diagnosed here, neither the binding element's slot.** (a) `[7, undefined, ]` in a `.js` file is lowered as a NUMERIC array, so the `undefined` is stored as `NaN` **before any destructuring** — `var o = { w: [7, undefined, ] }; o.w[1]` reads `NaN` at top level (`.tmp/w6651C3/q2.src.js`), while `o.w[2]` (past the end) is correctly `undefined`. (b) A nested pattern WITH its own default reads a missing element as `null` instead of `undefined`, but **only when the parameter's own default fired**: for one `function g({ w: [a,b,c] = [4,5,6] } = { w: [7,8] })`, `g({w:[7,8]})` gives `7 \| 8 \| undefined` and `g()` gives `7 \| 8 \| null` (`.tmp/w6651C3/q12.src.js`). Both fixes are needed for these rows; (a) is an array-literal lowering question, (b) lives in the parameter-default path. |
| 9 | `Cannot access property on null or undefined` — `params-dflt-ref-arguments`, `dstr/ary-ptrn-elem-ary-rest-init` | unchanged from C3: `arguments` bound in the PARAMETER scope (cluster I's B11 finding), and a rest-with-init element reading null. Unrelated to the slot. |
| 3 | `*-arg-val-not-undefined` — object-literal `gen-meth` / `async-gen-meth`, plus the class `async-gen-method` pair that gains on HOST but not standalone | the object-literal generator-method lane keeps its own pre-existing defect (the 2 rows below); the class `async-gen-method` pair is now blocked by something else in the standalone lane only. |
| 2 | `Cannot read properties of undefined (reading 'next')` — object-literal GENERATOR methods | pre-existing and independent (C3's `.tmp/w6651C3/p6.src.js` fails on base too). |

#### Process note

The A/B swap script is regenerated from `git status --porcelain src/` every time
the file set changes — it moved from three files to four mid-slice when the IIFE
mechanism was relocated out of the god-file, and a stale list is exactly what
produced C3's 45-minute all-`SyntaxError` "base" pass. Both trees were
typechecked before the control started.

### 2026-09-21 — Cluster E (TypedArray / ArrayBuffer / DataView), slice E3

- **Branch** `worktree-agent-a24bf92f8c93b26cc`, base
  `claude/es2015-test262-plan-54tooh` @ `685351f7bd` (origin/main + A2 + C3 +
  E2 + B2 + D2). **Worktree**
  `/home/user/js2/.claude/worktrees/agent-a24bf92f8c93b26cc`.
- **Engine for every run below: QuickJS** (`JS2WASM_EVAL_ENGINE=quickjs`,
  artifact `073742801ba7`, adapter key `d4799bda84cfed0d`), `--standalone`,
  24-row chunks, one runner at a time.
- **Manifest** `plan/agent-context/6651/E-typedarray-buffers.txt` (144 rows).
  The subtraction of E2's 19 landed rows was not taken on trust: the full file
  was re-measured on this source-clean base and came back **19 pass / 124 fail
  / 1 compile_error** — exactly E2's published after-state — so the 125
  non-pass rows ARE this slice's manifest
  (`.tmp/6651/E3-before/`, `.tmp/6651/E3-manifest.txt`).

| 144-row manifest, 24-row chunks | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/E3-before/`) | 19 | 124 | 1 |
| after (`.tmp/6651/E3-after/`) | **24** | 119 | 1 |

Per-row set diff (`.tmp/6651/E3-manifest-diff.txt`): **5 non-pass → pass, 0
pass → non-pass** — the whole `ctors/object-arg/throws-setting-obj-*` family.

#### What landed — ONE mechanism: OrdinaryToPrimitive over a vec carrier's OWN surface

`__to_primitive`'s `$__vec_base` arm was a single step:
`__array_to_primitive_string(v)`, i.e. `Array.prototype.toString` = `join(",")`.
§7.1.1 step 2 (`GetMethod(input, @@toPrimitive)`) and §7.1.1.1's hint-ordered
`valueOf`/`toString` cascade **never ran for any vec receiver**, so a method
installed on the carrier itself was invisible. Measured on this slice's base
(`.tmp/6651/p1.js`, `.tmp/6651/p3.js`):

```
a = [1];              a.valueOf   = () => 7;   a + 0     →  "10"   spec 7
b = [2];              b.toString  = () => "Z"; b + ""    →  "2"    spec "Z"
s = new Int8Array(1); s.valueOf   = () => 42;  s + 0     →  "00"   spec 42
a[Symbol.toPrimitive] = () => 77;              a + 0     →  "10"   spec 77
```

So E1's and E2's readings of this bucket are both superseded. E1 blamed the
static carrier's missing expando side-table; E2 measured that the table works
and named `__to_primitive` — correctly, but as "a dyn-view arm". It is not a
view arm: the gap is the whole vec family, **plain arrays included**, and a
view is a `$__vec_base` subtype (#3057) that inherits it.

New module `src/codegen/vec-own-to-primitive.ts` (~370 LOC), reserved beside
`reserveArrayToPrimitiveString` and filled at finalize after
`fillArrayToPrimitive`:

1. **Own `@@toPrimitive`** (§7.1.1 step 2) — called with the hint string, with
   §7.1.1 step 1's `"default"` substituted for the internal null hint, and
   §7.1.1 step 2.c's TypeError on an object result.
2. **The hint-ordered own `valueOf`/`toString` cascade** (§7.1.1.1).
3. **Tail into `__array_to_primitive_string`** — which IS the §7.1.1.1
   intrinsic step, since `%TypedArray%.prototype.toString` and
   `Array.prototype.toString` are the same function (§23.1.3.30). So a carrier
   with no own method keeps today's answer verbatim, and that is pinned as a
   unit test rather than assumed.
4. **…except when the intrinsic is SHADOWED.** A present, callable own
   `toString` replaces the join, so a cascade that then exhausts is §7.1.1.1
   step 6 — a TypeError, not a join. That single flag is the whole of
   `throws-setting-obj-valueof-typeerror.js`.

**The lookup is OWN-ONLY, and that boundary is the load-bearing part.** The
cascade must NOT be spelled with `__extern_get(v, name)`: #4655 measured that
on a vec receiver it resolves the BUILTIN `Array.prototype.toString`, and
calling that routes straight back into the vec arm — unbounded recursion on
`Number([1])`, `1 + [2]`, every array-in-string-concat. `__vec_prop_get` is out
for the same reason one level down: its bag-miss tail is
`protoIndexRecvGetMissInstrs`, which #4663 measured returning the builtin
whenever `protoMemberDirty` armed the native-proto seeder. So the module reads
only two surfaces a user write can reach — `__hasOwnProperty` → `__extern_get`
(the DYNAMIC-view door, E2's expando side-table), and the #3537 vec expando bag
addressed directly via `__is_vec_prop_carrier` → `__vec_bag_lookup` (LOOKUP,
never ensure) → own-guarded `__extern_get` (the STATIC-carrier door). Neither
can reach a builtin. Inherited overrides stay out: a user
`Array.prototype.toString` is already honoured by #4663's companion probe
inside `__array_to_primitive_string`, and widening the lookup to the chain is
how #4017 cost 684 host-free passes.

Plus one seam in the element-assignment dispatcher that the same five rows
exposed:

5. **A Symbol key on a TypedArray view is an ORDINARY named set**
   (`expressions/assignment.ts`, +15). §10.4.5.5 step 1 only diverts a String
   key whose CanonicalNumericIndexString is not undefined; a Symbol is neither.
   The `vecElementTypedArrayName(...) === undefined` gate had been excluding
   every view from the named-key route, and the write was **DROPPED** — not
   misdirected: measured (`.tmp/6651/p4.js`, `.tmp/6651/t1.mts`), `f64[S]`,
   `i8[S]` and `u8[S]` all read back `undefined` while the string-keyed
   `i8.str = 6` landed, and element 0 of a pre-filled view was left untouched.
   That silent drop, not ToPrimitive, is why the two `@@toPrimitive` rows
   survived the first three fixes.

#### Receipts

- **Corpus control — 1,830 rows, before vs after, identical 24-row chunking on
  both sides** (`.tmp/6651/E3-control.txt`, sha256
  `7d7fb189681886c59a4eefc58a9a0a56b0616fba6e92ca33cdc6740ffa07c1cb`;
  `.tmp/6651/ctl-{before,after}/`). Selection, stated as reachability rather
  than as a directory: every row under
  `built-ins/{TypedArray,TypedArrayConstructors,ArrayBuffer,DataView}/**` whose
  SOURCE mentions `valueOf`/`toString`/`toPrimitive`/`Symbol` (848), plus every
  row under `built-ins/Array/**` (193) and under
  `built-ins/{Object,String,Number,JSON,Symbol,Boolean,Date}/**` +
  `language/expressions/**` (718) that WRITES one of those names
  (`(valueOf|toString)\s*[:=][^=]` or `Symbol.toPrimitive`), plus the whole E
  manifest. pass **1301 → 1311**. Per-row set diff (`.tmp/6651/ctl-diff.txt`):
  **0 pass → non-pass**, 10 non-pass → pass — the 5 manifest rows and their 5
  `ctors-bigint/` twins, which are outside the ES2015 manifest.
  - The brief asked for the whole `built-ins/**` `valueOf|toString|toPrimitive`
    grep. That is 2,862 rows; at the measured 1.8 s/row on this box (two other
    lanes active) it is ~3 h per side, so it was narrowed as above and the
    narrowing is stated rather than implied. What the narrowing drops is rows
    that mention one of the names without writing it — they can reach the new
    prefix but can never take its branch.
  - **Chunk composition moves verdicts in this family, again.** The same 144
    manifest rows scored **19** pass when chunked alone and **23** inside the
    control's chunking, on the SAME base tree. E2 found this at 60 vs 24 rows;
    it is not only a chunk-SIZE effect, it is a chunk-COMPANY effect. Both
    numbers above are like-for-like (same chunking on both sides), and the
    manifest table quotes the manifest-only lane because that is the one whose
    before-state reproduces E2's published after-state exactly.
- **Byte-level blast radius** (`.tmp/6651/sha-{before,after}.txt`, 11 programs ×
  2 targets). **All 11 host-lane binaries are byte-identical** — the change is
  standalone-only by construction. On standalone, 9 of 11 differ and 2
  (`scalar-arith`, `string-concat`) are identical. **This is NOT byte-neutral
  for standalone modules that never use an array**, and that is stated plainly
  rather than glossed: the reserve mints one functype and one function wherever
  `__to_primitive`'s array-like arm is reserved at all, so `plain-object-keys`
  and `plain-object-plus` shift too. The behaviour is unchanged there (the
  filled body tails into the unchanged join); the emitted indices are not. The
  1,830-row control is broad for exactly this reason.
- **Unit tests**: new `tests/issue-6651-e3-vec-to-primitive.test.ts`, 11 cases,
  each comparing INSIDE the module and returning a number. Verified on the base
  tree: **8 of 8 positive cases fail there**, and all 3 controls pass on BOTH
  trees (`.tmp/6651/unit-base3.log`). One of those controls is labelled as a
  control precisely because it passes on both — the base did not clobber
  element 0, it dropped the write, and a test that cannot distinguish the two
  must not be presented as evidence for either.
- **Gates**: loc-budget, func-budget, coercion-sites (no net growth — the new
  module introduces no coercion vocabulary), oracle-ratchet (+0/+0),
  dead-exports, `check-compiler-boundaries --mode inventory --base origin/main`
  (the new module classified), `typecheck`, `biome lint … --diagnostic-level=error`,
  and `scripts/equivalence-gate.mjs` (22 failing / 1,720 passing, no new) all
  pass. E1's and E2's pin suites stay green (28 cases across the three files).
  Grants added to this file's frontmatter, dated: `object-runtime.ts` LOC
  (restated from #5197 so it is not stranded), `compileElementAssignment` and
  `ensureObjectRuntime` func keys.

#### `%TypedArray%.from` / `.of` — NOT attempted, and the measurements that say why

This slice's brief put the 20 `from`/`of` rows first. They were triaged, not
started; the mechanism is larger than the one above and half-landing it would
have been worse than landing nothing. What was measured (`.tmp/6651/p5.js`, on
this branch's tip) rather than assumed:

| probe | answer | reading |
| --- | --- | --- |
| `typeof TypedArray.from` / `.of` | `function` | the intrinsic's static value read already mints a closure — a `genericThrowBody` refusal one (`builtin-value-read.ts` ~L1747) |
| `TypedArray.from({length: 0})` | `TypeError: %TypedArray%.prototype.from is not yet implemented in --target standalone` | so the refusal body IS reached through `.call`/direct call — the closure plumbing works, the BODY is the hole |
| `typeof Float64Array.of` | `function` | same refusal closure on the concrete ctor |
| `Float64Array.of === TypedArray.of` | `false` | each read mints a FRESH `struct.new`; `inherited.js` needs one shared singleton value |
| `Float64Array.hasOwnProperty("of")` | `false` | already correct — `inherited.js`'s second assertion passes today |
| `Float64Array.from([1,2])` / `.of(1,2)` | work | the compile-time lowering in `call-builtin-static.ts` (~L1179) handles the static spelling only |
| `TA.of` / `TA.from` where `TA` is the harness loop variable | **`undefined`** | the DYNAMIC read — `__extern_get($__ta_ctor, "of")` — has no arm at all |

So the work decomposes into three parts, in dependency order, none of which is
an arm: (a) a `$__ta_ctor` / `%TypedArray%`-intrinsic `__extern_get` arm for
`of`/`from`; (b) ONE shared closure singleton per member so `===` holds
(today's per-read `struct.new` cannot); (c) real §23.2.2.1/§23.2.2.2 bodies —
`IsConstructor(C)`, `TypedArrayCreate(C, «len»)` via the existing
`__native_construct_<N>` / `__class_construct_dispatch` substrate, the
`@@iterator` / array-like split, `mapfn`/`thisArg`, and the variadic calling
convention for `of` (which today is wired for exactly three builtins sharing
one lifted func type). The 9 `built-ins/TypedArray/from/*` error-propagation
rows need only (c)'s front half — steps 1-5 observable, before any Construct —
which is the cheapest coherent sub-slice and the one to take first.

#### Residual buckets in the 144-row manifest (120 non-pass), re-measured

Unchanged from E2's table except for the five rows this slice took, plus two
corrections and one new residual:

| rows | sub-bucket | why it is still open |
| ---: | --- | --- |
| 20 | `TypedArray/from/*` + `TypedArrayConstructors/{from,of}/*` | the three-part mechanism above. E2's "an intrinsic-static-method mechanism, not an arm" is confirmed and now has the seven probe answers behind it |
| 7 | `internals/Set/*` — receiver-aware `[[Set]]` | unchanged: `__reflect_set` is a three-argument native; §10.4.5.5 needs the Receiver and the §10.1.9.2 cascade over it |
| 5 | `ctors/object-arg/iterator-*` | unchanged: the ctor argument is a CALLABLE, so dispatch falls to the count form and never consults `@@iterator` |
| 22 | detached-buffer cohort | unchanged, measured under QuickJS |
| 9 | `prototype/toLocaleString/*` | unchanged |
| 3 | `internals/OwnPropertyKeys/integer-indexes*` | unchanged: the own-key answer is correct, then `new TA(makeCtorArg(4)).subarray(2)` — a method call on a `new` EXPRESSION — answers null |
| rest | `Object.prototype.toString` (#4119), species-ctor `this`, `{filter,map}` callback receiver identity, DataView proto identity, `%ArrayIteratorPrototype%` results | unchanged |

**Two things this slice found and deliberately did not fix**, both one-line
locatable:

- **The symbol-key READ on a view is still on the numeric lane.** The write now
  lands; `typeof view[S]` still answers `undefined` (`.tmp/6651/p4.js` after).
  The symmetric gate is `property-access.ts` ~L6490
  (`elementAccessTypedArrayName(...) === undefined`). It was left alone on the
  #4017 rule — the write arm has two measured test262 rows behind it and the
  read arm has zero, and a read arm would change `view[Symbol.iterator]`, which
  has a real §23.2.3.36 meaning.
- **A STATICALLY-typed `Int8Array` receiver folds `+` without consulting
  `__to_primitive` at all** — `(s as any) + 0` on an `Int8Array`-typed `s`
  answers `NaN` on both trees while the `any`-typed spelling answers 99. That
  is a static `+`-lowering gap, not a ToPrimitive one; it costs no manifest row
  today because the test262 harness binds its samples through `any`-shaped
  paths.

### 2026-09-21 — Cluster A round 2 (slice A2-gates): the 37-row gate family, not the 90-row one

- **Branch** `worktree-agent-a62d9064b19aa6650`, based on `main` @ `3769840f`.
  **Worktree** `/home/claude/js2/.claude/worktrees/agent-a62d9064b19aa6650`.
  A second, source-clean worktree `/home/claude/js2/.claude/worktrees/measure-6651-A2`
  (detached at the same commit) held every before-run, so no base measurement
  was taken with an edited tree underneath the runner.
- **Manifest** `plan/agent-context/6651/A-generators-standalone.txt`, 197 rows,
  sha256 `5fc1a7c0c1d5672aba427f347ea225633e0c95cfa6e9547240fcc2cda2d62d77`.

| standalone, `--isolate`, 197 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/A2-before.log`, clean worktree) | 62 | 2 | 133 |
| after (`.tmp/6651/A2-after.log`) | **90** | 2 | 105 |

**+28 gained, 0 lost, 0 other verdict changes** (per-row set diff, not a count
comparison).

#### Which family, and the measurement that chose it

The round-2 dispatch table ranked A2-proper (the 90-row `yield`-inside-a-pattern
family) first. **The cheap host-lane probe says the other family is worth
strictly more, and the ordering predated that measurement.** All 127 residual
rows were run on the HOST target from the clean base
(`.tmp/6651/host-residual-before.log`, `--isolate`): **39 pass / 88 fail**. A row
that fails on host cannot be made to pass by fixing standalone-only lowering, so
per bail-site bucket:

| bail site (per-gate histogram) | rows | host-pass | read |
| --- | ---: | ---: | --- |
| `buildNativeGeneratorPlan:2324` (`lowerStatements` failed — A2 proper) | 78 | **5** | new engineering in BOTH lanes |
| `buildNativeGeneratorPlan:2303` (binding-element default) | 24 | **24** | pure standalone-only gap — **taken, all 24 now pass** |
| `isNativeGeneratorExpressionShape:2525` (named fn-expr own name) | 9 | 4 | needs the immutable self-name binding |
| `isNativeGeneratorCandidate:3162` (computed method name) | 6 | 4 | needs the EMIT site, not the gate (measured below) |
| `isNativeGeneratorCandidate:3188` / `…Shape:2503` (rest params) | 6 | 1 | direct `eval` in parameter scope |
| `isNativeGeneratorCandidate:3288` (`super` / outer capture) | 2 | 0 | no [[HomeObject]] slot in the frame |
| `isNativeGeneratorCandidate:3151` (anonymous `export default function*`) | 2 | 1 | module-namespace + `g.name === "default"` |
| parse: `'yield' is a reserved word …` | 6 | 0 | CE on **both** targets — a TS strict-parse issue, not a generator gap |

The histogram is the predecessor's method re-run: every `return false`/`null` in
the three gates was temporarily tagged with its line, `fail()` with its caller,
and the unmodeled statement with its `SyntaxKind` + source text, then the
manifest went through a **compile-only** probe (197 rows in ~3 min, versus ~50 min
for a runner pass). Not committed.

#### What landed

**1. A binding-element default is admitted by SUSPENSION, not by lane
(`generators-native.ts`, +14 lines, ~80 % comment).** #4769's argument for
admitting a class-valued default is "the factory's eager call-time destructure
(§10.2.11) hands the value to a resume function that runs immediately, so it
never crosses a yield". That is a property of the BODY. It was spelled as
`ts.isMethodDeclaration(decl)` plus a class/object-literal parent — lane
identity, which the #3952 note two paragraphs above explicitly warns against
relying on. `zeroSuspendDefaultLane` now states the property itself and admits
the generator function DECLARATION and EXPRESSION lanes, which reach the same
factory/resume split (#5255, #3164/#3302) and spill into the same state struct.

  **The blanket `ts.isFunctionExpression(decl)` arm is gone because its recorded
  control does not reproduce.** That arm was justified in place by: "that lane
  already traps on an element default with a plain NUMERIC value (`{ n = 41 }`),
  with no closure anywhere". Re-run through the runner at module scope, all four
  `fnexpr-num-{obj,ary}-{susp,nosusp}` cells **pass**, host-free. The claim was
  stale and was keeping 16 manifest rows bailed on a defect that no longer
  exists; the correction is recorded at the bail site, not in a commit message.

  Driven by an 80-cell matrix — lane {fndecl, fnexpr, objmeth, clsmeth} ×
  default {arrow, fn, generator fn, class, numeric} × pattern {obj, ary} ×
  {suspends, does not} — written as synthetic test262 rows and judged by the
  runner's own `runTest262File`, so every cell is a module-scope
  original-harness verdict (`.tmp/6651/matrix-{base,w1}-sa.txt`). **16 cells flip
  compile_error → pass, 0 regress.** Every cell the predicate still refuses is
  one that FAILS when admitted: `{gen,cls}-*-susp` in all four lanes.

**2. An accessor / constructor / class static block is a function SCOPE
(`generators-native-ast-scan.ts`).** `isFunctionLikeScope` named only
declaration / expression / arrow / method, so a `return` inside a getter was
attributed to the enclosing generator. `statementContainsReturn` therefore
answered `true` for

```js
function* g() { ({ get yield() { return 1 } }); }
```

— a statement with no yield and no generator-level return — which routed it into
the structural state-graph lowering, where an `ExpressionStatement` of that shape
is unmodeled, and bailed the whole generator to the host path. Four manifest rows,
all named `yield-as-literal-property-name`, whose entire point is that `yield` is
a legal PROPERTY name.

  **The carve-out beside it is the load-bearing half.** A COMPUTED property name
  is evaluated in the ENCLOSING scope (§8.6.1 / ClassElementEvaluation), so in
  `function* g() { class C { get [yield]() {…} } }` the `yield` really does
  suspend `g`. The first cut stopped at the whole node and lost that suspension:
  five `accessor-name-*-computed-yield-expr` rows flipped **compile_error →
  `SameValue(«undefined», «"get yield"»)`** — a loud refusal traded for a silent
  wrong answer, measured, not hypothesised. `nodeContainsYield` now visits the
  computed name before stopping, and those five are back to a clean refusal.

  The same carve-out also **corrects a row that was already shipping a wrong
  answer**: `language/expressions/object/method-definition/name-prop-name-yield-expr.js`
  compiled `{ [yield]() {} }` as a generator that never suspends, so the object
  was built on the first `next()` and the row failed
  `assert.sameValue(obj, null)`. It now refuses (compile_error) instead. That is
  the one non-pass → non-pass move in the whole sweep and it is a deliberate
  improvement, not drift.

#### Controls — zero pass → non-pass on BOTH targets

Neighbourhood: `language/{expressions,statements}/generators/**`,
`built-ins/{GeneratorPrototype,GeneratorFunction}/**`,
`language/expressions/object/method-definition/**`,
`language/computed-property-names/**` — 991 rows, filtered to the **839** whose
source (or an `includes:` harness file that itself declares a generator —
checked, not assumed: `compareIterator.js`, `iteratorZipUtils.js`,
`testIntl.js`, `wellKnownIntrinsicObjects.js`) contains a generator. The filter
is sound because both edits live inside `buildNativeGeneratorPlan` /
`isNativeGeneratorCandidate` / the scan predicates, which are reached only for a
generator declaration; `generators-native-ast-scan.ts` has no consumer outside
`generators-native.ts`. Run in 150-row chunks, one fresh process each; before on
the clean worktree.

| lane | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| standalone | 839 | 661 pass / 113 fail / 65 CE | **688 / 112 / 39** | **+27, 0 lost**, 1 fail → CE (the `name-prop-name-yield-expr` correction above) |
| host (default) | 839 | 553 pass / 136 fail (689 in-process) + 79 / 69 / 2 (150 isolated) | identical | **0 changes, per row** |

Chunk `g-02` kills the in-process HOST runner (it replaces intrinsics in the
runner's own realm) — identically before and after, so it was re-measured
`--isolate`; an all-`error` or empty counts line is a broken run, not a
measurement.

Also green: `npm run -s typecheck`; the five ratchet gates run bare
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet` — `getTypeAtLocation +0`, `ctx.checker +0` —
`check:dead-exports`); `node scripts/equivalence-gate.mjs`: **22 failing / 1720
passing, all 22 in the committed baseline, no new regressions**.

Pin file `tests/issue-6651-generator-default-lane.test.ts`, 11/11, of which **6
are verified RED on the clean base tree** and 5 are guards green on both sides —
including both negative directions (a yielding body still bails; a computed
accessor name containing `yield` still produces the LOUD #680 diagnostic) and a
CONTROL that pins the one thing this slice does not fix (reading `.name` off a
class-valued default through a TS annotation traps in the already-admitted
object-literal lane too, so it is a pre-existing TS-lane gap — the test262 rows
are untyped JS and do assert NamedEvaluation, and they pass).

`tests/issue-3952.test.ts` — the case "generator FUNCTION-EXPRESSION host keeps
the host path for closure defaults" asserted the stale control above. It is
**REWRITTEN** to assert the measured behaviour, and tightened: host-free AND the
right value, so a future regression cannot hide as a leak-free wrong answer.

#### Two bounded experiments that returned NEGATIVE — do not repeat them

Both were run by lifting the gate and measuring the bucket, then reverting.

- **Computed-name generator methods (`isNativeGeneratorCandidate:3162`, 6 rows,
  4 host-passing).** Lifting the `ts.isIdentifier(decl.name)` gate gains **0**:
  all six still leak `env::__create_generator`. The emit sites in
  `literals.ts` / `class-bodies.ts` do not route a computed-name generator
  method to the native factory at all, so the candidate gate is the second
  blocker, not the first. `resolveAccessorPropName` already derives a stable key
  for the statically-resolvable subset, so the gate's recorded reason ("only an
  identifier-named method threads cleanly through the funcMap key") is
  answerable — but the work is at the emit site.
- **Named fn-expr referencing its own name (`…Shape:2525`, 9 rows, 4
  host-passing).** Lifting `bodyReferencesOwnName` turns 9 loud compile errors
  into 9 **wrong answers**: the body's `g` resolves to the OUTER `var g`
  (`scope-name-var-close` reports `g === <function>` where `'outside'` is
  required), and `BindingIdentifier = 1` mutates the wrong binding, so the
  strict-mode TypeError rows throw nothing. The immutable self-name binding has
  to exist first. The bail stays.

#### Residual sub-buckets (107 rows), with signatures

| rows | bail site / signature | host-pass | what it needs |
| ---: | --- | ---: | --- |
| 74 | `buildNativeGeneratorPlan:2324` — `lowerStatements` reached an unmodeled statement | 1 | **A2 proper.** ~46 are `yield` inside a destructuring-assignment pattern or a `for-of` head; the rest are computed class/object property names from `yield` (8), `(yield 3) + (yield 4)` (3), a `for-of` with `try` inside (2), `with` (1), a template middle (1), `obj.foo = yield` (1). Fails on host too — new engineering in both lanes. |
| 11 | `…Shape:2525` (9) + `…Shape:2503` (2) — fn-expr shape | 4 | the immutable self-name binding incl. its strict-mode TypeError; rest params with `eval` in parameter scope |
| 6 | `isNativeGeneratorCandidate:3162` — computed method name | 4 | the EMIT site (see the negative above), not the gate |
| 6 | parse: `'yield' is a reserved word and may not be used as an identifier in strict mode` | 0 | `function yield() {}` in a sloppy script. **compile_error on BOTH targets**, no `"use strict"` and no module marker in the assembly — a TypeScript parse-strictness question with corpus-wide blast radius, and the rows also need decorators. Not a generator gap; belongs in its own slice or a `wont-fix` with that reason. |
| 4 | `isNativeGeneratorCandidate:3188` — rest params | 1 | `...[_ = (eval('var x = "inside"'), …)]` — parameter-scope direct `eval` |
| 2 | `isNativeGeneratorCandidate:3288` — `super` / outer capture in an object-literal method | 0 | no [[HomeObject]] slot in the generator frame |
| 2 | `isNativeGeneratorCandidate:3151` — anonymous `export default function*` | 1 | a funcMap key for an unnamed declaration, plus module-namespace + `g.name === "default"` |
| 2 | fail (unchanged from A1) | — | `yield/star-in-rltn-expr.js` (wrong first `value`); `yield-star-before-newline.js` (`__gen_resume_g` `local.tee` type, pre-existing and byte-identical) |

#### Next for this cluster, in rows-per-effort order

1. **Wire the EMIT sites for computed-name generator methods** (6 rows, 4
   host-passing) — `literals.ts` / `class-bodies.ts` already derive the key via
   `resolveAccessorPropName`; the candidate gate then relaxes for free.
2. **A2 proper** (74 rows) remains the big lever, but it is host-first work:
   only 1 of the 74 passes on host today, so a standalone-only attempt cannot
   pay off. Model the suspension inside a pattern in `lowerStatements` on the
   HOST lane first, then let standalone follow.
3. **The immutable self-name binding** (9 rows) — the measurement above says it
   must land before the gate moves, not after.
4. **The sloppy-script parse question** (6 rows) is not cluster A's; file it
   where the strict/sloppy decision lives.
### 2026-09-21 — Cluster C (class / object-literal / `super`, standalone), slice C3: a JS defaulted parameter is not a scalar contract

- **Branch** `worktree-agent-a35b06677e1b85446`, based on `origin/main`
  @ `3769840f` (the merge of PR #6024). **Worktree**
  `/home/claude/js2/.claude/worktrees/agent-a35b06677e1b85446`. Not pushed —
  the round-2 coordinator integrates it.
- **Manifests** `C-class-object-super.txt`, 177 rows, sha256
  `785dd45d78a609ecefc58377433fd144a142423557001a9b513cf1ae1492ad8d`;
  `G-forof-destructuring-iterators.txt`, 134 rows, sha256
  `e68a764ab55ce04936572717bdf96f724fb337af6a9af3a758f3525851ff1dec`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| C before (`.tmp/6651/C3-before.log`) | 15 | 158 | 4 |
| C after (`.tmp/6651/C3-after2.log`) | **24** | 149 | 4 |
| G before (`.tmp/6651/G3-before.log`) | 23 | 109 | 2 |
| G after (`.tmp/6651/G3-after.log`) | **25** | 107 | 2 |

**+11 rows, 0 lost, 0 other verdict changes**, per-row set diff. Both logs
account for every input row (24+149+4 = 177, 25+107+2 = 134). The before side
was measured on a pristine `git archive HEAD` extract (`.tmp/basetree`) rather
than in the working worktree: the `--isolate` runner re-imports the compiler
from disk per row, so a sweep that overlaps an edit measures two compilers and
reads as one. Three sweeps were discarded to that before the discipline stuck —
freeze `src/` for the whole duration of any measurement.

#### The defect

A defaulted parameter in a JavaScript source file has no type. The checker
reports one anyway, read off the parameter's own initializer, and that report
is a statement about ONE call: `method(aFalse = c1 += 1)` infers
`aFalse: number`, so the parameter got an `f64` slot and
`C.prototype.method(false)` arrived as `0` — `SameValue(«0», «false»)`.

This generalises #5360, which keyed on the SHAPE of the initializer
(`= undefined` / `= null`) because in a `.ts` file those are the one default
whose inferred type is never a usable contract. In a `.js` file **no** default
yields a contract — there is no annotation the author could have written that
the checker would then enforce at every call site. So the gate is the FILE
(`/\.(?:[cm]?js|jsx)$/`), and the resulting rule is the one JavaScript already
has: every unannotated parameter is dynamic, defaulted or not. An unannotated
parameter WITHOUT a default is already `any` ⇒ externref; the defaulted one was
the anomaly. New leaf module `src/codegen/js-default-param-type-guess.ts`
(classified in `scripts/compiler-boundaries.json`).

**Two halves, and one alone is worse than neither.**

1. **Slot** — `paramTypeIsJsDefaultGuess` widens the scalar (`i32`/`f64`/`i64`)
   slot to `externref`, applied at ~20 derivations through ONE helper. That
   spread is the change, not an accident of it: the callee has ~a dozen lanes
   (constructor ×4, class method ×2, function declaration ×3, closure ×2,
   object-literal method ×3) and a CALL SITE independently rebuilds a candidate
   signature from the checker to match a stored closure. A disagreement is not
   a wrong value — it is a failed `ref.test`. Measured: with only the four
   callee lanes the manifest rows needed,
   `function outer(f = function (q = 2) { return q; }) { return f(7); }` went
   from a CORRECT answer on the base to an uncaught Wasm exception. #5221
   recorded the same failure mode for its own widening and left it unfixed for
   exactly this reason.
2. **Read** — `paramReadIsJsDefaultGuess`. The prologue was already right
   (`__extern_is_undefined` gates the default), but the next instruction at
   every use was `call $__unbox_number`, because an identifier read re-narrows
   an externref local to the checker's type, and the §7.2.16 step-1 fold in
   `binary-ops-typed-dispatch` decided `Type(number) !== Type(boolean)` and
   emitted `drop; drop; i32.const 0` for `a === false` without ever reading the
   boxed boolean. Widening the slot alone moves the coercion one instruction
   later: measured, `typeof a` answered `"number"` for an argument that had
   arrived as a boxed boolean, and `aFalse === false` stayed wrong on the host
   lane while `aFalse == false` and `!aFalse` were right.

Scope is deliberately the SCALAR slots. A JS default that resolves to a ref
(`= {}`, `= ""`) is structurally open for the identical reason and the closure
lane already carries that rule locally; extending it is an ABI change for every
object-shaped parameter in every npm package and is not part of this slice.

#### The corpus-wide control — and the two defects it found that the manifest could not

This is the expensive half of the slice and it earned its cost twice. The list
is every test262 file carrying a *widenable* defaulted parameter — **3,660 of
53,869**, found by a TS-parser scan, deterministically shuffled with seed 6651
so any prefix is a uniform sample, then the first **794** rows measured on BOTH
targets, before and after, in 150-row chunks per fresh process.

| 794-row control (`.tmp/w6651C3/ctl-corpus.txt`, sha256 `f7b449fb…`) | pass | fail | CE | skip | set diff |
| --- | ---: | ---: | ---: | ---: | --- |
| standalone before | 584 | 158 | 24 | 28 | — |
| standalone after | **588** | 154 | 24 | 28 | +4 gained, **0 lost** |
| host (gc) before | 627 | 139 | 0 | 28 | — |
| host (gc) after | **633** | 133 | 0 | 28 | +6 gained, **0 lost** |

The first after-run was **−9 on standalone**, and both causes were
**pre-existing defects this widening merely routes rows into**, not new
breakage. Neither is visible from the manifest.

1. **`compileIIFE` padded a missing argument with `ref.null.extern`.** §9.2.12
   pads with `undefined`, and `emitDefaultParamInit`'s externref arm tests
   exactly that (`__extern_is_undefined`); a bare null externref is JS **`null`**
   under the standalone value model (#2864), so the default never fired.
   Latent on the base tree, where `(function (f: any = 123) { init = f; }())`
   already left `init` null — a TypeScript-lane bug this slice's file gate never
   touches. Fixed by `missingIIFEArgExternref` (defaulted parameters only; for a
   parameter with no initializer `ref.null.extern` still means "absent
   reference", the distinction `canonicalUndefinedExternInstrs` asks callers to
   keep). Cost: 8 annexB rows + `param-dflt-yield-non-strict.js`.
2. **B.3.3.1 step 1.a.ii — `parameterNames does not contain F` — was not
   implemented for step 3.** #4131 added the web-compat *assignment* onto an
   existing binding without that guard, so a block-nested `function f(){}`
   overwrote a same-named parameter. It had been invisible because the
   parameter sat on an `f64` slot and the function object could not be stored
   there: the eight `*-func-skip-dft-param.js` rows were passing **by
   accident**, and widening the slot made the spec-wrong write land. Fixed in
   `annexb-cancel.ts` (`scopeBindsNameAsParameter`). A parameter is categorically
   different from the `var f` that `scopeBindsName` also reports: `var f` gets
   the step-3 assignment, a parameter gets nothing. Re-measured directly — all
   8 rows plus `block-decl-func-skip-param.js`, `-existing-var-update.js`,
   `-existing-fn-update.js`, `-func-update.js`, `-func-init.js` and
   `param-dflt-yield-non-strict.js`: **14/14 pass**.

Two further controls, because a parameter-slot move is an ABI change:

- **TypeScript lane, byte identity.** 13 `website/playground/examples/**/*.ts`
  × both targets: **26/26 sha256 identical**. The file gate cannot move a `.ts`
  program. (The IIFE fix *can* — it is not file-gated, proved by the probe
  above — it simply does not for this corpus.)
- **Real npm sources.** All **59** files across 10 packages that the scan says
  carry a widenable defaulted parameter (hono 48, axios 7, marked 2, jsbi 1,
  js-temporal-polyfill 1), compiled on the host lane: **47 binaries identical,
  10 changed, 0 OK→ERR** (the same 2 pre-existing `async shape not supported`
  refusals on both sides). This control caught a real regression during
  development: `marked.umd.js` failed with `nested function me changed its full
  physical ABI after reservation` because the nested-function *reservation* was
  widened and the nested-function *body derivation* was not.

#### What this slice does NOT close

- **The 8 `dstr/*-dflt-obj-ptrn-prop-ary` rows in C are a DIFFERENT defect**,
  and the round-2 dispatch table's "≥18 in C" conflates them. Measured
  unchanged before and after. Isolated precisely — only the parameter-default
  materialization path is wrong:

  ```js
  var { w: [a,b,c] } = { w: [7, undefined, ] };            // c === undefined  ✓
  function f({ w: [x,y,z] })           {}  f({w:[7,undefined,]});  // ✓
  function h({ w: [x,y,z] = [4,5,6] }) {}  h({w:[7,undefined,]});  // ✓
  function g({ w: [x,y,z] } = { w: [7, undefined, ] }) {}  g();    // z === null ✗
  ```

  §13.3.3.7 says `undefined`; an elision past the end of the materialized
  default array reads as wasm `null`. That is the next C slice.
- `object/method-definition/gen-meth-dflt-params-arg-val-not-undefined.js` — an
  object-literal GENERATOR method produces no generator object at all
  (`Cannot read properties of undefined (reading 'next')`). Unrelated lane.
- Standalone only: `aString.length === 0` on a widened parameter still answers
  wrong (right on host, wrong on standalone in the probe bitmask). Wrong on the
  base too.
- Ref-valued JS defaults (`= {}`, `= ""`) — see the scope note above.

#### Gates

`check-loc-budget` (grants + dated rationale in this file's frontmatter),
`check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`
(`getTypeAtLocation +0, ctx.checker +0` across 19 changed files — the
declaration query goes through `ctx.oracle.declarationsOf`),
`check:dead-exports`, `check:compiler-boundaries:inventory`, prettier and
`equivalence-gate` (22 failing / 1720 passing, all 22 in the baseline) are all
green. Pin test `tests/issue-6651-js-defaulted-param-slot.test.ts`, 9 cases,
five of them verified RED on a pristine base extract.

### 2026-09-21 — Cluster B (RegExp `@@` protocol, standalone), slice B4: §22.2.6 accessor READS on the `$NativeRegExp` carrier (+ the generic `flags` getter, #5198 Slice F)

- **Base** `89767a49d9` (`claude/es2015-test262-plan-54tooh` immediately after
  B3), **not** current `origin/main`. `git log 89767a49d9..origin/main --
  src/codegen` touches no RegExp module, so this slice is collision-free with
  what landed meanwhile; the A2/C3/E2 twin merge into main is being resolved
  separately on the PR branch and is deliberately NOT done here.
- **Manifest** `plan/agent-context/6651/B-regexp-protocol.txt` **minus the 27
  rows B1+B2+B3 landed** = 120 rows (`.tmp/6651/B4-manifest.txt`, sha256
  `df02bc5dcd63f8135054a2a3c3e211510323e34cc078972a878d7deb447f159d`).
- **Engine** `JS2WASM_EVAL_ENGINE=quickjs` (artifact `073742801ba7`, adapter key
  `d4799bda84cfed0d` — the same pair B2/B3 measured under, rebuilt for this
  run), `--standalone --isolate`, 60-row chunks in fresh processes, one runner
  at a time.

#### The defect

A `$NativeRegExp` is a closed nominal struct whose DECLARED FIELD NAMES include
`flags` (the i32 bitfield) and `source`, and `fillClosedStructExternGetArms`
gives every closed struct a declared-field ladder in `__extern_get`. So a
RUNTIME-keyed read walked into the ladder instead of the §22.2.6 accessor:
`re[k]` with `k = "flags"` answered the **number 1** for `/a/g`, `re[k]` with
`k = "global"` answered `undefined`, and `source` looked right only by
coincidence (the field holds what the getter would return). §22.2.6.8 step 4 is
`ToString(? Get(rx, "flags"))`, so `"1"` contains no `g` — B3's fully
implemented §22.2.6.8 step-6 global collect loop was **dead on every real
RegExp receiver**, which is why B3 gained zero rows from it.

#### The fix — one prologue, one shared predicate, one generic getter

`src/codegen/regexp-accessor-get-arm.ts` (new, ~350 LOC) unshifts onto
`__extern_get`:

```
if (__regexp_getter_only_set(obj, key))   // brand + a §22.2.6 name — the WRITE
  if (!__carrier_bag_has(obj, key))       // half's predicate, reused verbatim
    return __regexp_accessor_get(obj, key);
```

Three facts are load-bearing and each is recorded in the module header:

1. **`__regexp_flags_generic` is §22.2.6.4 verbatim** — eight ordered
   `ToBoolean(? Get(R, <name>))` calls — and does NOT shortcut to the bitfield
   even on a real RegExp. `coerce-global` overrides `global` on the instance and
   requires `flags` to see it; `get-global-err` requires a poisoned `global`
   getter to abort the read. The recursion is one level deep: the eight flag
   names are answered from the struct and none of them is `flags`.
2. **The own-property consult is the shadowing implementation.** For seven of
   the nine names "fall through" is enough (the ordinary path reads the expando
   bag and runs accessors found there). `flags` and `source` cannot fall
   through — they are also declared FIELD names, so the ladder answers them
   first — and are re-entered against the bag object directly. Deliberate
   narrowing, recorded: the bag is then the accessor's `this`.
3. **The same native is the body of the reified `RegExp.prototype.flags`
   getter** (#5198 Slice F), which is brand-check-free because §22.2.6.4 is the
   one member of the family defined over an arbitrary Object. One native, two
   entry points, so the instance-side and prototype-side halves cannot drift.

The WRITE half (`regexp-accessor-set-guard.ts`) gained the same own-property
consult: §10.1.9 consults the OWN descriptor first, and the getter-only no-op
is what happens when the walk reaches the PROTOTYPE's accessor. Without it
`Object.defineProperty(r,'global',{writable:true}); r.global = true` was
swallowed.

**The `fileObservesRegExpExecProtocol` widening takes TWO tokens, and that is
measured.** A descriptor-shaped definition is the other way a program makes
§22.2.6 observable, but on the bare `defineProperty` token the widening gained
2 rows and LOST 3 (`@@match/{y-fail-lastindex-no-write,
builtin-failure-y-set-lastindex-err,builtin-success-y-set-lastindex-err}`) —
all of which define a **non-writable `lastIndex`** and need the `Set` to throw,
which the static core honours and the observable route does not yet. Requiring
a `defineProperty`/`defineProperties` token AND a §22.2.6 **accessor** name
(`lastIndex` deliberately excluded) keeps the gain and drops the loss.

#### Receipt — manifest (re-measured for this commit)

| 120 rows, `--standalone --isolate`, QuickJS | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before, sources `cp`-reverted (`.tmp/6651/B4-before3-{00,01}.log`) | **0** | 111 | 9 |
| after (`.tmp/6651/B4-after3-{00,01}.log`) | **8** | 104 | 8 |

**+8 rows pass, zero regressions**, joined row-by-row (`.tmp/6651/join.mjs`,
output in `.tmp/6651/B4-join-manifest.txt`): 8 rows changed status, all
non-pass → pass, every other row keeps its exact status. The 8 are
`@@match/{get-global-err, get-unicode-error, coerce-global, flags-tostring-error,
g-get-result-err, g-coerce-result-err, builtin-success-g-set-lastindex,
builtin-infer-unicode}` — i.e. the poisoned-accessor reads, the own-`flags`
shadow, and four rows of B3's step-6 loop that are reachable for the first time
because step 4 finally answers `"g"`.

**The predecessor's logs are NOT the receipt.** `.tmp/6651/B4-after2-00.log` is
a byte-identical copy of `B4-after-00.log` (20:09) and `B4-after2-01.log` is
empty; both predate the 21:11 gate widening, and the 20:33-21:02 control logs
predate it too. Everything above was re-run from scratch on the final sources.

#### Controls — zero pass → non-pass

Control set = B3's 252-row recipe WIDENED with every §22.2.6 accessor directory
in full (`built-ins/RegExp/prototype/{flags,global,ignoreCase,multiline,dotAll,
unicode,sticky,hasIndices,source}/**`), minus the manifest: **326 rows**
(`.tmp/6651/B4-controls.txt`, sha256
`352c5604a723d590656f7c968dce45f5ef855d4e7dc165a0400329fe4a215cde`, built by
`.tmp/6651/mkctrl.mjs`).

| lane | rows | result |
| --- | ---: | --- |
| standalone, after (`.tmp/6651/ctrl-after3-{00,01,02}.log`) | 326 | 269 pass / 37 fail / 20 compile_error |
| standalone, before — the **57 non-pass-after rows** on `cp`-reverted sources (`.tmp/6651/ctrl-before3.log`) | 57 | 0 pass; **every row's status IDENTICAL to its after status** |
| host — compiled-binary sha256 of 12 representative programs (`.tmp/6651/hostsha3-{before,after}.txt`) | 12 | **all 12 byte-identical** |
| standalone — the same 12 (`.tmp/6651/sasha3-{before,after}.txt`) | 12 | 3 identical (`static-reflection`, `defineproperty-plain-object`, `no-regexp-at-all`), 9 differ |

The 57-row before-side is COMPLETE for the regression question, not a sample: a
pass→non-pass regression is by definition non-pass after. The standalone sha
table differs from B3's on purpose — B4 has **no** byte-identity claim for
standalone: the prologue is unshifted into `__extern_get` in every module that
has a `$NativeRegExp` struct, so any regexp-bearing standalone program changes
bytes. A program with no regexp is untouched, which is what the two identical
non-regexp rows assert. The host lane is where byte-identity IS claimed, and it
holds on all 12.

#### Gates (bare, exit codes read directly)

`check-loc-budget` · `check-func-budget` · `check-coercion-sites` ·
`check:oracle-ratchet` · `check:dead-exports` — all `0`.
`check-compiler-boundaries --mode inventory --base origin/main` — `0`
(`regexp-accessor-get-arm.ts` classified). `npm run -s typecheck` — `0`.
`npx biome lint src tests scripts --diagnostic-level=error` — `0`.
`prettier --check` on all touched files — `0`. `scripts/equivalence-gate.mjs` —
`0`, **22 failing / 1720 passing, all 22 in the committed baseline**.
Pin suites: B1 `issue-6651-string-symbol-protocol` + B2
`issue-6651-regexp-exec-protocol` + B3 `issue-6651-regexp-symbol-protocol-b3`
**35/35**, and the new `tests/issue-6651-regexp-accessor-get-b4.test.ts`
**14/14** (the vitest process still exits 1 on the known
`[vitest-worker]: Timeout calling "onTaskUpdate"` RPC flake under a loaded
4-core box; every test reports PASS). The new suite was **verified red on the
reverted base**: 13 of its 14 fail there
(`.tmp/6651/g-pin-b4-ONBASE.log`), the single green one being the intended
static-reflection control.

#### Residuals (112 rows) and one honest correction

| rows | bucket | what it needs |
| ---: | --- | --- |
| 31 | `@@split` (6 CE) | unchanged: SpeciesConstructor, the sticky splitter walk, generic result reads |
| 30 | `@@replace` | unchanged: §22.2.6.11's result loop + GetSubstitution |
| 12 | RegExp ctor / statics (1 CE) | observable `IsRegExp`, called-as-function short-circuit, ordered `source`/`flags` Gets |
| 10 | `String.prototype.*` (1 CE) | unchanged from B1/B2 |
| 8 | `RegExp.prototype` accessors / `exec` | unchanged from B1/B2 |
| 7 | `prototype/compile` | Annex B ordering + SyntaxError/TypeError shapes |
| 5 | `@@match` `*-set-lastindex-err` family | ALL five that remain are the strict `[[Set]]`-must-throw gap — `__extern_set` silently no-ops on a non-writable property (B3's recorded object-runtime gap). Closing that closes this bucket AND re-opens the one-token gate widening above. |
| 5 | `prototype/flags/coercion-*` | see below |
| 3 | `@@search` | `coerce-string-err` needs `__extern_toString(symbol)` to throw per §7.1.17 |
| 1 | annexB misc | unchanged |

**The five `flags/coercion-*` rows do NOT pass, and the Slice F claim is
narrower than it reads.** The brand-check defect they named IS fixed — their
failure moved from `TypeError: Method called on incompatible receiver … at L21`
(the FIRST assert) to `SameValue(«""», «"g"») … at L33` (the first TRUTHY
value), i.e. four more asserts now run. The remaining half is not §22.2.6.4:
compiled as TypeScript the identical sequence answers correctly
(`.tmp/6651/probe-coercion3.mts` walks `undefined → null → NaN → "" → "string"
→ 86` on a plain object and returns 1), and the pin suite's generic-getter case
(`get.call({global:"truthy-string", sticky:86}) === "gy"`) passes. So what is
left is in the row's own shape — a script-scope `var` receiver whose property
slot loses a later string — not in the getter. Next owner: treat these as an
object-runtime/property-slot row family, not a RegExp one.

### 2026-09-22 — Cluster F (Proxy / Reflect, standalone), slice F2: the realm verdict, and three checks that declined

- **Branch** `issue-6651-cluster-F2-proxy-reflect`, based on `origin/main`
  @ `6190e961`. **Worktree**
  `/home/claude/js2/.claude/worktrees/agent-afd428375de50fa97`.
- **Manifest** `plan/agent-context/6651/F-proxy-reflect.txt`, 89 rows, sha256
  `3edd7052b503ee48f0022a8bc2f5c041a116228d19ef65d31bf2aeb54cf80dd7`
  (unchanged from F1).

| standalone, `--isolate`, 89 rows | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/F2-before.log`, `.tmp/6651/nb-pr-before.log`) | **7** | 77 | 5 |
| after (`.tmp/6651/nb-pr-after.log`) | **9** | 75 | 5 |

**+2 rows; zero lost; zero other verdict changes** — a per-PATH join, not a
count comparison. The before-state was measured TWICE, three hours apart: once
in the worktree before any edit, and once from a `git archive HEAD` extract
(`.tmp/base-tree`) while the branch sweep ran beside it. The two agree row for
row, so the delta is not measurement drift.

#### The 23 `*-realm*` rows: measurable, and NOT environment

F1 recorded them as "unmeasurable in this container — `$262.createRealm` needs a
built QuickJS provider". **That classification is retired.** The provider is
built (`.test262-cache/quickjs-eval-adapter-d4799bda84cfed0d.wasm`), QUICKJS is
now the runner's DEFAULT engine, and all 23 rows execute and fail with specific,
deep assertion messages — none says "provider is not built". `$262.createRealm`
works; `new OProxy(t, h)` through a foreign-realm `Proxy` constructor really does
mint a `$Proxy` (probed: its `get` trap runs, exactly once). So these are
ordinary compiler defects, and their causes are NOT realm-specific:

| rows | signature | root cause as probed |
| ---: | --- | --- |
| 5 | `Proxy/defineProperty/targetdesc-*-realm`, `defineProperty/trap-is-not-callable-realm` | a foreign-realm proxy's `[[DefineOwnProperty]]` skips the §10.5.6 checks the same shape gets natively. Probed side by side: `new Proxy({}, {defineProperty:{}})` throws, `new OProxy({}, {defineProperty:{}})` does not — the proxy VALUE is real, the dynamic dispatch it reaches is the one without the guards |
| 6+1 | `Proxy/construct/return-not-object-throws-*-realm`, `trap-is-not-callable-realm` | same asymmetry on `[[Construct]]`: `new P()` on a top-level foreign-realm proxy binding does not run §10.5.14 step 11, while the native spelling does. Shape-sensitive, not realm-sensitive — the native spelling ALSO loses the defineProperty guard when the proxy is built inside a helper function |
| 1 | `getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined-realm` | **not a realm defect at all** — the native spelling fails identically. The trap returns `null`, and `__proxy_inv_gopd`'s `isAbsent` treats a null externref as "the trap answered undefined" (§10.5.5 step 11). Deliberately not fixed: `__getOwnPropertyDescriptor` answers a genuine MISS with either null or the undefined singleton (#2106), so branding null as "not undefined" would throw for a legal `return undefined` trap. This needs a null/undefined-distinct value representation, not a guard tweak |
| 2 | `Proxy/get-fn-realm{,-recursive}` | `Reflect.construct newTarget is not a constructor` — #3371's lane |
| 4 | `apply/arguments-realm`, `construct/arguments-realm`, `construct/trap-is-undefined-proto-from-*-realm` | reading a foreign realm's intrinsic (`f().constructor`, `Object.getPrototypeOf(p)`) answers null |
| 3 | `defineProperty/desc-realm`, `ownKeys/return-not-list-object-throws-realm`, `revocable/tco-fn-realm` | one each: a descriptor object with a null prototype; an `undefined` ownKeys result through the `new other.Proxy(…)` spelling; a cross-realm `TypeError` identity |

Log: `.tmp/6651/F2-before.tsv` carries every row's verdict and reason.

#### What landed — three checks that declined on a value they should have rejected

None of the three is a new mechanism; each is an existing check whose admission
test let the wrong value through.

1. **`Object.getPrototypeOf(<integrity-marked binding>)` folded to
   `%Object.prototype%` for every marked identifier.** The arm's own comment
   scopes it to "closed standalone plain objects [that] keep their ordinary
   prototype implicit" — exact for `var o = {}`, wrong for a binding whose
   prototype was chosen at creation. Measured on base, one module:
   `var a = Object.create(proto)` reads back `proto` BEFORE
   `Object.preventExtensions(a)` and `%Object.prototype%` after. The order
   sensitivity is the tell: `ctx.nonExtensibleVars` is filled as statements are
   COMPILED, so only later-compiled sites see the mark. The runtime link is
   untouched throughout — the same query through a helper function, through
   `Reflect.getPrototypeOf`, through `proto.isPrototypeOf(a)` and through an
   alias `var z = a` all answer `proto`. Only the folded spelling was wrong.
   `bindingHasExplicitPrototype` now excludes an `Object.create(…)` /
   `Object.setPrototypeOf(…)` / `Reflect.setPrototypeOf(…)` initializer and a
   colon-form `__proto__` literal. **Deliberately not widened past the
   DECLARATION**: a prototype written by a later `setPrototypeOf` STATEMENT
   keeps the fold, because `Reflect/setPrototypeOf/return-false-*` asserts
   exactly that singleton after a REFUSED set on a `var o = {}` carrier.
2. **§28.1.1 step 2 (CreateListFromArrayLike) declined a LITERAL `null` /
   `undefined` argumentsList.** `emitNativeReflectNonObjectGuard` refuses to
   brand a null carrier at runtime — this compiler's alias widening nulls
   ordinary objects — so `Reflect.apply(fn, null, null)` called `fn` with an
   empty list. That hazard is about VALUES; this is a question about the
   EXPRESSION, and `guardReflectTargetIsObjectOrNullish` (built for exactly
   this in #6494 S3) already answers it. Measured: the row's other eight
   assertions — number, boolean, symbol, `Infinity`, `NaN`, and the throwing
   `length` getter — already passed.
3. **§28.1.2 step 1 `IsConstructor(target)` was never checked.** The arm checks
   IsConstructor on the NEWTARGET and nothing on the target, so
   `Reflect.construct(1, [])` reached `compileNewExpression(new 1())` and
   answered without throwing. Only the STATICALLY decidable half is taken, and
   that restriction is the design, not a shortcut: a runtime
   `__reflect_is_constructor` probe has to spill the target into a local, and
   `compileNewExpression` then evaluates the same expression a SECOND time —
   a real break for `Reflect.construct(f(), [])`. The static half never needs
   the duplicate, because it fires only where the program is guaranteed to
   throw. Three admitted classes: a primitive by the oracle's own type fact; an
   object/array literal or arrow function written in place; and a BUILT-IN
   METHOD through an unshadowed ambient global (`Date.now`), recognised by its
   lib declaration being a `MethodSignature` in a `.d.ts` interface — every ES
   constructor is `declare var X: XConstructor` instead, so the two separate
   exactly without a hand-kept name table. TypeScript construct signatures are
   NOT usable here: `function f() {}` has none and IS a constructor.
   Evaluation order is preserved, not short-circuited — the target and each
   argument-list element are compiled and dropped ahead of the throw.

#### Controls

| lane | rows | before | after | flips |
| --- | ---: | --- | --- | --- |
| `built-ins/Proxy/**` + `built-ins/Reflect/**`, standalone (`.tmp/6651/nb-pr-{before,after}.log`) | 464 | 381 / 78 / 5 | **383** / 76 / 5 | +2, **0 lost, 0 other** |
| corpus-wide integrity∩prototype rows (every test262 file mentioning `preventExtensions`/`seal`/`freeze` AND `getPrototypeOf`/`__proto__`, 30) + a deterministic 1-in-6 sample of the 820 `Reflect.apply`/`Reflect.construct` users OUTSIDE the neighbourhood (137), standalone (`.tmp/6651/nb-extra-{before,after}.log`) | 167 | 107 / 52 / 8 | **108** / 51 / 8 | **+1** (`built-ins/Object/prototype/__proto__/set-non-extensible.js`), 0 lost |
| the 89-row manifest ∪ the 167 above, HOST (default target) (`.tmp/6651/nb-host-{before,after}.log`) | 252 | 138 / 113 / 1 | 138 / 113 / 1 | **none** |

**Host byte-identity corpus** (`.tmp/6651/sha-{before,after}.txt`): ten programs
— a Proxy/Reflect-free control, the four changed prototype shapes, the kept
plain-literal fold, a nullish and a real `Reflect.apply`, a non-constructor and
a real `Reflect.construct`, and a proxy module — compiled for BOTH targets.
**All 10 `gc` binaries are byte-identical**; on standalone exactly the five
programs that exercise a changed arm move and the other five are identical.
That is the intended shape for a lane-gated change: the `getPrototypeOf` arm is
guarded by `ctx.standalone`, and the two Reflect arms are not reached on the
host lane (empirically, on these shapes).

Also green, all run bare: `npm run -s typecheck`; the five ratchet gates
(`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet` — +0 `getTypeAtLocation`, +0 `ctx.checker` — and
`check:dead-exports`); `node scripts/equivalence-gate.mjs` (22 failing / 1720
passing, all 22 in the committed baseline); `biome lint
--diagnostic-level=error`; and the new pin file
`tests/issue-6651-cluster-f2-proxy-reflect.test.ts`, 7/7 — **5 of the 7 verified
RED on the base commit**, 2 guards green on both sides.

The pin file compiles module-scope **JavaScript** (`allowJs`,
`deferTopLevelInit`) rather than the ORIGINAL-HARNESS assembly, and that is a
deliberate, stated trade: the harness assembly reproduces all three defects (it
is how they were found) but compiling it exceeds the 512 MB
`VITEST_FORK_MAX_OLD_SPACE_SIZE` the unit lane runs under. The JS module-scope
shape is what matters for defect 1 — a TS-typed local takes a different arm.

#### Newly root-caused, NOT taken

- **`Array.prototype` is not identity-stable inside a function body.** Probed on
  base and on this branch: `function rd() { return Array.prototype; }` gives
  `rd() !== Array.prototype` AND `rd() !== rd()` — every in-function read mints
  a FRESH empty array (`Array.isArray` true, `length` 0). `Object.prototype`,
  `Function.prototype`, `RegExp.prototype` and a user object are all stable, so
  this is specific to `Array.prototype`. **This, and not the §10.5.1 invariant,
  is what blocks `Proxy/getPrototypeOf/not-extensible-same-proto.js`**: the
  target's real prototype and the value the trap returns are two different
  objects, so the step-10 SameValue comparison fails and a COMPLIANT trap throws
  `Proxy trap result violates a Proxy invariant`. Worth its own task; the
  blast radius is every `X.prototype` identity comparison in a function.
- **The §10.5 guards are dispatch-shape-sensitive, not realm-sensitive** (see
  the realm table above). One mechanism — "a `$Proxy` the compiler only knows at
  runtime reaches a dispatch without the §10.5.6 / §10.5.14 post-trap checks" —
  is worth ~12 rows in this manifest alone. That is the best rows-per-effort
  left in cluster F and it is now measured rather than guessed.
- **`Proxy/setPrototypeOf/not-extensible-target-same-target-prototype.js`** is
  NOT fixed by the narrowing above: its failing assertion reads
  `Object.getPrototypeOf(outro)` where `outro = {}` and the prototype is written
  inside a trap through the PARAMETER name `t`. The receiver-name scan sees `t`,
  not `outro`, so the literal fold still claims it. Closing it needs the fold to
  yield whenever a module contains a `setPrototypeOf` whose receiver is not
  statically resolvable — a broad widening, not a call-site one.

#### Residual sub-buckets (80 rows), updated

| rows | status | sub-bucket | what it needs |
| ---: | --- | --- | --- |
| 23 | fail | `*-realm*` / `cross-realm` | **no longer environment** — re-classified above. 12 of them are the one dispatch-shape mechanism; 1 is the `null`-vs-`undefined` representation; 2 belong to #3371; 8 are foreign-intrinsic reads |
| 24 | fail | `*-target-is-proxy.js` | nested-proxy forwarding over EXOTIC targets (array `length`, `new String("str")`, RegExp `lastIndex`, function `prototype`). Several mechanisms per row; 6 of 24 fail on host too |
| 7 | fail | `has/call-in-prototype*`, `set/call-parameters-prototype*`, `defineProperty/call-parameters` | a proxy reached through the PROTOTYPE CHAIN never runs its trap — `$Object.$proto` is `ref null $Object` and `$Proxy` is not a subtype. Type-graph change, unchanged from F1 |
| 4+3 | fail/CE | `Proxy/construct/*` NewTarget | #3371's lane, unchanged |
| 4 | fail | `deleteProperty` family | #4745 tombstone/closed-struct gap, unchanged |
| 4 | fail | `getOwnPropertyDescriptor/*` "X should be an own property" | gOPD trap-absent forward over exotic targets; 3 of 4 fail on host |
| 2 | fail | `Reflect/ownKeys/{order-after-define-property,return-on-corresponding-order-large-index}` | unchanged from F1 |
| 1 | fail | `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js` | still blocked at its FIRST assertion (the refusal is invisible for a JS `var o = {}` carrier — F1's carrier-promotion finding). Its later `Object.getPrototypeOf(Object.create(null))` assertion is fixed by this slice, so the row is one defect closer |
| 8 | fail/CE | singletons | `Proxy/getPrototypeOf/not-extensible-same-proto` (→ the `Array.prototype` identity defect above), `Reflect.hasOwnProperty` CE (`Reflect/enumerate/undefined.js`; `Reflect.enumerate === undefined` already answers correctly, so this row is one static fold away), `Reflect/construct/arguments-list-is-not-array-like.js` (non-array-literal argsList is still a hard compile error), `Proxy/enumerate`, `Proxy/set/trap-is-null-receiver` (prototype-chain), the `Proxy/apply/*-target-is-proxy` pair, `Proxy/get/trap-is-undefined-receiver` |

## Handoff — 2026-09-21 (round 1 closed, round 2 ready to dispatch)

### What landed

PR [#6023](https://github.com/loopdive/js2/pull/6023) merged into `main` at
`5ac0df63bd` with slices A1, B1, C1+C2, D1, E1, F1, H1. Per-owner manifest
receipts (isolated `--standalone` runner, before → after, all with **zero
pass→non-pass** in their neighbourhood controls and byte-identical host-lane
binaries for the probed programs):

| cluster | manifest rows | before → after | gain |
| --- | ---: | --- | ---: |
| A generators | 197 | 1 → 62 | +61 |
| D promise combinators | 101 | 0 → 26 | +26 |
| E typed arrays / buffers | 144 | 0 → 13 | +13 |
| C class / object / super (C1+C2) | 177 | 0 → 12 | +12 |
| B RegExp protocol | 147 | 0 → 7 | +7 |
| F Proxy / Reflect | 89 | 0 → 7 | +7 |
| H builtins misc | 217 | 0 → 3 | +3 |
| G for-of / destructuring (follow-up PR) | 134 | 0 → 21 | +21 |
| I language misc (triage only, follow-up PR) | 114 | 0 → 0 | 0 |
| **sum** | | | **+150** |

These are manifest-row gains measured by each owner on their own base, not a
fresh full-suite census. The next authoritative number comes from the
`promote-baseline` run on `main` after #6023 (baseline
`test262-standalone-current.jsonl`); until then the honest statement is
"10,384 + ≤150 of 11,704".

G (for-of / destructuring / iterators, +21) and I (language misc, triage
only) landed after #6023 and ship in the follow-up PR together with this
handoff; their receipts are the two Cluster-status entries just above.

### Environment facts the next session needs

- **QuickJS eval provider is now built** in `.test262-cache/` (artifact
  `quickjs-artifact-2e2d7736713beeda`, adapter keyed on the compiler source
  hash; rebuild the adapter with
  `node --import tsx scripts/build-quickjs-eval-provider.mjs`, ~10 s when the
  artifact is cached). Every round-1 owner reported 5–63 rows per cluster as
  "unmeasurable: provider not built" (realm / `$262.createRealm` /
  detached-buffer shapes, ~130 rows total). Round 2 measures them with
  `JS2WASM_EVAL_ENGINE=quickjs` before classifying anything as environment.
- Agent worktrees get a `test262/` symlink farm that may not resolve; repair
  with `ln -sfn /home/user/js2/test262/test test262/test` (same for
  `harness`). An all-`error` counts line is a broken farm, not a measurement.
- The in-process runner OOMs / dies with an empty log above ~200–500 rows
  (realm poisoning); chunk neighbourhood sweeps at 128–200 rows per fresh
  process. Never `pkill -f run-test262-paths` (it killed other lanes' runs);
  match `/proc/<pid>/cwd`.
- Probe against the ORIGINAL-HARNESS assembly at module scope
  (`assembleOriginalHarness`), not a hand-written `export function test()`:
  several defects (C2-a, the `{kind:"class"}` expando fact in B1) exist only
  in the module-scope shape.
- A compile-only per-gate histogram (instrument every bail in the candidate
  gates) turns "N compile errors" into a bucket table in minutes; an 8-row
  host-lane probe per bucket then says which buckets can reach `pass`.
- The pre-commit hook greps the COMMAND LINE for the `✓` sign-off; `-F file`
  alone is blocked. New `src/codegen/*` modules must be classified in
  `scripts/compiler-boundaries.json` or `quality` fails on the inventory gate
  (this cost #6023 one CI cycle).
- The per-box spawn load cap was raised to 3 in the gitignored
  `.claude/max-load` for the PR shepherd; 4-core box, three heavy agents max.

### Round 2 — dispatch table (largest measured residuals, with owner shape)

| # | residual family | rows | mechanism (from the owner's receipt) | lane / effort |
| --- | --- | ---: | --- | --- |
| A2 | `yield` inside a destructuring pattern (`[x = yield] = v`, `for ([{} = yield] of …)`) | 90 | `lowerStatements` must model a suspension inside a pattern; **fails on host too** (8/8 probe), so it is new engineering in both lanes, not a port | senior-dev, max |
| C3 | ~~defaulted parameter typed `number` by the checker lowered to an f64 slot (`«0» vs «false»`, `«NaN» vs «undefined»`)~~ **DONE** — see the C3 entry above | 10 in C + 2 in G (the `«0» vs «false»` half); the 8 `«NaN» vs «undefined»` rows are a separate `dstr` defect, still open | landed as slot-widening at ~20 derivations + suppression of the checker-type re-narrowing at READS, not a type-map change; corpus control 794 rows × both targets, 0 pass→non-pass | senior-dev, max |
| D2 | observable intrinsic `Promise.all/race` protocol (`invoke-resolve*`, `invoke-then*`, iterator close) | ~34 | held PR #5883 (#5197 R3-2/R3-4) — integrate, don't re-implement; class-receiver `Construct(C)` (14 CE) is #5197 G9/G10 | senior-dev, high |
| B2 | observable `RegExpExec` substrate + brand-check widening | 62 | #5198 Slice B / draft #5393 owns it; coordinate with that lane first | senior-dev, high |
| ~~E2~~ **DONE 2026-09-21** (+7 manifest, +3 outside, 0 regressions — see the slice-E2 entry) | closed: §10.4.5.6 `[[OwnPropertyKeys]]` string keys, the `%TypedArray%` static `from`/`of` carrier, §23.2.2.1 step-3 `IsCallable(mapfn)`. Still open and RE-ROOT-CAUSED there: `internals/Set` (needs `Reflect.set` receiver override), `internals/DefineOwnProperty` (expando table stores values, not attributes), the symbol group, the static-carrier expando table, and two rows blocked on `new TA(4).subarray(2)` answering null | 37 | each is a mechanism, not an arm; the static `new Int8Array(1)` carrier has no expando side-table for `__extern_get` | senior-dev, high |
| F2 | proxy in the prototype chain never runs its trap; `Proxy/construct` NewTarget | 7 + 7 | `$Object.$proto` is `ref null $Object` and `$Proxy` is not a subtype — architectural; NewTarget belongs to the #3371 lane | architect spec first |
| H2 | symbol-keyed accessor `defineProperty` on a vec carrier dropped; `__extern_length` for non-`$Object` carriers; `Object.prototype.toString` runtime tag honouring `delete` | ~15 | localized to lines in H's receipt | developer, high |
| I2 | `instanceof` never consults `@@hasInstance` (primitive-LHS fold in `emitDynamicInstanceOf` answers before the handler) | 3 (+ corpus) | lowering change in one function via the existing `__apply_closure` invoker; both-lane sweep over `language/expressions/instanceof/**` | developer, high |
| I3 | module namespace object: self-import under the runner's virtual `./test.ts` key is left nested (#2932) AND the compiler materializes no namespace for a top-level self-import (`ns` reads null) | 12 | runner + compiler + then the MOP — XL, not the small MOP slice round 1 assumed | architect spec first |
| realm | every `*-realm*` / `cross-realm` / detached row across A–H | ~130 | re-measure under `JS2WASM_EVAL_ENGINE=quickjs`; then split fixable vs `$262.createRealm` wont-fix | developer, medium |

Dispatch order by rows-per-effort: A2, C3, E2 first (three slots), then D2/B2
(coordination-bound), then I2/H2/realm, F2 and I3 after their specs. Cluster I's
triage (above) also found that with the QuickJS provider present ZERO of its 114
rows are environment-unmeasurable, and that 5 `language/module-code/*-gen-*`
compile errors are generator leaks belonging to A2.

### Definition of done reminder

Unchanged: 11,704 / 11,704 on a full authoritative standalone run, or a
`wont-fix` issue with the spec-level reason for every remaining row; bank the
ES2015 floor via `check:edition-ratchet:update` from a FULL run only.

### Merge note — 2026-09-21, PR #6026 landed independent twins

While this branch was open, PR [#6026](https://github.com/loopdive/js2/pull/6026)
merged its own A2, C3 and E2 slices to `main`, in the same files. The
`git merge origin/main` on this branch resolved them once, deliberately: the JS
defaulted-parameter SLOT widening is now main's broader
`src/codegen/js-default-param-type-guess.ts` (`paramTypeIsJsDefaultGuess` /
`widenJsDefaultGuessSlot` / `widenJsDefaultGuessSymbolSlot` /
`paramReadIsJsDefaultGuess`), which every parameter-lowering lane applies, and
this branch's twin (`isJsUntypedDefaultParam` / `widenJsUntypedDefaultParamSlot`
/ `jsUntypedDefaultParamSlotMoves` in `checker/type-mapper.ts`, plus
`readsJsUntypedDefaultWidenedParam`) was deleted with all of its call sites; the
TypedArray view own-property surface is this branch's superset
`src/codegen/ta-dyn-own-keys.ts` (five arms) and main's
`ta-dyn-own-property-names.ts` was removed, because two arms spliced at body[0]
of the same native cannot both hold the front slot; A2 kept both sides, which
are complementary (main's "admit element defaults by suspension" and this
branch's `for-of` step terminator + iter-close unwind). The rest of C3b — the
IIFE return-protocol parking and the removal of the async-method exclusion — is
unchanged. **Before starting any further slice of this plan, run
`git log origin/main --grep=6651` and diff the files you intend to touch against
main** — the two lanes working this issue produce twins in the same files, and a
twin is far cheaper to avoid than to resolve.

### 2026-09-23 — Cluster I (language misc, standalone), slice I2: `instanceof` consults `@@hasInstance`

- **Branch** `worktree-agent-ad69a5dbc13ab8a8e`, base `main` @ `6190e961`.
  **Worktree** `/home/claude/js2/.claude/worktrees/agent-ad69a5dbc13ab8a8e`.
  Not pushed; the round-3 owner integrates it.
- **Manifest** `plan/agent-context/6651/I-language-misc.txt`, 114 rows,
  sha256 `f94fe9f129c0bcc5e5e52ce798cbeedfa6cae99f7506f5547af54717a71cdd68`
  (unchanged from the triage pass).

| standalone, `--isolate`, engine **quickjs** | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/I2-before.log`) | **3** | 100 | 11 |
| after (`.tmp/6651/I2-after.log`) | **6** | 97 | 11 |

**Per-row set diff (not a count comparison): +3 gained, 0 lost, 0 other
verdict changes.**

```
+ language/expressions/instanceof/symbol-hasinstance-get-err.js
+ language/expressions/instanceof/symbol-hasinstance-invocation.js
+ language/expressions/instanceof/symbol-hasinstance-to-boolean.js
```

**The triage's before-state is stale by 3 rows — measure your own.** The
2026-09-21 triage entry above records `0 / 103 / 11`; on `main` @ `6190e961`
the same manifest, same engine, same runner reads `3 / 100 / 11`. Three rows
were fixed by other lanes' landed work between the two runs. Nothing was wrong
with the triage; the manifest simply is not a constant.

#### What landed, and the one design decision worth reading

Three edits, `noJsHost`-only, ~215 lines of which most is comment:

1. **`native-dynamic-instanceof.ts` — a new wrapper native
   `__instanceof_operator(value, target) -> i32`.** It performs §13.10.2
   InstanceofOperator steps 2-4 (`GetMethod(C, @@hasInstance)`, then
   `ToBoolean(Call(handler, C, «O»))` through the existing `__apply_closure`
   bridge with a one-element `__objvec`) and otherwise delegates, unchanged, to
   `__instanceof_dynamic`. Same 0/1/2 tri-state, so the caller's
   `emitInstanceofThrowGuard` is untouched.
2. **`native-ordinary-instanceof.ts` — `moduleInstallsCallableHasInstance` is
   exported and widened** to count `Object.defineProperty(X,
   Symbol.hasInstance, <desc>)` / `Reflect.defineProperty(…)`.
3. **`expressions/identifiers.ts` — the #2998 primitive-LHS fold declines**
   when that predicate is true.

**The decision: the handler dispatch is a WRAPPER, not an arm inside
`__instanceof_dynamic`.** The round-2 dispatch table called I2 "a lowering
change in one function"; putting it in that one function would have been a
correctness bug. `__instanceof_dynamic` IS §7.3.20 OrdinaryHasInstance, and
`function-proto-has-instance.ts` calls it directly as the body of
`%Function.prototype%[@@hasInstance]`. OrdinaryHasInstance never consults
`@@hasInstance` — an arm inside the helper would make
`Function.prototype[Symbol.hasInstance].call(F, x)` re-enter `F`'s own handler,
which no step of the spec does. One level up is the only place the dispatch is
correct.

Two measurements that set the other two edits, recorded so they are not
re-derived:

- `symbol-hasinstance-get-err.js` failed with **"Expected a Test262Error but
  got a TypeError"** — i.e. `tryEmitNonCallableRhsThrow` fired. The gate's
  syntactic scan matched `F[Symbol.hasInstance] = …` and
  `{ [Symbol.hasInstance]: … }` but not the `Object.defineProperty` accessor
  spelling, so the step-5 throw beat the step-2 read. That is edit 2.
- `symbol-hasinstance-invocation.js` failed with **`callCount === 0`** — the
  handler was never called, because the primitive-LHS fold answered `false`
  first. That is edit 3, and it is why the change could not be confined to
  `native-*-instanceof.ts`.

The wrapper is built **only for a source file that installs a possibly-callable
`@@hasInstance`**, so `__apply_closure` and the argument-vector runtime stay out
of every other standalone binary. Documented residual: in a multi-file
compilation where the first dynamic `instanceof` site is in a file without an
installation and a later site is in one with it, the wrapper is minted once,
from the first site, and the later site keeps the ordinary helper — a missed
conversion, never a wrong answer.

#### Controls — both targets, per-row, zero pass→non-pass

Control manifest: every `language/expressions/instanceof/**` row plus every
`built-ins/{Symbol/hasInstance,Function/prototype/Symbol.hasInstance}/**` row
plus every file in the corpus that mentions `Symbol.hasInstance` at all
(`grep -rl`, minus `intl402/`) — **85 rows**, i.e. the whole blast radius of
both the widened gate and the declined fold. `.tmp/6651/I2-control.txt`.

| control | before | after | row diff |
| --- | --- | --- | --- |
| standalone (`I2-control-standalone-{before,after}.log`) | 66 pass / 12 fail / 3 CE / 4 skip | **69** pass / 9 fail / 3 CE / 4 skip | +3 gained, **0 lost**, 0 other changes |
| host, default target (`I2-control-host-{before,after}.log`) | 59 pass / 22 fail / 4 skip | 59 pass / 22 fail / 4 skip | **0 changes of any kind** |

The +3 in the standalone control are the same three manifest rows; nothing
outside them moved. The host lane is unchanged row-for-row, as the `noJsHost`
gating predicts.

Gates, run bare and chained before the commit: loc ✓ (after the grant below),
func ✓, coercion ✓ (after the grant below), oracle-ratchet ✓ (+0 raw checker
calls), dead-exports ✓, lint ✓, prettier ✓, `check:compiler-boundaries:inventory`
✓, `node scripts/equivalence-gate.mjs` → **22 failing / 1720 passing, all 22 in
the committed baseline, "No new equivalence regressions"**. Two allowances are
in this file's frontmatter, dated 2026-09-23: `loc-budget-allow`
`expressions/identifiers.ts` (+12, 7 of them comment — the decline has to be
readable at the fold it reverses) and `coercion-sites-allow`
`native-dynamic-instanceof.ts` (`__is_truthy` +1 — literally §13.10.2 step
4.a's `ToBoolean`).

#### Residuals — all 114 rows, re-bucketed on THIS base

`.tmp/6651/I2-after.log` is the authority. 108 rows still non-pass. The
triage's bucket table above still holds shape-for-shape; what changed is the
count and three specifics worth recording:

| bucket | rows left | note vs. the triage |
| --- | ---: | --- |
| `with` + `@@unscopables` | 15 | unchanged, still XL (a dynamic `with` environment record) |
| singletons | ~13 | unchanged in kind |
| `module-code/namespace/internals` | 12 | unchanged — I3, still wants a spec, see below |
| direct `eval` (spread / caller scope / class-in-eval) | 10 | unchanged |
| parameter defaults / destructuring params | 9 | unchanged |
| global-object declaration descriptors | 7 | unchanged |
| arrow `this` / `new.target` / `super` | 7 | unchanged |
| tagged template | 7 | unchanged |
| cross-realm | 6 | **wont-fix, reason below** |
| `instanceof` | **3** | was 6. The `@@hasInstance` half is CLOSED by this slice; the `Function.prototype.prototype` half is re-root-caused below |
| `arguments` object | 5 | unchanged |
| `module-code` generator exports | 5 | still `env::g` — **still cluster A's, not I's** |
| annexB | 4 | unchanged |
| TDZ in closures / block scope | 4 | unchanged |
| proper tail calls | 3 | unchanged |

**Re-root-caused: the other three `instanceof` rows
(`primitive-prototype-with-object`, `prototype-getter-with-object{,-throws}`).**
All three are `[] instanceof Function.prototype`. They do NOT fail on the
prototype walk — they fail because `__typeof_function` does not classify the
canonical `Function.prototype` carrier as callable, so `__instanceof_dynamic`
takes its documented "NOT CALLABLE ⇒ conservative false" tail and returns `0`
without ever performing `Get(C, "prototype")`. The getter therefore runs zero
times and no TypeError is raised. Closing them needs **two** things, and the
second is the expensive one: (a) an exact-identity probe for the
`Function.prototype` `$NativeProto` carrier in that tail, in the same
reserve-then-fill shape as `__instanceof_object_prototype`; and (b)
`__extern_get` on a `$NativeProto` carrier having to INVOKE an accessor
installed by `Object.defineProperty(Function.prototype, "prototype", {get})` —
the same "the expando table stores values, not attributes" limitation the
slice-E2 handoff records for TypedArray carriers. Without (b), (a) alone turns
a silent `false` into a silent `false` plus a wasted probe. **Deliberately not
attempted here:** widening `__typeof_function` instead would be corpus-wide,
and a wrong `true` on that classifier is observable everywhere.

#### `$262.createRealm` — the wont-fix, with the spec-level reason

Six rows, all of them calling `$262.createRealm()`:

```
built-ins/ThrowTypeError/distinct-cross-realm.js
language/eval-code/indirect/realm.js
language/expressions/call/eval-realm-indirect.js
language/expressions/tagged-template/cache-realm.js
language/types/reference/get-value-prop-base-primitive-realm.js
language/types/reference/put-value-prop-base-primitive-realm.js
```

They are **not** an `instanceof`/eval/tagged-template gap that happens to use a
realm; the realm IS the assertion. `distinct-cross-realm` asserts
`%ThrowTypeError%` is a *different function object* in the second realm;
`cache-realm` asserts the template-object cache is per-realm;
`get-value-prop-base-primitive-realm` asserts a primitive's wrapper resolves
against the *other* realm's `Number.prototype`. Each test's subject is the
existence of two realms.

The spec-level reason a no-host standalone target cannot honour them:

1. **`$262.createRealm` is a HOST hook, not an ECMAScript feature.** test262's
   INTERPRETING.md defines it as "a new ECMAScript Realm ... created by the
   host"; §9.6 InitializeHostDefinedRealm is host-defined by construction. A
   standalone binary has, by definition, no host to define it.
2. **A standalone module instance IS exactly one realm, materialised at compile
   time.** The intrinsics are WasmGC structs and module globals minted by
   codegen and instantiated once per module instance. There is no runtime
   operation that mints a second set — creating one would mean instantiating a
   second module, which needs an embedder.
3. **Even given a second instance, the two realms could not exchange object
   references usefully.** Each instance has its own rec-group type identities,
   so a value from instance B does not satisfy any `ref.test` in instance A;
   every brand check, every `__typeof_*` classifier and the whole prototype
   substrate would answer "foreign". The cross-realm *identity* assertions
   these six rows make are precisely the ones that depend on those checks.

So the honest verdict is **wont-fix for `--target standalone`**, not "not yet".
The JS-host lane keeps whatever `$262.createRealm` support the runner gives it;
nothing here changes that. Filed as
[#6657](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6657-standalone-262-createrealm-wontfix)
(`status: wont-fix`) on 2026-09-23, which converts 6 of cluster I's 108
residual rows into documented done under this issue's definition of done.

#### Logs and artefacts

All under `.tmp/6651/` in the worktree (gitignored, not committed):
`I2-before.log`, `I2-after.log`, `I2-control.txt`,
`I2-control-standalone-{before,after}.log`,
`I2-control-host-{before,after}.log`, `rowdiff.mjs` (the per-row set-diff
tool), `gate-*.txt` (one file per gate, run bare — never piped), and
`.tmp/base/` copies of all three edited files taken at the first edit.

## Handoff — 2026-09-22, the project-thread lane (PR #6026) signs off

This section closes out the **second** lane that worked #6651 on 2026-09-21 —
the one that ran from the project thread and shipped PR
[#6026](https://github.com/loopdive/js2/pull/6026). The `claude/es2015-test262-plan-54tooh`
lane continued past it and owns the round-3 dispatch; nothing here competes with
that. What this section adds is the part of #6026 that is *not* recoverable from
the diff: which residuals were measured and left open, and what the two-lane
overlap cost.

### What this lane shipped, and what survived the twin resolution

Three slices, each measured on its own base with the isolated standalone runner
and a per-row set diff: **A2-gates +28**, **C3 +9 in C / +2 in G**, **E2 +7 in
manifest / +3 beyond**. Total **+49, zero lost on either target**. All four
manifests were re-measured on the integrated branch before the PR opened
(90 / 24 / 20 / 25 pass), matching each slice's own after-state; the one verdict
difference was A2 deliberately turning
`language/expressions/object/method-definition/name-prop-name-yield-expr.js`
from a silent wrong answer into a loud refusal.

Per the merge note below, the `54tooh` lane then resolved the twins. Current
state on `main`:

| this lane's module | outcome |
| --- | --- |
| `src/codegen/js-default-param-type-guess.ts` | **kept** — it is now the single slot-widening mechanism; the twin in `checker/type-mapper.ts` was deleted |
| `src/codegen/ta-static-from-of-spec.ts` | **kept** |
| `src/codegen/ta-dyn-own-property-names.ts` | **removed** in favour of `ta-dyn-own-keys.ts` (five arms vs. one; two arms cannot both hold body[0] of the same native) |
| `generators-native.ts` A2 gates | **kept**, complementary to the other lane's `for-of` step terminator |

### Measurements worth not repeating

- **A host-lane probe is the cheapest triage in this plan, and it overturned the
  round-2 dispatch order.** All 127 cluster-A residual rows probed on the host:
  **39 pass / 88 fail**. The 90-row family the round-2 table ranked first passes
  **5 of 78** on the host — so it cannot be reached from standalone lowering at
  all — while the binding-element-default bucket passed **24 of 24**, a pure
  standalone-only gap. That is why this lane took the gate family instead. Run
  the probe before ranking anything.
- **Two gate rationales in `generators-native.ts` had gone stale**, each keeping
  rows bailed on a defect that no longer reproduced. The blanket
  `ts.isFunctionExpression` arm was one; its 16 rows were free. Re-measure a
  written-down "this cannot work because X" before treating it as a constraint.
- **Two bounded experiments returned NEGATIVE and are recorded so they are not
  retried:** lifting the computed-name gate (`:3162`) gains **0** — the emit
  sites in `literals.ts` / `class-bodies.ts` never route a computed-name
  generator method to the native factory, so the gate is the *second* blocker;
  lifting `bodyReferencesOwnName` (`:2525`) turns 9 loud compile errors into
  **9 wrong answers**, because the immutable self-name binding does not exist
  yet.
- **A manifest-scoped slice cannot see an accidental pass.** C3's 794-row corpus
  control found two latent defects that were *passing for the wrong reason* and
  went red the moment the parameter type changed: `compileIIFE` padded a missing
  argument with `ref.null.extern` instead of `undefined` (§9.2.12), and B.3.3.1
  step 1.a.ii's "parameterNames does not contain F" guard was missing from step
  3 — eight annexB rows had been green only because a function object could not
  physically fit in the f64 slot it was wrongly written to. Both fixed in the
  same commit. Any future slice that moves a parameter or variable slot needs
  the same control, on **both** targets: standalone showed 9 losses the host
  lane did not.
- **The round-2 table's "≥18 rows in C" conflated two families.** Eleven belong
  to C3; the rest are a separate materialization defect, isolated to:
  ```js
  function g({ w: [x,y,z] } = { w: [7, undefined, ] }) {}  g();   // z === null, §13.3.3.7 says undefined
  ```
  Only the parameter-default *materialization* path is wrong — the same pattern
  as a variable declaration, as a plain parameter, and with an element-level
  default all answer correctly. (The `54tooh` lane's C3b may already have taken
  this; check before starting.)

### Environment facts, additive to the round-1 list

- **An `error` row is "not measured", never a verdict.** The runner's 135 s
  child budget is a *serial* number: sharding an `--isolate` run 6 ways produced
  40 `spawnSync ETIMEDOUT` rows, which scored naively as 5 pass→non-pass and 35
  verdict changes — every one an artefact. Re-run with
  `JS2WASM_ROW_TIMEOUT_MS=420000` rather than scoring them.
- **Freeze `src/` for the whole duration of a measurement.** The `--isolate`
  runner re-imports the compiler per row, so a sweep overlapping an edit
  measures two compilers and reads as one. One lane discarded five sweeps to
  this before measuring the before-state from a `git archive HEAD` extract
  instead.
- **Probe through `testWithTypedArrayConstructors`, never a locally-bound
  constructor.** `var TA = [Float64Array][0]` is typed `Float64ArrayConstructor`
  by TypeScript, so `new TA(…)` takes the static path and yields a plain vec —
  against which a dyn-view arm reads as a total no-op. Cost one lane an hour and
  a nearly-deleted correct change.
- **Budget measurement time by load, not by row count.** On a 4-core box with
  three lanes sweeping, a 177-row isolate sweep took 45 minutes instead of 8.
- The QuickJS eval provider builds from cold in ~45 s
  (`node --import tsx scripts/build-quickjs-eval-provider.mjs`), and a fresh
  container needs `pnpm install` plus
  `git submodule update --init --depth 1 test262` before any of this works.

### Newly actionable residuals this lane root-caused

| rows | finding | what it needs |
| ---: | --- | --- |
| 2 (+ `slice` twin) | `internals/OwnPropertyKeys/integer-indexes*.js` die on `new TA(4).subarray(2)` answering **null** | `shouldWrapDynViewSpeciesTwoArm` requires `ts.isIdentifier(propAccess.expression)`, so a method called on a `new` expression never enters the dyn-view species arm; the fix needs a non-identifier receiver without double-evaluating it (the ELSE arm re-compiles the whole `callExpr`) |
| 2 | `ctors/object-arg/iterator-*` | the `$Object` arm in `emitTaDynCtorConstructFromLocals` already implements §23.2.5.1 step 6 correctly but is gated on `ref.test $Object`, which the tests' `var obj = function () {}` fails; widen with `__typeof_function` |
| 6 | computed-name generator methods | the **emit sites**, not the gate (see the negative experiment above) |
| 5 | DataView `sample.byteLength` reads back the getter **closure** instead of invoking it | out of scope for E2; worth its own task |
| 6 | `'yield' is a reserved word` | `function yield() {}` in a sloppy script, compile_error on **both** targets — a TypeScript parse-strictness question with corpus-wide blast radius, not a generator gap |

Also noted while reading: `array-object-proto.ts` carries a comment claiming the
refusal closure "is also the correct answer for a bare `TypedArray.from([])`".
`IsConstructor(%TypedArray%)` is true; the TypeError belongs at TypedArrayCreate,
after the drain. Left for whoever next touches that file.

### The concurrency lesson, stated once

Two lanes worked this issue on the same day without knowing about each other,
and produced twins of A2, C3 and E2 in the same files. The twins were resolved
correctly but at real cost: three slices were implemented twice, and the
resolution itself needed a careful read of both. The merge note below already
says to run `git log origin/main --grep=6651` and diff the files you intend to
touch before starting a slice. The stronger form: **this plan's cluster table is
the lock, and it only works if one owner holds a cluster at a time.** Before
dispatching, check whether another session is live on #6651 — the claim ref and
the open-PR scan do not see a lane that has started but not yet pushed.

### Lane partition — 2026-09-22 (accepted)

Two sessions work #6651 concurrently. To stop the twin duplication of
2026-09-21 (A2/C3/E2 landed twice, reconciled in PR #6027), clusters are now
partitioned by lane:

| lane | clusters |
| --- | --- |
| project-thread lane (shipped PR #6026, #6029) | **F** Proxy/Reflect, **H** builtins misc, **I** language misc |
| this lane (shipped #6023/#6024/#6027/#6028) | **B**, **C**, **D**, **E** (E4 in flight), **G** |
| cluster **A** | neither lane until explicitly claimed here first |

Both lanes `git merge origin/main` before opening a slice and record slices
under `## Cluster status`. This lane has not opened F, H or I since round 1;
the partition stands as proposed.

## Manifest generator note

Partition rule applied to the 1,320 non-pass rows, first match wins:
A = `status == compile_error` and error mentions generator/`__gen_`/yield;
D = path or error mentions Promise; B = `built-ins/RegExp`, `annexB/built-ins/RegExp`,
`String.prototype.{match,search,split,replace}`; E = `TypedArray*`,
`ArrayBuffer`, `DataView`; F = `Proxy`, `Reflect`; C = `statements/class`,
`expressions/class`, `expressions/super`, `new.target`, `expressions/object`,
computed-property-names; G = `for-of`, `expressions/assignment`, `for/`,
generators (runtime), `GeneratorPrototype`, `GeneratorFunction`, `Iterator`,
`ArrayIteratorPrototype`; H = remaining `built-ins/*`; I = the rest.
Manifest SHA-256s are in the commit that added them.
