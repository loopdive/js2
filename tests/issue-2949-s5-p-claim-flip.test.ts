// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.P — claim the landed dynamic truthiness/equality/relational/
// arithmetic producers and keep the selector's parameter ABI aligned with the
// direct callable.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const DYNAMIC_HELPERS = `
export function isModifier(ch: any): boolean {
  return ch === 105 || ch === 109 || ch === 115;
}

export function isLooseDigit(ch: any): boolean {
  return ch == 53;
}

export function isDigit(ch: any): boolean {
  return ch >= 48 && ch <= 57;
}

export function dec(ch: any): number {
  return ch - 1;
}

export function truth(ch: any): number {
  return ch ? 1 : 0;
}
`;

async function compileStandalone(source: string) {
  const result = await compile(source, {
    allowJs: true,
    experimentalIR: true,
    fileName: "issue-2949-s5-p.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  try {
    new WebAssembly.Module(result.binary);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${result.errors.map((entry) => entry.message).join("\n")}`,
    );
  }
  return result;
}

describe("#2949 S5.P dynamic-operator claim flip", () => {
  it("emits and runs the Acorn-style dynamic helper family in standalone", async () => {
    const result = await compileStandalone(DYNAMIC_HELPERS);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["isModifier", "isLooseDigit", "isDigit", "dec", "truth"]),
    );

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.isModifier as (value: unknown) => number)(105)).toBe(1);
    expect((instance.exports.isModifier as (value: unknown) => number)(53)).toBe(0);
    expect((instance.exports.isLooseDigit as (value: unknown) => number)(53)).toBe(1);
    expect((instance.exports.isLooseDigit as (value: unknown) => number)(54)).toBe(0);
    expect((instance.exports.isDigit as (value: unknown) => number)(53)).toBe(1);
    expect((instance.exports.dec as (value: unknown) => number)(53)).toBe(52);
    expect((instance.exports.truth as (value: unknown) => number)(0)).toBe(0);
    expect((instance.exports.truth as (value: unknown) => number)(53)).toBe(1);
  });

  it("projects a concrete implicit parameter ABI before claim and emits without parity withdrawal", async () => {
    const result = await compileStandalone(`
      function hexToInt(ch) {
        if (ch >= 65 && ch <= 70) return 10 + (ch - 65);
        if (ch >= 97 && ch <= 102) return 10 + (ch - 97);
        return ch - 48;
      }

      export function parseHex() {
        return hexToInt(66) * 100 + hexToInt(101);
      }
    `);

    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["hexToInt", "parseHex"]));
    expect(result.irOutcomes?.some((outcome) => outcome.code === "abi-signature-parity")).toBe(false);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.parseHex as () => number)()).toBe(1114);
  });

  it("boxes a concrete numeric result at an explicit-any direct-call boundary", async () => {
    const result = await compileStandalone(`
      function sameValue(actual: any, expected: any): number {
        return actual === expected ? 1 : 0;
      }

      export function checkPow(): number {
        return sameValue(Math.pow(2, 3), 8);
      }
    `);

    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["sameValue", "checkPow"]));

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.checkPow as () => number)()).toBe(1);
  });
});
