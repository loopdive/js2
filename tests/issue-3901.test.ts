// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3901 — `__str_split` / `__str_replace` were rewritten for speed:
 *
 *   - `__str_split` is now a two-pass, call-free lowering. It hoists the
 *     receiver's and separator's len/off/data into locals once, COUNTS the
 *     pieces with an inline scan (single-code-unit fast path), allocates the
 *     result array at EXACTLY that size, then fills it with inline
 *     `struct.new $NativeString` slice views. The old capacity-8-then-double
 *     growth path (`array.new_default` + `array.copy`) is gone, as are the
 *     per-piece `__str_indexOf` / `__str_substring` calls.
 *   - `__str_getSubstitution` early-outs when the replacement contains no `$`.
 *   - `__str_replace` splices directly (one array + one struct) when the result
 *     is below `__str_concat`'s 64-unit rope threshold and there is no `$`.
 *   - The split call site no longer emits a redundant `__str_flatten` on the
 *     receiver and separator — `__str_split`'s own preamble already flattens
 *     both behind a `ref.test` guard (#3673).
 *
 * These are pure lowering changes, so the risk is entirely semantic drift at
 * the edges: exact piece counts, empty pieces, `limit`, multi-char and
 * overlapping separators, offset-bearing (slice-view) receivers, and — because
 * the eager flatten was removed — ConsString ROPE receivers and separators.
 * Every expectation below matches V8.
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

/** Build a ConsString rope: `__str_concat` makes a rope node at >= 64 units. */
const ROPE = `let rope = ""; for (let i = 0; i < 12; i = i + 1) { rope = rope + "abcdefgh,"; }`;

describe("#3901 exact-pre-sized, call-free split", () => {
  it("splits into the right number of pieces", async () => {
    expect(await runNum(`return "alpha,bravo,charlie".split(",").length;`)).toBe(3);
  });

  it("keeps empty pieces from adjacent separators", async () => {
    expect(await runNum(`return "a,,b".split(",").length;`)).toBe(3);
    expect(await runNum(`return "a,,b".split(",")[1].length;`)).toBe(0);
  });

  it("keeps leading and trailing empty pieces", async () => {
    expect(await runNum(`return ",a,".split(",").length;`)).toBe(3);
    expect(await runNum(`return ",a,".split(",")[0].length + ",a,".split(",")[2].length;`)).toBe(0);
  });

  it("returns the whole string when the separator is absent", async () => {
    expect(await runNum(`return "abc".split(",").length;`)).toBe(1);
    expect(await runNum(`return "abc".split(",")[0].length;`)).toBe(3);
  });

  it("an empty receiver yields one empty piece", async () => {
    expect(await runNum(`return "".split(",").length;`)).toBe(1);
    expect(await runNum(`return "".split(",")[0].length;`)).toBe(0);
  });

  it("a separator equal to the whole string yields two empty pieces", async () => {
    expect(await runNum(`return "abc".split("abc").length;`)).toBe(2);
    expect(await runNum(`return "abc".split("abc")[0].length + "abc".split("abc")[1].length;`)).toBe(0);
  });

  // The old lowering grew a capacity-8 array by doubling. 11 pieces crossed
  // that boundary; exact pre-sizing must still produce all 11.
  it("crosses the old capacity-8 growth point (11 pieces)", async () => {
    expect(await runNum(`return "1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n11".split("\\n").length;`)).toBe(11);
    expect(await runNum(`return "1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n11".split("\\n")[10].length;`)).toBe(2);
  });

  it("multi-char separators", async () => {
    expect(await runNum(`return "aXXbXXc".split("XX").length;`)).toBe(3);
    expect(await runNum(`return "abXX".split("XX")[1].length;`)).toBe(0);
  });

  it("overlapping multi-char separators do not double-match", async () => {
    // "aaa".split("aa") === ["", "a"]
    expect(await runNum(`return "aaa".split("aa").length;`)).toBe(2);
    expect(await runNum(`return "aaa".split("aa")[1].length;`)).toBe(1);
  });

  it("a separator longer than the receiver never matches", async () => {
    expect(await runNum(`return "a".split("bbbb").length;`)).toBe(1);
  });

  it("honours limit (including 0)", async () => {
    expect(await runNum(`return "a,b,c,d".split(",", 2).length;`)).toBe(2);
    expect(await runNum(`return "a,b,c".split(",", 0).length;`)).toBe(0);
    expect(await runNum(`return "a,b,c,d".split(",", 2)[1].charCodeAt(0);`)).toBe(98);
  });

  it("empty separator splits into code units and honours limit", async () => {
    expect(await runNum(`return "abc".split("").length;`)).toBe(3);
    expect(await runNum(`return "abc".split("", 2).length;`)).toBe(2);
    expect(await runNum(`return "".split("").length;`)).toBe(0);
    expect(await runNum(`return "abc".split("")[2].charCodeAt(0);`)).toBe(99);
  });

  it("undefined separator returns the whole string", async () => {
    expect(await runNum(`return "abc".split().length;`)).toBe(1);
  });

  // The receiver carries off != 0; the pieces must be sliced relative to it.
  it("an offset-bearing (slice-view) receiver splits correctly", async () => {
    expect(await runNum(`return "xxhello,worldyy".substring(2, 13).split(",").length;`)).toBe(2);
    expect(await runNum(`return "xxhello,worldyy".substring(2, 13).split(",")[0].length;`)).toBe(5);
    expect(await runNum(`return "xxhello,worldyy".substring(2, 13).split(",")[1].charCodeAt(0);`)).toBe(119); // 'w'
  });

  it("a split result can itself be re-split", async () => {
    expect(await runNum(`return "a:1|b:2".split("|")[1].split(":")[0].charCodeAt(0);`)).toBe(98); // 'b'
  });
});

// The call site used to eagerly `__str_flatten` the receiver and separator.
// That was removed, so a rope now reaches __str_split unflattened and must be
// handled by its internal ref.test-guarded preamble.
describe("#3901 ConsString rope receivers and separators (eager flatten removed)", () => {
  it("rope receiver, 1-char separator", async () => {
    expect(await runNum(`${ROPE} return rope.split(",").length;`)).toBe(13);
    expect(await runNum(`${ROPE} return rope.split(",")[11].length;`)).toBe(8);
    expect(await runNum(`${ROPE} return rope.split(",")[12].length;`)).toBe(0);
  });

  it("rope receiver, multi-char separator", async () => {
    expect(
      await runNum(
        `let r = ""; for (let i = 0; i < 10; i = i + 1) { r = r + "xxxxxxxxxXY"; } return r.split("XY").length;`,
      ),
    ).toBe(11);
  });

  it("rope receiver, empty separator", async () => {
    expect(
      await runNum(`let r = ""; for (let i = 0; i < 9; i = i + 1) { r = r + "abcdefgh"; } return r.split("").length;`),
    ).toBe(72);
  });

  it("rope SEPARATOR (not just receiver)", async () => {
    const sep = `let sep = ""; for (let i = 0; i < 9; i = i + 1) { sep = sep + "SEPSEPSE"; }`;
    expect(await runNum(`${sep} const hay = "left" + sep + "right"; return hay.split(sep).length;`)).toBe(2);
    expect(await runNum(`${sep} const hay = "left" + sep + "right"; return hay.split(sep)[1].length;`)).toBe(5);
  });

  it("rope receiver with a limit, and with the separator absent", async () => {
    expect(await runNum(`${ROPE} return rope.split(",", 3).length;`)).toBe(3);
    expect(await runNum(`${ROPE} return rope.split("|").length;`)).toBe(1);
    expect(await runNum(`${ROPE} return rope.split("|")[0].length;`)).toBe(108);
  });
});

describe("#3901 direct-splice replace", () => {
  it("replaces the first occurrence only", async () => {
    expect(await runNum(`return "aXbXc".replace("X", "-").charCodeAt(1);`)).toBe(45); // '-'
    expect(await runNum(`return "aXbXc".replace("X", "-").charCodeAt(3);`)).toBe(88); // 'X' survives
  });

  it("handles start, end and whole-string matches", async () => {
    expect(await runNum(`return "abc".replace("a", "ZZ").length;`)).toBe(4);
    expect(await runNum(`return "abc".replace("c", "ZZ").length;`)).toBe(4);
    expect(await runNum(`return "abc".replace("abc", "x").length;`)).toBe(1);
  });

  it("returns the receiver unchanged when there is no match", async () => {
    expect(await runNum(`return "abc".replace("q", "x").length;`)).toBe(3);
  });

  it("empty replacement deletes, empty search inserts at 0", async () => {
    expect(await runNum(`return "abc".replace("b", "").length;`)).toBe(2);
    expect(await runNum(`return "abc".replace("", "X").length;`)).toBe(4);
    expect(await runNum(`return "abc".replace("", "X").charCodeAt(0);`)).toBe(88); // 'X'
  });

  it("a longer replacement grows the result", async () => {
    expect(await runNum(`return "abc".replace("b", "LONGER").length;`)).toBe(8);
  });

  // The splice fast path is gated on the replacement having no `$`; these must
  // still take the general GetSubstitution path.
  it("still expands $ patterns", async () => {
    expect(await runNum(`return "abc".replace("b", "$$").charCodeAt(1);`)).toBe(36); // '$'
    expect(await runNum(`return "abc".replace("b", "$$").length;`)).toBe(3);
    expect(await runNum(`return "abc".replace("b", "[$&]").length;`)).toBe(5); // a[b]c
    // `$\`` (dollar-backtick) expands to the prefix; built by concatenation so
    // the backtick does not have to be escaped inside a template literal.
    const dollarBacktick = 'return "abc".replace("b", "<$' + "`" + '>").charCodeAt(2);';
    expect(await runNum(dollarBacktick)).toBe(97); // prefix 'a'
    expect(await runNum(`return "abc".replace("b", "<$'>").charCodeAt(2);`)).toBe(99); // suffix 'c'
    expect(await runNum(`return "abc".replace("b", "$z").length;`)).toBe(4); // unrecognised, literal
    expect(await runNum(`return "abc".replace("b", "x$").length;`)).toBe(4); // trailing lone $
  });

  it("falls back to the rope path above the 64-unit threshold", async () => {
    const long = `const long = "0123456789012345678901234567890123456789012345678901234567890123456789";`;
    expect(await runNum(`${long} return long.replace("789", "XYZ").length;`)).toBe(70);
    expect(await runNum(`${long} return long.replace("789", "XYZ").charCodeAt(7);`)).toBe(88); // 'X'
    expect(await runNum(`${long} return long.replace("0123456789", "").length;`)).toBe(60);
  });

  it("an offset-bearing receiver splices correctly", async () => {
    expect(await runNum(`return "zzhello worldzz".substring(2, 13).replace("world", "there").length;`)).toBe(11);
    expect(await runNum(`return "zzhello worldzz".substring(2, 13).replace("world", "there").charCodeAt(6);`)).toBe(
      116,
    ); // 't'
  });

  it("replaceAll still works (shares getSubstitution)", async () => {
    expect(await runNum(`return "aXbXc".replaceAll("X", "-").charCodeAt(3);`)).toBe(45); // '-'
    expect(await runNum(`return "aXbXc".replaceAll("X", "$&$&").length;`)).toBe(7); // aXXbXXc
  });
});
