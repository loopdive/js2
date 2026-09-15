// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { format } from "node:util";
import { compile } from "../src/index.js";

async function run(source: string, standalone: boolean, optimize: boolean, experimentalIR = true): Promise<string[]> {
  const result = await compile(source, {
    fileName: "console-inspection.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
    optimize,
    experimentalIR,
    ...(standalone ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  if (standalone) expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
  const output: string[] = [];
  const savedLog = console.log;
  console.log = (...args) => output.push(format(...args));
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    if (standalone) {
      const prepare = instance.exports.__stdout_prepare as () => number;
      const char = instance.exports.__stdout_char as (index: number) => number;
      const raw = Array.from({ length: prepare() }, (_, index) => String.fromCharCode(char(index))).join("");
      output.push(...raw.replace(/\n$/, "").split("\n"));
    }
  } finally {
    console.log = savedLog;
  }
  return output;
}

for (const standalone of [false, true]) {
  for (const optimize of [false, true]) {
    for (const experimentalIR of [false, true]) {
      describe(`#5403 console numeric inspection (${standalone ? "standalone" : "host"}, optimize=${optimize}, IR=${experimentalIR})`, () => {
        it("preserves negative zero in the numeric-only IR candidate", async () => {
          expect(
            await run(
              `
            console.log(-0); console.log(-1*0); console.log(0); console.log(1);
            console.log(NaN); console.log(Infinity); console.log(-Infinity);
          `,
              standalone,
              optimize,
              experimentalIR,
            ),
          ).toEqual(["-0", "-0", "0", "1", "NaN", "Infinity", "-Infinity"]);
        });
        it("prints BigInt suffixes only for raw values, preserving explicit String conversions", async () => {
          expect(
            await run(
              `
            const n = 1n;
            console.log(n); console.log(n + 2n); console.log(0n); console.log(-1n);
            console.log(9007199254740993n);
            console.log(String(-0)); console.log(String(n)); console.log(String(n+2n));
          `,
              standalone,
              optimize,
              experimentalIR,
            ),
          ).toEqual(["1n", "3n", "0n", "-1n", "9007199254740993n", "0", "1", "3"]);
        });
        it("keeps native i64 numeric values unbranded", async () => {
          expect(
            await run(
              `
            type i64 = number;
            const value: i64 = 1;
            console.log(value); console.log(0 | 0); console.log(1 | 0);
          `,
              standalone,
              optimize,
              experimentalIR,
            ),
          ).toEqual(["1", "0", "1"]);
        });
      });
    }
  }
}
