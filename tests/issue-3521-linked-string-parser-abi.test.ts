// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";

import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "../src/ir/lower.js";
import type { IrType } from "../src/ir/nodes.js";
import { compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const previousIrFirst = process.env.JS2WASM_IR_FIRST;
const irIdentities = createTestIrFunctionIdentityFactory("issue-3521-linked-string-parser-abi");
const STRING: IrType = { kind: "string" };
const ANY_STRING_TYPE_IDX = 17;

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
  it.each([
    { branch: "decimal", input: "12_3", octal: false, expected: 123 },
    { branch: "octal", input: "17", octal: true, expected: 15 },
  ])(
    "lowers the exact linked Parser edge and preserves the $branch runtime result",
    async ({ input, octal, expected }) => {
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
            var octal = ${octal};
            return stringToNumber(parser.input.slice(0, parser.input.length), octal);
          }
          export function run() {
            return readNumber(new Parser("${input}"));
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
      expect(readNumber).toMatchObject({
        kind: "emitted",
        prepareAttempts: 1,
        directBodyEmissions: 1,
        irBodyEmissions: 1,
        legacyBodyEmitted: true,
        irBodyEmitted: true,
      });
      expect(stringToNumber).toMatchObject({
        kind: "emitted",
        prepareAttempts: 1,
        directBodyEmissions: 1,
        irBodyEmissions: 1,
        legacyBodyEmitted: true,
        irBodyEmitted: true,
      });
      expect(run).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });
      expect(new Set([parser.sourceId, readNumber.sourceId, stringToNumber.sourceId, run.sourceId]).size).toBe(1);
      expect(new Set([parser.unitId, readNumber.unitId, stringToNumber.unitId, run.unitId]).size).toBe(4);

      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
      (result.importObject as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports?.(
        instance.exports,
      );
      expect((instance.exports.run as () => number)()).toBe(expected);
    },
  );

  it("enforces the canonical nullable native-string parameter carrier and entry refinement", () => {
    const builder = new IrFunctionBuilder(irIdentities.next("readNumberPhysicalParam"), [STRING]);
    const input = builder.addParam("input", STRING);
    builder.openBlock();
    builder.terminate({ kind: "return", values: [input] });
    const fn = builder.finish();

    const resolver = (typeIdx: number): IrLowerResolver => ({
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      internFuncType: () => 0,
      resolveString: () => ({ kind: "ref", typeIdx: ANY_STRING_TYPE_IDX }),
      resolveParamPhysicalType: () => ({
        type: { kind: "ref_null", typeIdx },
        refineNonNull: true,
      }),
    });

    const exactResolver = resolver(ANY_STRING_TYPE_IDX);
    const exact = lowerIrFunctionBody(
      fn,
      exactResolver,
      new WasmGcEmitter(),
      wasmValueTypeConverter("wasmgc", exactResolver, fn.name),
    );
    expect(exact.params[0]?.slots).toEqual([{ kind: "ref_null", typeIdx: ANY_STRING_TYPE_IDX }]);
    expect(exact.results).toEqual([[{ kind: "ref", typeIdx: ANY_STRING_TYPE_IDX }]]);
    expect(exact.body).toEqual([{ op: "local.get", index: 0 }, { op: "ref.as_non_null" }, { op: "return" }]);

    const staleResolver = resolver(ANY_STRING_TYPE_IDX + 1);
    expect(() =>
      lowerIrFunctionBody(
        fn,
        staleResolver,
        new WasmGcEmitter(),
        wasmValueTypeConverter("wasmgc", staleResolver, fn.name),
      ),
    ).toThrow(/canonical native-string carrier\/refinement/);
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
