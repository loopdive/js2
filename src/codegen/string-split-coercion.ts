// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared staged `String.prototype.split` limit coercion.
 *
 * Both the reflective native-prototype body and the direct plain-`ToString`
 * lane must perform `limit === undefined ? 2**32 - 1 : ToUint32(limit)` only
 * after JavaScript has evaluated the complete argument list.  Keeping this
 * value-level operation here avoids reconstructing an AST expression after it
 * has already been staged (which would evaluate it twice).
 */
import type { Instr } from "../ir/types.js";
import { emitWasmInt32Coercion } from "../ir/backend/wasm-int32-coercion.js";
import { buildIsUndefinedExternBody, undefinedSingletonActive } from "./any-helpers.js";
import { ensureExternrefToNumberProvider, getToPrimitiveProvider } from "./coercion-engine.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addHostStringConstantGlobal, addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { UNDEF_F64_BITS } from "./value-tags.js";

/** `__str_split` represents the spec's `2**32 - 1` default as signed `-1`. */
export const SPLIT_NO_LIMIT = -1;

/** §7.1.4 step 2 — shared with the canonical standalone ToNumber guard. */
const SYMBOL_TO_NUMBER_MESSAGE = "Cannot convert a Symbol value to a number";

/** Current provider indices resolved at an emission boundary. */
export interface StagedSplitLimitProviders {
  readonly toPrimitiveIdx: number;
  readonly unboxIdx: number;
  readonly isUndefinedIdx: number | undefined;
  /** Native standalone `$Symbol` type for the post-ToPrimitive ToNumber guard. */
  readonly symbolTypeIdx: number | undefined;
}

/**
 * Host-assisted native-string dependencies for the direct, proven-undefined
 * separator arm. These are intentionally separate from the object-runtime
 * providers above: asking the latter for an exact undefined predicate also
 * provisions compatibility proxy helpers that this arm neither needs nor can
 * safely satisfy.
 */
export interface HostStagedSplitLimitProviders {
  readonly toPrimitiveIdx: number;
  readonly unboxIdx: number;
  readonly isUndefinedIdx: number;
  readonly numberHintGlobalIdx: number;
}

const HOST_EXACT_UNDEFINED_HELPER = "__split_host_exact_undefined";

/**
 * Materialize one exact `undefined` predicate for host-assisted native strings.
 *
 * Native-string modules represent compiler-produced `undefined` as a
 * non-null `$AnyValue` singleton, while values returned from the JS host can
 * be the real JavaScript `undefined`. Neither `ref.is_null` nor the host
 * import alone recognizes both; this helper is their precise disjunction and
 * deliberately keeps `null` false.
 */
function ensureHostExactUndefinedHelper(ctx: CodegenContext, hostUndefinedIdx: number): number | undefined {
  const existing = ctx.funcMap.get(HOST_EXACT_UNDEFINED_HELPER);
  if (existing !== undefined) return existing;
  if (!undefinedSingletonActive(ctx)) return undefined;

  const singletonBody = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
  if (singletonBody === undefined) return undefined;

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$split_host_exact_undefined_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HOST_EXACT_UNDEFINED_HELPER,
    typeIdx,
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: hostUndefinedIdx },
      ...singletonBody,
      { op: "i32.or" },
    ],
    exported: false,
  });
  ctx.funcMap.set(HOST_EXACT_UNDEFINED_HELPER, funcIdx);
  return funcIdx;
}

/** Whether a value is a reflective ABI slot or an exact raw staged value. */
export type StagedSplitLimitUndefinedMode = "reflective-padded" | "raw-value";

/** Push whether the staged external value is JavaScript `undefined`. */
function emitSplitIsUndefined(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valueLocal: number,
  isUndefinedIdx: number | undefined,
  mode: StagedSplitLimitUndefinedMode,
): void {
  if (mode === "reflective-padded") {
    // A reflective closure has no presence bit: the ABI pads an omitted limit
    // as ref.null.extern, so that slot deliberately treats null as absent.
    fctx.body.push({ op: "local.get", index: valueLocal }, { op: "ref.is_null" });
  }
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: valueLocal }, { op: "call", funcIdx: isUndefinedIdx });
    if (mode === "reflective-padded") fctx.body.push({ op: "i32.or" });
  } else if (mode === "raw-value") {
    // Direct staging distinguishes explicit null from canonical undefined. A
    // missing exact predicate after preflight is an internal compiler failure,
    // never a reason to silently reinterpret null as the omitted argument.
    throw new Error("direct split limit lost its exact undefined predicate after preflight");
  }
}

/**
 * Install every provider that {@link emitStagedSplitLimitFromExternref} needs
 * before a caller emits/stages user expressions.  A caller may then decline
 * its native arm safely when this returns false, instead of falling back after
 * observable evaluation.
 */
export function prepareStagedSplitLimitCoercion(ctx: CodegenContext, fctx: FunctionContext): boolean {
  ensureObjectRuntime(ctx);
  const available =
    ensureExternrefToNumberProvider(ctx, fctx) !== undefined && getToPrimitiveProvider(ctx) !== undefined;
  if (!available) return false;

  // The raw-runtime ToPrimitive call below needs this global. Register it
  // before a direct caller stages user operands, because a host-mode global
  // import repairs already-emitted indices.
  addStringConstantGlobal(ctx, "number");

  // `__unbox_number` intentionally answers NaN for an unrecognised carrier:
  // it is also the non-throwing numeric-key probe for ordinary property
  // access. A split limit is instead the §7.1.4 ToNumber consumer, so a
  // standalone `$Symbol` returned by ToPrimitive must throw here. Reserve the
  // carrier and native TypeError before any caller stages user operands; the
  // eventual emitter rebuilds only final handles after staging.
  if (ctx.standalone) {
    // `ensureObjectRuntime` above owns native `$Symbol` carrier provisioning
    // for the native-first standalone profile. Do not import `symbol-native`
    // here: that module reaches string-ops, which owns the direct split caller.
    // A missing carrier is an internal availability failure, never permission
    // to send a dynamic Symbol into the non-throwing numeric-key probe.
    if (ctx.symbolTypeIdx < 0) return false;
    void buildThrowJsErrorInstrs(ctx, "TypeError", SYMBOL_TO_NUMBER_MESSAGE, {
      forceInModuleCtor: true,
      flush: fctx,
    });
  }
  flushLateImportShifts(ctx, fctx);
  return true;
}

/**
 * Preflight the host-only direct-split limit providers before operand staging.
 *
 * This is deliberately unavailable outside host-assisted native-string mode.
 * The direct arm that calls it has already proved an undefined separator, so it
 * needs no host generic ToString renderer or object/proxy runtime. Returning
 * false is a compile-time decline before receiver or arguments are evaluated.
 */
export function prepareHostStagedSplitLimitCoercion(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (ctx.targetProfile.semanticProviders !== "host-assisted" || !ctx.nativeStrings || !undefinedSingletonActive(ctx)) {
    return false;
  }

  const toPrimitiveIdx = ensureLateImport(
    ctx,
    "__to_primitive",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  const hostUndefinedIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  const numberHintGlobalIdx = addHostStringConstantGlobal(ctx, "number");
  if (
    toPrimitiveIdx === undefined ||
    unboxIdx === undefined ||
    hostUndefinedIdx === undefined ||
    numberHintGlobalIdx === undefined
  ) {
    return false;
  }

  // All late imports precede the defined helper. Its body is therefore born
  // with current indices; later operand lowering can still shift them, and the
  // ordinary late-import repair reaches this registered body as well.
  flushLateImportShifts(ctx, fctx);
  return ensureHostExactUndefinedHelper(ctx, hostUndefinedIdx) !== undefined;
}

/**
 * Capture the providers after a caller has completed all helper/import/global
 * provisioning. Direct split lowering probes availability before staging, then
 * captures again after staged expressions so late imports cannot stale a saved
 * numeric function index.
 */
export function captureStagedSplitLimitProviders(
  ctx: CodegenContext,
  requireExactUndefined = false,
): StagedSplitLimitProviders | undefined {
  const toPrimitiveIdx = getToPrimitiveProvider(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  const isUndefinedIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  const needsStandaloneSymbolGuard = ctx.standalone;
  const symbolTypeIdx = needsStandaloneSymbolGuard ? ctx.symbolTypeIdx : undefined;
  if (
    toPrimitiveIdx === undefined ||
    unboxIdx === undefined ||
    (requireExactUndefined && isUndefinedIdx === undefined) ||
    (needsStandaloneSymbolGuard && (symbolTypeIdx === undefined || symbolTypeIdx < 0))
  ) {
    return undefined;
  }
  return { toPrimitiveIdx, unboxIdx, isUndefinedIdx, symbolTypeIdx };
}

/**
 * The strict §7.1.4 Symbol arm for the standalone limit path.
 *
 * Its input is the primitive `externref` left by `__to_primitive`; retain it
 * across the brand test so the ordinary `__unbox_number` path receives the
 * exact same value when it is not a Symbol. The constructor/message were
 * armed by {@link prepareStagedSplitLimitCoercion} before operand staging, so
 * rebuilding this template only resolves final function/global handles.
 */
function standaloneSymbolToNumberGuardInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  symbolTypeIdx: number | undefined,
  localStem: string,
): Instr[] {
  if (symbolTypeIdx === undefined) return [];
  const primitiveLocal = allocLocal(fctx, `${localStem}_primitive_${fctx.locals.length}`, { kind: "externref" });
  return [
    { op: "local.tee", index: primitiveLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: symbolTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", SYMBOL_TO_NUMBER_MESSAGE, { forceInModuleCtor: true }),
    },
    { op: "local.get", index: primitiveLocal },
  ];
}

/** Resolve the host-only direct-arm handles after arbitrary staged operands. */
export function captureHostStagedSplitLimitProviders(ctx: CodegenContext): HostStagedSplitLimitProviders | undefined {
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  const isUndefinedIdx = ctx.funcMap.get(HOST_EXACT_UNDEFINED_HELPER);
  const numberHintGlobalIdx = ctx.hostStringGlobalMap.get("number");
  if (
    toPrimitiveIdx === undefined ||
    unboxIdx === undefined ||
    isUndefinedIdx === undefined ||
    numberHintGlobalIdx === undefined
  ) {
    return undefined;
  }
  return { toPrimitiveIdx, unboxIdx, isUndefinedIdx, numberHintGlobalIdx };
}

/** §7.1.7 ToUint32 for an f64 already produced by ToNumber. */
function exactToUint32Instrs(fctx: FunctionContext, numberLocal: number, localStem: string): Instr[] {
  const bits = allocLocal(fctx, `${localStem}_uint32_bits_${fctx.locals.length}`, { kind: "i64" });
  const exponent = allocLocal(fctx, `${localStem}_uint32_exponent_${fctx.locals.length}`, { kind: "i64" });
  const significand = allocLocal(fctx, `${localStem}_uint32_significand_${fctx.locals.length}`, { kind: "i64" });
  const magnitude = allocLocal(fctx, `${localStem}_uint32_magnitude_${fctx.locals.length}`, { kind: "i64" });
  const instrs: Instr[] = [{ op: "local.get", index: numberLocal }];
  // This shared backend primitive decomposes the IEEE-754 value instead of
  // saturating an i64 conversion, preserving modulo-2**32 for finite values
  // at and above 2**63 (for example, 2**64 -> 0).
  emitWasmInt32Coercion(instrs, { bits, exponent, significand, magnitude });
  return instrs;
}

/**
 * Emit the split limit operation for a value already held in an externref
 * local, returning an i32 local.  The providers must have been prepared before
 * staging; a missing provider is a compiler-side decline, never a substitute
 * JavaScript value.
 */
export function emitStagedSplitLimitFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  limitExternLocal: number,
  localStem = "__split",
  captured: StagedSplitLimitProviders | undefined = undefined,
  undefinedMode: StagedSplitLimitUndefinedMode = "reflective-padded",
): number | undefined {
  const providers = captured ?? captureStagedSplitLimitProviders(ctx);
  if (providers === undefined) return undefined;

  const numberLocal = allocLocal(fctx, `${localStem}_number_${fctx.locals.length}`, { kind: "f64" });
  const limitLocal = allocLocal(fctx, `${localStem}_limit_${fctx.locals.length}`, { kind: "i32" });
  emitSplitIsUndefined(ctx, fctx, limitExternLocal, providers.isUndefinedIdx, undefinedMode);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: SPLIT_NO_LIMIT }],
    else: [
      { op: "local.get", index: limitExternLocal },
      ...stringConstantExternrefInstrs(ctx, "number"),
      { op: "call", funcIdx: providers.toPrimitiveIdx },
      ...standaloneSymbolToNumberGuardInstrs(ctx, fctx, providers.symbolTypeIdx, localStem),
      { op: "call", funcIdx: providers.unboxIdx },
      { op: "local.set", index: numberLocal },
      ...exactToUint32Instrs(fctx, numberLocal, localStem),
    ],
  });
  fctx.body.push({ op: "local.set", index: limitLocal });
  return limitLocal;
}

/**
 * Host-assisted counterpart for an already staged raw direct-call limit.
 *
 * The `"number"` hint must be a real JavaScript string: native `$AnyString`
 * values are opaque to the host import and would select its default hint. The
 * host unboxer supplies ordinary `Number` semantics, including a TypeError for
 * a bare Symbol or one returned by `ToPrimitive`.
 */
export function emitHostStagedSplitLimitFromExternref(
  fctx: FunctionContext,
  limitExternLocal: number,
  providers: HostStagedSplitLimitProviders,
  localStem = "__split_host",
): number {
  const numberLocal = allocLocal(fctx, `${localStem}_number_${fctx.locals.length}`, { kind: "f64" });
  const limitLocal = allocLocal(fctx, `${localStem}_limit_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: limitExternLocal }, { op: "call", funcIdx: providers.isUndefinedIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: SPLIT_NO_LIMIT }],
    else: [
      { op: "local.get", index: limitExternLocal },
      { op: "global.get", index: providers.numberHintGlobalIdx },
      { op: "call", funcIdx: providers.toPrimitiveIdx },
      { op: "call", funcIdx: providers.unboxIdx },
      { op: "local.set", index: numberLocal },
      ...exactToUint32Instrs(fctx, numberLocal, localStem),
    ],
  });
  fctx.body.push({ op: "local.set", index: limitLocal });
  return limitLocal;
}
