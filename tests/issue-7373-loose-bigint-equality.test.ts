// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7373 — `b == 1n` answered `false` when `b` held a BigInt in an `any` / `unknown` / `number | bigint`: the mixed
// BigInt arm compared through ToNumber, which is NaN for a BigInt. A BigInt on the dynamic side is now compared as
// a BigInt; any other value keeps the ToNumber comparison.
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

/** `main()` scores `b == k`, `b != k`, `k == b`, `k != b` as the bits 1, 2, 4, 8. */
const program = (type: string, value: string, k = "1n"): string =>
  `function g(): ${type} { return ${value} as any; } export function main(): number { const b = g(); ` +
  `return (b == ${k} ? 1 : 0) + (b != ${k} ? 2 : 0) + (${k} == b ? 4 : 0) + (${k} != b ? 8 : 0); }`;

const EQUAL = 1 + 4;
const UNEQUAL = 2 + 8;

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  ...["any", "unknown", "number | bigint"].flatMap((type) => [
    [`\`${type}\` holding 1n`, program(type, "1n"), EQUAL] as const,
    [`\`${type}\` holding 2n`, program(type, "2n"), UNEQUAL] as const,
    [`\`${type}\` holding 0n`, program(type, "0n"), UNEQUAL] as const,
    [`\`${type}\` holding -1n`, program(type, "-1n"), UNEQUAL] as const,
    [`\`${type}\` holding the number 1`, program(type, "1"), EQUAL] as const,
    [`\`${type}\` holding null, against 0n`, program(type, "null", "0n"), UNEQUAL] as const,
  ]),
  ['`any` holding the string "1"', program("any", '"1"'), EQUAL],
  ['`unknown` holding the string "1"', program("unknown", '"1"'), EQUAL],
  ["`bigint | undefined` holding 1n", program("bigint | undefined", "1n"), EQUAL],
  ["`bigint | undefined` holding undefined", program("bigint | undefined", "undefined"), UNEQUAL],
  [
    "a `bigint` local against an `any`",
    "function g(): any { return 5n; } export function main(): number { const c: bigint = 5n; return c == g() ? 1 : 0; }",
    1,
  ],
  [
    "a BigInt past 2^53",
    "function g(): any { return 9007199254740993n; } export function main(): number { return g() == 9007199254740993n ? 1 : 0; }",
    1,
  ],
  [
    "operands run left to right (`any` on the left)",
    "let log = 0; function g(): any { log = log * 10 + 1; return 1n; } function k(): bigint { log = log * 10 + 2; return 1n; } " +
      "export function main(): number { const r = g() == k() ? 1 : 0; return log * 10 + r; }",
    121,
  ],
  [
    "operands run left to right (`any` on the right)",
    "let log = 0; function g(): any { log = log * 10 + 1; return 2; } function k(): bigint { log = log * 10 + 2; return 1n; } " +
      "export function main(): number { const r = k() != g() ? 1 : 0; return log * 10 + r; }",
    211,
  ],
  [
    "static `bigint == number` (#1827, unchanged)",
    "export function main(): number { const a: bigint = 3n; const c: number = 3; return (a == c ? 1 : 0) + (a != c ? 10 : 0); }",
    1,
  ],
];

describe.each(["gc", "standalone"] as const)("#7373 — `==` with a maybe-BigInt operand (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
