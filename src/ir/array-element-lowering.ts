// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Representation-sensitive vector element lowering shared by the AST driver.
// Keeping these mechanics beside the array-element inference prevents
// `from-ast.ts` from accumulating another feature-specific lowering subsystem.

import { ts } from "../ts-api.js";

import { isCanonI32Lowerable, makePlannedI32Probe, planI32Slots, type IsPromotedI32 } from "./analysis/i32-slots.js";
import {
  EmptyArrayElementInference,
  inferEmptyArrayElementTypes,
  type ExactInt32Proof,
} from "./array-element-inference.js";
import { IrFunctionBuilder } from "./builder.js";
import { irIntrinsicFuncRef } from "./callable-bindings.js";
import type { I32PureNames } from "./i32-pure-bitwise.js";
import type { IrVecLowering } from "./lower.js";
import { asVal, irVal, type IrConst, type IrType, type IrValueId } from "./nodes.js";
import { demoteToLegacy, IrUnsupportedError } from "./outcomes.js";
import type { ValType } from "./types.js";
import { irVecElemSetSymbol } from "./vector-runtime.js";

interface ArrayElementResolver {
  resolveVec?(valType: ValType): IrVecLowering | null;
  resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
  resolveVecOutOfBoundsConst?(elementValType: ValType): IrConst | null;
  isVecValueExpression?(expression: ts.Expression): boolean;
  preparedAsyncPromiseVectorLocal?(declaration: ts.VariableDeclaration): boolean;
}

/**
 * Structural subset of `LowerCtx` used by element-representation mechanics.
 * The interface intentionally lives outside `from-ast.ts` so the subsystem
 * does not create a reverse dependency on the AST driver.
 */
export interface ArrayElementLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly resolver?: ArrayElementResolver;
  readonly checker?: ts.TypeChecker;
  readonly funcName: string;
  readonly emptyArrayInference: EmptyArrayElementInference;
  readonly i32PureNames: I32PureNames;
  readonly moduleBindings?: unknown;
}

const IR_F64: IrType = irVal({ kind: "f64" });
const PURE_PUSH_BINARY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

export interface CanonicalCountedPushPlan {
  readonly arrayLiteral: ts.ArrayLiteralExpression;
  readonly pushCall: ts.CallExpression;
  readonly capacity: number;
}

function unwrapPureExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Conservative side-effect/alias proof for the counted-push value. Identifier
 * reads and scalar operators are admitted; calls, member reads, mutation, and
 * any reference to the array under construction are rejected.
 */
function isPureNonAliasingPushValue(
  expression: ts.Expression,
  arrayName: string,
  checker: ts.TypeChecker | undefined,
): boolean {
  const candidate = unwrapPureExpression(expression);
  if (
    ts.isNumericLiteral(candidate) ||
    candidate.kind === ts.SyntaxKind.TrueKeyword ||
    candidate.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(candidate)) {
    if (candidate.text === arrayName || !checker) return false;
    const type = checker.getTypeAtLocation(candidate);
    return (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0;
  }
  if (ts.isPrefixUnaryExpression(candidate)) {
    if (
      candidate.operator !== ts.SyntaxKind.PlusToken &&
      candidate.operator !== ts.SyntaxKind.MinusToken &&
      candidate.operator !== ts.SyntaxKind.ExclamationToken &&
      candidate.operator !== ts.SyntaxKind.TildeToken
    ) {
      return false;
    }
    return isPureNonAliasingPushValue(candidate.operand, arrayName, checker);
  }
  if (ts.isBinaryExpression(candidate)) {
    if (!PURE_PUSH_BINARY_OPERATORS.has(candidate.operatorToken.kind)) return false;
    return (
      isPureNonAliasingPushValue(candidate.left, arrayName, checker) &&
      isPureNonAliasingPushValue(candidate.right, arrayName, checker)
    );
  }
  if (ts.isConditionalExpression(candidate)) {
    return (
      isPureNonAliasingPushValue(candidate.condition, arrayName, checker) &&
      isPureNonAliasingPushValue(candidate.whenTrue, arrayName, checker) &&
      isPureNonAliasingPushValue(candidate.whenFalse, arrayName, checker)
    );
  }
  return false;
}

function countedPushPlan(
  declaration: ts.VariableDeclaration,
  loop: ts.ForStatement,
  checker: ts.TypeChecker | undefined,
): CanonicalCountedPushPlan | null {
  if (!checker) return null;
  const declarationList = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    (declarationList.flags & ts.NodeFlags.Const) === 0 ||
    declarationList.declarations.length !== 1 ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isArrayLiteralExpression(declaration.initializer) ||
    declaration.initializer.elements.length !== 0
  ) {
    return null;
  }
  const arrayName = declaration.name.text;
  const arraySymbol = checker.getSymbolAtLocation(declaration.name);
  if (!arraySymbol) return null;

  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null;
  const indexDeclaration = initializer.declarations[0]!;
  if (
    !ts.isIdentifier(indexDeclaration.name) ||
    !indexDeclaration.initializer ||
    !ts.isNumericLiteral(indexDeclaration.initializer) ||
    indexDeclaration.initializer.text !== "0"
  ) {
    return null;
  }
  const indexName = indexDeclaration.name.text;
  const indexSymbol = checker.getSymbolAtLocation(indexDeclaration.name);
  if (!indexSymbol) return null;

  const condition = loop.condition;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== indexName ||
    checker.getSymbolAtLocation(condition.left) !== indexSymbol ||
    !ts.isNumericLiteral(condition.right)
  ) {
    return null;
  }
  const capacity = Number(condition.right.text);
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 1_000_000) return null;

  const incrementor = loop.incrementor;
  if (
    !incrementor ||
    (!ts.isPrefixUnaryExpression(incrementor) && !ts.isPostfixUnaryExpression(incrementor)) ||
    incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(incrementor.operand) ||
    incrementor.operand.text !== indexName ||
    checker.getSymbolAtLocation(incrementor.operand) !== indexSymbol
  ) {
    return null;
  }

  const statements = ts.isBlock(loop.statement) ? loop.statement.statements : [loop.statement];
  if (statements.length !== 1 || !ts.isExpressionStatement(statements[0])) return null;
  const expression = statements[0].expression;
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    ts.isSpreadElement(expression.arguments[0]!) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "push" ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== arrayName ||
    checker.getSymbolAtLocation(expression.expression.expression) !== arraySymbol ||
    !isPureNonAliasingPushValue(expression.arguments[0]!, arrayName, checker)
  ) {
    return null;
  }

  return { arrayLiteral: declaration.initializer, pushCall: expression, capacity };
}

/** Recover the exact adjacent allocation/loop proof from the empty literal. */
export function canonicalCountedPushPlanForLiteral(
  literal: ts.ArrayLiteralExpression,
  checker?: ts.TypeChecker,
): CanonicalCountedPushPlan | null {
  const declaration = literal.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== literal) return null;
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList)) return null;
  const statement = declarationList.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return null;
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  if (index < 0 || index + 1 >= statements.length) return null;
  const loop = statements[index + 1]!;
  return ts.isForStatement(loop) ? countedPushPlan(declaration, loop, checker) : null;
}

/** Recover the same proof from the push call lowered inside the loop body. */
export function canonicalCountedPushPlanForCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): CanonicalCountedPushPlan | null {
  const statement = call.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== call) return null;
  const loopBody = statement.parent;
  const loop = ts.isForStatement(loopBody)
    ? loopBody
    : ts.isBlock(loopBody) && loopBody.statements.length === 1 && ts.isForStatement(loopBody.parent)
      ? loopBody.parent
      : null;
  if (!loop || !ts.isBlock(loop.parent)) return null;
  const statements = loop.parent.statements;
  const index = statements.indexOf(loop);
  if (index <= 0) return null;
  const previous = statements[index - 1]!;
  if (!ts.isVariableStatement(previous) || previous.declarationList.declarations.length !== 1) return null;
  const plan = countedPushPlan(previous.declarationList.declarations[0]!, loop, checker);
  return plan?.pushCall === call ? plan : null;
}

/** Pre-lowering exact-int32 proof built from the i32 slot plan. */
export function plannedExactInt32Proof(
  slots: ReadonlySet<ts.VariableDeclaration> | undefined,
): ExactInt32Proof | undefined {
  if (slots === undefined) return undefined;
  const promoted = makePlannedI32Probe(slots);
  return (expression: ts.Expression): boolean => isCanonI32Lowerable(expression, promoted);
}

/** Plan i32 slots and array element inference from the same exact-int32 facts. */
export function planI32ArrayElements(
  fn: Parameters<typeof planI32Slots>[0],
  mutatedLets: ReadonlySet<string>,
  isGenerator: boolean,
  oracle?: Parameters<typeof inferEmptyArrayElementTypes>[1],
): {
  readonly i32Slots: ReadonlySet<ts.VariableDeclaration> | undefined;
  readonly emptyArrayInference: EmptyArrayElementInference;
} {
  const i32Slots = isGenerator ? undefined : planI32Slots(fn, mutatedLets);
  return {
    i32Slots,
    emptyArrayInference: inferEmptyArrayElementTypes(fn, oracle, plannedExactInt32Proof(i32Slots)),
  };
}

/**
 * Select the representation of an inferred empty `number[]`. Module-init and
 * backends without i32-vector support retain f64 storage.
 */
export function emptyLiteralElementValType(initializer: ts.Expression, host: ArrayElementLoweringHost): ValType {
  const f64: ValType = { kind: "f64" };
  if (host.moduleBindings !== undefined) return f64;
  if (!ts.isArrayLiteralExpression(initializer) || initializer.elements.length !== 0) return f64;
  const inference = host.emptyArrayInference.resultForLiteral(initializer);
  if (inference?.kind !== "resolved" || !inference.int32Narrowed) return f64;
  const i32: ValType = { kind: "i32" };
  return host.resolver?.resolveVecForElement?.(i32) ? i32 : f64;
}

/** Resolve an explicitly annotated empty-array representation. */
export function annotatedArrayElementValType(
  declaration: ts.VariableDeclaration,
  host: ArrayElementLoweringHost,
): ValType {
  const type = declaration.type;
  if (!type || !ts.isArrayTypeNode(type)) {
    // invariant (producer-promise): the carrier the producer promised was dropped — #4502.
    throw new Error(`ir/from-ast: annotated array '${declaration.name.getText()}' lost its array type`);
  }
  if (type.elementType.kind === ts.SyntaxKind.NumberKeyword) {
    return emptyLiteralElementValType(declaration.initializer!, host);
  }
  if (host.resolver?.preparedAsyncPromiseVectorLocal?.(declaration) === true) return { kind: "externref" };
  demoteToLegacy(
    "array-representation-unsupported",
    `ir/from-ast: array annotation on '${declaration.name.getText()}' must be number[] or a certified async vector`,
  );
}

/**
 * Distinguish a narrowed number[] from another i32-element vector, such as
 * boolean[]. The representation and the receiver-specific proof must agree.
 */
export function isNarrowedI32Vec(vec: IrVecLowering, receiver: ts.Expression, host: ArrayElementLoweringHost): boolean {
  return vec.elementValType.kind === "i32" && host.emptyArrayInference.isInt32NarrowedVectorExpression(receiver);
}

/**
 * Re-check invariant W at the store site. The live proof admits either an
 * i32-backed slot or a name proven int32-valued by the existing pure-name
 * analysis, making it at least as permissive as the plan-time proof.
 */
export function lowerNarrowedI32Element(
  value: ts.Expression,
  host: ArrayElementLoweringHost,
  promoted: IsPromotedI32,
  lower: (expression: ts.Expression) => IrValueId,
): IrValueId {
  const liveProof: IsPromotedI32 = (id) => promoted(id) || host.i32PureNames.has(id.text);
  if (!isCanonI32Lowerable(value, liveProof)) {
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: store into an i32-narrowed vector is not exact-i32 lowerable in ${host.funcName} (#3734)`,
    );
  }
  return lower(value);
}

interface VecPushLoweringOps {
  lowerExpr(expression: ts.Expression, expected: IrType): IrValueId;
  lowerNarrowedElement(expression: ts.Expression): IrValueId;
  coerceToExpectedExtern(value: IrValueId, expected: ValType, detail: string): IrValueId;
  describeType(type: IrType): string;
}

/**
 * Lower a supported `arr.push(value)` or return undefined when this call is
 * not a vec push. The caller owns expression lowering through narrow callbacks;
 * representation selection and vec-store mechanics stay in this subsystem.
 */
export function tryLowerVecPush(
  expr: ts.CallExpression,
  methodName: string,
  recv: IrValueId,
  recvType: IrType,
  statementPosition: boolean,
  host: ArrayElementLoweringHost,
  ops: VecPushLoweringOps,
): IrValueId | null | undefined {
  if (!ts.isPropertyAccessExpression(expr.expression)) return undefined;
  const receiverExpression = expr.expression.expression;
  if (methodName !== "push") return undefined;
  const vecRecvVal = asVal(recvType);
  const logicalElement = recvType.kind === "vec" ? asVal(recvType.elementType) : null;
  const vec = logicalElement
    ? host.resolver?.resolveVecForElement?.(logicalElement)
    : vecRecvVal
      ? host.resolver?.resolveVec?.(vecRecvVal)
      : null;
  if (!vec) return undefined;
  const scalarVecReceiver =
    (vec.valueType?.kind === "i32" || vecRecvVal?.kind === "i32") &&
    (host.resolver?.isVecValueExpression?.(receiverExpression) === true ||
      host.emptyArrayInference.isResolvedVectorExpression(receiverExpression));
  if (recvType.kind !== "vec" && (!vecRecvVal || (vecRecvVal.kind !== "ref" && !scalarVecReceiver))) {
    return undefined;
  }
  if (expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!)) {
    demoteToLegacy(
      "method-call-unsupported",
      `ir/from-ast: .push with ${expr.arguments.length} args / spread not in IR scope (single plain arg only) (${host.funcName})`,
    );
  }

  const elem = vec.elementValType;
  const narrowedI32 = isNarrowedI32Vec(vec, receiverExpression, host);
  if (!narrowedI32 && elem.kind !== "f64" && elem.kind !== "externref") {
    demoteToLegacy(
      "method-call-unsupported",
      `ir/from-ast: .push into '${elem.kind}' vec not in IR scope (${host.funcName})`,
    );
  }
  const lenF64 =
    scalarVecReceiver && host.emptyArrayInference.isResolvedVectorExpression(receiverExpression)
      ? emitForwardingAwareLinearVecLen(recv, host)
      : host.builder.emitVecLen(recv);
  const lenI32 = host.builder.emitUnary("i32.trunc_sat_f64_s", lenF64, irVal({ kind: "i32" }));
  const countedPush = canonicalCountedPushPlanForCall(expr, host.checker);
  let value: IrValueId;
  if (narrowedI32) {
    value = ops.lowerNarrowedElement(expr.arguments[0]!);
  } else {
    const raw = ops.lowerExpr(expr.arguments[0]!, irVal(elem));
    if (elem.kind === "f64") {
      if (asVal(host.builder.typeOf(raw))?.kind !== "f64") {
        demoteToLegacy(
          "method-call-unsupported",
          `ir/from-ast: .push value ${ops.describeType(host.builder.typeOf(raw))} into f64 vec ` +
            `not in IR scope (${host.funcName})`,
        );
      }
      value = raw;
    } else {
      value = ops.coerceToExpectedExtern(raw, elem, "value of .push");
    }
  }

  if (countedPush) {
    host.builder.emitVecSet(recv, lenI32, value);
    const one = host.builder.emitConst({ kind: "i32", value: 1 }, irVal({ kind: "i32" }));
    const nextLength = host.builder.emitBinary("i32.add", lenI32, one, irVal({ kind: "i32" }));
    host.builder.emitVecSetLength(recv, nextLength);
  } else {
    const symbol =
      recvType.kind === "vec" ? irVecElemSetSymbol(recvType.elementType) : `__vec_elem_set_${vec.vecStructTypeIdx}`;
    host.builder.emitCall(irIntrinsicFuncRef(symbol), [recv, lenI32, value], null);
  }
  if (statementPosition) return null;
  const one = host.builder.emitConst({ kind: "f64", value: 1 }, IR_F64);
  return host.builder.emitBinary("f64.add", lenF64, one, IR_F64);
}

/** Linear vec length reader that follows a forwarded growable header. */
export function emitForwardingAwareLinearVecLen(
  recv: IrValueId,
  host: Pick<ArrayElementLoweringHost, "builder" | "funcName">,
): IrValueId {
  const lenI32 = host.builder.emitCall(irIntrinsicFuncRef("__arr_len"), [recv], irVal({ kind: "i32" }));
  if (lenI32 === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: forwarding-aware vec length produced no value (${host.funcName})`);
  }
  return host.builder.emitUnary("f64.convert_i32_s", lenI32, IR_F64);
}

/**
 * Bounds-checked read of a narrowed i32 vector. Widening occurs inside the
 * in-bounds arm so the out-of-bounds arm can still produce numeric NaN.
 */
export function emitSafeNarrowedI32VecGet(
  recv: IrValueId,
  idxI32: IrValueId,
  host: Pick<ArrayElementLoweringHost, "builder">,
): IrValueId {
  const elemIr = irVal({ kind: "i32" });
  const lenI32 = host.builder.emitVecLenI32(recv);
  const cond = host.builder.emitBinary("i32.lt_u", idxI32, lenI32, elemIr);

  let thenValue!: IrValueId;
  const thenBody = host.builder.collectBodyInstrs(() => {
    thenValue = host.builder.emitUnary("f64.convert_i32_s", host.builder.emitVecGet(recv, idxI32, elemIr), IR_F64);
  });
  let elseValue!: IrValueId;
  const elseBody = host.builder.collectBodyInstrs(() => {
    elseValue = host.builder.emitConst({ kind: "f64", value: NaN }, IR_F64);
  });

  return host.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: elseBody,
    elseValue,
    resultType: IR_F64,
  });
}

/**
 * Bounds-checked vec read with the backend/default carrier preserved. Unsupported
 * non-nullable carriers demote rather than widening the downstream result type.
 */
export function emitSafeVecGet(
  recv: IrValueId,
  idxI32: IrValueId,
  elemValType: ValType,
  host: Pick<ArrayElementLoweringHost, "builder" | "resolver" | "funcName">,
): IrValueId {
  const elemIr = irVal(elemValType);
  let makeOobDefault: (() => IrValueId) | null = null;
  const backendDefault = host.resolver?.resolveVecOutOfBoundsConst?.(elemValType);
  if (backendDefault) {
    makeOobDefault = () => host.builder.emitConst(backendDefault, elemIr);
  } else {
    switch (elemValType.kind) {
      case "f64":
        makeOobDefault = () => host.builder.emitConst({ kind: "f64", value: NaN }, elemIr);
        break;
      case "i32":
        makeOobDefault = () => host.builder.emitConst({ kind: "i32", value: 0 }, elemIr);
        break;
      case "externref":
      case "ref_null":
        makeOobDefault = () => host.builder.emitConst({ kind: "null", ty: elemIr }, elemIr);
        break;
      default:
        demoteToLegacy(
          "array-representation-unsupported",
          `ir/from-ast: SAFE OOB vec read for element kind '${elemValType.kind}' needs legacy ` +
            `(no in-arm default without a result-type widen) in ${host.funcName}`,
        );
    }
  }

  const lenI32 = host.builder.emitVecLenI32(recv);
  const cond = host.builder.emitBinary("i32.lt_u", idxI32, lenI32, irVal({ kind: "i32" }));
  let thenValue!: IrValueId;
  const thenBody = host.builder.collectBodyInstrs(() => {
    thenValue = host.builder.emitVecGet(recv, idxI32, elemIr);
  });
  let elseValue!: IrValueId;
  const elseBody = host.builder.collectBodyInstrs(() => {
    elseValue = makeOobDefault!();
  });

  return host.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: elseBody,
    elseValue,
    resultType: elemIr,
  });
}
