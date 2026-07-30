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
import { IrUnsupportedError } from "./outcomes.js";
import type { ValType } from "./types.js";

interface ArrayElementResolver {
  resolveVec?(valType: ValType): IrVecLowering | null;
  resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
  resolveVecOutOfBoundsConst?(elementValType: ValType): IrConst | null;
  isVecValueExpression?(expression: ts.Expression): boolean;
}

/**
 * Structural subset of `LowerCtx` used by element-representation mechanics.
 * The interface intentionally lives outside `from-ast.ts` so the subsystem
 * does not create a reverse dependency on the AST driver.
 */
export interface ArrayElementLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly resolver?: ArrayElementResolver;
  readonly funcName: string;
  readonly emptyArrayInference: EmptyArrayElementInference;
  readonly i32PureNames: I32PureNames;
  readonly moduleBindings?: unknown;
}

const IR_F64: IrType = irVal({ kind: "f64" });

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
  const vecRecvVal = asVal(recvType);
  const scalarVecReceiver =
    vecRecvVal?.kind === "i32" &&
    (host.resolver?.isVecValueExpression?.(receiverExpression) === true ||
      host.emptyArrayInference.isResolvedVectorExpression(receiverExpression));
  if (methodName !== "push" || !vecRecvVal || (vecRecvVal.kind !== "ref" && !scalarVecReceiver)) {
    return undefined;
  }
  const vec = host.resolver?.resolveVec?.(vecRecvVal);
  if (!vec) return undefined;
  if (expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!)) {
    throw new Error(
      `ir/from-ast: .push with ${expr.arguments.length} args / spread not in IR scope (single plain arg only) (${host.funcName})`,
    );
  }

  const elem = vec.elementValType;
  const narrowedI32 = isNarrowedI32Vec(vec, receiverExpression, host);
  if (!narrowedI32 && elem.kind !== "f64" && elem.kind !== "externref") {
    throw new Error(`ir/from-ast: .push into '${elem.kind}' vec not in IR scope (${host.funcName})`);
  }
  const lenF64 =
    scalarVecReceiver && host.emptyArrayInference.isResolvedVectorExpression(receiverExpression)
      ? emitForwardingAwareLinearVecLen(recv, host)
      : host.builder.emitVecLen(recv);
  const lenI32 = host.builder.emitUnary("i32.trunc_sat_f64_s", lenF64, irVal({ kind: "i32" }));
  let value: IrValueId;
  if (narrowedI32) {
    value = ops.lowerNarrowedElement(expr.arguments[0]!);
  } else {
    const raw = ops.lowerExpr(expr.arguments[0]!, irVal(elem));
    if (elem.kind === "f64") {
      if (asVal(host.builder.typeOf(raw))?.kind !== "f64") {
        throw new Error(
          `ir/from-ast: .push value ${ops.describeType(host.builder.typeOf(raw))} into f64 vec ` +
            `not in IR scope (${host.funcName})`,
        );
      }
      value = raw;
    } else {
      value = ops.coerceToExpectedExtern(raw, elem, "value of .push");
    }
  }

  host.builder.emitCall(irIntrinsicFuncRef(`__vec_elem_set_${vec.vecStructTypeIdx}`), [recv, lenI32, value], null);
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
  const lenF64 = host.builder.emitVecLen(recv);
  const lenI32 = host.builder.emitUnary("i32.trunc_sat_f64_s", lenF64, elemIr);
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
        throw new Error(
          `ir/from-ast: SAFE OOB vec read for element kind '${elemValType.kind}' needs legacy ` +
            `(no in-arm default without a result-type widen) in ${host.funcName}`,
        );
    }
  }

  const lenF64 = host.builder.emitVecLen(recv);
  const lenI32 = host.builder.emitUnary("i32.trunc_sat_f64_s", lenF64, irVal({ kind: "i32" }));
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
