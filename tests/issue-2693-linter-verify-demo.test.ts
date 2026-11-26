// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2693 — MILESTONE: an ESLint-style `Linter.verify` RUNS as Wasm in Node.js.
//
// This is the demonstrable "eslint runs as Wasm" milestone for the
// npm-library-support goal. It does NOT compile the full real `eslint` package
// (that is gated on a large external dependency tree — eslint-scope, @eslint/core,
// @eslint/plugin-kit, espree, debug — plus node:fs/os/url/worker_threads; see
// #2691 + the #1573 gate-list). Instead it proves the END-TO-END architecture:
//
//   1. A `Linter` class with `verify(code)` + the ESLint-core `semi` rule is
//      COMPILED TO WASM (lint logic only).
//   2. PARSE IS HOST-DELEGATED: the wasm module imports `__parse` / `__tok_*`,
//      which the Node harness fulfils with TypeScript's scanner. So the wasm is
//      DECOUPLED from a compiled parser (acorn #1712) — a host JS runtime
//      tokenizes, the wasm does the rule logic.
//   3. The compiled module is instantiated in Node and `verify(...)` is CALLED,
//      producing real lint messages with correct line:col.
//
// Pins the milestone so it cannot silently regress.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// The ESLint-style Linter, compiled to Wasm. Parse host-delegated via imports.
const LINTER_SRC = `
declare function __parse(code: string): number;
declare function __tok_value(i: number): string;
declare function __tok_line(i: number): number;
declare function __tok_col(i: number): number;

class Linter {
  // The \`semi\` rule (ESLint core): a statement must terminate with ';'.
  verify(code: string): string {
    const n = __parse(code);
    if (n > 0) {
      const lastVal = __tok_value(n - 1);
      if (lastVal !== ";") {
        const line = __tok_line(n - 1);
        const col = __tok_col(n - 1);
        return "Missing semicolon. (" + line + ":" + col + ")";
      }
    }
    return "";
  }
}

export function verify(code: string): string {
  const linter = new Linter();
  return linter.verify(code);
}
`;

describe("#2693 MILESTONE — ESLint-style Linter.verify runs as Wasm in Node", () => {
  it("compiles the Linter, instantiates it, and runs verify() with host-delegated parse", async () => {
    const r = await compile(LINTER_SRC, { fileName: "linter.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);

    // ---- HOST-DELEGATED PARSE (TypeScript scanner stands in for espree) ----
    let toks: { value: string; line: number; col: number }[] = [];
    const hostParse = (code: string): number => {
      const sf = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
      toks = [];
      let t = scanner.scan();
      while (t !== ts.SyntaxKind.EndOfFileToken) {
        const pos = scanner.getTokenStart();
        const lc = sf.getLineAndCharacterOfPosition(pos);
        toks.push({ value: scanner.getTokenText(), line: lc.line + 1, col: lc.character + 1 });
        t = scanner.scan();
      }
      return toks.length;
    };

    const instance = await instantiateWithRuntime(r, {
      __parse: (code: string) => hostParse(code),
      __tok_value: (i: number) => toks[i]!.value,
      __tok_line: (i: number) => toks[i]!.line,
      __tok_col: (i: number) => toks[i]!.col,
    });
    const verify = instance.exports.verify as (c: string) => string;

    // The wasm Linter.verify runs and produces correct semi-rule diagnostics.
    expect(verify("var x = 1")).toBe("Missing semicolon. (1:9)");
    expect(verify("var x = 1;")).toBe("");
    expect(verify("let y = 2")).toBe("Missing semicolon. (1:9)");
    expect(verify("const z = 3;")).toBe("");
  });
});
