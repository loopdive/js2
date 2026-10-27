// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7156 — `for (k in o)` over a closed static shape is unrolled at compile time
// from the checker's property list. For a class instance that list carried
// private names, methods and accessors (`#x,y,m` instead of `y`) and put the
// derived class's fields before the base's; for `{...a, z}` it listed `z`
// first. Each row is diffed against native JS on the gc (native-first),
// standalone and wasi lanes. The joined key string is read back one char code
// at a time so the standalone lane needs no string marshalling.
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

async function expectSameOnLanes(
  body: string,
  lanes: readonly (typeof LANES)[number][] = LANES,
  pinned?: string,
): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = pinned ?? decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of lanes) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

const keysOf = (expr: string): string =>
  `function run(): string { const keys: string[] = []; for (const k in ${expr}) keys.push(k); return keys.join(); }`;

const sortedKeysOf = (expr: string): string =>
  `function run(): string { const keys: string[] = []; for (const k in ${expr}) keys.push(k); return keys.sort().join(); }`;

const CASES: Record<string, string> = {
  "private name, field, method": `class C { #x = 1; y = 2; m() {} }\n${keysOf("new C()")}`,
  "subclass: base fields first": `class C { #x = 1; y = 2; m() {} }\nclass D extends C { w = 3; n() {} }\n${keysOf("new D()")}`,
  "redeclared field keeps the base position": `class B { y = 1; z = 2; }\nclass D extends B { w = 3; y = 4; }\n${keysOf("new D()")}`,
  "getter/setter pair is not own": `class G { get a() { return 1; } set a(v: number) {} b = 1; }\n${keysOf("new G()")}`,
  "getter-only class enumerates nothing": `class G { get a() { return 1; } }\nfunction run(): string { let s = "n"; for (const k in new G()) s += k; return s; }`,
  "static field and method": `class S { static s = 1; t = 2; static f() {} }\n${keysOf("new S()")}`,
  "parameter properties before fields": `class P { c = 1; constructor(public a: number, b: number) {} d = 2; }\n${keysOf("new P(1, 2)")}`,
  "definite-assignment field": `class Q { x!: number; r = 1; }\n${keysOf("new Q()")}`,
  "computed string-literal key keeps its position": `class C { ["k1"] = 1; a = 2; }\n${keysOf("new C()")}`,
  "auto-accessor is not own": `class C { accessor a = 1; b = 2; }\n${keysOf("new C()")}`,
  "generic class with accessor": `class G<T> { v: T; constructor(v: T) { this.v = v; } get g() { return 1; } }\n${keysOf("new G<number>(1)")}`,
  "spread then own key": `const a = { x: 1, y: 2 };\n${keysOf("{ ...a, z: 3 }")}`,
  "own key, spread, redefined key": `const a = { x: 1, y: 2 };\n${keysOf("{ z: 0, ...a, x: 5, w: 1 }")}`,
  "spread literal through a const": `const a = { x: 1, y: 2 };\nconst o = { ...a, z: 3 };\n${keysOf("o")}`,
  "spread of a class instance": `class C { #x = 1; y = 2; m() {} }\n${keysOf("{ ...new C(), z: 1 }")}`,
  "plain literal order unchanged": keysOf("{ b: 1, a: 2 }"),
  // Integer-index keys come first, ascending (OrdinaryOwnPropertyKeys).
  "integer key in a derived class": `class B { b = 1; }\nclass D extends B { 0 = 2; }\n${keysOf("new D()")}`,
  "string integer key in a derived class": `class B { b = 1; }\nclass D extends B { "3" = 2; }\n${keysOf("new D()")}`,
  "computed integer key in a derived class": `class B { b = 1; }\nclass D extends B { [7] = 2; }\n${keysOf("new D()")}`,
  "integer key before a parameter property": `class C { 0 = 1; constructor(public p: number) {} }\n${keysOf("new C(5)")}`,
  "mixed integer and string keys": `class C { b = 1; 2 = 2; a = 3; 1 = 4; "01" = 5; }\n${keysOf("new C()")}`,
  // A const bound to \`new C()\` is provably that class's instance.
  "const bound to new C()": `class C { #x = 1; y = 2; m() {} }\nconst c = new C();\n${keysOf("c")}`,
  "new (C)()": `class C { #x = 1; y = 2; m() {} }\n${keysOf("new (C)()")}`,
  "new through an un-annotated const alias": `class C { #x = 1; y = 2; m() {} }\nconst D = C;\n${keysOf("new D()")}`,
  "new of a class expression": `const C = class { #x = 1; y = 2; m() {} };\n${keysOf("new C()")}`,
  // Writes that cannot reach a class instance do not count: an array index
  // loop and a `Record<string, number>` write leave the improvement on.
  "array and Record writes in the same program": `class C { #x = 1; y = 2; m() {} }\nconst arr: number[] = [0, 0];\nfor (let i = 0; i < arr.length; i++) arr[i] = i;\nconst rec: Record<string, number> = {};\nconst rk = "m" + "";\nrec[rk] = 1;\n${keysOf("new C()")}`,
  "Record<string, number> counter in the same program": `class C { #x = 1; y = 2; m() {} }\nconst counts: Record<string, number> = {};\nfor (const w of ["a", "b", "a"]) counts[w] = (counts[w] ?? 0) + 1;\n${keysOf("new C()")}`,
  "const bound to new C() with its own annotation": `class C { #x = 1; y = 2; m() {} }\nconst c: C = new C();\n${keysOf("c")}`,
};

// Not a SIMPLE class chain (a `declare`/`abstract` field, an interface merge, or
// a name that is a field in one class and a method/accessor in another): the
// unroll keeps the checker's key list and order, exactly as before #7156, so
// these programs compile byte-identically to the base. Where that order differs
// from node's, the row compares the sorted key set.
const NOT_SIMPLE: Record<string, string> = {
  "declare field assigned in the constructor (sorted)": `class C { declare a: number; b = 2; constructor() { this.a = 1; } }\n${sortedKeysOf("new C()")}`,
  "interface-merged field assigned in the constructor (sorted)": `interface C { extra: number }\nclass C { a = 1; constructor() { this.extra = 7; } }\n${sortedKeysOf("new C()")}`,
  "derived declare over a base field": `class B { y = 1; z = 2; }\nclass D extends B { declare y: number; w = 3; }\nfunction run(): string { let n = 0; for (const k in new D()) n++; return String(n); }`,
  "derived declare over a base field (sorted)": `class B { y = 1; z = 2; }\nclass D extends B { declare y: number; w = 3; }\n${sortedKeysOf("new D()")}`,
  "derived declare over a base parameter property": `class B { constructor(public p: number) {} }\nclass D extends B { declare p: number; q = 1; constructor() { super(1); } }\n${keysOf("new D()")}`,
  "abstract field placed by the subclass (sorted)": `abstract class A { abstract a: number; q = 1; }\nclass B extends A { a = 2; }\n${sortedKeysOf("new B()")}`,
  "base field under a derived method": `class B { m = () => 1; a = 1; }\nclass D extends B { m() { return 2; } }\n${keysOf("new D()")}`,
  "base field under a derived getter": `class B { x = 1; a = 2; }\nclass D extends B { get x() { return 5; } }\n${keysOf("new D()")}`,
  "base field under a derived getter (count)": `class B { x = 1; a = 2; }\nclass D extends B { get x() { return 5; } }\nfunction run(): string { let n = 0; for (const k in new D()) n++; return String(n); }`,
  "base method under a derived field (sorted)": `class B { m() { return 1; } a = 1; }\nclass D extends B { m = () => 2; }\n${sortedKeysOf("new D()")}`,
  // A class-TYPED value need not be built by that class (review round 3): TS
  // accepts an object literal, or a subclass that turns a method into a field.
  "object literal in a class-annotated const": `class P { x = 0; m(): number { return 1; } }\nconst p: P = { x: 1, m() { return 2; } };\n${keysOf("p")}`,
  "object literal in a class-annotated const (sorted)": `class P { x = 0; m(): number { return 1; } }\nconst p: P = { x: 1, m() { return 2; } };\n${sortedKeysOf("p")}`,
  "object literal passed to a class-typed parameter": `class P { x = 0; m(): number { return 1; } }\nfunction f(p: P): string { const keys: string[] = []; for (const k in p) keys.push(k); return keys.join(); }\nfunction run(): string { return f({ x: 1, m() { return 2; } }); }`,
  "subclass instance through a base-typed parameter (sorted)": `class B { m() { return 1; } a = 1; }\nclass D extends B { m = () => 2; }\nfunction f(b: B): string { const keys: string[] = []; for (const k in b) keys.push(k); return keys.sort().join(); }\nfunction run(): string { return f(new D()); }`,
  // A method name that is also assigned is an own property (review round 4).
  "method bound in the constructor": `class P { a = 1; m(): number { return this.a; } constructor() { this.m = this.m.bind(this); } }\n${keysOf("new P()")}`,
  "method bound in the constructor, through a const (sorted)": `class P { a = 1; m(): number { return this.a; } constructor() { this.m = this.m.bind(this); } }\nconst p = new P();\n${sortedKeysOf("p")}`,
  "method assigned outside the class (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\np.m = () => 2;\n${sortedKeysOf("p")}`,
  "method assigned in a subclass constructor (sorted)": `class P { a = 1; m(): number { return 1; } }\nclass Q extends P { constructor() { super(); this.m = () => 2; } }\n${sortedKeysOf("new Q()")}`,
  "method defined by Object.defineProperty (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nObject.defineProperty(p, "m", { value: 2, enumerable: true });\n${sortedKeysOf("p")}`,
  "method written by Object.assign (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nObject.assign(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  // Writes whose key or source is not static (review round 5): any method may
  // then be own, so every class chain keeps the checker's list.
  "const string key (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst key = "m";\n(p as any)[key] = () => 2;\n${sortedKeysOf("p")}`,
  "let key (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nlet key = "m";\n(p as any)[key] = () => 2;\n${sortedKeysOf("p")}`,
  "for-of key loop (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfor (const key of ["m"]) (p as any)[key] = () => 2;\n${sortedKeysOf("p")}`,
  "object destructuring target (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\n({ m: p.m } = { m: () => 2 });\n${sortedKeysOf("p")}`,
  "array destructuring target (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\n[p.m] = [() => 2];\n${sortedKeysOf("p")}`,
  "for-of target (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfor (p.m of [() => 2]) {}\n${sortedKeysOf("p")}`,
  "Object.assign with a variable source (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nObject.assign(p, src);\n${sortedKeysOf("p")}`,
  "Object.assign with a spread source (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nObject.assign(p, { ...src });\n${sortedKeysOf("p")}`,
  "defineProperty with a const key (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst key = "m";\nObject.defineProperty(p, key, { value: 2, enumerable: true });\n${sortedKeysOf("p")}`,
  "Reflect.set with a literal key (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nReflect.set(p, "m", () => 2);\n${sortedKeysOf("p")}`,
  "Object.setPrototypeOf (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nObject.setPrototypeOf(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "options bag: Object.assign(this, opts) (sorted)": `class C { a = 1; m(): number { return 1; } constructor(opts: Partial<C>) { Object.assign(this, opts); } }\n${sortedKeysOf("new C({ m: () => 2 })")}`,
  "options bag through a const (sorted)": `class C { a = 1; m(): number { return 1; } constructor(opts: Partial<C>) { Object.assign(this, opts); } }\nconst c = new C({ m: () => 2 });\n${sortedKeysOf("c")}`,
  "copy loop: this[k] = opts[k] (sorted)": `class C { a = 1; m(): number { return 1; } constructor(opts: any) { for (const key in opts) (this as any)[key] = opts[key]; } }\n${sortedKeysOf("new C({ m: 3 })")}`,
  // Index signatures whose values may be anything, and Object/Reflect
  // writers reached other than as a direct call (review round 6).
  "merge helper over Record<string, any> (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction merge(t: Record<string, any>, s: Record<string, any>): void { for (const k in s) t[k] = s[k]; }\nmerge(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "merge(this, opts) in a constructor (sorted)": `function merge(t: Record<string, any>, s: Record<string, any>): void { for (const k in s) t[k] = s[k]; }\nclass C { a = 1; m(): number { return 1; } constructor(opts: Record<string, any>) { merge(this, opts); } }\n${sortedKeysOf("new C({ m: 3 })")}`,
  "merge helper over an any index signature (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction merge(t: { [k: string]: any }, s: { [k: string]: any }): void { for (const k in s) t[k] = s[k]; }\nmerge(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "this through a Record<string, any> const (sorted)": `class C { a = 1; m(): number { return 1; } constructor(opts: Record<string, any>) { const self: Record<string, any> = this; for (const k in opts) self[k] = opts[k]; } }\n${sortedKeysOf("new C({ m: 3 })")}`,
  "globalThis.Object.assign (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nglobalThis.Object.assign(p, src);\n${sortedKeysOf("p")}`,
  "Object element-access assign (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nObject["assign"](p, src);\n${sortedKeysOf("p")}`,
  // Code run from a string, and index signatures whose values can be methods
  // (review round 7).
  "eval of a string (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\n(globalThis as any).pp = p;\neval("pp.m = 5");\n${sortedKeysOf("p")}`,
  "new Function of a string (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nnew Function("o", "o.m = 5")(p);\n${sortedKeysOf("p")}`,
  "bindAll over Record<string, Function> with a cast (sorted)": `function bindAll(o: Record<string, Function>, names: string[]): void { for (const n of names) o[n] = o[n].bind(o); }\nclass C { a = 1; m(): number { return this.a; } constructor() { bindAll(this as any, ["m"]); } }\n${sortedKeysOf("new C()")}`,
  "Record<string, number | Function> helper with a cast (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction put(o: Record<string, number | Function>, k: string, v: Function): void { o[k] = v; }\nput(p as any, "m", () => 2);\n${sortedKeysOf("p")}`,
  "Record<string, V> generic helper with a cast (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction put<V>(o: Record<string, V>, k: string, v: V): void { o[k] = v; }\nput(p as any, "m", () => 2);\n${sortedKeysOf("p")}`,
  "Record<string, object> helper with a cast (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction put(o: Record<string, object>, k: string, v: object): void { o[k] = v; }\nput(p as any, "m", () => 2);\n${sortedKeysOf("p")}`,
  // \`new K()\` proves the class only when K names the class itself.
  "new of a typeof-annotated const (sorted)": `class P { m(): number { return 1; } a = 1; }\nclass Q extends P { m = () => 2; }\nconst D: typeof P = Q;\n${sortedKeysOf("new D()")}`,
  "new of a constructor-type const (sorted)": `class P { m(): number { return 1; } a = 1; }\nclass Q extends P { m = () => 2; }\nconst D: new () => P = Q;\n${sortedKeysOf("new D()")}`,
  "new of a typeof parameter (sorted)": `class P { m(): number { return 1; } a = 1; }\nclass Q extends P { m = () => 2; }\nfunction f(K: typeof P): string { const keys: string[] = []; for (const k in new K()) keys.push(k); return keys.sort().join(); }\nfunction run(): string { return f(Q); }`,
  "const bound to new of a typeof parameter (sorted)": `class P { m(): number { return 1; } a = 1; }\nclass Q extends P { m = () => 2; }\nfunction f(K: typeof P): string { const o = new K(); const keys: string[] = []; for (const k in o) keys.push(k); return keys.sort().join(); }\nfunction run(): string { return f(Q); }`,
  "unassigned base declare under a derived field": `class B { declare x: number; }\nclass D extends B { y = 2; x = 1; }\n${keysOf("new D()")}`,
};

// Object/Reflect writers reached through an alias, `.call` or `Reflect.apply`
// (review round 6). On wasi these programs trap on the base too (pre-existing,
// outside #7156), so they run on gc and standalone.
const WRITER_ALIASES: Record<string, string> = {
  "assign destructured from an ObjectConstructor parameter (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction f({ assign }: ObjectConstructor, src: any): void { assign(p, src); }\nf(Object, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "Function called on a string (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst f = Function("o", "k", "o[k] = 5");\nf(p, "m");\n${sortedKeysOf("p")}`,
  "Object.assign through a const alias (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst assign = Object.assign;\nassign(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "Object.assign destructured from Object (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst { assign } = Object;\nassign(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "Object through a const alias (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst O = Object;\nconst src = { m: () => 2 };\nO.assign(p, src);\n${sortedKeysOf("p")}`,
  "Object.assign.call (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nObject.assign.call(null, p, src);\n${sortedKeysOf("p")}`,
  "Reflect.apply(Object.assign, …) (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst src = { m: () => 2 };\nReflect.apply(Object.assign, null, [p, src]);\n${sortedKeysOf("p")}`,
  "Object.defineProperty.call (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nObject.defineProperty.call(null, p, "m", { value: 2, enumerable: true });\n${sortedKeysOf("p")}`,
  "typed polyfill alias (sorted)": `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nconst assign: (t: any, ...s: any[]) => any = Object.assign;\nassign(p, { m: () => 2 });\n${sortedKeysOf("p")}`,
  "alias used in a constructor (sorted)": `const assign = Object.assign;\nclass C { a = 1; m(): number { return 1; } constructor(opts: any) { assign(this, opts); } }\n${sortedKeysOf("new C({ m: 3 })")}`,
};

describe("#7156 static for-in unroll lists only own enumerable keys, in order", () => {
  for (const [label, body] of Object.entries(CASES)) {
    it(label, () => expectSameOnLanes(body));
  }
  for (const [label, body] of Object.entries(NOT_SIMPLE)) {
    it(`not simple: ${label}`, () => expectSameOnLanes(body));
  }
  for (const [label, body] of Object.entries(WRITER_ALIASES)) {
    it(`not simple: ${label} (gc, standalone)`, () =>
      expectSameOnLanes(
        body,
        LANES.filter((l) => l.lane !== "wasi"),
      ));
  }
  // Reading the value back through the key. On wasi `o[k]` over a WasmGC
  // struct reads `undefined` for a plain object literal too (pre-existing,
  // outside #7156), so that lane is left out of this row.
  // A class-typed parameter keeps the checker's list (methods included), as
  // before #7156: node prints "y". Pinned so a change here is deliberate (#4138).
  it("class-typed parameter keeps the old key list (pinned)", () =>
    expectSameOnLanes(
      `class C { y = 2; m() {} }\nfunction f(c: C): string { const keys: string[] = []; for (const k in c) keys.push(k); return keys.join(); }\nfunction run(): string { return f(new C()); }`,
      LANES,
      "y,m",
    ));
  // A constructor that returns an object replaces the instance, so `new C()`
  // proves nothing; the chain keeps the old list. On wasi the dynamic result
  // reads wrong on the base too (pre-existing), so that lane is left out.
  it("not simple: constructor returns another object (gc, standalone)", () =>
    expectSameOnLanes(
      `class C { a = 1; m(): number { return 1; } constructor() { return { z: 1 } as any; } }\n${keysOf("new C()")}`,
      LANES.filter((l) => l.lane !== "wasi"),
    ));
  // Known limitation (review round 7): a cast instance passed as
  // \`Record<string, number>\` and given a number in a method slot. The
  // primitive-valued index signature is exempt, so \`m\` is dropped (node: "a,m").
  it("cast instance written through Record<string, number> (pinned)", () =>
    expectSameOnLanes(
      `class P { a = 1; m(): number { return 1; } }\nconst p = new P();\nfunction put(o: Record<string, number>, k: string, v: number): void { o[k] = v; }\nput(p as any, "m", 5);\n${sortedKeysOf("p")}`,
      LANES,
      "a",
    ));
  it("values read through the key (gc, standalone)", () =>
    expectSameOnLanes(
      `class C { #x = 1; y = 2; z = 3; m() {} }\nfunction run(): string { const c = new C(); let s = ""; for (const k in c) s += k + "=" + (c as any)[k] + ";"; return s; }`,
      LANES.filter((l) => l.lane !== "wasi"),
    ));
  it("declare field assigned in the constructor, values summed (gc, standalone)", () =>
    expectSameOnLanes(
      `class C { declare a: number; b = 2; constructor() { this.a = 40; } }\nfunction run(): string { const c = new C(); let n = 0; for (const k in c) n += (c as any)[k]; return String(n); }`,
      LANES.filter((l) => l.lane !== "wasi"),
    ));
});
