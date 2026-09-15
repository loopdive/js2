// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

/** Resolved generic signatures still need the source declaration's rest marker. */
export function registerResolvedRestParameter(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  name: string,
  params: readonly ValType[],
): void {
  const restIndex = declaration.parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined);
  if (restIndex < 0) return;
  const param = params[restIndex];
  if (!param || (param.kind !== "ref" && param.kind !== "ref_null")) return;
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, param.typeIdx);
  const array = ctx.mod.types[arrayTypeIdx];
  if (!array || array.kind !== "array") return;
  ctx.funcRestParams.set(name, {
    restIndex,
    elemType: array.element,
    arrayTypeIdx,
    vecTypeIdx: param.typeIdx,
  });
}
