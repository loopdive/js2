// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6772 — ES2015 standalone class residue. One probe per mechanism step, each
// the minimal shape of its test262 row(s). Every "RED on base" case records the
// value `origin/main` @ 08e61b2644 answered and asserts node's answer; every
// guard case asserts an answer base already gave, to hold order preservation.
//
// Probes run standalone (`imports: []`) with the top-level code deferred into
// `__module_init`, then read the module's `__r` accumulator.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runProbe(body: string): Promise<unknown> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports ?? [], "#6772 probes must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6772 S1a — super(...) publishes extras to a parent that reads `arguments`", () => {
  it("RED on base (0): the super(1, 2) site into a zero-formal parent (node 2121)", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = seen * 100 + arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        class Sub2 extends Base { constructor(x, y){ super(1, 2); } }
        new Sub(3, 4);
        new Sub2(3, 4);
        __r = seen;
      `),
    ).toBe(2121);
  });

  it("guard (base 21): the direct new Base(1, 2) site is unchanged", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        new Base(1, 2);
        __r = seen;
      `),
    ).toBe(21);
  });
});

describe("#6772 S1b — derived-constructor GetThisBinding / BindThisValue", () => {
  it("RED on base (0): `this.x = v` before super() throws ReferenceError (node 3)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){} }
        class D extends Base {
          constructor(){
            var e;
            try { this.x = 3; } catch (err) { e = err; }
            super();
            __r = (e instanceof ReferenceError) ? 1 : 0;
            __r += (this.x === undefined) ? 2 : 0;
          }
        }
        new D();
      `),
    ).toBe(3);
  });

  it("RED on base (0): `this` / super.x / super.m() / super() inside and before super(...) (node 63)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(a){} }
        var r = 0;
        try { class C extends Base { constructor(){ super(this.x); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 1 : 0; }
        try { class C extends Base { constructor(){ super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 2 : 0; }
        try { class C extends Base { constructor(){ super(super()); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 4 : 0; }
        try { class C extends Base { constructor(){ super.method(); super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 8 : 0; }
        try { class C extends Base { constructor(){ super(super.method()); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 16 : 0; }
        try { class C extends Base { constructor(){ super(1, 2, Object.getPrototypeOf(this)); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 32 : 0; }
        __r = r;
      `),
    ).toBe(63);
  });

  it("RED on base (14): a second super() runs the parent, then throws; `this` unchanged (node 15)", async () => {
    expect(
      await runProbe(`
        var baseCalled = 0; var fCalled = 0;
        class Base { constructor(){ baseCalled++; } }
        function f(){ fCalled++; return 3; }
        class S extends Base {
          constructor(){
            super();
            var obj = this; var exn = null; baseCalled = 0;
            try { super(f()); } catch (e) { exn = e; }
            __r = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 1 ? 2 : 0) + (baseCalled === 1 ? 4 : 0) + (this === obj ? 8 : 0);
          }
        }
        new S();
      `),
    ).toBe(15);
  });

  it("RED on base (133): the nested shapes super(super(), f()) and super(f(), super()) (node 3333)", async () => {
    // Each digit: ReferenceError (1) + fCalled matches node (1) + baseCalled === 1 (1),
    // per shape; the inner super() runs Base and throws at its own completion.
    expect(
      await runProbe(`
        var baseCalled = 0; var fCalled = 0;
        class Base { constructor(){ baseCalled++; } }
        function f(){ fCalled++; return 3; }
        class S extends Base {
          constructor(){
            super();
            var exn = null; baseCalled = 0; fCalled = 0;
            try { super(super(), f()); } catch (e) { exn = e; }
            var a = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 0 ? 1 : 0) + (baseCalled === 1 ? 1 : 0);
            exn = null; baseCalled = 0; fCalled = 0;
            try { super(f(), super()); } catch (e) { exn = e; }
            var b = (exn instanceof ReferenceError ? 1 : 0) + (fCalled === 1 ? 1 : 0) + (baseCalled === 1 ? 1 : 0);
            __r = a * 1000 + b * 100 + 33;
          }
        }
        new S();
      `),
    ).toBe(3333);
  });

  it("RED on base (880): compound / update / element writes and a bare read of `this` before super() (node 1023)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ this.b = 1; } }
        var r = 0;
        try { class C extends Base { constructor(){ this.x += 1; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 1 : 0; }
        try { class C extends Base { constructor(){ this.x++; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 2 : 0; }
        try { class C extends Base { constructor(){ var k = 'y'; this[k] = 3; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 4 : 0; }
        try { class C extends Base { constructor(){ var t = this; super(); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 8 : 0; }
        class A1 extends Base { constructor(){ var f = () => this.b; super(); this.v = f(); } }
        r += (new A1().v === 1) ? 16 : 0;
        class F1 extends Base { x = 5; constructor(){ super(); this.y = this.x + this.b; } }
        r += (new F1().y === 6) ? 32 : 0;
        try { class L extends Base { constructor(){ for (var i = 0; i < 2; i++) { if (i === 1) { this.q = 1; break; } super(); } } } var l = new L(); r += (l.q === 1) ? 64 : 0; } catch (e) { r += 0; }
        try { class L2 extends Base { constructor(){ for (var i = 0; i < 2; i++) super(); } } new L2(); } catch (e) { r += (e instanceof ReferenceError) ? 128 : 0; }
        class Br extends Base { constructor(a){ if (a) super(); else super(); this.z = 2; } }
        r += (new Br(1).z === 2 && new Br(0).z === 2) ? 256 : 0;
        class I extends Base {}
        r += (new I().b === 1) ? 512 : 0;
        __r = r;
      `),
    ).toBe(1023);
  });

  it("guard: a plain derived class with one straight-line super() allocates no flag", async () => {
    const result = await compile(
      `class Base { constructor(){ this.b = 1; } }
       class D extends Base { constructor(){ super(); this.c = this.b + 1; } }
       export function probe() { return new D().c; }`,
      { target: "standalone", fileName: "guard.js", allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(Buffer.from(result.binary).includes(Buffer.from("__js2_super_done"))).toBe(false);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { probe: () => number }).probe()).toBe(2);
  });
});

describe("#6772 S2 \u2014 constructor return-override channel", () => {
  it("RED on base (8): foreign-object override \u2014 base / inherited / derived / extends-null (node 63)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(a,b){ var o = new Object(); o.prp = a + b; return o; } }
        var b = new Base(1,2);
        var r = (b.prp === 3) ? 1 : 0;
        var obj = {};
        class Base3 { constructor(){ return obj; } }
        class Sub3 extends Base3 {}
        var s3 = new Sub3();
        r += (s3 === obj) ? 2 : 0;
        class B2 { constructor(){ this.prop = 1; } }
        class D2 extends B2 { constructor(){ super(); return {}; } }
        var o2 = new D2();
        r += (typeof o2.prop === 'undefined') ? 4 : 0;
        r += (o2 instanceof D2) ? 0 : 8;
        var obj2;
        class Foo extends null { constructor(){ return obj2 = {}; } }
        var f = new Foo();
        r += (f === obj2) ? 16 : 0;
        r += (Object.getPrototypeOf(f) === Object.prototype) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });

  it("RED on base (4608): this-access-restriction-2 distilled \u2014 override, derived `this`, second super() (node 8191)", async () => {
    expect(
      await runProbe(`
        var r = 0;
        class Base {
          constructor(a, b) {
            var o = new Object();
            o.prp = a + b;
            return o;
          }
        }
        class Subclass extends Base {
          constructor(a, b) {
            var exn;
            try { this.prp1 = 3; } catch (e) { exn = e; }
            r += (exn instanceof ReferenceError) ? 1 : 0;
            super(a, b);
            r += (this.prp === a + b) ? 2 : 0;
            r += (this.prp1 === undefined) ? 4 : 0;
            r += (this.hasOwnProperty("prp1") === false) ? 8 : 0;
            return this;
          }
        }
        var b = new Base(1, 2);
        r += (b.prp === 3) ? 16 : 0;
        var s = new Subclass(2, -1);
        r += (s.prp === 1) ? 32 : 0;
        r += (s.prp1 === undefined) ? 64 : 0;
        r += (s.hasOwnProperty("prp1") === false) ? 128 : 0;
        class Subclass2 extends Base {
          constructor(x) {
            super(1, 2);
            if (x < 0) return;
            var called = false;
            function tmp() { called = true; return 3; }
            var exn = null;
            try { super(tmp(), 4); } catch (e) { exn = e; }
            r += (exn instanceof ReferenceError) ? 256 : 0;
            r += (called === true) ? 512 : 0;
          }
        }
        var s2 = new Subclass2(1);
        r += (s2.prp === 3) ? 1024 : 0;
        var s3 = new Subclass2(-1);
        r += (s3.prp === 3) ? 2048 : 0;
        class BadSubclass extends Base { constructor() {} }
        try { new BadSubclass(); } catch (e) { r += (e instanceof ReferenceError) ? 4096 : 0; }
        __r = r;
      `),
    ).toBe(8191);
  });

  it("RED on base (4): `typeof` / reads of a declared field off the override object (node 7)", async () => {
    expect(
      await runProbe(`
        class B2 { constructor(){ this.prop = 1; } }
        class D2 extends B2 { constructor(){ super(); return {}; } }
        var o2 = new D2();
        var r = 0;
        r += (typeof o2.prop === 'undefined') ? 1 : 0;
        var t = typeof o2.prop;
        r += (t === 'undefined') ? 2 : 0;
        r += (o2.prop === undefined) ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (10): `return {}` is a plain object, not the class's own struct (node 7)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ return {}; } }
        var r = 0;
        var b = new Base();
        r += (b instanceof Base) ? 0 : 1;
        r += (typeof b === "object") ? 2 : 0;
        var p = Object.getPrototypeOf(b);
        r += (p === Object.prototype) ? 4 : 0;
        r += (p === Base.prototype) ? 8 : 0;
        r += (p === null) ? 16 : 0;
        r += (p === undefined) ? 32 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (7): getPrototypeOf / instanceof through a marked parent (node 31)", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(){ this.x = 1; if (flag) return {}; } m() { return 1; } }
        class Sub extends Base { constructor(){ super(); } }
        var r = 0;
        var b = new Base();
        r += (Object.getPrototypeOf(b) === Base.prototype) ? 1 : 0;
        var s = new Sub();
        r += (Object.getPrototypeOf(s) === Sub.prototype) ? 2 : 0;
        r += (s instanceof Base && s instanceof Sub) ? 4 : 0;
        flag = true;
        var s2 = new Sub();
        r += (Object.getPrototypeOf(s2) === Object.prototype) ? 8 : 0;
        r += (s2 instanceof Sub) ? 0 : 16;
        __r = r;
      `),
    ).toBe(31);
  });

  it("RED on base (63): a non-overriding instance keeps fields, methods, accessor, instanceof (node 255)", async () => {
    expect(
      await runProbe(`
        var flag = false;
        var other = { prp: 99 };
        class Base {
          constructor(a) { this.x = a; this.y = a + 1; if (flag) return other; }
          m() { return this.x * 10; }
          get g() { return this.y; }
          static s() { return 5; }
        }
        var r = 0;
        var b = new Base(3);
        r += (b.x === 3) ? 1 : 0;
        r += (b.m() === 30) ? 2 : 0;
        r += (b instanceof Base) ? 4 : 0;
        r += (b.g === 4) ? 8 : 0;
        b.x = 7;
        r += (b.m() === 70) ? 16 : 0;
        r += (Base.s() === 5) ? 32 : 0;
        flag = true;
        var c = new Base(1);
        r += (c === other && c.prp === 99) ? 64 : 0;
        r += (c instanceof Base) ? 0 : 128;
        __r = r;
      `),
    ).toBe(255);
  });

  it("RED on base (63): writes / compound / update / setter / private on a marked class (node 255)", async () => {
    expect(
      await runProbe(`
        var sink = null;
        class Base {
          #p = 5;
          constructor(a, o) { this.x = a; this._v = 0; if (o) return o; }
          get v() { return this._v; }
          set v(n) { this._v = n * 2; }
          peek() { return this.#p; }
          static has(o) { return #p in o; }
        }
        var r = 0;
        var b = new Base(3);
        b.x = 10;
        r += (b.x === 10) ? 1 : 0;
        b.x += 5;
        r += (b.x === 15) ? 2 : 0;
        b.x++;
        r += (b.x === 16) ? 4 : 0;
        b.v = 4;
        r += (b.v === 8 && b._v === 8) ? 8 : 0;
        r += (b.peek() === 5) ? 16 : 0;
        r += (Base.has(b)) ? 32 : 0;
        var o = {};
        var c = new Base(1, o);
        c.x = 9;
        r += (o.x === 9) ? 64 : 0;
        r += (Base.has(c)) ? 0 : 128;
        __r = r;
      `),
    ).toBe(255);
  });

  it("guard (base 63): a derived class of a marked base that does not override at runtime", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(v){ this.v = v; if (flag) return { v: -1, getV: function () { return -1; } }; } getV() { return this.v; } }
        class Sub extends Base {
          constructor(v){
            super(v);
            this.w = this.v * 2;
            this.z = this.getV() + 1;
            var f = () => this.w;
            this.q = f();
          }
          sum() { return this.v + this.w; }
        }
        var r = 0;
        var s = new Sub(3);
        r += (s.v === 3) ? 1 : 0;
        r += (s.w === 6) ? 2 : 0;
        r += (s.z === 4) ? 4 : 0;
        r += (s.q === 6) ? 8 : 0;
        r += (s.sum() === 9) ? 16 : 0;
        r += (s instanceof Sub && s instanceof Base) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });

  it("guard (base 31): getPrototypeOf of a marked class OBJECT and its prototype keeps the class folds", async () => {
    expect(
      await runProbe(`
        var flag = false;
        class Base { constructor(){ this.x = 1; if (flag) return {}; } }
        class Sub extends Base { constructor(){ super(); } }
        var C = class { constructor(){ if (flag) return {}; } };
        var r = 0;
        r += (Object.getPrototypeOf(Base) === Function.prototype) ? 1 : 0;
        r += (Object.getPrototypeOf(Base.prototype) === Object.prototype) ? 2 : 0;
        r += (Object.getPrototypeOf(Sub.prototype) === Base.prototype) ? 4 : 0;
        r += (Object.getPrototypeOf(C) === Function.prototype) ? 8 : 0;
        r += (Object.getPrototypeOf(C.prototype) === Object.prototype) ? 16 : 0;
        __r = r;
      `),
    ).toBe(31);
  });

  it("RESIDUAL (base 0, node 31): a class METHOD read / call on the foreign override object resolves against the class", async () => {
    // Data members of a marked-class binding read dynamically; declared methods
    // keep the struct dispatch, so `c.m()` / `typeof d.m` miss the override
    // object's own shape (bits 2 and 16).
    expect(
      await runProbe(`
        var other = { x: 42, m: function () { return 7; } };
        var empty = {};
        class Base {
          constructor(a, o) { this.x = a; return o; }
          m() { return 1; }
        }
        var r = 0;
        var c = new Base(3, other);
        r += (c.x === 42) ? 1 : 0;
        r += (c.m() === 7) ? 2 : 0;
        var d = new Base(3, empty);
        r += (typeof d.x === "undefined") ? 4 : 0;
        r += (d.x === undefined) ? 8 : 0;
        r += (typeof d.m === "undefined") ? 16 : 0;
        __r = r;
      `),
    ).toBe(13);
  });

  it("RESIDUAL (base 2, node 15): `this.m()` in a derived frame after an overriding super() hits the nominal receiver guard", async () => {
    // `this.v` reads the override object (bit 1); `this.w = 5` writes the
    // discarded struct (bit 2 only observes that it does not throw); the
    // declared-method call throws TypeError (10000) instead of calling the
    // override object's own `getV`.
    expect(
      await runProbe(`
        var flag = true;
        var r = 0;
        class Base { constructor(v){ this.v = v; if (flag) return { v: -1, getV: function () { return -1; } }; } getV() { return this.v; } }
        class Sub extends Base {
          constructor(v){
            super(v);
            try { r += (this.v === -1) ? 1 : 0; } catch (e) { r += 100; }
            try { this.w = 5; r += 2; } catch (e) { r += 1000; }
            try { r += (this.getV() === -1) ? 4 : 0; } catch (e) { r += 10000; }
          }
        }
        try { var t = new Sub(3); r += (t.v === -1) ? 8 : 0; } catch (e) { r += 100000; }
        __r = r;
      `),
    ).toBe(10011);
  });
});

describe("#6772 S3 — class constructors invoked through call / apply throw", () => {
  it("RED on base (0): C.apply / C.call on a base and a derived class throw TypeError (node 15)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ } }
        class Derived extends Base {}
        var r = 0;
        var obj = {};
        try { Derived.apply(obj, new Array(100)); } catch (e) { r += (e instanceof TypeError) ? 1 : 0; }
        try { Derived.call(obj, 1, 2); } catch (e) { r += (e instanceof TypeError) ? 2 : 0; }
        try { Base.call(new Object(), 1, 2); } catch (e) { r += (e instanceof TypeError) ? 4 : 0; }
        try { Base.apply(obj, []); } catch (e) { r += (e instanceof TypeError) ? 8 : 0; }
        __r = r;
      `),
    ).toBe(15);
  });

  it("RED on base (internal compile error): Function.prototype.call.call(C, …) throws TypeError (node 2)", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ } }
        var r = 0;
        try { Function.prototype.call.call(Base, {}); r += 100; } catch (e) { r += (e instanceof TypeError) ? 2 : 1000; }
        __r = r;
      `),
    ).toBe(2);
  });

  it("guard (base 31): a static call / apply member wins; plain functions keep call / apply", async () => {
    expect(
      await runProbe(`
        class A { static call(x) { return x + 1; } }
        class B extends A {}
        class C { static apply(t, a) { return a.length; } }
        function f(a, b) { return this.k + a + b; }
        var r = 0;
        r += (A.call(1) === 2) ? 1 : 0;
        r += (B.call(2) === 3) ? 2 : 0;
        r += (C.apply(null, [1, 2, 3]) === 3) ? 4 : 0;
        r += (f.call({ k: 1 }, 2, 3) === 6) ? 8 : 0;
        r += (f.apply({ k: 1 }, [2, 3]) === 6) ? 16 : 0;
        __r = r;
      `),
    ).toBe(31);
  });

  it("RESIDUAL (base 100, node 1): Reflect.apply(C, …) does not throw", async () => {
    expect(
      await runProbe(`
        class Base { constructor(){ } }
        var r = 0;
        try { Reflect.apply(Base, {}, []); r += 100; } catch (e) { r += (e instanceof TypeError) ? 1 : 1000; }
        __r = r;
      `),
    ).toBe(100);
  });
});

describe("#6772 S4 — a member named `new` / `init` does not take the allocator's funcMap key", () => {
  it("RED on base (invalid Wasm): escaped and plain `new()` methods, class expression and declaration (node 4242)", async () => {
    expect(
      await runProbe(`
        var C1 = class { n\\u0065w() { return 42; } };
        class C2 { new() { return 42; } other() { return 7; } }
        __r = new C1()['new']() * 100 + new C2().new();
      `),
    ).toBe(4242);
  });

  it("RED on base (invalid Wasm): dot / element / value reads of `new` and `init`; name, length, instanceof (node 127)", async () => {
    expect(
      await runProbe(`
        class C { new() { return 42; } init() { return 5; } }
        var obj = new C();
        var r = 0;
        try { r += (obj.new() === 42) ? 1 : 0; } catch (e) { r += 1000; }
        try { r += (obj['new']() === 42) ? 2 : 0; } catch (e) { r += 2000; }
        try { r += (obj.init() === 5) ? 4 : 0; } catch (e) { r += 4000; }
        try { r += (typeof obj.new === 'function') ? 8 : 0; } catch (e) { r += 8000; }
        try { r += (C.name === 'C' && C.length === 0) ? 16 : 0; } catch (e) { r += 16000; }
        try { r += (obj instanceof C) ? 32 : 0; } catch (e) { r += 32000; }
        try { var f = obj.new; r += (f.call(obj) === 42) ? 64 : 0; } catch (e) { r += 64000; }
        __r = r;
      `),
    ).toBe(127);
  });

  it("RED on base (invalid Wasm): static `new`, a derived `init` method, static + instance `init` (node 63)", async () => {
    expect(
      await runProbe(`
        class A { static new() { return 1; } constructor(x) { this.x = x; } }
        class B extends A { constructor() { super(7); this.y = 2; } init() { return this.x + this.y; } }
        class D { init(a) { return a * 2; } static init() { return 3; } }
        var r = 0;
        try { r += (A.new() === 1) ? 1 : 0; } catch (e) { r += 1000; }
        try { var b = new B(); r += (b.init() === 9) ? 2 : 0; } catch (e) { r += 2000; }
        try { r += (b.x === 7 && b.y === 2) ? 4 : 0; } catch (e) { r += 4000; }
        try { r += (new D().init(4) === 8) ? 8 : 0; } catch (e) { r += 8000; }
        try { r += (D.init() === 3) ? 16 : 0; } catch (e) { r += 16000; }
        try { r += (new A(5).x === 5) ? 32 : 0; } catch (e) { r += 32000; }
        __r = r;
      `),
    ).toBe(63);
  });

  it("guard (base 3): a subclass inherits `new` / `init` methods", async () => {
    expect(
      await runProbe(`
        class A { new() { return 1; } init() { return 2; } }
        class B extends A {}
        var b = new B();
        var r = 0;
        try { r += (b.new() === 1) ? 1 : 0; } catch (e) { r += 100; }
        try { r += (b.init() === 2) ? 2 : 0; } catch (e) { r += 200; }
        __r = r;
      `),
    ).toBe(3);
  });

  it("RED on base (IR compile error): a typed class the IR path claims projects `new` / `init` onto member slots (50)", async () => {
    const source = `
      class C {
        x: number;
        constructor(x: number) { this.x = x; }
        new(): number { return 42; }
        init(a: number): number { return a + this.x; }
      }
      export function test(): number { const c = new C(3); return c.new() + c.init(5); }
    `;
    for (const target of ["standalone", undefined] as const) {
      const result = await compile(source, { ...(target ? { target } : {}), fileName: "probe.ts" });
      expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      expect((instance.exports as { test: () => number }).test()).toBe(50);
    }
  });
});

describe("#6772 S5 — a folded computed key still runs its assignment at ClassDefinitionEvaluation", () => {
  it("RED on base (14): top-level declaration, method + static method keys `[x = 1]` (node 15)", async () => {
    expect(
      await runProbe(`
        let x = 0;
        class C { [x = 1]() { return 2; } static [x = 1]() { return 3; } }
        var r = (x === 1) ? 1 : 0;
        let c = new C();
        r += (c[x = 1]() === 2) ? 2 : 0;
        r += (C[x = 1]() === 3) ? 4 : 0;
        r += (c[String(x = 1)]() === 2) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("RED on base (0): class expressions at top level and in functions, accessor keys (node 7)", async () => {
    expect(
      await runProbe(`
        let x = 0;
        let C = class { get [x = 1]() { return 2; } static set [x = 1](v) {} };
        var r = (x === 1) ? 1 : 0;
        function g() { let y = 0; var D = class { get [y = 1]() { return 2; } }; return y; }
        r += (g() === 1) ? 2 : 0;
        function h() { let y = 0; let D = class { [y = 'b']() { return 2; } }; return y === 'b' && new D().b() === 2; }
        r += h() ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (0): the write runs in member order between runtime-keyed members (node 1)", async () => {
    expect(
      await runProbe(`
        var log = [];
        function k() {
          let y = 0;
          class A { [(log.push('a'), 'p')]() {} [y = 'q']() {} [(log.push('c'), 'r')]() {} }
          return log.join() + ':' + y;
        }
        __r = k() === 'a,c:q' ? 1 : 0;
      `),
    ).toBe(1);
  });
});

describe("#6772 S6 — comma heritage and Object.getPrototypeOf of a derived class", () => {
  it("RED on base (compile error): `extends (calls++, C)` runs once, links C, and getPrototypeOf(D) is C (node 1015)", async () => {
    expect(
      await runProbe(`
        var calls = 0;
        class C { m() { return 7; } }
        class D extends (calls++, C) {}
        var r = calls * 1000;
        r += (new D().m() === 7) ? 1 : 0;
        r += (new D() instanceof C) ? 2 : 0;
        r += (Object.getPrototypeOf(D) === C) ? 4 : 0;
        r += (Object.getPrototypeOf(D.prototype) === C.prototype) ? 8 : 0;
        __r = r;
      `),
    ).toBe(1015);
  });

  it("RED on base (448): chains, class-expression parents and bindings, nested and class-expression comma heritages (node 1023)", async () => {
    expect(
      await runProbe(`
        var calls = 0;
        class C { m() { return 7; } }
        var CE = class { n() { return 8; } };
        class D extends C {}
        class E extends D {}
        var F = class extends C {};
        class G extends CE {}
        function inner() { class H extends (calls++, C) {} return [H, Object.getPrototypeOf(H) === C, new H().m()]; }
        var H2 = class extends (calls++, calls++, C) {};
        var r = 0;
        r += (Object.getPrototypeOf(E) === D) ? 1 : 0;
        r += (Object.getPrototypeOf(F) === C) ? 2 : 0;
        r += (Object.getPrototypeOf(G) === CE) ? 4 : 0;
        var ii = inner();
        r += (ii[1] && ii[2] === 7) ? 8 : 0;
        r += (calls === 3) ? 16 : 0;
        r += (Object.getPrototypeOf(H2) === C && new H2().m() === 7) ? 32 : 0;
        r += (Object.getPrototypeOf(C) === Function.prototype) ? 64 : 0;
        r += (new G().n() === 8) ? 128 : 0;
        r += (Object.getPrototypeOf(E.prototype) === D.prototype) ? 256 : 0;
        r += (typeof Object.getPrototypeOf(D) === 'function') ? 512 : 0;
        __r = r;
      `),
    ).toBe(1023);
  });

  it("guard (base 0, node 7): a parameter heritage and a rewritten derived binding decline the fold", async () => {
    expect(
      await runProbe(`
        class C {}
        var r = 0;
        function mk(P) { class K extends P {} return K; }
        var K = mk(C);
        r += (Object.getPrototypeOf(K) === C) ? 1 : 0;
        class X extends C {}
        var saved = X;
        X = 5;
        r += (Object.getPrototypeOf(saved) === C) ? 2 : 0;
        r += (Object.getPrototypeOf(X) === Number.prototype) ? 4 : 0;
        __r = r;
      `),
    ).toBe(0);
  });
});

describe("#6772 S7 — a binding assigned two different class expressions resolves dynamically", () => {
  it("RED on base (0): `C.prototype.false` on the getter class, then on the setter class (node 3)", async () => {
    expect(
      await runProbe(`
        var empty = Object.create(null);
        var C, value;
        for (C = class { get ['x' in empty]() { return 'via get'; } }; ; ) { value = C.prototype.false; break; }
        var r = (value === 'via get') ? 1 : 0;
        for (C = class { set ['x' in empty](param) { value = param; } }; ; ) { C.prototype.false = 'via set'; break; }
        r += (value === 'via set') ? 2 : 0;
        __r = r;
      `),
    ).toBe(3);
  });

  it("guard (base 15): statics, construction and instanceof through the ambiguous binding", async () => {
    expect(
      await runProbe(`
        var C, K1;
        C = class { static s() { return 3; } };
        K1 = C;
        var r = C.s() === 3 ? 1 : 0;
        var x1 = new C();
        C = class { static s() { return 4; } };
        r += C.s() === 4 ? 2 : 0;
        r += (x1 instanceof K1) ? 4 : 0;
        r += (new C() instanceof C) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("guard (base 7): one class assigned once keeps the static mapping", async () => {
    expect(
      await runProbe(`
        var C;
        C = class { get g() { return 5; } static t() { return 6; } };
        var r = (new C().g === 5) ? 1 : 0;
        r += (C.t() === 6) ? 2 : 0;
        r += (C.prototype.constructor === C) ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RESIDUAL (base 102, node 3): constructing the FIRST of two classes with a field-writing constructor throws", async () => {
    expect(
      await runProbe(`
        var C, r = 0;
        C = class { constructor() { this.a = 1; } };
        var o1;
        try { o1 = new C(); r += (o1.a === 1) ? 1 : 0; } catch (e) { r += 100; }
        C = class { constructor() { this.a = 10; } };
        var o2;
        try { o2 = new C(); r += (o2.a === 10) ? 2 : 0; } catch (e) { r += 1000; }
        __r = r;
      `),
    ).toBe(102);
  });
});

describe("#6772 S8 — a class-expression METHOD writing the class's own name throws TypeError", () => {
  it("guard (already 3 on origin/main ce6631272c; 1 on the plan's base): constructor and method writes (node 3)", async () => {
    expect(
      await runProbe(`
        var r = 0;
        try { new (class C { constructor() { C = 42; } }); } catch (e) { r += (e instanceof TypeError) ? 1 : 0; }
        try { new (class C { m() { C = 42; } }).m(); } catch (e) { r += (e instanceof TypeError) ? 2 : 0; }
        __r = r;
      `),
    ).toBe(3);
  });
});

describe("#6772 S9 — a static accessor named `constructor` wins over the class-object `.constructor` fold", () => {
  it("RED on base (3): own `constructor` on C and C.prototype, distinct values (node 7)", async () => {
    expect(
      await runProbe(`
        var C = class { static get constructor() {} static set constructor(_) {} constructor() {} };
        var r = C.hasOwnProperty('constructor') ? 1 : 0;
        r += C.prototype.hasOwnProperty('constructor') ? 2 : 0;
        r += (C.prototype.constructor !== C.constructor) ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (illegal cast): both reads through an untyped helper (node 1)", async () => {
    expect(
      await runProbe(`
        function notSame(a, b) { if (a === b) throw new Error("same"); return true; }
        var C = class { static get constructor() {} static set constructor(_) {} constructor() {} };
        var r = 0;
        try { notSame(C.prototype.constructor, C.constructor); r += 1; } catch (e) { r += 100; }
        __r = r;
      `),
    ).toBe(1);
  });

  it("RED on base (illegal cast / 0): the getter's value, and C.prototype.constructor is still C (node 3)", async () => {
    expect(
      await runProbe(`
        class C { static get constructor() { return 9; } }
        var r = (C.constructor === 9) ? 1 : 0;
        r += (C.prototype.constructor === C) ? 2 : 0;
        __r = r;
      `),
    ).toBe(3);
  });
});

describe("#6772 S10 — RegExp `lastIndex` is an own non-configurable data property", () => {
  it("RED on base (8): gOPD on a plain RegExp and on a RegExp-subclass instance (node 15)", async () => {
    expect(
      await runProbe(`
        var re1 = new RegExp('39?'); re1.exec('TC39');
        var d1 = Object.getOwnPropertyDescriptor(re1, 'lastIndex');
        var r = (d1 !== undefined && d1.value === 0) ? 1 : 0;
        r += (d1 !== undefined && d1.writable === true && d1.enumerable === false && d1.configurable === false) ? 2 : 0;
        class RE extends RegExp {}
        var re2 = new RE('39?'); re2.exec('TC39');
        var d2 = Object.getOwnPropertyDescriptor(re2, 'lastIndex');
        r += (d2 !== undefined && d2.value === 0) ? 4 : 0;
        r += (re2.hasOwnProperty('lastIndex')) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("RED on base (throws): runtime key — value, attributes, delete refused, writable:false reflected (node 63)", async () => {
    expect(
      await runProbe(`
        function gopd(o, k) { return Object.getOwnPropertyDescriptor(o, k); }
        function del(o, k) { try { return delete o[k]; } catch (e) { return (e instanceof TypeError) ? false : 'other'; } }
        var re = /a/g;
        re.lastIndex = 3;
        var d = gopd(re, 'lastIndex');
        var r = (d.value === 3) ? 1 : 0;
        r += (d.writable === true && d.enumerable === false && d.configurable === false) ? 2 : 0;
        r += (del(re, 'lastIndex') === false) ? 4 : 0;
        r += (re.hasOwnProperty('lastIndex')) ? 8 : 0;
        Object.defineProperty(re, 'lastIndex', { writable: false });
        var d4 = gopd(re, 'lastIndex');
        r += (d4.writable === false && d4.value === 3) ? 16 : 0;
        r += (gopd(re, 'source') === undefined) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });
});

describe("#6772 S11 — a runtime heritage's `prototype` is read once at definition", () => {
  it("RED on base (0): the getter runs once per definition and a primitive answer throws (node 7)", async () => {
    expect(
      await runProbe(`
        var calls = 0;
        var Base = function() {}.bind();
        Object.defineProperty(Base, 'prototype', { get: function() { calls++; return null; }, configurable: true });
        class C extends Base {}
        var r = (calls === 1) ? 1 : 0;
        calls = 0;
        Object.defineProperty(Base, 'prototype', { get: function() { calls++; return 42; }, configurable: true });
        try { class C2 extends Base {} } catch (e) { r += (e instanceof TypeError) ? 2 : 0; }
        r += (calls === 1) ? 4 : 0;
        __r = r;
      `),
    ).toBe(7);
  });

  it("RED on base (0): nested declaration and class-expression bindings, string prototype (node 15)", async () => {
    expect(
      await runProbe(`
        var calls = 0;
        var Base = function() {}.bind();
        Object.defineProperty(Base, 'prototype', { get: function() { calls++; return null; }, configurable: true });
        function f() { class C extends Base {} return C; }
        f();
        var r = (calls === 1) ? 1 : 0;
        var K = class extends Base {};
        r += (calls === 2) ? 2 : 0;
        Object.defineProperty(Base, 'prototype', { get: function() { calls++; return 'str'; }, configurable: true });
        try { var K2 = class extends Base {}; } catch (e) { r += (e instanceof TypeError) ? 4 : 0; }
        r += (calls === 3) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("guard (base 27, node 31): valid runtime heritages do not throw (bit 4 is a pre-existing NS.B method gap)", async () => {
    expect(
      await runProbe(`
        var r = 0;
        function mk(P) { class K extends P { m() { return 5; } } return new K().m(); }
        try { r += (mk(class { }) === 5) ? 1 : 0; } catch (e) { r += 100; }
        var F = function() { this.f = 1; };
        try { class C extends F { } r += 2; } catch (e) { r += 200; }
        var NS = { B: class { n() { return 3; } } };
        try { class D extends NS.B { } r += (new D().n() === 3) ? 4 : 0; } catch (e) { r += 400; }
        function mk2(P) { var K = class extends P { }; return K; }
        try { mk2(Object); r += 8; } catch (e) { r += 800; }
        var N = null;
        try { class E extends N { } r += 16; } catch (e) { r += 1600; }
        __r = r;
      `),
    ).toBe(27);
  });
});

describe("#6772 S12 — static and instance accessors of one name get distinct function slots", () => {
  it("RED on base (3): the getters-restricted-ids shape (node 15)", async () => {
    expect(
      await runProbe(`
        class C {
          get eval() { return 1; }
          get arguments() { return 2; }
          static get eval() { return 3; }
          static get arguments() { return 4; }
        }
        var r = (new C().eval === 1) ? 1 : 0;
        r += (new C().arguments === 2) ? 2 : 0;
        r += (C.eval === 3) ? 4 : 0;
        r += (C.arguments === 4) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("RED on base (34): static declared first, setters on both sides, dynamic reads (node 63)", async () => {
    expect(
      await runProbe(`
        var log = 0;
        class C {
          static get x() { return 30; }
          get x() { return 10; }
          static set y(v) { log += v * 100; }
          set y(v) { log += v; }
        }
        var c = new C();
        var r = (c.x === 10) ? 1 : 0;
        r += (C.x === 30) ? 2 : 0;
        c.y = 1;
        r += (log === 1) ? 4 : 0;
        C.y = 2;
        r += (log === 201) ? 8 : 0;
        function rd(o, k) { return o[k]; }
        r += (rd(c, 'x') === 10) ? 16 : 0;
        r += (rd(C, 'x') === 30) ? 32 : 0;
        __r = r;
      `),
    ).toBe(63);
  });

  it("RED on base (3): gOPD(C, k).get of a static accessor with and without an instance twin (node 15)", async () => {
    expect(
      await runProbe(`
        class B { static get id() { return 1; } }
        class A { get id() { return 2; } static get id() { return 3; } }
        function g(o, k) { var d = Object.getOwnPropertyDescriptor(o, k); return d === undefined || d.get === undefined ? undefined : d.get; }
        var r = 0;
        var gb = g(B, 'id');
        r += (gb !== undefined && gb.call(B) === 1) ? 1 : 0;
        var ga = g(A, 'id');
        r += (ga !== undefined) ? 2 : 0;
        r += (ga !== undefined && ga.call(A) === 3) ? 4 : 0;
        r += (A.id === 3 && new A().id === 2) ? 8 : 0;
        __r = r;
      `),
    ).toBe(15);
  });

  it("RESIDUAL (#6767 R3, node 3): a class with a runtime-keyed STATIC accessor hides its literal static accessors from gOPD", async () => {
    expect(
      await runProbe(`
        var namedSym = Symbol('test262');
        class A { get id() {} static get id() {} static get [namedSym]() {} }
        var d = Object.getOwnPropertyDescriptor(A, 'id');
        var r = (d !== undefined && d.get !== undefined) ? 1 : 0;
        r += (d !== undefined && d.get !== undefined && d.get.name === 'get id') ? 2 : 0;
        __r = r;
      `),
    ).toBe(0);
  });
});
