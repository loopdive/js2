// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 H) Where the checker's type of an expression is not its IR type on the native dynamic lane.
 *
 * A script `var` without a proven typed home lives in the dynamic carrier whatever the checker infers for it
 * (`var z = 3` read by a hoisted function holds `undefined` first), and its value stays the dynamic value
 * through everything that passes it on unchanged: a local it initialises, a function result it is returned as,
 * a call of that function, another script `var` it is stored in. Every rule that fixes an IR type from the
 * checker asks here first: the script `var` home (a typed home also needs every stored value typed), the
 * unannotated result contract, and the implicit-flow rule.
 *
 * The analysis is fail-closed: an expression kind or a binding kind it does not model may be the dynamic value,
 * so its answer is never less dynamic than the IR's, only more (a typed value the carrier boxes).
 *
 * The questions are mutually recursive (a home depends on the values stored in it, a result on the values
 * returned). Each answer is computed once per program. A question met again while it is being answered counts
 * as dynamic, which only ever moves a value into the carrier, never out of it; the one exception is a binding's
 * own direct read inside the values it stores (`x = x + 1`): if every other value is typed, so is that one.
 */
import { ts } from "../ts-api.js";
import { isTopLevelStatementDeclaration } from "../shared/var-declaration-lists.js";
import { skipOuterExpressions } from "../shared/binding-writes.js";
import { scriptVarWrites } from "./module-binding-script-var.js";
import { irOwnedScriptVarHome } from "./module-binding-script-var-home.js";
import type { IrModuleBindingDeclaration, IrScriptVarHome } from "./module-bindings.js";

type Carries = (expression: ts.Expression) => boolean;

export interface SourceDynamicProvenance {
  /** The resolver's `scriptVarHome` option. */
  readonly scriptVarHome: (declaration: IrModuleBindingDeclaration) => IrScriptVarHome | undefined;
  /** The value of `expression` may be the dynamic value. */
  readonly carries: Carries;
}

/**
 * The provenance of a program's `sourceFiles`. Without a `dynamicCarrier` on the lane no script `var` gets the
 * dynamic home. `resultIsDynamic` is the unannotated-result contract, which asks `carries` of each returned value.
 */
export function sourceDynamicProvenance(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  dynamicCarrier: boolean,
  resultIsDynamic: (declaration: ts.FunctionDeclaration, carries: Carries) => boolean,
): SourceDynamicProvenance {
  const any = checker.getAnyType();
  const homes = new Map<IrModuleBindingDeclaration, IrScriptVarHome | undefined>();
  const locals = new Map<ts.VariableDeclaration, boolean>();
  const results = new Map<ts.FunctionDeclaration, boolean>();
  const once = <K, V>(memo: Map<K, V>, key: K, pending: V, answer: () => V): V => {
    if (memo.has(key)) return memo.get(key)!;
    memo.set(key, pending);
    const value = answer();
    memo.set(key, value);
    return value;
  };
  // Every store after the declaration. Fail-closed: without a write list (`with`, direct `eval`) anything may be
  // stored, and only a ToNumeric update (`++`, `-=`) is known to store a number.
  const storesCarry = (declaration: ts.VariableDeclaration): boolean =>
    scriptVarWrites(checker, declaration)?.some((write) =>
      write.kind === "value" ? carries(write.expr, declaration) : write.kind !== "numeric",
    ) ?? true;
  const classify = irOwnedScriptVarHome(checker, sourceFiles, dynamicCarrier ? storesCarry : undefined);
  const scriptVarHome = (declaration: IrModuleBindingDeclaration) =>
    once(homes, declaration, "dynamic", () => classify(declaration));
  // A local is typed by from-ast from the value it is created with; this answer must cover that value and every
  // later store, so it is never less dynamic than from-ast's (a local without an initializer starts `undefined`).
  const localCarries = (declaration: ts.VariableDeclaration): boolean =>
    once(
      locals,
      declaration,
      true,
      () =>
        declaration.initializer === undefined ||
        carries(declaration.initializer, declaration) ||
        storesCarry(declaration),
    );

  const bindingCarries = (node: ts.Identifier, self: ts.VariableDeclaration | undefined): boolean => {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration === undefined) return true;
    if (declaration === self) return false;
    // An ambient declaration's checker type is the contract its provider implements (`NaN`, `Math`).
    if (declaration.getSourceFile().isDeclarationFile) return false;
    // An untyped parameter is the dynamic value (#7354 P); an annotated one is typed by its annotation, and the
    // flow rule checks every argument against it.
    if (ts.isParameter(declaration)) return declaration.type === undefined;
    if (!ts.isVariableDeclaration(declaration) || ts.isCatchClause(declaration.parent)) return true;
    // A top-level declaration's storage is a global, whose home the classifier names: only a script `var` can
    // have the dynamic home (a lexical or ES-module global is typed by the resolver, which refuses a dynamic
    // store). Any other variable is a local.
    if (isTopLevelStatementDeclaration(declaration)) return scriptVarHome(declaration) === "dynamic";
    return localCarries(declaration);
  };
  const callCarries = (call: ts.CallExpression): boolean => {
    const callee = checker.getSymbolAtLocation(call.expression)?.valueDeclaration;
    if (callee === undefined) return true;
    if (callee.getSourceFile().isDeclarationFile) return false;
    if (!ts.isFunctionDeclaration(callee) || callee.body === undefined) return true;
    return once(results, callee, true, () => resultIsDynamic(callee, (value) => carries(value)));
  };
  // Fail-closed: a kind not modelled here may be the dynamic value.
  const carries = (expression: ts.Expression, self?: ts.VariableDeclaration): boolean => {
    const node = skipOuterExpressions(expression);
    if (checker.getTypeAtLocation(node) === any) return true;
    if (ts.isIdentifier(node)) return bindingCarries(node, self);
    if (ts.isCallExpression(node)) return callCarries(node);
    if (ts.isConditionalExpression(node)) return carries(node.whenTrue, self) || carries(node.whenFalse, self);
    // A member of a value the IR types is typed too: a dynamic value inside a composite has no carrier. A member
    // of the dynamic value is refused by the legalization, so it never reaches a typed position.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return carries(node.expression, self);
    if (ts.isBinaryExpression(node)) return binaryCarries(node, self);
    switch (node.kind) {
      // Literals, and values the IR creates with their own type (a fresh object, array, closure or instance only
      // becomes the dynamic value through a box, which the legalization owns).
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.ObjectLiteralExpression:
      case ts.SyntaxKind.ArrayLiteralExpression:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.NewExpression:
      // Operators whose result is a number, a Boolean or a string whatever the operand (`-v`, `!v`, `typeof v`).
      case ts.SyntaxKind.PrefixUnaryExpression:
      case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.TypeOfExpression:
      case ts.SyntaxKind.DeleteExpression:
        return false;
      default:
        return true;
    }
  };
  const binaryCarries = (node: ts.BinaryExpression, self: ts.VariableDeclaration | undefined): boolean => {
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return carries(node.right, self);
      // The value is one of the operands (`||`, `&&`, `??` and their assignments) or a dynamic `+` of them.
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarEqualsToken:
      case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      case ts.SyntaxKind.QuestionQuestionEqualsToken:
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.PlusEqualsToken:
        return carries(node.left, self) || carries(node.right, self);
      default:
        // Every other binary operator answers a number, a BigInt or a Boolean.
        return false;
    }
  };
  return { scriptVarHome, carries: (expression) => carries(expression) };
}
