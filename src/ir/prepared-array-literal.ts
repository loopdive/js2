// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 A1) An array literal on the Prepared path is the realm's array (ArrayAccumulation, §13.2.4.1), a dynamic
 * value like every other the path holds: one helper call over the present elements, each evaluated left to right
 * onto the carrier (`dynamicStoreOperand`, the one operand route of a stored value), whose symbol records the
 * literal's length (an elision is a hole, and a trailing one still counts) and each element's index. The
 * legalization writes it as ArrayCreate and the defines (`arrayOf`). A spread element needs the iteration protocol: it
 * refuses by name.
 */
import { ts } from "../ts-api.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { dynamicStoreOperand, type FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { irDynamic, type IrValueId } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { arrayLiteralHelper } from "./program/dynamic-realm-calls.js";

export function lowerPreparedArrayLiteral(
  expr: ts.ArrayLiteralExpression,
  host: FunctionObjectLoweringHost,
): IrValueId {
  if (expr.elements.some(ts.isSpreadElement))
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      `ir/from-ast: array literal with a spread element (${host.funcName})`,
    );
  const present = expr.elements.flatMap((element, index) =>
    ts.isOmittedExpression(element) ? [] : [{ element, index }],
  );
  const values = present.map(({ element }) =>
    dynamicStoreOperand(host.lowerExpression(element), element, host, "array element"),
  );
  const shape = { length: expr.elements.length, indices: present.map(({ index }) => index) };
  const array = host.builder.emitCall(irRuntimeFuncRef(arrayLiteralHelper(shape)), values, irDynamic());
  if (array === null) throw new Error("ir/from-ast: an array literal's helper call returned no value");
  return array;
}
