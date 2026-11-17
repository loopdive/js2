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
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../ir/core/nodes.js";
import {
  irStringConcatDemand,
  irStringConstDemand,
  irStringEqDemand,
  irStringLenDemand,
} from "../ir/program/runtime-demands.js";
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
 * chosen here, beside the census that authenticates it: (#7354 D1) the dynamic value also boxes booleans
 * (`__box_boolean`) and probes `undefined` (`__extern_is_undefined`) natively; its own `js.value.*` operations
 * have only a native arm and need no policy.
 */
export function preparedPresentationPolicy(
  backend: PreparedIrBackendOptions["backend"],
  target: PreparedIrBackendOptions["target"],
): RuntimeManifestPolicy {
  return backend === "wasmgc" && target === "standalone"
    ? {
        backend,
        target,
        numberBoundary: { box: "native", unbox: "native" },
        booleanBoundary: { box: "native" },
        externIsUndefined: { probe: "native" },
        stringConst: { storage: "native" },
        stringEq: { eq: "native" },
        stringLen: { len: "native" },
        stringConcat: { concat: "native" },
      }
    : { backend, target };
}

/** A completed support function: the row's key and its slot's index name exactly one receipt, and the slot
 * carries the row's signature. */
interface SupportCallableRow {
  readonly bindingId: IrBindingId;
  readonly key: string;
  readonly params: readonly CompletedValType[];
  readonly results: readonly CompletedValType[];
}
/** A declared value type after resolution; a type key that names no native type slot stays unresolved, so it can
 * never equal a completed slot's type. */
type CompletedValType = ValType | NativeDeclaredValType;
/** Order-free equality of two populations of plain data. */
function samePopulation(left: readonly unknown[], right: readonly unknown[]): boolean {
  const sorted = (rows: readonly unknown[]) =>
    rows
      // A one-element array always serializes to a string, whatever the row is.
      .map((row) => [JSON.stringify([row]), row] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row);
  return preparedIrDataMismatch(sorted(left), sorted(right)) === undefined;
}
const runtimeCallable = (symbol: string) => ({ kind: "runtime-callable", symbol });
/**
 * The one join of the support population, for remainders and natives alike: every row's completed slot carries
 * its signature, and the rows' (slot index, key) pairs are exactly the receipts' — no receipt joins nothing, none
 * joins twice, and no row lacks its receipt.
 */
function supportPopulationJoins(emission: EmittedPreparedIrProgram, rows: readonly SupportCallableRow[]): boolean {
  const joined: (readonly [number, string])[] = [];
  for (const row of rows) {
    const slot = completedFunctionSlot(emission, row.bindingId);
    // A binding without a completed function slot has no signature, so it fails this comparison too.
    const signature = slot && [slot.params, slot.results];
    if (preparedIrDataMismatch([row.params, row.results], signature) !== undefined) return false;
    joined.push([slot!.index, row.key]);
  }
  const receipts = emittedSupportFunctionReceipts(emission).map((row) => [row.index, row.key] as const);
  return samePopulation(joined, receipts);
}
/** The provider exactly as its canonical catalogue (ids unique) defines it, free of dependencies and host
 * capabilities. Its implementation is then joined, as data, to a runtime callable of the physical plan. */
function canonicalProvider(catalogue: readonly RuntimeProviderDefinition[], provider: RuntimeProviderDefinition) {
  return (
    preparedIrDataMismatch(
      catalogue.find((row) => row.id === provider.id),
      provider,
    ) === undefined &&
    !provider.dependencies.length &&
    !provider.hostCapabilities.length
  );
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
    const joined = resources.filter(
      (row) => preparedIrDataMismatch(provider.implementation, runtimeCallable(row.symbol)) === undefined,
    );
    if (!canonicalProvider(NUMBER_REMAINDER_RUNTIME_PROVIDERS, provider) || joined.length !== 1) return undefined;
    const resource = joined[0]!;
    const entry = program.abi.entries.find((row) => row.plan.id === resource.bindingId);
    if (!entry || entry.contract.kind !== "callable") return undefined;
    const declaration = irNumberRemainderCallableDeclaration(entry.contract.ref);
    return declaration?.feature === provider.feature &&
      entry.plan.structuralReferenceKey === resource.referenceKey &&
      preparedIrDataMismatch(entry.contract.params, declaration.params) === undefined &&
      preparedIrDataMismatch(entry.contract.results, declaration.results) === undefined
      ? {
          bindingId: resource.bindingId,
          key: resource.bindingId,
          params: [F64, F64],
          results: [F64],
        }
      : undefined;
  });
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** A native-setup declaration, the binding the setup published for it, and the completed slot of its space. */
interface NativeSlot {
  readonly declaration: NativeStringValueDeclaration;
  readonly binding: NativeStringValueAbiBinding;
  readonly index: number;
}
/** The completed type and global slots of an authenticated native setup: the reference values it owns. */
export interface NativeSetupSlots {
  readonly types: ReadonlySet<number>;
  readonly globals: ReadonlySet<number>;
}
/**
 * Declarations and published bindings of the accepted native setup plan join one to one by key, and the completed
 * emission resolves each binding to a slot of its declaration's space.
 */
function nativeSlots(emission: EmittedPreparedIrProgram, setup: PhysicalNativeStringSetup): NativeSlot[] | undefined {
  const { declarations } = setup.resources;
  if (!setup.bindings.every((binding) => declarations.filter((row) => row.key === binding.resourceKey).length === 1))
    return undefined;
  const slots: NativeSlot[] = [];
  for (const declaration of declarations) {
    const bindings = setup.bindings.filter((row) => row.resourceKey === declaration.key);
    const slot = bindings.length === 1 ? emittedProgramBindingIndex(emission, bindings[0]!.entry.id) : undefined;
    if (slot?.space !== declaration.space) return undefined;
    slots.push({ declaration, binding: bindings[0]!, index: slot.index });
  }
  return slots;
}
/** A declared value type, its resource type key resolved to the completed native type slot it names. */
function completedValType(slots: readonly NativeSlot[], value: NativeDeclaredValType): CompletedValType {
  if (!("typeKey" in value)) return value;
  const type = slots.find((row) => row.declaration.space === "type" && row.declaration.key === value.typeKey);
  if (!type) return value;
  return value.kind === "ref" ? { kind: "ref", typeIdx: type.index } : { kind: "ref_null", typeIdx: type.index };
}
/** A native global slot carries its declared type and mutability. */
function nativeGlobalMatches(emission: EmittedPreparedIrProgram, slots: readonly NativeSlot[], slot: NativeSlot) {
  const { declaration, index } = slot;
  if (declaration.space !== "global") return true;
  const global = emission.module.globals[index]!;
  const type = completedValType(slots, declaration.valueType);
  return global.mutable === declaration.mutable && preparedIrDataMismatch(type, global.type) === undefined;
}
/** (#7354 Str) The string features a Prepared presentation selects, each demanded by its own instruction kind. */
const STRING_FEATURES: ReadonlySet<string> = new Set([
  "js.string.const",
  "js.string.const.utf16",
  "js.string.eq",
  "js.string.len",
  "js.string.concat",
  "js.string.concat.owned",
]);
/** The string features the executable projection demands, by the manifest's own demand scanners. */
function demandedStringFeatures(functions: readonly IrFunction[]): string[] {
  const constant = irStringConstDemand(functions);
  const concat = irStringConcatDemand(functions);
  const demanded: [boolean, string][] = [
    [constant.literal, "js.string.const"],
    [constant.utf16, "js.string.const.utf16"],
    [irStringEqDemand(functions), "js.string.eq"],
    [irStringLenDemand(functions), "js.string.len"],
    [concat.immutable, "js.string.concat"],
    [concat.owned, "js.string.concat.owned"],
  ];
  return demanded.flatMap(([present, feature]) => (present ? [feature] : []));
}
function countInstructions(functions: readonly IrFunction[], kind: IrInstr["kind"]): number {
  let count = 0;
  for (const fn of functions)
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states ?? []).map((state) => state.body),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === kind) count++;
        });
  return count;
}
/** The setup function that implements a string provider the IR reaches through its own instruction, by role. */
const STRING_PROVIDER_ROLES: Readonly<Record<string, readonly string[]>> = {
  "js.string.eq": ["string-equality", "equals"],
  "js.string.concat": ["output", "concat"],
};
const hasRole = (slot: NativeSlot, role: readonly string[]) =>
  role.length === slot.declaration.role.length && role.every((part, index) => slot.declaration.role[index] === part);
/**
 * (#7354 Str) The selected string providers join the executable occurrences that demand them, one provider per
 * demanded feature (no provider without an occurrence, none twice), and each joins what implements it in the
 * native setup:
 * - the literal storage: every executable `string.const` is one literal use, and each use names exactly one
 *   literal global or materializer of the setup by its cache key;
 * - the length field: exactly one string carrier type, whose completed field at the provider's index is an i32;
 * - a by-instruction callable: exactly one setup function of the provider's role, named by the provider's symbol.
 */
function stringProvidersJoin(
  functions: readonly IrFunction[],
  emission: EmittedPreparedIrProgram,
  setup: PhysicalNativeStringSetup,
  slots: readonly NativeSlot[],
  providers: readonly RuntimeProviderDefinition[],
): boolean {
  if (
    !samePopulation(
      providers.map((row) => row.feature),
      demandedStringFeatures(functions),
    )
  )
    return false;
  const roled = (role: readonly string[]) => slots.filter((slot) => hasRole(slot, role));
  return providers.every(({ feature, implementation }) => {
    if (implementation.kind === "native-global") {
      const uses = "literalUses" in setup.resources ? setup.resources.literalUses : [];
      return (
        uses.length === countInstructions(functions, "string.const") &&
        uses.every(
          (use) =>
            roled(["literal-global", use.cacheKey]).length + roled(["literal-materializer", use.cacheKey]).length === 1,
        )
      );
    }
    if (implementation.kind === "carrier-field") {
      const carrier = roled(["string-type", "any"]);
      const type = carrier.length === 1 ? emission.module.types[carrier[0]!.index] : undefined;
      return type?.kind === "struct" && type.fields[implementation.fieldIndex]?.type.kind === "i32";
    }
    // The remaining canonical string providers are callables; the kind test narrows to the symbol.
    if (implementation.kind !== "runtime-callable") return false;
    const owners = roled(STRING_PROVIDER_ROLES[feature] ?? []).map(({ declaration }) =>
      declaration.space === "function" ? declaration.name : undefined,
    );
    return samePopulation(owners, [implementation.symbol]);
  });
}
/**
 * The native setup's support rows: every function it declares, with its declared signature. The runtime-bound ones
 * (named by their runtime symbol) are exactly the selected native callable providers' symbols, the string providers
 * join their occurrences (`stringProvidersJoin`), and every other function is a dependency the setup plan declares.
 */
function nativeRows(
  functions: readonly IrFunction[],
  emission: EmittedPreparedIrProgram,
  setup: PhysicalNativeStringSetup,
  providers: readonly RuntimeProviderDefinition[],
):
  | {
      readonly rows: readonly SupportCallableRow[];
      readonly slots: NativeSetupSlots;
    }
  | undefined {
  const slots = nativeSlots(emission, setup);
  if (!slots?.every((slot) => nativeGlobalMatches(emission, slots, slot))) return undefined;
  const strings = providers.filter((row) => STRING_FEATURES.has(row.feature));
  const callables = providers.filter((row) => !strings.includes(row) && row.implementation.kind === "runtime-callable");
  const answered: ReturnType<typeof runtimeCallable>[] = [];
  const rows: SupportCallableRow[] = [];
  for (const { declaration, binding } of slots) {
    if (declaration.space !== "function") continue;
    const reference = binding.reference;
    if (reference.kind === "func" && reference.binding.kind === "runtime") {
      if (declaration.name !== reference.binding.symbol) return undefined;
      answered.push(runtimeCallable(reference.binding.symbol));
    }
    rows.push({
      bindingId: binding.entry.id,
      key: declaration.key,
      params: declaration.signature.params.map((value) => completedValType(slots, value)),
      results: declaration.signature.results.map((value) => completedValType(slots, value)),
    });
  }
  if (
    !providers.every((row) => canonicalProvider(RUNTIME_PROVIDERS, row)) ||
    !samePopulation(
      answered,
      callables.map((row) => row.implementation),
    ) ||
    providers.some((row) => !strings.includes(row) && !callables.includes(row)) ||
    !stringProvidersJoin(functions, emission, setup, slots, strings)
  )
    return undefined;
  const indices = (space: "type" | "global") =>
    new Set(slots.filter((slot) => slot.declaration.space === space).map((slot) => slot.index));
  return {
    rows,
    slots: { types: indices("type"), globals: indices("global") },
  };
}
/**
 * The runtime census of a numeric presentation. The selected providers and the completed support population join
 * one to one: each remainder its completed resource, each native provider a runtime callable of the native setup
 * (standalone only), and every support receipt exactly one of those rows or a function the native setup plan
 * declares. Answers the native setup's slots when there is one, an empty census when there is none (then every
 * support function is a remainder), and undefined when anything joins nothing.
 */
export function runtimeCensus(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
  providers: readonly RuntimeProviderDefinition[],
): { readonly native?: NativeSetupSlots } | undefined {
  const isRemainder = (row: RuntimeProviderDefinition) =>
    NUMBER_REMAINDER_RUNTIME_PROVIDERS.some((canonical) => canonical.id === row.id);
  const natives = providers.filter((row) => !isRemainder(row));
  const remainders = remainderRows(program, emission, providers.filter(isRemainder));
  const setup = emittedPhysicalSetupPlan(emission).nativeStrings;
  const functions =
    program.runtime.find((row) => row.backend === backend.backend && row.target === backend.target)?.prepared
      .functions ?? [];
  const native = setup && backend.target === "standalone" ? nativeRows(functions, emission, setup, natives) : undefined;
  if (!remainders || (!native && natives.length)) return undefined;
  if (!supportPopulationJoins(emission, [...remainders, ...(native?.rows ?? [])])) return undefined;
  return native ? { native: native.slots } : {};
}
