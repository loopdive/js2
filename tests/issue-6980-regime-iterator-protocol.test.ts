// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6980 — iterator / generator protocol under the native regime.
 *
 * Every construct is compiled twice — native-first in a JavaScript environment
 * (exports read through `wrapCompiledExports`, the regime's value boundary) and
 * `target: "standalone"` — and checked by RESULT, never by WAT shape. The rows
 * that need a JS caller (host iterables, host `null`, a throwing host iterator)
 * only run in the JavaScript environment.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Mode = "native-first" | "standalone";
const MODES: readonly Mode[] = ["native-first", "standalone"];

async function load(source: string, mode: Mode): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = await compile(source, {
    fileName: `issue-6980-${mode}.ts`,
    ...(mode === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const }),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapCompiledExports(result, instance) as Record<string, (...args: unknown[]) => unknown>;
}

async function run(source: string, mode: Mode, ...args: unknown[]): Promise<unknown> {
  const exports = await load(source, mode);
  return await exports.test!(...args);
}

const CLOSURE_NEXT_ITERABLE = `
  const obj = {
    [Symbol.iterator]() {
      let i = 0;
      const data = [10, 20, 30];
      return { next: () => (i < data.length ? { value: data[i++], done: false } : { value: 0, done: true }) };
    },
  };
`;

describe.each(MODES)("#6980 native regime (%s)", (mode) => {
  it("spread / destructure / for-of drive an iterator whose next is a closure field", async () => {
    const source = `export function test(): number {
      ${CLOSURE_NEXT_ITERABLE}
      const a = [...obj];
      const [x, y] = obj;
      let s = 0;
      for (const v of obj) s += v;
      return a.length * 100000 + (a[0] + a[1] + a[2]) * 1000 + (x * 100 + y) + s * 0;
    }`;
    expect(await run(source, mode)).toBe(3 * 100000 + 60 * 1000 + 1020);
  });

  it("closure-next and method-next iterators coexist in one module", async () => {
    const source = `export function test(): number {
      ${CLOSURE_NEXT_ITERABLE}
      const other = {
        [Symbol.iterator]() {
          let n = 0;
          return { next() { return n < 2 ? { value: ++n, done: false } : { value: 0, done: true }; } };
        },
      };
      let s = 0;
      for (const x of obj) s += x;
      for (const y of other) s += y * 1000;
      const [a] = obj;
      return s + a * 100000 + [...obj].length;
    }`;
    expect(await run(source, mode)).toBe(1003006);
  });

  it("array-destructures a native Map and Set through the iterator protocol", async () => {
    const source = `export function test(): number {
      const m = new Map([[1, "a"], [2, "b"]]);
      const [first, second] = m;
      const s = new Set([7, 8, 9]);
      const [x, ...rest] = s;
      return first[0] * 1000 + (second[1] === "b" ? 100 : 0) + x * 10 + rest.length;
    }`;
    expect(await run(source, mode)).toBe(1172);
  });

  it("x[Symbol.iterator]() on a compiled method is an ordinary call", async () => {
    const source = `
      class Iter { [Symbol.iterator](): number { return 99; } }
      const obj: { [Symbol.iterator]: () => number } = { [Symbol.iterator](): number { return 42; } };
      export function test(): number {
        return new Iter()[Symbol.iterator]() * 1000 + obj[Symbol.iterator]();
      }`;
    expect(await run(source, mode)).toBe(99042);
  });

  it("a generator's @@iterator returns the generator itself", async () => {
    const source = `export function test(): number {
      function* g() { yield 1; yield 2; yield 3; }
      const it = g();
      const same = (it as any)[Symbol.iterator]() === it;
      let s = 0;
      for (const v of (it as any)[Symbol.iterator]()) s += v;
      return (same ? 100 : 0) + s;
    }`;
    expect(await run(source, mode)).toBe(106);
  });

  it("gen.return(v) keeps a non-number v; a finally return overrides it", async () => {
    const source = `export function test(): number {
      function* g() { yield 1; yield 2; }
      function* h() { try { yield 1; } finally { return 7; } }
      const it = g();
      it.next();
      const r: any = (it as any).return("done");
      const fresh: any = (g() as any).return("fresh");
      const hh = h();
      hh.next();
      const r4: any = (hh as any).return("x");
      return (r.value === "done" ? 1 : 0) + (r.done ? 10 : 0) + (fresh.value === "fresh" ? 100 : 0) +
        (r4.value === 7 ? 1000 : 0) + (it.next().done ? 10000 : 0);
    }`;
    expect(await run(source, mode)).toBe(11111);
  });

  it("a finally return whose value collides with v's numeric payload keeps its own value", async () => {
    // Review finding on PR #6678: provenance must come from the completion,
    // not from comparing the f64 result bits with `__gen_numeric_payload(v)`.
    const source = `export function test(): number {
      function* a() { try { yield 1; } finally { return NaN; } }
      function* b() { try { yield 1; } finally { return 1; } }
      function* c() { try { yield 1; } finally { return 0; } }
      function* e() { try { yield 1; } finally { yield 9; } }
      const ia = a(); ia.next(); const ra: any = (ia as any).return("done");
      const ib = b(); ib.next(); const rb: any = (ib as any).return(true);
      const ic = c(); ic.next(); const rc: any = (ic as any).return("0");
      const ie = e(); ie.next(); const re1: any = (ie as any).return("late"); const re2: any = (ie as any).next();
      return (typeof ra.value === "number" && ra.value !== ra.value && ra.done ? 1 : 0) +
        (typeof rb.value === "number" && rb.value === 1 ? 10 : 0) +
        (typeof rc.value === "number" && rc.value === 0 ? 100 : 0) +
        (re1.value === 9 && !re1.done ? 1000 : 0) +
        (re2.value === "late" && re2.done ? 10000 : 0);
    }`;
    expect(await run(source, mode)).toBe(11111);
  });

  it("a detached static async generator method iterates host-free", async () => {
    const source = `
      class C { static async *gen() { yield 1; yield 2; yield 3; } }
      export async function test(): Promise<number> {
        const f = C.gen;
        const it = f();
        let total = 0;
        for (let i = 0; i < 4; i++) {
          const r = await it.next();
          if (r.done) break;
          total += r.value;
        }
        return total;
      }`;
    expect(await run(source, mode)).toBe(6);
  });

  it("a yield nested in a binary chain resumes with the sent value, in order", async () => {
    const source = `
      let log = 0;
      let r1 = 0;
      let r2 = "";
      function f(n: number): number { log = log * 10 + n; return n; }
      function* g(): Generator<number, void, any> {
        r1 = f(1) + f(2) + (yield 1) + f(3);
        r2 = "a" + (yield 2) + "b";
      }
      export function test(): number {
        const it = g();
        it.next();
        log = log * 10 + 9;
        it.next(40);
        it.next("Z");
        return log * 1000 + r1 + (r2 === "aZb" ? 100 : 0);
      }`;
    expect(await run(source, mode)).toBe(1293 * 1000 + 46 + 100);
  });
});

describe("#6980 native regime — JavaScript caller values", () => {
  it("iterates a host array through for-of, destructuring, rest and spread", async () => {
    const exports = await load(
      `export function forOf(arr: any): number { let s = 0; for (const x of arr) s += x; return s; }
       export function dstr(arr: any): number { const [a, b, c] = arr; return a + b + c; }
       export function rest(arr: any): number { const [h, ...t] = arr; return h * 10 + t.length; }
       export function spread(arr: any): number { return [...arr].length; }`,
      "native-first",
    );
    expect(exports.forOf!([10, 20, 30])).toBe(60);
    expect(exports.dstr!([10, 20, 30])).toBe(60);
    expect(exports.rest!([1, 2, 3, 4])).toBe(13);
    expect(exports.spread!(new Set([1, 2, 3]))).toBe(3);
  });

  it("host null / undefined destructuring throws a catchable TypeError", async () => {
    const exports = await load(
      `export function test(v: any): number {
        try { const [x] = v; } catch (_e) { return 1; }
        return 0;
      }`,
      "native-first",
    );
    expect(exports.test!(null)).toBe(1);
    expect(exports.test!(undefined)).toBe(1);
  });

  it("a host iterator that throws is observable to try/catch; uncaught keeps the JS error", async () => {
    const exports = await load(
      `export function test(iter: any): number {
        try { const [x] = iter; } catch (_e) { return 1; }
        return 0;
      }
      export function uncaught(f: any): number { f(); return 0; }`,
      "native-first",
    );
    const throwsOnGet: any = {
      [Symbol.iterator]() {
        throw new Error("iter-get-err");
      },
    };
    const throwsOnNext: any = {
      [Symbol.iterator]: () => ({
        next: () => {
          throw new Error("iter-step-err");
        },
      }),
    };
    expect(exports.test!(throwsOnGet)).toBe(1);
    expect(exports.test!(throwsOnNext)).toBe(1);
    const original = new TypeError("boom");
    expect(() =>
      exports.uncaught!(() => {
        throw original;
      }),
    ).toThrow(original);
  });
});
