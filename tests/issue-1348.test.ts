/**
 * #1348 — for-of IteratorClose on abrupt body completion (return path).
 *
 * Spec §14.7.5 requires `IteratorClose(iterator, abrupt)` to be called
 * when a for-of body throws / breaks / continues / returns to a label
 * outside the loop.  Most paths were already wired in #851; this issue
 * fixes the `return` path inside a *void* IIFE, where the IIFE body was
 * being inlined into the caller without wrapping its body in a block.
 * That meant `return;` inside the IIFE became a Wasm `return` from the
 * enclosing function, skipping the rest of the test (and the
 * post-IIFE asserts that check `returnCount === 1`).
 *
 * Repro shape (lifted from
 * `test262/test/language/statements/for-of/iterator-close-via-return.js`):
 *
 *   (function () {
 *     for (var x of iterable) { iterationCount += 1; return; }
 *   }());
 *   // post-IIFE asserts must still run
 *
 * Fix lives in `src/codegen/expressions/calls.ts` (void-IIFE inlining).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const importResult = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: {} });
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  if (typeof importResult.setExports === "function") {
    importResult.setExports(instance.exports as any);
  }
  return (instance.exports as any).test();
}

describe("#1348 — void IIFE return", () => {
  it("return inside void IIFE exits ONLY the IIFE, not the caller", async () => {
    // The IIFE returns void; its `return;` must not leak through to the
    // outer function. Without the fix, this returned 0 instead of 42.
    const src = `
      export function test(): number {
        let sentinel: number = 0;
        (function (): void {
          for (let i: number = 0; i < 1; i++) {
            sentinel = 1;
            return;
          }
          sentinel = 99;
        }());
        if (sentinel !== 1) return -1;
        return 42;
      }
    `;
    expect(await runWasm(src)).toBe(42);
  });

  it("return inside void IIFE inside for-of preserves post-IIFE statements", async () => {
    // Mirrors iterator-close-via-return.js (without host iterables).
    const src = `
      export function test(): number {
        let iterCount: number = 0;
        let postIife: number = 0;
        (function (): void {
          for (let i: number = 0; i < 5; i++) {
            iterCount = iterCount + 1;
            return;
          }
        }());
        postIife = 1;
        if (iterCount !== 1) return -1;
        if (postIife !== 1) return -2;
        return 1;
      }
    `;
    expect(await runWasm(src)).toBe(1);
  });

  it("bare return in void IIFE — no expression — falls through to post-IIFE code", async () => {
    const src = `
      export function test(): number {
        let after: number = 0;
        (function (): void {
          return;
        }());
        after = 1;
        return after;
      }
    `;
    expect(await runWasm(src)).toBe(1);
  });

  it("nested void IIFEs — inner return only exits inner", async () => {
    const src = `
      export function test(): number {
        let outerRan: number = 0;
        let innerRan: number = 0;
        (function (): void {
          (function (): void {
            innerRan = 1;
            return;
          }());
          outerRan = 1;
        }());
        if (innerRan !== 1) return -1;
        if (outerRan !== 1) return -2;
        return 7;
      }
    `;
    expect(await runWasm(src)).toBe(7);
  });

  it("void arrow IIFE — return; exits only the arrow", async () => {
    const src = `
      export function test(): number {
        let x: number = 0;
        ((): void => {
          for (let i: number = 0; i < 3; i++) {
            x = i + 1;
            return;
          }
          x = 999;
        })();
        return x;
      }
    `;
    // Inner return after first iteration -> x === 1, post-arrow code in outer
    // function runs normally (no-op here since the return is the last statement).
    expect(await runWasm(src)).toBe(1);
  });
});

// #1348 — class static initialization order and private-field semantics.
//
// These cases mirror the residual test262 clusters called out in the issue.
// Spec anchors:
// - ECMA-262 §15.7.14 ClassDefinitionEvaluation collects static fields/blocks
//   in class-body order and executes those records during class evaluation.
// - ECMA-262 §13.3.7.1 SuperCall performs InitializeInstanceElements on the
//   derived constructor after the super constructor returns.
// - ECMA-262 §7.3.26 PrivateElementFind underpins `#x in obj` brand checks.
describe("#1348 class static initialization and private fields", () => {
  it("runs static fields and static blocks in source order", async () => {
    const ex = await compileToWasm(`
      class C {
        static n: number = 0;
        static a: number = C.n + 1;
        static { C.n = C.a + 1; }
        static b: number = C.n + 1;
        static { C.n = C.b + 1; }
      }
      export function test(): number { return C.n * 100 + C.a * 10 + C.b; }
    `);
    expect(ex.test()).toBe(413);
  });

  it("static block can read earlier private static field", async () => {
    const ex = await compileToWasm(`
      class C {
        static #x: number = 41;
        static y: number = 0;
        static { C.y = this.#x + 1; }
      }
      export function test(): number { return C.y; }
    `);
    expect(ex.test()).toBe(42);
  });

  it("private in is a brand check: false for a wrong-class object, TypeError for a non-object", async () => {
    // (#3714) `#x in obj` per ES2022 §12.10.3 step 5: `false` for any object
    // that isn't an `A` instance, but a **TypeError** when `obj` isn't an
    // Object at all (verified against real V8/Node — `null` throws, it does
    // not silently evaluate to `false`). This test previously asserted the
    // opposite for `null` ("does not throw on wrong receiver"); that was the
    // same spec misreading #3714 found and fixed in binary-ops-in.ts.
    const ex = await compileToWasm(`
      class A {
        #x: number = 1;
        has(o: any): boolean { return #x in o; }
        hasCaught(o: any): number {
          try {
            return #x in o ? 1 : 0;
          } catch (e) {
            return e instanceof TypeError ? 2 : 3;
          }
        }
      }
      class B {
        #x: number = 2;
      }
      export function test(): number {
        const a = new A();
        const b = new B();
        return (a.has(a) ? 1 : 0) + (a.has(b) ? 10 : 0) + a.hasCaught(null) * 100;
      }
    `);
    expect(ex.test()).toBe(201);
  });

  it("private field read rejects unrelated class with the same private name", async () => {
    const ex = await compileToWasm(`
      class A {
        #x: number = 1;
        read(o: any): number { return o.#x; }
      }
      class B {
        #x: number = 2;
      }
      export function test(): number {
        const a = new A();
        const b = new B();
        if (a.read(a) !== 1) return 0;
        try {
          a.read(b);
          return 0;
        } catch (e: any) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("super() runs parent field initializer before child shadow field", async () => {
    const ex = await compileToWasm(`
      let log: number = 0;
      function mark(n: number): number {
        log = log * 10 + n;
        return n;
      }
      class Parent {
        x: number = mark(1);
      }
      class Child extends Parent {
        x: number = mark(2);
        constructor() { super(); }
      }
      export function test(): number {
        const c = new Child();
        return log * 10 + c.x;
      }
    `);
    expect(ex.test()).toBe(122);
  });
});
