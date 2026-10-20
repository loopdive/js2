// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachNestedBuffer,
  type IrModule,
  type IrInstr,
  type IrValueId,
  type AllocSiteId,
} from "../../core/nodes.js";
import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import { inspectNativeNumberUndefinedBodies } from "./native-number-undefined-body.js";

/** Finite native annotation producer; source facts and generic analyses remain unchanged. */
export function analyzeNativeNumberUndefined(
  module: IrModule,
  registry: AllocSiteRegistry,
  deriveEscape: boolean,
): boolean {
  if (!inspectNativeNumberUndefinedBodies(module, registry.snapshot())) return false;
  for (const fn of module.functions) {
    const roots = new Map<IrValueId, Set<AllocSiteId>>(),
      reads = new Set<AllocSiteId>(),
      sites = new Set<AllocSiteId>();
    const touch = (value: IrValueId) => {
      for (const site of roots.get(value) ?? []) reads.add(site);
    };
    const visit = (buffer: readonly IrInstr[]) => {
      for (const instr of buffer) {
        forEachNestedBuffer(instr, visit);
        if (
          (instr.kind === "vec.new_fixed" || instr.kind === "box") &&
          instr.result !== null &&
          instr.alloc !== undefined
        ) {
          sites.add(instr.alloc);
          roots.set(instr.result, new Set([instr.alloc]));
        } else if (instr.kind === "if" && instr.result !== null && instr.resultType?.kind === "dynamic") {
          roots.set(
            instr.result,
            new Set([...(roots.get(instr.thenValue) ?? []), ...(roots.get(instr.elseValue) ?? [])]),
          );
        }
        if (instr.kind === "vec.get" || instr.kind === "vec.len") touch(instr.vec);
        if (instr.kind === "tag.test" || instr.kind === "dyn.to_number") touch(instr.value);
        if (instr.kind === "dyn.eq") {
          touch(instr.lhs);
          touch(instr.rhs);
        }
      }
    };
    for (const block of fn.blocks) visit(block.instrs);
    for (const site of sites) {
      registry.annotate(site, ALLOC_NAMESPACES.ownership, {
        state: "owned",
        ops: reads.has(site) ? ["read"] : [],
      });
      if (deriveEscape)
        registry.annotate(site, ALLOC_NAMESPACES.escape, {
          classification: "local",
          stackAllocatable: true,
        });
    }
  }
  return true;
}
