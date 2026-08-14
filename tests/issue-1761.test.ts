// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1761 — presize the string-build buffer from a static loop trip count.
 *
 * When a `let s = ""; for (let i = 0; i < BOUND; i++) s += <fixed-units>` loop's
 * final length is a provably runtime-known linear function of a loop-invariant
 * bound (`finalLen = BOUND * unitsPerIter`), the WasmGC i16 buffer is allocated
 * once at that length up front. This eliminates every doubling reallocation AND
 * lets the per-append `len+N > cap` cap-check / grow branch be omitted (the
 * capacity is proven sufficient for every append). See #1746 lever #3.
 *
 * These tests pin three things:
 *   1. Codegen shape — the presize fires (no `__str_buf_next_cap` grow call in
 *      the build loop) only when the final length is provably static; loops
 *      that break the proof keep the doubling grow path (no-presize fallback).
 *   2. Byte-for-byte parity — the presized buffer produces the identical string
 *      result as the JS reference across representative trip counts incl. 0, 1,
 *      and large n, including non-ASCII / surrogate-pair appends.
 *   3. Validity — the emitted binary instantiates.
 */
import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) The soundness boundary here — "a non-provable length must NOT
// presize" — is measured by COUNTING the doubling grow CALL. The IR inliner
// (default ON since the tuned-set flip) inlines that helper, so the count goes
// to zero while the grow path is still emitted: the assertion inverts and
// reports an unsound presize that did not happen. Pin the inliner off; this
// file's subject is the presize decision, not the call ABI under it.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

async function compileNative(source: string): Promise<{ wat: string; emittedWat: string; binary: Uint8Array }> {
  const result = await compile(source, { fileName: "t.js", target: "wasi", nativeStrings: true, emitWat: true });
  expect(result.success, `Compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  const mod = binaryen.readBinary(result.binary);
  const wat = mod.emitText();
  mod.dispose();
  return { wat, emittedWat: result.wat ?? "", binary: result.binary };
}

/**
 * Isolate one exported function's own body text within the module WAT.
 * Needed because `growCalls` must count grow calls WITHIN the function under
 * test, not module-wide: unrelated native-string runtime helpers (e.g. the
 * IR-only `__str_concat_owned`, #3744) also contain a static
 * `call $__str_buf_next_cap` in their own body, which would otherwise read
 * as a false "presize didn't fire" positive even though the tested function
 * never calls it.
 */
function exportedFuncWat(wat: string, exportName: string): string {
  const exportMatch = wat.match(new RegExp(`\\(export "${exportName}" \\(func (\\$[\\w.$]+)\\)\\)`));
  if (!exportMatch) throw new Error(`export "${exportName}" not found in WAT`);
  const funcRef = exportMatch[1]!.replace(/\$/, "\\$");
  const startMatch = new RegExp(`^ \\(func ${funcRef} `, "m").exec(wat);
  if (!startMatch) throw new Error(`func ${exportMatch[1]} body not found in WAT`);
  const rest = wat.slice(startMatch.index);
  const endMatch = /\n \)\n/.exec(rest);
  return endMatch ? rest.slice(0, endMatch.index + endMatch[0].length) : rest;
}

/** Count of `__str_buf_next_cap` grow calls in `exportName`'s own body — zero means the presize fired. */
function growCalls(wat: string, exportName = "run"): number {
  return (exportedFuncWat(wat, exportName).match(/call \$__str_buf_next_cap/g) || []).length;
}

function emittedFunctionWat(wat: string, functionName: string): string {
  const start = wat.indexOf(`(func $${functionName}`);
  const end = wat.indexOf("\n  (func ", start + 1);
  return wat.slice(start, end < 0 ? undefined : end);
}

async function instantiate(binary: Uint8Array): Promise<WebAssembly.Exports> {
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {
    wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
  });
  return inst.exports;
}

// The #1746 string-hash benchmark build loop: 3 fixed-length appends per
// iteration over a parameter bound `n`, so finalLen = 3n.
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

function jsStringHash(n: number): number {
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
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash | 0;
}

describe("#1761 — presize string-build buffer from static trip count", () => {
  it("fires on the string-hash build loop (no grow call) and matches JS across trip counts", async () => {
    const { wat, emittedWat, binary } = await compileNative(STRING_HASH_SOURCE);
    // The build loop's final length is provably 3*n → presize fires → the
    // doubling grow helper is gone from the module.
    expect(growCalls(wat), "presize must eliminate the doubling grow path").toBe(0);
    const emittedRun = emittedFunctionWat(emittedWat, "run");
    expect(
      (emittedRun.match(/\bref\.is_null\b/g) ?? []).length,
      "the hash loop condition must read the builder length local without materializing a string view",
    ).toBe(1);
    const mutableAlphabet = await compileNative(STRING_HASH_SOURCE.replace("const alphabet", "let alphabet"));
    const mutableRun = emittedFunctionWat(mutableAlphabet.emittedWat, "run");
    expect(
      (emittedRun.match(/\bref\.cast\b/g) ?? []).length - (mutableRun.match(/\bref\.cast\b/g) ?? []).length,
      "the two const-literal alphabet.charAt appends must use the proven-flat cast path",
    ).toBe(2);

    const exports = await instantiate(binary);
    const run = exports.run as (n: number) => number;
    // Includes 0 (never-iterated → 0-length buffer), 1, and large n.
    for (const n of [0, 1, 2, 5, 33, 100, 1000, 5000]) {
      expect(run(n), `run(${n}) mismatch`).toBe(jsStringHash(n));
    }
  });

  it("presizes a literal-bound loop and produces the exact length", async () => {
    // bound=5 literal, 3-char literal per iteration → finalLen = 15.
    const { wat, binary } = await compileNative(`
      export function run() {
        let s = "";
        for (let i = 0; i < 5; i++) { s += "abc"; }
        return s.length;
      }
    `);
    expect(growCalls(wat)).toBe(0);
    const exports = await instantiate(binary);
    expect((exports.run as () => number)()).toBe(15);
  });

  it("preserves non-ASCII / surrogate-pair appends byte-for-byte under presize", async () => {
    // Single-char charAt over a static alphabet with an astral code point.
    // charAt is code-unit-indexed, so a verbatim i16 copy must match JS.
    const src = `
      export function build(n) {
        const alphabet = "abcde\\u00e9\\uD83D\\uDE00z"; // 'abcdeé' + 😀 + 'z'
        let s = "";
        for (let i = 0; i < n; i++) {
          s += alphabet.charAt(i % 9);
        }
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h | 0;
      }
    `;
    const { wat, binary } = await compileNative(src);
    // i % 9 is a fixed-length (1-unit) charAt → presize fires.
    expect(growCalls(wat, "build")).toBe(0);
    const exports = await instantiate(binary);
    const build = exports.build as (n: number) => number;

    const alphabet = "abcdeé😀z";
    function jsBuild(n: number): number {
      let s = "";
      for (let i = 0; i < n; i++) s += alphabet.charAt(i % 9);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h | 0;
    }
    for (const n of [0, 1, 9, 33, 100]) {
      expect(build(n), `build(${n}) mismatch`).toBe(jsBuild(n));
    }
  });

  describe("no-presize fallback — soundness boundary keeps the doubling grow path", () => {
    // Each of these breaks the static-length proof; the builder must fall back
    // to the doubling buffer (grow path retained) and stay correct.
    const cases: { name: string; src: string }[] = [
      {
        name: "variable-length append (s += i)",
        src: `export function run(n){ let s=""; for(let i=0;i<n;i++){ s += i; } return s.length; }`,
      },
      {
        name: "early break",
        src: `export function run(n){ let s=""; for(let i=0;i<n;i++){ if(i>5)break; s+="x"; } return s.length; }`,
      },
      {
        name: "conditional append",
        src: `export function run(n){ let s=""; for(let i=0;i<n;i++){ if(i%2===0){ s+="x"; } } return s.length; }`,
      },
      {
        name: "<= bound (non-canonical trip count)",
        src: `export function run(n){ let s=""; for(let i=0;i<=n;i++){ s+="x"; } return s.length; }`,
      },
      {
        name: "continue in body",
        src: `export function run(n){ let s=""; for(let i=0;i<n;i++){ if(i%2)continue; s+="x"; } return s.length; }`,
      },
    ];

    for (const { name, src } of cases) {
      it(`keeps the grow path: ${name}`, async () => {
        const { wat } = await compileNative(src);
        expect(growCalls(wat), "non-provable length must NOT presize").toBeGreaterThan(0);
      });
    }
  });

  it("never-iterated presized builder yields an empty string (bound <= 0)", async () => {
    // A negative/zero bound runs the loop 0 times; the presized buffer is
    // clamped to length 0 and reads back empty.
    const { binary } = await compileNative(`
      export function run(n) { let s = ""; for (let i = 0; i < n; i++) { s += "x"; } return s.length; }
    `);
    const exports = await instantiate(binary);
    const run = exports.run as (n: number) => number;
    expect(run(0)).toBe(0);
    expect(run(-5)).toBe(0);
    expect(run(7)).toBe(7);
  });
});
