// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7066 step 1 — a `+` the selector claims is a `+` the builder lowers. A #5092
// mixed-primitive conditional lowers to the dynamic carrier, so it is a dynamic
// `+` operand (the dynamic add), not an unprovable one that demotes after the
// claim. The other mixed pairs are refused at selection by #7106 S0.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileHarnessBody, moduleInit } from "./helpers/harness-module-init.js";

const B = 'export function b(n: number): string { return "v" + (n > 0 ? "p" : 0); }';
const P = 'export function b(n: number, s: string): string { return "v" + (n > 0 ? s : 0); }';

function outcomeOf(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
}

async function runC(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-7066.ts", target: "standalone", trackIrOutcomes: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.c as () => number)();
}

describe("#7066 a mixed-primitive conditional is a dynamic `+` operand", () => {
  for (const target of ["gc", "standalone", "wasi"] as const) {
    for (const [name, source] of [
      ["the repro", B],
      ["a string-parameter arm", P],
    ] as const) {
      it(`lowers ${name} without a caller on ${target}`, async () => {
        const result = await compile(source, {
          fileName: "issue-7066.ts",
          trackIrOutcomes: true,
          ...(target === "gc" ? {} : { target }),
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(outcomeOf(result, "b")?.irBodyEmitted).toBe(true);
      });
    }
  }

  it("answers as node does", async () => {
    // node: b(1) === "vp", b(-1) === "v0".
    expect(
      await runC(`${B}\nexport function c(): number { return (b(1) === "vp" ? 1 : 0) + (b(-1) === "v0" ? 10 : 0); }`),
    ).toBe(11);
    // node: b(1, "q") === "vq", b(-1, "q") === "v0".
    expect(
      await runC(
        `${P}\nexport function c(): number { return (b(1, "q") === "vq" ? 1 : 0) + (b(-1, "q") === "v0" ? 10 : 0); }`,
      ),
    ).toBe(11);
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
