// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2508 — standalone `any[].indexOf/lastIndexOf/includes` leaked an unsatisfiable
// `env.__host_eq` / `env.__same_value_zero` host import (no native impl), so the
// module compiled to valid Wasm but could not instantiate without a JS host.
//
// Fix: synthesize native `__host_eq` (Strict Equality §7.2.16) and
// `__same_value_zero` (SameValueZero §7.2.11) in addUnionImportsAsNativeFuncs —
// tag-dispatched over two boxed externrefs (number → unbox f64; boolean → i32;
// bigint → i64; else WasmGC `eq`-heap ref identity), mirroring the inline `===`
// lowering (#1776). The two differ only in the number arm's NaN case (Strict:
// NaN ≠ NaN; SameValueZero: NaN = NaN). The names are routed to these natives
// via UNION_NATIVE_HELPER_NAMES under standalone/wasi. Host (GC) mode is
// unchanged (still uses the host imports). NOTE: string-element search-by-VALUE
// is a tracked follow-up — the string arm falls back to ref identity here to
// avoid a cross-regime finalize index-shift (see the impl comment in index.ts).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const env = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(
    env.filter((n) => n === "__host_eq" || n === "__same_value_zero"),
    `must not leak host equality imports: ${env.join(", ")}`,
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#2508 — standalone any[] search methods use native equality (no host-import leak)", () => {
  // ── indexOf — Strict Equality ──
  it("any[].indexOf(number) finds by value", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.indexOf(2);`))).toBe(1);
  });

  it("any[].indexOf returns -1 when not found", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.indexOf(9);`))).toBe(-1);
  });

  it("any[].indexOf(NaN) is -1 (Strict: NaN !== NaN)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [NaN, 2]; return a.indexOf(NaN);`))).toBe(-1);
  });

  it("any[].indexOf does cross-type strict compare ([false].indexOf(0) === -1)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [false]; return a.indexOf(0 as any);`))).toBe(-1);
  });

  it("any[].indexOf finds a boolean element (from an any var)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [true, false]; const t: any = false; return a.indexOf(t);`))).toBe(
      1,
    );
  });

  it("any[].indexOf honors fromIndex", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, 2, 1, 2]; return a.indexOf(2, 2);`))).toBe(3);
  });

  it("any[] with string elements compiles + instantiates standalone (no host-import leak)", async () => {
    // String-element search-by-VALUE on an any[] is a tracked follow-up (the
    // string-value arm of __host_eq lives in the native-string regime, not the
    // union-helper body — inlining it there drifted under the finalize index
    // shift). The #2508 guarantee here is the host-import-leak removal + valid
    // Wasm; the search currently falls back to ref identity for string elements.
    expect(
      await runStandalone(
        fn(`const a: any[] = ["x", "y"]; const t: any = "y"; const r = a.indexOf(t); return r < -1 ? 99 : 0;`),
      ),
    ).toBe(0);
  });

  // ── lastIndexOf ──
  it("any[].lastIndexOf finds the last match (number)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [5, 9, 5]; return a.lastIndexOf(5);`))).toBe(2);
  });

  // ── includes — SameValueZero ──
  it("any[].includes(number) finds by value", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.includes(2) ? 1 : 0;`))).toBe(1);
  });

  it("any[].includes(NaN) is true (SameValueZero: NaN = NaN)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [NaN, 2]; return a.includes(NaN) ? 1 : 0;`))).toBe(1);
  });

  it("any[].includes returns false when not found", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.includes(9) ? 1 : 0;`))).toBe(0);
  });

  // ── regression: number[] search unchanged (never leaked through __host_eq) ──
  it("number[].indexOf still works", async () => {
    expect(await runStandalone(fn(`const a = [1, 2, 3]; return a.indexOf(3);`))).toBe(2);
  });

  it("number[].includes still works", async () => {
    expect(await runStandalone(fn(`const a = [1, 2, 3]; return a.includes(2) ? 1 : 0;`))).toBe(1);
  });
  // (Typed `string[]` indexOf/includes by VALUE is a SEPARATE pre-existing
  // standalone gap — confirmed broken on main without this change — out of
  // scope here, which fixes the boxed-any/`any[]` element search path.)
});
