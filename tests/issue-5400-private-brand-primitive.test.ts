// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, standalone: boolean, optimize: boolean, experimentalIR = true): Promise<string[]> {
  const result = await compile(source, {
    fileName: "private-brand.js",
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
    describe(`#5400 private-brand receivers (${standalone ? "standalone" : "host"}, optimize=${optimize})`, () => {
      it("throws catchable TypeError for each primitive receiver", async () => {
        expect(
          await run(
            `
          class Box { #v; static check(value) { return #v in value; } }
          function probe(value) { try { Box.check(value); console.log("miss"); } catch(e) { console.log(e instanceof TypeError); } }
          probe(null); probe(undefined); probe(1); probe(0); probe(true); probe(false); probe("text"); probe(1n); probe(Symbol("s"));
        `,
            standalone,
            optimize,
          ),
        ).toEqual(Array(9).fill("true"));
      });
      it("preserves matching and unrelated object/function receivers", async () => {
        expect(
          await run(
            `
          class Box { #v; static check(value) { return #v in value; } }
          class Other { #v; }
          console.log(Box.check(new Box())); console.log(Box.check({}));
          console.log(Box.check(new Other())); console.log(Box.check([]));
          console.log(Box.check(function() {}));
        `,
            standalone,
            optimize,
          ),
        ).toEqual(["true", "false", "false", "false", "false"]);
      });
    });
  }
}
