// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7201 — on `--target wasi` a class instance (even with one class) read as an
// empty object to every closed-struct consumer: `JSON.stringify(new A())` was
// `null`, for…in / getOwnPropertyNames were empty, hasOwnProperty was false and
// `Object.assign({}, new A())` copied nothing. The finalize-time fills that give
// those helpers their closed-struct arms (`__extern_get`, `__hasOwnProperty`,
// `__getOwnPropertyNames`, the Object.assign/JSON source classifier) were gated
// on `ctx.standalone` alone; wasi is the other no-host target and now shares
// them. Object literals read through `any` (`({ length: 2 } as any).length`)
// were `undefined` for the same reason. Each row is diffed against native JS;
// the result is read back one char code at a time so no lane needs string
// marshalling.
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

const CASES: Record<string, string> = {
  "JSON.stringify": `class A { a = 1 }\nfunction run(): string { return JSON.stringify(new A()); }`,
  hasOwnProperty: `class A { a = 1 }\nfunction run(): string { const o: any = new A(); return String(o.hasOwnProperty("a")) + String(o.hasOwnProperty("zz")); }`,
  "for-in": `class A { a = 1; b = 2 }\nfunction run(): string { const o: any = new A(); const k: string[] = []; for (const p in o) k.push(p); return k.join(); }`,
  getOwnPropertyNames: `class A { a = 1 }\nfunction run(): string { const o: any = new A(); return Object.getOwnPropertyNames(o).join(); }`,
  "Object.assign from an instance": `class A { a = 1 }\nfunction run(): string { return JSON.stringify(Object.assign({}, new A())); }`,
  "Object.keys": `class A { a = 1 }\nfunction run(): string { return Object.keys(new A()).join(); }`,
  "Object.entries length and pair": `class A { a = 1 }\nfunction run(): string { const e = Object.entries(new A()); return e.length + ":" + e[0][0] + "=" + e[0][1]; }`,
  "computed read and write through any": `class A { a = 1 }\nfunction run(): string { const o: any = new A(); o.a = 7; o["b"] = 2; return JSON.stringify(o) + o["a"] + o.b; }`,
  "expando and delete": `class A { a = 1 }\nfunction run(): string { const o: any = new A(); o.z = 5; delete o.a; return JSON.stringify(o) + Object.keys(o).join() + String(o.hasOwnProperty("a")) + String("z" in o); }`,
  "methods and getters stay off the own keys": `class B { x = 1; get y() { return 2; } m() { return 3; } }\nfunction run(): string { const b: any = new B(); return JSON.stringify(b) + Object.keys(b).join() + b.y + b.m() + String(b.hasOwnProperty("y")) + String(b.hasOwnProperty("m")); }`,
  subclass: `class P { p = 1 }\nclass C extends P { c = 2 }\nfunction run(): string { const c: any = new C(); const k: string[] = []; for (const q in c) k.push(q); return JSON.stringify(c) + k.join() + Object.getOwnPropertyNames(c).join() + JSON.stringify(Object.assign({}, c)); }`,
  "instances nested in arrays and objects": `class A { a = 1; b = "x"; n: any = null }\nfunction run(): string { const xs = [new A(), new A()]; return JSON.stringify(xs) + JSON.stringify({ k: new A() }); }`,
  "nested object literal": `function run(): string { const o = { a: 1, b: { c: [1, 2, { d: "x" }] } }; return JSON.stringify(o) + Object.keys(o).join(); }`,
  "array-like object literal through any": `function run(): string { const o: any = { length: 2, 0: "x", 1: "y" }; return String(o.length) + o[0] + o[1]; }`,
  "JSON.stringify with indent": `class A { a = 1; b = [1] }\nfunction run(): string { const o: any = new A(); return JSON.stringify(o, null, 2); }`,
};

describe("#7201 wasi closed-struct consumers match native JS", () => {
  for (const [name, body] of Object.entries(CASES)) {
    it(name, async () => {
      const src = `${body}\n${READ}`;
      const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
      for (const { lane, options } of LANES) {
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
      }
    });
  }
});
