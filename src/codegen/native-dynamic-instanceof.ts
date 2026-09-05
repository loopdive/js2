// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2916 Slice B) The host-free substrate for the FULLY-DYNAMIC `instanceof`
 * right-hand side under `--target standalone` / `--target wasi`.
 *
 * ## The leak this closes
 *
 * `emitDynamicInstanceOf` (identifiers.ts) is the residual arm for an RHS whose
 * constructor identity is NOT knowable at compile time — an `any`-typed local, a
 * function-valued parameter, a property access, a call result, a comma
 * expression. Every static rule ahead of it (the #2998 primitive-LHS fold, the
 * #2916 non-callable-RHS throw, the builtin-alias rewrite, #3962's user-fnctor
 * arm, Slice A's builtin membership) declines there by construction, so the arm
 * fell through to `ensureLateImport(ctx, "__instanceof_check", …)` and emitted
 * `env::__instanceof_check`. A host-free binary cannot satisfy that import, so
 * the module does not instantiate and the #2961 leak guard refuses the test.
 *
 * **Scale, measured on the branch base rather than quoted from the baseline.**
 * The 2026-08-15 standalone baseline lists 59 files naming
 * `env::__instanceof_check` as their SOLE host import, and ~1,500 more naming it
 * alongside others. Both figures are STALE and neither should be quoted. Compiled
 * on current main: **20** of the 59 still emit it, and of a 150-file
 * deterministic sample of the ~1,500, **zero** do — earlier slices (#2998,
 * #3962, Slice A, #4276) resolve those sites statically now.
 *
 * So the live population is **20 files**, and this closes all of them. It is the
 * single import standing between ordinary `instanceof` code and a genuinely
 * host-free module — which is the deliverable. Conformance rows are the secondary
 * metric (see the issue's tiering); the measured yield is +3.
 *
 * ## What the runtime can actually decide, and what it cannot
 *
 * The helper is a DEFINED function, so every question it asks must be answerable
 * from the VALUE. Three classifiers already exist and are shared rather than
 * re-derived here (a second, silently-diverging copy is the hazard
 * `closure-classifier.ts` was created to end):
 *
 *  - `__typeof_function` — IsCallable. Finalize-corrected
 *    (`typeof-natives-finalize.ts`), so it sees EVERY closure root registered
 *    anywhere in the module plus the #4120 `OBJ_FLAG_CALLABLE`-branded builtin
 *    constructor carriers. Calling it instead of snapshotting
 *    `closureInfoByTypeIdx` at build time is what makes this helper immune to
 *    the order-dependence that #4276 documents for a membership list.
 *  - `__typeof_object` / `__typeof_undefined` — Type(V) is Object, and the
 *    `undefined` singleton (#2106 S1).
 *  - `__isPrototypeOf` — the §7.3.20 step 6/7 chain walk over `$Object.$proto`
 *    with `ref.eq` per level (object-runtime-prototype.ts). ONE walk, shared
 *    with #3962 and Slice C; no parallel `[[Prototype]]` mechanism.
 *  - The two tri-state identity probes below — the canonical `Object` carrier
 *    and `$NativeProto`'s `Object` brand. They answer only exact identities;
 *    an unknown probe leaves the ordinary conservative path untouched.
 *
 * ## The closure → prototype edge (#2660 M3) — and the remaining gap
 *
 * Until #2660 M3, `Get(C, "prototype")` was unanswerable for a **closure**: a
 * standalone function value is a WasmGC closure-wrapper struct, and its
 * prototype object lives in a module GLOBAL keyed by the COMPILE-TIME symbol
 * name (`fnctor-prototype.ts`, and `ctx.protoGlobals` for classes), with no
 * runtime edge from the value. So a closure RHS answered the conservative
 * `false` and the arbitrary runtime-`Function(...)` prototype cases remained
 * unresolved. The explicit `FACTORY.prototype = Object.prototype` join is a
 * separate, exact `$NativeProto` identity that the probes below can answer.
 *
 * Three arms close the modeled cases, in this precedence order:
 *
 * 1. **Own `prototype` on a NON-`$Object` callable.** The `ref.test $Object`
 *    branch below gained an `else`. `__hasOwnProperty`/`__extern_get` dispatch
 *    on the receiver kind themselves and route a closure into its own-property
 *    bag (#3468), where `F.prototype = v` actually lands — so the read is
 *    exactly as authoritative there as on a branded carrier. This is what lets
 *    `FACTORY.prototype = undefined` / `= "error"` on a `new Function` value
 *    reach the §7.3.20 step-5 TypeError (`S15.3.5.3_A2_T2` and `_A2_T6`,
 *    measured fail→pass) instead of the conservative `false`.
 * 2. **The identity edge**, `__closure_proto_of`
 *    (`closure-prototype-edge.ts`), consulted when NO own `prototype` exists —
 *    which is why the hasOwn miss now falls through instead of returning 0. It
 *    matches the value against the canonical singleton global for each user
 *    constructor / class by `ref.eq` and answers the SAME object the
 *    `[[Prototype]]` seeding uses, so a hit is the genuine `Get(C,"prototype")`
 *    and a miss is `null`. It is also consulted on the NOT-callable tail,
 *    because a CLASS value is `typeof "object"` in this backend (reason 2
 *    there) yet is callable per spec.
 * 3. **The canonical `Object.prototype` identity.** A runtime-created
 *    `Function()` can be joined to that native prototype by an own-property
 *    assignment. The Object-brand probe recognizes that exact value and
 *    answers the ordinary object-family membership without guessing about any
 *    other runtime-created prototype.
 *
 * The closure edge emits NOTHING when the module has no edges, and neither
 * identity arm can produce a wrong `true`: the closure edge is an exact
 * singleton match, the Object-brand arm is an exact native-proto brand match,
 * and the own-property arm reads a property the program itself wrote.
 *
 * ## The answers, and why each is the least-wrong one available
 *
 * The tri-state is the one `emitInstanceofThrowGuard` already consumes: 0 false,
 * 1 true, 2 throw a wasm-level TypeError.
 *
 * | RHS at runtime                                 | answer       | why                                                                                                       |
 * | ---------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
 * | `null` / `undefined`                           | 0            | host dynamic-path parity (`runtime.ts:2353`). This backend still lowers some `Function(a,b)` forms to null, and `primitive instanceof FACTORY` must stay `false`, not throw (`S15.3.5.3_A1_T1…T8`). |
 * | callable, OWNS a `prototype` property          | full §7.3.20 | an own-property read on a real `$Object` is authoritative: a present-but-non-object `prototype` is genuinely the program's state ⇒ 2, otherwise the chain walk decides. |
 * | callable, no modelled `prototype`              | 0            | **documented residual**, see below.                                                                        |
 * | anything else (incl. genuine primitives)       | 0            | there is no SOUND runtime primitive test in this backend — see the "no wrong throws" section.               |
 *
 * ### The residual, stated plainly
 *
 * `obj instanceof FACTORY` where `FACTORY` holds a runtime closure still
 * answers **`false`, not the spec's true/TypeError**, unless its own
 * `prototype` is a modelled value (including the exact `Object.prototype`
 * identity). `S15.3.5.3_A2_T2/T5/T6` (which want a TypeError for an arbitrary
 * non-object `F.prototype`) remain residuals; `_A3_T1` is the expected initial
 * false, while `_A3_T2` is closed by the Object-brand join. That is deliberate.
 * Both alternatives are WORSE: answering `2` asserts "F.prototype really is a
 * non-object", and answering `1` asserts membership — neither is known. A
 * missed conversion is a missed conversion; a wrong `true` passes a test
 * vacuously and a wrong throw is observable in a `catch`. Closing the remaining
 * cases needs a general runtime closure→prototype edge, not a guess in this
 * module.
 *
 * ### No wrong throws — the second thing this module measured and changed
 *
 * §13.10.2 steps 1/4 mandate a TypeError for a non-object / non-callable RHS,
 * and the first cut emitted one whenever the target was not classifiable as an
 * object. That is unsound HERE, because an unmodelled builtin constructor is
 * lowered to a boxed-primitive carrier: the shared classifiers answer
 * `typeof Int8Array === "boolean"` (probe-verified on this branch). So every
 * "is the target a primitive" predicate built on them mistakes a real
 * constructor for a primitive. Measured consequence:
 * `typedArray instanceof TypedArray` threw "Right-hand side of 'instanceof' is
 * not callable" where the host predicate answers `false`
 * (`built-ins/TypedArrayConstructors/ctors/object-arg/iterator-is-null-as-array-like.js`).
 *
 * Nothing PROVABLE was lost by dropping it: a statically-primitive RHS and a
 * provably non-callable object RHS both still throw at codegen, one dispatch
 * step earlier, where the evidence is the static TYPE rather than a runtime
 * representation the backend gets wrong.
 *
 * ## Why this cannot regress a passing test
 *
 * The arm runs ONLY under `noJsHost`, and ONLY where the code it replaces
 * emitted `env::__instanceof_check`. Under the authoritative measurement (the CI
 * worker / `scripts/test262-worker.mjs`, which applies `standaloneHostImportError`)
 * every reaching test is already a `compile_error`: a leaking module never
 * instantiates. So a native answer can only CONVERT such a test, never turn a
 * passing one into a failure. The JS-host lane never enters this module and is
 * byte-identical.
 *
 * NOTE for anyone re-measuring locally: `runTest262File`'s ORIGINAL-HARNESS lane
 * does NOT apply that guard, so a leaking module still runs there with the host
 * supplying the import. A local pass/fail on a leaking file is therefore an
 * upper bound on the host answer, NOT the lane CI scores.
 *
 * ## Index-space discipline
 *
 * The helper is minted with `mintDefinedFunc` (a STABLE handle — no shifter
 * touches it, `resolveLayout` resolves it once at emit) and pushed in the same
 * call, so its baked callee indices are walked by the late-import body shifter
 * like any other defined function. Nothing is minted at finalize (the #4221
 * hazard); the only finalize-time correction it depends on is a BODY rewrite of
 * `__typeof_function`, which changes no index at all.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ts } from "../ts-api.js";
import { OBJ_FLAG_CALLABLE } from "./builtin-callable-brand.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { CLOSURE_PROTO_OF } from "./closure-prototype-edge.js"; // (#2660 M3) closure → prototype identity edge
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** `__instanceof_dynamic(value, target) -> i32` — the 0/1/2 tri-state helper. */
const HELPER_NAME = "__instanceof_dynamic";

/** Runtime identity probes used by the shared dynamic HasInstance substrate. */
const BUILTIN_CTOR_IDENTITY_HELPER = "__instanceof_builtin_ctor_identity";
const OBJECT_PROTO_INSTANCE_HELPER = "__instanceof_object_prototype";
const UNKNOWN_RESULT = 3;

/** Param / local slots of the helper body. */
const P_VALUE = 0;
const P_TARGET = 1;
const L_TARGET_ANY = 2;
const L_PROTO = 3;
const L_BUILTIN_CODE = 4;
const L_OBJECT_PROTO_CODE = 5;

/**
 * Reserve a value-identity probe for reified builtin constructors.
 *
 * The dynamic `instanceof` helper is registered before its operands are
 * compiled, while a builtin carrier global is created by the operand's value
 * lowering.  A tiny reserve/fill helper keeps that ordering honest: the
 * helper is present while the dynamic body is built, and its body is filled
 * only after all source expressions have published their canonical globals.
 */
function reserveBuiltinCtorIdentityHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(BUILTIN_CTOR_IDENTITY_HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = {
    name: BUILTIN_CTOR_IDENTITY_HELPER,
    typeIdx,
    locals: [],
    // 0/1 are definitive results; 3 means that this target is not the
    // canonical Object constructor carrier known to this module.
    body: [{ op: "i32.const", value: UNKNOWN_RESULT }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(BUILTIN_CTOR_IDENTITY_HELPER, funcIdx);
  return funcIdx;
}

/** Reserve the Object.prototype identity probe used by OrdinaryHasInstance. */
function reserveObjectPrototypeInstanceHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(OBJECT_PROTO_INSTANCE_HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = {
    name: OBJECT_PROTO_INSTANCE_HELPER,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: UNKNOWN_RESULT }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(OBJECT_PROTO_INSTANCE_HELPER, funcIdx);
  return funcIdx;
}

/**
 * Register (once) the native `__instanceof_dynamic` helper and return its stable
 * function handle, or `undefined` when the standalone substrate it needs is
 * unavailable — in which case the caller MUST keep its existing lowering rather
 * than emit a partial answer.
 */
export function ensureNativeDynamicInstanceOf(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(HELPER_NAME);
  if (existing !== undefined) return existing;

  // Every callee must be registered BEFORE the body bakes its index. Under
  // `noJsHost` each of these routes to a DEFINED function (no `env::` import is
  // added), so this registration cannot itself shift the index space.
  ensureObjectRuntime(ctx);
  const typeofFunctionIdx = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  const typeofObjectIdx = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  const typeofUndefinedIdx = ensureLateImport(ctx, "__typeof_undefined", [EXTERNREF], [I32]);
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const isProtoOfIdx = ensureLateImport(ctx, "__isPrototypeOf", [EXTERNREF, EXTERNREF], [I32]);
  const hasOwnIdx = ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]);
  // Positive primitive classifiers: the dynamic throw arm needs proof, not the
  // absence of an object classification.
  const primitiveIdxs = (["__typeof_number", "__typeof_string", "__typeof_boolean", "__typeof_bigint"] as const).map(
    (n) => ensureLateImport(ctx, n, [EXTERNREF], [I32]),
  );
  // (#2660 M3) The function-value → prototype-object identity edge. It is a
  // RESERVED defined function (`ensureObjectRuntime` above reserves it under
  // `noJsHost`), so its funcIdx is stable here and its BODY is filled at
  // finalize, once every fnctor/class prototype global exists. `undefined` only
  // when the reservation did not happen, in which case every arm below that
  // depends on it emits nothing and this helper keeps its previous answers.
  const closureProtoOfIdx = ctx.funcMap.get(CLOSURE_PROTO_OF);
  const builtinCtorIdentityIdx = reserveBuiltinCtorIdentityHelper(ctx);
  const objectProtoInstanceIdx = reserveObjectPrototypeInstanceHelper(ctx);
  flushLateImportShifts(ctx, null);

  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (
    typeofFunctionIdx === undefined ||
    typeofObjectIdx === undefined ||
    typeofUndefinedIdx === undefined ||
    externGetIdx === undefined ||
    isProtoOfIdx === undefined ||
    hasOwnIdx === undefined ||
    objectTypeIdx === undefined ||
    primitiveIdxs.some((i) => i === undefined)
  ) {
    return undefined;
  }

  /** `slot` is an OBJECT value (§7.3.20's Type(x) is Object) — closures included. */
  const isObjectValue = (slot: number): Instr[] => [
    { op: "local.get", index: slot },
    { op: "call", funcIdx: typeofObjectIdx },
    { op: "local.get", index: slot },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.or" },
  ];
  /** `slot` is `null` or the `undefined` singleton. */
  const isNullish = (slot: number): Instr[] => [
    { op: "local.get", index: slot },
    { op: "ref.is_null" },
    { op: "local.get", index: slot },
    { op: "call", funcIdx: typeofUndefinedIdx },
    { op: "i32.or" },
  ];
  /** Positive primitive proof; unknown values must remain conservative false. */
  const isProvenPrimitive = (slot: number): Instr[] => {
    const out: Instr[] = [
      { op: "local.get", index: slot },
      { op: "call", funcIdx: primitiveIdxs[0]! },
    ];
    for (const idx of primitiveIdxs.slice(1)) {
      out.push({ op: "local.get", index: slot }, { op: "call", funcIdx: idx! }, { op: "i32.or" });
    }
    return out;
  };
  const returnConst = (value: number): Instr[] => [{ op: "i32.const", value }, { op: "return" }];

  addStringConstantGlobal(ctx, "prototype");

  // §7.3.20 steps 4–7 for a target that owns `prototype`. The own-property gate
  // distinguishes a written non-object (throw) from an unmodelled property;
  // each emitted tail is a fresh instruction array for index-finalization safety.
  /** §7.3.20 steps 5–7 for a `prototype` value already in `L_PROTO`. */
  const ordinaryHasInstanceTail = (): Instr[] => [
    ...isNullish(L_PROTO),
    ...isProvenPrimitive(L_PROTO),
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: returnConst(2) },
    { op: "local.get", index: L_PROTO },
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: objectProtoInstanceIdx },
    { op: "local.tee", index: L_OBJECT_PROTO_CODE },
    { op: "i32.const", value: UNKNOWN_RESULT },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: L_OBJECT_PROTO_CODE }, { op: "return" }],
    },
    { op: "local.get", index: L_PROTO },
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: isProtoOfIdx },
    { op: "return" },
  ];
  /**
   * §7.3.20 steps 4–7 for a target that OWNS a `prototype` property. (#2660 M3)
   * A hasOwn MISS FALLS THROUGH to the identity-edge arm instead of `return 0`
   * — see the module header's "the closure → prototype edge".
   */
  const ownedPrototypeOrdinaryHasInstance = (): Instr[] => [
    { op: "local.get", index: P_TARGET },
    ...stringConstantExternrefInstrs(ctx, "prototype"),
    { op: "call", funcIdx: hasOwnIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P_TARGET },
        ...stringConstantExternrefInstrs(ctx, "prototype"),
        { op: "call", funcIdx: externGetIdx },
        { op: "local.set", index: L_PROTO },
        ...ordinaryHasInstanceTail(),
      ],
    },
  ];

  /**
   * (#2660 M3) `Get(C, "prototype")` through the function-value → prototype
   * identity edge — see the module header. A miss answers `null` and this arm
   * falls through, preserving the documented conservative `false`.
   */
  const prototypeEdgeArm = (): Instr[] => {
    if (closureProtoOfIdx === undefined) return [];
    return [
      { op: "local.get", index: P_TARGET },
      { op: "call", funcIdx: closureProtoOfIdx },
      { op: "local.tee", index: L_PROTO },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: ordinaryHasInstanceTail() },
    ];
  };

  /** §7.3.20 step 3 — Type(V) is not Object ⇒ false, before any prototype read. */
  const requireObjectValue = (): Instr[] => [
    ...isNullish(P_VALUE),
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },
    ...isObjectValue(P_VALUE),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },
  ];

  const body: Instr[] = [
    // §13.10.2 step 1, with the host dynamic path's ONE documented divergence:
    // null / undefined answer `false` instead of throwing, because this backend
    // still lowers some `Function(params, body)` forms to null and
    // `primitive instanceof FACTORY` must stay `false` (S15.3.5.3_A1_T1…T8).
    ...isNullish(P_TARGET),
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },

    // A runtime alias may still carry the canonical Object constructor after
    // its source binding was written (e.g. `var O = 0; O = Object`).  The
    // identity probe is deliberately tri-state: only the exact carrier match
    // is decisive, and every other target keeps the normal callable path.
    { op: "local.get", index: P_VALUE },
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx: builtinCtorIdentityIdx },
    { op: "local.tee", index: L_BUILTIN_CODE },
    { op: "i32.const", value: UNKNOWN_RESULT },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: L_BUILTIN_CODE }, { op: "return" }],
    },

    // IsCallable(C) — the shared, finalize-corrected classifier.
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx: typeofFunctionIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // §7.3.20 step 3: Type(V) is not Object → false, BEFORE any prototype
        // read. Order matters: a primitive V must not fire a `prototype`
        // accessor nor throw on a non-object prototype (#2702).
        ...requireObjectValue(),
        // A #4120-branded builtin constructor carrier is a real `$Object`, so
        // its `prototype` own property is an authoritative read. Tested by
        // reading the brand bit DIRECTLY rather than through
        // `buildBuiltinBrandTestArm`, whose emptiness depends on whether any
        // carrier had been branded YET at build time — an order dependence this
        // helper must not inherit (it is minted at the first dynamic-instanceof
        // site, which can precede every carrier).
        { op: "local.get", index: P_TARGET },
        { op: "any.convert_extern" },
        { op: "local.set", index: L_TARGET_ANY },
        { op: "local.get", index: L_TARGET_ANY },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          // (#2660 M3) The ELSE arm is new: a callable that is NOT an `$Object`
          // is a WasmGC closure carrier, whose own `prototype` lives in the
          // #3468 side bag — an equally authoritative read. Module header, "the
          // closure → prototype edge", half 1.
          else: ownedPrototypeOrdinaryHasInstance(),
          then: [
            { op: "local.get", index: L_TARGET_ANY },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
            { op: "i32.const", value: OBJ_FLAG_CALLABLE },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then: ownedPrototypeOrdinaryHasInstance() },
          ],
        },
        // (#2660 M3) No own `prototype` anywhere — try the identity edge to the
        // compile-time prototype registry before giving up.
        ...prototypeEdgeArm(),
        // Callable, and its `[[Prototype]]` source is not reachable from the
        // value — see the module header's "residual". Conservative `false`,
        // never a wrong `true` or a wrong throw.
        ...returnConst(0),
      ],
    },

    // (#2660 M3) NOT callable by `__typeof_function` — which in this backend
    // includes every CLASS value (`typeof C === "object"`, reason 2 below). A
    // class object IS callable per spec, so answering §7.3.20 for one through
    // the `__class_<Name>` identity edge is a correction, not a widening.
    ...(closureProtoOfIdx === undefined
      ? []
      : ([
          { op: "local.get", index: P_TARGET },
          { op: "call", funcIdx: closureProtoOfIdx },
          { op: "local.tee", index: L_PROTO },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...requireObjectValue(), ...ordinaryHasInstanceTail()],
          },
        ] satisfies Instr[])),

    // NOT CALLABLE ⇒ conservative false. Runtime classifiers cannot prove this
    // for every builtin carrier or class representation; statically provable
    // primitive/non-callable RHS values still throw before this helper.
    { op: "i32.const", value: 0 },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER_NAME, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER_NAME,
    typeIdx,
    locals: [
      { name: "targetAny", type: { kind: "anyref" } },
      { name: "proto", type: { kind: "externref" } },
      { name: "builtinCtorCode", type: { kind: "i32" } },
      { name: "objectProtoCode", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** WasmGC `eqref` — the domain used by the identity probes below. */
const EQ_HEAP_TYPE = -19;

/** `$NativeProto.$brand` field. */
const NATIVE_PROTO_BRAND_FIELD = 0;

/**
 * Build the positive `Type(value) is Object` answer shared by the two
 * identity probes.  `typeof_object` includes the backend's ordinary `$Object`
 * values and `typeof_function` includes closure values; null is excluded
 * explicitly because it is an externref that neither classifier is allowed to
 * treat as an object.
 */
function objectValueResult(valueSlot: number, typeofObjectIdx: number, typeofFunctionIdx: number): Instr[] {
  return [
    { op: "local.get", index: valueSlot },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: valueSlot },
        { op: "call", funcIdx: typeofObjectIdx },
        { op: "local.get", index: valueSlot },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
      ],
    },
  ];
}

/**
 * Fill the two reserve/fill probes used by `__instanceof_dynamic`.
 *
 * The dynamic helper is emitted before its operands.  At that point neither
 * the canonical `Object` carrier global nor the `$NativeProto` type is
 * guaranteed to exist, so both helpers start with the tri-state `UNKNOWN`
 * answer.  Finalization runs after all source expressions have published
 * those identities and only then installs the exact checks.  A probe that
 * cannot prove its identity remains unknown and the caller keeps its existing
 * conservative path.
 */
export function fillNativeDynamicInstanceOf(ctx: CodegenContext): void {
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (typeofObjectIdx === undefined || typeofFunctionIdx === undefined) return;

  const builtinFnIdx = ctx.funcMap.get(BUILTIN_CTOR_IDENTITY_HELPER);
  const objectProtoFnIdx = ctx.funcMap.get(OBJECT_PROTO_INSTANCE_HELPER);

  const builtinGlobalIdx = ctx.builtinObjectGlobals.get("Object");
  const builtinFn = builtinFnIdx === undefined ? undefined : definedFuncAt(ctx, builtinFnIdx);
  if (builtinFn && builtinGlobalIdx !== undefined) {
    const targetAny = 2;
    const valueAny = 3;
    builtinFn.locals = [
      { name: "targetAny", type: { kind: "anyref" } },
      { name: "valueAny", type: { kind: "anyref" } },
    ];
    builtinFn.body = [
      // A null target cannot be the canonical Object carrier.  The caller
      // normally checks this already, but keeping the probe total makes it
      // safe to reuse independently.
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: UNKNOWN_RESULT }, { op: "return" }],
      },
      { op: "global.get", index: builtinGlobalIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: targetAny },
          { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: builtinGlobalIdx },
              { op: "any.convert_extern" },
              { op: "local.tee", index: valueAny },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: targetAny },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: valueAny },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...objectValueResult(0, typeofObjectIdx, typeofFunctionIdx), { op: "return" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { op: "i32.const", value: UNKNOWN_RESULT },
    ];
  }

  const nativeProtoTypeIdx = ctx.nativeProtoTypeIdx;
  const objectProtoFn = objectProtoFnIdx === undefined ? undefined : definedFuncAt(ctx, objectProtoFnIdx);
  if (objectProtoFn && nativeProtoTypeIdx !== undefined) {
    const protoAny = 2;
    objectProtoFn.locals = [{ name: "protoAny", type: { kind: "anyref" } }];
    objectProtoFn.body = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: UNKNOWN_RESULT }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: protoAny },
      { op: "ref.test", typeIdx: nativeProtoTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: protoAny },
          { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
          { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
          { op: "i32.const", value: BUILTIN_BRAND_TABLE.Object! },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...objectValueResult(1, typeofObjectIdx, typeofFunctionIdx), { op: "return" }],
          },
        ],
      },
      { op: "i32.const", value: UNKNOWN_RESULT },
    ];
  }
}

/**
 * Emit `expr.left instanceof expr.right` for a fully-dynamic RHS as a host-free
 * i32 TRI-STATE (0 / 1 / 2) — the caller runs `emitInstanceofThrowGuard` over
 * it exactly as it did for `env::__instanceof_check`. Returns `null` to decline,
 * in which case the caller keeps its existing (host-import) lowering.
 *
 * Both operands are compiled in source order (§13.10.1 evaluates
 * RelationalExpression then ShiftExpression), so side effects, a RHS
 * ReferenceError and accessor throws are preserved.
 */
export function tryEmitNativeDynamicInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  if (!noJsHost(ctx)) return null;
  // Reserve the helper (and everything it calls) BEFORE either operand is
  // compiled, so any index shift it triggers reaches the already-emitted
  // instructions through `currentFunc`.
  const helperIdx = ensureNativeDynamicInstanceOf(ctx);
  if (helperIdx === undefined) return null;
  flushLateImportShifts(ctx, fctx);

  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, EXTERNREF);
  }

  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!rightType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (rightType.kind !== "externref") {
    coerceType(ctx, fctx, rightType, EXTERNREF);
  }

  // Re-read the handle: compiling the operands may have registered helpers.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME) ?? helperIdx });
  return { kind: "i32" };
}
