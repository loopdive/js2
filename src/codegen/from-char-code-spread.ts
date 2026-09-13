// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The argument list of `String.fromCharCode` / `String.fromCodePoint` (#6421).
 *
 * ## The defect this exists to remove
 *
 * `compileFromCharCodeFamily` builds one string PART per argument AST node and
 * folds the parts with the shared variadic concat. One part per node is exact
 * only while every argument is a single value: a SPREAD contributes its runtime
 * element count, so `String.fromCharCode(...bytes)` compiled the SOURCE array
 * as one code unit — the array coerces to `NaN`, ToUint16(NaN) is 0, and the
 * whole call answered a single `"\0"`. That is why hono's
 * `btoa(String.fromCharCode(...new Uint8Array(signature)))` signed every cookie
 * as `AA==` (base64 of one zero byte) instead of the real 44-character digest.
 *
 * `fromCodePoint` failed harder: `NaN` is not an integral code point, so the
 * #2601 range guard threw `RangeError: Invalid code point NaN`.
 *
 * This is the same shape #5361 removed from `splice` / `push` / `Math.min`-`max`
 * and #6411 removed from the two host-Array argument builders — one push per AST
 * node — so the repair is the same: route a spread-containing argument list
 * through the shared {@link buildSpreadArgList} builder, which evaluates the list
 * once, left to right, and knows each spread's runtime length.
 *
 * ## Why the fold becomes an accumulator
 *
 * With a static argument list the parts are a compile-time array and
 * `emitVariadicStringConcat` folds them in place. A spread's element count is a
 * runtime value, so the fold has to run at runtime: an accumulator local seeded
 * with `""` and `acc = concat(acc, part)` inside the builder's per-element sink.
 * Left-to-right order is preserved because the builder emits its slots in
 * argument order.
 *
 * ## The per-code-unit tail is shared, not copied
 *
 * {@link emitCodeUnitPart} is the exact per-argument tail the static loop ran
 * (§7.1.8 ToUint16 in the f64 domain for native `fromCharCode`, the #2601 range
 * guard plus `i32.trunc_sat` for native `fromCodePoint`, an `f64.convert` for
 * the host imports, then the 1-char-string helper). Both lanes call it, so the
 * loop and the accumulator cannot drift apart.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { hostStringRepr, nativeStringRepr } from "./builtin-scaffold.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowRangeError, noJsHost } from "./js-errors.js";
import { buildSpreadArgList, canBuildSpreadArgList, hasSpreadArgument } from "./spread-arg-list.js";
import { tryThrowOnBigIntOrSymbolArg } from "./string-ops.js";

/** Which lane of the family is being lowered. */
export interface CodeUnitLane {
  /**
   * `true` for the pure-Wasm native-string helpers (`__str_fromCharCode` /
   * `__str_fromCodePoint`, i32-typed), `false` for the 1-arg host imports
   * (`String_fromCharCode` / `String_fromCodePoint`, f64-typed).
   */
  native: boolean;
  /** Funcidx of the 1-char(-or-code-point)-string helper for this lane. */
  helperIdx: number;
  /** `true` for `fromCodePoint` (§22.1.2.2 range check applies). */
  isFromCodePoint?: boolean;
}

/**
 * Emit the per-argument tail into `buf`: a numeric value of `argType` on the
 * stack becomes a one-code-unit string of the lane's representation.
 *
 * `argType` is the type `compileExpression` produced for the argument (or the
 * spread element's destination type, always `f64` there); `null` means the
 * argument compiled to no value at all.
 */
export function emitCodeUnitPart(
  ctx: CodegenContext,
  fctx: FunctionContext,
  buf: Instr[],
  argType: ValType | null,
  lane: CodeUnitLane,
): void {
  const { native, helperIdx, isFromCodePoint } = lane;
  // #2601 — §22.1.2.2 step 2b/2c: each fromCodePoint code point, after
  // ToNumber, must be an INTEGRAL Number in [0, 0x10FFFF] else RangeError.
  // (fromCharCode does ToUint16 with NO such check — fromCodePoint-only.)
  // Scoped to standalone/WASI (`noJsHost`): the throw uses the in-module
  // `__new_RangeError` constructor with no host bridge. The JS-host lane
  // keeps its existing host-delegated behaviour (the slice is standalone).
  const emitRangeGuard = isFromCodePoint === true && noJsHost(ctx);
  if (emitRangeGuard) {
    // Normalise to f64, then test `trunc(cp) != cp` (catches fractional AND
    // NaN) OR `cp < 0` OR `cp > 0x10FFFF` (±∞ caught by the range test).
    if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
    const cpTmp = allocLocal(fctx, `__fcp_cp_${fctx.locals.length}`, { kind: "f64" });
    buf.push({ op: "local.tee", index: cpTmp });
    // integral: trunc(cp) != cp  → also true for NaN
    buf.push({ op: "local.get", index: cpTmp });
    buf.push({ op: "f64.trunc" });
    buf.push({ op: "f64.ne" });
    // range: cp < 0
    buf.push({ op: "local.get", index: cpTmp });
    buf.push({ op: "f64.const", value: 0 });
    buf.push({ op: "f64.lt" });
    // range: cp > 0x10FFFF
    buf.push({ op: "local.get", index: cpTmp });
    buf.push({ op: "f64.const", value: 0x10ffff });
    buf.push({ op: "f64.gt" });
    buf.push({ op: "i32.or" });
    buf.push({ op: "i32.or" });
    const throwBuf: Instr[] = [];
    const savedForThrow = fctx.body;
    fctx.body = throwBuf;
    emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
    fctx.body = savedForThrow;
    buf.push({ op: "if", blockType: { kind: "empty" }, then: throwBuf });
    // Re-push the validated code point for the helper.
    buf.push({ op: "local.get", index: cpTmp });
  }
  if (native) {
    if (emitRangeGuard) {
      // Already f64 in the temp above — trunc to the i32 the native helper wants.
      buf.push({ op: "i32.trunc_sat_f64_s" });
    } else if (argType && argType.kind !== "i32") {
      // (#2875 slice 5) §7.1.8 ToUint16 computed in the f64 domain BEFORE
      // the i32 conversion: t = trunc(x); m = t − floor(t/2^16)·2^16 ∈
      // [0, 65535]. Division by 2^16 is a pure exponent shift, so every
      // step is exact for all finite f64s; NaN and ±Inf propagate to a NaN
      // m (Inf−Inf), which i32.trunc_sat then maps to the spec's +0.
      // A bare `i32.trunc_sat_f64_s` SATURATES first — +Inf → 0x7FFFFFFF,
      // which the helper's low-16 mask turns into 0xFFFF instead of 0
      // (S9.7_A1 #5), and any |x| ≥ 2^31 loses its true modulo the same
      // way. (The i32-typed arg arm needs none of this: the helper's mask
      // IS ToUint16 for i32-representable integers.)
      const u16Tmp = allocLocal(fctx, `__fcc_u16_${fctx.locals.length}`, { kind: "f64" });
      buf.push({ op: "f64.trunc" });
      buf.push({ op: "local.tee", index: u16Tmp });
      buf.push({ op: "local.get", index: u16Tmp });
      buf.push({ op: "f64.const", value: 65536 });
      buf.push({ op: "f64.div" });
      buf.push({ op: "f64.floor" });
      buf.push({ op: "f64.const", value: 65536 });
      buf.push({ op: "f64.mul" });
      buf.push({ op: "f64.sub" });
      buf.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
  }
  buf.push({ op: "call", funcIdx: helperIdx });
}

/**
 * Lower a SPREAD-containing `fromCharCode` / `fromCodePoint` argument list.
 *
 * Returns the result type on success, or `undefined` when this call must keep
 * the static per-node loop — no spread, no expansion substrate on this target,
 * or a positional argument whose static type makes the call a #5152 TypeError
 * throw (kept on the loop so its emission order is untouched). Nothing is
 * emitted in any of those cases.
 *
 * `helperName` re-resolves the 1-char-string helper's funcidx: expanding a
 * spread registers late imports, which shifts every defined-function index
 * captured before them. The representation is built after the same point, for
 * the same reason (`concat` / `__str_concat`).
 */
export function tryEmitFromCharCodeSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  opts: { native: boolean; helperName: string; isFromCodePoint?: boolean },
): ValType | undefined {
  const { native, helperName, isFromCodePoint } = opts;
  if (!hasSpreadArgument(expr.arguments)) return undefined;
  // (#5152) §22.1.2.1/§22.1.2.2 step 2a apply ToNumber to every argument, and
  // §7.1.4 ToNumber(Symbol) throws. That throw is emitted per argument by the
  // static loop; probing into a DISCARDED buffer decides the question without
  // emitting, so such a call stays on the loop exactly as it is today.
  if (noJsHost(ctx) && positionalArgThrowsOnToNumber(ctx, fctx, expr.arguments)) return undefined;
  const codeType: ValType = { kind: "f64" };
  if (!canBuildSpreadArgList(ctx, fctx, codeType)) return undefined;

  const built = buildSpreadArgList(ctx, fctx, expr.arguments, 0, codeType, isFromCodePoint === true ? "fcp" : "fcc");
  if (!built) return undefined;

  // Both of these capture funcidxs, so they must be re-read AFTER the builder's
  // late-import flush, not before it.
  const repr = native ? nativeStringRepr(ctx) : hostStringRepr(ctx);
  const helperIdx = native ? ctx.nativeStrHelpers.get(helperName) : ctx.funcMap.get(helperName);
  if (repr === undefined || helperIdx === undefined) return undefined;

  const accLocal = allocLocal(fctx, `__fcc_acc_${fctx.locals.length}`, repr.resultType);
  const partLocal = allocLocal(fctx, `__fcc_part_${fctx.locals.length}`, repr.resultType);
  // Zero elements → "" (§22.1.2.1 step 1: an empty codeUnits list).
  fctx.body.push(...repr.literal(""));
  fctx.body.push({ op: "local.set", index: accLocal });

  const post: Instr[] = [];
  emitCodeUnitPart(ctx, fctx, post, codeType, { native, helperIdx, isFromCodePoint });
  post.push({ op: "local.set", index: partLocal });
  post.push(...repr.concat([{ op: "local.get", index: accLocal }], [{ op: "local.get", index: partLocal }]), {
    op: "local.set",
    index: accLocal,
  });
  built.emitStores({ pre: [], post });

  fctx.body.push({ op: "local.get", index: accLocal });
  return repr.resultType;
}

/**
 * Whether any NON-spread argument is statically a BigInt or Symbol, i.e. whether
 * the static loop would replace this call with a #5152 TypeError throw.
 *
 * Decided by running the emitter into a throwaway buffer: it answers `false`
 * before emitting anything, so the probe costs nothing for ordinary arguments
 * and the real throw is emitted later by the loop we hand the call back to.
 */
function positionalArgThrowsOnToNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): boolean {
  const discarded: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = discarded;
  try {
    for (const arg of args) {
      if (ts.isSpreadElement(arg)) continue;
      if (tryThrowOnBigIntOrSymbolArg(ctx, fctx, arg)) return true;
    }
  } finally {
    fctx.body = savedBody;
  }
  return false;
}
