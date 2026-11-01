// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7144 — the selector half of the shared operand / write admissibility rule
// for a planned function-member closure (#7106 Stage 4).
//
// A planned closure's body is walked once, after the shape walk admitted it.
// Every operator and every slot write is judged by the SAME predicates
// `ir/from-ast` consults when it lowers them
// (`analysis/operand-admissibility.ts`), over the families this file can prove
// before lowering. A family it cannot prove is `unknown`, which every predicate
// refuses — so a claim is never followed by a typing withdrawal of an operand
// the walk saw. The family proof mirrors how from-ast represents each value in
// a planned closure: the dynamic parameters and the catch binding are the
// boxed-any carrier, an f64-planned parameter is a number, an untyped local
// takes the family of its initializer (no initializer: the carrier's
// `undefined`), literals and operators produce their result family.

import { forEachChild, ts } from "../ts-api.js";
import { i32IdentityBitwiseOperand, isWrapI32Lowerable } from "./analysis/i32-slots.js";
import type { IrFunctionMemberClosurePlan } from "./function-member-closure-plan.js";
import type { IrDeclaredPrimitiveExpressionFamily } from "./module-bindings.js";
import {
  additiveOperandsProvable,
  additiveResultFamily,
  binaryOperandsAdmissible,
  carrierHelperCall,
  carrierInReceiver,
  carrierLooseOperator,
  carrierLooseEqualityAdmissible,
  carrierMethodCallAdmissible,
  carrierMemberReadAdmissible,
  compoundWriteAdmissible,
  conditionalJoinFamily,
  dynamicCallArgumentAdmissible,
  incrementSlotAdmissible,
  isEqualityOperator,
  isStrictEqualityOperator,
  isTypedBinaryOperator,
  isUndefinedCompareOperand,
  logicalResultFamily,
  nullComparisonFolds,
  undefinedCompareOperandAdmissible,
  nullishLeftAdmissible,
  nullValueAdmissible,
  slotWriteVerdict,
  storeAdmissible,
  switchDiscriminantAdmissible,
  throwOperandAdmissible,
  type AdditiveProof,
  type OperandFamily,
} from "./analysis/operand-admissibility.js";

/** The selector's own family proofs the walk builds on. */
export interface PlannedClosureFamilySources {
  /** `obviousSelectorValueFamily`: the syntactic family of a literal / operator result. */
  readonly obviousFamily: (
    expr: ts.Expression,
  ) => "number" | "boolean" | "string" | "reference" | "nullish" | undefined;
  /** The checker's declared primitive family (a call to a JSDoc-typed function, a module binding, …). */
  readonly declaredFamily?: (expr: ts.Expression) => IrDeclaredPrimitiveExpressionFamily | undefined;
  /** (#7113, #7193) The lane binds the carrier's `String` / `in` helpers in a prepared component. */
  readonly preparedDynamicHelpers?: boolean;
  /** (#7113, #7177) The lane's dynamic member read handles string and vec receivers. */
  readonly nativeDynamicMemberRead?: boolean;
  /** (#7113, #7193) The lane admits a carrier loose `==` / `!=` in a planned closure. */
  readonly nativeDynamicLooseEquality?: boolean;
  /** (#7113) The lane plans a direct call to a module function from a planned closure. */
  readonly directCalls?: boolean;
  /** (#7066) The lane formats a number as a string (a string `+` concatenates it). */
  readonly numberToString?: boolean;
  /** (#7113) `undefined` here is the global (no module or enclosing binding shadows it). */
  readonly isGlobalUndefined?: (expr: ts.Expression) => boolean;
  /** (#7119) `recv.<name>(…arity args)` on the carrier takes the brand-dispatch wrapper on this lane. */
  readonly wrappedMethodCall?: (name: string, arity: number) => boolean;
  /** (#7115) The never-written `var x = F.member;` locals: each holds the carrier for its whole life. */
  readonly functionObjectReadLocals?: ReadonlySet<string>;
}

/** The refused operator / write; selection reports it as `operand-coercion-unsupported`. */
export interface PlannedClosureOperandRefusal {
  readonly arm: string;
  readonly node: ts.Node;
}

interface OperandProof {
  readonly family: OperandFamily;
  readonly additive: AdditiveProof;
}

const UNKNOWN: OperandProof = { family: "unknown", additive: "unprovable" };
const DYNAMIC: OperandProof = { family: "dynamic", additive: "dynamic" };
const NUMBER: OperandProof = { family: "number", additive: "number" };
const STRING: OperandProof = { family: "string", additive: "string" };
const BOOLEAN: OperandProof = { family: "boolean", additive: "boolean" };

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isAssignmentOperator(op: ts.SyntaxKind): boolean {
  return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
}

/** The operand an equality compares with a direct `null` literal (`null === null`: none to type). */
function nullComparedOperand(expr: ts.BinaryExpression): ts.Expression | null {
  if (!isEqualityOperator(expr.operatorToken.kind)) return null;
  const leftNull = expr.left.kind === ts.SyntaxKind.NullKeyword;
  const rightNull = expr.right.kind === ts.SyntaxKind.NullKeyword;
  if (leftNull === rightNull) return null;
  return leftNull ? expr.right : expr.left;
}

function nullIsComparedOperand(node: ts.Node): boolean {
  const parent = node.parent;
  if (!ts.isBinaryExpression(parent) || !isEqualityOperator(parent.operatorToken.kind)) return false;
  return parent.left === node || parent.right === node;
}

/**
 * (#7113) Does the module declare `name` at top level — as a function only,
 * or (`functionsOnly` false) as any binding (function, class, variable,
 * import)? Syntactic: the module scope is what shadows a global.
 */
function moduleDeclares(file: ts.SourceFile, name: string, functionsOnly: boolean): boolean {
  return file.statements.some((statement) => {
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === name;
    if (functionsOnly) return false;
    if (ts.isClassDeclaration(statement)) return statement.name?.text === name;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
    }
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined) return false;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    return ts.isNamespaceImport(bindings)
      ? bindings.name.text === name
      : bindings.elements.some((element) => element.name.text === name);
  });
}

/** Is `comma` the `for` incrementor, or one of its clauses? */
function isForIncrementorClause(comma: ts.BinaryExpression): boolean {
  let node: ts.Expression = comma;
  while (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    node = node.parent;
  }
  return ts.isForStatement(node.parent) && node.parent.incrementor === node;
}

/**
 * The consumer a bare `null` value lowers into: a discarded expression (a
 * statement, a `void` operand, a comma's left side, an arm of a discarded
 * conditional) and a `throw` operand take the externref hint
 * (`lowerDiscardedExpression`, `lowerThrowStatement`); every other position
 * has a scalar or dynamic consumer, or one the walk does not type. (#7113) A
 * `for` incrementor's comma is not discarded: `lowerForUpdateExpr` splits it
 * into clauses and lowers each leaf under an f64 hint.
 */
function nullConsumerFamily(node: ts.Node): OperandFamily {
  let child = node;
  let throughConditional = false;
  for (let parent = node.parent; ; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return "externref";
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      if (parent.left === child) return isForIncrementorClause(parent) ? "unknown" : "externref";
      continue;
    }
    // A conditional's arms join into one value; only a discarded conditional
    // lowers each arm discarded.
    if (ts.isConditionalExpression(parent) && parent.condition !== child) {
      throughConditional = true;
      continue;
    }
    if (ts.isThrowStatement(parent) && !throughConditional) return "externref";
    return "unknown";
  }
}

/**
 * Whether a value `void x` — the f64 NaN sentinel for `undefined` — reaches a
 * consumer that reads it correctly or that the predicates judge: discarded
 * (also through a discarded conditional), a typed binary operand, the value of
 * a closure-slot write, a ToBoolean / ToNumber reader (`!`, `-`, `+`, `~`, a
 * condition), or (#7113) an arm of a conditional that `conditionalJoinFamily`
 * joins on the carrier, where from-ast yields the carrier's real `undefined`
 * instead of the NaN (the conditional's own consumer is judged as a dynamic
 * value). Anywhere else (a call argument, a member store, a declaration,
 * `typeof`, `throw`, another joined conditional arm) the NaN would be
 * observed as a number, or from-ast has no carrier box for it.
 */
function voidValueConsumerAdmissible(
  node: ts.VoidExpression,
  isClosureSlot: (name: string) => boolean,
  joinsOnCarrier: (conditional: ts.ConditionalExpression) => boolean,
): boolean {
  let child: ts.Node = node;
  let throughConditional = false;
  for (let parent = node.parent; ; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== child) {
      if (!throughConditional && joinsOnCarrier(parent)) return true;
      throughConditional = true;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) {
        if (parent.left === child) return true;
        continue;
      }
      if (throughConditional) return false;
      if (isTypedBinaryOperator(op)) return true;
      const target = unwrapParens(parent.left);
      return (
        isAssignmentOperator(op) && parent.right === child && ts.isIdentifier(target) && isClosureSlot(target.text)
      );
    }
    if (throughConditional) return false;
    if (ts.isPrefixUnaryExpression(parent)) {
      return (
        parent.operator === ts.SyntaxKind.ExclamationToken ||
        parent.operator === ts.SyntaxKind.MinusToken ||
        parent.operator === ts.SyntaxKind.PlusToken ||
        parent.operator === ts.SyntaxKind.TildeToken
      );
    }
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
      return parent.expression === child;
    }
    if (ts.isForStatement(parent)) return parent.condition === child;
    if (ts.isConditionalExpression(parent)) return true;
    return false;
  }
}

/**
 * The first operator or slot write in `fn`'s body that from-ast's typing would
 * withdraw, or `null` when every one the walk sees is admissible.
 */
export function plannedClosureOperandRefusal(
  plan: IrFunctionMemberClosurePlan,
  sources: PlannedClosureFamilySources,
): PlannedClosureOperandRefusal | null {
  const fn = plan.expression;
  const dynamicParameterNames = new Set<string>();
  const numericParameterNames = new Set<string>();
  fn.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const type = plan.signature.params[index];
    if (plan.dynamicParameterIndices.has(index)) dynamicParameterNames.add(parameter.name.text);
    else if (type?.kind === "val" && type.val.kind === "f64") numericParameterNames.add(parameter.name.text);
  });
  // Slot bindings: name → initializer (`null` = declared without one) or the
  // `"carrier"` marker for a catch binding. Parameters are resolved from the plan.
  const locals = new Map<string, ts.Expression | null | "carrier">();
  const collect = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !locals.has(node.name.text)) {
      locals.set(node.name.text, node.initializer ?? null);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      locals.set(node.variableDeclaration.name.text, "carrier");
    }
    forEachChild(node, collect);
  };
  if (fn.body) collect(fn.body);
  const isGlobalUndefined = (expr: ts.Expression): boolean =>
    !moduleDeclares(fn.getSourceFile(), "undefined", false) && sources.isGlobalUndefined?.(expr) !== false;
  const parameterNames = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
  const isClosureSlot = (name: string): boolean => locals.has(name) || parameterNames.has(name);

  const resolving = new Set<string>();
  const slotProof = (name: string): OperandProof => {
    const local = locals.get(name);
    if (local === undefined) {
      if (!parameterNames.has(name)) return UNKNOWN;
      if (dynamicParameterNames.has(name)) return DYNAMIC;
      return numericParameterNames.has(name) ? NUMBER : UNKNOWN;
    }
    if (local === "carrier" || local === null || sources.functionObjectReadLocals?.has(name)) return DYNAMIC;
    if (resolving.has(name)) return UNKNOWN;
    resolving.add(name);
    try {
      const proof = operandProof(local);
      // An identifier read of a dynamic slot produces the carrier (`expressionProducesDynamic`).
      return proof.family === "dynamic" ? DYNAMIC : proof;
    } finally {
      resolving.delete(name);
    }
  };

  const declared = (expr: ts.Expression): OperandProof => {
    // A primitive union proves nothing.
    switch (sources.declaredFamily?.(expr)) {
      case "number":
        return NUMBER;
      case "string":
        return STRING;
      case "boolean":
        return BOOLEAN;
      default:
        return UNKNOWN;
    }
  };

  // A call through a dynamic parameter or function-object read local
  // (`dynamicValueCallTarget`): its arguments are boxed and its result is the
  // carrier (`expressionProducesDynamic` follows the callee binding).
  const callsThroughCarrier = (name: string): boolean =>
    (parameterNames.has(name) || sources.functionObjectReadLocals?.has(name) === true) &&
    slotProof(name).family === "dynamic";

  const operandProof = (raw: ts.Expression): OperandProof => {
    const expr = unwrapParens(raw);
    if (ts.isIdentifier(expr) && isClosureSlot(expr.text)) return slotProof(expr.text);
    // (#7115) A plan whose body reads `this` binds it at entry through `dyn.current_this`.
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return DYNAMIC;
    // (#7113) The unshadowed global `undefined` lowers to the carrier's
    // `dyn.undefined` on the host-free lanes that mint a plan.
    if (ts.isIdentifier(expr) && expr.text === "undefined" && isGlobalUndefined(expr)) {
      return { family: "dynamic", additive: "unprovable" };
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const numeric = expr.elements.every((element) => operandProof(element).family === "number");
      return { family: numeric ? "vec<number>" : "vec<other>", additive: "unprovable" };
    }
    switch (sources.obviousFamily(expr)) {
      case "number":
        return NUMBER;
      case "string":
        return STRING;
      case "boolean":
        return BOOLEAN;
      case "nullish":
        return { family: "nullish", additive: "unprovable" };
      case "reference":
        return { family: "reference", additive: "unprovable" };
    }
    // A value `void` is the f64 sentinel for `undefined` (`irOperandFamily`).
    if (ts.isVoidExpression(expr)) return { family: "undefined", additive: "unprovable" };
    if (ts.isConditionalExpression(expr)) {
      const whenTrue = operandProof(expr.whenTrue);
      const whenFalse = operandProof(expr.whenFalse);
      // (#7113) A dynamic arm and a boxable / `void` arm join on the carrier.
      const family = conditionalJoinFamily(whenTrue.family, whenFalse.family);
      if (family === "unknown") return UNKNOWN;
      if (whenTrue.family !== whenFalse.family) return DYNAMIC;
      return whenTrue.additive === whenFalse.additive ? whenTrue : { ...whenTrue, additive: "unprovable" };
    }
    if (ts.isBinaryExpression(expr)) return binaryProof(expr);
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const receiver = operandProof(expr.expression);
      // A member of the carrier is the carrier (`expressionProducesDynamic`
      // follows the receiver).
      if (receiver.family === "dynamic" && receiver.additive === "dynamic") return DYNAMIC;
      if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length") {
        if (receiver.family === "string" || receiver.family === "vec<number>" || receiver.family === "vec<other>") {
          return NUMBER;
        }
      }
      if (ts.isElementAccessExpression(expr) && receiver.family === "vec<number>") return NUMBER;
      return declared(expr);
    }
    if (ts.isCallExpression(expr)) {
      const callee = unwrapParens(expr.expression);
      // A method call on the carrier, or a call through it, is the carrier.
      if (ts.isPropertyAccessExpression(callee) && operandProof(callee.expression).additive === "dynamic")
        return DYNAMIC;
      if (ts.isIdentifier(callee) && callsThroughCarrier(callee.text)) return DYNAMIC;
      return declared(expr);
    }
    if (
      ts.isNewExpression(expr) ||
      ts.isClassExpression(expr) ||
      expr.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      return { family: "reference", additive: "unprovable" };
    }
    return declared(expr);
  };

  const binaryProof = (expr: ts.BinaryExpression): OperandProof => {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.CommaToken) return operandProof(expr.right);
    // A write's value is its slot's (a chained `s = t = v` stores one value
    // into slots that must share the family).
    if (isAssignmentOperator(op)) {
      const target = unwrapParens(expr.left);
      return ts.isIdentifier(target) ? operandProof(target) : UNKNOWN;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const family = logicalResultFamily(operandProof(expr.left).family, operandProof(expr.right).family);
      return family === "boolean" ? BOOLEAN : UNKNOWN;
    }
    if (op === ts.SyntaxKind.PlusToken) {
      const left = operandProof(expr.left);
      const right = operandProof(expr.right);
      const family = additiveResultFamily(left.family, right.family);
      if (family === "dynamic") {
        return {
          family,
          additive: left.additive === "dynamic" || right.additive === "dynamic" ? "dynamic" : "unprovable",
        };
      }
      return family === "number" ? NUMBER : family === "string" ? STRING : UNKNOWN;
    }
    if (isTypedBinaryOperator(op)) return NUMBER;
    return UNKNOWN;
  };

  const binaryRefusal = (expr: ts.BinaryExpression): PlannedClosureOperandRefusal | null => {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      return nullishLeftAdmissible(operandProof(expr.left).family) ? null : { arm: "closure-nullish-left", node: expr };
    }
    if (isAssignmentOperator(op)) {
      const target = unwrapParens(expr.left);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const receiver = operandProof(target.expression).family;
        const value = operandProof(expr.right).family;
        return storeAdmissible(receiver, value, ts.isElementAccessExpression(target))
          ? null
          : { arm: "closure-member-store", node: expr };
      }
      // Writes to module bindings have their own lowerings; only a closure
      // slot is judged here.
      if (!ts.isIdentifier(target) || !isClosureSlot(target.text)) return null;
      const slot = slotProof(target.text).family;
      const value = operandProof(expr.right).family;
      if (op === ts.SyntaxKind.EqualsToken) {
        return slotWriteVerdict(slot, value) === "admissible" ? null : { arm: "closure-slot-write", node: expr };
      }
      return compoundWriteAdmissible(op, slot, value) ? null : { arm: "closure-compound-write", node: expr };
    }
    if (op === ts.SyntaxKind.InKeyword) {
      return sources.preparedDynamicHelpers || !carrierInReceiver(operandProof(expr.right).family)
        ? null
        : { arm: "closure-carrier-helper-operator", node: expr };
    }
    if (!isTypedBinaryOperator(op)) return null;
    // `tryFoldNullCompare` sees a DIRECT `null` operand only (`(null) === x`
    // lowers the literal like any operand).
    const other = nullComparedOperand(expr);
    if (other !== null) {
      // `null === undefined` (the identifier) has no lowering; `null === void 0` folds.
      const undefinedIdentifier = ts.isIdentifier(other) && other.text === "undefined" && !locals.has(other.text);
      return !undefinedIdentifier && nullComparisonFolds(op, operandProof(other).family)
        ? null
        : { arm: "closure-null-compare", node: expr };
    }
    // `x | 0` with an i32-lowerable `x` takes from-ast's fused-i32 identity
    // (no promoted slot is visible here, so only the slot-free shapes).
    const identityOperand = i32IdentityBitwiseOperand(expr);
    if (identityOperand !== null && isWrapI32Lowerable(identityOperand, () => false)) return null;
    // The strict `undefined` compare has its own lowering (`tryLowerUndefinedCompare`).
    const isShadowed = (name: string): boolean => locals.has(name);
    const leftUndefined = isUndefinedCompareOperand(expr.left, isShadowed);
    const rightUndefined = isUndefinedCompareOperand(expr.right, isShadowed);
    if (isStrictEqualityOperator(op) && (leftUndefined || rightUndefined)) {
      if (leftUndefined && rightUndefined) return null;
      const compared = operandProof(leftUndefined ? expr.right : expr.left).family;
      return undefinedCompareOperandAdmissible(compared) ? null : { arm: "closure-undefined-compare", node: expr };
    }
    const left = unwrapParens(expr.left);
    const right = unwrapParens(expr.right);
    const leftProof = operandProof(left);
    const rightProof = operandProof(right);
    if (!sources.nativeDynamicLooseEquality && carrierLooseOperator(op, leftProof.family, rightProof.family)) {
      return { arm: "closure-carrier-helper-operator", node: expr };
    }
    if (!carrierLooseEqualityAdmissible(op, leftProof.family, rightProof.family) && isNewShape()) {
      return { arm: "closure-carrier-loose-equality", node: expr };
    }
    if (
      op === ts.SyntaxKind.PlusToken &&
      !additiveOperandsProvable(leftProof.additive, rightProof.additive, sources.numberToString === true)
    ) {
      return { arm: "closure-additive-operands", node: expr };
    }
    return binaryOperandsAdmissible(op, leftProof.family, rightProof.family)
      ? null
      : { arm: "closure-binary-operands", node: expr };
  };

  // (#7113, #7177, #7195, #7198) A shape main never planned — a call-argument
  // or script-var closure, a closure that mints a joined carrier (`var r = m ? m : 1`) or a
  // throw-only body (the void plan of an oracle-`never` return). The carrier
  // reads / calls with a known IR bug are kept out of these new claims; the
  // closures main already claims keep their behaviour until #7177 lands.
  let newShape: boolean | undefined;
  const isNewShape = (): boolean => {
    if (newShape !== undefined) return newShape;
    const body = fn.body;
    const walk = (node: ts.Node, hit: (n: ts.Node) => boolean): boolean =>
      !(node !== fn && ts.isFunctionLike(node)) && (hit(node) || forEachChild(node, (c) => walk(c, hit)) === true);
    const mintsJoin = body !== undefined && walk(body, (n) => ts.isConditionalExpression(n) && joinsOnCarrier(n));
    const statements = body !== undefined && ts.isBlock(body) ? body.statements : undefined;
    const throwOnly =
      statements !== undefined &&
      statements.length > 0 &&
      ts.isThrowStatement(statements[statements.length - 1]!) &&
      !walk(body!, ts.isReturnStatement);
    newShape = plan.site !== "member-assignment" || mintsJoin || throwOnly;
    return newShape;
  };

  // (#7113) A call through the carrier boxes every argument; `String(carrier)`
  // and a direct call to a module function need lane support.
  const callRefusal = (expr: ts.CallExpression): PlannedClosureOperandRefusal | null => {
    const callee = unwrapParens(expr.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      !carrierMethodCallAdmissible(
        operandProof(callee.expression).family,
        sources.wrappedMethodCall?.(callee.name.text, expr.arguments.length) === true,
      ) &&
      isNewShape()
    ) {
      return { arm: "closure-carrier-method-call", node: expr };
    }
    if (ts.isIdentifier(callee) && !isClosureSlot(callee.text)) {
      const first = expr.arguments[0];
      if (
        !sources.preparedDynamicHelpers &&
        first &&
        carrierHelperCall(callee.text, operandProof(first).family) &&
        isNewShape()
      ) {
        return { arm: "closure-carrier-helper-call", node: expr };
      }
      if (!sources.directCalls && moduleDeclares(fn.getSourceFile(), callee.text, true) && isNewShape()) {
        return { arm: "closure-direct-call", node: expr };
      }
    }
    const throughCarrier = ts.isPropertyAccessExpression(callee)
      ? operandProof(callee.expression).family === "dynamic"
      : ts.isIdentifier(callee) && callsThroughCarrier(callee.text);
    if (!throughCarrier) return null;
    const argument = expr.arguments.find((arg) => !dynamicCallArgumentAdmissible(operandProof(arg).family));
    return argument === undefined ? null : { arm: "closure-dynamic-call-argument", node: argument };
  };

  // (#7113, #7177) A member / element read of the carrier (not a store
  // target, an update operand or a method callee — those have their own arms),
  // judged in a new shape only (`isNewShape`).
  const memberReadRefusal = (
    expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): PlannedClosureOperandRefusal | null => {
    let child: ts.Node = expr;
    while (ts.isParenthesizedExpression(child.parent)) child = child.parent;
    const parent = child.parent;
    if (ts.isCallExpression(parent) && parent.expression === child) return null;
    if (ts.isBinaryExpression(parent) && parent.left === child && isAssignmentOperator(parent.operatorToken.kind)) {
      return null;
    }
    if (ts.isDeleteExpression(parent)) return null;
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return null;
    }
    const property = ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
    const receiver = operandProof(expr.expression).family;
    if (carrierMemberReadAdmissible(receiver, property, sources.nativeDynamicMemberRead === true)) return null;
    return isNewShape() ? { arm: "closure-carrier-member-read", node: expr } : null;
  };

  const updateRefusal = (
    expr: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  ): PlannedClosureOperandRefusal | null => {
    if (expr.operator !== ts.SyntaxKind.PlusPlusToken && expr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
    const target = unwrapParens(expr.operand);
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const receiver = operandProof(target.expression).family;
      return storeAdmissible(receiver, "number", ts.isElementAccessExpression(target))
        ? null
        : { arm: "closure-member-store", node: expr };
    }
    if (!ts.isIdentifier(target) || !isClosureSlot(target.text)) return null;
    return incrementSlotAdmissible(slotProof(target.text).family)
      ? null
      : { arm: "closure-increment-slot", node: expr };
  };

  const joinsOnCarrier = (conditional: ts.ConditionalExpression): boolean => {
    const whenTrue = operandProof(conditional.whenTrue).family;
    const whenFalse = operandProof(conditional.whenFalse).family;
    return whenTrue !== whenFalse && conditionalJoinFamily(whenTrue, whenFalse) === "dynamic";
  };

  let refusal: PlannedClosureOperandRefusal | null = null;
  const visit = (node: ts.Node): void => {
    if (refusal !== null || (node !== fn && ts.isFunctionLike(node))) return;
    if (ts.isBinaryExpression(node)) refusal = binaryRefusal(node);
    else if (ts.isCallExpression(node)) refusal = callRefusal(node);
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      refusal = memberReadRefusal(node);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) refusal = updateRefusal(node);
    else if (node.kind === ts.SyntaxKind.NullKeyword && !nullIsComparedOperand(node)) {
      refusal = nullValueAdmissible(nullConsumerFamily(node)) ? null : { arm: "closure-null-value", node };
    } else if (ts.isVoidExpression(node) && !voidValueConsumerAdmissible(node, isClosureSlot, joinsOnCarrier)) {
      refusal = { arm: "closure-void-value", node };
    } else if (ts.isThrowStatement(node) && !throwOperandAdmissible(operandProof(node.expression).family)) {
      // (#7113) `lowerThrowStatement` has no box for an f64 / i32 value.
      refusal = { arm: "closure-throw-operand", node: node.expression };
    } else if (ts.isSwitchStatement(node) && !switchDiscriminantAdmissible(operandProof(node.expression).family)) {
      refusal = { arm: "closure-switch-discriminant", node: node.expression };
    } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      // (#7113) A regex literal in a planned closure has no lowering on any
      // lane that mints a plan: the prepared component cannot bind
      // `__ir_dyn_call_box` (standalone, native gc) and WASI has no
      // `env.RegExp_new` import (measured).
      refusal = { arm: "closure-regexp-literal", node };
    }
    if (refusal === null) forEachChild(node, visit);
  };
  if (fn.body) forEachChild(fn.body, visit);
  return refusal;
}
