// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6704) A callable-property dispatch arm whose callee returns `externref`
 * while the call site expects an array (a `__vec_*` carrier), under
 * `--target standalone` / `wasi`.
 *
 * #6684's guarded downcast (`dispatch-extern-result-bridge.ts`) keeps the
 * value only when it already IS the expected vec type; any other array
 * carrier — lodash-es `words` returns `string.match(re) || []`, a match array
 * — answers null, and the caller's `.length` traps ("dereferencing a null
 * pointer", the npm-compat checksum). A direct call to the same function
 * converts that value with the vec materializer instead.
 *
 * The arm now calls the same shared, per-vec-type materializer
 * `__vec_from_extern_<T>` (`buildVecFromExternMaterializer`): null/undefined →
 * null, the exact vec → identity cast, any other array-like → a fresh vec of
 * the expected type. It is a plain `call` of a defined function resolved by
 * name, so the arm stays import-free (#2174); the materializer itself is
 * reserved at the call site, before the ladder is emitted, with the caller's
 * body flushed against any index shift that reservation causes.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { buildVecFromExternMaterializer, getVecInfo, vecFromExternFuncIdx } from "../type-coercion.js";
import { flushLateImportShifts } from "./late-imports.js";

function noHostVecTarget(ctx: CodegenContext, to: ValType | null): number | undefined {
  if (!(ctx.standalone || ctx.wasi) || to === null || to.kind !== "ref_null") return undefined;
  return getVecInfo(ctx, to.typeIdx) === null ? undefined : to.typeIdx;
}

/** Reserve the materializer for a no-host vec-typed dispatch result. Call before emitting the ladder. */
export function reserveDispatchVecResultMaterializer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expectedReturn: ValType | null,
): void {
  const vecTypeIdx = noHostVecTarget(ctx, expectedReturn);
  if (vecTypeIdx === undefined || vecFromExternFuncIdx(ctx, vecTypeIdx) !== undefined) return;
  if (buildVecFromExternMaterializer(ctx, vecTypeIdx) !== undefined) flushLateImportShifts(ctx, fctx);
}

/** `externref` arm result → expected vec, when the materializer was reserved. Read-only. */
export function dispatchVecResultBridge(ctx: CodegenContext, from: ValType, to: ValType): Instr[] | null {
  if (from.kind !== "externref") return null;
  const vecTypeIdx = noHostVecTarget(ctx, to);
  if (vecTypeIdx === undefined) return null;
  const funcIdx = vecFromExternFuncIdx(ctx, vecTypeIdx);
  return funcIdx === undefined ? null : [{ op: "call", funcIdx }];
}
