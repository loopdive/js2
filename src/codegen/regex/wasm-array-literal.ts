// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Materialize standalone RegExp bytecode/class-table constants as WasmGC i32
 * arrays in a legacy function body, with a scratch local for the chunked form.
 */
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { regexI32ArrayType } from "../native-regex.js";
import { regExpI32ArrayInstrs } from "../../runtime/wasmgc/values/regexp-carrier-layouts.js";

/** Leave one non-null i32 array on the operand stack. */
export function pushRegexI32Array(
  ctx: CodegenContext,
  fctx: FunctionContext,
  values: number[],
  label: "prog" | "class_table",
): void {
  const i32Arr = regexI32ArrayType(ctx);
  fctx.body.push(
    ...regExpI32ArrayInstrs(i32Arr, values, () =>
      allocLocal(fctx, `__regex_${label}_${fctx.locals.length}`, { kind: "ref", typeIdx: i32Arr }),
    ),
  );
}
