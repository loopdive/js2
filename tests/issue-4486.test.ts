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
// Scope note: #4486 was the CLASSIFICATION only — the nested-vec carrier was
// still unrepresentable, so section A pinned `irBodyEmitted: false` throughout
// and said so explicitly ("the assertion that flips when #4470 adopts
// nested-vec carriers"). #5166 built the carrier on 2026-08-29, so section A
// now pins the third and final state: these shapes EMIT. What #4486 itself
// owns is unchanged and still load-bearing — the refusal that remains (an
// object-typed element) is a typed `unsupported` demote, never an invariant,
// and section B still proves the fallback body is correct for every shape
// that does demote.

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
  it("the identifier-head for-of over string[][] compiles — and now emits (#5166)", async () => {
    // The #4486 repro. It went invariant (hard CE) -> typed demote (#4486) ->
    // emitted (#5166). The load-bearing part of #4486 survives either way:
    // whatever the registry cannot carry must withdraw the claim as a typed
    // `unsupported`, so a unit with a perfectly good legacy body never takes
    // the program down. The shape that still exercises that is the
    // object-element nesting below.
    const { result, outcome } = await outcomeForF(`
      function f(rows: string[][]): number {
        let n = 0;
        for (const r of rows) { n = n + 1; }
        return n;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  // Every nesting the two layers can carry now EMITS, and it is the same set
  // that used to split into "hard-failed here" and "withdrew a layer earlier"
  // — one carrier, one verdict. `Uint8Array[]` matters as it did before: it is
  // not a nested plain array (its element is a `vec<f64>` carrier), so neither
  // the defect nor the fix was ever specific to `vec<externref>`.
  const CARRIED_NESTINGS: Array<{ name: string; type: string }> = [
    // Reached the registry arm and HARD-FAILED before #4486; demoted after it.
    { name: "string[][]", type: "string[][]" },
    { name: "Array<Array<string>>", type: "Array<Array<string>>" },
    { name: "string[][][]", type: "string[][][]" },
    { name: "any[][]", type: "any[][]" },
    { name: "unknown[][]", type: "unknown[][]" },
    { name: "Uint8Array[]", type: "Uint8Array[]" },
    // Refused a layer earlier, in `resolvePositionType`, and soft throughout.
    { name: "number[][]", type: "number[][]" },
    { name: "boolean[][]", type: "boolean[][]" },
  ];

  for (const c of CARRIED_NESTINGS) {
    it(`${c.name} emits an IR body (#5166 carrier)`, async () => {
      const { result, outcome } = await outcomeForF(`
        function f(rows: ${c.type}): number {
          let n = 0;
          for (const r of rows) { n = n + 1; }
          return n;
        }
        export function main(): number { return 0; }
      `);
      expect(result.success).toBe(true);
      expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    });
  }

  // The #4486 contract itself, on a shape the carrier deliberately does NOT
  // cover: an OBJECT element type is out of #5166's scope (tuple / boxed-any /
  // object elements are #2379 territory), and it must still withdraw as a
  // typed capability gap rather than an invariant.
  it("{ v: number }[][] still withdraws as unsupported/type-resolution-unsupported@resolve", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(rows: { v: number }[][]): number {
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
