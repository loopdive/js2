// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The primitive wrappers of a realm that holds a wrapper family: #3518's wrapper subtypes and their storage
 * bodies (`native-primitive-wrapper-layouts.ts`, `native-primitive-wrapper-storage.ts`), issued over the realm's own
 * object layouts, which then take their explicit `extensible` opt-in (the wrappers are subtypes of the ordinary
 * object). A realm that holds no wrapper family reserves none of this, and its object type stays final.
 */
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  NATIVE_WRAPPER_CONSTRUCTORS,
  type NativeRealmIntrinsic,
} from "../../../runtime/contracts/native-realm-catalog.js";
import type { RealmWrapperKind } from "../../../runtime/wasmgc/values/realm-wrapper-bodies.js";
import type { NativeObjectLayoutDeclarationPlan, NativeObjectLayoutReservations } from "./native-object-layouts.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
} from "./native-primitive-wrapper-layouts.js";
import {
  declareNativePrimitiveWrapperStorageResources,
  fillNativePrimitiveWrapperStorageResources,
  nativePrimitiveWrapperStorageReservationInventory,
  reserveNativePrimitiveWrapperStorageResources,
  type NativePrimitiveWrapperStorageDependencies,
  type NativePrimitiveWrapperStoragePlan,
  type NativePrimitiveWrapperStorageReservations,
} from "./native-primitive-wrapper-storage.js";
import type { NativePrimitiveWrapperLayoutReservations } from "./native-primitive-wrapper-layouts.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import type { NativeSymbolCarrierReservations } from "./native-symbol-carrier.js";

/** The wrapper kinds whose family the realm holds (its rows `heldRows`), in selector order. */
export function heldWrapperKinds(heldRows: readonly NativeRealmIntrinsic[]): readonly number[] {
  return NATIVE_WRAPPER_CONSTRUCTORS.flatMap((name, selector) =>
    heldRows.some((row) => row.id === `%${name}%`) ? [selector] : [],
  );
}

export interface NativeRealmWrappers {
  readonly layouts: NativePrimitiveWrapperLayoutReservations;
  readonly storage: NativePrimitiveWrapperStorageReservations;
  readonly storagePlan: NativePrimitiveWrapperStoragePlan;
  readonly storageDependencies: NativePrimitiveWrapperStorageDependencies;
}

/** The wrapper types and storage bodies over the realm's (extensible) object layouts. */
export function reserveNativeRealmWrappers(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: {
    readonly objects: NativeObjectLayoutReservations;
    readonly objectPlan: NativeObjectLayoutDeclarationPlan;
    readonly strings: NativeStringLiteralReservations;
    readonly symbols: NativeSymbolCarrierReservations;
  },
): NativeRealmWrappers {
  const anyString = nativeStringTypeKeys(
    nativeStringLiteralReservationInventory(tx, dependencies.strings).typePack.key,
  ).any;
  const symbol = dependencies.symbols.types.symbol.key;
  const layoutPlan = declareNativePrimitiveWrapperLayouts(key + ":wrapper-types", {
    object: dependencies.objects.object.key,
    propMap: dependencies.objects.propMap.key,
    anyString,
    symbol,
  });
  const layouts = reserveNativePrimitiveWrapperLayouts(tx, key + ":wrapper-types", layoutPlan, dependencies);
  // The ordinary object's initial property capacity (`native-object-storage.ts`).
  const storagePlan = declareNativePrimitiveWrapperStorageResources(key + ":wrappers", { anyString, symbol }, 8);
  const storageDependencies = { layouts, layoutPlan, layoutDependencies: dependencies };
  const storage = reserveNativePrimitiveWrapperStorageResources(
    tx,
    key + ":wrappers",
    storagePlan,
    storageDependencies,
  );
  return Object.freeze({ layouts, storage, storagePlan, storageDependencies });
}

/** The realm's wrapper resources, for its inventory: the five types and ten storage bodies #3518 issues together. */
export function nativeRealmWrapperInventory(tx: PhysicalModuleReservations, wrappers: NativeRealmWrappers) {
  const inventory = nativePrimitiveWrapperStorageReservationInventory(
    tx,
    wrappers.storage,
    wrappers.storagePlan,
    wrappers.storageDependencies,
  );
  return { functions: inventory.functions, types: Object.values(inventory.layouts.types) };
}

export const fillNativeRealmWrappers = (tx: PhysicalModuleReservations, wrappers: NativeRealmWrappers): void =>
  fillNativePrimitiveWrapperStorageResources(tx, wrappers.storage);

/** The held kinds' types and bodies, physical (fill phase). */
export function realmWrapperKinds(
  tx: PhysicalModuleReservations,
  wrappers: NativeRealmWrappers,
  selectors: readonly number[],
): RealmWrapperKind[] {
  return selectors.map((selector) => {
    const kind = NATIVE_WRAPPER_CONSTRUCTORS[selector]!;
    return {
      kind,
      selector,
      typeIdx: tx.physicalIndex(wrappers.layouts.types[kind]),
      allocation: wrappers.storage.allocation[kind].handle,
      read: wrappers.storage.read[kind].handle,
    };
  });
}
