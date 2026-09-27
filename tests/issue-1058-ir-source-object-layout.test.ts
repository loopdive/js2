// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { irTypeEquals, irVal, type IrObjectShape } from "../src/ir/nodes.js";
import { orderedObjectFields } from "../src/ir/object-layout.js";
import { irTypeKey } from "../src/ir/type-key.js";
import { canonicalProgramAbiObjectShapeKey } from "../src/codegen/program-abi-type-planning.js";
import { dataFieldsHashKey } from "../src/wasm/physical/data-fields-key.js";

const cases = [
  {
    name: "annotated return with captured nested function",
    owner: "make",
    expected: 302,
    source: `
      function make(offset: number): { z: number; a: number } {
        function add(value: number): number { return offset + value; }
        return { z: add(1), a: 2 };
      }
      export function run(): number { const row = make(2); return row.z * 100 + row.a; }
    `,
  },
  {
    name: "annotated argument and mixed fields",
    owner: "read",
    expected: 17,
    source: `
      function read(row: { z: boolean; a: number }): number { return row.z ? row.a : -1; }
      export function run(): number { return read({ a: 17, z: true }); }
    `,
  },
  {
    name: "object captured by an escaped closure",
    owner: "make",
    expected: 2307,
    source: `
      function make(row: { z: number; a: number }): () => number {
        return (): number => row.z * 100 + row.a;
      }
      export function run(): number { const read = make({ a: 7, z: 23 }); return read(); }
    `,
  },
  {
    name: "nested declared layouts",
    owner: "make",
    expected: 415,
    source: `
      function make(value: number): { z: { b: number; a: number }; a: number } {
        return { a: 5, z: { a: 1, b: value } };
      }
      export function run(): number { const row = make(4); return row.z.b * 100 + row.z.a * 10 + row.a; }
    `,
  },
  {
    name: "distinct declared orders in the same module",
    owner: "reverse",
    expected: 3152,
    source: `
      function forward(value: number): { a: number; z: number } { return { z: value, a: 1 }; }
      function reverse(value: number): { z: number; a: number } { return { a: 2, z: value }; }
      export function run(): number {
        const left = forward(3); const right = reverse(5);
        return left.z * 1000 + left.a * 100 + right.z * 10 + right.a;
      }
    `,
  },
];

it.each(cases)("uses the declared IR layout: $name", async ({ source, expected, owner }) => {
  const result = await compile(source, { target: "standalone", experimentalIR: true, trackIrOutcomes: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect((new WebAssembly.Instance(module, {}).exports.run as () => number)()).toBe(expected);
  expect(
    result.irOutcomes?.find((row) => row.displayName === owner),
    JSON.stringify(result.irOutcomes),
  ).toMatchObject({ irBodyEmitted: true });
});

it("keeps representation order in object equality and both callable keys", () => {
  const shape: IrObjectShape = {
    fields: [
      { name: "a", type: irVal({ kind: "f64" }) },
      { name: "z", type: irVal({ kind: "f64" }) },
    ],
  };
  const canonical = { kind: "object" as const, shape };
  const explicit = { kind: "object" as const, shape: { ...shape, fieldOrder: ["a", "z"] } };
  const reversed = { kind: "object" as const, shape: { ...shape, fieldOrder: ["z", "a"] } };
  expect(irTypeEquals(canonical, explicit)).toBe(true);
  expect(irTypeKey(canonical)).toBe(irTypeKey(explicit));
  expect(canonicalProgramAbiObjectShapeKey(canonical)).toBe(canonicalProgramAbiObjectShapeKey(explicit));
  expect(irTypeEquals(canonical, reversed)).toBe(false);
  expect(irTypeKey(canonical)).not.toBe(irTypeKey(reversed));
  expect(canonicalProgramAbiObjectShapeKey(canonical)).not.toBe(canonicalProgramAbiObjectShapeKey(reversed));
  for (const fieldOrder of [["a"], ["a", "a"], ["a", "missing"]]) {
    expect(() => orderedObjectFields({ ...shape, fieldOrder })).toThrow(/every field exactly once/);
  }
});

it("preserves boolean/symbol branding and reference nullability in data layout keys", () => {
  expect(
    dataFieldsHashKey([
      { name: "a", type: { kind: "i32", boolean: true }, mutable: true },
      { name: "b", type: { kind: "i32", symbol: true }, mutable: true },
      { name: "c", type: { kind: "i32" }, mutable: true },
      { name: "d", type: { kind: "ref", typeIdx: 7 }, mutable: true },
      { name: "e", type: { kind: "ref_null", typeIdx: 7 }, mutable: true },
    ]),
  ).toBe("a:i32:bool|b:i32:sym|c:i32|d:ref:7|e:ref_null:7");
});
