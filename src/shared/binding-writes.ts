// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Every store into a bare identifier binding, enumerated once for every
 * analysis that asks who writes a binding and with what.
 *
 * - (#6992) The closure-capture / loop-boxing scans ask only WHETHER an
 *   identifier is written ({@link isLexicalBindingWrite},
 *   {@link varDeclaratorWrittenNames}). They used to recognise `x = …`,
 *   compound assignment and `++`/`--` only, so a write through a destructuring
 *   target, a for-in/for-of head or a `var` re-declaration left the capture
 *   by-value and the closure read a stale snapshot.
 * - (#4495) The slot-widening analyses — module bindings
 *   (`ir/heterogeneous-module-bindings.ts`), function locals
 *   (`codegen/analysis/mixed-assignment-carrier.ts`) and the numeric-local
 *   proof (`codegen/numeric-property-analysis.ts`) — also ask WHAT is stored.
 *   A string-initialised binding written by `[x] = [f()]` kept its native-string
 *   slot, whose coercion answers `null` for a non-string by design, and the
 *   next `'' + x` trapped. The oracle half of that answer is
 *   `identifierWriteFact` / `identifierWriteTag` in `checker/oracle.ts`.
 *
 * Both questions are answered by {@link identifierWritesOf}, so the scans
 * cannot disagree on what a write is. Pure AST: no checker, no CodegenContext —
 * it sits in `src/shared` so `src/ir` and `src/codegen` share it without a
 * codegen<->ir import edge.
 */
import { ts } from "../ts-api.js";

/** What one store writes into its target. */
type WriteSource =
  /**
   * The value of `expr`: a plain or logical assignment's right operand, a
   * literal source element or property, a default, a `var` initializer — and
   * for `x += v` the assignment itself, whose type is the stored result.
   */
  | { readonly kind: "value"; readonly expr: ts.Expression }
  /** An element iterated from `iterable`: a for-of head, or an array-pattern element of a non-literal source. */
  | { readonly kind: "element"; readonly iterable: ts.Expression }
  /** Property `key` of `object`: an object-pattern property of a non-literal source. */
  | { readonly kind: "property"; readonly object: ts.Expression; readonly key: string }
  /** A ToNumeric result: `++`, `--`, `-=`, `*=`, … */
  | { readonly kind: "numeric" }
  /** A for-in property key, always a string. */
  | { readonly kind: "key" }
  /** A rest element's fresh Array or Object. */
  | { readonly kind: "rest" }
  /** A value the syntax does not name: a nested pattern under a non-literal source, an absent element, a computed key. */
  | { readonly kind: "unknown" };

/** One store into an identifier binding. */
export type IdentifierWrite = WriteSource & { readonly target: ts.Identifier };

const UNKNOWN: WriteSource = { kind: "unknown" };
const REST: WriteSource = { kind: "rest" };
const KEY: WriteSource = { kind: "key" };

/** Shared result for the (overwhelmingly common) node that stores nothing — no per-node allocation. */
const NO_WRITES: readonly IdentifierWrite[] = Object.freeze([]);

/** Logical assignments store their right operand, conditionally. */
const LOGICAL_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Compound assignments whose write-back is always a Number or a BigInt — every one but `+=` and the logical forms. */
const NUMERIC_COMPOUND_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

/** True for a compound assignment operator whose write-back is ToNumeric (`-=`, `**=`, `|=`, …). */
export function isNumericCompoundAssignment(operator: ts.SyntaxKind): boolean {
  return NUMERIC_COMPOUND_ASSIGNMENTS.has(operator);
}

/** Parentheses only, for callers whose shape predicates must not look through TS type wrappers. */
export function stripParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

/** Parentheses and TS type wrappers (`as`, `!`, `satisfies`, `<T>x`) — transparent around a target or a source. */
function skipOuterExpressions(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/** Literal property-name text, or undefined for a computed / private name or a nested binding pattern. */
function literalKey(name: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

/**
 * What the array-pattern element at `index` receives from `source`: the paired
 * element of a spread-free array literal, an element of a non-literal source,
 * and unknown otherwise (an absent literal element is `undefined`).
 */
function arrayElementSource(source: ts.Expression | undefined, index: number): WriteSource {
  if (!source || ts.isObjectLiteralExpression(source)) return UNKNOWN;
  if (!ts.isArrayLiteralExpression(source)) return { kind: "element", iterable: source };
  if (source.elements.some((e) => ts.isSpreadElement(e))) return UNKNOWN;
  const element = source.elements[index];
  return element && !ts.isOmittedExpression(element) ? { kind: "value", expr: element } : UNKNOWN;
}

/**
 * What the object-pattern property `name` receives from `source`: the value of
 * a spread-free object literal naming it, property `name` of a non-literal
 * source, and unknown otherwise.
 */
function propertySource(source: ts.Expression | undefined, name: ts.PropertyName | ts.BindingName): WriteSource {
  const key = literalKey(name);
  if (!source || key === undefined || ts.isArrayLiteralExpression(source)) return UNKNOWN;
  if (!ts.isObjectLiteralExpression(source)) return { kind: "property", object: source, key };
  let found: WriteSource = UNKNOWN;
  for (const property of source.properties) {
    if (ts.isSpreadAssignment(property)) return UNKNOWN;
    const propertyName = literalKey(property.name);
    if (propertyName === undefined) return UNKNOWN;
    if (propertyName !== key) continue;
    if (ts.isPropertyAssignment(property)) found = { kind: "value", expr: property.initializer };
    else if (ts.isShorthandPropertyAssignment(property)) found = { kind: "value", expr: property.name };
    else return UNKNOWN; // accessor / method: not a plain stored value
  }
  return found;
}

type Pattern =
  | ts.ArrayLiteralExpression
  | ts.ObjectLiteralExpression
  | ts.ArrayBindingPattern
  | ts.ObjectBindingPattern;

function isPattern(node: ts.Node): node is Pattern {
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayBindingPattern(node) ||
    ts.isObjectBindingPattern(node)
  );
}

/** Record `node` receiving `source`, plus an optional default. */
function pushTarget(
  out: IdentifierWrite[],
  node: ts.Expression | ts.BindingName,
  source: WriteSource,
  defaultValue?: ts.Expression,
): void {
  const target = ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node) ? node : skipOuterExpressions(node);
  if (ts.isIdentifier(target)) {
    out.push({ ...source, target });
    if (defaultValue) out.push({ kind: "value", expr: defaultValue, target });
  } else if (isPattern(target)) {
    // A nested pattern destructures its source element — only a literal one
    // names its parts — and, when that is undefined, its default.
    collectPatternWrites(out, target, source.kind === "value" ? source.expr : undefined);
    if (defaultValue) collectPatternWrites(out, target, defaultValue);
  }
}

/** An assignment-pattern slot: `target` or `target = default`. */
function pushDefaultedTarget(out: IdentifierWrite[], slot: ts.Expression, source: WriteSource): void {
  if (ts.isBinaryExpression(slot) && slot.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    pushTarget(out, slot.left, source, slot.right);
  } else {
    pushTarget(out, slot, source);
  }
}

/** Identifier targets of an assignment or binding pattern, each with what it receives from `source`. */
function collectPatternWrites(out: IdentifierWrite[], pattern: Pattern, source: ts.Expression | undefined): void {
  const from = source && skipOuterExpressions(source);
  if (ts.isObjectLiteralExpression(pattern)) {
    for (const property of pattern.properties) {
      if (ts.isSpreadAssignment(property)) {
        pushTarget(out, property.expression, REST);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        pushTarget(out, property.name, propertySource(from, property.name), property.objectAssignmentInitializer);
      } else if (ts.isPropertyAssignment(property)) {
        pushDefaultedTarget(out, property.initializer, propertySource(from, property.name));
      }
    }
  } else if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      const received = element.dotDotDotToken ? REST : propertySource(from, element.propertyName ?? element.name);
      pushTarget(out, element.name, received, element.initializer);
    }
  } else {
    for (let index = 0; index < pattern.elements.length; index++) {
      const element: ts.Expression | ts.ArrayBindingElement = pattern.elements[index]!;
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isBindingElement(element)) {
        const received = element.dotDotDotToken ? REST : arrayElementSource(from, index);
        pushTarget(out, element.name, received, element.initializer);
      } else if (ts.isSpreadElement(element)) {
        pushTarget(out, element.expression, REST);
      } else {
        pushDefaultedTarget(out, element, arrayElementSource(from, index));
      }
    }
  }
}

function assignmentWrites(node: ts.BinaryExpression): readonly IdentifierWrite[] {
  const operator = node.operatorToken.kind;
  const left = skipOuterExpressions(node.left);
  if (ts.isIdentifier(left)) {
    if (operator === ts.SyntaxKind.EqualsToken || LOGICAL_ASSIGNMENTS.has(operator)) {
      return [{ kind: "value", expr: node.right, target: left }];
    }
    if (operator === ts.SyntaxKind.PlusEqualsToken) return [{ kind: "value", expr: node, target: left }];
    return NUMERIC_COMPOUND_ASSIGNMENTS.has(operator) ? [{ kind: "numeric", target: left }] : NO_WRITES;
  }
  if (operator !== ts.SyntaxKind.EqualsToken || !isPattern(left)) return NO_WRITES;
  const out: IdentifierWrite[] = [];
  collectPatternWrites(out, left, node.right);
  return out;
}

function updateWrites(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): readonly IdentifierWrite[] {
  if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) {
    return NO_WRITES;
  }
  const operand = skipOuterExpressions(node.operand);
  return ts.isIdentifier(operand) ? [{ kind: "numeric", target: operand }] : NO_WRITES;
}

/** Each iteration stores a key (for-in) or an element (for-of) into the head's binding(s). */
function loopHeadWrites(node: ts.ForInStatement | ts.ForOfStatement): readonly IdentifierWrite[] {
  const source: WriteSource = ts.isForInStatement(node) ? KEY : { kind: "element", iterable: node.expression };
  const out: IdentifierWrite[] = [];
  const head = node.initializer;
  if (ts.isVariableDeclarationList(head)) {
    for (const declaration of head.declarations) pushTarget(out, declaration.name, source);
  } else {
    pushTarget(out, head, source);
  }
  return out;
}

/**
 * A `var` declarator with an initializer stores into its binding(s). When the
 * name is already declared (`var v = 1; … var v = 2;`, or a parameter
 * re-declared by `var`) that is a plain write to the existing binding, so a
 * scan that knows a binding's own declaration counts every OTHER declarator.
 * `let`/`const` declarators initialise a fresh binding and never write one.
 */
function varDeclaratorWrites(node: ts.VariableDeclaration): readonly IdentifierWrite[] {
  const list = node.parent;
  if (!node.initializer || !ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) {
    return NO_WRITES;
  }
  const out: IdentifierWrite[] = [];
  pushTarget(out, node.name, { kind: "value", expr: node.initializer });
  return out;
}

/**
 * The identifier stores `node` itself performs — assignment (plain, logical,
 * compound, destructuring), `++`/`--`, a for-in/for-of head and a `var`
 * declarator with an initializer. Children are not visited: callers drive
 * their own walk. `updates: false` leaves `++`/`--` out for a caller that owns
 * them elsewhere.
 */
export function identifierWritesOf(
  node: ts.Node,
  options: { readonly updates?: boolean } = {},
): readonly IdentifierWrite[] {
  if (ts.isBinaryExpression(node)) return assignmentWrites(node);
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return options.updates === false ? NO_WRITES : updateWrites(node);
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) return loopHeadWrites(node);
  if (ts.isVariableDeclaration(node)) return varDeclaratorWrites(node);
  return NO_WRITES;
}

/**
 * The node whose stores `identifier` may be a target of: the first assignment,
 * update or for-in/for-of head reached by climbing through destructuring
 * containers (array/object literal, spread, shorthand, property value) and
 * transparent wrappers. Never a member receiver, a computed key or a default.
 */
function writeRootOf(identifier: ts.Identifier): ts.Node | undefined {
  let target: ts.Node = identifier;
  for (;;) {
    const parent = target.parent;
    if (!parent) return undefined;
    if (
      ts.isBinaryExpression(parent) ||
      ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent)
    ) {
      return parent;
    }
    if (
      (ts.isParenthesizedExpression(parent) && parent.expression === target) ||
      (ts.isAsExpression(parent) && parent.expression === target) ||
      (ts.isSatisfiesExpression(parent) && parent.expression === target) ||
      (ts.isNonNullExpression(parent) && parent.expression === target) ||
      (ts.isTypeAssertionExpression(parent) && parent.expression === target) ||
      (ts.isSpreadElement(parent) && parent.expression === target) ||
      (ts.isSpreadAssignment(parent) && parent.expression === target) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === target) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent)
    ) {
      target = parent;
      continue;
    }
    return undefined;
  }
}

/** True when `identifier` is a target {@link identifierWritesOf} reports — a `var` declarator's own name excluded. */
export function isLexicalBindingWrite(identifier: ts.Identifier): boolean {
  const root = writeRootOf(identifier);
  return root !== undefined && identifierWritesOf(root).some((write) => write.target === identifier);
}

/** The binding identifiers a `var` declarator with an initializer assigns; empty for any other node. */
export function varDeclaratorWrittenNames(node: ts.Node): ts.Identifier[] {
  if (!ts.isVariableDeclaration(node)) return [];
  return [...new Set(identifierWritesOf(node).map((write) => write.target))];
}
