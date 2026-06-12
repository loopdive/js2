// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1964 — for-of over a string must iterate CODE POINTS, not code units
 * (§22.1.5 String Iterator). `for (const c of "a😀b")` should run 3 iterations
 * with the emoji delivered as a 2-unit surrogate pair, not 4 iterations of lone
 * surrogates.
 *
 * The native for-of lowering became surrogate-pair aware on main before this
 * regression guard landed (the same string-iterator work that fixed #1962
 * spread). These cases lock the code-point behaviour in. Validated on the
 * pure-WasmGC standalone backend.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNum(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#1964 for-of over a string iterates code points (standalone)", () => {
  it('"a😀b" runs 3 iterations (not 4)', async () => {
    expect(await runNum(`let n = 0; for (const c of "a😀b") { n++; } return n;`)).toBe(3);
  });

  it("the astral code point arrives as a 2-unit chunk", async () => {
    // i===1 is the emoji; its .length is 2 (high + low surrogate).
    expect(
      await runNum(`let r = 0; let i = 0; for (const c of "a😀b") { if (i === 1) r = c.length; i++; } return r;`),
    ).toBe(2);
  });

  it("the emoji chunk leads with its high surrogate (U+D83D)", async () => {
    expect(await runNum(`let r = 0; for (const c of "😀") { r = c.charCodeAt(0); } return r;`)).toBe(0xd83d);
  });

  it("a string of only astral chars runs one iteration per code point", async () => {
    expect(await runNum(`let n = 0; for (const c of "😀😁") { n++; } return n;`)).toBe(2);
  });

  it("a lone high surrogate is still yielded as a single unit (spec)", async () => {
    expect(await runNum(`let n = 0; for (const c of "\\uD83D") { n++; } return n;`)).toBe(1);
  });

  it("BMP-only strings keep the fast path (one iteration per char)", async () => {
    expect(await runNum(`let n = 0; for (const c of "hello") { n++; } return n;`)).toBe(5);
    expect(await runNum(`let s = 0; for (const c of "abc") { s += c.charCodeAt(0); } return s;`)).toBe(97 + 98 + 99);
  });

  it("empty string runs zero iterations", async () => {
    expect(await runNum(`let n = 0; for (const c of "") { n++; } return n;`)).toBe(0);
  });
});
