import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #786: block-scoped let/const shadowing", () => {
  it("inner let does not leak to outer scope", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 2;
        {
          let x: number = 3;
        }
        return x;
      }
    `);
    expect(result).toBe(2);
  });

  it("nested let shadowing restores all levels", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 1;
        {
          let x: number = 2;
          {
            let x: number = 3;
          }
        }
        return x;
      }
    `);
    expect(result).toBe(1);
  });

  it("inner let value accessible inside block", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 10;
        let r: number = 0;
        {
          let x: number = 20;
          r = x;
        }
        return r + x;
      }
    `);
    expect(result).toBe(30);
  });

  it("var is not block-scoped (unchanged behavior)", async () => {
    const result = await run(`
      export function test(): number {
        var x: number = 2;
        {
          var x: number = 3;
        }
        return x;
      }
    `);
    expect(result).toBe(3);
  });

  it("for-loop let scope does not leak", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 10;
        for (let x: number = 0; x < 3; x = x + 1) {
          // inner x
        }
        return x;
      }
    `);
    expect(result).toBe(10);
  });

  it("block const shadowing does not poison a later loop variable", async () => {
    const result = await run(`
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 2; i = i + 1) {
          const d: number = i;
          sum = sum + d;
        }
        for (let d: number = 1; d <= 3; d++) {
          sum = sum + d;
        }
        return sum;
      }
    `);
    expect(result).toBe(7);
  });

  it("catch parameter scope does not leak", async () => {
    const result = await run(`
      export function test(): number {
        let result: number = 0;
        let c: number = 1;
        try {
          throw 42;
        } catch (e) {
          result = 10;
        }
        return c;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("Issue #786: method closure captures", () => {
  it("object method can read/write enclosing var", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        var obj = {
          inc(): void { callCount = callCount + 1; }
        };
        obj.inc();
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("object method captures multiple variables", async () => {
    const result = await run(`
      export function test(): number {
        var a: number = 10;
        var b: number = 20;
        var obj = {
          swap(): void {
            var t: number = a;
            a = b;
            b = t;
          }
        };
        obj.swap();
        if (a === 20 && b === 10) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("nested class method can read/write enclosing var", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        class C {
          inc(): void { callCount = callCount + 1; }
        }
        var c = new C();
        c.inc();
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("method callCount pattern (test262 common case)", async () => {
    const result = await run(`
      export function test(): number {
        var callCount: number = 0;
        var obj = {
          method(x: number, y: number, z: number): void {
            callCount = callCount + 1;
          }
        };
        obj.method(1, 2, 3);
        if (callCount === 1) return 1;
        return 0;
      }
    `);
    expect(result).toBe(1);
  });
});

// #786 — Array.prototype.{indexOf,lastIndexOf,includes} on an externref-element
// vec used the wasm:js-string `equals` builtin, which coerces both operands to
// strings. That mis-matched object identity, cross-type (e.g. boolean vs
// number), and other non-string elements. The fix routes externref comparison
// through __host_eq (Strict Equality, §7.2.16) for indexOf/lastIndexOf and
// __same_value_zero (§7.2.11) for includes.
describe("Issue #786: Array search methods use spec equality for externref elements", () => {
  async function runExtern(src: string): Promise<number | boolean> {
    const ex = await compileToWasm(src);
    return ex.test() as number | boolean;
  }

  it("indexOf finds an object element by reference", async () => {
    expect(
      await runExtern(`export function test(): number { const o={}; const a:any[]=[o]; return a.indexOf(o); }`),
    ).toBe(0);
  });

  it("indexOf finds an object among other objects", async () => {
    expect(
      await runExtern(
        `export function test(): number { const o={}; const p={}; const a:any[]=[p,o]; return a.indexOf(o); }`,
      ),
    ).toBe(1);
  });

  it("indexOf honours fromIndex for object elements", async () => {
    expect(
      await runExtern(
        `export function test(): number { const o={}; const a:any[]=["x","y",o]; return a.indexOf(o,2); }`,
      ),
    ).toBe(2);
  });

  it("indexOf returns -1 when fromIndex skips the match", async () => {
    expect(
      await runExtern(
        `export function test(): number { const o={}; const a:any[]=[o,"x","y"]; return a.indexOf(o,1); }`,
      ),
    ).toBe(-1);
  });

  it('indexOf does not coerce "0" to number 0 (strict equality)', async () => {
    expect(await runExtern(`export function test(): number { const a:any[]=["0"]; return a.indexOf(0); }`)).toBe(-1);
  });

  it("indexOf matches a string element", async () => {
    expect(
      await runExtern(`export function test(): number { const a:string[]=["x","y","z"]; return a.indexOf("y"); }`),
    ).toBe(1);
  });

  it("lastIndexOf finds the last matching object", async () => {
    expect(
      await runExtern(
        `export function test(): number { const o={}; const a:any[]=[o,"x",o]; return a.lastIndexOf(o); }`,
      ),
    ).toBe(2);
  });

  it("includes finds an object by reference (SameValueZero)", async () => {
    expect(
      await runExtern(`export function test(): boolean { const o={}; const a:any[]=["x",o]; return a.includes(o); }`),
    ).toBe(1);
  });

  it('includes does not coerce "0" to number 0', async () => {
    expect(
      await runExtern(`export function test(): boolean { const a:any[]=["0"]; return a.includes(0 as any); }`),
    ).toBe(0);
  });

  it("includes finds a matching string", async () => {
    expect(
      await runExtern(`export function test(): boolean { const a:string[]=["a","b"]; return a.includes("b"); }`),
    ).toBe(1);
  });
});

// #786 — A mixed array literal whose first element is numeric but which also
// contains a genuine object element (e.g. `[0, 1, obj]`) was typed as an f64
// vec from the first element, so the object reference was coerced to a number
// and lost. `[0,1,o].indexOf(o)` could then never match. The fix promotes the
// whole vec to externref when any element resolves to an object/ref type.
describe("Issue #786: mixed numeric+object array literal preserves object refs", () => {
  async function runExtern(src: string): Promise<number | boolean> {
    const ex = await compileToWasm(src);
    return ex.test() as number | boolean;
  }

  it("indexOf finds an object after leading numbers", async () => {
    expect(await runExtern(`export function test(): number { const o={}; return [0,1,o].indexOf(o); }`)).toBe(2);
  });

  it("indexOf honours fromIndex for object after numbers", async () => {
    expect(await runExtern(`export function test(): number { const o={}; return [0,1,o].indexOf(o,2); }`)).toBe(2);
  });

  it("indexOf object not found when fromIndex skips it", async () => {
    expect(await runExtern(`export function test(): number { const o={}; return [0,o,2].indexOf(o,2); }`)).toBe(-1);
  });

  it("indexOf with string fromIndex coercion finds object", async () => {
    expect(
      await runExtern(`export function test(): number { const o={}; return [0,1,2,o,4].indexOf(o,"3E0" as any); }`),
    ).toBe(3);
  });

  it("includes finds an object after leading numbers", async () => {
    expect(await runExtern(`export function test(): boolean { const o={}; return [0,1,o].includes(o as any); }`)).toBe(
      1,
    );
  });

  it("homogeneous number array still uses numeric path", async () => {
    expect(await runExtern(`export function test(): number { return [10,20,30].indexOf(20); }`)).toBe(1);
  });
});
