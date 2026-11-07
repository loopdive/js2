// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 levers R2, S2) Where the IR consumes a RegExp match result: an
 * `re.exec(s)` call (R2) or a read of a `regexp-match` script `var` (S2). Both
 * are the dynamic carrier holding the match array or null. The selector admits
 * one only where the dynamic lowering reads it as legacy does:
 *   - a property or element read: never a store target, a callee or a
 *     `delete` operand; the key is a number or a name other than `groups` /
 *     `indices`, two fields of the native match vector that the dynamic
 *     reader does not serve;
 *   - an operand of `===`, `!==`, the dynamic `+`, or `typeof`;
 *   - a `var` initializer.
 * Every other use is refused at its site. Today each of them either fails
 * after the claim (a call argument beside an array literal, a loose `!=`
 * against `null`, a property store) or traps (an element store).
 *
 * A `regexp-match` slot is legacy's #1914 `(ref null $__regexp_match_vec)`.
 * Legacy typed it only after proving every write in the source a match
 * result, so the IR's one write is the declaration's own `.exec(…)`
 * initializer, which the slot's `ref.cast null` always admits.
 */
import { ts } from "../ts-api.js";
import { isStoreTarget, outermostParenthesized, stripParens } from "../shared/binding-writes.js";

const UNSERVED_FIELDS: ReadonlySet<string> = new Set(["groups", "indices"]);
const OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.PlusToken,
]);

/** The primitive family the caller's classifier proves (`makeIrPrimitiveExpressionClassifier`). */
type ClassifyPrimitive = (expr: ts.Expression) => string | undefined;

/** True when the IR consumes the match result `use` where its lowering reads it as legacy does. */
export function regExpMatchUseAdmitted(use: ts.Expression, classify: ClassifyPrimitive | undefined): boolean {
  const value = outermostParenthesized(use);
  const consumer = value.parent;
  if (ts.isPropertyAccessExpression(consumer) && consumer.expression === value)
    return !UNSERVED_FIELDS.has(consumer.name.text) && isPlainRead(consumer);
  if (ts.isElementAccessExpression(consumer) && consumer.expression === value)
    return classify?.(consumer.argumentExpression) === "number" && isPlainRead(consumer);
  if (ts.isBinaryExpression(consumer)) return OPERATORS.has(consumer.operatorToken.kind);
  if (ts.isTypeOfExpression(consumer)) return true;
  return ts.isVariableDeclaration(consumer) && consumer.initializer === value;
}

function isPlainRead(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const outer = outermostParenthesized(access);
  const parent = outer.parent;
  return (
    !isStoreTarget(access) &&
    !ts.isDeleteExpression(parent) &&
    !(ts.isCallExpression(parent) && parent.expression === outer)
  );
}

/** True when `value` is an `.exec(…)` call: with legacy's proof above, the one write shape the IR lowers. */
export function regExpMatchWriteMatches(value: ts.Expression): boolean {
  const call = stripParens(value);
  return (
    ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "exec"
  );
}

/** True when `node` is the declaration's own name or an admitted use of the slot's value. */
export function regExpMatchUseSupported(
  node: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.BindingElement,
  classify: ClassifyPrimitive,
): boolean {
  return node === declaration.name || regExpMatchUseAdmitted(node, classify);
}
