// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Property get/set lowering for ES5 Function poison accessors. */

import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { emitUndefined } from "./expressions/late-imports.js";
import {
  ensureCallerStrictSnapshot,
  isCurrentSourceFunctionValue,
  sourceFunctionForValue,
} from "./function-poison-pill.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { compileExpression, skipTransparentExpressions } from "./shared.js";

type MemberExpression = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function poisonMember(
  expression: MemberExpression,
): { receiver: ts.Expression; name: string; computedKey?: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isPrivateIdentifier(expression.name)) return undefined;
    return { receiver: expression.expression, name: expression.name.text };
  }
  const key = skipTransparentExpressions(expression.argumentExpression);
  if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return undefined;
  return {
    receiver: expression.expression,
    name: key.text,
    computedKey: expression.argumentExpression,
  };
}

/** Compile a statically-proven poison get, or decline with `undefined`. */
export function tryCompileFunctionPoisonRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: MemberExpression,
): ValType | undefined {
  const member = poisonMember(expression);
  if (!member || (member.name !== "caller" && member.name !== "arguments")) return undefined;

  const sourceFunction = sourceFunctionForValue(ctx, member.receiver);
  const strictFunction =
    sourceFunction !== undefined && isStrictFunction(sourceFunction, ctx.inferModuleStrictArguments);
  const currentSloppyCallerRead =
    member.name === "caller" && !strictFunction && isCurrentSourceFunctionValue(ctx, fctx, member.receiver);
  if (!strictFunction && !currentSloppyCallerRead) return undefined;

  const receiverType = compileExpression(ctx, fctx, member.receiver);
  if (receiverType) fctx.body.push({ op: "drop" });
  if (member.computedKey) {
    const keyType = compileExpression(ctx, fctx, member.computedKey);
    if (keyType) fctx.body.push({ op: "drop" });
  }

  if (strictFunction) {
    emitThrowTypeError(ctx, fctx, `Access to strict function '${member.name}' is forbidden`);
    return { kind: "externref" };
  }

  const callerStrictLocalIdx = ensureCallerStrictSnapshot(ctx, fctx);
  emitUndefined(ctx, fctx);
  const undefinedLocal = allocLocal(fctx, `__fn_${member.name}_undefined_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefinedLocal });
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "Access to a strict function caller is forbidden", {
    flush: fctx,
  });
  fctx.body.push(
    { op: "local.get", index: callerStrictLocalIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: throwInstrs,
      else: [{ op: "local.get", index: undefinedLocal }],
    },
  );
  return { kind: "externref" };
}

/** Compile a statically-proven strict-function poison set, or decline. */
export function tryCompileStrictFunctionPoisonAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: MemberExpression,
  value: ts.Expression,
): ValType | undefined {
  const member = poisonMember(target);
  if (!member || (member.name !== "caller" && member.name !== "arguments")) return undefined;
  const sourceFunction = sourceFunctionForValue(ctx, member.receiver);
  if (!sourceFunction || !isStrictFunction(sourceFunction, ctx.inferModuleStrictArguments)) {
    return undefined;
  }

  const receiverType = compileExpression(ctx, fctx, member.receiver);
  if (receiverType) fctx.body.push({ op: "drop" });
  if (member.computedKey) {
    const keyType = compileExpression(ctx, fctx, member.computedKey);
    if (keyType) fctx.body.push({ op: "drop" });
  }
  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType) fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, `Assignment to strict function '${member.name}' is forbidden`);
  return rhsType ?? { kind: "externref" };
}
