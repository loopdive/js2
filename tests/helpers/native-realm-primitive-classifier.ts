// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { fullRealmFixture as fixture } from "./native-full-realm-call.js";
import {
  declareNativeNumberPrimitiveClassifierResources,
  reserveNativeNumberPrimitiveClassifierResources,
} from "../../src/backend/wasmgc/resources/native-number-primitive-classifier.js";
export function reserveNumericClassifier(r: ReturnType<typeof fixture>) {
  const classifierDependencies = {
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans: r.booleans,
    bigints: r.population.bigints,
    bigintPlan: r.population.bigintPlan,
    strings: r.f.strings,
    symbols: r.symbols,
  };
  return reserveNativeNumberPrimitiveClassifierResources(
    r.tx,
    "control:classifier",
    declareNativeNumberPrimitiveClassifierResources("control:classifier"),
    classifierDependencies,
  );
}
