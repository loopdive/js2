// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  buildVectorGrowStoreBody,
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";

describe("vector grow/store body construction", () => {
  it("returns independent fresh output without mutating frozen resource data", () => {
    const resources = Object.freeze({
      carrierTypeIndex: 5,
      arrayTypeIndex: 7,
      exceptionTagIndex: 2,
      gapFill: Object.freeze({ kind: "default" as const }),
    });
    const first = buildVectorGrowStoreBody(resources),
      second = buildVectorGrowStoreBody(resources);
    expect(first).toEqual(second);
    expect(first.body).not.toBe(second.body);
    expect(first.locals).not.toBe(second.locals);
    first.body.pop();
    first.locals.pop();
    expect(second).toEqual(buildVectorGrowStoreBody(resources));
  });
});

describe("shared vector type descriptors", () => {
  it("preserves the one open mutable length-prefix base", () => {
    expect(createVectorBaseType()).toEqual({
      kind: "struct",
      name: "__vec_base",
      superTypeIdx: -1,
      fields: [{ name: "length", type: { kind: "i32" }, mutable: true }],
    });
    expect(createVectorBaseType()).not.toBe(createVectorBaseType());
  });
  it.each(["externref", "f64", "i32", "i8"] as const)("preserves exact backing-array element %s", (kind) => {
    const element = { kind };
    const descriptor = createVectorBackingArrayType(`__arr_${kind}`, element);
    expect(descriptor).toEqual({ kind: "array", name: `__arr_${kind}`, element, mutable: true });
    expect(descriptor.element).toBe(element);
  });
  it.each([undefined, false, true])(
    "preserves carrier metadata final=%s without inventing missing properties",
    (final) => {
      const descriptor = createVectorCarrierType({
        name: "__vec_test",
        baseTypeIndex: 2,
        arrayTypeIndex: 6,
        ...(final === undefined ? {} : { final }),
      });
      expect(descriptor).toEqual({
        kind: "struct",
        name: "__vec_test",
        superTypeIdx: 2,
        ...(final === undefined ? {} : { final }),
        fields: [
          { name: "length", type: { kind: "i32" }, mutable: true },
          { name: "data", type: { kind: "ref", typeIdx: 6 }, mutable: true },
        ],
      });
      expect(Object.hasOwn(descriptor, "final")).toBe(final !== undefined);
    },
  );
});
