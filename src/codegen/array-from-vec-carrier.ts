// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6422) Carrier admission for the `Array.from` array-copy fast path.
 *
 * That arm picks its `$Vec` from the CHECKER type (`resolveArrayInfo`), then
 * `local.set`s the compiled argument into a `ref null $Vec` local. A declared
 * or inferred `Uint8Array` resolves to a `$Vec` — but two real carriers behind
 * that same static type are NOT one:
 *
 *  * the shared-backing `$__ta_view` struct that `new Uint8Array(<ArrayBuffer>)`
 *    builds (#3054), in both lanes; and
 *  * a genuine host `Uint8Array` (EXTERNREF) — in the JS-host lane
 *    `hostTaBufferArgSymName` answers `"dynamic"` for an untyped buffer
 *    argument, so `emitHostTaBufferConstruct` constructs the real thing through
 *    `__construct_closure`.
 *
 * Storing either into that local is a validation mismatch, and
 * `repairStructTypeMismatches` silently repairs it with
 * `any.convert_extern; ref.cast_null $Vec` — a cast that TRAPS with
 * "illegal cast" at runtime for both, taking the whole module down.
 *
 * This module answers the one question the arm has to ask after it has
 * speculatively compiled its argument: does this value belong in that `$Vec`
 * local? A `$__ta_view` is admitted by DE-VIEWING it first (#3054 B1's
 * `emitTaViewToVec`, the same materialization the TypedArray prototype methods
 * take), which keeps the fast path AND the element values. Anything else is
 * refused, and the caller rolls the probe back into the native/host
 * `Array.from` fallback rather than widening the cast.
 */
import type { FunctionContext, CodegenContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { emitTaViewToVec, taViewDecode } from "./dataview-native.js";

/**
 * Decide whether the just-compiled `Array.from` source (`srcType`, its value on
 * the stack) may be consumed as `vecTypeIdx`, materializing it when that takes
 * a de-view. Returns `true` only when the stack top is now exactly that vec.
 *
 * Emits nothing — and so is safe to call inside a speculative probe the caller
 * may still roll back — unless it returns `true` for a `$__ta_view`.
 */
export function admitArrayFromVecCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  srcType: InnerResult,
  vecTypeIdx: number,
): boolean {
  if (!srcType || typeof srcType === "symbol") return false;
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return false;
  if (srcType.typeIdx === vecTypeIdx) return true;
  if (taViewDecode(ctx, srcType.typeIdx) === undefined) return false;
  emitTaViewToVec(ctx, fctx, srcType.typeIdx, vecTypeIdx);
  return true;
}
