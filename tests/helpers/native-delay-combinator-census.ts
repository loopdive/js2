// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "../../src/ir/program/prepared-contracts.js";
import type { PreparedIrFunction } from "../../src/ir/runtime/contracts/prepared.js";
import { forEachNestedBuffer, type IrInstr } from "../../src/ir/core/nodes.js";
import { irRuntimeFuncRef } from "../../src/ir/core/callable-bindings.js";
import { IR_NATIVE_PROMISE_DELAY_FN, IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../../src/ir/core/async-callables.js";
import type { IrFuncRef } from "../../src/ir/core/value-references.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import { preparedIrDataMismatch } from "../../src/ir/program/data.js";

type View = "program" | "projection";
interface Owner {
  readonly unitId: IrUnitId;
  readonly name: string;
}
interface Coordinate {
  readonly view: View;
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly rootKind: "block" | "async-plan" | "async-runtime";
  readonly rootIndex: number;
  readonly rootId: string | number;
  readonly path: readonly { readonly instructionIndex: number; readonly childBufferIndex: number }[];
}
export interface NativeDelayCombinatorCensus {
  readonly owners: { readonly program: readonly Owner[]; readonly projection: readonly Owner[] };
  readonly buffers: readonly (Coordinate & { readonly instructionCount: number })[];
  readonly calls: readonly (Coordinate & {
    readonly instructionIndex: number;
    readonly kind: "delay" | "all";
    readonly binding: IrFuncRef["binding"];
  })[];
}
function fail(message: string): never {
  throw new Error("independent B3 census: " + message);
}
function dense<T>(rows: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(rows)) fail("missing " + label);
  for (let index = 0; index < rows.length; index++)
    if (!Object.hasOwn(rows, index) || rows[index] === undefined || rows[index] === null) fail("sparse " + label);
  return rows;
}

/** Test-only expected-input scan. Never reads a requirements object or a production demand collector. */
export function nativeDelayCombinatorCensus(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeDelayCombinatorCensus {
  if (!dense(program.runtime, "runtime projections").includes(projection)) fail("foreign projection");
  const owners: { program: Owner[]; projection: Owner[] } = { program: [], projection: [] };
  const buffers: (Coordinate & { instructionCount: number })[] = [];
  const calls: (Coordinate & { instructionIndex: number; kind: "delay" | "all"; binding: IrFuncRef["binding"] })[] = [];
  const targets = [
    { kind: "delay" as const, binding: irRuntimeFuncRef(IR_NATIVE_PROMISE_DELAY_FN).binding },
    { kind: "all" as const, binding: irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN).binding },
  ];
  // Detect active-path cycles, not shared sibling/root buffers, which are distinct occurrences.
  const activeBuffers = new Set<readonly IrInstr[]>();
  const activeInstructions = new Set<IrInstr>();
  function visit(instructions: readonly IrInstr[], coordinate: Coordinate): void {
    dense(instructions, "instructions");
    if (activeBuffers.has(instructions)) fail("cyclic instruction buffer");
    activeBuffers.add(instructions);
    try {
      buffers.push({ ...coordinate, instructionCount: instructions.length });
      for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex++) {
        const instruction = instructions[instructionIndex]!;
        if (activeInstructions.has(instruction)) fail("cyclic instruction");
        activeInstructions.add(instruction);
        try {
          if (instruction.kind === "call") {
            const selected = targets.find(
              (target) => preparedIrDataMismatch(instruction.target.binding, target.binding) === undefined,
            );
            if (selected)
              calls.push({
                ...coordinate,
                instructionIndex,
                kind: selected.kind,
                binding: structuredClone(instruction.target.binding),
              });
          }
          let childBufferIndex = 0;
          forEachNestedBuffer(instruction, (child) => {
            visit(child, {
              ...coordinate,
              path: [...coordinate.path, { instructionIndex, childBufferIndex: childBufferIndex++ }],
            });
          });
        } finally {
          activeInstructions.delete(instruction);
        }
      }
    } finally {
      activeBuffers.delete(instructions);
    }
  }
  function scan(view: View, functions: readonly PreparedIrFunction[]): void {
    const ids = new Set<IrUnitId>();
    for (const fn of dense(functions, view + " functions")) {
      if (!fn.unitId || ids.has(fn.unitId)) fail("duplicate/missing " + view + " owner");
      ids.add(fn.unitId);
      owners[view].push({ unitId: fn.unitId, name: fn.name });
      // Owners with no roots remain in owners; real empty buffers remain in buffers.
      const root = (
        rootKind: Coordinate["rootKind"],
        rootIndex: number,
        rootId: string | number,
        instructions: readonly IrInstr[],
      ) =>
        visit(instructions, {
          view,
          ownerUnitId: fn.unitId,
          ownerName: fn.name,
          rootKind,
          rootIndex,
          rootId,
          path: [],
        });
      dense(fn.blocks, "blocks").forEach((block, index) => root("block", index, block.id, block.instrs));
      if (fn.asyncPlan)
        dense(fn.asyncPlan.states, "async-plan states").forEach((state, index) =>
          root("async-plan", index, state.id, state.body),
        );
      if (fn.asyncRuntime)
        dense(fn.asyncRuntime.states, "async-runtime states").forEach((state, index) =>
          root("async-runtime", index, state.id, state.body),
        );
    }
  }
  scan("program", program.ir.functions);
  scan("projection", projection.prepared.functions);
  return { owners, buffers, calls };
}
