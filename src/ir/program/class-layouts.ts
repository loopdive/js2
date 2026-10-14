// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { preparedIrDataMismatch } from "./data.js";
import { assertSourceClassPreparation } from "./class-preparation.js";

import type { IrClassShape } from "../core/types.js";
import { preparedIrClassLayoutKey } from "./abi-signatures.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrProgram } from "./prepared-contracts.js";

/** Nominal references may recur; every occurrence must still agree with its declared layout. */
export function assertPreparedIrClassLayouts(
  program: Pick<PreparedIrProgram, "abi" | "ir" | "allocations"> & Partial<Pick<PreparedIrProgram, "inventory">>,
): void {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
  };
  const prepared = program.abi.entries.flatMap((e) =>
    e.contract.kind === "class" && e.contract.preparation ? [e.contract.preparation] : [],
  );
  if (prepared.length) {
    if (!program.inventory) invalid("source class preparation lacks original inventory");
    assertSourceClassPreparation(program.inventory!, prepared, program.ir);
  }
  const layouts = new Map<string, string>();
  for (const entry of program.abi.entries) {
    if (entry.contract.kind !== "class" || entry.plan.slotPolicy === "alias") continue;
    const { shape } = entry.contract;
    if (
      program.inventory?.terminalUnits.some(
        (u) =>
          u.lexicalOwnerId === shape.classId &&
          (u.kind === "class-constructor" || u.kind === "class-implicit-constructor"),
      ) &&
      !entry.contract.preparation
    )
      invalid("original source constructor lacks complete class preparation");
    if (
      entry.contract.preparation &&
      preparedIrDataMismatch(entry.contract.shape, entry.contract.preparation.shape) !== undefined
    )
      invalid("class ABI layout contradicts its source preparation");
    if (layouts.has(shape.classId)) invalid(`class ${shape.classId} has duplicate layout authority`);
    layouts.set(shape.classId, preparedIrClassLayoutKey(shape));
  }
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors))
      if (!("value" in descriptor)) invalid("prepared class graph contains executable accessors");
    const field = (key: string): unknown => descriptors[key]?.value;
    if (field("kind") === "class") {
      const shape = field("shape");
      // Class ABI intents/references carry an identity rather than a shape.
      if (shape !== undefined) visit(shape);
    }
    if (field("classId") !== undefined && field("fields") !== undefined) {
      if (
        typeof field("classId") !== "string" ||
        !Array.isArray(field("fields")) ||
        !Array.isArray(field("methods")) ||
        !Array.isArray(field("constructorParams"))
      )
        invalid("class layout lacks complete typed fields, methods or constructor parameters");
      const shape = value as IrClassShape;
      const declared = layouts.get(shape.classId);
      if (declared === undefined) invalid(`class ${shape.classId} lacks a declared layout contract`);
      if (declared !== preparedIrClassLayoutKey(shape))
        invalid(`class ${shape.classId} contradicts its declared complete layout`);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) if (key !== "asyncRuntime") visit(descriptor.value);
  };
  visit(program.ir);
  visit(program.abi.entries);
  visit(program.allocations);
}
