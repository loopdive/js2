// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Str2-c) The number formatter's part of the Prepared provider census (`prepared-provider-census.ts`). A
 * program that formats a number carries one runtime-support batch (the radix body), a formatter setup beside the
 * string setup (kernels, radix body and thunk, Ryu, `number_toString`, the native adapter) and the formatter's
 * scratch, which is the string setup's data type. Each is joined here by identity to the canonical declarations
 * of the program's runtime ABI anchor (`numberFormatRadixSupportDeclarations`, the formatter recipe and its
 * callable associations), never by a function name; the census owns the slot, signature and receipt joins.
 */

import type { EmittedPreparedIrProgram, PreparedIrBackendOptions, PreparedIrProgram } from "../ir/program.js";
import {
  internalNativeBinding,
  nativeSupplementalOrder,
  type NativeStringValueAbiBinding,
  type PhysicalNativeNumberFormatSetup,
  type PhysicalNativeStringSetup,
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
import { nativeRyuTableInitializers } from "../backend/wasmgc/resources/native-number-ryu.js";
import type { NativeStringValueDeclaration } from "../runtime/wasmgc/values/native-resource-declaration-types.js";

const same = (left: unknown, right: unknown) => preparedIrDataMismatch(left, right) === undefined;
const canonical = (program: PreparedIrProgram) =>
  numberFormatRadixSupportDeclarations(preparedIrRuntimeAbiAnchor(program.inventory).id);
const ADAPTER_PROVIDER = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find(
  (row) => row.feature === "async.native.number-to-string",
)!;

/**
 * (#7354 Str2 review 2) The formatter setup the physical plan derives for this program, whole (`nativeFormatterSetup`
 * builds it, validating each part as it goes): the recipe the runtime ABI anchor, the string owner and the accepted
 * integer policy declare, with that input; the string setup's data type as the scratch, on its prepared ABI entry;
 * one binding per declaration, in the producer's order — first a canonical callable's ABI entry and reference for a
 * kernel, the radix body and the adapter (`numberFormatSetupAssociations`), then the setup-derived binding
 * (`internalNativeBinding`) at the setup's declaration order for every other row, on an existing entry's order and
 * name where the program already plans it; and the radix body as the support function. Undefined when no recipe can
 * be declared (no policy, or no string owner key): then no formatter setup is the program's.
 */
function derivedFormatterSetup(
  program: PreparedIrProgram,
  strings: PhysicalNativeStringSetup["resources"],
  numberFormat: PreparedIrBackendOptions["numberFormat"],
): unknown {
  const stringKey = strings.literalRequirements.key;
  // The recipe throws on an input it cannot declare from (`declareNativeNumberFormatResources`).
  if (typeof numberFormat?.integerBeforeScratch !== "boolean" || !stringKey) return undefined;
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory).id;
  const declared = numberFormatRadixSupportDeclarations(anchor);
  const input = nativeNumberFormatResourceInput(anchor, stringKey, numberFormat.integerBeforeScratch);
  const recipe = declareNativeNumberFormatResources(input);
  const planOf = (id: string) => program.abi.entries.find((row) => row.plan.id === id)?.plan;
  const keyOf = (role: readonly string[]) => recipe.declarations.find((row) => same(row.role, role))?.key;
  const associated = numberFormatSetupAssociations(program.inventory).map((row) => ({
    resourceKey: keyOf(row.role),
    entry: planOf(row.bindingId),
    reference: row.ref,
  }));
  const baseOrder = nativeSupplementalOrder(program) + strings.declarations.length;
  const derived = recipe.declarations.flatMap((declaration, index) => {
    if (associated.some((row) => row.resourceKey === declaration.key)) return [];
    const binding = internalNativeBinding(program, declaration, baseOrder + index);
    const existing = planOf(binding.entry.id);
    const entry = existing
      ? { ...binding.entry, order: existing.order, displayName: existing.displayName }
      : binding.entry;
    return [{ ...binding, entry }];
  });
  const physical = (type: IrType) => (type.kind === "val" ? type.val : type);
  const { implementation, scratch } = declared;
  const body = associated.find((row) => same(row.reference, implementation.ref));
  return {
    resources: {
      ...recipe,
      input,
      scratch: {
        declaration: strings.declarations.find((row) => same(row.role, scratch.stringDataRole)),
        reference: scratch.type.ref,
        entry: planOf(scratch.type.ref.binding.bindingId),
      },
      supportUnitId: declared.ownerUnitId,
    },
    bindings: [...associated, ...derived],
    support: {
      unitId: declared.ownerUnitId,
      reference: implementation.ref,
      bindingId: body?.entry?.id,
      resourceKey: body?.resourceKey,
      params: implementation.params.map(physical),
      results: implementation.results.map(physical),
    },
  };
}

/**
 * (#7354 Str2 review 2) The formatter setup is exactly the one the physical plan derives for the program, its string
 * setup and the accepted number-format policy (`derivedFormatterSetup`): every field of it, so no part of the setup
 * is read past. The census then joins each binding's slot to the declaration's space, signature and support receipt.
 */
export function formatterSetupJoins(
  program: PreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup,
  strings: PhysicalNativeStringSetup["resources"],
  numberFormat: PreparedIrBackendOptions["numberFormat"],
): boolean {
  const derived = derivedFormatterSetup(program, strings, numberFormat);
  return derived !== undefined && same(formatter, derived);
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
  readonly index: number;
}
/**
 * The runtime-support batch is exactly the canonical radix batch of the runtime ABI anchor, demanded by exactly
 * the program's formatter-calling units. (Its body unit is the setup's support unit: `formatterSetupJoins`.)
 */
function batchJoins(program: PreparedIrProgram): boolean {
  const batches = program.runtimeSupport?.batches ?? [];
  const declared = canonical(program);
  if (batches.length !== 1) return false;
  const [batch] = batches;
  return (
    batch!.kind === "number-format-radix-v1" &&
    batch!.sourceId === preparedIrRuntimeAbiAnchor(program.inventory).id &&
    same(batch!.scratch, declared.scratch) &&
    same(batch!.kernels, declared.kernels) &&
    same(batch!.implementation.declaration, declared.implementation) &&
    batch!.implementation.body.unitId === declared.ownerUnitId &&
    same(batch!.demandOwners, irNumberFormatDemandOwners(program.ir.functions))
  );
}
/**
 * (#7354 Str2 review 2) Each Ryu table global holds its own table. The two globals share one shape, so their slots
 * could pass for each other in the emission's binding-index record; their initializers tell them apart.
 */
function ryuTablesJoin(emission: EmittedPreparedIrProgram, slots: readonly FormatterSlot[]): boolean {
  const slotOf = (role: string) => slots.find((slot) => same(slot.declaration.role, ["number-ryu", role]));
  const initializers = nativeRyuTableInitializers(slotOf("table-type")?.index ?? -1);
  return (["inverse", "powers"] as const).every((role) =>
    same(emission.module.globals[slotOf(role)?.index ?? -1]?.init, initializers[role]),
  );
}

/**
 * The formatter joins its demand: a program with a direct formatter call has the formatter setup (which the census
 * joined to its canonical declarations, `formatterSetupJoins`) and its batch, one without has no batch. The setup's
 * adapter answers the adapter's canonical provider, which the census then requires selected exactly once (no
 * provider without demand, none twice). Answers the provider implementations the formatter answers, or undefined
 * when anything joins nothing.
 */
export function formatterJoins(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup | undefined,
  slots: readonly FormatterSlot[],
): readonly RuntimeProviderDefinition["implementation"][] | undefined {
  // Without demand only the batch needs a check here: a provider then answers no runtime callable, a scratch no
  // second binding, and a formatter setup's functions no support receipt, so the census refuses each of them.
  if (irNumberFormatDemandOwners(program.ir.functions).length === 0)
    return program.runtimeSupport?.batches.length ? undefined : [];
  return formatter && batchJoins(program) && ryuTablesJoin(emission, slots)
    ? [ADAPTER_PROVIDER.implementation]
    : undefined;
}
