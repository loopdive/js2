// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7216 — a receiver STATICALLY typed as a class that has subclasses may hold
// a longer subclass struct at runtime, but `Object.keys`/`values`/`entries`,
// for…in, `hasOwnProperty` and `in` answered from the static class's field
// list: `const xs: Animal[] = [new Dog()]; Object.keys(xs[0])` was `name`
// where node prints `name,breed`. Those consumers now take the runtime
// own-key path when the static class is extended; a class nobody extends keeps
// its compile-time fold (byte-identical). Each row is diffed against native JS
// on gc, standalone and wasi. On wasi `Object.values`/`entries` keep the fold
// (their natives have no closed-struct arm there), so those rows skip wasi.
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

const ANIMALS = `class Animal { name = "a" }\nclass Dog extends Animal { breed = "b" }\nconst xs: Animal[] = [new Dog(), new Animal()];`;

/** [body, skip wasi] */
const CASES: Record<string, [string, boolean?]> = {
  "issue repro: Object.keys": [
    `${ANIMALS}\nfunction run(): string { return Object.keys(xs[0]).join() + "|" + Object.keys(xs[1]).join(); }`,
  ],
  "Object.values": [
    `${ANIMALS}\nfunction run(): string { return Object.values(xs[0]).join() + "|" + Object.values(xs[1]).join(); }`,
    true,
  ],
  "Object.entries": [
    `${ANIMALS}\nfunction run(): string { const e = Object.entries(xs[0]); return e.length + ":" + e.map((p) => p[0] + "=" + p[1]).join(); }`,
    true,
  ],
  "for-in": [
    `${ANIMALS}\nfunction run(): string { return xs.map((x) => { const k: string[] = []; for (const p in x) k.push(p); return k.join(); }).join("|"); }`,
  ],
  "hasOwnProperty and in": [
    `${ANIMALS}\nfunction run(): string { return xs.map((x) => String(x.hasOwnProperty("breed")) + String("breed" in x) + String(x.hasOwnProperty("name")) + String("zz" in x)).join("|"); }`,
  ],
  "base-typed parameter": [
    `${ANIMALS}\nfunction f(a: Animal): string { return Object.keys(a).join(); }\nfunction run(): string { return f(new Dog()) + "|" + f(new Animal()); }`,
  ],
  "three-level chain": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nclass C extends B { c = 3 }\nconst xs: A[] = [new A(), new B(), new C()];\nconst ys: B[] = [new B(), new C()];\nfunction run(): string { return xs.map((x) => Object.keys(x).join() + String(x.hasOwnProperty("c")) + String("b" in x)).join("|") + "/" + ys.map((y) => Object.keys(y).join()).join("|"); }`,
  ],
  "abstract base": [
    `abstract class Shape { kind = "s"; abstract area(): number; }\nclass Sq extends Shape { side = 2; area() { return this.side * this.side; } }\nclass Ci extends Shape { r = 1; area() { return 3 * this.r; } }\nconst xs: Shape[] = [new Sq(), new Ci()];\nfunction run(): string { return xs.map((x) => Object.keys(x).join() + String(x.hasOwnProperty("r")) + String("side" in x) + String("area" in x)).join("|"); }`,
  ],
  "twin-layout sibling": [
    `class A { a = 1 }\nclass B { b = 1 }\nclass A2 extends A { x = 5 }\nconst xs: A[] = [new A(), new A2()];\nconst b = new B();\nfunction run(): string { return xs.map((x) => Object.keys(x).join() + String(x.hasOwnProperty("x")) + String("x" in x)).join("|") + "|" + Object.keys(b).join() + String(b.hasOwnProperty("b")); }`,
  ],
  "parameter properties": [
    `class B { constructor(public a: number) {} }\nclass C extends B { constructor(a: number, public c: string) { super(a); } }\nconst xs: B[] = [new B(1), new C(2, "z")];\nfunction run(): string { return xs.map((x) => Object.keys(x).join() + String(x.hasOwnProperty("c")) + String("c" in x)).join("|"); }`,
  ],
  "class expressions": [
    `const A = class { a = 1 };\nconst B = class extends A { b = 2 };\nconst xs: InstanceType<typeof A>[] = [new A(), new B()];\nfunction run(): string { return xs.map((x) => Object.keys(x).join() + String(x.hasOwnProperty("b")) + String("b" in x)).join("|"); }`,
  ],
  "Object.keys(this) in a base method": [
    `class A { a = 1; keys(): string { return Object.keys(this).join(); } has(k: string): boolean { return this.hasOwnProperty(k); } }\nclass B extends A { b = 2 }\nfunction run(): string { return new A().keys() + "|" + new B().keys() + "|" + String(new B().has("b")) + String(new A().has("b")); }`,
  ],
  "private fields and accessors stay hidden": [
    `class A { #p = 1; a = 1; get p() { return this.#p; } m() { return 1; } }\nclass B extends A { #q = 2; b = 2; get q() { return this.#q; } }\nconst xs: A[] = [new A(), new B()];\nfunction run(): string { return xs.map((x) => { const k: string[] = []; for (const p in x) k.push(p); return Object.keys(x).join() + ":" + k.join() + String(x.hasOwnProperty("m")); }).join("|"); }`,
  ],
  "inline length and index": [
    `class A { a = 1 }\nclass B extends A { b = 2; c = 3 }\nconst xs: A[] = [new B()];\nfunction run(): string { return String(Object.keys(xs[0]).length) + Object.keys(xs[0])[2]; }`,
  ],
  "null receiver throws": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nfunction f(x: A | null): string { try { return Object.keys(x as A).join(); } catch (e) { return "threw"; } }\nfunction run(): string { return f(new B()) + "|" + f(null); }`,
  ],
  "leaf-typed receiver keeps its fold": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nconst b: B = new B();\nfunction run(): string { return Object.keys(b).join() + String(b.hasOwnProperty("a")) + String("b" in b); }`,
  ],
};

describe("#7216 own-key consumers see the runtime subclass, not the static class", () => {
  for (const [name, [body, skipWasi]] of Object.entries(CASES)) {
    it(name, async () => {
      const src = `${body}\n${READ}`;
      const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
      for (const { lane, options } of LANES) {
        if (skipWasi && lane === "wasi") continue;
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
      }
    });
  }
});
