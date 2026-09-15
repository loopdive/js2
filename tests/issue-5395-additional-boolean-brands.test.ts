// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, standalone: boolean, optimize: boolean, experimentalIR = true): Promise<string[]> {
  const result = await compile(source, {
    fileName: "boolean-brands.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    optimize,
    experimentalIR,
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
    for (const experimentalIR of [false, true]) {
      describe(`#5395 additional boolean producers (${standalone ? "standalone" : "host"}, optimize=${optimize}, IR=${experimentalIR})`, () => {
        it("renders string comparisons as booleans while preserving numeric results", async () => {
          expect(
            await run(
              `
            console.log("a" < "b"); console.log("b" < "a");
            console.log("a" <= "a"); console.log("a" >= "b");
            console.log("a" === "a"); console.log("a" !== "a");
            console.log("a" == "a"); console.log("a" != "a");
            console.log("a" + "b" === "ab");
            console.log("ab".indexOf("a")); console.log("ab".indexOf("b"));
            console.log(1 | 0); console.log(0 | 0);
          `,
              standalone,
              optimize,
              experimentalIR,
            ),
          ).toEqual(["true", "false", "true", "false", "true", "false", "true", "false", "true", "0", "1", "1", "0"]);
        });
        it("renders global and Number predicates without confusing their coercion rules", async () => {
          expect(
            await run(
              `
            console.log(isNaN(NaN)); console.log(isNaN(1));
            console.log(isNaN("x")); console.log(isFinite(Infinity)); console.log(isFinite("1"));
            console.log(Number.isNaN(NaN)); console.log(Number.isNaN(1));
            console.log(Number.isNaN("x")); console.log(Number.isNaN());
            console.log(Number.isInteger(1)); console.log(Number.isInteger(1.5));
            console.log(Number.isSafeInteger(1)); console.log(Number.isFinite(1));
            console.log(Number.isFinite("1")); console.log(Number.isFinite());
          `,
              standalone,
              optimize,
              experimentalIR,
            ),
          ).toEqual([
            "true",
            "false",
            "true",
            "false",
            "true",
            "true",
            "false",
            "false",
            "false",
            "true",
            "false",
            "true",
            "true",
            "false",
            "false",
          ]);
        });
      });
    }
  }
}
