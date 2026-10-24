// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { mixedOwnerFixture } from "./native-mixed-object-access.js";
import type { NativeBooleanReservations } from "../../src/backend/wasmgc/resources/native-booleans.js";
import type { NativeObjectRealmCalls } from "../../src/backend/wasmgc/resources/native-object-realm-calls.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  fillNativeObjectSameValueResources,
} from "../../src/backend/wasmgc/resources/native-object-same-value.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  declareNativeWellKnownSymbolResources,
  reserveNativeWellKnownSymbolResources,
  fillNativeWellKnownSymbolResources,
} from "../../src/backend/wasmgc/resources/native-well-known-symbols.js";
import {
  reserveNativeRealmPopulation,
  fillNativeRealmPopulation,
} from "../../src/backend/wasmgc/resources/native-realm-population.js";
import { deriveNativeObjectAccessRequirements } from "../../src/ir/program/native-object-access-requirements.js";

export function reserveRealmPopulationFixture(
  r: ReturnType<typeof mixedOwnerFixture>,
  booleans: NativeBooleanReservations,
  calls: NativeObjectRealmCalls,
) {
  const { tx, f, c } = r;
  const bigintPlan = declareNativeBigIntResources("population:bigints");
  const bigints = reserveNativeBigIntResources(tx, "population:bigints", bigintPlan);
  const sameValueDependencies = {
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans,
    bigints,
    bigintPlan,
    strings: f.strings,
    flatten: r.flatten,
    equality: r.equality,
  };
  const sameValue = reserveNativeObjectSameValueResources(
    tx,
    "population:same-value",
    sameValueDependencies,
    declareNativeObjectSameValueResources("population:same-value"),
  );
  const descriptorDependencies = {
    access: deriveNativeObjectAccessRequirements(f.program, f.projection),
    storage: r.storage,
    storageDependencies: r.storageDependencies,
    sameValue,
    sameValueDependencies,
    errors: f.substrate.errors,
    errorRequirements: f.substrate.errorRequirements,
    errorDependencies: f.substrate.errorDependencies,
    closures: c.closures,
  };
  const descriptors = reserveNativeObjectDescriptorResources(
    tx,
    "population:descriptors",
    descriptorDependencies,
    declareNativeObjectDescriptorResources("population:descriptors"),
  );
  const symbolDependencies = { symbols: r.symbols, strings: f.strings };
  const symbolPlan = declareNativeWellKnownSymbolResources("population:symbols", [
    "hasInstance",
    "species",
    "toStringTag",
  ]);
  const symbols = reserveNativeWellKnownSymbolResources(
    tx,
    "population:symbols",
    ["hasInstance", "species", "toStringTag"],
    symbolPlan,
    symbolDependencies,
  );
  const dependencies = { calls, descriptors, descriptorDependencies, symbols, symbolPlan, symbolDependencies };
  const pack = reserveNativeRealmPopulation(tx, dependencies);
  return { pack, dependencies, bigints, bigintPlan, sameValue, descriptors, symbols };
}
export function fillRealmPopulationFixture(
  r: Pick<ReturnType<typeof mixedOwnerFixture>, "tx" | "f">,
  p: ReturnType<typeof reserveRealmPopulationFixture>,
) {
  fillNativeBigIntResources(r.tx, p.bigints);
  fillNativeObjectSameValueResources(r.tx, p.sameValue);
  fillNativeObjectDescriptorResources(r.tx, p.descriptors, r.f.exception.tag);
  fillNativeWellKnownSymbolResources(r.tx, p.symbols);
  fillNativeRealmPopulation(r.tx, p.pack);
}
