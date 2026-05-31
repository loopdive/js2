// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1564 — ToNumeric / ToNumber with a Symbol argument must throw
 * TypeError (ECMAScript §7.1.3 / §7.1.4).
 *
 * `Number(Symbol())` and the unary/arithmetic ToNumber funnels already throw,
 * but the Number.prototype numeric formatters (toFixed / toPrecision /
 * toExponential) compiled their digits argument straight into an f64 local
 * without funneling through ToNumber. A Symbol argument (lowered to externref)
 * produced an invalid-Wasm `local.tee` (f64 vs externref) instead of the
 * spec-required TypeError.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

const catchKind = (call: string) => `
  export function test(): string {
    const s: any = Symbol("x");
    try { ${call}; return "no-throw"; }
    catch (e) { return e instanceof TypeError ? "TypeError" : "other"; }
  }
`;

describe("#1564 — ToNumber(Symbol) throws TypeError", () => {
  it("Number(Symbol()) throws TypeError", async () => {
    expect(await run(catchKind("Number(s)"))).toBe("TypeError");
  });

  it("new Number(Symbol()) throws TypeError", async () => {
    expect(await run(catchKind("new Number(s)"))).toBe("TypeError");
  });

  it("unary + on Symbol throws TypeError", async () => {
    expect(await run(catchKind("+s"))).toBe("TypeError");
  });

  it("Number.prototype.toFixed(Symbol) throws TypeError", async () => {
    expect(await run(catchKind("(5).toFixed(s)"))).toBe("TypeError");
  });

  it("Number.prototype.toPrecision(Symbol) throws TypeError", async () => {
    expect(await run(catchKind("(5).toPrecision(s)"))).toBe("TypeError");
  });

  it("Number.prototype.toExponential(Symbol) throws TypeError", async () => {
    expect(await run(catchKind("(5).toExponential(s)"))).toBe("TypeError");
  });

  // Regression guard: valid numeric arguments still coerce correctly.
  it("toFixed with a number argument is unaffected", async () => {
    expect(await run(`export function test(): string { return (5).toFixed(2); }`)).toBe("5.00");
  });

  it("toFixed with a boolean (i32) argument coerces via ToNumber", async () => {
    // ToNumber(true) === 1, so toFixed(true) === toFixed(1).
    expect(await run(`export function test(): string { return (5.5).toFixed(true as any); }`)).toBe("5.5");
  });

  it("toPrecision with a number argument is unaffected", async () => {
    expect(await run(`export function test(): string { return (123.456).toPrecision(4); }`)).toBe("123.5");
  });

  it("toExponential with a number argument is unaffected", async () => {
    expect(await run(`export function test(): string { return (12345).toExponential(2); }`)).toBe("1.23e+4");
  });

  // ── Operator ToNumeric coverage (§7.1.3 step 3) ──────────────────────────
  // Symbols are lowered to i32 ids; every numeric/bitwise/relational operator
  // and update operator must throw TypeError rather than treat the id as a
  // number. Equality (`===`/`==`) is excluded — it compares Symbols by identity.
  it("unary - on Symbol throws TypeError", async () => {
    expect(await run(catchKind("-s"))).toBe("TypeError");
  });

  it("bitwise ~ on Symbol throws TypeError", async () => {
    expect(await run(catchKind("~s"))).toBe("TypeError");
  });

  it("binary * on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s * 2"))).toBe("TypeError");
  });

  it("binary - on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s - 1"))).toBe("TypeError");
  });

  it("binary + on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s + 1"))).toBe("TypeError");
  });

  it("exponentiation ** on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s ** 2"))).toBe("TypeError");
  });

  it("bitwise | on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s | 0"))).toBe("TypeError");
  });

  it("shift << on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s << 1"))).toBe("TypeError");
  });

  it("relational < on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s < 5"))).toBe("TypeError");
  });

  it("relational > on Symbol throws TypeError", async () => {
    expect(await run(catchKind("s > 5"))).toBe("TypeError");
  });

  // Update / compound operators use a mutable `let s = Symbol()` binding so the
  // symbol type is preserved and the const-assignment guard does not pre-empt
  // the ToNumeric throw.
  it("postfix ++ on Symbol throws TypeError", async () => {
    expect(
      await run(`export function test(): string {
        let s = Symbol();
        try { s++; return "no-throw"; }
        catch (e) { return e instanceof TypeError ? "TypeError" : "other"; }
      }`),
    ).toBe("TypeError");
  });

  it("prefix -- on Symbol throws TypeError", async () => {
    expect(
      await run(`export function test(): string {
        let s = Symbol();
        try { --s; return "no-throw"; }
        catch (e) { return e instanceof TypeError ? "TypeError" : "other"; }
      }`),
    ).toBe("TypeError");
  });

  it("compound += on Symbol throws TypeError", async () => {
    expect(
      await run(`export function test(): string {
        let s: any = Symbol();
        try { s += 1; return "no-throw"; }
        catch (e) { return e instanceof TypeError ? "TypeError" : "other"; }
      }`),
    ).toBe("TypeError");
  });

  // Identity comparison must NOT throw — Symbols compare by reference.
  it("=== on Symbols does not throw (identity compare)", async () => {
    expect(
      await run(`export function test(): string {
        const s = Symbol();
        return (s === s) ? "eq-true" : "eq-false";
      }`),
    ).toBe("eq-true");
  });

  // Sanity: ordinary numeric arithmetic and relational ops are unaffected.
  it("ordinary arithmetic is unaffected", async () => {
    expect(await run(`export function test(): number { return 3 * 4 - 2; }`)).toBe(10);
  });

  it("ordinary relational comparison is unaffected", async () => {
    expect(await run(`export function test(): string { return (5 < 10) ? "lt" : "ge"; }`)).toBe("lt");
  });
});
