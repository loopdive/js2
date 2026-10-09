// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { assertFinalAllocProvenance } from "../analysis/alloc-verification.js";
import type { AllocProvenanceLookup } from "../analysis/contracts/allocations.js";
import { forEachInstrDeep, type IrFunction } from "../core/nodes.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/** Preserve the final async-state and resolved-result checks after allocation analysis. */
export function assertPreparedIrFunctionAllocationTypesAndStates(fn: IrFunction, lookup: AllocProvenanceLookup): void {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `program allocations: ${detail}`);
  };
  // State buffers are executable semantic bodies too. The existing provenance
  // verifier accepts a function carrier, so reuse it over each exact buffer.
  for (const state of fn.asyncPlan?.states ?? []) {
    const block = fn.blocks[0];
    if (!block) invalid(`async owner ${fn.unitId} lacks a typed entry block`);
    assertFinalAllocProvenance({ ...fn, blocks: [{ ...block, instrs: state.body }] }, lookup);
  }
  for (const buffer of [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
  ])
    for (const root of buffer)
      forEachInstrDeep(root, (instruction) => {
        if (instruction.alloc === undefined) return;
        const site = lookup.resolve(instruction.alloc);
        if (!site) return invalid(`body ${fn.unitId} references stale site ${instruction.alloc}`);
        if (instruction.resultType && preparedIrTypeKey(site.type) !== preparedIrTypeKey(instruction.resultType))
          invalid(`site ${site.id} contradicts body ${fn.unitId}'s result type`);
      });
}
