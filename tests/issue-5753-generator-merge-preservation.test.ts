// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { compile as candidateCompile } from "../src/index.js";

const compilerRoot = process.env.GENERATOR_MERGE_COMPILER_ROOT;
const compile: typeof candidateCompile = compilerRoot
  ? (await import(pathToFileURL(`${compilerRoot}/src/index.ts`).href)).compile
  : candidateCompile;

const fixtures = [
  {
    name: "sibling loops reuse a lexical binding spelling",
    source: `function* values() { yield 3; yield 4; }
function* g() {
  for (const x of values()) yield x;
  for (const x of values()) yield x;
}
export function test() {
  const it = g();
  return it.next().value * 1000 + it.next().value * 100 +
    it.next().value * 10 + it.next().value + (it.next().done ? 10000 : 0);
}`,
    expected: 13434,
  },
  {
    name: "loop suspends inside finally",
    source: `function* values() { yield 3; yield 4; }
function* g() {
  try { yield 1; } finally { for (const x of values()) yield x; }
}
export function test() {
  const it = g();
  return it.next().value * 100 + it.next().value * 10 +
    it.next().value + (it.next().done ? 1000 : 0);
}`,
    expected: 1134,
  },
  {
    name: "pending return survives suspended finally loop",
    source: `function* values() { yield 3; yield 4; }
function* g() {
  try { yield 1; } finally { for (const x of values()) yield x; }
}
export function test() {
  const it = g();
  const first = it.next();
  const a = it.return(9);
  const b = it.next();
  const c = it.next();
  return first.value * 1000 + a.value * 100 + b.value * 10 + c.value +
    (a.done ? 10000 : 0) + (b.done ? 20000 : 0) + (c.done ? 40000 : 0);
}`,
    expected: 41349,
  },
];

describe.each(["standalone", "wasi"] as const)("generator merge preservation: %s", (target) => {
  for (const fixture of fixtures) {
    it(
      fixture.name,
      async () => {
        const js = new Function(fixture.source.replace("export function test", "function test") + ";return test();")();
        expect(js).toBe(fixture.expected);
        // These fixtures compare JavaScript runtime behavior, including return(9)
        // on a generator whose inferred TypeScript return type is void.
        const result = await compile(fixture.source, { fileName: "test.ts", target, skipSemanticDiagnostics: true });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        expect((instance.exports.test as () => number)()).toBe(js);
      },
      30000,
    );
  }
});
