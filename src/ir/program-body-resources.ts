// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType, WasmFunction } from "./types.js";
import type { PreparedLinearBodyBindings } from "../backend/linear/program/memory.js";
import type { ProgramAbiMap } from "./program-abi.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrUnitId } from "./identity.js";
import type { IrFuncRef, IrGlobalRef } from "./nodes.js";
import type { IrLowerResolver } from "./lower.js";
import { irCallableBindingKey } from "./callable-bindings.js";
import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { PhysicalSignatureType } from "./program-physical-plan.js";
import { preparedIrDataMismatch } from "./program/data.js";
import type { PhysicalSetupPlan } from "./program-physical-plan.js";
import {
  nativeSourceClosureValueType,
  nativeSourceClosureResolver,
  type NativeSourceClosureEmission,
} from "./program-native-invocation.js";
import type { NativeStringLiteralTypeReservations } from "../backend/wasmgc/resources/native-string-literals.js";
import type {
  reserveNativeVectorHelper,
  nativeVectorPhysicalType,
  resolveNativeVector,
  resolveNativeVectorForElement,
  NativeVectorTypeReservations,
} from "../backend/wasmgc/resources/native-vectors.js";
import type {
  PhysicalModuleReservations,
  CallableReservation,
  GlobalReservation,
  GlobalImportReservation,
  TypeReservation,
  FunctionReservation,
} from "../wasm/physical/module-reservations.js";

export interface PhysicalBodyResources {
  readonly reservations: PhysicalModuleReservations;
  readonly functionsByKey: ReadonlyMap<string, CallableReservation>;
  readonly globalsByKey: ReadonlyMap<string, GlobalReservation | GlobalImportReservation>;
  readonly typesByKey: ReadonlyMap<string, TypeReservation>;
}

function emissionFailed(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `program emission: ${detail}`);
}

export function defaultInit(type: ValType): Instr[] {
  switch (type.kind) {
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    default:
      return emissionFailed(`no default initializer for global type ${type.kind}`);
  }
}

/** Publish the already reserved startup adapter without allocating a new slot. */
export function fillStartupAdapter(
  startAdapter: FunctionReservation | undefined,
  plan: PhysicalSetupPlan,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  reservations: PhysicalModuleReservations,
): void {
  if (!startAdapter) return;
  const body = plan.startup.units.map((unitId): Instr => {
    const target = slots.get(unitId);
    if (!target) emissionFailed(`startup unit ${unitId} has no reserved slot`);
    return { op: "call", funcIdx: target.handle };
  });
  reservations.fillFunction(startAdapter, { locals: [], body });
  if (plan.startup.adapter === "wasm-start") reservations.defineStart(startAdapter);
  else if (plan.startup.adapter === "deferred-export")
    reservations.defineExport("publication:startup", "__module_init", startAdapter);
  else if (plan.startup.adapter === "wasi-start-export")
    reservations.defineExport("publication:startup", "_start", startAdapter);
  else emissionFailed(`startup adapter ${plan.startup.adapter} has executable units but no materialization`);
}

/** Resolve body references only through this transaction's reserved resources. */
export interface NativeVectorCarrierProducers {
  readonly physicalType: typeof nativeVectorPhysicalType;
  readonly resolve: typeof resolveNativeVector;
  readonly resolveElement: typeof resolveNativeVectorForElement;
}

export function physicalBodyResolver(
  vectors: NativeVectorCarrierProducers,
  context: PhysicalBodyResources,
  vectorTypes: NativeVectorTypeReservations,
  stringTypes: NativeStringLiteralTypeReservations | undefined,
  exnTagIdx: number | undefined,
  sourceClosures: NativeSourceClosureEmission | undefined,
  linear?: PreparedLinearBodyBindings,
  target?: PhysicalSetupPlan["target"],
): IrLowerResolver {
  const { functionsByKey, globalsByKey, typesByKey, reservations } = context;
  // Resource validation authenticates this exact shared two-field layout.
  const vectorLowering = (layout: ReturnType<typeof resolveNativeVector>) =>
    layout ? { ...layout, lengthFieldIdx: 0, dataFieldIdx: 1 } : null;
  return {
    resolveFunc: (ref: IrFuncRef) => {
      const reserved = functionsByKey.get(irCallableBindingKey(ref.binding));
      if (!reserved) emissionFailed(`callable ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reserved.handle;
    },
    resolveGlobal: (ref: IrGlobalRef) => {
      const reserved = globalsByKey.get(irGlobalBindingKey(ref.binding));
      if (!reserved) emissionFailed(`global ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reservations.physicalIndex(reserved);
    },
    resolveType: (ref) => {
      const reserved = typesByKey.get(irTypeBindingKey(ref.binding));
      if (!reserved) emissionFailed(`type ${ref.name} was not reserved`);
      return reservations.physicalIndex(reserved);
    },
    ...(stringTypes
      ? {
          resolveString: (): ValType => ({ kind: "ref", typeIdx: stringTypes.layout.anyStrTypeIdx }),
          nativeStrings: () => true,
        }
      : {}),
    ...(sourceClosures ? nativeSourceClosureResolver(reservations, sourceClosures) : {}),
    vectorRepresentation: linear ? "linear" : "wasmgc",
    resolveVec: (type) => {
      if (linear) emissionFailed("persisted GC vector coordinates cannot enter Linear lowering");
      return vectorLowering(vectors.resolve(vectorTypes, type));
    },
    resolveVecForElement: (element, allocation) =>
      linear
        ? linear.resolveVectorLayout({ kind: "val", val: element }, allocation)
        : vectorLowering(vectors.resolveElement(vectorTypes, element)),
    internFuncType: (type) => reservations.internFunctionType(type.params, type.results),
    standardizedExceptions: () => target === "standalone" || target === "wasi",
    ensureExnTag: () => {
      if (exnTagIdx === undefined) emissionFailed("a body requires the __exn tag but the plan reserved none");
      return exnTagIdx;
    },
  };
}

/** Derive unit receipts from the actual module, retaining exact support ownership. */
export function collectPhysicalUnitReceipts(
  module: { readonly functions: readonly WasmFunction[] },
  plan: PhysicalSetupPlan,
  slotOwners: ReadonlyMap<WasmFunction, IrUnitId>,
  supportFunctions: ReadonlySet<WasmFunction>,
): IrUnitId[] {
  const emittedUnitIds: IrUnitId[] = [];
  for (const fn of module.functions) {
    const unitId = slotOwners.get(fn);
    if (unitId === undefined) {
      if (!supportFunctions.has(fn)) emissionFailed(`module carries an unowned function ${fn.name}`);
      continue;
    }
    emittedUnitIds.push(unitId);
  }
  if (emittedUnitIds.length !== plan.functions.length)
    emissionFailed(`module holds ${emittedUnitIds.length} owned bodies but the plan reserved ${plan.functions.length}`);
  if (emittedUnitIds.some((unitId, index) => unitId !== plan.functions[index]!.unitId))
    emissionFailed("module function ownership order contradicts the reserved program projection");
  return emittedUnitIds;
}

export function reservePhysicalImports(
  plan: PhysicalSetupPlan,
  reservations: PhysicalModuleReservations,
  physicalSignature: (signature: {
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  }) => { params: ValType[]; results: ValType[] },
  context: {
    functionsByKey: Map<string, CallableReservation>;
    globalsByKey: Map<string, GlobalReservation | GlobalImportReservation>;
    resourcesByBinding: Map<
      IrBindingId,
      CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
    >;
  },
): void {
  const { functionsByKey, globalsByKey, resourcesByBinding } = context;
  for (const imported of plan.importedFunctions) {
    const reserved = reservations.reserveFunctionImport(
      imported.bindingId,
      imported.module,
      imported.field,
      physicalSignature(imported),
    );
    functionsByKey.set(imported.referenceKey, reserved);
    resourcesByBinding.set(imported.bindingId, reserved);
  }
  for (const imported of plan.importedGlobals) {
    const reserved = reservations.reserveGlobalImport(
      imported.bindingId,
      imported.module,
      imported.field,
      imported.type,
      imported.mutable,
    );
    globalsByKey.set(imported.referenceKey, reserved);
    resourcesByBinding.set(imported.bindingId, reserved);
  }
}

/** Reserve the exact accepted shared or native tag before foundation resources. */
export function reservePhysicalExceptionTag(plan: PhysicalSetupPlan, reservations: PhysicalModuleReservations) {
  return plan.exceptionTag.required
    ? reservations.reserveTag(
        "physical:exception-tag",
        { params: [{ kind: "externref" }], results: [] },
        plan.exceptionTag.shared
          ? { kind: "import", module: "env", name: "__exn" }
          : { kind: "defined", name: "__exn" },
      )
    : undefined;
}

export function reserveStartupAdapter(
  plan: PhysicalSetupPlan,
  tx: PhysicalModuleReservations,
): FunctionReservation | undefined {
  return plan.startup.units.length
    ? tx.reserveFunction("physical:startup-adapter", "__module_init", { params: [], results: [] })
    : undefined;
}

export function physicalSignatureConverter(
  vectors: NativeVectorCarrierProducers,
  vectorTypes: NativeVectorTypeReservations,
  stringTypes: NativeStringLiteralTypeReservations | undefined,
  formatterScratch: NonNullable<PhysicalSetupPlan["nativeStrings"]>["formatterScratch"],
  reservations: PhysicalModuleReservations,
  sourceClosures?: NativeSourceClosureEmission,
) {
  const physicalSignature = (signature: {
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  }) => {
    const convert = (types: readonly PhysicalSignatureType[]): ValType[] =>
      types.map((type) => {
        if (type.kind === "closure" || type.kind === "callable" || type.kind === "boxed") {
          const value = sourceClosures && nativeSourceClosureValueType(reservations, sourceClosures, type);
          if (!value) emissionFailed("logical callable signature has no accepted source type owner");
          return value;
        }
        if (type.kind === "support-ref") {
          if (!stringTypes || !formatterScratch || preparedIrDataMismatch(type, formatterScratch) !== undefined)
            emissionFailed("support signature is not the accepted formatter scratch type");
          return { kind: type.nullable ? "ref_null" : "ref", typeIdx: stringTypes.layout.nativeStrDataTypeIdx };
        }
        if (type.kind === "string") {
          if (!stringTypes) emissionFailed("logical string signature has no accepted string resources");
          return { kind: "ref", typeIdx: stringTypes.layout.anyStrTypeIdx };
        }
        const value = vectors.physicalType(vectorTypes, type.kind === "vec" ? type : { kind: "val", val: type });
        if (!value) emissionFailed("accepted signature has no reserved physical carrier");
        return value;
      });
    return { params: convert(signature.params), results: convert(signature.results) };
  };

  return physicalSignature;
}

export function bindPhysicalAbi(
  abi: ProgramAbiMap,
  plan: PhysicalSetupPlan,
  context: {
    readonly reservations: PhysicalModuleReservations;
    readonly functionsByKey: ReadonlyMap<string, CallableReservation>;
    readonly globalsByKey: ReadonlyMap<string, GlobalReservation | GlobalImportReservation>;
    readonly resourcesByBinding: ReadonlyMap<
      IrBindingId,
      CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
    >;
    readonly slots: ReadonlyMap<IrUnitId, FunctionReservation>;
    readonly vectorHelper: ReturnType<typeof reserveNativeVectorHelper>;
  },
): void {
  const { reservations, functionsByKey, globalsByKey, resourcesByBinding, slots, vectorHelper } = context;
  const native = plan.nativeStrings;
  const formatter = plan.nativeNumberFormat;
  for (const imported of plan.importedFunctions) {
    abi.bindFinalIndex(imported.bindingId, {
      space: "function",
      index: reservations.physicalIndex(functionsByKey.get(imported.referenceKey)!),
    });
  }
  for (const declared of plan.functions) {
    abi.bindFinalIndex(declared.bindingId, {
      space: "function",
      index: reservations.physicalIndex(slots.get(declared.unitId)!),
    });
  }
  if (vectorHelper && plan.vectors.helper) {
    abi.bindFinalIndex(plan.vectors.helper.bindingId, {
      space: "function",
      index: reservations.physicalIndex(vectorHelper.function),
    });
  }
  for (const remainder of plan.numberRemainders) {
    const token = resourcesByBinding.get(remainder.bindingId);
    if (!token || token.kind !== "function" || functionsByKey.get(remainder.referenceKey) !== token)
      emissionFailed("number remainder lost its exact reserved ABI owner");
    abi.bindFinalIndex(remainder.bindingId, { space: "function", index: reservations.physicalIndex(token) });
  }
  for (const global of [...plan.importedGlobals, ...plan.definedGlobals]) {
    abi.bindFinalIndex(global.bindingId, {
      space: "global",
      index: reservations.physicalIndex(globalsByKey.get(global.referenceKey)!),
    });
  }
  if (native) {
    const bound = new Set<IrBindingId>();
    for (const binding of [
      ...native.bindings,
      ...(formatter?.bindings ?? []),
      ...(plan.nativeInvocation?.bindings ?? []),
    ]) {
      if (bound.has(binding.entry.id)) continue;
      const resource = resourcesByBinding.get(binding.entry.id);
      if (!resource || binding.entry.slotPolicy !== "required") emissionFailed("native ABI resource vanished");
      abi.bindFinalIndex(binding.entry.id, {
        space: binding.entry.slotSpace,
        index: reservations.physicalIndex(resource),
      });
      bound.add(binding.entry.id);
    }
  }
  if (plan.referenceError) {
    const token = resourcesByBinding.get(plan.referenceError.bindingId);
    if (!token || token.kind !== "function" || functionsByKey.get(plan.referenceError.referenceKey) !== token)
      emissionFailed("ReferenceError lost its accepted ABI owner");
    abi.bindFinalIndex(plan.referenceError.bindingId, { space: "function", index: reservations.physicalIndex(token) });
  }
  const alreadyBound = new Set([
    ...plan.importedFunctions.map((row) => row.bindingId),
    ...plan.functions.map((row) => row.bindingId),
  ]);
  for (const row of plan.asyncFrames?.entries ?? []) {
    if (row.slotPolicy !== "required" || alreadyBound.has(row.id)) continue;
    const token = resourcesByBinding.get(row.id);
    if (!token) emissionFailed("async ABI resource was not reserved");
    abi.bindFinalIndex(row.id, { space: row.slotSpace, index: reservations.physicalIndex(token) });
    alreadyBound.add(row.id);
  }
  abi.finishBinding();
}
