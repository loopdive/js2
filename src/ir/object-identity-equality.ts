// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irDynamic, type IrValueId } from "./nodes.js";
import { coerceIrValueToExternref } from "./value-coercion.js";

/** Two source objects compare by identity for both strict and abstract equality. */
export function tryEmitObjectIdentityEquality(
  builder: IrFunctionBuilder,
  operator: string | undefined,
  left: IrValueId,
  right: IrValueId,
): IrValueId | null {
  if (operator !== "===" && operator !== "!==" && operator !== "==" && operator !== "!=") return null;
  if (builder.typeOf(left).kind !== "object" || builder.typeOf(right).kind !== "object") return null;
  // Erase only the physical shape, never materialize fields or run ToPrimitive.
  // Canonical boxing classifies the actual carrier, including a nullable ABI
  // value; a source annotation alone must not stamp an Object runtime tag.
  const lhs = builder.emitBox(coerceIrValueToExternref(builder, left), irDynamic());
  const rhs = builder.emitBox(coerceIrValueToExternref(builder, right), irDynamic());
  return builder.emitDynEq(lhs, rhs, { loose: false, negate: operator === "!==" || operator === "!=" });
}
