/**
 * #1690b — Inner function `var x` must allocate a function-local instead of
 * aliasing the module-level `__mod_x` global.
 *
 * ECMA-262 §10.2.10: a `var` declared anywhere inside a function hoists to the
 * *enclosing function*, not to the module. The previous codegen short-circuited
 * `hoistVarDecl` / `hoistBindingPattern` / `ensureLetConstBindingPatternTdzFlags`
 * when the name collided with a module global, so the inner `var x` was never
 * allocated as a local. The identifier resolver then fell through to
 * `global.get/set $__mod_x` for every read/write inside the function body,
 * corrupting the module global.
 *
 * The fix removes the `moduleGlobals.has(name)` skip from those three
 * function-body hoisters (src/codegen/index.ts). They only run while compiling
 * a nested function body, so unconditionally allocating the local is correct;
 * the module-level var-hoisting walk (`walkModuleStmtForVars`) is a separate
 * path and is unaffected.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
    (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.exports);
  }
  return instance.exports;
}

describe("#1690b — inner var shadows module global", () => {
  it("basic shadow: inner var mutation does not touch the module global", async () => {
    const e: any = await run(`
      var i = 999;
      function f(): void {
        var i = 7;
        i = i + 1;
      }
      export function test(): number {
        f();
        return i; // module-level i must stay 999
      }
    `);
    expect(e.test()).toBe(999);
  });

  it("function returns its own shadowed var, module value unchanged", async () => {
    const e: any = await run(`
      let x = 1;
      function f(): number {
        var x = 2;
        return x;
      }
      export function test(): number {
        const inner = f();
        // encode both observations: inner*10 + module
        return inner * 10 + x;
      }
    `);
    // inner === 2, module x === 1 → 21
    expect(e.test()).toBe(21);
  });

  it("capturing nested function hoists its own shadow before module resolution", async () => {
    const e: any = await run(`
      var x = 1;
      export function test(): number {
        const outer = 2;
        function f(): number {
          var x = 3;
          return x + outer;
        }
        return f() * 10 + x;
      }
    `);
    // f captures `outer`, but its own x still shadows the module x: 5*10 + 1.
    expect(e.test()).toBe(51);
  });

  it("function-local var without initializer reads as undefined (not the module value)", async () => {
    const e: any = await run(`
      var x = 42;
      export function test(): unknown {
        var x;
        return x; // expected undefined
      }
    `);
    expect(e.test()).toBe(undefined);
  });

  it("uninitialised self-reference reads undefined before the var initialiser runs", async () => {
    const e: any = await run(`
      export function test(): unknown {
        var y = y; // hoisted y is undefined when its own initialiser evaluates
        return y;
      }
    `);
    expect(e.test()).toBe(undefined);
  });

  it("hoisted var inside a nested block is function-local and shadows the module global", async () => {
    const e: any = await run(`
      var n = 1;
      function g(): number {
        if (true) { var n = 5; }
        return n;
      }
      export function test(): number {
        return g(); // expected 5 (function-local), module n stays 1
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("module global remains accessible from a function that declares no shadow", async () => {
    const e: any = await run(`
      var k = 11;
      function h(): number {
        return k; // no inner var — reads the module global
      }
      export function test(): number {
        return h();
      }
    `);
    expect(e.test()).toBe(11);
  });

  it("top-level block lexical does not overwrite a same-named Script binding", async () => {
    const e: any = await run(`
      let x = 10;
      { let x = 20; }
      export function test(): number {
        return x;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("destructuring shadow: inner var pattern is function-local, module value unchanged", async () => {
    const e: any = await run(`
      let a = 1;
      function f(): number {
        var [a] = [5];
        return a;
      }
      export function test(): number {
        const inner = f();
        return inner * 10 + a; // inner 5, module a 1 → 51
      }
    `);
    expect(e.test()).toBe(51);
  });

  it("object-destructuring shadow inside a function is function-local", async () => {
    const e: any = await run(`
      var p = 100;
      function d(): number {
        var { p } = { p: 7 };
        return p;
      }
      export function test(): number {
        const inner = d();
        return inner * 1000 + p; // inner 7, module p 100 → 7100
      }
    `);
    expect(e.test()).toBe(7100);
  });
});
