// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import { buildRealmOrdinaryObjectAllocation } from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import { buildNativePromiseAllocation } from "../../../runtime/wasmgc/promise/promise-layout.js";
import { nativeRealmPopulationBinding, type NativeRealmPopulation } from "./native-realm-population.js";
import { requireNativePromiseInvocation, type NativePromiseInvocation } from "./native-promise-invocation.js";
import type { NativePromiseReservations } from "./native-promises.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";

export interface NativePromiseObjects {
  readonly promise: NativePromiseReservations;
  readonly population: NativeRealmPopulation;
  readonly create: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly invocation: NativePromiseInvocation;
  filled: boolean;
}
const owners = new WeakMap<NativePromiseObjects, Owner>();
const producers = new WeakSet<NativePromiseReservations>();
function fail(detail: string): never {
  throw Error("native Promise objects: " + detail);
}
function binding(
  tx: PhysicalModuleReservations,
  population: NativeRealmPopulation,
  invocation: NativePromiseInvocation,
  completed: boolean,
) {
  const d = nativeRealmPopulationBinding(tx, population, completed);
  if (!d.source) fail("missing shared source owner");
  const promise = requireNativePromiseInvocation(tx, invocation, d.source);
  if (promise.exceptionTag !== d.realm.exception.tag) fail("different exception owner");
  const prototype = d.realm.ordinaryIntrinsics.find((entry) => entry.intrinsic.id === "%Promise.prototype%");
  if (!prototype || prototype.type !== d.realm.layouts.types.ordinary) fail("missing canonical Promise.prototype");
  return { ...d, prototype };
}
function current(tx: PhysicalModuleReservations, pack: NativePromiseObjects, completed = false) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (owner.invocation.promise !== pack.promise) fail("changed Promise owner");
  return { owner, ...binding(tx, pack.population, owner.invocation, completed) };
}
/** Reserve one allocator for the checked program's Promise carrier and actual populated realm. */
export function reserveNativePromiseObjects(
  tx: PhysicalModuleReservations,
  key: string,
  population: NativeRealmPopulation,
  invocation: NativePromiseInvocation,
): NativePromiseObjects {
  if (tx.state !== "reserving" || typeof key !== "string" || !key) fail("invalid reservation");
  binding(tx, population, invocation, false);
  if (producers.has(invocation.promise)) fail("Promise already has an object producer");
  tx.assertReservationKeysAvailable([key]);
  const create = tx.reserveFunction(key, "__native_promise_create", {
    params: [{ kind: "i32" }],
    results: [{ kind: "ref", typeIdx: invocation.promise.types.promise.typeIndex }],
  });
  const pack = Object.freeze({ promise: invocation.promise, population, create });
  owners.set(pack, { tx, invocation, filled: false });
  producers.add(invocation.promise);
  return pack;
}
function definition(tx: PhysicalModuleReservations, pack: NativePromiseObjects) {
  const { realm, objects, prototype } = current(tx, pack, true);
  const bag = buildRealmOrdinaryObjectAllocation(
    { objectTypeIdx: objects.object.typeIndex, propMapTypeIdx: objects.propMap.typeIndex, initialCapacity: 8 },
    {
      allocationTypeIdx: realm.layouts.types.ordinary.typeIndex,
      stateTypeIdx: realm.layouts.types.state.typeIndex,
      prototype: [{ op: "global.get", index: tx.physicalIndex(prototype.singleton) }, { op: "extern.convert_any" }],
      realm: [{ op: "global.get", index: tx.physicalIndex(realm.globals.realm) }, { op: "ref.as_non_null" }],
    },
  );
  return {
    locals: [],
    body: [
      { op: "call" as const, funcIdx: realm.initialize.handle },
      ...buildNativePromiseAllocation(
        pack.promise.types.promise.typeIndex,
        [...bag, { op: "extern.convert_any" }],
        [{ op: "local.get", index: 0 }],
      ),
    ],
  };
}
export function fillNativePromiseObjects(tx: PhysicalModuleReservations, pack: NativePromiseObjects): void {
  const { owner } = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  tx.fillFunction(pack.create, definition(tx, pack));
  owner.filled = true;
}
/** Property production completion does not certify settlement or builtin algorithms. */
export function nativePromiseObjectBinding(
  tx: PhysicalModuleReservations,
  pack: NativePromiseObjects,
  completed = false,
) {
  const d = current(tx, pack, completed);
  if (completed) {
    if (!d.owner.filled) fail("missing canonical allocator fill");
    requireCanonicalNativeFunction(tx, pack.create, definition(tx, pack));
  }
  return Object.freeze({
    realm: d.realm,
    population: pack.population,
    promise: pack.promise.types.promise,
    bag: d.realm.layouts.types.ordinary,
    create: pack.create,
  });
}
