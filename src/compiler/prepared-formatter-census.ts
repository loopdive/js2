// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Str2-c) The number formatter's part of the Prepared provider census (`prepared-provider-census.ts`). A
 * program that formats a number carries one runtime-support batch (the radix body), a formatter setup beside the
 * string setup (kernels, radix body and thunk, Ryu, `number_toString`, the native adapter) and the formatter's
 * scratch, which is the string setup's data type. Each is joined here by identity to the canonical declarations
 * of the program's runtime ABI anchor (`numberFormatRadixSupportDeclarations`, the formatter recipe and its
 * callable associations), never by a function name; the census owns the slot, signature and receipt joins.
 */

import type { PreparedIrBackendOptions, PreparedIrProgram } from "../ir/program.js";
import {
  internalNativeBinding,
  type NativeStringValueAbiBinding,
  type PhysicalNativeNumberFormatSetup,
} from "../ir/program-physical-plan.js";
import { preparedIrRuntimeAbiAnchor } from "../ir/program-runtime-abi.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import {
  numberFormatRadixSupportDeclarations,
  numberFormatSetupAssociations,
} from "../ir/program/formatter-support.js";
import { irNumberFormatDemandOwners } from "../ir/program/runtime-support.js";
import type { IrType } from "../ir/core/types.js";
import type { IrFuncRef } from "../ir/core/value-references.js";
import { NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS } from "../ir/runtime/native-async-callables.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";
import { nativeNumberFormatResourceInput } from "../backend/wasmgc/program/native-number-format.js";
import { declareNativeNumberFormatResources } from "../backend/wasmgc/resources/native-number-format.js";
import type { NativeStringValueDeclaration } from "../runtime/wasmgc/values/native-resource-declaration-types.js";

const same = (left: unknown, right: unknown) => preparedIrDataMismatch(left, right) === undefined;
const canonical = (program: PreparedIrProgram) =>
  numberFormatRadixSupportDeclarations(preparedIrRuntimeAbiAnchor(program.inventory).id);
const ADAPTER_PROVIDER = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find(
  (row) => row.feature === "async.native.number-to-string",
)!;

/**
 * A formatter setup function bound under the batch's own support binding id (a kernel, the radix body) rather
 * than a setup-derived one; `formatterSetupJoins` pins that binding.
 */
export function canonicalSupportRole(program: PreparedIrProgram, declaration: NativeStringValueDeclaration): boolean {
  return (
    declaration.space === "function" &&
    numberFormatSetupAssociations(program.inventory).some(
      (row) => row.origin === "support" && same(declaration.role, row.role),
    )
  );
}

/**
 * (#7354 Str2 review 1) The formatter setup is exactly the one the runtime ABI anchor, the string owner and the
 * accepted number-format policy determine, joined row by row by identity: its declarations equal the formatter
 * recipe's (role, name, signature or type, mutability — one row per role, in recipe order), and each declaration is
 * published once, under the binding the physical plan gives it — a canonical callable's entry and reference for a
 * kernel, the radix body and the adapter (`numberFormatSetupAssociations`), the setup-derived one
 * (`internalNativeBinding`) for every other row. The census then joins each binding's slot to the declaration's
 * space, signature and support receipt. No row is joined by its name.
 */
function formatterSetupJoins(
  program: PreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup,
  stringKey: string,
  numberFormat: PreparedIrBackendOptions["numberFormat"],
): boolean {
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory).id;
  // An emission with a formatter setup was accepted only with its resolved integer policy.
  const input = nativeNumberFormatResourceInput(anchor, stringKey, numberFormat!.integerBeforeScratch);
  const { declarations } = declareNativeNumberFormatResources(input);
  const associations = numberFormatSetupAssociations(program.inventory);
  const published = declarations.map((declaration) => {
    const association = associations.find((row) => same(row.role, declaration.role));
    const { entry, reference } = association
      ? { entry: { id: association.bindingId }, reference: association.ref }
      : internalNativeBinding(program, declaration, 0);
    return [declaration.key, entry.id, reference] as const;
  });
  const byKey = (rows: readonly (readonly [string, string, unknown])[]) =>
    [...rows].sort(([a], [b]) => a.localeCompare(b));
  const bindings = formatter.bindings.map((row) => [row.resourceKey, row.entry.id, row.reference] as const);
  return same(formatter.resources.declarations, declarations) && same(byKey(bindings), byKey(published));
}

/**
 * The string data type is also the formatter's scratch when the program formats a number: it is bound twice, by the
 * canonical scratch reference, whose slot the census reads, and by the setup's own derived reference (`owned`), both
 * on the canonical scratch entry. Answers the canonical binding; undefined for anything else, including a single
 * binding where the scratch pair is due. Its slot needs no further check: every other type slot of the setups is
 * another declaration's, and the census admits one declaration per slot (`nativeRows`).
 */
export function formatterScratchBinding(
  program: PreparedIrProgram,
  scratchType: IrType | undefined,
  owned: string,
  bindings: readonly NativeStringValueAbiBinding[],
): NativeStringValueAbiBinding | undefined {
  const { scratch } = canonical(program);
  const reference = bindings.filter((row) => same(row.reference, scratch.type.ref));
  const derived = bindings.filter((row) => !reference.includes(row));
  if (!same(scratchType, scratch.type) || reference.length !== 1 || derived.length !== 1) return undefined;
  const entries = [reference[0]!, derived[0]!].map((row) => row.entry.id);
  return same(derived[0]!.reference.binding, { kind: "source", bindingId: owned }) &&
    same(entries, [scratch.type.ref.binding.bindingId, scratch.type.ref.binding.bindingId])
    ? reference[0]
    : undefined;
}

/** Whether a native setup declaration is the formatter scratch's string data type. */
export function isFormatterScratch(program: PreparedIrProgram, declaration: NativeStringValueDeclaration): boolean {
  return same(declaration.role, canonical(program).scratch.stringDataRole);
}

/**
 * (#7354 Str2-c) A callable ABI contract may carry the scratch reference only as a canonical kernel's: the kernel
 * reference by binding identity, the scratch type by data identity. The census authenticates the kernels' slots.
 */
export function formatterKernelScratch(program: PreparedIrProgram, ref: IrFuncRef, type: IrType): boolean {
  const { kernels, scratch } = canonical(program);
  return same(type, scratch.type) && kernels.some((kernel) => same(kernel.ref, ref));
}

/** A formatter setup slot, as the census resolved it. */
interface FormatterSlot {
  readonly declaration: NativeStringValueDeclaration;
  readonly binding: NativeStringValueAbiBinding;
}
/**
 * The runtime-support batch is exactly the canonical radix batch of the runtime ABI anchor, demanded by exactly
 * the program's formatter-calling units, and its body is the setup's support function, whose slot is the
 * radix-body role's.
 */
function batchJoins(
  program: PreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup,
  slots: readonly FormatterSlot[],
): boolean {
  const batches = program.runtimeSupport?.batches ?? [];
  const declared = canonical(program);
  const body = slots.find((slot) => same(slot.declaration.role, ["number-format", "radix-body"]));
  if (batches.length !== 1) return false;
  const [batch] = batches;
  return (
    batch!.kind === "number-format-radix-v1" &&
    batch!.sourceId === preparedIrRuntimeAbiAnchor(program.inventory).id &&
    same(batch!.scratch, declared.scratch) &&
    same(batch!.kernels, declared.kernels) &&
    same(batch!.implementation.declaration, declared.implementation) &&
    batch!.implementation.body.unitId === declared.ownerUnitId &&
    formatter.support.unitId === declared.ownerUnitId &&
    same(formatter.support.reference, declared.implementation.ref) &&
    formatter.support.bindingId === body?.binding.entry.id &&
    same(batch!.demandOwners, irNumberFormatDemandOwners(program.ir.functions))
  );
}

/**
 * The formatter joins its demand: a program with a direct formatter call has the canonical formatter setup
 * (`formatterSetupJoins`) and its batch, one without has no batch. The setup's adapter answers the adapter's
 * canonical provider, which the census then requires selected exactly once (no provider without demand, none
 * twice). Answers the provider implementations the formatter answers, or undefined when anything joins nothing.
 */
export function formatterJoins(
  program: PreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup | undefined,
  slots: readonly FormatterSlot[],
  stringKey: string,
  numberFormat: PreparedIrBackendOptions["numberFormat"],
): readonly RuntimeProviderDefinition["implementation"][] | undefined {
  // Without demand only the batch needs a check here: a provider then answers no runtime callable, a scratch no
  // second binding, and a formatter setup's functions no support receipt, so the census refuses each of them.
  if (irNumberFormatDemandOwners(program.ir.functions).length === 0)
    return program.runtimeSupport?.batches.length ? undefined : [];
  return formatter &&
    formatterSetupJoins(program, formatter, stringKey, numberFormat) &&
    batchJoins(program, formatter, slots)
    ? [ADAPTER_PROVIDER.implementation]
    : undefined;
}
