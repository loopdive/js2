// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  nativeNumberUndefinedPhysicalSignature,
  type NativeNumberUndefinedSignatureUse,
} from "./program-number-undefined-resources.js";
import { buildNumberRemainderBody } from "../wasm/physical/number-remainder.js";
import type { NativeNumberFormatResourceRow } from "../backend/wasmgc/resources/native-number-format.js";

import type { Instr, ValType, WasmFunction } from "./types.js";
import type { PreparedLinearBodyBindings } from "../backend/linear/program/memory.js";
import { ProgramAbiMap } from "./program-abi.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrUnitId } from "./identity.js";
import type { IrFuncRef, IrGlobalRef } from "./nodes.js";
import type { IrLowerResolver } from "./lower.js";
import { irCallableBindingKey } from "./callable-bindings.js";
import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { IrType } from "./core/types.js";
import type { NativeReconciliationContext } from "./program-consumer.js";

import type { AsyncFrameSetup } from "./program/async-frame-setup.js";
import type { PreparedIrProgram, PreparedIrAbiEntry } from "./program/prepared-contracts.js";
import type { PhysicalExport } from "./program-physical-plan.js";
import type { PhysicalImportedFunction } from "./program-physical-plan.js";
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
    case "ref_null":
      return [{ op: "ref.null", typeIdx: type.typeIdx }];
    default:
      return emissionFailed(`no default initializer for global type ${type.kind}`);
  }
}

/** Publish the already reserved startup adapter without allocating a new slot. */

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
  numericAppend?: {
    readonly referenceKey: string;
    requireFunction(): FunctionReservation;
    requestedCapacity(unitId: IrUnitId, value: import("./core/nodes.js").IrValueId): number;
  },
): IrLowerResolver {
  const { functionsByKey, globalsByKey, typesByKey, reservations } = context;
  // Resource validation authenticates this exact shared two-field layout.
  const vectorLowering = (layout: ReturnType<typeof resolveNativeVector>) =>
    layout ? { ...layout, lengthFieldIdx: 0, dataFieldIdx: 1 } : null;
  return {
    resolveFunc: (ref: IrFuncRef) => {
      const key = irCallableBindingKey(ref.binding);
      const reserved = functionsByKey.get(key);
      if (numericAppend?.referenceKey === key && numericAppend.requireFunction() !== reserved)
        emissionFailed("numeric append callable lost its original issued reservation");
      if (!reserved) emissionFailed(`callable ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reserved.handle;
    },
    resolveGlobal: (ref: IrGlobalRef) => {
      const reserved = globalsByKey.get(irGlobalBindingKey(ref.binding));
      if (!reserved) emissionFailed(`global ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reservations.physicalIndex(reserved);
    },
    nativeVectorGlobalReadNonNull: (ref, type) => {
      const reserved = globalsByKey.get(irGlobalBindingKey(ref.binding));
      if (!reserved || reserved.kind !== "global") emissionFailed("native vector global lost its defined reservation");
      const storage = reserved.object.type;
      if (linear && storage.kind === "i32") return false;
      const value = vectors.physicalType(vectorTypes, type);
      if (value?.kind !== "ref" || storage.kind !== "ref_null" || value.typeIdx !== storage.typeIdx)
        emissionFailed("native vector global carrier disagrees with its issued vector resources");
      return true;
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
    ...(linear
      ? { requestedVectorCapacity: linear.requestedVectorCapacity }
      : numericAppend
        ? { requestedVectorCapacity: numericAppend.requestedCapacity }
        : {}),
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
  numericSignature?: NativeNumberUndefinedSignatureUse,
) {
  const physicalSignature = (signature: {
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  }) => {
    const numeric = numericSignature && nativeNumberUndefinedPhysicalSignature(numericSignature, signature);
    if (numeric) return numeric;
    const convert = (types: readonly PhysicalSignatureType[]): ValType[] =>
      types.map((type) => {
        if (type.kind === "dynamic") emissionFailed("logical class dynamic signature has no issued current carrier");
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
  if (plan.numberUndefined) {
    for (const [bindingId, space] of [[plan.numberUndefined.singletonBindingId, "global"]] as const) {
      const token = resourcesByBinding.get(bindingId);
      if (!token || token.kind !== space) emissionFailed("numeric carrier ABI reservation vanished");
      abi.bindFinalIndex(bindingId, {
        space,
        index: reservations.physicalIndex(token),
      });
    }
  }
  if (plan.nativeJsClass) {
    for (const bindingId of plan.nativeJsClass.bindingIds) {
      const token = resourcesByBinding.get(bindingId);
      if (
        token?.kind === "function" &&
        plan.nativeJsClass.callableKeys.some((key) => functionsByKey.get(key) === token)
      )
        abi.bindFinalIndex(bindingId, { space: "function", index: reservations.physicalIndex(token) });
      else if (token?.kind === "global" && plan.nativeJsClass.globalKeys.some((key) => globalsByKey.get(key) === token))
        abi.bindFinalIndex(bindingId, { space: "global", index: reservations.physicalIndex(token) });
      else emissionFailed("class ABI lost its exact issued physical resource");
    }
  }
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
  if (plan.vectors.numericAppendHelper) {
    const binding = plan.vectors.numericAppendHelper;
    const token = resourcesByBinding.get(binding.bindingId);
    if (!token || token.kind !== "function" || functionsByKey.get(binding.referenceKey) !== token)
      emissionFailed("numeric append lost its exact reserved ABI owner");
    abi.bindFinalIndex(binding.bindingId, { space: "function", index: reservations.physicalIndex(token) });
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

export function indexSupportFunctions(
  rows: readonly NativeNumberFormatResourceRow[],
): Map<WasmFunction, FunctionReservation> {
  const functions = new Map<WasmFunction, FunctionReservation>();
  for (const row of rows) {
    if (row.space !== "function") continue;
    const previous = functions.get(row.reservation.object);
    if (previous && previous !== row.reservation) emissionFailed("support function has competing reservation owners");
    functions.set(row.reservation.object, row.reservation);
  }
  return functions;
}

export function completedStartupGuardIndex(
  record:
    | {
        readonly physical: { readonly startup: { readonly onceGuard?: true } };
        readonly startupGuard?: GlobalReservation;
        readonly reservations: PhysicalModuleReservations;
      }
    | undefined,
  validateFunctions: () => unknown,
): number | undefined {
  if (!record)
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "program consumer: startup guard has no completed emission owner",
    );
  validateFunctions();
  if ((record.physical.startup.onceGuard === true) !== (record.startupGuard !== undefined))
    emissionFailed("startup guard differs from the accepted plan");
  if (!record.startupGuard) return undefined;
  record.reservations.assertCompletedReservation(record.startupGuard);
  return record.reservations.physicalIndex(record.startupGuard);
}

export function fillPhysicalScalarResources(
  plan: PhysicalSetupPlan,
  context: {
    readonly reservations: PhysicalModuleReservations;
    readonly globalsByKey: PhysicalBodyResources["globalsByKey"];
    readonly resourcesByBinding: ReadonlyMap<
      IrBindingId,
      CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
    >;
  },
): void {
  const { reservations, globalsByKey } = context;
  for (const global of plan.definedGlobals) {
    const reserved = globalsByKey.get(global.referenceKey);
    if (!reserved || reserved.kind !== "global") emissionFailed(`global ${global.name} has no defined reservation`);
    reservations.fillGlobal(reserved, defaultInit(reserved.object.type));
  }
  for (const resource of plan.numberRemainders) {
    const token = context.resourcesByBinding.get(resource.bindingId);
    if (!token || token.kind !== "function") emissionFailed("number remainder reservation vanished before fill");
    context.reservations.fillFunction(token, buildNumberRemainderBody(resource.earlyMagnitude));
  }
}

export function reserveNumberRemainders(
  plan: PhysicalSetupPlan,
  context: NativeReconciliationContext,
  supportFunctions: Map<WasmFunction, FunctionReservation>,
): void {
  const { reservations, functionsByKey, resourcesByBinding } = context;
  for (const resource of plan.numberRemainders) {
    const token = reservations.reserveFunction(resource.bindingId, resource.symbol, {
      params: [...resource.params],
      results: [...resource.results],
    });
    if (functionsByKey.has(resource.referenceKey) || resourcesByBinding.has(resource.bindingId))
      emissionFailed("number remainder has competing physical owners");
    functionsByKey.set(resource.referenceKey, token);
    resourcesByBinding.set(resource.bindingId, token);
    supportFunctions.set(token.object, token);
  }
}

export function appendPhysicalImports(
  imports: readonly PhysicalImportedFunction[],
  importedFunctions: PhysicalImportedFunction[],
): void {
  for (const imported of imports) {
    const previous = importedFunctions.find((row) => row.referenceKey === imported.referenceKey);
    if (previous) {
      if (
        previous.bindingId !== imported.bindingId ||
        preparedIrDataMismatch(previous.params, imported.params) !== undefined ||
        preparedIrDataMismatch(previous.results, imported.results) !== undefined
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "canonical host import contradicts existing physical import",
        );
    } else
      importedFunctions.push({
        bindingId: imported.bindingId,
        referenceKey: imported.referenceKey,
        module: imported.module,
        field: imported.field,
        params: imported.params,
        results: imported.results,
      });
  }
}

export function scalar(type: IrType): ValType | undefined {
  return type.kind === "val" ? type.val : undefined;
}

export function numeric(type: ValType): boolean {
  return type.kind === "i32" || type.kind === "i64" || type.kind === "f32" || type.kind === "f64";
}

export function typeLabel(type: IrType): string {
  return type.kind === "val" ? type.val.kind : type.kind;
}

export function appendAsyncPhysicalResources(
  asyncFrames: AsyncFrameSetup | undefined,
  importedFunctions: PhysicalImportedFunction[],
  exports: PhysicalExport[],
): void {
  for (const frame of asyncFrames?.frames ?? []) {
    appendPhysicalImports(frame.imports, importedFunctions);
    exports.push(
      ...frame.callbacks.map((row) => ({
        externalName: row.externalName,
        targetBindingId: row.targetBindingId,
        space: "function" as const,
      })),
    );
  }
}

export function canonicalEntry(
  entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>,
  id: IrBindingId,
): PreparedIrAbiEntry | undefined {
  const seen = new Set<IrBindingId>();
  let current = entries.get(id);
  while (current && current.plan.slotPolicy === "alias" && !seen.has(current.plan.id)) {
    seen.add(current.plan.id);
    current = entries.get(current.plan.aliasOf);
  }
  return current;
}

export function publishPhysicalExports(
  plan: PhysicalSetupPlan,
  abi: ProgramAbiMap,
  context: NativeReconciliationContext,
): void {
  const { module, reservations, resourcesByBinding } = context;
  const exportNames = new Set<string>(module.exports.map((entry) => entry.name));
  for (const exported of plan.exports) {
    const final = abi.resolveFinalIndex(exported.targetBindingId);
    if (!final || final.space !== exported.space) {
      emissionFailed(`export ${exported.externalName} does not resolve to a bound ${exported.space}`);
    }
    const reserved = resourcesByBinding.get(abi.canonicalId(exported.targetBindingId));
    if (
      !reserved ||
      reserved.kind === "type" ||
      reservations.physicalIndex(reserved) !== final.index ||
      (reserved.kind === "function" || reserved.kind === "function-import" ? "function" : "global") !== final.space
    ) {
      emissionFailed(`export ${exported.externalName} contradicts its canonical physical reservation`);
    }
    if (exportNames.has(exported.externalName)) emissionFailed(`export ${exported.externalName} is declared twice`);
    exportNames.add(exported.externalName);
    reservations.defineExport(`publication:export:${exported.externalName}`, exported.externalName, reserved);
  }
}

export function reconcileInvocationBindings(
  plan: PhysicalSetupPlan,
  functions: readonly FunctionReservation[],
  { functionsByKey, resourcesByBinding }: NativeReconciliationContext,
): void {
  for (const binding of plan.nativeInvocation?.bindings ?? []) {
    const token = functions.find((row) => row.key === binding.resourceKey);
    if (
      !token ||
      functionsByKey.has(irCallableBindingKey(binding.reference.binding)) ||
      resourcesByBinding.has(binding.entry.id)
    )
      emissionFailed("invocation semantic binding lacks its unique actual resource");
    functionsByKey.set(irCallableBindingKey(binding.reference.binding), token);
    resourcesByBinding.set(binding.entry.id, token);
  }
}

export function sealedPhysicalProgramAbi(program: PreparedIrProgram): ProgramAbiMap {
  const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const entry of program.abi.entries) abi.plan(entry.plan);
  abi.sealPlan();
  return abi;
}

export function activeEmissionResolver(resolver: IrLowerResolver, assertEmissionActive: () => void): IrLowerResolver {
  assertEmissionActive();
  return Object.fromEntries(
    Object.entries(resolver).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: unknown[]) => {
            assertEmissionActive();
            return Reflect.apply(value, resolver, args);
          }
        : value,
    ]),
  ) as IrLowerResolver;
}
