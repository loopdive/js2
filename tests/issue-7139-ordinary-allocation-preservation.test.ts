// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { buildOrdinaryObjectCreateBody } from "../src/runtime/wasmgc/values/ordinary-object-storage-bodies.js";
import {
  allocationPrefixPath,
  allocationPrefixReceipt,
  applyAllocationPrefixPreservation,
  beforeAllocationPrefixPreservation,
} from "./helpers/ordinary-allocation-preservation.js";
const source = readFileSync(new URL("../" + allocationPrefixPath, import.meta.url), "utf8");
it("reconstructs the exact Git-pinned prefix refactor and replays all current bytes", () => {
  const before = beforeAllocationPrefixPreservation(allocationPrefixPath, source);
  expect(before).not.toBe(source);
  expect(applyAllocationPrefixPreservation(allocationPrefixPath, before, false)).toBe(source);
});
it("keeps legacy default construction instruction-identical across actual layout operands", () => {
  const historical = allocationPrefixReceipt().before;
  const compiled = ts.transpileModule(historical, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { buildOrdinaryObjectCreateBody?: typeof buildOrdinaryObjectCreateBody } = {};
  new Function("exports", compiled)(exports);
  expect(typeof exports.buildOrdinaryObjectCreateBody).toBe("function");
  for (const offset of [0, 91])
    for (const initialCapacity of [8, 32]) {
      const d = { objectTypeIdx: 10 + offset, propMapTypeIdx: 9 + offset, initialCapacity };
      expect(buildOrdinaryObjectCreateBody(d)).toEqual(exports.buildOrdinaryObjectCreateBody!(d));
    }
});
it("refuses mutated, missing, duplicate and historical-as-current inputs", () => {
  const r = allocationPrefixReceipt();
  for (const input of [
    source + "\n",
    source.replace(r.after, ""),
    source + r.after,
    applyAllocationPrefixPreservation(allocationPrefixPath, source, true),
  ])
    expect(() => beforeAllocationPrefixPreservation(allocationPrefixPath, input)).toThrow();
  expect(() => applyAllocationPrefixPreservation("unknown", source, true)).toThrow();
  expect(() => applyAllocationPrefixPreservation(allocationPrefixPath, source, true, "{}")).toThrow();
});
