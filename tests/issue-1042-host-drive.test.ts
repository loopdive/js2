// #1042 — JS-host async/await on the #2906 N-state resume machine (host settle backend).
//
// The JS-host lane previously CPS-lowered ONLY the single-tail-await canonical
// shapes (`asyncFnNeedsCps`); every other genuinely-suspending body fell through
// to the legacy synchronous fakery and returned wrong values (measured on main
// 2026-07-02: multi-await → null, spill-across-await → null,
// try/finally-across-await → null, rejected 2nd await → uncaught wasm
// exception). #1042 routes those linear shapes through the SAME `$AsyncFrame`
// resume engine the wasi lane uses (#2906), with host-Promise settle adapters:
//   - result promise: `Promise_new_pending` / `Promise_settle_resolve|reject`
//   - suspension:     `Promise_resolve` (§27.7.5.3 assimilation) +
//                     `Promise_then2(p, __make_callback(fulfillId, frame),
//                                       __make_callback(rejectId, frame))`
//   - step adapters:  exported `__cb_<id>(frame, value)` (the wasi adapters'
//                     ABI was `__cb_`-shaped by design)
// One lowering engine, two settle primitives. Shapes `asyncFnNeedsCps` accepts
// keep the proven CPS lane byte-identically; shapes `planLinearAwaits` rejects
// (await in loop/branch, try/catch-across-await, return-in-try) keep the legacy
// fallback (byte-identical, filed forward).
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/** Await `p` with a timeout so a never-settling result promise fails fast. */
async function settled<T>(p: T | Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("result promise never settled")), ms)),
  ]);
}

describe("#1042 host drive — multi-await linear bodies (genuinely pending operands)", () => {
  it("two sequential genuinely-pending awaits thread both values", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        const b = await Promise.resolve(20).then((x: number) => x + 1);
        return a + b;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("a prefix local and the first binding survive the second suspension (frame spill)", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const k: number = 2;
        const a = await Promise.resolve(9).then((x: number) => x + 1);
        const b = await Promise.resolve(9).then((x: number) => x + 1);
        return k * (a + b);
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(40);
  });

  it("bare awaits (no binding) with side effects run strictly in order", async () => {
    const exports = await compileToWasm(`
      let acc: number = 0;
      async function f(): Promise<number> {
        await Promise.resolve(0).then((x: number) => { acc = acc + 20; return x; });
        await Promise.resolve(0).then((x: number) => { acc = acc + 22; return x; });
        return acc;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("`return await P` as the final segment after a prior await", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(2).then((x: number) => x * 10);
        return await Promise.resolve(a).then((x: number) => x + 22);
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("multi-await over legacy async callees (sync-settled) still resolves correctly", async () => {
    // The awaited operands are calls into await-less async fns (legacy lane,
    // raw-T results) — PromiseResolve assimilation must wrap them and deliver
    // through a real microtask.
    const exports = await compileToWasm(`
      async function getA(): Promise<number> { return 10; }
      async function getB(): Promise<number> { return 20; }
      async function sum(): Promise<number> {
        const a = await getA();
        const b = await getB();
        return a + b;
      }
      export async function main(): Promise<number> { return await sum(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(30);
  });
});

describe("#1042 host drive — try/finally across await", () => {
  it("finally runs after the awaited value lands (normal path)", async () => {
    const exports = await compileToWasm(`
      let log: number = 0;
      async function f(): Promise<number> {
        try {
          const a = await Promise.resolve(20).then((x: number) => x + 1);
          log = log + a;
        } finally {
          log = log + 100;
        }
        return log;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(121);
  });

  it("a rejected in-try await runs the finally, then rejects the result promise", async () => {
    const exports = await compileToWasm(`
      let flag: number = 0;
      export function getFlag(): number { return flag; }
      async function g(): Promise<number> {
        let out: number = -5;
        try {
          await Promise.resolve(1).then((x: number): number => { throw new Error("kaboom"); });
          out = 1;
        } finally {
          flag = 99;
        }
        return out;
      }
      export function main(): any { return g(); }
    `);
    await expect(settled(exports.main() as Promise<number>)).rejects.toBeTruthy();
    expect((exports.getFlag as () => number)()).toBe(99);
  });
});

describe("#1042 host drive — rejection routing", () => {
  it("a rejected second await rejects the result promise (parity with the CPS lane)", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(1).then((x: number) => x + 1);
        const b = await Promise.resolve(1).then((x: number): number => { throw new Error("boom"); });
        return a + b;
      }
      export function main(): any { return f(); }
    `);
    await expect(settled(exports.main() as Promise<number>)).rejects.toBeTruthy();
  });
});

describe("#1042 host drive — unclaimed shapes keep the legacy fallback (no regression)", () => {
  it("await inside a loop the loop CFG declines still compiles via the legacy path", async () => {
    // A `break` in the body is outside the async loop CFG's shape — must compile
    // and keep today's behavior (sync-settled operands thread synchronously).
    const exports = await compileToWasm(`
      async function g(): Promise<number> { return 1; }
      async function f(): Promise<number> {
        let s: number = 0;
        for (let i = 0; i < 3; i++) { s = s + (await g()); if (s > 100) break; }
        return s;
      }
      export function main(): number { return f() as any as number; }
    `);
    expect(exports.main()).toBe(3);
  });

  it("a plain `for` body with an await is driven by the loop CFG (#7096)", async () => {
    // Until #7096 this shape took the legacy path above; it is now a real
    // suspension, so `f()` is a Promise that settles to the sum.
    const exports = await compileToWasm(`
      async function g(): Promise<number> { return 1; }
      async function f(): Promise<number> {
        let s: number = 0;
        for (let i = 0; i < 3; i++) { s = s + (await g()); }
        return s;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(3);
  });

  it("statically resolved awaits still yield in a JS environment and settle the right value", async () => {
    // #6982: in a JS environment even `await 20` yields a microtask turn (the
    // #1313/#1727 elision now applies only host-free), so `f()` is a real
    // Promise — surfaced on #7096's touch of this file.
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const x = await 20;
        const y = await 22;
        return x + y;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });

  it("single-tail-await stays on the CPS lane (control)", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        return a * 2;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(settled(exports.main())).resolves.toBe(42);
  });
});
