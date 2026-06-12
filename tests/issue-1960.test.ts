// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1960 — native RegExp VM must clear a quantified subtree's capture groups at
 * each repetition entry (§22.2.2.3.1 RepeatMatcher). Previously SAVE slots from
 * an earlier iteration persisted, so a group that did NOT participate in the
 * final iteration still read as set — e.g. `/(?:(a)|(b))+/.exec("ab")` left
 * group 1 holding `"a"` instead of `undefined`.
 *
 * The compiler now emits a CLEAR opcode at every star/plus body head. Validated
 * on the pure-WasmGC standalone backend against Node `RegExp`.
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

describe("#1960 capture groups reset between quantifier iterations", () => {
  it("alternation under + — non-participating group reads undefined (issue repro)", async () => {
    // /(?:(a)|(b))+/.exec("ab"): last iteration matched "b", so group 1 is
    // undefined and group 2 is "b". Node returns 18 (10 + 'b'%10 = 10 + 8).
    const got = await runNum(`
      const m = /(?:(a)|(b))+/.exec("ab");
      if (m === null) return -1;
      let r = 0;
      if (m[1] !== undefined) r += 100;
      if (m[2] !== undefined) { r += 10; r += m[2].charCodeAt(0) % 10; }
      return r;
    `);
    expect(got).toBe(18);
  });

  it("reverse order — group 1 participates last", async () => {
    // /(?:(a)|(b))+/.exec("ba"): last iteration matched "a", so group 1 is "a"
    // and group 2 is undefined.
    const got = await runNum(`
      const m = /(?:(a)|(b))+/.exec("ba");
      if (m === null) return -1;
      let r = 0;
      if (m[1] !== undefined) r += 100;
      if (m[2] !== undefined) r += 10;
      return r;
    `);
    expect(got).toBe(100);
  });

  it("capturing star — stale group cleared when final iteration omits it", async () => {
    // /((a)|(b))*/.exec("abab"): last iteration matched "b"; group 2 ('a')
    // undefined, group 3 ('b') = "b".
    const got = await runNum(`
      const m = /((a)|(b))*/.exec("abab");
      if (m === null) return -1;
      let r = 0;
      if (m[2] !== undefined) r += 100; // 'a' branch — should be cleared
      if (m[3] !== undefined) r += 10; // 'b' branch — participated last
      return r;
    `);
    expect(got).toBe(10);
  });

  it("single match group still captured (control)", async () => {
    // /(a)(b)/.exec("ab"): both groups participate.
    const got = await runNum(`
      const m = /(a)(b)/.exec("ab");
      if (m === null) return -1;
      let r = 0;
      if (m[1] !== undefined) r += 10;
      if (m[2] !== undefined) r += 1;
      return r;
    `);
    expect(got).toBe(11);
  });

  it("optional group inside + that never matches is undefined", async () => {
    // /(?:a(b)?)+/.exec("aa"): the (b) never matches, must be undefined.
    const got = await runNum(`
      const m = /(?:a(b)?)+/.exec("aa");
      if (m === null) return -1;
      return m[1] === undefined ? 1 : 0;
    `);
    expect(got).toBe(1);
  });
});
