// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7066 step 1 — the selector refuses a `+` the builder's operand gate would
// demote, wherever both decide from the same checker proof (static operands),
// so the claim never outlives its lowering.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileHarnessBody, moduleInit } from "./helpers/harness-module-init.js";

const B = 'export function b(n: number): string { return "v" + (n > 0 ? "p" : 0); }';

function outcomeOf(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
}

describe("#7066 mixed `+` refused at selection", () => {
  for (const target of ["gc", "standalone", "wasi"] as const) {
    it(`compiles the repro without a caller on ${target}`, async () => {
      const result = await compile(B, {
        fileName: "issue-7066.ts",
        trackIrOutcomes: true,
        ...(target === "gc" ? {} : { target }),
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(outcomeOf(result, "b")?.code).toBe("operand-coercion-unsupported");
    });
  }

  it("answers as node does with a caller", async () => {
    const source = `${B}\nexport function c(): number { return (b(1) === "vp" ? 1 : 0) + (b(-1) === "v0" ? 10 : 0); }`;
    const result = await compile(source, { fileName: "issue-7066.ts", target: "standalone", trackIrOutcomes: true });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    // node: b(1) === "vp", b(-1) === "v0".
    expect((instance.exports.c as () => number)()).toBe(11);
  });

  it("refuses the S11.7.*_A4 initializer at selection instead of demoting it", async () => {
    const result = await compileHarnessBody(
      "if (-1 << 0 !== -1) { throw new Test262Error('#1: -1 << 0 === -1. Actual: ' + (-1 << 0)); }",
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleInit(result)?.code).toBe("operand-coercion-unsupported");
  });

  it("keeps a provable static `+` claimed", async () => {
    const result = await compile(
      [
        'export function s(): string { return "a" + "b"; }',
        "export function n(): number { return 1 + (2 << 1); }",
      ].join("\n"),
      { fileName: "issue-7066.ts", target: "standalone", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(outcomeOf(result, "s")?.irBodyEmitted).toBe(true);
    expect(outcomeOf(result, "n")?.irBodyEmitted).toBe(true);
  });
});
