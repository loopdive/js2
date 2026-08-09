// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1558 — Strict equality codegen path missed the i32 → f64 coercion on
// the LEFT operand when both operands had compile-time type i32 but the
// TS type was `number`.
//
// Surfaced compiling ESLint's `Linter.verifyAndFix` via `compileProject(
// "node_modules/eslint/lib/linter/linter.js", { allowJs: true })`. The
// Wasm binary validated everywhere except this function, which failed
// with `f64.eq[0] expected type f64, found call of type i32` because the
// `currentText.length === secondPreviousText.length` comparison (after
// the latter went through a narrowing widening via AsExpression) reached
// the legacy AST codegen branch at the bottom of `compileBinaryExpression`
// in `src/codegen/binary-ops.ts`. That branch only ever coerced the RIGHT
// operand from i32 to f64, leaving the left operand as i32 — which then
// fed `compileNumericBinaryOp`'s `f64.eq` emit and broke validation.
//
// The "no-cast" form `a.length === b.length` happened to take the IR
// path which already coerces both sides to the f64 hint, so the bug only
// fired when the receiver expression was wrapped in `as T`, `!`, or a
// containing form that pushes the AST off the IR fast-path.

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

async function compileAndValidate(source: string): Promise<Uint8Array> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  // Surface the validation error here so the test message is clean.
  new WebAssembly.Module(r.binary);
  return r.binary;
}

async function compileAndRunNum(source: string, ...args: number[]): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  new WebAssembly.Module(r.binary);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: Function }).setExports === "function") {
    (imports as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as Record<string, (...a: number[]) => unknown>).test(...args);
}

describe("#1558 — strict-equality legacy path coerces both i32 operands to f64", () => {
  /**
   * Synthetic minimum repro: `a.length === (b as string).length` with
   * two string parameters. Both `.length` accesses return i32 (via the
   * `wasm:js-string`/`length` import), and both operands' TS types are
   * `number`. Before the fix, only the right operand was coerced via
   * `f64.convert_i32_s`, leaving `f64.eq` with one i32 operand. After
   * the fix the emit is `i32; f64.convert_i32_s; i32; f64.convert_i32_s;
   * f64.eq`.
   */
  it("string.length === (b as string).length validates", async () => {
    await compileAndValidate(`
      export function test(a: string, b: string): number {
        return a.length === (b as string).length ? 1 : 0;
      }
    `);
  });

  /**
   * Same shape with a non-null assertion (`b!.length`) — also drops the
   * comparison off the IR fast-path and exercises the legacy branch.
   */
  it("string.length === b!.length validates", async () => {
    await compileAndValidate(`
      export function test(a: string, b: string | undefined): number {
        return a.length === b!.length ? 1 : 0;
      }
    `);
  });

  /**
   * Through a temp local — `c = b as string` then `c.length`. The temp
   * round-trip preserves the legacy path (the IR doesn't know how to
   * lower the `as` cast).
   */
  it("via temp local: const c = b as string; a.length === c.length validates and runs", async () => {
    const r = await compileAndRunNum(
      `
      export function test(): number {
        const a: string = "hello";
        const b: string = "hello";
        const c: string = b as string;
        return a.length === c.length ? 1 : 0;
      }
    `,
    );
    expect(r).toBe(1);
  });

  /**
   * Reduced shape that mirrors ESLint's `verifyAndFix` do-while fix loop
   * — accumulates `currentText` length comparisons against a stashed
   * previous-iteration value cast through `as string` to satisfy
   * `string | undefined`.
   */
  it("ESLint verifyAndFix-shaped do-while validates", async () => {
    await compileAndValidate(`
      export function test(a: string): number {
        let curr = a;
        let prev: string | undefined;
        let pass = 0;
        do {
          pass++;
          prev = curr;
          curr = curr + a;
          if (curr.length === (prev as string).length) break;
        } while (pass < 10);
        return pass;
      }
    `);
  });

  /**
   * Strict-equality between a `number`-typed local and an i32-returning
   * call (`fn()` typed as `number` but compiled to i32 in some inference
   * contexts). Locks in that both sides get the f64 widen even when one
   * side is a literal.
   */
  it("function-call strict equality against literal validates", async () => {
    await compileAndValidate(`
      function fn(s: string): number { return s.length; }
      export function test(s: string): number {
        return fn(s) === 1 ? 1 : 0;
      }
    `);
  });

  /**
   * Loose equality `==` between two string lengths via cast (sibling to
   * the `===` case — the same legacy branch dispatches both).
   */
  it("string.length == (b as string).length validates", async () => {
    await compileAndValidate(`
      export function test(a: string, b: string): number {
        return a.length == (b as string).length ? 1 : 0;
      }
    `);
  });

  /**
   * Inequality `!==` — same branch in `compileNumericBinaryOp`.
   */
  it("string.length !== (b as string).length validates", async () => {
    await compileAndValidate(`
      export function test(a: string, b: string): number {
        return a.length !== (b as string).length ? 1 : 0;
      }
    `);
  });
});

describe("#1558 — runtime correctness of widened i32-i32 strict equality", () => {
  /**
   * Equality should still be value-correct after the widen. f64 can
   * exactly represent every i32, so 5 === 5, 5 === 7, 0 === -0 all
   * behave the same as plain JS.
   */
  it("equal lengths → 1", async () => {
    const r = await compileAndRunNum(`
      export function test(): number {
        const a: string = "hello";
        const b: string = "world";
        return a.length === (b as string).length ? 1 : 0;
      }
    `);
    expect(r).toBe(1);
  });

  it("different lengths → 0", async () => {
    const r = await compileAndRunNum(`
      export function test(): number {
        const a: string = "hello";
        const b: string = "hi";
        return a.length === (b as string).length ? 1 : 0;
      }
    `);
    expect(r).toBe(0);
  });

  /**
   * Inequality should report inverted to equality.
   */
  it("!== inverts ===", async () => {
    const r = await compileAndRunNum(`
      export function test(): number {
        const a: string = "hello";
        const b: string = "world";
        return a.length !== (b as string).length ? 1 : 0;
      }
    `);
    expect(r).toBe(0);
  });
});

describe("#1558 — ESLint linter.js smoke test", () => {
  /**
   * The reported failure site: `compileProject` on ESLint's `linter.js`
   * with `{ allowJs: true }`. Pre-fix this validated everywhere except
   * `Linter_verifyAndFix`, which threw `f64.eq[0] expected type f64,
   * found call of type i32`.
   *
   * Post-fix the `f64.eq` validation in `Linter_verifyAndFix` clears.
   * There may still be other downstream validation failures in other
   * functions of the binary (linter.js is large and other issues are
   * tracked separately — #1559 and #1560). This smoke test only locks
   * in that the SPECIFIC `f64.eq` failure in `Linter_verifyAndFix` is
   * gone — failure-modes from other unrelated functions don't regress
   * this issue.
   */
  it.skip("Linter_verifyAndFix no longer fails f64.eq validation (blocked before validation by #3654/#3655)", async () => {
    const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
    // Reproduce the validator error (if any) and assert it's NOT the
    // f64.eq one. Capturing the message lets us pin the regression
    // exactly — any other failure mode is allowed (and tracked
    // elsewhere) but THIS specific shape must stay fixed.
    let msg: string | null = null;
    try {
      new WebAssembly.Module(r.binary);
    } catch (e) {
      msg = (e as Error).message;
    }
    if (msg !== null) {
      expect(msg).not.toMatch(/Linter_verifyAndFix.*f64\.eq.*found call of type i32/);
    }
  }, 90_000);
});
