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
// The constructor (`typeof C`), `C.prototype` and a provable `new` of the
// static class keep the fold too.
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
  "leaf-typed receiver keeps its fold": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nconst b: B = new B();\nfunction run(): string { return Object.keys(b).join() + String(b.hasOwnProperty("a")) + String("b" in b); }`,
  ],
  // Review round 2: the constructor itself (`typeof C`) lowers to the same
  // struct ref but its own keys are the statics, so it keeps the fold.
  "constructor receiver keeps its static own keys": [
    `class A { a = 1; static s = 1; static sm() {} }\nclass B extends A {}\nfunction run(): string { return String(A.hasOwnProperty("s")) + String(A.hasOwnProperty("sm")) + String(A.hasOwnProperty("a")) + String(A.hasOwnProperty("name")) + String(A.hasOwnProperty("length")) + String(A.hasOwnProperty("prototype")) + String(A.propertyIsEnumerable("s")) + String("s" in A) + String("t" in A); }`,
  ],
  "typeof-class parameter": [
    `class A { static s = 1; a = 1 }\nclass B extends A {}\nfunction f(c: typeof A): string { return String(c.hasOwnProperty("s")) + String(c.propertyIsEnumerable("s")); }\nfunction run(): string { return f(A); }`,
  ],
  "const annotated with the base, built from the subclass": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nfunction run(): string { const k: string[] = []; const y: A = new B(); for (const p in y) k.push(p); return k.join() + "/" + Object.keys(y).join() + String(y.hasOwnProperty("b")) + String("b" in y); }`,
  ],
  "exact new of the static class, const and let": [
    `class A { a = 1; b = 2 }\nclass B extends A { c = 3 }\nfunction run(): string { let a = new A(); const b: A = new A(); const k: string[] = []; for (const p in b) k.push(p); return Object.keys(a).join() + "/" + Object.keys(b).join() + "/" + k.join() + String(a.hasOwnProperty("c")) + String("c" in b); }`,
  ],
  "let reassigned to a subclass": [
    `class A { a = 1 }\nclass B extends A { b = 2 }\nfunction run(): string { let a: A = new A(); a = new B(); const k: string[] = []; for (const p in a) k.push(p); return Object.keys(a).join() + "/" + k.join() + String(a.hasOwnProperty("b")) + String("b" in a); }`,
  ],
  "new of a class-expression subclass": [
    `const A = class { a = 1 };\nconst B = class extends A { b = 2 };\nfunction run(): string { const x: InstanceType<typeof A> = new B(); const y = new A(); return Object.keys(x).join() + "/" + Object.keys(y).join(); }`,
  ],
  // Review round 3: `C.prototype` is typed as an instance of `C`, but its own
  // keys are the methods; it keeps the fold (wasi's runtime arm inverted it).
  "prototype receiver keeps its fold": [
    `class A { a = 1; m() {} }\nclass B extends A { b = 2; n() {} }\nfunction run(): string { return String((A.prototype).hasOwnProperty("a")) + String((A.prototype).hasOwnProperty("constructor")) + String((A.prototype).hasOwnProperty("m")) + String(A.prototype.hasOwnProperty("m")) + String((B.prototype).hasOwnProperty("n")) + String(A.prototype.propertyIsEnumerable("m")) + String("m" in A.prototype); }`,
  ],
};

// Review round 4: a class-typed binding whose value failed the struct cast
// holds null at runtime. The consumers must not throw or trap there; they keep
// base's compile-time answer (pinned — node, which sees the real object,
// differs). `(o as any) as A` traps at the cast itself on gc/standalone, on
// base too. (#6979 S7-c) Its row ran on wasi only; WASI now lowers with the
// native regime and traps there the same way, so the row is gone.
const AB = `class A { a = 1; m() {} }\nclass B extends A { b = 2; n() {} }`;
const NON_INSTANCE: Record<string, [string, string, readonly string[]]> = {
  "JSON.parse(...) as A": [
    `${AB}\nfunction run(): string { const p = JSON.parse('{"a":5,"b":6}') as A; return Object.keys(p).join() + String(p.hasOwnProperty("a")) + String(p.hasOwnProperty("b")) + String("b" in p); }`,
    "atruefalsefalse",
    ["gc", "standalone", "wasi"],
  ],
  "an any returned into A": [
    `${AB}\nfunction mk(): any { return { a: 1, q: 2 }; }\nfunction run(): string { const q: A = mk(); const ks: string[] = Object.keys(q); return Object.keys(q).join() + ks.length; }`,
    "a1",
    ["gc", "standalone", "wasi"],
  ],
  "Object.getPrototypeOf(new A()) as A": [
    `${AB}\nfunction run(): string { const r = Object.getPrototypeOf(new A()) as A; return String(Object.keys(r).length); }`,
    "1",
    ["gc", "standalone", "wasi"],
  ],
};

describe("#7216 a class-typed value that is not an instance keeps base's answer", () => {
  for (const [name, [body, pinned, lanes]] of Object.entries(NON_INSTANCE)) {
    it(name, async () => {
      const src = `${body}\n${READ}`;
      for (const { lane, options } of LANES) {
        if (!lanes.includes(lane)) continue;
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(pinned);
      }
    });
  }
});

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
