// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7579) An array literal on the Prepared path is the realm's array (ArrayAccumulation, §13.2.4.1), a dynamic value
 * at its source: one call of `ARRAY_LITERAL_HELPER` over the literal's length (an elision is a hole and counts, a
 * trailing comma does not), then each present element's index key and value, evaluated left to right onto the carrier
 * (`dynamicStoreOperand`, the one operand route of a stored value). The legalization writes it as ArrayCreate and the
 * defines (`arrayOf`). A spread element needs the iteration protocol: it refuses by name.
 */
import { ts } from "../ts-api.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { dynamicStoreOperand, type FunctionObjectLoweringHost } from "./function-object-lowering.js";
import { irDynamic, irVal, type IrValueId } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { ARRAY_LITERAL_HELPER } from "./program/dynamic-realm-calls.js";

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
  const length = b.emitConst({ kind: "f64", value: expr.elements.length }, irVal({ kind: "f64" }));
  const entries = expr.elements.flatMap((element, index) =>
    ts.isOmittedExpression(element)
      ? []
      : [
          b.emitCoerceToExternref(b.emitStringConst(String(index))),
          dynamicStoreOperand(host.lowerExpression(element), element, host, "array element"),
        ],
  );
  return b.emitCall(irRuntimeFuncRef(ARRAY_LITERAL_HELPER), [length, ...entries], irDynamic())!;
}
