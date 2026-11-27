// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7424 — array destructuring of a class / object-literal iterator that stops before the iterator is done must run
// IteratorClose (§8.6.2, §13.15.5.2), i.e. call `return()` once. The declaration lane drained the whole iterator into a
// vec and never closed it; a typed `function f([a]: It)` parameter never iterated at all. Both now take the bounded
// `__array_from_iter_n` drive, which steps exactly `elements.length` times and closes. Each program carries node's
// answer, encoded as `r * 100 + i * 10 + value`: `r` counts `return()` calls, `i` counts `next()` calls.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, fileName: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName, allowJs: true });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
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

const node = (source: string): unknown =>
  new Function(
    `${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/export /g, "")}; return main();`,
  )();

// Both iterators yield 1, 2 and are done on the third `next()`.
const CLASS_IT = `class It { constructor() { this.i = 0; this.r = 0; }
  [Symbol.iterator]() { return this; }
  next() { this.i++; return { value: this.i, done: this.i > 2 }; }
  return() { this.r++; return { value: undefined, done: true }; } }
`;
const OBJ_IT = `function mk() { const o = { i: 0, r: 0, [Symbol.iterator]() { return o; },
  next() { o.i++; return { value: o.i, done: o.i > 2 }; },
  return() { o.r++; return { value: undefined, done: true }; } }; return o; }
`;
const TYPED_IT = `class It implements Iterable<number>, Iterator<number> {
  i = 0; r = 0;
  [Symbol.iterator](): Iterator<number> { return this; }
  next(): IteratorResult<number> { this.i++; return { value: this.i, done: this.i > 2 }; }
  return(): IteratorResult<number> { this.r++; return { value: 0, done: true }; } }
`;
const SCORE = "it.r * 100 + it.i * 10";

describe("#7424 array destructuring closes an unfinished class / object-literal iterator", () => {
  it.each([
    [
      "class const [a]",
      `export function main() { const it = new It(); const [a] = it; return ${SCORE} + a * 1000; }`,
      1110,
    ],
    [
      "object-literal const [a]",
      `export function main() { const it = mk(); const [a] = it; return ${SCORE} + a * 1000; }`,
      1110,
    ],
    [
      "class let [a, b] (not done after b)",
      `export function main() { const it = new It(); let [a, b] = it; return ${SCORE} + a * 1000 + b * 10000; }`,
      21120,
    ],
    [
      "class var [a, b, c] (exhausted, no close)",
      `export function main() { var it = new It(); var [a, b, c] = it; return ${SCORE} + a * 1000 + b * 10000 + (c === undefined ? 5 : 7); }`,
      21035,
    ],
    [
      "class elision [, x]",
      `export function main() { const it = new It(); const [, x] = it; return ${SCORE} + x * 1000; }`,
      2120,
    ],
    [
      "object-literal elision [, x]",
      `export function main() { const it = mk(); const [, x] = it; return ${SCORE} + x * 1000; }`,
      2120,
    ],
    [
      "class rest [a, ...r] (exhausted, no close)",
      `export function main() { const it = new It(); const [a, ...r] = it; return ${SCORE} + a * 1000 + r.length * 10000; }`,
      11030,
    ],
    [
      "class assignment [a] = it",
      `export function main() { const it = new It(); let a; [a] = it; return ${SCORE} + a * 1000; }`,
      1110,
    ],
    [
      "class parameter f([a])",
      `function f([a]) { return a; } export function main() { const it = new It(); const a = f(/** @type {any} */ (it)); return ${SCORE} + a * 1000; }`,
      1110,
    ],
    [
      "module-level const [g]",
      `const it = mk(); const [g] = it; export function main() { return ${SCORE} + g * 1000; }`,
      1110,
    ],
  ])("%s", async (_, body, expected) => {
    const source = CLASS_IT + OBJ_IT + body;
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, "t.js", target), target).toBe(expected);
  });

  it.each([
    [
      "typed const [a]",
      `export function main(): number { const it = new It(); const [a] = it; return ${SCORE} + a * 1000; }`,
      1110,
    ],
    [
      "typed const [a, b]",
      `export function main(): number { const it = new It(); const [a, b] = it; return ${SCORE} + a * 1000 + b * 10000; }`,
      21120,
    ],
    [
      "typed parameter f([a]: It)",
      `function f([a]: It): number { return a; } export function main(): number { const it = new It(); const a = f(it); return ${SCORE} + a * 1000; }`,
      1110,
    ],
  ])("%s", async (_, body, expected) => {
    const source = TYPED_IT + body;
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, "t.ts", target), target).toBe(expected);
  });

  // `@@iterator` returns a fresh object whose `next` / `return` are closure-valued fields, so no struct has a `next`
  // method. The bounded drive must still admit the iterable (the #2033 equivalence shape).
  it.each(["t.ts", "t.js"])("closure-field iterator, %s", async (fileName) => {
    const source = `export function main() {
      let calls = 0; let closes = 0;
      const obj = { [Symbol.iterator]() { let i = 0; return {
        next: () => { calls++; i++; return { value: i * 10, done: i > 3 }; },
        return: () => { closes++; return { value: 0, done: true }; } }; } };
      const [a, , b] = obj;
      return closes * 1000 + calls * 100 + a + b; }`;
    expect(node(source)).toBe(1340);
    for (const target of TARGETS) expect(await run(source, fileName, target), target).toBe(1340);
  });
});
