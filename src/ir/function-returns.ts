// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** The `return <expr>` statements of one function body, the walk the selector and the source contracts share. */
import { ts } from "../ts-api.js";

/** True when some `return <expr>` of `body`, outside nested function-likes and classes, satisfies `predicate`. */
export function someReturnedValue(body: ts.Block, predicate: (value: ts.Expression) => boolean): boolean {
  const visit = (node: ts.Node): boolean =>
    ts.isReturnStatement(node)
      ? node.expression !== undefined && predicate(node.expression)
      : !ts.isFunctionLike(node) && !ts.isClassLike(node) && ts.forEachChild(node, visit) === true;
  return ts.forEachChild(body, visit) === true;
}
