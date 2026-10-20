// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { liftedOwnerFixture, fillLiftedOwnerFixture } from "./native-realm-lifted-calls.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  reserveNativeRealmPopulation,
  fillNativeRealmPopulation,
} from "../../src/backend/wasmgc/resources/native-realm-population.js";

/** Real full public declarations and original source roots; deliberately missing unimplemented algorithms. */
export function populationFixture(displaced = false, decoded = false) {
  const f = liftedOwnerFixture(displaced, decoded);
  const descriptorDependencies = { ...f.dependencies, closures: f.source.types.closures };
  const descriptors = reserveNativeObjectDescriptorResources(
    f.tx,
    "population:descriptors",
    descriptorDependencies,
    declareNativeObjectDescriptorResources("population:descriptors"),
  );
  const populationDependencies = {
    realm: f.declarations,
    realmDependencies: f.realmDependencies,
    descriptors,
    descriptorDependencies,
  };
  const population = reserveNativeRealmPopulation(f.tx, populationDependencies);
  return { ...f, descriptorDependencies, descriptors, populationDependencies, population };
}
export function fillPopulationDependencies(f: ReturnType<typeof populationFixture>, exception = f.publicException.tag) {
  fillLiftedOwnerFixture(f);
  fillNativeObjectDescriptorResources(f.tx, f.descriptors, exception);
}
export function fillPopulationFixture(f: ReturnType<typeof populationFixture>) {
  fillPopulationDependencies(f);
  fillNativeRealmPopulation(f.tx, f.population);
}
