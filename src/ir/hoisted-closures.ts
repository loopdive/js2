// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Where a function body makes the closures of its nested declarations. FunctionDeclarationInstantiation (§10.2.11
// step 36) makes every one before the body's first statement. The closure is only observable through its name, and a
// declaration bound this way has a name nothing else writes, so making it just before the first statement that names
// it is the same program. Making it at entry would not be: a closure holds the bindings it captures as they are when
// it is made, and the `var`s above its first use are initialized only by then. A closure that captures another
// closure is refused when it is made (from-ast's `lowerClosureExpressionWithSignature`, #7547), so no declaration's
// place depends on another's.

import { ts } from "../ts-api.js";

/** For each statement of a body, the declarations to make just before it, in source order. */
export type HoistedClosurePlacement = ReadonlyMap<ts.Statement, readonly ts.FunctionDeclaration[]>;

/** Each of `declarations` (the hoisted ones among `statements`) goes before the first statement that names it, itself included. */
export function placeHoistedClosures(
  statements: readonly ts.Statement[],
  declarations: readonly ts.FunctionDeclaration[],
): HoistedClosurePlacement {
  const placement = new Map<ts.Statement, ts.FunctionDeclaration[]>();
  for (const declaration of declarations) {
    const name = declaration.name!.text;
    const statement = statements.find((s) => s === declaration || names(s, name))!;
    placement.set(statement, [...(placement.get(statement) ?? []), declaration]);
  }
  return placement;
}

/**
 * Whether an identifier in `node` other than a declaration's own name reads `name`. A shadowing binding of the same
 * name counts as a read: it only makes the closure earlier, where a capture not yet initialized is a named refusal
 * ("declared after the closure is created"), never a wrong value.
 */
function names(node: ts.Node, name: string): boolean {
  const visit = (child: ts.Node): boolean =>
    (ts.isIdentifier(child) && child.text === name && !isDeclarationName(child)) ||
    ts.forEachChild(child, visit) === true;
  return ts.forEachChild(node, visit) === true;
}

function isDeclarationName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === identifier;
}
