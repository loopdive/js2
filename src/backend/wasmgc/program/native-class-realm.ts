// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  reserveNativeRealmObjectState,
  requireNativeRealmObjectState,
  fillNativeRealmObjectState,
  nativeRealmObjectStateReservationInventory,
} from "../resources/native-realm-object-layouts.js";
import {
  reserveNativeClassValues,
  requireNativeClassValues,
  fillNativeClassValues,
  requireCompletedNativeClassValues,
  type NativeClassValueReservations,
} from "../resources/native-class-values.js";
import { nativeSourceClosureRealmState, type NativeSourceClosureTypes } from "../resources/native-source-closures.js";

type State = ReturnType<typeof reserveNativeRealmObjectState>;
export interface NativeClassRealm {
  readonly state: State;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly state: State;
  values?: NativeClassValueReservations;
}
const owners = new WeakMap<NativeClassRealm, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeClassRealm): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.state !== pack.state)
    throw Error("native class realm: foreign or copied owner");
  requireNativeRealmObjectState(tx, pack.state);
  if (owner.values) requireNativeClassValues(tx, owner.values);
  return owner;
}
/** Closure state is independent of ordinary-object subtype/dispatch coverage. */
export function reserveNativeClassRealm(tx: PhysicalModuleReservations, key: string): NativeClassRealm {
  const state = reserveNativeRealmObjectState(tx, key + ":object-state"),
    pack = Object.freeze({ state });
  owners.set(pack, { tx, state });
  return pack;
}
/** The class population borrows this exact source closure root and this exact state owner. */
export function reserveNativeClassRealmAllocation(
  tx: PhysicalModuleReservations,
  pack: NativeClassRealm,
  source: NativeSourceClosureTypes,
): void {
  const owner = current(tx, pack);
  if (
    owner.values ||
    !source.requirements.classValues?.length ||
    nativeSourceClosureRealmState(tx, source) !== pack.state
  )
    throw Error("native class realm: duplicate or unrelated class/source population");
  owner.values = reserveNativeClassValues(tx, source.requirements.key + ":class-values", source);
}
export function nativeClassRealmInventory(tx: PhysicalModuleReservations, pack: NativeClassRealm | undefined) {
  if (!pack) return { functions: [], types: [], globals: [] };
  const owner = current(tx, pack),
    state = nativeRealmObjectStateReservationInventory(tx, pack.state);
  if (!owner.values) throw Error("native class realm: missing class allocator population");
  return {
    ...state,
    functions: [...state.functions, owner.values.allocate],
    types: [...state.types, owner.values.type],
  };
}
export function fillNativeClassRealm(tx: PhysicalModuleReservations, pack: NativeClassRealm | undefined): void {
  if (!pack) return;
  const owner = current(tx, pack);
  if (!owner.values) throw Error("native class realm: missing class allocator population");
  fillNativeRealmObjectState(tx, pack.state);
  fillNativeClassValues(tx, owner.values);
  requireCompletedNativeClassValues(tx, owner.values);
}
