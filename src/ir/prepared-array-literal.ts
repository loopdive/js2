// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 A1) An array literal on the Prepared path is the realm's array (ArrayAccumulation, §13.2.4.1): ArrayCreate of
 * the literal's length (an elision is a hole, and a trailing one still counts), then each element evaluated left to
 * right and defined right after, CreateDataPropertyOrThrow under its index. The element is the carrier
 * (`dynamicStoreOperand`, the one operand route of a stored value), and the define the realm's
 * (`js.object.define-data`), which an array target answers through its ArrayDefineOwnProperty. A spread element needs
 * the iteration protocol: it refuses by name.
 */
import { ts } from "../ts-api.js";
import { irIntrinsicFuncRef } from "./callable-bindings.js";
import { dynamicStoreOperand, type FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { irVal, type IrValueId } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { CREATE_DATA_PROPERTY_WORD } from "./runtime/ordinary-object-callables.js";

const F64 = irVal({ kind: "f64" });

export function lowerPreparedArrayLiteral(
  expr: ts.ArrayLiteralExpression,
  host: FunctionObjectLoweringHost,
): IrValueId {
  const b = host.builder;
  if (expr.elements.some(ts.isSpreadElement))
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      `ir/from-ast: array literal with a spread element (${host.funcName})`,
    );
  const length = b.emitConst({ kind: "f64", value: expr.elements.length }, F64);
  const array = b.emitCall(irIntrinsicFuncRef("js.object.create-array"), [length], irVal({ kind: "externref" }));
  if (array === null) throw new Error("ir/from-ast: ArrayCreate returned no value");
  expr.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return;
    const value = dynamicStoreOperand(host.lowerExpression(element), element, host, "array element");
    const key = b.emitCoerceToExternref(b.emitStringConst(String(index)));
    const word = b.emitConst({ kind: "f64", value: CREATE_DATA_PROPERTY_WORD }, F64);
    b.emitCall(irIntrinsicFuncRef("js.object.define-data"), [array, key, b.emitCoerceToExternref(value), word], null);
  });
  return array;
}
