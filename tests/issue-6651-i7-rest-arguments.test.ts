// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice I7 — a rest parameter and the `arguments` object.
 *
 * Two defects, both on the standalone AND host lanes:
 *
 * 1. `arguments` counted the rest ARRAY as one argument. The arguments object
 *    is built from the call's argument list (§10.2.11 / §10.4.4.6), and the
 *    rest binding is only a view over that list's tail. A direct / method /
 *    `new` / `super` call packs the tail into the rest vec and published no
 *    `__argc`, so the callee's builder read "argc unknown → every formal" and
 *    produced `[x, restArray]`. `language/rest-parameters/with-new-target.js`
 *    saw `arguments.length === 1` for `constructor(...a)` called with 3.
 *
 * 2. An immediately-invoked function with a rest parameter bound the rest name
 *    to ONE argument (inline IIFE path) or to null (lifted IIFE path, taken for
 *    a short call). `language/rest-parameters/arrow-function.js`:
 *    `((...args) => args)()` was not an array.
 *
 * RED on the base commit (f58f09bd): every case except the two controls.
 * The tests compile with `target: "standalone"` — the lane slice I7 is scoped
 * to — and use no eval.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6651-i7.ts",
    target: "standalone",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#6651 I7 arguments excludes the rest array, counts the rest elements", () => {
  it("function declaration: arguments.length and arguments[i] cover the rest tail", async () => {
    expect(
      await runStandalone(`
        function f(x, ...a) {
          return arguments.length * 10 + (arguments[2] === 3 ? 1 : 0);
        }
        export function test(): number { return f(1, 2, 3); }
      `),
    ).toBe(31);
  });

  it("short call: an absent fixed formal is not counted", async () => {
    expect(
      await runStandalone(`
        function k(x, y, ...a) { return arguments.length; }
        export function test(): number { return k(1) * 10 + k(1, 2, 3, 4); }
      `),
    ).toBe(14);
  });

  it("typed rest elements are boxed into arguments", async () => {
    expect(
      await runStandalone(`
        function f(x: number, ...a: number[]): number {
          return arguments.length * 10 + (arguments[2] === 3 ? 1 : 0);
        }
        function g(x: string, ...a: string[]): number {
          return arguments.length * 10 + (arguments[1] === "b" ? 1 : 0);
        }
        export function test(): number { return f(1, 2, 3) * 100 + g("a", "b", "c"); }
      `),
    ).toBe(3131);
  });

  it("class constructor + super(...) (with-new-target.js shape)", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        class Base {
          constructor(...a) { out += arguments.length * 1000 + a.length * 100; }
        }
        class Child extends Base {
          constructor(...b) {
            super(1, 2, 3);
            out += arguments.length * 10 + b.length;
          }
        }
        export function test(): number { new Child(1, 2, 3, 4); return out; }
      `),
    ).toBe(3344);
  });

  it("class method, static method and object-literal method", async () => {
    expect(
      await runStandalone(`
        class C {
          m(x, ...a) { return arguments.length; }
          static s(x, ...a) { return arguments.length; }
        }
        var o = { om(x, ...a) { return arguments.length; } };
        export function test(): number {
          return new C().m(1, 2, 3) * 100 + C.s(1, 2, 3, 4) * 10 + o.om(1, 2);
        }
      `),
    ).toBe(342);
  });

  it("control: function expression with rest (already correct on base)", async () => {
    expect(
      await runStandalone(`
        var g = function (x, ...a) { return arguments.length * 10 + (arguments[2] === 3 ? 1 : 0); };
        export function test(): number { return g(1, 2, 3); }
      `),
    ).toBe(31);
  });

  it("control: simple parameter list keeps its call-site argument count", async () => {
    expect(
      await runStandalone(`
        function k2(x, y) { return arguments.length; }
        export function test(): number { return k2(1) * 10 + k2(1, 2, 3); }
      `),
    ).toBe(13);
  });
});

describe("#6651 I7 an immediately-invoked function packs its rest parameter", () => {
  it("((...args) => args)() is an empty array; (1,2,3) packs all three", async () => {
    expect(
      await runStandalone(`
        function shape(v: any, n: number): number {
          if (v === null) return 2;
          if (v === undefined) return 3;
          if (typeof v !== "object") return 4;
          return v.length === n ? 1 : 5;
        }
        export function test(): number {
          return shape(((...args) => args)(), 0) * 10 + shape(((...args) => args)(1, 2, 3), 3);
        }
      `),
    ).toBe(11);
  });

  it("fixed formals before the rest (arrow-function.js shape)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var r = ((a, b, ...c) => c)(1, 2, 3, 4, 5);
          var e = ((a, b, ...c) => c)(1);
          return r.length * 100 + (r[0] === 3 ? 10 : 0) + e.length;
        }
      `),
    ).toBe(310);
  });
});
