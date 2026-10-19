// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachInstrDeep,
  mapNestedBuffers,
  type IrFunction,
  type IrInstr,
  type IrObjectShape,
  type IrType,
  type IrValueId,
} from "../core/nodes.js";
import type { IrFuncRef } from "../core/value-references.js";
import { irTypeEquals } from "../core/types.js";

export type IrObjectPropertyResolver = (
  shape: IrObjectShape,
  name: string,
  fieldType: IrType | null,
  operation: "get" | "set",
  failureMode?: "throw" | "ignore",
) => IrFuncRef;

/**
 * Project BEFORE optimization: a foreign Get/Set may invoke arbitrary code.
 * Real call instructions give DCE, GVN and scheduling the existing call-effect
 * contract. Merely switching a field emitter after those passes is unsound.
 * This does not issue prepared ownership or publish any ABI/boundary metadata.
 */
export function projectObjectPropertyCalls(fn: IrFunction, resolve: IrObjectPropertyResolver): IrFunction {
  const types = new Map<IrValueId, IrType>(fn.params.map((param) => [param.value, param.type]));
  fn.asyncPlan?.values.forEach((value) => types.set(value.value, value.type));
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => types.set(value, block.blockArgTypes[index]!));
    for (const instruction of block.instrs)
      forEachInstrDeep(instruction, (row) => {
        if (row.result !== null && row.resultType !== null) types.set(row.result, row.resultType);
      });
  }
  for (const state of fn.asyncPlan?.states ?? [])
    for (const instruction of state.body)
      forEachInstrDeep(instruction, (row) => {
        if (row.result !== null && row.resultType !== null) types.set(row.result, row.resultType);
      });
  const project = (instructions: readonly IrInstr[]): readonly IrInstr[] =>
    instructions.map((instruction): IrInstr => {
      if (instruction.kind !== "object.get" && instruction.kind !== "object.set")
        return mapNestedBuffers(instruction, project);
      const type = types.get(instruction.value);
      if (type?.kind !== "object" || instruction.alloc !== undefined)
        throw new Error("reference-object projection: missing logical receiver or unexpected allocation identity");
      const operation = instruction.kind === "object.get" ? "get" : "set";
      const fieldType =
        instruction.kind === "object.get" ? instruction.resultType : (types.get(instruction.newValue) ?? null);
      const field = type.shape.fields.find((row) => row.name === instruction.name);
      if (!field || !fieldType || !irTypeEquals(field.type, fieldType))
        throw new Error("reference-object projection: different logical field contract");
      const target = resolve(
        type.shape,
        instruction.name,
        fieldType,
        operation,
        instruction.kind === "object.set" ? instruction.failureMode : undefined,
      );
      return {
        kind: "call",
        target,
        args: instruction.kind === "object.get" ? [instruction.value] : [instruction.value, instruction.newValue],
        result: instruction.result,
        resultType: instruction.resultType,
        ...(instruction.site ? { site: instruction.site } : {}),
      };
    });
  return {
    ...fn,
    blocks: fn.blocks.map((block) => ({ ...block, instrs: project(block.instrs) })),
    ...(fn.asyncPlan
      ? {
          asyncPlan: {
            ...fn.asyncPlan,
            states: fn.asyncPlan.states.map((state) => ({ ...state, body: project(state.body) })),
          },
        }
      : {}),
  };
}
