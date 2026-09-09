// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import type { FieldDef } from "../src/ir/types.js";
import { dataFieldsHashKey } from "../src/wasm/physical/data-fields-key.js";

it("distinguishes numeric, boolean and symbol i32, preserving symbol precedence", () => {
  expect(
    dataFieldsHashKey([
      { name: "n", type: { kind: "i32" } },
      { name: "b", type: { kind: "i32", boolean: true } },
      { name: "s", type: { kind: "i32", symbol: true } },
      { name: "both", type: { kind: "i32", boolean: true, symbol: true } },
    ]),
  ).toBe("n:i32|b:i32:bool|s:i32:sym|both:i32:sym");
});

it("preserves reference nullability and exact type indices", () => {
  expect(
    dataFieldsHashKey([
      { name: "a", type: { kind: "ref", typeIdx: 3 } },
      { name: "a", type: { kind: "ref_null", typeIdx: 3 } },
      { name: "a", type: { kind: "ref", typeIdx: 4 } },
    ]),
  ).toBe("a:ref:3|a:ref_null:3|a:ref:4");
});

it("preserves field names and supplied order without sorting", () => {
  const fields = [
    { name: "z", type: { kind: "f64" as const } },
    { name: "a", type: { kind: "externref" as const } },
  ];
  expect(dataFieldsHashKey(fields)).toBe("z:f64|a:externref");
  expect(dataFieldsHashKey([...fields].reverse())).toBe("a:externref|z:f64");
  expect(dataFieldsHashKey([])).toBe("");
});

it("accepts full FieldDef records and ignores metadata outside the key contract", () => {
  const fields: FieldDef[] = [{ name: "value", type: { kind: "f64" }, mutable: true, undefinedDefault: true }];
  expect(dataFieldsHashKey(fields)).toBe("value:f64");
  expect(dataFieldsHashKey(fields.map((field) => ({ ...field, mutable: false, undefinedDefault: undefined })))).toBe(
    "value:f64",
  );
});
