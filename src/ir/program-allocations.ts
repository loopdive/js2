// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { AllocSiteRegistry, ALLOC_NAMESPACES } from "./alloc-registry.js";
import { analyzeOwnership } from "./analysis/ownership.js";
import { analyzeEscape } from "./analysis/escape.js";
import { analyzeEncoding } from "./analysis/encoding.js";
import { asAllocSiteId, forEachInstrDeep, type IrFunction } from "./nodes.js";
import { preparedIrDataKey, preparedIrTypeKey } from "./program-abi-contracts.js";
import { PreparedIrProgramInvariantError, type PreparedIrProgram } from "./program.js";
import { assertFinalAllocProvenance } from "./verify-alloc.js";

/** Reconstruct the existing registry's read authority, then verify every final artifact. */
export function assertPreparedIrProgramAllocations(program: Pick<PreparedIrProgram, "allocations" | "ir">): void {
  const snapshot = program.allocations;
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `program allocations: ${detail}`);
  };
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size < 0 ||
    snapshot.entries.length !== snapshot.size
  )
    invalid("invalid snapshot denominator");
  const registry = new AllocSiteRegistry();
  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.state === "live") {
      if (entry.site.id !== index) invalid(`site ${index} has a foreign identity`);
      registry.fresh(entry.site.kind, entry.site.type, entry.site.origin);
    } else {
      if (entry.state !== "aliased" && entry.state !== "retired")
        invalid(`site ${index} has an unknown provenance state`);
      registry.fresh("object", { kind: "val", val: { kind: "i32" } });
    }
  }
  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.state !== "aliased") continue;
    const seen = new Set<number>([index]);
    let target = entry.to as number;
    while (true) {
      if (!Number.isSafeInteger(target) || target < 0 || target >= snapshot.size || seen.has(target))
        invalid(`site ${index} has broken/cyclic provenance`);
      seen.add(target);
      const next = snapshot.entries[target]!;
      if (next.state !== "aliased") break;
      target = next.to as number;
    }
    registry.alias(asAllocSiteId(index), asAllocSiteId(target));
  }
  for (const [index, entry] of snapshot.entries.entries())
    if (entry.state === "retired") registry.retire(asAllocSiteId(index));
  const metadataIds = new Set<number>();
  const requestedNamespaces = new Set<string>([ALLOC_NAMESPACES.encoding]);
  for (const row of snapshot.metadata) {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id < 0 ||
      row.id >= snapshot.size ||
      metadataIds.has(row.id) ||
      snapshot.entries[row.id]!.state !== "live"
    )
      invalid(`metadata ${row.id} has no exact live owner`);
    metadataIds.add(row.id);
    const namespaces = new Set<string>();
    for (const [namespace] of row.entries) {
      if (namespaces.has(namespace)) invalid(`metadata ${row.id} duplicates ${namespace}`);
      if (
        namespace !== ALLOC_NAMESPACES.encoding &&
        namespace !== ALLOC_NAMESPACES.ownership &&
        namespace !== ALLOC_NAMESPACES.escape
      )
        invalid(`metadata ${row.id} has an unverifiable namespace ${namespace}`);
      namespaces.add(namespace);
      requestedNamespaces.add(namespace);
    }
  }
  const analyze = (fn: IrFunction): void => {
    assertFinalAllocProvenance(fn, registry);
    analyzeEncoding(fn, registry);
    if (requestedNamespaces.has(ALLOC_NAMESPACES.ownership) || requestedNamespaces.has(ALLOC_NAMESPACES.escape)) {
      const ownership = analyzeOwnership(fn, registry);
      if (requestedNamespaces.has(ALLOC_NAMESPACES.escape)) analyzeEscape(fn, registry, ownership);
    }
  };
  for (const fn of program.ir.functions) {
    analyze(fn);
    // State buffers are executable semantic bodies too. The existing provenance
    // verifier accepts a function carrier, so reuse it over each exact buffer.
    for (const state of fn.asyncPlan?.states ?? []) {
      const block = fn.blocks[0];
      if (!block) invalid(`async owner ${fn.unitId} lacks a typed entry block`);
      assertFinalAllocProvenance({ ...fn, blocks: [{ ...block, instrs: state.body }] }, registry);
    }
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.alloc === undefined) return;
          const site = registry.resolve(instruction.alloc);
          if (!site) return invalid(`body ${fn.unitId} references stale site ${instruction.alloc}`);
          if (instruction.resultType && preparedIrTypeKey(site.type) !== preparedIrTypeKey(instruction.resultType))
            invalid(`site ${site.id} contradicts body ${fn.unitId}'s result type`);
        });
  }
  const expected = new Map(registry.snapshot().metadata.map((row) => [row.id, new Map(row.entries)]));
  const actual = new Map(snapshot.metadata.map((row) => [row.id, new Map(row.entries)]));
  for (let index = 0; index < snapshot.size; index++) {
    const id = asAllocSiteId(index);
    for (const namespace of requestedNamespaces) {
      const before = actual.get(id);
      const current = expected.get(id);
      if (
        (before?.has(namespace) ?? false) !== (current?.has(namespace) ?? false) ||
        preparedIrDataKey(before?.get(namespace)) !== preparedIrDataKey(current?.get(namespace))
      )
        invalid(`site ${id} has missing or stale ${namespace} evidence`);
    }
  }
}
