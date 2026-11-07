// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 lever S2) Admission for a SCRIPT `var` that legacy stores in #1914's
 * `exec` match-result slot (`scriptVarHome`'s `regexp-match` home,
 * `(ref null $__regexp_match_vec)`). Legacy typed the slot only after proving
 * that every write in the source is a match result
 * (`inferStandaloneRegExpMatchResultType`). The IR reads the slot as a dynamic
 * value. It writes the slot only from an `.exec(…)` initializer, and the
 * carrier's result (`null` or the capture vector) always passes the slot's
 * `ref.cast null`. Every other store is refused at its site and stays on the
 * direct path, which writes the same slot: `=`, an update, a for-in/of head,
 * a `var` redeclaration.
 */
import { ts } from "../ts-api.js";
import { isStoreTarget, stripParens } from "../shared/binding-writes.js";

/** True when `value` is an `.exec(…)` call, the one IR write a `regexp-match` slot takes. */
export function regExpMatchWriteMatches(value: ts.Expression): boolean {
  const call = stripParens(value);
  return (
    ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "exec"
  );
}

/** True when `node` is the declaration's own name or a read, never another store into the slot. */
export function regExpMatchUseSupported(node: ts.Identifier, declarationName: ts.Node): boolean {
  if (node === declarationName) return true;
  return !isStoreTarget(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node);
}
