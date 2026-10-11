// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import * as runtime from "../src/runtime/contracts/builtin-brands.js";
import * as legacy from "../src/codegen/builtin-brands.js";
import * as collection from "../src/runtime/contracts/collection-kind.js";
import * as legacyCollection from "../src/codegen/collection-kind.js";

// Ordered emitted ABI identities, independent of the implementation's table.
const names = [
  "RegExp",
  "Array",
  "%TypedArray%",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Promise",
  "Date",
  "Iterator",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "FinalizationRegistry",
  "DisposableStack",
  "AsyncDisposableStack",
  "SuppressedError",
  "GeneratorPrototype",
  "AggregateError",
  "MapIterator",
  "SetIterator",
  "ArrayIterator",
];

describe("shared native prototype brand ABI", () => {
  it("retains each occupied slot and the reserved zero slot", () => {
    expect(runtime.BUILTIN_BRAND_BASE).toBe(-1073741824);
    expect(runtime.BUILTIN_BRAND_COUNT).toBe(49);
    expect(Object.keys(runtime.BUILTIN_BRAND_TABLE)).toEqual(names);
    names.forEach((name, index) => {
      expect(runtime.BUILTIN_BRAND_TABLE[name]).toBe(-1073741824 + index + 1);
      expect(runtime.builtinBrandOffsetOf(name)).toBe(index + 1);
      expect(runtime.isBrandedBuiltinName(name)).toBe(true);
    });
    expect(Object.values(runtime.BUILTIN_BRAND_TABLE)).not.toContain(runtime.BUILTIN_BRAND_BASE);
    expect(runtime.builtinBrandOffsetOf("AbsentBuiltin")).toBeUndefined();
    expect(runtime.isBrandedBuiltinName("toString")).toBe(false);
  });

  it("retains exact object and function identity through both legacy facades", () => {
    expect(legacy.BUILTIN_BRAND_TABLE).toBe(runtime.BUILTIN_BRAND_TABLE);
    expect(legacy.builtinBrandOffsetOf).toBe(runtime.builtinBrandOffsetOf);
    expect(legacy.isBrandedBuiltinName).toBe(runtime.isBrandedBuiltinName);
    expect(legacyCollection.COLLECTION_KIND).toBe(collection.COLLECTION_KIND);
    expect(legacy.COLLECTION_KIND).toBe(collection.COLLECTION_KIND);
    expect(runtime.COLLECTION_KIND).toBe(collection.COLLECTION_KIND);
    expect(collection.COLLECTION_KIND).toEqual({ MAP: 0, SET: 1, WEAKMAP: 2, WEAKSET: 3 });
  });
});
