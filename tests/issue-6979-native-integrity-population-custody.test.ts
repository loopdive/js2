// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  objectExtensibilityFixture,
  fillObjectExtensibilityDependencies,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativeObjectIntegrityAlgorithms,
  fillNativeObjectIntegrityAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-integrity.js";
import {
  nativeRealmPopulationDependencies,
  fillNativeRealmPopulation,
} from "../src/backend/wasmgc/resources/native-realm-population.js";
import { fillNativeObjectSameValueResources } from "../src/backend/wasmgc/resources/native-object-same-value.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeBooleanResources } from "../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeNumberPrimitiveClassifierResources,
  reserveNativeNumberPrimitiveClassifierResources,
} from "../src/backend/wasmgc/resources/native-number-primitive-classifier.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
describe("integrity consumes the genuine independent population owner", () => {
  let r: ReturnType<typeof objectExtensibilityFixture>;
  beforeAll(async () => {
    r = objectExtensibilityFixture(false, false, "interned", false, false, false, false, false, true, true);
    await setImmediate();
  }, 120000);
  it("refuses copied/foreign population owners before duplicate-claim or reservation effects", () => {
    const population = r.intrinsic!.population;
    expect(nativeRealmPopulationDependencies(r.tx, population)).toBeDefined();
    expect(() => reserveNativeObjectIntegrityAlgorithms(r.tx, r.algorithmDependencies, { ...population })).toThrow(
      /foreign or copied population owner/,
    );
    expect(() =>
      nativeRealmPopulationDependencies(new PhysicalModuleReservations(createEmptyModule()), population),
    ).toThrow(/foreign or copied population owner/);
    const original = r.intrinsic!.populationDependencies.descriptorDependencies;
    r.intrinsic!.populationDependencies.descriptorDependencies = { ...original };
    expect(() => reserveNativeObjectIntegrityAlgorithms(r.tx, r.algorithmDependencies, population)).toThrow(
      /substituted dependency identity/,
    );
    r.intrinsic!.populationDependencies.descriptorDependencies = original;
    const booleans = reserveNativeBooleanResources(
      r.tx,
      "negative:population-booleans",
      r.values,
      r.valuePlan,
      r.valueDependencies,
    );
    const primitiveDependencies = { ...r.primitiveDependencies, booleans };
    const primitivePlan = declareNativeNumberPrimitiveClassifierResources("negative:population-primitives");
    const primitives = reserveNativeNumberPrimitiveClassifierResources(
      r.tx,
      "negative:population-primitives",
      primitivePlan,
      primitiveDependencies,
    );
    // Independently genuine same-ledger family, not a copied or forged token.
    expect(() =>
      reserveNativeObjectIntegrityAlgorithms(
        r.tx,
        { ...r.algorithmDependencies, primitives, primitivePlan, primitiveDependencies },
        population,
      ),
    ).toThrow(/population does not share the original realm\/value\/descriptor owners/);
    expect(() => reserveNativeObjectIntegrityAlgorithms(r.tx, r.algorithmDependencies, population)).toThrow(
      /already has/,
    );
  });
  describe("receipt-valid alternate initializer", () => {
    beforeAll(async () => {
      fillObjectExtensibilityDependencies(r);
      await setImmediate();
      fillNativeObjectSameValueResources(r.tx, r.intrinsic!.sameValue);
      await setImmediate();
      fillNativeObjectDescriptorResources(r.tx, r.intrinsic!.descriptors, r.realm.declarations.exception.tag);
      await setImmediate();
    }, 120000);
    it("does not admit intrinsic bags from an unfilled initializer or an allocator-valid replacement", () => {
      const { population } = r.intrinsic!;
      expect(() => fillNativeObjectIntegrityAlgorithms(r.tx, r.integrity!)).toThrow(
        /missing canonical population initializer fill/,
      );
      const fill = r.tx.fillFunction.bind(r.tx);
      vi.spyOn(r.tx, "fillFunction").mockImplementation((token, definition) =>
        fill(token, token === population.initialize ? { locals: [], body: [] } : definition),
      );
      fillNativeRealmPopulation(r.tx, population);
      r.tx.assertCompletedReservation(population.initialize);
      expect(() => fillNativeObjectIntegrityAlgorithms(r.tx, r.integrity!)).toThrow(/noncanonical function definition/);
      expect(r.tx.state).toBe("failed");
    }, 120000);
  });
});
