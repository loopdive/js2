// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileObjectLiteralAsExternref, resolvePropertyNameText } from "../literals.js";
import { compileExpression } from "../shared.js";

/**
 * Compile an argument for a call that stays inside the generated module.
 *
 * In JS-host mode, the general vec-to-externref coercion deliberately creates
 * a real JS Array mirror so native host APIs can iterate it. That is the wrong
 * boundary for a compiled-function call: an `any`-typed callee mutates the
 * mirror while the caller still owns the original WasmGC vec. Preserve the raw
 * vec identity for locally-typed array arguments so indexed writes and strict
 * identity remain visible across the internal call (#4383).
 */
export function compileInternalCallArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
  expectedType: ValType | undefined,
  forceArrayLiteralVec = false,
): ValType | null {
  // Class bodies are emitted before their call sites. When an unannotated class
  // method parameter is an externref binding pattern, a contextual tuple at the
  // call site can therefore be a type the callee never saw while building its
  // tuple fast path. Re-enter the established lowering under the narrow array
  // carrier override; the default path below stays exactly unchanged.
  if (forceArrayLiteralVec && expectedType?.kind === "externref" && ts.isArrayLiteralExpression(expression)) {
    const previous = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
    (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
    try {
      return compileInternalCallArgument(ctx, fctx, expression, expectedType, false);
    } finally {
      (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = previous;
    }
  }
  // A native `externref` parameter is an open JavaScript-value boundary. A
  // plain object literal must therefore use the runtime `$Object` carrier,
  // even when TypeScript gives the literal a concrete contextual object type.
  // Boxing a closed Wasm struct as externref makes dynamic operations such as
  // a captured `Object.assign(target, source)` unable to enumerate the source.
  if (
    expectedType?.kind === "externref" &&
    ts.isObjectLiteralExpression(expression) &&
    expression.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isSpreadAssignment(property),
    ) &&
    expression.properties.every(
      (property) => ts.isSpreadAssignment(property) || resolvePropertyNameText(ctx, property) !== undefined,
    )
  ) {
    const objectValue = compileObjectLiteralAsExternref(ctx, fctx, expression);
    if (objectValue !== null) return objectValue;
  }

  return compileExpression(ctx, fctx, expression, expectedType);
}
