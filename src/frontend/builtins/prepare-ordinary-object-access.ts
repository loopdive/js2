// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import type { IrType } from "../../ir/core/types.js";
import { resolveOrdinaryObjectClosureSignature } from "../../ir/ordinary-object-closure-signatures.js";
import { objectLiteralDataPropertyName } from "../../shared/property-key-fold.js";

export interface PreparedOrdinaryPropertyRead {
  readonly key: string;
  readonly resultType: IrType;
}
/** (#7352 arrays) A typed read of an array literal's element at a constant index. */
export interface PreparedArrayElementRead {
  readonly index: number;
  readonly resultType: IrType;
}

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The array index a numeric-literal key names, when it lies inside `length`. */
function constantIndex(access: ts.ElementAccessExpression, length: number): number | undefined {
  const key = access.argumentExpression;
  if (!ts.isNumericLiteral(key)) return undefined;
  const index = Number(key.text);
  return Number.isInteger(index) && index >= 0 && index < length ? index : undefined;
}

const isAccessor = (property: ts.ObjectLiteralElementLike): boolean =>
  ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property);

/**
 * (#7354 O1) Every member is a statically named data property (a `__proto__` member sets the prototype instead): its
 * value is the literal's own initializer.
 */
function isDataOnlyLiteral(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      objectLiteralDataPropertyName(property.name) !== null &&
      !(ts.isPropertyAssignment(property) && objectLiteralDataPropertyName(property.name) === "__proto__"),
  );
}

/**
 * A read `o.k` (or, #7352 arrays, `o[k]`) that neither writes, deletes, calls nor otherwise passes on the property
 * or `o`. A member inside an array or object literal is refused outright: that is where a destructuring assignment
 * target hides.
 */
function isPlainMemberRead(reference: ts.Identifier): boolean {
  const access = reference.parent;
  if (
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== reference ||
    access.questionDotToken
  )
    return false;
  let outer: ts.Node = access;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const user = outer.parent;
  const step = (unary: ts.Node) =>
    (ts.isPrefixUnaryExpression(unary) || ts.isPostfixUnaryExpression(unary)) &&
    (unary.operator === ts.SyntaxKind.PlusPlusToken || unary.operator === ts.SyntaxKind.MinusMinusToken);
  const assigned =
    ts.isBinaryExpression(user) &&
    user.left === outer &&
    user.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    user.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  return !(
    assigned ||
    step(user) ||
    ts.isDeleteExpression(user) ||
    (ts.isCallExpression(user) && user.expression === outer) ||
    ((ts.isForInStatement(user) || ts.isForOfStatement(user)) && user.initializer === outer) ||
    ts.isArrayLiteralExpression(user) ||
    ts.isSpreadElement(user) ||
    ts.isPropertyAssignment(user) ||
    ts.isShorthandPropertyAssignment(user) ||
    ts.isSpreadAssignment(user)
  );
}

/** Exact source intent only. The packet's actual object/descriptor/Get graph grants runtime authority. */
export function prepareOrdinaryObjectAccessResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declarationOrStatements: ts.FunctionDeclaration | readonly ts.Statement[],
): {
  readonly preparedOrdinaryPropertyRead: (
    expression: ts.PropertyAccessExpression,
  ) => PreparedOrdinaryPropertyRead | undefined;
  readonly preparedOrdinaryObjectLiteral: (literal: ts.ObjectLiteralExpression) => boolean;
  readonly preparedArrayLiteral: (literal: ts.ArrayLiteralExpression) => boolean;
  readonly preparedArrayElementRead: (expression: ts.ElementAccessExpression) => PreparedArrayElementRead | undefined;
} {
  const plans = new WeakMap<ts.PropertyAccessExpression, PreparedOrdinaryPropertyRead>();
  const elementPlans = new WeakMap<ts.ElementAccessExpression, PreparedArrayElementRead>();
  const roots: readonly ts.Node[] =
    "kind" in declarationOrStatements ? [declarationOrStatements] : declarationOrStatements;
  // (#7354 O1) Every reference to a symbol in the program's sources, gathered once.
  let references: Map<ts.Symbol, ts.Identifier[]> | undefined;
  const referencesOf = (symbol: ts.Symbol): readonly ts.Identifier[] => {
    if (!references) {
      const found = new Map<ts.Symbol, ts.Identifier[]>();
      const collect = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          // `{ o }` names the property it defines; the binding it reads is the shorthand's value symbol.
          const target =
            ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
              ? checker.getShorthandAssignmentValueSymbol(node.parent)
              : checker.getSymbolAtLocation(node);
          const known = target && found.get(target);
          if (known) known.push(node);
          else if (target) found.set(target, [node]);
        }
        ts.forEachChild(node, collect);
      };
      sourceFiles.forEach(collect);
      references = found;
    }
    return references.get(symbol) ?? [];
  };
  /**
   * The literal behind a receiver whose property values the checker types exactly: an accessor literal bound to a
   * `const`, or (#7354 O1) a function's data-only literal whose binding is only ever read as `o.k`, so no property is
   * written after the literal stored it.
   */
  /** The variable declaration and symbol behind an identifier receiver declared in the program's sources. */
  const sourceVariable = (expression: ts.Expression) => {
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    return declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      sourceFiles.includes(declaration.getSourceFile()) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.initializer
      ? { symbol: symbol!, declaration, initializer: declaration.initializer }
      : undefined;
  };
  // (#7354 O2) A binding outside any function is a module binding: a script `var` holds its value in the dynamic
  // home, whose reads are the dynamic member read; only a function's binding has typed reads.
  const onlyRead = (variable: NonNullable<ReturnType<typeof sourceVariable>>, read: (access: ts.Node) => boolean) =>
    ts.findAncestor(variable.declaration, ts.isFunctionLike) !== undefined &&
    referencesOf(variable.symbol).every(
      (reference) =>
        reference === variable.declaration.name || (isPlainMemberRead(reference) && read(reference.parent)),
    );
  const ordinaryLiteral = (expression: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    // The literal itself as the receiver: its members are its own initializers.
    if (ts.isObjectLiteralExpression(expression)) return expression;
    const variable = sourceVariable(expression);
    if (!variable || !ts.isObjectLiteralExpression(variable.initializer)) return undefined;
    const literal = variable.initializer;
    if (literal.properties.some(isAccessor))
      return variable.declaration.parent.flags & ts.NodeFlags.Const ? literal : undefined;
    return isDataOnlyLiteral(literal) && onlyRead(variable, () => true) ? literal : undefined;
  };
  /**
   * (#7352 arrays) The literal behind a receiver that is only read as `a.length` or `a[i]` with a constant `i`
   * inside it, and has no elision or spread: every planned read finds its element present.
   */
  const arrayLiteral = (expression: ts.Expression): ts.ArrayLiteralExpression | undefined => {
    const variable = sourceVariable(expression);
    if (!variable || !ts.isArrayLiteralExpression(variable.initializer)) return undefined;
    const literal = variable.initializer;
    const inside = (access: ts.Node) =>
      ts.isPropertyAccessExpression(access)
        ? access.name.text === "length"
        : ts.isElementAccessExpression(access) && constantIndex(access, literal.elements.length) !== undefined;
    return literal.elements.every((element) => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) &&
      onlyRead(variable, inside)
      ? literal
      : undefined;
  };
  const numeric = (node: ts.Expression) => {
    const type = checker.getTypeAtLocation(node);
    const parts = type.isUnion() ? type.types : [type];
    return parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && !node.questionDotToken && numeric(node)) {
      const literal = arrayLiteral(node.expression);
      const index = literal && constantIndex(node, literal.elements.length);
      if (index !== undefined) elementPlans.set(node, Object.freeze({ index, resultType: F64 }));
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      !node.questionDotToken &&
      node.name.text === "length" &&
      arrayLiteral(node.expression)
    )
      plans.set(node, Object.freeze({ key: "length", resultType: F64 }));
    if (
      ts.isPropertyAccessExpression(node) &&
      !node.questionDotToken &&
      ts.isIdentifier(node.name) &&
      ordinaryLiteral(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node);
      const parts = type.isUnion() ? type.types : [type];
      // These are logical result intentions. The keyed descriptor/return proof
      // must authenticate them before physical allocation; checker types alone
      // do not grant either the Boolean payload read or callable projection.
      if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0)) {
        plans.set(node, Object.freeze({ key: node.name.text, resultType: F64 }));
      } else if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0)) {
        plans.set(node, Object.freeze({ key: node.name.text, resultType: BOOLEAN }));
      } else {
        const getters = ordinaryLiteral(node.expression)!.properties.filter(
          (property): property is ts.GetAccessorDeclaration =>
            ts.isGetAccessorDeclaration(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === node.name.text,
        );
        const signature =
          getters.length === 1 ? resolveOrdinaryObjectClosureSignature(checker, getters[0]!) : undefined;
        if (signature?.kind === "supported" && signature.signature.returnType?.kind === "callable")
          plans.set(node, Object.freeze({ key: node.name.text, resultType: signature.signature.returnType }));
      }
    }
    ts.forEachChild(node, visit);
  };
  const owned = roots.every((root) => sourceFiles.includes(root.getSourceFile()));
  if (owned) roots.forEach(visit);
  return Object.freeze({
    preparedOrdinaryPropertyRead(expression: ts.PropertyAccessExpression) {
      return plans.get(expression);
    },
    // (#7354 O1) The Prepared backend has no closed object struct: every literal it owns is an ordinary object.
    preparedOrdinaryObjectLiteral(literal: ts.ObjectLiteralExpression) {
      return owned && sourceFiles.includes(literal.getSourceFile());
    },
    // (#7352 arrays) Nor a vec home for a literal: every array literal it owns is an Array exotic object.
    preparedArrayLiteral(literal: ts.ArrayLiteralExpression) {
      return owned && sourceFiles.includes(literal.getSourceFile());
    },
    preparedArrayElementRead(expression: ts.ElementAccessExpression) {
      return elementPlans.get(expression);
    },
  });
}
