// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5350 r1) `super` PROPERTY READS in `--target standalone`.
//
// Five mechanisms, each pinned against the answer node 22 gives for the same
// source. Every case asserts `result.imports` is `[]` — a standalone module
// that reaches for an `env::` import could never instantiate with `{}`, so the
// assertion is what makes "standalone" mean anything here.
//
//  1. A CLASS method's `super.<x>` / `super[<static key>]` resolves through the
//     real prototype chain (`__getPrototypeOf(C.prototype)` →
//     `__reflect_get_receiver`), not through the three static tables that used
//     to answer with a type-shaped literal.
//  2. `super[<dynamic key>]` reads, with GetSuperBase evaluated BEFORE
//     ToPropertyKey.
//  3. `class C extends null` — a super read is a TypeError, while a BASE class
//     (no `extends`) must NOT throw. The second half is the regression guard:
//     it is the shape the coercible guard would break first.
//  4. A derived constructor's `super.x` before `super()` is a ReferenceError,
//     while the same read AFTER `super()` — and one inside an arrow written
//     before `super()` but invoked after it — must still answer.
//  5. An object literal's `super.m(args)` is INVOKED with the call-time
//     receiver, rather than leaving a default where its value belongs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.errors ?? []).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

describe("#5350 r1 — standalone super property reads", () => {
  it("reads a class super property through the runtime prototype chain", async () => {
    // 1 = `super.fromB` sees B.prototype's own property, 2 = `super['fromA']`
    // walks past it to A.prototype. Node 22 answers 3.
    expect(
      await runStandalone(`
export function test(): number {
  if (1) {
    var n = 0;
    class A {}
    class B extends A {}
    class C extends B {
      method() {
        var k = 0;
        if (super.fromB === 'b') k += 1;
        if (super['fromA'] === 'a') k += 2;
        return k;
      }
    }
    (A as any).prototype.fromA = 'a';
    (B as any).prototype.fromB = 'b';
    n = (C as any).prototype.method();
    return n;
  }
  return -1;
}
`),
    ).toBe(3);
  });

  it("reads super[<dynamic key>] and applies ToPropertyKey to the key", async () => {
    // 1 = a string key, 2 = an object key whose `toString` answers "p".
    // Node 22 answers 3.
    expect(
      await runStandalone(`
export function test(): number {
  var proto: any = { p: "ok" };
  var obj: any = { __proto__: proto, m(k: any) { return super[k]; } };
  var n = 0;
  if (obj.m("p") === "ok") n += 1;
  if (obj.m({ toString() { return "p"; } }) === "ok") n += 2;
  return n;
}
`),
    ).toBe(3);
  });

  it("throws TypeError for `extends null` and stays quiet for a base class", async () => {
    // 4 = `class C extends null` threw a TypeError. The base class D must not
    // throw at all — 64 would mean the coercible guard leaked into it.
    expect(
      await runStandalone(`
export function test(): number {
  var n = 0;
  class C extends null {
    method() {
      try { (super.x as any); return 2; } catch (err) { return (err as any) instanceof TypeError ? 4 : 8; }
    }
  }
  class D {
    method() {
      try { (super.x as any); return 16; } catch (err) { return 64; }
    }
  }
  n = (C as any).prototype.method() + (D as any).prototype.method();
  return n;
}
`),
    ).toBe(20);
  });

  it("throws ReferenceError only for a super read that cannot have run after super()", async () => {
    // 1 = read before `super()` threw a ReferenceError; 4 = the read after
    // `super()` answered; 32 = an arrow written before `super()` but invoked
    // after it answered. Node 22 answers 37 for exactly this source.
    expect(
      await runStandalone(`
export function test(): number {
  var n = 0;
  class C extends Object {
    constructor() {
      try { (super.x as any); } catch (err) { n += (err as any) instanceof ReferenceError ? 1 : 2; }
      super();
    }
  }
  try { new (C as any)(); } catch (_) {}
  class D extends Object {
    constructor() {
      super();
      try { (super.y as any); n += 4; } catch (err) { n += 8; }
    }
  }
  try { new (D as any)(); } catch (_) { n += 16; }
  class E extends Object {
    constructor() {
      var f = () => (super.z as any);
      super();
      try { f(); n += 32; } catch (err) { n += 64; }
    }
  }
  try { new (E as any)(); } catch (_) { n += 128; }
  return n;
}
`),
    ).toBe(37);
  });

  it("invokes an object literal's super method with the call-time receiver", async () => {
    // 1 = `super.getThis()` returned the receiver (not a default), 2 = the
    // inherited accessor sees the same receiver, 8 = arguments are forwarded.
    // Node 22 answers 11.
    expect(
      await runStandalone(`
export function test(): number {
  var parent: any = {
    getThis: function () { return this; },
    add: function (a: any, b: any) { return a + b; },
    get This() { return this; },
  };
  var obj: any = {
    method() {
      var k = 0;
      var viaCall = super.getThis();
      var viaMember = super.This;
      if (viaCall === obj) k += 1;
      if (viaMember === obj) k += 2;
      if (viaCall === null) k += 4;
      if (super.add(2, 3) === 5) k += 8;
      return k;
    },
  };
  Object.setPrototypeOf(obj, parent);
  return obj.method();
}
`),
    ).toBe(11);
  });

  // ── Review round 1 (2026-09-06) ────────────────────────────────────────
  //
  // F1: `super` over a literal whose prototype is set with the §B.3.1
  // `__proto__:` colon form. The literal used to build as a closed struct, so
  // its runtime [[Prototype]] was never linked and `__getPrototypeOf(home)`
  // answered nullish — a silent wrong default before the lane, an ESCAPING
  // TypeError after it. Node 22 answers 3 / 3 / 11 / 8 for these four.
  it("calls a super method over a `__proto__:` object literal", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var proto: any = { m() { return 3; } };
  var o: any = { __proto__: proto, m() { return super.m(); } };
  return o.m();
}
`),
    ).toBe(3);
  });

  it("resolves a differently-named super method over a `__proto__:` literal", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var proto: any = { p() { return 3; } };
  var o: any = { __proto__: proto, m() { return super.p(); } };
  return o.m();
}
`),
    ).toBe(3);
  });

  it("binds `this` to the call-time receiver in a `__proto__:` literal super call", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var proto: any = { who() { return this.tag; } };
  var o: any = { __proto__: proto, tag: 11, m() { return super.who(); } };
  return o.m();
}
`),
    ).toBe(11);
  });

  it("reads a super DATA property over a `__proto__:` literal", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var proto: any = { v: 8 };
  var o: any = { __proto__: proto, m() { return super.v; } };
  return o.m();
}
`),
    ).toBe(8);
  });

  // F2: the uninitialised-`this` guard is lexical, and source position orders
  // the TEXT, not the execution. On a loop's back-edge the read runs AFTER
  // `super()`, so the unconditional throw was a false positive. Node 22
  // answers 5 for both; the second proves no ReferenceError is raised at all.
  it("does not throw for a super read reached on a loop back-edge", async () => {
    expect(
      await runStandalone(`
class A { a: number; constructor() { this.a = 1; } }
class B extends A {
  b: number;
  constructor() {
    let i = 0;
    let v: any;
    while (true) {
      if (i === 1) { v = (super.zz as any); break; }
      super();
      i = 1;
    }
    this.b = v === undefined ? 5 : 6;
  }
}
export function test(): number { return new B().b; }
`),
    ).toBe(5);
  });

  it("raises no ReferenceError for that back-edge read", async () => {
    expect(
      await runStandalone(`
class A { a: number; constructor() { this.a = 1; } }
class B extends A {
  b: number;
  constructor() {
    let i = 0; let v: any; let t = 0;
    while (true) {
      if (i === 1) { try { v = (super.zz as any); } catch (e) { t = e instanceof ReferenceError ? 8 : 9; } break; }
      super();
      i = 1;
    }
    this.b = t === 0 ? (v === undefined ? 5 : 6) : t;
  }
}
export function test(): number { return new B().b; }
`),
    ).toBe(5);
  });

  it("still throws ReferenceError for a straight-line read before super()", async () => {
    // The narrowing must not cost the genuine case: with no loop over it, the
    // text order IS the execution order. Node 22 answers 8.
    expect(
      await runStandalone(`
class A { a: number; constructor() { this.a = 1; } }
class B extends A {
  b: number;
  constructor() {
    const v: any = (super.zz as any);
    super();
    this.b = v === undefined ? 5 : 6;
  }
}
export function test(): number {
  try { return new B().b; } catch (e) { return e instanceof ReferenceError ? 8 : 9; }
}
`),
    ).toBe(8);
  });

  it("keeps a base class's super read answering without a throw", async () => {
    // The acceptance criterion's own regression guard: `class B {}` has no
    // parent, so `super.anything` must complete. 1 = it did.
    expect(
      await runStandalone(`
export function test(): number {
  class B {
    method() {
      try { (super.missing as any); return 1; } catch (err) { return 2; }
    }
  }
  return (B as any).prototype.method();
}
`),
    ).toBe(1);
  });
});
