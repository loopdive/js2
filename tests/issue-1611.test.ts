import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

async function hasLexError(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts" });
  return (r.errors ?? []).some((e) => /single-statement context|labeled statement/.test(e.message));
}

describe("#1611 lexical declaration ASI in single-statement context", () => {
  // `let` + LineTerminator + (identifier | `{`) is an ExpressionStatement
  // (identifier reference) closed by ASI — valid in single-statement position.
  it.each([
    "if (false) let\nx = 1;",
    "if (false) let\n{}",
    "while (false) let\nx = 1;",
    "do let\nx = 1; while (false);",
    "for (;false;) let\nx = 1;",
    "for (var x in null) let\nx = 1;",
    "for (var x of []) let\nx = 1;",
    "L: let\nx = 1;",
  ])("accepts ASI let-as-identifier: %j", async (src) => {
    expect(await hasLexError(src)).toBe(false);
  });

  // `let [` is a lexical declaration even across a newline (no `[no LineTerminator
  // here]` in the spec lookahead) — still a SyntaxError in single-statement position.
  it.each(["if (false) let\n[a] = 0;", "for (var x of []) let\n[a] = 0;", "while (false) let\n[a] = 0;"])(
    "still rejects let-array after newline: %j",
    async (src) => {
      expect(await hasLexError(src)).toBe(true);
    },
  );

  // No newline, or `const`, stays a genuine lexical declaration -> still rejected.
  it.each(["if (x) let y = 1;", "if (false) const\nx = 1;", "while (x) const y = 1;"])(
    "still rejects same-line let / any const: %j",
    async (src) => {
      expect(await hasLexError(src)).toBe(true);
    },
  );
});
