// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7158 — WasmGC canonicalises structurally identical structs, so the
// closed-struct enumeration arm `ref.test $D` also accepted a `C` instance
// whose fields have the same Wasm types (`class C { #x = 1 }` beside
// `class D { y = 2 }`, or `class A { a = 1 }` beside `class B { b = 1 }`), and
// `ref.test $Base` accepted every subclass instance before its own, longer arm.
// `JSON.stringify(new C())` printed `{"y":1}`; `Object.keys`, for…in,
// `getOwnPropertyNames`, `Object.assign` and spread read the twin's names. The
// arms now also compare the instance's `__tag`. Each row is diffed against
// native JS; the joined result is read back one char code at a time so the
// standalone lane needs no string marshalling.
//
// The wasi lane runs only the consumers it supports for ANY class instance
// (`Object.keys` / spread); its JSON.stringify, for…in, getOwnPropertyNames and
// Object.assign of a class instance answer `null` / empty even with a single
// class, a separate pre-existing gap.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const ALL = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;
const NO_WASI = ALL.slice(0, 2);

const READ = `export function test(i: number) { const s = run(); return i < 0 ? s.length : s.charCodeAt(i); }`;

function decode(f: (i: number) => unknown): string {
  const n = Number(f(-1));
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(Number(f(i)));
  return out;
}

async function expectSameOnLanes(body: string, lanes: readonly (typeof ALL)[number][]): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of lanes) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

const CASES: Record<string, [string, readonly (typeof ALL)[number][]]> = {
  "private-only beside a public twin": [
    `class C { #x = 1 }\nclass D { y = 2 }\nfunction run(): string { return JSON.stringify(new C()) + JSON.stringify(new D()); }`,
    NO_WASI,
  ],
  "public twins: JSON.stringify": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { return JSON.stringify(new A()) + JSON.stringify(new B()); }`,
    NO_WASI,
  ],
  "public twins: Object.keys of a spread": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { new A(); return Object.keys({ ...new B() }).join(); }`,
    ALL,
  ],
  "public twins: Object.assign": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { new A(); return JSON.stringify(Object.assign({}, new B())); }`,
    NO_WASI,
  ],
  "public twins: Object.keys through any": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { const a: any = new A(); const b: any = new B(); return Object.keys(a).join() + ";" + Object.keys(b).join(); }`,
    ALL,
  ],
  "public twins: for-in through any": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { new A(); const o: any = new B(); const k: string[] = []; for (const p in o) k.push(p); return k.join(); }`,
    NO_WASI,
  ],
  "public twins: getOwnPropertyNames through any": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { new A(); const o: any = new B(); return Object.getOwnPropertyNames(o).join(); }`,
    NO_WASI,
  ],
  "three-way twins": [
    `class A { a = 1 }\nclass B { b = 1 }\nclass C { c = 1 }\nfunction run(): string { const xs: any[] = [new A(), new B(), new C()]; let s = ""; for (const o of xs) s += JSON.stringify(o) + Object.keys(o).join(); return s; }`,
    NO_WASI,
  ],
  "three-way twins: Object.keys": [
    `class A { a = 1 }\nclass B { b = 1 }\nclass C { c = 1 }\nfunction run(): string { const xs: any[] = [new A(), new B(), new C()]; let s = ""; for (const o of xs) s += Object.keys(o).join(); return s; }`,
    ALL,
  ],
  "subclass pair over a shared base": [
    `class Base { z = 0 }\nclass A extends Base { a = 1 }\nclass B extends Base { b = 1 }\nfunction run(): string { return JSON.stringify(new A()) + JSON.stringify(new B()) + JSON.stringify(new Base()); }`,
    NO_WASI,
  ],
  "subclass pair: Object.keys": [
    `class Base { z = 0 }\nclass A extends Base { a = 1 }\nclass B extends Base { b = 1 }\nfunction run(): string { const xs: any[] = [new Base(), new A(), new B()]; let s = ""; for (const o of xs) s += Object.keys(o).join() + ";"; return s; }`,
    ALL,
  ],
  "deep chain": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nclass C extends B { c = 3 }\nfunction run(): string { const xs: any[] = [new A(), new B(), new C()]; let s = ""; for (const o of xs) s += JSON.stringify(o) + Object.keys(o).join() + ";"; return s; }`,
    NO_WASI,
  ],
  "subclass without own fields reads its parent's names": [
    `class A { a = 1 }\nclass B extends A {}\nclass T { t = 1 }\nfunction run(): string { const o: any = new B(); return JSON.stringify(new B()) + Object.keys(o).join() + JSON.stringify(new T()); }`,
    NO_WASI,
  ],
  "mixed private and public beside a public twin": [
    `class C { #x = 1; y = 2 }\nclass D { u = 3; v = 4 }\nfunction run(): string { return JSON.stringify(new C()) + JSON.stringify(new D()) + JSON.stringify({ ...new C() }) + JSON.stringify({ ...new D() }); }`,
    NO_WASI,
  ],
  "expando on a twin": [
    `class A { a = 1 }\nclass B { b = 1 }\nfunction run(): string { const o: any = new B(); o.z = 5; return Object.keys(o).join() + JSON.stringify(new A()); }`,
    NO_WASI,
  ],
};

// Sweep: every pair of same-layout class bodies, every consumer, both instances.
const TWIN_BODIES: Record<string, [string, string]> = {
  "private vs public": ["#p = 1", "q = 2"],
  "two public numbers": ["a = 1", "b = 2"],
  "two public strings": ['s = "x"', 't = "y"'],
  "private+public vs public+public": ["#p = 1; q = 2", "r = 3; s = 4"],
  "public+private vs private+public": ["a = 1; #b = 2", "#c = 3; d = 4"],
  "two private": ["#p = 1", "#q = 2"],
};
const CONSUMERS = [
  "JSON.stringify(o)",
  "Object.keys(o).join()",
  "JSON.stringify({ ...o })",
  "JSON.stringify(Object.assign({}, o))",
  "Object.getOwnPropertyNames(o).join()",
  "(() => { const k: string[] = []; for (const p in o) k.push(p); return k.join(); })()",
];

describe("#7158 twin struct layouts keep their own enumeration arm", () => {
  for (const [name, [body, lanes]] of Object.entries(CASES)) {
    it(name, async () => {
      await expectSameOnLanes(body, lanes);
    });
  }
  for (const [name, [x, y]] of Object.entries(TWIN_BODIES)) {
    it(`sweep: ${name}`, async () => {
      const each = CONSUMERS.map(
        (c) => `{ const o: any = new X(); s += ${c} + "|"; }\n{ const o: any = new Y(); s += ${c} + "|"; }`,
      );
      const body = `class X { ${x} }\nclass Y { ${y} }\nfunction run(): string { let s = "";\n${each.join("\n")}\nreturn s; }`;
      await expectSameOnLanes(body, NO_WASI);
    });
  }
});
