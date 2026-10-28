// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4495) A literal that a destructuring pattern receives — `[r] = [1]`,
 * `({ a: r } = { a: id(1) })`, a literal nested inside one, a nested pattern's
 * default, a `var` binding pattern's initializer — is contextually typed by
 * the PATTERN. That type says where the values go, not what they are, so
 * lowering the literal against it coerces an element of another kind before
 * destructuring sees it: `var r = 'r'; [r] = [1]` built a `[string]` tuple,
 * stored `null` for the `1`, and the binding read back `"null"` once its slot
 * was correctly widened (a trap before that).
 *
 * {@link literalContextualType} is the contextual type both the array and the
 * object literal lowerer start from; for such a source it answers none, so
 * they fall back to the literal's own type. Deliberately narrow:
 *
 * - the decision is made once for the whole source, so the levels of a nested
 *   literal agree on their struct types;
 * - `null`/`undefined` values and pattern holes never count, so the
 *   `undefined` sentinel a pattern default relies on (#801 / #1024) keeps its
 *   contextual lowering;
 * - a level the context lowers as a vec keeps it: its tuple is shorter than
 *   the literal (a pattern collecting a rest, `[a, ...r] = [1, 2, 3]`), the
 *   literal's own type is a tuple of its full length, and the rest lowering
 *   reads only a vec.
 */
import { jsTagOfFact } from "../../checker/oracle.js";
import { stripParens } from "../../shared/binding-writes.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

type Literal = ts.ArrayLiteralExpression | ts.ObjectLiteralExpression;

function isLiteral(node: ts.Node): node is Literal {
  return ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node);
}

/** The outermost literal of the destructuring source `literal` sits in, if it sits in one. */
function destructuringSourceRoot(literal: Literal): Literal | undefined {
  let root = literal;
  let node: ts.Node = literal;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent)) {
      const feeds = parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node;
      return feeds && isLiteral(stripParens(parent.left)) ? root : undefined;
    }
    if (ts.isVariableDeclaration(parent)) {
      const isPattern = ts.isArrayBindingPattern(parent.name) || ts.isObjectBindingPattern(parent.name);
      return parent.initializer === node && isPattern ? root : undefined;
    }
    if (isLiteral(parent)) root = parent;
    else if (
      !ts.isParenthesizedExpression(parent) &&
      !(ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** The values a literal stores, one per element / property (spreads, holes and methods excluded). */
function storedValues(literal: Literal): ts.Expression[] {
  if (ts.isArrayLiteralExpression(literal)) {
    return literal.elements.filter((e) => !ts.isOmittedExpression(e) && !ts.isSpreadElement(e));
  }
  const values: ts.Expression[] = [];
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) values.push(property.initializer);
    else if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
  }
  return values;
}

/** A leaf value whose kind the pattern's definite JS type at its position cannot hold. */
function valueOutgrowsContext(ctx: CodegenContext, value: ts.Expression): boolean {
  const own = ctx.oracle.typeFactOf(value);
  if (own.kind === "null" || own.kind === "undefined" || own.kind === "void") return false;
  const expected = ctx.oracle.contextualFactOf(value);
  const expectedTag = expected && jsTagOfFact(expected);
  // `undefined` is a pattern hole (`[, r] = …`): nothing is stored there.
  return expectedTag !== undefined && expectedTag !== "undefined" && jsTagOfFact(own) !== expectedTag;
}

/** Every literal of a source tree, outermost first. */
function sourceLiterals(root: Literal): Literal[] {
  const literals = [root];
  for (let index = 0; index < literals.length; index++) {
    for (const value of storedValues(literals[index]!)) {
      const inner = stripParens(value);
      if (isLiteral(inner)) literals.push(inner);
    }
  }
  return literals;
}

/** An array level whose contextual tuple is shorter than the literal: the context lowers it as a vec. */
function contextLowersAsVec(ctx: CodegenContext, literal: Literal): boolean {
  if (!ts.isArrayLiteralExpression(literal)) return false;
  const expected = ctx.oracle.contextualFactOf(literal);
  return expected?.kind === "tuple" && expected.elements.length < literal.elements.length;
}

function sourceOutgrowsPattern(ctx: CodegenContext, root: Literal): boolean {
  const literals = sourceLiterals(root);
  if (literals.some((literal) => contextLowersAsVec(ctx, literal))) return false;
  return literals.some((literal) =>
    storedValues(literal).some((value) => !isLiteral(stripParens(value)) && valueOutgrowsContext(ctx, value)),
  );
}

/** The contextual type an array / object literal is lowered against — none for a source its pattern cannot hold. */
export function literalContextualType(ctx: CodegenContext, literal: Literal): ts.Type | undefined {
  const root = destructuringSourceRoot(literal);
  if (root && sourceOutgrowsPattern(ctx, root)) return undefined;
  return ctx.checker.getContextualType(literal);
}
