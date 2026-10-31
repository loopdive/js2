// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7159 — §25.5.2 SerializeJSONProperty step 11: a callable value has no JSON
// serialisation. `JSON.stringify(C)` is `undefined`, `{ a: C }` omits the key
// and `[C]` renders `null`. A class VALUE is a `$C` struct singleton, so the
// codec's closed-struct classifier walked it as an instance (`{}`, `{"y":0}`)
// and its `toJSON` dispatcher found the INSTANCE method. Each row is diffed
// against native JS on the gc (native-first), standalone and wasi lanes.
//
// NOT covered: a callable at the TOP level. node answers `undefined`; the codec
// roots coalesce "no serialisation" to `"null"`, because a `JSON.stringify`
// result lives in a string-typed slot that cannot hold `undefined` (#6734 —
// `console.log(JSON.stringify(undefined))` traps on the same slot today). The
// `it.skip` rows below pin those programs for #6734.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports as buildRuntimeImports, instantiateWasm } from "../../src/runtime.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest (-1 for `undefined`) and all lanes compare numbers.
const ENC =
  "function enc(s: string | undefined): number { if (s === undefined) return -1; let h = s.length; " +
  "for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n";

// Pre-existing wasi gaps, independent of #7159 (same answer on main): a class
// INSTANCE renders `null`, and so does an object literal holding a function
// inside an array (`{ x: [{ v: fn }] }`, the "nested" position); a static
// `toJSON` on a class is not called.
const NOT_ON_WASI = new Set([
  "static toJSON, top level",
  "static toJSON, property and array",
  "instance toJSON while the class value is serialised",
  "class property next to instances",
  "toJSON on the class prototype",
  "nested callables next to an instance",
  ...["class", "function", "arrow", "method", "bound function"].map((k) => `${k} × nested`),
]);

async function expectSameOnAllLanes(name: string, body: string): Promise<void> {
  const src = `${ENC}function value(): string | undefined { ${body} }\nexport function test(): number { return enc(value()); }`;
  const expected = evaluateAsJs(src).test!();
  const targets = NOT_ON_WASI.has(name)
    ? ([undefined, "standalone"] as const)
    : ([undefined, "standalone", "wasi"] as const);
  for (const target of targets) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const ISSUE_ROWS: [string, string][] = [
  ["class with a private field, property", `class C { #x = 1 } return JSON.stringify({ a: C });`],
  ["class with a private field, array", `class C { #x = 1 } return JSON.stringify([C]);`],
  ["class with only public fields", `class C { y = 2 } return JSON.stringify({ a: C }) + "|" + JSON.stringify([C]);`],
  [
    "class property next to instances",
    `class C { y = 2 } return JSON.stringify({ a: C, b: new C(), c: [new C(), C] });`,
  ],
  [
    "nested callables next to an instance",
    `class C { y = 2 } function f() { return 1; } return JSON.stringify({ x: [C, { f: f, z: [f, new C()] }], w: { g: () => 0 } });`,
  ],
  ["replacer function", `class C { y = 2 } return JSON.stringify({ a: C, b: 1 }, (k: string, v: any) => v);`],
  ["indent", `class C { y = 2 } return JSON.stringify({ a: C, b: [C, 1] }, null, 2);`],
  [
    "toJSON on the class prototype",
    `class C { y = 2; toJSON() { return "c"; } } return JSON.stringify([C, new C()]) + JSON.stringify({ a: C });`,
  ],
];

// §25.5.2 order: toJSON (step 2) runs BEFORE the callable test (step 11), and
// the test then screens toJSON's RESULT. A class value's toJSON is its own
// static member, never the instance method.
const TO_JSON_ROWS: [string, string][] = [
  ["static toJSON, top level", `class C { static toJSON() { return "S"; } y = 1 } return JSON.stringify(C);`],
  [
    "static toJSON, property and array",
    `class C { static toJSON() { return "S"; } y = 1 } return JSON.stringify({ a: C, b: [C] });`,
  ],
  [
    "instance toJSON while the class value is serialised",
    `class C { toJSON() { return "I"; } y = 1 } return JSON.stringify({ c: C, d: [C], e: new C() });`,
  ],
  [
    "toJSON returning a class",
    `class C { y = 1 } const o = { toJSON() { return C; } }; return JSON.stringify({ a: o, b: [o] });`,
  ],
  [
    "toJSON returning a function",
    `function f() { return 1; } const o = { toJSON() { return f; } }; return JSON.stringify({ a: o, b: [o] });`,
  ],
  [
    "static toJSON returning a class",
    `class D { y = 2 } class C { static toJSON() { return D; } } return JSON.stringify({ a: C, b: [C] });`,
  ],
];

// A function's OWN `toJSON` property: node calls it (`{"a":"T","b":["T"]}`);
// every lane omits / nulls the function instead — the codec's toJSON step only
// looks at objects and class structs, not closures. Same answer on main.
const FN_OWN_TO_JSON = `function f() { return 1; } (f as any).toJSON = () => "T"; return JSON.stringify({ a: f, b: [f] });`;

// (#6734) Top-level callables: node answers `undefined`, every lane `"null"`.
const TOP_LEVEL_ROWS: [string, string][] = [
  ["class with a private field, top level", `class C { #x = 1 } return JSON.stringify(C);`],
  ["class with only public fields, top level", `class C { y = 2 } return JSON.stringify(C);`],
  ["function, top level", `function f() { return 1; } return JSON.stringify(f);`],
  ["arrow, top level", `return JSON.stringify(() => 1);`],
  ["class, top level with indent", `class C { y = 2 } return JSON.stringify(C, null, 2);`],
];

// callable kind × position. `decl` declares the callable; `F` names it.
const KINDS: [string, string, string][] = [
  ["class", "class K { #p = 1; q = 2; }", "K"],
  ["function", "function fn() { return 1; }", "fn"],
  ["arrow", "const ar = (x: number) => x;", "ar"],
  ["method", "const o = { m() { return 1; } };", "o.m"],
  ["bound function", "function g() { return 1; } const bf = g.bind(null);", "bf"],
];
const POSITIONS: [string, (f: string) => string][] = [
  ["property", (f) => `JSON.stringify({ a: ${f}, b: 1 })`],
  ["array", (f) => `JSON.stringify([${f}, 1])`],
  ["nested", (f) => `JSON.stringify({ x: [{ v: ${f}, w: [${f}] }], y: [[${f}]] })`],
];

describe("#7159 JSON.stringify of function values (class constructors included)", () => {
  for (const [name, body] of ISSUE_ROWS) it(name, () => expectSameOnAllLanes(name, body));
  for (const [name, body] of TO_JSON_ROWS) it(name, () => expectSameOnAllLanes(name, body));
  it.fails("function with its own toJSON property (not called; pre-existing)", () =>
    expectSameOnAllLanes("function own toJSON", FN_OWN_TO_JSON),
  );
  for (const [name, body] of TOP_LEVEL_ROWS) it.skip(`#6734: ${name}`, () => expectSameOnAllLanes(name, body));
  for (const [kind, decl, f] of KINDS) {
    for (const [pos, make] of POSITIONS) {
      const name = `${kind} × ${pos}`;
      it(name, () => expectSameOnAllLanes(name, `${decl} return ${make(f)};`));
    }
  }
});

// The issue's property / array programs, printed through console.log as the
// report showed them (gc native-first and standalone; the digest rows cover wasi).
const PRINTED: Record<string, string> = {
  property: `class C { #x = 1 }\nconsole.log(JSON.stringify({ a: C }));`,
  array: `class C { #x = 1 }\nconsole.log(JSON.stringify([C]));`,
  "functions as values": `function f() {}\nconsole.log(JSON.stringify({ f, g: () => 1, h: [f] }));`,
};

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out;
}

async function runPrinted(src: string, target: "standalone" | "gc"): Promise<string[]> {
  const result = await compile(src, {
    fileName: "probe.js",
    deferTopLevelInit: true,
    ...(target === "standalone" ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const out: string[] = [];
  type Exports = Record<string, ((...a: number[]) => number) | undefined>;
  if (target === "gc") {
    const built = buildRuntimeImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const origLog = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      (instance.exports as Exports).__module_init?.();
    } finally {
      console.log = origLog;
    }
    return out;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exp = instance.exports as Exports;
  exp.__module_init?.();
  const len = exp.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
  for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  return out;
}

describe("#7159 printed output", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(PRINTED)) {
      it(`${target === "gc" ? "gc native-first" : "standalone"}: ${name}`, async () => {
        expect(await runPrinted(src, target)).toEqual(runV8(src));
      });
    }
  }
});
