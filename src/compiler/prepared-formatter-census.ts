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
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "../ir/program-runtime-abi.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import { numberFormatRadixSupportDeclarations } from "../ir/program/formatter-support.js";
import { irNumberFormatDemandOwners } from "../ir/program/runtime-support.js";
import type { IrType } from "../ir/core/types.js";
import type { IrFuncRef } from "../ir/core/value-references.js";
import { NATIVE_ASYNC_CALLABLE_DECLARATIONS } from "../ir/runtime/native-async-callables.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";
import type { NativeStringValueDeclaration } from "../runtime/wasmgc/values/native-resource-declaration-types.js";

const same = (left: unknown, right: unknown) => preparedIrDataMismatch(left, right) === undefined;
const canonical = (program: PreparedIrProgram) =>
  numberFormatRadixSupportDeclarations(preparedIrRuntimeAbiAnchor(program.inventory).id);
const ADAPTER = NATIVE_ASYNC_CALLABLE_DECLARATIONS.find((row) => row.feature === "async.native.number-to-string")!;
const ADAPTER_ROLE = ["number-format", "native-to-string"] as const;

/** The canonical support callable a formatter setup role names: a kernel by its role, the radix body. */
function supportCallable(program: PreparedIrProgram, role: readonly string[]): IrFuncRef | undefined {
  if (role.length !== 2 || role[0] !== "number-format") return undefined;
  const { kernels, implementation } = canonical(program);
  return role[1] === "radix-body" ? implementation.ref : kernels.find((kernel) => kernel.role === role[1])?.ref;
}

/**
 * A setup binding that is a canonical support callable: the support reference of its declaration's role, bound
 * under that reference's own binding id (the kernels and the radix body keep the batch's ids, not setup-derived
 * ones).
 */
export function canonicalSupportBinding(
  program: PreparedIrProgram,
  declaration: NativeStringValueDeclaration,
  binding: NativeStringValueAbiBinding,
): boolean {
  const ref = supportCallable(program, declaration.role);
  return ref?.binding.kind === "support" && binding.entry.id === ref.binding.bindingId && same(binding.reference, ref);
}

/**
 * The string data type is also the formatter's scratch when the program formats a number: two bindings share the
 * scratch's entry, the canonical scratch reference and the setup's own derived one (`owned`). Answers the canonical
 * binding; undefined for anything else, including a single binding where the scratch pair is due.
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
  const [own] = derived;
  return reference[0]!.entry.id === scratch.type.ref.binding.bindingId &&
    same(own!.entry, reference[0]!.entry) &&
    own!.reference.kind === "type" &&
    own!.reference.binding.kind === "source" &&
    own!.reference.binding.bindingId === owned
    ? reference[0]
    : undefined;
}

/** Whether a native setup declaration is the formatter scratch's string data type. */
export function isFormatterScratch(program: PreparedIrProgram, declaration: NativeStringValueDeclaration): boolean {
  return declaration.space === "type" && same(declaration.role, canonical(program).scratch.stringDataRole);
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
  const body = slots.filter((slot) => same(slot.declaration.role, ["number-format", "radix-body"]));
  if (batches.length !== 1 || body.length !== 1) return false;
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
    formatter.support.bindingId === body[0]!.binding.entry.id &&
    same(batch!.demandOwners, irNumberFormatDemandOwners(program.ir.functions))
  );
}

/**
 * The formatter joins its demand: a program with a direct formatter call has the provider, the scratch, the
 * formatter setup and its batch; one without has none of them. The provider is answered by the setup's unique
 * adapter role, bound to the adapter's own intrinsic reference and runtime binding id; that adapter is the setup's
 * only intrinsic-bound function. Answers the runtime callable the provider names (none without demand), or
 * undefined when anything joins nothing.
 */
export function formatterJoins(
  program: PreparedIrProgram,
  scratchType: IrType | undefined,
  formatter: PhysicalNativeNumberFormatSetup | undefined,
  slots: readonly FormatterSlot[],
  providers: readonly RuntimeProviderDefinition[],
): readonly { readonly kind: "runtime-callable"; readonly symbol: string }[] | undefined {
  const provided = providers.filter((row) => row.feature === ADAPTER.feature);
  const demanded = irNumberFormatDemandOwners(program.ir.functions).length > 0;
  if (!demanded)
    return !provided.length && !formatter && scratchType === undefined && !program.runtimeSupport?.batches.length
      ? []
      : undefined;
  const adapters = slots.filter((slot) => same(slot.declaration.role, ADAPTER_ROLE));
  const adapter = adapters[0];
  if (
    !formatter ||
    provided.length !== 1 ||
    adapters.length !== 1 ||
    adapter!.declaration.space !== "function" ||
    !same(adapter!.binding.reference, ADAPTER.ref) ||
    adapter!.binding.entry.id !== preparedIrRuntimeCallableBindingId(program.inventory, ADAPTER.ref) ||
    slots.some((slot) => slot.binding.reference.binding.kind === "intrinsic" && slot !== adapter) ||
    !batchJoins(program, formatter, slots)
  )
    return undefined;
  return [{ kind: "runtime-callable", symbol: adapter!.declaration.name }];
}
