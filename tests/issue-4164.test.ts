// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4164 — borrowed `String.prototype.<m>` on a NON-string receiver, standalone.
//
// Two dispatch shapes reach a borrowed String.prototype method, and both were
// broken for most of the member set:
//
//   (A) transferred/property-assigned — `obj.m = String.prototype.m; obj.m()`
//   (B) value-erased `.call`          — `var f = String.prototype.m; f.call(x)`
//
// Before this slice `emitStringProtoMemberBody` wired only
// {substring, indexOf, lastIndexOf, includes, startsWith, endsWith,
//  trim, trimStart, trimEnd, charAt, at, charCodeAt, codePointAt}; every other
// member's body was `emitProtoMemberBodyRefusal`, which returns `null` — the
// "not wired, fall through" signal — so shape (A) evaluated to `null` and
// shape (B) fell back to a path that did not exist for a value-erased closure.
//
// This slice adds the case-conversion family (§22.1.3.26/27/28/29) and `slice`
// (§22.1.3.22, which shares `substring`'s closure ABI and native helper shape),
// and generalises the single-member "transferred charAt" dispatch arms into a
// member-list-driven family so shape (A) reaches the closure at all.
//
// It also fixes ToString(this) in the shared 0-arg body: `$__any_to_string`
// alone takes the `"[object Object]"` terminal on an OBJECT receiver instead of
// running §7.1.1.1 OrdinaryToPrimitive, so a boxed primitive receiver
// (`new Object(true)`, `new Boolean`, `new Number(123)`) stringified to
// `"[object Object]"` rather than `"true"` / `"false"` / `"123"`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// Compile through the SAME lane the test262 standalone runner uses — literal
// JavaScript source with `allowJs`. The TypeScript lane annotates the receiver
// (`const x: any = new Boolean()`) and takes a different, statically-typed
// member-call route, so a `.ts` probe would not exercise the transferred
// (property-assigned) dispatch this slice fixes.
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(r.imports ?? []).toEqual([]); // host-free
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4164 — transferred String.prototype.<m> on a non-string receiver (standalone)", () => {
  // ── (A) transferred / property-assigned ────────────────────────────────
  it("new Object(true).toUpperCase = String.prototype.toUpperCase → 'TRUE'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object(true);
           x.toUpperCase = String.prototype.toUpperCase;
           return x.toUpperCase() === "TRUE" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("new Boolean().toLowerCase (transferred) → 'false'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Boolean();
           x.toLowerCase = String.prototype.toLowerCase;
           return x.toLowerCase() === "false" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("toLocaleUpperCase (transferred) matches toUpperCase without ECMA-402", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object(true);
           x.m = String.prototype.toLocaleUpperCase;
           return x.m() === "TRUE" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("toLocaleLowerCase (transferred) matches toLowerCase without ECMA-402", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object(true);
           x.m = String.prototype.toLocaleLowerCase;
           return x.m() === "true" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("new Number(123).slice (transferred) resolves the boxed primitive", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Number(123);
           x.slice = String.prototype.slice;
           return x.slice(1) === "23" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("slice (transferred) honours a NEGATIVE index (not substring's swap rule)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Number(12345);
           x.slice = String.prototype.slice;
           return x.slice(-2) === "45" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("charAt (transferred) still works — the pre-existing single-member arm", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Boolean();
           x.charAt = String.prototype.charAt;
           return x.charAt(0) === "f" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  // ── (B) value-erased `.call` ───────────────────────────────────────────
  it("var f = String.prototype.toUpperCase; f.call(true) → 'TRUE'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var f = String.prototype.toUpperCase;
           return f.call(true) === "TRUE" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("String.prototype.toUpperCase.call(new Object(true)) → 'TRUE' (no regression)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object(true);
           return String.prototype.toUpperCase.call(x) === "TRUE" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  // ── ToString(this) is OrdinaryToPrimitive, not the "[object Object]" terminal ──
  it("trim.call(new Object('  ab  ')) unwraps the boxed primitive", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var x = new Object("  ab  ");
           return String.prototype.trim.call(x) === "ab" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  // ── RequireObjectCoercible still throws for the new members ────────────
  it("toUpperCase.call(null) throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           try { String.prototype.toUpperCase.call(null); return 0; }
           catch (e) { return (e instanceof TypeError) ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("toLowerCase.call(undefined) throws TypeError (RequireObjectCoercible)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           try { String.prototype.toLowerCase.call(undefined); return 0; }
           catch (e) { return (e instanceof TypeError) ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  // ── §7.1.17 ToString rejects a Symbol ─────────────────────────────────
  // `$__any_to_string` deliberately has a PRINTABLE fallback for a Symbol, so
  // routing a member through it without a guard silently stringifies instead of
  // throwing (test262 `this-value-tostring-throws-symbol`, which this slice
  // regressed and then fixed).
  it("toLowerCase.call(Symbol()) throws TypeError (ToString rejects Symbol)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           try { String.prototype.toLowerCase.call(Symbol("x")); return 0; }
           catch (e) { return (e instanceof TypeError) ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("trim.call(Symbol()) throws TypeError (ToString rejects Symbol)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           try { String.prototype.trim.call(Symbol("x")); return 0; }
           catch (e) { return (e instanceof TypeError) ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  // ── the DIRECT path must be untouched ─────────────────────────────────
  it("direct 'éx'.toUpperCase() still uses the full-Unicode table", async () => {
    expect(await runStandalone(`export function test() { return "éx".toUpperCase() === "ÉX" ? 1 : 0; }`)).toBe(1);
  });

  it("direct 'abcdef'.slice(-3, -1) unchanged", async () => {
    expect(await runStandalone(`export function test() { return "abcdef".slice(-3, -1) === "de" ? 1 : 0; }`)).toBe(1);
  });
});
