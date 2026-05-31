// #1670 — Atomics / typed-array arg cast must follow validation throw.
//
// PR #599 (fix(#1654)) added a native byte-buffer view path for
// `new TypedArray(arrayBuffer)`. The path emits an unconditional `ref.cast`
// to the native `i32_byte` vec. In JS-host mode an ArrayBuffer /
// SharedArrayBuffer is NOT lowered to that vec — `new SharedArrayBuffer(n)`
// has no native struct at all — so the cast trapped with `illegal cast`
// before any spec-required validation could run. This regressed 28
// `built-ins/Atomics/{wait,waitAsync,notify}/*` negative tests, all built on
// `new Int32Array(new SharedArrayBuffer(...))` and expecting RangeError /
// TypeError on bad index / non-integer / detached args.
//
// Fix: gate the native byte-buffer view path on no-JS-host mode (where the
// buffer IS the native i32_byte vec). #1654's WASI/standalone DataView and
// TypedArray validity work stays intact.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1670 Int32Array over SharedArrayBuffer must not trap on construction (JS-host)", () => {
  it("positive: new Int32Array(new SharedArrayBuffer(n)) constructs + indexes without illegal cast", async () => {
    // Before the fix this trapped with `illegal cast` at construction time.
    const ret = await compileAndRun(`
      const i32a = new Int32Array(new SharedArrayBuffer(16));
      i32a[0] = 42;
      i32a[1] = 7;
      export function test(): number { return i32a[0] + i32a[1]; }
    `);
    expect(ret).toBe(49);
  });

  it("negative shape: a guarded bad-index throw is reached (not pre-empted by an illegal-cast trap)", async () => {
    // Mirrors the Atomics negative tests: a RangeError-style throw on a bad
    // index must surface as a JS throw, not a wasm `illegal cast` trap. We
    // model the spec throw with an explicit guard so the test stays
    // host-runtime-agnostic; the regression was that construction trapped
    // *before* any such guard could run.
    const r = await compile(
      `
      const i32a = new Int32Array(new SharedArrayBuffer(16));
      i32a[0] = 5;
      export function test(idx: number): number {
        if (idx < 0) { throw new RangeError("bad index"); }
        return i32a[idx];
      }
    `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
    const test = (instance.exports as Record<string, (n: number) => number>).test;
    // valid index: no trap, no throw (construction must have succeeded)
    expect(test(0)).toBe(5);
    // bad index: the guard throws (a JS exception), NOT an illegal-cast trap.
    let threw = false;
    let msg = "";
    try {
      test(-1);
    } catch (e) {
      threw = true;
      msg = String((e as { message?: string }).message ?? e);
    }
    expect(threw).toBe(true);
    // The decisive check: it must NOT be the regression's `illegal cast` trap.
    expect(msg).not.toContain("illegal cast");
  });
});
