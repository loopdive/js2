// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  assertPreparedIrData,
  createPreparedIrDataRecord,
  preparedIrDataMismatch,
} from "../src/shared/contracts/prepared-ir-data.js";
import {
  copyNativeJsClassValueData,
  freezeNativeJsClassValueData,
  nativeJsClassValueDataKey,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/data.js";

it("allocates distinct actual null records while observing their current mutable DATA", () => {
  const first = createPreparedIrDataRecord(),
    second = createPreparedIrDataRecord();
  expect(first).not.toBe(second);
  expect(Object.getPrototypeOf(first)).toBeNull();
  expect(Object.getPrototypeOf(second)).toBeNull();
  expect(Object.isFrozen(first)).toBe(false);
  first.value = 1;
  assertPreparedIrData(first);
  first.value = 2;
  assertPreparedIrData(first);
  expect(preparedIrDataMismatch({ value: 1 }, first)).toBeDefined();
  expect(preparedIrDataMismatch({ value: 2 }, first)).toBeUndefined();
});
it.each(["getter", "nestedGetter", "prototype", "function", "symbol", "cycle"] as const)(
  "checks live %s after a genuine record's negative internal-slot brand",
  (mutation) => {
    const record = createPreparedIrDataRecord();
    record.value = { n: 1 };
    assertPreparedIrData(record);
    let reads = 0;
    if (mutation === "getter")
      Object.defineProperty(record, "extra", {
        get() {
          reads++;
          return 1;
        },
      });
    if (mutation === "nestedGetter")
      Object.defineProperty(record.value, "extra", {
        get() {
          reads++;
          return 1;
        },
      });
    if (mutation === "prototype")
      Object.setPrototypeOf(record, {
        get bad() {
          reads++;
          return 1;
        },
      });
    if (mutation === "function")
      record.extra = () => {
        reads++;
      };
    if (mutation === "symbol") Object.defineProperty(record, Symbol("foreign"), { value: 1 });
    if (mutation === "cycle") record.extra = record;
    expect(() => assertPreparedIrData(record)).toThrow();
    expect(reads).toBe(0);
  },
);
function collection(kind: "Map" | "Set" | "WeakMap" | "WeakSet"): object {
  if (kind === "Map") return new Map([[{}, 1]]);
  if (kind === "Set") return new Set([1]);
  if (kind === "WeakMap") return new WeakMap([[{}, 1]]);
  return new WeakSet([{}]);
}
it.each(["Map", "Set", "WeakMap", "WeakSet"] as const)(
  "does not grant a caller's erased-prototype %s the fresh record brand",
  (kind) => {
    const record = createPreparedIrDataRecord(),
      foreign = Object.setPrototypeOf(collection(kind), null);
    record.foreign = foreign;
    expect(() => assertPreparedIrData(record)).toThrow();
    Object.setPrototypeOf(foreign, Object.prototype);
    expect(() => assertPreparedIrData(record)).toThrow();
    expect(Reflect.deleteProperty(record, "foreign")).toBe(true);
    record.n = 7;
    expect(() => assertPreparedIrData(record)).not.toThrow();
  },
);
it.each(["create", "apply", "set"] as const)("uses captured %s without authenticating a spoofed allocation", (kind) => {
  const originalCreate = Object.create,
    originalApply = Reflect.apply,
    originalSet = WeakMap.prototype.set;
  const fake = Object.setPrototypeOf(new Map(), null);
  let calls = 0,
    record: Record<string, unknown> | undefined;
  try {
    if (kind === "create")
      Object.create = (() => {
        calls++;
        return fake;
      }) as typeof Object.create;
    if (kind === "apply")
      Reflect.apply = (() => {
        calls++;
        return fake;
      }) as typeof Reflect.apply;
    if (kind === "set")
      WeakMap.prototype.set = (() => {
        calls++;
        return fake;
      }) as unknown as typeof WeakMap.prototype.set;
    record = createPreparedIrDataRecord();
  } finally {
    Object.create = originalCreate;
    Reflect.apply = originalApply;
    WeakMap.prototype.set = originalSet;
  }
  expect(calls).toBe(0);
  expect(record).toBeDefined();
  expect(record).not.toBe(fake);
  expect(Object.getPrototypeOf(record)).toBeNull();
  assertPreparedIrData(record);
  expect(() => assertPreparedIrData(fake)).toThrow();
});
it("does not turn a borrowed native receiver into caller registration", () => {
  const caller = Object.setPrototypeOf(new Map(), null),
    record = createPreparedIrDataRecord.call(caller);
  expect(record).not.toBe(caller);
  expect(Object.getPrototypeOf(record)).toBeNull();
  assertPreparedIrData(record);
  expect(() => assertPreparedIrData(caller)).toThrow();
});
it("preserves the pure copier's DATA, fresh-per-path identities, keys and freeze behavior", () => {
  const shared = { n: 7 },
    input = { left: shared, right: shared, list: [NaN, -0, undefined, 7n] };
  const copy = copyNativeJsClassValueData(input);
  expect(copy).not.toBe(input);
  expect(copy.left).not.toBe(shared);
  expect(copy.left).not.toBe(copy.right);
  expect(Object.getPrototypeOf(copy)).toBeNull();
  expect(Object.getPrototypeOf(copy.left)).toBeNull();
  expect(Object.is(copy.list[0], NaN)).toBe(true);
  expect(Object.is(copy.list[1], -0)).toBe(true);
  expect(copy.list[2]).toBeUndefined();
  expect(copy.list[3]).toBe(7n);
  expect(nativeJsClassValueDataKey(copy)).toBe(nativeJsClassValueDataKey(input));
  expect(preparedIrDataMismatch(copy, input)).toBeUndefined();
  expect(freezeNativeJsClassValueData(copy)).toBe(copy);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(Object.isFrozen(copy.left)).toBe(true);
  assertPreparedIrData(copy);
});
