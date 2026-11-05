// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7215 — TypeScript constructor parameter properties
// (`constructor(public x: number)`, also `private`/`protected`/`readonly`/
// `override` and their combinations) were never stored: the struct had no
// slot for them and the constructor never wrote `this.x = x`, so
// `JSON.stringify(new A(1, "p"))` printed `{}` and `a.x` read `NaN` on every
// lane. They now declare own fields ahead of the class properties and are
// stored right after the field initializers, in parameter order — the
// TypeScript ES2022 emit (`x; z = …; constructor(x) { super(); this.x = x; … }`).
// Each row is diffed against native JS on gc, standalone and wasi.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

const READ = `export function test(i: number) { const s = run(); return i < 0 ? s.length : s.charCodeAt(i); }`;

function decode(f: (i: number) => unknown): string {
  const n = Number(f(-1));
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(Number(f(i)));
  return out;
}

async function expectSameOnLanes(body: string): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of LANES) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

const CASES: Record<string, string> = {
  "issue repro": `class A { constructor(public x: number, public y: string) {} }
function run(): string { const a = new A(1, "p"); return JSON.stringify(a) + " " + a.x + a.y; }`,
  "readonly and public readonly": `class A { constructor(readonly x: number, public readonly y: string) {} }
function run(): string { const a = new A(3, "q"); return JSON.stringify(a) + " " + (a.x + 1) + a.y; }`,
  "mixed with fields and initializers": `class Pt { label = "pt"; constructor(public readonly x: number, private y: number, protected tag: string = "t") {} dist(): number { return Math.sqrt(this.x * this.x + this.y * this.y); } t(): string { return this.tag; } }
function run(): string { const p = new Pt(3, 4); return p.dist() + p.t() + JSON.stringify(p) + Object.keys(p).join(); }`,
  "initialization order with super": `const log: string[] = [];
function note(s: string): number { log.push(s); return 1; }
class B { b = note("b"); constructor(public p: number) { note("B" + this.p); } }
class A extends B { a = note("a"); constructor(public x: number, public y: number) { note("pre"); super(note("arg") + x); note("A" + this.x + this.y + this.p); } }
function run(): string { log.length = 0; const o = new A(1, 2); return log.join() + JSON.stringify(o); }`,
  "subclass with super and a body field": `class B { constructor(public a: number) {} }
class C extends B { c = 0; constructor(a: number, public d: string) { super(a); this.c = this.a + 1; } }
function run(): string { const o = new C(1, "d"); return JSON.stringify(o) + Object.keys(o).join(); }`,
  "three levels": `class A { constructor(public a: number) {} }
class B extends A { constructor(public b: number) { super(b * 2); } }
class C extends B { c = 0; constructor(public d: number) { super(d + 1); this.c = this.a + this.b + this.d; } }
function run(): string { const o = new C(1); return JSON.stringify(o) + Object.keys(o).join(); }`,
  "implicit derived constructor": `class A { constructor(public a: number, public s: string) {} }
class B extends A { extra = 1; }
function run(): string { const o = new B(3, "z"); return JSON.stringify(o) + o.a + o.s; }`,
  "override parameter property": `class B { constructor(public v: number) {} }
class C extends B { constructor(public override v: number, public w: number) { super(v + 100); } }
function run(): string { const o = new C(1, 2); return JSON.stringify(o) + o.v; }`,
  "default values": `class A { constructor(public x = 5, public s: string = "d") {} }
function run(): string { const a = new A(); const b = new A(2, "e"); return JSON.stringify(a) + JSON.stringify(b) + (a.x + b.x); }`,
  "private read through a method": `class A { constructor(private secret: number, protected name: string) {} get(): number { return this.secret * 2; } nm(): string { return this.name; } }
function run(): string { const a = new A(21, "n"); return a.get() + a.nm(); }`,
  "private mutated through a method": `class Counter { constructor(private n: number = 0) {} inc(): this { this.n++; return this; } val(): number { return this.n; } }
function run(): string { return "" + new Counter().inc().inc().val() + new Counter(10).inc().val(); }`,
  "accessor over a private parameter property": `class A { constructor(private _v: number) {} get v(): number { return this._v; } set v(n: number) { this._v = n; } }
function run(): string { const a = new A(1); a.v = a.v + 5; return "" + a.v; }`,
  "JSON, Object.keys and for-in order": `class A { k = 1; constructor(public x: number, public y: number) {} }
function run(): string { const a: any = new A(1, 2); const ks: string[] = []; for (const p in a) ks.push(p); return ks.join() + "|" + Object.keys(a).join() + "|" + JSON.stringify(a); }`,
  hasOwnProperty: `class A { constructor(public x: number) {} m() { return 1; } }
function run(): string { const a: any = new A(1); return String(a.hasOwnProperty("x")) + String(a.hasOwnProperty("m")) + String(a.hasOwnProperty("q")); }`,
  "Object.keys of a subclass instance": `class B { constructor(public a: number) {} }
class C extends B { constructor(a: number, public c: string) { super(a); } }
function run(): string { const o: any = new C(1, "c"); return Object.keys(o).join() + JSON.stringify(o); }`,
  "body reassigns the field and the parameter": `class A { constructor(public x: number) { this.x = this.x * 10; x = 3; } }
function run(): string { const a = new A(2); a.x++; return "" + a.x; }`,
  "parameter captured by a closure": `class A { f: () => number; constructor(public x: number) { this.f = () => x; x = 9; } }
function run(): string { const a = new A(2); return a.x + "," + a.f(); }`,
  "reference-typed parameter properties": `class P { p = 1 }
class A { constructor(public p: P, public arr: number[]) {} }
function run(): string { const a = new A(new P(), [1, 2]); return a.p.p + "," + a.arr.length + Object.keys(a).join(); }`,
  "boolean parameter property": `class A { constructor(public on: boolean, public n: number) {} }
function run(): string { const a = new A(true, 1); return JSON.stringify(a) + (a.on ? "y" : "n"); }`,
  "generic class": `class Box<T> { constructor(public v: T) {} get(): T { return this.v; } }
function run(): string { const b = new Box<number>(3); const s = new Box<string>("s"); return b.get() + s.get() + JSON.stringify(b); }`,
  "class expression": `const K = class { constructor(public x: number) {} };
function run(): string { const k = new K(3); return JSON.stringify(k) + k.x; }`,
  "class inside a function": `function mk(n: number) { class L { constructor(public n: number, public t: string) {} } return new L(n, "t"); }
function run(): string { const l = mk(4); return l.n + l.t + JSON.stringify(l); }`,
  "array of instances": `class P { constructor(public x: number, public y: number) {} }
function run(): string { const ps = [new P(1, 2), new P(3, 4)]; let s = 0; for (const p of ps) s += p.x * p.y; return s + JSON.stringify(ps); }`,
  "spread, Object.assign, getOwnPropertyNames": `class P { constructor(public x: number, public y: string) {} }
function run(): string { const p = new P(1, "a"); return JSON.stringify({ ...p }) + JSON.stringify(Object.assign({}, p)) + Object.getOwnPropertyNames(p).join(); }`,
  "any-typed receiver": `class P { constructor(public x: number, public y: string) {} }
function run(): string { const p: any = new P(1, "a"); return p.x + p["y"] + typeof p.x; }`,
  "constructor reading arguments": `class P { n: number; constructor(public x: number) { this.n = arguments.length; } }
function run(): string { const p = new P(4); return p.x + "," + p.n; }`,
  "default that is defined": `class A { constructor(public s: string | undefined = "d") {} }
function run(): string { const a = new A(); const b = new A("e"); return a.s! + a.s! + JSON.stringify(b); }`,
  "field declared and parameter property": `class A { x: number; constructor(public y: number) { this.x = y + 1; } }
function run(): string { const a = new A(1); return JSON.stringify(a) + Object.keys(a).join(); }`,
};

describe("#7215 constructor parameter properties are stored", () => {
  for (const [name, body] of Object.entries(CASES)) {
    it(name, async () => {
      await expectSameOnLanes(body);
    });
  }
});

// A class whose parameter properties cannot all get a field yet (an argument
// that may be `undefined`, or a native `i32` annotation) declares none of them,
// exactly as before #7215: a typed field would read `null`/`0` for an omitted
// argument, and a native field fails the IR methods' type check.
const UNDECLARED: Record<string, string> = {
  "omitted optional string": `class A { constructor(public s?: string) {} }
function run(): string { const a = new A(); return String(a.s) + (a.s === undefined) + JSON.stringify(a); }`,
  "undefined passed to a union": `class A { constructor(public s: string | undefined) {} }
function run(): string { const a = new A(undefined); return String(a.s) + (a.s === undefined) + JSON.stringify(a); }`,
  "omitted optional object": `class P { p = 1 }
class A { constructor(public p?: P) {} }
function run(): string { const a = new A(); return String(a.p) + (a.p === undefined) + JSON.stringify(a); }`,
  "default void 0": `class A { constructor(public s: string | undefined = void 0) {} }
function run(): string { const a = new A(); return String(a.s) + (a.s === undefined) + JSON.stringify(a); }`,
  "default undefined": `class A { constructor(public s: string | undefined = undefined) {} }
function run(): string { const a = new A(); return String(a.s) + (a.s === undefined) + JSON.stringify(a); }`,
  "default call returning undefined": `function d(): string | undefined { return undefined; }
class A { constructor(public s: string | undefined = d()) {} }
function run(): string { const a = new A(); return String(a.s) + (a.s === undefined); }`,
  "number default undefined": `class A { constructor(public n: number | undefined = undefined) {} }
function run(): string { return JSON.stringify(new A()); }`,
};
const NATIVE_COMPILES = [
  `type i32 = number;\nclass A { constructor(public n: i32) {} get(): number { return this.n; } }\nexport function run(): number { return new A(4).get(); }`,
  `type i32 = number;\nclass A { constructor(public n: i32) {} inc(): i32 { return this.n + 1; } }\nexport function run(): number { return new A(4).inc(); }`,
];

describe("#7215 parameter properties that cannot get a field yet keep the earlier lowering", () => {
  for (const [name, body] of Object.entries(UNDECLARED)) {
    it(name, async () => {
      await expectSameOnLanes(body);
    });
  }
  for (const [i, src] of NATIVE_COMPILES.entries()) {
    it(`native i32 parameter property still compiles (${i})`, async () => {
      for (const { lane, options } of LANES) {
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
      }
    });
  }
});

// Known residual, pinned to today's output rather than node's: an `any` /
// `unknown` / generic `T` parameter property holding `undefined` gets a field
// (its type is not "undefinable"), and JSON writes an `undefined` field as
// `null`, exactly as the explicit-field form (`v: any; this.v = v`) does on
// base. Node prints `{}true{"v":3}v`. Reads and `Object.keys` are correct.
describe("#7215 known residual: undefined in an any-typed parameter property", () => {
  it("serialises as null (pinned)", async () => {
    const src = `class A { constructor(public v: any) {} }
function run(): string { const a = new A(undefined); const b = new A(3); return JSON.stringify(a) + (a.v === undefined) + JSON.stringify(b) + Object.keys(a).join(); }
${READ}`;
    for (const { lane, options } of LANES) {
      const result = await compile(src, { fileName: "probe.ts", ...options });
      expect(result.success, lane).toBe(true);
      const instance = await instantiateWithRuntime(result);
      expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe('{"v":null}true{"v":3}v');
    }
  });
});
