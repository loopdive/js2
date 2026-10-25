// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrFunction, type IrInstr } from "../core/nodes.js";
import { irUnitCallableBindingId } from "../core/callable-bindings.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import type { AsyncFrameSetup } from "./async-frame-setup.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";
import { assertNativeValueResourcePlanFor } from "./native-value-resources.js";
import type { NativeValueResourcePlan } from "./native-value-resources.js";

/** Unrefined values travel unchanged; the owning unit planner must admit this representation. */
export function preparedOpaqueDynamicCarrier(type: IrType): ValType | undefined {
  return type.kind === "dynamic" && type.tag === undefined ? { kind: "externref" } : undefined;
}

function dynamicFunctionFacts(fn: IrFunction) {
  const instructions: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (instruction) => instructions.push(instruction));
  const types = [
    ...fn.params.map((param) => param.type),
    ...fn.resultTypes,
    ...(fn.slots?.map((slot) => slot.type) ?? []),
    ...fn.blocks.flatMap((block) => block.blockArgTypes),
    ...(fn.asyncPlan?.values.map((value) => value.type) ?? []),
    ...instructions.flatMap((instruction) =>
      "resultType" in instruction && instruction.resultType ? [instruction.resultType] : [],
    ),
  ];
  const dynamicValues = new Set<number>(
    fn.params.filter((param) => param.type.kind === "dynamic").map((param) => Number(param.value)),
  );
  for (const block of fn.blocks)
    block.blockArgs.forEach((value, index) => {
      if (block.blockArgTypes[index]?.kind === "dynamic") dynamicValues.add(Number(value));
    });
  for (const instruction of instructions)
    if ("resultType" in instruction && instruction.resultType?.kind === "dynamic" && instruction.result !== null)
      dynamicValues.add(Number(instruction.result));
  return { types: types.filter((type) => type.kind === "dynamic"), instructions, dynamicValues };
}

/** Admit unchanged values only for an authenticated frame or native source/value population. */
export function planPreparedDynamicUnits(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  setup: AsyncFrameSetup | undefined,
  source?: NativeSourceClosureRequirements,
  values?: NativeValueResourcePlan,
): { readonly units: readonly IrUnitId[]; readonly gaps: readonly { unitId: IrUnitId; detail: string }[] } {
  const candidates = new Set<IrUnitId>();
  const nativeCandidates = new Set<IrUnitId>();
  if (source && values) {
    assertNativeSourceClosureRequirementsCurrent(source);
    assertNativeValueResourcePlanFor(values, program, projection, "native-string");
    if (source.demands.program !== program || source.demands.projection !== projection)
      throw new Error("native dynamic source/value owners differ");
    for (const unit of source.units) nativeCandidates.add(unit.unitId);
  }
  for (const frame of setup?.frames ?? []) {
    if (frame.kind !== "host") continue;
    candidates.add(frame.owner);
    const calls = new Set(frame.calls.map((call) => call.bindingId));
    for (const derived of program.derivedUnits)
      if (
        derived.parentId === frame.owner &&
        derived.terminalOwnerId === frame.owner &&
        derived.role === "ir-async-state" &&
        calls.has(irUnitCallableBindingId(derived.id))
      )
        candidates.add(derived.id);
  }
  const units: IrUnitId[] = [];
  const gaps: { unitId: IrUnitId; detail: string }[] = [];
  for (const fn of projection.prepared.functions) {
    const facts = dynamicFunctionFacts(fn);
    if (!facts.types.length) continue;
    const reject = (detail: string) => gaps.push({ unitId: fn.unitId, detail });
    const host = projection.target === "host" && candidates.has(fn.unitId);
    const standalone = projection.target === "standalone" && nativeCandidates.has(fn.unitId);
    if (projection.backend !== "wasmgc" || (!host && !standalone)) {
      reject(`body ${fn.name} has no accepted dynamic value carrier`);
      continue;
    }
    if (facts.types.some((type) => !preparedOpaqueDynamicCarrier(type))) {
      reject(`body ${fn.name} requires a refined dynamic carrier contract`);
      continue;
    }
    let supported = true;
    for (const instruction of facts.instructions) {
      if (
        instruction.kind.startsWith("dyn.") ||
        (instruction.kind === "box" && instruction.toType.kind === "dynamic") ||
        ((instruction.kind === "unbox" ||
          instruction.kind === "tag.test" ||
          instruction.kind === "coerce.to_externref") &&
          facts.dynamicValues.has(Number(instruction.value)))
      ) {
        reject(`body ${fn.name} requires unsupported dynamic operation ${instruction.kind}`);
        supported = false;
      }
    }
    if (supported) units.push(fn.unitId);
  }
  return { units, gaps };
}
