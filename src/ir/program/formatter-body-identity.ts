// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrFunction, type IrInstr } from "../core/nodes.js";
import type { IrSourceId } from "../../shared/contracts/ir-identity.js";
import { numberFormatRadixSupportDeclarations } from "./formatter-support.js";
import { preparedIrDataMismatch } from "./data.js";

function fail(detail: string): never {
  throw Error("native radix body identity: " + detail);
}

/** Data description only. The independent retained template, never caller data, authorizes a body. */
export function describeNativeRadixBody(body: IrFunction, sourceId: IrSourceId): unknown {
  if (preparedIrDataMismatch(body, body) !== undefined) fail("non-data body");
  const actual = numberFormatRadixSupportDeclarations(sourceId),
    // Comparison-only anchor, not an issuer or permission to allocate/emit.
    canonical = numberFormatRadixSupportDeclarations(
      "ir-source:v1:0000000000000000:entry:%3Cnative%3Aradix%3E" as IrSourceId,
    );
  const identities = new Map<string, string>([[actual.ownerUnitId, canonical.ownerUnitId]]);
  // Pair only genuine declarations, never IDs or names selected from the body.
  function pair(left: unknown, right: unknown): void {
    if (typeof left === "string" && typeof right === "string") {
      const prior = identities.get(left);
      if (prior !== undefined && prior !== right) fail("nonunique declaration identity");
      identities.set(left, right);
    } else if (left && right && typeof left === "object" && typeof right === "object") {
      for (const key of Object.keys(left))
        pair((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]);
    }
  }
  pair(actual, canonical);
  const allocations = new Map<number, number>(),
    instructions = new Set<IrInstr>(),
    activeBuffers = new Set<readonly IrInstr[]>();
  function visit(buffer: readonly IrInstr[]): void {
    if (!Array.isArray(buffer) || activeBuffers.has(buffer)) fail("missing or cyclic instruction buffer");
    activeBuffers.add(buffer);
    for (const instruction of buffer) {
      instructions.add(instruction);
      if (instruction.alloc !== undefined) {
        if (!Number.isSafeInteger(instruction.alloc) || instruction.alloc < 0) fail("invalid allocation identity");
        if (!allocations.has(instruction.alloc)) allocations.set(instruction.alloc, allocations.size);
      }
      forEachNestedBuffer(instruction, visit);
    }
    activeBuffers.delete(buffer);
  }
  for (const block of body.blocks) visit(block.instrs);
  const active = new Set<object>();
  function describe(value: unknown): unknown {
    if (typeof value === "string") return identities.get(value) ?? value;
    if (!value || typeof value !== "object") return value;
    if (active.has(value)) fail("cyclic body data");
    active.add(value);
    const result = Array.isArray(value)
      ? value.map(describe)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => {
              const field = (value as Record<string, unknown>)[key];
              if (key === "alloc" && field !== undefined && instructions.has(value as IrInstr)) {
                if (typeof field !== "number" || !allocations.has(field)) fail("missing allocation renaming");
                return [key, allocations.get(field)];
              }
              return [key, describe(field)];
            }),
        );
    active.delete(value);
    return result;
  }
  return describe(body);
}
