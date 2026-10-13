// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrValueId } from "./core/nodes.js";
import type { IrType } from "./core/types.js";
import { IrUnsupportedError } from "./outcomes.js";
import {
  nativeVectorMutationIsProven,
  nativeVectorMutationOwnerIsSynchronous,
} from "./native-vector-mutation-proof.js";
export { nativeVectorMutationOwnerIsSynchronous } from "./native-vector-mutation-proof.js";

interface NativeMutationHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  readonly checker?: ts.TypeChecker;
  readonly scope: ReadonlyMap<
    string,
    { readonly kind: string; readonly slotIndex?: number; readonly i32Storage?: boolean }
  >;
  readonly nativeVectorMutationSlots?: ReadonlyMap<ts.Symbol, number>;
  readonly logicalVectorTypes?: ReadonlyMap<
    ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression,
    Extract<IrType, { kind: "vec" }>
  >;
}
const IR_F64: IrType = { kind: "val", val: { kind: "f64" } };
function asVal(type: IrType) {
  return type.kind === "val" ? type.val : undefined;
}

function lowerNativeVectorMutationIndex(lhs: ts.ElementAccessExpression, cx: NativeMutationHost): IrValueId {
  const binding = ts.isIdentifier(lhs.argumentExpression) ? cx.scope.get(lhs.argumentExpression.text) : undefined;
  const symbol = cx.checker?.getSymbolAtLocation(lhs.argumentExpression);
  const expectedSlot = symbol === undefined ? undefined : cx.nativeVectorMutationSlots?.get(symbol);
  if (
    !nativeVectorMutationIsProven(lhs, cx.checker, (expression) => cx.logicalVectorTypes?.has(expression) === true) ||
    binding?.kind !== "slot" ||
    !binding.i32Storage ||
    expectedSlot === undefined ||
    binding.slotIndex !== expectedSlot
  ) {
    throw new IrUnsupportedError(
      "element-store-unsupported",
      "build",
      `ir/from-ast: native vector mutation needs a stable symbol-bound integer loop proof (${cx.funcName})`,
    );
  }
  return cx.builder.emitSlotRead(binding.slotIndex!);
}

export function nativeMutationSlotsForLoop(
  stmt: ts.ForStatement,
  cx: NativeMutationHost,
): ReadonlyMap<ts.Symbol, number> | undefined {
  if (
    !nativeVectorMutationOwnerIsSynchronous(stmt) ||
    cx.logicalVectorTypes === undefined ||
    !cx.checker ||
    !stmt.initializer ||
    !ts.isVariableDeclarationList(stmt.initializer) ||
    stmt.initializer.declarations.length !== 1
  )
    return cx.nativeVectorMutationSlots;
  const declaration = stmt.initializer.declarations[0];
  if (!ts.isIdentifier(declaration.name)) return cx.nativeVectorMutationSlots;
  const symbol = cx.checker.getSymbolAtLocation(declaration.name),
    binding = cx.scope.get(declaration.name.text);
  if (!symbol || binding?.kind !== "slot" || !binding.i32Storage) return cx.nativeVectorMutationSlots;
  return new Map([...(cx.nativeVectorMutationSlots ?? []), [symbol, binding.slotIndex!]]);
}

export function emitNativeVectorMutation(
  lhs: ts.ElementAccessExpression,
  rhs: ts.Expression | null,
  cx: NativeMutationHost,
  recv: IrValueId,
  type: Extract<IrType, { kind: "vec" }>,
  binop: Parameters<IrFunctionBuilder["emitBinary"]>[0] | undefined,
  lowerValue: (expression: ts.Expression) => IrValueId,
): void {
  if (!cx.logicalVectorTypes?.has(lhs.expression)) {
    throw new IrUnsupportedError(
      "element-store-unsupported",
      "build",
      `ir/from-ast: missing native vector expression fact (${cx.funcName})`,
    );
  }
  if (asVal(type.elementType)?.kind !== "f64") {
    throw new IrUnsupportedError(
      "element-store-unsupported",
      "build",
      `ir/from-ast: native mutation needs f64 elements (${cx.funcName})`,
    );
  }
  const index = lowerNativeVectorMutationIndex(lhs, cx);
  // Capture receiver/index and load the old value before RHS effects.
  const old = binop === undefined ? undefined : cx.builder.emitVecGet(recv, index, type.elementType);
  const value = rhs === null ? cx.builder.emitConst({ kind: "f64", value: 1 }, IR_F64) : lowerValue(rhs);
  if (asVal(cx.builder.typeOf(value))?.kind !== "f64") {
    throw new IrUnsupportedError(
      "element-store-unsupported",
      "build",
      `ir/from-ast: native mutation value must be f64 (${cx.funcName})`,
    );
  }
  cx.builder.emitVecSet(recv, index, old === undefined ? value : cx.builder.emitBinary(binop!, old, value, IR_F64));
}
