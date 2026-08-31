// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Assignment defaults for named properties of array-like rest values. */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getLocalType } from "../context/locals.js";
import { localGlobalIdx } from "../registry/imports.js";
import { emitResolvedIdentifierWriteFromStack } from "../expressions/identifier-assignment.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";

/**
 * Handle a named key in an object assignment pattern applied to a rest vec.
 * Array-like rest values have no such own property, so a default initializer
 * is evaluated directly and written to its identifier target. Returns true for
 * every named key so the caller can skip the vec-index path.
 */
export function emitForOfRestObjectNamedDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  prop: ts.ObjectLiteralElementLike,
): boolean {
  let target: ts.Expression | undefined;
  let initializer: ts.Expression | undefined;
  if (ts.isShorthandPropertyAssignment(prop)) {
    target = prop.name;
    initializer = prop.objectAssignmentInitializer;
  } else if (ts.isPropertyAssignment(prop) && ts.isBinaryExpression(prop.initializer)) {
    if (prop.initializer.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return true;
    target = prop.initializer.left;
    initializer = prop.initializer.right;
  }
  const targetIdentifier = target;
  if (!initializer || !targetIdentifier || !ts.isIdentifier(targetIdentifier)) return true;

  const localIdx = fctx.localMap.get(targetIdentifier.text);
  const syncGlobalIdx = ctx.moduleGlobals.get(targetIdentifier.text);
  const globalIdx = localIdx === undefined ? syncGlobalIdx : undefined;
  if (localIdx === undefined && globalIdx === undefined) return true;
  const targetType =
    localIdx !== undefined ? getLocalType(fctx, localIdx) : ctx.mod.globals[localGlobalIdx(ctx, globalIdx!)]?.type;
  const initType = compileExpression(ctx, fctx, initializer, targetType ?? { kind: "externref" });
  if (initType) {
    emitResolvedIdentifierWriteFromStack(ctx, fctx, targetIdentifier, initType, localIdx, globalIdx);
    if (localIdx !== undefined && syncGlobalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
      const localType = getLocalType(fctx, localIdx);
      const globalType = ctx.mod.globals[localGlobalIdx(ctx, syncGlobalIdx)]?.type;
      if (localType && globalType && !valTypesMatch(localType, globalType))
        coerceType(ctx, fctx, localType, globalType);
      fctx.body.push({ op: "global.set", index: syncGlobalIdx });
    }
  }
  return true;
}
