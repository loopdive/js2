// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { isFatalCodegenDiagnostic } from "../src/codegen/context/errors.js";

/**
 * #1921 — the compile-failure gate keys on diagnostic severity, not on a
 * magic `"Codegen error:"` message prefix.
 *
 * Before this change a `reportError(..., "Unsupported expression: X")` pushed a
 * severity-"error" diagnostic, the expression compiled to a placeholder, and
 * `compile()` still returned `success: true` with the wrong value baked in —
 * because the gate only failed on messages that happened to start with the
 * magic prefix. The gate now fails on any `severity: "error"` (or omitted)
 * diagnostic.
 */
describe("#1921 — structured compile-failure gate", () => {
  it("an Unsupported expression returns success:false (no magic prefix needed)", async () => {
    // `satisfies` is not handled by the codegen and falls through to the
    // `Unsupported expression: SatisfiesExpression` catch-all at
    // src/codegen/expressions.ts. Its message carries no "Codegen error:"
    // prefix; before #1921 it silently degraded to success:true.
    const r = await compile(
      `export function test(): number { const x = ({ a: 1 } satisfies { a: number }); return x.a; }`,
      { fileName: "issue-1921.ts", skipSemanticDiagnostics: true },
    );

    expect(r.success).toBe(false);
    const msgs = r.errors.map((e) => e.message).join("\n");
    expect(msgs).toContain("Unsupported expression");
    // The fatal diagnostic must NOT depend on the magic prefix.
    expect(msgs).not.toContain("Codegen error: Unsupported expression");
    // It is surfaced as a real "error" severity.
    expect(r.errors.some((e) => e.severity === "error")).toBe(true);
  });

  it("isFatalCodegenDiagnostic treats severity by value, defaulting to fatal", () => {
    expect(isFatalCodegenDiagnostic({ severity: "error" })).toBe(true);
    // An omitted severity fails loudly rather than silently degrading.
    expect(isFatalCodegenDiagnostic({})).toBe(true);
    expect(isFatalCodegenDiagnostic({ severity: undefined })).toBe(true);
    // Non-fatal channels: IR-fallback warnings and deliberate degrades.
    expect(isFatalCodegenDiagnostic({ severity: "warning" })).toBe(false);
    expect(isFatalCodegenDiagnostic({ severity: "degrade" })).toBe(false);
  });

  it("a well-formed program still compiles successfully (gate is not over-eager)", async () => {
    const r = await compile(
      `export function test(): number { let s = 0; for (let i = 0; i < 5; i++) s += i; return s; }`,
      { fileName: "issue-1921-ok.ts", target: "standalone", skipSemanticDiagnostics: true },
    );

    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(10);
  });
});
