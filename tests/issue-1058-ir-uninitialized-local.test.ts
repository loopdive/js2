// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe.each(["gc", "standalone"] as const)("uninitialized local (%s)", (target) => {
  it.each([
    ["undefined", "let value: number | undefined; return value === undefined ? 1 : 0;", 1],
    [
      "assignment",
      "let value: number | undefined; const before = value === undefined ? 1 : 0; value = 42; return before * 100 + value;",
      142,
    ],
    [
      "captured read",
      "let value: number | undefined; const read = (): number => value === undefined ? 1 : 2; const before = read(); value = 42; return before * 10 + read();",
      12,
    ],
    [
      "captured write",
      "let value: number | undefined; function set(next: number): number { value = next; return 7; } const before = value === undefined ? 1 : 0; set(42); return before * 100 + value;",
      142,
    ],
    [
      "undefined is not null",
      "let value: number | undefined; return value === null ? 0 : value === undefined ? 1 : 2;",
      1,
    ],
  ] as const)("initializes local storage with real undefined (%s)", async (_name, body, expected) => {
    const result = await compile(`export function run(): number { ${body} }`, {
      target,
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = new WebAssembly.Instance(module, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.run as () => number)()).toBe(expected);
    expect(
      result.irOutcomes?.find((row) => row.displayName === "run"),
      JSON.stringify(result.irOutcomes),
    ).toMatchObject({ irBodyEmitted: true });
  });
});
