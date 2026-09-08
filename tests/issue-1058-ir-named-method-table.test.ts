// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(result: CompileResult, value: number): Promise<number> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.run as (value: number) => number)(value);
}

it("preserves returned tables of captured named functions", async () => {
  const result = await compile(
    `
    function make(offset: number): { add: (value: number) => number } {
      return { add };
      function add(value: number): number { return offset + value; }
    }
    export function run(value: number): number {
      const rules = make(2);
      return rules.add(value);
    }
  `,
    { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(await run(result, 40)).toBe(42);
});

it.each(["gc", "standalone"] as const)("returns a captured named function through prepared IR (%s)", async (target) => {
  const result = await compile(
    `
    function make(offset: number): (value: number) => number {
      return add;
      function add(value: number): number { return offset + value; }
    }
    export function run(value: number): number {
      const add = make(2);
      return add(value);
    }
  `,
    { target, experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(await run(result, 40)).toBe(42);
  expect(
    result.irOutcomes?.find((row) => row.displayName === "make"),
    JSON.stringify(result.irOutcomes),
  ).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
  });
});

it.each(["gc", "standalone"] as const)("keeps escaped named captures live and per-instance (%s)", async (target) => {
  const result = await compile(
    `
    function make(start: number): (value: number) => number {
      let offset = start;
      function add(value: number): number { offset += value; return offset; }
      offset += 2;
      return add;
    }
    export function run(value: number): number {
      const first = make(1);
      const second = make(10);
      first(value);
      return first(value) * 100 + second(value);
    }
  `,
    { target, experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(await run(result, 2)).toBe(714);
  expect(
    result.irOutcomes?.find((row) => row.displayName === "make"),
    JSON.stringify(result.irOutcomes),
  ).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
  });
});

it.each(["gc", "standalone"] as const)("preserves source field order and shared method state (%s)", async (target) => {
  const result = await compile(
    `
    function make(start: number): { z: (value: number) => number; a: (value: number) => number } {
      let state = start;
      return { a, z };
      function z(value: number): number { state += value; return state; }
      function a(value: number): number { return state + value; }
    }
    export function run(value: number): number {
      const table = make(3);
      return table.z(value) * 100 + table.a(value);
    }
  `,
    { target, experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  if (target === "standalone") expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  expect(await run(result, 2)).toBe(507);
});
