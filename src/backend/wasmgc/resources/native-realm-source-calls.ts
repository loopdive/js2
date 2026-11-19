// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354) The realm functions that serve source calls. Every feature a realm family declares (`sourceCalls`,
 * native-realm-requirements.ts) has at most one row here, written by its family's module: the resource that serves
 * it, and when no other realm pack reserves that resource, the adapter this module reserves there, whose signature is
 * the contract's and whose body is written over the realm's packs. A feature without a row has no native source
 * provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { RealmSourceCallFeature } from "../../../ir/program/native-realm-requirements.js";
import type { NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";
import { ORDINARY_OBJECT_SOURCE_CALL_ROWS } from "./native-source-objects.js";

/** The realm packs an adapter body is written over. */
export interface RealmSourceCallDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
}

export interface RealmSourceCallAdapter {
  readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
  readonly body: (
    dependencies: RealmSourceCallDependencies,
  ) => Parameters<PhysicalModuleReservations["fillFunction"]>[1];
}

/** `resource` is the key below the realm's own; `adapter` is present when this module reserves it. */
export interface RealmSourceCallRow {
  readonly resource: string;
  readonly adapter?: RealmSourceCallAdapter;
}

const ROWS: Readonly<Partial<Record<RealmSourceCallFeature, RealmSourceCallRow>>> = {
  ...ORDINARY_OBJECT_SOURCE_CALL_ROWS,
};

const adapterOf = (feature: RealmSourceCallFeature) => ROWS[feature]?.adapter;

/**
 * The reservation key of the function that serves `feature` in the realm keyed `realmKey`, or `undefined` when the
 * feature has no native source provider. The physical plan's binding rows and the reservations below both use it.
 */
export function realmSourceCallResourceKey(realmKey: string, feature: RealmSourceCallFeature): string | undefined {
  const row = ROWS[feature];
  return row && realmKey + ":" + row.resource;
}

export interface RealmSourceCallReservations {
  readonly adapters: ReadonlyMap<RealmSourceCallFeature, FunctionReservation>;
  readonly dependencies: RealmSourceCallDependencies;
}

/** One adapter per adapted feature the program calls, in feature order. */
export function reserveRealmSourceCallResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  features: readonly RealmSourceCallFeature[],
  dependencies: RealmSourceCallDependencies,
): RealmSourceCallReservations {
  const adapted = [...new Set(features)].filter((feature) => adapterOf(feature) !== undefined).sort();
  const adapters = new Map(
    adapted.map((feature) => {
      const key = realmSourceCallResourceKey(realmKey, feature)!;
      const { signature } = adapterOf(feature)!;
      return [
        feature,
        tx.reserveFunction(key, key, { params: [...signature.params], results: [...signature.results] }),
      ] as const;
    }),
  );
  return Object.freeze({ adapters, dependencies });
}

export function fillRealmSourceCallResources(tx: PhysicalModuleReservations, pack: RealmSourceCallReservations): void {
  for (const [feature, token] of pack.adapters) tx.fillFunction(token, adapterOf(feature)!.body(pack.dependencies));
}
