// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #821 — A destructuring binding element whose default initializer returns
 * `void` (e.g. `{ s: t = counter() }` where `counter(): void`) made TypeScript
 * infer the binding's type as `void`. `mapTsTypeToWasm` mapped that to `i32`,
 * so the *actual* present property value (`null`/`0`/`false`/`''`, an
 * externref) was coerced into an `i32` local and destroyed.
 *
 * Per ECMA-262 §13.3.3.6/§13.3.3.7 the default is only used when the value is
 * `undefined`; a present, non-`undefined` value must be preserved unchanged.
 * The fix types such bindings as `externref` so the real value survives.
 */
async function run(src: string): Promise<Record<string, any>> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return instance.exports as Record<string, any>;
}

describe("#821 — void-default dstr binding preserves the real value", () => {
  it("object param with renamed binding + void default: falsy values preserved", async () => {
    const ex = await run(`
      var initCount = 0;
      function counter() { initCount += 1; }
      let rt: any, rv: any, rx: any, rz: any;
      function f({ s: t = counter(), u: v = counter(), w: x = counter(), y: z = counter() }: any) {
        rt = t; rv = v; rx = x; rz = z;
      }
      export function test(): number {
        initCount = 0;
        f({ s: null, u: 0, w: false, y: '' });
        if (rt !== null) return -10;
        if (rv !== 0) return -11;
        if (rx !== false) return -12;
        if (rz !== '') return -13;
        if (initCount !== 0) return -14;
        return 1;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("class method object param with void default: falsy values preserved", async () => {
    const ex = await run(`
      var initCount = 0;
      function counter() { initCount += 1; }
      let oa: any, ob: any;
      class C {
        m({ a = counter(), b = counter() }: any): number {
          oa = a; ob = b;
          if (oa !== null) return -40;
          if (ob !== 0) return -41;
          if (initCount !== 0) return -42;
          return 1;
        }
      }
      export function test(): number {
        initCount = 0;
        return new C().m({ a: null, b: 0 });
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("void default still fires when the property is undefined", async () => {
    const ex = await run(`
      var initCount = 0;
      function counter() { initCount += 1; }
      let oa: any;
      function f({ a = counter() }: any) { oa = a; }
      export function test(): number {
        initCount = 0;
        f({});
        // a was undefined -> default ran exactly once; counter() returns undefined
        if (initCount !== 1) return -50 - initCount;
        if (oa !== undefined) return -60;
        return 1;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });
});
