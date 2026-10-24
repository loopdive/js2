// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Canonical prepared function values and ordered property calls. The AST driver
// supplies its current recursive/coercion operations; this module never imports it.
import { ts } from "../ts-api.js";
import { emitNativeTypeError } from "./native-errors.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrImportedCallLoweringPlan, IrTopLevelFunctionValueLoweringPlan } from "./ast-lowering-plans.js";
import type { IrFunctionMemberClosures } from "./function-member-closure-plan.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import type { IrUnitId } from "./identity.js";
import { JS_TAG_IDS } from "./runtime/js-tag-domain.js";
import { asVal, irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";

/** Source-owned plan values shared by top-level and lifted lowering contexts. */
export interface FunctionValueLoweringPlans {
  readonly importedCalls?: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues?: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly functionMemberClosures?: IrFunctionMemberClosures;
}

/** Keep all own keys, read order, and plan identities when forwarding a context. */
export function projectFunctionValueLoweringPlans(source: FunctionValueLoweringPlans | undefined): {
  readonly importedCalls: FunctionValueLoweringPlans["importedCalls"];
  readonly topLevelFunctionValues: FunctionValueLoweringPlans["topLevelFunctionValues"];
  readonly functionMemberClosures: FunctionValueLoweringPlans["functionMemberClosures"];
} {
  return {
    importedCalls: source?.importedCalls,
    topLevelFunctionValues: source?.topLevelFunctionValues,
    functionMemberClosures: source?.functionMemberClosures,
  };
}

export interface FunctionObjectLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly ownerUnitId: IrUnitId;
  readonly funcName: string;
  readonly dynamicCarrierIsExternref: () => boolean;
  readonly requireOwner: (ownerUnitId: IrUnitId) => void;
  readonly lowerExpression: (source: ts.Expression) => IrValueId;
  readonly boxConcrete: (value: IrValueId, type: IrType, source: ts.Expression) => IrValueId | null;
  readonly symbols: {
    readonly IR_DYN_CALL_BOX_FN: string;
    readonly IR_DYN_CALL_VALUE_FN: string;
    readonly IR_DYN_CALL_ARGUMENT_FN: string;
  };
}

/**
 * (#3214 B1) Read/create the canonical cached wrapper for one exact bare
 * top-level function-value site.  The codegen planning phase has already
 * materialized the matching symbolic trampoline/global declarations through
 * `ensureFuncClosureSingleton`; IR owns only the lazy access sequence.
 */
export function lowerTopLevelFunctionValue(
  plan: IrTopLevelFunctionValueLoweringPlan,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  cx.requireOwner(plan.ownerUnitId);
  if (plan.target.binding.kind !== "unit") {
    // invariant (producer-promise): identity resolution promised an exact unit — #4502.
    throw new Error(`ir/from-ast: top-level function value target ${plan.target.name} is not an exact unit`);
  }
  if (plan.trampoline.binding.kind !== "support") {
    // invariant (producer-promise): the prepared trampoline plan promised a compiler-support binding — #4502.
    throw new Error(`ir/from-ast: function-value trampoline ${plan.trampoline.name} is not compiler support`);
  }
  if (plan.accessor) {
    if (plan.accessor.binding.kind !== "support") {
      throw new Error(`ir/from-ast: function-value accessor ${plan.accessor.name} is not compiler support`);
    }
    const value = cx.builder.emitCall(plan.accessor, [], { kind: "callable", signature: plan.signature });
    if (value === null) throw new Error(`ir/from-ast: function-value accessor returned void (${cx.funcName})`);
    if (!plan.objectReceiver) return value;
    const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [value], irDynamic());
    if (dynamic === null) throw new Error("function-object projection returned void");
    return dynamic;
  }
  const cache = plan.cacheGlobal;
  const cached = cx.builder.emitGlobalGet(cache, irVal({ kind: "externref" }));
  const isNull = cx.builder.emitRefIsNull(cached);
  const thenBody = cx.builder.collectBodyInstrs(() => {
    const closure = cx.builder.emitClosureNew(plan.trampoline, plan.signature, [], []);
    const external = cx.builder.emitCoerceToExternref(closure);
    cx.builder.emitGlobalSet(cache, external);
  });
  cx.builder.emitIfStmt({ cond: isNull, then: thenBody, else: [] });
  // `callable<S>` is the source boundary type and lowers to the exact same
  // externref global carrier. Retagging the final read avoids an unsound
  // externref→closure cast while preserving singleton identity.
  return cx.builder.emitGlobalGet(cache, { kind: "callable", signature: plan.signature });
}

export function functionObjectDynamicValue(
  value: IrValueId,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  let type = cx.builder.typeOf(value);
  if (type.kind === "dynamic") return value;
  if (type.kind === "closure") {
    value = cx.builder.emitCallablePack(value, type.signature);
    type = cx.builder.typeOf(value);
  }
  const primitive = cx.boxConcrete(value, type, source);
  if (primitive !== null) return primitive;
  if (
    type.kind === "callable" ||
    type.kind === "object" ||
    type.kind === "class" ||
    type.kind === "extern" ||
    asVal(type)?.kind === "externref" ||
    asVal(type)?.kind === "ref" ||
    asVal(type)?.kind === "ref_null"
  ) {
    const external = type.kind === "callable" ? value : cx.builder.emitCoerceToExternref(value);
    const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [external], irDynamic());
    if (dynamic === null) throw new Error("function-object value projection returned void");
    return dynamic;
  }
  demoteToLegacy(
    "operand-coercion-unsupported",
    `ir/from-ast: function member operand has no canonical carrier (${cx.funcName})`,
  );
}

export function lowerFunctionObjectMemberCall(
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  if (access.questionDotToken || expr.questionDotToken || expr.arguments.some(ts.isSpreadElement)) {
    demoteToLegacy("method-call-unsupported", "optional/spread function-object member call is unsupported");
  }
  const receiver = cx.lowerExpression(access.expression);
  const keySource = ts.isPropertyAccessExpression(access) ? undefined : access.argumentExpression;
  const key = keySource
    ? functionObjectDynamicValue(cx.lowerExpression(keySource), keySource, cx)
    : cx.builder.emitBox(
        cx.builder.emitStringConst((access as ts.PropertyAccessExpression).name.text),
        irDynamic(JS_TAG_IDS.String),
      );
  const callee = cx.builder.emitDynMemberGet(receiver, key);
  const args = cx.builder.emitCall(irRuntimeFuncRef("__objvec_new"), [], irVal({ kind: "externref" }));
  if (args === null) throw new Error("native argument vector returned void");
  for (const argument of expr.arguments) {
    const value = functionObjectDynamicValue(cx.lowerExpression(argument), argument, cx);
    const external = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_ARGUMENT_FN),
      [value],
      irVal({ kind: "externref" }),
    );
    if (external === null) throw new Error("native argument projection returned void");
    cx.builder.emitCall(irRuntimeFuncRef("__objvec_push"), [args, external], null);
  }
  const externalCallee = cx.builder.emitCall(
    irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
    [callee],
    irVal({ kind: "externref" }),
  );
  const externalReceiver = cx.builder.emitCall(
    irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
    [receiver],
    irVal({ kind: "externref" }),
  );
  if (externalCallee === null || externalReceiver === null) throw new Error("native call projection returned void");
  const callable = cx.builder.emitCall(irRuntimeFuncRef("__is_callable"), [externalCallee], irVal({ kind: "i32" }));
  if (callable === null) throw new Error("native callable classifier returned void");
  const refusal = cx.builder.collectBodyInstrs(() => {
    emitNativeTypeError(cx.builder, "Value is not callable");
  });
  cx.builder.emitIfStmt({
    cond: cx.builder.emitUnary("i32.eqz", callable, irVal({ kind: "i32" })),
    then: refusal,
    else: [],
  });
  const result = cx.builder.emitCall(
    irRuntimeFuncRef("__apply_closure"),
    [externalCallee, externalReceiver, args],
    irVal({ kind: "externref" }),
  );
  if (result === null) throw new Error("native closure application returned void");
  const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [result], irDynamic());
  if (dynamic === null) throw new Error("function-object call result projection returned void");
  return dynamic;
}

/** The same per-AST proof is required on expression and discarded call paths. */
export function isPreparedFunctionObjectAccess(
  access: ts.Expression,
  plans: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan> | undefined,
): access is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
    ts.isIdentifier(access.expression) &&
    plans?.get(access.expression)?.objectReceiver === true
  );
}

export function lowerFunctionObjectPropertyWrite(
  receiver: IrValueId,
  name: string,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
): void {
  if (cx.dynamicCarrierIsExternref()) {
    const key = cx.builder.emitCoerceToExternref(cx.builder.emitStringConst(name));
    const value = functionObjectDynamicValue(cx.lowerExpression(source), source, cx);
    const externalReceiver = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
      [receiver],
      irVal({ kind: "externref" }),
    );
    const externalValue = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
      [value],
      irVal({ kind: "externref" }),
    );
    if (externalReceiver === null || externalValue === null) throw new Error("native write projection returned void");
    cx.builder.emitCall(irRuntimeFuncRef("__extern_set_strict"), [externalReceiver, key, externalValue], null);
    return;
  }
  const key = cx.builder.emitBox(cx.builder.emitStringConst(name), irDynamic(JS_TAG_IDS.String));
  const value = functionObjectDynamicValue(cx.lowerExpression(source), source, cx);
  cx.builder.emitDynMemberSet(receiver, key, value);
}
