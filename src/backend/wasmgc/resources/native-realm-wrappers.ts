// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7561) The primitive wrappers of a realm that holds a wrapper prototype: #3518's wrapper subtypes and their storage
 * bodies (`native-primitive-wrapper-layouts.ts`, `native-primitive-wrapper-storage.ts`), issued over the realm's own
 * object layouts, which then take their explicit `extensible` opt-in (a wrapper is a subtype of the ordinary object).
 * A realm that holds no wrapper prototype reserves none of this, and its object type stays final.
 */
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  NATIVE_WRAPPER_CONSTRUCTORS,
  type NativeRealmIntrinsic,
} from "../../../runtime/contracts/native-realm-catalog.js";
import type {
  RealmWrapperKind,
  WrapperRepresentation,
} from "../../../runtime/wasmgc/values/primitive-wrapper-bodies.js";
import type { NativeValueReservations } from "./native-values.js";
import type { NativeObjectLayoutDeclarationPlan, NativeObjectLayoutReservations } from "./native-object-layouts.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
  type NativePrimitiveWrapperLayoutReservations,
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
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import type { NativeSymbolCarrierReservations } from "./native-symbol-carrier.js";

/** The selectors of the wrapper kinds whose prototype the realm holds (its rows `heldRows`). */
export function heldWrapperKinds(heldRows: readonly NativeRealmIntrinsic[]): readonly number[] {
  return NATIVE_WRAPPER_CONSTRUCTORS.flatMap((name, selector) =>
    heldRows.some((row) => row.id === `%${name}.prototype%`) ? [selector] : [],
  );
}

export interface NativeRealmWrappers {
  readonly selectors: readonly number[];
  readonly layouts: NativePrimitiveWrapperLayoutReservations;
  readonly storage: NativePrimitiveWrapperStorageReservations;
  readonly storagePlan: NativePrimitiveWrapperStoragePlan;
  readonly storageDependencies: NativePrimitiveWrapperStorageDependencies;
}

/** The wrapper types and storage bodies over the realm's (extensible) object layouts. */
export function reserveNativeRealmWrappers(
  tx: PhysicalModuleReservations,
  key: string,
  selectors: readonly number[],
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
  return Object.freeze({ selectors, layouts, storage, storagePlan, storageDependencies });
}

/** The realm's wrapper resources, for its inventory: the types and storage bodies #3518 issues together. */
export function nativeRealmWrapperInventory(tx: PhysicalModuleReservations, wrappers: NativeRealmWrappers) {
  const inventory = nativePrimitiveWrapperStorageReservationInventory(
    tx,
    wrappers.storage,
    wrappers.storagePlan,
    wrappers.storageDependencies,
  );
  return { functions: inventory.functions, types: Object.values(inventory.layouts.types) };
}

export function fillNativeRealmWrappers(tx: PhysicalModuleReservations, wrappers: NativeRealmWrappers): void {
  fillNativePrimitiveWrapperStorageResources(tx, wrappers.storage);
}

/** How the realm's values represent the primitive a wrapper holds (`SLOT`), physical (fill phase). */
export function realmWrapperRepresentation(
  values: NativeValueReservations,
  anyStrTypeIdx: number,
): WrapperRepresentation {
  return {
    anyStrTypeIdx,
    boxedBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
    boxNumber: values.functions.boxNumber.handle,
    unboxNumber: values.functions.unboxNumber.handle,
    isNumber: values.functions.isNumber.handle,
  };
}

/** The held kinds' types and bodies, physical (fill phase). */
export function realmWrapperKinds(tx: PhysicalModuleReservations, wrappers: NativeRealmWrappers): RealmWrapperKind[] {
  return wrappers.selectors.map((selector) => {
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
