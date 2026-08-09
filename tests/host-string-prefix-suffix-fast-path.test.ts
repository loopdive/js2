// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function compileHost(source: string): Promise<{
  run: (...args: string[]) => number;
  imports: Awaited<ReturnType<typeof compile>>["imports"];
  runWat: string;
}> {
  const result = await compile(source, {
    fileName: "host-string-prefix-suffix.ts",
    nativeStrings: false,
    experimentalIR: false,
    optimize: 4,
    emitWat: true,
    emitWatOnlyFunctions: ["run"],
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return {
    run: (instance.exports as Record<string, (...args: string[]) => number>).run!,
    imports: result.imports,
    runWat: result.wat ?? "",
  };
}

describe("host string prefix/suffix intrinsic", () => {
  it("uses wasm:js-string primitives for fixed prefixes and suffixes", async () => {
    const { run, imports, runWat } = await compileHost(`
      export function run(): number {
        const values: string[] = ["hello world", "hello there", "small world", "small"];
        let count = 0;
        for (let i = 0; i < values.length; i = i + 1) {
          const value = values[i];
          if (value.startsWith("hello")) count = count + 1;
          if (value.endsWith("world")) count = count + 2;
        }
        return count;
      }
    `);

    expect(run()).toBe(6);
    expect(imports.some((entry) => entry.module === "env" && entry.name === "string_startsWith")).toBe(false);
    expect(imports.some((entry) => entry.module === "env" && entry.name === "string_endsWith")).toBe(false);
    expect(runWat).toContain('(import "wasm:js-string" "substring"');
    expect(runWat).toContain('(import "wasm:js-string" "equals"');
    expect(runWat).not.toContain("call $string_startsWith");
    expect(runWat).not.toContain("call $string_endsWith");
  });

  it("compares UTF-16 code units and handles empty or longer needles", async () => {
    const { run } = await compileHost(`
      export function run(): number {
        const values: string[] = ["😀tail", "plain", "a longer suffix", ""];
        let count = 0;
        for (let i = 0; i < values.length; i = i + 1) {
          const value = values[i];
          if (value.startsWith("😀")) count = count + 1;
          if (value.endsWith("")) count = count + 2;
          if (value.endsWith("a longer suffix")) count = count + 4;
        }
        return count;
      }
    `);

    expect(run()).toBe(13);
  });

  it("keeps explicit positions on the general method path", async () => {
    const { run, imports } = await compileHost(`
      export function run(value: string): number {
        let count = 0;
        if (value.startsWith("world", 6)) count = count + 1;
        if (value.endsWith("hello", 5)) count = count + 2;
        return count;
      }
    `);

    expect(run("hello world")).toBe(3);
    expect(imports.some((entry) => entry.module === "env" && entry.name === "string_startsWith")).toBe(true);
    expect(imports.some((entry) => entry.module === "env" && entry.name === "string_endsWith")).toBe(true);
  });

  it("keeps dynamic needles and source-visible method writes on the general path", async () => {
    const dynamic = await compileHost(`
      export function run(value: string, needle: string): number {
        return value.startsWith(needle) ? 1 : 0;
      }
    `);
    expect(dynamic.run("hello", "hell")).toBe(1);
    expect(dynamic.imports.some((entry) => entry.module === "env" && entry.name === "string_startsWith")).toBe(true);

    const reassigned = await compileHost(`
      export function run(value: string): number {
        if (false) (value as any).startsWith = 0;
        return value.startsWith("hello") ? 1 : 0;
      }
    `);
    expect(reassigned.run("hello world")).toBe(1);
    expect(reassigned.imports.some((entry) => entry.module === "env" && entry.name === "string_startsWith")).toBe(true);
  });
});
