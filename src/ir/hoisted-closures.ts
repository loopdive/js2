// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Where a function body makes the closures of its nested declarations. FunctionDeclarationInstantiation (§10.2.11
// step 36) makes every one before the body's first statement. The closure is only observable through its name, and a
// declaration bound this way has a name nothing else writes, so making it just before the first statement that names
// it is the same program. It must not be made earlier than that: a closure holds the bindings it captures as they
// are when it is made, and the `var`s above its first use are initialized by then.

import { ts } from "../ts-api.js";

/** For each statement of a body, the declarations to make just before it, in source order. */
export type HoistedClosurePlacement = ReadonlyMap<ts.Statement, readonly ts.FunctionDeclaration[]>;

/**
 * The placement of `declarations` (the hoisted ones among `statements`): each goes before the earliest statement that
 * names it, the declaration itself included, and before every hoisted declaration that names it, so a closure that
 * calls another finds it made.
 */
export function placeHoistedClosures(
  statements: readonly ts.Statement[],
  declarations: readonly ts.FunctionDeclaration[],
): HoistedClosurePlacement {
  const index = new Map(declarations.map((declaration) => [declaration, statements.indexOf(declaration)]));
  for (const declaration of declarations) {
    const name = declaration.name!.text;
    const first = statements.findIndex((statement) => statement === declaration || names(statement, name));
    index.set(declaration, first);
  }
  // A declaration that names another pulls that one up to its own place; repeat until nothing moves.
  for (let moved = true; moved; ) {
    moved = false;
    for (const user of declarations)
      for (const used of declarations)
        if (used !== user && index.get(user)! < index.get(used)! && names(user, used.name!.text)) {
          index.set(used, index.get(user)!);
          moved = true;
        }
  }
  const placement = new Map<ts.Statement, ts.FunctionDeclaration[]>();
  for (const declaration of declarations) {
    const statement = statements[index.get(declaration)!]!;
    placement.set(statement, [...(placement.get(statement) ?? []), declaration]);
  }
  return placement;
}

/** Whether an identifier in `node` other than a declaration's own name reads `name`. Shadowing is ignored: it only moves a closure earlier. */
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
