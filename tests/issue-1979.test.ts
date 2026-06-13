// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1979 — the IR Phase-2 "early-return if" rewrite turned `if (cond) <then>;
// <rest>` into `if (cond) <then> else { <rest> }`, sound only when the then-arm
// terminates. Slice 14 (#1228) made a non-terminating ExpressionStatement a
// valid void "tail", so `if (a > 0) g(b); h(b);` lowered the then-arm to a
// synthesized `return` — the true branch returned after `g(b)` and `h(b)` never
// ran (b.v = 100 instead of 101).
//
// Fix (src/ir/from-ast.ts): only apply the early-return rewrite when the
// then-arm unconditionally terminates (`thenArmTerminates`). A non-terminating
// then-arm now lowers as a converging guard — both the then-block (after its
// side effect) and the false branch fall through to a continuation block that
// holds `<rest>`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: Function }).setExports === "function") {
    (imps as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => unknown }).test();
}

const helpers = `
class Box { v: number = 0; }
function g(b: Box): number { b.v = b.v + 100; return b.v; }
function h(b: Box): number { b.v = b.v + 1; return b.v; }
`;

describe("#1979 non-terminating early-if in a void function", () => {
  it("runs the statements after a true-but-non-terminating `if` guard", async () => {
    const got = await run(
      `${helpers}
      function f(b: Box, a: number): void { if (a > 0) g(b); h(b); }
      export function test(): number { const b = new Box(); f(b, 1); return b.v; }`,
    );
    expect(got).toBe(101); // node: g adds 100, h adds 1 → 101 (was 100)
  });

  it("skips the guarded statement but still runs the rest when the cond is false", async () => {
    const got = await run(
      `${helpers}
      function f(b: Box, a: number): void { if (a > 0) g(b); h(b); }
      export function test(): number { const b = new Box(); f(b, 0); return b.v; }`,
    );
    expect(got).toBe(1); // node: only h runs → 1
  });

  it("a non-terminating guard at the end of the function still runs", async () => {
    const got = await run(
      `${helpers}
      function f(b: Box, a: number): void { h(b); if (a > 0) g(b); }
      export function test(): number { const b = new Box(); f(b, 1); return b.v; }`,
    );
    expect(got).toBe(101); // node: h then g → 101
  });

  it("a true early-RETURN guard still short-circuits the rest (unregressed)", async () => {
    const got = await run(
      `${helpers}
      function f(b: Box, a: number): void { if (a > 0) return; h(b); }
      export function test(): number { const b = new Box(); f(b, 1); return b.v; }`,
    );
    expect(got).toBe(0); // node: returns before h → 0
  });

  it("a false early-RETURN guard falls through to the rest (unregressed)", async () => {
    const got = await run(
      `${helpers}
      function f(b: Box, a: number): void { if (a > 0) return; h(b); }
      export function test(): number { const b = new Box(); f(b, 0); return b.v; }`,
    );
    expect(got).toBe(1); // node: h runs → 1
  });

  it("non-void early-return recursion is unregressed (classic fact)", async () => {
    const got = await run(
      `function fact(n: number): number { if (n <= 1) return 1; return n * fact(n - 1); }
      export function test(): number { return fact(5); }`,
    );
    expect(got).toBe(120); // node: 120
  });
});
