// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([false, true])("preserves tagged union values (generic return=%s)", async (generic) => {
  const result = await compile(
    `function defined<T>(value: T | undefined): T {
      if (value === undefined) throw new Error("missing");
      return value;
    }
    const values: (string | number | boolean)[] = ["x", 42, true, false];
    export function read(index: number): number {
      const value = ${generic ? "defined(values[index])" : "values[index]"};
      if (index === 0) return typeof value === "string" && value === "x" ? 1 : -1;
      if (index === 1) return typeof value === "number" && value === 42 ? 2 : -2;
      if (index === 2) return typeof value === "boolean" && value === true ? 3 : -3;
      return typeof value === "boolean" && value === false ? 4 : -4;
    }
    export function homogeneous(index: number): number {
      const booleanValue = defined(index > 0);
      const stringValue = defined(index > 0 ? "a" : "b");
      const numberValue = defined(index > 0 ? 1 : 2);
      if (typeof booleanValue !== "boolean" || typeof stringValue !== "string" || typeof numberValue !== "number") return -1;
      return (booleanValue ? 100 : 0) + (stringValue === "a" ? 10 : 20) + numberValue;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const read = instance.exports.read as (index: number) => number;
  expect([0, 1, 2, 3].map(read)).toEqual([1, 2, 3, 4]);
  const homogeneous = instance.exports.homogeneous as (index: number) => number;
  expect([homogeneous(0), homogeneous(1)]).toEqual([22, 111]);
});
