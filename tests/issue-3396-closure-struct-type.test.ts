// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3396 — forward-reference let/const ref-cell type drift (closure-env family).
//
// Trigger: a closure that captures a `let`/`const` binding with a REF-typed
// initializer, constructed BEFORE the binding's declaration in source order
// (`var pf = function () { return x; }; let x = "o";` — the test262
// `scope-*-lex-open` probeBefore shape). The closure construction boxes the
// capture into a ref-cell local and re-aims `localMap[x]` at the CELL slot;
// the `let x = "o"` declaration's pre-hoisted-slot re-type block then resolved
// `existingIdx` through that re-aimed localMap and mutated the CELL slot's
// declared type to the VALUE type — so the already-emitted closure-construct
// `local.tee` and the box-aware init `struct.set` disagreed with the slot:
// `struct.set[0] expected (ref null <cell>), found local.get of type
// (ref null <value>)` — INVALID Wasm (module-level failure).
//
// Fix: the re-type block skips boxed-capture slots (variables.ts, mirroring
// the #3037 / #3097 arms' explicit `boxedCaptures` guards). The box slot keeps
// its ref-cell type; the box-aware `boxedForInitStore` write below it already
// handles the value store.

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Must be VALID wasm (the bucket signature was a validation failure) and
  // standalone-clean.
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, `leaked host imports: ${envImports.map((i) => i.name).join(", ")}`).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3396 forward-ref let/const ref-cell type drift", () => {
  it("2-line minimal repro compiles to valid Wasm", async () => {
    expect(
      await run(`export function test(): number { var pf: any = function () { return x; }; let x = "o"; return 1; }`),
    ).toBe(1);
  });

  it("closure reads the post-init value through the shared cell", async () => {
    expect(
      await run(`export function test(): number {
        var pf: any = function () { return x; };
        let x = "o";
        const got: any = pf();
        if (got === "o") return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("post-init mutation is visible through the cell", async () => {
    expect(
      await run(`export function test(): number {
        var pf: any = function () { return x; };
        let x = "o";
        x = "p";
        const got: any = pf();
        if (got === "p") return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("forward ARROW over a const OBJECT initializer", async () => {
    expect(
      await run(`export function test(): number {
        var pf: any = () => o;
        const o = { k: 7 };
        const got: any = pf();
        if (got.k === 7) return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("two forward closures share ONE cell (write in one, read in the other)", async () => {
    expect(
      await run(`export function test(): number {
        var pa: any = function () { return x; };
        var pb: any = function () { x = "z"; return x; };
        let x = "o";
        pb();
        const got: any = pa();
        if (got === "z") return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("GUARD: normal-order capture (closure AFTER decl) stays intact", async () => {
    expect(
      await run(`export function test(): number {
        let x = "o";
        var pf: any = function () { return x; };
        x = "q";
        const got: any = pf();
        if (got === "q") return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("GUARD: forward capture of a NUMBER let (was already valid) stays intact", async () => {
    expect(
      await run(`export function test(): number {
        var pf: any = function () { return n; };
        let n = 5;
        n = 6;
        const got: any = pf();
        if (got === 6) return 42;
        return 0;
      }`),
    ).toBe(42);
  });

  it("GUARD: var-decl re-type of a non-captured hoisted slot still applies", async () => {
    // The skipped re-type must be scoped to BOXED captures only — an ordinary
    // hoisted var with a more precise initializer type keeps the upgrade path.
    expect(
      await run(`export function test(): number {
        var a = [1, 2, 3];
        let s = 0;
        for (const v of a) s += v;
        return s;
      }`),
    ).toBe(6);
  });
});
