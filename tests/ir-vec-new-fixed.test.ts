// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1804 — IR `vec.new_fixed` array-literal construction.
//
// The IR Phase-1 path could READ vecs (vec.len/vec.get/forof.vec) but not
// CONSTRUCT them — `ArrayLiteralExpression` threw a clean fallback. This slice
// adds fixed-length, non-spread, non-sparse, same-typed array-literal
// construction via the new `vec.new_fixed` IR node (WasmGC lowering).
//
// Each construction case compiles under both legacy and IR and asserts the two
// produce the same return value (byte-level identity is covered by the
// equivalence suite; here we assert observable equality + that the IR path is
// actually exercised, proven by `array.new_fixed` appearing in the IR-compiled
// WAT). The fallback cases (spread / sparse / mixed-type / hintless-empty) must
// still compile and run via legacy without surfacing an IR error.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileRun(
  source: string,
  fn: string,
  args: number[],
  experimentalIR: boolean,
): Promise<{ value: unknown; wat: string }> {
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return { value: (f as (...a: number[]) => unknown)(...args), wat: r.wat };
}

/** Assert legacy and IR agree, and that the IR path actually built the vec. */
async function expectConstruction(source: string, fn: string, args: number[], expected: unknown): Promise<void> {
  const legacy = await compileRun(source, fn, args, false);
  const ir = await compileRun(source, fn, args, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  // The IR path lowered vec.new_fixed → array.new_fixed (proof it was used,
  // not silently demoted to legacy).
  expect(ir.wat.includes("array.new_fixed"), "IR WAT contains array.new_fixed").toBe(true);
}

/** Assert a fallback shape still compiles+runs (via legacy) without an IR error. */
async function expectFallbackRuns(source: string, fn: string, args: number[], expected: unknown): Promise<void> {
  const ir = await compileRun(source, fn, args, true);
  expect(ir.value).toStrictEqual(expected);
}

describe("#1804 — IR vec.new_fixed array-literal construction", () => {
  it("(1) number literal — element type inferred from elements", async () => {
    await expectConstruction(
      `export function sum(): number { const a = [1, 2, 3]; let t = 0; for (const x of a) { t += x; } return t; }`,
      "sum",
      [],
      6,
    );
  });

  it("(2) empty literal — element type from the declared hint", async () => {
    // The empty `[]` path depends on the hint resolving to a vec ref so the
    // element type can be recovered with zero elements. When the hint resolves
    // (full type propagation) the IR builds it; when it doesn't, the IR cleanly
    // falls back to legacy. Either way the observable result must be 0, so we
    // assert value-equality across both backends without requiring the IR path
    // specifically (the non-empty cases prove vec.new_fixed is exercised).
    const legacy = await compileRun(
      `export function emptyLen(): number { const a: number[] = []; return a.length; }`,
      "emptyLen",
      [],
      false,
    );
    const ir = await compileRun(
      `export function emptyLen(): number { const a: number[] = []; return a.length; }`,
      "emptyLen",
      [],
      true,
    );
    expect(legacy.value).toStrictEqual(0);
    expect(ir.value).toStrictEqual(legacy.value);
  });

  it("(4) f([1,2,3]) — call-graph closure keeps the callee claimed", async () => {
    await expectConstruction(
      `function f(xs: number[]): number { let t = 0; for (const x of xs) { t += x; } return t; }
       export function callArg(): number { return f([10, 20, 30]); }`,
      "callArg",
      [],
      60,
    );
  });

  it("(5) return [a, b] — element type from same-typed params, indexed read", async () => {
    await expectConstruction(
      `export function retIdx(a: number, b: number): number { const r = [a, b]; return r[0] + r[1]; }`,
      "retIdx",
      [4, 5],
      9,
    );
  });

  it("constructed vec round-trips through .length and vec.get", async () => {
    await expectConstruction(
      `export function midOfFive(): number { const a = [10, 20, 30, 40, 50]; return a[2] + a.length; }`,
      "midOfFive",
      [],
      35,
    );
  });

  // ── Fallback shapes (must stay legacy, still compile + run) ──────────────

  it("(6a) spread literal stays legacy and still runs", async () => {
    await expectFallbackRuns(
      `export function spread(): number { const base = [1, 2]; const a = [...base, 3]; let t = 0; for (const x of a) { t += x; } return t; }`,
      "spread",
      [],
      6,
    );
  });

  it("(6b) sparse literal stays legacy and still runs", async () => {
    await expectFallbackRuns(
      `export function sparse(): number { const a = [1, , 3]; return a.length; }`,
      "sparse",
      [],
      3,
    );
  });

  it("(6d) hintless empty literal stays legacy and still runs", async () => {
    // No declared element type and zero elements → the IR can't infer the
    // element type, so it cleanly falls back. Must still compile + run.
    await expectFallbackRuns(
      `export function hintlessEmpty(): number { const a = []; return a.length; }`,
      "hintlessEmpty",
      [],
      0,
    );
  });

  // #1804 regression guard (PR #1585 equivalence-gate FAIL): a constructed vec
  // read inside a C-style while/for loop fails SSA hygiene (the vec value isn't
  // threaded into the loop's cond/body blocks). The selector withholds the
  // claim when the function has such a loop, so it reverts to legacy and runs
  // correctly. (for-of works — different node. Non-loop vec reads work.)
  it("(6e) vec read inside a while loop stays legacy and runs correctly", async () => {
    await expectFallbackRuns(
      `export function whileSum(): number {
        let arr = [1, 2, 3, 4, 5];
        let sum = 0;
        let i = 0;
        while (i < arr.length) { sum += arr[i]; i++; }
        return sum;
      }`,
      "whileSum",
      [],
      15,
    );
  });

  it("(6f) vec read inside a C-style for loop stays legacy and runs correctly", async () => {
    await expectFallbackRuns(
      `export function forSum(): number {
        let arr = [10, 20, 30];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) { sum += arr[i]; }
        return sum;
      }`,
      "forSum",
      [],
      60,
    );
  });
});
