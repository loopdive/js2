// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4177 — IR-first hard-failed on lattice-narrowed `+`.
//
// Selection admits an unannotated helper because the interprocedural fixpoint
// (src/ir/propagate.ts, #1131) proves its parameter f64 from the call sites,
// but from-ast's `+` operand proof (#2781 Row 7) re-derived operand types from
// the TS checker alone — which says `any` for the unannotated param — and
// hard-failed AFTER the legacy body had already been skipped (IR-first #2138:
// no fallback). The fix makes `proveAdditiveOperand` consume the SAME facts
// the claim was made with (`latticeAdditiveFact`): the enclosing function's
// never-written parameter facts (f64 atom → number, string atom → string) and
// certified direct-call plan return types. No new inference — a
// conflicting-sites param joins to a union atom, is never claimed, and keeps
// its clean legacy fallback (pinned below).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileRun(
  source: string,
  opts: { standalone?: boolean } = {},
): Promise<{ exports: Record<string, Function>; errors: { message: string }[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone === false ? {} : { target: "standalone" as const }),
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = result.importObject ?? buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (e: object) => void }).__setExports?.(instance.exports as object);
  return { exports: instance.exports as Record<string, Function>, errors: result.errors };
}

describe("#4177 — from-ast `+` provability consumes the fixpoint's lattice facts", () => {
  it("compiles the issue fixture standalone under default IR-first (f64 param fact)", async () => {
    const { exports, errors } = await compileRun(`
      function addOne(n) { return n + 1; }
      export function top(k: number): number { return addOne(k); }
    `);
    expect(exports.top(42)).toBe(43);
    // The whole point: no hard-fail AND no IR fallback — addOne stays claimed.
    expect(errors.filter((e) => e.message.includes("not provably both-number"))).toEqual([]);
  });

  it("string-lattice param proves string — `+` lowers as concat", async () => {
    const { exports } = await compileRun(`
      function shout(s) { return s + "!"; }
      export function top(): number { return shout("hi").length; }
    `);
    expect(exports.top()).toBe(3);
  });

  it("string-lattice param concat, host mode (observable string value)", async () => {
    const { exports } = await compileRun(
      `
      function shout(s) { return s + "!"; }
      export function top(): string { return shout("hi"); }
    `,
      { standalone: false },
    );
    expect(exports.top()).toBe("hi!");
  });

  it("conflicting-sites param stays unprovable and keeps the clean legacy fallback (no hard-fail)", async () => {
    // pick's `v` joins f64 ⊔ string → union atom → not claimable → the whole
    // chain must still COMPILE (legacy body kept) and answer correctly:
    // pick("x") = "x1" (concat), pick(41) = 42 (add), 42 + 2 = 44.
    const { exports } = await compileRun(`
      function pick(v) { return v + 1; }
      function useString(): number { return pick("x").length; }
      export function ta(k: number): number { return pick(k) + useString(); }
    `);
    expect(exports.ta(41)).toBe(44);
  });

  it("recursion: `+` over recursive call results proves via the certified plan return atom", async () => {
    const { exports, errors } = await compileRun(`
      function fib(n) { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); }
      export function top(k: number): number { return fib(k); }
    `);
    expect(exports.top(10)).toBe(55);
    expect(errors.filter((e) => e.message.includes("not provably both-number"))).toEqual([]);
  });

  it("a written (mutated) param gets NO fact — the incoming-value proof does not cover reassigned reads", async () => {
    // `n` is reassigned, so collectLatticeParamFacts excludes it. The claim
    // must not miscompile; whatever route it takes, the answer must be right.
    const { exports } = await compileRun(`
      function bump(n) { n = n + 1; return n + 1; }
      export function top(k: number): number { return bump(k); }
    `);
    expect(exports.top(40)).toBe(42);
  });

  it("a shadowing local never satisfies a param fact (decl-keyed, symbol-resolved)", async () => {
    const { exports } = await compileRun(`
      function inner(n) {
        const arr = [n];
        let total = 0;
        for (const n of arr) { total = total + n; }
        return total + n;
      }
      export function top(k: number): number { return inner(k); }
    `);
    expect(exports.top(21)).toBe(42);
  });
});
