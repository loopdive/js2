// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6997) Loose equality between two OBJECT operands is identity.
 *
 * §7.2.15 IsLooselyEqual step 1: when `Type(x)` is `Type(y)`, return
 * IsStrictlyEqual(x, y). Two Objects therefore compare by identity — the
 * ToPrimitive of steps 10-11 is reached only when exactly ONE side is an
 * Object. The typed dispatch used to send every struct-ref pair under `==`/`!=`
 * through the numeric ToPrimitive→f64 arm, so `c == c` was `false` (NaN ≠ NaN)
 * and two distinct `{ valueOf() { return 1 } }` compared `true`.
 *
 * `identityEqualityFlags` answers "should this `==`/`!=` be lowered as
 * `===`/`!==`?" for the typed dispatch. It says yes only when
 * the pair is provably Object-vs-Object (or nullish): both operands are Wasm
 * references, both static types are object types (a union may also carry
 * `null`/`undefined`, which identity handles — `null == null` is `true`, and a
 * nullish ref against a live object is `false`, exactly as steps 2-3 + 1 say).
 * Pairs the strict ref arm would compare by anything other than identity stay
 * on their existing lowering: a native-string ref (content equality), and a
 * `$AnyValue` box paired with a non-box (the box needs tag dispatch).
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

const OBJECT_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive;
const NULLISH_FLAGS = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

/** Every constituent is an object type or nullish, and at least one is an object. */
function isObjectOrNullishType(t: ts.Type): boolean {
  const parts = t.isUnion() ? t.types : [t];
  let sawObject = false;
  for (const p of parts) {
    if ((p.flags & OBJECT_FLAGS) !== 0) sawObject = true;
    else if ((p.flags & NULLISH_FLAGS) === 0) return false;
  }
  return sawObject;
}

function refTypeIdx(t: ValType): number | undefined {
  return t.kind === "ref" || t.kind === "ref_null" ? t.typeIdx : undefined;
}

/**
 * `[isStrictEq, isStrictNeq]` for the typed dispatch's identity arm: `===` /
 * `!==` themselves, plus a loose `==` / `!=` that compares two Object operands
 * (identity, §7.2.15 step 1). Every other operator answers `[false, false]`.
 */
export function identityEqualityFlags(
  ctx: CodegenContext,
  op: ts.SyntaxKind,
  leftType: ValType,
  rightType: ValType,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): [boolean, boolean] {
  if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return [true, false];
  if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return [false, true];
  const isLoose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isLoose || !isObjectPair(ctx, leftType, rightType, leftTsType, rightTsType)) return [false, false];
  return op === ts.SyntaxKind.EqualsEqualsToken ? [true, false] : [false, true];
}

function isObjectPair(ctx: CodegenContext, leftType: ValType, rightType: ValType, lTs: ts.Type, rTs: ts.Type): boolean {
  const l = refTypeIdx(leftType);
  const r = refTypeIdx(rightType);
  if (l === undefined || r === undefined) return false;
  const isString = (idx: number): boolean => idx === ctx.anyStrTypeIdx || idx === ctx.nativeStrTypeIdx;
  if (isString(l) || isString(r)) return false;
  const anyValue = ctx.anyValueTypeIdx;
  if (anyValue >= 0 && (l === anyValue) !== (r === anyValue)) return false;
  return isObjectOrNullishType(lTs) && isObjectOrNullishType(rTs);
}
