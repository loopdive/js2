// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Bounded Script early-error validation for statically folded eval bodies
 * (#3632). The foreign SourceFile has no checker bindings, so this pass covers
 * only rules whose answer is fully syntactic. Unsupported node kinds remain
 * the responsibility of eval-inline's conservative dynamic-eval fallback.
 */
import { ts } from "../../ts-api.js";
import { isUseStrictDirectiveExpression } from "../helpers/use-strict-directive.js";

const STRICT_RESERVED_WORDS = new Set([
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
]);
const STRICT_BINDING_NAMES = new Set(["eval", "arguments"]);

/**
 * Caller-context permissions for the §15.1.1 Script early-error rules that
 * cannot be answered from the eval source alone (#5157). Each flag is true only
 * when the *call site* licenses the construct:
 *
 * - `newTarget` — direct eval contained in function code that is not the
 *   function code of an ArrowFunction.
 * - `superProperty` — direct eval inside a method / accessor / constructor
 *   (a function with a [[HomeObject]]).
 * - `superCall` — direct eval inside a derived-class constructor.
 *
 * Indirect eval never licenses any of them.
 */
export interface EvalCallerCapabilities {
  newTarget: boolean;
  superProperty: boolean;
  superCall: boolean;
}

const NO_CAPABILITIES: EvalCallerCapabilities = { newTarget: false, superProperty: false, superCall: false };

/** Return the first early-error message, or undefined when the body is valid. */
export function foldedEvalEarlyError(
  sourceFile: ts.SourceFile,
  scriptIsStrict: boolean,
  caller: EvalCallerCapabilities = NO_CAPABILITIES,
): string | undefined {
  let error: string | undefined;

  const metaError = evalMetaPropertyEarlyError(sourceFile, caller);
  if (metaError !== undefined) return metaError;

  const visit = (node: ts.Node): void => {
    if (error !== undefined) return;

    if (ts.isContinueStatement(node) && !evalContinueTargetExists(node)) {
      error = node.label
        ? `Undefined continue target '${node.label.text}' in eval Script`
        : "Continue statement is not inside an iteration statement in eval Script";
      return;
    }
    if (ts.isBreakStatement(node) && !evalBreakTargetExists(node)) {
      error = node.label
        ? `Undefined break target '${node.label.text}' in eval Script`
        : "Break statement is not inside an iteration or switch statement in eval Script";
      return;
    }

    const strict = scriptIsStrict || evalNodeHasStrictScope(node);
    if (strict) {
      if (ts.isIdentifier(node)) {
        if (STRICT_RESERVED_WORDS.has(node.text) && strictReservedIdentifierIsInvalid(node)) {
          error = `'${node.text}' is reserved in strict eval code`;
          return;
        }
        if (STRICT_BINDING_NAMES.has(node.text) && identifierIsBindingName(node)) {
          error = `Binding '${node.text}' is not allowed in strict eval code`;
          return;
        }
      }

      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const restricted = restrictedAssignmentTarget(node.left);
        if (restricted !== undefined) {
          error = `Assignment to '${restricted}' is not allowed in strict eval code`;
          return;
        }
      }

      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const restricted = restrictedAssignmentTarget(node.operand);
        if (restricted !== undefined) {
          error = `Update of '${restricted}' is not allowed in strict eval code`;
          return;
        }
      }

      if (isFunctionLikeWithParameters(node)) {
        const names = new Set<string>();
        for (const param of node.parameters) {
          const duplicate = firstDuplicateBindingName(param.name, names);
          if (duplicate !== undefined) {
            error = `Duplicate parameter name '${duplicate}' in strict eval code`;
            return;
          }
        }
      }

      if (ts.isNumericLiteral(node)) {
        const raw = node.getText(sourceFile);
        if (/^0[0-9]+$/.test(raw) && !/^0[xXoObB]/.test(raw)) {
          error = "Legacy octal literals are not allowed in strict eval code";
          return;
        }
      }
    }

    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);
  return error;
}

/**
 * §15.1.1 Script early errors for `new.target` / SuperProperty / SuperCall.
 *
 * `Contains` deliberately does NOT descend into ordinary function forms (they
 * introduce their own NewTarget / [[HomeObject]]), but DOES descend into arrow
 * functions, which inherit both from the enclosing code. That asymmetry is the
 * whole point of the rule, so it is modelled here rather than reusing the
 * generic visitor above.
 */
function evalMetaPropertyEarlyError(sourceFile: ts.SourceFile, caller: EvalCallerCapabilities): string | undefined {
  let error: string | undefined;

  const visit = (node: ts.Node): void => {
    if (error !== undefined) return;
    // Opaque to `Contains` for these symbols — their own code supplies them.
    if (isMetaOpaqueFunctionForm(node)) return;

    if (!caller.newTarget && isNewTargetMetaProperty(node)) {
      error = "'new.target' is only allowed in eval code processed by a direct eval inside non-arrow function code";
      return;
    }
    if (node.kind === ts.SyntaxKind.SuperKeyword) {
      const parent = node.parent;
      const isCall = parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
      if (isCall) {
        if (!caller.superCall) {
          error = "'super' call is not allowed in this eval code";
          return;
        }
      } else if (!caller.superProperty) {
        error = "'super' property access is not allowed in this eval code";
        return;
      }
    }
    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);
  return error;
}

function isNewTargetMetaProperty(node: ts.Node): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === "target";
}

/** Function forms that `Contains` treats as opaque for new.target / super. */
function isMetaOpaqueFunctionForm(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * Classify a direct-eval CALL SITE for the rules above. Arrow functions are
 * transparent for `super` (an arrow borrows its method's [[HomeObject]]) but
 * NOT for `new.target` when the arrow is the outermost function form: §15.1.1
 * names ArrowFunction code explicitly as ineligible.
 */
export function evalCallerCapabilities(callSite: ts.Node, directEval: boolean): EvalCallerCapabilities {
  if (!directEval) return NO_CAPABILITIES;
  for (let cur: ts.Node | undefined = callSite; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if (ts.isArrowFunction(cur)) continue;
    if (ts.isMethodDeclaration(cur) || ts.isGetAccessorDeclaration(cur) || ts.isSetAccessorDeclaration(cur)) {
      return { newTarget: true, superProperty: true, superCall: false };
    }
    if (ts.isPropertyDeclaration(cur)) return { newTarget: true, superProperty: true, superCall: false };
    if (ts.isConstructorDeclaration(cur)) {
      return { newTarget: true, superProperty: true, superCall: constructorIsDerived(cur) };
    }
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)) {
      return { newTarget: true, superProperty: false, superCall: false };
    }
  }
  // Reached Script/Module top level: global code licenses none of the three.
  return NO_CAPABILITIES;
}

function constructorIsDerived(ctor: ts.ConstructorDeclaration): boolean {
  const cls = ctor.parent;
  if (cls === undefined || (!ts.isClassDeclaration(cls) && !ts.isClassExpression(cls))) return false;
  return (cls.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
}

function evalNodeHasStrictScope(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return true;
    if (isFunctionLikeWithParameters(current) && current.body && ts.isBlock(current.body)) {
      if (hasUseStrictDirective(current.body.statements)) return true;
    }
  }
  return false;
}

function hasUseStrictDirective(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    // §11.2.2 matches the RAW token — see helpers/use-strict-directive.ts.
    if (isUseStrictDirectiveExpression(statement.expression)) return true;
  }
  return false;
}

function strictReservedIdentifierIsInvalid(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function identifierIsBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return Boolean(
    parent &&
    ((ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionExpression(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isClassExpression(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.name === node) ||
      (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node)),
  );
}

function firstDuplicateBindingName(name: ts.BindingName, seen: Set<string>): string | undefined {
  if (ts.isIdentifier(name)) {
    if (seen.has(name.text)) return name.text;
    seen.add(name.text);
    return undefined;
  }
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    const duplicate = firstDuplicateBindingName(element.name, seen);
    if (duplicate !== undefined) return duplicate;
  }
  return undefined;
}

function isFunctionLikeWithParameters(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function restrictedAssignmentTarget(expr: ts.Expression): string | undefined {
  let target = expr;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  return ts.isIdentifier(target) && STRICT_BINDING_NAMES.has(target.text) ? target.text : undefined;
}

function isEvalIterationStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isEvalFunctionBoundary(node: ts.Node): boolean {
  return isFunctionLikeWithParameters(node) || ts.isClassStaticBlockDeclaration(node);
}

function labelTargetsIteration(statement: ts.Statement): boolean {
  let target = statement;
  while (ts.isLabeledStatement(target)) target = target.statement;
  return isEvalIterationStatement(target);
}

function evalContinueTargetExists(node: ts.ContinueStatement): boolean {
  const label = node.label?.text;
  for (let current: ts.Node | undefined = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (isEvalFunctionBoundary(current)) return false;
    if (label !== undefined) {
      if (ts.isLabeledStatement(current) && current.label.text === label) {
        return labelTargetsIteration(current.statement);
      }
    } else if (isEvalIterationStatement(current)) {
      return true;
    }
  }
  return false;
}

function evalBreakTargetExists(node: ts.BreakStatement): boolean {
  const label = node.label?.text;
  for (let current: ts.Node | undefined = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (isEvalFunctionBoundary(current)) return false;
    if (label !== undefined) {
      if (ts.isLabeledStatement(current) && current.label.text === label) return true;
    } else if (isEvalIterationStatement(current) || ts.isSwitchStatement(current)) {
      return true;
    }
  }
  return false;
}
