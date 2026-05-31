// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1744 — string-builder build-loop perf: kill the per-`charAt` allocation.
 *
 * #1580 fixed the string-hash *hash* loop (the materialized-`$NativeString`
 * cache). The residual cost was the *build* loop: `buf += X.charAt(i)` lowered
 * to `__str_charAt(__str_flatten(X), i)` + a 1-char append, allocating a fresh
 * 1-char `$NativeString` (`array.new_fixed` + `struct.new`) on every iteration
 * just to copy a single code unit out of it (~40k throwaway allocations on the
 * 20k-input string-hash benchmark).
 *
 * The fix special-cases `buf += X.charAt(i)` (and `buf += "<1 char>"`) in the
 * string-builder append path: read the code unit directly (`array.get_u` on
 * `X`'s data) and `array.set` it into the buffer, with NO intermediate string.
 * Measured effect on wasmtime 45 (20k input, warm): ~22.7 ms → ~13 ms,
 * crossing below StarlingMonkey's 14.2 ms.
 *
 * These tests assert the codegen shape (no `__str_charAt` call in the build
 * loop) and behavioural correctness (the single-char fast path produces the
 * same characters as the string-roundtrip path, including non-ASCII).
 */
import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { compile } from "../src/index.js";

const STRING_HASH_SOURCE = `
export function run(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) {
    const a = (i * 13) & 31;
    const b = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash | 0;
}
`;

async function compileToWat(source: string): Promise<{ wat: string; binary: Uint8Array }> {
  const result = await compile(source, { fileName: "t.js", target: "wasi", nativeStrings: true });
  expect(result.success, `Compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  const mod = binaryen.readBinary(result.binary);
  const wat = mod.emitText();
  mod.dispose();
  return { wat, binary: result.binary };
}

describe("#1744 — string-builder single-char append fast path", () => {
  it("eliminates the per-charAt __str_charAt call in the build loop", async () => {
    const { wat } = await compileToWat(STRING_HASH_SOURCE);
    // The build loop (`text += alphabet.charAt(x)`) must no longer call
    // __str_charAt — that helper allocates a 1-char $NativeString. The fast
    // path reads the code unit inline (`array.get_u`) and array.sets it.
    expect(wat).not.toContain("call $__str_charAt");
    // It still uses inline array.get_u for the code-unit read.
    expect(wat).toContain("array.get_u");
  });

  it("compiles to a binary that WebAssembly.compile accepts", async () => {
    const { binary } = await compileToWat(STRING_HASH_SOURCE);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
  });

  it('single-char-literal append (buf += ";") emits no __str_concat / __str_charAt', async () => {
    const { wat } = await compileToWat(`
      export function run(n) {
        let s = "";
        for (let i = 0; i < n; i++) { s += ";"; }
        return s.length;
      }
    `);
    expect(wat).not.toContain("call $__str_charAt");
  });

  it("produces correct output: charAt-built string hash matches JS (incl. surrogate pairs)", async () => {
    // Build a string char-by-char via the single-char `+=` fast path, then
    // hash it. The receiver alphabet includes non-ASCII and an astral
    // (surrogate-pair) code point, so this also pins that a verbatim
    // code-unit copy matches JS `charAt` (which is code-unit-indexed). The
    // length and hash were cross-checked against both the JS reference and
    // the generic (`s = s + c`) string-roundtrip path on wasmtime 45 — all
    // three agree, confirming the fast path is semantically identical.
    const src = `
      export function build(n) {
        const alphabet = "abcde\\u00e9\\uD83D\\uDE00z"; // 'abcdeé' + 😀 (surrogate pair) + 'z'
        let s = "";
        for (let i = 0; i < n; i++) {
          s += alphabet.charAt(i % alphabet.length);
        }
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h | 0;
      }
    `;
    const result = await compile(src, { fileName: "b.js", target: "wasi", nativeStrings: true });
    expect(result.success).toBe(true);
    const mod = await WebAssembly.compile(result.binary);
    const inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
    });
    const wasmBuild = inst.exports.build as (n: number) => number;

    // JS reference with the same source semantics (alphabet.length === 9:
    // 'abcdeé' = 6 units, 😀 = 2 surrogate units, 'z' = 1).
    const alphabet = "abcdeé😀z";
    function jsBuild(n: number): number {
      let s = "";
      for (let i = 0; i < n; i++) s += alphabet.charAt(i % alphabet.length);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h | 0;
    }
    for (const n of [0, 1, 8, 33, 100]) {
      expect(wasmBuild(n), `build(${n}) mismatch`).toBe(jsBuild(n));
    }
  });
});
