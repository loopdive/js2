// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  planNativeStringLiteral,
  buildOversizedNativeStringLiteral,
  type NativeLiteralPlan,
  type StringEncoding,
} from "../runtime/wasmgc/values/string-literal-bodies.js";
export { nativeStringLiteralHash, type StringEncoding } from "../runtime/wasmgc/values/string-literal-bodies.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

export type NativeStringLiteralMaterialization =
  | { readonly kind: "global"; readonly globalIdx: number }
  | { readonly kind: "callable"; readonly funcIdx: number };

function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Select the exact native materialization once.
 *
 * Common literals retain the immutable interned-global path introduced for
 * Acorn. A literal beyond `array.new_fixed`'s validated limit uses one cached
 * rope-building helper assembled from interned, fixed-size chunks.
 */
export function nativeStringLiteralMaterialization(
  ctx: CodegenContext,
  value: string,
  encoding?: StringEncoding,
): NativeStringLiteralMaterialization {
  const plan = planNativeStringLiteral(ctx, ctx.utf8Storage, value, encoding);
  return plan.kind === "global"
    ? { kind: "global", globalIdx: internNativeStringLiteral(ctx, plan.key, plan.refTypeIdx, plan.init) }
    : { kind: "callable", funcIdx: ensureOversizedNativeStringLiteralHelper(ctx, plan) };
}

/** Emit one exact global read or materializer call for a native literal. */
export function nativeStringLiteralInstrs(ctx: CodegenContext, value: string, encoding?: StringEncoding): Instr[] {
  const materialization = nativeStringLiteralMaterialization(ctx, value, encoding);
  return materialization.kind === "global"
    ? [{ op: "global.get", index: materialization.globalIdx }]
    : [{ op: "call", funcIdx: materialization.funcIdx }];
}

/** Plan one immutable literal global and return its absolute global index. */
function internNativeStringLiteral(ctx: CodegenContext, key: string, refTypeIdx: number, init: Instr[]): number {
  const existing = ctx.nativeStrLiteralGlobals.get(key);
  if (existing !== undefined) return existing;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__strlit_${ctx.nativeStrLiteralGlobals.size}`,
    type: { kind: "ref", typeIdx: refTypeIdx },
    mutable: false,
    init,
  });
  ctx.nativeStrLiteralGlobals.set(key, globalIdx);
  return globalIdx;
}

/**
 * Build one zero-argument helper that returns the exact literal as a native
 * rope of i16 leaves. The native rope flattener consumes NativeString leaves,
 * so even a UTF-8-proven oversized literal deliberately uses this shared i16
 * representation. The helper avoids invalid oversized fixed-array operations.
 */
function ensureOversizedNativeStringLiteralHelper(
  ctx: CodegenContext,
  plan: Extract<NativeLiteralPlan, { kind: "callable" }>,
): number {
  const cacheKey = plan.key;
  const existing = ctx.nativeStrHelpers.get(cacheKey);
  if (existing !== undefined) return existing;
  if (ctx.anyStrTypeIdx < 0 || ctx.consStrTypeIdx < 0) {
    throw new Error("oversized native string literal requires the complete native-string type family");
  }

  const chunks = plan.chunks;
  if (chunks.length < 2) {
    throw new Error("oversized native string literal did not split into fixed-array-safe chunks");
  }
  const globals = chunks.map((chunk) => {
    const materialization = nativeStringLiteralMaterialization(ctx, chunk, "wtf16");
    if (materialization.kind !== "global") {
      throw new Error("oversized native string literal chunk exceeded the fixed-array limit");
    }
    return materialization.globalIdx;
  });

  const strRef = nativeStringType(ctx);
  const { body, locals } = buildOversizedNativeStringLiteral(ctx, chunks, globals);

  const helperOrdinal = ctx.nativeStrHelpers.size;
  const typeIdx = addFuncType(ctx, [], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: `__strlit_materialize_${helperOrdinal}`,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.nativeStrHelpers.set(cacheKey, funcIdx);
  return funcIdx;
}
