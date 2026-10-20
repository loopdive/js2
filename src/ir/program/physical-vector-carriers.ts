// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { NativeVectorResourcePlan } from "./native-vector-resources.js";

/** Descriptive inputs from the actual physical plan; no reservation or admission authority. */
export interface PhysicalVectorCarrierResources {
  readonly backend: string;
  readonly vectors: Pick<NativeVectorResourcePlan, "layouts">;
  readonly linearMemory?: { readonly memory?: object };
  /** Symbolic type owners actually reserved by this plan, never inferred source names. */
  readonly typeBindings?: ReadonlySet<string>;
}

function materializable(type: Extract<IrType, { kind: "vec" }>, resources: PhysicalVectorCarrierResources): boolean {
  if (type.layout)
    return (
      resources.backend === "wasmgc" &&
      resources.typeBindings?.has(irTypeBindingKey(type.layout.carrierType.binding)) === true &&
      resources.typeBindings.has(irTypeBindingKey(type.layout.dataType.binding))
    );
  if (type.elementType.kind !== "val" || type.elementType.typeRef) return false;
  const element = type.elementType.val.kind;
  if (resources.backend === "linear") return element === "f64" && resources.linearMemory?.memory !== undefined;
  return (
    resources.backend === "wasmgc" &&
    (element === "f64" || element === "externref") &&
    resources.vectors.layouts.includes(element)
  );
}

/** Census every body type lowering can project into a vector carrier before acceptance. */
export function physicalVectorCarrierGaps(
  fn: IrFunction,
  resources: PhysicalVectorCarrierResources,
): readonly { readonly unitId: IrUnitId; readonly detail: string }[] {
  const gaps: { unitId: IrUnitId; detail: string }[] = [];
  const note = (type: IrType, where: string): void => {
    if (type.kind === "vec" && !materializable(type, resources))
      gaps.push({
        unitId: fn.unitId,
        detail: `body ${fn.name} ${where} requires a vector carrier the plan cannot materialize`,
      });
  };
  fn.params.forEach((param, index) => note(param.type, `parameter ${index}`));
  fn.resultTypes.forEach((type, index) => note(type, `result ${index}`));
  fn.asyncPlan?.values.forEach((value, index) => note(value.type, `async value ${index}`));
  const inspect = (body: IrFunction["blocks"][number]["instrs"], where: string): void => {
    let ordinal = 0;
    for (const root of body)
      forEachInstrDeep(root, (instruction) => {
        const current = ordinal++;
        if (instruction.resultType)
          note(instruction.resultType, `${where} instruction ${current} (${instruction.kind})`);
      });
  };
  fn.blocks.forEach((block, index) => {
    block.blockArgTypes.forEach((type, argument) => note(type, `block ${index} argument ${argument}`));
    inspect(block.instrs, `block ${index}`);
  });
  fn.asyncPlan?.states.forEach((state, index) => inspect(state.body, `async state ${index}`));
  return gaps;
}
