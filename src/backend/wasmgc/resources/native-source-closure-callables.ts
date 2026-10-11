// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  assertNativeInvocationRequirementsCurrent,
  type NativeInvocationRequirements,
} from "../../../ir/program/native-invocation-requirements.js";
import type { IrFunction } from "../../../ir/core/nodes.js";
import { irUnitCallableBindingId } from "../../../ir/core/callable-bindings.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  requireNativeSourceClosureTypes,
  resolveNativeSourceClosureShape,
  type NativeSourceClosureTypes,
} from "./native-source-closures.js";
import {
  assertNativeRealmRequirementsCurrent,
  type NativeRealmRequirements,
} from "../../../ir/program/native-realm-requirements.js";

export interface NativeSourceClosureCallable {
  readonly unitId: IrUnitId;
  readonly source: IrFunction;
  readonly slot: FunctionReservation;
  readonly shape: NativeSourceClosureTypes["shapes"][number];
  readonly signature: NativeSourceClosureTypes["closures"]["signatures"][number]["binding"];
  readonly publicLength: number;
}
export interface NativeSourceClosureCallables {
  readonly types: NativeSourceClosureTypes;
  readonly requirements: NativeInvocationRequirements;
  readonly entries: readonly NativeSourceClosureCallable[];
}
const owners = new WeakMap<NativeSourceClosureCallables, PhysicalModuleReservations>();
const bindings = new WeakMap<NativeSourceClosureTypes, NativeSourceClosureCallables>();
function fail(detail: string): never {
  throw new Error(`native source closure callables: ${detail}`);
}

function resolveSourceEntries(
  tx: PhysicalModuleReservations,
  types: NativeSourceClosureTypes,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  selected: ReadonlySet<IrUnitId>,
): NativeSourceClosureCallable[] {
  const entries = types.requirements.units
    .filter((unit) => selected.has(unit.unitId))
    .map((unit) => {
      const source = types.requirements.demands.projection.prepared.functions.find((fn) => fn.unitId === unit.unitId);
      const slot = slots.get(unit.unitId);
      if (!source?.closureSubtype || !slot || slot.key !== irUnitCallableBindingId(unit.unitId))
        fail(`unit ${unit.unitId} has no exact prepared source and original function slot`);
      if (source.asyncPlan || source.asyncRuntime) fail(`unit ${unit.unitId} needs its native async completion owner`);
      tx.physicalIndex(slot);
      const shape = resolveNativeSourceClosureShape(
        tx,
        types,
        source.closureSubtype.signature,
        source.closureSubtype.captureFieldTypes,
      );
      if (!shape || shape.id !== unit.shapeId || slot.object.typeIdx !== shape.lowering.funcTypeIdx)
        fail(`unit ${unit.unitId} has a substituted capture shape or lifted signature`);
      const description = types.requirements.shapes.find((row) => row.id === shape.id)!;
      const signature = types.closures.signatures.find((row) => row.id === description.signatureId)?.binding;
      if (!signature || signature.liftedFuncTypeIndex !== slot.object.typeIdx)
        fail(`unit ${unit.unitId} has no exact issued signature binding`);
      const parameters = source.closureSubtype.parameters;
      if (
        !parameters ||
        parameters.kind !== "fixed" ||
        parameters.count !== signature.info.paramTypes.length ||
        parameters.publicLength !== (source.closureSubtype.signature.defaultParamStart ?? parameters.count)
      )
        fail(`unit ${unit.unitId} lacks its fixed-parameter/public-length producer contract`);
      return Object.freeze({
        unitId: unit.unitId,
        source,
        slot,
        shape,
        signature,
        publicLength: parameters.publicLength,
      });
    });
  if (entries.length !== selected.size) fail("selected invocation lacks an original lifted source unit");
  return entries;
}

function resolveEntries(
  tx: PhysicalModuleReservations,
  types: NativeSourceClosureTypes,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  requirements: NativeInvocationRequirements,
): NativeSourceClosureCallable[] {
  requireNativeSourceClosureTypes(tx, types, types.requirements);
  assertNativeInvocationRequirementsCurrent(requirements);
  if (requirements.source !== types.requirements) fail("selected invocation belongs to a different source owner");
  return resolveSourceEntries(
    tx,
    types,
    slots,
    new Set([
      ...requirements.uses.flatMap((use) => (use.liftedUnitId ? [use.liftedUnitId] : [])),
      ...requirements.getterUses.map((use) => use.liftedUnitId),
    ]),
  );
}

/** Associate the consumer's sole unit-slot population after reservation freeze. No allocation or fill. */
export function bindNativeSourceClosureCallables(
  tx: PhysicalModuleReservations,
  types: NativeSourceClosureTypes,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  requirements: NativeInvocationRequirements,
): NativeSourceClosureCallables {
  if (tx.state !== "filling" || bindings.has(types)) fail("source callables require one frozen binding operation");
  const pack = Object.freeze({
    types,
    requirements,
    entries: Object.freeze(resolveEntries(tx, types, slots, requirements)),
  });
  owners.set(pack, tx);
  bindings.set(types, pack);
  return pack;
}

export interface NativeRealmSourceClosureCallables {
  readonly types: NativeSourceClosureTypes;
  readonly realm: NativeRealmRequirements;
  readonly entries: readonly NativeSourceClosureCallable[];
  readonly completionScope: "source-call-association";
}
const realmOwners = new WeakMap<NativeRealmSourceClosureCallables, PhysicalModuleReservations>();
const realmBindings = new WeakMap<NativeSourceClosureTypes, NativeRealmSourceClosureCallables>();
function realmEntries(
  tx: PhysicalModuleReservations,
  types: NativeSourceClosureTypes,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  realm: NativeRealmRequirements,
) {
  requireNativeSourceClosureTypes(tx, types, types.requirements);
  assertNativeRealmRequirementsCurrent(realm);
  if (realm.source !== types.requirements) fail("realm belongs to a different source owner");
  return resolveSourceEntries(tx, types, slots, new Set(realm.description.sourceUnits));
}
/** All actual source units, independently of selected call/apply/getter demands. No Construct or reflection grant. */
export function bindNativeRealmSourceClosureCallables(
  tx: PhysicalModuleReservations,
  types: NativeSourceClosureTypes,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  realm: NativeRealmRequirements,
): NativeRealmSourceClosureCallables {
  if (tx.state !== "filling" || realmBindings.has(types))
    fail("realm source callables require one frozen binding operation");
  const pack = Object.freeze({
    types,
    realm,
    entries: Object.freeze(realmEntries(tx, types, slots, realm)),
    completionScope: "source-call-association" as const,
  });
  realmOwners.set(pack, tx);
  realmBindings.set(types, pack);
  return pack;
}
/** This authenticates the original slot association; canonical IR lowering remains a separate required proof. */
export function requireNativeRealmSourceClosureCallables(
  tx: PhysicalModuleReservations,
  pack: NativeRealmSourceClosureCallables,
  expectedTypes: NativeSourceClosureTypes,
  expectedRealm: NativeRealmRequirements,
): NativeRealmSourceClosureCallables {
  if (
    realmOwners.get(pack) !== tx ||
    pack.types !== expectedTypes ||
    pack.realm !== expectedRealm ||
    realmBindings.get(expectedTypes) !== pack
  )
    fail("foreign, copied or substituted realm callable association");
  const fresh = realmEntries(
    tx,
    expectedTypes,
    new Map(pack.entries.map((row) => [row.unitId, row.slot])),
    expectedRealm,
  );
  if (fresh.length !== pack.entries.length) fail("changed realm callable population");
  for (const [index, row] of fresh.entries()) {
    const old = pack.entries[index]!;
    if (
      row.source !== old.source ||
      row.slot !== old.slot ||
      row.shape !== old.shape ||
      row.signature !== old.signature ||
      row.publicLength !== old.publicLength
    )
      fail(`changed realm callable association for ${row.unitId}`);
  }
  return pack;
}

/** The exact source/capture/slot association, never a function-signature permission. */
export function requireNativeSourceClosureCallables(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureCallables,
  expectedTypes: NativeSourceClosureTypes,
  completed = false,
): NativeSourceClosureCallables {
  if (owners.get(pack) !== tx || pack.types !== expectedTypes || bindings.get(expectedTypes) !== pack)
    fail("foreign, copied or substituted callable association");
  const fresh = resolveEntries(
    tx,
    expectedTypes,
    new Map(pack.entries.map((row) => [row.unitId, row.slot])),
    pack.requirements,
  );
  if (fresh.length !== pack.entries.length) fail("changed callable population");
  for (const [index, row] of fresh.entries()) {
    const old = pack.entries[index]!;
    if (
      row.source !== old.source ||
      row.slot !== old.slot ||
      row.shape !== old.shape ||
      row.signature !== old.signature ||
      row.publicLength !== old.publicLength
    )
      fail(`changed callable association for ${row.unitId}`);
    if (completed) tx.assertCompletedReservation(row.slot);
  }
  return pack;
}
