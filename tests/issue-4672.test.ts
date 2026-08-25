// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4672 — residual standalone ES2015 let/TDZ cases.
//
// The test262 wrapper uses JavaScript-style evolving arrays (`let a = []`),
// so TypeScript reports an `any` element for `a[0]`. Before this fix the
// callable-element helper declined that unresolved element type and the tail
// fallback silently dropped the call. The loop cases additionally exercise
// CreatePerIterationEnvironment when a closure appears in the for-head
// initializer, a position the original closure scan skipped.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4672.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "standalone module must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4672 — standalone let/TDZ residuals", () => {
  it("calls closures stored in an evolving empty array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let fns = [];
          fns.push(function () { return 7; });
          return fns[0]();
        }
      `),
    ).toBe(7);
  });

  it("keeps body closures on distinct per-iteration let cells", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let fns = [];
          for (let i = 0; i < 3; ++i) {
            fns.push(function () { return i; });
          }
          return fns[0]() + 10 * fns[1]() + 100 * fns[2]();
        }
      `),
    ).toBe(210);
  });

  it("freshens closures created in the condition and incrementor", async () => {
    // The incrementor runs in the fresh environment, after the copy of j and
    // before `++j`, so its closures observe 1, 2, 3 (the condition closures
    // observe 0, 1, 2).
    expect(
      await runStandalone(`
        export function test(): number {
          let condition = [];
          for (let i = 0; condition.push(function () { return i; }), i < 3; ++i) {}
          let next = [];
          for (let j = 0; j < 3; next.push(function () { return j; }), ++j) {}
          return condition[0]() + 10 * condition[1]() + 100 * condition[2]() +
            1000 * next[0]() + 10000 * next[1]() + 100000 * next[2]();
        }
      `),
    ).toBe(321210);
  });

  it("keeps a closure from a for-head initializer on the initial cell", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let fns = [];
          for (let i = 0, f = function () { return i; }; i < 3; ++i) {
            fns.push(f);
          }
          return fns[0]() + 10 * fns[1]() + 100 * fns[2]();
        }
      `),
    ).toBe(0);
  });
});
