// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  FunctionReservation,
  PhysicalModuleReservations,
  TagReservation,
  TagImportReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "../../../ir/program/native-object-access-requirements.js";
import { assertNativeValueResourcePlanFor } from "../../../ir/program/native-value-resources.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../../../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import {
  buildOrdinaryDataDescriptorDefinition,
  buildOrdinaryAccessorDescriptorDefinition,
  buildOrdinaryDefineDataDefinition,
  buildOrdinaryDefineAccessorDefinition,
  buildOrdinaryDefineAttributesDefinition,
} from "../../../runtime/wasmgc/values/ordinary-object-descriptor-definitions.js";
import {
  requireNativeObjectStorageReservations,
  requireCompletedNativeObjectStorage,
  type NativeObjectStorageReservations,
  type NativeObjectStorageDependencies,
} from "./native-object-storage.js";
import {
  requireNativeObjectSameValueReservations,
  requireCompletedNativeObjectSameValue,
  type NativeObjectSameValueReservations,
  type NativeObjectSameValueDependencies,
} from "./native-object-same-value.js";
import {
  requireNativeErrorReservations,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorRequirements,
  type NativeErrorDependencies,
} from "./native-errors.js";
import { requireNativeClosureReservations, type NativeClosureReservations } from "./native-closures.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

const DATA_MESSAGES = [
  "TypeError: Cannot define property, object is not extensible",
  "TypeError: Cannot redefine property: configurable attribute of a non-configurable property",
  "TypeError: Cannot redefine property: enumerable attribute of a non-configurable property",
  "TypeError: Cannot redefine property: cannot convert a non-configurable accessor to a data property",
  "TypeError: Cannot redefine property: writable attribute of a non-configurable, non-writable property",
  "TypeError: Cannot assign to read only property of a non-configurable property",
] as const;
const ACCESSOR_MESSAGES = [
  DATA_MESSAGES[1],
  DATA_MESSAGES[2],
  "TypeError: Cannot redefine property: cannot convert a non-configurable data property to an accessor",
  "TypeError: Cannot redefine property: get attribute of a non-configurable property",
  "TypeError: Cannot redefine property: set attribute of a non-configurable property",
] as const;
const BOUNDARY_MESSAGES = [
  "Object.defineProperty called on non-object",
  "TypeError: Invalid property descriptor mask",
  "TypeError: Getter/setter must be a function",
] as const;
/** Required real literals; callers reserve these through the existing string owner. */
export const NATIVE_OBJECT_DESCRIPTOR_LITERALS = Object.freeze([
  ...new Set([...DATA_MESSAGES, ...ACCESSOR_MESSAGES, ...BOUNDARY_MESSAGES]),
]);

export interface NativeObjectDescriptorDependencies {
  readonly access: NativeObjectAccessRequirements;
  readonly storage: NativeObjectStorageReservations;
  readonly storageDependencies: NativeObjectStorageDependencies;
  readonly sameValue: NativeObjectSameValueReservations;
  readonly sameValueDependencies: NativeObjectSameValueDependencies;
  readonly errors: NativeErrorReservations;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
  /** Actual callable carrier classification; invocation remains a separate C2 owner. */
  readonly closures: NativeClosureReservations;
}
export interface NativeObjectDescriptorReservations {
  readonly defineData: FunctionReservation;
  readonly defineAccessor: FunctionReservation;
  readonly defineAttributes: FunctionReservation;
}
const roles = ["data-body", "accessor-body", "define-data", "define-accessor", "define-attributes"] as const;
export function declareNativeObjectDescriptorResources(key: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key) throw new Error("native object descriptors: invalid declaration key");
  const ext = { kind: "externref" } as const,
    flags = { kind: "f64" } as const;
  const data = [ext, ext, ext, flags],
    accessor = [ext, ext, ext, ext, flags];
  const signatures = [
    { params: data, results: [ext] },
    { params: accessor, results: [ext] },
    { params: data, results: [] },
    { params: accessor, results: [] },
    { params: [ext, ext, flags], results: [] },
  ];
  const declarations = roles.map((role, i) => ({
    key: key + ":" + role,
    role: ["ordinary-descriptor", role],
    space: "function" as const,
    name: "__ordinary_object_" + role.replaceAll("-", "_"),
    signature: signatures[i]!,
  }));
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeObjectDescriptorDependencies;
  readonly identities: NativeObjectDescriptorDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly functions: readonly FunctionReservation[];
  exception?: TagReservation | TagImportReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeObjectDescriptorReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native object descriptors: " + detail);
}
function requireDependencies(tx: PhysicalModuleReservations, d: NativeObjectDescriptorDependencies): void {
  assertNativeObjectAccessRequirementsCurrent(d.access);
  requireNativeObjectStorageReservations(tx, d.storage, d.storageDependencies);
  requireNativeObjectSameValueReservations(tx, d.sameValue, d.sameValueDependencies);
  requireNativeErrorReservations(tx, d.errors, d.errorRequirements, d.errorDependencies);
  requireNativeClosureReservations(tx, d.closures);
  const s = d.sameValueDependencies,
    lookup = d.storageDependencies.lookupDependencies;
  if (
    s.strings !== lookup.strings ||
    s.flatten !== lookup.flatten ||
    s.equality !== lookup.equality ||
    d.errorDependencies.strings !== s.strings
  )
    fail("substituted shared string producer");
  assertNativeValueResourcePlanFor(
    s.valuePlan,
    d.access.demands.program,
    d.access.demands.projection,
    s.valuePlan.strings,
  );
  NATIVE_OBJECT_DESCRIPTOR_LITERALS.forEach((value) => requireNativeStringLiteral(tx, s.strings, value));
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectDescriptorReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  for (const key of Object.keys(owner.identities) as (keyof NativeObjectDescriptorDependencies)[])
    if (owner.dependencies[key] !== owner.identities[key]) fail("substituted dependency identity");
  requireDependencies(tx, owner.dependencies);
  if (
    preparedIrDataMismatch(owner.sourcePlan, owner.plan) ||
    preparedIrDataMismatch(declareNativeObjectDescriptorResources(owner.key), owner.plan)
  )
    fail("changed declaration plan");
  if (
    [pack.defineData, pack.defineAccessor, pack.defineAttributes].some((token, i) => token !== owner.functions[i + 2])
  )
    fail("substituted function token");
  if (tx.state !== "reserving") owner.functions.forEach((token) => tx.physicalIndex(token));
  return owner;
}
export function reserveNativeObjectDescriptorResources(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: NativeObjectDescriptorDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectDescriptorReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  requireDependencies(tx, dependencies);
  const plan = declareNativeObjectDescriptorResources(key);
  if (preparedIrDataMismatch(expectedPlan, plan)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const functions = Object.freeze(
    roles.map((role) => requireNativeDeclaredReservation(records, key + ":" + role, "function")),
  );
  const pack = Object.freeze({
    defineData: functions[2]!,
    defineAccessor: functions[3]!,
    defineAttributes: functions[4]!,
  });
  owners.set(pack, {
    tx,
    key,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    sourcePlan: expectedPlan,
    plan,
    functions,
    filled: false,
  });
  return pack;
}
export function requireNativeObjectDescriptorReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectDescriptorReservations,
  expectedDependencies: NativeObjectDescriptorDependencies,
): NativeObjectDescriptorReservations {
  if (requireOwner(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}
function requireCompletedDependencies(tx: PhysicalModuleReservations, d: NativeObjectDescriptorDependencies): void {
  requireCompletedNativeObjectStorage(tx, d.storage, d.storageDependencies);
  requireCompletedNativeObjectSameValue(tx, d.sameValue, d.sameValueDependencies);
  requireCompletedNativeErrors(tx, d.errors, d.errorRequirements, d.errorDependencies);
}
export function fillNativeObjectDescriptorResources(
  tx: PhysicalModuleReservations,
  pack: NativeObjectDescriptorReservations,
  exception: TagReservation | TagImportReservation,
): void {
  const owner = requireOwner(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  // Authenticate the actual shared exception token before filling any body.
  const tagIdx = tx.physicalIndex(exception);
  requireCompletedDependencies(tx, d);
  const values = d.sameValueDependencies.values,
    lookup = d.storageDependencies.lookupDependencies;
  const literal = (value: string): Instr[] => {
    const ref = requireNativeStringLiteral(tx, lookup.strings, value);
    return [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ];
  };
  const errors = (messages: readonly string[]) => ({
    constructorIdx: d.errors.newTypeError.handle,
    tagIdx,
    messages: messages.map(literal),
  });
  const common = {
    objectTypeIdx: lookup.layouts.object.typeIndex,
    propEntryTypeIdx: lookup.layouts.propEntry.typeIndex,
    objFindIdx: d.storageDependencies.lookup.findOwn.handle,
    objInsertIdx: d.storage.insert.handle,
    objGrowIdx: d.storage.grow.handle,
    sameValueIdx: d.sameValue.sameValue.handle,
    flags: ORDINARY_OBJECT_DESCRIPTOR_ENCODING,
  };
  tx.fillFunction(
    owner.functions[0]!,
    buildOrdinaryDataDescriptorDefinition({ ...common, errors: errors(DATA_MESSAGES) }, [
      { op: "global.get", index: tx.physicalIndex(values.globals.undefined) },
    ]),
  );
  tx.fillFunction(
    owner.functions[1]!,
    buildOrdinaryAccessorDescriptorDefinition({
      ...common,
      errors: errors(ACCESSOR_MESSAGES),
      nonExtensible: { ownKeyIdx: undefined, errors: errors([DATA_MESSAGES[0]]) },
    }),
  );
  const boundary = {
    objectTypeIdx: common.objectTypeIdx,
    anyValueTypeIdx: values.types.anyValue.typeIndex,
    closureRootTypeIdx: d.closures.root.typeIndex,
    undefinedGlobalIdx: tx.physicalIndex(values.globals.undefined),
    dataIdx: owner.functions[0]!.handle,
    accessorIdx: owner.functions[1]!.handle,
    errors: errors(BOUNDARY_MESSAGES),
  };
  tx.fillFunction(pack.defineData, buildOrdinaryDefineDataDefinition(boundary));
  tx.fillFunction(pack.defineAccessor, buildOrdinaryDefineAccessorDefinition(boundary));
  tx.fillFunction(pack.defineAttributes, buildOrdinaryDefineAttributesDefinition(boundary, pack.defineData.handle));
  owner.exception = exception;
  owner.filled = true;
}
export function requireCompletedNativeObjectDescriptors(
  tx: PhysicalModuleReservations,
  pack: NativeObjectDescriptorReservations,
  expectedDependencies: NativeObjectDescriptorDependencies,
): NativeObjectDescriptorReservations {
  requireNativeObjectDescriptorReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled || !owner.exception) fail("missing canonical fill");
  tx.physicalIndex(owner.exception);
  requireCompletedDependencies(tx, owner.dependencies);
  owner.functions.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}
export function nativeObjectDescriptorReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectDescriptorReservations,
  expectedDependencies: NativeObjectDescriptorDependencies,
) {
  requireNativeObjectDescriptorReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, functions: owner.functions });
}
