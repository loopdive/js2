// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Preserve a function-constructor instance's prototype identity through
 * `Object(instance).constructor.prototype` in the standalone backend.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import { emitFnctorProtoGet } from "./expressions/fnctor-prototype.js";
import { objectCoercionObjectArgumentOf } from "./object-ctor-primitive-receiver.js";
import { resolveReceiverStruct } from "./fnctor-escape-gate.js";
import { compileExpression } from "./shared.js";

/**
 * Try the fnctor-specific `constructor.prototype` identity arm. The caller
 * supplies the module-wide constructor-mutation proof because its scanner is
 * owned by property-access.ts and must not be imported back into this helper.
 */
export function tryObjectCoercionFnctorPrototypeIdentity(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  moduleTouchesConstructor: boolean,
): ValType | undefined {
  if (
    !noJsHost(ctx) ||
    propName !== "prototype" ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== "constructor" ||
    moduleTouchesConstructor
  ) {
    return undefined;
  }

  const preservedArgument = objectCoercionObjectArgumentOf(ctx, expr.expression.expression);
  const preservedName = preservedArgument === undefined ? undefined : ctx.oracle.declaredNameOf(preservedArgument);
  const directStruct = resolveReceiverStruct(ctx, fctx, expr.expression.expression);
  const directName = directStruct?.startsWith("__fnctor_") ? directStruct.slice("__fnctor_".length) : undefined;
  const argumentName = directName ?? preservedName;
  const gate = argumentName === undefined ? undefined : ctx.fnctorEscapeGate;
  if (argumentName === undefined || gate?.ctorDeclByName.has(argumentName) !== true || ctx.classSet.has(argumentName)) {
    return undefined;
  }

  const receiverResult = compileExpression(ctx, fctx, expr.expression.expression);
  if (receiverResult) fctx.body.push({ op: "drop" });
  return emitFnctorProtoGet(ctx, fctx, argumentName) ? { kind: "externref" } : undefined;
}
