// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 follow-up to slice H (root cause and fix: #7359) — a `&&` / `||` whose value is unused (an expression
// statement, an unread local) is a value `if` in the IR; DCE and the lowerer dropped it together with the right
// operand. On the Prepared path the right operand must run exactly as in JavaScript: its throw escapes and its
// counter update is seen.
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (fileName: string): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    ...(fileName.endsWith(".js") ? { allowJs: true } : {}),
  }) as Test262CompileOptions;

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  const result = await compile(source, options("test.ts"));
  expect(result.errors.map((error) => error.message)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

// A call counter needs a typed script `var` written by a function, which the Prepared path does not have yet
// (`no exact typed storage`), so the counter is a local the right operand assigns; the throw is a call.
const HEAD =
  "function boom(v: number): boolean { if (v) throw 9; return false; } function id(v: number): number { return v; } ";
const BUMP = "(k = k + 1) > 0";

/** [shape, the unused expression with `R` for the right operand, how often R runs for a = 1] */
const FORMS: readonly (readonly [string, string, number])[] = [
  ["`&&`", "a > 0 && R", 1],
  ["short-circuited `&&`", "a < 0 && R", 0],
  ["`||`", "a < 0 || R", 1],
  ["short-circuited `||`", "a > 0 || R", 0],
  ["nested `a && (b || R)`", "a > 0 && (a < 0 || R)", 1],
  ["nested `a || (b && R)`", "a < 0 || (a > 0 && R)", 1],
  ["a chain", "a > 0 && a > -1 && R", 1],
  ["a call on the left", "id(a) > 0 && R", 1],
  ["`?:` (sibling)", "a > 0 ? R : false", 1],
];

/** [position, program with `E` for the expression that ends with `k` in `r`, how often E runs] */
const POSITIONS: readonly (readonly [string, string, number])[] = [
  ["a statement", "function f(a: number, b: number): number { let k = 0; E; return k; } var r = f(1, 1);", 1],
  [
    "an unread local",
    "function f(a: number, b: number): number { let k = 0; const u = E; return k; } var r = f(1, 1);",
    1,
  ],
  ["the top level", "var a = id(1); var b = id(1); var k = 0; E; var r = k;", 1],
  [
    "a loop body",
    "function f(a: number, b: number): number { let k = 0; for (let i = 0; i < 3; i = i + 1) { E; } return k; } var r = f(1, 1);",
    3,
  ],
  [
    "nested loops",
    "function f(a: number, b: number): number { let k = 0; for (let i = 0; i < 2; i = i + 1) { for (let j = 0; j < 2; j = j + 1) { E; } } return k; } var r = f(1, 1);",
    4,
  ],
  [
    "a comma operand (sibling)",
    "function f(a: number, b: number): number { let k = 0; (E, 0); return k; } var r = f(1, 1);",
    1,
  ],
];

const CASES = FORMS.flatMap(([form, expression, runs]) =>
  POSITIONS.map(
    ([position, program, times]) => [form, position, program.replace("E", expression), runs * times] as const,
  ),
);

describe("#7354 H follow-up — an unused `&&` / `||` keeps its right operand", () => {
  // Each counter program runs twice, with node's count (returns) and a wrong count (throws).
  it.each(CASES)("%s in %s updates the counter", async (_, __, program, count) => {
    const source = `${HEAD}${program.replace("R", BUMP)}`;
    expect(await run(`${source} if (r !== ${count}) throw 1;`)).toBe("returned");
    expect(await run(`${source} if (r !== ${count + 1}) throw 1;`)).toBe("threw");
  });

  it.each(CASES)("%s in %s throws from the right operand", async (_, __, program, count) => {
    expect(await run(`${HEAD}${program.replace("R", "boom(b)")}`)).toBe(count === 0 ? "returned" : "threw");
  });
});
