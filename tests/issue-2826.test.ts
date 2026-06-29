// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2826 (carved from #2818, parent #2669) — Bug C, CPS-capture half: a
 * block-scoped `let`/`const` IMMUTABLY captured by a hoisted async/generator
 * function declaration read the stale pre-hoisted slot (0/null), not the
 * captured value.
 *
 * Root cause: #2820's producer-side slot reuse deliberately SKIPS the reuse
 * when any CPS (async/generator) function captures the name (collapsing the
 * duplicate slot perturbs the for-await-of continuation state machine — 43
 * regressions). That left the immutable CPS capture pinned to the never-written
 * pre-hoisted slot A while `let s` stored into a fresh slot B.
 *
 * Fix (`variables.ts`, Design 1A): keep both slots (B is the real storage) and
 * re-point the recorded capture metadata `outerLocalIdx` from A to B for
 * IMMUTABLE captures only — mutable boxed captures already thread correctly and
 * are exactly the 43-regression class. Producer slot layout unchanged.
 */

async function run<T>(source: string, exp = "test"): Promise<T> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool) as unknown as {
    importObject?: WebAssembly.Imports;
    setExports?: (e: WebAssembly.Exports) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    (imports.importObject ?? imports) as WebAssembly.Imports,
  );
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return (await (instance.exports as Record<string, () => unknown>)[exp]!()) as T;
}

describe("#2826 Bug C — block-let immutably captured by a hoisted async/generator decl", () => {
  it("block async capturer reads the let (numeric), not 0", async () => {
    expect(
      await run<number>(
        `export async function test(): Promise<number> {
           { let s = 42; async function f(): Promise<number> { return s; } return await f(); }
         }`,
      ),
    ).toBe(42);
  });

  it("block generator capturer reads the let (numeric), not 0", async () => {
    expect(
      await run<number>(
        `export function test(): number {
           { let s = 42; function* g(): Generator<number> { yield s; } return g().next().value; }
         }`,
      ),
    ).toBe(42);
  });

  it("block async capturer reads a captured STRING", async () => {
    expect(
      await run<string>(
        `export async function test(): Promise<string> {
           { let s = "outer"; async function f(): Promise<string> { return s; } return await f(); }
         }`,
      ),
    ).toBe("outer");
  });

  it("block generator capturer reads a captured STRING", async () => {
    expect(
      await run<string>(
        `export function test(): string {
           { let s = "gx"; function* g(): Generator<string> { yield s; } return g().next().value; }
         }`,
      ),
    ).toBe("gx");
  });

  it("mixed plain + CPS capturer of the same block-let: both read the captured value", async () => {
    expect(
      await run<number>(
        `export async function test(): Promise<number> {
           { let s = 42;
             function p(): number { return s; }
             async function a(): Promise<number> { return s; }
             return p() + await a(); }
         }`,
      ),
    ).toBe(84);
  });

  it("const variant: block async capturer reads the const", async () => {
    expect(
      await run<number>(
        `export async function test(): Promise<number> {
           { const s = 9; async function f(): Promise<number> { return s; } return await f(); }
         }`,
      ),
    ).toBe(9);
  });

  // --- controls: must remain correct (no regression) ---

  it("control: fn-scope async capture still returns the value", async () => {
    expect(
      await run<number>(
        `export async function test(): Promise<number> {
           let s = 42; async function f(): Promise<number> { return s; } return await f();
         }`,
      ),
    ).toBe(42);
  });

  it("control: fn-scope generator capture still returns the value", async () => {
    expect(
      await run<number>(
        `export function test(): number {
           let s = 42; function* g(): Generator<number> { yield s; } return g().next().value;
         }`,
      ),
    ).toBe(42);
  });

  it("control: plain (non-CPS) block capture still returns the value (#2820 path)", async () => {
    expect(
      await run<number>(
        `export function test(): number {
           { let s = 7; function f(): number { return s; } return f(); }
         }`,
      ),
    ).toBe(7);
  });
});
