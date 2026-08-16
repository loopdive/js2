// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4486 — the prepared-vector registry's element-kind refusal is a CAPABILITY
// GAP, not a producer-promise violation, and must demote to the legacy body.
//
// `prepareIrVectorSupport` (src/ir/prepared-vector-support.ts) resolves each
// logical `vec<T>` to a physical layout and accepts exactly three element
// ValTypes: f64, i32, externref. Anything else was refused with a plain
// `Error`, so `classifyIrFailure` bucketed it as the untyped
// `unexpected-internal-throw` INVARIANT — and an invariant is a hard compile
// error, even though the legacy body for the unit had already been emitted.
//
// The shape that reaches this arm is a NESTED vec. `string[]` resolves to a
// physical `ref_null $vec_externref` — a `val` — so `resolvePositionType`
// accepts `string[][]` and the unit IS claimed; the logical type is then
// `vec<vec<externref>>`, which the registry refuses. Its `number[][]` and
// `boolean[][]` siblings never get that far: their inner array stays an
// `irVec`, which `resolvePositionType` rejects first, taking the soft #1921
// `type-resolution-unsupported`@resolve path. Two nestings, two verdicts, one
// underlying gap — this file pins that they now agree.
//
// Scope note: this is the CLASSIFICATION only. The nested-vec carrier is still
// unrepresentable in the IR (`irBodyEmitted: false` throughout); adopting it is
// #4470's blocked scope.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function outcomeForF(source: string) {
  const r = await compile(source, { fileName: "issue-4486.ts", experimentalIR: true, trackIrOutcomes: true });
  return { result: r, outcome: r.irOutcomes?.find((o) => o.displayName === "f") };
}

async function runMain(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "issue-4486.ts", experimentalIR: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).main!();
}

// ---------------------------------------------------------------------------
// A. The classification itself.
// ---------------------------------------------------------------------------

describe("#4486 A — nested-vec refusal is a typed demote, not an invariant", () => {
  it("the identifier-head for-of over string[][] compiles and demotes", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(rows: string[][]): number {
        let n = 0;
        for (const r of rows) { n = n + 1; }
        return n;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      stage: "resolve",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
    expect(String((outcome as { detail?: string }).detail)).toContain("prepared vec element");
  });

  // The point of the fix: every nesting withdraws the claim the SAME way. The
  // `string[][]` row is the one that used to be an invariant; the others are
  // the controls that were already soft, and they must not move.
  const NESTINGS: Array<{ name: string; type: string }> = [
    // Reached the registry arm and HARD-FAILED before this fix (measured: 6/15
    // probe shapes). `Uint8Array[]` is the one that is not a nested plain
    // array — its element is a `vec<f64>` carrier, so the defect was never
    // specific to `vec<externref>`.
    { name: "string[][]", type: "string[][]" },
    { name: "Array<Array<string>>", type: "Array<Array<string>>" },
    { name: "string[][][]", type: "string[][][]" },
    { name: "any[][]", type: "any[][]" },
    { name: "unknown[][]", type: "unknown[][]" },
    { name: "Uint8Array[]", type: "Uint8Array[]" },
    // Already soft before the fix — they are refused a layer earlier, in
    // `resolvePositionType`. Pinned so the two paths cannot drift apart again.
    { name: "number[][]", type: "number[][]" },
    { name: "boolean[][]", type: "boolean[][]" },
    { name: "{ v: number }[][]", type: "{ v: number }[][]" },
  ];

  for (const c of NESTINGS) {
    it(`${c.name} withdraws as unsupported/type-resolution-unsupported@resolve`, async () => {
      const { result, outcome } = await outcomeForF(`
        function f(rows: ${c.type}): number {
          let n = 0;
          for (const r of rows) { n = n + 1; }
          return n;
        }
        export function main(): number { return 0; }
      `);
      expect(result.success).toBe(true);
      expect(outcome).toMatchObject({
        kind: "unsupported",
        code: "type-resolution-unsupported",
        stage: "resolve",
        irBodyEmitted: false,
        legacyBodyEmitted: true,
      });
    });
  }

  it("a FLAT string[] still emits an IR body (the fix does not widen the refusal)", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(xs: string[]): number {
        let n = 0;
        for (const x of xs) { n = n + 1; }
        return n;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });
});

// ---------------------------------------------------------------------------
// B. The legacy body the demote falls back to actually works.
//
// A demote is only correct if the retained body is right. Every expectation
// below is the value node produces for the same source.
// ---------------------------------------------------------------------------

describe("#4486 B — the retained legacy body computes the node answer", () => {
  it("counts rows", async () => {
    expect(
      await runMain(`
        function f(rows: string[][]): number { let n = 0; for (const r of rows) { n = n + 1; } return n; }
        export function main(): number {
          const rows: string[][] = [["a", "b"], ["c"], ["d", "e", "f"]];
          return f(rows);
        }
      `),
    ).toBe(3);
  });

  it("sums inner lengths", async () => {
    expect(
      await runMain(`
        function f(rows: string[][]): number { let n = 0; for (const r of rows) { n = n + r.length; } return n; }
        export function main(): number {
          const rows: string[][] = [["a", "b"], ["c"], ["d", "e", "f"]];
          return f(rows);
        }
      `),
    ).toBe(6);
  });

  it("walks both levels and concatenates", async () => {
    expect(
      await runMain(`
        function f(rows: string[][]): string {
          let s = "";
          for (const r of rows) { for (const c of r) { s = s + c; } }
          return s;
        }
        export function main(): string {
          const rows: string[][] = [["a", "b"], ["c"], ["d", "e"]];
          return f(rows);
        }
      `),
    ).toBe("abcde");
  });

  it("reads through the nested vec by index", async () => {
    expect(
      await runMain(`
        function f(rows: string[][]): string { return rows[1][0]; }
        export function main(): string {
          const rows: string[][] = [["a", "b"], ["c", "d"]];
          return f(rows);
        }
      `),
    ).toBe("c");
  });

  it("handles an empty outer array", async () => {
    expect(
      await runMain(`
        function f(rows: string[][]): number { let n = 0; for (const r of rows) { n = n + 1; } return n; }
        export function main(): number {
          const rows: string[][] = [];
          return f(rows);
        }
      `),
    ).toBe(0);
  });
});
