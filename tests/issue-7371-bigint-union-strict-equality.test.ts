// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7371 — `b === 1n` with `b: number | bigint` folded to `false`: the strict-equality fold for "a BigInt against a
// provably non-BigInt operand" took the union as non-BigInt. Only `any`/`unknown` escaped to the runtime comparison
// (#6642); a union with a bigint member now does too.
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

const UNION = "function g(k: boolean): number | bigint { return k ? 1n : 2; } ";

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  [
    "`=== 1n` on a BigInt in a `number | bigint`",
    `${UNION}export function main(): number { const b = g(true); return (b === 1n ? 10 : 0) + (typeof b === 'bigint' ? 1 : 0); }`,
    11,
  ],
  ["`!== 1n`", `${UNION}export function main(): number { const b = g(true); return b !== 1n ? 0 : 1; }`, 1],
  [
    "`1n ===` (BigInt on the left)",
    `${UNION}export function main(): number { const b = g(true); return 1n === b ? 1 : 0; }`,
    1,
  ],
  [
    "`=== 2n` on a different BigInt",
    `${UNION}export function main(): number { const b = g(true); return b === 2n ? 0 : 1; }`,
    1,
  ],
  [
    "`=== 2` on the number member",
    `${UNION}export function main(): number { const b = g(false); return b === 2 ? 1 : 0; }`,
    1,
  ],
  [
    "`=== 1n` on a number 1 in the union",
    "function g(k: boolean): number | bigint { return k ? 1n : 1; } export function main(): number { const b = g(false); return b === 1n ? 0 : 1; }",
    1,
  ],
  [
    "`=== 1n` on a `bigint | undefined`",
    "function g(k: boolean): bigint | undefined { return k ? 1n : undefined; } export function main(): number { const b = g(true); return b === 1n ? 1 : 0; }",
    1,
  ],
  [
    "`===` against a `bigint` local",
    `${UNION}export function main(): number { const b = g(true); const c: bigint = 1n; return b === c ? 1 : 0; }`,
    1,
  ],
  [
    "`=== 1n` on an `any` (the #6642 case, unchanged)",
    "function g(k: boolean): any { return k ? 1n : 2; } export function main(): number { const b = g(true); return b === 1n ? 1 : 0; }",
    1,
  ],
];

describe.each(["gc", "standalone"] as const)("#7371 — `===` with a maybe-BigInt union (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
