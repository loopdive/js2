import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#3794 IR dynamic RegExp/string replace dispatch", () => {
  it("executes Acorn's exact stringToNumber replace shape", async () => {
    const source = `
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8);
  }
  return parseFloat(str.replace(/_/g, ""));
}

export function callStringToNumber() {
  const str: any = "12_345.5";
  return stringToNumber(str, false);
}

export function callLegacyStringToNumber() {
  const str: any = "17";
  return stringToNumber(str, true);
}
`;
    const result = await compile(source, {
      fileName: "issue-3794-ir-dynamic-replace-positive.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("stringToNumber");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    expect((instance.exports.callStringToNumber as () => number)()).toBe(12345.5);
    expect((instance.exports.callLegacyStringToNumber as () => number)()).toBe(15);
  });

  it("rejects wider arity, spread, dynamic, reference, and non-exact literal shapes before claim", async () => {
    const source = `
function arityThree(str: any): number {
  return +str.replace(/_/g, "", "extra");
}

function spreadArguments(str: any): number {
  const args: any = [/_/g, ""];
  return +str.replace(...args);
}

function dynamicReplacement(str: any, replacement: any): number {
  return +str.replace(/_/g, replacement);
}

function regexpReference(str: any): number {
  const pattern = /_/g;
  return +str.replace(pattern, "");
}

function wrongPattern(str: any): number {
  return +str.replace(/x/g, "");
}

function nonEmptyReplacement(str: any): number {
  return +str.replace(/_/g, "x");
}

export function run(): number {
  return arityThree("4_2") +
    spreadArguments("4_2") +
    dynamicReplacement("4_2", "") +
    regexpReference("4_2") +
    wrongPattern("4_2") +
    nonEmptyReplacement("4_2");
}
`;
    const result = await compile(source, {
      fileName: "issue-3794-ir-dynamic-replace-negatives.ts",
      target: "gc",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of [
      "arityThree",
      "spreadArguments",
      "dynamicReplacement",
      "regexpReference",
      "wrongPattern",
      "nonEmptyReplacement",
    ]) {
      expect(result.irCompiledFuncs ?? [], name).not.toContain(name);
    }
  });

  it("preserves custom replace dispatch for generic dynamic receivers", async () => {
    const source = `
export function genericReplace(value: any): number {
  return +value.replace(/_/g, "");
}

export function makeString(): any {
  return "4_1";
}

export function makeCustom(): any {
  return {
    replace() {
      return "41";
    },
  };
}
`;
    const result = await compile(source, {
      fileName: "issue-3794-ir-dynamic-replace-custom.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("genericReplace");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const genericReplace = instance.exports.genericReplace as (value: unknown) => number;
    const nativeString = (instance.exports.makeString as () => unknown)();
    const custom = (instance.exports.makeCustom as () => unknown)();
    expect(genericReplace(nativeString)).toBe(41);
    expect(genericReplace(custom)).toBe(41);
  });

  it("rejects inferred string parse carriers before claim", async () => {
    const source = `
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8);
  }
  return parseFloat(str.replace(/_/g, ""));
}

export function run(): number {
  return stringToNumber("1_2.5", false);
}
`;
    const result = await compile(source, {
      fileName: "issue-3794-ir-dynamic-replace-inferred-string.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("stringToNumber");
  });
});
