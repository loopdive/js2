// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  assertPreparedIrData,
  preparedIrDataMismatch,
  createPreparedIrDataObject,
  copyPreparedIrDataObject,
} from "../src/shared/contracts/prepared-ir-data.js";
it("creates distinct ordinary mutable records without schema or caller registration", () => {
  const a = createPreparedIrDataObject(),
    b = createPreparedIrDataObject();
  expect(a).not.toBe(b);
  expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
  expect(Reflect.ownKeys(a)).toEqual([]);
  a.n = 1;
  assertPreparedIrData(a);
  a.n = 2;
  expect(preparedIrDataMismatch({ n: 1 }, a)).toBeDefined();
  expect(Object.getPrototypeOf(Reflect.apply(createPreparedIrDataObject, new Map(), [new Map()]))).toBe(
    Object.prototype,
  );
});
it("copies native own order, descriptors, special numbers and shared aliases without reading values twice", () => {
  const shared = {},
    symbol = Symbol("key"),
    input = { z: undefined, n: NaN, zero: -0, shared };
  Object.defineProperty(input, "hidden", { value: 3 });
  Object.defineProperty(input, symbol, { value: shared, enumerable: true, writable: false, configurable: false });
  const result = copyPreparedIrDataObject(input);
  expect(result).not.toBe(input);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Reflect.ownKeys(result)).toEqual(
    Reflect.ownKeys(input).filter((k) => Object.getOwnPropertyDescriptor(input, k)!.enumerable),
  );
  for (const key of Reflect.ownKeys(result))
    expect(Object.getOwnPropertyDescriptor(result, key)).toEqual(Object.getOwnPropertyDescriptor(input, key));
  expect(result.shared).toBe(shared);
  expect(result[symbol]).toBe(shared);
  expect(Object.is(result.zero, -0)).toBe(true);
  expect(Number.isNaN(result.n)).toBe(true);
});
it.each(["Map", "Set", "WeakMap", "WeakSet"] as const)(
  "never brands a masked %s initializer or its nested identity",
  (kind) => {
    const input =
      kind === "Map" ? new Map() : kind === "Set" ? new Set() : kind === "WeakMap" ? new WeakMap() : new WeakSet();
    Object.setPrototypeOf(input, Object.prototype);
    Object.defineProperty(input, "n", { value: 7, enumerable: true });
    const output = copyPreparedIrDataObject(input);
    assertPreparedIrData(output);
    expect(output.n).toBe(7);
    expect(() => assertPreparedIrData(input)).toThrow();
    expect(() => assertPreparedIrData(copyPreparedIrDataObject({ input }))).toThrow();
  },
);
it.each([null, undefined, 1, "x", [], Object.create(null), new Date()])(
  "refuses nonordinary initializer %#",
  (value) => {
    expect(() => copyPreparedIrDataObject(value as object)).toThrow();
  },
);
it("rejects enumerable accessors without executing them, including inherited value descriptor poison", () => {
  let reads = 0;
  const input = {};
  Object.defineProperty(input, "x", {
    get() {
      reads++;
      return 1;
    },
    enumerable: true,
  });
  const old = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  let rejected = false;
  try {
    Object.defineProperty(Object.prototype, "value", {
      get() {
        reads++;
        return 1;
      },
      configurable: true,
    });
    try {
      copyPreparedIrDataObject(input);
    } catch {
      rejected = true;
    }
  } finally {
    if (old) Object.defineProperty(Object.prototype, "value", old);
    else Reflect.deleteProperty(Object.prototype, "value");
  }
  expect(rejected).toBe(true);
  expect(reads).toBe(0);
});
it("bypasses inherited setters and descriptor get/set poison while retaining own DATA definitions", () => {
  let calls = 0;
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, "x"),
    get = Object.getOwnPropertyDescriptor(Object.prototype, "get"),
    set = Object.getOwnPropertyDescriptor(Object.prototype, "set");
  let output: object | undefined;
  try {
    Object.defineProperty(Object.prototype, "x", {
      set() {
        calls++;
      },
      configurable: true,
    });
    Object.defineProperty(Object.prototype, "get", {
      get() {
        calls++;
        return () => 1;
      },
      configurable: true,
    });
    Object.defineProperty(Object.prototype, "set", {
      get() {
        calls++;
        return () => 1;
      },
      configurable: true,
    });
    output = copyPreparedIrDataObject({ x: 7 });
  } finally {
    for (const [key, old] of [
      ["x", prior],
      ["get", get],
      ["set", set],
    ] as const) {
      if (old) Object.defineProperty(Object.prototype, key, old);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
  expect(calls).toBe(0);
  expect(Object.getOwnPropertyDescriptor(output!, "x")).toEqual({
    value: 7,
    writable: true,
    enumerable: true,
    configurable: true,
  });
});
it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "hasOwn"] as const)(
  "uses captured %s after import",
  (key) => {
    const holder = key === "hasOwn" ? Object : Reflect,
      old = Object.getOwnPropertyDescriptor(holder, key)!;
    let calls = 0;
    let output: object | undefined;
    try {
      Object.defineProperty(holder, key, {
        ...old,
        value() {
          calls++;
          throw Error("live intrinsic");
        },
      });
      output = copyPreparedIrDataObject({ n: 7 });
    } finally {
      Object.defineProperty(holder, key, old);
    }
    expect(calls).toBe(0);
    expect(output).toEqual({ n: 7 });
  },
);
it.each(["getter", "prototype", "function", "cycle"] as const)(
  "rechecks live %s after ordinary construction",
  (kind) => {
    const result = copyPreparedIrDataObject({ n: 1 });
    assertPreparedIrData(result);
    let reads = 0;
    if (kind === "getter")
      Object.defineProperty(result, "x", {
        get() {
          reads++;
          return 1;
        },
      });
    if (kind === "prototype") Object.setPrototypeOf(result, { foreign: true });
    if (kind === "function") result.x = () => 1;
    if (kind === "cycle") result.x = result;
    expect(() => assertPreparedIrData(result)).toThrow();
    expect(reads).toBe(0);
  },
);
it("documents reflection effects on arbitrary Proxies without granting their input a brand", () => {
  let traps = 0;
  const target = { n: 7 },
    proxy = new Proxy(target, {
      ownKeys(t) {
        traps++;
        return Reflect.ownKeys(t);
      },
    });
  expect(copyPreparedIrDataObject(proxy)).toEqual(target);
  expect(traps).toBe(1);
});

// Computational record semantics only; these coordinates do not issue a Model or program/engine evidence.
import { createReplayLocation } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
it("preserves fixed replay location fields, descriptors, aliases and live DATA checks", () => {
  const unitId = "computational-location" as Parameters<typeof createReplayLocation>[0],
    nestedPath = [2, 0];
  const expected = copyPreparedIrDataObject({ unitId, blockOrdinal: 3, nestedPath, instructionOrdinal: 7 });
  const define = Reflect.defineProperty,
    iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
  let calls = 0,
    iterations = 0;
  let actual: ReturnType<typeof createReplayLocation> | undefined;
  try {
    Reflect.defineProperty = () => {
      calls++;
      throw Error("must use captured property definition");
    };
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iterator,
      value() {
        iterations++;
        throw Error("must not add live array iteration");
      },
    });
    actual = createReplayLocation(unitId, 3, nestedPath, 7);
  } finally {
    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
    } finally {
      Reflect.defineProperty = define;
    }
  }
  expect(calls).toBe(0);
  expect(iterations).toBe(0);
  if (!actual) throw Error("missing actual fixed location result");
  expect(actual).not.toBe(expected);
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Reflect.ownKeys(actual)).toEqual(["unitId", "blockOrdinal", "nestedPath", "instructionOrdinal"]);
  expect(Object.getOwnPropertyDescriptors(actual)).toEqual(Object.getOwnPropertyDescriptors(expected));
  expect(actual.nestedPath).toBe(nestedPath);
  expect(Reflect.set(actual, "instructionOrdinal", 9)).toBe(true);
  expect(actual.instructionOrdinal).toBe(9);
  expect(expected.instructionOrdinal).toBe(7);
  nestedPath.push(11);
  expect(actual.nestedPath).toEqual([2, 0, 11]);
  assertPreparedIrData(actual);
  let reads = 0;
  Object.defineProperty(actual, "extra", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  expect(Object.hasOwn(actual, "extra")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(actual, "extra")?.get).toBeDefined();
  expect(() => assertPreparedIrData(actual)).toThrow();
  expect(reads).toBe(0);
});

import { snapshotRuntimeProvider } from "../src/ir/runtime/provider-snapshot.js";
import {
  TYPE_ERROR_RUNTIME_PROVIDERS,
  TYPE_ERROR_SIGNATURE,
  nativeJsClassTypeErrorProviderMismatch,
} from "../src/ir/runtime/native-js-class-error-callables.js";
import { RuntimeManifestBuilder } from "../src/ir/runtime/manifest.js";
import type { RuntimeProviderDefinition } from "../src/ir/runtime/contracts/manifest.js";

function providerSnapshotTrace(
  value: RuntimeProviderDefinition,
  events: string[],
  foreign?: { at: number; value: object },
) {
  const freeze = Object.getOwnPropertyDescriptor(Object, "freeze")!;
  const sort = Object.getOwnPropertyDescriptor(Array.prototype, "sort")!;
  const callbacks: unknown[] = [],
    receivers: boolean[] = [];
  const compare = (left: string, right: string) => {
    events.push("compare");
    return left < right ? -1 : left > right ? 1 : 0;
  };
  let freezes = 0;
  let result: RuntimeProviderDefinition | undefined;
  try {
    Object.defineProperty(Array.prototype, "sort", {
      ...sort,
      value(this: unknown[], callback: unknown) {
        callbacks.push(callback);
        events.push("sort");
        return Reflect.apply(sort.value, this, [callback]);
      },
    });
    Object.defineProperty(Object, "freeze", {
      ...freeze,
      value(this: unknown, item: object) {
        receivers.push(this === Object);
        events.push("freeze");
        if (++freezes === foreign?.at) return foreign.value;
        return Reflect.apply(freeze.value, this, [item]);
      },
    });
    result = snapshotRuntimeProvider(value, TYPE_ERROR_SIGNATURE, compare);
  } finally {
    try {
      Object.defineProperty(Object, "freeze", freeze);
    } finally {
      Object.defineProperty(Array.prototype, "sort", sort);
    }
  }
  if (!result) throw Error("missing provider snapshot");
  return { result, callbacks, compare, receivers, freezes };
}

function providerSnapshotInput(events: string[]) {
  const child = { payload: 7 },
    symbol = Symbol("provider-child");
  const implementation = { kind: "runtime-callable" as const, symbol: "__new_TypeError", child };
  Object.defineProperty(implementation, "symbol", {
    enumerable: true,
    get() {
      events.push("read:symbol");
      return "__new_TypeError";
    },
  });
  const value = {
    ...TYPE_ERROR_RUNTIME_PROVIDERS[0]!,
    signature: undefined,
    hostCapabilities: ["error.reference.construct", "async.promise.resolve", "error.reference.construct"] as const,
    supportedTargets: ["wasi", "standalone", "wasi"] as const,
    supportedBackends: ["wasmgc", "linear", "wasmgc"] as const,
    implementation,
    [symbol]: child,
  };
  Object.defineProperty(value, "dependencies", {
    enumerable: true,
    get() {
      events.push("read:dependencies");
      return ["math.sin", "math.cos", "math.sin"];
    },
  });
  Object.setPrototypeOf(value, { inherited: 13 });
  return { value: value as RuntimeProviderDefinition, child, symbol };
}

it("keeps provider snapshot births, callbacks and live freeze returns within their allocation boundary", () => {
  const events: string[] = [],
    input = providerSnapshotInput(events);
  const keys = Reflect.ownKeys(input.value);
  const observed = providerSnapshotTrace(input.value, events),
    output = observed.result,
    constructionEvents = events.slice();
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  expect(Reflect.ownKeys(output)).toEqual(keys);
  expect(Object.hasOwn(output, "inherited")).toBe(false);
  expect(output.signature).toBe(TYPE_ERROR_SIGNATURE);
  expect(Object.is(output.implementation, input.value.implementation)).toBe(false);
  expect(Reflect.get(output.implementation, "child")).toBe(input.child);
  expect(Reflect.get(output, input.symbol)).toBe(input.child);
  expect(
    Object.values(Object.getOwnPropertyDescriptors(output)).every(
      (d) => Object.hasOwn(d, "value") && d.enumerable && !d.writable && !d.configurable,
    ),
  ).toBe(true);
  expect(output.dependencies).toEqual(["math.cos", "math.sin"]);
  expect(output.hostCapabilities).toEqual(["async.promise.resolve", "error.reference.construct"]);
  expect(output.supportedTargets).toEqual(["standalone", "wasi"]);
  expect(output.supportedBackends).toEqual(["linear", "wasmgc"]);
  expect(observed.callbacks).toHaveLength(4);
  expect(observed.callbacks.every((callback) => callback === observed.compare)).toBe(true);
  expect(observed.freezes).toBe(6);
  expect(observed.receivers.every(Boolean)).toBe(true);
  expect(constructionEvents.filter((event) => event === "compare").length).toBeGreaterThan(0);
  expect(constructionEvents.filter((event) => event !== "compare")).toEqual([
    "read:dependencies",
    "read:dependencies",
    "sort",
    "freeze",
    "sort",
    "freeze",
    "sort",
    "freeze",
    "sort",
    "freeze",
    "read:symbol",
    "freeze",
    "freeze",
  ]);
  expect(() => assertPreparedIrData(output)).toThrow("unknown symbol field");
  const canonical = providerSnapshotTrace(TYPE_ERROR_RUNTIME_PROVIDERS[0]!, []).result;
  expect(nativeJsClassTypeErrorProviderMismatch(canonical)).toBeUndefined();
  let getters = 0;
  const masked = Object.assign(new Map(), TYPE_ERROR_RUNTIME_PROVIDERS[0]);
  Object.setPrototypeOf(masked, Object.prototype);
  const accessor = { ...TYPE_ERROR_RUNTIME_PROVIDERS[0]! };
  Object.defineProperty(accessor, "extra", {
    enumerable: true,
    get() {
      getters++;
      return 1;
    },
  });
  for (const foreign of [masked, accessor]) {
    const returned = providerSnapshotTrace(TYPE_ERROR_RUNTIME_PROVIDERS[0]!, [], { at: 6, value: foreign });
    expect(returned.freezes).toBe(6);
    expect(returned.result === foreign).toBe(true);
    expect(() => nativeJsClassTypeErrorProviderMismatch(returned.result)).toThrow();
  }
  const child = providerSnapshotTrace(TYPE_ERROR_RUNTIME_PROVIDERS[0]!, [], { at: 5, value: masked });
  expect(child.freezes).toBe(6);
  expect(Object.is(child.result.implementation, masked)).toBe(true);
  expect(() => nativeJsClassTypeErrorProviderMismatch(child.result)).toThrow();
  expect(getters).toBe(0);
  const policy = { backend: "wasmgc", target: "standalone" } as const;
  const ctor = new RuntimeManifestBuilder(policy, { providers: TYPE_ERROR_RUNTIME_PROVIDERS });
  const registered = new RuntimeManifestBuilder(policy, { providers: [] });
  registered.registerProvider(TYPE_ERROR_RUNTIME_PROVIDERS[0]!);
  for (const builder of [ctor, registered]) {
    builder.requestFeature("error.type.construct");
    builder.freeze();
    expect(builder.resolveProvider("error.type.construct").signature).toBe(TYPE_ERROR_SIGNATURE);
  }
  expect(registered.manifest.providers).toEqual(ctor.manifest.providers);
});
