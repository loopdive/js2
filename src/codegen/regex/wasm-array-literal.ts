// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Materialize standalone RegExp bytecode/class-table constants as WasmGC i32
 * arrays. Large Unicode string properties can produce programs beyond V8's
 * 10,000-operand `array.new_fixed` limit, so those are assembled from bounded
 * fixed chunks into one destination array.
 */
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { i32ArrayLiteralInstrs, regexI32ArrayType } from "../native-regex.js";

const FIXED_CHUNK = 8192;

/** Leave one non-null i32 array on the operand stack. */
export function pushRegexI32Array(
  ctx: CodegenContext,
  fctx: FunctionContext,
  values: number[],
  label: "prog" | "class_table",
): void {
  if (values.length <= FIXED_CHUNK) {
    fctx.body.push(...i32ArrayLiteralInstrs(ctx, values));
    return;
  }
  const i32Arr = regexI32ArrayType(ctx);
  const arrayLocal = allocLocal(fctx, `__regex_${label}_${fctx.locals.length}`, { kind: "ref", typeIdx: i32Arr });
  fctx.body.push({ op: "i32.const", value: values.length });
  fctx.body.push({ op: "array.new_default", typeIdx: i32Arr });
  fctx.body.push({ op: "local.set", index: arrayLocal });
  for (let offset = 0; offset < values.length; offset += FIXED_CHUNK) {
    const chunk = values.slice(offset, offset + FIXED_CHUNK);
    fctx.body.push({ op: "local.get", index: arrayLocal });
    fctx.body.push({ op: "i32.const", value: offset });
    for (const value of chunk) fctx.body.push({ op: "i32.const", value: value | 0 });
    fctx.body.push({ op: "array.new_fixed", typeIdx: i32Arr, length: chunk.length });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: chunk.length });
    fctx.body.push({ op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr });
  }
  fctx.body.push({ op: "local.get", index: arrayLocal });
}
