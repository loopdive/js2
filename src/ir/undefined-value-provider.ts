// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { canonicalUndefinedExternInstrs, ensureAnyValueType } from "../codegen/any-helpers.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../codegen/func-space.js";
import { addFuncType } from "../codegen/registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "../codegen/shared.js";

export const IR_UNDEFINED_VALUE_FN = "__ir_undefined_value";

/** Reserve a canonical undefined producer before any IR function body is lowered. */
export function ensureIrUndefinedValueProvider(ctx: CodegenContext): void {
  if (ctx.funcMap.has(IR_UNDEFINED_VALUE_FN)) return;
  if (ctx.standalone || ctx.nativeStrings) {
    ensureAnyValueType(ctx);
    if (ctx.undefinedGlobalIdx === undefined) throw new Error("IR undefined provider requires its native singleton");
  } else {
    ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, null);
  }
  const body = canonicalUndefinedExternInstrs(ctx);
  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
  const index = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, index, { name: IR_UNDEFINED_VALUE_FN, typeIdx, locals: [], body, exported: false });
  ctx.funcMap.set(IR_UNDEFINED_VALUE_FN, index);
}
