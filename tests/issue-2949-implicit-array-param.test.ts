// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 — an untyped parameter whose call sites agree on one native vec
// carrier must use that exact ABI in both the direct callable and the IR
// overlay. Acorn's isInAstralSet helper is the measured runtime-dynamic case.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#2949 — implicit array parameter projection", () => {
  it("emits the Acorn isInAstralSet helper without ABI withdrawal", async () => {
    const result = await compile(
      `
        function isInAstralSet(code, set) {
          var pos = 0x10000;
          for (var i = 0; i < set.length; i += 2) {
            pos += set[i];
            if (pos > code) return false;
            pos += set[i + 1];
            if (pos >= code) return true;
          }
          return false;
        }

        export function callAstral(code: any, set: number[]): boolean {
          return new RegExp("x").test("x") && isInAstralSet(code, set);
        }
      `,
      {
        allowJs: true,
        experimentalIR: true,
        fileName: "issue-2949-implicit-array-param.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("isInAstralSet");
    expect(result.irCompiledFuncs ?? []).not.toContain("callAstral");
    expect(result.irOutcomes?.some((outcome) => outcome.code === "abi-signature-parity")).toBe(false);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });
});
