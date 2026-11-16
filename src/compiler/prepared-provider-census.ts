// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The runtime side of the Prepared presentation: the one place its runtime policy is chosen, and the census that
 * authenticates the completed runtime population against the selected providers and the accepted physical plan
 * (the presentation's `checkResourceDemand` asks it). Every support function, and every native-setup slot, must
 * join an authenticated row; anything that joins nothing refuses.
 */

import type { EmittedPreparedIrProgram, PreparedIrBackendOptions, PreparedIrProgram } from "../ir/program.js";
import {
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedSupportFunctionReceipts,
} from "../ir/program-consumer.js";
import type { NativeStringValueAbiBinding, PhysicalNativeStringSetup } from "../ir/program-physical-plan.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";
import { RUNTIME_PROVIDERS } from "../ir/runtime/manifest.js";
import {
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
  irNumberRemainderCallableDeclaration,
} from "../ir/runtime/number-remainder-callables.js";
import type { ValType } from "../ir/types.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type {
  NativeDeclaredValType,
  NativeStringValueDeclaration,
} from "../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import { completedFunctionSlot } from "./prepared-physical-signature.js";

/**
 * (#7354) The runtime policy a Prepared presentation selects. On wasmgc standalone the number boundary is the
 * native value runtime (`__box_number` / `__unbox_number`), which the census below authenticates; every other
 * family and target keeps its default (unsupported). Each further native family the presentation admits is
 * chosen here, beside the census that authenticates it.
 */
export function preparedPresentationPolicy(
  backend: PreparedIrBackendOptions["backend"],
  target: PreparedIrBackendOptions["target"],
): RuntimeManifestPolicy {
  return backend === "wasmgc" && target === "standalone"
    ? { backend, target, numberBoundary: { box: "native", unbox: "native" } }
    : { backend, target };
}

type SupportReceipt = ReturnType<typeof emittedSupportFunctionReceipts>[number];
/** A completed support function: one receipt at its slot under its key, and the slot carries its signature. */
interface SupportCallableRow {
  readonly bindingId: IrBindingId;
  readonly key: string;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}
/** The shared join of a selected provider and of every support function: one shape for remainders and natives. */
function supportCallableJoins(
  emission: EmittedPreparedIrProgram,
  receipts: readonly SupportReceipt[],
  row: SupportCallableRow,
): boolean {
  const slot = completedFunctionSlot(emission, row.bindingId);
  return Boolean(
    slot &&
    receipts.filter((receipt) => receipt.key === row.key && receipt.index === slot.index).length === 1 &&
    preparedIrDataMismatch(row.params, slot.params) === undefined &&
    preparedIrDataMismatch(row.results, slot.results) === undefined,
  );
}
/** The provider exactly as its canonical catalogue defines it: a dependency-free runtime callable. */
function canonicalCallable(
  catalogue: readonly RuntimeProviderDefinition[],
  provider: RuntimeProviderDefinition,
): string | undefined {
  const canonical = catalogue.filter((row) => row.id === provider.id);
  return canonical.length === 1 &&
    preparedIrDataMismatch(canonical[0], provider) === undefined &&
    provider.implementation.kind === "runtime-callable" &&
    !provider.dependencies.length &&
    !provider.hostCapabilities.length
    ? provider.implementation.symbol
    : undefined;
}

const F64 = Object.freeze({ kind: "f64" as const });
/** Each selected remainder joins its unique completed remainder resource; answers the joined support rows. */
function remainderRows(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  providers: readonly RuntimeProviderDefinition[],
): readonly SupportCallableRow[] | undefined {
  const resources = emittedPhysicalSetupPlan(emission).numberRemainders;
  if (resources.length !== providers.length) return undefined;
  const rows = providers.map((provider) => {
    const symbol = canonicalCallable(NUMBER_REMAINDER_RUNTIME_PROVIDERS, provider);
    const joined = resources.filter((row) => row.symbol === symbol);
    if (!symbol || joined.length !== 1) return undefined;
    const resource = joined[0]!;
    const entry = program.abi.entries.find((row) => row.plan.id === resource.bindingId);
    if (!entry || entry.contract.kind !== "callable") return undefined;
    const declaration = irNumberRemainderCallableDeclaration(entry.contract.ref);
    return declaration?.feature === provider.feature &&
      entry.plan.structuralReferenceKey === resource.referenceKey &&
      preparedIrDataMismatch(entry.contract.params, declaration.params) === undefined &&
      preparedIrDataMismatch(entry.contract.results, declaration.results) === undefined
      ? { bindingId: resource.bindingId, key: resource.bindingId, params: [F64, F64], results: [F64] }
      : undefined;
  });
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** A native-setup declaration and the binding the setup published for it. */
interface NativeSlot {
  readonly declaration: NativeStringValueDeclaration;
  readonly binding: NativeStringValueAbiBinding;
}
const REFERENCE_KIND = { function: "func", type: "type", global: "global" } as const;
/**
 * Every declaration of the accepted native setup plan joins exactly one published binding of its space, resolved
 * by the completed emission to a slot of that space, and every binding joins a declaration.
 */
function nativeSlots(emission: EmittedPreparedIrProgram, setup: PhysicalNativeStringSetup): NativeSlot[] | undefined {
  const { declarations } = setup.resources;
  if (setup.bindings.length !== declarations.length) return undefined;
  const slots: NativeSlot[] = [];
  for (const declaration of declarations) {
    const bindings = setup.bindings.filter((row) => row.resourceKey === declaration.key);
    const binding = bindings[0];
    if (
      bindings.length !== 1 ||
      binding!.reference.kind !== REFERENCE_KIND[declaration.space] ||
      emittedProgramBindingIndex(emission, binding!.entry.id)?.space !== declaration.space
    )
      return undefined;
    slots.push({ declaration, binding: binding! });
  }
  return slots;
}
/** A declared value type with its resource type key resolved to the completed type slot. */
function completedValType(
  emission: EmittedPreparedIrProgram,
  slots: readonly NativeSlot[],
  value: NativeDeclaredValType,
): ValType | undefined {
  if (!("typeKey" in value)) return value;
  const type = slots.find((row) => row.declaration.space === "type" && row.declaration.key === value.typeKey);
  const slot = type && emittedProgramBindingIndex(emission, type.binding.entry.id);
  return slot?.space === "type" ? { kind: value.kind, typeIdx: slot.index } : undefined;
}
function completedValTypes(
  emission: EmittedPreparedIrProgram,
  slots: readonly NativeSlot[],
  values: readonly NativeDeclaredValType[],
): readonly ValType[] | undefined {
  const result = values.map((value) => completedValType(emission, slots, value));
  return result.every((value) => value !== undefined) ? result : undefined;
}
/** A native function declaration as a support row; a global declaration's slot carries its declared type. */
function nativeSupportRow(emission: EmittedPreparedIrProgram, slots: readonly NativeSlot[], slot: NativeSlot) {
  const { declaration, binding } = slot;
  if (declaration.space !== "function") return undefined;
  const params = completedValTypes(emission, slots, declaration.signature.params);
  const results = completedValTypes(emission, slots, declaration.signature.results);
  return params && results ? { bindingId: binding.entry.id, key: declaration.key, params, results } : undefined;
}
function nativeGlobalMatches(emission: EmittedPreparedIrProgram, slots: readonly NativeSlot[], slot: NativeSlot) {
  const { declaration, binding } = slot;
  if (declaration.space !== "global") return true;
  const index = emittedProgramBindingIndex(emission, binding.entry.id)!.index;
  const global = emission.module.globals[index];
  const type = completedValType(emission, slots, declaration.valueType);
  return Boolean(
    global && type && global.mutable === declaration.mutable && preparedIrDataMismatch(type, global.type) === undefined,
  );
}
/**
 * The native setup's runtime callables and the selected native providers join one to one; every other native
 * function is a dependency the setup plan itself declares. Answers the setup's support rows.
 */
function nativeRows(
  emission: EmittedPreparedIrProgram,
  setup: PhysicalNativeStringSetup,
  providers: readonly RuntimeProviderDefinition[],
): readonly SupportCallableRow[] | undefined {
  const slots = nativeSlots(emission, setup);
  if (!slots || !slots.every((slot) => nativeGlobalMatches(emission, slots, slot))) return undefined;
  const runtime = slots.flatMap(({ declaration, binding }) =>
    binding.reference.kind === "func" && binding.reference.binding.kind === "runtime"
      ? [
          declaration.space === "function" && declaration.name === binding.reference.binding.symbol
            ? declaration.name
            : "",
        ]
      : [],
  );
  const symbols = providers.map((provider) => canonicalCallable(RUNTIME_PROVIDERS, provider) ?? "");
  if (
    new Set(runtime).size !== runtime.length ||
    preparedIrDataMismatch([...runtime].sort(), [...symbols].sort()) !== undefined ||
    runtime.includes("")
  )
    return undefined;
  const rows = slots
    .filter((slot) => slot.declaration.space === "function")
    .map((slot) => nativeSupportRow(emission, slots, slot));
  return rows.every((row) => row !== undefined) ? rows : undefined;
}
/**
 * The selected providers and the completed support population join one to one: each remainder its completed
 * resource, each native provider a runtime callable of the native setup (standalone only), and every support
 * receipt exactly one of those rows or a function the native setup plan declares. Without a native setup the
 * numeric contract stays exact: every support function is a remainder.
 */
export function providerCensusMatches(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
  providers: readonly RuntimeProviderDefinition[],
): boolean {
  if (new Set(providers.map((row) => row.id)).size !== providers.length) return false;
  const isRemainder = (row: RuntimeProviderDefinition) =>
    NUMBER_REMAINDER_RUNTIME_PROVIDERS.some((canonical) => canonical.id === row.id);
  const natives = providers.filter((row) => !isRemainder(row));
  const remainders = remainderRows(program, emission, providers.filter(isRemainder));
  const setup = emittedPhysicalSetupPlan(emission).nativeStrings;
  const native = setup && backend.target === "standalone" ? nativeRows(emission, setup, natives) : undefined;
  if (!remainders || (!native && (setup || natives.length))) return false;
  const rows = [...remainders, ...(native ?? [])];
  const receipts = emittedSupportFunctionReceipts(emission);
  return (
    receipts.length === rows.length &&
    new Set(rows.map((row) => row.key)).size === rows.length &&
    new Set(receipts.map((row) => row.index)).size === rows.length &&
    rows.every((row) => supportCallableJoins(emission, receipts, row))
  );
}
/**
 * (#7354) The completed slots of an authenticated native setup, on standalone: reference-typed values the
 * presentation may carry without a widening refusal. Undefined when there is no native setup to authenticate them.
 */
export function nativeSetupSlots(
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
): { readonly types: ReadonlySet<number>; readonly globals: ReadonlySet<number> } | undefined {
  const setup = emittedPhysicalSetupPlan(emission).nativeStrings;
  const slots = setup && backend.target === "standalone" ? nativeSlots(emission, setup) : undefined;
  if (!slots) return undefined;
  const indices = (space: "type" | "global") =>
    new Set(
      slots
        .filter((slot) => slot.declaration.space === space)
        .map((slot) => emittedProgramBindingIndex(emission, slot.binding.entry.id)!.index),
    );
  return { types: indices("type"), globals: indices("global") };
}
