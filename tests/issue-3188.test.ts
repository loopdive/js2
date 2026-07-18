// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3188 slice 1 — wrapTest `await { … }` obj-literal misparse (runner artifact).
 *
 * The `language/module-code/top-level-await/syntax/*-await-expr-obj-literal.js`
 * tests contain an AwaitExpression whose operand is an ObjectLiteral
 * (`await { function() {} }`). The runner compiles the top-level-await body
 * SYNCHRONOUSLY (the wrapTest TLA path emits it at module top level, not inside
 * an `async` function), so TS treats `await` as an identifier and the following
 * `{ … }` as a *block statement*, which swallows the wrapper's trailing
 * `export function test()` during error recovery — surfacing as
 * `Duplicate identifier 'test'` / `Duplicate export name 'test'` (a `compile_error`
 * on 6 records, a pure runner artifact, NOT a real compiler bug).
 *
 * Fix: `parenthesizeAwaitBraceOperand` rewrites `await { … }` → `await ({ … })`
 * in the TLA path so the `{ … }` parses as the await operand in every position
 * (top-level statement, `typeof`/`void`, for-header, `export var/let x = await {…}`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parenthesizeAwaitBraceOperand, runSyntheticTest262File, wrapTest } from "./test262-runner.ts";

const TLA_SYNTAX = "test262/test/language/module-code/top-level-await/syntax";
const OBJ_LITERAL_TESTS = [
  "top-level-await-expr-obj-literal",
  "typeof-await-expr-obj-literal",
  "void-await-expr-obj-literal",
  "for-await-expr-obj-literal",
  "export-var-await-expr-obj-literal",
  "export-lex-decl-await-expr-obj-literal",
];

describe("#3188 slice 1 — wrapTest await-obj-literal misparse", () => {
  it("parenthesizes the object-literal operand of await", () => {
    expect(parenthesizeAwaitBraceOperand("await { function() {} };")).toBe("await ({ function() {} });");
    // Nested braces are balanced correctly.
    expect(parenthesizeAwaitBraceOperand("typeof await { a: { b: 1 } };")).toBe("typeof await ({ a: { b: 1 } });");
    // Every position in one string (mirrors the for-header shape).
    expect(parenthesizeAwaitBraceOperand("for (; await {}; await {}) {}")).toBe("for (; await ({}); await ({})) {}");
  });

  it("leaves non-object await operands and already-parenthesized forms untouched", () => {
    expect(parenthesizeAwaitBraceOperand("await 1;")).toBe("await 1;");
    expect(parenthesizeAwaitBraceOperand("await [x];")).toBe("await [x];");
    expect(parenthesizeAwaitBraceOperand("await ({ a: 1 });")).toBe("await ({ a: 1 });");
    expect(parenthesizeAwaitBraceOperand("await foo;")).toBe("await foo;");
    // `await {` inside a string/comment must NOT be rewritten.
    expect(parenthesizeAwaitBraceOperand('const s = "await {x}";')).toBe('const s = "await {x}";');
    expect(parenthesizeAwaitBraceOperand("// await { x }\nawait 1;")).toBe("// await { x }\nawait 1;");
    // `awaiting` is not `await` (word boundary).
    expect(parenthesizeAwaitBraceOperand("awaiting = { x: 1 };")).toBe("awaiting = { x: 1 };");
  });

  it("wrapTest emits a compilable module for a top-level `await { … }` body (no Duplicate-test)", async () => {
    const { source } = wrapTest("await { function() {} };", { flags: ["module"], features: ["top-level-await"] });
    // The block-vs-object misparse used to bleed into the wrapper export.
    expect(source).toContain("await ({ function() {} })");
    expect((source.match(/export function test/g) ?? []).length).toBe(1);
  });

  it.runIf(existsSync(join(process.cwd(), TLA_SYNTAX)))(
    "the 6 await-expr-obj-literal test262 files compile + pass (were compile_error)",
    async () => {
      for (const name of OBJ_LITERAL_TESTS) {
        const file = join(process.cwd(), TLA_SYNTAX, `${name}.js`);
        const r = await runSyntheticTest262File(file, "language/module-code");
        expect(r.status, `${name}: ${r.error ?? r.reason ?? ""}`).toBe("pass");
      }
    },
  );
});
