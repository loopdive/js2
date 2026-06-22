import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2602 — for-of / for-await assignment-destructuring rest element (`...y`) is
// never written. `for ([x, ...y] of [[1, 2, 3]])` (an ASSIGNMENT pattern — `x`
// and `y` are pre-declared, not bound by the loop) must, per spec §13.15.5.5
// ArrayAssignmentPattern (the rest step), PutValue the rest slice `[2, 3]` to
// `y`. Before this fix the per-element for-of destructuring loops `continue`d on
// `ts.isSpreadElement`, so the rest target was silently dropped: `y` kept its
// stale value (the source array, length 3) instead of the rest slice (length 2).
//
// This is NOT async-specific — the sync `for ([x, ...y] of …)` failed too. The
// fix lives in the externref / vec / tuple for-of assignment-destructuring paths
// in src/codegen/statements/loops.ts and is mirrored into the for-await async
// state machine (same lowering function).

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = await compile(src, target ? ({ target, fileName: "test.ts" } as never) : { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const importObject: any = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2602 for-of/for-await assignment-destructuring rest element", () => {
  // The headline case from the issue: typed number[] rest (vec lowering), the
  // path the test262 `array-rest-after-element` shape exercises.
  it("sync for-of: [x, ...y] writes the rest slice to a typed local (vec path)", async () => {
    const src = `
      let x = 0;
      let y: number[] = [];
      let ylen = -1, y0 = -1, y1 = -1;
      for ([x, ...y] of [[1, 2, 3]]) {
        ylen = y.length; y0 = y[0]; y1 = y[1];
      }
      export function test(): number {
        if (x !== 1) return 100 + x;
        if (ylen !== 2) return 200 + ylen;
        if (y0 !== 2) return 300 + y0;
        if (y1 !== 3) return 400 + y1;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("sync for-of: [...y] writes the whole array to the rest target", async () => {
    const src = `
      let y: number[] = [];
      let ylen = -1, y0 = -1, y2 = -1;
      for ([...y] of [[4, 5, 6]]) {
        ylen = y.length; y0 = y[0]; y2 = y[2];
      }
      export function test(): number {
        if (ylen !== 3) return 200 + ylen;
        if (y0 !== 4) return 300 + y0;
        if (y2 !== 6) return 400 + y2;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("sync for-of: rest target as a module-level var (global-sync path)", async () => {
    const src = `
      var x = 0;
      var y: number[] = [];
      for ([x, ...y] of [[7, 8, 9]]) {}
      export function test(): number {
        if (x !== 7) return 100 + x;
        if (y.length !== 2) return 200 + y.length;
        if (y[0] !== 8) return 300 + y[0];
        if (y[1] !== 9) return 400 + y[1];
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("async for-await: [x, ...y] writes the rest slice (async state machine)", async () => {
    const src = `
      let x = 0;
      let y: number[] = [];
      let ylen = -1, y0 = -1, y1 = -1;
      async function fn(): Promise<void> {
        for await ([x, ...y] of [[1, 2, 3]]) {
          ylen = y.length; y0 = y[0]; y1 = y[1];
        }
      }
      export function test(): number {
        fn();
        if (x !== 1) return 100 + x;
        if (ylen !== 2) return 200 + ylen;
        if (y0 !== 2) return 300 + y0;
        if (y1 !== 3) return 400 + y1;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("sync for-of: rest after two elements ([a, b, ...rest])", async () => {
    const src = `
      let a = 0, b = 0;
      let r: number[] = [];
      let rlen = -1, r0 = -1;
      for ([a, b, ...r] of [[10, 20, 30, 40]]) {
        rlen = r.length; r0 = r[0];
      }
      export function test(): number {
        if (a !== 10) return 100 + a;
        if (b !== 20) return 200 + b;
        if (rlen !== 2) return 300 + rlen;
        if (r0 !== 30) return 400 + r0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // Standalone (pure-Wasm) mode: typed `number[]` rest so the read-back is fully
  // native (no #2580 any-read substrate dependency). This exercises the vec rest
  // write through the native object-runtime __extern_slice (zero host imports).
  it("standalone: [x, ...y] writes the rest slice (native vec slice)", async () => {
    const src = `
      export function test(): number {
        let x = 0;
        let y: number[] = [];
        let ylen = -1, y0 = -1, y1 = -1;
        for ([x, ...y] of [[1, 2, 3]]) { ylen = y.length; y0 = y[0]; y1 = y[1]; }
        if (x !== 1) return 100 + x;
        if (ylen !== 2) return 200 + ylen;
        if (y0 !== 2) return 300 + y0;
        if (y1 !== 3) return 400 + y1;
        return 1;
      }
    `;
    expect(await run(src, "standalone")).toBe(1);
  });
});
