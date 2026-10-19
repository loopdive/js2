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
import { type CodegenContext, type FunctionContext, wasmGcBackend } from "../context/types.js";
import { buildVecFromExternMaterializer, getVecInfo, vecFromExternFuncIdx } from "../type-coercion.js";
import { addUnionImports } from "../registry/imports.js";
import { flushLateImportShifts } from "./late-imports.js";

function nativeVecTarget(ctx: CodegenContext, to: ValType | null): number | undefined {
  if (!wasmGcBackend(ctx) || to === null || to.kind !== "ref_null") return undefined;
  return getVecInfo(ctx, to.typeIdx) === null ? undefined : to.typeIdx;
}

/** Reserve the materializer for a no-host vec-typed dispatch result. Call before emitting the ladder. */
export function reserveDispatchVecResultMaterializer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expectedReturn: ValType | null,
): void {
  const vecTypeIdx = nativeVecTarget(ctx, expectedReturn);
  if (vecTypeIdx === undefined || vecFromExternFuncIdx(ctx, vecTypeIdx) !== undefined) return;
  if (buildVecFromExternMaterializer(ctx, vecTypeIdx) !== undefined) flushLateImportShifts(ctx, fctx);
}

/** `externref` arm result → expected vec, when the materializer was reserved. Read-only. */
export function dispatchVecResultBridge(ctx: CodegenContext, from: ValType, to: ValType): Instr[] | null {
  if (from.kind !== "externref") return null;
  const vecTypeIdx = nativeVecTarget(ctx, to);
  if (vecTypeIdx === undefined) return null;
  const funcIdx = vecFromExternFuncIdx(ctx, vecTypeIdx);
  return funcIdx === undefined ? null : [{ op: "call", funcIdx }];
}

/**
 * (#7025) Before a no-host ladder is built: register the number / boolean
 * boxers that `boxedScalarResultBridge` (dispatch-extern-result-bridge.ts)
 * needs when an externref call site dispatches to a scalar-returning
 * candidate. On these lanes `addUnionImports` defines native helpers (no host
 * import); it runs before any arm bakes an index, never inside one (#2174).
 * It lives here, not beside the bridge, so that leaf module stays out of the
 * codegen import cycle.
 */
export function reserveScalarResultBoxers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  candidates: readonly { readonly returnType: ValType | null }[],
  expectedReturn: ValType | null,
): void {
  if (!wasmGcBackend(ctx) || expectedReturn === null) return;
  if (expectedReturn.kind !== "externref" && expectedReturn.kind !== "ref_extern") return;
  if (!candidates.some(({ returnType }) => returnType?.kind === "f64" || returnType?.kind === "i32")) return;
  addUnionImports(ctx);
  flushLateImportShifts(ctx, fctx);
}
