// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7403 — a comparison of a BigInt against an operand that may hold one (`any`, `number | bigint`):
// - `b < 2n` / `b > 0n` answered false when `b` held a BigInt: the mixed arm compared through ToNumber, which is NaN
//   for a BigInt. Relational operators now share #7373's maybe-BigInt arm.
// - A BigInt past 64 bits on the dynamic side compared by its low 64 bits (`2n ** 70n == 0n` was true); it now
//   orders by its sign.
// - A constant past 64 bits on the BigInt side wrapped on the i64 lane; it is now compared with the carrier ordering.
// - `g() === 2n ** 70n` answered false: the module's first wide constant was folded before the wide carrier type was
//   registered, so it was wrapped to i64.
// Every expected value is node's own answer for the same expression.
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

/** The eight comparisons of `b` against `k`, both ways round, scored as one bit each. */
const RELATIONS = ["b < k", "b <= k", "b > k", "b >= k", "k < b", "k <= b", "k > b", "k >= b"];
const score = (k: string): string =>
  RELATIONS.map((relation, bit) => `(${relation.replace(/k/g, k)} ? ${1 << bit} : 0)`).join(" + ");

const relational = (type: string, value: string, k: string): string =>
  `function g(): ${type} { return ${value} as any; } export function main(): number { const b = g(); return ${score(k)}; }`;
const nodeRelational = (value: string, k: string): number =>
  new Function(`const b = ${value}; return ${score(k)};`)() as number;

const RELATIONAL_ROWS: readonly (readonly [string, string, string])[] = [
  ...["any", "number | bigint"].flatMap((type) =>
    ["1n", "2n", "3n", "-5n", "1.5", "2", "NaN", "2n ** 70n", "-(2n ** 70n)"].flatMap((value) =>
      ["2n", "0n", "-1n"].map((k) => [type, value, k] as const),
    ),
  ),
  ...["null", "undefined", '"1"', '"3"'].map((value) => ["any", value, "2n"] as const),
  // A constant past 64 bits on the BigInt side, against narrow, wide and Number values.
  ...["5n", "-5n", "2n ** 70n", "2n ** 70n + 1n", "2n ** 71n", "-(2n ** 70n)", "-(2n ** 71n)", "1e30", "NaN"].flatMap(
    (value) => ["2n ** 70n", "2n ** 70n + 1n", "-(2n ** 70n)"].map((k) => ["any", value, k] as const),
  ),
];

/** `main()` scores `g() === k`, `g() !== k`, `k === g()`, `g() == k` as the bits 1, 2, 4, 8. */
const equality = (type: string, value: string, k: string): string =>
  `function g(): ${type} { return ${value} as any; } export function main(): number { ` +
  `return (g() === ${k} ? 1 : 0) + (g() !== ${k} ? 2 : 0) + (${k} === g() ? 4 : 0) + (g() == ${k} ? 8 : 0); }`;
const nodeEquality = (value: string, k: string): number =>
  new Function(
    `const g = () => ${value}; return (g() === ${k} ? 1 : 0) + (g() !== ${k} ? 2 : 0) + (${k} === g() ? 4 : 0) + (g() == ${k} ? 8 : 0);`,
  )() as number;

const EQUALITY_ROWS: readonly (readonly [string, string, string])[] = ["any", "number | bigint"].flatMap((type) => [
  [type, "2n ** 70n", "2n ** 70n"] as const,
  [type, "2n ** 70n", "2n ** 71n"] as const,
  [type, "-(2n ** 70n)", "2n ** 70n"] as const,
  [type, "2n ** 70n", "0n"] as const,
  [type, "2n ** 64n", "18446744073709551616n"] as const,
  [type, "5n", "5n"] as const,
]);

const STATIC_MIXED =
  "export function main(): number { const a: number = 1; const c: bigint = 2n; const d: number = 2.5; const n: number = NaN; " +
  "return (a < c ? 1 : 0) + (c > 1.5 ? 2 : 0) + (d < c ? 4 : 0) + (n < c ? 8 : 0) + (c < n ? 16 : 0) + (c >= 2 ? 32 : 0); }";

describe.each(["gc", "standalone"] as const)("#7403 — comparisons with a maybe-BigInt operand (%s)", (target) => {
  it.each(RELATIONAL_ROWS)("`%s` holding %s against %s: < <= > >= both ways", async (type, value, k) => {
    expect(await runMain(relational(type, value, k), target)).toBe(nodeRelational(value, k));
  });

  it.each(EQUALITY_ROWS)("`%s` holding %s against %s: === !== ==", async (type, value, k) => {
    expect(await runMain(equality(type, value, k), target)).toBe(nodeEquality(value, k));
  });

  it("operands run left to right", async () => {
    const source =
      "let log = 0; function g(): any { log = log * 10 + 1; return 1n; } function k(): bigint { log = log * 10 + 2; return 2n; } " +
      "export function main(): number { const r = (g() < k() ? 1 : 0) + (k() <= g() ? 2 : 0); return log * 10 + r; }";
    expect(await runMain(source, target)).toBe(12211);
  });

  it("static number against BigInt (unchanged)", async () => {
    expect(await runMain(STATIC_MIXED, target)).toBe(1 + 2 + 32);
  });
});
