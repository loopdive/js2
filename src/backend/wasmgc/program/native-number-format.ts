// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrTypeRef } from "../../../ir/core/types.js";
import type { ProgramAbiPlanEntry } from "../../../ir/program/abi.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";
import { numberFormatRadixSupportDeclarations } from "../../../ir/program/formatter-support.js";
import {
  assertNativeNumberFormatRequirementsCurrent,
  type NativeNumberFormatRequirements,
} from "../../../ir/program/native-number-format-requirements.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { createStringDataType } from "../../../runtime/wasmgc/values/string-layouts.js";
import { nativeScalarTypeDeclaration } from "../resources/native-resource-declarations.js";
import { nativeStringTypeKeys } from "../resources/native-string-literals.js";

/** Descriptive preallocation join, not an issued type or an ABI binding. */
export interface NativeNumberFormatScratchPlan {
  readonly declaration: Extract<NativeStringValueDeclaration, { space: "type" }>;
  readonly reference: IrTypeRef;
  readonly entry: ProgramAbiPlanEntry;
}

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native formatter scratch: ${detail}`);
}

/** The prepared scratch entry must own the existing string-data row, not a second type. */
export function planNativeNumberFormatScratch(
  requirements: NativeNumberFormatRequirements,
  stringKey: string,
  strings: NativeResourceRecipe,
): NativeNumberFormatScratchPlan {
  assertNativeNumberFormatRequirementsCurrent(requirements, requirements);
  if (typeof stringKey !== "string" || !stringKey) fail("missing string owner key");
  const { program, batch } = requirements;
  const canonical = numberFormatRadixSupportDeclarations(batch.sourceId).scratch;
  if (preparedIrDataMismatch(batch.scratch, canonical) !== undefined) fail("changed semantic scratch contract");
  const rows = strings.declarations.filter(
    (row) => preparedIrDataMismatch(row.role, canonical.stringDataRole) === undefined,
  );
  if (rows.length !== 1) fail("missing or duplicate string-data declaration");
  const declaration = rows[0]!;
  if (declaration.space !== "type" || declaration.key !== nativeStringTypeKeys(stringKey).data)
    fail("string-data declaration belongs to a different owner");
  if (preparedIrDataMismatch(declaration.shape, nativeScalarTypeDeclaration(createStringDataType())) !== undefined)
    fail("string-data storage is not the canonical mutable i16 array");
  const reference = canonical.type.ref;
  const entries = program.abi.entries.filter((row) => row.plan.id === reference.binding.bindingId);
  if (entries.length !== 1) fail("missing or duplicate prepared scratch entry");
  const entry = entries[0]!;
  if (
    entry.contract.kind !== "type" ||
    preparedIrDataMismatch(entry.contract.ref, reference) !== undefined ||
    preparedIrDataMismatch(entry.contract.type, canonical.type) !== undefined ||
    entry.plan.slotPolicy !== "required" ||
    entry.plan.slotSpace !== "type"
  )
    fail("prepared scratch entry is not its canonical required root");
  return Object.freeze({ declaration, reference, entry: entry.plan });
}
