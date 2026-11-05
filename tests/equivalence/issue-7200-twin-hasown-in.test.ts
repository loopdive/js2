// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7200 — `class A { a = 1 }` and `class B { b = 1 }` are "twins": distinct
// classes whose WasmGC structs canonicalise to ONE type, so the closed-struct
// own-property arms (`fillClosedStructHasOwnArms`) answered for the wrong
// class — `new B().hasOwnProperty("a")` and `"a" in new B()` were both true.
// #7158 gave the enumeration arms a nominal `__tag` guard; the own-property
// arms (`__hasOwnProperty`, `__object_hasOwn`, `__propertyIsEnumerable`,
// `__extern_has`) now share it. `Object.getOwnPropertyDescriptor` on an `any`
// receiver reads through `__hasOwnProperty`, so it is fixed with them. Each
// row is diffed against native JS.
//
// The wasi lane runs only the rows that already hold there: wasi does not get
// the closed-struct own-property arms yet (it answers `false` for every field,
// twin or not) until #7201 / PR #7020 widens their gate to `noJsHost(ctx)`.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const GC = { lane: "gc", options: {} } as const;
const STANDALONE = { lane: "standalone", options: { target: "standalone" } } as const;
const WASI = { lane: "wasi", options: { target: "wasi" } } as const;
const ALL = [GC, STANDALONE, WASI] as const;
const NO_WASI = [GC, STANDALONE] as const;

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

const AB = `class A { a = 1 }\nclass B { b = 1 }`;
/** `o` is a `B`, `p` an `A`; `expr` is an array of answers. */
const overAB = (expr: string): string =>
  `${AB}\nfunction run(): string { const o: any = new B(); const p: any = new A(); return ${expr}.join(); }`;
/** Every instance in `news` answers `expr` (over `o`). */
const overEach = (decls: string, news: string, expr: string): string =>
  `${decls}\nfunction run(): string { const xs: any[] = [${news}]; let s = ""; for (const o of xs) s += ${expr}.join() + ";"; return s; }`;

const ROWS: [string, string, readonly (typeof ALL)[number][]][] = [
  [
    "issue repro: hasOwnProperty and in",
    overAB(`[o.hasOwnProperty("a"), "a" in o, p.hasOwnProperty("a"), "a" in p, o.hasOwnProperty("b"), "b" in o]`),
    NO_WASI,
  ],
  [
    "Object.hasOwn",
    overAB(`[Object.hasOwn(o, "a"), Object.hasOwn(o, "b"), Object.hasOwn(p, "a"), Object.hasOwn(p, "b")]`),
    NO_WASI,
  ],
  [
    "Object.prototype.hasOwnProperty.call",
    overAB(`[Object.prototype.hasOwnProperty.call(o, "a"), Object.prototype.hasOwnProperty.call(p, "a")]`),
    NO_WASI,
  ],
  [
    "propertyIsEnumerable",
    overAB(`[o.propertyIsEnumerable("a"), o.propertyIsEnumerable("b"), p.propertyIsEnumerable("a")]`),
    NO_WASI,
  ],
  [
    "getOwnPropertyDescriptor",
    overAB(
      `[Object.getOwnPropertyDescriptor(o, "a") === undefined, Object.getOwnPropertyDescriptor(o, "b") !== undefined, Object.getOwnPropertyDescriptor(p, "a") !== undefined]`,
    ),
    NO_WASI,
  ],
  [
    "subclass pairs: own versus inherited fields",
    overEach(
      `${AB}\nclass C extends A { c = 2 }\nclass D extends B { d = 2 }`,
      "new A(), new B(), new C(), new D()",
      `[o.hasOwnProperty("a"), "a" in o, o.hasOwnProperty("b"), "b" in o, o.hasOwnProperty("c"), "c" in o, Object.hasOwn(o, "d")]`,
    ),
    NO_WASI,
  ],
  [
    "inherited Object.prototype members stay visible to in",
    overAB(`["toString" in o, "a" in o, "hasOwnProperty" in p, o.hasOwnProperty("toString")]`),
    NO_WASI,
  ],
  [
    "delete",
    `${AB}\nfunction run(): string { const o: any = new B(); const p: any = new A(); delete p.a; delete o.b; return [o.hasOwnProperty("a"), "a" in o, p.hasOwnProperty("a"), "a" in p, "b" in o].join(); }`,
    ALL,
  ],
  [
    "expando on a non-twin name",
    `${AB}\nfunction run(): string { const o: any = new B(); o.z = 5; return [o.hasOwnProperty("z"), "z" in o, o.hasOwnProperty("a"), "a" in o].join(); }`,
    NO_WASI,
  ],
  [
    "nested twins (#7199 shape)",
    overEach(
      `class P { p = 1 }\nclass Q { q = 1 }\nclass A { a: P = new P() }\nclass B { b: Q = new Q() }`,
      "new A(), new B(), new P(), new Q()",
      `[o.hasOwnProperty("a"), "a" in o, "b" in o, "p" in o, Object.hasOwn(o, "q")]`,
    ),
    NO_WASI,
  ],
  [
    "self-recursive twins",
    overEach(
      `class A { v = 1; a: A | null = null }\nclass B { w = 2; b: B | null = null }`,
      "new A(), new B()",
      `["a" in o, "b" in o, "v" in o, o.hasOwnProperty("w")]`,
    ),
    NO_WASI,
  ],
  [
    "Proxy over a twin class instance",
    `${AB}\nfunction run(): string { const o: any = new Proxy(new B(), {}); return ["a" in o, "b" in o, Object.hasOwn(o, "a")].join(); }`,
    NO_WASI,
  ],
  [
    "control: classes with distinct layouts",
    overEach(
      `class A { a = 1 }\nclass B { b = "x" }`,
      "new A(), new B()",
      `[o.hasOwnProperty("a"), "a" in o, "b" in o, Object.hasOwn(o, "b")]`,
    ),
    NO_WASI,
  ],
];

describe("#7200 own-property lookup respects twin-layout class tags", () => {
  for (const [name, body, lanes] of ROWS) {
    it(name, async () => {
      await expectSameOnLanes(body, lanes);
    });
  }
});
