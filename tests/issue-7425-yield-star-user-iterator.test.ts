// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7425 — `yield*` over a user iterator (a class or an object literal) threw "Invalid iterator protocol": the
// delegation read `@@iterator` through the runtime-key path, which saw neither a class's `[Symbol.iterator]()`
// method nor an object literal's. Each program carries node's answer.
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

// Both iterator kinds in every program: a closed struct declaring `@@iterator` must not shadow the class read.
const ITERATORS = `
class It {
  constructor() { this.i = 0; this.got = 0; this.r = 0; this.t = 0; }
  [Symbol.iterator]() { return this; }
  next(v) { if (v !== undefined) this.got = v; this.i++; return { value: this.i, done: this.i > 3 }; }
  return(v) { this.r++; return { value: v, done: true }; }
  throw(e) { this.t++; return { value: 50, done: false }; }
}
function mk() {
  const o = {
    i: 0, got: 0, r: 0, t: 0,
    [Symbol.iterator]() { return this; },
    next(v) { if (v !== undefined) o.got = v; o.i++; return { value: o.i, done: o.i > 3 }; },
    return(v) { o.r++; return { value: v, done: true }; },
    throw(e) { o.t++; return { value: 50, done: false }; },
  };
  return o;
}
`;

const cases: [string, string][] = [];
for (const [kind, make] of [
  ["class", "new It()"],
  ["object literal", "mk()"],
]) {
  cases.push(
    [
      `${kind}: values`,
      `function* g() { yield* ${make}; } export function main() { let s = 0; for (const v of g()) s = s * 10 + v; return s; }`,
    ],
    [
      `${kind}: next(v)`,
      `export function main() { const it = ${make}; function* g() { yield* it; } const x = g(); x.next(); x.next(7); return it.got; }`,
    ],
    [
      `${kind}: return()`,
      `export function main() { const it = ${make}; function* g() { yield* it; } const x = g(); x.next(); const r = x.return(); return it.r * 10 + (r.done ? 1 : 0); }`,
    ],
    [
      `${kind}: throw()`,
      `export function main() { const it = ${make}; function* g() { yield* it; } const x = g(); x.next(); const r = x.throw(new Error("e")); return it.t * 100 + r.value; }`,
    ],
    [
      `${kind}: [Symbol.iterator] read`,
      `export function main() { const it = ${make}; const f = it[Symbol.iterator]; return typeof f === "function" && f.call(it) === it ? 1 : 0; }`,
    ],
  );
}

const node = (source: string): unknown => new Function(`${source.replace(/export /g, "")}; return main();`)();

describe("#7425 yield* over a user iterator", () => {
  it.each(cases)("%s", async (_, body) => {
    const source = ITERATORS + body;
    const expected = node(source);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
