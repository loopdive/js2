// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import "../src/index.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { promotedCaptureValueInstrs } from "../src/codegen/closures/promoted-capture-value.js";
import { localGlobalIdx } from "../src/codegen/registry/imports.js";

function context(): CodegenContext {
  return {
    numImportGlobals: 2,
    capturedGlobals: new Map([["value", 2]]),
    capturedGlobalsWidened: new Set(["value"]),
    capturedBoxGlobals: new Map([["value", { globalIdx: 2, refCellTypeIdx: 0, valType: { kind: "externref" } }]]),
    mod: {
      globals: [{ type: { kind: "ref_null", typeIdx: 0 } }],
      types: [{ kind: "struct", fields: [{ type: { kind: "externref" }, mutable: true }] }],
    },
  } as unknown as CodegenContext;
}

it("extracts an immutable externref capture from the matching shared global cell", () => {
  expect(promotedCaptureValueInstrs(context(), "value", { kind: "externref" }, localGlobalIdx)).toEqual([
    { op: "global.get", index: 2 },
    { op: "struct.get", typeIdx: 0, fieldIdx: 0 },
  ]);
});

it("keeps a consumer that expects the cell on the cell path", () => {
  expect(promotedCaptureValueInstrs(context(), "value", { kind: "ref", typeIdx: 0 }, localGlobalIdx)).toEqual([
    { op: "global.get", index: 2 },
    { op: "ref.as_non_null" },
  ]);
});

it("does not unwrap a foreign same-named box global", () => {
  const ctx = context();
  ctx.capturedBoxGlobals!.get("value")!.globalIdx = 3;
  expect(promotedCaptureValueInstrs(ctx, "value", { kind: "externref" }, localGlobalIdx)).toEqual([
    { op: "global.get", index: 2 },
    { op: "ref.as_non_null" },
  ]);
});

it("preserves an ordinary promoted value global", () => {
  const ctx = context();
  ctx.capturedBoxGlobals!.clear();
  ctx.capturedGlobalsWidened.clear();
  ctx.mod.globals[0]!.type = { kind: "externref" };
  expect(promotedCaptureValueInstrs(ctx, "value", { kind: "externref" }, localGlobalIdx)).toEqual([
    { op: "global.get", index: 2 },
  ]);
});

it("refuses a global whose physical type does not match the registered cell", () => {
  const ctx = context();
  ctx.mod.globals[0]!.type = { kind: "externref" };
  expect(() => promotedCaptureValueInstrs(ctx, "value", { kind: "externref" }, localGlobalIdx)).toThrow(
    "cell type disagrees",
  );
});

it("refuses stale inner-value metadata instead of extracting the wrong physical field type", () => {
  const ctx = context();
  (ctx.mod.types[0] as { fields: Array<{ type: unknown }> }).fields[0]!.type = { kind: "f64" };
  expect(() => promotedCaptureValueInstrs(ctx, "value", { kind: "externref" }, localGlobalIdx)).toThrow(
    "cell value type disagrees",
  );
});

it("refuses a missing global instead of emitting an undefined index", () => {
  expect(() => promotedCaptureValueInstrs(context(), "missing", { kind: "externref" }, localGlobalIdx)).toThrow(
    "Missing promoted capture",
  );
});
