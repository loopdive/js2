// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7199 — the #7158 twin test compared field type INDICES, so two classes whose
// fields point at DIFFERENT but structurally identical structs
// (`class A { a: P }` / `class B { b: Q }` with `P`, `Q` themselves twins) were
// not seen as twins, although WasmGC canonicalises both pairs to one type. The
// enumeration arms and the per-name method ladders then fired for the wrong
// class: `JSON.stringify(new B())` printed `{"a":{"q":1}}` and `b.name()` ran
// `A`'s body. The test now compares referenced types structurally (nested
// structs, arrays, self- and mutually-recursive references). Each row is diffed
// against native JS.
//
// The wasi lane runs only `Object.keys` and method dispatch: its JSON.stringify,
// for…in, getOwnPropertyNames, Object.assign and spread of a class instance
// with a reference field answer `null` / empty even without twins (#7201).
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

// Each entry declares two twin classes `X` and `Y` (plus helpers) that differ
// only in names, so their structs canonicalise to one type.
const TWINS: Record<string, string> = {
  "nested struct": `class P { p = 1 }\nclass Q { q = 1 }\nclass X { a: P = new P() }\nclass Y { b: Q = new Q() }`,
  "array field": `class P { p = 1 }\nclass Q { q = 1 }\nclass X { a: P[] = [new P()] }\nclass Y { b: Q[] = [new Q()] }`,
  "deeper nesting": `class P { p = 1 }\nclass Q { q = 1 }\nclass P2 { x: P = new P() }\nclass Q2 { y: Q = new Q() }\nclass X { a: P2 = new P2() }\nclass Y { b: Q2 = new Q2() }`,
  "self-recursive": `class X { v = 1; a: X | null = null }\nclass Y { w = 2; b: Y | null = null }`,
  "mutually recursive pairs": `class X { v = 1; m: M | null = null }\nclass M { w = 2; x: X | null = null }\nclass Y { u = 3; n: N | null = null }\nclass N { z = 4; y: Y | null = null }`,
  "mixed scalar and nested": `class P { s = "p"; n = 1 }\nclass Q { t = "q"; m = 2 }\nclass X { k = 1; a: P = new P(); f = true }\nclass Y { l = 2; b: Q = new Q(); g = false }`,
};

const CONSUMERS: [string, string, readonly (typeof ALL)[number][]][] = [
  ["JSON.stringify", "JSON.stringify(o)", NO_WASI],
  ["Object.keys", "Object.keys(o).join()", ALL],
  ["spread", "JSON.stringify({ ...o })", NO_WASI],
  ["Object.assign", "JSON.stringify(Object.assign({}, o))", NO_WASI],
  ["getOwnPropertyNames", "Object.getOwnPropertyNames(o).join()", NO_WASI],
  ["for-in", "(() => { const k: string[] = []; for (const p in o) k.push(p); return k.join(); })()", NO_WASI],
];

describe("#7199 twins through structurally identical field types", () => {
  it("issue repro: JSON.stringify(new B())", async () => {
    await expectSameOnLanes(
      `class P { p = 1 }\nclass Q { q = 1 }\nclass A { a: P = new P() }\nclass B { b: Q = new Q() }\nfunction run(): string { return JSON.stringify(new B()) + JSON.stringify(new A()); }`,
      NO_WASI,
    );
  });
  for (const [twin, decls] of Object.entries(TWINS)) {
    for (const [consumer, expr, lanes] of CONSUMERS) {
      it(`${twin}: ${consumer}`, async () => {
        const body = `${decls}\nfunction run(): string { let s = "";\n{ const o: any = new X(); s += ${expr} + "|"; }\n{ const o: any = new Y(); s += ${expr} + "|"; }\nreturn s; }`;
        await expectSameOnLanes(body, lanes);
      });
    }
    it(`${twin}: method dispatch by name`, async () => {
      const withMethods = decls
        .replace(/class X \{/, 'class X { name() { return "X"; }')
        .replace(/class Y \{/, 'class Y { name() { return "Y"; }');
      const body = `${withMethods}\nfunction run(): string { const xs: any[] = [new X(), new Y()]; let s = ""; for (const o of xs) s += o.name(); return s; }`;
      await expectSameOnLanes(body, ALL);
    });
  }
  it("mutually recursive pairs: every member, linked", async () => {
    await expectSameOnLanes(
      `class A { v = 1; b: B | null = null }\nclass B { w = 2; a: A | null = null }\nclass C { x = 3; d: D | null = null }\nclass D { y = 4; c: C | null = null }\nfunction run(): string { const c = new C(); c.d = new D(); const xs: any[] = [c, new A(), new B(), new D()]; let s = ""; for (const o of xs) s += JSON.stringify(o) + Object.keys(o).join() + ";"; return s; }`,
      NO_WASI,
    );
  });
  it("near-twins whose nested structs differ stay distinct", async () => {
    await expectSameOnLanes(
      `class P { p = 1 }\nclass Q { q = "s" }\nclass A { a: P = new P() }\nclass B { b: Q = new Q() }\nfunction run(): string { const xs: any[] = [new A(), new B()]; let s = ""; for (const o of xs) s += JSON.stringify(o) + Object.keys(o).join(); return s; }`,
      NO_WASI,
    );
  });
});
