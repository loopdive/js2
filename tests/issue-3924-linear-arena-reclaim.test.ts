// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { arrayBenchmarks } from "../benchmarks/suites/arrays.js";
import { mixedBenchmarks } from "../benchmarks/suites/mixed.js";
import { stringBenchmarks } from "../benchmarks/suites/strings.js";
import { compile } from "../src/index.js";

type LinearExports = Record<string, unknown> & {
  memory: WebAssembly.Memory;
  __arena_used?: () => number;
};

async function instantiateLinear(
  source: string,
  allocator: "bump" | "arena-reset" = "arena-reset",
  optimize?: number,
): Promise<{ exports: LinearExports; wat: string; binary: Uint8Array }> {
  const result = await compile(source, { target: "linear", allocator, optimize, emitWat: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return { exports: instance.exports as LinearExports, wat: result.wat, binary: result.binary };
}

describe("#3924 linear exported-call arena reclaim", () => {
  it("rewinds before primitive-only exported calls while preserving primitive module state", async () => {
    const source = `
      let calls = 0;
      export function run(seed: number): number {
        calls = calls + 1;
        const values: number[] = [];
        for (let i = 0; i < 2048; i = i + 1) values.push(seed + i);
        return calls * 10000 + values[seed];
      }
    `;
    const reclaimed = await instantiateLinear(source);
    const run = reclaimed.exports.run as (seed: number) => number;
    const arenaUsed = reclaimed.exports.__arena_used!;

    expect(reclaimed.wat).toContain("(func $__arena_entry_run");
    expect(run(0)).toBe(10000);
    const oneCallBytes = arenaUsed();
    expect(oneCallBytes).toBeGreaterThan(0);
    for (let call = 2; call <= 200; call++) expect(run(0)).toBe(call * 10000);
    expect(arenaUsed()).toBe(oneCallBytes);
    expect(reclaimed.exports.memory.buffer.byteLength).toBe(65536);
  });

  it("keeps omitted/default and explicit bump allocation byte-identical", async () => {
    const source = `export function run(): number { const a: number[] = [1, 2, 3]; return a.length; }`;
    const omitted = await compile(source, { target: "linear" });
    const explicit = await compile(source, { target: "linear", allocator: "bump" });
    expect(omitted.success).toBe(true);
    expect(explicit.success).toBe(true);
    expect([...explicit.binary]).toEqual([...omitted.binary]);
  });

  it("resets only at host exports, never when one exported function calls another internally", async () => {
    const module = await instantiateLinear(`
      export function inner(value: number): number {
        const scratch: number[] = [];
        scratch.push(value);
        return scratch[0];
      }
      export function outer(): number {
        const retained: number[] = [];
        retained.push(40);
        return retained[0] + inner(2);
      }
    `);
    const outer = module.exports.outer as () => number;

    expect(module.wat).toContain("(func $__arena_entry_inner");
    expect(module.wat).toContain("(func $__arena_entry_outer");
    expect(outer()).toBe(42);
  });

  it("falls back module-wide for aggregate params/results so returned pointers stay live", async () => {
    const module = await instantiateLinear(`
      export function make(): number[] {
        const result: number[] = [];
        result.push(7);
        return result;
      }
      export function churn(): number {
        const scratch: number[] = [];
        scratch.push(99);
        return scratch[0];
      }
      export function read(value: number[]): number { return value[0]; }
    `);
    const make = module.exports.make as () => number;
    const churn = module.exports.churn as () => number;
    const read = module.exports.read as (pointer: number) => number;

    expect(module.wat).not.toContain("__arena_entry_");
    const returnedPointer = make();
    const afterMake = module.exports.__arena_used!();
    expect(churn()).toBe(99);
    expect(module.exports.__arena_used!()).toBeGreaterThan(afterMake);
    expect(read(returnedPointer)).toBe(7);
  });

  it("falls back module-wide when an arena allocation escapes into a module global", async () => {
    const module = await instantiateLinear(`
      let saved: number[];
      export function step(initialize: number): number {
        if (initialize === 1) {
          saved = [];
          saved.push(41);
          return saved.length;
        }
        const scratch: number[] = [];
        scratch.push(99);
        return saved[0] + scratch[0];
      }
    `);
    const step = module.exports.step as (initialize: number) => number;

    expect(module.wat).not.toContain("__arena_entry_");
    expect(step(1)).toBe(1);
    expect(step(0)).toBe(140);
  });

  const affected = [
    { name: "string/split", expected: 75000 },
    { name: "array/map-filter", expected: 3334 },
    { name: "mixed/csv-parse", expected: 97000 },
    { name: "mixed/sieve", expected: 9592 },
  ] as const;
  const benchmarkDefinitions = [...stringBenchmarks, ...arrayBenchmarks, ...mixedBenchmarks];

  it.each(affected)(
    "completes the stock $name call count with the correct value",
    async ({ name, expected }) => {
      const definition = benchmarkDefinitions.find((candidate) => candidate.name === name)!;
      const module = await instantiateLinear(definition.source, "arena-reset", 4);
      const run = module.exports.run as () => number;
      const calls = (definition.warmup ?? 5) + (definition.iterations ?? 100);

      let value = 0;
      for (let call = 0; call < calls; call++) value = run();
      expect(value).toBe(expected);
    },
    30_000,
  );

  it("does not hide #3935's intra-call quadratic concat exhaustion", async () => {
    const definition = stringBenchmarks.find((candidate) => candidate.name === "string/concat-short")!;
    const module = await instantiateLinear(definition.source, "arena-reset", 4);
    const run = module.exports.run as () => number;

    expect(() => run()).toThrow(/memory access out of bounds/);
  }, 30_000);
});
