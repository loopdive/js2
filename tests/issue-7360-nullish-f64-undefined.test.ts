// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7360 — a `number | undefined` value in an f64 slot carries `undefined` as the UNDEF_F64_BITS sentinel. `??` and
// `??=` folded every f64 operand to "never nullish", so `x ?? 7` with `x === undefined` returned the sentinel (NaN).
// An ordinary NaN number is not nullish and must keep reading as NaN (a NaN with the sentinel's exact bits, read from
// a DataView or Float64Array, is #7367).
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

// (review RV7307, finding 1) `x ?? <right>` keeps the number when `x` is defined and yields `<right>` when not, for
// every right-hand kind: [kind, right operand, the undefined-side check]. Each program's node answer is 11.
const RIGHT_KINDS: readonly (readonly [string, string, string])[] = [
  ["a string", "'d'", "b === 'd'"],
  ["an object", "{}", "typeof b === 'object' && b !== null"],
  ["a BigInt", "1n", "typeof b === 'bigint'"], // `b === 1n` on a `number | bigint` folds to false on main too
  ["a boolean", "true", "b === true"],
  ["null", "null", "b === null"],
  ["a number", "7", "b === 7"],
];

// (review RV7307, finding 2) A type-only wrapper around the operand: [shape, operand]. node answers 27.
const WRAPPED_OPERANDS: readonly (readonly [string, string])[] = [
  ["`x!`", "x!"],
  ["`x as number`", "(x as number)"],
  ["`(x)`", "(x)"],
  ["`x satisfies number | undefined`", "(x satisfies number | undefined)"],
];

describe.each(["gc", "standalone"] as const)("#7360 — nullish tests see an f64 `undefined` (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
  it.each(RIGHT_KINDS)(
    "`x ?? %s` keeps a defined number and yields the right side otherwise",
    async (_, right, check) => {
      const source =
        `function f(x: number | undefined) { return x ?? ${right}; } ` +
        `export function main(): number { const a = f(2); const b = f(undefined); ` +
        `return (a === 2 && typeof a === "number" ? 1 : 0) + (${check} ? 10 : 0); }`;
      expect(await runMain(source, target)).toBe(11);
    },
  );
  it.each(WRAPPED_OPERANDS)("%s under `??` sees `undefined`", async (_, operand) => {
    const source =
      `function f(x: number | undefined): number { return ${operand} ?? 7; } ` +
      "export function main(): number { return f(2) * 10 + f(undefined); }";
    expect(await runMain(source, target)).toBe(27);
  });
});
