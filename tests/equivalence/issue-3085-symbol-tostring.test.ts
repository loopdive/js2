import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #3085 — Host-mode `Symbol.prototype.toString` (§20.4.3.3 →
// SymbolDescriptiveString §20.4.3.3.1) and `String(symbol)` (§22.1.1.1 step 1).
// Before the fix, host mode dropped the symbol id: `sym.toString()` fell through
// to the generic `.toString()` and produced "[object Object]", and `String(sym)`
// stringified the raw i32 symbol id (e.g. "101"). Both now route through the
// `__symbol_to_string` host import, matching the native-strings path.
describe("#3085 host-mode Symbol descriptive string", () => {
  it("Symbol.prototype.toString yields Symbol(desc)", async () => {
    const ex = await compileToWasm(`
      export function withDesc(): string { return Symbol('66').toString(); }
      export function noDesc(): string { return Symbol().toString(); }
      export function viaVar(): string { let s = Symbol('abc'); return s.toString(); }
    `);
    expect(ex.withDesc()).toBe("Symbol(66)");
    expect(ex.noDesc()).toBe("Symbol()");
    expect(ex.viaVar()).toBe("Symbol(abc)");
  });

  it("String(symbol) yields Symbol(desc) without throwing", async () => {
    const ex = await compileToWasm(`
      export function s1(): string { return String(Symbol('66')); }
      export function s2(): string { let s: symbol = Symbol('x'); return String(s); }
      export function s3(): string { return String(Symbol()); }
    `);
    expect(ex.s1()).toBe("Symbol(66)");
    expect(ex.s2()).toBe("Symbol(x)");
    expect(ex.s3()).toBe("Symbol()");
  });

  it("valueOf still returns the symbol primitive (unchanged)", async () => {
    const ex = await compileToWasm(`
      export function same(): number { let s = Symbol('66'); return s.valueOf() === s ? 1 : 0; }
    `);
    expect(ex.same()).toBe(1);
  });
});
