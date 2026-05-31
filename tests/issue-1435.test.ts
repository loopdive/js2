// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1435 — Lexical grammar and syntax-directed early errors.
 *
 * Tracks the long-tail of `negative.phase: parse` failures in test262 §12
 * where TypeScript flags an ECMA-262 early error but we silently let it
 * compile and instantiate, so the runner reports
 *   "expected parse/early SyntaxError but compiled and instantiated
 *    successfully"
 *
 * This commit closes the auto-strict reserved-word slice:
 *
 *   ECMA-262 §12.6.1 Early Errors
 *     Identifier : IdentifierName but not ReservedWord
 *     It is a Syntax Error if this phrase is contained in strict mode
 *     code and the StringValue of IdentifierName is: "implements",
 *     "interface", "let", "package", "private", "protected", "public",
 *     "static", or "yield".
 *   §10.2.1  Class and module bodies are strict mode code.
 *
 * TypeScript emits these as diagnostic code 1213 (class context) and 1214
 * (module context). Both are reported as **semantic** diagnostics, so the
 * compiler's syntactic-only gate previously let them through. Adding the
 * codes to `HARD_TS_DIAG_CODES` makes the compile fail as the spec
 * mandates, without disturbing the sloppy-mode-friendly diagnostics
 * (TS1100/1102/1121/1489) that remain tolerated for #833.
 *
 * Targets the test262 file
 *   language/statements/class/class-name-ident-let.js
 * and the sibling `class-name-ident-*` reserved-word cases.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileFails(src: string): Promise<boolean> {
  const r = await compile(src);
  if (!r.success) return true;
  // Any error-severity entry should bubble up to a failed compile too —
  // we treat error-severity output as "compile rejected" for negative tests.
  return r.errors.some((e) => e.severity === "error");
}

describe("#1435 — reserved-word identifier in auto-strict context (TS1213/1214)", () => {
  describe("class definitions are strict mode (§10.2.1) — class name cannot be a strict reserved word", () => {
    it("rejects `class let {}`", async () => {
      expect(await compileFails(`class let {}`)).toBe(true);
    });

    it("rejects `class static {}`", async () => {
      expect(await compileFails(`class static {}`)).toBe(true);
    });

    it("rejects `class yield {}`", async () => {
      expect(await compileFails(`class yield {}`)).toBe(true);
    });

    it("rejects `class private {}`", async () => {
      expect(await compileFails(`class private {}`)).toBe(true);
    });

    it("accepts non-reserved class names", async () => {
      const r = await compile(`class Foo {}`);
      // Either no errors or only non-fatal warnings — the key invariant
      // is that the compile path does NOT reject a valid class name.
      expect(r.errors.some((e) => e.severity === "error")).toBe(false);
    });
  });

  describe("module bodies are strict mode (§10.2.1) — top-level reserved-word bindings are SyntaxErrors", () => {
    // Modules are auto-strict; an explicit `export` clause makes the source
    // a module per ECMA-262. Reserved-word identifiers as exported bindings
    // surface as TS1214.
    it("compiles a valid module export (sanity)", async () => {
      const r = await compile(`export const ok: number = 1;`);
      expect(r.errors.some((e) => e.severity === "error")).toBe(false);
    });
  });

  describe("regression guard: prior good code stays good", () => {
    it("uses `let` as a binding inside a function (sloppy/strict both allow this)", async () => {
      const r = await compile(`
        export function test(): number {
          let x: number = 42;
          return x;
        }
      `);
      expect(r.errors.some((e) => e.severity === "error")).toBe(false);
    });

    it("class with a regular method that uses `let` internally", async () => {
      const r = await compile(`
        export class Counter {
          private value: number = 0;
          inc(): number {
            let prev: number = this.value;
            this.value = prev + 1;
            return this.value;
          }
        }
      `);
      expect(r.errors.some((e) => e.severity === "error")).toBe(false);
    });
  });
});
