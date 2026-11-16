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
  // No write list: `with` or direct `eval` may store anything. A ToNumeric update stores a number.
  const storesCarry = (declaration: ts.VariableDeclaration): boolean =>
    scriptVarWrites(checker, declaration)?.some((write) =>
      write.kind === "value" ? carries(write.expr, declaration) : write.kind !== "numeric",
    ) ?? true;
  const classify = irOwnedScriptVarHome(checker, sourceFiles, dynamicCarrier ? storesCarry : undefined);
  const scriptVarHome = (declaration: IrModuleBindingDeclaration) =>
    once(homes, declaration, "dynamic", () => classify(declaration));

  const bindingCarries = (node: ts.Identifier, self: ts.VariableDeclaration | undefined): boolean => {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (!declaration || declaration === self || !ts.isVariableDeclaration(declaration)) return false;
    // A script `var` is a global with its own home; the global of a top-level lexical binding or of an ES
    // module's `var` is typed by the resolver, which refuses a dynamic store. Any other variable is a local,
    // typed by the value it holds.
    if (isTopLevelStatementDeclaration(declaration))
      return (
        (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0 &&
        !ts.isExternalModule(declaration.getSourceFile()) &&
        scriptVarHome(declaration) === "dynamic"
      );
    return once(locals, declaration, true, () => storesCarry(declaration));
  };
  const callCarries = (call: ts.CallExpression): boolean => {
    const callee = ts.isIdentifier(call.expression)
      ? checker.getSymbolAtLocation(call.expression)?.valueDeclaration
      : undefined;
    if (!callee || !ts.isFunctionDeclaration(callee)) return false;
    return once(results, callee, true, () => resultIsDynamic(callee, (value) => carries(value)));
  };
  const carries = (expression: ts.Expression, self?: ts.VariableDeclaration): boolean => {
    const node = skipOuterExpressions(expression);
    if (checker.getTypeAtLocation(node) === any) return true;
    if (ts.isIdentifier(node)) return bindingCarries(node, self);
    if (ts.isCallExpression(node)) return callCarries(node);
    if (ts.isConditionalExpression(node)) return carries(node.whenTrue, self) || carries(node.whenFalse, self);
    if (!ts.isBinaryExpression(node)) return false;
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
        return false;
    }
  };
  return { scriptVarHome, carries: (expression) => carries(expression) };
}
