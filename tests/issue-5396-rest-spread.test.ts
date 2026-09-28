// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, standalone: boolean, optimize: boolean): Promise<string[]> {
  const result = await compile(source, {
    fileName: "rest-spread.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    optimize,
    ...(standalone ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const output: string[] = [];
  const savedLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(" "));
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
    describe(`#5396 rest/spread (${standalone ? "standalone" : "host"}, optimize=${optimize})`, () => {
      it("preserves explicit arguments and literal/variable spreads", async () => {
        expect(
          await run(
            `
          function sum(...nums) { return nums.reduce((a,b) => a+b, 0); }
          console.log(sum(1,2,3,4));
          console.log(sum(...[10,20,30]));
          const values = [10,20,30];
          console.log(sum(...values));
          console.log(Math.max(...[1,5,3]));
        `,
            standalone,
            optimize,
          ),
        ).toEqual(["10", "60", "60", "5"]);
      });
      it("packs all mixed rest arguments and creates a fresh rest array", async () => {
        expect(
          await run(
            `
          function sum(base, ...nums) { return base + nums.reduce((a,b) => a+b, 0); }
          const values = [2,3];
          console.log(sum(10, 1, ...values, 4, ...[5,6]));
          function change(...nums) { nums[0] = 99; return nums[0]; }
          console.log(change(...values));
          console.log(values[0]);
          console.log(sum(10, ...[]));
        `,
            standalone,
            optimize,
          ),
        ).toEqual(["31", "99", "2", "10"]);
      });
      it("preserves nested Math literal spreads and numeric dynamic spreads", async () => {
        expect(
          await run(
            `
          const values = [1,5,3];
          console.log(Math.max(...values));
          console.log(Math.min(9, ...[4, ...[2,3]], 8));
          console.log(Math.max(...[]));
        `,
            standalone,
            optimize,
          ),
        ).toEqual(["5", "2", "-Infinity"]);
      });
      it("rejects a spread across fixed and rest parameters with a source location", async () => {
        const result = await compile(
          `function f(first, ...rest) { return first + rest.length; }\nconsole.log(f(...[1,2,3]));`,
          {
            fileName: "prefix.js",
            allowJs: true,
            skipSemanticDiagnostics: true,
            optimize,
            ...(standalone ? { target: "standalone" as const } : {}),
          },
        );
        expect(result.success).toBe(false);
        expect(result.binary.length).toBe(0);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              severity: "error",
              line: 2,
              message: expect.stringContaining("[JS2WASM_UNSUPPORTED_REST_PREFIX_SPREAD]"),
            }),
          ]),
        );
      });
    });
  }
}
