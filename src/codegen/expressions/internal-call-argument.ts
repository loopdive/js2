// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getArrTypeIdxFromVec } from "../registry/types.js";
import { compileObjectLiteralAsExternref, resolvePropertyNameText } from "../literals.js";
import {
  canCompilePropertyAccessForNullishObservation,
  compilePropertyAccessForNullishObservation,
} from "../property-access.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";

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
  // tuple fast path. Force the ordinary array carrier only for the explicitly
  // opted-in class-method call sites; this keeps present null distinct from an
  // absent element without widening unrelated argument lowering.
  const compileWithArrayLiteralVec = (): ValType | null => {
    const shouldForce =
      forceArrayLiteralVec &&
      expectedType?.kind === "externref" &&
      (ctx.standalone || ctx.wasi) &&
      ts.isArrayLiteralExpression(expression);
    const previous = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
    if (shouldForce) (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
    try {
      return compileExpression(ctx, fctx, expression, expectedType);
    } finally {
      if (shouldForce) (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = previous;
    }
  };
  // A native `externref` parameter is an open JavaScript-value boundary. A
  // plain object literal must therefore use the runtime `$Object` carrier,
  // even when TypeScript gives the literal a concrete contextual object type.
  // Boxing a closed Wasm struct as externref makes dynamic operations such as
  // a captured `Object.assign(target, source)` unable to enumerate the source.
  if (
    expectedType?.kind === "externref" &&
    (ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone || ctx.wasi) &&
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

  if (expectedType?.kind !== "externref" || ctx.standalone || ctx.wasi) {
    return compileWithArrayLiteralVec();
  }

  let carrier = expression;
  while (
    ts.isParenthesizedExpression(carrier) ||
    ts.isAsExpression(carrier) ||
    ts.isTypeAssertionExpression(carrier) ||
    ts.isNonNullExpression(carrier)
  ) {
    carrier = carrier.expression;
  }
  // An externref parameter deliberately preserves the full JavaScript value.
  // Compile a property argument through the boxed dynamic reader so a missing
  // numeric-looking field remains `undefined` instead of being narrowed to
  // f64 NaN and then re-boxed. This is the `v1(options) -> v1Bytes(...)`
  // nullish-default path in uuid (#4383).
  if (ts.isPropertyAccessExpression(carrier) && canCompilePropertyAccessForNullishObservation(ctx, fctx, carrier)) {
    return compilePropertyAccessForNullishObservation(ctx, fctx, carrier);
  }
  if (!ts.isIdentifier(carrier)) {
    return compileWithArrayLiteralVec();
  }

  const localIdx = fctx.localMap.get(carrier.text);
  const localType = localIdx === undefined ? undefined : getLocalType(fctx, localIdx);
  const isMaterializedArgumentsObject =
    carrier.text === "arguments" &&
    localIdx !== undefined &&
    localIdx >= fctx.params.length &&
    fctx.locals[localIdx - fctx.params.length]?.name === "arguments";
  if (
    isMaterializedArgumentsObject ||
    !localType ||
    (localType.kind !== "ref" && localType.kind !== "ref_null") ||
    getArrTypeIdxFromVec(ctx, localType.typeIdx) < 0
  ) {
    return compileWithArrayLiteralVec();
  }

  const actualType = compileWithArrayLiteralVec();
  if (
    actualType &&
    (actualType.kind === "ref" || actualType.kind === "ref_null") &&
    getArrTypeIdxFromVec(ctx, actualType.typeIdx) >= 0
  ) {
    fctx.body.push({ op: "extern.convert_any" });
    return expectedType;
  }
  if (actualType && !valTypesMatch(actualType, expectedType)) {
    coerceType(ctx, fctx, actualType, expectedType);
    return expectedType;
  }
  return actualType;
}
