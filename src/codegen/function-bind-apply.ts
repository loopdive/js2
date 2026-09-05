// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Standalone lowering for the ES5 `Function.prototype.bind.apply` spelling. */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureObjVecBuilders, reserveBindDynHelper } from "./object-runtime.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { noJsHost } from "./expressions/helpers.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression } from "./shared.js";

/**
 * Compile `Function.prototype.bind.apply(target, argArray)`. The argument
 * array is preserved as a runtime `$ObjVec`, including the static-literal
 * spelling used by the ES5 rows. Extra arguments are evaluated for effects,
 * as required by the ordinary `apply` call semantics.
 */
export function tryCompileIndirectFunctionBindApplyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (
    propAccess.name.text !== "apply" ||
    !ts.isPropertyAccessExpression(propAccess.expression) ||
    propAccess.expression.name.text !== "bind" ||
    !ts.isPropertyAccessExpression(propAccess.expression.expression) ||
    propAccess.expression.expression.name.text !== "prototype" ||
    !ts.isIdentifier(propAccess.expression.expression.expression) ||
    propAccess.expression.expression.expression.text !== "Function" ||
    expr.arguments.length < 1 ||
    !(noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first")
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  const targetType = compileExpression(ctx, fctx, expr.arguments[0]!, externref);
  if (targetType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (targetType.kind !== "externref") {
    coerceType(ctx, fctx, targetType, externref);
  }
  const targetLocal = allocLocal(fctx, `__bind_apply_target_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: targetLocal });

  const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
  const argsLocal = allocLocal(fctx, `__bind_apply_args_${fctx.locals.length}`, externref);
  if (expr.arguments.length >= 2) {
    const argArray = expr.arguments[1]!;
    if (ts.isArrayLiteralExpression(argArray) && !argArray.elements.some((el) => ts.isSpreadElement(el))) {
      fctx.body.push({ op: "call", funcIdx: vecNewIdx }, { op: "local.set", index: argsLocal });
      for (const element of argArray.elements) {
        if (ts.isOmittedExpression(element)) {
          fctx.body.push(...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]));
        } else {
          const elementType = compileExpression(ctx, fctx, element, externref);
          if (elementType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (elementType.kind !== "externref") {
            coerceType(ctx, fctx, elementType, externref);
          }
        }
        const elementLocal = allocLocal(fctx, `__bind_apply_element_${fctx.locals.length}`, externref);
        fctx.body.push(
          { op: "local.set", index: elementLocal },
          { op: "local.get", index: argsLocal },
          { op: "local.get", index: elementLocal },
          { op: "call", funcIdx: vecPushIdx },
        );
      }
    } else {
      const argsType = compileExpression(ctx, fctx, argArray);
      if (argsType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (argsType.kind !== "externref") {
        coerceType(ctx, fctx, argsType, externref);
      }
      fctx.body.push({ op: "local.set", index: argsLocal });
    }
  } else {
    fctx.body.push({ op: "call", funcIdx: vecNewIdx }, { op: "local.set", index: argsLocal });
  }

  for (let i = 2; i < expr.arguments.length; i++) {
    const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, undefined);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }

  const bindDynIdx = reserveBindDynHelper(ctx);
  fctx.body.push(
    { op: "local.get", index: targetLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: bindDynIdx },
  );
  return externref;
}
