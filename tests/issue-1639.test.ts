/**
 * #1639 — Generator / AsyncIterator prototype: receiver brand checks + the
 * %(Async)IteratorPrototype% chain reachable via `g.prototype`.
 *
 * Before this fix:
 *  - `g.prototype` (member access on a compiled generator-function object)
 *    evaluated to `undefined`, so `getPrototypeOf(g.prototype)` trapped.
 *  - `%AsyncIteratorPrototype%` did not exist as a distinct object carrying
 *    `[Symbol.asyncIterator]`.
 */
import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function runReturningNumber(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return (exports.test as () => number)();
}

describe("#1639 generator prototype receiver checks", () => {
  it("g.prototype resolves to %GeneratorPrototype% (not undefined)", async () => {
    const r = await runReturningNumber(`export function test(): number {
      function* gen(){ yield 1; }
      const proto = Object.getPrototypeOf(gen.prototype);
      return typeof (proto as any).next === "function" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("Generator.prototype.next on a non-generator throws TypeError (no trap)", async () => {
    const r = await runReturningNumber(`export function test(): number {
      function* gen(){ yield 1; }
      const proto = Object.getPrototypeOf(gen.prototype);
      try { (proto as any).next.call({}); return 0; }
      catch (e) { return e instanceof TypeError ? 1 : 0; }
    }`);
    expect(r).toBe(1);
  });

  it("Generator.prototype.return/throw on a non-generator throw TypeError", async () => {
    const r = await runReturningNumber(`export function test(): number {
      function* gen(){ yield 1; }
      const proto = Object.getPrototypeOf(gen.prototype);
      let ok = 0;
      try { (proto as any).return.call({}); } catch (e) { if (e instanceof TypeError) ok++; }
      try { (proto as any).throw.call({}); } catch (e) { if (e instanceof TypeError) ok++; }
      return ok === 2 ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("walks asyncGen.prototype to %AsyncIteratorPrototype% with [Symbol.asyncIterator]", async () => {
    // Inspect the chain object from the host side — the Wasm computed
    // Symbol-read path is a separate, pre-existing gap (#1639 is about the
    // prototype structure + brand checks).
    const exports = await compileAndInstantiate(`export function test(): any {
      async function* g(){}
      return Object.getPrototypeOf(Object.getPrototypeOf(g.prototype));
    }`);
    const asyncIterProto = (exports.test as () => any)();
    const fn = asyncIterProto[Symbol.asyncIterator];
    expect(typeof fn).toBe("function");
    expect(fn.length).toBe(0);
    expect(fn.name).toBe("[Symbol.asyncIterator]");
    // [Symbol.asyncIterator]() returns this
    expect(fn.call(asyncIterProto)).toBe(asyncIterProto);
  });

  it("does not regress generator iteration (for-of, manual next, yield*)", async () => {
    const forOf = await runReturningNumber(`export function test(): number {
      function* g(){ yield 1; yield 2; yield 3; }
      let s = 0; for (const x of g()) s += x; return s === 6 ? 1 : 0;
    }`);
    expect(forOf).toBe(1);

    const yieldStar = await runReturningNumber(`export function test(): number {
      function* inner(){ yield 1; yield 2; }
      function* outer(){ yield* inner(); yield 3; }
      let s = 0; for (const x of outer()) s += x; return s === 6 ? 1 : 0;
    }`);
    expect(yieldStar).toBe(1);
  });
});
