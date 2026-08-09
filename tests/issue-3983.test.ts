// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3983 — standalone strict [[Set]] must throw a catchable TypeError.
//
// `__extern_set_strict` used to be a bare `ctx.funcMap` alias of `__extern_set`,
// whose refusals are all silent `return`s. So in standalone mode every strict
// write that ES §6.2.5.6 steps 3.d–e require to throw did nothing instead. The
// front end already routed strict vs sloppy to the two distinct names; only the
// standalone registration collapsed them.
//
// Two things these tests are deliberately careful about, both of which produced
// a confidently wrong answer during the investigation:
//
//  1. **No `as any` casts on the receiver.** test262 has none, and a cast can
//     defeat the very gate under test.
//  2. **Numeric return codes only.** A `string` returned from an exported
//     standalone function does not marshal across the JS boundary — it comes
//     back `undefined` for EVERY case including the positive control.
//
// The write is placed inside a nested callback (the `assert.throws(TypeError,
// function () { … })` shape test262 actually uses) in the accessor cases,
// because a write in the SAME function as a statically visible
// `Object.defineProperty(o, "p", {writable:false})` is constant-folded into an
// unconditional `throw` by the #3872 static mirror — which would make these
// tests pass without the runtime path working at all.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** 20 = threw a TypeError · 21 = threw something else · 10/11 = no throw. */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Standalone must stay host-free: the TypeError is constructed natively.
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#3983 standalone strict [[Set]] throws a catchable TypeError", () => {
  it("throws on assignment to an own accessor with set: undefined", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const o: any = {};
          Object.defineProperty(o, "p", {
            get: function () { return 11; },
            set: undefined,
            enumerable: true,
            configurable: true
          });
          const write = function (): void { o.p = 2; };
          try { write(); } catch (e) { return e instanceof TypeError ? 20 : 21; }
          return 10;
        }
      `),
    ).toBe(20);
  });

  it("throws on a COMPOUND assignment to a setter-less accessor (11.13.2-40-s)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const o: any = {};
          Object.defineProperty(o, "p", {
            get: function () { return 11; },
            set: undefined,
            enumerable: true,
            configurable: true
          });
          const write = function (): void { o.p >>= 20; };
          try { write(); } catch (e) { return e instanceof TypeError ? 20 : 21; }
          return 10;
        }
      `),
    ).toBe(20);
  });

  it("throws on assignment to an own writable:false data property", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const o: any = {};
          Object.defineProperty(o, "p", { value: 1, writable: false, enumerable: true, configurable: true });
          const write = function (): void { o.p = 2; };
          try { write(); } catch (e) { return e instanceof TypeError ? 20 : 21; }
          return 10;
        }
      `),
    ).toBe(20);
  });

  it("throws on a data write to a frozen object", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const o: any = { p: 1 };
          Object.freeze(o);
          const write = function (): void { o.p = 2; };
          try { write(); } catch (e) { return e instanceof TypeError ? 20 : 21; }
          return 10;
        }
      `),
    ).toBe(20);
  });

  it("throws on a NEW key added to a non-extensible object", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const o: any = {};
          Object.preventExtensions(o);
          const write = function (): void { o.q = 1; };
          try { write(); } catch (e) { return e instanceof TypeError ? 20 : 21; }
          return 10;
        }
      `),
    ).toBe(20);
  });
});

// The no-throw side is the part that can silently break: `__reflect_set`
// answers FALSE for every receiver that is not a `$Object` — arrays, closures,
// proxies, host carriers — and those writes are legal. A strict setter that
// threw on `__reflect_set === 0` unconditionally would turn `a[0] = 1` into a
// TypeError. Each case returns 1 on the correct (non-throwing) outcome.
describe("#3983 legal strict writes must NOT throw", () => {
  const cases: [string, string][] = [
    [
      "array element write",
      `const a: any = [9, 9, 9];
       try { a[0] = 1; } catch (e) { return 90; }
       return a[0] === 1 ? 1 : 0;`,
    ],
    [
      "array write past the end",
      `const a: any = [1];
       try { a[3] = 7; } catch (e) { return 90; }
       return a[3] === 7 ? 1 : 0;`,
    ],
    [
      "named expando on an array",
      `const a: any = [1, 2];
       try { a.tag = 5; } catch (e) { return 90; }
       return a.tag === 5 ? 1 : 0;`,
    ],
    [
      "named expando on a function",
      `const g: any = function () { return 1; };
       try { g.tag = 5; } catch (e) { return 90; }
       return g.tag === 5 ? 1 : 0;`,
    ],
    [
      "write through an own accessor WITH a setter",
      `const o: any = {};
       let seen: number = 0;
       Object.defineProperty(o, "p", {
         get: function () { return seen; },
         set: function (v: number) { seen = v * 2; },
         configurable: true
       });
       try { o.p = 4; } catch (e) { return 90; }
       return o.p === 8 ? 1 : 0;`,
    ],
    [
      "existing key on a SEALED (not frozen) object still lands",
      `const o: any = { a: 1 };
       Object.seal(o);
       try { o.a = 3; } catch (e) { return 90; }
       return o.a === 3 ? 1 : 0;`,
    ],
    [
      "write through a Proxy set trap",
      `const t: any = {};
       let hits: number = 0;
       const p: any = new Proxy(t, {
         set: function (o: any, k: any, v: any): boolean { hits = hits + 1; o[k] = v; return true; }
       });
       try { p.a = 3; } catch (e) { return 90; }
       return hits === 1 && t.a === 3 ? 1 : 0;`,
    ],
    [
      "computed-key write with a dynamic key",
      `const o: any = {};
       const k: any = "z";
       try { o[k] = 3; } catch (e) { return 90; }
       return o.z === 3 ? 1 : 0;`,
    ],
    [
      "write to a defineProperty'd writable:true property",
      `const o: any = {};
       Object.defineProperty(o, "p", { value: 1, writable: true, configurable: true });
       const write = function (): void { o.p = 3; };
       try { write(); } catch (e) { return 90; }
       return o.p === 3 ? 1 : 0;`,
    ],
  ];

  for (const [name, bodySrc] of cases) {
    it(name, async () => {
      expect(await runStandalone(`export function f(): number { ${bodySrc} }`)).toBe(1);
    });
  }
});
