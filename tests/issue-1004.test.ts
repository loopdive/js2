// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#1004) Counted-append string-loop aggregation: `for (let i=0;i<N;i++) s = s + FRAG`
// lowers to `s += FRAG.repeat(N)`. These tests pin byte-identical semantics for
// the optimizable cases and confirm the guard declines unsafe shapes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime.js";

async function runStr(src: string): Promise<string> {
  const exports = (await compileAndInstantiate(src)) as { test(): string };
  return exports.test();
}
async function runNum(src: string): Promise<number> {
  const exports = (await compileAndInstantiate(src)) as { test(): number };
  return exports.test();
}

describe("#1004 counted string-append aggregation", () => {
  it("aggregates the canonical benchmark loop (length)", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let str = "";
          for (let i = 0; i < 1000; i++) str = str + "abcde";
          return str.length;
        }`),
    ).toBe(5000);
  });

  it("preserves the counted aggregation instead of routing the loop through IR", async () => {
    const result = await compile(`
      export function test(): number {
        let str = "";
        for (let i = 0; i < 1000; i++) str = str + "abcde";
        return str.length;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("test");
    expect(result.wat).not.toContain("i32.lt_s");
  });

  it("produces the byte-identical string", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 4; i++) s = s + "ab";
          return s;
        }`),
    ).toBe("abababab");
  });

  it("honors a non-empty seed prefix", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "X";
          for (let i = 0; i < 3; i++) s = s + "yz";
          return s;
        }`),
    ).toBe("Xyzyzyz");
  });

  it("handles the compound-assignment form", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 5; i++) s += "q";
          return s;
        }`),
    ).toBe("qqqqq");
  });

  it("handles a braced single-statement body", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) { s = s + "mn"; }
          return s;
        }`),
    ).toBe("mnmnmn");
  });

  it("handles a non-zero start (i<=B inclusive)", async () => {
    // i = 2..10 inclusive → 9 iterations
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          for (let i = 2; i <= 10; i++) s = s + "z";
          return s.length;
        }`),
    ).toBe(9);
  });

  it("a loop-invariant string identifier fragment", async () => {
    expect(
      await runStr(`
        export function test(): string {
          const frag = "hi";
          let s = "";
          for (let i = 0; i < 3; i++) s = s + frag;
          return s;
        }`),
    ).toBe("hihihi");
  });

  it("emits nothing for a zero-iteration loop (keeps seed)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "seed";
          for (let i = 0; i < 0; i++) s = s + "x";
          return s;
        }`),
    ).toBe("seed");
  });

  it("emits nothing when start >= bound", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "seed";
          for (let i = 5; i < 3; i++) s = s + "x";
          return s;
        }`),
    ).toBe("seed");
  });

  it("still handles a single iteration (N=1) via the normal path", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "a";
          for (let i = 0; i < 1; i++) s = s + "b";
          return s;
        }`),
    ).toBe("ab");
  });

  // ── Guard must DECLINE unsafe / non-matching shapes (correctness) ──

  it("does NOT aggregate when the body references the counter (i-dependent)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) s = s + ("" + i);
          return s;
        }`),
    ).toBe("012");
  });

  it("does NOT aggregate a prepend loop (order matters)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) s = "a" + s + "b";
          return s;
        }`),
    ).toBe("aaabbb");
  });

  it("does NOT aggregate a multi-statement body", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          let c = 0;
          for (let i = 0; i < 4; i++) { s = s + "x"; c = c + 1; }
          return s.length + c;
        }`),
    ).toBe(8);
  });

  it("does NOT aggregate a doubling accumulator (s = s + s)", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "ab";
          for (let i = 0; i < 3; i++) s = s + s;
          return s.length;
        }`),
    ).toBe(16);
  });

  it("does NOT aggregate a runtime (non-constant) bound", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let n = 5;
          n = n + 1;
          let s = "";
          for (let i = 0; i < n; i++) s = s + "z";
          return s.length;
        }`),
    ).toBe(6);
  });

  it("does NOT aggregate a non-unit step", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          for (let i = 0; i < 10; i += 2) s = s + "z";
          return s.length;
        }`),
    ).toBe(5);
  });

  it("nested aggregated loops compose correctly", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let total = 0;
          for (let j = 0; j < 3; j++) {
            let s = "";
            for (let i = 0; i < 4; i++) s = s + "ab";
            total = total + s.length;
          }
          return total;
        }`),
    ).toBe(24);
  });
});
