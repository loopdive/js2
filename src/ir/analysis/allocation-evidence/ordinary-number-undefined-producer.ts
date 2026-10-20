// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrInstr, type IrModule } from "../../core/nodes.js";
import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import { analyzeOwnership } from "../ownership.js";
import { analyzeEscape } from "../escape.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";
import { inspectOrdinaryNumberUndefinedBodies } from "./ordinary-number-undefined-body.js";

/** Use the real generic analyses; an actual returned box is never relabeled local. */
export function analyzeOrdinaryNumberUndefined(
  module: IrModule,
  registry: AllocSiteRegistry,
  deriveEscape: boolean,
): boolean {
  try {
    if (!inspectOrdinaryNumberUndefinedBodies(module, registry.snapshot())) return false;
  } catch (error) {
    if (error instanceof IrUnsupportedError) return false;
    throw error;
  }
  for (const fn of module.functions) {
    const prior = registry.snapshot();
    const marked = prior.metadata
      .filter((row) =>
        row.entries.some(
          ([key, value]) =>
            key === ALLOC_NAMESPACES.ownership &&
            value !== null &&
            typeof value === "object" &&
            Object.getOwnPropertyDescriptor(value, "stackCandidate")?.value === true,
        ),
      )
      .map((row) => row.id);
    const definitions = new Map<number, IrInstr>();
    const index = (buffer: readonly IrInstr[]) => {
      for (const instr of buffer) {
        if (instr.result !== null) definitions.set(instr.result, instr);
        forEachNestedBuffer(instr, index);
      }
    };
    for (const block of fn.blocks) index(block.instrs);
    const ownership = analyzeOwnership(fn, registry);
    for (const [value, annotation] of ownership.entries()) {
      void annotation;
      const definition = definitions.get(value);
      if (definition?.alloc !== undefined && marked.includes(definition.alloc) && ownership.isStackAllocatable(value)) {
        const current = registry.read<Record<string, unknown>>(definition.alloc, ALLOC_NAMESPACES.ownership);
        registry.annotate(definition.alloc, ALLOC_NAMESPACES.ownership, { ...current, stackCandidate: true });
      }
    }
    if (deriveEscape) analyzeEscape(fn, registry, ownership);
  }
  return true;
}
