/**
 * #820l — arguments object: extra positional args beyond declared formals
 * not retained.
 *
 * Spec §10.4.4 step 5: the arguments object's `len` is "the number of
 * arguments actually passed", not the formal-parameter count. We previously
 * sized argv to the formal count, dropping every extra positional and
 * leaving `arguments.length` lying.
 *
 * The fix plumbs __argc + __extras_argv from the inlined array-method
 * dispatcher (which knows the spec arity per method — 3 for forEach/map/etc.,
 * 4 for reduce) into the receive-side `emitArgumentsVecBody`. This file
 * pins the observable behaviour for the dominant sub-shape (Array.prototype
 * callbacks reading `arguments`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, (result as any).importObject);
  return instance.exports;
}

describe("#820l — arguments object retains extra positional args from spec-arity callbacks", () => {
  it("does not allocate callback extras for a simple arrow that cannot observe them", async () => {
    const result = await compile(
      `
        export function run(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) values.push(i);
          return values.map((value: number): number => value * 2).length;
        }
      `,
      { fileName: "test.ts", optimize: 4, emitWat: true, emitWatOnlyFunctions: ["run"] },
    );
    expect(result.success).toBe(true);
    const body = result.wat?.slice(result.wat.indexOf("(func $run"), result.wat.indexOf('(export "run"'));
    expect(body).not.toContain("array.new_fixed");

    const { instance } = await WebAssembly.instantiate(result.binary, (result as any).importObject);
    expect((instance.exports.run as () => number)()).toBe(10);
  });

  it("forEach callback with 1 formal sees arguments.length === 3", async () => {
    const e: any = await run(`
      export function test(): number {
        let n = 0;
        [10, 20, 30].forEach(function (v: any) { n = arguments.length; });
        return n;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("forEach callback with 0 formals sees arguments.length === 3", async () => {
    const e: any = await run(`
      export function test(): number {
        let n = 0;
        [10, 20].forEach(function () { n = arguments.length; });
        return n;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("forEach callback can read arguments[1] (index) and arguments[2] (array)", async () => {
    const e: any = await run(`
      export function test(): number {
        let lastIdx = -1;
        let arrLen = 0;
        [11, 22, 33].forEach(function (v: any) {
          lastIdx = (arguments as any)[1];
          arrLen = ((arguments as any)[2] as any).length;
        });
        return lastIdx * 10 + arrLen;
      }
    `);
    // lastIdx=2, arrLen=3 → 23
    expect(e.test()).toBe(23);
  });

  it("map callback with 1 formal sees arguments.length === 3", async () => {
    const e: any = await run(`
      export function test(): number {
        let observed = 0;
        [1, 2].map(function (v: any) { observed = arguments.length; return v; });
        return observed;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("filter callback with 1 formal sees arguments.length === 3", async () => {
    const e: any = await run(`
      export function test(): number {
        let observed = 0;
        [1, 2].filter(function (v: any) { observed = arguments.length; return true; });
        return observed;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("forEach callback declaring all 3 formals still sees arguments.length === 3", async () => {
    const e: any = await run(`
      export function test(): number {
        let n = 0;
        [10, 20, 30].forEach(function (v: any, i: any, a: any) { n = arguments.length; });
        return n;
      }
    `);
    expect(e.test()).toBe(3);
  });
});
