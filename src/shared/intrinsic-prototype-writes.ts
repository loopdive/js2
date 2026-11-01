// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Whether a program may change what a read through `Array.prototype` or
 * `Object.prototype` answers: it assigns, deletes or defines a member of one.
 *
 * Pure AST, shared by the legacy array-iteration brand (#1719,
 * `sourceOverridesArrayIterator`) and the IR's literal destructuring reader
 * (#7106), so the two cannot disagree on what a patch is. It sees:
 *   - `<C>.prototype[k] = v` / `<C>.prototype.k = v`, through `(…)`, `as`,
 *     `!` and `<T>` wrappers around the receiver;
 *   - `delete <C>.prototype[k]`;
 *   - `Object.defineProperty(<C>.prototype, …)` and
 *     `Object.defineProperties(<C>.prototype, …)`.
 *
 * Any member counts: `Array.prototype[1] = 9` changes a hole read as much as
 * `Array.prototype[Symbol.iterator] = f` changes iteration. A patch reached
 * through an alias (`var p = Array.prototype; p.x = 1`), `Reflect`, or
 * `%ArrayIteratorPrototype%` is not seen.
 */
import { forEachChild, ts } from "../ts-api.js";

export type PatchableIntrinsic = "Array" | "Object";

const cache = new WeakMap<ts.SourceFile, ReadonlySet<PatchableIntrinsic>>();

export function sourcePatchesPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  let patched = cache.get(sourceFile);
  if (!patched) {
    patched = scanPrototypePatches(sourceFile);
    cache.set(sourceFile, patched);
  }
  return patched.has(intrinsic);
}

function scanPrototypePatches(sourceFile: ts.SourceFile): ReadonlySet<PatchableIntrinsic> {
  const patched = new Set<PatchableIntrinsic>();
  const visit = (node: ts.Node): void => {
    const target =
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? memberReceiver(node.left)
        : ts.isDeleteExpression(node)
          ? memberReceiver(unwrap(node.expression))
          : definePropertyReceiver(node);
    const intrinsic = target && prototypeOf(target);
    if (intrinsic) patched.add(intrinsic);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return patched;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The receiver of a member access, wrappers removed; undefined for any other target. */
function memberReceiver(target: ts.Expression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
    ? unwrap(target.expression)
    : undefined;
}

/** The first argument of `Object.defineProperty(…)` / `Object.defineProperties(…)`. */
function definePropertyReceiver(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const callee = node.expression;
  const defines =
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    (callee.name.text === "defineProperty" || callee.name.text === "defineProperties");
  return defines ? node.arguments[0] : undefined;
}

/** `Array` for `Array.prototype`, `Object` for `Object.prototype`. */
function prototypeOf(expression: ts.Expression): PatchableIntrinsic | undefined {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== "prototype" ||
    !ts.isIdentifier(expression.expression)
  ) {
    return undefined;
  }
  const name = expression.expression.text;
  return name === "Array" || name === "Object" ? name : undefined;
}
