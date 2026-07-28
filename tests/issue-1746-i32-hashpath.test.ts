// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1746 — i32-typed string-hash hot path.
//
// The hot loop `hash = (hash * 31 + text.charCodeAt(i)) | 0` was previously
// lowered through f64: each iteration ran `f64.convert_i32_s` on the operands,
// an `f64.mul` / `f64.add`, then an expensive ToInt32 emulation
// (`f64.trunc` + div/floor/mul/sub by 2^32 + `i32.trunc_sat_f64_u`). That is
// ~60k f64↔i32 conversions for the benchmark's 20k iterations.
//
// The fix teaches `isI32PureExpr` that `<string>.charCodeAt(idx)` is an
// i32-pure *leaf* (it always returns a u16 code unit in [0, 65535]), and adds
// a self-contained i32 emitter so the whole proven-pure subtree stays in i32
// regardless of nesting depth. Under the enclosing `| 0` (ToInt32) the i32
// wrap is bit-for-bit identical to the f64-then-ToInt32 result — `hash` is i32
// so `hash*31` is f64-exact (< 2^53) and `i32.mul` wraps the same way ToInt32
// would. This collapses the loop body to `i32.mul` + `i32.add`, matching the
// V8 TurboFan fingerprint (176 integer ops / 8 float / 0 SIMD) for the hot
// loop. See ADR 0016 (differential codegen analysis) and
// plan/issues/1746-string-hash-warm-v8-gap-i32-hashpath-linmem.md.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const STRING_HASH_SRC = `
/** @param {number} n @returns {number} */
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

// JS reference, identical semantics to STRING_HASH_SRC.
function runRef(n: number): number {
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

async function compileAndRun(
  src: string,
  opts: Record<string, unknown>,
): Promise<{ exports: Record<string, CallableFunction>; wat: string }> {
  const r = await compile(src, { fileName: "string-hash.js", ...opts });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(r.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${r.wat}`);
  }
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exportsObj = instance.exports as unknown as Record<string, CallableFunction>;
  // setExports may exist on the runtime result (host-string back-references).
  const maybeSet = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (maybeSet) maybeSet(exportsObj);
  return { exports: exportsObj, wat: r.wat };
}

describe("#1746 i32-typed string-hash hot path", () => {
  const inputs = [0, 1, 2, 3, 5, 10, 20, 50, 100, 256, 1000, 5000, 20000];

  it("matches the JS reference in nativeStrings/WASI mode (benchmark config)", async () => {
    const { exports } = await compileAndRun(STRING_HASH_SRC, { target: "wasi", nativeStrings: true });
    for (const n of inputs) {
      expect(exports.run(n), `run(${n})`).toBe(runRef(n));
    }
  });

  it("matches the JS reference in JS-host (wasm:js-string) mode", async () => {
    const { exports } = await compileAndRun(STRING_HASH_SRC, {});
    for (const n of inputs) {
      expect(exports.run(n), `run(${n})`).toBe(runRef(n));
    }
  });

  it("lowers the hash accumulator without the f64 ToInt32 dance", async () => {
    // (#3744) This is specifically a legacy-codegen assertion (the #1746
    // i32-pure-leaf lowering in src/codegen/binary-ops.ts) — pin
    // experimentalIR: false so it stays independent of whichever backend the
    // default IR selector happens to claim STRING_HASH_SRC's shape with.
    // IR's own arithmetic lowering for this shape is tracked separately
    // (#3741 — IR lacks legacy's i32-loop-accumulator promotion).
    const { wat } = await compileAndRun(STRING_HASH_SRC, {
      target: "wasi",
      nativeStrings: true,
      experimentalIR: false,
    });
    // Isolate the second loop (the hash loop) — it starts after the build
    // loop's text assembly. The whole `run` body should no longer contain the
    // ToInt32-by-2^32 modulo emulation that the old f64 accumulator needed.
    const runStart = wat.indexOf("(func $run");
    const runEnd = wat.indexOf("(func ", runStart + 1);
    const runBody = wat.slice(runStart, runEnd === -1 ? undefined : runEnd);
    // The 2^32 constant is the tell-tale of the f64 ToInt32 emulation.
    expect(runBody).not.toContain("4294967296");
    // The accumulator multiply must be native i32, not f64.
    expect(runBody).toContain("i32.mul");
  });

  it("preserves ToInt32 wrap for large multiplications (soundness guard)", async () => {
    // `(x * 0x7FFFFFFF) | 0` must NOT use the unsafe i32.mul fast path when the
    // true product can exceed 2^53 (the f64-exactness precondition fails). The
    // i32-pure predicate only fires the multiply arm when a small-literal
    // operand (|n| < 2^21) bounds the product. 0x7FFFFFFF is not small, so this
    // exercises the f64 path and must still match JS semantics exactly.
    const src = `
      export function f(x: number): number {
        return (x * 2147483647 + 1) | 0;
      }
    `;
    const { exports } = await compileAndRun(src, { fileName: "t.ts" });
    const ref = (x: number) => (x * 2147483647 + 1) | 0;
    for (const x of [0, 1, 2, 3, 1000, 65535, 0x10000, 0x7fffffff]) {
      expect(exports.f(x), `f(${x})`).toBe(ref(x));
    }
  });

  it("keeps charCodeAt's own value identical whether arithmetic is i32 or f64", async () => {
    // A bare `s.charCodeAt(i)` (no enclosing | 0) and one inside `| 0` must both
    // report the same code unit — the i32-pure leaf doesn't change the value.
    const src = `
      export function bare(i: number): number {
        const s = "Az09";
        return s.charCodeAt(i);
      }
      export function wrapped(i: number): number {
        const s = "Az09";
        return (s.charCodeAt(i) * 1) | 0;
      }
    `;
    const { exports } = await compileAndRun(src, { fileName: "t.ts", target: "wasi", nativeStrings: true });
    const s = "Az09";
    for (let i = 0; i < s.length; i++) {
      expect(exports.bare(i), `bare(${i})`).toBe(s.charCodeAt(i));
      expect(exports.wrapped(i), `wrapped(${i})`).toBe(s.charCodeAt(i));
    }
  });
});
