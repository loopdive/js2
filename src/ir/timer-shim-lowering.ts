// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrImportedCallLoweringPlan } from "./ast-lowering-plans.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrType, IrValueId } from "./nodes.js";

/** Validate the one compiler-owned timer capability ABI before lowering. */
export function requireCompilerTimerShimPlan(plan: IrImportedCallLoweringPlan): void {
  if (
    plan.ownerName === "setTimeout" &&
    plan.target.binding.kind === "import" &&
    plan.target.binding.module === "env" &&
    plan.target.binding.field === "__timer_set_timeout" &&
    plan.params.length === 2 &&
    plan.params[0]?.kind === "callable" &&
    plan.params[0].signature.params.length === 0 &&
    plan.params[0].signature.returnType === null &&
    plan.params[1]?.kind === "dynamic" &&
    plan.returnType?.kind === "dynamic" &&
    plan.optionalParams.size === 0 &&
    !plan.needsArgc &&
    plan.argcGlobal === undefined
  ) {
    return;
  }
  throw new Error("ir/from-ast: compiler timer shim plan lost its exact env capability ABI");
}

/** Box only the exact timer delay boundary; all other imported arguments pass through. */
export function timerArg(
  plan: IrImportedCallLoweringPlan,
  expected: IrType,
  actual: IrType,
  value: IrValueId,
  box: () => IrValueId | null,
): IrValueId {
  return plan.source === "compiler-timer-shim" && expected.kind === "dynamic" && actual.kind !== "dynamic"
    ? (box() ?? value)
    : value;
}

/** Seal the capability's dynamic handle as the timer shim's numeric return. */
export function timerResult(
  result: IrValueId | null,
  builder: Pick<IrFunctionBuilder, "typeOf" | "emitDynToNumber">,
  funcName: string,
): IrValueId {
  if (result === null || builder.typeOf(result).kind !== "dynamic") {
    throw new Error(`ir/from-ast: compiler timer shim capability returned the wrong carrier (${funcName})`);
  }
  return builder.emitDynToNumber(result);
}
