import { reserveNativeObjectRealmKernelResources } from "../resources/native-object-realm.js";
import { type NativeRealmRequirements } from "../../../ir/program/native-realm-requirements.js";
import { type NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import {
  type PhysicalModuleReservations,
  type FunctionReservation,
  type TypeReservation,
  type GlobalReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  assertNativeStringValueReservationInput,
  reserveNativeStringValueResources,
  nativeStringValueReservationInventory,
  requireCompletedNativeStringValues,
  type NativeStringValueReservationInput,
  type NativeStringValueReservations,
} from "./native-string-values.js";
import { readNativeRealmLiteralInput } from "./native-realm-literals.js";
import {
  reserveNativeVectorTypes,
  requireNativeVectorTypeReservations,
  type NativeVectorTypeReservations,
} from "../resources/native-vectors.js";
import {
  reserveNativeStringLiteralTypes,
  nativeStringLiteralReservationInventory,
  type NativeStringLiteralRequirements,
} from "../resources/native-string-literals.js";
import {
  declareNativeInvocationSubstrateResources,
  reserveNativeInvocationSubstrateResources,
  nativeInvocationSubstrateReservationInventory,
  fillNativeInvocationSubstrateResources,
  requireCompletedNativeInvocationSubstrate,
  type NativeInvocationSubstrateReservations,
} from "../resources/native-invocation-substrate.js";
import {
  declareNativeBuiltinFunctionRequests,
  requireNativeBuiltinFunctionRequests,
  type NativeBuiltinFunctionRequests,
} from "../resources/native-builtin-function-requests.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  reserveNativeClosureResources,
  nativeClosureReservationInventory,
  type NativeClosureReservations,
  type NativeClosureDeclarationPlan,
} from "../resources/native-closures.js";
import { requireNativeSourceClosureTypes, type NativeSourceClosureTypes } from "../resources/native-source-closures.js";
import {
  fillNativeStringEqualityResources,
  nativeStringEqualityReservationInventory,
} from "../resources/native-string-equality.js";
import { fillNativeBooleanResources, requireNativeBooleanReservations } from "../resources/native-booleans.js";
import { fillNativeBigIntResources, nativeBigIntReservationInventory } from "../resources/native-bigint.js";
import {
  fillNativeSymbolCarrierResources,
  nativeSymbolCarrierReservationInventory,
} from "../resources/native-symbol-carrier.js";
import { nativeObjectLayoutReservationInventory } from "../resources/native-object-layouts.js";
import {
  fillNativeObjectLookupResources,
  nativeObjectLookupReservationInventory,
} from "../resources/native-object-access.js";
import {
  fillNativeObjectStorageResources,
  nativeObjectStorageReservationInventory,
} from "../resources/native-object-storage.js";
import {
  fillNativeObjectSameValueResources,
  nativeObjectSameValueReservationInventory,
} from "../resources/native-object-same-value.js";
import {
  fillNativeObjectDescriptorResources,
  nativeObjectDescriptorReservationInventory,
} from "../resources/native-object-descriptors.js";
import {
  fillNativeBuiltinFunctionResources,
  requireCompletedNativeBuiltinFunctionKernel,
  nativeBuiltinFunctionReservationInventory,
} from "../resources/native-builtin-functions.js";
import {
  assertNativeProgramRealmRequirements,
  assertNativeProgramFoundationVectors,
} from "../../../ir/program/native-program-resource-requirements.js";
import { type IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { type Instr } from "../../../wasm/model/instructions.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { nativeJsClassPhysicalBootstrapCall, type NativeJsClassPhysicalValues } from "./native-js-class-session.js";
export {
  reserveNativeJsClassPhysicalValues,
  fillNativeJsClassPhysicalValues,
  assertNativeJsClassPhysicalValuesCurrent,
  nativeJsClassPhysicalRoleType,
  nativeJsClassPhysicalValueType,
  nativeJsClassPhysicalErrorConstructor,
  reserveNativeJsClassPhysicalRealm,
  fillNativeJsClassPhysicalRealm,
  nativeJsClassPhysicalRealmBindings,
  nativeJsClassPhysicalBootstrapCall,
  reserveNativeJsClassPhysicalModuleBindings,
  fillNativeJsClassPhysicalModuleBindings,
  nativeJsClassPhysicalModuleBindings,
  reserveNativeJsClassPhysicalFunctions,
  nativeJsClassPhysicalFunctionSlots,
  requireCompletedNativeJsClassPhysicalFunctions,
  assertNativeJsClassPhysicalLowering,
  nativeJsClassPhysicalLowering,
  emitNativeJsClassPhysicalBox,
  emitNativeJsClassPhysicalFrame,
  emitNativeJsClassPhysicalDefinition,
  emitNativeJsClassPhysicalModuleInitialization,
  emitNativeJsClassPhysicalNormalCompletion,
  assertNativeJsClassPhysicalDescription,
  nativeJsClassPhysicalCallableBindings,
  requireCompletedNativeJsClassPhysicalValues,
  nativeJsClassPhysicalSupportFunctions,
  nativeJsClassPhysicalFunctionPlan,
  assertNativeJsClassPhysicalFunctionPlan,
  nativeJsClassPhysicalSignatureConverter,
} from "./native-js-class-session.js";
export type {
  NativeJsClassPhysicalValues,
  NativeJsClassRealmBinding,
  NativeJsClassFunctionSlot,
} from "./native-js-class-session.js";

// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

function fail(detail: string): never {
  throw Error("native realm composition: " + detail);
}
/** Existing source string selection plus its optional authenticated realm supplement. */

export interface NativeRealmReservations {
  readonly requirements: NativeRealmRequirements;
  readonly strings: NativeStringValueReservations;
  readonly substrate: NativeInvocationSubstrateReservations;
  readonly requests: NativeBuiltinFunctionRequests;
  readonly completionScope: "native-realm-bootstrap";
}
interface Population {
  readonly closures: NativeClosureReservations;
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly sourceTypes?: NativeSourceClosureTypes;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly input: NativeStringValueReservationInput;
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly requirements: NativeRealmRequirements;
  readonly strings: NativeStringValueReservations;
  population?: Population;
  kernel?: ReturnType<typeof reserveNativeObjectRealmKernelResources>;
  phase: "foundation" | "reserving-kernel" | "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeRealmReservations, Owner>();
/** A vector description is data; its association comes from the authenticated selected program. */

function sharedCarriers(owner: Owner) {
  const types = nativeStringLiteralReservationInventory(owner.tx, owner.strings.strings).typePack;
  return {
    vectors: owner.vectors,
    vectorPlan: owner.vectorPlan,
    strings: { types, key: types.key, utf8Storage: types.utf8Storage },
  };
}
function current(tx: PhysicalModuleReservations, pack: NativeRealmReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.requirements !== pack.requirements || owner.strings !== pack.strings)
    fail("foreign or copied realm owner");
  if (owner.phase === "failed") fail("failed composition has no completion authority");
  assertNativeProgramRealmRequirements(pack.requirements);
  assertNativeStringValueReservationInput(owner.input);
  assertNativeProgramFoundationVectors(owner.input, owner.vectorPlan);
  if (owner.input.realmRequirements !== pack.requirements) fail("substituted realm input identity");
  requireNativeVectorTypeReservations(tx, owner.vectors, owner.vectorPlan);
  nativeStringValueReservationInventory(tx, pack.strings);
  nativeInvocationSubstrateReservationInventory(tx, pack.substrate);
  requireNativeBuiltinFunctionRequests(tx, pack.requests);
  if (owner.population) {
    if (owner.population.sourceTypes)
      requireNativeSourceClosureTypes(
        tx,
        owner.population.sourceTypes,
        pack.requirements.source!,
        pack.requests,
        sharedCarriers(owner),
      );
    nativeClosureReservationInventory(tx, owner.population.closures, owner.population.closurePlan);
  }
  return owner;
}
function beginRealm(
  tx: PhysicalModuleReservations,
  input: NativeStringValueReservationInput,
  strings: NativeStringValueReservations,
  vectors: NativeVectorTypeReservations,
  vectorPlan: NativeVectorResourcePlan,
): NativeRealmReservations {
  const requirements = readNativeRealmLiteralInput(
    input,
    input.plan.literalRequirements.utf8Storage,
  )!.realmRequirements;
  const key = requirements.description.key,
    shared = { key: key + ":invocation-substrate" };
  const substrate = reserveNativeInvocationSubstrateResources(
    tx,
    shared,
    { vectors, vectorPlan, strings: strings.strings },
    declareNativeInvocationSubstrateResources(shared, vectors.base ? { vectorBaseKey: vectors.base.key } : {}),
  );
  const intrinsics = requirements.description.catalog.bootstrap.map((id, index) => {
    const row = requirements.description.catalog.intrinsics.find((row) => row.id === id),
      call = row?.callable;
    if (
      !row ||
      !call ||
      call.implementation === "unavailable" ||
      call.initialName !== "" ||
      call.length !== 0 ||
      row.constructible
    )
      fail("catalog bootstrap lacks its supported canonical behavior");
    return {
      id: call.implementation,
      behavior: call.implementation,
      signatureId: "realm:signature:" + index,
      metadataId: "realm:metadata:" + index,
      initialName: call.initialName,
      initialLength: call.length,
      userFormalCount: 0,
      prototype:
        call.implementation === "function-prototype" ? ("object-prototype" as const) : ("function-prototype" as const),
      constructible: false as const,
      aliases: row.aliases,
    };
  });
  const requests = declareNativeBuiltinFunctionRequests(
    tx,
    { key: key + ":builtins", intrinsics },
    {
      arguments: substrate.arguments,
      argumentPlan: substrate.argumentPlan,
      strings: strings.strings,
    },
  );
  let population: Population | undefined;
  if (!requirements.source) {
    const closurePlan = declareNativeClosureResources({
      key: key + ":closures",
      startingClosureCounter: 0,
      requests: requests.requests,
      referenceTypeKeys: requests.referenceTypes.map((row) => row.key),
    });
    const closureRequirements = instantiateNativeClosureRequirements(
      tx,
      closurePlan,
      new Map(requests.referenceTypes.map((row) => [row.key, row])),
    );
    population = Object.freeze({
      closurePlan,
      closures: reserveNativeClosureResources(tx, closureRequirements, closurePlan),
    });
  }
  const pack = Object.freeze({
    requirements,
    strings,
    substrate,
    requests,
    completionScope: "native-realm-bootstrap" as const,
  });
  owners.set(pack, { tx, input, vectors, vectorPlan, requirements, strings, population, phase: "foundation" });
  return pack;
}
/** Preserve unselected reservation order; selected realms authenticate before the first write. */
export function reserveNativeProgramFoundation(
  tx: PhysicalModuleReservations,
  vectorPlan: NativeVectorResourcePlan,
  literals: NativeStringLiteralRequirements | undefined,
  input: NativeStringValueReservationInput | undefined,
) {
  if (input) {
    assertNativeStringValueReservationInput(input);
    assertNativeProgramFoundationVectors(input, vectorPlan);
    if (!literals || preparedIrDataMismatch(literals, input.plan.literalRequirements) !== undefined)
      fail("string declaration differs from the retained input");
  }
  const vectorTypes = reserveNativeVectorTypes(tx, vectorPlan);
  const stringTypes = literals ? reserveNativeStringLiteralTypes(tx, literals.key, literals.utf8Storage) : undefined;
  const earlyStrings =
    input?.realmRequirements && stringTypes ? reserveNativeStringValueResources(tx, input, stringTypes) : undefined;
  const realm = earlyStrings && input ? beginRealm(tx, input, earlyStrings, vectorTypes, vectorPlan) : undefined;
  return { vectorTypes, stringTypes, earlyStrings, realm };
}

/** Consumer retains genuine source binding/lowering authority; no callback can attest its completion. */
export function reserveNativeRealmKernel(
  tx: PhysicalModuleReservations,
  pack: NativeRealmReservations,
  sourceTypes?: NativeSourceClosureTypes,
) {
  const owner = current(tx, pack);
  if (tx.state !== "reserving" || owner.phase !== "foundation") fail("invalid or duplicate kernel reservation phase");
  if (pack.requirements.source) {
    if (!sourceTypes) fail("missing actual source type issuer");
    requireNativeSourceClosureTypes(tx, sourceTypes, pack.requirements.source, pack.requests, sharedCarriers(owner));
    owner.population = Object.freeze({
      sourceTypes,
      closures: sourceTypes.closures,
      closurePlan: sourceTypes.closurePlan,
    });
  } else if (sourceTypes !== undefined) fail("unexpected source owner for no-source realm");
  owner.phase = "reserving-kernel";
  try {
    owner.kernel = reserveNativeObjectRealmKernelResources(tx, pack, owner.input.valueRequirements, owner.population);
    owner.phase = "reserved";
    return owner.kernel.kernel;
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
/** Enumerate real owners once. Borrowed strings, booleans and source bodies stay with their producers. */
export function nativeRealmReservationInventory(tx: PhysicalModuleReservations, pack: NativeRealmReservations) {
  const owner = current(tx, pack),
    k = owner.kernel,
    population = owner.population;
  if (!k || !population) fail("incomplete realm reservation phase");
  const substrate = nativeInvocationSubstrateReservationInventory(tx, pack.substrate);
  const bigints = nativeBigIntReservationInventory(tx, k.bigints, k.bigintPlan);
  const symbols = nativeSymbolCarrierReservationInventory(tx, k.symbols);
  const kernel = nativeBuiltinFunctionReservationInventory(tx, k.kernel);
  const functions: FunctionReservation[] = [
    ...substrate.functions,
    nativeStringEqualityReservationInventory(tx, k.equality).equals,
    ...(k.ownsBooleans ? [k.booleans.isBoolean, k.booleans.unboxBoolean] : []),
    ...bigints.functions,
    ...symbols.resources.flatMap((row) => (row.reservation.kind === "function" ? [row.reservation] : [])),
    ...nativeObjectLookupReservationInventory(tx, k.lookup).functions,
    ...nativeObjectStorageReservationInventory(tx, k.storage).functions,
    ...nativeObjectSameValueReservationInventory(tx, k.sameValue, k.sameValueDependencies).functions,
    ...nativeObjectDescriptorReservationInventory(tx, k.descriptors, k.descriptorDependencies).functions,
    ...kernel.functions,
  ];
  const types: TypeReservation[] = [
    ...substrate.types,
    ...bigints.types,
    ...(!population.sourceTypes
      ? nativeClosureReservationInventory(tx, population.closures, population.closurePlan).filter(
          (row): row is TypeReservation => row.kind === "type",
        )
      : []),
    ...symbols.resources.flatMap((row) => (row.reservation.kind === "type" ? [row.reservation] : [])),
    ...nativeObjectLayoutReservationInventory(tx, k.layouts, k.layoutPlan),
    ...kernel.types,
  ];
  const globals: GlobalReservation[] = [
    ...symbols.resources.flatMap((row) => (row.reservation.kind === "global" ? [row.reservation] : [])),
    ...kernel.globals,
  ];
  requireNativeBooleanReservations(
    tx,
    k.booleans,
    pack.strings.number!.values,
    owner.input.valueRequirements!,
    pack.strings.number!.dependencies,
  );
  if (new Set(functions).size !== functions.length) fail("duplicate native function ownership");
  return Object.freeze({
    functions: Object.freeze(functions),
    types: Object.freeze(types),
    globals: Object.freeze(globals),
    ...population,
    kernel: k.kernel,
    tags: Object.freeze([k.kernel.exception]),
    completionScope: pack.completionScope,
    unavailable: pack.requirements.description.unavailable,
  });
}
export function fillNativeRealmResources(tx: PhysicalModuleReservations, pack: NativeRealmReservations): void {
  const owner = current(tx, pack),
    k = owner.kernel;
  if (tx.state !== "filling" || owner.phase !== "reserved" || !k) fail("invalid or duplicate canonical realm fill");
  requireCompletedNativeStringValues(tx, pack.strings);
  owner.phase = "filling";
  try {
    fillNativeInvocationSubstrateResources(tx, pack.substrate);
    fillNativeStringEqualityResources(tx, k.equality);
    if (k.ownsBooleans) fillNativeBooleanResources(tx, k.booleans);
    fillNativeBigIntResources(tx, k.bigints);
    fillNativeSymbolCarrierResources(tx, k.symbols);
    fillNativeObjectLookupResources(tx, k.lookup);
    fillNativeObjectStorageResources(tx, k.storage);
    fillNativeObjectSameValueResources(tx, k.sameValue);
    fillNativeObjectDescriptorResources(tx, k.descriptors, k.kernel.exception);
    fillNativeBuiltinFunctionResources(tx, k.kernel);
    owner.phase = "complete";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
/** This certifies bootstrap resources only. The consumer separately authenticates its real source bodies. */
export function requireCompletedNativeRealmBootstrap(
  tx: PhysicalModuleReservations,
  pack: NativeRealmReservations,
): NativeRealmReservations {
  const owner = current(tx, pack);
  if (owner.phase !== "complete" || !owner.kernel) fail("incomplete realm bootstrap");
  requireCompletedNativeStringValues(tx, pack.strings);
  requireCompletedNativeInvocationSubstrate(tx, pack.substrate, {
    vectors: owner.vectors,
    vectorPlan: owner.vectorPlan,
    strings: pack.strings.strings,
  });
  requireCompletedNativeBuiltinFunctionKernel(tx, owner.kernel.kernel, owner.kernel.kernelDependencies);
  return pack;
}

export function fillNativeProgramStartupAdapter(
  startAdapter: FunctionReservation | undefined,
  plan: { readonly startup: { readonly units: readonly IrUnitId[]; readonly adapter: string } },
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  reservations: PhysicalModuleReservations,
  onceGuard?: GlobalReservation,
  nativeJsClass?: NativeJsClassPhysicalValues,
): void {
  if (!startAdapter) return;
  if (nativeJsClass && !onceGuard) classStartupFailed("class bootstrap lacks its genuine startup once guard");
  const body = plan.startup.units.map((unitId): Instr => {
    const target = slots.get(unitId);
    if (!target) classStartupFailed(`startup unit ${unitId} has no reserved slot`);
    return { op: "call", funcIdx: target.handle };
  });
  if (onceGuard) {
    const index = reservations.physicalIndex(onceGuard);
    reservations.fillGlobal(onceGuard, [{ op: "i32.const", value: 0 }]);
    if (nativeJsClass) body.unshift(...nativeJsClassPhysicalBootstrapCall(nativeJsClass, plan.startup.units));
    body.unshift(
      { op: "global.get", index },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }], else: [] },
      { op: "global.get", index },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
      { op: "i32.const", value: 1 },
      { op: "global.set", index },
    );
    body.push({ op: "i32.const", value: 2 }, { op: "global.set", index });
  }
  reservations.fillFunction(startAdapter, { locals: [], body });
  if (plan.startup.adapter === "wasm-start") reservations.defineStart(startAdapter);
  else if (plan.startup.adapter === "deferred-export")
    reservations.defineExport("publication:startup", "__module_init", startAdapter);
  else if (plan.startup.adapter === "wasi-start-export")
    reservations.defineExport("publication:startup", "_start", startAdapter);
  else classStartupFailed(`startup adapter ${plan.startup.adapter} has executable units but no materialization`);
}
function classStartupFailed(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `program emission: ${detail}`);
}
