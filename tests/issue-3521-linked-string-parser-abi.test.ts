// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const previousIrFirst = process.env.JS2WASM_IR_FIRST;

afterEach(() => {
  if (previousIrFirst === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = previousIrFirst;
});

describe("#3521 linked Parser string ABI", () => {
  it("lowers the exact linked Parser edge once and preserves both numeric branches", async () => {
    process.env.JS2WASM_IR_FIRST = "0";
    const result = await compileMulti(
      {
        "./entry.mjs": `
          function Parser(input) {
            this.input = input;
          }
          function stringToNumber(str, isLegacyOctalNumericLiteral) {
            if (isLegacyOctalNumericLiteral) return parseInt(str, 8);
            return parseFloat(str.replace(/_/g, ""));
          }
          function readNumber(parser) {
            var octal = false;
            return stringToNumber(parser.input.slice(0, parser.input.length), octal);
          }
          export function run() {
            return readNumber(new Parser("12_3"));
          }
        `,
        "./empty.mjs": "export const unused = 0;",
      },
      "./entry.mjs",
      {
        allowJs: true,
        target: "standalone",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["stringToNumber", "readNumber"]));

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    (result.importObject as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
    expect((instance.exports.run as () => number)()).toBe(123);
  });
});
