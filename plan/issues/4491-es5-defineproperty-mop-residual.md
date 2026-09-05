---
id: 4491
title: "ES5 standalone: Object.defineProperty/defineProperties/create residual (90 tests) — descriptor MOP semantics on the dynamic object runtime"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-25
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 3031, 4490, 4504]
func-budget-allow:
  # Ordinary-function `prototype` reflection adds one identity-gated descriptor
  # arm plus its local to the shared descriptor-helper orchestrator. The arm's
  # implementation is extracted into closurePrototypeDescriptorArm; these 19
  # lines are the remaining registration/wiring at the owning function.
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
# 2026-08-25 standalone Array constructor pair: the dynamic computed-key
# dispatch for S15.4_A1.1_T9 and the sparse companion write/read for
# S15.4_A1.1_T10 are the remaining value-representation slice described in
# this issue's sparse-tail residual. The dispatch must stay beside the native
# locals it splices, so the existing allowances below apply to this pair.
loc-budget-allow:
  # 2026-08-24 wave-7 (Object.prototype.toString): the syntactic `.call(v)` form
  # is owned by the #2501 compile-time fold, whose standalone ladder ended in a
  # `[object Object]` FALLBACK rather than a classification — 11 of 16 receivers
  # answered wrongly by a baked constant. Making the #4119 runtime classifier
  # reachable from that spelling means composing runtime-answer-first with the
  # fold constant as fallback, and the compose has to happen AT the fold site.
  # The classifier itself went to a NEW subsystem module
  # (src/codegen/object-proto-tostring-native.ts, +156); this residual is the
  # dispatch wiring that cannot leave the call driver.
  - src/codegen/expressions/calls.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/object-ops.ts
  # 2026-08-19 mirror/vec descriptor slice: a compiled array crosses the
  # externref boundary as a DETACHED __make_iterable mirror while
  # Object.defineProperty gets the RAW vec, so every recorded attribute was
  # invisible to reflective reads. The bulk went to two NEW subsystem modules
  # (src/runtime/vec-descriptor-mirror.ts, src/runtime/builtin-proto-expando.ts)
  # — +284 -> +134; the residual is call-site wiring that must live in the
  # runtime barrel at the host-import boundary.
  - src/runtime.ts
  # 2026-08-20 honest-carrier slice: emitRuntimeDescriptorGet keeps externref
  # in standalone (accessor results are runtime state; narrowing to the
  # checker's f64 turned a get:undefined redefine's canonical undefined into
  # NaN — 15.2.3.6-4-498/516/534/552 measured fail→pass).
  - src/codegen/property-access.ts
  # 2026-08-21 void-undefined slice: typeof unsound-fold guard for runtime
  # accessor keys (typeof-delete.ts), void-typed binding slot widening
  # (declarations.ts moduleGlobalWasmType arm).
  - src/codegen/typeof-delete.ts
  # 2026-08-25 optional-host guard slice: a DOM use dominated by
  # `typeof document !== "undefined"` must not request the standalone DOM
  # capability, because the guard is false in a host-free realm.
  - src/ir/dom-capability.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/declarations.ts
  # 2026-08-21 defineProperties/create edge slice (buckets Q + R): the
  # `Object.prototype.isPrototypeOf` reflective body is dispatched from
  # `makeGlue`'s Object arm (array-object-proto.ts, +6) and the `for…in`
  # [[Enumerable]] gate joins the existing #4222 presence gate
  # (statements/loops.ts, +26). Both bodies live in NEW modules
  # (object-proto-is-prototype-of.ts, vec-index-enumerable.ts); only the
  # dispatch/wiring is in the big files.
  - src/codegen/array-object-proto.ts
  - src/codegen/statements/loops.ts
  # 2026-08-21 wave-3 lane C, arguments [[ParameterMap]] slice: a lifted
  # function EXPRESSION built the same arguments vec as a declaration but never
  # installed `mappedArgsInfo`, so §10.2.11 step 22.a's mapped/unmapped split
  # depended on how the function was SPELLED. The install goes in the existing
  # `needsImplicitArgumentsObject` block of `compileLiftedClosureBody`; the
  # `mappedArgsInfo` shape itself gains one optional Set field.
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  # 2026-08-21 wave-3 lane C, §10.1.6.3 step 4.c guard: the accessor→data
  # refusal in `__defineProperty_value`'s ValidateAndApply preflight gains its
  # missing IsGenericDescriptor precondition. One nested `if` around the
  # existing throw; no new natives, no local-vector change.
  - src/codegen/object-runtime-descriptors.ts
  # 2026-08-21 wave-3 lane A (types/object + types/reference rows): the two
  # "the closed struct cannot serve this write" arms of `compileMemberIncDec`
  # now share ONE externref read-modify-write emitter, hoisted to module scope
  # (`emitMemberIncDecExternrefFallback`) rather than inlined twice. The file
  # grows by the hoisted helper; the driver function grows by the second call.
  - src/codegen/expressions/unary-updates.ts
  # 2026-08-21 (wave-4 lane E, #3966 slice): +17 / +11 lines of pure DISPATCH
  # wiring — three `if (isSloppyImplicitGlobalBinding(...))` guards in the
  # update path and one predicate disjunction plus one negation in the call
  # path. Every new BODY lives in the new module
  # src/codegen/expressions/implicit-global-binding.ts; these two files gain
  # only the branch that reaches it. (unary-updates.ts already granted above
  # by wave-3 lane A; this extends the same file's grant.)
  - src/codegen/expressions/call-identifier.ts
  # 2026-08-21 wave-4 lane G, Math-as-a-VALUE slice (+5): `Math.sin` passed as a
  # first-class value reified a closure whose body THREW even though the
  # `Math_sin` f64 kernel already existed and the direct-CALL path used it.
  # Both phases that decide this keyed on the CALL form only. The body AND the
  # collector predicate both live in a NEW module
  # (src/codegen/math-static-value-body.ts); the collector retains only the
  # 5-line dispatch, which has to be in the walker to see the node at all.
  - src/codegen/declarations/import-collector.ts
  # 2026-08-21 wave-4 lane G (+13 at integration base): the dispatch arm for
  # the Math value body in `ensureStandaloneBuiltinStaticMethodClosure` — see
  # the func-budget entry; the body lives in math-static-value-body.ts.
  - src/codegen/builtin-value-read.ts
  # 2026-08-21 wave-4 lane J, slice J2 (+5): `Array.prototype.join`'s #3224
  # beyond-the-backing arm rendered EVERY hole as "", but a hole INHERITS
  # `Array.prototype[k]` and the read path already sees it — `x[1]` answered 1
  # while `x.join()` answered "0,". The whole fallback body (gate, native
  # registration, scratch local, the [[Get]] + ToString arm) lives in the NEW
  # module src/codegen/array-join-proto-hole.ts; `compileArrayJoinNative` gains
  # one import line, one arming call and the `else:` swap. The arming call has
  # to be in this function — it must run BEFORE the existing `externToStrIdx`
  # capture or that index shifts underneath it (#2043).
  - src/codegen/array-methods.ts
  # 2026-08-21 wave-4 lane H, synthetic-`arguments`-rest slice (+5): TWO
  # two-line parameter-resolution swaps in `compileTailDispatch`'s
  # CallExpression-callee and generic-callee arms — `sig.parameters` →
  # `runtimeSignatureParameters(sig)`, the helper that ALREADY exists in
  # calls-closures.ts for exactly this (it was private; this slice exports it).
  # There is no new body to move out: the change is which symbol list the two
  # existing loops read. Both arms sit at fixed points in one long ordered
  # dispatch chain and cannot be hoisted without reordering it.
  - src/codegen/expressions/call-tail-dispatch.ts
  # 2026-08-22 gate-visibility re-grant for PR #4768 (same stranded-grant
  # class as #4723's b456e62394, which merged to main and then dropped out of
  # this branch's frontmatter in the post-merge sync): growth originally
  # granted in 2071/4206/2175 frontmatter whose doc edits are already on main,
  # plus proto-index-store.ts (+60, the T10 constructor-fallthrough gate whose
  # body is keyIsNotConstructorInstrs — dispatch and guard in the same module
  # that owns the walk).
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/proto-index-store.ts
  - src/codegen/binary-ops.ts
  - src/codegen/index.ts
  - src/codegen/expressions/assignment.ts
  # 2026-08-22, PR #4768 wave-6 dispatch wiring (under-ceiling at each lane's
  # own base, over main's refreshed ceilings at PR scope): literals.ts +17
  # (T11 elision marker at the literal site), expressions/identifiers.ts +13
  # (T3 instanceof RHS + assigned-alias dispatch), statements/variables.ts +6
  # (T12 redeclared-binding dispatch). All bodies live in the new modules.
  - src/codegen/literals.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/variables.ts
  # 2026-08-22, PR #4768 (wave-6 T11 presence half): +35 in object-runtime.ts
  # — the per-carrier hole test in __extern_has_idx's vec arm and the presence
  # chokepoint wiring that `in`/Object.keys/for-in route through. The bodies
  # live in vec-f64-hole-presence.ts; this is the arm/dispatch share that must
  # sit inside the runtime builder because it references the result-vector
  # locals of the natives it splices into (same constraint as the #4491 lane B
  # entry above). Surfaced only after #4723's post-merge baseline refresh
  # reset the ceiling.
  - src/codegen/object-runtime.ts
  # 2026-08-23 wave-4 census slice. Four narrow arms, each in the ONE module
  # that owns the decision it corrects — none of them has a body that can be
  # moved out, because each is a guard/withdrawal inside an existing ordered
  # chain:
  #  - declarations/param-return-inference.ts (+~35): a fifth WITHDRAWAL rule
  #    alongside #3548/#4555/#4530/#2867-S2, in the same `if (type !== null …)`
  #    ladder at the end of `inferParamTypeFromCallSites`. The rule IS the
  #    dispatch; there is no body.
  #  - builtin-ctor-own-props.ts (+~12): one entry (plus its cost rationale) in
  #    the existing `CTOR_STATIC_METHODS` table.
  #  - vec-overlay.ts (+~110): the integrity-bag consult for a vec's IMPLICIT
  #    element descriptor and the frozen-own-index write guard. Both splice
  #    into `__vec_gopd` / `__extern_set`'s prologue and reference those
  #    functions' own local vectors, so they cannot live anywhere else (the
  #    same constraint as the #4491 lane B entry above).
  #  - declarations.ts: extends the existing 2026-08-21 void-undefined grant
  #    with the `= undefined` IDENTIFIER arm next to the void-call arm.
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/builtin-ctor-own-props.ts
  # 2026-08-23 T4 parity slice (S11.6.1_A2.2_T3): +63 in add-to-primitive.ts
  # (the replacement guard `identifierIsTheCapturedFunction` plus the record of
  # why the old one always fired) and +50 in addition-to-primitive.ts (the
  # `emitOperand` closure inside `emitObjectAdd` that consults the shared
  # helper). Neither body can move: the guard IS the predicate the exported
  # helper applies, and `emitOperand` must sit between the two operand
  # compilations it replaces, because §13.15.3's left-then-right evaluation
  # order is what it preserves. Most of both diffs is the rationale comment —
  # in particular the measured record that repairing the guard ALONE moved 0
  # of 128 rows, which is the trap the next lane would otherwise re-derive.
  - src/codegen/add-to-primitive.ts
  - src/codegen/addition-to-primitive.ts
oracle-ratchet-allow:
  # 2026-08-21: one getTypeAtLocation in varBindingNeedsExternrefForUndefined's
  # new call arm — the same raw-checker idiom as the surrounding predicate;
  # the query is a TypeFlags test (void/undefined purity) the oracle does not
  # express.
  - src/codegen/index.ts
  # 2026-08-21 (regression fix): the module-global consult was narrowed to an
  # INLINE void-call check in moduleGlobalWasmType (the full predicate's
  # void-0/#4206 arms regressed the filter harness family) — same TypeFlags
  # purity query, same rationale.
  - src/codegen/declarations.ts
coercion-sites-allow:
  # 2026-08-22 wave-6 lane T11: NOT a fresh ToString matrix. The f64
  # absence-marker arm in `__extern_has_idx` must look the index up in the
  # #3251 companion (an own accessor recorded there means the index is PRESENT
  # even though the slot still holds the marker), and a companion is keyed by
  # the DECIMAL INDEX STRING. `number_toString` is the sealed index-key
  # formatter every other companion consult uses — `vec-overlay-presence.ts`,
  # `fillDynamicForinVecArms`, `vec-overlay.ts` all call exactly this one. Using
  # anything else would be the hand-rolled matrix the gate exists to prevent.
  - src/codegen/vec-f64-hole-presence.ts
  # 2026-08-21 wave-3 lane C: NOT new coercion vocabulary — the missing half of
  # an existing pair. `compileLiftedClosureBody` already ensures `__box_number`
  # two lines above (param → arguments slot); the mapped REVERSE sync
  # (`emitMappedArgReverseSync`, logical-ops.ts) unboxes back into an f64/i32
  # parameter and silently degrades to a wrong value when `__unbox_number` is
  # absent. `compileFunctionBody` has ensured both since #849; the lifted
  # closure path ensured only one because it never installed `mappedArgsInfo`.
  - src/codegen/closures.ts
  # 2026-08-21 wave-3 lane B: ONE `number_toString` in the new
  # `__strexo_push_keys` native. It is not a hand-rolled matrix — it is the
  # SEALED formatter, used for the one thing §10.4.3.6 requires here (the
  # canonical index KEY `ToString(i)`), identically to every other index-key
  # producer in the tree (`__extern_get_idx`'s `$Object` arm, the #3251 overlay
  # companion lookup, `emitArrayForIn`). Hand-rolling a digit loop instead is
  # exactly what this gate exists to prevent, so the reviewed grant is the
  # correct outcome rather than an avoidance.
  - src/codegen/string-exotic-own-props.ts
  # 2026-08-21 wave-4 lane G: NOT new coercion vocabulary — the gate counts
  # `__any_to_f64` as +1 only because the call sits in a new file. The pair
  # `__any_from_extern` → `__any_to_f64` is copied verbatim from the variadic
  # `Math.max`/`Math.min` value body in builtin-value-read.ts, deliberately, so
  # an extracted `Math.sin` coerces its argument exactly like an extracted
  # `Math.max` does. No ToNumber/ToString/ToPrimitive matrix is hand-rolled.
  - src/codegen/math-static-value-body.ts
  # 2026-08-21 wave-4 lane J, slice J2: NOT new coercion vocabulary — the gate
  # counts `__extern_toString` as +2 only because the call moved into a new
  # file. It is the SAME runtime ToString the join fold's boxed-any arm already
  # calls (`buildJoinBoxedElementToString`, array-join-element.ts) and the same
  # one `String(a[i])` uses; the inherited-hole arm has to stringify identically
  # to the backed-element arm or `x.join()` and `x[1] + ""` would disagree about
  # one index. Nothing is hand-rolled — the nullish/undefined test reuses
  # `__extern_is_undefined`, exactly as `joinEmptyElementTest` does.
  - src/codegen/array-join-proto-hole.ts
  # 2026-08-22 wave-5 T6: NOT new coercion vocabulary — the gate counts
  # `__any_to_f64` as +2 only because the calls sit in a new file. The pair
  # `__any_from_extern` → `__any_to_f64` is the SAME engine ToNumber pipeline
  # the variadic `Math.max`/`Math.min` value body in builtin-value-read.ts uses
  # (and that wave-4 lane G already reused for `math-static-value-body.ts`), so
  # a reified `String.fromCharCode` coerces each code-unit argument exactly like
  # a reified `Math.max` coerces each of its. §22.1.2.1 requires
  # ToUint16(ToNumber(arg)); using `__unbox_number` instead would answer NaN for
  # every non-Number argument. The §7.1.8 ToUint16 step that follows is the
  # verbatim f64-domain sequence already emitted by the `.apply` lane in
  # call-builtin-static.ts — no ToString/ToPrimitive/equality matrix is
  # hand-rolled.
  - src/codegen/string-fromcharcode-value-read.ts
func-budget-allow:
  # 2026-08-23 T4 parity slice — `emitObjectAdd` gains the `emitOperand`
  # closure (see the loc entry above for why it cannot be hoisted).
  - src/codegen/addition-to-primitive.ts::emitObjectAdd
  # 2026-08-23 wave-4 census: +38 in `inferParamTypeFromCallSites`, which is a
  # TERMINAL LADDER of soundness withdrawals — #3548 (under-application), #4555
  # (native scalars), #4491 (nullish arg), #4530 (opaque `any`), #2867 S2
  # (escapes-as-value) — each a `if (type !== null && …) type = null;` guard on
  # the SAME local. The wave-4 vec-carrier rule is the sixth. It cannot be
  # hoisted into a helper without passing `type` in and out by reference (the
  # ladder is order-dependent: a later rule must see the earlier ones' result),
  # and splitting the ladder in half would put the withdrawal decisions in two
  # files with no single place to read the rule set. Most of the +38 is the
  # rationale comment the surrounding rules all carry.
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  # 2026-08-22 PR #4768: +4 dispatch in the T12 redeclared-binding arm.
  - src/codegen/statements/variables.ts::compileVariableStatement
  # 2026-08-22 gate-visibility re-grant for PR #4768, same stranded-grant
  # cause as the loc entries above.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/declarations/object-shape-widening.ts::scanStatements#2
  - src/codegen/declarations.ts::compileDeclarations
  # 2026-08-22 wave-5 lane T3, §13.10.1 step-3 `instanceof` RHS evaluation.
  # +6, DISPATCH ONLY — the emitter is one exported call in the new subsystem
  # module instanceof-rhs-evaluation.ts. The two call sites are the function's
  # own conservative fall-through arms (`typeIdxs === undefined` and
  # `instanceofIdx === undefined`); each must sit between the LHS drop and the
  # `i32.const 0` terminal, because that IS the spec's evaluation order, so
  # neither can be lifted out of the arm it guards.
  - src/codegen/expressions/identifiers.ts::compileHostInstanceOf
  # 2026-08-22 wave-5 lane T8, f64-hole VALUE half: `compileElementAssignment`
  # gains ONE `else if (arrDef.element.kind === "f64")` arm (+14) that calls
  # `emitF64GapFillInstrs`. The whole body — the sNaN marker, the locals, the
  # guarded `array.fill` — lives in the NEW module
  # src/codegen/vec-f64-hole-gap.ts; this function keeps only the branch, which
  # has to be here because it is the sibling of the externref gap-fill arm it
  # mirrors (#2773 S7) and shares its already-allocated vec/data/idx locals.
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  # 2026-08-22 wave-6 lane T11, f64-hole PRESENCE half. Every new BODY lives in
  # the NEW module src/codegen/vec-f64-hole-presence.ts (the marker test, the
  # read-boundary canonicalization, the per-carrier `__extern_has_idx` arms);
  # the eight functions below gain only the branch that reaches it, and each
  # branch has to be where it is:
  #   compileArrayLiteral (+13)          — the elision arm is the only place
  #     that knows an element is an OmittedExpression rather than an explicit
  #     `undefined`; that distinction IS the slice.
  #   _emitVecAccessExportsInner (+13)   — `__vec_get`'s f64 arm already tests
  #     UNDEF_F64_BITS (#3315); it now tests both payloads, in place, sharing
  #     the scratch local the existing arm allocates.
  #   compileInOperator (+5)             — the typed-vec `in` route hands off to
  #     `__extern_has_idx` exactly where the #4222 overlay route already does.
  #   ensureNativeArrayHof (+5)          — one disjunct on the existing
  #     `hasGateIdx` condition, next to `protoIndexDirty`/`forceHasProperty`.
  #   fillDynamicForinVecArms (+5)       — one disjunct on `gateKeysOnPresence`,
  #     plus the f64 marker map inside the `__extern_get_idx` box arm it builds.
  #   compileElementAccessBody (+4)      — the two bounds-eliminated read arms,
  #     siblings of the `emitHoleToUndefined` calls they sit beside.
  #   compileArrayDestructuringAssignment (+2) / compileForOfArray (+1) — one
  #     canonicalization call each, same read boundary.
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/hof-native.ts::ensureNativeArrayHof
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/expressions/assignment.ts::compileArrayDestructuringAssignment
  - src/codegen/statements/loops.ts::compileForOfArray
  # 2026-08-21 defineProperties/create edge slice: the `Properties`-map entry
  # model gains a PASS-THROUGH arm (a map entry that is not an object literal)
  # plus the reified-map construction. Already 724 LOC at base — the growth is
  # in the existing `stableDescriptorMapEntries` IIFE, which cannot be split out
  # without also moving the stability visitor it closes over.
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  # 2026-08-21 wave-3 lane C, arguments [[ParameterMap]] slice.
  # `compileLiftedClosureBody` grows by the mapped-arguments install (+32).
  # `compileObjectDefinePropertyCore` is NOT growth: `compileObjectDefineProperty`
  # was split into an 8-line wrapper (which emits §10.4.4.2 step 5.b.i after the
  # define) plus the unchanged body under the new name, so the baseline's entry
  # moved rather than grew. The post-merge baseline refresh absorbs the rename.
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/object-ops.ts::compileObjectDefinePropertyCore
  # 2026-08-21 wave-3 lane B, §10.4.3 String-exotic own KEYS: two one-call
  # prologue splices (`__object_keys` + `__object_keys_forin`), +7 lines total.
  # They MUST live inside this builder — each one references the result-vector
  # LOCAL INDEX of the native it is spliced into, so it cannot be lifted out
  # without also lifting the two native bodies. The prologue's whole
  # implementation is already in a separate module
  # (src/codegen/string-exotic-own-props.ts, +184); this is call-site wiring.
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  # 2026-08-21 wave-3 lane A: `compileMemberIncDec` gains one call to the
  # hoisted externref RMW emitter (its body SHRANK by the de-duplicated
  # emitter); `compileTypeofComparison` gains the 4-line
  # `readPrecedesVarInitializer` unsound-fold guard — a `var x` read that is
  # textually before its own initializer must not fold the checker's
  # initializer-derived type. Both are guard clauses in long dispatch chains
  # whose arms cannot be reordered without changing precedence.
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  # 2026-08-25 #4491 inherited-descriptor slice: the standalone typeof fold
  # gains a receiver/key runtime-descriptor guard. It stays in this ordered
  # ladder so the guard runs after TDZ/eval/accessor checks but before the
  # checker-derived static result; moving it to a helper would obscure that
  # precedence and duplicate the transparent-operand handling.
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  # 2026-08-21 wave-3 lane A, realm-global member CALL/READ: two guard clauses
  # that must sit at a specific point in a long ordered dispatch chain — the
  # call one BEFORE `compileReceiverMethodCall` (which resolves the member
  # against the `typeof globalThis` struct and throws on the miss), the element
  # one BEFORE the JSON/linear/Math arms. Both bodies live in their own
  # modules (realm-global-member-call.ts, and the existing #4500 Slice A helper
  # in property-access.ts); only the dispatch point is in the big function.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/property-access.ts::compileElementAccess
  # 2026-08-21 (wave-4 lane E, #3966 slice): +10 each, dispatch-only.
  # `compilePrefixUpdate` gains one 4-line guard per operator (`++`/`--`);
  # `compileIdentifierCall` gains a predicate binding and one extra
  # disjunct/negation. Splitting either function is a real refactor with its
  # own blast radius and is deliberately NOT bundled into a semantics fix.
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  # 2026-08-21 wave-4 lane G, Math-as-a-VALUE slice. Both growths are DISPATCH
  # ONLY — every line of the new body lives in math-static-value-body.ts:
  #  * ensureStandaloneBuiltinStaticMethodClosure (+12): one `else if` arm that
  #    must sit BEFORE the `genericThrowBody` arm, because that arm claims every
  #    `default:` case (this one included) and behind it the new arm would never
  #    fire.
  #  * unifiedVisitNode (+4): the collector dispatch — a predicate call and a
  #    `mathNeeded.add`. It has to be in the walker to see the node.
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  # Wave-4 lane F slice F3: +3 each — the finalize ladders ARE these two
  # functions, so a new `__extern_set` prologue pass has nowhere else to be
  # called from.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # 2026-08-21 wave-4 lane H. Both are DISPATCH/WIRING only:
  #  * compileTailDispatch (+4): the two `runtimeSignatureParameters(sig)`
  #    swaps described in the loc-budget entry above — no new body, just which
  #    symbol list the two existing param loops read.
  #  * compileDeleteExpression (+2): one call to
  #    `prepareDynamicArgumentsDeleteIndex`. It MUST sit here, between the
  #    `keyLocal` store and the `__delete_property` `ensureLateImport` — the
  #    helper can pull a late import, and a late import registered after that
  #    funcIdx is captured shifts the already-planned call. The whole body
  #    lives in the existing subsystem module arguments-object-mop.ts.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/typeof-delete.ts::compileDeleteExpression
  # 2026-08-22 wave-5 T4 slice T4-E: `"valueOf" in {}` answered false because
  # standalone's `$Object.$proto` chain ends at null (%Object.prototype% is a
  # `$NativeProto`, the priced representation wall) while the READ resolved it
  # statically. The name set and the receiver-shape predicate both live in the
  # NEW module src/codegen/object-proto-name-in.ts; `compileInOperator` grows
  # by the two-line consult plus the comment that says why the fold is
  # affirmative-only (+10). The consult must sit exactly where `has` is
  # computed — one statement earlier and it would bypass the §13.10.1
  # primitive-RHS TypeError, one later and the `__extern_has` route has already
  # been chosen.
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# #4491 — ES5 defineProperty/defineProperties/create MOP residual

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

ES5 standalone stands at 8,386/9,029 (92.9%), 643 non-passing. The single
largest family is the property-descriptor MOP: `built-ins/Object/
defineProperty` (52) + `defineProperties` (26) + `create` (12) = **90 tests**.

Symptom mix (top): silent no-op defines (`result !== true`, `Expected "a ===
10", actually 0`), accessor descriptors not taking effect (`foo value should
be undefined`), index-keyed defines landing wrong (`Expected obj[0] to equal
0, actually null`), `Object.create(proto, props)` second-arg families, 3
`__module_init` null derefs.

## FALSIFIED HYPOTHESIS (kept visible per lane convention)

The plan below was built by mining error TEXT, not by verifying tests. Its
symptom list and its sub-bucket table did **not** survive contact — see
"Measured triage" after it. Kept so the next reader can see what was tried.

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by MOP operation before coding** (mandatory table in this
   file): (a) data-descriptor writes on dyn objects, (b) ACCESSOR descriptors
   (get/set installation + invocation), (c) attribute enforcement
   (writable:false silently ignored? configurable transitions?), (d)
   index-keyed properties on vec-backed arrays, (e) `Object.create` props-arg,
   (f) the 3 null-deref crashes (fix first — crashes before semantics).
2. The dynamic object runtime (`src/stdlib/object-runtime.ts`,
   `__defineProperty_value` — note #2175's S3b-1 just touched materialization
   ordering vs `__defineProperty_value`, coordinate with the reflection lane's
   in-flight worktree) already has descriptor machinery; expect the residual
   to be missing arms (accessor install on specific carriers, attribute
   checks on define-over-existing) rather than a missing subsystem.
3. Fix largest bounded sub-buckets first; each with unit tests; A/B file-copy
   baselines; zero pass→non-pass on the scoped filter.

## Measured triage (generators lane, 2026-08-15)

**Source**: the shared full standalone baseline
`.test262-cache/test262-standalone-current.jsonl` (mtime 2026-08-15 20:21Z, 1.2 h
old at extraction), filtered to the plan's own scope. A dedicated scoped run was
started and **abandoned** — at the observed ~60 s/test under three-lane load,
2083 files is hours, and the shared baseline covers the identical file set. The
baseline is one other lane's run against integrated main, which is the right
reference for triage (main's state, not my worktree's).

**Scope totals: 2083 files, 1983 pass, 100 non-passing** (99 fail + 1 CE) —
`defineProperty` 59, `defineProperties` 29, `create` 12. Close to the plan's 90;
the delta is snapshot drift, not a different population.

### Step 0 — the plan's symptoms do not reproduce

One minimal standalone program per sub-bucket in the plan's list. **All ten
pass, host-free, zero imports** — including the two named as top symptoms:

| probe                                             | result |
| ------------------------------------------------- | ------ |
| data define; returns obj; value reads back        | pass   |
| accessor `get` installs **and invokes**           | pass   |
| accessor `set` installs **and invokes**           | pass   |
| `writable:false` blocks a later write             | pass (throws TypeError — correct, see below) |
| `enumerable:false` hidden from `for-in`           | pass   |
| `configurable:false` redefine throws              | pass   |
| index-keyed define on an array (`a[0] === 42`)    | pass   |
| `Object.create(proto, props)`                     | pass   |
| `Object.defineProperties` two data props          | pass   |
| `getOwnPropertyDescriptor` round-trip (all 4 attrs) | pass |

`writable:false` first looked like a real hit — a wasm exception. That was the
PROBE's fault: it had no `try`/`catch`, and a compiled module is always strict,
where that write MUST throw. With the catch it is a proper catchable TypeError,
matching Node. Recorded so the false positive is not re-derived.

**Consequently the source comment in `src/codegen/object-runtime.ts` calling
`__defineProperty_accessor` / `__getOwnPropertyDescriptor` "RUNTIME-LAYER
GROUNDWORK … not yet reached end-to-end under standalone" is STALE** — both are
reached and both work. Fix that comment in the first slice that touches the file.

### Step 1 — measured sub-buckets (classified from test SOURCE, not error text)

| bucket                                              | n  | status |
| ---------------------------------------------------- | -: | ------ |
| D array index at/above the 2^32 boundary             | 26 | **reproduced** |
| Q `defineProperties` descriptor-map edges            | 18 | unprobed |
| R `Object.create` edges                              | 13 | unprobed |
| B accessor descriptor round-trip (non-trivial)       | 12 | unprobed |
| H still unclassified                                 | 11 | — |
| P1 define ACCESSOR on a **builtin prototype**        |  7 | **reproduced** |
| E symbol-keyed define                                |  5 | unprobed |
| F crash — `__module_init` null deref                 |  3 | fix first |
| P2 define DATA prop on a **builtin prototype**       |  3 | **reproduced** |
| OUT Proxy / TypedArray-RAB / DOM global              |  4 | out of lane |

**The plan had no category for P1/P2 at all**, and they are the cleanest
reproductions:

- **P1** — `Object.defineProperty(Array.prototype, "prop", {get, set})`, then
  `a.prop` reads correctly but `a.prop = v` **does not run the setter**.
- **P2** — `Object.defineProperty(Date.prototype, "prop", {value})`, then
  `d.prop = 1002` reads back 1002 but `d.hasOwnProperty("prop")` is **false**:
  the assignment never created an own property on the instance.
  These overlap #2175's builtin-prototype territory — coordinate before coding.

- **D is NOT "length/index coupling"**, which works: index define extends
  `length` (index 5 → length 6; index 1000 → length 1001), a `length` shrink
  deletes higher indices, and an ACCESSOR at index `"0"` installs and invokes.
  What fails is the **boundary**: at index `4294967294` the property is created
  but `length` does not become `4294967295` and the element does not read back;
  at `4294967295` (not an array index) the ordinary string-keyed property is not
  created. Smells like an i32/u32 truncation in the index path — bounded, and
  the largest single target.

**Recommended order**: F (3 crashes) → D boundary → P1/P2 with #2175 (10).

### Step 2 — F verified: REAL crashes, not failure-path artifacts

Decisive test: strip the asserts. If the crash survives, it is on the success
path. It does.

- `create/15.2.3.5-4-{165,191}.js` — **real, success-path crash**, narrowed to
  `Object.create(proto, { prop: <constructor instance> })`. Controls isolate it
  tightly: the same call with an object-LITERAL descriptor works, and
  `Object.defineProperty(o, "p", <constructor instance>)` works. So it is
  `Object.create`'s props-arg reader, not the descriptor reader, and not the
  instance carrier per se. **2 tests.**
- `defineProperty/15.2.3.6-3-123.js` — does NOT reproduce in a module. The test
  is `{ configurable: this }` in a SLOPPY script, where `this` is the global
  object (truthy); in a module `this` is `undefined` (falsy) and the shape
  passes. Different root cause; needs the sloppy-`this` context to study.
  **1 test.**

### Step 3 — D re-scoped: it is not one 26-test bucket

Extracting the index literals each D test actually uses splits it three ways,
and only one part is a bounded, self-contained fix:

| part | n | what it needs |
| ---- | -: | ------------- |
| **D-a** non-index key ≥ 2^32-1 on an ARRAY via `defineProperty` | 8 | self-contained, no representation change |
| **D-b** index in `[2^31, 2^32-2]` | 7 | widen `__obj_index_of_key` i32 → u32 — see below |
| mis-bucketed by my own heuristic | 11 | re-triage |

**D-b is a DOCUMENTED, deliberate approximation, not an unnoticed truncation.**
`vec-index-domain.ts` §1 (#4434) states it outright: "The ceiling stays 2^31-1
rather than the spec's 2^32-2 … the result doubles as a SIGNED sort key for
OrdinaryOwnPropertyKeys ordering. Keys in `[2^31, 2^32-2]` are therefore treated
as ordinary string keys." So the i32/u32 smell is real and the mechanism is
right, but the fix is a representation change with a named downstream consumer —
not a one-line boundary correction. Do not start it as if it were.

**D-a is the bounded slice.** Isolated with four probes:

| probe | result |
| ----- | ------ |
| `defineProperty(arr, "4294967295", …)` | `length` right; `hasOwnProperty` **false**; value unreadable |
| `arr["4294967295"] = 7` (plain assignment) | `length` right; value **readable**; `hasOwnProperty` **false** |
| `defineProperty(arr, "foo", …)` | fully correct |
| `defineProperty(plainObj, "4294967295", …)` | fully correct |

So: ordinary names on arrays work, the same key on a plain object works — only
**array × numeric-non-index via `defineProperty`** fails. A second, adjacent
defect shows up in the assignment control: `hasOwnProperty` does not see the
#4247 expando-bag entry even when the value reads back, which likely accounts
for part of the 8 on its own.

### Step 4 — D-a is THREE defects, not one (key-domain sweep)

Sweeping `Object.defineProperty(a, K, {value:7,…})` over key spellings, then
checking `a.length`, `a.hasOwnProperty(K)` and `a[K]`, separates them. (Earlier
probes used DOT access `a.foo` / a NUMERIC literal `a[5]`, which is why this
only surfaced on the sweep — the read spelling matters.)

| key | length | hasOwnProperty | `a[K]` reads back |
| --- | ------ | -------------- | ----------------- |
| `"foo"`, `"-1"`, `"1.5"`, `"4294967295x"`, `"2147483648"` | ok | ok | **NO** |
| `"4294967295"`, `4294967295`, `"4294967296"` | ok | **NO** | **NO** |
| `"99"` (ordinary index) | ok | ok | **NO** |
| `"2147483647"` (= 2^31-1, a legal index) | — | — | **TRAPS**: "array element access out of bounds" |

1. **Read-path**: a COMPUTED STRING key on an array (`a["foo"]`) does not find
   the property, while DOT access (`a.foo`) does — and the same holds for
   elements (`a["99"]` misses where `a[99]` hits). This gates almost every case
   in the table, including ones whose store already works, so it is the
   load-bearing half of the "visibility" family.
2. **Store-path**: `defineProperty` with a numeric non-index key `>= 2^32-1`
   creates no named property at all (`hasOwnProperty` false).
3. **Trap**: defining a legal but huge index (`2^31-1`) tries to grow the
   backing array to ~2 billion elements and aborts — an uncatchable trap, the
   #4222/#4247 family, still reachable through `defineProperty`.

(3) is a new component, not in the original D-a scope, and it is a hard abort
rather than a wrong answer — split out as **#4498** (allocation policy, blast
radius over every array grow path).

### Step 7 — the D-a gate, and the PRICED SKIP of the full regression run

**Gate composition (corrected by reading each test's FIRST failing assertion,
not its bucket label).** The "8-test D-a gate" is really three groups:

| tests | first failing assertion | owner |
| ----- | ----------------------- | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | `arr[K]` value read (their `hasOwnProperty` already PASSES) | **this slice (element-read fall-through)** |
| `defineProperty/15.2.3.6-4-{184,185,186}` | `hasOwnProperty(K)` | blocked on the `__hasOwnProperty` fall-through, HELD behind #2175 P2 |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | `arr.length === 4294967295` | **re-bucketed to #4497** (needs index 4294967294 to be legal) |

So the element-read slice's honest bar is **3 flips**, not 8. Recorded before
implementing so the slice is not later read as underdelivering.

**Priced skip — why the full (a)/(c) regression run was NOT done.** Measured
throughput of the per-file driver on this box: **3.67 s/file** (timed, 30 files;
the pooled runner measured no faster at 2.9 s/file). Populations:

| gate | population | cost |
| ---- | ---------: | ---: |
| (a) `built-ins/**/{name,length}.js` — the propertyHelper set that burned 684 passes | 1,240 | 75 min |
| (c) `built-ins/Array` + `built-ins/Object/defineProperty` | 4,213 | 257 min |
| | **before-state** | **~5.5 h** |
| | before + after | **~11 h** |

Eleven hours for a read-side arm addition is the wrong trade, so the gate was
**substituted** (approved): emitted-BYTE identity over a bracketing corpus
(`.tmp/byte-corpus.mts`, 23 programs × gc + standalone) + the functional D-a
gate + a **random 200-file** spot-check of gate (a), **seed 20260815**
(`.tmp/sample-gate-a.mjs`; the sample is random precisely because path order
correlates with feature families, so an alphabetical head-200 is not a sample).

Byte identity is the STRONGER proof for the population that must not move: a
program whose emitted binary is unchanged cannot have changed behaviour, which
is exactly the claim needed about the 684-pass propertyHelper set. The corpus
program whose bytes are EXPECTED to change (non-index numeric read) gets its own
functional before/after so the only observable delta is the intended
absent → found.

### Step 9 — D-a element-read fall-through: LANDED, gates measured

**Change.** `vec-overlay.ts` — the existing finalize-time overlay read prologue
is now spliced into **both** `__extern_get` and `__vec_prop_get`, by iterating
the two lane names rather than duplicating the body, so they cannot drift.
Standalone routes a non-index named read on an array to `__vec_prop_get`
(`resolveNamedPropHelper`, deliberately — the `__extern_*` prologue would
swallow the key as an element), and that lane never received the prologue while
the gc/host lane has had it since #3251. That asymmetry was the whole bug.

**Functional delta (the intended one, and only it):**

| probe | before | after |
| ----- | ------ | ----- |
| `a[4294967295]` after `defineProperty` | miss | **7** ✅ |
| `a["4294967295"]` | miss | **7** ✅ |
| `a.hasOwnProperty(K)` | false | false (HELD step-3 edit) |
| `Object.hasOwn(a,K)` / plain-object / `a.hasOwnProperty("foo")` | ok | unchanged ✅ |

**Gate (b) — exactly the predicted 3 flips, 0 regressions:**
`defineProperties/15.2.3.7-6-a-{180,181,182}` fail → **pass**;
`defineProperty/15.2.3.6-4-{184,185,186}` still fail (blocked on the held
`__hasOwnProperty` fall-through); `4-155` / `-151` still fail (#4497).

**Gate (a), seeded 200 (seed 20260815) — 129 pass / 40 fail / 31 skip →
129 / 40 / 31. Zero pass→non-pass.** This is the population that burned 684
passes last time; it does not move.

**Gate: byte matrix — DEVIATED from its stated expectation, and the deviation is
the GATE's flaw, not the change's.** Expected exactly one program to change;
**11 standalone programs changed**, including `syn:obj-prop` and `syn:hasown`,
which contain no array at all. Cause, verified rather than assumed: a standalone
module links the WHOLE runtime, so editing any native shifts every standalone
module's bytes. Probed directly — a program with no array still contains
`__vec_prop_get`, `__extern_get` and `__vec_overlay_lookup`.

So byte-identity is only a blast-radius proof when linkage is per-program. For
standalone whole-runtime linking it proves **lane-level** isolation and nothing
finer. What it does prove here is worth keeping: **the gc lane is 100 %
unchanged (23/23 programs)** — the host lane is provably untouched. Within
standalone, the functional gates above are the binding evidence, not the bytes.

**Gate: FUNCTIONAL corpus, standalone, base vs branch — IDENTICAL on all 23.**
Same 23 programs, same lane, comparing observed OUTPUT instead of bytes
(`.tmp/func-corpus.mts`, A/B with both sides derived from git at use time). This
converts "the 11 byte deltas are benign code-shift" from inference into
measurement: every one of those programs computes exactly what it did before.

Note the corpus program I predicted WOULD change functionally
(`syn:array-nonindex-numeric`) did not — correctly. It reads
`a[4294967295]` on an array that never had `defineProperty` called on it, so
there is no companion entry and `undefined` is the right answer on both sides.
The behavioural delta is confined to programs that actually install a
descriptor, which is what gate (b) and the R4/R5 probes measure directly. That
is the third time in this slice that a stated expectation was wrong in the
SAFE direction; each was caught by measuring rather than asserting.

### Step 11 — step-3 root cause: a COMPILE-TIME FOLD, not a runtime arm

Diagnostic done by disassembling the emitted module — **no src instrumentation
needed**, so nothing had to be reverted. Both candidates in Step 10 are WRONG,
and so is the plan's assumed site.

**The two natives are byte-identical.** `wasm-dis` of a module containing both
calls shows `$__hasOwnProperty` and `$__object_hasOwn` with the SAME locals and
the SAME `fillVecHasOwnHelpers` prologue (`ref.test $vecBase` → `call
$__vec_gopd` → …). The splice worked on both. So it was never a splice-time
resolution failure (candidate a) nor a competing earlier prologue (candidate b).

**`a.hasOwnProperty(K)` never calls either native.** In `$test` the only
predicate call emitted is `call $__object_hasOwn`; the `hasOwnProperty` site
compiled to a literal **`(if (i32.const 0) …)`**. The answer was CONSTANT-FOLDED
at compile time.

**Where.** `compilePropertyIntrospection` (`object-ops.ts`) — its own docstring
says "Static resolution (string literal arg): constant fold to i32.const 0/1".
Its vec-receiver branch has exactly two arms: a dense-literal own index (fold to
1) and, for reference-element vecs, a canonical-index bounds test OR-ed with
`__hasOwnProperty`. A static key that is **not a canonical array index** —
`"4294967295"` — matches neither, falls through to the generic FIELD-NAME logic,
and a vec struct has no field of that name ⇒ folded `0`. `Object.hasOwn` has no
such fold, which is the entire reason the two spellings disagree.

**Fix (small, and NOT in a contended file).** In that vec branch, a static key
that is not a canonical array index must NOT reach the field-name fold: delegate
to `emitRuntimePropertyIntrospection` (same file, already present, already calls
`__hasOwnProperty`). The runtime prologue is proven correct by `__object_hasOwn`
answering `true` on the identical body — so this is a routing fix, not new
semantics. `object-ops.ts` is untouched by the reflection lane (verified:
they hold `object-runtime.ts` + `proto-index-store.ts`).

### Step 12 — step-3 REVERTED after the #4604 park. Do not retry here.

The step-3 arm is **removed from this worktree** (`object-ops.ts` back to base).
Two reasons, the second of which matters more than the first.

**1. The narrowing fix does not behave as designed, and I cannot explain it.**
`vecInfo !== null` was added to confine the arm to genuine vec receivers. Three
states, one script, one probe (`.tmp/three-state.sh`, reproducible):

| probe | base | over-broad arm | narrowed arm |
| ----- | ---- | -------------- | ------------ |
| K1 `C.hasOwnProperty('prototype')` | 0 | 0 | **1** |
| K3 `C.prototype.hasOwnProperty('constructor')` | 1 | 1 | **0** |
| K7 static own on constructor | 0 | 0 | **1** |

Base and the over-broad arm agree; the NARROWED one differs from both. Adding a
restriction cannot make an arm fire more often, so something other than the arm
is moving — an emission-order or late-import side effect of
`emitRuntimePropertyIntrospection` reaching the generic fold differently, most
likely. Unexplained is disqualifying for a change that already parked the queue.

**2. This worktree structurally CANNOT validate the fix.** The regression is a
composition with reflection's **P2**, which I was correctly told not to sync. On
integrated main P2 makes `C.hasOwnProperty('prototype')` answer `true`; here,
without P2, K1/K7 are **already wrong at base** (0). So every local class-receiver
measurement is of a different composition than the one that parked #4604 — a
local "green" would prove nothing and a local "red" mis-attributes. That is why
the over-broad arm looked harmless in this worktree (base == broad above) while
regressing 12 tests in the integrated branch.

**Consequence for whoever retries:** the fold-vs-runtime decision for
`hasOwnProperty` on a non-vec receiver must be validated **where P2 exists**.
The receiver-narrowing idea is still the right shape — the #3251 overlay and
#3537 bag are vec-only, so a non-vec receiver was never in scope — but it needs
to be measured against the P2 composition, with the 12 regressed
class-elements paths in the control set, not against this worktree's base.

**D-a (Step 9) is unaffected** — it is a separate commit (3829480e6) in
`vec-overlay.ts`, and its 3 flips do not depend on step 3.

### Step 11 result — LANDED (superseded by Step 12: reverted)

**Gate (b): 6 upward flips, 0 regressions** — the full D-a gate now stands at
6/8, and the 2 that remain are the ones correctly re-bucketed to #4497:

| test | before | after |
| ---- | ------ | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | fail | **pass** (D-a, unchanged by this step — no interaction) |
| `defineProperty/15.2.3.6-4-{184,185,186}` | fail | **pass** (this step) |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | fail | fail (#4497, expected) |

**Probe quartet + fold positive controls: 12/12.** The quartet is green
(`hasOwnProperty`, the `.call` spelling, `Object.hasOwn` still true, non-numeric
key still true) and — the part that matters for a fold change — **the world is
not un-folded**: plain-object own/absent, array canonical index in/out of
bounds, array absent non-index key, array named expando, `length` own, and
inherited `push` NOT own all keep their previous answers.

**Blast radius, base = HEAD (already contains D-a):**

| corpus check | result |
| ------------ | ------ |
| gc lane bytes | **identical** |
| standalone bytes | **identical** |
| functional outputs | **identical on all 23** |

Standalone bytes being identical here — where D-a moved 11 programs — is the
signature of the difference between the two fixes: D-a edited a runtime native
(which every standalone module links), this one changes a CALL-SITE routing
decision, so a program that never calls `hasOwnProperty` with such a key emits
byte-for-byte what it did before.

**Gate (a), seeded 200 (seed 20260815): 129/40/31 → 129/40/31, zero
pass→non-pass.** The population that burned 684 passes does not move.

`pnpm run typecheck`: clean. Files: `src/codegen/object-ops.ts` only.

### Step 10 — step-3 (`hasOwnProperty`) recon: the two predicates DIVERGE

Not implemented. Recon only, recorded so the next attempt starts from measured
facts rather than the plan's assumption.

The step-3 target was expected to be `fillVecHasOwnHelpers` — which lives in
**`vec-bag-seed.ts`** (moved out of `vec-overlay.ts`; NOT `object-runtime.ts`,
so no collision with reflection's `emitHasOwn`/`__extern_set` work). That
function unshifts ONE shared prologue into BOTH `__hasOwnProperty` and
`__object_hasOwn`, via a `for` loop over the two names.

**But the two answers diverge on the same receiver and key**, which the shared
prologue cannot explain:

| spelling | answer |
| -------- | ------ |
| `Object.hasOwn(a, "4294967295")` | **true** ✅ |
| `a.hasOwnProperty("4294967295")` | **false** ❌ |
| `Object.prototype.hasOwnProperty.call(a, "4294967295")` | **false** ❌ |
| `a.hasOwnProperty("foo")` (non-numeric, same overlay store) | **true** ✅ |

The generic `.call` spelling failing too rules out an Array.prototype
borrowed-method quirk. And `__vec_gopd` is NOT the problem: the prologue's
affirmative arm calls it, and `Object.getOwnPropertyDescriptor(a, K)` — which
reaches the same companion — returns `{value: 7}`.

So the open question for step 3 is narrow and specific: **why does the prologue
produce a different answer in `__hasOwnProperty` than in `__object_hasOwn` when
`fillVecHasOwnHelpers` unshifts the same instructions into both?** Candidates
worth instrumenting first: (a) `ctx.mod.functions.find(name)` not resolving
`__hasOwnProperty` at splice time (so it silently never gets the prologue —
the same class of failure as Step 8's dead code), or (b) an earlier prologue
already unshifted into `__hasOwnProperty` by another lane returning before
this one runs. Both are cheap to distinguish with a single emitted-body dump.

### Step 8 — implementation attempt: right native, WRONG WIRING POINT

Tried, measured, **reverted** (byte-identity confirmed zero residue).

The element read for a non-index key on a vec goes to `__vec_prop_get`
(`resolveNamedPropHelper` returns `VEC_PROP_GET` in standalone, deliberately NOT
`__extern_get` — see the `array-nonindex-key.ts` header on why the `__extern_*`
prologue would eat the key as an element). So `__vec_prop_get` IS the right
native to teach about the overlay.

**But its body is built too early.** Instrumented:
`[vpget] overlayLookup=undefined externHas=2097294` — `__vec_overlay_lookup`
does not exist yet when `fillVecPropHelpers` sets the body, exactly as
`vec-overlay.ts`'s own header warns ("the descriptor natives are built EARLY …
the per-carrier vec types and index helpers are only complete at FINALIZE").
The arm I added was therefore **dead code**: guarded on a `funcMap` miss, it
emitted nothing. Reverted rather than kept — an unvalidated change that fixes
nothing is the same call #4492 attempts 2 and 3 made, for the same reason.

**Correct wiring point:** a FINALIZE-time splice in `vec-overlay.ts`, beside the
existing overlay read prologues — `__extern_get_idx` (~L2093) and `__extern_get`
(~L2266). `__vec_prop_get` simply never got the third one. The `__extern_get`
prologue is a working template for the exact shape needed (probe companion →
answer if present → otherwise fall through untouched).

**Why the standalone lane misses while gc does not:** the gc/host lane reads
through `__extern_get`, which HAS the overlay prologue. Standalone routes to
`__vec_prop_get`, which does not. That asymmetry is the whole bug.

### Step 6 — CORRECTION: the store is NOT lost. Step 5 below was wrong.

Step 5 (kept underneath, struck through in effect) concluded the numeric
non-index define never lands. **Measured, that is false** — the store works and
only READS are blind. On `var a = []; Object.defineProperty(a, "4294967295",
{value:7,w/e/c:true})`:

| query | answer | |
| ----- | ------ | - |
| `Object.getOwnPropertyDescriptor(a, K)` | `{value: 7, …}` | ✅ stored |
| `Object.getOwnPropertyNames(a)` | includes `"4294967295"` | ✅ |
| `"4294967295" in a` | `true` | ✅ |
| `Object.hasOwn(a, K)` | `true` | ✅ |
| `a.hasOwnProperty(K)` | **`false`** | ❌ |
| `Object.prototype.hasOwnProperty.call(a, K)` | **`false`** | ❌ |
| `a[4294967295]` / `a["4294967295"]` | **miss** | ❌ |
| same key on a PLAIN OBJECT | both correct | ✅ control |
| `a.hasOwnProperty("foo")` (ordinary name, array) | `true` | ✅ control |

So the defect is **entirely read-side, and specific to a NUMERIC-LIKE key on a
vec receiver**: ordinary names on the same receiver are fine, the same key on a
plain object is fine, and `Object.hasOwn` — a different native — already answers
correctly on the very receiver `__hasOwnProperty` gets wrong.

**Single target.** A numeric-like key on a vec routes into the INDEXED lane
(that is what `markNumericLikeNamedKey`, #4434, arms it for). For a key that is
canonical-numeric but NOT an array index the parsed index is `-1`, the indexed
lane has nothing, and `__hasOwnProperty` + the element read answer "absent"
instead of falling through to the companion/bag. `Object.hasOwn`, `gOPD` and
`getOwnPropertyNames` already have that fall-through; `__hasOwnProperty` and the
element read do not. Fix = give those two the same fall-through, which is a
strictly narrower change than the store-side one Step 5 proposed.

Corollary for the slice's original framing: component **(2) "the ≥2^32-1 store
path" does not exist as a defect**. The whole D-a slice is component (1).

### Step 5 — where the D-a store is lost (SUPERSEDED by Step 6 above)

The substrate is NOT missing: #3251 built a full standalone array-descriptor
OVERLAY (`vec-overlay.ts`) — each vec receiver targeted by a descriptor op gets
a companion `$Object` that the hard parts delegate to. `defineProperty(arr,
"foo", …)` works through it today.

The define arm (`vec-overlay.ts` ~L1440) does `parseIndex(1, 7)` →
`i = __obj_index_of_key(key)`, then branches on `i >= 0`. A non-index key gets
`-1` and should fall through to the companion's named define — which is exactly
what `"foo"` does. `"4294967295"` also parses to `-1`, yet does **not** land.
The divergence to inspect first is the #4434 note at ~L1682, "canonical-numeric
named key → arm the indexed-lane flag": a numeric-SPELLED key that is not an
array index is steered into the indexed lane, where a key `>= 2^32-1` has no
slot and is dropped. That is the site to fix, not `__obj_index_of_key` (whose
`-1` answer is already correct here — contrast #4497, which is about the
range it answers `-1` for *wrongly*).

**Deliberately OUT of scope for this slice** (recorded, not fixed): a computed
STRING-NAME read on an array, `a["foo"]`, misses the bag while `a.foo` finds it,
because `nonArrayIndexNumericKey` admits only numeric/boolean SPELLINGS. Widening
it to arbitrary names means owning a reserved-name exclusion list — `arr["length"]`,
`arr["push"]`, `arr["constructor"]` must NOT route to the bag, and an incomplete
list silently breaks every borrowed prototype method. The 8 D-a tests do not need
it: they read back with a NUMERIC key (`arrObj[4294967295]`), which the existing
numeric arm already routes. Fixing it blind, unprompted by a test, is how that
hazard would land.

### F residual — module-goal-unreachable

`defineProperty/15.2.3.6-3-123.js` (`{ configurable: this }`) cannot be
reproduced or fixed under the module goal: it depends on SLOPPY-script `this`
being the global object (truthy). Compiled modules are always strict, where
`this` is `undefined` (falsy) and the shape already passes. Not a defect in the
MOP; parked here so it is not re-triaged as one.

## Wave-4 lane E — implicit-global binding (head shared with #3966)

Row set handed to this lane: `S13.2.2_A17_T2/T3`, `S13.2.2_A18_T1/T2`,
`S13.2.2_A19_T7`, `S8.6.2_A5_T1/T2/T4`, `S8.7.2_A3`, `S8.7_A5_T2`. All ten
verified FAILING on the lane's base (`284bd91a1f`) before any edit.

### Step 0 — the head is NARROWER than "creation". Measured first.

The brief assumed the binding is never CREATED. It is. A single probe of the
three creation spellings at script top level passes on base, untouched:

| probe (top level, standalone)                     | base |
| ------------------------------------------------- | ---- |
| `this.a = 1` then bare `a`                        | pass |
| `b = 2` then bare `b`                             | pass |
| `this["c"] = 3` then bare `c`                     | pass |
| `this.a = 1` then `this.a`                        | pass |

So #3956 (read) + #4500 Slice B (plain write) already give these names real
storage on the realm global object, and the synthesised-module-global design the
brief sketched would have DUPLICATED that storage — two carriers for one name,
which is the exact failure mode #4500 Slice A's own note warns about ("fixing
only the read makes `this.p = 2; this.p === 2` regress"). It was not built.

What is actually missing is every OTHER operation on such a name. Matrix
(`.tmp/probe/p5.js`, one program, each case fault-isolated in a `try`):

| shape                                             | base | after |
| ------------------------------------------------- | ---- | ----- |
| `p++` / `++p`, script top level                   | **0** ❌ | 1 ✅ |
| `p++` / `++p`, inside a nested function           | **0** ❌ | 1 ✅ |
| `p += 2`, top level and nested                    | 2 ✅ | 2 ✅ |
| `p = p + 3`, top level and nested                 | 3 ✅ | 3 ✅ |
| `f()` where `this.f = function(){}`               | silently **no-op** ❌ | runs ✅ |
| `f()` where bare `f = function(){}`               | **ReferenceError** ❌ | runs ✅ |
| `this["f"]()`                                     | **no-op** ❌ | no-op ❌ (see residual) |

### Step 1 — root causes (two, both "the arm was simply never written")

1. **UpdateExpression.** `compilePostfixUnary`'s identifier path ends in
   `fctx.body.push({ op: "f64.const", value: 0 })` — "graceful fallback: emit 0
   for unknown postfix increment/decrement". For an implicit global that both
   answers the wrong value AND drops the store. `compilePrefixUpdate` falls
   through to `compileMemberIncDec` on an Identifier operand, equally inert.
   Neither consulted `ctx.sloppyImplicitGlobals`, which the read
   (`emitImplicitGlobalRead`) and the plain write have consulted since #3956/#4500.
2. **CallExpression.** `tryEmitInlineDynamicCall` refuses unless the callee is a
   "known variable" (local / module global / captured global). An implicit
   global is none of those, so the call fell to one of the two arms below it:
   a hard `ReferenceError: <name> is not defined` when the name has no TS
   declaration, or the graceful `ref.null.extern` when it has one — the latter
   is why `beep()` in `S8.6.2_A5_T4` ran to completion having done nothing.

### Step 2 — change

New module `src/codegen/expressions/implicit-global-binding.ts`:
`isSloppyImplicitGlobalBinding` (one predicate, shared) and
`tryEmitImplicitGlobalIncDec` (GetValue → ToNumeric → ±1 → PutValue, reusing
`emitImplicitGlobalRead` for the read half and the same `__extern_set` carrier
`assignment.ts` uses for the write half, so read and write cannot drift apart
again — which is precisely how this defect arose).

Dispatch-only wiring in the two god-files: three guards in `unary-updates.ts`
(postfix, prefix `++`, prefix `--`) and, in `call-identifier.ts`, one extra
disjunct on the `tryEmitInlineDynamicCall` gate plus one negation on the
ReferenceError arm.

### Step 3 — measured result

**Rows flipped fail → pass: 3.** `S13.2.2_A17_T2`, `S8.6.2_A5_T1`,
`S8.6.2_A5_T4`. Zero rows moved the other way.

**Control set: 60 files, deterministic shuffle seed 20260821**
(`.tmp/mkcontrols.mjs`, population 733) over `language/statements/with`,
`global-code`, `expressions/typeof`, `types/reference`, `statements/variable`,
`expressions/assignment`, `types/object`, `statements/function`. Run on base and
on branch by file-copy revert, same runner, same lane:
**41 pass / 18 fail / 1 compile_error on BOTH — the two result files are
byte-identical.**

### Step 4 — the other seven rows, and why each is NOT this head

Recorded so the next lane does not re-derive them. Each was reduced to a probe.

| row | first failing assertion | actual head |
| --- | ----------------------- | ----------- |
| `S8.6.2_A5_T2` | `position === 1` | **builtin-prototype name capture**, see below |
| `S13.2.2_A18_T1/T2` | `callee === 0` | `with (arguments)` must resolve `callee` to the arguments object's own property; we bind the outer `var callee` instead |
| `S13.2.2_A17_T3` | `__obj.p1 === "w1"` | `with`-scoped write precedence, #4231/#4264 |
| `S13.2.2_A19_T7` | `this.hasOwnProperty('__func')` | global-object ↔ `var`-binding aliasing (#3956 residual): `__func` IS declared, so this is not implicit-global creation at all |
| `S8.7.2_A3` | `this.x !== undefined` at line 1 | reading an ABSENT realm-global property must answer `undefined`, not throw; then `this.x++` must CREATE it (NaN). Genuinely the "creation" head the brief described — but via a MEMBER update, not an identifier one |
| `S8.7_A5_T2` | `typeof(__ref)` after `__ref = obj` | `typeof` on an implicit global holding an OBJECT answers `"undefined"` |

### Step 5 — `typeof` on an implicit global: ATTEMPTED, MEASURED, REVERTED

Recorded in full because the reason it was abandoned is more useful than the
attempt. Nothing from this step is in the branch.

`typeof-delete.ts` const-folds `typeof <name>` to the literal `"undefined"`
whenever the checker reports no value declaration — right for a name that never
exists, wrong for one the program creates at runtime. Replacing the fold with a
guarded runtime probe (`__extern_has` ? `__typeof(__extern_get(…))` :
`"undefined"`) makes the OBVIOUS probe pass:

| probe (`.tmp/probe/p20.js`)                        | fold | probe arm |
| --------------------------------------------------- | ---- | --------- |
| `typeof r` before any assignment                    | ✅   | ✅        |
| `r = new Object(); typeof r`                        | **"undefined"** ❌ | "object" ✅ |
| `r = 5; typeof r` / `r = "s"; typeof r`             | **"undefined"** ❌ | ✅        |

**It still flips zero rows, and the reason is a defect the arm does not own.**
A runtime-computed `typeof` result is fine when CONCATENATED and broken when
used directly (`.tmp/probe/p25.js`, `p26.js`, standalone):

| expression, after `w1 = obj`                       | result |
| ---------------------------------------------------- | ------ |
| `"" + (typeof w1)`                                  | `"object"` ✅ |
| `s = "" + (typeof w1); s === "object"`              | true ✅ |
| `typeof w1 !== "object"`                            | **true** ❌ |
| `(typeof w1) === "undefined"`                       | false ✅ |
| `(typeof w1).length`                                | **NaN** ❌ |

The `.length` row is the decisive one: it rules out the string-EQUALITY route
and every carrier hypothesis at once. Three carriers were tried and all three
produce that same NaN — raw `externref`; `any.convert_extern` + `ref.cast` to
`$AnyString` (verified `absentType = {ref, typeIdx: 6}`, `anyStrTypeIdx = 6`,
`nativeStrTypeIdx = 7`, so the cast is to the type the literal itself uses); and
a five-instruction form with no `if` and no extra locals at all, byte-shaped
exactly like the generic `__typeof` path at `typeof-delete.ts:1796`. Ordering was
also ruled out (`p26` puts the direct use FIRST; same NaN). Instrumentation
confirms the arm fires at every site.

So the residual is: **a runtime `__typeof` result is unusable in direct value
position under standalone** — the concat path coerces it, the value path does
not. That is #2107's territory (the note there records the same class of failure
and answers it with `__any_typeof` returning a native `ref $AnyString`, which
needs an `$AnyValue` operand this path does not have). Fixing `typeof` for
implicit globals means giving the global-object read an `$AnyValue`-shaped
answer, or teaching the value path the externref carrier — either is a
different slice with a different blast radius than this head, so the arm was
removed rather than landed unvalidated.

Second finding from the same probes, unresolved and worth a look: in
`S8.7_A5_T2` the probe arm reports the property ABSENT after `__ref = obj`
(CHECK#1 passes, CHECK#2 fails), while `.tmp/probe/p21.js` — the same shape with
a different name — reports it present. So the bare-assignment write may not
always reach the realm global object; that would be a defect in the #4500
Slice B write arm, not in `typeof`.

**`S8.6.2_A5_T2` is a builtin-prototype name capture, not an implicit-global
defect — and it is a live miscompile well outside this row.** Reduced to:

```js
var a1 = {};
a1['dispose'] = function () { /* … */ };
a1.dispose();     // TypeError: DisposableStack.prototype.dispose requires a DisposableStack receiver
```

An OWN data property whose name matches a builtin-prototype method (`dispose`,
`move`, `defer`, `adopt`, …) is captured by that builtin's native dispatch
instead of taking precedence, on a receiver that does not have the brand.
`a1['moveq']` is fine; `a1['move']` is not. The test uses `seat['move']`, so it
never reaches the increment the row is nominally about. Left unfixed here: it
lives in the builtin-proto dispatch, not in this head, and it deserves its own
row-set and control population.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties|built-ins/Object/create" pnpm run test:262`
— baseline 90 non-pass. gc-lane control on the same filter. Equivalence guard.

## Wave-4 lane G — `Math.<fn>` as a first-class VALUE (2026-08-21)

Slice landed by the wave-4 lane G row set (built-ins/Function family + the
wave-3 lane A `arguments`-extras head). Only ONE of that whole row set was in
reach; the rest is triaged below with reasons, so it is not re-derived.

### What was broken

`Math.sin` **read as a value** — `derivative(Math.sin, 0.0001)` — reified a
closure whose body was the degrade-to-catchable refusal, so the call threw:

```
TypeError: Math.sin is not yet implemented in --target standalone
```

Meanwhile `Math.sin(x)` **called directly** worked, and had for a long time, via
the `Math_sin` self-hosted f64 kernel (`math-helpers.ts`) that
`expressions/builtins.ts` calls from its `hostUnary` arm. The kernel was never
the gap.

The gap was that BOTH phases which decide the value form keyed on the CALL form:

1. `collectImports` (`declarations/import-collector.ts`) added to
   `state.mathNeeded` only from a `ts.isCallExpression`, so a value read never
   put `sin` in the set, `emitInlineMathFunctions` never emitted `Math_sin`, and
   there was no kernel to call even in principle.
2. `ensureStandaloneBuiltinStaticMethodClosure` (`builtin-value-read.ts`) let
   `Math.sin` fall to its `default:` arm, whose body is `emitThrowTypeError`.

Either fix alone leaves the row failing — measured both ways.

### The fix

New module `src/codegen/math-static-value-body.ts` holds both halves:

- `mathValueReadMethod(node)` — the collector predicate (non-call-position
  `Math.<m>` whose kernel exists). The collector keeps only a 5-line dispatch.
- `emitMathStaticValueBody(...)` — the body:
  `__any_from_extern` → `__any_to_f64` per arg → `call Math_<m>` → `__box_number`.
  That coercion pair is copied verbatim from the variadic `Math.max`/`Math.min`
  value body two arms above, deliberately, so an extracted `Math.sin` coerces
  exactly like an extracted `Math.max` rather than growing a second matrix.

**Dispatch position is load-bearing.** The new arm sits BEFORE the
`genericThrowBody` arm, because that arm claims every `default:` case — this one
included — so behind it the new arm would never fire. Verified it fires by the
row flipping, not by inspection.

**Declining is the default and is always safe**: the emitter returns `false`
without pushing anything unless the kernel and all three helpers are already in
`ctx.funcMap`, and the `&&` then falls through to the pre-existing throw body.
Covers 21 methods (19 unary + `pow`/`atan2`); the inline-opcode Math functions
(`abs`/`floor`/`sqrt`/…) and `random` are deliberately excluded — they have no
`Math_<m>` function to call, so they keep today's behaviour.

### Measured

Real `runTest262File`, `--target standalone`, this branch's base vs. after.

| row                                                | base | after |
| -------------------------------------------------- | ---- | ----- |
| `language/statements/function/S13.2.1_A5_T2.js`    | fail | **pass** |

Blast radius: the 35-row built-ins/Function set is **byte-identical** before and
after (33 fail / 1 pass both runs — none of them reads a Math value); the other
5 extras-head rows are unchanged. Control set of 519 currently-passing neighbours
(`Function/prototype/{call,apply}` families, `language/statements/function`,
`language/expressions/call`, and the `Math/{sin,cos,tan,log,pow,atan2}`
directories — the last added specifically because this slice changes Math
emission) diffed base vs. after with no regressions.

### Triage of the rest of the row set — NOT attempted, with reasons

Measured on base with the probes noted; each is a real wall, not a skip.

| bucket | n | finding |
| ------ | -: | ------- |
| `Function(...)` constructor result semantics | 22 of 35 | The bare `Function` value and `Function(src)` both resolve through the **runtime-eval provider realm** (`function-intrinsic-carrier.ts`: reading bare `Function` is an `intrinsic-value` boundary site). Probed: for `f = Function("a1,a2,a3","…")`, `typeof f`/`f.length`/`f.hasOwnProperty("prototype")`/`typeof f.call` are all **correct**, but `Object.prototype.toString.call(f)` is `[object Object]` (should be `[object Function]`) and `Object.getPrototypeOf(f) === Function.prototype` is **false**. Fixing means branding the interpreter-materialized callable across the provider boundary (`src/interp/`, `src/runtime.ts`), not a codegen table entry. |
| `Function.hasOwnProperty("prototype"/"length")`, `delete Function.prototype` | 3 | Same root cause, and cheap-looking but isn't. `Object`/`Array`/`String.hasOwnProperty("prototype")` all answer **true** — `pushBuiltinCtorOwnPropSeed` seeds those carriers, and `Function: 1` **is** in `BUILTIN_CTOR_ARITY`. The seed never reaches this value because the bare `Function` identifier read does not route to `emitBuiltinConstructorIdentity` at all; it routes to the provider realm. (This is exactly failure mode 1 recorded in the `function-intrinsic-carrier.ts` header.) `delete Function.prototype` returns `true` and is a no-op, for the same reason. |
| `Object.getPrototypeOf(fn) === Function.prototype` | — | **Also false for an ORDINARY declared function**, so this is not a Function-ctor defect but a general carrier-identity gap. It is what makes `typeof obj.call === "function"` answer `undefined` when `obj`'s prototype is a function (`S15.3.4.{3,4}_A1_T1/T2`). Out of reach of this row set. |
| `Function.prototype.bind` | 2 | Refuses loud in standalone (`… is not yet implemented`). Genuinely unimplemented, not a plumbing gap. |
| strict `caller`/`arguments` poison pills (`15.3.5.4_2-*gs`) | 5 | Substrate exists (`function-poison-pill.ts` threads the caller-strictness bit) but 4 of the 5 build the strict function via `Function("\"use strict\"; …")`, i.e. the provider realm again. |

Base status of the 35-row set is **33 fail / 1 pass / 1 compile-error**, not
34 — `built-ins/Function/S15.3.3_A2_T2.js` reports status `compile_error`, which
a status filter written as `pass|fail|skip` silently drops. Recorded because a
row that vanishes from a triage listing reads exactly like a row that was never
in the set. Its error is the same bucket as the two rows above it:

```
Codegen error: Function.indicator built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

i.e. an arbitrary static property read on the `Function` carrier, which the
provider-realm value cannot serve.

### `arguments`-extras head — measured, and narrower than assumed

The brief framed the remaining gap as "over-supplied arguments in ORDINARY calls
of function declarations". Probed on base, that framing is **too broad** — the
ordinary direct-call path already works:

| probe | result |
| ----- | ------ |
| top-level `function one(a){…}` called `one("a","b")` | `2:a,b` — **extras work** |
| top-level zero-formal, called through a closure var | `arguments.length` **1** (right), `arguments[0]` **null** |
| nested `function inner(){…}` returned and called | whole `arguments` object **null** |
| nested `function inner(a){…}` called with 2 args | whole `arguments` object **null** |

So there are two distinct defects, and neither is "the ordinary-call path drops
extras": (a) a **lifted nested function DECLARATION** gets no `arguments` object
at all when called through a closure ref — note `compileLiftedClosureBody`
(where wave-3 lane C installed `mappedArgsInfo`) is typed
`ts.ArrowFunction | ts.FunctionExpression` and does **not** accept a
`FunctionDeclaration`; (b) in the zero-formal closure-call case argc and the
extras array disagree, leaving slot 0 filled from neither formals nor extras.
`S13.2.2_A5_T1` is a third variant: `new F(a,b,c,d)` on a 2-formal declaration
reading `arguments[2]`, which null-derefs despite wave-3 lane D's in-`new` work.

Not attempted here — each needs its own measured slice, and guessing at the
call/callee `paramCount` contract is how a silent wrong `arguments.length` would
land. `S13_A2_T2` additionally needs `arg + arguments[1]` to pick the *dynamic*
`+` (it currently folds to the numeric operator and yields `2` instead of
`"11"`), which is a typing question, not an extras question.

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **100 rows — defineProperty 47 + defineProperties 15 + rest-of-Object 38**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-20 routing correction — Date writable-data own visibility

Fresh ES5 standalone triage for #4504 isolated
`built-ins/Object/defineProperty/15.2.3.6-4-408.js` from the inherited-`[[Set]]`
cohort. The write decision itself is already correct: a writable data descriptor
on `Date.prototype` permits `dateObj.prop = 1002`, and the value reads back as
`1002`. The failure is that direct/borrowed `hasOwnProperty` and `in` do not see
the Date instance's created expando (the statically typed Date introspection path
folds false), while the dynamic receiver path can observe it. This is a Date
carrier own-storage/visibility and `compilePropertyIntrospection` convergence
row, not a prototype-descriptor refusal row. #4504 explicitly excludes it from
its nine-test denominator; retain it here for the next MOP/introspection slice.

## 2026-08-21 wave-2 census + Implementation Plan

Fresh corpus run on the merged integration tree (`d13f3859`): the **Object MOP
lane is 78 rows** (`defineProperty` 36, `defineProperties` 11, `keys` 4,
`Object.prototype` 6, `create`/gOPD/rest 21). Lane list:
`.claude/worktrees/es5w2-obj-mop/.tmp/lane-tests.txt`.

Top signatures: `Expected X, actually N` (5), `resultN !== true` (4),
`arrObj.length SameValue` (3), `arrObj.hasOwnProperty !== true` (3),
`arr.length SameValue` (3), `Object.prototype.isPrototypeOf not yet
implemented` (2 — see #4480 R4 for the receiver-spelling mechanism and its
two-lane evidence).

### Plan (ordered)

1. **Re-baseline**: lane list + 551-guard on the branch point, one process per
   test for anything prototype-adjacent; record both before any edit.
2. **Array-receiver descriptor rows first** (`arrObj.length` / index defines):
   the #4426/#2668 vec-overlay work owns this shape; extend
   `emitArraySetLengthValidation`'s deferral to the runtime for the remaining
   §10.4.2.1 steps. Do NOT touch the signed-length representation (bucket E is
   retired — ≥146 raw-i32 readers, a −1 sentinel at
   `property-access-dispatch.ts` ~L2861; see #4556).
3. **Accessor + attributes-only defines on plain objects**: the #4491
   mirror→vec projection landed for reads; the residual is write-path
   (`accessed !== true`, `resultN !== true` families). Follow the descriptor
   table through `vec-descriptor-mirror.ts`.
4. **Defer**: anything rooted in `Object.prototype.isPrototypeOf` receiver
   spelling (#4480 R4) or function-intrinsic `length`/`name` (#4562) — note
   and skip, both are owned elsewhere.

Verification bar (all lanes, standing): guard 551/551 (re-baselined), vitest
relative to merge base **including GC-lane suites**, prototype-write corpus
isolated with frozen tree, budget gates earned before granted.

## 2026-08-21 wave-2 FINAL (obj-MOP lane) — 0 → 6 of 78, all gates clean, no allowances

Branch `es5w2-obj-mop`, 4 commits, merged to the integration branch; all 6 rows
independently re-verified by the integrator on the merged tree.

| commit | rows | defect |
| --- | ---: | --- |
| `7e0fac5a` | +3 | `isFrozen`/`isSealed` read a stored flags bit only `freeze`/`seal` ever set; §7.3.15 makes them COMPUTED predicates (`preventExtensions` alone can make an object frozen). Own-property walk added behind the bit as fast path, carrier bags excluded (a bag holds expandos, not elements). |
| `dadeaaae` | +1 | a void closure answered `ref.null.extern` (`null`) across the dynamic `__call_fn_method_*` ABI; JS says `undefined`. `return null` / `return 5` controls unchanged. |
| `cc057dd6` | +1 | the vec `hasOwnProperty` arm OR-ed an inline presence check with the native — a ONE-WAY RATCHET that could only turn false into true, so a delete tombstone could not veto the stale vec slot (`a.hasOwnProperty("0")` true while `0 in a` — the same native, different spelling — false). Native measured correct on all four cases; obsolete inline half deleted. |
| `2c6217e1` | +1 | `""` treated as an absent property name rather than a real own key. |

Verification: guard 551/551 on every slice; vitest base-relative 42→42 failing
IDENTICAL set (56 files/517 tests incl. a 26-file GC-lane subset — the full
equivalence dir OOMs the worker pool on this box, stated as a real limit);
prototype-write corpus 120/121 both sides, same single pre-existing failure;
both god-file growths paid by extraction, **no budget allowances**.

### Two working changes REVERTED at zero rows (diagnosis retained)

1. **`propertyIsEnumerable` on a vec index is compile-time folded to `false`**
   for every array index — the dynamic-key spelling and gOPD both say true.
   Extending the vec introspection arm fixes it; moved 0 rows in lane and 0 in
   `built-ins/Object/prototype/propertyIsEnumerable/**` (13/16 both sides).
2. **for-in over a vec ignores the enumerable bit.** For whoever takes it:
   (a) the #4222 presence gate (`overlayRouteActive` + `__extern_has_idx`) is
   FALSE in a module whose only descriptor op is `Object.defineProperties` —
   measured `hasIdx=undefined`, so a filter hung off it is inert exactly where
   the failing tests need it; (b) `__propertyIsEnumerable` must NOT be the
   filter — it answers 0 for a TypedArray index and would silently empty
   TypedArray for-in. The correct probe is gOPD-shaped: suppress only when the
   descriptor EXISTS and `enumerable` is false (measured right on all six
   shapes).

### Remaining 72, classified

- **Blocked**: 6 × `length` ≥ 2³¹ (retired bucket E/#4497); 7 × mapped-`arguments`
  defineProperty writeback; 1 × sloppy-script `this` (module goal); 1 × DOM.
- **Out of lane**: 6 × boxed valueOf (protos lane); 2 × `isPrototypeOf`
  (#4480 R4).
- **Root-caused, not fixed**: 3 × void-in-argument-position (branded i32 zero —
  type-mapping change); 4 × accessor read site coercing to the getter's
  statically-inferred return type after `{get: undefined}` (store+gOPD already
  correct); 3 × the `hasOwnProperty` numeric-non-index fold needing the
  reflection lane's P2; 3 × the vec enumerable filter above; 1 × Date
  own-visibility.
- **QuickJS/eval-blocked: ZERO rows in this lane.**

## 2026-08-21 void-in-argument-position slice (closes the void-undefined family)

**Root cause.** `inferParamTypeFromCallSites` narrowed an implicit-`any`
parameter from the TS type of the argument at each call site. For a purely-void
argument — `verifyEqualTo(arrObj, "0", getFunc())` where `getFunc` returns
nothing — `mapTsTypeToWasm` answers `i32` ("void → no result, handled in
codegen"). That answer is a lowering convention for a *result slot*, not a claim
that the argument is the number `0`, but the inference took it literally: the
harness parameter got an `i32` slot, the void call padded it with `i32.const 0`,
and the deprecated `verifyEqualTo` reported `Expected obj[0] to equal 0,
actually undefined` — with the **expected** side wrong, not the actual one.

**Fix** (`src/codegen/declarations/param-return-inference.ts`, +21 LOC, exactly
the shape of the #4555 under-application rule right above it): record a call
site whose argument type is exclusively `Void | Undefined`, and withdraw the
narrowing when the agreed type is a native scalar (`f64`/`i32`/`i64`) — those
have no encoding of `undefined`. The parameter stays on its resolved
`externref`, whose default value already IS the canonical undefined
(`pushDefaultValue` → `emitUndefinedValue` → the #2106 `$undefined` singleton in
standalone). The withdrawal is per parameter POSITION, so a numeric kernel with
a void argument in some other slot is untouched, and annotated parameters never
reach this inference at all.

**Measured** (serial single-test standalone probes, before/after on the same
worktree):

| test                                          | before | after |
| --------------------------------------------- | ------ | ----- |
| `Object/defineProperty/15.2.3.6-4-207.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-208.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-312.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-570.js`     | pass   | pass  |
| `Object/defineProperty/15.2.3.6-4-498.js`     | pass   | pass  |

Two 12- and 17-test control batches (arguments-object, function statements,
call/void expressions, Math/Array/Object/String/parseInt built-ins, and 12
`verifyEqualTo(..., getFunc())` defineProperty rows that already passed) are
**byte-identical before and after** — no regressions in the sample.

**Residuals deliberately NOT taken in this slice:**

- `15.2.3.6-4-195.js` still fails, but no longer on the void value — its
  `verifyEqualTo` now passes and it stops at `Expected obj[0] to be writable,
  but was not`. That is inherited-accessor `[[Set]]` dispatch, a different row.
- `[1, getFunc()]` — a void element mixed with numbers types the array
  `number[]` after the type mapper's union rule ("`T | undefined` for primitives
  → just use `T`"), so the element lands as `f64 0`. Pure `undefined[]`/`void[]`
  is already correct (#2806). Changing the union rule would move every
  `number | undefined` slot in the compiler and is out of scope here.

## 2026-08-21 bucket D re-triage + the uint32 `length` VALUE slice

**Bucket D was 26 rows in the 2026-08-15 triage; on this head it is 10.** Every
row in the file set that mentions a 2^32-boundary literal
(`built-ins/Object/define{Property,Properties}`, `built-ins/Array{,/length}`,
35 files) was re-run serially against my own HEAD before touching anything —
several had already been carried by the session's earlier slices (`15.2.3.6-4-
{184,185,186}`, `15.2.3.7-6-a-{180,181,182}`, `-{149,152,153}`,
`15.2.3.6-4-{153,156,157}` all pass now).

The 10 reproducing rows split into **three unrelated defects**, not one:

| part | rows | defect |
| ---- | ---- | ------ |
| **D-L** `length` **VALUE** in `[2^31, 2^32-1]` | `defineProperty/15.2.3.6-4-{154,155}`, `defineProperties/15.2.3.7-6-a-{150,151}`, `Array/length/15.4.5.1-3.d-3`, `Array/S15.4.5.2_A3_T3` | this slice (4 of 6 landed; 2 blocked, below) |
| **D-I** array **INDEX** at 2^32-2 must bump `length` to 2^32-1 | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | #4497 — needs the `vec-index-domain.ts` ceiling raised from 2^31-1 |
| **D-A** allocation | `Array/S15.4.5.2_A1_T1`, `Array/length/S15.4.5.2_A3_T4`, `Array/length/S15.4.2.2_A2.1_T1` | #4498 — `new Array(2^32-1)` / `x[2^31]=1` trap ("requested new array is too large" / "array element access out of bounds") |

(`Array/length/define-own-prop-length-overflow-realm.js` is eval-rooted and
cannot be validated here — no QuickJS provider on this box, per #4163.)

### Root cause of D-L: an explicit bail, not a truncation

`vec-overlay.ts`'s native `__vec_dp_value` `"length"` arm (the standalone
ArraySetLength) carried

```
// u ≥ 2^31 → legacy no-op (i32 vec length cannot represent it)
```

and **returned the receiver untouched**. So
`Object.defineProperty(arr, "length", {value: 2**32-2})` answered `0` — a wrong
answer with no error, invisible to every gate.

The premise is false in the direction that matters. STORING elements at such an
index does need sparse arrays; carrying the uint32 length VALUE does not — the
`$__vec_base` length field round-trips the whole u32 domain as a bit pattern,
and the readers that can observe a length ≥ 2^31 already widen it with
`f64.convert_i32_u` (the `__extern_get` `"length"` arm in `object-runtime.ts`,
added by the `vec-length-set.ts` slice, which had already made the *dynamic*
`arr.length = n` store unsigned). The define arm was the odd one out.

**Fix** (`src/codegen/vec-overlay.ts`, +38 −2): replace the bail with a
sparse-length arm — the same §10.1.6.3 `__vec_dp_value` legality delegate as the
in-range path (so a non-writable / non-configurable `length` still refuses),
then `vec.length = i32.trunc_sat_f64_u(u)`. The element machinery is skipped
deliberately: a length ≥ 2^31 is unbackable, so it is always a grow into sparse
territory with no real elements to create — exactly what the static
`maybeEmitVecLengthDefine` does above its own 16M ceiling. It also *cannot* use
the shrink loop below it, whose `i32.lt_s` against a newLen with a negative bit
pattern never terminates.

### Measured (serial single-test standalone probes, file-copy A/B on one head)

| set | files | base | branch | up | down |
| --- | ----: | ---: | -----: | -: | ---: |
| boundary candidates (every 2^32-literal file in the 4 dirs) | 35 | 23 pass | 27 pass | **4** | **0** |
| control: `Array/length/**` + `defineProperty/15.2.3.6-4-1*` + `defineProperties/15.2.3.7-6-a-1[4-9]*` | 204 | 186 pass | 191 pass | **5** | **0** |
| blast radius: seeded-120 sample of `built-ins/**/{name,length}.js` (the propertyHelper population) + 60 `push`/`pop`/`splice` | 180 | 103 pass | 103 pass | 0 | **0** |

Flips: `defineProperty/15.2.3.6-4-{154,155}`,
`defineProperties/15.2.3.7-6-a-{150,151}`, and — not predicted —
`defineProperty/15.2.3.6-4-116` ("length descriptor should be writable"), which
reads the descriptor back through the same companion the arm now populates.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all OK (the `vec-overlay.ts` / `fillVecOverlayHelpers`
grants in this file's frontmatter cover it). `tsc` shows no error in any touched
file (510 pre-existing errors, 482 of them TS2591).

### ~~BLOCKED sub-item~~ — CLOSED 2026-08-21 (see the uint32-pair slice below)

The two assignment-form rows below landed together in the
"uint32 `length` ASSIGNMENT pair" slice at the end of this file. The analysis
that follows is retained because it is the reason the pair must move together.

### The two assignment-form rows

`Array/length/15.4.5.1-3.d-3` and `Array/S15.4.5.2_A3_T3` are the same defect on
the plain `arr.length = n` ASSIGNMENT form, and they need **two** one-word
changes, only one of which is in reach:

1. `emitArraySetLengthValidation` (`array-length-define.ts`) ends
   `i32.trunc_sat_f64_s` — signed, so a validated `2**32-1` SATURATES to
   2147483647. Its comment reads this as needing sparse arrays; per the argument
   above that is the wrong diagnosis, and `_u` is the fix. (Same for the
   assignment-expression result widening in `expressions/assignment.ts`.)
2. The STATIC `.length` READ of a vec receiver widens with
   `f64.convert_i32_s` — **`src/codegen/property-access-dispatch.ts` ~L2985**
   (verified by disassembling the emitted module: `$run` is
   `f64.convert_i32_s (struct.get $15 0 …)`). That file is held by another lane
   right now, so this slice does not touch it.

Both edits were **implemented and measured, then REVERTED**, because half of the
pair is worse than neither: with the unsigned store and the signed read,
`[].length = 2**32-1` answers **-1** where it used to answer 2147483647 — still
failing, no test won, and a behaviour change on every `arr.length = <≥2^31>`
with no way to validate it to green from here. Measured state of the pair, so
the next attempt does not re-derive it:

| probe | base | store `_u` only | store + read `_u` |
| ----- | ---- | --------------- | ----------------- |
| `var a=[]; a.length=2**32-1; a.length` | 2147483647 | −1 | (expected 4294967295 — unverified, read not touched) |

**Whoever holds `property-access-dispatch.ts` next: make the vec `length` read
`f64.convert_i32_u`, then flip the two truncations above.** Lengths below 2^31 —
every ordinary array — encode identically under either signedness, so the change
is inert outside the boundary band.

## 2026-08-21 defineProperties descriptor-map + Object.create edges (buckets Q, R)

**Method.** Every file in `built-ins/Object/defineProperties` (632) and
`built-ins/Object/create` (320) — 952 rows — run serially through
`runTest262File(..., "standalone")`, A/B against the identical 952 rows with the
change reverted by file copy (`.tmp/probe/ab.sh`, base copies captured at the
first edit). Plus 279 paired CONTROL rows: all of `language/statements/for-in`,
`built-ins/Object/{keys,getOwnPropertyNames}`, and 89 of
`built-ins/Object/getOwnPropertyDescriptor`.

**Result: 1,231 paired rows, 5 fail→pass, 0 pass→fail.**

| test | before | after |
| ---- | ------ | ----- |
| `create/15.2.3.5-3-1.js` | fail | **pass** |
| `create/15.2.3.5-4-1.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-198.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-203.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-209.js` | fail | **pass** |

### The buckets were much smaller than the triage estimated

Bucket Q was estimated at ~18 rows and R at ~13. Measured on this head, the two
directories together hold **19 non-passing rows**, of which **3 are
`JS2WASM_EVAL_ENGINE=quickjs` infrastructure blocks** — the provider does not
build in this container (`scripts/quickjs-artifact/build.sh` needs clang-18 +
network; the compiler-rt fetch returns non-gzip), the #4163 finding — so **16
are real**. Several rows in the 2026-08-20 gap list already pass on this head
(e.g. `create/15.2.3.5-4-263`, the get-only accessor descriptor). Bucket sizes
derived from error TEXT overstate; re-verify before scoping.

### Root causes fixed

1. **`Object.prototype.isPrototypeOf` had no reflective body**
   (`object-proto-is-prototype-of.ts`, new). `makeGlue`'s `Object` arm sent
   every member but `toString` to `emitObjectProtoOrRefusal`, so a *called*
   `isPrototypeOf` threw "not yet implemented in --target standalone". The
   compile-time folds in `native-is-prototype-of.ts` only fire for a receiver
   written literally as `<Ctor>.prototype`; the ordinary `b.isPrototypeOf(d)` on
   a constructed instance resolves the member off `Object.prototype` and lands
   on the reflective CLOSURE. The body routes to the existing `__isPrototypeOf`
   chain walk and boxes with `__box_boolean` (so `r === true` holds, not
   `1 !== true`). Both late imports are ensured BEFORE any instruction is
   emitted — a mid-body late import would shift this body's already-emitted
   `call`, and the shift fixer only repairs `ctx.currentFunc`.
   Probe controls, all correct: `Object.prototype.isPrototypeOf({})` true,
   `Array.prototype.isPrototypeOf([1,2])` true / `({})` false, own chain true,
   reverse false, self false, primitive/`undefined`/`null` arg false, 2-deep
   chain true, `typeof` `boolean`.

2. **A `Properties` map in a VARIABLE with non-literal entries refused**
   (`object-ops.ts`). `stableDescriptorMapEntries` (#3782) required every entry
   initializer to BE an object literal; `var properties = { "0": descObj }`
   declined, the closed WasmGC struct reached the native plural applier, and it
   threw `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`. Such an entry is now modelled as
   a PASS-THROUGH, and a map containing one is reified into a real `$Object`
   through the existing `compileDescriptorMapAsDynamicObject` builder rather
   than expanded per key — the native applier is the only path with
   ToPropertyDescriptor's conflict/callable checks and it preserves
   §20.1.2.3.1's gather-all-then-define-all order. An all-literal map with no
   merged field write keeps the pre-existing per-key expansion untouched, so
   the paths that already worked emit exactly what they did.
   Note the pre-existing limitation this did NOT change: the stability visitor
   treats a SECOND read of the map variable as instability, so
   `Object.defineProperties(a, props); Object.defineProperties(b, props)`
   declines both.

3. **`for…in` enumerated array indices whose descriptor says
   `enumerable: false`** (`vec-index-enumerable.ts`, new). The descriptor was
   already recorded correctly — `getOwnPropertyDescriptor(a,"0")` reads
   `1001/true/false/true` — only the enumeration disagreed, because
   `emitArrayForIn`'s native lane walks `"0" … "length-1"` unconditionally. The
   new native answers from the #3251 overlay companion and joins the existing
   #4222 presence gate inside the loop's `$continue` block (same `br_if 0`
   shape, so the user body's break/continue depths are untouched). Reserve-then-
   fill like `__vec_overlay_push_keys`, because `__vec_overlay_lookup` is only
   minted at finalize; a skipped fill degrades to the placeholder `1`, i.e. the
   previous answer. Demand gated on `vecOwnKeysDirty`, so a module that never
   mentions a descriptor/own-key builtin gets no native, no call, no local.

### Diagnosed but NOT taken — with the measurement, so it is not re-derived

- **`defineProperty/15.2.3.6-3-138` is NOT an inherited-accessor
  ToPropertyDescriptor bug.** The dispatch brief named it as a §8.10.5 step-5.a
  prototype-walk failure. Measured, `__desc_has_own` already does the full
  §7.3.12 chain walk (#4163) and `"value" in child` answers `true`. The real
  condition is on the RECEIVER: `Object.defineProperty(o, K, desc)` where `o`
  is a compiler-CLOSED struct that already has a declared field `K` and `desc`
  is anything other than an INLINE object literal writes the descriptor into
  the dynamic store while the static `o.K` read still returns the struct field.
  Sweep (`.tmp/probe/pa.js`, `pb.js`), one program, standalone:
  | receiver | descriptor | `o.p` after |
  | -------- | ---------- | ----------- |
  | `{}` | constructed instance w/ own `value` | 42 ✅ |
  | `{q:1}` | constructed instance w/ own `value` | 42 ✅ |
  | `{p:120}` | INLINE `{value:42}` | 42 ✅ |
  | `{p:120}` | `var dsc = {value:42,w/e/c:true}` | **120** ❌ |
  | `{p:120}` | constructed instance | **120** ❌ |
  The descriptor CARRIER (constructed instance, inherited field, set-only
  accessor) is irrelevant — only receiver-shape × descriptor-spelling matters.
  One row in the current red set; the fix belongs with the sidecar/struct-field
  convergence work, not here.
- **`defineProperties/15.2.3.7-6-a-{204,231}` are the typed-lane/aliasing gap,
  not descriptor gaps.** `p5`/`r2` show the accessor at index `"0"` installs,
  invokes, and reports the right descriptor when read directly. What fails is
  reading it back through anything but the original identifier
  (`.tmp/probe/s3.js`, one program):
  `arr[0]` → 101 ✅ · `var idx=0; arr[idx]` → 101 ✅ ·
  `var alias = arr; alias[0]` → **0** ❌ · `f(arr,0)` (param monomorphized to
  the vec) → **0** ❌ · `f(arr,0)` (polymorphic param) → **undefined** ❌ ·
  `f.call(null,arr,0)` → **undefined** ❌ · `f(arr,"verifySetter")` →
  **undefined** ❌ while `arr["verifySetter"]` → 100 ✅.
  That is #4159's own subject (a `propertyHelper.js` parameter on the typed
  lane) plus an ALIAS leak the #4159 note does not mention: the route is keyed
  on the identifier, so `var alias = arr` escapes it. Needs its own slice.
- **`defineProperties/15.2.3.7-6-a-183` is a value-representation row.**
  `arr=[1,2,3]` is a `__vec_f64`; `defineProperties(arr,{"1":{value:"abc"}})`
  cannot store a string in it. Control: the same define with `length` still
  writable also leaves `arr[1] === 2`, and `arr[1] = "zzz"` gives `NaN` — so
  the non-writable `length` in the test is a red herring.
- **`defineProperties/15.2.3.7-2-16` and `create/15.2.3.5-4-15` need the
  ARGUMENTS object, not the descriptor map.** Both assert
  `'[object Arguments]' === Object.prototype.toString.call(this)` inside a
  getter on the `Properties` object. Measured (`.tmp/probe/q3.js`): an
  arguments object here tags `[object Object]`, reports `length: 0` for
  `new Fun(1,2)`, and `Object.defineProperty(args,"bar",{...})` lands nowhere
  (`hasOwnProperty` false, `gOPD` null) while a plain `args.foo = 7` expando
  works. Three separate gaps upstream of anything `defineProperties` can fix.
- **`Object.keys` / `getOwnPropertyNames` still enumerate a non-enumerable
  array index** (`Object.keys(a)` → `["0"]` for the fix-3 array). They reach the
  key list through `__vec_overlay_push_keys` and the `__object_keys` vec arm —
  different wiring, no row in this bucket asserting it, and widening both at
  once would make one regression indistinguishable from the other.
- `15.2.3.7-6-a-{150,151,179}` remain #4497 (the 2^32 `length` boundary);
  `15.2.3.7-6-a-113` is an `Array.prototype.length` value read inside a closure
  (`illegal cast`), a builtin-prototype-value row.

## 2026-08-21 uint32 `length` ASSIGNMENT pair (closes the D-L residual)

Closes the "BLOCKED sub-item" above. `property-access-dispatch.ts` was held by
another lane when that note was written; this slice holds it, so the pair moved
together as the note prescribed.

**The three edits (one semantic change, three sites):**

| file | site | was | now |
| ---- | ---- | --- | --- |
| `src/codegen/array-length-define.ts` | `emitArraySetLengthValidation` tail | `i32.trunc_sat_f64_s` | `i32.trunc_sat_f64_u` |
| `src/codegen/expressions/assignment.ts` | `arr.length = v` expression result | `f64.convert_i32_s` | `f64.convert_i32_u` |
| `src/codegen/property-access-dispatch.ts` | the 9 static vec-`.length` READ widenings (L799, 2819, 2843, 2881, 2932, 2964, 2979, 2986, 3007) | `f64.convert_i32_s` | `f64.convert_i32_u` |

All nine dispatch sites are `struct.get <vec> fieldIdx 0` — the length/element
count of a length-prefixed vec, an ArrayBuffer byteLength, or a `$__ta_view`
effective length. Every one of those is a non-negative uint32 by construction,
so `_u` is the correct widening at each; lengths below 2^31 encode identically
under either signedness, which is why this is inert outside the boundary band.
Only flipping the ONE site the disassembly named would have left the other eight
answering `−1` for the same array reached through a different static shape.

**Measured** (serial single-test standalone probes, file-copy A/B on one head —
base copies in `.tmp/base/`, captured at the first edit):

| test | before | after |
| ---- | ------ | ----- |
| `Array/length/15.4.5.1-3.d-3.js` | fail (`2147483647`) | **pass** |
| `Array/S15.4.5.2_A3_T3.js` | fail (`2147483647`) | **pass** |

Paired control A/B, 473 rows — all of `built-ins/Array/length`,
`Array/prototype/{join,push,splice,slice,pop}`, 40 `indexOf`, 25
`String/prototype/slice`, the `defineProperty/15.2.3.6-4-1**` band and the
`defineProperties/15.2.3.7-6-a-1[4-9]*` band:
**base 328 pass → after 329 pass, 1 up, 0 down.**

The landed boundary flips named as must-stay-green controls
(`15.2.3.6-4-{154,155,116}`, `15.2.3.7-6-a-{150,151}`) are all still `pass`,
as are `Array/length/S15.4.5.1_A1.{1,2,3}_T1`.

Direct value probe (`.tmp/probe/len1.js`), one program, standalone:
`a.length = 4294967295` → `4294967295` · `(b.length = 4294967294)` →
`4294967294` (assignment RESULT, the second half of the pair) ·
`[1,2,3].length` → `3`, shrink to `2` → `"1,2"` · `d.length = 4294967296` →
`RangeError` thrown, as §10.4.2.4 step 3 requires.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0. `tsc` reports no error in any of the three
touched files.

## Wave-3 dispatch plan (2026-08-21, toward 100% ES5 standalone)

328 rows remain (`.tmp/es5-remaining.txt`, derived from the 20260821-122045
scoped run minus the 14 post-measurement flips). Four parallel lanes, each an
Opus worktree agent with reproduce-first discipline and per-lane file
ownership; briefs carry the banked per-cluster diagnoses from this file,
#4206 (25-row statements/function clustering), #2875 (String residuals), and
#2071. Lanes: (A) statements/function + types/object|reference — seeds: the
kind-changing member-update growable trigger (`m.foo++` on a string field
answers null, probe n1), the banked f.prototype/constructor and
typeof-before-var heads; (B) Array/prototype + keys/gOPN — seeds: the
declined keys/gOPN enumerability widening, the alias leak; (C)
defineProperty/defineProperties + Object/prototype — seeds: the 138
static-read/dynamic-store divergence, arguments-object define rows; (D)
Function/prototype + instanceof — seeds: the C2 provider-dependence
re-measure, apply/call receiver family, aliased-ctor instanceof. String +
RegExp + assignment queue for the next free slot.

## 2026-08-21 wave-3 lane B — §10.4.3 String-exotic own KEYS (the enumeration half of #4232)

`hasOwnProperty` has answered String-exotic own properties correctly since
#4232. Nothing else did: the key list for `Object.keys` / `getOwnPropertyNames`
/ `for…in` is built by walking the `$Object` own-props TABLE, and a String
exotic's `length` and indices are DERIVED from the `[[PrimitiveValue]]`
[[StringData]], not stored as table entries. Measured on this branch,
`--target standalone`, before the fix (`.tmp/probe/s11.js`, `s13.js`, one
program each):

| expression | before | after | spec |
| ---------- | ------ | ----- | ---- |
| `Object.keys("abc")` | `[]` | `["0","1","2"]` | ✅ |
| `Object.keys(new String("abc"))` | `[]` | `["0","1","2"]` | ✅ |
| `Object.getOwnPropertyNames(new String("abc"))` | `["[[PrimitiveValue]]"]` | `["0","1","2","length"]` | ✅ |
| …then `str[5] = "de"` | `["5","[[PrimitiveValue]]"]` | `["0","1","2","5","length"]` | ✅ |
| `Object.getOwnPropertyNames("ab")` | `[]` | `["0","1","length"]` | ✅ |
| `"0" in new String("abc")` | **false** | `true` | ✅ |
| `for (p in new String("abc"))` | `[]` | `["0","1","2"]` | ✅ |

**Three defects, one slice** — they are not separable, and the middle one is
why the naive fix is a net ZERO:

1. **No index keys in the enumerators.** New native `__strexo_push_keys(obj,
   vec) -> i32` (`src/codegen/string-exotic-own-props.ts`) resolves the
   [[StringData]] from either receiver shape — a `new String` wrapper
   (`$Object` + the reserved slot) or a PRIMITIVE string reaching
   `Object.keys("abc")` (the `$AnyString` itself; standalone does not
   materialize the call-site ToObject) — and pushes `"0" … "len-1"`. Spliced as
   a one-call prologue into `__object_keys`, `__object_keys_forin` and
   `__getOwnPropertyNames`. Those indices are the LOWEST by construction (an
   index below the [[StringData]] length is non-configurable, §10.4.3.5, so a
   `defineProperty` can never create a competing table entry), which is why
   pushing them ahead of the table walk IS OrdinaryOwnPropertyKeys order rather
   than an approximation of it. `length` is a non-index key, so gOPN appends it
   AFTER the table walk — `str[5]="de"` must read `[…,"5","length"]`, not
   `[…,"length","5"]` — and `Object.keys` never gets it (non-enumerable).
2. **`[[PrimitiveValue]]` leaked out of gOPN.** The all-keys walk pushed every
   live entry; the reserved FLAG_INTERNAL slot is not an own property.
   `Object.keys` was never affected — its walk is `__obj_ordered`, which
   filters by [[Enumerable]].
3. **`__extern_has` did not know about String-exotic indices**, so `"0" in str`
   was `false`. Fixing only (1) is a NET ZERO, not a +1: `Object/keys/
   15.2.3.14-6-3` asserts `for…in` and `Object.keys` AGREE on a String object,
   and it had been passing **vacuously** because both were empty. Teaching the
   enumerator alone turned that vacuous pass into a real `pass → fail` while
   flipping two others — measured, not predicted. The for-in loop re-checks
   each key's liveness with `__extern_has` (#2066), so every index key the
   enumerator produced was discarded one instruction later; #4232 had taught
   only the OWN predicate. The same consult-only prologue on `__extern_has` is
   sound (an own property IS a HasProperty hit) and closes it.

**Measured**, serial single-test standalone probes, file-copy A/B on one head
(base copies captured at the first edit in `.tmp/base/`):

| control set | rows | base | after |
| ----------- | ---- | ---- | ----- |
| all of `Object/{keys,getOwnPropertyNames}` + `getOwnPropertyDescriptor` + the `defineProperties/15.2.3.7-6-a-19*/20*` for-in-enumerability band + `String/prototype/{toString,valueOf}` + `language/statements/for-in` | 225 | 187 pass | **190 pass** |
| `language/expressions/in` + `Object/{hasOwn,prototype/hasOwnProperty,prototype/propertyIsEnumerable}` + `Array/prototype/{indexOf,every}` + `String/prototype/indexOf` + `built-ins/String` + more `for-in` | 327 | 272 pass | **272 pass** |
| **total** | **552** | **459** | **462** — 3 up, **0 down** |

Flips: `Object/keys/15.2.3.14-1-3`, `Object/getOwnPropertyNames/15.2.3.4-4-44`
(both assigned rows) and `Object/getOwnPropertyNames/non-object-argument-valid`
(unassigned bonus). The `vec-index-enumerable.ts` for-in gate stays green —
`defineProperties/15.2.3.7-6-a-{198,203}` both still `pass`. The one non-flip
message change in the second set is a func-INDEX shift inside a pre-existing
`CompileError` (`#452` → `#453`), expected from adding a native.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0. `tsc` reports no error in any touched file.

### Follow-ups this slice deliberately did NOT take

- **`const FLAG_INTERNAL_SLOT = 0x10` in `object-runtime-descriptors.ts` is an
  invariant living only in prose.** It duplicates `FLAG_INTERNAL` in
  `object-runtime.ts` rather than importing it, purely so this wave's diff in
  the C-lane-fenced file stays one contiguous region (one import + five hunks,
  all inside the `__getOwnPropertyNames` block). A follow-up should export the
  flag from the owning module and import it here — see the #4082 result-boxing
  header for why this repo treats prose invariants as a defect.
- **`for…in` over a PRIMITIVE string enumerates `String.prototype`'s methods**
  (`toString|charAt|charCodeAt|…`, measured) instead of `["0","1","2"]`. A
  separate receiver-classification bug in the static-unroll path, untouched.
- **`Object.keys({"": "empty"})` is `[]`** — an empty-string property key is
  dropped before the runtime sees it (`gOPN` also `[]`), so
  `getOwnPropertyNames/15.2.3.4-4-b-3` still fails for a reason upstream of
  key enumeration.

## 2026-08-21 wave-3 lane C — the `arguments` [[ParameterMap]] cluster (6 rows)

All 36 of lane C's rows were re-run serially on this head before any edit; all
36 reproduced, so nothing below is inherited from the dispatch list.

The dispatch brief expected these six to need "a new arguments carrier". They
did not. The cluster is **two independent defects in the existing mapped-args
machinery**, and both are visible from one three-line probe.

### Defect 1 — the mapped/unmapped split depended on how the function was SPELLED

`compileFunctionBody` has installed `mappedArgsInfo` for function DECLARATIONS
since #849. `compileLiftedClosureBody` builds the identical arguments vec for a
function EXPRESSION and never installed it, so every mapped emitter
(`emitMappedArgParamSync`, `emitMappedArgReverseSync`, the
`Object.defineProperty(arguments, …)` arms) was simply off for the expression
form. Measured, one program (`.tmp/probe/p3.js`), standalone:

| form | `arguments[0] = 9` → `a` | `defineProperty(arguments,"0",{value:9})` → `a` |
| ---- | ------------------------ | ---------------------------------------------- |
| `function g(a,b,c)` (declaration) | 9 ✅ | 9 ✅ |
| `var m = function (a,b,c)` (expression) | 0 ❌ | 0 ❌ |

Every one of the six failing tests is an IIFE — `(function (a,b,c) { … }(0,1,2))`
— which is why the whole cluster reads as an "arguments object" gap.

Fix: install `mappedArgsInfo` in the existing `needsImplicitArgumentsObject`
block of `compileLiftedClosureBody`, gated exactly as the declaration path is
(§10.2.11 step 22.a: `isSimpleParameterList` ∧ ¬`isStrictFunction`), with
`paramOffset: 1` because a lifted closure carries `__self` at local 0 — the
same shape `new-super.ts` already uses for lifted methods. `__unbox_number` is
ensured beside the `__box_number` the block already ensured: the forward sync
boxes a param INTO the slot, the reverse sync unboxes back OUT into it, and only
the first half was present (the reverse sync degrades silently when the import
is missing).

### Defect 2 — §10.4.4.2 sequenced Map.[[Delete]] before Map.[[Set]]

With defect 1 fixed the six tests still failed, because their first define is
`{value: 10, writable: false, …}`. Step 5.b of ArgumentsExotic.[[DefineOwnProperty]]
is ordered: **5.b.i `Map.[[Set]](P, Desc.[[Value]])` — which writes the linked
formal parameter — and only then 5.b.ii `Map.[[Delete]](P)` when `writable` is
present and false.** The compiler severed the link while PARSING the descriptor
(`unmappedIndices.add`), then routed the define to the runtime, which writes only
the arguments slot. So `a` kept its old value:

| probe (`.tmp/probe/p4.js`, declaration form, so defect 1 is not in play) | before | after |
| --- | --- | --- |
| `defineProperty(arguments,"0",{value:20,writable:false,e:false,c:false})` → `a` | 0 ❌ | 20 ✅ |
| …then a second `{value:20}` → TypeError, `a` | threw ✅, `a` = 0 ❌ | threw ✅, `a` = 10 ✅ |
| its `getOwnPropertyDescriptor` | `20/false/false/false` ✅ | unchanged ✅ |

Fix: `compileObjectDefineProperty` is now an 8-line wrapper around the unchanged
body (`compileObjectDefinePropertyCore`). When the core hands a mapped-index data
define with an explicit `[[Value]]` to the generic path, it records the debt; the
wrapper emits step 5.b.i **after** the define, reading the value back out of the
arguments slot the define just wrote. That evaluates the descriptor exactly once
and makes the two steps land in spec order (the emitter's severed-index check is
re-opened for the duration of that one emission). The core records the debt
rather than the wrapper re-deriving the fast-path predicate, so the two cannot
disagree about which defines the inline path took.

### The interlock this exposed, and the regression it caused

Marking a mapped index as "now runtime-defined" was necessary — otherwise a
later `{value: 20}` takes the inline fast path, writes the opaque vec slot, and
leaves the sidecar descriptor reporting the OLD value (`15.2.3.6-4-293-3`
failed exactly there: `0 descriptor value should be 20`). But the first cut
stopped at that, and the inline path is also the only one that wrote the
parameter — so `Object.defineProperty(arguments,"0",{configurable:false})`
followed by `{value:2}` stopped updating `a`. **The 812-row control caught it:
+6 / −4.** Four `language/arguments-object/mapped/*` rows regressed. Generalising
the debt to *every* generic-path value define on a still-mapped index (not just
the `writable:false` one) fixes both directions; the re-run is below.

### Measured — paired A/B, 812 rows, serial single-test standalone probes

Set: all of `language/arguments-object` (263) + all of
`language/expressions/function` (264) + `built-ins/Object/defineProperty/15.2.3.6-4-{2,3}*`
(285). Base copies captured at the first edit (`.tmp/base/`), A/B by file copy on
one head.

| | base | after |
| --- | --- | --- |
| pass | 699 | **706** |
| fail | 107 | 100 |
| compile_error | 6 | 6 |

**7 up, 0 down.** The six targets — `defineProperty/15.2.3.6-4-{292-1, 293-2,
293-3, 294-1, 295-1, 296-1}` — plus one not predicted:
`language/arguments-object/mapped/nonconfigurable-descriptors-set-value-with-define-property.js`,
which is defect 2 in its own words.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all OK (grants added to this file's frontmatter — note
`compileObjectDefinePropertyCore` is a RENAME, not growth). `tsc` reports no
error in `closures.ts`, `object-ops.ts` or `context/types.ts`.

### Diagnosed but NOT taken (measured, so it is not re-derived)

- **An ACCESSOR define on a mapped index does not install the accessor.**
  `(function (a) { Object.defineProperty(arguments, "0", { get: function () {
  return 10; } }); return arguments[0]; })(0)` answers **0**, not 10 — §10.4.4.2
  step 5.a severs the map and the property becomes a real accessor, but the
  compiled `arguments[i]` read still goes to the vec slot. No row in lane C
  needs it (all six are data descriptors), and it needs the element READ to
  consult the sidecar, which is the same convergence the 3-138 row wants.
- **`defineProperties/15.2.3.7-2-16` and `create/15.2.3.5-4-15` are unchanged**
  by this slice, and the earlier note about them needs one correction: an
  arguments object tags `[object Arguments]` correctly and reports the right
  `length` **inside** its function — measured on this head (`.tmp/probe/p1.js`):
  `len=3`, `cls=[object Arguments]`, `defineProperty(arguments,"bar",…)` lands
  and `hasOwnProperty("bar")` is true, `gOPD(arguments,"0")` round-trips. What
  those two tests need is the arguments object as the `Properties` MAP after it
  has ESCAPED its function (`var props = new Fun()` / `return arguments`): the
  escaped value no longer answers the vec-carrier test, so
  `__defineProperties` refuses with `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`
  (`object-runtime-descriptors.ts` `nonVecFallback`). That is a carrier-identity
  row, not an arguments-MOP row.

## 2026-08-21 wave-3 lane C — §10.1.6.3 step 4.c lost its IsGenericDescriptor precondition

`built-ins/Object/defineProperty/15.2.3.6-4-59` defines an accessor and then
redefines it with an EMPTY descriptor, `Object.defineProperty(obj, "foo", {})`,
which §10.1.6.3 makes a no-op. Standalone threw
`Cannot redefine property: cannot convert a non-configurable accessor to a data
property`.

**Root cause.** The `__defineProperty_value` ValidateAndApply preflight
(`object-runtime-descriptors.ts`, `s4Preflight`) implements step 4.c as "current
entry is an accessor ⇒ throw". The spec's step 4.c is guarded: *"If
IsGenericDescriptor(Desc) is **false** and IsAccessorDescriptor(Desc) is not
IsAccessorDescriptor(current)"*. A descriptor mentioning neither `[[Value]]` nor
`[[Writable]]` converts nothing, so it must not reach 4.c at all. The apply path
20 lines below already had this right — its `keepAccessor` arm is literally
"existing accessor AND a GENERIC desc … the accessor halves stay live" — so the
preflight was throwing before its own correct implementation could run.

**Fix.** Wrap the existing throw in an `hf & (HOST_HAS_VALUE |
HOST_WRITABLE_SPECIFIED)` test. Steps 4.a/4.b, which run BEFORE 4.c, still reject
a generic descriptor asking for `configurable: true` or a different `enumerable`,
so nothing that must throw stops throwing.

**Control matrix** (`.tmp/probe/p6.js`, one program, standalone — the
must-still-throw rows are the point):

| probe | before | after | expected |
| ----- | ------ | ----- | -------- |
| E `{}` over a NON-configurable accessor | **throws** | `function/function/false/false` | no-op ✅ |
| F `{value:1}` over a NON-configurable accessor | throws | **throws** | TypeError ✅ |
| G `{writable:true}` over a NON-configurable accessor | throws | **throws** | TypeError ✅ |
| K `{enumerable:true}` over a NON-configurable, non-enumerable accessor | throws (4.b) | **throws (4.b)** | TypeError ✅ |
| L `{configurable:true}` over a NON-configurable accessor | throws (4.a) | **throws (4.a)** | TypeError ✅ |
| I `{enumerable:true}` where current already IS enumerable | **throws** | `function/true/false` | no-op ✅ |
| J `{configurable:false}` over a NON-configurable accessor | **throws** | `function/false` | no-op ✅ |
| H `{value:7}` over a CONFIGURABLE accessor | `7/undefined` | `7/undefined` | conversion ✅ |
| M `{}` over a plain data prop | `5/true` | `5/true` | no-op ✅ |
| N `{}` over a non-writable non-configurable data prop | `5/false/false` | unchanged | no-op ✅ |
| O `{}` on an ABSENT key | `undefined/false/false/false` | unchanged | creates ✅ |
| P `{enumerable:true}` over a CONFIGURABLE accessor | `function/true/true` | unchanged | attrs only ✅ |

**Measured — paired A/B, serial single-test standalone probes, base = the
commit above (file-copy revert):**

| set | rows | base | after | up | down |
| --- | ---: | ---: | ----: | -: | ---: |
| `Object/{freeze,seal}` (147) + `defineProperty/15.2.3.6-4-<1-2 digit>*` (122) + every 3rd `getOwnPropertyDescriptor` (104) + `defineProperties/15.2.3.7-{5-b-2xx,6-a-<1-2 digit>}` (156) | 529 | 509 pass | 510 pass | **1** | **0** |
| all of `built-ins/Object/create` — the plural applier calls this same native | 320 | 319 pass | 319 pass | 0 | **0** |

The single flip is `15.2.3.6-4-59`. Gates: `check:loc-budget`,
`check:func-budget`, `check:coercion-sites`, `check:oracle-ratchet` all OK;
`tsc` reports no error in the touched file.

### Adjacent defect found while probing, NOT fixed here

`Object.defineProperty(o, k, { get: g })` where `g` is a VARIABLE holding
`null` does **not** throw (`.tmp/probe/p5.js` row D) — §6.2.5.6 requires a
TypeError for a `get` that is present, not undefined and not callable. The
LITERAL spelling `{ get: null }` is caught at compile time (#3116), which is why
`create/15.2.3.5-4-258` and `defineProperties/15.2.3.7-5-b-218` still pass. The
runtime reader's singleton arm normalises the undefined singleton to a null slot
and then cannot tell the two apart. Fixing it means giving the reader a
representation that distinguishes "present undefined" from "present null" — the
#2106 value-representation lane, not this one.

### 15.2.3.6-4-21 is NOT the `get: undefined` bug it looks like

Its shape — install `{set: setter}`, then redefine with `{get: getter}` where
`getter` is `undefined` — is **already correct on this head** when it runs inside
a function (`.tmp/probe/p5.js` row A: `d2.get === getter` ✅, `d2.set === setter`
✅, `configurable`/`enumerable` both `false` ✅). The test declares its bindings
at TOP LEVEL, so whatever it hits is a module-scope binding/shape difference, not
the descriptor reader. Recorded so the next attempt starts from the probe rather
than from the error text.

## 2026-08-21 wave-3 lane C — the remaining 29 rows, triaged from SOURCE

Lane C's slice was 36 rows (`defineProperty` 20, `defineProperties` 6,
`getOwnPropertyDescriptor` 3, `create` 1, `Object/prototype` 6). All 36 were
re-run serially on this head before any edit and all 36 reproduced; **7 now
pass** (the six `[[ParameterMap]]` rows plus `15.2.3.6-4-59`). The other 29 are
grouped below by the defect that actually causes them — each line is what was
measured, not what the error text says.

| n | rows | root cause | owner |
| -: | ---- | ---------- | ----- |
| 3 | `Object/prototype/valueOf/S15.2.4.4_A1_T{1,2,3}` | `new Object(<primitive>)` does not build a primitive WRAPPER, so `__dyn_valueOf` (`wrapper-valueof.ts`) finds no `WRAPPER_PRIMITIVE_KEY` slot and falls to its identity arm. The error text renders as `SameValue(«1.1», «1.1»)` because the wrapper stringifies as its primitive — a TYPE bug that reads as a VALUE bug, exactly as that module's header warns. Fix belongs at the `new Object(x)` lowering, not the valueOf helper. | value-representation |
| 3 | `defineProperty/15.2.3.6-4-{195,243-1,243-2}`, `defineProperties/15.2.3.7-6-a-{204,231}` (5 rows, 3 distinct shapes) | accessor installed at an ARRAY INDEX: it installs and reports the right descriptor, but the element READ/WRITE does not dispatch through it. This is #4159's typed-lane subject plus the alias leak already recorded above. | array lane (#4159) |
| 3 | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179`, and the `length` half of `-113` | array INDEX at 2^32-2 must bump `length` to 2^32-1 | #4497 (`vec-index-domain.ts` ceiling) |
| 2 | `defineProperty/15.2.3.6-4-117`, `defineProperties/15.2.3.7-6-a-113` | `Array.prototype.length` read inside a closure → `illegal cast` | builtin-prototype-value |
| 2 | `getOwnPropertyDescriptor/15.2.3.3-4-{34,116}` | `gOPD(Function.prototype, "constructor")` / `gOPD(Date.prototype, "constructor")` answer nothing. Verified against `Object`/`Array`, which answer `true/true/false/true` correctly — so this is not a gOPD gap but the DECLINE that `builtin-proto-constructor.ts` (#4200) documents in its own header: Date, String, Number, Boolean and Function have no identity-stable carrier, and minting one changes what the BARE identifier reads. Explicitly deferred there, not here. | #4200 follow-up |
| 2 | `defineProperties/15.2.3.7-2-16`, `create/15.2.3.5-4-15` | the arguments object as the `Properties` MAP after it has ESCAPED its function — see the correction above; a carrier-identity row, not an arguments-MOP row | carrier identity |
| 2 | `defineProperty/15.2.3.6-{3-123,625gs}`, `S15.2.3.6_A1` (3 rows) | module-goal-unreachable or host-shaped: `3-123` needs sloppy-script `this` (already parked above); `625gs` needs a global `var` to win over `Object.prototype`; `S15.2.3.6_A1` reaches `Document.createElement` | out of lane |
| 1 | `defineProperty/15.2.3.6-3-138` | the banked static-read/dynamic-store divergence (closed struct already declaring the key + non-inline descriptor). Confirmed still reproducing; needs the property-access convergence, which is another lane's file. | struct/dyn convergence |
| 1 | `defineProperty/15.2.3.6-4-21` | NOT the `get: undefined` bug it looks like — see the probe above; the same shape is already correct inside a function, so it is a top-level-binding difference | unclassified |
| 1 | `defineProperty/15.2.3.6-4-408` | Date-instance own-storage visibility (already routed here 2026-08-20) | Date carrier |
| 1 | `defineProperty/15.2.3.6-4-589` | a Date object stored through a prototype-chain accessor reads back `NaN` | value-representation |
| 1 | `defineProperty/15.2.3.6-4-622` | `verifyProperty(Date, "now", …)` — `Date.now`'s own descriptor is correct (`function/true/false/true`, probed), so the failure is elsewhere in `verifyProperty`'s walk | unclassified |
| 1 | `getOwnPropertyDescriptor/15.2.3.3-4-4` | `gOPD(globalThis, "eval")` | global object |
| 1 | `Object/prototype/S15.2.4_A1_T2` | `delete Object.prototype.toString` then calling it must throw | builtin-proto delete |
| 1 | `Object/prototype/constructor/S15.2.4.1_A1_T2` | `new (Object.prototype.constructor)` — "is not a constructor" | #4200 follow-up |
| 1 | `Object/prototype/valueOf/S15.2.4.4_A14` | `(1, Object.prototype.valueOf)()` must throw on an undefined `this` | ToObject on undefined |

Nothing in this table is blocked on the descriptor MOP itself any more: the two
slices above closed the last rows whose cause lived in `object-ops.ts` /
`object-runtime-descriptors.ts`.

## Wave-3 lane A, slice 1 (2026-08-21) — 5 of 41 rows closed

Measured on `claude/pull-from-upstream-zgdo0m` @ `1d57d9229a`, `--target
standalone`, single-test in-process runner, QuickJS eval provider built
locally (artifact `13c33e175f16`, adapter key `1429ec7ecf2163fd`). Row set:
the 41 `language/statements/function` + `language/types/object` +
`language/types/reference` non-passes in `.tmp/es5-remaining.txt`. **All 41
re-verified failing on that head before any edit** — none had flipped.

### Cluster A — an ALWAYS-numeric update on a field the closed struct cannot hold (4 rows)

`S8.6_A2_T1`, `S8.6_A2_T2`, `S8.6_A3_T1`, `S8.6_A3_T2` — all four `fail` →
`pass`. Two shapes of one defect; the literal pins each slot's storage type:

| source | closed struct | observed | spec |
| --- | --- | --- | --- |
| `var m = {foo:"bar"}; m.foo++` | `foo` is a string slot | `m.foo` is **null** (a later `+` null-derefs in `__str_concat`) | `NaN` |
| `var m = {}; m.foo++` | no `foo` slot at all | update RESULT is `NaN` (correct) but the write is **dropped**, so `"foo" in m` is false | `NaN`, property created |

The two halves needed separate fixes and are separable — the first is a
representation choice made before codegen, the second is an emission arm.

**Half 1 — `markStandaloneNumericUpdateKindChangeTargets`**
(src/codegen/declarations/object-shape-widening.ts) joins the existing
`markStandalone*Targets` markers in `collectGrowableObjectLiterals`, so a
non-empty literal whose field is hit by an always-numeric update is routed to
the open `$Object` builder and inherits that block's concrete-struct consumer
guard unchanged. Isolation that fixed the direction before writing it: adding
`if (false) { delete m.zzz; }` — which routes the literal to `$Object` through
the pre-existing `markStandaloneDeleteTargets` poison — makes `{foo:"bar"}` +
`foo++` answer NaN with no other change.

The trigger is deliberately narrow. `+=` is **excluded**: `"a" += x` stays a
String, so it does not change a string field's kind — only `++`/`--`/`-=`/
`*=`/`/=`/`%=`/`**=` are always-numeric. And the disagreement must be provable
from the literal's own syntax (a string/template/boolean/null/object/array/
function initializer, or the field being absent); a call or an identifier
initializer answers "unknown" and stays on the closed-struct path.

**Half 2 — the unknown-field arm of `compileMemberIncDec`**
(src/codegen/expressions/unary-updates.ts) emitted `f64.const NaN` and dropped
the write when the receiver's struct resolved but carried no slot for the
property. It now reuses the SAME externref read-modify-write the #2656
unresolvable-receiver arm one screen above already uses — the read still
answers undefined → NaN, so the result value is unchanged; only the vanished
write-back changes. The two arms were de-duplicated into one module-scope
`emitMemberIncDecExternrefFallback` rather than inlined twice.

Half 2 is what closes the EMPTY-literal rows, and it is worth recording that
the delete-poison isolation did **not** help them: `var m = {}` with the
poison still lost the write, because the empty-widening path had already
resolved a zero-field struct and the drop is downstream of the
representation choice.

### Cluster B — `typeof x` read textually BEFORE `var x = <init>` (1 row + 1 advanced)

`S8.7_A5_T1` `fail` → `pass`; `S13.2.2_A19_T8` advances from CHECK#0 to
CHECK#2.

A `var` binding hoists; its VALUE does not. The checker types the symbol from
its initializer, so `staticTypeofForType` folds the EVENTUAL type forever:

```js
typeof __func;                     // observed "function", spec "undefined"
var __func = function () {};

typeof __ref;                      // observed "object",   spec "undefined"
var obj = new Object(); var __ref = obj;
```

This re-diagnoses #4206's Cluster C ("`var f = function(){}` hoists carrying
its VALUE"). The binding does **not** hoist its value: `__module_init` seeds
each backing global with the `$undefined` singleton and overwrites it in
declaration order, exactly as the spec requires. Only the CONST-FOLD was
wrong. `readPrecedesVarInitializer` (src/codegen/typeof-delete.ts) kills the
fold for that window; the existing runtime `__typeof*` path then reads the
global and answers correctly on both sides of it.

Two findings that cost real time and are cheap to hand on:

- **A first cut tested `ref.is_null` on the backing global and silently never
  fired.** The seed is the `$undefined` SINGLETON, not a null extern — so the
  guard compiled, allocated its locals, and changed nothing. The fix is to
  kill the fold and let the runtime path read the value, never to test
  live-ness by pointer.
- **The two fold sites must be guarded together.** `typeof(__ref) !==
  "undefined"` folds in `compileTypeofComparison`, while the `'Actual: ' +
  typeof(__ref)` in the SAME throw statement folds in
  `compileTypeofExpression`. Guarding only the latter produced a test that
  threw while reporting `Actual: undefined` — the two arms disagreeing inside
  one source line. The comparison arm also has to unwrap parentheses, which
  the plain arm already did.

Narrow by construction: standalone/WASI-gated; `let`/`const` excluded (their
pre-declaration read is a TDZ ReferenceError, owned by the boxed-TDZ path);
the read and the declaration must share one enclosing code unit (otherwise
`function f(){ return typeof x }; var x = 1; f()` would be mis-guarded — it
runs AFTER the declaration despite reading earlier); and no loop may enclose
the read inside that unit (a backward edge can revisit it).

### Blast radius, measured

73 currently-passing standalone rows re-run, 73/73 still pass — 42 sampled
across `expressions/{postfix,prefix}-{in,de}crement`, `compound-assignment`,
`expressions/object`, `types/object`, `Object/{defineProperty,keys,
getOwnPropertyNames}`, `statements/{for-in,with}`, plus 31 across
`expressions/typeof`, `statements/variable`, `global-code`,
`statements/function`, `types/reference` and `expressions/delete`. Gates
`check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0; `tsc` clean on the three touched files.

### Wave-3 lane A, slice 2 — `var F = function(){}` had no `constructor` back-ref (1 row)

`S13.2_A4_T2` `fail` → `pass`; `13.2-17-1` advances past its first assertion.

§13.2 step 10 does not care how the function object was produced, but this
compiler does. Measured on this head, the ONLY varying axis being the
declaration form:

| source | `F.prototype.constructor` |
| --- | --- |
| `function __func(){}` | `__func` — correct |
| `var __gunc = function(){}` | `[object Object]` — the bare prototype object; the property was simply ABSENT and the read walked on |

`fnctorConstructorInstallInstrs` (src/codegen/expressions/fnctor-prototype.ts)
declined the second form on purpose, and its #4480 note says why: the value it
installs must be the very object an ordinary `F` identifier read yields, and
`var F = function(){}` has no `__fn_closure_<F>` singleton. Publishing the
singleton anyway would make the IDENTITY assertion false — a wrong answer
where there was merely a missing property.

The note also names the value that IS identity-stable for this shape and did
not need inventing: **the module global the identifier read itself returns.**
`moduleGlobalConstructorInstallInstrs` installs `global.get <F's slot>`, so
`F.prototype.constructor === F` holds because both sides are the same
`global.get`, not because two constructions happen to agree.

Gate order matters here: the arm fires only when the caller resolved NO
declaration (`ctx.funcMapOwnerDecl` / `topLevelFunctionDeclarations` both
miss — the `function F(){}` case is the sibling arm's) and the name is not a
top-level function name, so a declaration whose decl node we merely failed to
find cannot fall through into it. The backing global must also be `externref`;
a primitive slot cannot carry a function value.

Blast radius: 38 further passing rows across `statements/function`,
`expressions/function`, `Function/prototype`, `Object/getPrototypeOf`,
`expressions/new` and `expressions/instanceof` — 38/38 still pass, plus the
42-row control set re-run at 42/42.

**Still failing in this cluster, and why they are NOT this head:**
`S13.2.2_A1_T1/T2` and `S8.6.2_A1` need `F.prototype.isPrototypeOf(new F())`,
which `fnctor-instance-prototype.ts` already records as blocked by the #2660
escape gate (writing the call demotes `F` out of the approved set) and whose
file this lane does not own. `S8.6.2_A2` needs an inherited-property WRITE to
shadow on the instance. `13.2-17-1` now fails one assertion later, on an
`Object.prototype.constructor` ACCESSOR being consulted by `verifyProperty`.

### Wave-3 lane A, slice 3 — `for…in` over a literal that writes GREW (1 row)

`S8.6_A4_T1` `fail` → `pass`.

```js
var o = { bar: true };
o.some = 1; o.foo = "a";
for (var k in o) count++;      // observed 1, spec 3
```

The #2837 growable pre-pass already recognises the growth (two depth-1
out-of-shape writes). Its consumer-safety poison for `for…in` then CANCELS the
marking — and that poison is a HOST-lane statement: "`for (k in V)` lowers
against V's STATIC struct type, so an externref `$Object` would fail the
cast."

In standalone the relation inverts, the same way #2992 S6 established for
`delete`: the closed struct is precisely what cannot serve the consumer,
because the added keys have no slots to enumerate. So the enumeration is a
REASON to open the object, not a reason to leave it shut.
`markStandaloneEnumeratedGrowthTargets` fires only on the conjunction
(enumerated ∧ grown), inside the standalone-only `mopSet` arm that already
carries the concrete-struct-consumer guard.

The one #2837 poison that keeps its force in standalone is re-stated by hand:
an ARITHMETIC read of a field off `V` wants the `struct.get` f64 contract
(#1897), so such a var declines and keeps its closed struct — with the
enumeration gap intact. That is a deliberate documented trade, not an
oversight.

Scan shape worth noting for the next editor: the three signals (the literal,
the writes, the loop) routinely sit in DIFFERENT statements, so this marker
scans the whole statement list at once. The sibling `markStandalone*Targets`
helpers are called per-statement and would never see them together.

Blast radius: 42 further passing rows across `statements/for-in`,
`Object/{keys,getOwnPropertyNames,assign}`, `JSON/stringify`,
`expressions/object` and `Array/prototype/{map,filter,forEach}` — 40 pass, and
the two that do not (`expressions/object/{getter,setter}-body-strict-inside`)
were **re-run on the pristine branch head `1d57d9229a` with all four touched
files reverted and fail there identically**, so they are pre-existing on this
branch and not attributable to any slice here. The 42-row control set re-runs
at 42/42.

### Wave-3 lane A, slice 4 — the realm-global member CALL and BRACKET read (1 row)

`S8.6.2_A5_T3` `fail` → `pass`.

#4500 Slice A taught the member READ that `this.p` / `globalThis.p` on a
`var`-declared script global must answer from the wasm module global that
actually stores it. Two siblings never got the same treatment, and the split is
visible inside one program:

```js
var count = 0, knock = function () { count++; };
var g = this.knock;   typeof g   // "function"   — Slice A, correct
this.knock();                    // TypeError: called value is not a function
this["knock"]();                 // TypeError
var c = this["count"];           // undefined  (the dot form answers 0)
```

The read being right while the call throws is the tell: one lowering learned
about module globals and the other did not.

- **The bracket READ** — `tryEmitRealmGlobalModuleGlobalElementRead`
  (src/codegen/property-access.ts) is the literal twin of the Slice A dot arm.
  §13.3.3 makes the two spellings the same [[Get]]; only a key the compiler can
  resolve to a fixed string qualifies, so a genuinely dynamic `this[k]` keeps
  the existing dynamic read.
- **The CALL** — `tryEmitRealmGlobalMemberCall`
  (src/codegen/expressions/realm-global-member-call.ts, new) reads the callee
  out of the module global and invokes it through `__apply_closure`, passing the
  compiled receiver so a STRICT callee still sees the global object (a bare
  `f()` would bind `undefined`).

**Dispatch POSITION is the load-bearing part, and it cost two attempts.** The
arm first went into `compileCallDispatchTail` — the last-resort arm, one line
above the graceful `ref.null.extern` fallback — and never fired, because
`compileReceiverMethodCall` claims the call much earlier: it resolves the member
against the checker's `typeof globalThis` struct, misses (a `var` global has no
field there), and its resolved-method-is-null guard raises the TypeError. So the
arm has to sit BEFORE the property-access dispatch block in
`compileCallExpression`, not after everything else. A "last-resort" position is
only last-resort for calls nothing else claimed; this one was claimed and
answered wrongly.

Blast radius: 50 passing rows across `expressions/call`, `expressions/this`,
`global-code`, `built-ins/global*`, `Function.prototype.{call,apply}`,
`types/{object,reference}` and `built-ins/Math` — 50/50 pass; control set 3
(38 rows over `statements/function`, `expressions/function`,
`Function/prototype`, `Object/getPrototypeOf`, `expressions/new`,
`expressions/instanceof`) re-runs 38/38.

**Not fixed, and it is one head, not four:** `S8.6.2_A5_T{1,2,4}`,
`S8.7.2_A3` and `S13.2.2_A19_T7` all need `this.x = v` / `this["x"] = v` on a
name with NO `var` declaration to CREATE a script-global binding that a bare
`x` reference then resolves. That is the implicit-global-binding work #4206
already scoped out (its `S13.2.2_A17_T2/T3` + `A18_T1/T2` entry is the same
head); the read/call arms here deliberately do not touch it, because creating a
binding is a declaration-time act and these arms are expression lowerings.

### Wave-3 lane A — final tally and the residual heads

**8 of 41 rows closed** (`fail` → `pass`), verified by a final serial re-run of
the whole 41-row set on `worktree-agent-a0565c82af575a1ff`:

| row | slice |
| --- | --- |
| `language/types/object/S8.6_A2_T1` | 1 — kind-changing numeric update |
| `language/types/object/S8.6_A2_T2` | 1 |
| `language/types/object/S8.6_A3_T1` | 1 |
| `language/types/object/S8.6_A3_T2` | 1 |
| `language/types/reference/S8.7_A5_T1` | 1 — typeof before `var` initializer |
| `language/statements/function/S13.2_A4_T2` | 2 — `var F = function(){}` constructor back-ref |
| `language/types/object/S8.6_A4_T1` | 3 — `for…in` over a grown literal |
| `language/types/object/S8.6.2_A5_T3` | 4 — realm-global member call / bracket read |

The other 33 all still report `fail` — none regressed to `compile_error`, and
one moved the other way: `S8.6.2_A5_T2` was `compile_error` (standalone emitted
the `env::DisposableStack_move` host import, #2961) in the wave-3 row list and
now compiles and runs, failing on the implicit-global head below.

Two rows ADVANCED without passing, which is worth recording because both are
now failing on a different defect than the one they were filed under:

- `S13.2.2_A19_T8` — CHECK#0 and #1 now pass; it fails at CHECK#2, on a
  `var __func` re-declared inside a SECOND `with` block keeping the first
  block's scope (the residual #4206 already named).
- `13.2-17-1` — `typeof fun.prototype.constructor` is now `"function"`; it
  fails one assertion later, inside `verifyProperty`, on an
  `Object.prototype.constructor` ACCESSOR being consulted.

**The residual heads, grouped by what actually blocks them** (so the next lane
does not re-derive this):

| head | rows | why not taken here |
| --- | ---: | --- |
| implicit-global binding — `this.x = v` / `x = v` on an UNDECLARED name must CREATE a script-global that a bare `x` resolves | 8 | `S8.6.2_A5_T{1,2,4}`, `S8.7.2_A3`, `S13.2.2_A19_T7`, `S8.7_A5_T2`, `S13.2.2_A17_T2/T3` (+`A18_T1/T2` add `with (arguments)`). Creating a binding is a declaration-time act; every arm this lane touched is an expression lowering. This is ONE head, not eight, and it is the single largest remaining item in the set. |
| `F.prototype.isPrototypeOf(new F())` | 3 | `S13.2.2_A1_T1/T2`, `S8.6.2_A1`. `fnctor-instance-prototype.ts` already records the blocker: writing the call is a dynamic method use on `F`'s prototype, which demotes `F` out of the #2660 escape gate's approved set. Its file is owned by another lane. |
| `new F()` whose ctor RETURNS a function | 3 | `S13.2.2_A8_T1/T2/T3` — #2071's area, unchanged. |
| `arguments` extras beyond the formals | 4 | `S13.2_A2_T1/T2` (null-deref in `__module_init`), `S13.2.2_A5_T1`, `S13_A11_T4`. `S13_A2_T2` is the adjacent operator half (`arg + arguments[1]` picks numeric). |
| `var F; F = function(){}` — the SPLIT declaration/assignment fnctor | 2 | `S13.2.2_A4_T2`, and it also blocks `S13.2.2_A2`. **Newly isolated here**, and it is a one-line-apart A/B: `var F = function(){}; F.prototype = {…}; new F().m()` WORKS, while `var F; F = function(){}; …` answers `undefined` for the inherited member. `resolveFnctorSymbol` (fnctor-escape-gate.ts) walks the symbol's declarations and finds a `VariableDeclaration` with NO initializer, so the whole #2660 fnctor machinery declines. Admitting the shape means proving the assignment is the ONLY one targeting that binding, and `resolveFnctorSymbol` is consulted by the `new F()` lowering and the escape gate alike — a wide blast radius for a narrow win, so it is left measured rather than attempted. |
| `Math.<unary>` as a first-class VALUE | 1 | `S13.2.1_A5_T2` passes `Math.sin` to a higher-order function. `builtin-value-read.ts`'s `default` arm reifies an identity-stable closure whose BODY throws (#2984 Phase 3). The self-hosted `Math_sin` f64→f64 func already exists (math-helpers.ts) and a body could be `__unbox_number` → `Math_sin` → `__box_number`; what is missing is plumbing the name into the `needed` set that decides whether `Math_sin` is emitted at all, which happens in a different phase from the value read. |
| duplicate function declarations | 1 | `S13_A6_T1` — the later `function __func(){return 'A'}` must win for BOTH earlier and later calls. The call site is typed f64 from the FIRST declaration, so the string result coerces to NaN. A checker-merged-symbol representation question. |
| non-extensible `__proto__` write | 1 | `S8.6.2_A8` — `x.__proto__ = y` on a `preventExtensions` object mutates the prototype. Also measured: `Object.getPrototypeOf(x)` answers `null` rather than `Object.prototype` for that object, so there are TWO defects here and the read one is the more basic. |

## Wave-4 dispatch plan (2026-08-21, base `7e2d724311`)

Wave-3 landed: lane D (+5: arguments inside `new F(…)`, instanceof boolean
branding), lane B (+3: String-exotic own keys), lane C (+8: [[ParameterMap]]
for function expressions + §10.4.4.2 step-5.b order + step-4.c guard), lane A
(+8: kind-changing member updates, typeof-before-var fold guard, `var F =
function(){}` constructor back-ref, for-in over grown literal, realm-global
member call/bracket read). Acceptance measurement in flight.

Three Opus lanes dispatched in parallel, each in its own worktree, no pushes
(tech-lead integrates serially with gates as commit blockers):

| lane | head / row set | rows | seed analysis |
| --- | --- | ---: | --- |
| E | implicit-global binding — `this.x = v` / `x = v` on an UNDECLARED name must CREATE a script global that a bare read resolves | 10 | wave-3 lane A residual table: the single largest one-head item. Declaration-time synthesis of an externref module global seeded `$undefined`, so the existing #4500 Slice A read arm + lane A's slice-4 call arm resolve it. `S13.2.2_A17/A18` add `with (arguments)` and may be blocked past the head. |
| F | String / RegExp / regexp-literals / types-string | 55 | never had a dedicated lane; `.tmp/wave4-laneF.txt`. Triage-first; #2875 records the known walls (primitive-string for-in, empty-string key, value-rep). |
| G | built-ins/Function + `arguments` extras beyond formals + `Math.sin` as value | 41 | `.tmp/wave4-laneG.txt` + lane A's extras rows. The __extras_argv/__argc protocol exists (fnctor-ctor-arguments.ts documents it); the ordinary-call sibling drops extras. |

Not dispatched, measured verdicts on record: split-decl fnctor (`var F; F =
function(){}` — wide blast radius via resolveFnctorSymbol, narrow win),
`new F()` returning a function (#2071), isPrototypeOf behind the #2660 escape
gate, duplicate function declarations (checker-merged-symbol representation),
non-extensible `__proto__` (read defect is the more basic half).

---

## Wave-4 lane F — slice F3: runtime-keyed write to a getter-only RegExp member (2026-08-21)

**Measured before/after** (`--target standalone`, base `284bd91a1f`, probe
`test262/test/probe/f-re-proto3.js`, `var s = /^|^/; var k = "global";`):

| expression | base | after | spec |
| --- | --- | --- | --- |
| `s.global` (static) | `false` | `false` | `false` |
| `s.global = "x"; s.global` | `false` | `false` | `false` |
| `s[k]` | `undefined` | `undefined` | `false` (still wrong — see below) |
| `s[k] = "x"; s[k]` | **`"x"`** | `undefined` | `false` |
| `hasOwnProperty(s, k)` after the write | **`true`** | `false` | `false` |

§22.2.6 makes `source`/`flags`/`global`/`ignoreCase`/`multiline`/`dotAll`/
`unicode`/`unicodeSets`/`sticky`/`hasIndices` getter-only accessors on
`RegExp.prototype`, so §10.1.9 step 3 makes an instance assignment a sloppy
no-op. A `$NativeRegExp` is not a `$Object`, so `__extern_set` routed the write
to the instance expando bag; #4504's inherited-accessor walk could not see it,
because that walk follows `$Object.$proto` links through `$PropEntry` tables and
`RegExp.prototype` is a `$NativeProto` whose getters live in a member CSV.

**Why it is not just a spelling curiosity**: `propertyHelper.js`'s
`isWritable(obj, name, verifyProp)` does `obj[name] = v` with `name` a VARIABLE,
i.e. exactly the runtime-keyed form — which is why `verifyNotWritable` reported
these as writable on a build whose static read was already correct.

**Fix**: new module `src/codegen/regexp-accessor-set-guard.ts` mints
`__regexp_getter_only_set(obj, key) -> i32` (a `ref.test $NativeRegExp` plus ten
`__str_equals` comparisons) and unshifts an early `return` onto `__extern_set` at
finalize — last among the `__extern_set` prologue passes, so it is the body's
first instruction. Demand-gated on the RegExp struct existing in the module.

**Rows flipped (3)**: `built-ins/RegExp/prototype/global/S15.10.7.2_A10`,
`ignoreCase/S15.10.7.3_A10`, `multiline/S15.10.7.4_A10`.

**Deliberately NOT done in this slice**

- **Strict `[[Set]]`.** §10.1.9.2 says a strict write to a getter-only accessor
  throws a TypeError. `__extern_set_strict` is a separate function and is
  untouched: no row in this lane's set exercises it, and a wrong throw is
  catchable and therefore observable.
- **The READ side.** `s[k]` still answers `undefined` instead of `false` — the
  `$NativeProto` getter is not consulted by `__extern_get` either. That is the
  #2885 reflective-getter core, not a `[[Set]]` question, and the no-op above is
  correct standing alone.
- **`delete` on a `$NativeProto` member** (`S15.10.7.{2,3,4}_A9`, 3 rows).
  Measured: `delete RegExp.prototype.global` returns `true` but
  `RegExp.prototype.hasOwnProperty('global')` stays `true` — there is no delete
  path for native-proto members at all (`native-proto.ts` has no tombstone
  concept). Flipping those needs a per-(proto object, member) tombstone side
  table consulted by `__nproto_hasown` and by member dispatch, which is a
  different and larger change than this guard.

**Controls**: 95/95 passing neighbours, before and after (63 String/RegExp/
addition/literals rows plus 32 Object.defineProperty / gOPD / Object.keys /
Array.prototype.push / assignment / delete / RegExp.prototype.{source,toString}
rows). Three rows in the supplementary batch fail identically on base and after
(`Array/prototype/push/S15.4.4.7_A2_T{1,2}` — push-as-a-value unwired;
`RegExp/prototype/source/cross-realm` — `__module_init` null deref) and are
excluded from the control set for that reason.

## Wave-4 lane F — slice F4: String-exotic own props are immutable and undeletable (2026-08-21)

Same defect shape as F3, second receiver family. §10.4.3 gives a String WRAPPER
an own `length` and own canonical INDEX properties, all `{w:false,e:false,c:false}`.
#4232 already taught `hasOwnProperty` about them (`__strexo_hasown`) and gOPD
already reported the right triple — but they are DERIVED from the [[StringData]]
slot rather than being `$PropEntry` rows, so `__obj_find` missed them and a
runtime-keyed write created an own bag entry that shadowed both.

**Measured** (probe `test262/test/probe/f-misc2.js`, `var si = new String("globglob")`):

| query | base | after | spec |
| --- | --- | --- | --- |
| `gOPD(si,"length")` | `{w:f,e:f,c:f,v:8}` | unchanged | unchanged |
| `si.length = "x"; si.length` (static) | `8` | `8` | `8` |
| `isWritable(si,"length")` (propertyHelper) | **`true`** | `false` | `false` |
| `delete si.length` | **`true`** | `false` | `false` |

**Fix**: reuse `__strexo_hasown` as the predicate in the same finalize splice —
`__extern_set` returns early, `__delete_property` returns `0` (§10.1.10 step 4).
Reusing #4232's native is the point: presence, descriptor and mutability then
cannot disagree, because all three read the same predicate.

**Rows flipped (2)**: `built-ins/String/S15.5.5.1_A3`, `built-ins/String/S15.5.5.1_A4_T2`.

**Controls**: 120/120. The set was widened for this slice's blast radius with
`String/prototype/{charCodeAt,toUpperCase}`, `Object/{getOwnPropertyNames,seal,
freeze}`, `Array/prototype/indexOf`, `Array/length`, `for-in`,
`property-accessors` — 25 further passing neighbours. Nine rows in that batch
fail identically before and after (`charCodeAt/S15.5.4.5_A1.1`, three
`Object/seal`, three `Array/prototype/indexOf`, `Array/length/15.4.5.1-3.d-3`,
`property-accessors/S11.2.1_A3_T1`) and are excluded for that reason.

## Wave-4 lane F — slice F6: `delete <Builtin>.prototype.<member>` actually deletes (2026-08-21)

Every own property of a builtin prototype is `{[[Configurable]]: true}`, so the
delete must succeed AND must make `hasOwnProperty` answer `false`.

**Measured** (probe `test262/test/probe/f-re-proto.js`):

| step | base | after | spec |
| --- | --- | --- | --- |
| `RegExp.prototype.hasOwnProperty('global')` | `true` | `true` | `true` |
| `delete RegExp.prototype.global` | `true` | `true` | `true` |
| `…hasOwnProperty('global')` again | **`true`** | `false` | `false` |

The delete reported success and changed nothing: a builtin prototype is a
`$NativeProto` glue singleton whose own-member set is the `$memberCsv` native
string `__nproto_hasown` (#4248) scans, and `__delete_property` only knows how to
tombstone a `$PropEntry` row in a `$Object` hash table.

**Fix**: new module `src/codegen/native-proto-delete.ts` mints
`__nproto_delete(obj, key)`, which rewrites `$memberCsv` (a MUTABLE `externref`
field) with the comma-padded token removed, and unshifts it onto
`__delete_property`. At RUNTIME exactly one consumer reads that field —
`__nproto_hasown`, behind `hasOwnProperty`/`Object.hasOwn`/`propertyIsEnumerable`
— so removing the token is exactly, and only, the observable delete. Every other
`memberCsv` mention in codegen is the COMPILE-TIME `glue.memberCsv` used while
emitting static member reads, which is why dispatch is unaffected (see the
non-attempt below).

**Rows flipped (3)**: `built-ins/RegExp/prototype/{global/S15.10.7.2_A9,
ignoreCase/S15.10.7.3_A9, multiline/S15.10.7.4_A9}`.

**Two toolchain traps found while building it — worth knowing before the next
native is spliced into `__delete_property`:**

1. **Do not read a parameter more than once through a cast chain.** The first cut
   repeated `local.get 0; any.convert_extern; ref.cast $NativeProto` at each use.
   After the caller-side inliner copied the body into `__delete_property`, the
   later `local.get 0` sites had been forwarded the FIRST occurrence's
   already-cast value, so the body's own `any.convert_extern` was handed a
   `(ref null $NativeProto)` and the module failed validation with
   *"any.convert_extern[0] expected type externref"*. Recovering the receiver
   ONCE into a local fixes it.
2. **`__str_replace` is declared to return `$AnyString`, and the replaced result
   is a rope.** Holding it in a `$NativeString` local made the emitter insert a
   narrowing cast that trapped at runtime (*"illegal cast in
   __delete_property"*). Keep the local wide and call `__str_flatten` explicitly.

**Deliberately NOT done**: making the delete affect DISPATCH.
`built-ins/String/prototype/S15.5.4_A1` and `built-ins/RegExp/S15.10.4.1_A6_T1`
both delete a prototype's `toString` and then expect the call to fall back up the
chain to `Object.prototype.toString` (`"[object String]"` / `"[object RegExp]"`).
Measured after this slice they still answer `null` and `"/(?:)/"` respectively:
static member reads consult the compile-time `glue.memberCsv`, not the runtime
field, so a runtime delete cannot redirect them. That is a dispatch-model change,
not a member-set one.

**Controls**: 168/168. Widened again for this slice with
`Object/prototype/{hasOwnProperty,propertyIsEnumerable}`, `Number/prototype/toString`,
`Boolean/prototype/valueOf`, `Date/prototype/getTime`, `Array/prototype/slice`,
`String/prototype/lastIndexOf`, `RegExp/prototype/exec` — 31 further passing
neighbours. Four rows in that batch fail identically before and after
(`Number/prototype/toString/S15.7.4.2_A1_T01`, two `Boolean/prototype/valueOf`,
`Array/prototype/slice/15.4.4.10-10-c-ii-1`) and are excluded.

---

## Wave-4 lane I — HEAD 1: builtin-prototype NAME CAPTURE (2026-08-21)

Lane E isolated this and handed it on: an OWN data property whose name collides
with a builtin-prototype method is hijacked by that builtin's dispatch on a
receiver WITHOUT the brand. Base `da724268b0`, `--target standalone`, real
`runTest262File`.

### The capture set is 1,040 names, not four

Lane E named `dispose` / `move` / `defer` / `adopt`. **Enumerated from the
dispatch code itself** (`ctx.externClasses`, dumped with a throwaway probe at
the top of `tryExternClassMethodOnAny`, on a trivial standalone program): the
first-match loop's candidate pool carries **1,040 distinct method names** — the
whole ambient `lib.dom.d.ts` + builtin surface, from `addEventListener` to
`deref`. Every one of them is a capture candidate; the four lane E saw are the
ones its row happened to touch.

Measured hijack rate on base, deterministic sample of 100 of those 1,040
(`.tmp/genbatch.mjs`, mulberry32 seed 20260821, each name in a zero-arg
`o[<name>] = function(){return "R"}; o.<name>()` shape, 10 names per file):

| lane | names answering `"R"` | names answering wrongly |
| --- | ---: | ---: |
| base `da724268b0` | 95 / 100 | **5** — `cloneContents`, `getRemoteCertificates`, `getType`, `importNode`, `text`, each silently `null` |
| after this slice | **100 / 100** | 0 |

Plus the six lane E / adjacent-brand names, hand-probed one file each
(`.tmp/probe/h1c.js`, `h1f.js`): base `dispose`/`defer`/`adopt`/`use` throw
`TypeError: DisposableStack.prototype.<m> requires a DisposableStack receiver`,
`move` answers `null`, `deref`/`register`/`unregister`/`disposeAsync` **trap**
(`RuntimeError: dereferencing a null pointer`); after, all ten answer `"R"`.
The silent-`null` answers are the worse half — nothing in the program mentions
DisposableStack, and nothing reports an error.

### Root cause — the refusal never learned the bracket spelling

The #3033 guard in `tryExternClassMethodOnAny` (calls-closures.ts) already
declines extern dispatch when the program defines its own function-valued member
of that name. It sits ABOVE every claiming arm, so it is the one place that
covers all 1,040 names at once. `sourceDefinesFunctionMember`
(source-function-members.ts) scanned only the DOTTED write:

```js
o.dispose = function () {};     // seen  → refusal fires  → generic call ✅
o['dispose'] = function () {};  // MISSED → the loop claims the name    ❌
```

The bracket form is the dominant spelling in the ES5 sputnik corpus
(`seat['move']=function(){position++}`) and in any code building a method table
from string keys. The miss is **file-scoped**, which is why the defect hides:
add one dotted write of the same name anywhere in the file and every bracket
site starts working (`.tmp/probe/h1d.js` — four spellings, all pass, because the
file also contains `o.dispose = …`).

### Fix — at the refusal, not in the brand arm's else

New module `src/codegen/element-access-member-names.ts`:
`elementAccessAssignedMemberName(node)` returns the literal property name a
`<recv>[<key>] = <fn>` assignment writes. Two-line dispatch in
`source-function-members.ts`'s existing visitor. Literal keys only — a computed
key (`o[k] = fn`) names nothing at compile time, and widening to "some member
was written" would decline extern dispatch for every program touching a dynamic
property, far past the evidence.

**Why not the else arm of the DisposableStack brand test** (per wave-3 lane A's
"fix the claiming arm at its position"): the brand arm's MISS currently throws
`RequireInternalSlot`, and turning that into a generic-path fall-through would
have to be repeated once per builtin. The refusal runs before ALL of them, so
one recognizer retires the whole class. The brand arm keeps its throw, which is
still correct for the receiver it is actually meant to judge.

### Measured

**Rows flipped fail → pass: 1** — `language/types/object/S8.6.2_A5_T2.js`
(`seat['move']=function(){position++}`; it also needed lane E's implicit-global
`position++`, which is already on this base).

**Controls: 80 rows**, base-vs-after by file-copy revert, same runner, same
lane, quickjs runtime-eval provider built for each lane's own adapter key:
50 from `language/expressions/object` + `language/types/object` +
`built-ins/Object/{defineProperty,defineProperties}` (population 2,952) and 25
from `built-ins/{DisposableStack,WeakRef,FinalizationRegistry,Map,Set}`
(population 756) — the branded-builtin families added specifically because this
slice changes when their dispatch is claimed — plus the 5 target rows.
Deterministic shuffle seed 20260821.
**79 of 80 byte-identical; the one move is `S8.6.2_A5_T2` fail → pass.**
Base 59 pass / 21 fail; after 60 pass / 20 fail.

### Residual, deliberately not taken

`o[k] = fn` with a COMPUTED key stays captured. Closing it needs the runtime
dispatch to consult the receiver's own property table before the extern loop,
which is the dispatch-model change #2151 owns — not a scan widening.

---

## Wave-4 lane I — HEAD 2: a builtin prototype can never BE a `[[Prototype]]`

**WALL. Measured, bounded, not attempted.** Row set
`built-ins/Function/prototype/{apply/S15.3.4.3,call/S15.3.4.4}_A1_T{1,2}` — all
four verified failing on base `da724268b0` (`--target standalone`), all four on
the SAME assertion, `typeof obj.apply` / `typeof obj.call` answering
`"undefined"` where the spec says `"function"`. Each row's SECOND half — the
`obj.apply()` TypeError — already passes on base, so the typeof read is the
whole blocker.

### It is NOT the provider realm, and it is not a Function defect

Lane G filed this under "provider-realm carrier identity" (the 22-row
`Function(…)` wall). It is neither. `F.prototype = X; var o = new F;`, one
program, `.tmp/probe/h2c.js`, no `eval`, no `Function(…)`:

| `X` | `Object.getPrototypeOf(o)` | inherited member read |
| --- | --- | --- |
| `Function.prototype` | **null** | `undefined` |
| `Array.prototype` | **null** | `undefined` |
| `String.prototype` | **null** | `undefined` |
| an ordinary declared `function g` | **null** | `undefined` |
| `Object.prototype` | **null** | `function` (every object gets it anyway) |
| an object LITERAL | `=== X` ✅ | `function` ✅ |
| `new Object()` + expandos | `=== X` ✅ | `function` ✅ |

`Object.create(Array.prototype).slice` and `Object.setPrototypeOf(o, Function.prototype)`
fail the same way (`.tmp/probe/h2d.js`), and so does
`Object.create(Object.prototype)`. So the head is not "Function" and not "eval":
**no builtin prototype can serve as any object's `[[Prototype]]` in standalone.**

### Mechanical cause — one type, one `ref.test`

Builtin prototypes ARE identity-stable (`Function.prototype === Function.prototype`
→ true, two separate reads compare equal — `.tmp/probe/h2e.js`), and they answer
member queries: `Function.prototype.apply` is `"function"`,
`FP.hasOwnProperty("apply")` is `true`. But they are `$NativeProto` VALUE objects
(brand + member CSV, `array-object-proto.ts` / `builtin-brands.ts`), not native
`$Object`s — `Object.getOwnPropertyNames(Function.prototype)` returns **`[]`**,
which is the tell.

`$Object.$proto` is typed `ref null $Object`. Every seeding helper therefore
ends in the same two instructions — `__object_create`
(`object-runtime-prototype.ts` ~L104) does
`ref.test $Object` on its argument and stores `null` on a miss; the identical
coercion is written into `__object_setPrototypeOf` right below it. `new F()`
routes through `compileFnctorNewAsObject` (`expressions/new-super.ts` ~L1355) →
`__object_create(F.prototype)`, so a `$NativeProto` prototype silently becomes
`$proto = null` and every inherited read misses.

The per-fnctor prototype global itself is fine: `F.prototype === Function.prototype`
is **true** and `F.prototype.apply` is `"function"` after the assignment
(`.tmp/probe/h2b.js`). Nothing is lost at the WRITE; it is lost at the seed.

### Cost of closing it, and why this lane stopped

Closing it means giving `$Object.$proto` a representation that can hold a
`$NativeProto` — a second field, or a per-brand shim `$Object` materialized with
the brand's members as own closure properties — and then teaching the
`__extern_get` / `__extern_has` / `__getPrototypeOf` / `__isPrototypeOf` proto
walks to traverse it. That is the `$Object` dispatch model, touched in four
runtime helpers plus every walk.

Priced against the payoff: **a scan of all 328 remaining ES5 standalone rows
finds only these 4** using a builtin prototype as an object's `[[Prototype]]`
(`.tmp/scanproto.mjs`; the regex catches `X.prototype = <Builtin>.prototype`,
`Object.create(<Builtin>.prototype)`, `setPrototypeOf(_, <Builtin>.prototype)`
and `X.prototype = Function(…)`).

Two cheaper shapes were considered and rejected **as measured, not as guesses**:

- **Seed the fnctor prototype global with a materialized `$Object` when the RHS
  is syntactically `<Builtin>.prototype`.** It would flip these 4 — and it would
  make `F.prototype === Function.prototype` go **false**, trading a passing
  identity for a passing typeof. It also has to seed a `bind` property whose
  value cannot be built (`Function.prototype.bind` still refuses loud in
  standalone).
- **Answer `obj.apply` by a compile-time fold** keyed on the recorded prototype
  assignment. That is the same fold-instead-of-carrier move that produced the
  divergence documented above — `hasOwnProperty("apply")` true while
  `getOwnPropertyNames()` is empty. Adding another fold deepens the hole the 4
  rows are a symptom of.

So the boundary is: **the 4 rows are reachable only behind a `[[Prototype]]`
representation change, and the whole ES5 standalone gap behind that change is
those same 4 rows.** Worth doing when the `$Object` proto model is opened for
another reason; not worth opening it for.

## Wave-4 lane J — slice J1: the UNBACKABLE end of the array-index domain (2026-08-21)

Base `da724268b0`, `--target standalone`, in-process `runTest262File` probe.

### The defect

`vec-index-domain.ts` (#4434) established the model the whole vec family now
uses: `vec.length` is LOGICAL, the backing `$data` array may be shorter, and
every index in `[capacity, length)` is a HOLE. The READ side
(`vec-oob-read.ts`) and the `a.length = N` SETTER honour it. The element-STORE
side and `new Array(n)` did not — both unconditionally sized the backing to the
requested index/length, so three ordinary ES5 boundary idioms aborted the whole
module with an **uncatchable Wasm trap**, not a wrong answer:

| source                  | measured on base                                  |
| ----------------------- | ------------------------------------------------- |
| `x[2147483648] = 1`     | trap `array element access out of bounds`         |
| `x[4294967294] = 1`     | trap `array element access out of bounds`         |
| `new Array(4294967295)` | trap `requested new array is too large`           |
| `x[k-2] = k`, k = 2**32 | trap `requested new array is too large`           |

Two independent causes, both fixed:

1. **The index comparisons were SIGNED.** The index local holds a u32 bit
   pattern (index `2**32-2` arrives as `-2`), so `idx >= capacity` answered "no"
   and `array.set` ran out of bounds; `idx + 1 > vec.length` answered "yes" for
   an array whose length is already a huge u32, clobbering it downward.
2. **A numeric-literal index above `i32.MAX` SATURATED.**
   `tryEmitStaticI32Expression` refuses anything over `0x7fffffff` and the
   generic `compileExpression(key, {kind:"i32"})` fallback lowers it through
   `i32.trunc_sat_f64_s` → `2147483647`. That silently renamed the index:
   `x[2147483648] = 1` set `length` to `2147483648` where §10.4.2.2 requires
   `2147483649`, and `x[4294967294]` collapsed onto `x[2147483647]`'s slot.

### The change

New module `src/codegen/vec-sparse-index.ts` holds every body:
the unbackable-index flag, the three guard-condition builders, the guarded
element store, and the `new Array(n)` length/capacity split. The two call sites
(`expressions/assignment.ts` vec arm, `expressions/new-indexed.ts` Array arm)
gain dispatch only, and `array-nonindex-key.ts::compileElementIndexI32` gains
one arm for the high numeric literal. **No LOC / func / coercion / oracle
allowance was needed** — all four gates pass clean.

The ceiling is `16777216`, numerically identical to `SAFE_GROW_CEILING` in
`array-length-define.ts`, deliberately: an index write and a `length` write must
not disagree about which lengths are backed.

### Measured

Rows flipped `fail → pass` (2 of the 4 in the bucket):

| row                                        | before                             | after |
| ------------------------------------------ | ---------------------------------- | ----- |
| `built-ins/Array/S15.4.5.2_A1_T1`          | trap: element access out of bounds | PASS  |
| `built-ins/Array/length/S15.4.2.2_A2.1_T1` | trap: new array too large          | PASS  |

Control: **112 / 112 pass, zero regressions** — the passing neighbours of
`Array/prototype/{join,push,pop,slice,indexOf,map,forEach,sort,splice}`,
`Array/length`, `built-ins/Array`, `language/statements/for-in`, `Object/keys`
and `JSON/stringify` (the 112 rows of a 196-candidate sweep that pass on base).
Sparse-tail reads were separately verified: after `a[20000000] = 9` on a
3-element array, `a.length` is `20000001` and `a[0]`, `a[5]`, `a[19999999]`,
`a[20000000]` and the dynamic `a[i]` forms all answer correctly (no trap).

### Deliberate trade

A store at an index in `(16.7M, 2**32-2]` now LOSES its value (the slot becomes
a hole) where before it allocated a backing that large and kept it. That
exchanges a working-but-memory-hostile case for a whole class of terminal traps,
and it matches the rule `array-length-define.ts` already applies to the same
decision. No control row exercised it.

### Declined in this bucket, with reasons

- **`built-ins/Array/S15.4_A1.1_T10`** — needs genuine SPARSE element STORAGE:
  it writes and then reads back `x[k-2]` for `k = 2, 4, …, 2**32`, so indices
  `2147483646` and `4294967294` must round-trip a value. A hole cannot. This is
  the value-representation wall, not a guard bug. It no longer traps at the
  STORE; it now fails at the read of the unbacked index.
- **`built-ins/Array/length/S15.4.5.2_A3_T4`** — blocked by a **pre-existing,
  unrelated** module-scope defect that this slice did not introduce (verified by
  file-copy A/B against `da724268b0`): at MODULE-GLOBAL scope, an out-of-range
  index store combined with a `length` assignment corrupts ordinary element
  reads.

  ```js
  var x = [0, 1, 2];
  x[1];            // 1
  x[100] = 7;
  x.length = 2;
  // …but with BOTH statements present in the module, the FIRST read above
  // already answers `undefined` on base and after.
  ```

  The same code inside a function expression is correct, and either statement
  alone is correct. Not diagnosed further — it is a separate carrier/lowering
  choice for module-global arrays, outside this slice.

## Wave-4 lane J — slice J2: a join HOLE may inherit `Array.prototype[k]` (2026-08-21)

Base `1dfa99b78a` (slice J1), `--target standalone`.

### The defect

§23.1.3.18 step 4.b renders an ABSENT index as the empty string — but "absent"
is `Get(O, ToString(k))`, a full [[Get]] **with the prototype walk**, not "this
array's backing has no slot there". The #3224 bounds guard in
`compileArrayJoinNative` conflated the two: every index past the physical
backing joined as `""`, unconditionally. So the read path and `join` disagreed
about the same index:

```js
Array.prototype[1] = 1;
var x = [0]; x.length = 2;   // index 1 is a hole in x's backing
x[1];                        // 1     — the #4159 routed read already walks the chain
x.hasOwnProperty("1");       // false — correct, it is inherited
x.join();                    // "0,"  — expected "0,1"
x.toString();                // "0,"  — toString IS join
```

### The change

New module `src/codegen/array-join-proto-hole.ts`: the gate, the native
registration + scratch local (`ensureJoinProtoHoleLocal`), and the replacement
`else` arm, which re-asks `__extern_get_idx` — the SAME prototype-aware indexed
[[Get]] the routed element read uses, so the two cannot answer differently — and
still renders `""` when the walk finds nothing.

`compileArrayJoinNative` gains one import line, one arming call and the `else:`
swap (+5 LOC, allowance recorded above). The arming call must be in that
function: it has to run BEFORE the existing `externToStrIdx` capture or that
index shifts underneath it (#2043).

Gate: `ctx.standalone && ctx.protoIndexDirty` — the #4160 pre-scan flag, set
only by a module that writes an INDEX onto `Array.prototype` /
`Object.prototype`. With the flag clear, a hole cannot inherit anything, `""` is
exactly right, and the fold is byte-identical. The arm also only replaces the
`else` of a guard that already existed, so a DENSE array never reaches it.

### Measured

| row                                          | before | after |
| -------------------------------------------- | ------ | ----- |
| `built-ins/Array/prototype/toString/S15.4.4.2_A3_T1` | `"0,"` | PASS  |

Controls, both file-copy A/B against `1dfa99b78a`:

- The 112-row passing-neighbour set: **112 / 112, unchanged.**
- **The exact blast radius** — all 150 files under `built-ins/Array/**` that
  write `Array.prototype[…]` or `Object.prototype[…]`, i.e. every file that
  turns this gate on: 65 pass after, 85 fail after. Running the 85 on base:
  **85 / 85 also fail there** (no regression). Running the 65 on base: **64
  pass, 1 fails** — and that one is `toString/S15.4.4.2_A3_T1`, the intended
  flip. One row moved, in one direction.

### Declined in the same family, with reasons

- **`concat/S15.4.4.4_A3_T{1,2,3}`** — the same inheritance question for
  `concat`, and a gate routing a typed vec receiver to the existing §23.1.3.1
  loop (`array-concat-spec.ts`, prototype-aware via `__extern_get_idx`) was
  built and measured. It advances all three (`arr[1]` goes `0 → 1`, which is
  correct) but flips **none**, because each then needs one of two things this
  slice does not deliver, so it was NOT kept:
  - `A3_T1` asserts `arr.hasOwnProperty("1") === true` on the result. The loop
    returns an `$ObjVec`, and `__hasOwnProperty` (object-runtime.ts) has arms
    for `$Object` and the carrier bag but none for `$ObjVec` — measured
    `c.hasOwnProperty("0") === false` while `0 in c === true` on a freshly
    concatenated result.
  - `A3_T2`/`A3_T3` assert `b[1] === undefined`. `b` is statically `number[]`,
    so the read lowers to f64 and `undefined` arrives as `NaN`. That is the
    value-representation wall, not a concat bug.
- **`toLocaleString/S15.4.4.3_A{1_T1,3_T1}`** — `toLocaleString` is not aliased
  "by accident": `array-methods.ts` routes `case "toLocaleString"` into
  `compileArrayJoin` deliberately (#2863 Phase 2, "the locale-independent
  default is the same comma-join"). §23.1.3.32 requires
  `Invoke(element, "toLocaleString")` per element, which is a new fold, not a
  gate — J2's hole arm does not help, since the elements here are present.
- **`filter/15.4.4.20-9-b-{7,11,14,15}`**, **`toString/S15.4.4.2_A1_T2`**,
  **`concat/S15.4.4.4_A1_T{2,4}`** — the f64-hole value-representation wall.
  Direct measurement on `[0, , 2]` with `Array.prototype[1] = 1` set: the
  callback receives `NaN` at index 1 and the index is COUNTED, because the array
  is an f64 vec whose hole is a real `NaN`/`0` in the backing and
  `__extern_has_idx` therefore answers 1. `$Hole` exists only for externref
  vecs. Nothing above the value representation fixes these.

## Wave-5 standing-team dispatch plan (2026-08-21, base `c3522cad12`)

Model change by project-lead order: a STANDING team of four Opus lanes fed from
the TaskList, instead of per-wave fire-and-forget dispatch. The tech-lead
session files/updates the implementation plans here and in the sibling issue
files, keeps the TaskList stocked, integrates each lane's worktree serially
(gates as commit blockers), and re-measures.

| lane | task | rows | plan seed |
| --- | --- | ---: | --- |
| T1 | transferred builtin calls — `Array.prototype.X.call(plainObj)`, `String.prototype.{split,slice,substring,trim}` on non-String receivers, transferred `String.fromCharCode` closure | 16 (`.tmp/wave5-T1.txt`) | lane J re-fenced 4 Array rows here (its filter/9-b-2 isolation proves the non-transferred core passes); #2875 sizes the String half as its own L-slice (split/concat reflective glue bodies); lane F measured the fromCharCode pair (value survives, `typeof` right, no wired closure body — needs a static-method-body slice + [[Construct]] refusal). transferred-native-proto-call.ts (wave-3 salvage) is the existing machinery to extend. |
| T2 | Object descriptor/introspection residual — defineProperty (19), defineProperties (6), keys/gOPN/gOPD/freeze/isFrozen/valueOf/prototype | 60 (`.tmp/wave5-T2.txt`) | the wave-2/3 MOP slices closed everything whose cause lived in object-ops.ts/object-runtime-descriptors.ts; what remains is per-row: verify each against current head FIRST (list predates ~50 landed fixes), bucket by error, expect accessor-on-builtin-proto, global-object rows, arguments-object defines. |
| T3 | harness-blocked rows (10) + instanceof (6) + assignment (5) | 21 (`.tmp/wave5-T3.txt`) | harness rows fail inside propertyHelper/compareArray machinery — fix the underlying primitive each one exercises, never the harness. instanceof: lane A landed boolean branding; residual is builtin-namespace-carrier edges. |
| T4 | function-code (12) + annexB function-code (4) + statements/variable (3) + expressions in/addition/call/object (12) | 31 (`.tmp/wave5-T4.txt`) | function-code rows overlap the strict poison pills (provider-realm wall — measure and fence, don't fight) and arguments aliasing; annexB is sloppy-mode function semantics. |

Known walls the team must NOT re-attempt without a design change (measured
verdicts already on record above): f64-hole value representation ($Hole is
externref-only), provider-realm carrier identity, [[Prototype]] slot typing
($Object.$proto vs $NativeProto — priced at exactly 4 rows), toLocaleString
per-element Invoke fold, `arguments` isArray branding, #2151 computed-key
dispatch-model change.

Owed follow-up issues surfaced by wave 4 (file when a lane touches the area):
module-global array-carrier corruption (x[100]=7 + x.length=2 at module scope,
lane J), $ObjVec arm for __hasOwnProperty (lane J's concat gate blocker),
ToString-of-object user-toString dispatch (#1472, 6 rows + lane F's
String()-vs-call divergence).

### Wave-5 T1 result (2026-08-21, lane team-dev-1, base `0e71b59ed3`)

**Rows: 2/16 at start, 2/16 at end — no row flipped.** Both passing rows
(`fromCharCode/S15.5.3.2_A1`, `substring/S15.5.4.15_A1_T5`) already passed on
the branch base; the 14 failures were each re-verified on this HEAD before any
edit. Two mechanisms landed, each with a control run; every remaining row is
priced below.

| commit | change | control |
| --- | --- | --- |
| `b865397216` | transferred-proto ASSIGNMENT resolution + `Object.prototype.toString` transfer emitter | 60/60 |
| (this commit) | §20.1.3.6 `Math` / `JSON` namespace tag | 45/45 Math+JSON, 60/60 T1 neighbours, 42/45 toString-family (the 2 FAILs are pre-existing — verified by file-copy A/B against the base file) |

#### What the assignment arm fixed, and why it flipped nothing

Wave-3's `transferred-native-proto-call.ts` resolves a transfer written through
an object LITERAL. Every Sputnik-era genericity test writes it as an
ASSIGNMENT, which that module declines on purpose. Measured on the base:

| probe | base | now |
| --- | --- | --- |
| `var o={}; o.split=String.prototype.split; o.split()` | THREW `TypeError: Cannot access property on null or undefined` | `["[object Object]"]` ✓ |
| `var x={}; x.getClass=Object.prototype.toString; x.getClass()` | THREW same | `"[object Object]"` ✓ |
| `var a=[1,2]; a.g=Object.prototype.toString; a.g()` | THREW same | `"[object Array]"` ✓ |

The idiom now works. No T1 row flips on it alone because each row has a
SECOND, independent blocker behind the transfer — which the arm made visible:
the concat pair's error moved from the null-funcref TypeError to
`Array.prototype.concat is not yet callable as a value in --target standalone`,
naming the real gate (the owed `$ObjVec`-arm follow-up).

#### Per-row verdict for the 14 failures

| rows | blocker | verdict |
| --- | --- | --- |
| `concat/S15.4.4.4_A2_T{1,2}` | `Array.prototype.concat` has no value-callable body | the owed `$ObjVec` follow-up; the transfer half is now done |
| `split/instance-is-math` | the split receiver's ToString runs through `$__any_to_string` at RUNTIME, which has no static tag. The compile-time classifier now answers `Math` (`Object.prototype.toString.call(Math)` and `String(Math)` both correct), but the borrowed-receiver path does not consult it | needs `emitBorrowedStringReceiverToString` to fold a statically-known namespace receiver; NOT safe as a blanket object rule (an object with a user `toString` must dispatch to it) |
| `slice/S15.5.4.13_A3_T4`, `slice/S15.5.4.13_A1_T5` | ToString-of-object must call the receiver's USER `toString` | the owed #1472 follow-up |
| `trim/15.5.4.20-2-51` | `ToString(arguments)` answers `"1,2,true"` (array join) instead of `"[object Arguments]"` | the `arguments` isArray-branding WALL — do not re-attempt |
| `split/argument-is-regexp-and-instance-is-number` | transfer target is `Number.prototype`, not a variable | out of the assignment arm's shape by design |
| `split/arguments-are-boolean-…-instance-is-boolean` | `new Boolean` receiver + THREE args drops the `limit`; the same call with two args, or with a `{}` receiver and three, is correct | narrow wrapper-receiver arity edge, isolated but not fixed |
| `split/instance-is-number-1e21` | `new Number(-1e21)` receiver — "called value is not a function" | wrapper-receiver transfer, unpriced |
| `split/separator-regexp-limit-string-via-eval` | eval-dependent | unpriced |
| `filter/15.4.4.20-9-b-2` | `Cannot redefine property: configurable attribute of a non-configurable property` | unrelated to transfers; belongs with the T2 descriptor lane |
| `forEach/15.4.4.18-3-23` | `testResult !== true` | unrelated to transfers |

#### `String.fromCharCode` as a value — ATTEMPTED, NOT LANDED (full diagnosis)

The two `fromCharCode` rows need the extracted value to be CALLABLE. The
attempt was reverted, but the root cause is fully measured and the next lane
should not re-derive it:

1. The `default:` arm of `ensureStandaloneBuiltinStaticMethodClosure` reifies
   the value at its DECLARED arity (one). A four-argument call matches no
   funcref candidate, so the guarded `ref.cast` yields null and the failure
   (`TypeError: Cannot access property on null or undefined`) arrives from the
   DISPATCH — the body never runs. A variadic body on the `Math.max`
   `(ref null $vec_externref) -> externref` convention is the right shape.
2. **`resolveBuiltinStaticBindingAlias` only recognises the DESTRUCTURING
   spelling** (`const { ownKeys } = Reflect`). The plain
   `var f = String.fromCharCode` resolves to `undefined`, so the call site
   falls back to the TypeScript lib signature.
3. That fallback is what destroys the arguments. For a rest-parameter static
   the lib signature's single slot is a `number[]` vec, and the generic
   slot-by-slot loop compiles argument 0 against it. The emitted WAT for
   `String.fromCharCode(97)` is literally `f64.const 97` / `drop` /
   `ref.null 4` — evaluated, discarded, replaced by a null vec. Measured
   `f(97, 98)` answered NUL + `"b"`: argument 0 destroyed, argument 1 intact
   only because it overflowed into the separately-boxed extras path.
4. A fourth defect sits behind those: the #2933 variadic call-site arm coerces
   its externref result for `f64`/`i32` and passes `externref` through, but
   DROPS every other expected type and pushes a default. That never showed
   because `Math.max`/`Math.min` return numbers; a reified `fromCharCode`
   returns `string`, which lowers to `(ref $AnyString)`, so `f(97)` answered
   `undefined` with the correct `"a"` computed and thrown away.

So the slice is four coupled fixes (variadic body, plain-alias resolution,
argv-slot construction at the call site, ref-typed return recovery), not one.
`S15.5.3.2_A4` additionally needs a `[[Construct]]` refusal on the reified
value. Sized L, not S — the "static-method-body slice" estimate in the wave-5
seed was low.

**`Math.max` as a value works today only because its arguments survive the same
mis-compiled slot by accident of being numbers.** Anyone touching the variadic
convention should treat that as unowned behaviour, not as a working reference.

---

## Wave-5 T3 result — harness + instanceof + assignment (2026-08-22, lane w5-t3)

**Rows: 21 in `.tmp/wave5-T3.txt`. 1 already passing at base, 5 BLOCKED on
infrastructure, 3 flipped by this lane, 11 priced below.** Every row was
re-verified on this lane's own head before any edit; every figure is a run this
lane executed, `--target standalone`, serial single-test probes, base-vs-after
by file-copy A/B (`.tmp/ab/*.base.ts`), never `git stash`.

| row | base | after |
| --- | --- | --- |
| `language/expressions/assignment/S11.13.1_A2.1_T1` | fail — `#1: x = 1; x === 1. Actual: 0` | **pass** |
| `language/expressions/instanceof/S11.8.6_A2.1_T3` | fail — `Actual: [object Object]` | **pass** |
| `language/expressions/instanceof/S11.8.6_A2.4_T4` | fail — `(OBJECT = Object, {}) instanceof OBJECT !== true` | **pass** |
| `harness/deepEqual-primitives` | fail | **pass, then REVERTED — see "Symbol typeof" below** |
| `language/expressions/instanceof/S11.8.6_A1` | pass | pass (already passing at base — not counted) |

### Landed slice 1 — a top-level write that precedes its own `var` was DROPPED

`shouldCollectTopLevelAssignment` (declarations.ts) decides whether to keep a
top-level `x = 1` by asking `ctx.moduleGlobals.has("x")` — a set the SAME single
pass over `sourceFile.statements` is still filling. So an assignment textually
before its own `var x` was answered "not a module global" and the whole
statement was dropped from `__module_init`. Tenth instance of the #3623
silent-drop family; the shape was already on the allow-list, so what was missing
is the FACT, not another arm.

| probe | base | after |
| --- | --- | --- |
| `x = 1; if (x !== 1) throw …; var x = 1;` | `CHECK1 x=0 typeof=number` | `ALLOK x=1` |
| `x = 1; var x;` (no initializer) | `NOINIT x=undefined` | still `undefined` — see residual below |

The no-initializer probe is what rules OUT an "initializer ordering" reading:
the statement is gone, not reordered.

New module `src/codegen/top-level-hoisted-var-names.ts` pre-scans the file for
names bound by a top-level `var` (hoisting through blocks / `if` / loops /
`try` / `switch` / labels / `with`, stopping at every function and class
boundary), cached per source file; declarations.ts gets one dispatch line.
`let`/`const` are deliberately excluded — a write before those is a TDZ
ReferenceError, so emitting the write would be a worse wrong answer than the
current drop.

**Controls:** 378 rows (assignment + instanceof + comma + statements/variable +
global-code) 285 → 286, the single transition being the target row; a second
220-row sample (statements/for + expressions/object + Object.defineProperty)
IDENTICAL both sides.

**Residual, NOT fixed:** `x = 1; var x;` still reads `undefined` after the
write is collected — so a second defect sits behind this one: a `var` with NO
initializer appears to re-store `undefined` over an existing binding, which
§14.3.2.1 forbids (a redeclaration of an existing var binding performs no
initialization). Not attempted here; it is a separate statement-emission
question and no row in this lane's set depends on it.

### Landed slice 2 — `instanceof`'s RHS was never evaluated (§13.10.1 step 3)

`compileHostInstanceOf`'s conservative arms compile the LHS, drop it, and push
`i32.const 0` without ever compiling the RHS. §13.10.1 evaluates the
ShiftExpression and **GetValues** it, and GetValue on an unresolvable Reference
is a ReferenceError.

| probe | base | after |
| --- | --- | --- |
| `({}) instanceof UNDECLARED_XYZ` | `false`, no throw | ReferenceError ✓ |
| `var v = UNDECLARED_ABC` | ReferenceError ✓ | unchanged |
| `var w = UNDECLARED_DEF + 1` | ReferenceError ✓ | unchanged |

So the identifier lowering already threw correctly everywhere the operand was
actually compiled — only `instanceof`'s RHS was skipped. New module
`src/codegen/instanceof-rhs-evaluation.ts`; two call sites in identifiers.ts,
each between the LHS drop and the constant so the observable order is the
spec's. **Controls:** the same 378-row set 286 → 287 (single transition = the
target row), plus a 213-row instanceof-sensitive set
(`Function.prototype[Symbol.hasInstance]`, class/subclass, Error, TypeError)
IDENTICAL both sides.

### Landed slice 3 — the ASSIGNED builtin-constructor alias

`resolveBuiltinCtorAliasName` (native-ordinary-instanceof.ts, #2916) resolves a
DECLARED alias from the binding's static type, whose lib.d.ts shape is the
nominal `ObjectConstructor`. Two spellings have no such type to read:

| spelling | base | after |
| --- | --- | --- |
| `var C = Object; o instanceof C` | `true` ✓ | `true` |
| `OBJECT = Object; o instanceof OBJECT` (implicit global — no declaration) | **`false`** | **`true`** |
| `var OBJECT = 0; OBJECT = Object; o instanceof OBJECT` (union type) | `false` | `false` — declines, by design |
| `o instanceof (o2 = 0, Object)` (comma RHS) | `false` | `false` — out of shape |

New module `src/codegen/builtin-ctor-assigned-alias.ts` answers a different
question from the type-based one: not "what type does the checker give this
binding" but "what values does this FILE ever write into this spelling". When
every write supplies the SAME builtin constructor, the name holds that
constructor at every point where it reads without throwing — a read before the
first write is an unresolvable reference and throws ReferenceError instead. The
scan disqualifies a spelling on a compound assign / `++` / `--` / `delete`, a
parameter / catch / binding element / `for-in` loop variable, a function or
class declaration, an initializer-less declaration, an assignment whose RHS is
not a bare identifier, or two writes naming different builtins. Host-free only.

**That is deliberately weaker than row three above**, which is why
`S11.8.6_A2.4_T1` does not flip: its `var OBJECT = 0` contributes a
second, non-constructor source, so the spelling is not uniform. `T1`'s CHECK#2
needs something else again — the LHS spilled to a temp BEFORE the comma's
leading operands run, then instanceof dispatched on the comma's LAST operand.
Slice 2 makes those side effects happen in the right order; the answer still
falls to the conservative `0`. Both are runtime-RHS problems, not static-fold
problems.

Flips `S11.8.6_A2.4_T4` fail → pass. **Controls:** the 378-row set 287 → 288
(single transition = the target row); the 213-row instanceof-sensitive set and a
200-row sample of `Object.prototype` + `Array.prototype.concat` + `Function`
both IDENTICAL to the pre-slice run.

### ATTEMPTED AND REVERTED — `typeof <symbol>` through a dynamic slot

**This is a REAL defect with a complete diagnosis. It was implemented, measured,
and then reverted because the fix cascades into the `$Object.$proto` wall. The
next lane should start from these measurements, not re-derive them.**

The defect: a symbol reaching `typeof` through a dynamic slot (a parameter, an
`any` local, an object field) answers `"object"`. The compile-time fold answers
`"symbol"`. That is the #2984 path-dependence class.

| probe | base |
| --- | --- |
| `var s = Symbol(); typeof s` | `"symbol"` (fold) |
| `(function (v) { return typeof v; })(s)` | **`"object"`** |
| `(function (v) { return typeof v === "symbol"; })(s)` | **`false`** |
| `(function (v) { switch (typeof v) { case "symbol": … } })(s)` | takes `default` |

Two natives are missing the case, and there is **no `__typeof_symbol` predicate
at all** — `object-runtime-proxy.ts` looks the name up in `ctx.funcMap`, but
nothing ever registers it, so that lookup has always returned `undefined`:

- `__typeof` (the MATERIALIZED tag; also what `typeof x === "symbol"` falls back
  to comparing, since there is no predicate) classifies null / number / boolean
  / bigint / string / function and falls through to `"object"`.
- `__typeof_object` answers 1 for the `$Symbol` carrier, so a symbol is BOTH
  not-a-symbol and an object. `native-object-family-instanceof.ts` already
  documents this and subtracts the carrier at its own call site.

**What it costs, measured:** upstream `deepEqual.js` routes on
`switch (typeof value) { … case 'symbol': return true }` inside
`isPrimitiveEquatable(value)` with `value` a parameter. Every symbol therefore
missed the primitive arm, was admitted by `isObjectEquatable` (`typeof value
=== 'object'`), and two DISTINCT symbols compared structurally EQUAL — so
`harness/deepEqual-primitives.js`'s `assert.throws(Test262Error, … deepEqual(s1,
s2))` saw no throw. A second symptom on the same row:
`assert.deepEqual(s1, "Symbol()")` threw `TypeError: Reflect.ownKeys called on
non-object` from the format path.

**The two-arm fix works and was measured** (splice the `$Symbol` `ref.test` into
`__typeof` → `"symbol"` and into `__typeof_object` → 0, at the same finalize
point as the closure arms, keeping `hasSymbolCarrier` alive as its own reason to
run the pass). On a 298-row control (built-ins/Symbol + expressions/typeof +
gOPS/gOPN + all of harness/ + the T3 rows): **+2** (`harness/deepEqual-primitives`,
`harness/verifyProperty-desc-is-not-object`), **−1**
(`language/expressions/typeof/symbol.js`).

**Why the −1, and why it is not a trade you may take.**
`language/expressions/typeof/symbol.js` asserts BOTH `typeof Symbol() ===
"symbol"` AND `typeof Object(Symbol()) === "object"`. It passed at base for the
wrong reason: standalone `Object(sym)` returns the symbol UNCHANGED (the
`isSymbolType` arm of `emitObjectCoercion` is gated `!noJsHost` and there is no
standalone arm), and the runtime tag for everything unclassified was `"object"`.
Teaching `typeof` the symbol tag makes that accident visible.

**The wrapper fix was then implemented and ALSO reverted.** Building
`Object(sym)` as the ordinary `$Object` + [[PrimitiveValue]] slot every other
standalone wrapper uses (a `__new_Symbol_object` native next to `__new_String`,
`"Symbol"` added to `StandaloneWrapperConstructorName`, and `"symbol"` added to
`isPrimitiveObjectCoercionCall`) gives the right answers in isolation:

| probe | after wrapper |
| --- | --- |
| `typeof Object(Symbol())` | `"object"` ✓ |
| `Object(s1) === s1` | `false` ✓ |
| `Object(s1) instanceof Symbol` | `true` ✓ |
| `s1 instanceof Symbol` | `false` ✓ |
| `Object(s1).valueOf() === s1` | `true` ✓ (statically-typed receiver) |
| `Object(s1) instanceof Object` | `true` ✓ |

…and still loses `deepEqual-primitives`, now with
`TypeError: Object.prototype.valueOf is not yet implemented in --target
standalone`. **Root cause of THAT, measured:** `__dyn_valueOf`
(wrapper-valueof.ts) probes the receiver's `valueOf` PROPERTY first and only
then the [[PrimitiveValue]] slot. Its docstring justifies that order with
"standalone ships no `Boolean.prototype.valueOf` object, so an own `valueOf`
and the intrinsic cannot both be present" — an assumption the symbol wrapper
breaks: the lookup reaches a reified `Object.prototype.valueOf`, whose glue
(`array-object-proto.ts` → `emitProtoMemberBodyRefusal`) is the catchable
"not yet implemented" throw, and arm 1 calls it. `Object(1)` / `Object("a")`
escape this only because a STATIC receiver-type arm answers them before
`__dyn_valueOf` is reached.

**So the honest ordering of the remaining work is:**

1. the symbol wrapper needs `[[Prototype]] = Symbol.prototype`, which is the
   known `$Object.$proto` vs `$NativeProto` wall — do not re-attempt without a
   design change; or
2. `__dyn_valueOf` is restructured to OWN-property → slot → inherited-property
   → self (today: any-property → slot → self). That is spec-equivalent for
   every case it handles now, since a wrapper never has an own `valueOf`, and
   it is the smaller of the two. It changes a helper every dynamic `.valueOf()`
   goes through, so it needs its own control run; or
3. `Object.prototype.valueOf` gets a real wired body (§20.1.3.7 `ToObject(this)`
   — for an object receiver, `this`) instead of the refusal. Cheap on its own
   and useful beyond symbols, but on its own it does NOT fix `deepEqual`: arm 1
   would then return the wrapper instead of the primitive.

Sized **L, not S** — four coupled surfaces (typeof natives, `Object()`
coercion, wrapper-instanceof, valueOf dispatch), the same shape T1 recorded for
`String.fromCharCode` as a value. Nothing from this attempt is committed; the
lane's tree is back to the two landed slices.

### BLOCKED — 5 rows need the quickjs eval provider, which does not build

`harness/assert-throws-same-realm`, `harness/asyncHelpers-throwsAsync-same-realm`,
`harness/detachArrayBuffer-host-detachArrayBuffer`,
`harness/wellKnownIntrinsicObjects`, `language/expressions/instanceof/S11.8.6_A6_T4`
all fail with `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not
built`. `node scripts/build-quickjs-eval-provider.mjs` fails its
`functionParityProbe` canary: returns **1**, expected 11 — i.e.
`constructorIdentity = 0`, a QuickJS-created `new Function(…)` value has lost
`.constructor === Function`. Verified by file-copy A/B (reverting the wave-5
`%Function%` own-props commit's source changes) that this **predates** that
commit. Because the adapter's cache key folds the compiler-bundle hash, ANY
`src/` edit invalidates the cached adapter, so this blocks every eval-dependent
row in every lane that touches the compiler. Routed to the lead as its own task.

**Trap worth keeping:** the build script exits **0** when piped
(`… | tail`) even though the canary threw — the shell reports `tail`'s status.
Run it bare.

### Per-row verdict for the 11 remaining failures

| rows | blocker | verdict |
| --- | --- | --- |
| `harness/deepEqual-primitives` | symbol `typeof` (above) | measured, implemented, reverted — sized L |
| `harness/deepEqual-mapset` | `assert.deepEqual(new Set(), new Set())` says `Expected Map {} to be structurally equal to Map {}` — two empty Sets compare unequal AND format as `Map` | not attempted; Set/Map structural comparison + `@@toStringTag`, own slice |
| `harness/asyncHelpers-asyncTest-return-not-thenable` | `doneValues` all `false` where all `true` expected | async-harness, not attempted |
| `harness/asyncHelpers-asyncTest-{returns-undefined,then-rejects,then-resolves}` | `Test262:AsyncTestFailure:Test262Error: [object Object]` | async-harness; the `[object Object]` payload means the failure reason itself does not stringify — worth fixing first, it is hiding the real errors |
| `language/expressions/assignment/S11.13.1_A6_T{1,2}` | `x = (eval("var x;"), 1)` must PutValue through the reference created BEFORE the eval introduced a nearer binding | direct-eval var injection into the caller activation — the eval wall |
| `language/expressions/assignment/S8.12.5_A2` | `var m = {1:"one"}; m[1] = 5` silently stores NOTHING: `typeof m[1]` still folds to `"string"` and the value reads `undefined` | **value-representation wall.** Measured separately: the key canonicalisation is FINE (`m["1"]`/`m[1]` are the same slot, and `{1:5}; q["1"]=7; q[1] === 7`). What fails is assigning a NUMBER into a property whose inferred type is `string` — `o.a = 5` and `p["a"] = 5` reproduce it identically on a plain key, so it is not index-specific |
| `language/expressions/assignment/8.12.5-3-b_1` | `Array.prototype.reduce = function(){}` then `gOPD(Array.prototype,"reduce").value` still reads the original | builtin-prototype method PATCH; belongs with the T2 descriptor lane |
| `language/expressions/instanceof/S11.8.6_A2.4_T1` | `var OBJECT = 0; (OBJECT = Object, {}) instanceof OBJECT` **and** `object instanceof (object = 0, Object)` | still failing — see slice 3 below for why each half declines |
| `language/expressions/instanceof/S15.3.5.3_A3_T2` | `F = Function(); F.prototype = Object.prototype; ({}) instanceof F` | needs a RUNTIME read of `.prototype` off an arbitrary callable — `native-ordinary-instanceof.ts` already documents this as deliberately not covered |

---

## Handover (T6, team-dev-4, 2026-08-22)

**Status: DONE, integration-ready. Nothing in flight, no WIP.**

- Worktree `/home/user/js2/.claude/worktrees/agent-a80e323da56cbb5eb`,
  branch `worktree-agent-a80e323da56cbb5eb`, sha **`5697b697ab`**, one commit
  on base `7dd91b7bad`. Not pushed, no PR (per the wave protocol).
- **Rows flipped: 2** — `built-ins/String/fromCharCode/S15.5.3.2_A3_T2` and
  `S15.5.3.2_A4`, both `fail → pass`. `S15.5.3.2_A1`/`_A2`/`_A3_T1` were
  already passing at base and are NOT counted.
- **Controls: 520 rows, base-vs-after by file-copy A/B — exactly 2 transitions
  (the target rows), 0 `pass → anything`.** `Math.max`/`Math.min` value and
  call rows were in the control set as required, and IMPROVED rather than
  regressed (`var m = Math.max; m(5)` 0 → 5; `var n = Math.min; n(4,2,9)`
  0 → 2 — both were already wrong at base).
- **Gates all green** at the committed sha: `check-loc-budget`,
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
  `biome lint`, `prettier --check`.
- **Next steps for an integrator:** none required. If someone wants to
  continue this line, the three deliberately-unattempted follow-ons are listed
  under "Left open" at the end of the result section below — the most
  valuable is `String.fromCodePoint` as a value (same module, needs the
  §22.1.2.2 RangeError guard).
- **Gotchas for anyone re-running the measurements in this container:**
  1. The isolation harness rebuilds this worktree's `test262` symlink farm
     between tool calls, pointing it at other (possibly dead) agent
     worktrees. Re-link it **inside the same shell invocation** as the probe:
     `rm -rf test262; ln -s /home/user/js2/test262 test262; npx tsx …`. A
     mid-sweep clobber shows up as `THREW … ENOENT … harness/*.js`, which
     looks exactly like a regression.
  2. `runTest262File` reports a status, not stdout, so value probes have to
     `throw new Error("RESULT:" + …)` to surface a computed value.

Details, tables and the per-defect walkthrough are in the result section that
follows.

## Wave-5 T6 result — `String.fromCharCode` as a callable VALUE (2026-08-22, lane team-dev-4, base `7dd91b7bad`)

**LANDED. Both target rows flipped, 0 regressions across 520 control rows.**
The four coupled defects T1 diagnosed were all real; all four are fixed, plus
the `[[Construct]]` refusal `S15.5.3.2_A4` needs. Every figure below is a run
this lane executed on `--target standalone`, serial single-test probes,
file-copy A/B against the base files (`.tmp/base-*.ts`), never `git stash`.

| row | base `7dd91b7bad` | after |
| --- | --- | --- |
| `built-ins/String/fromCharCode/S15.5.3.2_A3_T2` | fail — `TypeError: Cannot access property on null or undefined` | **pass** |
| `built-ins/String/fromCharCode/S15.5.3.2_A4` | fail — `new __fcc__func(…)` did not throw | **pass** |
| `S15.5.3.2_A1`, `S15.5.3.2_A2`, `S15.5.3.2_A3_T1` | pass | pass (already passing at base — not counted as flips) |

### T1's "Math.max works by numeric accident" was understated — it was already WRONG

Re-measured on the base BEFORE any edit (`.tmp/probe/p2.js`, a `throw`-the-
result probe because the runner reports status, not stdout):

| probe | base | after | correct |
| --- | --- | --- | --- |
| `var m = Math.max; m(1,2,3)` | `3` | `3` | 3 |
| `m(5)` | **`0`** | `5` | 5 |
| `m()` | `-Infinity` | `-Infinity` | -Infinity |
| `var n = Math.min; n(4,2,9)` | **`0`** | `2` | 2 |
| `var f = String.fromCharCode; f(97)` | THREW | `"a"` | "a" |

Argument 0 was destroyed and replaced by a null vec, which the fold read as
`0`. `max(1,2,3)` survived only because `max(-Inf, 0, 2, 3) === 3`; `max(5)`
and every `min` did not. So this slice **fixes** the Math value rows rather
than risking them — but the risk direction the task named was right, and both
`Math.max`/`Math.min` value AND call rows are in the control set below.

### The five fixes

1. **(a) Variadic body** — new module `src/codegen/string-fromcharcode-value-read.ts`.
   `String.fromCharCode` now reifies on the SAME #2933 convention as
   `Math.max`/`Math.min`: one `(ref null $vec_externref)` args param →
   `externref`. All three therefore share ONE lifted func type, so the single
   `ref.test` arm in `call-identifier.ts` serves them all and `call_ref` picks
   the body from the funcref value. Per element:
   `__any_from_extern` → `__any_to_f64` (engine ToNumber) → §7.1.8 ToUint16 in
   the f64 domain → `__str_fromCharCode` → `__str_concat` fold. Null/empty vec
   → `""` (§22.1.2.1). Degrades to the Phase-3 catchable-TypeError body when
   the native-string or any-value substrate is unavailable.
   `builtin-value-read.ts` gets dispatch wiring only.
2. **(b) Plain-alias resolution** — new module
   `src/codegen/builtin-static-plain-alias.ts`.
   `resolveVariadicBuiltinStaticPlainAlias` recognises
   `var f = String.fromCharCode` (the shape every Sputnik-era genericity test
   uses), which `resolveBuiltinStaticBindingAlias` declines because it only
   knows the destructuring spelling. **Scope is deliberately narrow: only the
   variadic-convention statics** (`Math.max`, `Math.min`,
   `String.fromCharCode` — `VARIADIC_VALUE_STATICS`). A fixed-arity static's
   lib signature does not destroy its arguments, so widening this set would be
   a behaviour change with no defect behind it and would move every such call
   off today's foreign-callable fallback. Soundness gates: the namespace
   identifier must be the ambient global, and neither the alias nor the
   namespace may be written to anywhere in the file
   (`identifierIsWrittenTo`, shared with the `isPrototypeOf` folds).
3. **(c) argv-slot construction** — `call-identifier.ts`. On a
   statically-known variadic-alias call, EVERY call-site argument now goes
   down the extras path (boxed externref) instead of one of them being
   coerced into the declared vec slot; the declared slot is padded so the
   non-variadic candidate arms stay statically valid. Two supporting edits:
   the padding loop now starts from `argLocals.length` rather than
   `expr.arguments.length` (provably identical for every pre-existing shape,
   since `argLocals.length === Math.min(expr.arguments.length, cpParamCnt)`),
   and the variadic arm skips the positional pack.
   **The non-obvious one:** once (b) lands, `matchedClosureInfo` IS the
   variadic func type, so the ordinary positional candidate arm for that type
   matched first and shadowed the variadic arm — `m(1,2,3)` answered
   `-Infinity` (an empty fold). That duplicate arm is now dropped when the
   variadic arm owns the func type. This cost one measured round-trip and is
   the single thing a re-implementer is most likely to miss.
4. **(d) ref-typed return recovery** — `call-identifier.ts`. The variadic arm
   used to `drop` every non-`f64`/`i32`/`externref` return and push a default.
   It now recovers a `ref`/`ref_null` result with `any.convert_extern` +
   `ref.cast`/`ref.cast_null` (both pure, so the arm stays dead-arm-safe).
   With (b) in place `sigRetWasm` comes from the closure and is already
   `externref`, so this is belt-and-braces on the alias path — it is the arm
   that matters for any future variadic builtin whose call site keeps a
   ref-typed expectation.
5. **`[[Construct]]` refusal** — new module
   `src/codegen/expressions/new-builtin-static-alias.ts`, dispatched from
   `new-super.ts` right after the #4246 arm. `new f(65,66)` on an alias of a
   builtin static throws a real TypeError (§10.3 — no builtin static has
   `[[Construct]]`). Measured at base: `new f(65,66)` and `new m(1,2)` both
   evaluated to `object:null` with **no throw**. **Not attempted:** the DIRECT
   spelling `new String.fromCharCode(…)` — equally non-constructable, but a
   different callee shape; left out so this arm stays measurable in isolation.

### Controls (base-vs-after, file-copy A/B, serial)

| set | rows | base | after | delta |
| --- | ---: | --- | --- | --- |
| `String/fromCharCode` + `fromCodePoint` + `Math/{max,min,abs,floor,round}` + `Object/keys` + `Array/isArray` + `language/expressions/new` + `String/prototype/split` + `Function/prototype/{apply,call}` + `language/statements/function` + `Number/isInteger` + `JSON/stringify` + `String/prototype/{charCodeAt,concat}` | 282 | 226 pass / 53 fail / 3 CE | **228 pass** / 51 fail / 3 CE | **+2 pass, 0 pass→anything** |
| `language/expressions/call` + `language/arguments-object` + `Array/prototype/{map,filter,forEach,reduce}` + `Function/prototype/bind` + `language/statements/function` + `String/prototype/replace` + `RegExp/property-escapes/generated` (the `fromCodePoint.apply` consumers) | 238 | 155 pass / 81 fail / 2 CE | 155 pass / 81 fail / 2 CE | **0 changed** |

The only two transitions in 520 rows are the two target rows. (Eight
`property-escapes` rows read `THREW` mid-sweep in one run: the isolation
harness rebuilds this worktree's `test262` symlink farm between tool calls, so
`harness/regExpUtils.js` vanished. Re-running those eight on the same tree
gave `pass` ×8. Infrastructure, not codegen — relink `test262` inside the same
shell invocation as the probe.)

### Gates

`check-loc-budget` ✓ · `check-func-budget` ✓ · `check-coercion-sites` ✓ ·
`check:oracle-ratchet` ✓ · `biome lint` ✓ · `prettier --check` ✓ · `tsc`
clean for the six touched files.

- **oracle-ratchet** was FAILING at `ctxChecker 0→2` in
  `builtin-static-plain-alias.ts`; fixed properly rather than granted —
  `ctx.oracle.variableDeclarationOf` and `ctx.oracle.declarationsOf` answer
  both queries, so the file now has zero raw-checker use.
- **coercion-sites** needed a granted allowance (`__any_to_f64` +2 in the new
  module) with dated rationale in this file's frontmatter — the same grant and
  the same reason wave-4 lane G took for `math-static-value-body.ts`: it is the
  engine ToNumber pipeline copied from the `Math.max` value body, not a
  hand-rolled matrix. §22.1.2.1 requires ToUint16(ToNumber(arg)), so
  `__unbox_number` would answer NaN for every non-Number argument.

### Files touched

| file | role |
| --- | --- |
| `src/codegen/string-fromcharcode-value-read.ts` | NEW — variadic body + `VARIADIC_VALUE_STATICS` |
| `src/codegen/builtin-static-plain-alias.ts` | NEW — plain-alias resolver (oracle-only) |
| `src/codegen/expressions/new-builtin-static-alias.ts` | NEW — `new <alias>` TypeError |
| `src/codegen/builtin-value-read.ts` | dispatch wiring only (case + body arm + variadic publish) |
| `src/codegen/expressions/call-identifier.ts` | call-site wiring: alias lookup, argv routing, arm skip, ref return |
| `src/codegen/expressions/new-super.ts` | dispatch wiring only (one arm call) |

### Left open (deliberately, with reasons)

- `new String.fromCharCode(…)` — the direct spelling (see fix 5).
- `String.fromCodePoint` as a callable value — the same shape, and the module
  is written so a second case is a small addition, but §22.1.2.2 needs the
  integral/`[0,0x10FFFF]` RangeError guard (the `.apply` lane in
  `call-builtin-static.ts` has the exact sequence to copy) and no target row
  demanded it. Not attempted, not measured.
- Widening `VARIADIC_VALUE_STATICS` / the plain-alias resolver to fixed-arity
  statics. Would move every `var k = Object.keys; k(o)` off the
  foreign-callable `__apply_closure` fallback onto the closure signature. That
  may well be an improvement; it is a separate change that needs its own
  control run, and it was NOT measured here.
- A genuinely dynamic variadic callee (`var m = cond ? Math.max : foo; m(1,2)`)
  still packs the mis-compiled declared slot as argument 0 — the alias gate is
  static. Unchanged from base, not a regression, and the general fix is the
  rest-parameter-aware argument loop (`compileRestClosureArguments` already
  exists in `calls-closures.ts` for real closures) rather than more special
  cases.

---

## Wave-4 lane H — the `arguments`-extras residual (2026-08-21, base `da724268b0`)

Four target rows were handed over as one head ("extras beyond the formals").
They were three unrelated defects plus one already-fixed row. Measured on the
integration base BEFORE any edit, `--target standalone`, serial single-test
probes:

| row | base | cause |
| --- | --- | --- |
| `language/statements/function/S13.2_A2_T1` | fail — null deref in `__module_init` | synthetic-rest signature (slice H1) |
| `language/statements/function/S13.2_A2_T2` | fail — same | synthetic-rest signature (slice H1) |
| `language/statements/function/S13.2.2_A5_T1` | **pass** | already closed by wave-3 lane D; no work needed |
| `language/statements/function/S13_A11_T4` | fail — `delete arguments[i]` did nothing | runtime-index delete (slice H2) |
| `language/statements/function/S13_A2_T2` | fail — `x === 2`, want `"11"` | dynamic `+`; NOT taken, see below |

### Slice H1 — the checker's synthetic `arguments` rest parameter

**The call/callee arity contract, measured rather than assumed.** A shape
matrix (`function` declaration vs expression × 0/1/2 formals × called
direct / through a `var` alias / through a returned closure), read as
`arguments.length` plus `typeof arguments[i]` for i in 0..3:

| shape | base | after |
| --- | --- | --- |
| 0/1/2-formal declaration, called DIRECT with 4 args | correct | correct |
| 0-formal function EXPRESSION, called direct | correct | correct |
| 0-formal, through a returned closure, 1 arg | `len=1`, `[0]` **null** | `len=1`, `[0]` string |
| 0-formal, through a returned closure, 2 args | `len=2`, `[0]` **null**, `[1]` ok | both correct |
| 0-formal, through a returned closure, 0 args | `len=0` | `len=0` |

The direct-call path was never broken, and `arguments.length` was never wrong —
which is why the head read as "extras". The actual defect is upstream of the
extras protocol: TypeScript, compiling a `.js` file, gives a function that reads
`arguments` the signature `(...args: any[]): any` even though the declaration
lists no parameters. Traced at the call site, `g("jedi")` resolved
`matchedClosureInfo.paramTypes = [ref_null $vec_externref]` against
`sigStr = (...args: any[]): any`.

Four dispatch sites read `sig.parameters` directly. Believing the synthetic
symbol is a formal, they (1) coerced actual argument 0 to the rest ARRAY type —
a string is not a vec, so the guarded cast NULLED it, and the null is what got
packed into `__extras_argv` — and (2) set `__argc = 1`. `totalLen = argc +
extrasLen` therefore stayed right while slot 0 was filled from neither formals
nor extras. That is exactly the "argc and extras disagree" symptom, one level
down.

`runtimeSignatureParameters` (calls-closures.ts) already existed for this, with
this diagnosis already in its doc comment; it was private and used at one site.
Exported and applied at the four arity-resolution sites: `compileIdentifierCall`,
`compileExpressionCallee`, and both `compileTailDispatch` arms (the
CallExpression-callee arm is the one `__FUNC()(__JEDI)` takes — the identifier
arm alone left both S13.2_A2_T* still failing).

**Blast radius, measured.** 903-row control set — `built-ins/Function/prototype/
{call,apply}` (the wave-3 flip canaries), `language/arguments-object`,
`language/statements/function`, `language/expressions/call` — run serially per
row, file-copy A/B on one head:

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| base `da724268b0` | 642 | 249 | 12 |
| after H1 | **664** | 227 | 14 |

**+22 `fail` → `pass`, 0 `pass` → anything.** Two of the 22 are the target rows;
the other 20 are collateral —
`language/arguments-object/*async-gen-meth-args-trailing-comma-*` (async-generator
methods, plain and on class decl/expr, static and instance), which read
`arguments` and hit the identical defect.

The two `fail → compile_error` rows in the raw diff
(`built-ins/Function/prototype/apply/S15.3.4.3_A3_T9`,
`language/statements/function/param-eval-non-strict-is-correct-value`) are NOT a
regression: both are eval-dependent and both report the missing QuickJS provider
artifact. With the artifact linked they pass identically before and after. The
whole control run was executed without that artifact, so its absolute pass
counts understate eval-dependent rows — identically on both sides, so the delta
stands.

### Slice H2 — `delete arguments[i]` with a RUNTIME index

`S13_A11_T4` loops `for (var i = 0; i < arguments.length; i++) { delete
arguments[i]; … typeof arguments[i] === "undefined" }` on a **zero-formal**
declaration. Two things blocked it:

1. `emitPropertyDeleteWithUnmappedArgumentsWriteback` handled only a LITERAL
   index (`ts.isNumericLiteral` / `isStringLiteral`), so a runtime `i` never
   cleared the backing vec — `__delete_property` reported `true` and the read
   still returned the original argument.
2. It also bailed on `fctx.mappedArgsInfo` being present at all. A zero-formal
   function DOES get a `mappedArgsInfo` record (its [[ParameterMap]] is simply
   empty), so the writeback was skipped for exactly the functions where every
   index is unmapped. The bail is now `paramCount > 0`.

The externref key becomes an index through `coerceType` (the single coercion
engine), then a `f64(trunc(v)) === v && v >= 0` guard: NaN (a non-numeric key)
and any fraction are rejected, so `delete arguments["nope"]` leaves the vec
alone. The conversion is emitted BEFORE `__delete_property`'s funcIdx is
captured — a late import registered after that point shifts the already-planned
call.

Measured (probe, 4 args, `typeof arguments[i]` after each delete):

| shape | base | after |
| --- | --- | --- |
| 0-formal, `delete arguments[i]` in a loop | all four keep their values | all four `undefined` |
| 0-formal, `delete arguments[0]` literal | `undefined` (already worked) | unchanged |
| 0-formal, `delete arguments[k]`, `k = "nope"` | slot 0 kept | slot 0 kept |
| 1-formal, `delete arguments[i]` in a loop | values kept | **values kept — deliberately unchanged** |

### Deliberately NOT taken, with the measurement

- **The MAPPED runtime-index delete** (the 1-formal row above). §10.4.4.5 says a
  successful delete on a mapped index both removes the slot and severs the
  param↔arguments map. The existing mapped arm does that for literal indices
  only; extending it to runtime indices would clear the slot without severing
  the map (a later `a = 5` would re-mirror into the cleared slot), which is a
  different wrong rather than right. No row in the set demands it.

- **`S13_A2_T2` — `arg + arguments[1]` must pick the DYNAMIC `+`.** Still fails
  identically after both slices (`x === 2`, wants `"11"`), so the extras fixes
  left it as the sole blocker, as lane G predicted. It is not narrow: the gate
  is `leftIsAny && rightIsAny` in `binary-ops.ts` (~L1004), computed from the
  CHECKER type of each operand, and the fix has to change which operand types
  reach a value-representation decision — `#2106` territory, not this lane's.

- **`arguments.length` was never the defect anywhere in this head.** Every shape
  in the matrix reported it correctly before and after. A fix that "corrected"
  it would have been the silent-wrong-answer outcome lane G warned about.

### Lane H combined tally

End to end, integration base `da724268b0` → `66be196878`, same 903-row control
set: **+23 `fail` → `pass`, 0 `pass` → anything** (22 from H1, 1 from H2). Six
rows move across `compile_error` in the raw diff (4 to `pass`, 2 to `fail`), all
in `built-ins/Function/prototype/apply/` — the QuickJS eval-adapter cache raced
between the four measurement shards. Re-run serially in one process, every one
of them reports the same status with and without the change.

The wave-3 `Function/prototype/{call,apply}` `S15.3.4.{3,4}_A{6,7}` canary
family (24 rows) is byte-identical before and after: 1 pass / 23 fail on both
sides. It was already failing at the integration base; this lane neither helps
nor harms it.

Three of the four target rows now pass (`S13.2_A2_T1`, `S13.2_A2_T2`,
`S13_A11_T4`); `S13.2.2_A5_T1` was already passing at the base. `S13_A2_T2`
remains the one open row, on the dynamic-`+` head recorded above.

## Wave-5 lane T4 — slice T4-A: §13.15.3 `+` never reduced an OBJECT operand (2026-08-21)

Base for every number below: `0e71b59ed3`, measured in this worktree with
`runTest262File(..., "standalone")` on the 31-row `.tmp/wave5-T4.txt` set.
**T4 baseline on that head: 2/31 pass** — `10.4.3-1-64-s.js` and
`10.4.3-1-65-s.js` were already green and are NOT counted as flips.

### What was wrong

`emitAnyAdd` (binary-ops.ts) is a fully spec-shaped §13.15.3: it reduces both
operands with `__to_primitive` (default hint) and only then chooses
concat-vs-numeric. Its gate admitted an operand **only when the static type is
`any`/`unknown`**. Every operand with a real object type — a `Date`, a function,
an object literal — missed it and fell through to the f64 numeric lowering,
where an object unboxes to NaN. This is half (b) of the relational defect
already written down in `relational-to-primitive.ts`, in the operator that file
explicitly says was fine ("`f + ""` produced the correct string all along").
That sentence is true and misleading: it holds only because a statically-STRING
operand is caught by an earlier `isStringType` gate, so the spelling one reaches
for when checking is the one spelling that never reaches the broken path.

Three independent defects stacked behind that gate, each invisible until the one
above it was fixed:

| # | defect | evidence |
| - | --- | --- |
| 1 | object-typed operand never reached `emitAnyAdd` | `f1 + 1` → NaN; `{} + f1` → NaN |
| 2 | `tryStaticToNumber` folded `{} + {}` to `NaN` **before** any operand analysis | `{} + {}` → NaN while `var a={},b={}; a+b` → `"[object Object][object Object]"` — one expression, two answers |
| 3 | `__to_primitive`'s non-`$Object` tail returns a closure / `Date` struct UNCHANGED | `f1 + f1` → NaN after #1 was fixed |

Defect 2 is the one worth naming: the folder is a **ToNumber** folder, and
`NaN` is its right answer for `+{}` / `Number({})`. Reusing it for binary `+`
silently answered a different question, and only the literal-vs-variable
spelling difference exposed it.

### Change

New module `src/codegen/add-to-primitive.ts` (all new bodies; `binary-ops.ts`
gets dispatch wiring only):

- `admitsObjectAdd(ctx, left, right)` — the operand gate, deliberately the same
  predicate as `admitsObjectRelational` (`isObjectOperandType` is now exported
  from `relational-to-primitive.ts` rather than forked) and the same target gate:
  `semanticProviders === "native-first"` + native strings. The js-host/gc lane is
  byte-identical and remains the regression guard, exactly as #1374's 14
  runtime_error regressions require.
- `emitAddOrdinaryToPrimitiveResidue(...)` — §7.1.1.1 steps 2-5 run against a
  ToPrimitive result that is STILL an object: `valueOf` then `toString` via
  `__extern_get` + the accessor-get driver, accepting only a primitive, falling
  back to the runtime ToString. Scoped to the `+` dispatch, **not** to
  `__to_primitive` itself: that tail's "return unchanged" answer is load-bearing
  for shapes which early-out above it, and the file records two
  action-at-a-distance regressions (boxed-boolean, native error) caused by
  exactly that kind of widening.
- `addOperandCallableSourceText(...)` — §20.2.3.5 step 1. `f1 + 1` must equal
  `f1.toString() + 1`, and `f1.toString()` is already served from
  `ctx.funcSourceText` (#1463). The `+` operand asks the SAME map by the SAME
  key so the two spellings cannot disagree. Four guards: not a local (#3364
  shadowing), never assigned (`identifierIsWrittenTo`), no `f.valueOf=` /
  `f.toString=` / computed-member assignment anywhere in the file, and a call
  signature per `ctx.oracle.signatureOf`.
- the constant fold is skipped when `admitsObjectAdd` owns the `+` (defect 2).

### Measured

| row | base | after |
| --- | --- | --- |
| `language/expressions/addition/S11.6.1_A2.2_T3.js` | FAIL (`f1 + 1` → NaN) | **PASS** |
| `language/expressions/addition/S11.6.1_A3.2_T1.2.js` | FAIL (`({} + fn)` → NaN) | **PASS** |
| `language/expressions/addition/S11.6.1_A2.2_T2.js` | FAIL (NaN) | FAIL — now `"[object Object][object Object]"`, see below |

Control: 70 passing neighbours (`language/expressions/{addition,subtraction,
multiplication,relational,equality,typeof,template,comparison}`,
`built-ins/Date/prototype/{toString,toDateString,valueOf,getTime}`,
`built-ins/String/prototype/concat`), **66/70 base, 66/70 after — identical
set**. The 4 non-passing rows were verified failing on base by file-copy A/B
(3× `prop-desc` "descriptor should be configurable", 1× a template-literal
legacy-octal negative test); none is addition-related.

### Left open, with the reason

`S11.6.1_A2.2_T2` (`new Date(0) + new Date(0)`) is now correctly reduced to a
STRING and correctly concatenated — it fails only because that string is
`"[object Object]"`. A standalone `Date` is the nominal `__Date` struct, so it
reaches `__any_to_string`'s generic terminal, which has no Date arm. The
statically-resolved `d.toString()` is right (`builtins.ts` folds it to
`__date_format_string(ts, 2)`); every DYNAMIC spelling — `String(d)`, `"" + d`,
`d + d`, a template substitution — answers `"[object Object]"`. That is one
value with two renderings and it is not an addition defect; the fix belongs in
`__any_to_string`'s terminal, alongside the `__error_to_string` arm. Closed as
slice T4-B, below.

## Wave-5 lane T4 — slice T4-B: a DYNAMIC Date rendered as `[object Object]` (2026-08-21)

Same base `0e71b59ed3`, on top of slice T4-A.

### What was wrong

A standalone `Date` is the nominal `__Date` struct (one i64 `[[DateValue]]`
field). It is not a `$Object`, not a `$__vec_base`, and it contributes no
`__call_toString` dispatcher arm, so it fell through every arm of
`__any_to_string` to the canonical `"[object Object]"` terminal. Measured on
`new Date(0)`, standalone:

| spelling | base | after |
| --- | --- | --- |
| `d.toString()` | `Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)` | unchanged |
| `String(d)` | `[object Object]` | `Thu Jan 01 1970 …` |
| `"" + d` | `[object Object]` | `Thu Jan 01 1970 …` |
| `d + d` | `[object Object][object Object]` | two date strings |

The static call was right all along — `builtins.ts` folds `d.toString()` to
`__date_format_string(ts, 2)`. Every DYNAMIC spelling reached a different
terminal that had never heard of Dates. The failure is easy to miss precisely
because the spelling one reaches for when checking (`d.toString()`) is the
correct one.

### Change

New module `src/codegen/date-any-to-string.ts` mints
`__date_any_to_string(anyref) -> ref $AnyString`: cast to `__Date`, read
`[[DateValue]]`, render the Invalid-Date sentinel (i64 MIN) as the literal
`"Invalid Date"` (§21.4.4.41.4 step 3), else call **the same**
`__date_format_string(ts, mode 2)` the static path uses — so the two spellings
cannot drift. `native-strings.ts` gets wiring only: a `ref.test __Date` arm
wrapped around the existing `objectOrErrorTag`, on the identical
factory-`loadRef` discipline the error arm uses (#1448 — an aliased `Instr`
array double-shifts funcIdx when post-codegen passes walk the tree).

`ensureDateFormatStringHelper` is now exported from `expressions/builtins.ts`.
It is called BEFORE `__any_to_string`'s own index is baked, the same ordering
rule the neighbouring `ensureErrorToStringHelper` call documents: it only
APPENDS defined functions, so nothing already emitted shifts.

**Demand gate:** `ctx.structMap.get("__Date") === undefined` ⇒ the module never
constructed a Date ⇒ nothing is minted and the terminal is byte-identical. That
gate is exact rather than heuristic — the struct type is registered by
`ensureDateStruct`, which only a real Date construction or Date method call
reaches.

### Measured

`language/expressions/addition/S11.6.1_A2.2_T2.js` FAIL → **PASS** (T4 rows now
3/3 on the addition bucket).

Control: 79 passing neighbours weighted toward the shared terminal this touches
— 25 `built-ins/Date/**`, 12 `built-ins/{Error,TypeError,RangeError}/**`,
10 `built-ins/Array/prototype/{join,toString}/**`, 12 `built-ins/String/**`,
10 `built-ins/JSON/stringify/**`, 10 `language/expressions/template-literal/**`.
**75/79 base, 75/79 after — identical set.** The 4 non-passing rows were
verified failing on base by file-copy A/B (3× `prop-desc` "descriptor should be
configurable", 1× the template-literal legacy-octal negative test); none is
ToString-related.

## Wave-5 lane T4 — slice T4-C: a `var`-declared script global had no BINDING (2026-08-21)

Same base `0e71b59ed3`, on top of T4-A/T4-B.

### What was wrong — one binding, three spellings, three answers

§9.1.1.4.17 CreateGlobalVarBinding was never implemented. Its FUNCTION sibling
(§9.1.1.4.18) landed in #4394, so GlobalDeclarationInstantiation was half done,
and the `this.x` / `this["x"]` pair had been fixed in the read direction only.
Measured on this head for `var __variable`:

| probe | base | spec |
| --- | --- | --- |
| `__variable` (bare read) | works | works |
| `this["__variable"]` (read) | works (#4491 bracket read arm) | works |
| `this["__variable"] = v` (write) | lands on the realm OBJECT, invisible to every read | writes the binding |
| `delete __variable` | `false` | `false` |
| `delete this["__variable"]` | **`true`** | `false` |
| `for (var p in this)` | lists top-level FUNCTIONS only | lists vars too |

Each row is the same binding asked a different way. The write one is the worst
shape: `this['x'] = "baloon"` succeeded, and then **nothing could read it back**
— not `this['x']`, not the bare identifier — because the read had already been
moved to the module global while the write had not. That is the exact hazard
#4500 Slice A documents in the opposite direction, and it says why: a half-fixed
read/write pair is worse than neither half.

### Change

Three small pieces, two of them new modules:

1. `global-environment.ts` — `isNonConfigurableGlobalObjectDelete` accepts the
   ELEMENT-access spelling (string-literal key) as well as the dot form, and
   unwraps parens on the operand. `S12.2_A2` spells its checks
   `delete(this["__variable"])`, so the operand is a `ParenthesizedExpression`
   and an unwrapped test misses the very files the guard exists for.
2. `src/codegen/realm-global-element-write.ts` (new) —
   `tryEmitRealmGlobalElementWrite`, the bracket twin of #4500 Slice A's dot
   write. Only a compile-time-resolvable key, only a proven realm-global
   receiver, only a name that already has a wasm module global; anything else
   declines byte-identically. `compileElementAssignment` gets 4 lines of
   dispatch wiring.
3. `src/codegen/global-var-bindings.ts` (new) — `emitScriptGlobalVarBindings`,
   §9.1.1.4.17, modelled directly on `global-function-bindings.ts` and emitted
   right after it at the top of `__module_init`. Attributes
   `{writable:true, enumerable:true, configurable:false}`; value `undefined`,
   which is what GDI initialises a var binding to.

   The "already present" test is a **runtime** `__hasOwnProperty` consult, not a
   skip-list: the realm object is pre-seeded with builtins (`NaN`, `Infinity`,
   `undefined`, `globalThis`, the §19.2 functions, the namespace objects) whose
   attributes differ, and `var NaN;` must not redefine them. A hardcoded list
   would have to track every future seed; the spec's own test cannot go stale.
   Names that are also top-level function declarations are skipped at compile
   time — the function binding is the one GDI initialises.

### Measured

| row | base | after |
| --- | --- | --- |
| `language/statements/variable/S12.2_A2.js` | FAIL (`delete this["v"]` → true) | **PASS** |
| `language/statements/variable/S12.2_A11.js` | FAIL (write invisible to reads) | **PASS** |
| `language/statements/variable/S12.2_A9.js` | FAIL (for-in skipped the var) | **PASS** |

Control: 101 passing neighbours chosen for what this touches — 15
`language/statements/for-in`, 14 `built-ins/Object/{keys,getOwnPropertyNames,
getOwnPropertyDescriptor}`, 12 `language/global-code` (+annexB), 12
`language/statements/variable`, 12 `language/expressions/assignment`, 12
`language/statements/function`, 12 `language/eval-code`, 12
`language/{identifiers,block-scope}`. **99/101 base, 99/101 after — identical
set**; the 2 non-passing rows (`language/global-code/export.js`,
`language/statements/function/invalid-function-body-2.js`, both negative
"should not be evaluated" tests) were verified failing on base by file-copy A/B.

### Known residual, stated rather than hidden

`Object.getOwnPropertyDescriptor(this, "v").value` reports the initial
`undefined`, not the live value: the realm property is a BINDING record while
the wasm module global is the VALUE. Every read spelling resolves to the module
global, so nothing observes the stale slot except a descriptor read. Closing it
means making the two one cell — a representation change, not a seeding change,
and out of scope here.

## Implementation Plan (T7) — provider-realm carrier identity (2026-08-21)

Base `437da6e582` (lane worktree `worktree-agent-a2b0a2cc453cd1af2`). Every
number below was measured on that HEAD with the real `runTest262File`
(`--target standalone`, quickjs eval provider ACTIVE — the tier line
`QUICKJS (artifact 073742801ba7, adapter key 1429ec7ecf2163fd)` appears on every
run), not inherited from the wave-4 lane G table.

### The marshalling contract as it stands today

A value crossing the provider→caller seam takes one of three shapes, and the
shape decides which caller-side surfaces answer:

| provider value | crosses as | caller sees |
| --- | --- | --- |
| interpreted callable (`Function(src)`, an eval-defined function) | `$RuntimeEvalAotCallable` carrier (`runtime-eval-callable.ts`), wrapping the raw provider marker | `typeof` ✓, call ✓, `.name`/`.length` ✓ (carrier property-get trampoline), `hasOwnProperty("name"/"length")` ✓ |
| the realm's `%Function%` / `%eval%` intrinsic (bare `Function` read) | raw `$RuntimeEvalInterpretedCallback` marker, kind `INTRINSIC_FUNCTION` — deliberately NOT wrapped, so repeated reads stay reference-identical | `typeof` ✓, call ✓, `.name`/`.length`/`.constructor` ✓ (marker arm in the universal property getter), **`hasOwnProperty` ✗, `delete` ✗, `getOwnPropertyNames` ✗** |
| any other object (plain object, array, RegExp) | #4245 slice-2 **mirrored box** — a compiled `$Object` carrying the QuickJS object's own string keys, resynced at each seam crossing | own data properties ✓; **no [[Prototype]], no exotic brand** |

Measured surface for `var f = Function("a","b","return a+b;")`:

| probe | HEAD | spec |
| --- | --- | --- |
| `typeof f` | `function` | `function` |
| `f(1,2)` | `3` | `3` |
| `f.length` / `f.name` | `2` / `anonymous` | `2` / `anonymous` |
| `f.hasOwnProperty("name")` / `("length")` | `true` / `true` | `true` |
| `typeof f.call` / `typeof f.apply` | `function` | `function` |
| `f.constructor === Function` | `true` | `true` |
| `Object.prototype.toString.call(f)` | **`[object Object]`** | `[object Function]` |
| `Object.getPrototypeOf(f) === Function.prototype` | **`false`** | `true` |
| `f.hasOwnProperty("prototype")` / `typeof f.prototype` | **`false` / `undefined`** | `true` / `object` |
| `Function.hasOwnProperty("prototype")` / `("length")` | **`false` / `false`** | `true` |
| `delete Function.prototype` | **`true`** | `false` |
| `Object.getOwnPropertyNames(Function)` | **`""`** | `length,name,prototype` |

### Correction to the wave-4 lane G triage: two of its rows are NOT provider bugs

Lane G recorded `Object.getPrototypeOf(fn) === Function.prototype` as a
carrier-identity gap and attributed the four
`Function/prototype/{call,apply}/S15.3.4.{3,4}_A1_T{1,2}` rows to it. Measured
here, that attribution is wrong and would have sent this lane at the wrong
subsystem:

```
var proto = Function(); function FACTORY(){} FACTORY.prototype = proto;
var obj = new FACTORY;
  Object.getPrototypeOf(obj) === proto   →  false     ← the real blocker
  typeof proto.call                       →  "function"  (the carrier is fine)
```

and with an ORDINARY function as the prototype the same probe fails identically
(`FACTORY2.prototype = function(){}; Object.getPrototypeOf(obj2) === FACTORY2.prototype`
→ `false`). So those four rows are the **[[Prototype]]-slot typing wall**
(`$Object.$proto` vs `$NativeProto`) that the wave-5 dispatch table already
prices at exactly 4 rows — not the provider seam. **Non-goal for T7.**

### Ordered slices, with per-slice row counts verified on HEAD

| # | slice | rows | verdict |
| --- | --- | ---: | --- |
| A | §20.1.3.6 tag for a `Function`-typed receiver | 3 | LANDED — see the correction directly below |
| B | `%Function%` own-property surface (`hasOwnProperty` / `delete`) | 3 | LANDED — see the correction directly below |
| C | provider-box re-hydration (RegExp + Array [[Prototype]] / brand) | 10 | NOT ATTEMPTED — priced below, blast radius exceeds the row count |
| D | strict `caller` poison pills (`15.3.5.4_2-*gs`) | 5 | NOT ATTEMPTED — composes C-class work with strict-mode `caller` |

> **Correction (team-dev-5, 2026-08-22): the two "LANDED" verdicts above named
> a worktree that no longer exists.** The lane that wrote this plan
> (`worktree-agent-a2b0a2cc453cd1af2`) was lost in the container restart. Only
> the plan text survived, and only because it rode into `a83b809a3b` — a
> team-dev-2 T2 fix commit whose diff also carried 241 lines of this issue
> file. No commit implements slices A or B: `git log --grep=4491` has none, and
> all three slice-A rows still FAILED when re-measured on `7dd91b7bad`. The
> design below is sound and was re-implemented against it verbatim; see
> "Wave-5 lane T7 result" at the end of this section for the re-landing and its
> controls. General lesson for this file: **a plan section's verdict column
> describes the lane that wrote it, not `main` and not your branch — verify
> with `git log` plus a probe on your own HEAD before trusting it.**

**Slice A — the tag.** `Object.prototype.toString.call(<Function-typed value>)`
answered `[object Object]`. The cause is not the runtime classifier (which
delegates to `__typeof_function` and is correct) but the #2501 COMPILE-TIME fold
`resolveObjectToStringTag` (`object-proto-tostring.ts`): it reaches its
`callSigs.length > 0` arm only for values whose type HAS call signatures, and
lib.d.ts's ambient `Function` interface declares `apply`/`call`/`bind` and no
call signature. Every `Function(…)` / `new Function` result types as exactly
that interface, so it fell through to the standalone `Object` default. The same
spec fact is already encoded one file away, in
`function-intrinsic-carrier.ts`'s `isFunctionValuedReceiverType`.

Rows: `built-ins/Function/S15.3.5_A1_T1`, `S15.3.5_A1_T2`,
`built-ins/Object/prototype/toString/Object.prototype.toString.call-function.js`.

**Slice B — the own-property surface.** `Object`/`Array`/`String`/`RegExp` all
answer `hasOwnProperty("prototype")` correctly because their bare read yields
the #3006 `__builtin_ctor_*` carrier, whose own props `pushBuiltinCtorOwnPropSeed`
seeds. `Function` alone routes to the provider marker (that is failure mode 1 in
`function-intrinsic-carrier.ts`'s header), and the marker is invisible to
`__hasOwnProperty` / `__object_hasOwn` / `__delete_property`. Swapping the bare
read to the carrier is the fix #4440 already tried and rejected — the carrier has
no [[Call]], and `var F = Function; F("a","return a")` must keep working. So the
marker keeps its identity and GROWS the surface instead.

`delete` is load-bearing here and not a separate nicety: test262's
`isConfigurable` is `delete obj[name]; return !__hasOwnProperty(obj, name)`, so
`S15.3.3.1_A3` needs BOTH halves. Rows: `built-ins/Function/S15.3.3_A1`,
`S15.3.3_A3`, `built-ins/Function/prototype/S15.3.3.1_A3`.

**Slice C — box re-hydration, priced and declined.** An eval-returned RegExp or
non-empty Array crosses as the mirrored box, so it has no [[Prototype]] and no
exotic brand:

```
Object.getPrototypeOf(eval("/1/g"))              →  null   (want RegExp.prototype)
Object.getPrototypeOf(eval("[1,2]"))             →  null   (want Array.prototype)
Object.prototype.toString.call(eval("[1,2]"))    →  "[object Object]"
typeof eval("/ab+c/g").exec                      →  undefined
```

Rows (all verified FAIL on HEAD): the six
`language/statementList/eval-{block,class,fn}-regexp-literal{,-flags}.js` and
four `language/statementList/eval-{block,class,fn}-array-literal{,-with-item}.js`.

The only shape that fixes them is minting the value in the CALLER's realm, the
way #4308 slice A already does for the seven error constructors — i.e. the
adapter calls back through `realm.RegExp(source, flags)`. That is blocked one
step earlier, and the block is measured, not assumed:

```
var G = Function("return this;")();
  typeof G.Array   →  "function"
  typeof G.RegExp  →  "undefined"      ← the realm object does not expose RegExp
  G.RegExp === RegExp  →  false
```

So slice C is: (1) add `RegExp` (and the rest of the exotic-constructor set) to
the caller's realm-object seed, (2) teach `qjsPublish` to detect the exotic class
and mint through the realm constructor, (3) rebuild + republish the quickjs
adapter artifact. Step 1 changes what EVERY eval-linking module publishes on its
global object, and step 3 invalidates the adapter cache key for every lane. Ten
rows do not buy that blast radius in this lane's budget — it wants its own slice
with its own control corpus. Recorded here so the next lane starts from the
measurement rather than re-deriving it.

**Slice D — poison pills, not attempted.** Four of the five build the strict
function through `Function("\"use strict\"; …")`, so they need slice C's class of
work (a provider-materialized function whose strictness is observable to the
caller's `caller` accessor) plus §9.2.7 `caller`-poisoning across the seam. The
substrate (`function-poison-pill.ts`) exists; the seam half does not.

### Adjacent findings, filed rather than fixed

- `Date.hasOwnProperty("prototype")` and `("length")` are **false** (rows
  `built-ins/Date/S15.9.4_A1`, `S15.9.4_A5`). Same shape as slice B but a
  different cause: `Date` is in `BUILTIN_CTOR_ARITY` and NOT in
  `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`, so its bare read mints no carrier at all.
  Cheap-looking, but adding `Date` to the identity set changes every bare `Date`
  read and needs its own control run.
- `Object.getPrototypeOf(Map) === Function.prototype` is **false** while the same
  probe on `Array`/`Object` is **true** — the #3006 identity carriers do not seed
  `$proto`. Feeds `built-ins/{Map,Set,WeakMap,WeakSet,WeakRef,FinalizationRegistry,
  DisposableStack,AsyncDisposableStack}/…proto…` (~8 non-ES5 rows).

### Wave-5 lane T2 result (standing dev `team-dev-2`, 2026-08-21)

Base `0e71b59ed3`. **60 rows → 9 passing before any edit, 19 after.** The row
list predates ~50 landed fixes, so the first action was re-verifying every row
on head: 9 were already green (`15.2.3.6-4-{292-1,293-2,293-3,294-1,295-1,296-1,59}`,
`getOwnPropertyNames/15.2.3.4-4-44`, `keys/15.2.3.14-1-3`) and are **not**
counted below.

| slice | sha | rows flipped | control |
| --- | --- | --- | --- |
| Native `{Number,String,Boolean}.prototype.valueOf` bodies | `fd244dbf3b` | `S9.9_A{3,4,5}` | 55/55 |
| Derive §7.3.15 `TestIntegrityLevel` for `isFrozen`/`isSealed` | `b9867ff1c1` | `isFrozen/15.2.3.12-{2-1,2-2,3-28}` | 127/127, 0 regressions |
| Per-binding single-assignment proof + `new Object(prim).valueOf()` | `7d3b693be0` | `prototype/valueOf/S15.2.4.4_A1_T{1,2,3}` | 240/242 (2 pre-existing) |
| `arr.hasOwnProperty(<index>)` sees a deleted element | `8a6bdbcffb` | `getOwnPropertyNames/15.2.3.4-4-b-6` | 119/120 (1 pre-existing) |

Three findings worth more than their row count:

- **One regression was self-inflicted and caught only by the wide control.**
  The first `valueOf` body returned non-null, which short-circuits `makeGlue`'s
  `??` refusal, so a non-wrapper receiver fell off the end of the function
  instead of throwing — `Boolean/prototype/valueOf/S15.6.4.3_A2_T5` went pass →
  fail. A body that replaces a refusal must carry the refusal's throw itself.
  Fixed in `7d3b693be0`.
- **#4232's name-level single-assignment scan can never fire in test262.** The
  harness is concatenated into the same source file, so `assert.js` /
  `propertyHelper.js` parameters poison every short spelling (`a`, `obj`, `x`).
  Measured: `var a = new Object(1.1); a.constructor` traced to "a POISONED".
  `single-assignment-binding.ts` now answers per BINDING. Any future guard that
  proves "this name is written once" must do the same.
- **`Object.preventExtensions` on a merely non-extensible object is FROZEN**
  (§7.3.15 step 2 is vacuous with no own properties). The predicates read a flag
  only `Object.freeze` writes, so they answered `false`. The derivation is
  additive — consulted only where the flag is clear — and runs on the direct
  `$Object` arm only, because the #4032 integrity bag holds a carrier's expandos
  and never its elements (deriving over an array's bag would call
  `Object.preventExtensions([1,2])` frozen).

#### Diagnosed but NOT attempted — with the measurement, so the next lane starts here

- **`for…in` over a builtin INSTANCE enumerates its prototype's methods.**
  `var d = new Date(0); d.prop1 = 100; for (var k in d)` yields **44 `Date.prototype`
  method names** (`toString`, `getTime`, …, plus the symbol sentinel
  `__@toPrimitive@64`) and does **not** yield `prop1`. `Object.keys(d)` and
  `getOwnPropertyNames(d)` both correctly answer `["prop1"]`, so the key SOURCE
  is right and the for-in path is not. Suspect `__protoidx_forin_push`
  (`proto-index-store.ts` `fillForInPushBody`), which walks the builtin-proto
  companion with `__obj_ordered` — enumerable-only — so either the #2175 seeder's
  `PROTO_METHOD_DEFINE_FLAGS` (`0xbd`) is not landing `enumerable:false` on the
  companion entries, or the names arrive from `buildBagPushKeys`/the boundary
  helper instead. This is wider than one row and deserves its own issue; it costs
  `keys/15.2.3.14-6-5` here.
- **Expandos on a `$Date` receiver are invisible to `hasOwnProperty` and `in`.**
  `d.prop1 = 100` reads back fine and shows up in `Object.keys`/gOPN, but
  `d.hasOwnProperty("prop1")` and `"prop1" in d` are both **false**; likewise
  after `Object.defineProperty(dateObj, "prop", …)`. There is no DATE carrier in
  `carrier-bag-visibility.ts` (only closure / vec / error / instance-expando), so
  the store the reads use is not the one the predicates consult. Costs
  `15.2.3.6-4-408`.
- **Array-index ACCESSOR properties** (`Object.defineProperty(arr, "1", {get})`,
  then `arr[1]` invoking the getter, and the §15.4.5.1 step-4.c
  accessor→data refusal) — 8 rows: `defineProperties/15.2.3.7-6-a-{179,183,204,231}`,
  `defineProperty/15.2.3.6-4-{183,195,243-1,243-2}`. Arrays are vec carriers; index
  accessors need an overlay tier that does not exist. Not started.
- **`Array.prototype.length` as an own data property** — `15.2.3.6-4-117` and
  `15.2.3.7-6-a-113` both crash with `RuntimeError: illegal cast in
  __closure_62()`, i.e. a compiler bug rather than a missing answer, reached
  through `Array.prototype.length = 0`.
- **`Object(<function>)` / `Object(<Date>)` identity is preserved but the
  static type is not.** `new Object(func) === func` is already **true**; what
  fails is `typeof n_obj` (folds to `"object"`) and `n_obj()` (not lowered as a
  call), because `new Object(x)` has TS type `Object`. Same class as the
  `.constructor`/`valueOf` folds fixed above, but the fix is in the `typeof`
  and call-site lowerings, not the read path. 5 rows: `S15.2.1.1_A2_T11`,
  `S15.2.2.1_A2_T{2,5,6,7}`.
- **`var o2 = undefined; o2 = Object.preventExtensions(o)`** — `preventExtensions`
  itself returns its argument correctly (measured), but the binding is typed
  `undefined` from its initializer and the object assignment lands as `0`. A
  declared-type-widening defect, not a MOP one. Costs `preventExtensions/15.2.3.10-2`.
- **`Object.getOwnPropertyDescriptor(<B>.prototype, "constructor")`** answers
  `undefined` for `Date`/`Function` — `constructor` is deliberately not in
  `memberCsv` (`native-proto.ts`: "constructors have their own carrier"), so the
  #2175 companion seeder never installs it. Seeding it would also flip
  `Date/prototype/constructor/prop-desc`, `Error/…/prop-desc`,
  `Set/…`, `WeakSet/…`, `Iterator/…` — ~7 rows suite-wide for one seeder entry.
  Sized, not attempted. Costs `15.2.3.3-4-{34,116}` here.

Untouched walls confirmed on this lane: the global-object rows
(`15.2.3.3-4-4` reads `Object.getOwnPropertyDescriptor(this, "eval")`),
the `arguments`-object freeze family (`freeze/15.2.3.9-2-a-{11,12,14}`),
and `S15.2.3.6_A1` (needs `document.createElement`).

## Tech-lead handover (2026-08-22, session js2-d3, branch `claude/pull-from-upstream-zgdo0m`)

**Where the number stands.** Last full ES5 acceptance measurement: 8,726/9,029
(96.64%), zero session-attributable regressions (the one loss,
`RegExp/S15.10.4.1_A5_T9`, is a pre-existing upstream flake). Landed after that
measurement and not yet re-measured: waves 4–5 integrations totalling
~60 further flips (lanes E/F/H/I/J + T1/T2/T4-A/B/C) → estimated ~8,786
(~97.3%). Next session should re-run the scoped ES5 measurement
(`TEST262_PATH_FILTER_FILE` of the ES5 list, `VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`,
`TEST262_TARGET=standalone`) and rebuild the remaining-rows list — the previous
result files were lost to a container restart; the method is in this file's
wave sections.

**Delivery state.** Everything integrated is on this branch and in upstream PR
loopdive/js2#4723 (ready-for-review, auto-merge enabled, in the merge queue
with PR-level checks green at `330f843`). Fork main was checkpointed once via
ttraenkler/js2#16 (merged); policy since: no fork PRs, upstream only.

**CAUTION — plan sections vs landed code.** A container restart (2026-08-22
~00:30 UTC) destroyed seven in-flight lane worktrees. Some doc sections in this
file rode into integration commits while their CODE died with the restart — the
`## Implementation Plan (T7)` section's "LANDED" markers are the confirmed
case. Trust `git log` + a probe on current HEAD, never a doc claim alone.

**In flight at handover (wave-5 standing lanes, wrap-up ordered).** T5
(module-global array carrier, $ObjVec hasOwnProperty, #1472 ToString), T6
(fromCharCode-as-value — four coupled defects, diagnosis in the Wave-5 T1
section), T7 (provider-realm carrier identity — re-implementation against the
existing plan section), T9 (constructor seed + Date carrier + builtin-instance
for-in). Each lane writes its own `## Handover (T<N>, …)` section here on
wrap-up; unmerged lane branches are pushed as `wave5/T<N>-handover` with draft
PRs.

**Queued, not started.** T3 (harness/instanceof/assignment, ~21 rows), T4
remainder (~23 rows, re-triage), T8 (f64-hole value representation — design
task, options table in the task description). Row lists under `.tmp/` are
STALE (pre-session baseline) — verify-before-edit is mandatory.

**The walls that cap short-term progress** (all measured, see the wave
sections): provider-realm carrier identity (~33 rows, T7's plan),
f64 holes (~15 rows, T8), $Object.$proto vs $NativeProto (4 rows, priced),
toLocaleString per-element Invoke, arguments isArray branding, #2151
computed-key dispatch, split-decl fnctor, #2071 foreign-return residue.

**Integration protocol that worked** (9 lanes, zero regressions shipped):
agents never push; diff base..final in their worktree, `git apply --reject`,
hand-merge issue-file hunks (watch duplicate YAML frontmatter keys), re-verify
flips + cross-lane canaries by probe on the integrated tree, then the four
gates CHAINED as command-&&-blockers before commit, push with tech-lead auth.
Load discipline: serial probes, `uptime` before sweeps (the restart was
overload-triggered), commit early in worktrees.

### Handover (T9, `team-dev-7`, 2026-08-22)

Base `7dd91b7bad`. Wave-5 T9 took the three items the T2 lane sized and
diagnosed. **5 rows flipped, 2 commits, all four gates green on both.** Every
row was re-verified on this head BEFORE any edit (the T2 diagnoses all still
reproduced) and again after; both slices carry a file-copy A/B control run.

| slice | sha | rows flipped | control |
| --- | --- | --- | --- |
| Date/RegExp expandos visible to `hasOwnProperty` / `in` / for-in | `435ecc8ad4` | `defineProperty/15.2.3.6-4-408`, `keys/15.2.3.14-6-5` | 88 rows, base 86/88 = after 86/88, 0 regressions |
| `constructor` seeded into the #2175 companion | `8303b5a373` | `Error/prototype/constructor/prop-desc`, `Set/…/set-prototype-constructor`, `WeakSet/…/weakset-prototype-constructor` | 146 rows, base and after outputs BYTE-IDENTICAL (124/146), 0 regressions |

#### Item 1 — `constructor` in the companion: the exclusion IS load-bearing, and the seed alone was not enough

The `memberCsv` exclusion stays, and the reason is in #4200's own header, not
just `native-proto.ts`'s one-liner: the glue CSVs drive a shared consumer that
mints a brand-keyed **method closure** per member, so a CSV entry would make
`Error.prototype.constructor` a callable refusal stub instead of the constructor
object — while `gOPD(p,"constructor").value === p.constructor` is a corpus
assertion. The companion is a **different table**, so seeding it is not blocked
by that; `builtin-proto-constructor-seed.ts` installs the SAME #4200 carrier, so
all three consumers agree by construction.

**The half that was not in the T2 sizing, and without which the seed flips
zero rows:** `native-proto-own-props.ts` answers `constructor` own
**unconditionally from ES5**, so `propertyHelper.js`'s `isConfigurable`
(`delete o[k]; return !hasOwnProperty(o, k)`) can never observe the delete. With
the seed in and that list unchanged, all three rows failed with exactly
*"constructor descriptor should be configurable"*. `constructor` now joins
`seededNativeProtoDataMembersByBrand` for a brand whose seeder actually
installed it, which routes the query to the companion; a brand with no carrier
seeds none and keeps the unconditional arm.

The T2 sizing said ~7 rows; the measured answer is **3**. `Date` and `Function`
decline (no identity-stable carrier — `15.2.3.3-4-{34,116}` and
`Date/prototype/constructor/prop-desc` stay #4200 follow-ups, and note
`Date === null` is genuinely true on this head, so `Date.prototype.constructor
=== Date` cannot hold until a carrier exists). `Iterator/prototype/constructor/
prop-desc` wants an **accessor** pair (`typeof desc.get === "function"`), which
the seeder does not install — same deferral as the #2175 accessor tier.

#### Items 2+3 — the T2 diagnosis pointed at the wrong layer; correct it before re-using it

T2 recorded these as a `carrier-bag-visibility.ts` gap ("there is no DATE
carrier"). **That is not the defect.** `__is_closure_prop_carrier` has covered
`__Date` / `__StandaloneRegExp` since #4008, and the RUNTIME is already right —
measured on this head before any edit:

| query | before | Node |
| --- | --- | --- |
| `d.prop1`, `Object.keys(d)`, `gOPN(d)`, `gOPD(d,"prop1")`, `Object.hasOwn(d,"prop1")` | correct | correct |
| `f(d)` where `function f(x){return x.hasOwnProperty("prop1")}` | **`true`** | `true` |
| `d.hasOwnProperty("prop1")` (statically-typed receiver) | **`false`** | `true` |
| `"prop1" in d` (statically-typed receiver) | **`false`** | `true` |

The `any`-typed spelling being RIGHT while the `Date`-typed spelling is WRONG is
the whole discriminator: it is a **compile-time fold**, not a missing store.
`compilePropertyIntrospection` / `compileInOperator` fold `structFieldNames ∪
checker properties`, and `__Date`'s field list is `["timestamp"]`. This is #4062
(`vec-named-key-presence.ts`) one receiver family further out; the new
`builtin-instance-key-presence.ts` carries the same only-widens-a-FALSE safety
argument that keeps it clear of the #4055-v1 −684.

for-in was the same class: a `(ref $__Date)` is not externref/anyref, so
`compileForInStatement` took the **static unroll**, which enumerated `Date`'s 44
declared members — all inherited, all non-enumerable, i.e. exactly the set
for-in must not yield — plus the `__@toPrimitive@64` CSV sentinel, and never the
own expando. `__protoidx_forin_push` was NOT involved; that suspicion in the T2
note can be dropped. The companion's `0xbd` flag word is correct
(`enumerable:false`), which is why the 44 names could not have come from it.

Files touched: `src/codegen/builtin-instance-key-presence.ts` (new),
`builtin-proto-constructor-seed.ts` (new), `native-proto.ts`,
`native-proto-own-props.ts`, `object-ops.ts`, `binary-ops-in.ts`,
`statements/loops.ts`, `closure-props.ts`.

Gotchas for the next lane in this area:

- **`compileForInStatement`, `compileInOperator` and `compilePropertyIntrospection`
  are all AT their #3400 ceiling.** The first cut of items 2+3 added a comment
  and a second `if` at each site and failed the func-budget gate by +12/+6. The
  fix was to merge both questions into one `carrierBagKeyNeedsRuntime` call and
  move the rationale into the new module — net-zero lines at every site, no
  allowance needed. Budget the wiring, not just the logic.
- **A carrier emitter can shift `__defineProperty_value`.**
  `emitBuiltinConstructorIdentity` / `emitBuiltinNamespaceObject` may register a
  late import, which shifts every DEFINED func index — including the one
  `ensureNativeProtoCompanionSeeder` captured before its member loop. The seed
  arm runs FIRST and the loop re-reads the index afterwards.
- **`delete <B>.prototype.<seeded method>` still does not retract
  `hasOwnProperty`** — measured here, unchanged by this work: `delete
  Number.prototype.toFixed` returns `true` and `gOPD` goes `undefined`, but
  `hasOwnProperty("toFixed")` stays `true`. `__nproto_delete` rewrites the CSV
  while the seeded-member ladder reads the companion, and the two disagree. Not
  in scope here; it is the same shape as the `constructor` half above and
  probably one fix.
- The worktree's `test262/` symlink is recreated as a dead cross-worktree
  symlink farm between Bash calls; re-link it in the SAME invocation as any
  probe run.

## Wave-5 lane T5 — slice T5-A: a module-global array literal was DISCARDED (2026-08-22)

Base `7dd91b7bad`, `--target standalone`, in-process `runTest262File` probe.
The follow-up wave-4 lane J owed as "module-global array-carrier corruption".

### What was wrong — the initializer was never compiled

`collectShapes` (shape-inference.ts) classifies a module-level variable as
"array-like" when it sees BOTH a numeric-index write and a `length` write on
it — built for `var obj: any = {}; obj.length = 3; obj[0] = 10;`.
`applyShapeInference` then retypes that module global to a concrete vec struct,
and the declaration site in `statements/variables.ts` seeded it with an EMPTY
vec and `continue`d — **without compiling `decl.initializer` at all**.

The two signals are also exactly what ordinary ES5 array code emits, so:

```js
var x = [0, 1, 2];
x[4294967294] = 4294967294;   // numeric-index write
x.length = 2;                 // "length" field write
x[1];                         // 0 — the literal was thrown away
```

`[0, 1, 2]` was replaced by `{length: 0, data: array.new_default(4)}` and every
element read answered the zero (or `NaN`, read into an f64 slot) — including
reads that appear textually BEFORE both writes, since the substitution happens
at the DECLARATION. Confirmed by WAT diff on the one-line A/B: with the `length`
write the module init emits `i32.const 0 / i32.const 4 / array.new_default`,
without it `f64.const 0 / f64.const 1 / f64.const 2 / array.new_fixed 3 3`.

Measured isolations, all on this head, all reproducing lane J's report:

| source (module scope)                    | `x[1]` before | after |
| ---------------------------------------- | ------------- | ----- |
| `x[100]=7; x.length=2`                   | `NaN` / `0`   | `1`   |
| `x[3]=7; x.length=2`                     | `0`           | `1`   |
| `x.length=2; x[100]=7` (order swapped)   | `0`           | `1`   |
| `x[1]=9; x.length=2` (non-GROWING store) | `9` ✓         | `9`   |
| `x[3]=7` alone                           | `1` ✓         | `1`   |
| `x.length=2` alone                       | `1` ✓         | `1`   |
| the whole thing in a function expression | `1` ✓         | `1`   |
| `y.length=2` (length write on a SIBLING) | `1` ✓         | `1`   |

The last four are why it never showed: `collectShapes` walks module scope only,
and needs BOTH signals on the SAME name — so the shapes that got checked were
the ones that were already right.

### The change

New module `src/codegen/shape-vec-literal-seed.ts` owns the seed.
`emitShapeInferredVecInit` carries the literal's elements when the initializer
is a non-empty array literal with no spread and no elision, by calling
`compileArrayLiteral` with its `forcedElementType` parameter — which re-keys the
literal through `getOrRegisterVecType` to the SAME `vecTypeIdx` the global was
retyped to, so the seed cannot disagree with the global's declared type. Every
other initializer keeps the empty-vec seed byte-identically.
`statements/variables.ts` loses the inline emission and gains the call plus the
`ctx.moduleGlobals.get(name)` re-read the generic arm next to it already does
(compiling a literal can shift globals via `addStringConstantGlobal`).

All four gates clean — no LOC / func / coercion / oracle allowance needed.

### Measured

| row | before | after |
| --- | ------ | ----- |
| `built-ins/Array/length/S15.4.5.2_A3_T4` | `x[1]` is `0`, expected `1` | **PASS** |

Control, file-copy A/B against the base `variables.ts`: a 150-row deterministic
sample of the 630 files under `built-ins/Array/{length,prototype/{join,push,pop,
slice,indexOf,concat,toString}}`, `language/statements/for-in` and
`built-ins/Object/keys` — **93/150 pass on base, 93/150 after, and all 150
statuses identical row-for-row.** Zero regressions.

### Declined in the same family, with reasons

- **Spread and elision initializers** (`var x = [...a]` / `var x = [0, , 2]`)
  keep the empty seed, i.e. they are still lossy. A spread needs the runtime
  concat/grow machinery rather than a constant seed, and an elision is a HOLE
  whose faithful representation is the f64-hole value-representation wall
  (`$Hole` is externref-only) — seeding `0` there swaps one wrong answer for
  another. Neither shape appears in the ES5 rows this slice targets.
- **`built-ins/Array/S15.4_A1.1_T10`** — still the sparse-STORAGE wall lane J
  priced (`x[k-2]` must round-trip a value at index `4294967294`). Verified
  unchanged by this slice: same `array element access out of bounds` trap
  before and after.

## Handover (T5, team-dev-3, 2026-08-22)

Branch `worktree-agent-abfb03fcc1e8b8df1`, worktree
`/home/user/js2/.claude/worktrees/agent-abfb03fcc1e8b8df1`. Not pushed, no PR.

**INTEGRATION-READY — gates green, control clean**

| slice | rows | control |
| --- | --- | --- |
| T5-A module-global array-literal seed | `built-ins/Array/length/S15.4.5.2_A3_T4` fail → **pass** | 150 rows, 93/150 both sides, all 150 statuses identical |

Files: `src/codegen/shape-vec-literal-seed.ts` (new),
`src/codegen/statements/variables.ts` (dispatch only).

**WIP — do NOT integrate as-is**

| slice | state |
| --- | --- |
| T5-C prototype-installed ToPrimitive | behaviour verified (`String(q)` / `"" + q` on an `F.prototype.toString` instance; `slice/S15.5.4.13_A1_T5`'s first blocker cleared), gates green — but the 150-row ToString-terminal control moves `built-ins/Error/prototype/no-error-data` pass → fail with a compile-time REFUSAL. Needs the demand gate described in its section above. |

Files: `src/codegen/proto-method-to-primitive.ts` (new),
`src/codegen/class-to-primitive.ts` (wiring only). Its pre-edit copy is
`.tmp/base-class-to-primitive.ts`, so reverting is one `cp`.

**Reverted, with the measurement on record above**: the T5-B `hasOwnProperty`
numeric-vec index widening — one row regresses, blocked by the f64-hole wall.
The change itself was a single gate, `elemIsRef` → `vecInfo !== null`, in
`compilePropertyIntrospection`; `.tmp/base-object-ops.ts` is the pre-edit copy.
The literal-`toString` predicate half is likewise reverted;
`.tmp/base-member-override-scan.ts` is its base copy.

**Exact next steps, in value order**

0. **Demand-gate the T5-C tail** (or revert it) — see its section. Until then
   only T5-A is integrable.
1. **The borrowed-method receiver-ToString path** — blocks
   `slice/S15.5.4.13_A3_T4` and its charAt / charCodeAt / indexOf / lastIndexOf /
   substring siblings (9 `__FACTORY.prototype` files under
   `built-ins/String/prototype/`). Repro pair is already written:
   `.tmp/probe/d3i.js` vs `.tmp/probe/d3j.js`. Find why the stored-borrowed-method
   call does not demand `ensureAnyToStringHelper`.
2. **The decline target for a literal-declared `toString`** — make the
   non-static route answer the own slot instead of `null`, then re-apply the
   predicate half (one function, ~20 lines, drafted and measured).
3. **Length-shrink element deletion on an f64 vec** is the real blocker under
   both T5-B and lane J's concat gate; both wait on the value representation.

**Gotchas for the next lane in this worktree**

- `test262/` is restored as an empty real directory by the harness after most
  tool calls — `.tmp/p.sh` / `.tmp/rl.sh` re-link it on every invocation, so run
  probes through those, never bare `npx tsx`.
- `compileSource` rejects `{ standalone: true }`; use `{ target: "standalone" }`
  (`.tmp/wat.mts` does).
- Probe harness: `.tmp/run.mts <abs.js | path-under-test262/test>`,
  `.tmp/runlist.mts <list> <out>`, `.tmp/cmp.mts <base> <after>`,
  `.tmp/mk-control.mts` / `.tmp/mk-grep.mts` / `.tmp/sample.mts` to build row
  lists. Every row list and both A/B result sets are left in `.tmp/`.

---

## Wave-5 lane T7 result — slices A + B re-landed (team-dev-5, 2026-08-22)

Base `7dd91b7bad`, worktree `agent-a5b44a9cd1ef5cff0`. This lane implements the
T7 plan above; that plan's own implementation was lost with its worktree (see
the correction note under its slice table). Everything here is a fresh
measurement on this base with the real `runTest262File`, `--target standalone`,
the quickjs provider ACTIVE on every run (tier line
`QUICKJS (artifact 073742801ba7, adapter key 1429ec7ecf2163fd)`).

### Row set re-verified on HEAD before any edit

Of the 13 candidate rows pulled from the standalone baseline, **2 already
passed** on this base and are not counted as flips:
`built-ins/Function/prototype/S15.3.4_A1.js` and
`built-ins/Function/15.3.5.4_2-14gs.js`. That second one matters for the plan's
arithmetic: slice D was sized at **5** poison-pill rows, and the whole
`15.3.5.4_2-*gs` family now has exactly **one** failing member
(`-8gs`). Slice D is a 1-row residual today, not a 5-row one.

### Flipped

| row | base | after |
| --- | --- | --- |
| `built-ins/Function/S15.3.5_A1_T1.js` | fail | **pass** |
| `built-ins/Function/S15.3.5_A1_T2.js` | fail | **pass** |
| `built-ins/Object/prototype/toString/Object.prototype.toString.call-function.js` | fail | **pass** |
| `built-ins/Function/S15.3.3_A1.js` | fail | **pass** |
| `built-ins/Function/S15.3.3_A3.js` | fail | **pass** |
| `built-ins/Function/prototype/S15.3.3.1_A3.js` | fail | **pass** |

Slice A is the first three, slice B the last three. Measured independently: the
slice-A-only build flipped exactly its three and left the slice-B rows failing.

### What each slice actually changed

**A** — one arm in `resolveObjectToStringTag` (`object-proto-tostring.ts`)
recognising the ambient `Function` / `CallableFunction` / `NewableFunction`
symbols, through `deferOrStandalone` so host output is untouched. The value's
own `typeof` already said `"function"`; the fold said `[object Object]`, so the
module contradicted itself about one value.

**B** — new module `runtime-eval-intrinsic-own-props.ts` (203 lines) splices a
`$RuntimeEvalInterpretedCallback` arm, gated on `kind = INTRINSIC_FUNCTION`,
onto `__hasOwnProperty`, `__object_hasOwn` and `__delete_property` — all three
`(externref, externref) -> i32`, which is why one emitter serves them.
`src/codegen/index.ts` gets four lines of finalize wiring next to
`fillRuntimeEvalCallablePropertyGetArm`, and nothing else.

Two details worth carrying forward:

- **`delete` shipped in the same change as visibility** (#4010's ordering law).
  `verifyNotConfigurable` is `delete obj[name]` followed by `hasOwnProperty`,
  so visibility without a matching `delete` answer reads as
  `configurable: true`. §20.2.2 makes `Function.prototype`
  `configurable: false`, so the arm answers `false` for that key.
- **`length` / `name` are deliberately NOT claimed by the delete arm.** They are
  `configurable: true`, and the marker has no store to record a tombstone in, so
  a `delete` answering `true` would leave the key visible — the same
  two-surfaces-disagree defect the slice exists to remove. Stated residual:
  `delete Function.length` does not remove it. `Object.getOwnPropertyDescriptor(
  Function, "length")` was already correct on base
  (`built-ins/Function/length/15.3.3.2-1.js` passes) and is untouched.

### Correction to the plan's slice-B framing

The plan lists `gOPD` as part of the missing surface. Measured: it is **not**
missing. `Object.getOwnPropertyDescriptor(Function, "length")` already returns
`{value: 1, writable: false, enumerable: false, configurable: true}` on base —
that is why `Function/length/15.3.3.2-1.js` passes. Only `hasOwnProperty` /
`__object_hasOwn` / `delete` were blind to the marker.

### Declined, with the measurement that prices it

- **A GENERIC marker's own `prototype`** (`Function(src).hasOwnProperty(
  "prototype")` → `false`, `f.prototype` → `undefined`,
  `Object.getOwnPropertyNames(f)` → `length,name`). §20.2.1.1 says it should
  exist, but nothing can hand it back: every field of
  `$RuntimeEvalInterpretedCallback` is immutable, so a lazily-minted prototype
  object needs a **mutable slot on a struct type shared structurally with the
  separately compiled provider module** — a cross-module ABI change that also
  invalidates the adapter cache key for every lane. One row
  (`Function/prototype/S15.3.5.2_A1_T1.js`). Claiming `prototype` in
  `hasOwnProperty` without minting the object would make the two surfaces
  disagree, so it is not a cheaper half-measure.
- **`Object.getPrototypeOf(f) === Function.prototype`** → `false`. Confirmed
  the plan's own correction: this is the `$Object.$proto` vs `$NativeProto`
  wall, not a provider defect. `Object.getPrototypeOf(f)` answers **`null`**
  today, and `%Function.prototype%` exists as TWO objects by design —
  `emitFunctionPrototypeObjectSingleton` (array-object-proto.ts) mints the
  proto-CHAIN target as a plain `$Object`, explicitly "distinct from the
  `Function` `$NativeProto` glue used for `Function.prototype.<member>` VALUE
  reads", which is what a bare `Function.prototype` read yields. So returning
  the chain singleton would not make the `===` true. Already priced at 4 rows in
  the wave-5 table; out of T7's scope.
- **Slice C (box re-hydration).** Re-measured and the plan's verdict stands. An
  eval-returned RegExp crosses as the #4245 mirrored box: `typeof` `object`,
  `Object.getOwnPropertyNames` → `lastIndex` only, `source`/`global` →
  `undefined`, `r.test("abbc")` → `TypeError: called value is not a function`,
  tag `[object Object]`. **Probe hygiene note for whoever takes this:** a
  LITERAL `eval("/ab+c/gi")` is folded at compile time and does not exercise the
  seam at all — it answers `source` `ab+c` and `test` `true` while `flags`
  reads `3` (the raw internal bitmask) and `global` is `undefined`. Only a
  non-constant source (`eval(src + "")`) reaches the box. Measuring the folded
  form would price this slice as nearly-working when it is not.

### Controls

| control set | rows | slice A build | slice A+B build |
| --- | --- | --- | --- |
| `built-ins/Object/prototype/toString/`, `Function/prototype/{call,apply}/`, `built-ins/eval/`, `language/eval-code/`, the `Function` top level and `Function/prototype` top level — every row the standalone baseline calls `pass` | 597 | 596 pass, 1 non-pass | 596 pass, 1 non-pass (same row) |

Both builds were swept in full; the two runs are identical row-for-row.

The single non-pass is `built-ins/Object/prototype/toString/prop-desc.js`
("toString descriptor should be configurable"), and it is **pre-existing, not
collateral**: re-measured on base `7dd91b7bad` with both slices reverted by file
copy, it fails identically. The stale standalone baseline calls it `pass`, which
is exactly why every control non-pass gets a base run rather than a shrug.

The set was chosen to cover both blast radii: slice A changes a fold every
`Object.prototype.toString.call` site consults, and slice B changes three
`__*` natives in **every module that links the provider**, which is what the
`built-ins/eval` + `language/eval-code` half is there to exercise.

**Harness note that cost this lane two runs, recorded because it silently
fabricates failures:** the agent worktree's `test262/` is periodically
re-materialized by the harness as a tree of symlinks into a DIFFERENT (often
dead) agent worktree, mid-run. The tail of a sweep then reports `THREW … ENOENT`
for rows that are fine. Repairing the symlink once at process start is not
enough — the runner script must re-check it before every row, and the sweep must
be launched as a harness-managed background task rather than a detached
`nohup … &`.

---

## Handover (T7, team-dev-5, 2026-08-22)

Worktree `agent-a5b44a9cd1ef5cff0`, branch
`worktree-agent-a5b44a9cd1ef5cff0`, base `7dd91b7bad`.

### Doc-only vs re-implemented — read this first

The `## Implementation Plan (T7)` section earlier in this file is **entirely
doc-only with respect to `main` and to every live branch.** Its author's
worktree died in the restart; the text survives only because it rode into
`a83b809a3b`, a team-dev-2 fix commit whose diff also carried 241 lines of this
issue file. Concretely:

| plan slice | plan says | actual state after this lane |
| --- | --- | --- |
| A — §20.1.3.6 tag | "LANDED" | **doc-only there; re-implemented here** (commit `9f2718120b`) |
| B — `%Function%` own-key surface | "LANDED" | **doc-only there; re-implemented here** (commit `9f2718120b`) |
| C — provider-box re-hydration | "NOT ATTEMPTED" | still not attempted; verdict re-measured and upheld |
| D — poison pills | "NOT ATTEMPTED", 5 rows | still not attempted; **re-counted as 1 row**, not 5 |

The plan's *design* was correct and was followed verbatim; only its verdict
column was false. Its two measured corrections to wave-4 lane G (the
`call`/`apply` `_A1_T*` rows being the `[[Prototype]]`-slot wall, not the
provider seam) were re-verified here and stand.

### Done, measured, gates green

One commit: **`9f2718120b`** — `fix(#4491): provider-realm %Function% answers
its own tag and own keys (T7 A+B)`. Integration-ready. All four required gates
run clean on it (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`), plus lint-staged prettier/biome.

**6 rows flipped**, each verified fail→pass on this base:
`built-ins/Function/{S15.3.5_A1_T1,S15.3.5_A1_T2,S15.3.3_A1,S15.3.3_A3}`,
`built-ins/Function/prototype/S15.3.3.1_A3`,
`built-ins/Object/prototype/toString/Object.prototype.toString.call-function`.

Files touched:

- `src/codegen/object-proto-tostring.ts` (+27) — slice A, one arm in
  `resolveObjectToStringTag`.
- `src/codegen/runtime-eval-intrinsic-own-props.ts` (new, 203) — slice B, the
  whole body.
- `src/codegen/index.ts` (+9) — finalize wiring only, both the single-source and
  multi-source paths, next to `fillRuntimeEvalCallablePropertyGetArm`.

### In flight at wrap-up

**Nothing.** No uncommitted `src/` changes, and both 597-row control sweeps
(slice-A-only and slice-A+B) ran to completion at 596/597 with the same single
pre-existing non-pass. The lane is integration-ready as it stands.

### Exact next steps, in the order they pay

1. **Slice D, now a 1-row residual** — only `built-ins/Function/15.3.5.4_2-8gs.js`
   still fails in that family (`-14gs` passes on this base; the plan's "5 rows"
   is stale). Diagnose before budgeting anything: it may not need the seam work
   the plan assumed.
3. **Slice C stays parked.** Its blocker is one step earlier than the box: the
   caller's realm object exposes no `RegExp` for the adapter to mint through
   (`Function("return this;")()` → `typeof G.Array` `"function"`, `typeof
   G.RegExp` `"undefined"`), and fixing it invalidates the quickjs adapter cache
   key for every lane. Use a NON-constant eval source when probing it — a literal
   `eval("/ab+c/gi")` is constant-folded and never reaches the seam.
4. **Do not** try to make `Function(src).hasOwnProperty("prototype")` true
   without also minting the prototype object; see the "Declined" list above for
   why the half-measure is worse than the current answer.

### Gotchas for the next lane in this area

- **`test262/` in an agent worktree is re-materialized mid-run** (see the
  harness note above). Re-check the symlink before every row; launch sweeps as
  harness-managed background tasks.
- **The pre-commit chain times out at 2 min.** Use
  `SKIP_SLOW_PRECOMMIT=1 git commit …` (never `--no-verify`), and keep the
  checklist `✓` **on the command line** — the hook reads the command text, so a
  `-F <file>` message whose `✓` is inside the file is rejected.
- **`.test262-cache/` is per-worktree.** Copy the `quickjs-eval-adapter-*.wasm`
  and `quickjs-artifact-*` entries from `/home/user/js2/.test262-cache/`, and
  expect to rebuild anyway (`npx tsx scripts/build-quickjs-eval-provider.mjs`)
  — the adapter key is derived from compiler source, so any `src/` edit that
  changes it forces a ~3 s rebuild. Without it the provider is INACTIVE and
  every row in this area probes the wrong thing.
- **The standalone baseline JSONL is stale enough to matter**: of 13 candidate
  rows, 2 already passed, and one control row it calls `pass` fails on base.
  Verify every row on your own HEAD, and base-check every control non-pass.

## Implementation Plan (T8) — f64-hole value representation (2026-08-22, lane w5-t8)

Base `6b513c7155`, `--target standalone`, in-process `runTest262File`. Every
number below is a run this lane executed; the pre-edit copies
(`.tmp/base-literals.ts`, `.tmp/base-assignment.ts`, `.tmp/base-array-methods.ts`)
and both A/B result sets are in the worktree's `.tmp/`.

### The wall is NOT (mainly) the literal elision

The dispatch brief and the earlier lane-J verdict both frame this as
"`[0, , 2]` in an f64 vec". Re-measuring each named row against its ACTUAL
error says otherwise — only one of them is a literal elision at all:

| row | measured failure on base | real cause |
| --- | --- | --- |
| `toString/S15.4.4.2_A1_T2` | `x=[]; x[0]=0; x[3]=3; x.toString()` → `"0,0,0,3"`, want `"0,,,3"` | **grow-gap**: `array.new_default` zero-fills the f64 backing, and `0` is a legal element |
| `concat/S15.4.4.4_A3_T2` | `b[1]` is `0`, want `undefined` | same grow-gap |
| `concat/S15.4.4.4_A1_T4` | `arr[2]` is `NaN`, want `undefined` | `undefined` in an f64 carrier is not observed at `SameValue` |
| `concat/S15.4.4.4_A1_T2` | `arr[1]` is `NaN`, want an object | concat result element type drops a ref element — not a hole bug |
| `Array/S15.4_A1.1_T10` | trap: `array element access out of bounds` | the sparse-STORAGE wall (index `4294967294`), already priced by lane J |
| `filter/15.4.4.20-9-b-{7,11,14,15}` | callback sees `NaN` at the hole and the index is COUNTED | presence, not value |

`array-holes.ts` states the scope limit in its own header ("typed `number[]`
… never see a `$Hole`"), and `expressions/assignment.ts` states it from the
other side, in the #2773 S7 gap-fill: *"Externref elements only: an f64/i32
slot cannot hold either representation."* That sentence is the wall, written
down. **For f64 it is false** — the compiler has had an f64 absence marker
since #1024: `UNDEF_F64_BITS` (`value-tags.ts`), the SIGNALING NaN
`0x7FF00000DEADC0DE`. JS arithmetic only ever yields the QUIET NaN
`0x7FF8000000000000`, so it cannot collide, and ~28 observer sites already
read it as `undefined`.

### Behaviour of `var x=[]; x[0]=0; x[3]=3` on base (function scope, standalone)

`toString "0,0,0,3"` · `join "0,0,0,3"` · `x[1] === 0` · `1 in x` true ·
`hasOwnProperty("1")` false · `Object.keys` `0|1|2|3` · `forEach` visits 4.
(Correct: `"0,,,3"` · `x[1] === undefined` · `1 in x` false · keys `0|3` ·
forEach visits 2.)

### The three options, measured

**(b) Demote hole-bearing literals/arrays to externref vecs at collect time —
MEASURED LOSER, and structurally so.** One-line spike in
`compileArrayLiteral` (widen `elemWasm` to `externref` whenever any element is
an `OmittedExpression`), which is the smallest possible form of the
markStandalone*Targets pattern:

| set | base | spike (b) |
| --- | ---: | ---: |
| 112 elision-bearing rows under `built-ins/Array`, `language/expressions/array`, `Object/{defineProperties,keys}` | **33 pass** | **21 pass** |

Twelve regressions, one gain. Two independent reasons, and the second is fatal
to the whole family:

1. `var x = [0, , 2]` is statically `number[]`, so the element READ still
   lowers to f64. The widened vec hands the read an externref, the `$Hole` maps
   to `undefined`, and `undefined` coerced to f64 is `NaN` — so
   `array[0] === undefined` went `true → false`
   (`language/expressions/array/S11.1.4_A1.{4,5,6,7}`). The `string[]` and
   object-array spellings were unaffected, which isolates it to the numeric
   read boundary.
2. **The construction site is not the authority on the representation.**
   `resolveWasmType` is: every CONSUMER re-derives the carrier from the value's
   TS type. A construction-site override desyncs producer and consumer. Proven
   twice — once by (1), and again by a second spike that gave
   `compileArrayConstructorCall` the null/undefined widening
   `compileArrayLiteral` already has (`hasNullLiteral`): `Array(undefined,1,
   null,3).toString()` went `",1,0,3" → "NaN,1,0,3"` — the producer widened,
   the consumer did not, and the result got *worse*. `literals.ts` already
   names this as the open decision, in the #2809 comment on that exact
   function.

   Widening only works where producer and consumer agree by construction —
   which is why the existing `hasNullLiteral` / `hasObjectElem` widenings are
   safe (they fire where TS itself infers a non-numeric element type) and a
   hole-driven one is not (TS infers `number[]` for `[0, , 2]`).

**(c) Presence bitmap** — declined without a spike, on two grounds that do not
need one. It is strictly more state than a value marker (every grow, store,
delete, length-set and copy must maintain it in lockstep), and it does not
survive the carrier: a third struct field means a nominal subtype, so any code
compiled against plain `$__vec_base` — which is most of the dynamic path —
loses the bitmap silently. A value marker travels inside the element and cannot
be lost. The one precedent for a nominal holey carrier (#4222's
`$__holey_array` + `holey-array-presence.ts`) is deliberately narrow for
exactly this reason: it is minted only for a proven `new Array(n)` → `.filter`
path, and even there only `__extern_has_idx` knows about it.

**(a) NaN-boxed marker — WINNER.** It is the only option where producer and
consumer cannot disagree, because the marker rides inside the f64 value; it
needs no type-system change, no struct change, no allocation; the grow path is
where holes are actually created and it already emits an `array.fill` for the
externref carrier; and it composes with the T5 case (a `length` shrink-then-grow
leaves stale slots — filling them with the marker is the same one-line fill).

Blast radius on the f64 fast path: **zero for dense numeric code**. The fill is
inside the existing `needsGapFillCondInstrs` guard (`idx > length`), which is
false at every step of `for (i…) a[i] = v` and of `push`, so the dense-fill and
counted-push kernels emit byte-identical code. The #1897 `struct.get` contract
is untouched — no field is added, moved, or retyped.

### Value half vs presence half — the split, and why the marker must eventually fork

`UNDEF_F64_BITS` means **undefined**, not **absent**. Reusing it gets every
VALUE question right (`x[1] === undefined`, `join`/`toString` render `""` —
which is also what an explicit `undefined` element renders, so the arm is right
either way) and leaves every PRESENCE question wrong (`1 in x`,
`Object.keys`, HOF hole-skip), because `x[1] = undefined` writes the same bits
and must answer PRESENT.

The presence half therefore needs a SECOND, distinct sNaN payload
(`HOLE_F64_BITS`, e.g. `0x7FF00000DEADC01E`) plus:

1. **Canonicalization at the vec read boundary** — `HOLE → UNDEF_F64_BITS` at
   the ~8 sites that already call `emitHoleToUndefined` for externref
   (`property-access.ts` 5717/5838, `statements/loops.ts` 1808,
   `array-methods.ts` 777/6207/6419, `expressions/assignment.ts` 2242/2341),
   extended to `element.kind === "f64"` under `ctx.usesArrayHoles`. This keeps
   the "the sentinel is never observed AS the sentinel" invariant that
   `array-holes.ts` already states, so none of the ~28 `UNDEF_F64_BITS`
   observers need to change.
2. **A per-carrier hole test in `__extern_has_idx`'s vec arm** — today that arm
   answers on `i < length` alone (`array-filter-spec-access.ts` L105 says so).
   The shape to copy is `fillExternGetIdxVecArms` (`object-runtime.ts` L7702),
   which already walks `ctx.vecTypeMap` and emits one `ref.test`-guarded arm per
   carrier; the f64 carriers get `array.get` + the bit compare, every other
   carrier keeps today's answer.
3. **`forceHasProperty` on the native HOFs when `ctx.usesArrayHoles`** — the
   `hof-native.ts` switch that `ensureHoleyArrayFilter` already flips for the
   #4222 carrier.

That is the design; it is NOT this slice. It is a second slice with its own
control run, and it should not start until the value half is landed and
measured, because (1) is the piece that would otherwise silently change what
~28 existing observers see.

### Slice T8-A (this slice) — the value half

New module `src/codegen/vec-f64-hole-gap.ts` owns both bodies; the two god-files
get dispatch wiring only.

1. `emitF64GapFillInstrs` — the f64 twin of the #2773 S7 gap-fill. Same
   `needsGapFillCondInstrs` guard, same `array.fill`, `UNDEF_F64_BITS` in place
   of the `undefined` externref. `expressions/assignment.ts` gains one `else if
   (arrDef.element.kind === "f64")` arm + one import.
2. `f64JoinSentinelArm` — §23.1.3.18 step 4.b for the marker inside
   `compileArrayJoinNative`'s element fold. The JS-host `compileArrayJoin` has
   had this since #1998 (`array-methods.ts` L4686); the standalone native fold
   never grew it, so the same array joined as `"0,NaN,NaN,3"` host-free.
   `array-methods.ts` gains the arm call + one import.

Neither is gated on a new flag: the gap-fill fires only where a store grows past
`length` (a state that was previously unrepresentable, so there is no prior
behaviour to preserve), and the join arm fires only on a bit pattern that JS
arithmetic cannot produce.

### The one hazard the value half introduces, stated plainly

Filling a gap with the marker changes an arithmetic HOF over a sparse array
from **quietly** wrong to **loudly** wrong. Measured on
`var a=[1,2,3]; a[6]=5;` (function scope, standalone):

| expression | correct JS | base | after T8-A |
| --- | --- | --- | --- |
| `a.reduce((s,x)=>s+x, 0)` | 11 (holes skipped) | 11 (the gap `0`s are additive identity — right by luck) | NaN |
| `a.reduce((s,x)=>s*x, 1)` | 30 | **0** | NaN |
| `a.join(",")` | `"1,2,3,,,,5"` | `"1,2,3,0,0,0,5"` | `"1,2,3,,,,5"` ✓ |
| `a[4] === undefined` | true | **false** | true ✓ |

Neither column is spec-correct for the HOFs — only hole-SKIPPING is, and that
is the presence half. The value half makes the failure visible instead of
plausible. No row in the 292 measured here exercises it, but the next lane
should know the trade before extending the marker to `push`, `concat` or the
`length` setter.

### Measured — slice T8-A

Base `6b513c7155`. Every control is a FILE-COPY A/B (`.tmp/base-assignment.ts`,
`.tmp/base-array-methods.ts` are the pre-edit copies) run on both sides on this
head; no `git stash`.

| row | before | after |
| --- | --- | --- |
| `built-ins/Array/prototype/pop/S15.4.4.6_A1.2_T1` | check #8: `x=[]; x[0]=0; x[3]=3; x.pop(); x[2]` is `0`, expected `undefined` | **PASS** |
| `built-ins/Array/prototype/shift/S15.4.4.9_A1.2_T1` | same idiom, same check | **PASS** |
| `built-ins/Array/prototype/toString/S15.4.4.2_A1_T2` | fails at check #2.2 (`x.toString()` is `"0,0,0,3"`) | still fails, now at check **#3.2** — two checks further on. Its remaining blocker is `Array(undefined,1,null,3)`, i.e. `null` in an f64 carrier, which is the #2809 representation question, not a hole. |

Controls, all statuses compared row-for-row:

| control set | base | after | changed |
| --- | ---: | ---: | ---: |
| 180 dense-numeric Array rows — a deterministic stride sample over `map`, `reduce`, `reduceRight`, `sort`, `join`, `push`, `pop`, `indexOf`, `lastIndexOf`, `slice`, `forEach`, `toString`, `concat`, `filter`, `Array/length` (1,872 files) | 117 | 117 | **0** |
| 150 sparse-index-store rows — stride sample of the 508 files under `built-ins/Array` + `language/expressions/array` that write a literal numeric index, excluding rows already in the other two sets | 73 | **75** | **+2, both gains** |
| 112 elision-bearing rows (`built-ins/Array`, `language/expressions/array`, `Object/{defineProperties,keys}`) | 33 | 33 | **0** |

Perf sanity — `compileSource(…, { target: "standalone" })` on the numeric
playground samples, module byte size:

| sample | base | after |
| --- | ---: | ---: |
| `website/playground/examples/benchmarks/array.ts` | 54,651 | 54,651 |
| `…/loop.ts` | 34,533 | 34,533 |
| `…/fib.ts` | 34,192 | 34,192 |

Byte-identical, which is the expected result rather than a lucky one: the fill
is inside the `idx > length` guard, and none of these samples ever stores past
`length`.

Gates: `check-loc-budget` OK · `check-func-budget` OK (one new allowance,
`compileElementAssignment`, rationale in the frontmatter) · `check-coercion-sites`
OK · `check:oracle-ratchet` OK (this slice makes no checker query at all).

### Presence is INCONSISTENT today, which is a design constraint for the next lane

On the same `x=[]; x[0]=0; x[3]=3`, the three presence paths disagree with each
other on base AND after:

| query | answer | correct |
| --- | --- | --- |
| `1 in x` | true | false |
| `x.hasOwnProperty("1")` | **false** | false ✓ |
| `Object.keys(x)` | `0,1,2,3` | `0,3` |

So `hasOwnProperty` already answers a gap correctly while `in` and `Object.keys`
do not — they are three different code paths and only one of them consults
anything hole-aware. The presence half must make them agree, not just fix `in`;
a fix that moves `in` to `false` while `Object.keys` still lists the index would
swap one inconsistency for another.

### Handover (T8, lane w5-t8, 2026-08-22)

Branch `worktree-agent-a499924a5d891dcc1`, worktree
`/home/user/js2/.claude/worktrees/agent-a499924a5d891dcc1`. Not pushed, no PR.

**INTEGRATION-READY** — commit `aace92530b`, all four gates green, three control
sets measured on this head with zero regressions.

| slice | rows | control |
| --- | --- | --- |
| T8-A f64 grow-gap marker + native-join step 4.b | `pop/S15.4.4.6_A1.2_T1`, `shift/S15.4.4.9_A1.2_T1` fail → **pass**; `toString/S15.4.4.2_A1_T2` advances #2.2 → #3.2 | 180 dense-numeric 117/117 identical · 150 sparse-store 73 → 75 · 112 elision 33/33 identical · benchmark modules byte-identical |

Files: `src/codegen/vec-f64-hole-gap.ts` (new, both bodies),
`src/codegen/expressions/assignment.ts` + `src/codegen/array-methods.ts`
(dispatch only), plus the `func-budget-allow` entry for
`compileElementAssignment`.

**Next steps, in value order**

1. **The presence half** — the three pieces are named above with their exact
   sites. Do not start it as three separate slices: `in`, `hasOwnProperty` and
   `Object.keys` already disagree with each other today, so a partial fix swaps
   one inconsistency for another. It unblocks
   `filter/15.4.4.20-9-b-{7,11,14,15}` and the T5-B `hasOwnProperty` widening.
2. **Extend the marker to the other gap producers** — `push` past a gap, the
   `concat` result build (`concat/S15.4.4.4_A3_T2` needs `b[1] === undefined`
   on the concat OUTPUT), and the T5 length-shrink-then-grow stale slots. Each
   is the same `array.fill` with the same marker; each needs its own control run
   because of the arithmetic-HOF trade recorded above.
3. **`null` in an f64 carrier** blocks `toString/S15.4.4.2_A1_T2` at its new
   frontier (`Array(undefined,1,null,3)` → `",1,0,3"`). That is #2809's
   representation question, NOT a hole — and the widening spike proves it cannot
   be fixed at the construction site alone.

**Do NOT re-attempt** (measured, above): widening a hole-bearing array literal
or `Array(...)` call to an externref vec. Producer/consumer desync via
`resolveWasmType`; −12 rows measured on the 112-row elision set.

**Probe harness in this worktree**: `.tmp/run.mts <abs.js | rel-under-test262/test>`,
`.tmp/runlist.mts <list> <out>`, `.tmp/p.sh` wraps both and RE-LINKS `test262/`
and `node_modules/` first (`runlist.mts` also re-links before EVERY row — the
harness clobbers the symlink mid-run, which fabricates ENOENT sweeps).
`.tmp/wat.mts` is the compile-size sanity. Row lists: `t8-rows.txt`,
`t8-elision-scan.txt`, `t8-control.txt`, `t8-sparse150.txt`; both sides of every
A/B are in `.tmp/*.tsv`.

## Wave-5 lane T4 — re-triage on integration head `6b513c7155` (2026-08-22)

The stale 40-row list at `.tmp/wave5-T4.txt` was re-measured row-by-row on the
merged head before any edit. **17/40 already passed** — the slice-T4-A/B/C flips
plus, once the eval provider was available, the six §10.4.3 / §12.2.1
strict-mode `eval` rows and `10.4.3-1-19-s`/`-19gs`/`-20-s`/`-20gs` that T7's
provider-realm work had just turned green. Those 17 are NOT counted as flips.

### Blocker found first: the QuickJS eval provider will not BUILD on this head

`node scripts/build-quickjs-eval-provider.mjs` fails its own canary:

```
quickjs canary functionParityProbe() returned 1, expected 11
(a QuickJS-created function lost %Function% constructor identity, …)
```

`1` decodes as `constructorIdentity=0, appliedGlobal=1` — `new Function(src)`
returns a callable whose `.constructor` is not `%Function%`. It is the same
defect the T4 rows `S10.2.1_A4_T2` (`f1().constructor.prototype` is `undefined`)
and `10.4.3-1-83-s`/`-84-s` (`Function("…return f();")()` → `TypeError: not a
function`) report, i.e. the **provider-realm carrier-identity wall** — T7's lane,
fenced here rather than fought. It did NOT clear with `6b513c7155`.

**Consequence for anyone measuring eval-dependent rows: a clean worktree cannot
get an adapter at all**, because the build script writes the artifact only
*after* the canary passes. Every eval row then reports `JS2WASM_EVAL_ENGINE=
quickjs but the quickjs provider is not built`, which is indistinguishable from
"the row fails". This lane unblocked measurement with a canary-free build
(`.tmp/build-adapter-nocanary.mjs` — byte-identical adapter compile, no
`verifyQuickjsProvider`); the numbers below are therefore real, but CI on this
head would not produce the adapter.

### Confirmed by measurement: the harness clobbers `test262/` MID-RUN

The T7 lane's warning reproduced here: `test262/` was silently replaced by an
empty directory between rows, producing `ENOENT … /test262/harness/assert.js`.
The runner used for every number below repairs the symlink **before each row**
and retries once on any ENOENT; the repair fired 4× inside a single 40-row
sweep. A sweep without that repair fabricates failures.

### Slice T4-D — a redeclared `var` silently DROPPED its initializer

`var x = true; … var x = function () {};` is ONE binding. The checker types the
symbol from the FUNCTION declaration, so the slot is `(ref null $closure)` and
`coerceType` answers the boolean initializer with `ref.null`:

```wat
i32.const 1     ;; `true`
drop            ;; thrown away
ref.null 47
global.set 7    ;; x := null
```

`typeof x` still folds to `"boolean"` from the checker type, so value and tag
disagree and nothing errors. Measured on this head, `var b = true` followed by
`var b = function () {}`:

| probe | base | after |
| --- | --- | --- |
| `b === true` | **false** | true |
| `b === false` (for `var b = false`) | **false** | true |
| `b ? "T" : "F"` | **`"F"`** | `"T"` |
| `String(b)` | **`"[object Object]"`** | `"true"` |
| `typeof b` | `"boolean"` | `"boolean"` |
| object-typed redeclaration (`var a = true; var a = {}`) | already correct | unchanged |

This is the DECLARATION-vs-declaration half of #4204/#4206's rule: that analysis
asks exactly the right question but only of `BinaryExpression` assignment nodes,
and its own `collectModuleScopedVarsByName` keeps just the FIRST declaration per
name — so the identical hazard arrives through a carrier the walk never visits.

**Change.** New module `src/codegen/declarations/redeclared-var-widening.ts`
(all new bodies; `declarations.ts` and `statements/variables.ts` get one dispatch
line each). Widens to `externref` only when: module scope, ≥2 declarations of the
name, at least one initializer tagged a specialized-slot primitive
(`number`/`string`/`boolean`/`bigint` — reusing
`HETEROGENEOUS_PRIMITIVE_SLOT_TAGS` rather than forking it), another
declaration's tag differs, and no explicit TypeScript annotation (the annotation
is the representation contract, the same carve-out #4204 makes). `mixed` counts
as different, per #4206.

The second dispatch line is not optional: the global and its `__module_init`
shadow local are one binding. With only the global widened, the closure
declaration allocates the local as `externref`, a LATER redeclaration re-enters
the generic local path — where the checker still reports the SYMBOL's (first
declaration's) `boolean` — and the retype ladder narrows the slot to `i32`. The
already-emitted `local.tee; global.set` then fails module validation with
`global.set[0] expected type externref, found local.tee of type i32`. Reduced by
delta-debugging `S11.1.5_A2` to its three load-bearing checks (`var x = true` /
`= function () {}` / `= this`).

**Flips: 0 rows on their own.** `S11.1.5_A2` advances from CHECK#1 to CHECK#2 and
still fails: `var object = {prop : x}` is redeclared 12 times with object
literals whose *field* representations disagree, which this analysis (keyed on
the top-level JS tag) does not see. Kept because it is a measured value-loss fix
with an identical control, not because it moves a row — see "Left open".

### Slice T4-E — `"valueOf" in {}` answered **false**

§7.3.12 HasProperty is prototype-inclusive and every ordinary object's chain ends
at %Object.prototype%, so its seven own names (§20.1.3) are `in` every object.
Standalone answered `false` for all of them:

| probe (`var o = {}`) | base | after |
| --- | --- | --- |
| `"valueOf" in o` | **false** | true |
| `"toString" in o` | **false** | true |
| `"hasOwnProperty" in o` | **false** | true |
| `"nope" in o` | false | false |
| `typeof o.valueOf` | `"function"` | `"function"` |

The read and the presence test disagree because they take different routes:
`o.valueOf` resolves statically against the checker's apparent type, while `in`
folds from own struct fields and then asks the runtime `__extern_has`, which
walks `$Object.$proto` — and an ordinary object's `$proto` is `null`, because
%Object.prototype% is a `$NativeProto`, not an `$Object`. That is the
`$Object.$proto` vs `$NativeProto` wall this file already prices. The failure is
easy to miss because the spelling one reaches for when checking (`o.valueOf`) is
the one that was never broken.

**Change.** New module `src/codegen/object-proto-name-in.ts` carries the §20.1.3
name set and the receiver-shape predicate; `binary-ops-in.ts` gets a two-line
consult where `has` is computed. `in` does not need the prototype OBJECT, only
its NAME SET, which is fixed by the spec — so this costs one membership test
instead of the priced representation change.

Deliberately bounded:

- **Only `in`.** `hasOwnProperty` / `Object.hasOwn` / `propertyIsEnumerable` are
  OWN-only by spec and are untouched — widening those is the #4017 −684 blast
  radius recorded above.
- **Affirmative-only.** It turns a wrong `false` into `true` and can never turn a
  `true` into `false`.
- **`for…in` cannot gain keys.** The enumerator builds its key list from
  `__object_keys_forin` and only re-checks liveness with `__extern_has` (#2066),
  so a name that was never enumerated cannot appear.
- **Standalone-only**, so the js-host lane — where `__extern_has` already answers
  correctly — stays byte-identical (the #1374 regression guard).
- **A null-prototype receiver stays wrong, and was already wrong.** Measured on
  base: `"toString" in Object.create(null)` ALREADY answered `true` via the
  non-`$Object` boundary arm. The fold makes the ordinary receiver agree with the
  exotic one rather than the reverse; it introduces no new disagreement.

**Flip: `language/expressions/in/S8.12.6_A2_T1` FAIL → PASS.**

### Measured, both slices together

40-row T4 set: **17/40 base → 18/40 after**; the diff is exactly one row
(`S8.12.6_A2_T1` fail→pass), 39 identical.

Control: 75 neighbours weighted toward what these touch — 10
`language/expressions/in`, 3 `delete`, 7 `for-in`, 11
`built-ins/Object/prototype/{hasOwnProperty,isPrototypeOf,propertyIsEnumerable,
toString,valueOf,toLocaleString}`, 9 other `built-ins/Object`, 7
`expressions/object`, 7 `statements/variable`, plus assignment / addition /
function / typeof / strict-equals / instanceof / with / switch / Array / String /
Boolean / Function rows. **57/75 base, 57/75 after — identical set**, verified by
file-copy A/B (never `git stash`). One listed path does not exist in this test262
checkout and is reported as such rather than counted.

### Left open, with the reason (measured, not assumed)

- **`S11.1.5_A2`** — now fails at CHECK#2 instead of CHECK#1. `var object` is
  redeclared 12× with object literals whose *field* representations disagree
  (`{prop: boolean}` vs `{prop: Boolean-wrapper}` vs `{prop: function}`), and the
  clash is invisible to a tag-level analysis: the checker reports `x` as
  `boolean` at EVERY one of those literals, because a widened binding keeps its
  first declaration's checker type. Closing it needs the object-literal FIELD
  slot to widen when its initializer reads a representation-widened binding — the
  `moduleGlobalIsDynamicButStaticallyPrimitive` idea applied to struct fields.
  That is a shape-analysis change, not a seeding change.
- **`S8.12.6_A2_T2` CHECK#2** — `Robin.prototype = __proto; "phylum" in new
  Robin()`. Measured: `Robin.prototype === __proto` is **true** while
  `Object.getPrototypeOf(r) === __proto` is **false**, and `r.phylum` still reads
  `"avis"` (static route). So the per-fnctor prototype global is right and the
  INSTANCE SEED loses it — `new F()` → `compileFnctorNewAsObject` →
  `__object_create(F.prototype)`. The inline spelling
  (`Robin2.prototype = {phylum:"avis"}`) answers `true` only because TS models
  that literal in the instance type; its runtime `$proto` is equally wrong. Same
  family as the priced `$proto` wall, one receiver further in.
- **`S11.8.7_A2.4_T1`** — `(NUMBER = Number, "MAX_VALUE") in NUMBER`: presence on
  a builtin CONSTRUCTOR object, a different substrate (namespace-object members)
  from either slice above.
- **`10.4.3-1-83-s` / `-84-s` / `S10.2.1_A4_T1` / `S10.2.1_A4_T2`** — the
  provider-realm `%Function%` identity wall (T7). Fenced, not attempted; they are
  the same defect the build canary reports.
- **`10.4.3-1-103/104/106`** — sloppy-mode `ToObject(thisArg)` for a primitive
  receiver (`(5).x` where the `Object.prototype` getter returns `this`).
  Untouched by this lane.
- **`10.4.3-1-102-s` / `-102gs`** — `illegal cast in __module_init` on
  `"ab".replace("b", function(){…})`. Untouched.
- **`annexB/language/function-code/*` (4 rows)** — B.3.3 sloppy block-level
  function hoisting: 3 fail `illegal cast in f()`, 1 fails to VALIDATE
  (`__call_fn_0`: `not enough arguments on the stack for call_ref`). A distinct
  hoisting/closure-arity defect, sized beyond this slice.
- **`expressions/call/11.2.3-3_3/_4/_8`** and
  **`expressions/object/11.1.5-0-1/-0-2`** — untouched; the first three are
  §13.3.6 TypeError shape, the last two are object-literal accessor ordering.

### Wave-5 T4 addendum — measured diagnoses for the two biggest rows left open

Both were reduced to a standalone repro on the committed head; neither is
attempted here, and both are stated so the next lane does not have to re-find
them.

#### annexB `function-code` (4 rows) — a FunctionDeclaration binding cannot hold a non-function

`annexB/language/function-code/block-decl-func-block-scoping` (and the
`switch-case` / `switch-dflt` twins) fail with `RuntimeError: illegal cast in
f()`. The body is §B.3.3's shape:

```js
{
  function f() { initialBV = f; f = 123; currentBV = f; return "decl"; }
}
```

`f = 123` writes a NUMBER into a binding whose Wasm slot is the closure struct.
Measured, on this head:

| shape | result |
| --- | --- |
| block-scoped `function f(){ … f = 123 … }` | **`RuntimeError: illegal cast`** — hard trap |
| function-scoped `function g(){ g = 123; … }` | **silently ignored** — `typeof g` stays `"function"`, `g` still the closure |
| function-scoped `function h(){…}; h = 7` | **silently ignored** — same |

This is the same "one binding, two representations" family as slice T4-D, but
for a **FunctionDeclaration** binding rather than a `var`, and at FUNCTION as
well as module scope. Two consequences for whoever picks it up: the silent arm
is the more dangerous one (no trap, wrong answer), and the widening analyses
that exist today (#4204/#4206 and T4-D) all key on `ts.VariableDeclaration`, so
none of them can see this declaration kind at all.

The fourth row, `block-decl-func-skip-arguments`, is a different defect: the
module does not VALIDATE — `Compiling function #515:"__call_fn_0" failed: not
enough arguments on the stack for call_ref`.

#### `expressions/call/11.2.3-3_{3,4,8}` — §13.3.6.1 evaluation order, and it only reproduces UNDER THE HARNESS

The bare shapes are all correct on this head. `o.bar()`, `o.bar.gar()`,
`p.n()` (a number-valued property) and `this.bar()` each throw a real
`TypeError`, and an inline `(function(){ this.bar(foo()); })()` throws too.

The rows still fail, and the reason is worth recording because it defeats the
obvious probe:

- **`11.2.3-3_3`** — the TypeError IS thrown, but `fooCalled` is `true`. §13.3.6.1
  evaluates the callee reference before the arguments; this compiler evaluates
  the arguments first, so `foo()` runs before `o.bar.gar`'s access throws. An
  ordering change in call codegen, not a missing check.
- **`11.2.3-3_4` and `_8`** — these report `Expected a TypeError but got a
  Test262Error`, i.e. the call did NOT throw. Reproduced only when the callback
  is handed to the ORIGINAL test262 `assert.throws` (`.tmp/probe/c8c.js`): the
  identical body invoked through a local `runner(fn)`, through a parameter,
  through an inline function-expression argument, or as an IIFE all throw
  correctly. So the defect is in how the compiled harness's `assert.throws`
  invokes its callback, not in the member-call check — and any probe that does
  not go through the real harness will report the bug as absent.

## Wave-6 lane T10 — the QuickJS provider build was DOWN: `constructor` leaked from `Object.prototype`'s companion (2026-08-22)

**Symptom (operational blocker, not a conformance row).** On integration head
`4f4bb249dd`, `npx tsx scripts/build-quickjs-eval-provider.mjs` exited **1**:

```
[quickjs-eval-provider] FAILED: Error: quickjs canary functionParityProbe()
  returned 1, expected 11
```

`functionParityProbe` = `constructorIdentity * 10 + appliedGlobal`, so **1**
means `appliedGlobal` was fine and `constructorIdentity` was **0** — a
QuickJS-created `new Function(…)` value lost `%Function%` identity. Because the
provider is the only way to build the adapter, every
`JS2WASM_EVAL_ENGINE=quickjs` row for every lane was gated behind this.

> Run the script **BARE**. Piped (`… | tail`) it reports `tail`'s status and a
> thrown canary reads as success.

### Diagnosis — measured, not inferred

Diagnostic canaries compiled through the same linked pair
(`.tmp/t10/harness.mjs`, adapter compile ≈3 s so iteration is cheap):

| probe on `made = new Function("this.x = 1;")` | base `73c0a290c0` | head `4f4bb249dd` | spec |
| --- | --- | --- | --- |
| `made.constructor === Function` | 1 | **0** | 1 |
| `made.constructor.name` | `"Function"` | **`"Object"`** | `"Function"` |
| `made.constructor === Object` | 0 | **1** | 0 |

So the answer did not go missing — it became **`Object`**.

### Bisect

`src/`-only file-copy A/B over the integration range (`.tmp/t10/atcommit.sh`,
one `git checkout <sha> -- src/` per candidate, always restored):

| src at | `functionParityProbe()` |
| --- | --- |
| `7dd91b7bad` (wave base) | 11 |
| `73c0a290c0` (all upstream merges, pre-T9) | 11 |
| **`de32ec84f5` (T9 — builtin-proto constructor seed)** | **1** |
| `e707acd56a`, `6b513c7155`, `4f4bb249dd` | 1 |

Narrowed **inside** `de32ec84f5` by per-file revert, then by an env-gated
early-return in the seeder itself:

| variant | reading |
| --- | --- |
| T9 with `src/codegen/native-proto.ts` reverted | 11 |
| T9 with `pushCompanionConstructorSeed` disabled entirely | 11 |
| T9 with the seed disabled **for the `Object` brand only** | 11 |
| T9, seed on for `Object` | 1 |

Also isolated **which module** matters: rebuilding only the ADAPTER with the
seed and the canary without it gives 11 — so the defect is in the **caller /
user module's** codegen, not the provider's.

### Root cause

T9 seeds `constructor` into the #2175 companion of every builtin prototype that
has an identity-stable carrier. `Function` and `Date` **decline** (no carrier —
that decline is deliberate and documented in
`builtin-proto-constructor-seed.ts`), so their companions stay absent.

`__protoidx_get_k` (#4176) models the prototype chain as exactly **two** levels:
the receiver's brand companion, then `Object.prototype`'s. A closure receiver
classifies as the `Function` brand, whose companion has no `constructor`, so the
walk fell through and answered **`Object.prototype.constructor` = `Object`** —
which T9 had just made reachable for the first time.

That answer then propagated: `__closure_prop_get`'s miss consult is
`__protoidx_get_r`, and the runtime-eval AOT callable carrier's property-get
trampoline treats any **non-undefined** result from `__closure_prop_get` as
final — so the `Object` it now returned **shadowed the carrier's own marker
`constructor` field**, which is exactly where the provider realm's `%Function%`
lives (`$RuntimeEvalInterpretedCallback` field 6).

### Fix

`src/codegen/proto-index-store.ts` — `constructor` never takes the
`Object.prototype` FALLTHROUGH. New `keyIsNotConstructorInstrs` (fill-time,
`nativeStringLiteralInstrs` + `__str_flatten`/`__str_equals`, and byte-identical
`undefined` when those helpers are absent) is `i32.and`-ed into the existing
second-probe guard in `fillGetKBody`.

Justification is the spec, not the canary: **every** builtin prototype owns
`constructor` (§19.2.3.1 / §20.2.3.1 / §22.1.3.1 / …), so for a receiver whose
implicit prototype is any brand other than `Object` the nearer level always
shadows `Object.prototype` — the two-level model simply has no way to say "the
nearer level owns this key but has no companion". A **miss** is the correct
answer there, and it hands the read back to each caller's own fallback (the
carrier's marker metadata; #4442's `%Function%` arm for a statically
function-typed receiver). `get_k` is reached only from `get_r` and `get_f`
(numeric keys), so this one edit covers both entry points.

Deliberately NOT changed: `__protoidx_has_k`. `"constructor" in f` is `true`
per spec, and T9's seed made it answer `true` for the first time. Suppressing
the fallthrough on the `has` side would regress it to `false`.

### Measurements (all on this worktree, file-copy A/B, `--target standalone`)

| set | base | with fix |
| --- | --- | --- |
| `functionParityProbe()` | 1 | **11** |
| `npx tsx scripts/build-quickjs-eval-provider.mjs` (bare) | exit 1 | **exit 0**, canary-verified, 271,378 bytes |
| T9's own flip rows + 13 `<B>.prototype.constructor` neighbours (15 rows) | 11 pass / 4 fail | **identical, 0 changed** |
| eval-dependent controls — all `language/eval-code/indirect/*`, all `built-ins/eval/*`, 20 `language/eval-code/direct/*` (91 rows) | 82 pass / 9 fail | **identical, 0 changed** |
| prototype-chain neighbours — `Object/prototype/hasOwnProperty`, `Object/getPrototypeOf`, `Object/prototype/isPrototypeOf`, `expressions/property-accessors`, `Function/prototype/bind` (70 rows) | 69 pass / 1 fail | **identical, 0 changed** |
| `tests/issue-4176`, `issue-4160-proto-index-store`, `issue-4200`, `issue-4442` (67 tests) | 62 pass / 5 fail | **identical, 0 changed** |

Net: **0 test262 rows flipped either way** — this is a build-unblock, not a
conformance slice. New pin: `tests/issue-4491-proto-index-constructor-shadow.test.ts`
(5 tests; the headline one measured **failing on base**, passing after).

Gates green before commit: `check-loc-budget` · `check-func-budget` ·
`check-coercion-sites` · `check:oracle-ratchet`.

### Pre-existing failures found, NOT caused by this fix (both sides identical)

- `tests/issue-4200.test.ts` — four `gOPD(<B>.prototype, "constructor") still
  declines (no carrier)` guards now fail for `String` / `Number` / `Boolean` /
  `Function`. T9's seed made three of those brands answer a descriptor; the
  guards were written before it and were not updated. Someone owning #4200
  should decide whether the guards or the seed are wrong.
- `tests/issue-4176.test.ts` — `prepared IR for-in shares prototype-companion
  enumeration`.
- `built-ins/Error/prototype/constructor/S15.11.4.1_A1_T2.js`,
  `Object/prototype/constructor/S15.2.4.1_A1_T2.js`,
  `String/prototype/constructor/S15.5.4.1_A1_T2.js` — all
  `TypeError: is not a constructor`; the seeded carrier is not [[Construct]]able.
- `Date/prototype/constructor/prop-desc.js` — `Date` declines the seed, so the
  descriptor is still absent.
- `<array>.constructor === Array` is still **false** (the #4220 vec arm and the
  companion entry are different objects). The T10 pin asserts only the property
  this guard owns — that it is never `Object`.

### Gotchas confirmed again

- **`test262/` in an agent worktree is re-materialized between (and DURING)
  tool calls**, and the target it is pointed at is another lane's worktree that
  may already be gone. Six rows of one control sweep died mid-run as
  `ENOENT … test262/harness/assert.js`. Relink **inside the same shell command
  as the run**: `rm -rf test262 && ln -s /home/user/js2/test262 test262 && node …`.
- **The adapter cache key is `sha256(adapterSource ∥ compilerBundleHash)`, and
  under `tsx` the bundle hash is the literal `no-bundle`** — so in a dev
  worktree the key does NOT move when `src/` changes, and a stale adapter is
  silently reused. That is convenient for an A/B (both arms link the same
  adapter, isolating the caller-module codegen), but it means a local
  "the provider still builds" check proves nothing unless you delete the keyed
  `.wasm` first.

## Wave-6 lane T12 — assignment OVER a `function` declaration binding (2026-08-22)

Integration head `bd868fe433` (`claude/es5-standalone-wave6`), `--target
standalone`. The FunctionDeclaration analogue of slice T4-D, and the follow-up
the T4 re-triage explicitly left: _"the widening analyses that exist today
(#4204/#4206 and T4-D) all key on `ts.VariableDeclaration`, so none of them can
see this declaration kind at all."_

Every row below was re-measured on this head before any edit; the five
`if-*-func-block-scoping` rows in the stale list ALREADY PASSED and are not
counted as flips.

### It is two defects, and they fail in opposite directions

`function g() {}; g = 123;` is one binding assigned a number. Measured:

| shape                                                       | before                                    | after                                                                        |
| ----------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| module scope `function g(){}; g = 123` — `g === 123`        | **false**                                 | true                                                                         |
| … `typeof g`                                                | **`"function"`**                          | `"number"`                                                                   |
| … `String(g)`                                               | **`"function () { [native code] }"`**     | `"123"`                                                                      |
| module scope, dynamic read (`after = g; look(after)`)       | **`"function"`**                          | `"number"`                                                                   |
| §B.3.3 block scope `{ function f(){ f = 123; … } }`         | **`RuntimeError: illegal cast in f()`**   | correct (`initialBV()` `'decl'`, `currentBV` `123`, `varBinding()` `'decl'`) |
| `function h(){}` never reassigned — `typeof h`              | `"function"`                              | `"function"` (unchanged)                                                     |

The silent arm is the dangerous one: no trap, no diagnostic, wrong answer.

### Slice T12-A — the trap: constructibility was decided PER READ SITE

`getOrCreateConstructibleFuncRefWrapperTypes` mints a nominally distinct struct
subtype (`__constructible_fn_wrap_N_struct`, one extra `$__constructible i32`)
so IsConstructor can discriminate. The lazy closure singleton
(`ensureFuncClosureSingleton`) caches by function NAME, but chose between that
subtype and the plain wrapper from a boolean the CALLER passed. Reduced WAT for
`block-decl-func-block-scoping`:

```wat
;; __module_init, at `varBinding = f`
ref.func 391  i32.const 0  ref.null extern  global.get 355
struct.new 243                 ;; __fn_wrap_10_struct__fnmeta  (PLAIN)
global.set 354                 ;; $__fn_closure_f
…
;; inside $f, at `initialBV = f`
global.get 354  any.convert_extern
ref.cast (ref 240)             ;; __constructible_fn_wrap_11_struct → ILLEGAL CAST
```

The two sites disagree because TypeScript models the two bindings differently:
inside `f`'s body the name resolves to the `FunctionDeclaration`
(`identifiers.ts` passes `constructible = true`), while at the Annex-B
web-compat VAR binding `identifierValueSymbol` answers `undefined` and the same
site passes `false`. Whichever compiled first decided the allocation; the other
decided the cast.

`emitFuncRefAsClosure` already normalizes exactly this — #4437's own note says
"constructibility belongs to the source function, not to whichever value read
happened to materialize its cached capture struct first". The CACHED singleton
path, which is the one ordinary identifier reads actually take, did not.

**Change.** New module `src/codegen/closures/ordinary-fn-constructibility.ts`
resolves the answer from `funcMapOwnerDecl` / `topLevelFunctionDeclarations`,
i.e. from the compiled FUNCTION; `method-trampolines.ts`
(`emitCachedFuncClosureAccess`) gets one normalization line. It only ever
WIDENS `false → true`, and the constructible struct is a subtype of the plain
wrapper, so every existing cast still succeeds.

**Flips: 3 rows** — `annexB/language/function-code/{block-decl,switch-case,switch-dflt}-func-block-scoping`.

### Slice T12-B — the silence: the top-level write was never collected

`shouldCollectTopLevelAssignment` (`declarations.ts`) keeps a top-level write
only when its root identifier is already in `ctx.moduleGlobals`. The global that
backs a reassigned function binding is minted by
`registerReassignedFunctionGlobals` (#2931, `index.ts`), which runs AFTER
`collectDeclarations` — so the answer is "no" for EVERY such name under EVERY
statement order, and the statement is dropped with no diagnostic. Confirmed by
instrumenting the dispatcher: `g = 123;` never reaches
`compileExpressionStatement`, let alone `compileAssignment`, and no
`f64.const 123` appears anywhere in the emitted module.

This is the #4491-T3 ordering hole with a different filler — and unlike the
`var` case there is no source order under which it works, which is why it reads
as "assignment over a function is ignored" rather than as a hoisting bug. It is
the tenth member of the #3623 silent-drop family
(`{1268, 2671, 2992, 3366, 3468, 3592, 3615, 3956, 4179, 4491-T3}`).

**Change.** New module `src/codegen/top-level-assigned-function-names.ts`
(pre-scan, mirroring `top-level-hoisted-var-names.ts`); `declarations.ts` gets
one allow-list arm. **Bare-identifier targets only** — member writes rooted at a
function (`F.p = …`, `F.prototype = …`) already have their own arms with their
own host/standalone gating, and widening those through this predicate would
change which member writes survive.

### Slice T12-C — the fold: `typeof` still answered from the checker type

With T12-B the VALUE is right and `g === 123` is true, but `typeof g` still
folded to `"function"`. `moduleGlobalIsDynamicButStaticallyPrimitive` (#4204)
exists for exactly this hazard — a widened binding keeps its declaration-derived
checker type — but resolves binding identity with `variableDeclarationOf`, which
answers only for a `ts.VariableDeclaration`.

**Change.** New module
`src/codegen/declarations/reassigned-function-binding-widening.ts`;
`heterogeneous-scalar-var-widening.ts` gets one consult line. It keys on
`ctx.liveFuncBindingGlobals` — already exactly "a function-declaration name
reassigned somewhere in the realm", and the reason the `externref` global exists
at all — and additionally requires the identifier to RESOLVE to that
module-scope declaration, so a same-named function local cannot consult a global
(#3364's failure mode). A function binding OUTSIDE that set keeps a fixed
function value, so its checker type is sound and the fold stays correct; pinned
by a test.

### Measured

- **Target set (10 rows):** 5/10 base → 8/10 after. The diff is exactly the
  three `*-func-block-scoping` rows; the five `if-*` rows already passed and
  `S11.1.5_A2` is unchanged (see below).
- **Whole `annexB/language/{function-code,global-code}` — 312 rows, base vs
  after by FILE-COPY A/B (never `git stash`):** **277 → 280**. The diff is those
  same three rows and nothing else; the other 309 lines are byte-identical,
  error text included.
- **Control set (99 existing rows, each verified to exist in this checkout):**
  72 rows weighted toward `statements/function`, `expressions/function`,
  `expressions/assignment`, `expressions/typeof`, `expressions/new`,
  `instanceof`, `expressions/object`, `statements/variable`, `global-code`,
  `Function.prototype.{call,apply,bind,toString}`, `Reflect.construct`, array
  callbacks, `switch` / `block` / `with` / `try`, plus 27 more after replacing
  25 listed paths that do not exist here. **77/99 base, 77/99 after —
  byte-identical output on both lists.**
- **`tests/equivalence` — the 43-file function / closure / typeof / assignment /
  `new` slice (321 cases), base vs after:** **317 passed | 4 failed on BOTH**,
  the same four. Two are environmental (`new-non-constructor.test.ts` reads a
  hardcoded `/workspace/test262/…` path that does not exist in this worktree);
  two are the pre-existing `optional-direct-closure-call` `NaN` rows. The full
  215-file suite OOMs in this container, as CLAUDE.md records — the subset was
  chosen for what this lane touches, not for what fits.
- **Gates**, green on the final state: `check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `typecheck`, `prettier`,
  `biome lint`. No new frontmatter allowance needed (+6/+8/+5 lines in three
  existing files; every new body is in a new module).
- Regression test `tests/issue-4491-function-binding-widening.test.ts` —
  5 cases, **4 fail on base / 5 pass after**, verified by flipping the file
  copies both ways.

### Left open, measured rather than assumed

- **`block-decl-func-skip-arguments` (the 4th annexB row)** — unchanged, and NOT
  this defect. It fails to VALIDATE: `CompileError: Compiling function
  #515:"__call_fn_0" failed: not enough arguments on the stack for call_ref
  (need 2, got 1)`. Its body is `{ function arguments() {} }` inside three IIFEs
  with different parameter shapes (simple / one named / rest) — the
  `arguments`-shadowing case — so the failure is a closure-ARITY defect in the
  generated dispatcher, not a binding-representation one. Byte-identical before
  and after.
- **`S11.1.5_A2`** — still fails at CHECK#2 (`var x = new Boolean(true); var
  object = {prop : x}; object.prop === x`), exactly where T4-D left it. This
  lane's machinery does not reach it: the clash is between _object-literal FIELD_
  representations, and neither the function-binding widening nor the
  constructibility normalization touches struct fields. T4-D's pricing stands —
  it needs the field slot to widen when its initializer reads a
  representation-widened binding, which is a shape analysis, not a seeding
  change.
- **`typeof` on a plain `var` that only a function writes still folds.** Probe:
  `var currentBV;` … `currentBV = f` (inside `f`) … `typeof currentBV` answers
  `"undefined"` while `currentBV === 123` is TRUE. The binding has no
  initializer, so #4204 assigns it no tag and this lane's predicate does not
  apply either. Harmless for the three flipped rows (they assert values, not
  tags), but it is a live wrong answer of the same family.
- **`String(after)` where `var after; after = g`** renders the function source
  even though `after === 123`. The widening does not PROPAGATE: `after` is a
  separate `var` whose checker type came from the function, and #4204 gives an
  initializer-less binding no tag to widen from.
- **18 `annexB/language/global-code/*-init` rows are unmeasurable on this head** —
  they report `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not
  built`, the T10-owned canary breakage. They are identical before and after, so
  they cannot hide a regression from this lane, but their verdict here is not
  evidence about conformance.
- **5 `if-*-func-existing-var-update` rows** fail with `RuntimeError:
  dereferencing a null pointer in __module_init` at `typeof after`. Pre-existing
  and byte-identical across the A/B — a different Annex-B arm (B.3.3.1 step 3.f
  on an already-existing var binding), not attempted here.

## Wave-6 lane T11 — the f64-hole PRESENCE half (2026-08-22)

Base `66c6a69afb` (the wave-6 integration head — T8-A's value half already
landed), `--target standalone`, in-process `runTest262File`. Every number below
is a run this lane executed. Both sides of every A/B come from the file-copy
harness (`.tmp/ab/{base,new}/`, `.tmp/ab-use.sh`); the base copies were captured
before the first edit, and `git stash` was never used.

### What the value half left behind, measured on base

`var x = []; x[0] = 0; x[3] = 3` (function scope) and the literal `[0, , 2]`:

| query | grow-gap, base | elision, base | correct |
| --- | --- | --- | --- |
| `x[1] === undefined` | true ✓ | true ✓ | true |
| `x.toString()` | `"0,,,3"` ✓ | `"0,,2"` ✓ | — |
| `1 in x` | **true** | **true** | false |
| `x.hasOwnProperty("1")` | false ✓ | false ✓ | false |
| `Object.keys(x)` | **`0,1,2,3`** | **`0,1,2`** | `0,3` / `0,2` |
| `forEach` visits | **4** | **3** | 2 / 2 |
| `[0, , 2].filter(() => true).length` | — | **3** | 2 |

After this slice every cell in those two columns is the `correct` one.

### 1. A second sNaN payload

`HOLE_F64_BITS = 0x7FF00000DEADC01E` next to `UNDEF_F64_BITS =
0x7FF00000DEADC0DE` (`value-tags.ts`). Same signaling-NaN exponent, so T8-A's
non-collision argument carries over verbatim: JS arithmetic only ever produces
the quiet NaN `0x7FF8000000000000`.

Produced at exactly two sites — an array-literal **elision**
(`compileArrayLiteral`, both the `array.new_fixed` and the spread path) and the
T8-A **grow-gap fill**. An explicit `undefined` element keeps
`UNDEF_F64_BITS`; that fork IS the slice.

### 2. Read-boundary canonicalization

`HOLE → UNDEF` (new module `vec-f64-hole-presence.ts`) at the
`emitHoleToUndefined` sites extended to f64 — `property-access.ts` ×3,
`array-methods.ts` ×3 plus its six HOF element loads, `statements/loops.ts`,
`expressions/assignment.ts` ×2 — plus the two dynamic chokepoints `__vec_get`
(host boundary, which now tests BOTH payloads) and `__extern_get_idx`.

This preserves `array-holes.ts`'s stated invariant — *a hole is never observed
AS the marker* — which is what lets the ~28 existing `UNDEF_F64_BITS` observers
stay untouched: they keep testing one bit pattern and never see the other.

`__extern_get_idx` reads a hole through `idxMiss()`, the prototype consult an
out-of-bounds index already used, not a flat `undefined` — §10.1.8.1
OrdinaryGet, and it is what makes `filter/15.4.4.20-9-b-7` (a getter installed
on `Array.prototype[1]` mid-iteration) answer `6.99` at the hole.

### 3. One presence chokepoint, four consumers

A per-carrier `ref.test`-guarded arm on `__extern_has_idx` per f64 vec carrier
(shape copied from `fillExternGetIdxVecArms` / `fillHoleyArrayHasIdxArm`), and
`in` (`binary-ops-in.ts`), `Object.keys` (`fillDynamicForinVecArms`) and
`for…in` (`emitArrayForIn`) re-routed to it. `hasOwnProperty` already consulted
it.

Two properties keep the arm safe:

- **It returns only when it positively identifies a hole.** Everything else
  falls through to the body already there, so the arm can only turn a `true`
  into a `false`, never the reverse.
- **A hole is not the END of HasProperty.** §7.3.11 walks the prototype chain,
  so the arm answers `protoIndexHasIdxInstrs` — the same consult the #3251
  overlay's DELETED-index arm uses. A hole and a deleted index are the same
  question.

### 4. Hole-SKIPPING on the HOFs — the T8-A hazard, defused

`forceHasProperty` is implied for the native `__hof_*` helpers whenever the
module can hold a marker, and the STATIC inline loops join in: `shouldHoleSkip`
accepts f64, and `reduce`/`reduceRight` — which #2001 S2 left folding every
index — gain the gate.

T8-A recorded that the value marker made arithmetic HOFs *loudly* wrong. Same
program (`var a=[1,2,3]; a[6]=5;`, module hole-active), measured this lane:

| expression | correct JS | T8-A (base) | after T11 |
| --- | --- | --- | --- |
| `a.reduce((s,x)=>s+x, 0)` | 11 | NaN | **11** ✓ |
| `a.reduce((s,x)=>s*x, 1)` | 30 | NaN | **30** ✓ |
| `a.forEach` visits | 4 | 7 | **4** ✓ |
| `a.join(",")` | `"1,2,3,,,,5"` | ✓ | ✓ |
| `a[4] === undefined` | true | ✓ | ✓ |
| `Object.keys(a)` | `0,1,2,6` | `0,1,2,3,4,5,6` | **`0,1,2,6`** ✓ |
| `4 in a` | false | true | **false** ✓ |

NOT included: the no-initialValue **seed seek** (§23.1.3.24 step 6.b walks
forward to the first PRESENT index). The seed still reads index 0 and maps a
hole to `undefined`. That differs only when index 0 itself is a hole and no
initial value is passed; it was already wrong before this slice.

### The two things the control A/B caught that no probe would have

Both were real regressions, both fixed on-branch, both worth recording because
the next lane will meet the same shape.

**(a) The marker means "nothing was WRITTEN here", not "no own property here".**
`Object.defineProperty(arr, "1", {set: function(){}})` records an own ACCESSOR
in the #3251 companion and writes nothing to the slot, so the marker is still
sitting there while the index IS present. Nine rows — the whole "own or
inherited accessor without a get function" family
(`reduce`/`reduceRight` `15.4.4.2{1,2}-9-c-i-{18,20,22}`,
`forEach/15.4.4.18-7-c-i-22`, `filter/15.4.4.20-9-b-5`) — went pass → fail. Two
fixes, one per path:

- the `__extern_has_idx` arm asks `__vec_overlay_lookup` + `__obj_find` first
  and DECLINES whenever a companion entry exists for the index;
- `shouldHoleSkip` gains a SECOND disqualifier for f64, `overlayRouteActive`.
  `protoIndexDirty` (inherited from the externref case) only covers an
  INHERITED index; an OWN accessor is invisible to a static own-slot test, and
  `overlayRouteActive` is exactly the condition under which those reads take
  the dynamic route that can see it.

**(b) Making ONE presence path correct can break a row that passed because two
wrong ones agreed.** `Object/keys/15.2.3.14-6-2` builds its expected list from
`for…in` + `hasOwnProperty` and asserts it equals `Object.keys`. On base both
sides answered `0..5` for `[1, 2, , 4, , 6]`. Fixing `Object.keys` alone broke
the agreement — precisely the failure the T8 handover warned about. `for…in`
joined the same chokepoint; all three now answer `0,1,3,5`.

### Controls — file-copy A/B, both sides run on this head

| control set | rows | base pass | after pass | changed |
| --- | ---: | ---: | ---: | ---: |
| dense-numeric — deterministic stride sample over `map`, `reduce`, `reduceRight`, `sort`, `join`, `push`, `pop`, `indexOf`, `lastIndexOf`, `slice`, `forEach`, `toString`, `concat`, `filter`, `Array/length` (pool 1,872 files) | 180 | 115 | **116** | 1 — `filter/15.4.4.20-9-b-11` fail → pass |
| elision-bearing — every file under `built-ins/Array`, `language/expressions/array`, `Object/{defineProperties,keys}` whose body contains a literal elision | 162 | 60 | **62** | 2 — `filter/15.4.4.20-9-b-7`, `-11` fail → pass |
| sparse-index-store — stride sample of the files that write a literal numeric index, excluding rows already in the other two sets | 150 | 69 | 69 | **0** |

**Zero regressions; every change is a gain.** The two rows are the same
`filter` pair counted once per set they belong to, so the union is +2.

Perf sanity — `compileSource(…, { target: "standalone" })` on the numeric
playground samples, module byte size AND sha-256 prefix:

| sample | base | after |
| --- | --- | --- |
| `website/playground/examples/benchmarks/array.ts` | 54,651 · `3a6f5611…` | 54,651 · `3a6f5611…` |
| `…/loop.ts` | 34,533 · `fe39bef0…` | 34,533 · `fe39bef0…` |
| `…/fib.ts` | 34,192 · `2d204833…` | 34,192 · `2d204833…` |

Byte-identical AND sha-identical. That took a third gate to achieve, and the
lesson generalises: **`usesArrayHoles` says the program contains SOME elision,
not that an f64 marker was ever minted.** `array.ts` set the flag without ever
reaching an f64 elision, and `__vec_get` grew 19 bytes for a compare that could
not fire. The FINALIZE-time consumers (`__vec_get`'s host-boundary map,
`fillF64HoleHasIdxArms`) therefore read a narrower flag, `f64HoleMarkerEmitted`,
set at the two sites that actually mint the payload. Body-compile-time consumers
cannot use it — function compilation order is not source order, so a read of
`a[i]` can be compiled before the literal that introduces the marker.

Gates: `check-loc-budget` OK · `check-func-budget` OK (eight allowances, all
dispatch-only, rationale in the frontmatter) · `check-coercion-sites` OK (one
allowance: the companion consult keys on `number_toString`, the sealed
index-key formatter) · `check:oracle-ratchet` OK (this slice makes no checker
query).

**Three rows are EXCLUDED from all three sets, and the exclusion is not
cosmetic:** `lastIndexOf/length-near-integer-limit.js`,
`reverse/length-exceeding-integer-limit-with-proxy.js`,
`splice/create-species-length-exceeding-integer-limit.js`. These are the
runner's known #1589A family — a `length` near 2**53 makes the search loop spin,
and a synchronous Wasm loop blocks Node's event loop so `TEST_TIMEOUT_MS` can
never fire. The first one silently ate a 58-minute blind sweep before it was
identified. They are unrelated to holes; if you build a control set over
`built-ins/Array`, exclude them or add them to `HANGING_TESTS`.

### Target rows — verified on the merged head, then re-measured

| row | base | after | note |
| --- | --- | --- | --- |
| `filter/15.4.4.20-9-b-7` | fail | **pass** | hole falls through to a `Array.prototype[1]` getter installed mid-iteration |
| `filter/15.4.4.20-9-b-11` | fail | **pass** | hole + `delete Array.prototype[1]` |
| `filter/15.4.4.20-9-b-14` | fail | fail | NOT a hole row — `[0,1,2,"last"]` is an externref carrier and the blocker is the `length` SHRINK (T5 family) |
| `filter/15.4.4.20-9-b-15` | fail | fail | length-shrink again, and its residual is a CARRIER question: `arr` is `number[]`, so the proto getter's string `"prototype"` coerces to NaN in the f64 result vec |
| `defineProperties/15.2.3.7-6-a-161` | **pass** | pass | already passing on the merged head — not a flip |
| `concat/S15.4.4.4_A1_T2` | fail | fail | concat result element type drops a ref element — not a hole bug (T8 said the same) |
| `concat/S15.4.4.4_A1_T4` | fail | fail | the SOURCE array is now fully correct (`x[0] === undefined`, `0 in x` false, `x.join()` `",1"`); the concat OUTPUT loses the marker — measured `arr.join()` `"NaN,1,NaN"`. The 2-arg concat path round-trips elements through a box, which canonicalizes the NaN payload. This is the T8 handover's next-step #2 ("extend the marker to the other gap producers — the concat result build"), deliberately a separate slice with its own control run |
| `concat/S15.4.4.4_A3_T2` / `A3_T3` | fail | fail | need the `length` SETTER to fill shrunk/grown slots with the marker (T5 family), plus `hasOwnProperty` on the concat output. Not attempted |
| `toString/S15.4.4.2_A1_T2` | fail | fail | still blocked on #2809 exactly where T8-A left it: `Array(undefined,1,null,3)` renders `",1,0,3"` — `null` in an f64 carrier, a representation question, not a hole |
| `Array/S15.4_A1.1_T10` | fail | fail | the sparse-STORAGE wall at index 4294967294, priced by lane J. Untouched |
| `pop/S15.4.4.6_A1.2_T1` | pass | **pass** | canary, stays green |
| `shift/S15.4.4.9_A1.2_T1` | pass | **pass** | canary, stays green |

### Known edges, stated so the next lane does not rediscover them

- **The demand gate is `ctx.usesArrayHoles`** — the same pre-scan flag
  `array-holes.ts` uses, set iff the module contains an array-literal elision.
  Clear ⇒ no marker is produced anywhere ⇒ every consumer is a no-op and the
  bytes are unchanged, dense-numeric kernel and the #1897 `struct.get` contract
  included. **Consequence:** in a module with NO elision, an f64 grow-gap keeps
  T8-A's `UNDEF_F64_BITS` and presence stays as it was (`1 in x` true).
  Widening the gate to grow-gaps alone needs a pre-scan predicate that fires on
  `a[i] = v` — which is every numeric benchmark — so the price would be paid in
  the dense kernel. Deliberately not taken.
- **`Float32Array` / `Float64Array` share the `f64` vec carrier** (the packed
  storage table covers only the integer views). An element whose bits happen to
  equal the marker — reachable only by writing raw bytes through an
  ArrayBuffer — would answer absent. Same exposure `UNDEF_F64_BITS` already has
  at `__vec_get`; not widened, not fixed.
- **`hasOwnProperty` with a STRING-LITERAL key is wrong on an elision-bearing
  array, on base and after.** Measured on `[1, 2, , 4, , 6]`:
  `a.hasOwnProperty("3")` is `false` although index 3 holds `4`. The dynamic-key
  form answers correctly. Two different code paths; the literal one is a
  pre-existing defect this slice neither caused nor fixed.

### Handover (T11, lane w6-t11, 2026-08-22)

Branch `worktree-agent-ad111d1c7ba23417e`, worktree
`/home/user/js2/.claude/worktrees/agent-ad111d1c7ba23417e`. Not pushed, no PR.

**INTEGRATION-READY** — four commits on top of `66c6a69afb`, all four gates
green, three control sets and the perf sanity measured on this head with zero
regressions.

| commit | what |
| --- | --- |
| `86baa6928f` | the four deliverables: `HOLE_F64_BITS`, read-boundary canonicalization, the `__extern_has_idx` arm + `in`/`Object.keys` re-route, HOF hole-skip |
| `6b5e6246c4` | own-descriptor decline (the nine-row regression the control A/B caught) |
| `18babd4dc2` | `for…in` joins the same chokepoint |
| `4ea51e130b` | `f64HoleMarkerEmitted` — the narrower FINALIZE-time gate that restores byte-identical benchmarks |

Files: `src/codegen/vec-f64-hole-presence.ts` (new — every new body),
`value-tags.ts` (+1 constant), and dispatch-only wiring in `literals.ts`,
`property-access.ts`, `array-methods.ts`, `object-runtime.ts`,
`vec-access-exports.ts`, `binary-ops-in.ts`, `hof-native.ts`, `index.ts`,
`expressions/assignment.ts`, `statements/loops.ts`, `vec-f64-hole-gap.ts`,
`context/types.ts`.

**Next steps, in value order**

1. **Extend the marker to the remaining gap producers** — the `concat` result
   build and the `length` SETTER (shrink-then-grow). Measured above: the concat
   SOURCE is now fully correct and the OUTPUT is not, because the 2-arg concat
   path round-trips elements through a box that canonicalizes the NaN payload.
   That unblocks `concat/S15.4.4.4_A1_T4`, and with the length setter,
   `A3_T2`/`A3_T3` and `filter/15.4.4.20-9-b-{14,15}`.
2. **`hasOwnProperty` with a STRING-LITERAL key** answers `false` for a PRESENT
   index on an elision-bearing array (`[1,2,,4,,6].hasOwnProperty("3")` is
   `false`, base and after). The dynamic-key form is correct. Two different
   paths; the literal one is a pre-existing defect and the only presence answer
   still out of line.
3. **`null` in an f64 carrier (#2809)** still blocks
   `toString/S15.4.4.2_A1_T2` at check `#3.2` — unchanged from T8-A.

**Do NOT re-attempt / read first**

- Widening a hole-bearing literal to an externref vec — T8's measured −12.
- Answering absence from the raw slot ALONE. An own accessor recorded in the
  #3251 companion writes nothing to the slot; the arm must consult the
  companion. Nine rows.
- Fixing ONE presence path in isolation. `Object/keys/15.2.3.14-6-2` passed on
  base because `for…in` and `Object.keys` were wrong in the same direction.
- Three rows hang the in-process runner forever (a `length` near 2**53 spins a
  search loop, and a synchronous Wasm loop blocks Node's event loop so
  `TEST_TIMEOUT_MS` cannot fire): `lastIndexOf/length-near-integer-limit.js`,
  `reverse/length-exceeding-integer-limit-with-proxy.js`,
  `splice/create-species-length-exceeding-integer-limit.js`. Exclude them from
  any `built-ins/Array` sweep.

**Harness in this worktree** (`.tmp/`): `p.sh` wraps `run.mts` (one row) and
`runlist.mts` (a list; writes `<out>.partial` incrementally and RE-LINKS
`test262/` + `node_modules/` before every row). `ab-setup.sh` snapshots both
sides, `ab-use.sh base|new` flips them, `run-side.sh`/`run-new2.sh` run a side,
`cmp.mjs` diffs two result TSVs bucketed by control set, `bench-ab.sh` is the
module-size/sha A/B, `wat-ab.sh` diffs the WAT when sizes move.

**One process trap worth writing down:** `ab-use.sh base` overwrites the working
tree, so ANY uncommitted edit is lost when you flip sides. It cost this lane
three fixes and one full control run. Re-run `ab-setup.sh` immediately after
every edit, and prefer committing before flipping.

## 2026-08-23 wave-4 census (lead sweep on campaign HEAD, post-#4785)

24 MOP rows remain in the ES≤5 standalone failing set (162 total), all
re-verified failing by the lead's fresh sweep (`.tmp/sweep-wave4.jsonl`):

```
Object/defineProperty/15.2.3.6-3-138.js      Object/defineProperty/15.2.3.6-4-183.js
Object/defineProperty/15.2.3.6-4-195.js      Object/defineProperty/15.2.3.6-4-21.js
Object/defineProperty/15.2.3.6-4-243-1.js    Object/defineProperty/15.2.3.6-4-243-2.js
Object/defineProperty/15.2.3.6-4-589.js      Object/defineProperty/15.2.3.6-4-622.js
Object/defineProperty/S15.2.3.6_A1.js
Object/defineProperties/15.2.3.7-2-16.js     Object/defineProperties/15.2.3.7-6-a-179.js
Object/defineProperties/15.2.3.7-6-a-183.js  Object/defineProperties/15.2.3.7-6-a-204.js
Object/defineProperties/15.2.3.7-6-a-231.js
Object/freeze/15.2.3.9-2-a-11.js             Object/freeze/15.2.3.9-2-a-12.js
Object/freeze/15.2.3.9-2-a-14.js
Object/preventExtensions/15.2.3.10-2.js      Object/preventExtensions/15.2.3.10-3-5.js
Object/getOwnPropertyDescriptor/15.2.3.3-4-4.js
Object/getOwnPropertyDescriptor/15.2.3.3-4-34.js
Object/keys/15.2.3.14-5-13.js                Object/keys/15.2.3.14-5-a-4.js
Object/getOwnPropertyNames/15.2.3.4-4-1.js
```

Wave-4 dispatch note: sample errors include arguments-object descriptor
visibility (`freeze/15.2.3.9-2-a-1x` — frozen ARGUMENTS index
descriptors still writable/configurable), `arrObj.length` descriptor
(`SameValue(«0», «4294967295»)`, length-descriptor configurable),
`getOwnPropertyNames` on built-ins, and defineProperty on array index
past length. Triage-first per this file's standing plan; re-verify each
row live before edits (methodology item 1). Possible cross-lane overlap:
`Array/prototype/filter/15.4.4.20-9-b-*` rows are in #4641's extended
family but may root here (descriptor mirror on callback iteration) —
whichever lane measures the root first takes them, hand over with
evidence.

### Wave-4 census RESULT (dev-4491, branch `issue-4491-wave4`, base `52cb0a6a6`)

All 24 rows re-verified failing on the campaign base before any edit
(`.tmp/base-wave4.tsv`, standalone lane, single-test driver). **8 of the 24
flip to pass**, from four independent roots. Every number below is from a run
executed in this worktree; the base side was re-measured from file-copy
reverts (`.tmp/base/*.ts`), not inherited.

#### Root 1 — a monomorphic vec PARAMETER destroys array identity (5 rows)

`Object.defineProperty(arr, "1", {get, set})` records the accessor in the
#3251 overlay companion, which is a module-global side table **keyed by vec
IDENTITY** (`ref.eq`). `inferParamTypeFromCallSites` narrows a callee's
implicit-any parameter to the argument's `resolveWasmType`, and in a
descriptor-dirty module the checker's element type is **not** a proof of the
runtime carrier: `var arr = []; Object.defineProperty(arr, …)` is `number[]`
to the checker after the first numeric element write, but codegen materialises
it as `$__vec_externref` so the overlay can hold accessor entries. The
parameter is therefore narrowed to `$__vec_f64`, and the ARGUMENT boundary
becomes a carrier conversion — `emitSafeStructConversion` →
`emitVecToVecBody`, an element-wise copy into a **fresh `struct.new`**. The
callee receives an array the overlay has never heard of.

Measured, standalone, on the base (`.tmp/pA*.js` probes):

| read of `arr[1]` where index 1 is an accessor returning 3 | answer |
| --- | --- |
| module level, literal key | `3` (getter invoked) |
| `function f(o,k,v){return o[k];}` called once with `arr` | **`0`** (raw backing slot, getter never invoked) |
| the SAME call site made polymorphic (a second, non-array call) | `3` |

The emitted signature is the proof: with the module-level call the callee is
`(func $readThrough (param (ref null 4) …))` where `arr`'s global is
`(mut (ref null 2))` — `$__vec_f64` vs `$__vec_externref`.

That is exactly `propertyHelper.js`: `verifyEqualTo` / `verifyWritable` /
`verifyProperty` all take the array under test as their only `obj` argument,
so the whole verification family ran on a COPY. It is also why the defect
resisted isolation — a two-parameter clone of `verifyEqualTo` in the test body
answered correctly whenever the same helper was ALSO called before the
element write, because the narrowing depends on the call sites, not the call.

**Fix** (`src/codegen/declarations/param-return-inference.ts`, +~35): a fifth
withdrawal rule in the existing ladder — when `overlayRouteActive(ctx)` (the
module-wide #4159/#4222/#4160 pre-scan flag), withdraw a narrowing to any
`__vec_*` carrier. Free where it applies: that flag already routes typed-lane
element access through the dynamic lane, so a vec-typed parameter buys nothing
there and costs identity. Byte-identical in every module where the flag is
clear.

Flips: `defineProperty/15.2.3.6-4-195`, `-4-243-1`,
`defineProperties/15.2.3.7-6-a-204`, `-6-a-231`.
(`-4-243-2`, the `onlyStrict` twin of `-4-243-1`, still fails — see Residuals.)

#### Root 2 — `Object.freeze` was invisible to an array/arguments ELEMENT (2 rows)

`__object_freeze` records the level on the carrier's #4032 integrity bag and
clears W/C on the **bag's** entries. A vec's elements have no bag entry, so
the implicit element descriptor `__vec_gopd` synthesises kept answering
`{writable: true, configurable: true}` — and, worse, nothing refused the
operations: measured on base, `Object.freeze([0,1,2])` then propertyHelper's
`isWritable(arr,"0")` answered **true** (the store landed and was reverted)
and `isConfigurable(arr,"0")` answered **true** (the delete succeeded, which
then made `isEnumerable` answer false as a knock-on).

**Fix** (`src/codegen/vec-overlay.ts`, +~110), two halves that compose:

1. `__vec_gopd`'s implicit element descriptor reads the integrity bag
   (`__vec_bag_lookup` — LOOKUP, never `ensure`: a gOPD is a pure query and
   must not allocate a bag for every array merely inspected) and answers
   `writable: !FROZEN`, `configurable: !SEALED`. `enumerable` is untouched by
   either operation.
2. `__extern_set`'s vec arm refuses a write to an own, BACKED index of a
   frozen vec, publishing the shared refusal result so a strict-mode
   assignment throws. Deliberately scoped to an index inside the backed
   length: a key the frozen array does NOT own must still walk the prototype
   chain, so this is not a blanket refusal.

The DELETE half needed no new code — `buildVecDeletePrologue` already consults
`__vec_gopd(obj,key).configurable` and refuses on false, so half (1) closes it
by construction.

Flips: `freeze/15.2.3.9-2-a-11` (arguments), `-2-a-14` (array).

#### Root 3 — `var x = undefined` was the NUMBER 0 (2 rows)

`resolveWasmType(undefined)` is `i32` ("void → no result"), a lowering
convention for a RESULT. Applied to a module-global BINDING it stored
`i32.const 0` and boxed to `ref.i31 0`. Measured on base:

```
var g  = undefined; ({get: g }).get === undefined   // false   ← i31 0
var g2;             ({get: g2}).get === undefined   // true
```

Two census rows are this one defect: `{get: getter}` with
`var getter = undefined` threw `TypeError: Getter/setter must be a function`
(§6.2.5.6 accepts an undefined half; the ambiguous raw value took the
non-callable arm), and `var o2 = undefined; o2 = Object.preventExtensions(o)`
read back `0` instead of the object.

**Fix** (`src/codegen/declarations.ts`): one arm next to the existing
2026-08-21 void-CALL arm in `moduleGlobalWasmType` — an initializer that is
the `undefined` IDENTIFIER resolving to the global binding gets an `externref`
slot. Deliberately NOT the general "declared type is purely undefined/void"
rule (an optional read or a delete-sentinel keeps its numeric slot) and NOT
the `void 0` arm, which is the one the 2026-08-21 note records as having
regressed the filter harness family.

Flips: `defineProperty/15.2.3.6-4-21`, `preventExtensions/15.2.3.10-2`.

#### Root 4 — `Date`'s statics were not own properties (1 row)

The ctor carrier seeded only `length`/`name`/`prototype`, so
`Object.prototype.hasOwnProperty.call(Date,"now")` answered false and
`gOPN(Date)` reported three names. **Fix**
(`src/codegen/builtin-ctor-own-props.ts`): `Date: ["now","parse","UTC"]` in
`CTOR_STATIC_METHODS`. This joins that table on the SAME cost argument its
String-only note makes, not against it — `BUILTIN_STATIC_METHOD_ARITY.Date`
has exactly three entries, the same order of magnitude as String's three, not
`Math`'s ~30.

Flip: `defineProperty/15.2.3.6-4-622`.

#### What the roots were NOT

Two hypotheses were measured and falsified before the ones above, and are
recorded so they are not re-derived:

- *"the dynamic-key element read ignores the overlay"* — it does not:
  `__extern_get_idx` and `__extern_get` both carry the overlay read prologue
  and both answer the getter correctly. The receiver they were handed was a
  different object.
- *"the `{get: undefined}` TypeError is a ToPropertyDescriptor bug"* — the
  literal spelling `{get: undefined}` and `{get: void 0}` both already worked;
  only a value routed through an `undefined`-typed binding failed, which put
  the defect in the binding's slot, not in the descriptor reader.

#### Residuals — 16 of 24, each with a measured root and an owner

Every one reproduces on this branch and is pinned `it.fails` in
`tests/issue-4491-wave4.test.ts`, so a later lane's fix flips a red test to
green instead of landing unnoticed. The last two rows have no census row at
all — they surfaced while writing the pins.

| rows | root | owner / next step |
| --- | --- | --- |
| `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | array INDEX at 2^32-2 must bump `length` to 2^32-1. `MAX_CANONICAL_INDEX` is `2^31-1` because `__obj_index_of_key`'s result doubles as a SIGNED sort key for OrdinaryOwnPropertyKeys, so keys in `[2^31, 2^32-2]` are ordinary string keys and never touch `length`. | **#4497** — already filed by the 2026-08-21 bucket-D triage as exactly this (`part D-I`). Not re-derived here. |
| `defineProperties/15.2.3.7-6-a-183` | a data-only descriptor whose VALUE is kind-incompatible with the array's carrier (a string into `$__vec_f64`) cannot be written back into the element, so it lands in the companion with `FLAG_COMPANION_VALUE` — but `isNonDataDescriptorDefine` calls `{value: "abc"}` data-only, the module is not descriptor-dirty, and the typed read never consults the companion. Measured: `gOPD(arr,"1").value === "abc"` while `arr[1] === 2`. | NOT a pre-scan fix: flagging every `{value: <non-numeric>}` define would route element access in any module containing `Object.defineProperty(x,k,{value:true})` through the dynamic lane. The narrow fix is to widen that BINDING's carrier (`heterogeneousWidenedModuleGlobalType`, #4428). Unowned. |
| `keys/15.2.3.14-5-13` | defining a far index (10000) grows the backing with a NON-hole default, so `Object.keys` enumerates the whole filled range: measured 9999 keys where the spec wants 4. | growth must fill with the `$Hole` sentinel (externref carriers) or skip the write-back. Unowned. |
| `keys/15.2.3.14-5-a-4` | `delete array[0]` on an `Object.keys` RESULT records the tombstone (`hasOwnProperty("0")` → false) but the element read still answers `"prop1"`. The keys result is an `$ObjVec`, not a `__vec_*` carrier, so the #4222 delete/presence prologues do not cover it. | unowned; the `$ObjVec`-vs-vec split is the same seam as #4010. |
| `freeze/15.2.3.9-2-a-12`, `preventExtensions/15.2.3.10-3-5` | a String object's INDEX read misses through a dynamic receiver: measured `readThrough(new String("abc"), "0")` → `undefined`, while the module-level literal-key read answers `"a"`. `preventExtensions` additionally does not stop `new String()` from answering a character for an out-of-range index. | `string-exotic-own-props.ts` (the #4232 §10.4.3 lane). Unowned. |
| `getOwnPropertyDescriptor/15.2.3.3-4-4`, `-4-34`, `getOwnPropertyNames/15.2.3.4-4-1` | the GLOBAL object and `Function.prototype` expose no own function properties: `gOPD(this,"eval")` and `gOPD(Function.prototype,"constructor")` are `undefined`, and `gOPN(this)` reports a name set missing every global function. The comparable tables DO work — `Math.abs` and `Array.prototype.push` both answer the full `{w:true,e:false,c:true}` triple — so this is a carrier-coverage gap, not a MOP gap. | needs a global-object own-property carrier + `constructor` on the `Function.prototype` proto (which has no identity-stable carrier, per the T9/T10 note above). Unowned. **Distinct from #4651**: `gOPN(this)` also TRAPS with `illegal cast` in some module shapes (surfaced by this lane's probe, filed by the lead as #4651). `15.2.3.4-4-1` itself does NOT trap — it fails its own `assert` on a short name list — so the row belongs here, not to #4651. |
| `defineProperty/S15.2.3.6_A1` | §13.5.3 says `typeof` of an unresolvable Reference is `"undefined"`, but a name the TS DOM lib declares gets an ambient `valueDeclaration`, so `typeof-delete.ts`'s undeclared-fold does not fire and the static type fold answers `"object"` — then `document.createElement` null-derefs and the test never reaches its own guard. | closing it needs the standalone PROVIDED-globals set; today `structuredClone` has a hand-written arm for exactly this shape. Unowned. Worth more than one row: `typeof document !== "undefined"` is a very common npm guard. |
| `defineProperty/15.2.3.6-3-138` | **Landed 2026-08-25.** `__desc_has_own` already walks the chain (`"value" in child` → true, `child.value` → undefined); the remaining split was a closed non-empty receiver's static field versus the dynamic descriptor store. Standalone pre-scan now opens receivers of non-inline descriptor defines and records the affected receiver/key for typeof-fold invalidation. Exact row, 136/137/139/140 neighbors, and inline numeric control pass; the 131-row census has no regressions. | `src/codegen/declarations/object-shape-widening.ts`, `src/codegen/typeof-delete.ts`; focused regression/control in `tests/issue-4491-wave4.test.ts`. |
| `defineProperties/15.2.3.7-2-16` | `Object.defineProperties(obj, argumentsObject)`: the descriptor-map getter must run with `this` = the arguments object and `Object.prototype.toString.call(this)` must be `"[object Arguments]"`. | the `Properties`-map own-key source for an arguments receiver. Unowned. |
| `defineProperty/15.2.3.6-4-589` | `teamMeeting.startTime = dateObj` through an INHERITED setter that stores into `var data1 = 1001` reads back `NaN`: the numeric-carrier binding cannot hold a Date. Same defect FAMILY as root 3, different trigger (a numeric initializer rebound to an object, not an `undefined` one). | `mixed-assignment-carrier` / `heterogeneousWidenedModuleGlobalType` (#4428). Unowned. |
| `defineProperty/15.2.3.6-4-243-2` | the `onlyStrict` twin of a fixed row: a STRICT-mode write to an array-index accessor with no setter must throw a TypeError. The sloppy no-op is correct; the strict-throw is the documented boundary in `__extern_set`'s accessor arm. | the shared `__extern_set_decide` refusal channel already exists (root 2 uses it); wiring the accessor arm to it is a small follow-up. Unowned. |
| (no census row — found writing the pins) | `Object.freeze(arr)` flips `Object.prototype.hasOwnProperty.call(arr,"0")` from `true` to **`false`**, while `gOPD(arr,"0")` keeps answering the full descriptor. PRE-EXISTING: reproduces with `vec-overlay.ts` reverted. A descriptor that exists while `hasOwnProperty` says the property does not is the #4010 overlay-vs-bag split, now reachable through the integrity path too. | unowned; pinned `it.fails` in `tests/issue-4491-wave4.test.ts`. |
| (no census row — found writing the pins) | a FUNCTION-LOCAL `var g = undefined` still stores the number 0, and an INLINE `{get: getter}` descriptor argument still throws where the same descriptor in a variable does not. Root 3 fixes the module-global slot on the dynamic define path only. | unowned; see "Not done" below. |

#### T4 parity slice (2026-08-23, branch `issue-4491-t4-parity`, base `340f7c49d`)

Routed in from dev-4515: `language/expressions/addition/S11.6.1_A2.2_T3`
CHECK#1 — `f1 + 1 !== f1.toString() + 1`. Measured standalone on the base:

```
f1 + 1            -> "function () { [native code] }1"   (§20.2.3.5 step 3)
f1.toString() + 1 -> "function f1() { return 0; }1"     (#1463's funcSourceText)
```

The row is the invariant `add-to-primitive.ts`'s own header names, so the module
that exists to hold it was not holding it.

**The reported root was real but NOT sufficient, and the measurement is the only
reason that is known.** dev-4515 identified `add-to-primitive.ts`'s
`fctx.localMap.has(expr.text)` guard: the test262 harness wraps every script in a
synthetic `export function test()`, so every top-level function is a local and
the guard always fires. That is true. Repairing it moved **0 of 128 rows** —
because for this operand shape `addOperandCallableSourceText` is **never
called**. An earlier dispatch in `binary-ops.ts` (line ~1325) hands `f1 + 1` to
`emitObjectAdd` (`addition-to-primitive.ts`, #4564): `admitsObjectAddition`
admits a known-compiled-closure operand, so the later `admitsObjectAdd` arm —
the helper's only caller — is unreachable for it. Two modules with near-identical
names own the same operator, and the live one had no source-text arm.

**Fix, both halves (neither works alone):**

1. `addition-to-primitive.ts` — `emitObjectAdd` consults the shared helper for
   each operand before compiling it, materialising the captured source text.
   Reuse, not a second copy of the guards, so the spellings cannot drift apart
   again.
2. `add-to-primitive.ts` — the guard becomes a resolution question instead of a
   name-in-a-map question (`ctx.oracle.valueDeclarationOf` → is it that
   `FunctionDeclaration`?), plus a `getText()` equality so the map's BARE-NAME
   keying cannot fold a same-named function's source. Without this the helper
   refuses under the harness and half 1 is inert. The replacement is both
   narrower (a local that IS the function now folds) and WIDER (a module-scope
   shadow, which `localMap` never saw, is now refused) than what it replaced.
   The same `valueDeclarationOf` → `isFunctionDeclaration` idiom is what
   `isKnownCompiledClosure` in the sibling module already uses.

**Measured, both arms run in this worktree** (`language/expressions/addition` 48
rows + `built-ins/Function/prototype/toString` 80 rows as the `funcSourceText`
control set, 128 total): base 78 pass, branch 78 pass, **UP 1** (the target row),
**DOWN 0**. One row (`S11.6.1_A2.4_T3`) reported DOWN in the parallel sweep and
passes on BOTH arms when re-run serially — the worktree symlink-farm ENOENT race
again, the same false-regression class recorded in the wave-4 section. Serial
re-verification of every apparent flip is now standing practice for this harness.

Pins: `tests/issue-4491-t4-add-parity.test.ts` — 5 passed on the branch; on the
reverted sources the parity pin FAILS and the four "must not fold" controls
(CHECKS #2-#4's `valueOf`/`toString` overrides, plus a local shadowing a
top-level function) pass on both arms, which is what shows the guards were made
precise rather than removed.

#### Routed IN from #4654 (2026-08-23) — accessor-tier twin of the T9 fix

dev-4654 handed over three rows whose root is in this issue's files, with the
analysis already done and the wrong fix already ruled out. Recorded here so it
is not lost; **not taken in this slice** — it is a different member KIND with
its own risk record, and folding an unmeasured accessor-tier change into a
branch whose zero-regression claim is already established would put that claim
at risk. It should be dispatched as its own wave-5 slice.

- Rows: `RegExp/prototype/{global,multiline,ignoreCase}/S15.10.7.{2,4,3}_A9.js`.
  The receiver is `RegExp.prototype` ITSELF, not an instance. `hasOwnProperty`
  and the `delete` both pass; the SECOND `hasOwnProperty` (must be `false`)
  fails.
- Root: `__nproto_hasown` (`native-proto-own-props.ts`). Those three names are
  in the brand's `$memberCsv`, and the CSV token scan answers `1`
  unconditionally. The seeded-member ladder that consults the mutable
  companion — the one #4491 T9 added `constructor` to — is restricted to
  `kind === "method"`, because `ensureNativeProtoCompanionSeeder` deliberately
  does not seed accessors. So a deleted accessor member is resurrected by the
  CSV. Structurally the SAME defect T9 closed for `constructor`, one member
  kind over.
- Ruled out, with a record: seeding the getters via
  `__defineProperty_accessor` flips `tests/issue-2885.test.ts` ("plain read
  `RegExp.prototype.global` is undefined") to FAIL, and that mechanism is not
  established (see the "ACCESSORS ARE DELIBERATELY NOT SEEDED IN THIS SLICE"
  note in `native-proto.ts`).
- The direction that is still open: these rows do not need accessors SEEDED —
  they need a DELETION to be OBSERVABLE. A tombstone consulted by the CSV
  shortcut answers all three assertions without installing an accessor entry,
  and therefore without touching the #2885 read path. Merely routing accessor
  keys through the companion does NOT work: the companion has no entry for
  them, so the FIRST `hasOwnProperty` would start failing.
- Control set for whoever takes it:
  `%TypedArray%.prototype.{buffer,byteLength,byteOffset,length}/prop-desc.js`.

#### Cross-lane (methodology item 7)

The dispatch note flagged `Array/prototype/filter/15.4.4.20-9-b-{2,14,15,16}`
and `forEach/15.4.4.18-3-23` as possibly rooting in this lane's descriptor
mirror. **They do not.** All five are `fail` on BOTH arms of this lane's A/B —
unchanged by every fix above — so this lane hands them back to #4641 with that
evidence. **This lane makes no claim about dev-4641's arm**: a claim about
another lane's effect needs an arm containing their change, which a two-arm
tip-vs-own A/B is structurally unable to provide.

The four filter HARNESS rows the 2026-08-21 note names as having been
regressed by the earlier `void 0` module-global widening —
`filter/15.4.4.20-9-{2,3,4,6}` — are **pass on both arms**. That is the
measurement that says the wave-4 `= undefined` arm did not repeat that
regression, and it is why the arm is scoped to the `undefined` identifier
rather than reusing the full local predicate.

#### Test Results

**Scoped standalone sweep, both arms run in this worktree** (single-test
driver, `--target standalone`, 7 shards; base arm from file-copy reverts of
the four touched sources, branch arm at `a41edca71`):

| directory | rows |
| --- | ---: |
| `built-ins/Object/defineProperty` | 1131 |
| `built-ins/Object/defineProperties` | 632 |
| `built-ins/Object/getOwnPropertyDescriptor` | 310 |
| `built-ins/Object/keys` | 59 |
| `built-ins/Object/freeze` | 53 |
| `built-ins/Object/getOwnPropertyNames` | 45 |
| `built-ins/Object/preventExtensions` | 40 |
| + the 9 cross-lane `Array/prototype/{filter,forEach}` rows | 9 |
| **total** | **2279** |

|  | base | branch |
| --- | ---: | ---: |
| pass | 2226 | **2235** |
| fail | 51 | 42 |
| infrastructure (compile-timeout / ENOENT) | 2 | 2 |

**UP 9, DOWN 0.** Flip list:

```
defineProperty/15.2.3.6-4-195      defineProperty/15.2.3.6-4-21
defineProperty/15.2.3.6-4-243-1    defineProperty/15.2.3.6-4-622
defineProperties/15.2.3.7-6-a-204  defineProperties/15.2.3.7-6-a-231
freeze/15.2.3.9-2-a-11             freeze/15.2.3.9-2-a-14
preventExtensions/15.2.3.10-2
```

Three rows moved for INFRASTRUCTURE reasons and are excluded from both counts
— each was re-run SERIALLY on both arms afterwards and passes on both:

- `defineProperty/15.2.3.6-4-419` — base-arm `compilation timeout (123s)` under
  7-way contention (the box was also running three sibling lanes at load 15-21).
- `defineProperties/15.2.3.7-5-b-186` — base-arm `ENOENT`, the worktree
  `test262/` symlink-farm race the brief documents.
- `defineProperty/15.2.3.6-4-298-1` — the SAME ENOENT race on the branch arm.
  Counting it as a regression would have been a false alarm; the serial re-run
  is what settles it.

The 24-row census on the branch: **9 pass, 15 fail** (`.tmp/FINAL-wave4.tsv`),
matching the sweep exactly.

**Eval tier.** The worktree's `.test262-cache` was copied from the main
checkout at 12:57Z — i.e. the adapter the lead later found had been built from
an 8-day-stale bundle. It was kept UNCHANGED across both arms deliberately: a
base/branch delta is only meaningful if the tier is identical on both sides.
Blast radius is **2 rows of 2279** (`getOwnPropertyDescriptor/15.2.3.3-4-187`,
`-4-188` — the only rows in the set that mint from a body string); both pass on
both arms, and both still pass on the branch after refreshing the cache from
the rebuilt artifact. None of the 24 census rows is eval-dependent.

**Pins.** `tests/issue-4491-wave4.test.ts` — **14 passed (14)** on the branch;
on the reverted sources **7 failed / 7 passed**, i.e. every one of the 7
positive pins fails on the arm it claims to test and every one of the 7
`it.fails` residual pins reproduces on both arms. Prior-wave suites for this
issue: `issue-4491-proto-index-constructor-shadow` + `issue-4491-function-
binding-widening` → **10 passed (10)**; `issue-4506` → **22 passed**.

`issue-4504-inherited-set` → **1 failed / 35 passed (36)**. The one failure
(`reads present fnctor flow slots directly while absent slots preserve normal
prototype lookup`, expected 7 got 6) **reproduces on the reverted sources** —
it is pre-existing on the campaign base, not caused by this slice.

Two harness notes that cost real time and will cost the next lane the same:

- That suite spins its own `CompilerPool`, whose worker imports the GITIGNORED
  `scripts/runtime-bundle.mjs` and `scripts/compiler-bundle.mjs`. A fresh
  worktree has NEITHER, so the pool prints `[pool] worker failed before ready
  (exit 1)` and vitest reports **`36 skipped`, exit code 0** — a suite that
  runs nothing, green. Build both first
  (`npx esbuild src/runtime.ts --bundle --platform=node --format=esm
  --outfile=scripts/runtime-bundle.mjs --external:typescript
  --external:binaryen`, plus `pnpm run build:compiler-bundle`), and read the
  "N passed" line rather than the exit code — exactly the check the brief
  requires.
- Build those bundles from the arm you are measuring. They are compiled
  snapshots of `src/`, so a bundle left over from the other arm silently
  measures the wrong tree.

Three pin-shape findings worth carrying forward, because each one is a way a
pin can be green without testing anything:

1. The vec-identity pins only reproduce when the CALL is at module scope. With
   the same helper called from inside `main`, the checker hands the parameter
   the externref carrier, no conversion is emitted, and the pin passes on base.
2. The frozen-element pin only reproduces when the module contains a
   `delete obj[k]` somewhere — that is what sets `vecIndexDeleteDirty` and
   makes the module `overlayRouteActive`. Without it the typed lane writes
   through `array.set` and never reaches the guard. That is the honest scope of
   the fix, and it is why the real failing rows all include `propertyHelper.js`.
3. The `{get: <undefined var>}` pin only reproduces when the descriptor is
   passed as a VARIABLE. An inline literal argument takes the static
   literal-shape define path, which still throws — the same defect has two
   lowerings and only one of them is fixed.

Gates at commit (`SKIP_SLOW_PRECOMMIT=1`): `check:loc-budget` OK,
`check:func-budget` OK, both under the grants added to this file's
frontmatter. `test262` gitlink verified untouched
(`git diff 52cb0a6a6..HEAD --stat -- test262` empty).

#### Not done, and why

A local (function-scope) `var g = undefined` still stores the number 0. The
one-line extension of `varBindingNeedsExternrefForUndefined` was written and
**measured not to fix it** — the enclosing object literal's field type is
decided separately — so it was reverted rather than shipped: a behaviour
change on every `var x = undefined` local in every module with no measured
beneficiary is exactly the trade this campaign's audit chain keeps flagging.

Root 1's withdrawal was NOT extended to variable declarations
(`var alias = arr` shows the same converting copy — measured: `alias[1]`
answers the raw slot while `arr[1]` invokes the getter). No census row needed
it, and the same "no measured beneficiary" rule applies. Worth knowing that
the defect is not parameter-specific: a JS array is a REFERENCE, and any
cross-carrier vec→vec conversion silently makes a copy of one.

## Suspended Work — ES5 standalone campaign, waves 3–6 (2026-08-22)

**Everything implemented is MERGED to main.** Nothing is parked in a worktree;
all agent worktrees are removed. This section exists so the next session
resumes from measured state rather than re-deriving it.

### Where the number stands

| point | ES5 standalone (host-free) |
| --- | --- |
| campaign start | 8,618 / 9,029 (95.45%) |
| last full measurement (wave-3 head, 20260822-121509) | 8,748 / 9,029 (96.89%) |
| after wave-4/5/6 + regression recovery, unmeasured | ≈8,780 / 9,029 (≈97.2%) |

The landing page still shows **96.49%** because
`website/public/benchmarks/results/test262-standalone-editions.json` is
regenerated only by `test262-sharded.yml`'s promote job (needs a merge-QUEUE
artifact — both campaign PRs were admin-merged, so it never ran) or by
`refresh-baseline.yml` (cron `17 */8 * * *`). **Dispatch Baseline Refresh to
republish it.** PR #4785's parallel campaign also landed since, so the true
number is higher than the estimate above.

### How to resume

1. Dispatch Baseline Refresh (above), or run the scoped sweep locally:
   `TEST262_PATH_FILTER_FILE=<es5 list> VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 \
    TEST262_TARGET=standalone bash scripts/run-test262-vitest.sh`
   (the 3072 fork heap is load-bearing — the default 512 MB kills the run at
   ~2,554 tests).
2. Rebuild the remaining-rows list from the new jsonl; the `.tmp/` lists from
   this campaign are stale by ~250 flips.
3. Pick heads from "What is left" below.

### What is left (measured, with the blocking mechanism named)

| head | rows | state |
| --- | ---: | --- |
| Provider-realm carrier identity, slices C+D | ~25 | T7 landed slices A+B (tag + own keys). C = RegExp re-hydration through the QuickJS bridge; D re-counted to **1** row, not 5. `Function(src)` own `prototype` needs a mutable slot on a struct shared with the separately-compiled provider — a cross-module ABI change for 1 row, declined with price. |
| f64-hole follow-ons | ~8 | Value + presence halves both landed. Remaining: concat OUTPUT loses the marker (the 2-arg path boxes elements, canonicalizing the payload); the `length` SETTER must mark shrunk/grown slots. Design in "Implementation Plan (T8)". |
| `$Object.$proto` vs `$NativeProto` | 4 | Priced wall: `%Function.prototype%` exists as two objects by design, so `getPrototypeOf(f) === Function.prototype` cannot be fixed by returning the chain singleton. |
| #2809 `null` in an f64 carrier | ~3 | `Array(undefined,1,null,3).toString()` renders `",1,0,3"`. Blocks toString/S15.4.4.2_A1_T2 past check #3.2. |
| `typeof <symbol>` through a dynamic slot | ~2 | Implemented, measured +2/−1, REVERTED. Three exits priced in the T3 section; ends at the `$Object.$proto` wall. |
| String.fromCodePoint as a value; `new String.fromCharCode(…)` | 2 | T6 landed the fromCharCode value path; these two are its documented non-goals. |
| Sparse storage at index 2**32-2 | 1 | Lane J's storage wall — a hole cannot round-trip a value there. |
| annexB `block-decl-func-skip-arguments` | 1 | Module fails to VALIDATE: `__call_fn_0` call_ref arity (need 2, got 1). Not the T12 widening family. |
| `11.2.3-3_{3,4}` evaluation order / harness-only repro | 3 | `_3` is §13.3.6.1 arg-before-callee order; `_4`/`_8` reproduce ONLY through the real `assert.throws` — a simplified probe reports them absent. |

### Owed follow-ups (not blockers, but recorded)

- **F6 delete arm is DISABLED, not fixed** (`index.ts`, both finalize sites;
  `native-proto-delete.ts` deleted). It was net-negative: ~17 rows broken for
  3 gained. Re-enable only with a fix for the descriptor side-effect plus a
  control run over the `Object/defineProperty` prop-desc family.
- **Three `isPrototypeOf` modules now coexist** after PR #4785 landed in
  parallel (`expressions/is-prototype-of-call-arm.ts`,
  `native-is-prototype-of.ts`, `object-proto-is-prototype-of.ts`), as do three
  presence predicates (`builtin-instance-key-presence`,
  `vec-named-key-presence`, `vec-f64-hole-presence`). Not conflicting — wired at
  different dispatch points — but one spec operation with three routes deserves
  a consolidation slice.
- **Four `tests/issue-4200.test.ts` guards are stale** — T9's `constructor`
  seed made `gOPD(<B>.prototype, "constructor")` answer where the guards expect
  a decline. #4200's owner should adjudicate.
- **Three rows hang the in-process runner forever** (a `length` near 2^53 spins
  a search loop; a synchronous Wasm loop blocks Node's event loop so
  `TEST_TIMEOUT_MS` never fires): `lastIndexOf/length-near-integer-limit`,
  `reverse/length-exceeding-integer-limit-with-proxy`,
  `splice/create-species-length-exceeding-integer-limit`. They belong in
  `HANGING_TESTS`.
- **`wave5/T5-toprimitive-wip`** (fork branch) holds `d44becf8c3`, the T5-C
  ToPrimitive attempt — its own message says DO NOT INTEGRATE AS-IS, one
  measured regression. Its sibling fix (module-global array literal discarded by
  the shape-inferred vec seed) already landed via #4723.

### Process lessons worth keeping

- Gate failures cost more of this campaign than compiler defects did. The rules
  are now in `CLAUDE.md` ("Ratchet gates — run BEFORE every commit"): never pipe
  a gate whose status you need; simulate CI's base with `LOC_GATE_BASE`;
  run `check:dead-exports` after any supersede-style merge resolution.
- A test262 row that a probe cannot reproduce may still be real — some rows only
  fail through the genuine harness (`assert.throws`), and an agent worktree's
  `test262/` symlink farm is re-materialized mid-run, fabricating ENOENT
  "failures". Re-link before every row.
- Admin-merging bypasses the merge queue, so the landing-page artifacts do not
  refresh. Dispatch Baseline Refresh after any admin merge.

## Wave-7 (2026-08-24, branch `issue-4491-wave7`, base `17eb0b8d1` = campaign tip `c84bea96e` merged in)

### The 22-row census, bucketed honestly — including two buckets that are not buckets

All 22 rows re-verified failing on the branch base before any edit
(`.tmp/base-census.jsonl`, single-test driver, `--target standalone`, serial).
The dispatch note grouped them four ways; two of those groups do not survive
measurement, and saying so is half the value of this section.

| bucket | rows | verdict |
| --- | --- | --- |
| **§20.1.3.6 class tag on a dynamic receiver** | `create/15.2.3.5-4-15`, `defineProperties/15.2.3.7-2-16` | **ONE root, TAKEN** — see below |
| array `length` / index domain | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | one root, **#4497** (`MAX_CANONICAL_INDEX` is `2^31-1`), already filed |
| a kind-incompatible descriptor VALUE | `defineProperties/15.2.3.7-6-a-183` | separate root (`heterogeneousWidenedModuleGlobalType`, #4428) |
| far-index growth fills with a non-hole | `keys/15.2.3.14-5-13` | separate root |
| global / `Function.prototype` own function props | `getOwnPropertyDescriptor/15.2.3.3-4-4`, `-4-34`, `getOwnPropertyNames/15.2.3.4-4-1` | one root, carrier coverage |
| `Object(v)` on a Date / function | `S15.2.2.1_A2_T5`, `_A2_T7`, `S15.2.1.1_A2_T11` | one root, and it is **NOT** what the row titles say |
| the rest | 9 rows | separate roots, see the wave-4 residual table |

**The "array-length cluster" is three roots, not one.** The dispatch note calls
it "the biggest single cluster" on the strength of four rows whose failure text
mentions `length`. Measured, `-4-183` / `-6-a-179` are the 2^32-2 index domain
(#4497), `-6-a-183` is a descriptor VALUE the array's carrier cannot hold, and
`keys/15.2.3.14-5-13` is backing growth filling with a non-hole default. Only
the first pair shares a root.

**The "propertyHelper-site cluster" is not a cluster at all.** The note reads
`Cannot access property on null or undefined at 315:18` / `316:18` (and `320:18`
in the `Function/prototype/{apply,call}` rows) as "ONE harness interaction, not
four bugs". Those offsets are each test's OWN failing line mapped into the
assembled module, and the deltas prove it: 315−13 = 302 and 316−14 = 302 for the
two gOPD rows (same harness prefix, one extra source line in `-4-4`), but
320−15 = **305** for the `apply` row — a different prefix, i.e. different
includes. The gOPD pair fails because `gOPD(this,"eval")` and
`gOPD(Function.prototype,"constructor")` are `undefined` and the test then reads
`desc.value`; the `apply`/`call` pair is an eval-minted `Function(...)` used as a
[[Construct]] target. Near-identical numbers, unrelated roots. **No shared root
to hand back to the other lane.**

**`Object(v)` does NOT lose identity — the row titles mislead.** Measured on the
base (`.tmp/pObj1.js`), `Object(x) === x` is **true** for a Date, an array, a
plain object, a function and a RegExp. What fails is the member read afterwards:
`n_obj` types as `any`, so `n_obj.getFullYear` and `n_obj.constructor` go through
the reflective path and answer `undefined`. The bucket is a dynamic-receiver
member-lookup gap, not a ToObject gap; a lane taking it should start there and
not in `Object`'s constructor. (One caveat that cost me an hour and is worth
inheriting: the answer for `Object(d).getFullYear` **changed with unrelated
module content** — a probe that also contained a runtime-keyed member read
answered `function` where the minimal probe answered `undefined`. Isolate before
concluding.)

### Root taken — `Object.prototype.toString` had two lowerings and only one could see a value

`Object.prototype.toString.call(v)` in its DIRECT syntactic form is owned by the
#2501 compile-time fold (`resolveObjectToStringTag`), which keys on the
receiver's TypeScript type. Its standalone ladder ends in
`deferOrStandalone("Object")` for any receiver whose static type merely lowers
to a ref/externref — which under `allowJs` is **every `any`**. So the module
baked the constant `"[object Object]"` and nothing ever looked at the value.
Measured on the base, standalone (`.tmp/pTag1.js`), with

```js
var t = function (v) { return Object.prototype.toString.call(v); };
```

| receiver | base | branch | spec |
| --- | --- | --- | --- |
| `[1,2]` | `[object Object]` | **`[object Array]`** | Array |
| `function(){}` | `[object Object]` | **`[object Function]`** | Function |
| `new String("a")` / `new Number(1)` / `new Boolean(true)` | `[object Object]` ×3 | **String / Number / Boolean** | ✓ |
| `null` / `undefined` | `[object Object]` ×2 | **Null / Undefined** | ✓ |
| `1` / `"s"` / `true` | `[object Object]` ×3 | **Number / String / Boolean** | ✓ |
| `arguments` (all 5 spellings) | `[object Object]` | **`[object Arguments]`** | Arguments |
| `{}` | `[object Object]` | `[object Object]` | ✓ (unchanged) |
| `new Date(0)` / `/a/` / `new Error()` / `Math` / `JSON` | `[object Object]` ×5 | unchanged | residuals, below |

Eleven of sixteen receivers were being answered wrongly, silently, by a constant.
The identical question asked with a syntactically visible operand already
answered correctly — one module, one value, two answers.

The #4119 RUNTIME classifier (`object-proto-tostring.ts`) could already prove
most of them. It was simply unreachable from this spelling: the interception in
`expressions/calls.ts` (~L1110) declines the reflective path *whenever the fold
returns a tag*, and in standalone the fold always returns one.

**Reach beyond this issue.** `test262/harness/assert.js` — included by every
single test file — contains `Object.prototype.toString.call(value)` on a
parameter, i.e. exactly the unproven shape. So the slice changes the *emitted
module* corpus-wide even though it changes *behaviour* only where the tag is
observed. That is what set the sweep's shape (below).

### Fix — three parts, and the composition order is the whole design

1. **`object-proto-tostring-native.ts` (new)** — mint
   `__opts_classify(externref) -> externref`: the same emitter the reflective
   closure uses (`emitObjectProtoToStringClassifier`, now taking the receiver's
   local index as a parameter so param 0 works as well as the closure's param 1)
   with a **`ref.null extern` decline tail** instead of the loud refusal. Null is
   unambiguous as "declined": every real answer is a non-null `$NativeString`,
   and a null receiver returns the STRING `"[object Null]"`.
2. **`expressions/calls.ts` fold site** — when the fold's answer came from its
   UNPROVEN terminal (a new optional `ObjectToStringTagProof` out-parameter, set
   in exactly the two terminal arms and ridden through the `Object(x)`
   recursion), emit `classify(v) ?? <the fold's constant>`.

   **Runtime-first-then-constant, never the reverse, and this is not a style
   choice.** #4119's own record is the measurement: giving `toString` a real
   reflective body made the interception succeed and took **27 passing rows**
   down to the classifier's refusal. Composing this way is monotone — every
   receiver the classifier PROVES gets a right answer, every receiver it cannot
   keeps today's byte-for-byte constant, and nothing that passes can start
   refusing, because this path never reaches the refusal at all.

   Scoped to the unproven terminal only. A tag the fold derived from a resolved
   symbol name — `Date`, `RegExp`, `Error`, `IArguments`, a typed array, `Math`,
   `JSON` — is *more* precise than the classifier can be from a bare externref
   (those carriers are nominal structs it deliberately refuses), so those keep
   the constant. Pinned by the "a statically typed Date still folds to
   `[object Date]`" control.
3. **Two arms the classifier was missing.**
   - `NATIVE_PROTO_ORDINARY_BRANDS` — the builtin prototypes that are ORDINARY
     objects (`Object`, `Date`, `RegExp`, and the seven `*Error`s) answer the
     step-13 default instead of throwing. An EXPLICIT list, not a default `else`
     on `$NativeProto`: `Map.prototype`, `Set.prototype`, `Promise.prototype`,
     `Symbol.prototype`, `DataView.prototype`, `%TypedArray%.prototype` and
     `Generator.prototype` all carry an own `@@toStringTag`, so a blanket
     default would convert a loud refusal into a silent mis-tag for each of
     them — the exact trade the module's header rejects.
   - **Arguments before Array inside the `$Vec` arm.** An `arguments` exotic and
     an Array share `$Vec` (#4667), so `ref.test $__vec_base` claimed every
     arguments object as `[object Array]` — a mis-tag #4119's own note records.
     #4658 already mints the runtime fact (`OBJ_FLAG_ARGUMENTS` on the overlay
     companion); it just never exposed a plain "is this arguments?" query, since
     all four of its natives ask about `length`. Wave-7 adds
     `__args_is_branded(vec) -> i32` in the same pure-query shape as
     `__args_len_absent` (LOOKUP, never `ensure` — a query must not hand a later
     consumer a companion the receiver never had).

     **This deliberately does NOT touch `Array.isArray` / `__is_vec`.** #4667
     documents the landing-order hazard: narrowing *that* predicate flips
     test262's `propertyHelper.isWritable` onto a string-valued `length` probe
     that #4658's residual 1 cannot satisfy, silently trading
     `language/arguments-object/10.6-6-2` away. The new native is read by the
     class-tag classifier only, so it cannot reach that harness branch — and the
     whole `language/arguments-object` directory was swept on both arms to say
     so with a measurement rather than an argument.

### The bug inside the fix, which only a measurement found

The Arguments arm did not work when first written, and it failed as a silent
degrade rather than a wrong answer. `buildArgumentsIsBrandedCall` returns an
EMPTY payload when the native is not in `ctx.funcMap`, and #4658 reserves its
natives from arguments-vec **construction** — which may not have been compiled
yet when the classifier is emitted. Measured at that moment: the brand was
correctly applied at run time (`gOPD(args,"length").configurable` answered
`true` where an array answered `false`) and the classifier still said
`[object Array]`. The fix is one line — the classifier reserves the brand
natives itself (idempotent, append-only, standalone-only) rather than reading
whatever the map happens to hold.

Worth generalising: a helper that degrades to `[]` when its native is missing is
invisible at the call site. If you consume one, either reserve it yourself or
assert its presence; do not read the map and hope.

### A refuted hypothesis of my own, kept as a pin

I wrote an `it.fails` residual for "an arguments object that never reaches a MOP
call is unbranded, so it still reads `[object Array]`", reasoning from #4658's
observability gate. **It does not reproduce.** All five construction spellings —
`(function(){return arguments})()`, `new Fun()`, `new Fun(1,2)`, a declaration
called with arguments, and `arguments` read inside its own body — answer
`[object Arguments]` in a module containing no `defineProperty` at all: merely
being passed to a function makes the object observable. The `it.fails` was
flipped to a positive pin, which is what would catch the limit becoming real.

### Test Results — every number below is from a run executed in this worktree

**Flips: 4. Regressions: 0.** All four re-verified SERIALLY on both arms, one row
per process, after the parallel sweep (per the campaign's contention rule):

| row | base | branch | in the 22-row census? |
| --- | --- | --- | --- |
| `built-ins/Object/create/15.2.3.5-4-15` | fail `result !== true` | **pass** | yes |
| `built-ins/Object/defineProperties/15.2.3.7-2-16` | fail `result !== true` | **pass** | yes |
| `built-ins/Number/15.7.4-1` | fail `SameValue(«"[object Object]"», «"[object Number]"»)` | **pass** | no — out-of-census gain |
| `built-ins/Error/prototype/S15.11.4_A2` | fail `TypeError: Object.prototype.toString is not yet implemented` | **pass** | no — out-of-census gain |

**MOVEMENT, not a flip** (reported separately so the campaign total stays
auditable): `built-ins/Object/prototype/S15.2.4_A1_T2` fails on both arms, but
the failing assertion MOVED. On base it fails at assertion 1
(`Object.prototype.toString()` refused); on the branch assertion 1 passes and it
now fails at the second half — `delete Object.prototype.toString` must make the
method unfindable and a subsequent call must throw TypeError. That surviving
half is the deleted-member-observability shape of **#4664** (`__nproto_hasown`
answers from the brand's `$memberCsv`, and the companion ladder that would see a
tombstone is `kind === "method"`-only). **Handed to #4664**, not carried as a
residual here — it may come for free when that lands.

#### The sweep, and why it had to be a full one

Scope: **3,114 rows** (the raw list is 3,132; 18 are excluded, see the
contamination note below), composed as

| slice | rows | why |
| --- | ---: | --- |
| every corpus file naming `Object.prototype.toString` | 2,656 (with the below) | the behavioural reach |
| `language/arguments-object` (full) | 263 | the #4658 brand's home; `10.6-6-2` is #4667's canary |
| `built-ins/Array/prototype/{slice,splice,concat}` (full) | 245 | the #4119 `getClass` genericity family — the arm whose ORDER this slice changed |
| `built-ins/Object/{create,defineProperties,keys,freeze,preventExtensions,getOwnPropertyDescriptor,getOwnPropertyNames,prototype,seal}` + top-level | — | the issue's own directories, including every dir holding a flip |
| deterministic breadth sample of the rest of `built-ins` + `language` (every 95th) | 476 | the EMISSION reach — see below |

**Dropped, and named:** `built-ins/Object/defineProperty` (1,131 rows) except the
files that mention `Object.prototype.toString`. My diff contains no descriptor
code and cannot reach it except through the class tag; its census rows are
covered by the 22-row both-arms run instead.

**The byte-identity shortcut does NOT apply to this diff — measured, 145 of 149.**
The campaign's preferred zero-regression argument is "compare `wasm_sha` per
module and execute only the ones that differ". I ran it
(`.tmp/shasweep.mts`, compile-only, `assembleOriginalHarness` + the runner's exact
compile options, 149-row sample across the list, both arms):

```
identical: 4    differ: 145    no-binary: 0
```

**97% of modules differ**, because `test262/harness/assert.js` — included in
every single assembled test — carries `Object.prototype.toString.call(value)` on
a parameter, i.e. exactly the unproven shape this slice re-routes. So every
module mints `__opts_classify` and every module's bytes move. The identity
technique is right for a diff behind a narrow syntactic gate; this diff is behind
a gate the harness itself trips, and the full execution sweep was the correct
instrument. Worth recording as the boundary condition of that technique.

**Arms.**

| arm | rows | pass | fail | compile_error | skip | measured 1-min load |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| branch | 3,114 | 2,483 | 412 | 21 | 198 | 4.4 – 9.6 |
| base (subset, below) | 954 | 521 | 412 | 21 | 0 | 3.5 – 5.1 |

**UP 0, DOWN 0 across the base-arm subset**, which is
`{every row that is NOT passing on the branch}` ∪ `language/arguments-object` ∪
`Array/prototype/{slice,splice,concat}` ∪ `built-ins/Object/prototype`. The first
term is the load-bearing one: a regression is by definition a row that PASSES on
base and does not on the branch, so measuring the base for every branch-non-pass
row rules out a regression **anywhere in the 3,114**, not merely in the subset.
What the subset does NOT establish is the complete UP list outside those
families — flips are claimed only from the both-arms runs (the 22-row census, the
14-row `Object.prototype.toString` candidate set, and the serial re-verification
above).

**Zero infrastructure failures.** No `compilation timeout`, no ENOENT symlink
race, no `THREW` in either arm — unusual for this box and worth stating, since it
means no row in the counts above needed the flake-exclusion treatment.

**The two families most at risk are unchanged, row for row:**

| family | base | branch |
| --- | --- | --- |
| `language/arguments-object` | 216 pass / 47 fail | 216 pass / 47 fail |
| `Array/prototype/{slice,splice,concat}` | 116 pass / 105 fail | 116 pass / 105 fail |

`10.6-6-2` and `10.6-7-1` — the two rows #4667 names as the canary for touching
the arguments/Array split — **pass on both arms.** That is the measurement behind
the claim that reading `OBJ_FLAG_ARGUMENTS` inside the class-tag classifier does
not trip #4667's landing-order hazard.

#### Reconciling one mid-sweep source edit

A one-line guard (propagate `null` from the receiver's `compileExpression`
instead of falling through onto a partially-emitted operand stack) was added
after 2,067 of the branch arm's rows had already run, so those rows were measured
on a tree one line behind the commit. The guard can only affect a row whose
receiver expression fails to compile, so all **21** `compile_error` rows were
re-run on the FINAL tree: **21 of 21 unchanged.** Stated rather than hidden — the
right move would have been to freeze the tree, and the reconciliation is what
makes the numbers usable anyway.

#### Pins

`tests/issue-4491-wave7.test.ts` — **19 passed (19)** on the branch (file line
carries no `skipped` suffix). On the reverted sources: **11 failed / 8 passed**,
i.e. **every one of the 11 positive pins fails on the arm it claims to test**,
and the 3 controls + 5 `it.fails` residuals pass on both arms.

Getting there took two corrections, both instances of the same rule:

1. **The pin harness's compile options were not the runner's.** `runStandalone`
   compiled without `deferTopLevelInit` / `hostBridge: "always"`; the runner uses
   both. Fixed (and `__module_init` is now invoked before `main`, as the runner
   does after `setInstance`).
2. **Two pins were written in the corpus row's own spelling and were INSENSITIVE
   in it.** `Error.prototype.toString = Object.prototype.toString; …toString()`
   PASSES on the reverted sources in bare source — it answers `[object Object]`
   without ever consulting the classifier. Bisected across seven spellings on the
   revert arm:

   | spelling | base | branch |
   | --- | --- | --- |
   | the corpus spelling | answers | answers — **insensitive** |
   | …plus an unrelated `O.p.toString.call(x)` fold site | answers | answers — **insensitive** |
   | via a dynamic holder (`box.p = Error.prototype`) | refuses | **answers** ✔ |
   | via a helper parameter | refuses | **answers** ✔ |
   | via a variable (`Error.prototype.getClass = m`) | refuses | refuses |
   | `m.call(Object.prototype)` | refuses | refuses |
   | `m.call(box.p)` | refuses | refuses |

   The pins now use the dynamic-holder shape; the last three rows of that table
   are pinned `it.fails` as a residual with an owner.

Neighbouring suites on the branch — `issue-4491-wave4`, `issue-4658`,
`issue-2885`, `issue-4506`, `issue-4491-proto-index-constructor-shadow`,
`issue-4491-function-binding-widening`, `issue-4491-t4-add-parity`:
**77 passed (77)**, seven files, none with a `skipped` suffix. `issue-4658` (the
arguments brand this slice reads) and `issue-2885` (the `RegExp.prototype`
accessor read the #4654 handover flags as fragile) are both green.

#### Residuals from this slice, with owners

| residual | measured | owner |
| --- | --- | --- |
| a Date / RegExp / Error **instance** through a dynamic receiver still answers `[object Object]` | both arms | needs instance-carrier arms in the classifier; today those are the nominal structs it deliberately refuses |
| `Math` / `JSON` through a dynamic receiver still answer `[object Object]` | both arms | the fold knows both (`symName` arms, wave-5 T1); the classifier has no `@@toStringTag` step-15 arm |
| a SYNTACTIC `X.prototype` receiver (`X.prototype.m()` / `m.call(X.prototype)`) still refuses | both arms | the borrowed `X.prototype` receiver path (`transferred-proto-assignment.ts` / #1888), not this classifier |
| `Date.prototype` answers a non-`Object` tag | both arms, PRE-EXISTING | the fold's `.prototype` arm — its four-exception table is where `Date.prototype → Object` belongs |
| `String.prototype.trim.call(<arguments>)` coerces via element-join instead of the class tag (`"1,2,true"` vs `"[object Arguments]"`) — `String/prototype/trim/15.5.4.20-2-51` | branch | `emitBorrowedStringReceiverToString` (#3254), a different subsystem |

#### Two environment findings for the next lane

- **The shared `test262/test/` tree is CONTAMINATED with another lane's probe
  files.** `test/__probe4481__/` holds 18 `.js` files left behind by #4481 (a
  lane closed 2026-08-15). Any `find`-built row list silently includes them and
  they compile and "pass", inflating a denominator by 18 with rows that are not
  test262 at all. They are excluded from every number above. Worth deleting; at
  minimum, filter `__probe` out of any generated list.
- **A helper that degrades to an empty payload is invisible at the call site.**
  `buildArgumentsIsBrandedCall` returns `[]` when its native is unreserved, which
  is how the Arguments arm silently did nothing while the brand was demonstrably
  correct at run time. If you consume one of these builders, reserve the native
  yourself rather than reading `ctx.funcMap` and hoping.

#### Gates

`check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports` — all run BARE (not piped) and all
exit 0. No frontmatter allowance needed: the bulk of the change is a new module
(`src/codegen/object-proto-tostring-native.ts`), and `expressions/calls.ts` grows
by one guarded block at the single fold site.

`test262` gitlink verified untouched: `git status --short -- test262` empty
throughout, and no commit on this branch touches the submodule.

## Wave-7 landed (2026-08-24) — and re-bucketed what is left

**Status stays `ready`, not `done`:** wave-7 took one root of several. It was found at
`suspended`, which was stale.

**Landed:** `Object.prototype.toString` had two lowerings and only one could see a value.
The syntactic `.call(v)` form is owned by the #2501 compile-time fold, whose standalone
ladder ended in a `[object Object]` that is a **fallback, not a classification** — under
`allowJs` every `any` lands there. Measured: **11 of 16 receivers** answered wrongly by a
baked constant, while the same question with a visible operand answered correctly. The
#4119 runtime classifier could already prove most of them; it was unreachable from that
spelling. Composed **runtime-answer-first, fold-constant-as-fallback** — never the reverse,
because #4119's own record shows the reverse cost 27 passing rows.

4 flips (`Object/create/15.2.3.5-4-15`, `Object/defineProperties/15.2.3.7-2-16`, plus
out-of-census `Number/15.7.4-1` and `Error/prototype/S15.11.4_A2`), 0 regressions.
`Object/prototype/S15.2.4_A1_T2` **moved, did not flip** — assertion 1 now passes, it fails
at the `delete Object.prototype.toString` half, and is handed to **#4664** as the same
deleted-member-observability root.

### Three corrections to the earlier bucketing — do not re-derive these

1. **The "Array-length descriptor cluster" is THREE roots, not one.** Only
   `defineProperty/15.2.3.6-4-183` and `defineProperties/15.2.3.7-6-a-179` share one
   (#4497). `defineProperties/15.2.3.7-6-a-183` and `keys/15.2.3.14-5-13` are separate.
2. **The "propertyHelper-site cluster" is not a cluster at all.** The `315:18` / `316:18` /
   `320:18` offsets are each test's **own failing line**, and the deltas are 302, 302 and
   **305** — different harness prefixes. There is no shared root to hand back, and the
   `Function/prototype` rows that share the message are not siblings of these.
3. **`Object(v)` does not lose identity.** `Object(x) === x` holds on base for Date, array,
   object, function and RegExp. That bucket is **dynamic-receiver member lookup**, not
   ToObject — start there.

### Still open here

String-exotic index reads (`keys/15.2.3.14-5-a-4`, `preventExtensions/15.2.3.10-3-5`), the
three Array-length roots above, and the singles (`create/15.2.3.5-4-15`'s neighbours,
`-4-243-2`, `-4-589`, `freeze/15.2.3.9-2-a-12`,
`getOwnPropertyNames/15.2.3.4-4-1`, `prototype/valueOf/S15.2.4.4_A14`, the `n_obj.constructor`
pair). Explicitly **out of scope**: `defineProperty/S15.2.3.6_A1.js`, which fails on
`standalone target emitted host imports: env::Document_createElement (#2961)` — a DOM-import
issue, not descriptor MOP.
