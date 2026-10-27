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

async function expectSameOnLanes(body: string, lanes: readonly (typeof LANES)[number][] = LANES): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of lanes) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

const keysOf = (expr: string): string =>
  `function run(): string { const keys: string[] = []; for (const k in ${expr}) keys.push(k); return keys.join(); }`;

const CASES: Record<string, string> = {
  "private name, field, method": `class C { #x = 1; y = 2; m() {} }\n${keysOf("new C()")}`,
  "subclass: base fields first": `class C { #x = 1; y = 2; m() {} }\nclass D extends C { w = 3; n() {} }\n${keysOf("new D()")}`,
  "redeclared field keeps the base position": `class B { y = 1; z = 2; }\nclass D extends B { w = 3; y = 4; }\n${keysOf("new D()")}`,
  "getter/setter pair is not own": `class G { get a() { return 1; } set a(v: number) {} b = 1; }\n${keysOf("new G()")}`,
  "getter-only class enumerates nothing": `class G { get a() { return 1; } }\nfunction run(): string { let s = "n"; for (const k in new G()) s += k; return s; }`,
  "static field and method": `class S { static s = 1; t = 2; static f() {} }\n${keysOf("new S()")}`,
  "parameter properties before fields": `class P { c = 1; constructor(public a: number, b: number) {} d = 2; }\n${keysOf("new P(1, 2)")}`,
  // `declare` and interface-merged fields are own once assigned (constructor
  // or base class), so they must stay; a derived `declare` keeps the base position.
  "declare field assigned in the constructor": `class C { declare a: number; b = 2; constructor() { this.a = 1; } }\n${keysOf("new C()")}`,
  "declare field assigned (sorted)": `class C { declare a: number; b = 2; constructor() { this.a = 1; } }\nfunction run(): string { const keys: string[] = []; for (const k in new C()) keys.push(k); return keys.sort().join(); }`,
  "interface-merged field assigned in the constructor": `interface C { extra: number }\nclass C { a = 1; constructor() { this.extra = 7; } }\n${keysOf("new C()")}`,
  "derived declare over a base field": `class B { y = 1; z = 2; }\nclass D extends B { declare y: number; w = 3; }\nfunction run(): string { let n = 0; for (const k in new D()) n++; return String(n); }`,
  "derived declare over a base field (order)": `class B { y = 1; z = 2; }\nclass D extends B { declare y: number; w = 3; }\n${keysOf("new D()")}`,
  "derived declare over a base parameter property": `class B { constructor(public p: number) {} }\nclass D extends B { declare p: number; q = 1; constructor() { super(1); } }\n${keysOf("new D()")}`,
  "definite-assignment field": `class Q { x!: number; r = 1; }\n${keysOf("new Q()")}`,
  "computed string-literal key keeps its position": `class C { ["k1"] = 1; a = 2; }\n${keysOf("new C()")}`,
  "abstract field placed by the subclass": `abstract class A { abstract a: number; q = 1; }\nclass B extends A { a = 2; }\n${keysOf("new B()")}`,
  "auto-accessor is not own": `class C { accessor a = 1; b = 2; }\n${keysOf("new C()")}`,
  "generic class with accessor": `class G<T> { v: T; constructor(v: T) { this.v = v; } get g() { return 1; } }\n${keysOf("new G<number>(1)")}`,
  "spread then own key": `const a = { x: 1, y: 2 };\n${keysOf("{ ...a, z: 3 }")}`,
  "own key, spread, redefined key": `const a = { x: 1, y: 2 };\n${keysOf("{ z: 0, ...a, x: 5, w: 1 }")}`,
  "spread literal through a const": `const a = { x: 1, y: 2 };\nconst o = { ...a, z: 3 };\n${keysOf("o")}`,
  "spread of a class instance": `class C { #x = 1; y = 2; m() {} }\n${keysOf("{ ...new C(), z: 1 }")}`,
  "plain literal order unchanged": keysOf("{ b: 1, a: 2 }"),
};

describe("#7156 static for-in unroll lists only own enumerable keys, in order", () => {
  for (const [label, body] of Object.entries(CASES)) {
    it(label, () => expectSameOnLanes(body));
  }
  // Reading the value back through the key. On wasi `o[k]` over a WasmGC
  // struct reads `undefined` for a plain object literal too (pre-existing,
  // outside #7156), so that lane is left out of this row.
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
