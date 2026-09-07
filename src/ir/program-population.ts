// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createDerivedIrUnitId } from "./identity-values.js";
import type { IrUnitId } from "./identity.js";
import { forEachInstrDeep, type IrFuncRef, type IrFunction } from "./nodes.js";
import { verifyIrAsyncPlan } from "./async-plan.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import { PreparedIrProgramInvariantError, type PreparedIrProgramProducerInput } from "./program.js";

type Population = Pick<PreparedIrProgramProducerInput, "inventory" | "ir" | "derivedUnits">;

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

/**
 * One population check shared by preparation, semantic producers and replay.
 * These indexes are local verification state, not another ownership ledger.
 */
export function assertPreparedIrProgramPopulation(input: Population): void {
  const sources = new Map(input.inventory.sources.map((source) => [source.id, source]));
  const units = new Map(input.inventory.allUnits.map((unit) => [unit.id, unit]));
  const terminals = new Map(input.inventory.terminalUnits.map((unit) => [unit.id, unit]));
  if (sources.size !== input.inventory.sources.length || units.size !== input.inventory.allUnits.length) {
    invalid("program inventory contains duplicate source or unit identities");
  }
  if (terminals.size !== input.inventory.terminalUnits.length) invalid("program inventory duplicates a terminal");
  for (const unit of units.values()) {
    if (!sources.has(unit.sourceId)) invalid(`unit ${unit.id} has no source record`);
    if (unit.terminal !== terminals.has(unit.id)) invalid(`unit ${unit.id} has inconsistent terminal membership`);
    if (unit.terminalOwnerId !== null && !terminals.has(unit.terminalOwnerId)) {
      invalid(`unit ${unit.id} has no original terminal owner`);
    }
  }
  for (const terminal of terminals.values()) {
    const original = units.get(terminal.id);
    if (
      !original?.terminal ||
      original.sourceId !== terminal.sourceId ||
      original.kind !== terminal.kind ||
      original.terminalOwnerId !== terminal.terminalOwnerId ||
      original.declarationStart !== terminal.declarationStart ||
      original.declarationEnd !== terminal.declarationEnd ||
      terminal.terminalOwnerId !== terminal.id
    ) {
      invalid(`terminal ${terminal.id} contradicts the original inventory`);
    }
  }

  const derived = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
  for (const record of input.derivedUnits) {
    if (units.has(record.id) || derived.has(record.id)) invalid(`derived unit ${record.id} is duplicated`);
    if (record.id !== createDerivedIrUnitId(record)) invalid(`derived unit ${record.id} has noncanonical provenance`);
    const owner = record.terminalOwnerId === null ? undefined : terminals.get(record.terminalOwnerId);
    if (!owner || record.sourceId !== owner.sourceId) invalid(`derived unit ${record.id} has no exact source owner`);
    derived.set(record.id, record);
  }
  const checkParent = (record: ProgramAbiDerivedUnitRecord, ancestors: ReadonlySet<IrUnitId>): void => {
    if (ancestors.has(record.id)) invalid(`derived unit ${record.id} has cyclic provenance`);
    const parent = units.get(record.parentId) ?? derived.get(record.parentId);
    if (!parent || parent.sourceId !== record.sourceId || parent.terminalOwnerId !== record.terminalOwnerId) {
      invalid(`derived unit ${record.id} has a missing or contradictory parent`);
    }
    const derivedParent = derived.get(record.parentId);
    if (derivedParent) checkParent(derivedParent, new Set([...ancestors, record.id]));
  };
  for (const record of derived.values()) checkParent(record, new Set());

  const functions = new Map<IrUnitId, IrFunction>();
  for (const fn of input.ir.functions) {
    if (functions.has(fn.unitId)) invalid(`program body ${fn.unitId} is duplicated`);
    const owner = units.get(fn.unitId) ?? derived.get(fn.unitId);
    if (!owner || owner.terminalOwnerId === null) invalid(`program body ${fn.unitId} has no original owner`);
    functions.set(fn.unitId, fn);
    if (fn.asyncPlan) {
      if (fn.asyncPlan.ownerUnitId !== fn.unitId) invalid(`async plan ${fn.unitId} has a foreign owner`);
      const errors = verifyIrAsyncPlan(fn.asyncPlan);
      if (errors.length > 0) invalid(`async plan ${fn.unitId}: ${errors.map((error) => error.message).join("; ")}`);
    }
  }
  for (const unitId of [...terminals.keys(), ...derived.keys()]) {
    if (!functions.has(unitId)) invalid(`complete program is missing body ${unitId}`);
  }
  const checkReference = (owner: IrUnitId, reference: IrFuncRef): void => {
    if (reference.binding.kind === "unit" && !functions.has(reference.binding.unitId)) {
      invalid(`body ${owner} references missing body ${reference.binding.unitId}`);
    }
  };
  for (const fn of functions.values()) {
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers) {
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call") checkReference(fn.unitId, instruction.target);
          if (instruction.kind === "closure.new") checkReference(fn.unitId, instruction.liftedFunc);
        });
    }
  }
}
