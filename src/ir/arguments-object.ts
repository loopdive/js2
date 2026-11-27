// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106 S1e, #7562) What the lowering does with a function's own arguments object, by the one scope-correct answer
// of `ownArgumentsObjectUse` / `argumentsObjectOwner` (`analysis/ast-scope.ts`): it builds `arguments.length` reads
// from the count the function takes at entry, and nothing else.

import { ts } from "../ts-api.js";
import { argumentsObjectOwner, ownArgumentsObjectUse } from "./analysis/ast-scope.js";
import type { IrValueId } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";

/**
 * The value of `expr` when it reads `arguments.length` of an arguments object: `entry`, the count the reading
 * function took at entry. `undefined` when `expr` reads no arguments object (a property of anything else, or of a
 * declared binding named `arguments`).
 */
export function argumentsLengthRead(
  expr: ts.PropertyAccessExpression,
  entry: IrValueId | undefined,
  funcName: string,
): IrValueId | undefined {
  if (expr.name.text !== "length" || !ts.isIdentifier(expr.expression) || expr.expression.text !== "arguments")
    return undefined;
  const owner = argumentsObjectOwner(expr.expression);
  if (owner === undefined) return undefined;
  if (entry === undefined || ownArgumentsObjectUse(owner) !== "length")
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: arguments.length outside its function's entry prologue (${funcName})`,
    );
  return entry;
}

/** (Prepared) A body that uses its own arguments object beyond reading `arguments.length` is the run-time abort. */
export function refuseArgumentsObjectUse(fn: ts.SignatureDeclaration, unselected: true | undefined, funcName: string) {
  if (unselected && ownArgumentsObjectUse(fn) === "other")
    demoteToLegacy("body-shape-rejected", `ir/from-ast: arguments object beyond arguments.length (${funcName})`);
}
