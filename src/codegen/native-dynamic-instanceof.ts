// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared native OrdinaryHasInstance and InstanceofOperator.
 *
 * The ordinary helper is also called by Function.prototype[@@hasInstance], so
 * it never consults a custom handler. For host-free values it validates the
 * left operand, performs canonical Get(target, "prototype") once and reuses the
 * existing representation-aware prototype walk. Missing/non-object prototypes
 * return the TypeError sentinel. The operator owns RHS validation, GetMethod,
 * handler Call/ToBoolean and the final ordinary delegation.
 *
 * Bound functions are resolved by a reserve/fill dispatcher: their carrier type
 * can be registered after the first operator site. It delegates each bound
 * target through the full operator, preserving a target's custom handler.
 * Identity probes use the same 0/1/2/UNKNOWN protocol and are filled after all
 * value globals exist. Every emitted instruction array is fresh for index
 * finalization; no body is minted during the final fill.
 *
 * Class/closure prototype materialization, getter calls and exceptions remain
 * owned by the canonical property runtime. The JavaScript boundary keeps its
 * existing compatibility instruction selection until its reviewed retirement.
 * This runtime cannot repair a source producer that supplied an incorrect
 * carrier; those remaining program-level gaps are tracked in issue 7139.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { hostFreeEnvironment, type CodegenContext, type FunctionContext } from "./context/types.js";
import { recordStandaloneRuntimeKeyClassMemberRead } from "./standalone-class-dyn-member.js";
import type { ts } from "../ts-api.js";
import { OBJ_FLAG_CALLABLE } from "./builtin-callable-brand.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { collectErrorInstanceOfTags, ERROR_FAMILY_CTOR_NAMES } from "./builtin-tags.js"; // (#7120)
import { CLOSURE_PROTO_OF } from "./closure-prototype-edge.js"; // (#2660 M3) closure → prototype identity edge
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { getWellKnownSymbolId } from "./literals.js"; // (#6651 I2) @@hasInstance id
import { moduleInstallsCallableHasInstance } from "./native-ordinary-instanceof.js"; // (#6651 I2)
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { protoIndexOwnViewSubstituteInstrs } from "./proto-index-store.js"; // (#6774 S20)
import { unwrapArrayProtoVecAliasInstrs } from "./vec-proto-link.js"; // (#6774 S20)
import { standaloneLinkBoundaryPeerIndex } from "./standalone-link-boundary.js"; // (#6644) linked-provider target
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
/** (#6651 I3) `target === %Function.prototype%` — an exact carrier probe, 0/1. */
const FUNCTION_PROTO_TARGET_HELPER = "__instanceof_function_prototype_target";
const UNKNOWN_RESULT = 3;
const BOUND_INSTANCEOF_HELPER = "__instanceof_bound_dispatch";

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
function reserveBinaryInstanceofProbe(ctx: CodegenContext, name: string): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: UNKNOWN_RESULT }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * (#6651 I3) Reserve the `%Function.prototype%` TARGET-identity probe.
 *
 * Same reserve/fill shape as {@link reserveBinaryInstanceofProbe}, and
 * for the same ordering reason: the `$NativeProto` type and the Function brand
 * are published by operand lowering, which runs AFTER the dynamic helper's body
 * is baked. The unfilled answer is `0` ("not proven to be the carrier"), which
 * keeps the helper's existing conservative path byte-for-byte.
 *
 * ## Why the helper needs it at all
 *
 * `%Function.prototype%` IS a function object (§20.2.3), but it is the one
 * callable this backend models as a `$NativeProto` carrier rather than as a
 * closure — so `__typeof_function` answers `false` for it and every §7.3.20
 * step past IsCallable was skipped: `V instanceof Function.prototype` came back
 * a silent `false`, whatever `Function.prototype.prototype` held.
 *
 * ## Why a probe here, not a widened classifier
 *
 * Teaching `__typeof_function` to answer `true` for the carrier would be
 * corpus-wide and a wrong `true` out of that classifier is observable
 * everywhere (`typeof`, every callable gate, every brand check). The probe is
 * an EXACT `$NativeProto` brand match consulted only on the helper's
 * not-callable tail, so no target the classifier already answers for changes
 * path.
 *
 * ## What the arm then does, and what was measured before writing it
 *
 * `__extern_get(C, "prototype")` is §7.3.20 step 5 in full on this carrier —
 * measured on this slice's base, it reads a data expando
 * (`Function.prototype.prototype = ""`) and it INVOKES an accessor installed by
 * `Object.defineProperty(Function.prototype, "prototype", {get})`. That
 * disproves the slice-I2 handoff's assumption that an accessor on a
 * `$NativeProto` carrier could not run ("the expando table stores values, not
 * attributes"); it holds for TypedArray carriers, not for this one. An ABSENT
 * `prototype` reads undefined, which `ordinaryHasInstanceTail` turns into the
 * spec's step-6 TypeError rather than a `false`.
 */
function reserveFunctionPrototypeTargetHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(FUNCTION_PROTO_TARGET_HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = {
    name: FUNCTION_PROTO_TARGET_HELPER,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(FUNCTION_PROTO_TARGET_HELPER, funcIdx);
  return funcIdx;
}

/**
 * (#6769 S3) §7.3.20 steps 6-7 for a `prototype` value that is a
 * TypedArray-family `$NativeProto` glue (`%TypedArray%.prototype` or a per-kind
 * `<View>.prototype`) — an arm of the `__instanceof_object_prototype` probe,
 * which already receives `(proto, value)` at exactly this step and already
 * answers the tri-state for the one `$NativeProto` it knew (the Object brand).
 *
 * `__isPrototypeOf` walks `$Object.$proto` only, and a glue is not an
 * `$Object`, so `view instanceof TA` (a `$__ta_ctor` target, whose `prototype`
 * is the per-kind glue) and `view instanceof %TypedArray%` both answered the
 * conservative `false` — while `Object.getPrototypeOf(view) === TA.prototype`
 * already held. This walk asks `__getPrototypeOf` hop by hop (it has the
 * dyn-view arm and the glue → parent-glue edge) and `ref.eq`s each hop against
 * the glue: an exact identity, so it can only turn a miss into a hit. Any other
 * brand falls through to the probe's UNKNOWN.
 *
 * Slots: params 0=proto 1=value; `protoAny` holds proto (already proven a
 * `$NativeProto`); `cur`/`curAny`/`hops` are the walk's scratch.
 */
/** Scratch locals {@link taProtoWalkArm} needs after the probe's `protoAny` (slots 3-5). */
const TA_WALK_LOCALS = [
  { name: "cur", type: EXTERNREF },
  { name: "curAny", type: { kind: "anyref" } as ValType },
  { name: "hops", type: I32 },
];

function taProtoWalkArm(
  ctx: CodegenContext,
  nativeProtoTypeIdx: number,
  slots: { protoAny: number; cur: number; curAny: number; hops: number },
): Instr[] {
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  const loBrand = BUILTIN_BRAND_TABLE["%TypedArray%"];
  const hiBrand = BUILTIN_BRAND_TABLE.BigUint64Array;
  if (getProtoIdx === undefined || loBrand === undefined || hiBrand === undefined) return [];
  // Only a module that minted a TA-family glue can hold one as a `prototype`;
  // every other module keeps the probe byte-identical.
  const minted = [...(ctx.nativeProtoGlobals?.keys() ?? [])].some((b) => b >= loBrand && b <= hiBrand);
  if (!minted) return [];
  const walk: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "local.set", index: slots.cur },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: slots.cur },
            { op: "call", funcIdx: getProtoIdx },
            { op: "local.tee", index: slots.cur },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: slots.cur },
            { op: "any.convert_extern" },
            { op: "local.tee", index: slots.curAny },
            { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: slots.curAny },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "local.get", index: slots.protoAny },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "ref.eq" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
              ],
            },
            // A chain is finite by construction ([[SetPrototypeOf]] refuses a
            // cycle); the cap only bounds a representation this walk does not
            // model, answering `false` rather than spinning.
            { op: "local.get", index: slots.hops },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.tee", index: slots.hops },
            { op: "i32.const", value: 10000 },
            { op: "i32.lt_u" },
            { op: "br_if", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 0 },
    { op: "return" },
  ];
  // brand ∈ [%TypedArray%, BigUint64Array] — the contiguous TA-family range.
  return [
    { op: "local.get", index: slots.protoAny },
    { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
    { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
    { op: "i32.const", value: loBrand },
    { op: "i32.sub" },
    { op: "i32.const", value: hiBrand - loBrand },
    { op: "i32.le_u" },
    { op: "if", blockType: { kind: "empty" }, then: walk },
  ];
}

const CARRIER_CHAIN_HELPER = "__instanceof_carrier_chain";
/** Chain helpers whose entry already carries the vec-alias unwrap (finalize may run twice). */
const aliasUnwrapped = new WeakSet<WasmFunction>();

/**
 * (#6774 S20) §7.3.20 steps 6-7 for a value that is not an `$Object`: a native
 * `$Array`, a string wrapper, a closure. `__isPrototypeOf` walks `$Object.$proto`
 * only (and casts the PROTOTYPE to `$Object` too), so `[] instanceof G` with
 * `G.prototype = Array.prototype` answered `false` while
 * `Object.getPrototypeOf([]) === Array.prototype` held. This generalises the
 * TA-family hop walk above: `__isPrototypeOf` first (unchanged answer and
 * fast path; it owns the `$Object` and Proxy candidates), then — for any
 * other candidate — `__getPrototypeOf` hop by hop with an identity test per
 * level. It can only turn a miss into a hit. Params: 0=proto 1=value.
 */
function ensureCarrierChainWalk(ctx: CodegenContext, isProtoOfIdx: number, objectTypeIdx: number): number {
  const existing = ctx.funcMap.get(CARRIER_CHAIN_HELPER);
  if (existing !== undefined) return existing;
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  if (getProtoIdx === undefined) return isProtoOfIdx;
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const [CUR, CUR_ANY, PROTO_ANY, HOPS, CANON] = [2, 3, 4, 5, 6];
  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  const notOrdinary: Instr[] = [
    { op: "local.get", index: CUR_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
  ];
  if (proxyTypeIdx !== undefined) {
    notOrdinary.push({ op: "local.get", index: CUR_ANY }, { op: "ref.test", typeIdx: proxyTypeIdx }, { op: "i32.or" });
  }
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: isProtoOfIdx },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.set", index: CUR_ANY },
    ...notOrdinary,
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // A builtin prototype has two carriers (the `$NativeProto` glue and its
    // companion `$Object`); compare both sides in the companion form.
    ...protoIndexOwnViewSubstituteInstrs(ctx, 0),
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: PROTO_ANY },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 1 },
    { op: "local.set", index: CUR },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: CUR },
            { op: "call", funcIdx: getProtoIdx },
            { op: "local.tee", index: CUR },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: CUR },
            { op: "local.set", index: CANON },
            ...protoIndexOwnViewSubstituteInstrs(ctx, CANON),
            { op: "local.get", index: CANON },
            { op: "any.convert_extern" },
            { op: "local.tee", index: CUR_ANY },
            { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: CUR_ANY },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "local.get", index: PROTO_ANY },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "ref.eq" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
              ],
            },
            // Bounds a representation this walk does not model (a chain is
            // finite by construction), answering `false` rather than spinning.
            { op: "local.get", index: HOPS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.tee", index: HOPS },
            { op: "i32.const", value: 10000 },
            { op: "i32.lt_u" },
            { op: "br_if", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 0 },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(CARRIER_CHAIN_HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: CARRIER_CHAIN_HELPER,
    typeIdx: addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]),
    locals: [
      { name: "cur", type: EXTERNREF },
      { name: "curAny", type: { kind: "anyref" } },
      { name: "protoAny", type: { kind: "anyref" } },
      { name: "hops", type: I32 },
      { name: "canon", type: EXTERNREF },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#6644) `Get(C, "prototype")` for an `instanceof` target the LINKED PROVIDER
 * owns — the last-resort arm of {@link ensureNativeDynamicInstanceOf}'s body.
 *
 * Every other ingredient of §7.3.20 already crossed the seam correctly.
 * Measured on the branch base with the real two-module fixture
 * (`.tmp/s66/probes/p3.mts`): `typeof T` is `"function"`, `T.prototype` reads
 * back the provider's own prototype object, `T.prototype.isPrototypeOf(V)` is
 * `true` (the #6622 class-instance seed composed with #6617's link hop), and
 * `Object.getPrototypeOf(V) === T.prototype` is `true`. The ONE step that
 * missed was the own-property GATE: `hasOwnProperty(T, "prototype")` answers
 * **false** for a provider-minted class object, because the consumer's
 * own-property bag is a module-local `ref.test` ladder that a foreign struct
 * matches nowhere. So the helper fell past both `prototype` arms to the
 * closure identity edge (module-local by construction), missed there too, and
 * answered the conservative `false` — for a DIRECTLY constructed provider
 * instance as much as for a subclass of one.
 *
 * The peer's `callableKind` is the ownership answer the gate needs: a value
 * with neither [[Call]] nor [[Construct]] over there is not a provider
 * function object, and this emits NOTHING at all in a module that consumes no
 * standalone provider. Bit 0 alone is not enough — a provider CLASS publishes
 * construct-only (`fillStandaloneLinkBoundaryLateTerminals`'s encoding), and a
 * class object is precisely the target every `x instanceof Temporal.Foo` names.
 *
 * `guardedTail` is §7.3.20 steps 3 + 5-7 for a `prototype` value already in
 * `L_PROTO`, passed in already-built so each call site owns a FRESH instruction
 * array (the index-finalization discipline every tail factory in this module
 * follows). Emitted LAST, after every local answer has declined, so it can only
 * replace a `false` that was a miss — never pre-empt an answer the consumer
 * could give itself.
 */
function linkedPeerPrototypeArm(ctx: CodegenContext, externGetIdx: number, guardedTail: Instr[]): Instr[] {
  const callableKindIdx = standaloneLinkBoundaryPeerIndex(ctx, "callableKind");
  if (callableKindIdx === undefined) return [];
  return [
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx: callableKindIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P_TARGET },
        ...stringConstantExternrefInstrs(ctx, "prototype"),
        { op: "call", funcIdx: externGetIdx },
        { op: "local.tee", index: L_PROTO },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: guardedTail },
      ],
    },
  ];
}

/** OrdinaryHasInstance's bound arm delegates to the full target operator. */
function fillBoundInstanceofDispatch(ctx: CodegenContext): void {
  const index = ctx.funcMap.get(BOUND_INSTANCEOF_HELPER);
  const operator = ctx.funcMap.get(NATIVE_INSTANCEOF_OPERATOR);
  if (index === undefined || operator === undefined || ctx.boundFnTypeIdx < 0) return;
  const fn = definedFuncAt(ctx, index);
  if (!fn) return;
  fn.body = [
    { op: "local.get", index: P_TARGET },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.boundFnTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P_VALUE },
        { op: "local.get", index: P_TARGET },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.boundFnTypeIdx },
        { op: "struct.get", typeIdx: ctx.boundFnTypeIdx, fieldIdx: 0 },
        { op: "call", funcIdx: operator },
        { op: "return" },
      ],
    },
    { op: "i32.const", value: UNKNOWN_RESULT },
  ];
}

/** Settle the same (value,target) tri-state protocol used by identity probes. */
function settledInstanceofProbe(funcIdx: number): Instr[] {
  return [
    { op: "local.get", index: P_VALUE },
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx },
    { op: "local.tee", index: L_BUILTIN_CODE },
    { op: "i32.const", value: UNKNOWN_RESULT },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: L_BUILTIN_CODE }, { op: "return" }] },
  ];
}

/** Positive primitive proof; unknown values remain unclassified. */
function provenPrimitiveInstrs(slot: number, primitiveIdxs: readonly (number | undefined)[]): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: slot },
    { op: "call", funcIdx: primitiveIdxs[0]! },
  ];
  for (const idx of primitiveIdxs.slice(1)) {
    out.push({ op: "local.get", index: slot }, { op: "call", funcIdx: idx! }, { op: "i32.or" });
  }
  return out;
}

/**
 * Register (once) the native `__instanceof_dynamic` helper and return its stable
 * function handle, or `undefined` when the standalone substrate it needs is
 * unavailable — in which case the caller MUST keep its existing lowering rather
 * than emit a partial answer.
 */
export function ensureNativeDynamicInstanceOf(ctx: CodegenContext): number | undefined {
  // The operator implicitly reads the runtime constructor prototype. Record
  // the explicit-read demand before reuse; finalize builds the identity edge.
  if (hostFreeEnvironment(ctx)) recordStandaloneRuntimeKeyClassMemberRead(ctx);
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
  const boundDispatchIdx = hostFreeEnvironment(ctx)
    ? reserveBinaryInstanceofProbe(ctx, BOUND_INSTANCEOF_HELPER)
    : undefined;
  const closureProtoOfIdx = ctx.funcMap.get(CLOSURE_PROTO_OF);
  const builtinCtorIdentityIdx = reserveBinaryInstanceofProbe(ctx, BUILTIN_CTOR_IDENTITY_HELPER);
  const objectProtoInstanceIdx = reserveBinaryInstanceofProbe(ctx, OBJECT_PROTO_INSTANCE_HELPER);
  const functionProtoTargetIdx = reserveFunctionPrototypeTargetHelper(ctx);
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
  const isProvenPrimitive = (slot: number): Instr[] => provenPrimitiveInstrs(slot, primitiveIdxs);
  const returnConst = (value: number): Instr[] => [{ op: "i32.const", value }, { op: "return" }];

  addStringConstantGlobal(ctx, "prototype");

  // §7.3.20 steps 4–7 for a target that owns `prototype`. The own-property gate
  // distinguishes a written non-object (throw) from an unmodelled property;
  // each emitted tail is a fresh instruction array for index-finalization safety.
  /** §7.3.20 steps 5–7 for a `prototype` value already in `L_PROTO`. */
  const ordinaryHasInstanceTail = (): Instr[] => [
    ...isNullish(L_PROTO),
    ...(hostFreeEnvironment(ctx)
      ? [...isObjectValue(L_PROTO), { op: "i32.eqz" as const }]
      : isProvenPrimitive(L_PROTO)),
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
    { op: "call", funcIdx: ensureCarrierChainWalk(ctx, isProtoOfIdx, objectTypeIdx) }, // (#6774 S20)
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

  /**
   * (#6651 I3) §7.3.20 steps 3/5-7 for the canonical `%Function.prototype%`
   * target. Placed on the not-callable tail; see the call site for why the
   * classifier is not widened instead.
   */
  const functionPrototypeTargetArm = (): Instr[] => [
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx: functionProtoTargetIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...requireObjectValue(),
        { op: "local.get", index: P_TARGET },
        ...stringConstantExternrefInstrs(ctx, "prototype"),
        { op: "call", funcIdx: externGetIdx },
        { op: "local.set", index: L_PROTO },
        ...ordinaryHasInstanceTail(),
      ],
    },
  ];

  /** §7.3.20 step 3 — Type(V) is not Object ⇒ false, before any prototype read. */
  const requireObjectValue = (): Instr[] => [
    ...isNullish(P_VALUE),
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },
    ...isObjectValue(P_VALUE),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },
  ];

  const body: Instr[] = [
    // OrdinaryHasInstance returns false for a non-callable target. The full
    // operator validates its RHS before delegating here.
    ...isNullish(P_TARGET),
    { op: "if", blockType: { kind: "empty" }, then: returnConst(0) },

    ...(boundDispatchIdx === undefined ? [] : settledInstanceofProbe(boundDispatchIdx)),

    // A runtime alias may still carry the canonical Object constructor after
    // its source binding was written (e.g. `var O = 0; O = Object`).  The
    // identity probe is deliberately tri-state: only the exact carrier match
    // is decisive, and every other target keeps the normal callable path.
    ...settledInstanceofProbe(builtinCtorIdentityIdx),

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
        ...(hostFreeEnvironment(ctx)
          ? ([
              { op: "local.get", index: P_TARGET },
              ...stringConstantExternrefInstrs(ctx, "prototype"),
              { op: "call", funcIdx: externGetIdx },
              { op: "local.set", index: L_PROTO },
              ...ordinaryHasInstanceTail(),
            ] satisfies Instr[])
          : ([
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
              // (#6644) …and the linked provider, for a target it owns.
              ...linkedPeerPrototypeArm(ctx, externGetIdx, [...requireObjectValue(), ...ordinaryHasInstanceTail()]),
              // Callable, and its `[[Prototype]]` source is not reachable from the
              // value — see the module header's "residual". Conservative `false`,
              // never a wrong `true` or a wrong throw.
              ...returnConst(0),
            ] satisfies Instr[])),
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

    // (#6644) A target this module cannot classify AT ALL may still be a
    // function object the linked provider owns — `__typeof_function` tests
    // THIS module's carrier shapes, so every provider-minted class object
    // lands here.
    ...linkedPeerPrototypeArm(ctx, externGetIdx, [...requireObjectValue(), ...ordinaryHasInstanceTail()]),

    // (#6651 I3) The ONE callable carrier `__typeof_function` cannot classify —
    // see `reserveFunctionPrototypeTargetHelper` for why this is a probe here
    // rather than a widening there.
    ...functionPrototypeTargetArm(),

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
  if (hostFreeEnvironment(ctx) && ensureInstanceofOperator(ctx) === undefined) return undefined;
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

/** `$Error_struct.$tag`, the native error kind (#1473). */
const ERROR_TAG_FIELD = 0;

/**
 * The `Object`-carrier arm of the builtin-constructor identity probe: when the
 * target is the canonical `Object` constructor carrier, answer Type(value) is
 * Object. Locals: 2 targetAny, 3 carrierAny.
 */
function objectCarrierIdentityArm(ctx: CodegenContext, typeofObjectIdx: number, typeofFunctionIdx: number): Instr[] {
  const objectGlobalIdx = ctx.builtinObjectGlobals.get("Object");
  if (objectGlobalIdx === undefined) return [];
  const targetAny = 2;
  const valueAny = 3;
  return [
    { op: "global.get", index: objectGlobalIdx },
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
            { op: "global.get", index: objectGlobalIdx },
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
  ];
}

/**
 * (#7120) The Error-family arm of the same probe. When the target is the
 * bare-value carrier of an Error-family constructor `N` (#2907), and the
 * value is a native `$Error_struct` whose `$tag` is in
 * `collectErrorInstanceOfTags(N)`, it answers 1. Every other case falls
 * through to UNKNOWN, so the chain walk still decides.
 *
 * ## Why the chain walk alone answered wrong
 *
 * The native error prototypes do not chain. On the host-free lanes
 * `Object.getPrototypeOf(TypeError.prototype) === Error.prototype` is false.
 * A user subclass of a builtin error is a `$Error_struct` carrying the
 * parent's `$tag`, with no `$Object` prototype link. So
 * `new TypeError() instanceof E` answered `false` whenever `E` (the realm's
 * `Error`) reached the operator as a VALUE. The name-based path (#1473),
 * which reads the `$tag`, answered `true` for a literal `instanceof Error`.
 *
 * ## Why this can only correct
 *
 * Only a 1 is decisive, so the operator answers (tag set) OR (chain walk).
 * A 1 is exactly a value and target pair the name-based path already answers
 * `true`, so no answer moves away from legacy's static path.
 * `Object.create(TypeError.prototype)`, which is not an `$Error_struct`, keeps
 * its chain-walk answer. Locals: 2 targetAny, 4 errorAny, 5 carrierAny, 6 tag.
 */
function errorCarrierTagArm(ctx: CodegenContext): Instr[] {
  const errorTypeIdx = ctx.errorStructTypeIdx;
  if (errorTypeIdx < 0) return [];
  const [targetAny, errorAny, carrierAny, tag] = [2, 4, 5, 6];
  const carriers: Instr[] = [];
  for (const name of ERROR_FAMILY_CTOR_NAMES) {
    const carrier = ctx.builtinObjectGlobals.get(name);
    if (carrier === undefined) continue;
    const member: Instr[] = [{ op: "i32.const", value: 0 }];
    for (const t of collectErrorInstanceOfTags(name)) {
      member.push({ op: "local.get", index: tag }, { op: "i32.const", value: t }, { op: "i32.eq" }, { op: "i32.or" });
    }
    carriers.push(
      { op: "global.get", index: carrier },
      { op: "any.convert_extern" },
      { op: "local.tee", index: carrierAny },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: targetAny },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "local.get", index: carrierAny },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.eq" },
          ...member,
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        ],
      },
    );
  }
  if (carriers.length === 0) return [];
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: targetAny },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: errorAny },
        { op: "ref.test", typeIdx: errorTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: errorAny },
            { op: "ref.cast", typeIdx: errorTypeIdx },
            { op: "struct.get", typeIdx: errorTypeIdx, fieldIdx: ERROR_TAG_FIELD },
            { op: "local.set", index: tag },
            ...carriers,
          ],
        },
      ],
    },
  ];
}

/**
 * Fill the builtin-constructor identity probe once every carrier exists: the
 * `Object` arm (decisive 0/1) and, since #7120, the Error-family arm (a
 * decisive 1). Leaves the reserved UNKNOWN body when neither can be proven.
 */
function fillBuiltinCtorIdentityHelper(ctx: CodegenContext, typeofObjectIdx: number, typeofFunctionIdx: number): void {
  const fnIdx = ctx.funcMap.get(BUILTIN_CTOR_IDENTITY_HELPER);
  const fn = fnIdx === undefined ? undefined : definedFuncAt(ctx, fnIdx);
  if (!fn) return;
  const objectArm = objectCarrierIdentityArm(ctx, typeofObjectIdx, typeofFunctionIdx);
  const errorArm = errorCarrierTagArm(ctx);
  if (objectArm.length === 0 && errorArm.length === 0) return;
  fn.locals = [
    { name: "targetAny", type: { kind: "anyref" } },
    { name: "carrierAny", type: { kind: "anyref" } },
    { name: "errorAny", type: { kind: "anyref" } },
    { name: "errorCarrierAny", type: { kind: "anyref" } },
    { name: "errorTag", type: I32 },
  ];
  fn.body = [
    // A null target cannot be a builtin carrier. The caller normally checks
    // this already, but keeping the probe total makes it safe to reuse.
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: UNKNOWN_RESULT }, { op: "return" }],
    },
    ...objectArm,
    ...errorArm,
    { op: "i32.const", value: UNKNOWN_RESULT },
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
  fillBoundInstanceofDispatch(ctx);
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (typeofObjectIdx === undefined || typeofFunctionIdx === undefined) return;

  const objectProtoFnIdx = ctx.funcMap.get(OBJECT_PROTO_INSTANCE_HELPER);

  fillBuiltinCtorIdentityHelper(ctx, typeofObjectIdx, typeofFunctionIdx);

  const nativeProtoTypeIdx = ctx.nativeProtoTypeIdx;
  const objectProtoFn = objectProtoFnIdx === undefined ? undefined : definedFuncAt(ctx, objectProtoFnIdx);
  if (objectProtoFn && nativeProtoTypeIdx !== undefined) {
    const protoAny = 2;
    const taWalk = taProtoWalkArm(ctx, nativeProtoTypeIdx, { protoAny, cur: 3, curAny: 4, hops: 5 }); // (#6769 S3)
    objectProtoFn.locals = [{ name: "protoAny", type: { kind: "anyref" } }];
    if (taWalk.length > 0) objectProtoFn.locals.push(...TA_WALK_LOCALS);
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
          ...taWalk,
        ],
      },
      { op: "i32.const", value: UNKNOWN_RESULT },
    ];
  }

  // (#6774 S20) An `Array.prototype` read through a vec-typed slot (a getter
  // whose inferred return is `any[]`) is the vec ALIAS, not the `$NativeProto`
  // the chain walk meets; unwrap it on entry. Once per helper.
  const chainIdx = ctx.funcMap.get(CARRIER_CHAIN_HELPER);
  const chainFn = chainIdx === undefined ? undefined : definedFuncAt(ctx, chainIdx);
  if (chainFn && !aliasUnwrapped.has(chainFn)) {
    aliasUnwrapped.add(chainFn);
    chainFn.body.unshift(...unwrapArrayProtoVecAliasInstrs(ctx, 0));
  }

  // (#6651 I3) `target === %Function.prototype%`. A 0/1 answer, not the
  // tri-state: the caller uses it only to ENTER the §7.3.20 arm, so "cannot
  // prove it" and "is not the carrier" are the same instruction.
  const functionProtoFnIdx = ctx.funcMap.get(FUNCTION_PROTO_TARGET_HELPER);
  const functionProtoFn = functionProtoFnIdx === undefined ? undefined : definedFuncAt(ctx, functionProtoFnIdx);
  if (functionProtoFn && nativeProtoTypeIdx !== undefined) {
    const targetAny = 1;
    functionProtoFn.locals = [{ name: "targetAny", type: { kind: "anyref" } }];
    functionProtoFn.body = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: targetAny },
      { op: "ref.test", typeIdx: nativeProtoTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: targetAny },
          { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
          { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
          { op: "i32.const", value: BUILTIN_BRAND_TABLE.Function! },
          { op: "i32.eq" },
          { op: "return" },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
  }
}

/** `__instanceof_operator(value, target) -> i32` — §13.10.2 over the ordinary helper. */
export const NATIVE_INSTANCEOF_OPERATOR = "__instanceof_operator";

/** Local slots of the §13.10.2 operator wrapper (params are P_VALUE / P_TARGET). */
const OP_L_HANDLER = 2;
const OP_L_ARGS = 3;

/**
 * GetMethod/Call/ToBoolean are operator semantics, separate from the public
 * ordinary-instance method. Native invalid RHS/handler values return 2; the IR
 * or existing Wasm caller turns that into a real native TypeError. Getter and
 * handler exceptions propagate directly. IR reserves this entry regardless of
 * source-local handler installation; the compatibility AST caller retains its
 * previous demand scan.
 */
export function ensureInstanceofOperator(ctx: CodegenContext): number | undefined {
  const strict = hostFreeEnvironment(ctx);
  const existing = ctx.funcMap.get(NATIVE_INSTANCEOF_OPERATOR);
  if (existing !== undefined) return existing;

  const ordinaryIdx = ensureNativeDynamicInstanceOf(ctx);
  if (ordinaryIdx === undefined) return undefined;
  // Ordinary registration may have completed this reciprocal dependency.
  const reserved = ctx.funcMap.get(NATIVE_INSTANCEOF_OPERATOR);
  if (reserved !== undefined) return reserved;

  // Every callee must be registered BEFORE the body bakes its index; the object
  // runtime (which owns `__objvec_new` / `__objvec_push`) is already up via
  // `ensureNativeDynamicInstanceOf` above.
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const boxSymbolIdx = ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  const isTruthyIdx = ensureLateImport(ctx, "__is_truthy", [EXTERNREF], [I32]);
  const typeofFunctionIdx = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  const typeofObjectIdx = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  const isCallableIdx = strict ? ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]) : typeofFunctionIdx;
  const typeofUndefinedIdx = ensureLateImport(ctx, "__typeof_undefined", [EXTERNREF], [I32]);
  const applyClosureIdx = reserveApplyClosure(ctx);
  flushLateImportShifts(ctx, null);

  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const hasInstanceId = getWellKnownSymbolId("hasInstance");
  if (
    externGetIdx === undefined ||
    boxSymbolIdx === undefined ||
    isTruthyIdx === undefined ||
    typeofFunctionIdx === undefined ||
    typeofObjectIdx === undefined ||
    isCallableIdx === undefined ||
    typeofUndefinedIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    hasInstanceId === undefined
  ) {
    return undefined;
  }

  // step 4.a: ToBoolean(Call(handler, C, «O»)).
  const callHandler: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: OP_L_ARGS },
    { op: "local.get", index: OP_L_ARGS },
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: OP_L_HANDLER },
    { op: "local.get", index: P_TARGET },
    { op: "local.get", index: OP_L_ARGS },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "call", funcIdx: isTruthyIdx },
    { op: "return" },
  ];

  const body: Instr[] = [
    ...(strict
      ? ([
          // InstanceofOperator validates the RHS before GetMethod or the LHS kind.
          { op: "local.get", index: P_TARGET },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 2 }, { op: "return" }] },
          { op: "local.get", index: P_TARGET },
          { op: "call", funcIdx: typeofObjectIdx },
          { op: "local.get", index: P_TARGET },
          { op: "call", funcIdx: typeofFunctionIdx },
          { op: "i32.or" },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 2 }, { op: "return" }] },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: P_TARGET },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // step 2: GetMethod(C, @@hasInstance). A throwing getter propagates.
        { op: "local.get", index: P_TARGET },
        { op: "i32.const", value: hasInstanceId },
        { op: "call", funcIdx: boxSymbolIdx },
        { op: "call", funcIdx: externGetIdx },
        { op: "local.tee", index: OP_L_HANDLER },
        { op: "ref.is_null" },
        { op: "local.get", index: OP_L_HANDLER },
        { op: "call", funcIdx: typeofUndefinedIdx },
        { op: "i32.or" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: OP_L_HANDLER },
            { op: "call", funcIdx: isCallableIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: callHandler,
              else: strict ? [{ op: "i32.const", value: 2 }, { op: "return" }] : undefined,
            },
          ],
        },
      ],
    },
    ...(strict
      ? ([
          { op: "local.get", index: P_TARGET },
          { op: "call", funcIdx: typeofFunctionIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 2 }, { op: "return" }] },
        ] satisfies Instr[])
      : []),
    // steps 5-6: OrdinaryHasInstance(C, O), tri-state, unchanged.
    { op: "local.get", index: P_VALUE },
    { op: "local.get", index: P_TARGET },
    { op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME) ?? ordinaryIdx },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(NATIVE_INSTANCEOF_OPERATOR, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: NATIVE_INSTANCEOF_OPERATOR,
    typeIdx,
    locals: [
      { name: "hasInstanceHandler", type: EXTERNREF },
      { name: "hasInstanceArgs", type: EXTERNREF },
    ],
    body,
    exported: false,
  });
  return funcIdx;
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
  //
  // (#6651 I2) In a module that installs a possibly-callable `@@hasInstance`,
  // the OPERATOR (§13.10.2) is the entry point, not OrdinaryHasInstance — see
  // `ensureInstanceofOperator`. It wraps the same tri-state, so the caller's
  // throw guard is unchanged, and it declines to the ordinary helper whenever
  // its substrate is absent.
  const operatorIdx = moduleInstallsCallableHasInstance(expr.getSourceFile())
    ? ensureInstanceofOperator(ctx)
    : undefined;
  const entryName = operatorIdx === undefined ? HELPER_NAME : NATIVE_INSTANCEOF_OPERATOR;
  const helperIdx = operatorIdx ?? ensureNativeDynamicInstanceOf(ctx);
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
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(entryName) ?? helperIdx });
  return { kind: "i32" };
}
