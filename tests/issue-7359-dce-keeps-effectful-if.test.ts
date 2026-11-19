// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7359 — a value `if` (the structured conditional behind `&&`, `||` and `?:`) whose result is unused was dropped
// by IR DCE and by the lowerer together with the call in its arm: `a > 0 && boom(b);` never called `boom`. The rule
// now: an instruction that runs nested buffers is as side-effecting as what it runs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { isSideEffecting } from "../src/ir/analysis/effects.js";
import type { IrInstr } from "../src/ir/core/nodes.js";

const HEAD =
  "let n = 0; function inc(v: number): boolean { n = n + 1; return v > 0; } " +
  "function boom(v: number): boolean { if (v) throw 9; return false; } ";

type Target = "gc" | "standalone";

/** Compile through the ordinary pipeline and call `main`: its number, or "threw". */
async function runMain(source: string, target: Target): Promise<number | "threw"> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  try {
    return (instance.exports.main as () => number)();
  } catch (error) {
    expect(error).toBeInstanceOf(WebAssembly.Exception);
    return "threw";
  }
}

// [shape, body of `f(a, b)` before `return n;`, the count node reports for f(1, 1)]
const COUNTERS: readonly (readonly [string, string, number])[] = [
  ["a `&&` statement", "a > 0 && inc(b);", 1],
  ["a `||` statement", "a < 0 || inc(b);", 1],
  ["a short-circuited `&&` statement", "a < 0 && inc(b);", 0],
  ["a short-circuited `||` statement", "a > 0 || inc(b);", 0],
  ["an unread `&&` local", "const r = a > 0 && inc(b);", 1],
  ["an unread `?:` local", "const r = a > 0 ? inc(b) : false;", 1],
  ["a nested `&&` / `||`", "a > 0 && (a < 0 || inc(b));", 1],
  ["a `&&` statement in a loop", "for (let i = 0; i < 3; i = i + 1) { a > 0 && inc(b); }", 3],
  [
    "a `&&` statement in nested loops",
    "for (let i = 0; i < 2; i = i + 1) { for (let j = 0; j < 2; j = j + 1) { a > i && inc(b); } }",
    2,
  ],
];

const THROWS: readonly (readonly [string, string])[] = [
  ["a `&&` statement", "a > 0 && boom(b);"],
  ["a `||` statement", "a < 0 || boom(b);"],
  ["an unread `&&` local", "const r = a > 0 && boom(b);"],
  ["an unread `?:` local", "const r = a > 0 ? boom(b) : false;"],
  ["a nested `&&` / `||`", "a > 0 && (a < 0 || boom(b));"],
];

describe.each(["gc", "standalone"] as const)("#7359 — an unused value `if` keeps its effectful arm (%s)", (target) => {
  // `main` returns the count, so the exact value is node's answer; a throw program is also run where node returns.
  it.each(COUNTERS)("runs the right operand of %s", async (_, body, count) => {
    const program =
      `${HEAD}function f(a: number, b: number): number { ${body} return n; } ` +
      "export function main(): number { return f(1, 1); }";
    expect(await runMain(program, target)).toBe(count);
  });

  it.each(THROWS)("throws from the right operand of %s", async (_, body) => {
    const program =
      `${HEAD}function f(a: number, b: number): number { ${body} return 0; } ` +
      "export function main(): number { return f(1, 1); }";
    expect(await runMain(program, target)).toBe("threw");
    expect(await runMain(program.replace("f(1, 1)", "f(1, 0)"), target)).toBe(0);
  });
});

describe("#7359 — the rule: as side-effecting as the buffers it runs", () => {
  const call = { kind: "call", result: null } as unknown as IrInstr;
  const binary = { kind: "binary", result: null } as unknown as IrInstr;
  const valueIf = (then: IrInstr[], otherwise: IrInstr[] = []) =>
    ({ kind: "if", result: null, then, else: otherwise }) as unknown as IrInstr;

  const slot = (kind: "slot.read" | "slot.write") => ({ kind, slotIndex: 0, result: null }) as unknown as IrInstr;
  const thrown = { kind: "throw", result: null } as unknown as IrInstr;

  it("keeps a value `if` whose arm writes or throws, at any depth", () => {
    expect(isSideEffecting(valueIf([call]))).toBe(true);
    expect(isSideEffecting(valueIf([], [binary, call]))).toBe(true);
    expect(isSideEffecting(valueIf([valueIf([binary, valueIf([], [call])])]))).toBe(true);
    expect(isSideEffecting(valueIf([slot("slot.write")]))).toBe(true);
    expect(isSideEffecting(valueIf([], [thrown]))).toBe(true);
  });

  // `effectsOf` is the authority on what an arm does: a read is not kept.
  it("still drops a value `if` whose arms are pure or only read", async () => {
    expect(isSideEffecting(valueIf([binary], [binary]))).toBe(false);
    expect(isSideEffecting(valueIf([valueIf([binary])]))).toBe(false);
    expect(isSideEffecting(valueIf([slot("slot.read")]))).toBe(false);
    // The buffer rule reaches only buffer-bearing kinds: a leaf `effectsOf` calls call-like stays droppable.
    expect(isSideEffecting({ kind: "dyn.current_this", result: null } as unknown as IrInstr)).toBe(false);
    const result = await compile(
      "export function f(a: number, b: number): number { a > 0 && b > 0; const r = a > 0 ? b > 1 : b < 1; return 0; }",
      { fileName: "test.ts", target: "standalone", emitWat: true },
    );
    expect(result.success).toBe(true);
    const body = /\(func \$f [\s\S]*?\n {2}\)/.exec(result.wat)?.[0];
    expect(body).toBeDefined();
    expect(body).not.toContain("if");
  });
});
