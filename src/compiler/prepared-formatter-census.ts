// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Str2-c) The number formatter's part of the Prepared provider census (`prepared-provider-census.ts`). A
 * program that formats a number carries one runtime-support batch (the radix body), a formatter setup beside the
 * string setup (kernels, radix body and thunk, Ryu, `number_toString`, the native adapter) and the formatter's
 * scratch, which is the string setup's data type. Each is joined here by identity to the canonical declarations
 * of the program's runtime ABI anchor (`numberFormatRadixSupportDeclarations`, the adapter's callable
 * declaration), never by a function name; the census owns the slot, signature and receipt joins.
 */

import type { PreparedIrProgram } from "../ir/program.js";
import type { NativeStringValueAbiBinding, PhysicalNativeNumberFormatSetup } from "../ir/program-physical-plan.js";
import { preparedIrRuntimeAbiAnchor } from "../ir/program-runtime-abi.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import { numberFormatRadixSupportDeclarations } from "../ir/program/formatter-support.js";
import { irNumberFormatDemandOwners, type IrFormatterKernelRole } from "../ir/program/runtime-support.js";
import type { IrType } from "../ir/core/types.js";
import type { IrFuncRef } from "../ir/core/value-references.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
} from "../ir/runtime/native-async-callables.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";
import type { NativeStringValueDeclaration } from "../runtime/wasmgc/values/native-resource-declaration-types.js";

const same = (left: unknown, right: unknown) => preparedIrDataMismatch(left, right) === undefined;
const canonical = (program: PreparedIrProgram) =>
  numberFormatRadixSupportDeclarations(preparedIrRuntimeAbiAnchor(program.inventory).id);
const ADAPTER = NATIVE_ASYNC_CALLABLE_DECLARATIONS.find((row) => row.feature === "async.native.number-to-string")!;
const ADAPTER_PROVIDER = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find((row) => row.feature === ADAPTER.feature)!;
const ADAPTER_ROLE = ["number-format", "native-to-string"] as const;

/** The formatter setup roles of the batch's support callables: the kernels and the radix body. */
const SUPPORT_ROLES: readonly (readonly string[])[] = [
  ...(["new", "get", "set", "fin", "trap"] as const satisfies readonly IrFormatterKernelRole[]),
  "radix-body",
].map((role) => ["number-format", role]);

/**
 * A formatter setup function bound under the batch's own support binding id (a kernel, the radix body) rather
 * than a setup-derived one. Its identity is joined like every setup function's, which needs no binding id: the
 * emission's support receipt at the binding's slot carries the declaration's key, and the slot its signature
 * (`supportPopulationJoins`), so a binding moved to another function's entry joins nothing.
 */
export function canonicalSupportRole(declaration: NativeStringValueDeclaration): boolean {
  return declaration.space === "function" && SUPPORT_ROLES.some((role) => same(declaration.role, role));
}

/**
 * The string data type is also the formatter's scratch when the program formats a number: it is bound twice, by the
 * canonical scratch reference, whose slot the census reads, and by the setup's own derived reference (`owned`).
 * Answers the canonical binding; undefined for anything else, including a single binding where the scratch pair is
 * due. Its slot needs no further check: every other type slot of the setups is another declaration's, and the census
 * admits one declaration per slot (`nativeRows`).
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
  return same(derived[0]!.reference.binding, { kind: "source", bindingId: owned }) ? reference[0] : undefined;
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
 * The formatter joins its demand: a program with a direct formatter call has the formatter setup and its batch, one
 * without has no batch. The setup's unique adapter role is bound to the adapter's own intrinsic reference; it
 * answers the adapter's canonical provider, which the census then requires selected exactly once (no provider
 * without demand, none twice). Its slot, like every setup function's, needs no binding-id check: the support receipt
 * at that slot carries the role's declaration key (`supportPopulationJoins`). Answers the provider implementations
 * the formatter answers, or undefined when anything joins nothing.
 */
export function formatterJoins(
  program: PreparedIrProgram,
  formatter: PhysicalNativeNumberFormatSetup | undefined,
  slots: readonly FormatterSlot[],
): readonly RuntimeProviderDefinition["implementation"][] | undefined {
  // Without demand only the batch needs a check here: a provider then answers no runtime callable, a scratch no
  // second binding, and a formatter setup's functions no support receipt, so the census refuses each of them.
  if (irNumberFormatDemandOwners(program.ir.functions).length === 0)
    return program.runtimeSupport?.batches.length ? undefined : [];
  const adapters = slots.filter((slot) => same(slot.declaration.role, ADAPTER_ROLE));
  if (
    adapters.length !== 1 ||
    !same(adapters[0]!.binding.reference, ADAPTER.ref) ||
    // A formatter setup's slots exist only beside the setup itself.
    !batchJoins(program, formatter!, slots)
  )
    return undefined;
  return [ADAPTER_PROVIDER.implementation];
}
