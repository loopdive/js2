// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7413 — for-of, spread and array destructuring call a class iterator's `next(v)` / `return(v)` through the
// `__call_next` / `__call_return` dispatchers with the argument omitted. The pad was `ref.null.extern` when the host
// `__get_undefined` import was absent, so the method saw `v === null`, not `undefined` (wrong on gc too). The pad is
// now the native `$undefined` singleton. Each program carries node's answer.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.ts" });
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

const node = (source: string): unknown =>
  new Function(`${source.replace(/export /g, "").replace(/\(v\?: any\)/g, "(v)")}; return main();`)();

// `next` answers 1 for an undefined argument and 100 otherwise; `return` records the same in `r`.
const IT =
  "let r = 0; class It { n = 0; next(v?: any) { this.n++; return { value: v === undefined ? 1 : 100, done: this.n > 2 }; } " +
  "return(v?: any) { r = v === undefined ? 1 : 100; return { value: 0, done: true }; } [Symbol.iterator]() { return this; } } ";

describe("#7413 an omitted iterator next/return argument is undefined", () => {
  it.each([
    ["for-of", "export function main() { let t = 0; for (const x of new It()) t += x; return t; }", 2],
    ["spread", "export function main() { const a = [...new It()]; return a[0] + a[1]; }", 2],
    ["array destructuring", "export function main() { const [a, b] = new It(); return a + b; }", 2],
    ["return(v) on break", "export function main() { for (const x of new It()) { break; } return r; }", 1],
  ])("%s", async (_, body, expected) => {
    const source = IT + body;
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
