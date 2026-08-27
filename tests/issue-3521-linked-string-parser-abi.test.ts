// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";

import { compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";

const previousIrFirst = process.env.JS2WASM_IR_FIRST;

afterEach(() => {
  if (previousIrFirst === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = previousIrFirst;
});

function functionOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const matches =
    result.irOutcomes?.filter((candidate) => candidate.unitKind === "function" && candidate.displayName === name) ?? [];
  expect(matches, `expected one IR outcome for ${name}`).toHaveLength(1);
  return matches[0]!;
}

describe("#3521 linked Parser string ABI", () => {
  it("lowers the exact linked Parser edge and preserves the decimal runtime result", async () => {
    // Exercise the post-legacy late overlay used by this PR checkpoint.
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
        experimentalIR: true,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["stringToNumber", "readNumber"]));
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const parser = functionOutcome(result, "Parser");
    const readNumber = functionOutcome(result, "readNumber");
    const stringToNumber = functionOutcome(result, "stringToNumber");
    const run = functionOutcome(result, "run");
    expect(parser).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });
    expect(readNumber).toMatchObject({ kind: "emitted", legacyBodyEmitted: true, irBodyEmitted: true });
    expect(stringToNumber).toMatchObject({ kind: "emitted", legacyBodyEmitted: true, irBodyEmitted: true });
    expect(run).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });
    expect(new Set([parser.sourceId, readNumber.sourceId, stringToNumber.sourceId, run.sourceId]).size).toBe(1);
    expect(new Set([parser.unitId, readNumber.unitId, stringToNumber.unitId, run.unitId]).size).toBe(4);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    (result.importObject as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
    expect((instance.exports.run as () => number)()).toBe(123);
  });

  it("keeps an aliased Parser allocation on the legacy control route", async () => {
    process.env.JS2WASM_IR_FIRST = "0";
    const result = await compileMulti(
      {
        "./entry.mjs": `
          function ParserControl(input) {
            this.input = input;
          }
          function stringToNumberControl(str, isLegacyOctalNumericLiteral) {
            if (isLegacyOctalNumericLiteral) return parseInt(str, 8);
            return parseFloat(str.replace(/_/g, ""));
          }
          function readNumberControl(parser) {
            var octal = false;
            return stringToNumberControl(parser.input.slice(0, parser.input.length), octal);
          }
          export function runControl() {
            const parser = new ParserControl("12_3");
            return readNumberControl(parser);
          }
        `,
        "./empty.mjs": "export const unused = 0;",
      },
      "./entry.mjs",
      {
        allowJs: true,
        target: "standalone",
        experimentalIR: true,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(functionOutcome(result, "readNumberControl")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    (result.importObject as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
    expect((instance.exports.runControl as () => number)()).toBe(123);
  });
});
