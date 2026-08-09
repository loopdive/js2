// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 — Acorn emits parser scope flags as unique top-level `var` scalars.
// Their IR readers must share the exact legacy module-global slots.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#2949 — Acorn module var scalars", () => {
  it("emits functionFlags through IR while its caller remains on the direct path", async () => {
    const result = await compile(
      `
        var SCOPE_FUNCTION = 2;
        var SCOPE_ASYNC = 4;
        var SCOPE_GENERATOR = 8;

        function functionFlags(async, generator) {
          return SCOPE_FUNCTION |
            (async ? SCOPE_ASYNC : 0) |
            (generator ? SCOPE_GENERATOR : 0);
        }

        export function callFlags(async: boolean, generator: boolean): number {
          return new RegExp("x").test("x")
            ? functionFlags(async, generator)
            : -1;
        }
      `,
      {
        allowJs: true,
        experimentalIR: true,
        fileName: "issue-2949-module-var-scalars.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("functionFlags");
    expect(result.irCompiledFuncs ?? []).not.toContain("callFlags");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const callFlags = instance.exports.callFlags as (async: number, generator: number) => number;
    expect(callFlags(0, 0)).toBe(2);
    expect(callFlags(1, 0)).toBe(6);
    expect(callFlags(1, 1)).toBe(14);
  });

  it("keeps repeated var declarations outside the exact module binding capability", async () => {
    const result = await compile(
      `
        var FLAG = 2;
        var FLAG;
        export function readFlag(): number { return FLAG; }
      `,
      {
        allowJs: true,
        experimentalIR: true,
        fileName: "issue-2949-module-var-repeated.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("readFlag");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps ordinary numeric var storage on the direct path in fast mode", async () => {
    const result = await compile(
      `
        var FLAG = 2;
        export function readFlag(): number { return FLAG; }
      `,
      {
        allowJs: true,
        experimentalIR: true,
        fast: true,
        fileName: "issue-2949-module-var-fast.ts",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("readFlag");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
