// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5350 r2) `super` property WRITES in `--target standalone`.
//
// §13.15.2 PutValue on a SuperProperty reference is
// `base.[[Set]](key, value, thisValue)`: the prototype chain is searched from
// the [[HomeObject]]'s [[Prototype]], a data property is created on the
// RECEIVER, and a `false` result throws a TypeError in strict code. Before r2
// the write took the ordinary member lowering with `super` as the object and
// landed nowhere. Every expected value below is node 22's answer for the same
// source, and every case asserts `result.imports` is `[]`.
//
// The cases marked "RED on base" fail on origin/main @ eb57f327 (measured with
// the file-copy A/B, see the issue record); the others are guards that pass on
// both trees and pin what the change must not move.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, sloppy = false): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    ...(sloppy ? { inferModuleStrictArguments: false } : {}),
  });
  expect(result.errors ?? []).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

describe("#5350 r2 — standalone super property writes", () => {
  // RED on base (p10 bit 2): the write created nothing on the receiver.
  it("object literal: super.x = v creates an own property on the receiver, not the prototype", async () => {
    expect(
      await runStandalone(`
var obj: any = { method() { super.x = 8; return this; } };
var r1 = obj.method() === obj ? 1 : 0;
var r2 = Object.prototype.hasOwnProperty.call(obj, 'x') ? 2 : 0;
var r3 = Object.getPrototypeOf(obj).x === undefined ? 4 : 0;
export function test(): number { return r1 + r2 + r3; }
`),
    ).toBe(7);
  });

  // RED on base (p10 bits 8 + 16): no TypeError, and no `x` on C.prototype.
  it("class: a strict write through a frozen C.prototype throws, the first write landed on it", async () => {
    expect(
      await runStandalone(`
var caught = 0;
class C {
  method() {
    super.x = 8;
    Object.freeze(C.prototype);
    try { super.y = 9; } catch (e) { caught = e instanceof TypeError ? 1 : 2; }
  }
}
C.prototype.method();
export function test(): number {
  return (caught === 1 ? 8 : 0) + (Object.prototype.hasOwnProperty.call(C.prototype, 'x') ? 16 : 0);
}
`),
    ).toBe(24);
  });

  // Guard (p10 bit 32): `super.m()` keeps the instance as its receiver.
  it("super.m() still sees the instance as this", async () => {
    expect(
      await runStandalone(`
var seen: any;
class P { m() { seen = this; } }
class Q extends P { m() { super.m(); } }
var q = new Q();
q.m();
export function test(): number { return seen === q ? 32 : 0; }
`),
    ).toBe(32);
  });

  // RED on base: sloppy mode swallows the failed write — no throw, no own `y`.
  it("sloppy object literal: a write through a frozen receiver fails silently", async () => {
    expect(
      await runStandalone(
        `
var threw = 0;
var obj: any = { method() { super.x = 8; Object.freeze(obj); super.y = 9; } };
try { obj.method(); } catch (e) { threw = 1; }
export function test(): number {
  return (Object.prototype.hasOwnProperty.call(obj, 'x') ? 1 : 0)
    + (!Object.prototype.hasOwnProperty.call(obj, 'y') ? 2 : 0)
    + (threw === 0 ? 4 : 0);
}
`,
        true,
      ),
    ).toBe(7);
  });

  // RED on base: `super[k] = v` with a dynamic and a literal key.
  it("super[k] = v writes the evaluated key onto the receiver", async () => {
    expect(
      await runStandalone(`
var k = 'z';
var o: any = { m() { super[k] = 3; super['w'] = 4; } };
o.m();
export function test(): number {
  return (o.z === 3 ? 1 : 0) + (o.w === 4 ? 2 : 0) + (Object.prototype.hasOwnProperty.call(o, k) ? 4 : 0);
}
`),
    ).toBe(7);
  });

  // Guard (green on base too — the legacy lowering wrote `super.x = v` as
  // `this.x = v`, which answers the same wherever the receiver itself has no
  // own `x`): a derived write lands on the instance; an inherited setter runs
  // with the instance as `this`.
  it("derived class: parent setter gets the receiver, a data write lands on the instance", async () => {
    expect(
      await runStandalone(`
var log = '';
var inst: any;
class A { set x(v: number) { log += 'A' + (this === inst ? 'i' : 'o') + v; } }
class B extends A { m() { super.x = 5; } }
inst = new B();
inst.m();
class A2 { f() {} }
class B2 extends A2 { m() { super.y = 7; return this; } }
var b2: any = new B2();
b2.m();
export function test(): number {
  return (log === 'Ai5' ? 1 : 0) + (b2.y === 7 ? 2 : 0)
    + (Object.prototype.hasOwnProperty.call(b2, 'y') ? 4 : 0) + ((A2.prototype as any).y === undefined ? 8 : 0);
}
`),
    ).toBe(15);
  });

  // RED on base: PutValue's ToObject(base) runs AFTER the RHS (and after the
  // key expression), so a null super base throws with the RHS already evaluated.
  it("a null super base throws a TypeError after the RHS is evaluated", async () => {
    expect(
      await runStandalone(`
var cnt = 0;
var what = 0;
var o: any = { m() { super.x = (cnt++, 1); } };
Object.setPrototypeOf(o, null);
try { o.m(); what = 1; } catch (e) { what = e instanceof TypeError ? 2 : 3; }
var k: any = { m() { super[(cnt += 10, 'x')] = (cnt += 100, 1); } };
Object.setPrototypeOf(k, null);
try { k.m(); } catch (e) { if (e instanceof TypeError) what += 10; }
export function test(): number { return what * 1000 + cnt; }
`),
    ).toBe(12111);
  });

  // RED on base: `class N extends null` — the super base is null.
  it("extends null: the write throws a TypeError after evaluating the RHS", async () => {
    expect(
      await runStandalone(`
var cnt = 0;
var what = 0;
class N extends null { m() { super.q = (cnt++, 1); } }
var inst: any = Object.create(N.prototype);
try { inst.m(); what = 1; } catch (e) { what = e instanceof TypeError ? 2 : 3; }
export function test(): number { return what * 10 + cnt; }
`),
    ).toBe(21);
  });

  // RED on base (the ReferenceError half): GetThisBinding precedes the write.
  it("derived constructor: a super write before super() is a ReferenceError; after it, it lands", async () => {
    expect(
      await runStandalone(`
class A {}
class B extends A {
  ok: number;
  constructor() {
    var ok = 0;
    try { super.x = 1; } catch (e) { ok = e instanceof ReferenceError ? 1 : 2; }
    super();
    this.ok = ok;
  }
}
class B3 extends A { constructor() { super(); super.x = 4; } }
var b3: any = new B3();
export function test(): number { return new B().ok + (b3.x === 4 ? 10 : 0); }
`),
    ).toBe(11);
  });

  // RED on base (probe a1): the receiver walk now refuses to create a property
  // on a non-extensible receiver — `Reflect.set`'s 4-argument form shares it.
  it("Reflect.set with a non-extensible receiver answers false", async () => {
    expect(
      await runStandalone(`
var fr = Object.freeze({});
var ne = Object.preventExtensions({});
export function test(): number {
  return (Reflect.set({}, 'y', 9, fr) === false ? 1 : 0)
    + (Reflect.set({}, 'y', 9, ne) === false ? 2 : 0)
    + (!Object.prototype.hasOwnProperty.call(fr, 'y') ? 4 : 0);
}
`),
    ).toBe(7);
  });
});
