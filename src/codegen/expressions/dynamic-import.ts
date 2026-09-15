// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addFuncType } from "../registry/types.js";
import { addImport } from "../registry/physical-imports.js";
import { compileExpression, coerceType } from "../shared.js";
import { shiftLateImportIndices } from "./late-imports.js";

/** Evaluate a host import expression and emit its current ABI call. */
export function compileHostDynamicImport(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): ValType {
  // Ensure __dynamic_import is registered
  let dynIdx = ctx.funcMap.get("__dynamic_import");
  if (dynIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const dynType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__dynamic_import", { kind: "func", typeIdx: dynType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    dynIdx = ctx.funcMap.get("__dynamic_import");
  }
  if (dynIdx === undefined) {
    throw new Error("Missing __dynamic_import after registration");
  }
  // Compile the specifier argument
  const specArg = expr.arguments[0];
  if (specArg) {
    const specResult = compileExpression(ctx, fctx, specArg);
    // Coerce to externref if needed
    if (specResult && specResult.kind !== "externref") {
      coerceType(ctx, fctx, specResult, { kind: "externref" });
    }
  } else {
    // No argument — pass undefined (null externref)
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Evaluate remaining arguments (e.g. import attributes/options) for side effects.
  // Per spec, the second argument (optionsExpression) is evaluated before the
  // host import is performed. If it throws, the throw propagates synchronously.
  // We evaluate and drop the result since __dynamic_import only takes the specifier.
  for (let ai = 1; ai < expr.arguments.length; ai++) {
    const extraArg = expr.arguments[ai];
    const extraResult = compileExpression(ctx, fctx, extraArg);
    // Drop the value from the stack if the expression produced one
    if (extraResult) {
      fctx.body.push({ op: "drop" });
    }
  }

  const currentDynamicImportIdx = ctx.funcMap.get("__dynamic_import");
  if (currentDynamicImportIdx === undefined) throw new Error("Missing __dynamic_import after argument compilation");
  fctx.body.push({ op: "call", funcIdx: currentDynamicImportIdx });
  return { kind: "externref" };
}
