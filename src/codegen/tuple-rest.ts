// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceArrayRestType, coerceType, getVecInfo } from "./type-coercion.js";
import { valTypesMatch } from "./shared.js";

export function coerceTupleBindingElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  element: ts.ArrayBindingElement,
  from: ValType,
  to: ValType | undefined,
): void {
  if (!to || valTypesMatch(from, to)) return;
  if (ts.isBindingElement(element) && element.dotDotDotToken) coerceArrayRestType(ctx, fctx, from, to);
  else coerceType(ctx, fctx, from, to);
}

/** Initialize a tuple-backed rest binding after the source iterator is exhausted. */
export function emitExhaustedTupleRest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  element: ts.ArrayBindingElement,
  exhausted: boolean,
): boolean {
  if (!exhausted) return false;
  if (!ts.isBindingElement(element) || !element.dotDotDotToken || !ts.isIdentifier(element.name)) return true;
  const localIdx = fctx.localMap.get(element.name.text);
  const localType = localIdx === undefined ? undefined : getLocalType(fctx, localIdx);
  if (localIdx === undefined || (localType?.kind !== "ref" && localType?.kind !== "ref_null")) return true;
  const restVecInfo = getVecInfo(ctx, localType.typeIdx);
  if (!restVecInfo) return true;
  const body: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: restVecInfo.arrTypeIdx },
    { op: "struct.new", typeIdx: localType.typeIdx },
    { op: "local.set", index: localIdx },
  ];
  fctx.body.push(...body);
  return true;
}
