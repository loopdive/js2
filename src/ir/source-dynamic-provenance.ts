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
import { isModuleInitVarList, isTopLevelStatementDeclaration } from "../shared/var-declaration-lists.js";
import { skipOuterExpressions } from "../shared/binding-writes.js";
import { preparedBindingRewritten, scriptVarWrites } from "./module-binding-script-var.js";
import { annexBWritesScriptBinding } from "../shared/annexb-block-functions.js";
import { irOwnedScriptVarHome } from "./module-binding-script-var-home.js";
import { syntacticAnnotation } from "./select-expression-structure.js";
import type { IrModuleBindingDeclaration, IrScriptVarHome } from "./module-bindings.js";
import { realmConstantRead } from "./realm-static-call.js";

type Carries = (expression: ts.Expression) => boolean;

export interface SourceDynamicProvenance {
  /** The resolver's `scriptVarHome` option. */
  readonly scriptVarHome: (declaration: IrModuleBindingDeclaration) => IrScriptVarHome | undefined;
  /** The value of `expression` may be the dynamic value. */
  readonly carries: Carries;
}

/**
 * The provenance of a program, over its `startupSources` (see `irOwnedScriptVarHome`); `pristine` is the program's
 * `pristineBuiltinGlobal`, over every source. Without a `dynamicCarrier` on the lane no script `var` gets the dynamic
 * home. `resultIsDynamic` is the unannotated-result contract, which asks `carries` of each returned value;
 * `parameterIsDynamic` the parameter contract.
 */
export function sourceDynamicProvenance(
  checker: ts.TypeChecker,
  startupSources: readonly ts.SourceFile[],
  pristine: (identifier: ts.Identifier) => boolean,
  dynamicCarrier: boolean,
  resultIsDynamic: (declaration: ts.FunctionDeclaration, carries: Carries) => boolean,
  parameterIsDynamic: (declaration: ts.FunctionDeclaration, parameter: ts.ParameterDeclaration) => boolean,
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
  // (#7372 2a-3) An Annex B block function of the name stores a function object.
  const storesCarry = (declaration: ts.VariableDeclaration): boolean =>
    (ts.isIdentifier(declaration.name) &&
      annexBWritesScriptBinding(declaration.getSourceFile(), declaration.name.text)) ||
    (scriptVarWrites(checker, declaration)?.some((write) =>
      write.kind === "value" ? carries(write.expr, declaration) : write.kind !== "numeric",
    ) ??
      true);
  const classify = irOwnedScriptVarHome(checker, startupSources, dynamicCarrier ? storesCarry : undefined);
  const scriptVarHome = (declaration: IrModuleBindingDeclaration) =>
    once(homes, declaration, "dynamic", () => classify(declaration));
  // from-ast is the authority on a local: it types the local from the value it is created with (or its syntactic
  // annotation, never a JSDoc tag: `syntacticAnnotation`) and refuses a later store of another type. So an
  // unannotated local holds the dynamic value exactly when that first value may be it; a local without an
  // initializer (a catch binding too) starts as `undefined`.
  const localCarries = (declaration: ts.VariableDeclaration): boolean =>
    once(
      locals,
      declaration,
      true,
      () =>
        syntacticAnnotation(declaration) === undefined &&
        (declaration.initializer === undefined || carries(declaration.initializer, declaration)),
    );

  const bindingCarries = (node: ts.Identifier, self: ts.VariableDeclaration | undefined): boolean => {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration === undefined) return true;
    if (declaration === self) return false;
    // An untyped or `any` parameter is checker `any` (above); a syntactically annotated one is typed by its
    // annotation, and the flow rule checks every argument against it. (#7354 W2) A JSDoc-tagged one is not: the
    // parameter contract says whether it holds the dynamic value.
    if (ts.isParameter(declaration))
      return ts.isFunctionDeclaration(declaration.parent) && parameterIsDynamic(declaration.parent, declaration);
    if (!ts.isVariableDeclaration(declaration)) return true;
    // A top-level declaration's storage is a global, whose home the classifier names: only a script `var` of the
    // program can have the dynamic home (a lexical, ES-module or ambient global is typed by its declaration, and
    // the resolver refuses a dynamic store into it). (#7372) So is a script `var` nested in top-level code. Any
    // other variable is a local.
    if (isTopLevelStatementDeclaration(declaration) || isModuleInitVarList(declaration.parent, "with-for-in-heads"))
      return scriptVarHome(declaration) === "dynamic";
    return localCarries(declaration);
  };
  const callCarries = (call: ts.CallExpression): boolean => {
    const callee = sourceFunctionCallee(checker, call);
    if (callee === undefined) return true;
    return once(results, callee, true, () => resultIsDynamic(callee, (value) => carries(value)));
  };
  // Fail-closed: a kind not modelled here may be the dynamic value.
  const carries = (expression: ts.Expression, self?: ts.VariableDeclaration): boolean => {
    const node = skipOuterExpressions(expression);
    if (checker.getTypeAtLocation(node) === any) return true;
    if (ts.isIdentifier(node)) return bindingCarries(node, self);
    if (ts.isCallExpression(node)) return callCarries(node);
    if (ts.isConditionalExpression(node)) return carries(node.whenTrue, self) || carries(node.whenFalse, self);
    if (ts.isBinaryExpression(node)) return binaryCarries(node, self);
    // (#7350 B3a) A constant a realm constructor holds (`Number.MAX_VALUE`) is folded to its number.
    if (ts.isPropertyAccessExpression(node) && realmConstantRead(node, pristine) !== undefined) return false;
    switch (node.kind) {
      // Number, Boolean and (#7354 Str) string literals, and the prefix operators whose result is a number or a
      // Boolean whatever the operand (`-v`, `!v`, `++v`). Every other kind (members, calls of anything but a source
      // function, object and array literals, closures, templates, `this`, `void`) is not modelled yet and may be the
      // dynamic value.
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.PrefixUnaryExpression:
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

/**
 * The source function declaration with a body that `call` calls directly, if any. (#7354 H2) A call of a rewritten
 * declaration reads its binding, which may hold any value.
 */
export function sourceFunctionCallee(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.FunctionDeclaration | undefined {
  const callee = checker.getSymbolAtLocation(call.expression)?.valueDeclaration;
  return callee !== undefined &&
    ts.isFunctionDeclaration(callee) &&
    callee.body !== undefined &&
    !preparedBindingRewritten(checker, callee.name!)
    ? callee
    : undefined;
}
