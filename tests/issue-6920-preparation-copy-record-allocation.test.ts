// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";
import { IR_CLASS_SHAPE_CELL } from "../src/shared/contracts/ir-class-shape-marker.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../src/shared/contracts/prepared-ir-data.js";
it.each(["ordinary", "null"] as const)("preserves the actual %s prototype and descriptor/value population", (kind) => {
  const shared = { n: 1 },
    input = kind === "ordinary" ? {} : Object.create(null);
  Object.defineProperties(input, {
    n: { value: NaN, writable: true, enumerable: true, configurable: true },
    zero: { value: -0, enumerable: true },
    absentValue: { value: undefined, enumerable: true },
    a: { value: shared, enumerable: true },
    b: { value: shared, enumerable: true },
    __proto__: { value: 4, enumerable: true },
  });
  Object.defineProperty(input, IR_CLASS_SHAPE_CELL, { value: true, enumerable: false });
  Object.preventExtensions(input);
  const result = copyIrPreparationData(input);
  expect(result).not.toBe(input);
  expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(input));
  expect(Reflect.ownKeys(result)).toEqual(Reflect.ownKeys(input));
  expect(Object.isExtensible(result)).toBe(false);
  for (const key of Reflect.ownKeys(input)) {
    const a = Object.getOwnPropertyDescriptor(input, key)!,
      b = Object.getOwnPropertyDescriptor(result, key)!;
    expect([b.writable, b.enumerable, b.configurable]).toEqual([a.writable, a.enumerable, a.configurable]);
    if (key !== "a" && key !== "b") expect(Object.is(a.value, b.value)).toBe(true);
  }
  expect(result.a).not.toBe(shared);
  expect(result.a).toBe(result.b);
  expect(preparedIrDataMismatch(result, input)).toBeUndefined();
});
it("retains graph cycles/aliases as the historical copier does without granting DATA validity", () => {
  const shared = { value: 7 },
    input: { a: typeof shared; b: typeof shared; self?: unknown } = { a: shared, b: shared };
  input.self = input;
  const result = copyIrPreparationData(input);
  expect(result.a).toBe(result.b);
  expect(result.a).not.toBe(shared);
  expect(result.self).toBe(result);
  expect(() => assertPreparedIrData(result)).toThrow();
});
it.each(["Map", "Set"] as const)("retains actual %s collection construction and graph aliases", (kind) => {
  const key = {},
    input = kind === "Map" ? new Map([[key, key]]) : new Set([key]);
  Object.preventExtensions(input);
  const result = copyIrPreparationData(input);
  expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(input));
  expect(result).not.toBe(input);
  expect(Object.isExtensible(result)).toBe(false);
  if (result instanceof Map) {
    const [[a, b]] = Array.from(result);
    expect(a).toBe(b);
    expect(a).not.toBe(key);
  } else expect([...result][0]).not.toBe(key);
});
it("preserves actual array length, sparse population and element descriptors", () => {
  const input = new Array(3);
  Object.defineProperty(input, "1", { value: { n: 7 }, enumerable: true, writable: false, configurable: false });
  Object.preventExtensions(input);
  const result = copyIrPreparationData(input);
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(3);
  expect(Reflect.ownKeys(result)).toEqual(["1", "length"]);
  expect(Object.getOwnPropertyDescriptor(result, "1")).toEqual({
    ...Object.getOwnPropertyDescriptor(input, "1"),
    value: result[1],
  });
  expect(result[1]).not.toBe(input[1]);
  expect(Object.isExtensible(result)).toBe(false);
});
it.each(["Map", "Set", "WeakMap", "WeakSet", "Date"] as const)(
  "never blesses an erased-prototype caller %s",
  (kind) => {
    const input =
      kind === "Map"
        ? new Map()
        : kind === "Set"
          ? new Set()
          : kind === "WeakMap"
            ? new WeakMap()
            : kind === "WeakSet"
              ? new WeakSet()
              : new Date();
    Object.setPrototypeOf(input, Object.prototype);
    expect(() => copyIrPreparationData(input)).toThrow();
    const output = copyIrPreparationData({ n: 7 });
    assertPreparedIrData(output);
    expect(() => copyIrPreparationData(input)).toThrow();
    if (kind !== "Date") expect(() => assertPreparedIrData(input)).toThrow();
  },
);
it("preserves own __proto__ DATA and bypasses inherited setters", () => {
  const input = {};
  Object.defineProperty(input, "__proto__", { value: 7, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(input, "field", { value: 8, enumerable: true });
  let calls = 0;
  const old = Object.getOwnPropertyDescriptor(Object.prototype, "field");
  let result: object | undefined;
  try {
    Object.defineProperty(Object.prototype, "field", {
      set() {
        calls++;
      },
      configurable: true,
    });
    result = copyIrPreparationData(input);
  } finally {
    if (old) Object.defineProperty(Object.prototype, "field", old);
    else Reflect.deleteProperty(Object.prototype, "field");
  }
  expect(calls).toBe(0);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(result!, "__proto__")!.value).toBe(7);
  expect(Object.getOwnPropertyDescriptor(result!, "field")!.value).toBe(8);
});
it.each(["value", "getter", "prototype", "foreign"] as const)(
  "checks live %s after a genuine copy output was healthy",
  (kind) => {
    const output = copyIrPreparationData<Record<string, unknown>>({ n: 1 });
    assertPreparedIrData(output);
    let calls = 0;
    if (kind === "value") {
      output.n = 2;
      expect(preparedIrDataMismatch(output, { n: 1 })).toBeDefined();
      assertPreparedIrData(output);
      return;
    }
    if (kind === "getter")
      Object.defineProperty(output, "bad", {
        get() {
          calls++;
          return 1;
        },
      });
    if (kind === "prototype") Object.setPrototypeOf(output, { foreign: true });
    if (kind === "foreign") output.bad = Object.setPrototypeOf(new WeakMap(), null);
    expect(() => assertPreparedIrData(output)).toThrow();
    expect(calls).toBe(0);
  },
);
it("retains accessor and extra array/symbol rejection before output publication", () => {
  let calls = 0;
  const input = {};
  Object.defineProperty(input, "x", {
    get() {
      calls++;
      return 7;
    },
  });
  expect(() => copyIrPreparationData(input)).toThrow();
  expect(calls).toBe(0);
  expect(() => copyIrPreparationData(Object.assign([], { extra: 1 }))).toThrow();
  expect(() => copyIrPreparationData({ [Symbol("foreign")]: true })).toThrow();
});
