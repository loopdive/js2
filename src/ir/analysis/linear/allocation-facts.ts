// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrInstr, type IrValueId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import type { IrFunction, IrModule } from "../../core/nodes.js";
import { ALLOC_NAMESPACES, type EscapeInfo } from "../contracts/allocations.js";
import { createVerifiedAllocationSnapshot, sameDetachedValue } from "../allocations/snapshot.js";
import type {
  LinearPreparedAllocationFact,
  LinearPreparedAllocationFacts,
  OwnershipMetadata,
} from "./contracts/allocation-facts.js";

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Validate exact body-site joins and all producer evidence before layout. */
export function verifyLinearPreparedAllocationFacts(
  module: IrModule,
  preparedFacts: LinearPreparedAllocationFacts,
): void {
  const read = createVerifiedAllocationSnapshot(preparedFacts.registry);
  const located = collectModuleAllocationInstructions(module);
  const factsById = new Map<number, LinearPreparedAllocationFact>();
  for (const fact of preparedFacts.allocations) {
    const id = fact.id as number;
    if (factsById.has(id)) throw new Error(`linear-memory frozen allocation facts duplicate site ${id}`);
    const canonicalIndex = read.canonicalIndex(fact.id);
    const canonical = read.siteAtCanonicalIndex(canonicalIndex);
    if (fact.site.id !== canonical.id || !sameDetachedValue(fact.site, canonical)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has a falsified site projection`);
    }
    const ownership = read.metadata(canonicalIndex, ALLOC_NAMESPACES.ownership);
    const escapeMetadata = read.metadata(canonicalIndex, ALLOC_NAMESPACES.escape);
    const encoding = read.metadata(canonicalIndex, ALLOC_NAMESPACES.encoding);
    if (!fact.evidence || typeof fact.evidence !== "object") {
      throw new Error(`linear-memory frozen allocation fact ${id} has no evidence-presence projection`);
    }
    const factOwnershipEvidence = fact.evidence.ownership;
    const factEscapeEvidence = fact.evidence.escape;
    const factEncodingEvidence = fact.evidence.encoding;
    if (
      !factOwnershipEvidence ||
      !factEscapeEvidence ||
      !factEncodingEvidence ||
      factOwnershipEvidence.present !== ownership.present ||
      factEscapeEvidence.present !== escapeMetadata.present
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with metadata presence`);
    }
    if (
      !sameDetachedValue(factOwnershipEvidence.value, ownership.value) ||
      !sameDetachedValue(factEscapeEvidence.value, escapeMetadata.value)
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with metadata evidence`);
    }
    const factEncodingPresent = Object.prototype.hasOwnProperty.call(fact, "encoding");
    if (factEncodingPresent !== encoding.present || factEncodingEvidence.present !== encoding.present) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding presence`);
    }
    if (!sameDetachedValue(factEncodingEvidence.value, encoding.value)) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding evidence`);
    }
    if (!sameDetachedValue(fact.encoding, encoding.value)) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding value`);
    }
    const ownershipValue = ownership.value;
    if (ownershipValue !== undefined && (typeof ownershipValue !== "object" || ownershipValue === null)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has malformed ownership evidence`);
    }
    const ownershipRecord = ownershipValue as OwnershipMetadata | undefined;
    const expectedOwnership = ownershipRecord?.state ?? "escaped";
    const expectedAccesses = ownershipRecord?.ops ?? [];
    const expectedStackCandidate = ownershipRecord?.stackCandidate === true;
    if (
      fact.ownership !== expectedOwnership ||
      !sameStringArray(fact.accesses, expectedAccesses) ||
      fact.stackCandidate !== expectedStackCandidate
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with ownership evidence`);
    }
    const escapeValue = escapeMetadata.value;
    if (escapeValue !== undefined && (typeof escapeValue !== "object" || escapeValue === null)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has malformed escape evidence`);
    }
    const escapeRecord = escapeValue as EscapeInfo | undefined;
    if (fact.escape !== (escapeRecord?.classification ?? "opaque")) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with escape evidence`);
    }
    factsById.set(id, fact);
  }
  const bodyIds = new Set<number>();
  for (const { instr } of located.allocations) {
    if (instr.alloc === undefined) continue;
    const id = instr.alloc as number;
    if (bodyIds.has(id)) throw new Error(`duplicate live allocation-site id ${id} in linear-memory facts`);
    bodyIds.add(id);
    if (!factsById.has(id)) throw new Error(`linear-memory facts are missing body allocation site ${id}`);
  }
  for (const id of factsById.keys()) {
    if (!bodyIds.has(id)) throw new Error(`linear-memory facts contain extra site ${id}`);
  }
}

/**
 * Collect only allocation instructions and their value-type environments.
 * Keeping this census separate prevents preparation facts from invoking the
 * backend layout/storage walk before the immutable handoff.
 */
export function collectModuleAllocationInstructions(module: IrModule): {
  allocations: {
    readonly instr: IrInstr;
    readonly valueTypes: ReadonlyMap<IrValueId, IrType>;
    readonly ownerFunction: string;
  }[];
} {
  const allocations: { instr: IrInstr; valueTypes: ReadonlyMap<IrValueId, IrType>; ownerFunction: string }[] = [];
  for (const fn of module.functions) {
    const valueTypes = collectValueTypes(fn);
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.alloc !== undefined) allocations.push({ instr: nested, valueTypes, ownerFunction: fn.name });
        });
      }
    }
    for (const state of fn.asyncPlan?.states ?? []) {
      for (const instr of state.body) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.alloc !== undefined) allocations.push({ instr: nested, valueTypes, ownerFunction: fn.name });
        });
      }
    }
  }
  return { allocations };
}

export function collectValueTypes(fn: IrFunction): Map<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  for (const param of fn.params) types.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) types.set(value.value, value.type);
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => {
      const type = block.blockArgTypes[index];
      if (type) types.set(value, type);
    });
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.result !== null && nested.resultType) types.set(nested.result, nested.resultType);
      });
    }
  }
  return types;
}
