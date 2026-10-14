// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrModule, type AllocSiteId, type IrInstr } from "../../core/nodes.js";
import { assertPreparedIrData } from "../../../shared/contracts/prepared-ir-data.js";
import { ALLOC_NAMESPACES, type AllocRegistrySnapshot } from "../contracts/allocations.js";
import {
  hasNativeNumberUndefinedPopulation,
  inspectNativeNumberUndefinedBodies,
} from "./native-number-undefined-body.js";
import { indexRegistryEvidence, checkRegistryEvidenceMetadataDomain } from "./metadata.js";
import type { AllocationEvidenceCheck } from "./contracts.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

function exactRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(actual),
    keys = Reflect.ownKeys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => {
      if (typeof key !== "string" || !Object.hasOwn(expected, key)) return false;
      const field = descriptors[key];
      if (!field || !("value" in field)) return false;
      const value = expected[key];
      return Array.isArray(value)
        ? Array.isArray(field.value) &&
            field.value.length === value.length &&
            value.every((v, i) => Object.getOwnPropertyDescriptor(field.value, String(i))?.value === v)
        : field.value === value;
    })
  );
}
/** Independent partition/effect/namespace replay over complete source-free bodies. */
export function inspectNativeNumberUndefinedNamespaces(
  module: IrModule,
  registry: AllocRegistrySnapshot,
):
  | Exclude<AllocationEvidenceCheck, { kind: "verified" }>
  | ({ kind: "representable" } & Omit<Extract<AllocationEvidenceCheck, { kind: "verified" }>, "kind" | "profile">)
  | undefined {
  const effects = new Map<AllocSiteId, boolean>();
  let requirements;
  try {
    if (!hasNativeNumberUndefinedPopulation(module)) return undefined;
    assertPreparedIrData(registry);
    requirements = inspectNativeNumberUndefinedBodies(module, registry, effects);
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return {
        kind: "not-covered",
        reason: "reference-carrier",
        at: { kind: "module" },
      };
    if (error instanceof PreparedIrProgramInvariantError)
      return {
        kind: "invalid",
        code: "lexical-definition",
        at: { kind: "module" },
      };
    throw error;
  }
  if (!requirements) return undefined;
  const namespaces = new Set<string>([ALLOC_NAMESPACES.ownership, ALLOC_NAMESPACES.escape, ALLOC_NAMESPACES.encoding]);
  for (const row of registry.metadata)
    for (const [namespace] of row.entries)
      if (!namespaces.has(namespace))
        return { kind: "invalid", code: "namespace-presence", at: { kind: "site", site: row.id } };
  const index = indexRegistryEvidence(registry);
  const domain = checkRegistryEvidenceMetadataDomain(index);
  if (domain) return domain;
  for (let id = 0; id < registry.size; id++) {
    const site = id as AllocSiteId,
      row = index.rows.get(site),
      at = { kind: "site" as const, site };
    if (!effects.has(site)) {
      if (
        row?.has(ALLOC_NAMESPACES.ownership) ||
        row?.has(ALLOC_NAMESPACES.escape) ||
        row?.has(ALLOC_NAMESPACES.encoding)
      )
        return { kind: "invalid", code: "unused-site-evidence", at };
      continue;
    }
    if (row?.has(ALLOC_NAMESPACES.encoding)) return { kind: "invalid", code: "namespace-presence", at };
    const expected = [
      [index.ownership, ALLOC_NAMESPACES.ownership, { state: "owned", ops: effects.get(site) ? ["read"] : [] }],
      [index.escape, ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
    ] as const;
    for (const [enabled, namespace, value] of expected)
      if (enabled && !exactRecord(row?.get(namespace), value))
        return {
          kind: "invalid",
          code: row?.has(namespace) ? "namespace-value" : "namespace-presence",
          at,
        };
  }
  const census = {
    functions: module.functions.length,
    buffers: 0,
    instructions: 0,
    allocations: effects.size,
    vectorReads: 0,
    vectorWrites: 0,
    registrySlots: registry.size,
  };
  const visit = (buffer: readonly IrInstr[]) => {
    census.buffers++;
    for (const instr of buffer) {
      census.instructions++;
      if (instr.kind === "vec.get" || instr.kind === "vec.len") census.vectorReads++;
      forEachNestedBuffer(instr, visit);
    }
  };
  for (const fn of module.functions) for (const block of fn.blocks) visit(block.instrs);
  return {
    kind: "representable",
    namespaces: index.mode,
    census,
  };
}
