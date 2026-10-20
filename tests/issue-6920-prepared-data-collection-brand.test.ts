// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  assertPreparedIrData,
  freezePreparedIrRuntimeValue,
  freezePreparedIrValue,
  preparedIrDataMismatch,
  preparedIrReadonlyMap,
} from "../src/shared/contracts/prepared-ir-data.js";

const nativeKinds = ["Map", "Set", "WeakMap", "WeakSet"] as const;
function native(kind: (typeof nativeKinds)[number]): object {
  switch (kind) {
    case "Map":
      return new Map([[{}, 1]]);
    case "Set":
      return new Set([1]);
    case "WeakMap":
      return new WeakMap([[{}, 1]]);
    case "WeakSet":
      return new WeakSet([{}]);
  }
}
const prototypes = ["ordinary", "null", "array"] as const;
function mask(value: object, prototype: (typeof prototypes)[number]): object {
  return Object.setPrototypeOf(
    value,
    prototype === "ordinary" ? Object.prototype : prototype === "null" ? null : Array.prototype,
  );
}

describe("native collection slot brands remain distinct from live prepared DATA", () => {
  it("preserves actual ordinary, array, null-record and immutable collection data", () => {
    const original = {
      array: [1, NaN, -0, { present: undefined }],
      nullRecord: Object.assign(Object.create(null), { n: 3 }),
    };
    assertPreparedIrData(original);
    const copy = freezePreparedIrValue(original);
    assertPreparedIrData(copy);
    expect(preparedIrDataMismatch(copy, original)).toBeUndefined();
    expect(freezePreparedIrRuntimeValue(original)).toBe(original);
    const readonlyMap = preparedIrReadonlyMap([["key", [1, 2]]]);
    assertPreparedIrData(readonlyMap);
    expect(preparedIrDataMismatch(readonlyMap, preparedIrReadonlyMap([["key", [1, 2]]]))).toBeUndefined();
    const readonlySet = freezePreparedIrValue(new Set([1, 2]));
    assertPreparedIrData(readonlySet);
    expect(preparedIrDataMismatch(readonlySet, freezePreparedIrValue(new Set([1, 2])))).toBeUndefined();
  });

  it.each(nativeKinds.flatMap((kind) => prototypes.map((prototype) => [kind, prototype] as const)))(
    "refuses native %s slots behind %s prototype before and after brand reuse",
    (kind, prototype) => {
      const value = mask(native(kind), prototype);
      expect(() => assertPreparedIrData(value)).toThrow();
      expect(() => freezePreparedIrRuntimeValue(value)).toThrow();
      expect(preparedIrDataMismatch({}, value)).toBeDefined();
      Object.setPrototypeOf(value, Object.prototype);
      expect(() => assertPreparedIrData(value)).toThrow();
      expect(preparedIrDataMismatch({}, value)).toBeDefined();
    },
  );

  it("does not authenticate an array from Array.prototype alone", () => {
    const fake = Object.create(Array.prototype);
    expect(Array.isArray(fake)).toBe(false);
    expect(() => assertPreparedIrData(fake)).toThrow();
    expect(preparedIrDataMismatch([], fake)).toBeDefined();
  });

  it.each(["prototype", "indexGetter", "shadowMethod", "extraField", "symbol", "cycle"] as const)(
    "rechecks live array %s after its genuine array brand was observed",
    (mutation) => {
      const value: unknown[] = [1];
      assertPreparedIrData(value);
      let reads = 0;
      if (mutation === "prototype") Object.setPrototypeOf(value, null);
      if (mutation === "indexGetter")
        Object.defineProperty(value, "0", {
          configurable: true,
          get() {
            reads++;
            return 1;
          },
        });
      if (mutation === "shadowMethod")
        Object.defineProperty(value, "map", {
          value: () => {
            reads++;
          },
        });
      if (mutation === "extraField") Object.defineProperty(value, "extra", { value: 1 });
      if (mutation === "symbol") Object.defineProperty(value, Symbol("foreign"), { value: 1 });
      if (mutation === "cycle") value[0] = value;
      expect(() => assertPreparedIrData(value)).toThrow();
      expect(reads).toBe(0);
    },
  );

  it("rechecks live ordinary descriptors after a negative native-slot brand", () => {
    const value = { n: 1 };
    assertPreparedIrData(value);
    let reads = 0;
    Object.defineProperty(value, "n", {
      get() {
        reads++;
        return 1;
      },
    });
    expect(() => assertPreparedIrData(value)).toThrow();
    expect(preparedIrDataMismatch({ n: 1 }, value)).toBeDefined();
    expect(reads).toBe(0);
  });

  it("does not let a later Array.isArray patch poison a masked native collection brand", () => {
    const value = mask(new Map(), "ordinary"),
      original = Array.isArray;
    let mismatch: string | undefined;
    try {
      Array.isArray = (() => true) as unknown as typeof Array.isArray;
      mismatch = preparedIrDataMismatch({}, value);
    } finally {
      Array.isArray = original;
    }
    expect(mismatch!).toBeDefined();
    expect(() => assertPreparedIrData(value)).toThrow();
  });

  it("allocates an actual ordinary copy without calling a patched Object.create", () => {
    const original = Object.create,
      fake = mask(new Map(), "null");
    let calls = 0,
      copy: unknown;
    try {
      Object.create = (() => {
        calls++;
        return fake;
      }) as typeof Object.create;
      copy = freezePreparedIrValue({ n: 1 });
    } finally {
      Object.create = original;
    }
    expect(calls).toBe(0);
    expect(copy).not.toBe(fake);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    assertPreparedIrData(copy);
    expect(() => assertPreparedIrData(fake)).toThrow();
  });

  it("does not seed a caller map-method result as an ordinary allocation", () => {
    const fake = mask(new Map(), "ordinary"),
      source = [1];
    Object.defineProperty(source, "map", { value: () => fake });
    const copy = freezePreparedIrValue(source);
    expect(() => assertPreparedIrData(copy)).toThrow();
    expect(preparedIrDataMismatch({}, copy)).toBeDefined();
  });

  it("does not turn the private fresh-copy brand into a DATA verdict", () => {
    const original = Object.freeze;
    let copy: { n: number };
    try {
      Object.freeze = (<T>(value: T) => value) as typeof Object.freeze;
      copy = freezePreparedIrValue({ n: 1 }) as { n: number };
    } finally {
      Object.freeze = original;
    }
    let reads = 0;
    Object.defineProperty(copy!, "extra", {
      get() {
        reads++;
        return 2;
      },
    });
    expect(() => assertPreparedIrData(copy!)).toThrow();
    expect(preparedIrDataMismatch({ n: 1 }, copy!)).toBeDefined();
    expect(reads).toBe(0);
  });
});

import { createPreparedIrDataObject } from "../src/shared/contracts/prepared-ir-data.js";

it("keeps the private cache read isolated from later WeakMap get replacement", () => {
  const define = Object.defineProperty;
  const getDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
  if (!getDescriptor) throw new Error("missing intrinsic descriptor");
  const key = {};
  const canary = new WeakMap<object, unknown>([[key, 7]]);
  const sentinel = Symbol("hostile intrinsic control");
  const ordinary = { n: 1 };
  const array: unknown[] = [];
  const nativeMap = mask(new Map(), "ordinary");
  const mutable = { n: 2 };
  let getCalls = 0,
    getterCalls = 0;
  let getControl: unknown;
  let controlsGetCalls = 0;
  const accepted: boolean[] = [];
  const errors: unknown[] = [];
  const observe = (value: unknown) => {
    try {
      assertPreparedIrData(value);
      accepted.push(true);
    } catch (error) {
      accepted.push(false);
      errors.push(error);
    }
  };
  try {
    define(WeakMap.prototype, "get", {
      ...getDescriptor,
      value() {
        getCalls++;
        return sentinel;
      },
    });
    // A real ordinary WeakMap lookup proves the hostile replacement is live.
    getControl = canary.get(key);
    controlsGetCalls = getCalls;
    observe(ordinary);
    observe(ordinary);
    observe(array);
    observe(array);
    observe(createPreparedIrDataObject());
    observe(nativeMap);
    observe(nativeMap);
    observe(mutable);
    define(mutable, "hostile", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls++;
        return 3;
      },
    });
    observe(mutable);
  } finally {
    define(WeakMap.prototype, "get", getDescriptor);
  }
  // All matchers and error formatting run after the original descriptor is restored.
  expect(getControl).toBe(sentinel);
  expect(controlsGetCalls).toBe(1);
  expect(getCalls).toBe(1);
  expect(accepted).toEqual([true, true, true, true, true, false, false, true, false]);
  expect(errors).toHaveLength(3);
  expect(errors[0]).toMatchObject({
    code: "invalid-prepared-data",
    message: "runtime data contains mutable or executable context state",
  });
  expect(errors[1]).toMatchObject({
    code: "invalid-prepared-data",
    message: "runtime data contains mutable or executable context state",
  });
  expect(errors[2]).toMatchObject({
    code: "invalid-prepared-data",
    message: "runtime property hostile must be non-executable data",
  });
  expect(getterCalls).toBe(0);
});
