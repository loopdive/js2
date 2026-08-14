// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4417 — three ES early-error checks rejected valid TypeScript.
//
// Found while measuring how much of js2wasm's own source js2wasm can compile:
// a whole-program compile of `src/index.ts` resolved and type-checked all 730
// files, then failed at the early-error gate with 130 errors in exactly these
// three classes — every one a false positive on Prettier-formatted code. They
// blocked 593 of 768 source files transitively.
//
// Each test below pins BOTH directions: the valid form must compile, and the
// genuinely-invalid form it resembles must still be rejected. A fix that only
// stops the false positive, at the cost of letting the real SyntaxError
// through, is not a fix.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function compiles(source: string): Promise<{ ok: boolean; error?: string }> {
  const r = (await compile(source, { fileName: "t.ts" })) as {
    success?: boolean;
    errors?: { message: string }[];
  };
  return { ok: Boolean(r.success), error: r.errors?.[0]?.message };
}

describe("#4417 arrow-function ASI restriction", () => {
  it("accepts a parameter list wrapped across lines (Prettier's own output)", async () => {
    // The restriction is between the END of ArrowParameters and `=>`. The
    // closing paren — and the newlines before it — are INSIDE ArrowParameters.
    const r = await compiles("const f = (\n  a: number,\n  b: number,\n) => a + b;\nconst r = f(1, 2);\n");
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("accepts a return type annotation before `=>`", async () => {
    const r = await compiles("const f = (\n  a: number,\n): number => a;\nconst r = f(1);\n");
    expect(r.ok).toBe(true);
  });

  it("still rejects a newline between the closing paren and `=>`", async () => {
    const r = await compiles("const f = (a, b)\n=> a + b;\n");
    // Rejection is the contract. The wording is not pinned: this shape is
    // caught by the scanner-level "Line terminator not permitted before …"
    // check before the arrow rule sees it, and either message is correct.
    expect(r.ok).toBe(false);
  });

  it("still rejects a newline after a single unparenthesized parameter", async () => {
    // No paren to skip past, so the whole gap is subject to the rule.
    const r = await compiles("const f = a\n=> a;\n");
    expect(r.ok).toBe(false);
  });

  it("still rejects a newline after the return type annotation", async () => {
    const r = await compiles("const f = (a: number): number\n=> a;\n");
    expect(r.ok).toBe(false);
  });
});

describe("#4417 non-null assertion as an assignment target", () => {
  // `!` is a TYPE-level assertion that erases at emit, so these are ordinary
  // property/element assignments. `fctx.breakStack[i]!++` appears 16 times in
  // codegen/statements/control-flow.ts alone.
  it("accepts `o.n!++`", async () => {
    const r = await compiles("const o: { n?: number } = { n: 1 };\no.n!++;\n");
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("accepts `a[0]!++` on an element access", async () => {
    const r = await compiles("const a: number[] = [1];\na[0]!++;\n");
    expect(r.ok).toBe(true);
  });

  it("accepts `o.n! = v`", async () => {
    const r = await compiles("const o: { n?: number } = { n: 1 };\no.n! = 5;\n");
    expect(r.ok).toBe(true);
  });

  it("still rejects assignment to a literal", async () => {
    expect((await compiles("1 = 2;\n")).ok).toBe(false);
  });

  it("still rejects a postfix update on a literal", async () => {
    expect((await compiles("1++;\n")).ok).toBe(false);
  });

  it("still rejects a parenthesized object literal as an assignment target", async () => {
    // §13.15.1 — CoverParenthesizedExpression cannot be refined to an
    // AssignmentPattern. The destructuring test must keep running BEFORE the
    // unwrap loop for this to hold.
    expect((await compiles("({}) = 1;\n")).ok).toBe(false);
    expect((await compiles("([]) = 1;\n")).ok).toBe(false);
    expect((await compiles("({})++;\n")).ok).toBe(false);
  });

  it("still accepts genuine destructuring assignment", async () => {
    const r = await compiles("let a = 0, b = 0;\n({ a, b } = { a: 1, b: 2 });\n");
    expect(r.ok).toBe(true);
  });

  it("still accepts a parenthesized identifier target", async () => {
    const r = await compiles("let x = 0;\n(x) = 1;\n");
    expect(r.ok).toBe(true);
  });
});
