// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Maximum-optimization fold for closed, ground export calls.
 *
 * This is deliberately an interpreter for a small, explicitly pure JavaScript
 * subset — it never executes user source with eval/Function/vm. The fold fires
 * only for a call over ground literals inside an exported function, whose
 * complete local call graph is available in the same source file, and whose
 * reachable functions pass the purity gate.
 *
 * Replacements are exactly the same byte length as the original expression
 * (JSON literal + spaces). Source offsets therefore remain stable and the
 * existing diagnostic/source-map PositionMap needs no new rewrite segment.
 */
import { ts } from "../ts-api.js";

const UNSUPPORTED = Symbol("ground-fold-unsupported");
type Unsupported = typeof UNSUPPORTED;

interface GroundArray {
  kind: "array";
  elements: GroundValue[];
}

interface GroundObject {
  kind: "object";
  entries: Map<string, GroundValue>;
}

interface GroundFunction {
  kind: "function";
  name: string;
}

type GroundValue = undefined | null | boolean | number | string | GroundArray | GroundObject | GroundFunction;

type ExecResult =
  | { kind: "normal" }
  | { kind: "break" }
  | { kind: "return"; value: GroundValue }
  | { kind: "unsupported" };

interface EvalState {
  functions: Map<string, ts.FunctionDeclaration>;
  emptyConstructors: Set<string>;
  calls: number;
  steps: number;
}

const MAX_CALLS = 256;
const MAX_STEPS = 20_000;
const NORMAL: ExecResult = { kind: "normal" };
const EXEC_UNSUPPORTED: ExecResult = { kind: "unsupported" };

function unwrap(expr: ts.Expression): ts.Expression {
  let value = expr;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function isGroundArray(value: GroundValue | Unsupported): value is GroundArray {
  return typeof value === "object" && value !== null && value.kind === "array";
}

function isGroundObject(value: GroundValue | Unsupported): value is GroundObject {
  return typeof value === "object" && value !== null && value.kind === "object";
}

function isGroundFunction(value: GroundValue | Unsupported): value is GroundFunction {
  return typeof value === "object" && value !== null && value.kind === "function";
}

function truthy(value: GroundValue): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return true;
}

function primitiveString(value: GroundValue): string | Unsupported {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return UNSUPPORTED;
}

function plus(left: GroundValue, right: GroundValue): GroundValue | Unsupported {
  if (typeof left === "string" || typeof right === "string") {
    const a = primitiveString(left);
    const b = primitiveString(right);
    return a === UNSUPPORTED || b === UNSUPPORTED ? UNSUPPORTED : a + b;
  }
  if (typeof left === "number" && typeof right === "number") return left + right;
  return UNSUPPORTED;
}

function propertyKey(value: GroundValue): string | Unsupported {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return UNSUPPORTED;
}

function abstractEqual(left: GroundValue, right: GroundValue): boolean | Unsupported {
  if (left === null || right === null || left === undefined || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  const leftObject = isGroundArray(left) || isGroundObject(left);
  const rightObject = isGroundArray(right) || isGroundObject(right);
  if (leftObject || rightObject) return leftObject && rightObject ? left === right : UNSUPPORTED;
  if (typeof left === typeof right) return left === right;
  if (typeof left === "boolean") return abstractEqual(Number(left), right);
  if (typeof right === "boolean") return abstractEqual(left, Number(right));
  if (typeof left === "number" && typeof right === "string") return left === Number(right);
  if (typeof left === "string" && typeof right === "number") return Number(left) === right;
  return false;
}

function getProperty(target: GroundValue, key: string): GroundValue | Unsupported {
  if (isGroundArray(target)) {
    if (key === "length") return target.elements.length;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 ? target.elements[index] : UNSUPPORTED;
  }
  if (isGroundObject(target)) return target.entries.get(key);
  if (typeof target === "string" && key === "length") return target.length;
  return UNSUPPORTED;
}

function assignTarget(
  target: ts.Expression,
  value: GroundValue,
  env: Map<string, GroundValue>,
  state: EvalState,
): GroundValue | Unsupported {
  const lhs = unwrap(target);
  if (ts.isIdentifier(lhs) && env.has(lhs.text)) {
    env.set(lhs.text, value);
    return value;
  }
  if (ts.isPropertyAccessExpression(lhs)) {
    const object = evaluateExpression(lhs.expression, env, state);
    if (!isGroundObject(object)) return UNSUPPORTED;
    object.entries.set(lhs.name.text, value);
    return value;
  }
  if (ts.isElementAccessExpression(lhs) && lhs.argumentExpression) {
    const object = evaluateExpression(lhs.expression, env, state);
    const rawKey = evaluateExpression(lhs.argumentExpression, env, state);
    if (!isGroundObject(object) || rawKey === UNSUPPORTED) return UNSUPPORTED;
    const key = propertyKey(rawKey);
    if (key === UNSUPPORTED) return UNSUPPORTED;
    object.entries.set(key, value);
    return value;
  }
  return UNSUPPORTED;
}

function evaluateCall(
  expr: ts.CallExpression,
  env: Map<string, GroundValue>,
  state: EvalState,
): GroundValue | Unsupported {
  const callee = unwrap(expr.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Array" &&
    callee.name.text === "isArray" &&
    expr.arguments.length === 1 &&
    !env.has("Array") &&
    !state.functions.has("Array")
  ) {
    const value = evaluateExpression(expr.arguments[0]!, env, state);
    return value === UNSUPPORTED ? UNSUPPORTED : isGroundArray(value);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const target = evaluateExpression(callee.expression, env, state);
    if (typeof target !== "string") return UNSUPPORTED;
    const args: GroundValue[] = [];
    for (const arg of expr.arguments) {
      if (ts.isSpreadElement(arg)) return UNSUPPORTED;
      const value = evaluateExpression(arg, env, state);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      args.push(value);
    }
    if (callee.name.text === "indexOf" && typeof args[0] === "string") {
      return target.indexOf(args[0], typeof args[1] === "number" ? args[1] : undefined);
    }
    if (callee.name.text === "lastIndexOf" && typeof args[0] === "string") {
      return target.lastIndexOf(args[0], typeof args[1] === "number" ? args[1] : undefined);
    }
    if (callee.name.text === "charCodeAt" && typeof args[0] === "number") return target.charCodeAt(args[0]);
    if (
      callee.name.text === "slice" &&
      typeof args[0] === "number" &&
      (args[1] === undefined || typeof args[1] === "number")
    ) {
      return target.slice(args[0], args[1]);
    }
    return UNSUPPORTED;
  }
  if (!ts.isIdentifier(callee)) return UNSUPPORTED;
  const bound = env.get(callee.text);
  const functionName = isGroundFunction(bound) ? bound.name : callee.text;
  if (env.has(callee.text) && !isGroundFunction(bound)) return UNSUPPORTED;
  const fn = state.functions.get(functionName);
  if (!fn || !fn.body || fn.asteriskToken || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return UNSUPPORTED;
  }
  const args: GroundValue[] = [];
  for (const arg of expr.arguments) {
    if (ts.isSpreadElement(arg)) return UNSUPPORTED;
    const value = evaluateExpression(arg, env, state);
    if (value === UNSUPPORTED) return UNSUPPORTED;
    args.push(value);
  }
  return evaluateFunction(fn, args, state);
}

function evaluateBinary(
  expr: ts.BinaryExpression,
  env: Map<string, GroundValue>,
  state: EvalState,
): GroundValue | Unsupported {
  const op = expr.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = evaluateExpression(expr.left, env, state);
    if (left === UNSUPPORTED || !truthy(left)) return left;
    return evaluateExpression(expr.right, env, state);
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    const left = evaluateExpression(expr.left, env, state);
    if (left === UNSUPPORTED || truthy(left)) return left;
    return evaluateExpression(expr.right, env, state);
  }
  if (op === ts.SyntaxKind.CommaToken) {
    if (evaluateExpression(expr.left, env, state) === UNSUPPORTED) return UNSUPPORTED;
    return evaluateExpression(expr.right, env, state);
  }
  if (op === ts.SyntaxKind.EqualsToken) {
    const value = evaluateExpression(expr.right, env, state);
    return value === UNSUPPORTED ? UNSUPPORTED : assignTarget(expr.left, value, env, state);
  }
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    const lhs = unwrap(expr.left);
    if (!ts.isIdentifier(lhs) || !env.has(lhs.text)) return UNSUPPORTED;
    const right = evaluateExpression(expr.right, env, state);
    if (right === UNSUPPORTED) return UNSUPPORTED;
    const value = plus(env.get(lhs.text), right);
    if (value === UNSUPPORTED) return UNSUPPORTED;
    env.set(lhs.text, value);
    return value;
  }

  const left = evaluateExpression(expr.left, env, state);
  if (left === UNSUPPORTED) return UNSUPPORTED;
  const right = evaluateExpression(expr.right, env, state);
  if (right === UNSUPPORTED) return UNSUPPORTED;
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return plus(left, right);
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return left === right;
    case ts.SyntaxKind.EqualsEqualsToken:
      return abstractEqual(left, right);
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return left !== right;
    case ts.SyntaxKind.ExclamationEqualsToken: {
      const equal = abstractEqual(left, right);
      return equal === UNSUPPORTED ? UNSUPPORTED : !equal;
    }
    case ts.SyntaxKind.LessThanToken:
      return typeof left === "number" && typeof right === "number" ? left < right : UNSUPPORTED;
    case ts.SyntaxKind.LessThanEqualsToken:
      return typeof left === "number" && typeof right === "number" ? left <= right : UNSUPPORTED;
    case ts.SyntaxKind.GreaterThanToken:
      return typeof left === "number" && typeof right === "number" ? left > right : UNSUPPORTED;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return typeof left === "number" && typeof right === "number" ? left >= right : UNSUPPORTED;
    case ts.SyntaxKind.MinusToken:
      return typeof left === "number" && typeof right === "number" ? left - right : UNSUPPORTED;
    default:
      return UNSUPPORTED;
  }
}

function evaluateExpression(
  input: ts.Expression,
  env: Map<string, GroundValue>,
  state: EvalState,
): GroundValue | Unsupported {
  if (++state.steps > MAX_STEPS) return UNSUPPORTED;
  const expr = unwrap(input);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expr)) {
    if (env.has(expr.text)) return env.get(expr.text);
    if (state.functions.has(expr.text)) return { kind: "function", name: expr.text };
    return expr.text === "undefined" ? undefined : UNSUPPORTED;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const elements: GroundValue[] = [];
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) return UNSUPPORTED;
      if (ts.isOmittedExpression(element)) {
        elements.push(undefined);
        continue;
      }
      const value = evaluateExpression(element, env, state);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      elements.push(value);
    }
    return { kind: "array", elements };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const entries = new Map<string, GroundValue>();
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return UNSUPPORTED;
      let name: string;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)) {
        name = prop.name.text;
      } else {
        return UNSUPPORTED;
      }
      const value = evaluateExpression(prop.initializer, env, state);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      entries.set(name, value);
    }
    return { kind: "object", entries };
  }
  if (ts.isTypeOfExpression(expr)) {
    const value = evaluateExpression(expr.expression, env, state);
    if (value === UNSUPPORTED) return UNSUPPORTED;
    if (value === null || isGroundArray(value) || isGroundObject(value)) return "object";
    return typeof value;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken) {
      const operand = unwrap(expr.operand);
      if (!ts.isIdentifier(operand) || !env.has(operand.text)) return UNSUPPORTED;
      const old = env.get(operand.text);
      if (typeof old !== "number") return UNSUPPORTED;
      const value = expr.operator === ts.SyntaxKind.PlusPlusToken ? old + 1 : old - 1;
      env.set(operand.text, value);
      return value;
    }
    const value = evaluateExpression(expr.operand, env, state);
    if (value === UNSUPPORTED) return UNSUPPORTED;
    if (expr.operator === ts.SyntaxKind.ExclamationToken) return !truthy(value);
    if (expr.operator === ts.SyntaxKind.PlusToken && typeof value === "number") return value;
    if (expr.operator === ts.SyntaxKind.MinusToken && typeof value === "number") return -value;
    return UNSUPPORTED;
  }
  if (ts.isConditionalExpression(expr)) {
    const condition = evaluateExpression(expr.condition, env, state);
    if (condition === UNSUPPORTED) return UNSUPPORTED;
    return evaluateExpression(truthy(condition) ? expr.whenTrue : expr.whenFalse, env, state);
  }
  if (ts.isNewExpression(expr)) {
    const callee = unwrap(expr.expression);
    if (!ts.isIdentifier(callee) || !state.emptyConstructors.has(callee.text) || expr.arguments?.length) {
      return UNSUPPORTED;
    }
    return { kind: "object", entries: new Map() };
  }
  if (ts.isPostfixUnaryExpression(expr)) {
    const operand = unwrap(expr.operand);
    if (!ts.isIdentifier(operand) || !env.has(operand.text)) return UNSUPPORTED;
    const old = env.get(operand.text);
    if (typeof old !== "number") return UNSUPPORTED;
    if (expr.operator === ts.SyntaxKind.PlusPlusToken) env.set(operand.text, old + 1);
    else if (expr.operator === ts.SyntaxKind.MinusMinusToken) env.set(operand.text, old - 1);
    else return UNSUPPORTED;
    return old;
  }
  if (ts.isBinaryExpression(expr)) return evaluateBinary(expr, env, state);
  if (ts.isCallExpression(expr)) return evaluateCall(expr, env, state);
  if (ts.isPropertyAccessExpression(expr)) {
    const target = evaluateExpression(expr.expression, env, state);
    if ((target === undefined || target === null) && expr.questionDotToken) return undefined;
    return target === UNSUPPORTED ? UNSUPPORTED : getProperty(target, expr.name.text);
  }
  if (ts.isElementAccessExpression(expr) && expr.argumentExpression) {
    const target = evaluateExpression(expr.expression, env, state);
    if ((target === undefined || target === null) && expr.questionDotToken) return undefined;
    if (target === UNSUPPORTED) return UNSUPPORTED;
    const rawKey = evaluateExpression(expr.argumentExpression, env, state);
    if (rawKey === UNSUPPORTED) return UNSUPPORTED;
    const key = propertyKey(rawKey);
    return key === UNSUPPORTED ? UNSUPPORTED : getProperty(target, key);
  }
  return UNSUPPORTED;
}

function executeVariableList(
  list: ts.VariableDeclarationList,
  env: Map<string, GroundValue>,
  state: EvalState,
): boolean {
  for (const decl of list.declarations) {
    if (!ts.isIdentifier(decl.name)) return false;
    if (!env.has(decl.name.text)) env.set(decl.name.text, undefined);
    if (decl.initializer) {
      const value = evaluateExpression(decl.initializer, env, state);
      if (value === UNSUPPORTED) return false;
      env.set(decl.name.text, value);
    }
  }
  return true;
}

function executeStatement(stmt: ts.Statement, env: Map<string, GroundValue>, state: EvalState): ExecResult {
  if (++state.steps > MAX_STEPS) return EXEC_UNSUPPORTED;
  if (ts.isBlock(stmt)) {
    for (const child of stmt.statements) {
      const result = executeStatement(child, env, state);
      if (result.kind !== "normal") return result;
    }
    return NORMAL;
  }
  if (ts.isVariableStatement(stmt)) {
    return executeVariableList(stmt.declarationList, env, state) ? NORMAL : EXEC_UNSUPPORTED;
  }
  if (ts.isExpressionStatement(stmt)) {
    return evaluateExpression(stmt.expression, env, state) === UNSUPPORTED ? EXEC_UNSUPPORTED : NORMAL;
  }
  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) return { kind: "return", value: undefined };
    const value = evaluateExpression(stmt.expression, env, state);
    return value === UNSUPPORTED ? EXEC_UNSUPPORTED : { kind: "return", value };
  }
  if (ts.isIfStatement(stmt)) {
    const condition = evaluateExpression(stmt.expression, env, state);
    if (condition === UNSUPPORTED) return EXEC_UNSUPPORTED;
    const branch = truthy(condition) ? stmt.thenStatement : stmt.elseStatement;
    return branch ? executeStatement(branch, env, state) : NORMAL;
  }
  if (ts.isForStatement(stmt)) {
    if (stmt.initializer) {
      const ok = ts.isVariableDeclarationList(stmt.initializer)
        ? executeVariableList(stmt.initializer, env, state)
        : evaluateExpression(stmt.initializer, env, state) !== UNSUPPORTED;
      if (!ok) return EXEC_UNSUPPORTED;
    }
    for (;;) {
      if (++state.steps > MAX_STEPS) return EXEC_UNSUPPORTED;
      if (stmt.condition) {
        const condition = evaluateExpression(stmt.condition, env, state);
        if (condition === UNSUPPORTED) return EXEC_UNSUPPORTED;
        if (!truthy(condition)) return NORMAL;
      }
      const result = executeStatement(stmt.statement, env, state);
      if (result.kind !== "normal") return result;
      if (stmt.incrementor && evaluateExpression(stmt.incrementor, env, state) === UNSUPPORTED) {
        return EXEC_UNSUPPORTED;
      }
    }
  }
  if (ts.isForInStatement(stmt)) {
    const subject = evaluateExpression(stmt.expression, env, state);
    if (subject === UNSUPPORTED) return EXEC_UNSUPPORTED;
    const keys = isGroundObject(subject)
      ? [...subject.entries.keys()]
      : isGroundArray(subject)
        ? subject.elements.map((_, index) => String(index))
        : null;
    if (!keys) return EXEC_UNSUPPORTED;
    for (const key of keys) {
      if (++state.steps > MAX_STEPS) return EXEC_UNSUPPORTED;
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        const decl = stmt.initializer.declarations[0];
        if (!decl || !ts.isIdentifier(decl.name)) return EXEC_UNSUPPORTED;
        env.set(decl.name.text, key);
      } else if (assignTarget(stmt.initializer, key, env, state) === UNSUPPORTED) {
        return EXEC_UNSUPPORTED;
      }
      const result = executeStatement(stmt.statement, env, state);
      if (result.kind !== "normal") return result;
    }
    return NORMAL;
  }
  if (ts.isDoStatement(stmt)) {
    for (;;) {
      if (++state.steps > MAX_STEPS) return EXEC_UNSUPPORTED;
      const result = executeStatement(stmt.statement, env, state);
      if (result.kind === "break") return NORMAL;
      if (result.kind !== "normal") return result;
      const condition = evaluateExpression(stmt.expression, env, state);
      if (condition === UNSUPPORTED) return EXEC_UNSUPPORTED;
      if (!truthy(condition)) return NORMAL;
    }
  }
  if (ts.isWhileStatement(stmt)) {
    for (;;) {
      if (++state.steps > MAX_STEPS) return EXEC_UNSUPPORTED;
      const condition = evaluateExpression(stmt.expression, env, state);
      if (condition === UNSUPPORTED) return EXEC_UNSUPPORTED;
      if (!truthy(condition)) return NORMAL;
      const result = executeStatement(stmt.statement, env, state);
      if (result.kind === "break") return NORMAL;
      if (result.kind !== "normal") return result;
    }
  }
  if (ts.isBreakStatement(stmt) && !stmt.label) return { kind: "break" };
  if (ts.isEmptyStatement(stmt)) return NORMAL;
  return EXEC_UNSUPPORTED;
}

function evaluateFunction(
  fn: ts.FunctionDeclaration,
  args: GroundValue[],
  state: EvalState,
): GroundValue | Unsupported {
  if (!fn.body || ++state.calls > MAX_CALLS) return UNSUPPORTED;
  const env = new Map<string, GroundValue>();
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i]!;
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer) {
      state.calls--;
      return UNSUPPORTED;
    }
    env.set(param.name.text, args[i]);
  }
  env.set("arguments", { kind: "array", elements: args });
  const result = executeStatement(fn.body, env, state);
  state.calls--;
  return result.kind === "return" ? result.value : UNSUPPORTED;
}

function hasExportModifier(fn: ts.FunctionDeclaration): boolean {
  return ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function locallyPure(
  fn: ts.FunctionDeclaration,
  functions: ReadonlyMap<string, ts.FunctionDeclaration>,
  emptyConstructors: ReadonlySet<string> = new Set(),
  allowLocalAggregateMutation = false,
): boolean {
  let pure = true;
  const locals = new Set<string>(
    fn.parameters.flatMap((param) => (ts.isIdentifier(param.name) ? [param.name.text] : [])),
  );
  const collectLocals = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) locals.add(node.name.text);
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(fn.body!);

  const visit = (node: ts.Node): void => {
    if (!pure) return;
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isThrowStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isDeleteExpression(node)
    ) {
      pure = false;
      return;
    }
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (!ts.isIdentifier(callee) || !emptyConstructors.has(callee.text) || node.arguments?.length) pure = false;
      if (!pure) return;
    }
    if (
      ts.isIdentifier(node) &&
      ["eval", "Function", "Proxy", "Reflect", "globalThis", "__proto__", "prototype"].includes(node.text)
    ) {
      pure = false;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const lhs = unwrap(node.left);
      const root =
        ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs) ? unwrap(lhs.expression) : lhs;
      if (!ts.isIdentifier(root) || !locals.has(root.text) || (!ts.isIdentifier(lhs) && !allowLocalAggregateMutation)) {
        pure = false;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrap(node.operand);
      if (!ts.isIdentifier(operand) || !locals.has(operand.text)) {
        pure = false;
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const localCall = ts.isIdentifier(callee) && functions.has(callee.text);
      const arrayBrandCall =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Array" &&
        callee.name.text === "isArray" &&
        !functions.has("Array");
      const localBoundCall = ts.isIdentifier(callee) && locals.has(callee.text);
      const pureStringMethod =
        ts.isPropertyAccessExpression(callee) &&
        ["indexOf", "lastIndexOf", "charCodeAt", "slice"].includes(callee.name.text);
      if (!localCall && !arrayBrandCall && !localBoundCall && !pureStringMethod) {
        pure = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body!);
  return pure;
}

function reachableFunctions(
  root: ts.FunctionDeclaration,
  functions: ReadonlyMap<string, ts.FunctionDeclaration>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const fn = queue.pop()!;
    const name = fn.name?.text;
    if (!name || reachable.has(name)) continue;
    reachable.add(name);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee)) {
          const next = functions.get(callee.text);
          if (next && !reachable.has(callee.text)) queue.push(next);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body!);
  }
  return reachable;
}

export interface GroundCallFoldResult {
  source: string;
  folded: number;
}

export interface GroundMultiCallFoldResult {
  files: Record<string, string>;
  folded: number;
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  return /\.(?:c|m)?js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function primitiveLiteral(value: GroundValue): string | null {
  if (
    value === undefined ||
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null)
  ) {
    return null;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) return null;
  return JSON.stringify(value) ?? null;
}

function normalizeModuleName(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveRelativeModule(
  fromFile: string,
  specifier: string,
  normalizedFiles: ReadonlyMap<string, string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const directory = normalizeModuleName(fromFile).split("/").slice(0, -1);
  const base = normalizeModuleName([...directory, specifier].join("/"));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.js`,
    `${base}/index.mjs`,
  ]) {
    const actual = normalizedFiles.get(candidate);
    if (actual) return actual;
  }
  return null;
}

function blankPreservingLines(source: string): string {
  return source.replace(/[^\r\n]/g, " ");
}

function emptyNullPrototypeConstructorFactory(input: ts.Expression): boolean {
  const expression = unwrap(input);
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = unwrap(expression.expression);
  if ((!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) || !ts.isBlock(callee.body)) return false;
  const [declarationStatement, prototypeStatement, returnStatement] = callee.body.statements;
  if (
    callee.body.statements.length !== 3 ||
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.declarationList.declarations.length !== 1 ||
    !prototypeStatement ||
    !ts.isExpressionStatement(prototypeStatement) ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression
  ) {
    return false;
  }
  const declaration = declarationStatement.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return false;
  const constructorExpression = unwrap(declaration.initializer);
  if (
    (!ts.isFunctionExpression(constructorExpression) && !ts.isArrowFunction(constructorExpression)) ||
    constructorExpression.parameters.length !== 0 ||
    !ts.isBlock(constructorExpression.body) ||
    constructorExpression.body.statements.length !== 0
  ) {
    return false;
  }
  const assignment = unwrap(prototypeStatement.expression);
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(assignment.left) ||
    assignment.left.name.text !== "prototype" ||
    !ts.isIdentifier(assignment.left.expression) ||
    assignment.left.expression.text !== declaration.name.text ||
    !ts.isCallExpression(assignment.right) ||
    assignment.right.arguments.length !== 1 ||
    assignment.right.arguments[0]?.kind !== ts.SyntaxKind.NullKeyword ||
    !ts.isPropertyAccessExpression(assignment.right.expression) ||
    !ts.isIdentifier(assignment.right.expression.expression) ||
    assignment.right.expression.expression.text !== "Object" ||
    assignment.right.expression.name.text !== "create" ||
    !ts.isIdentifier(returnStatement.expression) ||
    returnStatement.expression.text !== declaration.name.text
  ) {
    return false;
  }
  return true;
}

function classifyPureTopLevelConstants(statement: ts.VariableStatement, emptyConstructors: Set<string>): boolean {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return false;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return false;
    const initializer = unwrap(declaration.initializer);
    if (
      ts.isRegularExpressionLiteral(initializer) ||
      ts.isStringLiteral(initializer) ||
      ts.isNumericLiteral(initializer) ||
      initializer.kind === ts.SyntaxKind.TrueKeyword ||
      initializer.kind === ts.SyntaxKind.FalseKeyword ||
      initializer.kind === ts.SyntaxKind.NullKeyword
    ) {
      continue;
    }
    if (emptyNullPrototypeConstructorFactory(initializer)) {
      emptyConstructors.add(declaration.name.text);
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Fold a ground call nested inside the entry module of a closed multi-file
 * graph. It proves a pure literal-input expression once and emits its primitive
 * value directly, like ordinary constant folding.
 *
 * The first slice is deliberately narrow:
 * - every top-level declaration in the linked graph is a function/import/export;
 * - function names are unique across modules;
 * - candidates call a named import from the entry module with no shadowing;
 * - the complete reachable call graph passes the existing purity evaluator.
 *
 * Keeping the replacement byte-neutral preserves the multi-file diagnostic
 * offsets and source-map content.
 */
export function foldGroundCallsInMultiFilesForCompile(
  files: Record<string, string>,
  entryFile: string,
  optimize: boolean | number | undefined,
): Record<string, string> {
  if (optimize !== 4) return files;
  return foldGroundCallsInMultiFiles(files, entryFile).files;
}

export function foldGroundCallsInMultiFiles(
  files: Record<string, string>,
  entryFile: string,
): GroundMultiCallFoldResult {
  interface LinkedImport {
    declaration: ts.ImportDeclaration;
    targetFile: string;
    bindings: Map<string, string>;
  }

  const parsed = new Map<string, ts.SourceFile>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  const functionsByFile = new Map<string, Map<string, ts.FunctionDeclaration>>();
  const exportedByFile = new Map<string, Set<string>>();
  const importsByFile = new Map<string, LinkedImport[]>();
  const emptyConstructors = new Set<string>();
  const normalizedFiles = new Map(Object.keys(files).map((name) => [normalizeModuleName(name), name] as const));

  for (const [fileName, source] of Object.entries(files)) {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindForFile(fileName));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) return { files, folded: 0 };
    parsed.set(fileName, sourceFile);
    const moduleFunctions = new Map<string, ts.FunctionDeclaration>();
    const moduleExports = new Set<string>();
    functionsByFile.set(fileName, moduleFunctions);
    exportedByFile.set(fileName, moduleExports);

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        if (functions.has(stmt.name.text)) return { files, folded: 0 };
        functions.set(stmt.name.text, stmt);
        moduleFunctions.set(stmt.name.text, stmt);
        if (hasExportModifier(stmt)) moduleExports.add(stmt.name.text);
        continue;
      }
      if (ts.isImportDeclaration(stmt)) {
        // This first multi-file specialization slice allows dependencies to be
        // pure function modules, but not to have their own imports. That keeps
        // every unqualified helper call unambiguous without inventing a second
        // module resolver inside the evaluator.
        if (fileName !== entryFile || !ts.isStringLiteral(stmt.moduleSpecifier)) return { files, folded: 0 };
        const bindings = stmt.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return { files, folded: 0 };
        const targetFile = resolveRelativeModule(fileName, stmt.moduleSpecifier.text, normalizedFiles);
        if (!targetFile) return { files, folded: 0 };
        const importBindings = new Map<string, string>();
        for (const specifier of bindings.elements) {
          if (specifier.isTypeOnly) continue;
          importBindings.set(specifier.name.text, specifier.propertyName?.text ?? specifier.name.text);
        }
        if (importBindings.size === 0) return { files, folded: 0 };
        const linked: LinkedImport = { declaration: stmt, targetFile, bindings: importBindings };
        importsByFile.set(fileName, [...(importsByFile.get(fileName) ?? []), linked]);
        continue;
      }
      if (
        fileName !== entryFile &&
        ts.isVariableStatement(stmt) &&
        classifyPureTopLevelConstants(stmt, emptyConstructors)
      ) {
        continue;
      }
      if (ts.isExportAssignment(stmt) || ts.isEmptyStatement(stmt)) continue;
      return { files, folded: 0 };
    }
  }

  const entrySource = files[entryFile];
  const entryAst = parsed.get(entryFile);
  const linkedEntryImports = importsByFile.get(entryFile) ?? [];
  if (entrySource === undefined || !entryAst || linkedEntryImports.length === 0) return { files, folded: 0 };

  const entryImports = new Map<
    string,
    { importedName: string; target: ts.FunctionDeclaration; linked: LinkedImport }
  >();
  for (const linked of linkedEntryImports) {
    const targetFunctions = functionsByFile.get(linked.targetFile)!;
    const targetExports = exportedByFile.get(linked.targetFile)!;
    for (const [localName, importedName] of linked.bindings) {
      const target = targetFunctions.get(importedName);
      if (!target || !targetExports.has(importedName)) return { files, folded: 0 };
      if (localName !== importedName) {
        const collision = functions.get(localName);
        if (collision && collision !== target) return { files, folded: 0 };
        functions.set(localName, target);
      }
      entryImports.set(localName, { importedName, target, linked });
    }
  }

  // An imported name that is rebound anywhere in the entry module is not a
  // stable direct-call target. Reject it conservatively instead of attempting
  // to reproduce JavaScript lexical-resolution rules in this bounded pass.
  const shadowed = new Set<string>();
  const visitBindings = (node: ts.Node): void => {
    if (!ts.isImportSpecifier(node)) {
      const binding =
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)
          ? node.name
          : undefined;
      if (binding && ts.isIdentifier(binding) && entryImports.has(binding.text)) shadowed.add(binding.text);
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(entryAst);

  for (const localName of shadowed) entryImports.delete(localName);
  if (entryImports.size === 0) return { files, folded: 0 };

  const replacements: { start: number; end: number; text: string }[] = [];
  const tryFold = (node: ts.Node): boolean => {
    if (!ts.isExpression(node)) return false;

    const roots = new Set<ts.FunctionDeclaration>();
    const inspectedFunctions = new Set<ts.FunctionDeclaration>();
    const collectCalls = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const callee = unwrap(child.expression);
        if (ts.isIdentifier(callee) && entryImports.has(callee.text)) {
          roots.add(entryImports.get(callee.text)!.target);
        } else if (ts.isIdentifier(callee)) {
          const localFunction = functionsByFile.get(entryFile)?.get(callee.text);
          if (localFunction?.body && !inspectedFunctions.has(localFunction)) {
            inspectedFunctions.add(localFunction);
            collectCalls(localFunction.body);
          }
        }
      }
      ts.forEachChild(child, collectCalls);
    };
    collectCalls(node);
    if (roots.size === 0) return false;

    for (const root of roots) {
      const reachable = reachableFunctions(root, functions);
      if ([...reachable].some((name) => !locallyPure(functions.get(name)!, functions, emptyConstructors, true))) {
        return false;
      }
    }

    const state: EvalState = { functions, emptyConstructors, calls: 0, steps: 0 };
    const value = evaluateExpression(node, new Map(), state);
    if (value === UNSUPPORTED) return false;
    const literal = primitiveLiteral(value);
    if (literal === null) return false;
    const start = node.getStart(entryAst);
    const end = node.getEnd();
    if (literal.length > end - start) return false;
    replacements.push({ start, end, text: literal.padEnd(end - start, " ") });
    return true;
  };

  const visitExpressions = (node: ts.Node): void => {
    // Prefer the widest provable expression (`clsx(...).length` over its
    // nested `clsx(...)`) so downstream codegen sees the most precise scalar.
    if (tryFold(node)) return;
    ts.forEachChild(node, visitExpressions);
  };
  visitExpressions(entryAst);

  if (replacements.length === 0) return { files, folded: 0 };
  let rewritten = entrySource;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }

  // A folded call may make a private entry helper unreachable (for example an
  // observation helper that calls into a dependency and returns one scalar).
  // Compute liveness from every exported entry function while treating folded
  // ranges as leaves, then blank dead private helpers byte-for-byte.
  const entryFunctions = functionsByFile.get(entryFile)!;
  const liveEntryFunctions = new Set<ts.FunctionDeclaration>();
  const markLive = (fn: ts.FunctionDeclaration): void => {
    if (liveEntryFunctions.has(fn) || !fn.body) return;
    liveEntryFunctions.add(fn);
    const visit = (node: ts.Node): void => {
      if (
        replacements.some(
          (replacement) => node.getStart(entryAst) >= replacement.start && node.getEnd() <= replacement.end,
        )
      ) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee)) {
          const target = entryFunctions.get(callee.text);
          if (target) markLive(target);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  };
  for (const exportedName of exportedByFile.get(entryFile) ?? []) {
    const exportedFunction = entryFunctions.get(exportedName);
    if (exportedFunction) markLive(exportedFunction);
  }
  const deadEntryFunctionRanges: { start: number; end: number }[] = [];
  for (const fn of entryFunctions.values()) {
    if (hasExportModifier(fn) || liveEntryFunctions.has(fn)) continue;
    const start = fn.getStart(entryAst);
    const end = fn.getEnd();
    deadEntryFunctionRanges.push({ start, end });
    rewritten = rewritten.slice(0, start) + blankPreservingLines(rewritten.slice(start, end)) + rewritten.slice(end);
  }

  // IR models block-scoped locals. Canonicalize `var` to the byte-identical
  // `let` spelling only in a function whose folded expression we just proved,
  // and only when lexical scoping is observably equivalent: no nested closure,
  // no read before declaration, and for-head bindings never escape the loop.
  for (const statement of entryAst.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
    if (
      !replacements.some(
        (replacement) =>
          replacement.start >= statement.body!.getStart(entryAst) && replacement.end <= statement.body!.getEnd(),
      )
    ) {
      continue;
    }
    let hasNestedFunction = false;
    const detectNested = (node: ts.Node): void => {
      if (node !== statement && ts.isFunctionLike(node)) {
        hasNestedFunction = true;
        return;
      }
      ts.forEachChild(node, detectNested);
    };
    detectNested(statement.body);
    if (hasNestedFunction) continue;

    const lists: ts.VariableDeclarationList[] = [];
    const collectLists = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) lists.push(node);
      ts.forEachChild(node, collectLists);
    };
    collectLists(statement.body);
    for (const list of lists) {
      const names = list.declarations.map((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text : null,
      );
      if (names.some((name) => name === null) || new Set(names).size !== names.length) continue;
      const parent = list.parent;
      const scope =
        ts.isForStatement(parent) && parent.initializer === list
          ? parent
          : ts.isVariableStatement(parent) && parent.parent === statement.body
            ? statement.body
            : null;
      if (!scope) continue;

      let safe = true;
      const collectUses = (node: ts.Node): void => {
        if (!safe) return;
        if (
          ts.isIdentifier(node) &&
          names.includes(node.text) &&
          !list.declarations.some((declaration) => declaration.name === node)
        ) {
          if (node.getStart(entryAst) < list.getStart(entryAst)) safe = false;
          if (
            ts.isForStatement(parent) &&
            !(node.getStart(entryAst) >= scope.getStart(entryAst) && node.getEnd() <= scope.getEnd())
          ) {
            safe = false;
          }
        }
        ts.forEachChild(node, collectUses);
      };
      collectUses(statement.body);
      if (!safe) continue;
      const keywordStart = list.getStart(entryAst);
      rewritten = rewritten.slice(0, keywordStart) + "let" + rewritten.slice(keywordStart + 3);
    }
  }

  // Once every use of every binding from an import declaration lies inside a
  // folded range, the import itself is dead. Blank it byte-for-byte, then drop
  // newly unreachable pure dependency modules. Besides code size this removes
  // their generic value/string runtime from startup and compilation.
  const deadImports = new Set<LinkedImport>();
  for (const linked of linkedEntryImports) {
    let allBindingsDead = true;
    for (const localName of linked.bindings.keys()) {
      const references: ts.Identifier[] = [];
      const collectReferences = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === localName &&
          !(
            node.getStart(entryAst) >= linked.declaration.getStart(entryAst) &&
            node.getEnd() <= linked.declaration.getEnd()
          )
        ) {
          references.push(node);
        }
        ts.forEachChild(node, collectReferences);
      };
      collectReferences(entryAst);
      if (
        references.some(
          (reference) =>
            !replacements.some(
              (replacement) =>
                reference.getStart(entryAst) >= replacement.start && reference.getEnd() <= replacement.end,
            ) &&
            !deadEntryFunctionRanges.some(
              (range) => reference.getStart(entryAst) >= range.start && reference.getEnd() <= range.end,
            ),
        )
      ) {
        allBindingsDead = false;
        break;
      }
    }
    if (allBindingsDead) {
      deadImports.add(linked);
      const start = linked.declaration.getStart(entryAst);
      const end = linked.declaration.getEnd();
      rewritten = rewritten.slice(0, start) + blankPreservingLines(rewritten.slice(start, end)) + rewritten.slice(end);
    }
  }

  if (rewritten.length !== entrySource.length) throw new Error("multi ground-call fold changed source length");
  const reachableFiles = new Set<string>([entryFile]);
  for (const linked of linkedEntryImports) {
    if (!deadImports.has(linked)) reachableFiles.add(linked.targetFile);
  }
  const rewrittenFiles = { ...files, [entryFile]: rewritten };
  for (const [fileName, source] of Object.entries(files)) {
    if (!reachableFiles.has(fileName)) rewrittenFiles[fileName] = blankPreservingLines(source);
  }
  return { files: rewrittenFiles, folded: replacements.length };
}

export function foldGroundExportCallsForCompile(
  source: string,
  fileName: string,
  optimize: boolean | number | undefined,
  useJsGrammar: boolean,
): string {
  if (optimize !== 4) return source;
  return foldGroundExportCalls(source, fileName, useJsGrammar ? ts.ScriptKind.JS : ts.ScriptKind.TS).source;
}

export function foldGroundExportCalls(
  source: string,
  fileName = "input.ts",
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): GroundCallFoldResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) return { source, folded: 0 };

  const functions = new Map<string, ts.FunctionDeclaration>();
  const exportedNames = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      if (functions.has(stmt.name.text)) return { source, folded: 0 };
      functions.set(stmt.name.text, stmt);
      if (hasExportModifier(stmt)) exportedNames.add(stmt.name.text);
      continue;
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      exportedNames.add(stmt.expression.text);
      continue;
    }
    if (!ts.isEmptyStatement(stmt)) return { source, folded: 0 };
  }

  const replacements: { start: number; end: number; text: string }[] = [];
  for (const name of exportedNames) {
    const candidate = functions.get(name);
    if (!candidate?.body) continue;

    const ownerReachable = reachableFunctions(candidate, functions);
    if ([...exportedNames].some((exported) => !ownerReachable.has(exported))) continue;

    // A local binding with the same spelling as a top-level function makes
    // identifier resolution scope-dependent. Reject that spelling throughout
    // the exported function rather than attempting a partial scope resolver.
    const shadowed = new Set<string>();
    const collectBindings = (node: ts.Node): void => {
      if (node !== candidate && ts.isFunctionLike(node)) return;
      const binding =
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)
          ? node.name
          : undefined;
      if (binding && ts.isIdentifier(binding) && functions.has(binding.text)) shadowed.add(binding.text);
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(candidate);

    const tryFold = (node: ts.Node): boolean => {
      if (!ts.isExpression(node)) return false;

      const roots = new Set<ts.FunctionDeclaration>();
      const collectCalls = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) {
          const callee = unwrap(child.expression);
          if (ts.isIdentifier(callee) && !shadowed.has(callee.text)) {
            const target = functions.get(callee.text);
            if (target && target !== candidate) roots.add(target);
          }
        }
        ts.forEachChild(child, collectCalls);
      };
      collectCalls(node);
      if (roots.size === 0) return false;

      for (const root of roots) {
        const reachable = reachableFunctions(root, functions);
        if ([...reachable].some((reachableName) => !locallyPure(functions.get(reachableName)!, functions))) {
          return false;
        }
      }

      const state: EvalState = { functions, emptyConstructors: new Set(), calls: 0, steps: 0 };
      const value = evaluateExpression(node, new Map(), state);
      if (value === UNSUPPORTED) return false;
      const literal = primitiveLiteral(value);
      if (literal === null) return false;
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      if (literal.length > end - start) return false;
      replacements.push({ start, end, text: literal.padEnd(end - start, " ") });
      return true;
    };

    const visitExpressions = (node: ts.Node): void => {
      if (node !== candidate.body && ts.isFunctionLike(node)) return;
      // Prefer the widest provable expression so downstream codegen sees the
      // most precise scalar, then fall back to a nested ground call.
      if (tryFold(node)) return;
      ts.forEachChild(node, visitExpressions);
    };
    visitExpressions(candidate.body);
  }

  if (replacements.length === 0) return { source, folded: 0 };
  let rewritten = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  if (rewritten.length !== source.length) throw new Error("ground-call fold changed source length");
  return { source: rewritten, folded: replacements.length };
}
