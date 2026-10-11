// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addUnionImports } from "./registry/imports.js";
import { coerceType } from "./shared.js";
import { emitStandaloneObjectToNumber } from "./tonumber-fast-paths.js";
import { emitHostArrayCarrierToNumber } from "./host-carrier-to-primitive.js";

/** Actual runtime carriers use their canonical numeric path, not a nominal default. */
export function tryRuntimeRefToNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  hint: "number" | "string" | "default" | undefined,
): boolean {
  if (typeIdx === ctx.objectRuntimeTypes?.objectTypeIdx) {
    if (ctx.standalone) return emitStandaloneObjectToNumber(ctx, fctx, hint ?? "number");
    // $Object has no nominal class name. Preserve the object and invoke the
    // existing ordered ToPrimitive/ToNumber path instead of dropping it for 0.
    fctx.body.push({ op: "extern.convert_any" });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, hint ?? "number");
    return true;
  }
  // (#6788) A JS-host array carrier reduces to its join, not through the host
  // struct walker, which answers "[object Object]" → NaN.
  if (emitHostArrayCarrierToNumber(ctx, fctx, typeIdx, hint)) return true;
  if (
    ctx.nativeStrings &&
    (typeIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && typeIdx === ctx.nativeStrTypeIdx))
  ) {
    let strToNumberIdx = ctx.funcMap.get("__str_to_number");
    if (strToNumberIdx === undefined) {
      addUnionImports(ctx);
      strToNumberIdx = ctx.funcMap.get("__str_to_number");
    }
    if (strToNumberIdx !== undefined) {
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: strToNumberIdx });
      return true;
    }
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      return true;
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: NaN });
    return true;
  }
  return false;
}
