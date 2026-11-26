// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7370 — `x?.toFixed(1)` on a `number | undefined` (or `x?: number`) receiver returned `undefined` even for a
// defined `x`: the optional-call lowering treated every value-type receiver as nullish, and the method ladder saw
// the receiver as `number | undefined`, so no Number arm (nor its helper registration) matched.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  [
    "`toFixed` on a `number | undefined` parameter",
    "function f(x: number | undefined) { return x?.toFixed(1); } " +
      "export function main(): number { return (f(2) === '2.0' ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "`toFixed` under `??`",
    "function f(x: number | undefined): string { return x?.toFixed(1) ?? 'u'; } " +
      "export function main(): number { return (f(2) === '2.0' ? 1 : 0) + (f(undefined) === 'u' ? 10 : 0); }",
    11,
  ],
  [
    "`toFixed` on an optional parameter",
    "function f(x?: number) { return x?.toFixed(1); } " +
      "export function main(): number { return (f(2) === '2.0' ? 1 : 0) + (f() === undefined ? 10 : 0); }",
    11,
  ],
  [
    "`toFixed` on a `number | null` parameter",
    "function f(x: number | null) { return x?.toFixed(0); } " +
      "export function main(): number { return (f(3) === '3' ? 1 : 0) + (f(null) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "`toFixed` on a NaN",
    "function f(x: number | undefined) { return x?.toFixed(1); } export function main(): number { return f(NaN) === 'NaN' ? 1 : 0; }",
    1,
  ],
  [
    "`toString`",
    "function f(x: number | undefined) { return x?.toString(); } " +
      "export function main(): number { return (f(5) === '5' ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "`toPrecision`",
    "function f(x: number | undefined) { return x?.toPrecision(2); } " +
      "export function main(): number { return (f(1.25) === '1.3' ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "`toFixed` on a plain `number`",
    "function f(x: number) { return x?.toFixed(1); } export function main(): number { return f(2) === '2.0' ? 1 : 0; }",
    1,
  ],
];

describe.each(["gc", "standalone"] as const)("#7370 — `?.` calls a method on a primitive receiver (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
