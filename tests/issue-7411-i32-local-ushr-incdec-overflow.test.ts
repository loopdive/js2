// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7411 — the legacy i32-local promotion (`collectI32CoercedLocals`) kept two writes whose result leaves the int32
// range in an i32 slot: `x >>>= n` (an unsigned 32-bit result) and `x++` / `x--` (which leave int32 at its bounds).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(body: string, target: Target, experimentalIR?: false): Promise<number> {
  const source = `export function main(): number { ${body} }`;
  const result = await compile(source, { fileName: "test.ts", target, experimentalIR });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

// [program body, what JavaScript returns]
const CASES: readonly (readonly [string, number])[] = [
  ["let x: number = -1; x >>>= 0; return x;", 4294967295],
  ["let x: number = -16; x >>>= 0; return x;", 4294967280],
  ["let x: number = 2147483647; x++; return x;", 2147483648],
  ["let x: number = 2147483647; ++x; return x;", 2147483648],
  ["let x: number = -2147483647; x--; x--; return x;", -2147483649],
  ["let x: number = -2147483647; --x; --x; return x;", -2147483649],
  ["let x: number = 2147483647; const y = ++x; return y;", 2147483648],
  ["let x: number = 2147483647; x += 1; return x;", 2147483648],
];

describe.each(["gc", "standalone"] as const)("#7411 — i32 locals keep JavaScript's number range (%s)", (target) => {
  for (const experimentalIR of [undefined, false] as const) {
    const pipeline = experimentalIR === false ? "legacy" : "default";
    for (const [body, expected] of CASES) {
      it(`${pipeline}: ${body}`, async () => {
        expect(await runMain(body, target, experimentalIR)).toBe(expected);
      });
    }
  }
});
