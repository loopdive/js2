// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4065 / #4042 — CharacterEscape support in the STANDALONE runtime RegExp
// pattern compiler, plus the tokenisation invariant that made it possible.
//
// `ensureDynamicStandaloneRegExpCompiler` walks a runtime-built pattern four
// times (count records, find next `|`, emit records, and the anchored
// literal-alternations fast path). Each walk used to advance ONE SOURCE CODE
// UNIT at a time and re-derive the character semantics itself — and only the
// emitter knew `.` means `ReOp.ANY`. That agreed only because every construct
// the runtime grammar accepted was exactly one unit wide; the invariant was
// never written down, it was implicit in `CHARS` on one side and `J - I` on
// the other.
//
// Two consequences, both covered below:
//   1. A CharacterEscape (`\x41` = 4 units, 1 record) could not be added to
//      the emitter alone without desynchronising the record count from the
//      allocated program array.
//   2. The alternations fast path copies the pattern SOURCE text verbatim as
//      its match payload, so it was ALREADY wrong for `.`: `^(?:a.c|zz)$`
//      failed to match "abc" while the non-anchored `a.c` matched it. Same
//      construct, two answers, depending only on anchoring.
//
// Node is the oracle for every expectation here.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Verdict = "AGREES_WITH_NODE" | "MATCHED_DIFFERENT_TEXT" | "NO_MATCH" | "REFUSED";

/** What Node does — computed, never hard-coded from memory. */
function oracle(pattern: string, flags: string, subject: string): string | null {
  const m = new RegExp(pattern, flags).exec(subject);
  return m === null ? null : m[0]!;
}

/**
 * Compile+run a standalone program whose pattern comes back from `mk()`, which
 * defeats `staticConstStringValue` folding so the pattern really reaches the
 * runtime compiler. (A string-literal concat like `"a" + ".c"` IS folded and
 * would silently exercise the compile-time path instead — that false green is
 * exactly how this area is easy to mis-measure.)
 *
 * The comparison happens INSIDE the compiled program and only a small integer
 * comes back: a Wasm string ref does not survive `String()` on the JS side.
 */
async function runDynamic(pattern: string, flags: string, subject: string): Promise<Verdict> {
  const expected = oracle(pattern, flags, subject);
  const check =
    expected === null
      ? `return r === null ? 1 : 0;`
      : `return r === null ? -1 : (r[0] === ${JSON.stringify(expected)} ? 1 : 0);`;
  const src = `
function mk(): any { return ${JSON.stringify(pattern)}; }
function mf(): any { return ${JSON.stringify(flags)}; }
export function test(): number {
  try {
    const r: any = new RegExp(mk(), mf()).exec(${JSON.stringify(subject)});
    ${check}
  } catch (e: any) {
    const m: any = e.message;
    return m === "Unsupported dynamic regular expression pattern" ? 7 : 8;
  }
}`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const code = (instance.exports as { test: () => number }).test();
  if (code === 1) return "AGREES_WITH_NODE";
  if (code === 0) return "MATCHED_DIFFERENT_TEXT";
  if (code === -1) return "NO_MATCH";
  if (code === 7) return "REFUSED";
  throw new Error(`unexpected verdict ${code} for /${pattern}/${flags} ~ ${JSON.stringify(subject)}`);
}

async function expectMatchesNode(pattern: string, flags: string, subject: string): Promise<void> {
  expect(await runDynamic(pattern, flags, subject), `/${pattern}/${flags} ~ ${JSON.stringify(subject)}`).toBe(
    "AGREES_WITH_NODE",
  );
}

describe("#4065 dynamic RegExp pattern — CharacterEscape", () => {
  it("compiles \\xHH to the escaped code unit", async () => {
    await expectMatchesNode("\\x41", "", "A");
    await expectMatchesNode("\\x7a", "", "z");
  });

  it("compiles \\uHHHH to the escaped code unit", async () => {
    await expectMatchesNode("\\u0041", "", "A");
    await expectMatchesNode("\\u00e9", "", "\u00e9");
  });

  it("compiles \\cX (ControlLetter) to X % 32", async () => {
    await expectMatchesNode("\\cA", "", "\u0001");
    await expectMatchesNode("\\cz", "", "\u001a");
  });

  it("compiles the ControlEscapes \\n and \\t", async () => {
    await expectMatchesNode("\\n", "", "a\nb");
    await expectMatchesNode("\\t", "", "a\tb");
  });

  // One `it` per character: each case is a separate compile (~3.5 s), so a
  // single loop over all of them overruns the default per-test timeout.
  it.each(["~", "|", "\\", "/", "(", "[", ".", "*", "+", "?", "{", "^", "$"])(
    "compiles IdentityEscape of %s",
    async (ch) => {
      await expectMatchesNode("\\" + ch, "", `a${ch}b`);
    },
  );

  it("honours the i flag on an escaped literal", async () => {
    await expectMatchesNode("\\x41", "i", "a");
  });

  it("mixes escapes with plain literals and '.'", async () => {
    await expectMatchesNode("a\\x42c", "", "zaBc");
    await expectMatchesNode("a\\x42.", "", "aBz");
  });
});

describe("#4065 dynamic RegExp pattern — Annex B \\c fallback", () => {
  it("treats \\c NOT followed by an ASCII letter as a literal backslash", async () => {
    // B.1.4: the `\` is a SourceCharacterIdentityEscape and `c` is its own atom.
    await expectMatchesNode("\\c\u0416", "", "\\c\u0416");
    await expectMatchesNode("\\c", "", "\\c");
  });

  it("does not let a Cyrillic letter wrap around into a control character", async () => {
    expect(await runDynamic("\\c\u0416", "", String.fromCharCode(0x416 % 32))).toBe("AGREES_WITH_NODE");
  });
});

describe("#4065 tokenisation invariant — multi-unit tokens inside an alternation", () => {
  // These are the cases a per-source-unit walk gets wrong: the SPLIT target was
  // derived as `J - I` (source units), which over-counts the moment an
  // alternative contains a multi-unit escape.
  it("targets the second alternative correctly past a multi-unit escape", async () => {
    await expectMatchesNode("^(?:\\x41\\x42|cd)$", "", "AB");
    await expectMatchesNode("^(?:\\x41\\x42|cd)$", "", "cd");
    await expectMatchesNode("^(?:ab|\\u0043\\u0044)$", "", "CD");
  });

  it("does not mistake an escaped \\| for an alternation separator", async () => {
    await expectMatchesNode("^(?:a\\|b|cd)$", "", "a|b");
    await expectMatchesNode("^(?:a\\|b|cd)$", "", "cd");
  });
});

describe("#4065 anchored-alternations fast path must not treat '.' as literal", () => {
  // PRE-EXISTING defect, fixed here: the fast path copies the pattern SOURCE
  // text as its match payload, which is only valid when every token is a
  // one-unit literal.
  it("matches '.' as any-char inside an anchored alternation", async () => {
    await expectMatchesNode("^(?:a.c|zz)$", "", "abc");
  });

  it("still matches a literal dot through the same pattern", async () => {
    await expectMatchesNode("^(?:a.c|zz)$", "", "a.c");
  });

  it("keeps the plain literal-alternation fast path working", async () => {
    await expectMatchesNode("^(?:abc|zz)$", "", "abc");
    await expectMatchesNode("^(?:abc|zz)$", "", "zz");
  });
});

describe("#4065 constructs outside the runtime grammar stay LOUD refusals", () => {
  // A refusal is recoverable; a wrong match is not. Each of these needs engine
  // features the runtime grammar does not have, so the decoder reports
  // TOKEN_UNSUPPORTED rather than guess.
  it.each([
    ["class escape \\d", "\\d", "5"],
    ["class escape \\w", "\\w", "q"],
    ["assertion \\b", "\\b", "q"],
    ["back-reference", "(a)\\1", "aa"],
    ["capture group", "(a)b", "ab"],
    ["character class", "[abc]", "b"],
    ["quantifier", "a*b", "aab"],
    ["\\x with bad hex digits", "\\xZZ", "xZZ"],
  ])("refuses %s", async (_label, pattern, subject) => {
    expect(await runDynamic(pattern, "", subject)).toBe("REFUSED");
  });
});
