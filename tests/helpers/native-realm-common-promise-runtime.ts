// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect } from "vitest";
import type { fullRealmFixture } from "./native-full-realm-call.js";
import { reserveNumericClassifier } from "./native-realm-primitive-classifier.js";
import { fillNativeNumberPrimitiveClassifierResources } from "../../src/backend/wasmgc/resources/native-number-primitive-classifier.js";
import {
  reserveNativeRealmNumberCoercion,
  fillNativeRealmNumberCoercion,
} from "../../src/backend/wasmgc/resources/native-realm-number-coercion.js";
import {
  reserveNativePromiseThenLookup,
  fillNativePromiseThenLookup,
} from "../../src/backend/wasmgc/resources/native-promise-then-lookup.js";
import {
  reserveNativeCommonPromiseRuntime,
  fillNativeCommonPromiseRuntime,
  nativeCommonPromiseRuntimeBinding,
} from "../../src/backend/wasmgc/resources/native-common-promise-runtime.js";

export function reserveRealmCommonPromiseRuntime(r: ReturnType<typeof fullRealmFixture>) {
  const { tx } = r;
  const classifier = reserveNumericClassifier(r);
  const coercion = reserveNativeRealmNumberCoercion(tx, "promise:number", r.invocation, r.access, classifier);
  const lookup = reserveNativePromiseThenLookup(tx, "promise:then", r.invocation, coercion);
  const before = r.f.module.functions.length;
  expect(() =>
    reserveNativeCommonPromiseRuntime(tx, { ...r.promiseObjects! }, r.promise!.association, r.invocation, lookup),
  ).toThrow(/foreign or copied/);
  expect(r.f.module.functions.length).toBe(before);
  const runtime = reserveNativeCommonPromiseRuntime(
    tx,
    r.promiseObjects!,
    r.promise!.association,
    r.invocation,
    lookup,
  );
  expect(() => nativeCommonPromiseRuntimeBinding(tx, { ...runtime })).toThrow(/foreign or copied/);
  expect(() => nativeCommonPromiseRuntimeBinding(tx, runtime)).toThrow(/missing canonical runtime/);
  return {
    runtime,
    fill() {
      fillNativeNumberPrimitiveClassifierResources(tx, classifier);
      fillNativeRealmNumberCoercion(tx, coercion);
      fillNativePromiseThenLookup(tx, lookup);
      fillNativeCommonPromiseRuntime(tx, runtime);
      expect(nativeCommonPromiseRuntimeBinding(tx, runtime).promise).toBe(r.promise!.resources);
      expect(() => fillNativeCommonPromiseRuntime(tx, runtime)).toThrow(/duplicate/);
    },
  };
}
