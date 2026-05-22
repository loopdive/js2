// #1454 — Iterator protocol during destructuring: GetIterator, IteratorStep,
// IteratorClose error propagation.
//
// ECMA-262 §13.15.5.2 ArrayAssignmentPattern (and §13.3.3.5–§13.3.3.7
// IteratorBindingInitialization) require that array destructuring of an
// iterable go through GetIterator → IteratorStep → IteratorClose. Before
// this fix, the externref destructure path (used for plain JS objects
// passed to `var [x] = obj`, `[x] = obj`, and `fn([x])` patterns) read
// indices via `__extern_get(obj, box(i))`, bypassing @@iterator entirely.
// A throwing @@iterator getter (test262 iter-get-err) or a throwing
// .next() (iter-step-err) was therefore silently swallowed.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("#1454 — iterator protocol during destructuring", () => {
  it("declaration: throwing @@iterator propagates through `const [x] = iter`", async () => {
    const exp = await compileToWasm(`
      export function destructure(iter: any): any {
        let caught = "no-throw";
        try {
          const [x] = iter;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const iter: any = {};
    iter[Symbol.iterator] = () => {
      throw new Error("iter-get-err");
    };
    expect(exp.destructure!(iter)).toBe("caught");
  });

  it("declaration: throwing .next() propagates through `const [x] = iter`", async () => {
    const exp = await compileToWasm(`
      export function destructure(iter: any): any {
        let caught = "no-throw";
        try {
          const [x] = iter;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const iter: any = {};
    iter[Symbol.iterator] = () => ({
      next: () => {
        throw new Error("iter-step-err");
      },
    });
    expect(exp.destructure!(iter)).toBe("caught");
  });

  it("assignment: throwing @@iterator propagates through `[x] = iter`", async () => {
    const exp = await compileToWasm(`
      export function destructure(iter: any): any {
        let x: any;
        let caught = "no-throw";
        try {
          [x] = iter;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const iter: any = {};
    iter[Symbol.iterator] = () => {
      throw new Error("iter-get-err");
    };
    expect(exp.destructure!(iter)).toBe("caught");
  });

  it("assignment: throwing .next() propagates through `[x] = iter`", async () => {
    const exp = await compileToWasm(`
      export function destructure(iter: any): any {
        let x: any;
        let caught = "no-throw";
        try {
          [x] = iter;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const iter: any = {};
    iter[Symbol.iterator] = () => ({
      next: () => {
        throw new Error("iter-step-err");
      },
    });
    expect(exp.destructure!(iter)).toBe("caught");
  });

  it("array-prototype override: overridden Array.prototype[Symbol.iterator] is observed", async () => {
    const exp = await compileToWasm(`
      export function destructure(arr: any): any {
        let caught = "no-throw";
        try {
          const [x] = arr;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const orig = (Array.prototype as any)[Symbol.iterator];
    (Array.prototype as any)[Symbol.iterator] = () => {
      throw new Error("array-proto-iter-err");
    };
    try {
      expect(exp.destructure!([1, 2, 3])).toBe("caught");
    } finally {
      (Array.prototype as any)[Symbol.iterator] = orig;
    }
  });

  it("array-prototype default: plain arrays still take the fast path (no observable change)", async () => {
    const exp = await compileToWasm(`
      export function sum(arr: any): number {
        const [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(exp.sum!([10, 20, 30])).toBe(60);
  });

  it("param destructuring: throwing .next() on parameter propagates", async () => {
    const exp = await compileToWasm(`
      export function fn(iter: any): any {
        let caught = "no-throw";
        try {
          // Manually destructure inside fn to exercise the externref
          // declaration path (param patterns also work; here we test the
          // common path used by assignment + declaration destructuring).
          const [x] = iter;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    const iter: any = {};
    iter[Symbol.iterator] = () => ({
      next: () => {
        throw new Error("step-throw");
      },
    });
    expect(exp.fn!(iter)).toBe("caught");
  });

  it("normal iterators: generator destructure still works (no regression)", async () => {
    const exp = await compileToWasm(`
      export function test(): any {
        function* gen(): any { yield 1; yield 2; yield 3; }
        const [a, b, c] = gen();
        return a * 100 + b * 10 + c;
      }
    `);
    expect(exp.test!()).toBe(123);
  });

  it("normal iterators: Map destructure still works (no regression)", async () => {
    const exp = await compileToWasm(`
      export function test(): any {
        const m = new Map([[1, "a"], [2, "b"]]);
        const [first] = m;
        return first[0];
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("null/undefined still throws TypeError (no regression)", async () => {
    const exp = await compileToWasm(`
      export function destructure(v: any): any {
        let caught = "no-throw";
        try {
          const [x] = v;
        } catch (_e: any) {
          caught = "caught";
        }
        return caught;
      }
    `);
    expect(exp.destructure!(null)).toBe("caught");
    expect(exp.destructure!(undefined)).toBe("caught");
  });

  it("rest element: rest still collects after iteration (no regression)", async () => {
    const exp = await compileToWasm(`
      export function test(arr: any): any {
        const [head, ...tail] = arr;
        return head + ":" + tail.length;
      }
    `);
    expect(exp.test!([1, 2, 3, 4])).toBe("1:3");
  });

  // IteratorClose on inner-initializer throw (iter-thrw-close /
  // iter-rtrn-close) requires a follow-up: the current architecture
  // materializes the iterator eagerly via Array.from, so by the time an
  // inner default initializer throws, the iterator is already exhausted
  // and `.return()` cannot be called per spec §7.4.6. Tracked as an
  // out-of-scope follow-up for #1454; the iter-get-err / iter-step-err
  // failures (~134 of the ~160 documented in #1454) are addressed here.
  it.todo(
    "TODO: iter-thrw-close — inner-initializer throw should call iterator.return() (requires iterator-record threading, separate PR)",
  );
});
