// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3521 R2-T1 (c) — the telemetry moves no compiled byte and touches no other
// row shape.
//
// Its own file for the same reason the shapes suite is: a vitest fork has
// 512 MB (`vitest.config.ts:5`) and the six-lane byte matrix below is 24
// compiles. The two claims it pins are the whole "zero conformance change by
// design" argument of this slice:
//
//   * only compile-twice function rows carry the field — a `(1,0,1)` prepared
//     row and a `(1,1,0)` direct-only row must stay exactly as they were;
//   * a compile is byte-identical whether or not outcomes are tracked, in
//     every lane, so nothing about the recorder can reach the emitter.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { compile, type CompileOptions, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { r2WithdrawalDefect, r2WithdrawalOf } from "../src/ir/r2-withdrawal.js";

// Register the low-level codegen delegates used by the compile paths below.
import "../src/codegen/expressions.js";

// Drop each compile's `ts.Program` before the next one builds another; forks
// already run with `--expose-gc` (`vitest.config.ts:68`).
afterEach(() => {
  (globalThis as { gc?: () => void }).gc?.();
});

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing outcome for ${name}`);
  return observed;
}

async function tracked(source: string, fileName: string, options: CompileOptions = {}): Promise<CompileResult> {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

// ── (c) neutrality ──────────────────────────────────────────────────────────

const NEUTRALITY_LANES: readonly (readonly [string, CompileOptions])[] = [
  ["host", {}],
  ["fast", { fast: true }],
  ["fast-hostStr", { fast: true, nativeStrings: false }],
  ["native", { nativeStrings: true }],
  ["standalone", { target: "standalone" }],
  ["wasi", { target: "wasi" }],
];

describe("#3521 R2 withdrawal telemetry — (c) neutrality", () => {
  it("attaches nothing to rows that are not compile-twice", async () => {
    const prepared = await tracked(
      "export function add(a: number, b: number): number { return a + b; }",
      "r2-neutral-prepared.ts",
    );
    const addRow = outcome(prepared, "add");
    expect([addRow.directBodyEmissions, addRow.irBodyEmissions]).toEqual([0, 1]);
    expect(r2WithdrawalOf(addRow)).toBeUndefined();

    const directOnly = await tracked(
      "export function withDefault(a: number, b: number = 2): number { return a + b; }",
      "r2-neutral-direct.ts",
    );
    const defaultRow = outcome(directOnly, "withDefault");
    expect([defaultRow.directBodyEmissions, defaultRow.irBodyEmissions]).toEqual([1, 0]);
    expect(r2WithdrawalOf(defaultRow)).toBeUndefined();

    // And no row anywhere in either compile carries a defect.
    for (const result of [prepared, directOnly]) {
      for (const observed of result.irOutcomes ?? []) expect(r2WithdrawalDefect(observed)).toBeUndefined();
    }
  });

  it("does not move a compiled byte in any lane, tracked or not", async () => {
    const sources: readonly (readonly [string, string])[] = [
      ["scalar-add", "export function add(a: number, b: number): number { return a + b; }"],
      [
        "async",
        "async function inner(): Promise<number> { return 1; }\nexport async function outer(): Promise<number> { return (await inner()) + 1; }",
      ],
    ];
    // Each cell is reduced to a hash and a boolean immediately: the fork's heap
    // is 512 MB (`vitest.config.ts:5`) and 24 retained `CompileResult`s do not
    // fit in it.
    async function cell(source: string, fileName: string, options: CompileOptions): Promise<string> {
      const result = await compile(source, { fileName, ...options });
      const digest = `${result.success}:${createHash("sha256").update(result.binary).digest("hex")}`;
      (globalThis as { gc?: () => void }).gc?.();
      return digest;
    }
    for (const [label, source] of sources) {
      for (const [lane, options] of NEUTRALITY_LANES) {
        const on = await cell(source, `${label}.ts`, { trackIrOutcomes: true, ...options });
        const off = await cell(source, `${label}.ts`, options);
        expect(on, `${label}/${lane} is not byte-identical with outcome tracking on`).toBe(off);
      }
    }
  }, 120_000);
});
