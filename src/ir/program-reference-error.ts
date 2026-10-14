// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./program/prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import { preparedIrDataMismatch, freezePreparedIrValue } from "./program/data.js";
import { REFERENCE_ERROR_DECLARATION, referenceErrorProviderMismatch } from "./runtime/reference-error-callable.js";
import { irCallableBindingKey } from "./core/callable-bindings.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type {
  reserveNativeStringLiteralResources,
  nativeStringLiteralReservationInventory,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  requireNativeStringLiteral,
  nativeStringLiteralGlobalMatches,
  NativeStringLiteralRequirements,
  NativeStringLiteralReservations,
} from "../backend/wasmgc/resources/native-string-literals.js";
import {
  reserveLinearReferenceErrorResources,
  linearReferenceErrorConstructorBodyMatches,
  linearReferenceErrorConstructorIndex,
  fillLinearReferenceErrorResources,
  requireCompletedLinearReferenceErrorResources,
} from "../backend/linear/program/reference-error.js";
import type {
  CallableReservation,
  FunctionReservation,
  GlobalReservation,
  GlobalImportReservation,
  TypeReservation,
} from "../wasm/physical/module-reservations.js";
import type { WasmFunction, GlobalDef, TypeDef, FuncTypeDef } from "../wasm/model/module-records.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";
import type { WasmModule } from "./types.js";
import type { PhysicalModuleReservations } from "../wasm/physical/module-reservations.js";

export interface PhysicalReferenceError {
  readonly key: string;
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly literals: NativeStringLiteralRequirements;
}

export interface ReferenceErrorLiteralProducers {
  readonly reserve: typeof reserveNativeStringLiteralResources;
  readonly inventory: typeof nativeStringLiteralReservationInventory;
  readonly fill: typeof fillNativeStringLiteralResources;
  readonly requireCompleted: typeof requireCompletedNativeStringLiterals;
  readonly requireLiteral: typeof requireNativeStringLiteral;
  readonly globalMatches: typeof nativeStringLiteralGlobalMatches;
}

interface PhysicalReferenceErrorPack {
  readonly strings: NativeStringLiteralReservations;
  readonly error: ReturnType<typeof reserveLinearReferenceErrorResources>;
  readonly functions: readonly FunctionReservation[];
}
const packOwners = new WeakMap<
  PhysicalReferenceErrorPack,
  {
    tx: PhysicalModuleReservations;
    plan: PhysicalReferenceError;
    guard: () => void;
    literals: ReferenceErrorLiteralProducers;
  }
>();

export interface CompletedPhysicalReferenceErrorReceipt {
  readonly kind: "completed-native-reference-error";
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly constructor: {
    readonly supportKey: string;
    readonly index: number;
    readonly descriptor: WasmFunction;
    readonly signatureIndex: number;
    readonly signature: FuncTypeDef;
  };
  readonly errorType: { readonly key: string; readonly index: number; readonly descriptor: TypeDef };
  readonly name: { readonly text: "ReferenceError"; readonly globalIndex: number; readonly representation: "gc" };
  readonly types: readonly { readonly key: string; readonly index: number; readonly descriptor: TypeDef }[];
  readonly globals: readonly { readonly key: string; readonly index: number; readonly descriptor: GlobalDef }[];
  readonly functions: readonly {
    readonly supportKey: string;
    readonly index: number;
    readonly descriptor: WasmFunction;
  }[];
}
const receiptOwners = new WeakMap<
  CompletedPhysicalReferenceErrorReceipt,
  { tx: PhysicalModuleReservations; module: WasmModule; pack: PhysicalReferenceErrorPack }
>();

function literalProducers(
  tx: PhysicalModuleReservations,
  pack: PhysicalReferenceErrorPack,
): ReferenceErrorLiteralProducers {
  const owner = packOwners.get(pack);
  if (!owner || owner.tx !== tx) invalid("foreign ReferenceError literal owner");
  return owner.literals;
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native ReferenceError: ${detail}`);
}

/** Derive only a selected canonical provider and its existing complete semantic ABI entry. */
export function planPhysicalReferenceError(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): PhysicalReferenceError | undefined {
  if (projection.target !== "standalone" && projection.target !== "wasi") return undefined;
  const providers = projection.prepared.manifest.providers.filter(
    (row) => row.feature === REFERENCE_ERROR_DECLARATION.feature,
  );
  if (!providers.length) return undefined;
  if (
    providers.length !== 1 ||
    providers[0]!.id !== "native.error.reference.construct" ||
    referenceErrorProviderMismatch(providers[0]!) ||
    !providers[0]!.supportedBackends.includes(projection.backend)
  )
    invalid("selected provider is not the complete canonical native declaration");
  const referenceKey = irCallableBindingKey(REFERENCE_ERROR_DECLARATION.ref.binding);
  const entries = program.abi.entries.filter(
    (row) => row.contract.kind === "callable" && irCallableBindingKey(row.contract.ref.binding) === referenceKey,
  );
  if (entries.length !== 1) invalid("constructor lacks one semantic ABI owner");
  const entry = entries[0]!;
  if (
    entry.contract.kind !== "callable" ||
    entry.plan.slotPolicy !== "required" ||
    entry.plan.slotSpace !== "function" ||
    preparedIrDataMismatch(entry.contract.params, REFERENCE_ERROR_DECLARATION.params) !== undefined ||
    preparedIrDataMismatch(entry.contract.results, REFERENCE_ERROR_DECLARATION.results) !== undefined
  )
    invalid("constructor ABI differs from the shared declaration");
  const key = `native:reference-error:${entry.plan.id}`;
  return freezePreparedIrValue({
    key,
    bindingId: entry.plan.id,
    referenceKey,
    literals: { key: `${key}:name`, utf8Storage: false, literals: [{ value: "ReferenceError" }] },
  }) as PhysicalReferenceError;
}

/** Ordinary reservations remain under the common consumer's single transaction and attempt guard. */
export function reservePhysicalReferenceError(
  tx: PhysicalModuleReservations,
  plan: PhysicalReferenceError,
  guard: () => void,
  literals: ReferenceErrorLiteralProducers,
) {
  guard();
  literals = Object.freeze({ ...literals });
  const strings = literals.reserve(tx, plan.literals);
  const requirements = { key: plan.key };
  const dependencies = { strings, referenceErrorTag: -16 };
  const error = reserveLinearReferenceErrorResources(tx, requirements, dependencies, guard);
  const inventory = literals.inventory(tx, strings);
  const functions = [...inventory.functions.map((row) => row.function), error.newReferenceError];
  const pack: PhysicalReferenceErrorPack = Object.freeze({ strings, error, functions: Object.freeze(functions) });
  packOwners.set(pack, { tx, plan, guard, literals });
  return pack;
}

export function fillPhysicalReferenceError(
  tx: PhysicalModuleReservations,
  pack: ReturnType<typeof reservePhysicalReferenceError>,
) {
  linearReferenceErrorConstructorIndex(tx, pack.error);
  literalProducers(tx, pack).fill(tx, pack.strings);
  fillLinearReferenceErrorResources(tx, pack.error);
}

export function requireCompletedPhysicalReferenceError(
  tx: PhysicalModuleReservations,
  pack: ReturnType<typeof reservePhysicalReferenceError>,
) {
  literalProducers(tx, pack).requireCompleted(tx, pack.strings);
  requireCompletedLinearReferenceErrorResources(tx, pack.error);
}

export function reserveAndBindPhysicalReferenceError(
  tx: PhysicalModuleReservations,
  plan: PhysicalReferenceError | undefined,
  guard: () => void,
  context: {
    functionsByKey: Map<string, CallableReservation>;
    resourcesByBinding: Map<
      IrBindingId,
      CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
    >;
  },
  support: Map<WasmFunction, FunctionReservation>,
  literals: ReferenceErrorLiteralProducers,
) {
  if (!plan) return undefined;
  const pack = reservePhysicalReferenceError(tx, plan, guard, literals);
  const token = pack.error.newReferenceError;
  if (context.functionsByKey.has(plan.referenceKey) || context.resourcesByBinding.has(plan.bindingId))
    invalid("constructor has competing physical owners");
  context.functionsByKey.set(plan.referenceKey, token);
  context.resourcesByBinding.set(plan.bindingId, token);
  for (const functionToken of pack.functions) support.set(functionToken.object, functionToken);
  return pack;
}

/** Completed DATA only: actual tokens/descriptors are acquired before the whole attempt ends. */
export function completedPhysicalReferenceErrorReceipt(
  tx: PhysicalModuleReservations,
  pack: PhysicalReferenceErrorPack,
  module: WasmModule,
): CompletedPhysicalReferenceErrorReceipt {
  const owner = packOwners.get(pack);
  if (!owner || owner.tx !== tx) invalid("foreign ReferenceError receipt owner");
  owner.guard();
  requireCompletedPhysicalReferenceError(tx, pack);
  const inventory = owner.literals.inventory(tx, pack.strings);
  const name = owner.literals.requireLiteral(tx, pack.strings, "ReferenceError");
  if (name.kind !== "global") invalid("canonical short Error name requires its actual native global");
  if (!owner.literals.globalMatches(tx, pack.strings, "ReferenceError", false))
    invalid("native name bytes differ from the canonical ReferenceError literal");
  const errorIndex = tx.physicalIndex(pack.error.type);
  const nameIndex = tx.physicalIndex(name.global);
  const ctorToken = pack.error.newReferenceError;
  if (!linearReferenceErrorConstructorBodyMatches(tx, pack.error))
    invalid("constructor differs from the canonical null/message/name/tag recipe");
  const types = [pack.error.type, ...pack.strings.types].map((token) => ({
    key: token.key,
    index: tx.physicalIndex(token),
    descriptor: token.object,
  }));
  const globals = inventory.globals.map((row) => {
    tx.assertCompletedReservation(row.global);
    return { key: row.global.key, index: tx.physicalIndex(row.global), descriptor: row.global.object };
  });
  const functions = pack.functions.map((token) => {
    tx.assertCompletedReservation(token);
    return { supportKey: token.key, index: tx.physicalIndex(token), descriptor: token.object };
  });
  const signatureIndex = ctorToken.object.typeIdx as number;
  const signature = indexPhysicalTypes(module.types).entries[signatureIndex]?.definition;
  if (
    !signature ||
    signature.kind !== "func" ||
    preparedIrDataMismatch(signature.params, [{ kind: "externref" }]) !== undefined ||
    preparedIrDataMismatch(signature.results, [{ kind: "externref" }]) !== undefined
  )
    invalid("constructor signature is not the actual externref ABI");
  const functionOffset = module.imports.filter((row) => row.desc.kind === "func").length;
  const globalOffset = module.imports.filter((row) => row.desc.kind === "global").length;
  const flat = indexPhysicalTypes(module.types).entries;
  if (
    types.some((row) => flat[row.index]?.definition !== row.descriptor) ||
    globals.some((row) => module.globals[row.index - globalOffset] !== row.descriptor) ||
    functions.some((row) => module.functions[row.index - functionOffset] !== row.descriptor)
  )
    invalid("receipt module is not the actual token-owned module");
  const receipt = freezePreparedIrValue({
    kind: "completed-native-reference-error",
    bindingId: owner.plan.bindingId,
    referenceKey: owner.plan.referenceKey,
    constructor: {
      supportKey: ctorToken.key,
      index: tx.physicalIndex(ctorToken),
      descriptor: ctorToken.object,
      signatureIndex,
      signature,
    },
    errorType: types[0],
    name: { text: "ReferenceError", globalIndex: nameIndex, representation: "gc" },
    types,
    globals,
    functions,
  }) as CompletedPhysicalReferenceErrorReceipt;
  receiptOwners.set(receipt, { tx, module, pack });
  return verifyCompletedPhysicalReferenceErrorReceipt(module, receipt);
}

/** Read-only post-emission evidence; never resurrects the revoked executable pack. */
export function verifyCompletedPhysicalReferenceErrorReceipt(
  module: WasmModule,
  receipt: CompletedPhysicalReferenceErrorReceipt,
): CompletedPhysicalReferenceErrorReceipt {
  const owner = receiptOwners.get(receipt);
  if (!owner || owner.module !== module) invalid("foreign or forged completed receipt");
  // Kernel checks authenticate original tokens and all their completed producer bodies,
  // even after seal. The attempt guard is intentionally not reusable as receipt authority.
  for (const token of owner.pack.functions) owner.tx.assertCompletedReservation(token);
  for (const token of owner.pack.strings.types) owner.tx.physicalIndex(token);
  owner.tx.physicalIndex(owner.pack.error.type);
  const literal = literalProducers(owner.tx, owner.pack).inventory(owner.tx, owner.pack.strings);
  for (const row of literal.globals) owner.tx.assertCompletedReservation(row.global);
  const flat = indexPhysicalTypes(module.types).entries;
  const functionOffset = module.imports.filter((row) => row.desc.kind === "func").length;
  const globalOffset = module.imports.filter((row) => row.desc.kind === "global").length;
  if (
    receipt.types.some((row) => preparedIrDataMismatch(flat[row.index]?.definition, row.descriptor) !== undefined) ||
    receipt.globals.some(
      (row) => preparedIrDataMismatch(module.globals[row.index - globalOffset], row.descriptor) !== undefined,
    ) ||
    receipt.functions.some(
      (row) => preparedIrDataMismatch(module.functions[row.index - functionOffset], row.descriptor) !== undefined,
    ) ||
    preparedIrDataMismatch(flat[receipt.constructor.signatureIndex]?.definition, receipt.constructor.signature) !==
      undefined
  )
    invalid("completed ReferenceError module descriptors changed");
  return receipt;
}
