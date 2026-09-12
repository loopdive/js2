// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Initialize generator function values without changing their callable identity. */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeDelegatedResultHelpers } from "./generators-delegation-runtime.js";
import { NATIVE_GENERATOR_FACTORY_PROTO } from "./generators-native-protocol.js";

export function initializeNativeGeneratorFunctionValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  declaration: ts.Node | undefined,
  type: ValType,
): ValType {
  if (
    !(ctx.standalone || ctx.wasi) ||
    !declaration ||
    !(ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) ||
    !declaration.asteriskToken ||
    declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return type;
  ensureNativeDelegatedResultHelpers(ctx);
  const value = allocLocal(fctx, "__generator_function_value", type);
  fctx.body.push({ op: "local.set", index: value }, { op: "local.get", index: value });
  if (type.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get(NATIVE_GENERATOR_FACTORY_PROTO)! },
    { op: "drop" },
    { op: "local.get", index: value },
  );
  return type;
}
