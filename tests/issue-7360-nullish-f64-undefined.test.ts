// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7360 — a `number | undefined` value in an f64 slot carries `undefined` as the UNDEF_F64_BITS sentinel. `??` and
// `??=` folded every f64 operand to "never nullish", so `x ?? 7` with `x === undefined` returned the sentinel (NaN).
// A genuine NaN number is not nullish and must keep reading as NaN.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

const NAN_CHECK = "const r = f(NaN); return r !== r ? 1 : 0;";

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  [
    "a parameter under `??`",
    "function f(x: number | undefined): number { return x ?? 7; } export function main(): number { return f(undefined) + f(2) * 100; }",
    207,
  ],
  [
    "a parameter under `??` with a call on the right",
    "let c = 0; function s(): number { c++; return 7; } function f(x: number | undefined): number { return x ?? s(); } " +
      "export function main(): number { return f(undefined) + f(2) * 100 + c * 10000; }",
    10207,
  ],
  [
    "a parameter under `??` inside arithmetic",
    "function f(x: number | undefined): number { return (x ?? 7) + 1; } export function main(): number { return f(undefined) + f(2) * 100; }",
    308,
  ],
  [
    "a local copy under `??`",
    "function f(x: number | undefined): number { const y = x; return y ?? 7; } export function main(): number { return f(undefined) + f(2) * 100; }",
    207,
  ],
  [
    "an optional parameter under `??`",
    "function f(x?: number): number { return x ?? 7; } export function main(): number { return f() + f(2) * 100; }",
    207,
  ],
  [
    "a `number | null` parameter under `??`",
    "function f(x: number | null): number { return x ?? 7; } export function main(): number { return f(null) + f(2) * 100; }",
    207,
  ],
  [
    "a `number | null | undefined` parameter under `??`",
    "function f(x: number | null | undefined): number { return x ?? 7; } " +
      "export function main(): number { return f(undefined) + f(null) * 10 + f(2) * 100; }",
    277,
  ],
  [
    "a parameter under `??=`",
    "function f(x: number | undefined): number { x ??= 7; return x; } export function main(): number { return f(undefined) + f(2) * 100; }",
    207,
  ],
  [
    "an optional property under `??`",
    "interface O { a?: number } function f(o: O): number { return o.a ?? 7; } export function main(): number { return f({}) + f({ a: 2 }) * 100; }",
    207,
  ],
  [
    "a `number | undefined` property under `??`",
    "interface O { a: number | undefined } function f(o: O): number { return o.a ?? 7; } " +
      "export function main(): number { return f({ a: undefined }) + f({ a: 2 }) * 100; }",
    207,
  ],
  [
    "an optional property under `??=`",
    "interface O { a?: number } function f(o: O): number { o.a ??= 7; return o.a; } export function main(): number { return f({}) + f({ a: 2 }) * 100; }",
    207,
  ],
  [
    "a class field under `??=`",
    "class C { a: number | undefined = undefined; } function f(c: C): number { c.a ??= 7; return c.a; } " +
      "export function main(): number { const c = new C(); const d = new C(); d.a = 2; return f(c) + f(d) * 100; }",
    207,
  ],
  [
    "an optional chain under `??`",
    "interface O { a?: number } function f(o: O | undefined): number { return o?.a ?? 7; } " +
      "export function main(): number { return f(undefined) + f({}) * 10 + f({ a: 2 }) * 100; }",
    277,
  ],
  [
    "a default parameter",
    "function f(x: number | undefined = 5): number { return x; } export function main(): number { return f(undefined) + f(2) * 100; }",
    205,
  ],
  [
    "`=== undefined` and `== null`",
    "function f(x: number | undefined): number { return (x === undefined ? 1 : 2) + (x == null ? 10 : 20); } " +
      "export function main(): number { return f(undefined) + f(2) * 100 + f(NaN) * 10000; }",
    222211,
  ],
  [
    "`typeof`",
    "function f(x: number | undefined): string { return typeof x; } " +
      "export function main(): number { return (f(undefined) === 'undefined' ? 1 : 0) + (f(2) === 'number' ? 10 : 0) + (f(NaN) === 'number' ? 100 : 0); }",
    111,
  ],
  [
    "a genuine NaN under `??`",
    `function f(x: number | undefined): number { return x ?? 7; } export function main(): number { ${NAN_CHECK} }`,
    1,
  ],
  [
    "a genuine NaN under `??=`",
    `function f(x: number | undefined): number { x ??= 7; return x; } export function main(): number { ${NAN_CHECK} }`,
    1,
  ],
  [
    "a genuine NaN optional parameter under `??`",
    `function f(x?: number): number { return x ?? 7; } export function main(): number { ${NAN_CHECK} }`,
    1,
  ],
  [
    "a plain `number` under `??`",
    "function f(x: number): number { return x ?? 7; } export function main(): number { return f(2); }",
    2,
  ],
];

describe.each(["gc", "standalone"] as const)("#7360 — nullish tests see an f64 `undefined` (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
