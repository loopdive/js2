import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * `Array.from(set)` in `--target standalone` previously emitted INVALID Wasm
 * ("not enough arguments on the stack for struct.new").
 *
 * Root cause (`src/codegen/expressions/calls.ts`, the `Array.from` handler): a
 * `Set` lowers to a `ref $Map` struct whose field layout is NOT a `__vec`
 * (field 0 is not a length; field 1 is the entries bucket array). The
 * `Array.from` array-copy fast path guards on `resolveArrayInfo`, which is
 * purely STRUCTURAL — it matches any struct with a `ref array` field[1] — so it
 * FALSELY treated the Set struct as a `__vec`, did `struct.get 0/1` on it, then
 * `struct.new <vecTypeIdx>` with a mismatched field arity → the crash. (The
 * generic `__iterator` native-drain fallback instead hard-casts the subject to a
 * `__vec` → `illegal cast` trap at runtime for a non-vec Set.)
 *
 * Fix: route `Array.from(set)` through the SAME `emitCollectionIteratorVec`
 * driver the `[...set]` spread (#42) and `.values()` paths use — a Set yields its
 * values (§23.1.4.1 / §24.2.3) as a canonical externref vec. Non-array builtin
 * collections (Set the driver declined, Map, WeakSet, WeakMap) are also rejected
 * from the structural array-copy fast path so they cannot trigger the struct.new
 * crash.
 *
 * Validated below via the `const a = Array.from(s); …` form (assign-then-use),
 * which is the dominant real-world usage and is fully correct. (The chained
 * inline form `Array.from(s).length` reads the length through a separate
 * property-access result-type path that does not yet recognise the externref vec
 * result; tracked as a follow-up. `Array.from(map)` entry-pair materialisation is
 * likewise a separate follow-up — it stays on the prior routing here and is no
 * worse than before: it was already invalid Wasm on the base.)
 */

async function standalone(body: string): Promise<{ result: number; envImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

describe("Array.from(Set) standalone — was invalid Wasm (struct.new arity)", () => {
  it("Array.from(set).length via a local", async () => {
    const { result, envImports } = await standalone(
      `const s = new Set<number>([1, 2, 3]); const a = Array.from(s); return a.length;`,
    );
    expect(result).toBe(3);
    expect(envImports).toEqual([]);
  });

  it("Array.from(set) sums its values via for-of", async () => {
    const { result } = await standalone(
      `const s = new Set<number>([1, 2, 3]); const a = Array.from(s); let t = 0; for (const v of a) t += v; return t;`,
    );
    expect(result).toBe(6);
  });

  it("Array.from(set) is indexable", async () => {
    const { result } = await standalone(
      `const s = new Set<number>([10, 20, 30]); const a = Array.from(s); return a[2];`,
    );
    expect(result).toBe(30);
  });

  it("Array.from(set) preserves Set de-duplication", async () => {
    const { result } = await standalone(
      `const s = new Set<number>([1, 1, 2, 3, 3]); const a = Array.from(s); return a.length;`,
    );
    expect(result).toBe(3);
  });

  it("Array.from(set) drives an indexed for-loop", async () => {
    const { result } = await standalone(
      `const s = new Set<number>([2, 4, 6]); const a = Array.from(s); let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t;`,
    );
    expect(result).toBe(12);
  });

  it("is host-import-free standalone", async () => {
    const { envImports } = await standalone(
      `const s = new Set<number>([1, 2, 3]); const a = Array.from(s); return a.length;`,
    );
    expect(envImports).toEqual([]);
  });

  // Regression guards — Array.from over genuine array / string must be unchanged.
  it("Array.from(array) regression", async () => {
    const { result } = await standalone(`const a = Array.from([5, 6, 7]); return a.length;`);
    expect(result).toBe(3);
  });

  it("Array.from(string) regression", async () => {
    const { result } = await standalone(`const a = Array.from("hello"); return a.length;`);
    expect(result).toBe(5);
  });
});
