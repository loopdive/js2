// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../wasm/model/instructions.js";
import type { CodegenContext } from "../context/types.js";
import { addFuncType } from "../registry/types.js";
import { emitWasmInt32Coercion } from "../../backend/wasmgc/lowering/wasm-int32-coercion.js";

/** Reuse the canonical low-32-bit conversion after direct imports have been collected. */
export function ensureToUint32Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__toUint32");
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__toUint32", funcIdx);
  const body: Instr[] = [{ op: "local.get", index: 0 }];
  emitWasmInt32Coercion(body, { bits: 1, exponent: 2, significand: 3, magnitude: 4 });
  ctx.mod.functions.push({
    name: "__toUint32",
    typeIdx,
    locals: [
      { name: "$to_uint32_bits", type: { kind: "i64" } },
      { name: "$to_uint32_exponent", type: { kind: "i64" } },
      { name: "$to_uint32_significand", type: { kind: "i64" } },
      { name: "$to_uint32_magnitude", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
