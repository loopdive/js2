// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2175 PREP — builtin native-proto brand-table reservations.
//
// The native-proto glue wave (#1616/#2158 slices 1-4) registers per-builtin
// prologue + member bodies against a STABLE brand id drawn from
// `BUILTIN_BRAND_TABLE` (native-proto.ts). This PREP step reserves a brand for
// every builtin-constructor family up front so each glue slice only wires its
// glue, never the table — and so two slices landed in parallel cannot collide.
//
// These tests lock in the PREP contract:
//   1. every reserved family resolves to a brand,
//   2. brands are unique (a collision would silently mis-dispatch — #2175 Risk 2),
//   3. the brand band stays disjoint from class tags (the invariant in
//      getBuiltinBrand still fires),
//   4. an unbranded name returns undefined (caller falls through to the refusal).
//
// Brands are an append-only contract: this list intentionally hard-codes the
// expected families so a future renumber/removal trips the test.
import { describe, expect, it } from "vitest";
import { getBuiltinBrand } from "../src/codegen/native-proto.js";

// Minimal stand-in for the codegen context: getBuiltinBrand only reads
// classTagMap (for the disjointness assert) and lazily seeds builtinBrandMap.
function fakeCtx(classTags: Array<[string, number]> = []) {
  return {
    classTagMap: new Map<string, number>(classTags),
    builtinBrandMap: undefined as Map<string, number> | undefined,
  } as unknown as Parameters<typeof getBuiltinBrand>[0];
}

// Every builtin family the glue wave (#1616/#2158) will register. Mirrors
// BUILTIN_CTOR_NAMES (property-access.ts) plus the abstract %TypedArray%
// intrinsic. Math/JSON/Reflect/Atomics/Proxy are namespace objects, not
// prototype-bearing constructors, so they are intentionally NOT branded.
const RESERVED_FAMILIES = [
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
] as const;

describe("#2175 PREP — builtin native-proto brand table", () => {
  it("reserves a brand for every glue-wave builtin family", () => {
    const ctx = fakeCtx();
    const unresolved = RESERVED_FAMILIES.filter((n) => getBuiltinBrand(ctx, n) === undefined);
    expect(unresolved).toEqual([]);
  });

  it("assigns a UNIQUE brand to each family (no collision — #2175 Risk 2)", () => {
    const ctx = fakeCtx();
    const byBrand = new Map<number, string>();
    const collisions: string[] = [];
    for (const name of RESERVED_FAMILIES) {
      const brand = getBuiltinBrand(ctx, name)!;
      const prior = byBrand.get(brand);
      if (prior !== undefined) collisions.push(`${prior} & ${name} both => ${brand}`);
      byBrand.set(brand, name);
    }
    expect(collisions).toEqual([]);
    expect(byBrand.size).toBe(RESERVED_FAMILIES.length);
  });

  it("returns a brand in the reserved HIGH-NEGATIVE band (disjoint from class tags)", () => {
    const ctx = fakeCtx();
    // Class tags are small non-negative i32s; brands must be deeply negative.
    for (const name of RESERVED_FAMILIES) {
      expect(getBuiltinBrand(ctx, name)!).toBeLessThan(0);
    }
  });

  it("returns undefined for an unbranded name (falls through to the refusal)", () => {
    const ctx = fakeCtx();
    expect(getBuiltinBrand(ctx, "NotABuiltin")).toBeUndefined();
    expect(getBuiltinBrand(ctx, "MyUserClass")).toBeUndefined();
  });

  it("throws if a class tag ever lands in the builtin band (disjointness invariant)", () => {
    // Seed a class tag deep in the negative band; resolving any brand must trip
    // the guard rather than silently mis-dispatch.
    const ctx = fakeCtx([["Rogue", -0x4000_0000 - 1]]);
    expect(() => getBuiltinBrand(ctx, "Array")).toThrow(/Brand space must stay disjoint/);
  });
});
