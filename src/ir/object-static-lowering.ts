// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7338, #7339) Lowering of a call the `Object` statics table admits (`object-statics.ts`): the call's operands as
 * carriers, in source order, onto the lane's object runtime (`emitObjectStaticCall`, `emitOwnPropertyTest`).
 * from-ast supplies the plan, the runtime and the operand lowering through {@link ObjectStaticLoweringHost}.
 */
import type { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { DescriptorDefinition } from "./descriptor-literal.js";
import type { IrValueId } from "./nodes.js";
import type { ObjectStaticPlan } from "./object-statics.js";
import {
  emitObjectStaticCall,
  emitOwnPropertyTest,
  type ObjectStaticDefinitionValues,
  type ObjectStaticRuntime,
} from "./open-object-carrier.js";
import { refuseUnselected } from "./outcomes.js";

export interface ObjectStaticLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  /** No selector claimed the unit: a call the table declines is refused by name (`refuseUnselected`). */
  readonly unselected?: boolean | undefined;
  readonly runtime: ObjectStaticRuntime;
  /** The table's plan of `call`, on the producer's lane and program facts. */
  readonly plan: (call: ts.CallExpression) => ObjectStaticPlan | undefined;
  /** (#7339) `call` is in the fallback test row's territory (`isOwnPropertyTestTerritory`). */
  readonly isOwnPropertyTestTerritory: (call: ts.CallExpression) => boolean;
  /** `operand` as a `dynamic` carrier. */
  readonly lowerCarrier: (operand: ts.Expression, callName: string) => IrValueId;
}

/** A table call the admission declines: the selector refuses it, so after a selector's claim it is a drift. */
export function refuseObjectStatic(
  host: Pick<ObjectStaticLoweringHost, "unselected" | "funcName">,
  detail: string,
): never {
  return refuseUnselected(host.unselected, "call-resolution-unsupported", `ir/from-ast: ${detail} (${host.funcName})`);
}

/** A define's key (a literal stays static) and field values, each as a carrier (#7338, #7276). */
export function lowerDescriptorDefinition(
  { key, fields }: DescriptorDefinition,
  callName: string,
  lowerCarrier: ObjectStaticLoweringHost["lowerCarrier"],
): ObjectStaticDefinitionValues {
  return {
    key: typeof key === "string" ? key : lowerCarrier(key, callName),
    fields: fields.map(({ name, initializer }) => ({ name, value: lowerCarrier(initializer, callName) })),
  };
}

/**
 * An admitted `Object.<static>(…)`: every value and definition as a carrier, in source order, then
 * `emitObjectStaticCall`; (#7339) the fallback test row's receiver, then `emitOwnPropertyTest`, which lowers its key.
 * Null when the call is no table row on this lane, which leaves it to the other arms.
 */
export function lowerObjectStaticCall(expr: ts.CallExpression, host: ObjectStaticLoweringHost): IrValueId | null {
  const { builder, runtime, lowerCarrier } = host;
  const plan = host.plan(expr);
  if (plan === undefined) {
    if (!host.isOwnPropertyTestTerritory(expr)) return null;
    return refuseObjectStatic(host, "own-property test on a script var planned by neither #7335's arm nor the row");
  }
  if (plan.kind === "refused") {
    const name = (expr.expression as ts.PropertyAccessExpression).name.text;
    return refuseObjectStatic(host, `Object.${name} is not an admitted Object static: ${plan.refusal}`);
  }
  if (plan.kind === "test") {
    const { name, receiver, key } = plan.test;
    return emitOwnPropertyTest(
      builder,
      plan.test,
      lowerCarrier(receiver, name),
      () => lowerCarrier(key, name),
      runtime,
    );
  }
  const { name, operands, definitions } = plan.call;
  const values = operands.map((operand) =>
    operand.kind === "object" ? runtime.newObject(builder) : lowerCarrier(operand.expr, name),
  );
  const defined = definitions.map((definition) => lowerDescriptorDefinition(definition, name, lowerCarrier));
  return emitObjectStaticCall(builder, plan.call, values, defined, runtime);
}
