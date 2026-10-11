// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) A generic function's signature comes from call-site resolution
// (`resolveGenericDeclarationCallSiteTypes`), which lowers a rest parameter to
// its vec type but skipped the `funcRestParams` entry the non-generic path
// records. Call sites then took a spread argument for POSITIONAL expansion:
// `addRelatedInfo(diag, ...relatedInformation)` — TypeScript's binder — passed
// the array's first element where the whole rest vec belonged. Record the rest
// info from the resolved vec so call sites pack and pass it like any other.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getVecInfo } from "./type-coercion.js";
import { getOrRegisterVecType } from "./registry/types.js";

export function registerResolvedRestParam(
  ctx: CodegenContext,
  name: string,
  stmt: ts.SignatureDeclarationBase,
  params: readonly ValType[],
): void {
  const restIndex = stmt.parameters.findIndex((param) => param.dotDotDotToken !== undefined);
  if (restIndex < 0 || ctx.funcRestParams.has(name)) return;
  const restType = params[restIndex];
  if (restType === undefined || (restType.kind !== "ref" && restType.kind !== "ref_null")) return;
  const vecInfo = getVecInfo(ctx, restType.typeIdx);
  if (!vecInfo) return;
  ctx.funcRestParams.set(name, {
    restIndex,
    elemType: vecInfo.elemType,
    arrayTypeIdx: vecInfo.arrTypeIdx,
    vecTypeIdx: restType.typeIdx,
  });
}

/**
 * (#6774 S7) A generator's rest parameter whose target is a BINDING PATTERN
 * (`function* g(...[a]) {}`): `lowerParamType` lowers it to the pattern's tuple
 * shape, so the call site never packs the extras and the prologue destructures
 * a null carrier. Lower it to the rest vec the plain-function path uses.
 */
export function restPatternParamVecType(
  ctx: CodegenContext,
  param: ts.ParameterDeclaration,
  vecOf: (elemType: ValType) => number,
): ValType | undefined {
  if (!ctx.standalone || param.dotDotDotToken === undefined || ts.isIdentifier(param.name)) return undefined;
  return { kind: "ref_null", typeIdx: vecOf({ kind: "externref" }) };
}

/** `restPatternParamVecType` over the shared externref vec, else `slot` unchanged. */
export function restPatternParamSlot(ctx: CodegenContext, param: ts.ParameterDeclaration, slot: ValType): ValType {
  return restPatternParamVecType(ctx, param, (t) => getOrRegisterVecType(ctx, "externref", t)) ?? slot;
}
