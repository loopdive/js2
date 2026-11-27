// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7425 — `yield*` over a class iterator threw "Invalid iterator protocol": the delegation read `@@iterator` through
// the runtime-key path, which never saw a class's `[Symbol.iterator]()` method. The object-literal half needs a
// symbol key space a string cannot spell (#7495). Each program carries node's answer, including the string keys
// spelled `"@@iterator"` that must stay strings (review RV7444, B1/B2).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.js", allowJs: true });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  const imports =
    target === "gc"
      ? buildImports(result.imports, undefined, result.stringPool)
      : target === "wasi"
        ? { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }
        : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.main as () => unknown)();
}

const ITERATOR = `
class It {
  constructor() { this.i = 0; this.got = 0; this.r = 0; this.t = 0; }
  [Symbol.iterator]() { return this; }
  next(v) { if (v !== undefined) this.got = v; this.i++; return { value: this.i, done: this.i > 3 }; }
  return(v) { this.r++; return { value: v, done: true }; }
  throw(e) { this.t++; return { value: 50, done: false }; }
}
`;

const yieldStar: [string, string][] = [
  [
    "values",
    "function* g() { yield* new It(); } export function main() { let s = 0; for (const v of g()) s = s * 10 + v; return s; }",
  ],
  [
    "next(v)",
    "export function main() { const it = new It(); function* g() { yield* it; } const x = g(); x.next(); x.next(7); return it.got; }",
  ],
  [
    "return()",
    "export function main() { const it = new It(); function* g() { yield* it; } const x = g(); x.next(); const r = x.return(); return it.r * 10 + (r.done ? 1 : 0); }",
  ],
  [
    "throw()",
    'export function main() { const it = new It(); function* g() { yield* it; } const x = g(); x.next(); const r = x.throw(new Error("e")); return it.t * 100 + r.value; }',
  ],
  [
    "[Symbol.iterator] read",
    'export function main() { const it = new It(); const f = it[Symbol.iterator]; return typeof f === "function" && f.call(it) === it ? 1 : 0; }',
  ],
  [
    "beside a struct with a next field",
    "const p = { next: 3 }; function* g() { yield* new It(); } export function main() { let s = 0; for (const v of g()) s += v; return s + p.next; }",
  ],
];

// A string key spelled like the internal symbol name must stay a string key.
const LITERAL = "const o = { a: 1, [Symbol.iterator]() { return this; } };";
const stringKeys: [string, string][] = [
  ["B1 Object.keys", `export function main() { ${LITERAL} return Object.keys(o).length; }`],
  ["B1 Object.entries", `export function main() { ${LITERAL} return Object.entries(o).length; }`],
  ["B1 Object.hasOwn", `export function main() { ${LITERAL} return Object.hasOwn(o, "@@iterator") ? 1 : 0; }`],
  ["B1 string read", `export function main() { ${LITERAL} return o["@@iterator"] === undefined ? 1 : 0; }`],
  [
    "B1 computed string read",
    `export function main() { ${LITERAL} return o["@@" + "iterator"] === undefined ? 1 : 0; }`,
  ],
  ["B1 spread", `export function main() { ${LITERAL} return Object.keys({ ...o }).length; }`],
  [
    "B1 string key beside the symbol",
    'export function main() { const o = { "@@iterator": 5, [Symbol.iterator]() { return this; } }; return o["@@iterator"]; }',
  ],
  [
    "B2 class string-literal key",
    'class C { "@@iterator"() { return 9; } } export function main() { return new C()[Symbol.iterator] === undefined ? 1 : 0; }',
  ],
  [
    "B2 class computed string key",
    'class C { ["@@iterator"]() { return 9; } } export function main() { return new C()[Symbol.iterator] === undefined ? 1 : 0; }',
  ],
];

const node = (source: string): unknown => new Function(`${source.replace(/export /g, "")}; return main();`)();

async function expectNode(source: string): Promise<void> {
  const expected = node(source);
  for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
}

describe("#7425 yield* over a class iterator", () => {
  it.each(yieldStar)("%s", async (_, body) => expectNode(ITERATOR + body));
});

describe("#7425 a string key spelled @@iterator stays a string key", () => {
  it.each(stringKeys)("%s", async (_, body) => expectNode(body));
});
