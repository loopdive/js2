// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeStringLiteralReservations } from "./native-string-literals.js";
import {
  reserveNativeErrorConstructor,
  requireNativeErrorConstructor,
  fillNativeErrorConstructor,
  requireCompletedNativeErrorConstructor,
  type NativeErrorConstructorReservations,
  type NativeErrorConstructorDependencies,
  type NativeErrorConstructorRequirements,
} from "./native-error-constructor.js";

/** Compatibility contract for the existing TypeError substrate. */
export interface NativeErrorDependencies {
  readonly strings: NativeStringLiteralReservations;
  readonly typeErrorTag: number;
}
export interface NativeErrorReservations {
  readonly type: TypeReservation;
  readonly newTypeError: FunctionReservation;
}
export interface NativeErrorRequirements {
  readonly key: string;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeErrorRequirements;
  readonly dependencies: NativeErrorDependencies;
  readonly constructorDependencies: NativeErrorConstructorDependencies;
  readonly constructorRequirements: NativeErrorConstructorRequirements;
  readonly resource: NativeErrorConstructorReservations;
}
const owners = new WeakMap<NativeErrorReservations, Owner>();

export function reserveNativeErrorResources(
  tx: PhysicalModuleReservations,
  requirements: NativeErrorRequirements,
  dependencies: NativeErrorDependencies,
): NativeErrorReservations {
  const constructorDependencies = Object.freeze({ strings: dependencies.strings, tag: dependencies.typeErrorTag });
  const constructorRequirements = Object.freeze({ key: requirements.key, kind: "TypeError" as const });
  const resource = reserveNativeErrorConstructor(tx, constructorRequirements, constructorDependencies);
  const pack = Object.freeze({ type: resource.type, newTypeError: resource.construct });
  owners.set(pack, { tx, requirements, dependencies, constructorRequirements, constructorDependencies, resource });
  return pack;
}
function requireOwner(
  tx: PhysicalModuleReservations,
  pack: NativeErrorReservations,
  requirements: NativeErrorRequirements,
  dependencies: NativeErrorDependencies,
): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  if (
    owner.requirements !== requirements ||
    requirements.key !== owner.constructorRequirements.key ||
    owner.dependencies !== dependencies ||
    dependencies.strings !== owner.constructorDependencies.strings ||
    dependencies.typeErrorTag !== owner.constructorDependencies.tag ||
    pack.type !== owner.resource.type ||
    pack.newTypeError !== owner.resource.construct
  )
    throw new Error("native errors: substituted or stale producer inputs");
  requireNativeErrorConstructor(tx, owner.resource, owner.constructorRequirements, owner.constructorDependencies);
  return owner;
}
export function requireNativeErrorReservations(
  tx: PhysicalModuleReservations,
  pack: NativeErrorReservations,
  requirements: NativeErrorRequirements,
  dependencies: NativeErrorDependencies,
): NativeErrorReservations {
  requireOwner(tx, pack, requirements, dependencies);
  return pack;
}
export function requireCompletedNativeErrors(
  tx: PhysicalModuleReservations,
  pack: NativeErrorReservations,
  requirements: NativeErrorRequirements,
  dependencies: NativeErrorDependencies,
): NativeErrorReservations {
  const owner = requireOwner(tx, pack, requirements, dependencies);
  requireCompletedNativeErrorConstructor(
    tx,
    owner.resource,
    owner.constructorRequirements,
    owner.constructorDependencies,
  );
  return pack;
}
export function fillNativeErrorResources(tx: PhysicalModuleReservations, pack: NativeErrorReservations): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  requireOwner(tx, pack, owner.requirements, owner.dependencies);
  fillNativeErrorConstructor(tx, owner.resource);
}
