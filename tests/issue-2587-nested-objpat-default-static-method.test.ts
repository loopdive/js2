import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { compileAndInstantiate } from "../src/runtime-instantiate.ts";

// #2587 — a static class method whose parameter is a nested object binding
// pattern with a default initializer (the exact shape of the test262
// `class/dstr/*obj-ptrn*-init*` family, e.g. `meth-static-dflt-obj-ptrn-prop-obj.js`)
// used to crash the COMPILER with infinite recursion ("Maximum call stack size
// exceeded") in the parameter-destructuring lowering. The nested-pattern descent
// combined with the default-initializer compile did not bottom out.
//
// Resolved on main by the nested dstr-param-default work (#2158 valid-Wasm for a
// nested sub-pattern, #2568 two-level nested default struct-shape match, #2545
// outer-pattern eval). This test regression-locks the class-method shape so the
// recursion cannot reappear.
describe("#2587 nested obj-pattern default in a static class method", () => {
  it("compiles the double-default shape without a stack overflow (host)", async () => {
    const src = `class C {
      static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any = { w: { x: 10, z: 7 } }): number {
        return x as number;
      }
    }
    export function test(): number { return C.method() ?? -1; }`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
  });

  it("compiles the same shape under standalone (nativeStrings)", async () => {
    const src = `class C {
      static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any = { w: { x: 10, z: 7 } }): number {
        return x as number;
      }
    }
    export function test(): number { return C.method() ?? -1; }`;
    const r = await compile(src, { fileName: "test.ts", nativeStrings: true });
    expect(r.success).toBe(true);
  });

  it("applies outer and inner defaults with correct runtime semantics", async () => {
    const src = `class C {
      static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any = { w: { x: 10, z: 7 } }): number {
        return (x ?? -1) * 100 + (y ?? -1) * 10 + (z ?? -1);
      }
      static call1(): number { return C.method(); }
      static call2(): number { return C.method({ w: undefined }); }
      static call3(): number { return C.method({ w: { x: 1, y: 2, z: 3 } }); }
    }
    export function call1(): number { return C.call1(); }
    export function call2(): number { return C.call2(); }
    export function call3(): number { return C.call3(); }`;
    const ex = (await compileAndInstantiate(src)) as {
      call1(): number;
      call2(): number;
      call3(): number;
    };
    // No arg: outer default { w: { x: 10, z: 7 } } destructured directly →
    // x=10, y=undefined, z=7 → 10*100 + (-1)*10 + 7 = 997.
    expect(ex.call1()).toBe(997);
    // { w: undefined }: inner `w` is undefined → inner default { x:4, y:5, z:6 } → 456.
    expect(ex.call2()).toBe(456);
    // { w: { x:1, y:2, z:3 } }: explicit values → 123.
    expect(ex.call3()).toBe(123);
  });
});
