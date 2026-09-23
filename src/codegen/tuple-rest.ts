// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { emitLocalTdzInit } from "./statements/tdz.js";
import { coerceArrayRestType, coerceType, getVecInfo } from "./type-coercion.js";
import { compileExpression, emitNestedBindingDefault, valTypesMatch } from "./shared.js";

/**
 * (#6651 C4) A non-rest element PAST the end of a tuple struct. The tuple's
 * width is the checker's view of one value (a `{ w: [7, 8] }` parameter default
 * types `w` as `[number, number]`), not a bound on the pattern: §8.6.3
 * IteratorBindingInitialization reads `undefined` for every element after the
 * source is exhausted, then applies that element's own default. The loop in
 * `destructureParamArray` used to `break` here, so `[a, b, c]` left `c` at its
 * zero-initialised local — a null externref, which is JS `null` under the
 * standalone value model — and never ran `c`'s default. `destructureNested`
 * is the caller's recursion for a nested pattern held in an externref local.
 */
export function emitExhaustedTupleElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  element: ts.BindingElement,
  isDecl: boolean,
  destructureNested: (tmpLocal: number, pattern: ts.BindingPattern) => void,
): void {
  const ext: ValType = { kind: "externref" };
  if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
    const tmp = allocLocal(fctx, `__dparam_exh_${fctx.locals.length}`, ext);
    fctx.body.push(...canonicalUndefinedExternInstrs(ctx), { op: "local.set", index: tmp });
    if (element.initializer) emitNestedBindingDefault(ctx, fctx, tmp, ext, element.initializer);
    destructureNested(tmp, element.name);
    return;
  }
  if (!ts.isIdentifier(element.name)) return;
  const localIdx = fctx.localMap.get(element.name.text);
  if (localIdx === undefined) return;
  const localType = getLocalType(fctx, localIdx) ?? ext;
  if (element.initializer) compileExpression(ctx, fctx, element.initializer, localType);
  else {
    fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
    coerceType(ctx, fctx, ext, localType);
  }
  fctx.body.push({ op: "local.set", index: localIdx });
  if (isDecl) emitLocalTdzInit(fctx, element.name.text);
}

export function coerceTupleBindingElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  element: ts.ArrayBindingElement,
  from: ValType,
  to: ValType | undefined,
): void {
  if (!to || valTypesMatch(from, to)) return;
  if (ts.isBindingElement(element) && element.dotDotDotToken) coerceArrayRestType(ctx, fctx, from, to);
  // (#6651 C4) An f64 tuple FIELD is a stored slot that carries the
  // `UNDEF_F64_BITS` sentinel for an `undefined` element (`{ w: [7, undefined] }`
  // lowers `w` to an `(f64, f64)` tuple). Boxing it into a dynamic binding must
  // recover `undefined`, as the vec lane's destructure read-back already does
  // (#3315 keeps the generic box sentinel-blind; slot reads are the sanctioned
  // decode sites). The `with-default` twin of this is #2574's raw-field check.
  else if (from.kind === "f64" && to.kind === "externref")
    coerceType(ctx, fctx, { kind: "f64", undefSentinel: true }, to);
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
