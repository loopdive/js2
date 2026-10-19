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
import type { IrObjectReferenceLowering } from "../backend/handles.js";
import { objectReferenceFieldProvider, resolveObjectReference } from "./object-reference.js";

/**
 * Project BEFORE optimization: a foreign Get/Set may invoke arbitrary code.
 * Real call instructions give DCE, GVN and scheduling the existing call-effect
 * contract. Merely switching a field emitter after those passes is unsound.
 * This does not issue prepared ownership or publish any ABI/boundary metadata.
 */
export function projectObjectReferenceFunction(
  fn: IrFunction,
  resolve: (shape: IrObjectShape) => IrObjectReferenceLowering | null,
): IrFunction {
  const types = new Map<IrValueId, IrType>(fn.params.map((param) => [param.value, param.type]));
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => types.set(value, block.blockArgTypes[index]!));
    for (const instruction of block.instrs)
      forEachInstrDeep(instruction, (row) => {
        if (row.result !== null && row.resultType !== null) types.set(row.result, row.resultType);
      });
  }
  const project = (instructions: readonly IrInstr[]): readonly IrInstr[] =>
    instructions.map((instruction): IrInstr => {
      if (instruction.kind !== "object.get" && instruction.kind !== "object.set")
        return mapNestedBuffers(instruction, project);
      const type = types.get(instruction.value);
      if (type?.kind !== "object" || instruction.alloc !== undefined)
        throw new Error("reference-object projection: missing logical receiver or unexpected allocation identity");
      const reference = resolveObjectReference({ resolveObjectReference: resolve }, type.shape)!;
      const operation = instruction.kind === "object.get" ? "get" : "set";
      const fieldType =
        instruction.kind === "object.get" ? instruction.resultType : (types.get(instruction.newValue) ?? null);
      const target = objectReferenceFieldProvider(reference, type.shape, instruction.name, fieldType, operation);
      return {
        kind: "call",
        target,
        args: instruction.kind === "object.get" ? [instruction.value] : [instruction.value, instruction.newValue],
        result: instruction.result,
        resultType: instruction.resultType,
        ...(instruction.site ? { site: instruction.site } : {}),
      };
    });
  return { ...fn, blocks: fn.blocks.map((block) => ({ ...block, instrs: project(block.instrs) })) };
}
