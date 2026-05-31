import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #779a — class-method destructuring-param trampoline emitted invalid Wasm.
//
// Root cause: for a class declared *inside* a function, `compileClassBodies`
// overwrote `ctx.currentFunc` without registering the enclosing function on
// the global-index shift-tracking stacks. A `string_constants` import added
// during binding-pattern destructuring (the "Cannot destructure ..." message)
// then ran `fixupModuleGlobalIndices`, which shifted the captured-global maps
// (and the method body) but NOT the enclosing function's already-emitted
// `global.set`/`global.get`. The enclosing function's captured-variable
// global references drifted onto the wrong (and wrongly typed) globals, so the
// binary failed `WebAssembly.instantiate` with a `global.set` type mismatch.
//
// These tests pin the shape that triggered the drift: a class method with a
// typed binding-pattern param whose body mutates an enclosing-scope variable
// (forcing capture-to-global promotion) AND whose param destructure adds the
// null-guard string constant.

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#779a class-method dstr-param global-index drift", () => {
  it("instance method, typed array pattern, captured enclosing var", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let ok = 0;
        class C {
          method([a, b]: number[]): void { if (a === 1 && b === 2) ok = 1; }
        }
        new C().method([1, 2]);
        return ok;
      }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("static method, typed array-rest pattern with default, captured var", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        const values = [1, 2, 3];
        let ok = 0;
        class C {
          static method([...x]: number[] = values): void {
            if (x.length === 3 && x[0] === 1 && x[1] === 2 && x[2] === 3 && x !== values) ok = 1;
          }
        }
        C.method();
        return ok;
      }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("generator method, typed array pattern, captured var", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let ok = 0;
        class C {
          *gen([a, b]: number[]): Generator<number> { if (a === 1 && b === 2) ok = 1; yield a; }
        }
        const g = new C().gen([1, 2]);
        g.next();
        return ok;
      }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("object binding pattern param, captured var", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let ok = 0;
        class C {
          method({ a, b }: { a: number; b: number }): void { if (a === 1 && b === 2) ok = 1; }
        }
        new C().method({ a: 1, b: 2 });
        return ok;
      }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("captured variable still readable after the destructuring method runs", async () => {
    // Guards the specific failure mode: the enclosing `return ok` must read the
    // SAME global the method wrote to, not a neighbouring (mis-shifted) one.
    const exports = await compileAndRun(`
      export function test(): number {
        let total = 0;
        class C {
          add([a, b]: number[]): void { total = total + a + b; }
        }
        const c = new C();
        c.add([1, 2]);
        c.add([3, 4]);
        return total;
      }
    `);
    expect(exports.test()).toBe(10);
  }, 30000);
});
